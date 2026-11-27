#!/usr/bin/env python3
"""Route local CLI workers and read-only reviews using the workflow and engine registry."""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SKILL_DIR = Path(__file__).resolve().parent.parent
SCHEMA_PATH = SKILL_DIR / "resources" / "report_schema.json"

STATE_DIR = Path(
    os.environ.get(
        "AGY_DISPATCH_STATE_DIR",
        os.path.expanduser("~/.local/state/multi-agent-dispatch"),
    )
)
STATE_FILE = STATE_DIR / "state.json"
LOCK_FILE = STATE_DIR / "state.lock"
RUNS_DIR = STATE_DIR / "runs"
WORKTREES_DIR = STATE_DIR / "worktrees"
ENGINE_CONFIG_FILE = Path(
    os.environ.get("AGY_ENGINE_CONFIG_FILE", str(STATE_DIR / "engine_config.json"))
)

_INITIAL_ENGINE_CONFIG_FILE = ENGINE_CONFIG_FILE

ZCODE_HOME = Path(os.environ.get("ZCODE_HOME", os.path.expanduser("~/.zcode")))
ZCODE_SCRIPT = Path("/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs")
ZCODE_BUILTIN_PROVIDER_CONFIG = Path(
    "/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json"
)
ZCODE_PERSONAL_PROVIDER_CONFIG = ZCODE_HOME / "v2" / "provider_config.json"
ZCODE_TASKS_INDEX_DB = ZCODE_HOME / "v2" / "tasks-index.sqlite"
ZCODE_CLI_DB = ZCODE_HOME / "cli" / "db" / "db.sqlite"

ZCODE_PROVIDER_BAILIAN = "qwen-alibaba-model-studio-cn"
ZCODE_PROVIDER_TOKENHUB = "e2a41300-b652-45ec-9f78-ebd2ec7889be"
ZCODE_PROVIDER_LABELS = {
    ZCODE_PROVIDER_BAILIAN: "阿里云百炼",
    ZCODE_PROVIDER_TOKENHUB: "腾讯TokenHub",
}

BUNDLED_CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"
MODELS_CACHE_PATHS = (
    Path(os.path.expanduser("~/.codex/models_cache.json")),
    Path(os.path.expanduser("~/.codex/models_cache.codex_work_desktop.json")),
)

VALID_DIFFICULTIES = ("auto", "low", "medium", "hard", "extreme")
VALID_QUALITIES = ("smart", "max", "balanced")
VALID_EFFORTS = ("low", "medium", "high", "xhigh", "max", "ultra")
MODEL_ID = re.compile(r"[A-Za-z0-9._/:@-]{1,160}")
VALID_BUILTIN_BACKENDS = ("codex", "zcode", "claude", "gemini")
VALID_SANDBOXES = ("read-only", "workspace-write")
VALID_ISOLATIONS = ("auto", "worktree", "inplace")
MAX_FAILOVER_ATTEMPTS = 3

EXTREME_KEYWORDS = (
    "architecture redesign",
    "system redesign",
    "distributed",
    "zero-downtime",
    "security audit",
    "race condition",
    "deadlock",
    "full rewrite",
    "end-to-end architecture",
    "架构重设计",
    "架构重构",
    "全链路",
    "安全审计",
    "死锁",
    "分布式",
)
HARD_KEYWORDS = (
    "refactor",
    "debug",
    "diagnose",
    "optimize",
    "algorithm",
    "concurrency",
    "async",
    "state machine",
    "compiler",
    "parser",
    "migration",
    "database",
    "schema",
    "multi-module",
    "cross-module",
    "performance",
    "root cause",
    "重构",
    "排查",
    "根因",
    "并发",
    "异步",
    "状态机",
    "复杂",
    "算法",
    "性能优化",
    "跨模块",
    "迁移",
)
CODE_IMPL_KEYWORDS = (
    "implement",
    "code",
    "function",
    "class",
    "api",
    "endpoint",
    "bug",
    "fix",
    "test",
    "pytest",
    "unittest",
    "sql",
    "script",
    "实现",
    "代码",
    "接口",
    "函数",
    "修复",
    "报错",
    "单测",
    "测试",
    "脚本",
    "审计",
    "审查",
)
LOW_KEYWORDS = (
    "typo",
    "readme",
    "comment",
    "docstring",
    "rename",
    "format",
    "lint",
    "unit test",
    "single file",
    "boilerplate",
    "scaffold",
    "summarize",
    "summary",
    "文档",
    "注释",
    "改名",
    "重命名",
    "单文件",
    "简单",
    "小修",
    "单元测试",
    "格式化",
    "总结",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def ensure_state_dirs() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    WORKTREES_DIR.mkdir(parents=True, exist_ok=True)


@contextlib.contextmanager
def locked_state() -> Iterator[dict[str, Any]]:
    """Load state.json under an exclusive flock and persist any mutations on exit."""
    ensure_state_dirs()
    with open(LOCK_FILE, "a+", encoding="utf-8") as lock_fh:
        fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX)
        try:
            if STATE_FILE.exists():
                try:
                    data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    data = {}
            else:
                data = {}
            if not isinstance(data, dict):
                data = {}
            data.setdefault("rr_counter", 0)
            data.setdefault("tasks", {})
            snapshot = json.dumps(data, sort_keys=True)
            yield data
            if json.dumps(data, sort_keys=True) != snapshot or not STATE_FILE.exists():
                tmp_path = STATE_FILE.with_suffix(".json.tmp")
                tmp_path.write_text(
                    json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                tmp_path.replace(STATE_FILE)
        finally:
            fcntl.flock(lock_fh.fileno(), fcntl.LOCK_UN)


def find_binary(name: str, fallbacks: tuple[str, ...] = ()) -> str | None:
    resolved = shutil.which(name)
    if resolved:
        return resolved
    for candidate in fallbacks:
        expanded = os.path.expanduser(candidate)
        if os.path.isfile(expanded) and os.access(expanded, os.X_OK):
            return expanded
    return None


def parse_codex_semver(version_text: str | None) -> tuple[int, int, int, int, int]:
    """Parse 'codex-cli 0.171.0-alpha.13' into a sortable tuple where stable > prerelease."""
    if not version_text:
        return (-1, 0, 0, 0, 0)
    match = re.search(r"(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.]+))?", version_text)
    if not match:
        return (-1, 0, 0, 0, 0)
    major, minor, patch = int(match.group(1)), int(match.group(2)), int(match.group(3))
    pre = match.group(4)
    if not pre:
        return (major, minor, patch, 1, 0)
    pre_nums = re.findall(r"\d+", pre)
    pre_patch = int(pre_nums[-1]) if pre_nums else 0
    return (major, minor, patch, 0, pre_patch)


def list_codex_candidates() -> list[dict[str, Any]]:
    """Inspect all available Codex CLI binaries and sort newest-first."""
    raw_candidates = [
        BUNDLED_CODEX_BIN,
        shutil.which("codex"),
        os.path.expanduser("~/.local/bin/codex"),
        os.path.expanduser("~/.npm-global/bin/codex"),
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
    ]
    seen_real: set[str] = set()
    candidates: list[dict[str, Any]] = []
    for path in raw_candidates:
        if not path:
            continue
        expanded = os.path.expanduser(path)
        if not (os.path.isfile(expanded) and os.access(expanded, os.X_OK)):
            continue
        real = os.path.realpath(expanded)
        if real in seen_real:
            continue
        seen_real.add(real)
        ver = probe_version([expanded, "--version"])
        candidates.append(
            {
                "bin": expanded,
                "version": ver,
                "_rank": parse_codex_semver(ver),
            }
        )
    candidates.sort(key=lambda item: item["_rank"], reverse=True)
    for item in candidates:
        item.pop("_rank", None)
    return candidates


def get_codex_bin() -> str | None:
    env_bin = os.environ.get("CODEX_BIN")
    if env_bin:
        expanded = os.path.expanduser(env_bin)
        if os.path.isfile(expanded) and os.access(expanded, os.X_OK):
            return expanded
    candidates = list_codex_candidates()
    return candidates[0]["bin"] if candidates else None


def get_node_bin() -> str | None:
    return find_binary(os.environ.get("NODE_BIN") or "node", ("~/.local/bin/node", "/opt/homebrew/bin/node"))


def get_git_bin() -> str | None:
    return find_binary("git", ("/usr/bin/git", "/opt/homebrew/bin/git"))


def probe_version(cmd: list[str]) -> str | None:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    output = (proc.stdout or proc.stderr or "").strip()
    return output.splitlines()[0] if output else None


def extract_model_generation(slug: str) -> tuple[int, int]:
    """Extract numeric generation tuple (major, minor) from model slug."""
    match = re.search(r"(\d+)(?:\.(\d+))?", slug)
    if not match:
        return (-1, -1)
    return (int(match.group(1)), int(match.group(2)) if match.group(2) else 0)


def normalize_cached_model(entry: dict[str, Any]) -> dict[str, Any] | None:
    slug = entry.get("slug") or entry.get("id")
    if not isinstance(slug, str) or not slug.strip():
        return None
    if entry.get("visibility") not in (None, "list") or entry.get("supported_in_api") is False:
        return None
    raw_levels = entry.get("supported_reasoning_levels")
    efforts: list[str] = []
    if isinstance(raw_levels, list):
        for lvl in raw_levels:
            if isinstance(lvl, dict) and isinstance(lvl.get("effort"), str) and lvl["effort"].strip():
                efforts.append(lvl["effort"].strip())
    priority = entry.get("priority")
    context_window = entry.get("context_window")
    return {
        "slug": slug.strip(),
        "gen": extract_model_generation(slug),
        "priority": priority if isinstance(priority, int) else 9999,
        "context_window": context_window if isinstance(context_window, int) else 0,
        "description": str(entry.get("description") or ""),
        "default_reasoning_level": entry.get("default_reasoning_level"),
        "supported_efforts": efforts,
    }


def pick_frontier_roles(listed_models: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Pick newest-generation flagship (highest capability) and wide_fast (largest context) siblings."""
    if not listed_models:
        return None, None
    ranked = sorted(
        listed_models,
        key=lambda m: (-m["gen"][0], -m["gen"][1], m["priority"], m["slug"]),
    )
    top_gen = ranked[0]["gen"]
    top_candidates = ranked[:3] if top_gen == (-1, -1) else [m for m in ranked if m["gen"] == top_gen]

    def _flagship_rank(m: dict[str, Any]) -> tuple[int, int, int, int]:
        desc = m["description"].lower()
        slug_l = m["slug"].lower()
        if "most capable" in desc or "complex" in desc:
            tier = 0
        elif any(tok in slug_l for tok in ("astra", "pro", "max")):
            tier = 1
        else:
            tier = 2
        return (tier, m["priority"], -m["context_window"], 0)

    flagship = min(top_candidates, key=_flagship_rank)
    siblings = [m for m in top_candidates if m["slug"] != flagship["slug"]]
    if not siblings:
        return flagship, flagship

    def _wide_rank(m: dict[str, Any]) -> tuple[int, int, int]:
        combined = f"{m['slug']} {m['description']}".lower()
        fast_hint = 0 if any(tok in combined for tok in ("go-to", "fast", "sol", "mini", "flash")) else 1
        return (-m["context_window"], fast_hint, m["priority"])

    wide_fast = min(siblings, key=_wide_rank)
    return flagship, wide_fast


def codex_catalog_override(config_file: str) -> str:
    configured = config_file if config_file != "~/.codex/models_cache.json" else ""
    return os.path.expanduser(os.environ.get("AGY_MODELS_CACHE_FILE") or configured)


def codex_cache_paths(config_file: str = "") -> tuple[Path, ...]:
    override = codex_catalog_override(config_file)
    if override:
        return (Path(override),)
    if os.environ.get("CODEX_HOME"):
        return tuple(Path(os.environ["CODEX_HOME"]).expanduser() / p.name for p in MODELS_CACHE_PATHS)
    return MODELS_CACHE_PATHS


def discover_frontier_models(config_file: str = "") -> dict[str, Any]:
    """Read live Codex models cache and dynamically resolve flagship & wide_fast models."""
    best: dict[str, Any] | None = None
    best_score = (-1, (-2, 0, 0, 0, 0))
    for cache_path in codex_cache_paths(config_file):
        if not cache_path.exists():
            continue
        try:
            raw = json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        client_ver = raw.get("client_version") if isinstance(raw, dict) else None
        raw_models = raw.get("models", raw) if isinstance(raw, dict) else raw
        listed: list[dict[str, Any]] = []
        if isinstance(raw_models, list):
            for entry in raw_models:
                if isinstance(entry, dict):
                    norm = normalize_cached_model(entry)
                    if norm:
                        listed.append(norm)
        score = (len(listed), parse_codex_semver(client_ver))
        if best is None or score > best_score:
            best_score = score
            flagship, wide_fast = pick_frontier_roles(listed)
            best = {
                "exists": True,
                "source_file": str(cache_path),
                "client_version": client_ver,
                "flagship": flagship,
                "wide_fast": wide_fast,
                "listed_models": listed,
                "listed_slugs": [m["slug"] for m in sorted(listed, key=lambda x: (-x["gen"][0], -x["gen"][1], x["priority"]))],
            }

    if best is None:
        return {
            "exists": False,
            "source_file": None,
            "client_version": None,
            "flagship": None,
            "wide_fast": None,
            "listed_models": [],
            "listed_slugs": [],
        }
    return best


def engine_config_path() -> Path:
    if ENGINE_CONFIG_FILE != _INITIAL_ENGINE_CONFIG_FILE:
        return Path(ENGINE_CONFIG_FILE).expanduser()
    state_dir = Path(os.environ.get("AGY_DISPATCH_STATE_DIR", STATE_DIR))
    return Path(os.environ.get("AGY_ENGINE_CONFIG_FILE") or state_dir / "engine_config.json").expanduser()


def custom_engine(engine_id: str) -> dict:
    args = "-p {prompt} --model {model}"
    return {
        "id": engine_id, "name": engine_id, "builtin": False, "kind": "custom_cli",
        "enabled": False, "binPath": engine_id, "configFilePath": "",
        "models": {"primaryModel": "", "fallbackModel": "", "defaultEffort": "high"},
        "adapter": {"execTemplate": "{bin} " + args, "readonlyTemplate": "{bin} " + args,
                    "resumeTemplate": "{bin} --resume {session_id} " + args, "syncDesktopIndex": False},
    }


def default_engine_config() -> dict:
    b = ZCODE_PROVIDER_BAILIAN
    engines = [custom_engine(key) for key in VALID_BUILTIN_BACKENDS]
    codex, zcode, claude, gemini = engines
    for engine in engines:
        engine["builtin"] = True
    codex.update(name="OpenAI Codex", kind="codex", enabled=True, binPath="", configFilePath="~/.codex/models_cache.json")
    codex["models"].update(primaryModel="auto", defaultEffort="xhigh")
    codex["adapter"].update(
        execTemplate='codex exec -C {cwd} -m {model} -c model_reasoning_effort="{effort}" -s {sandbox} --json -',
        readonlyTemplate='codex exec review -m {model} -c model_reasoning_effort="{effort}" -c sandbox_mode="read-only" --json',
        resumeTemplate='codex exec resume -m {model} -c model_reasoning_effort="{effort}" {session_id} -',
    )
    zcode.update(name="ZCode CLI", kind="zcode", enabled=False, binPath=str(ZCODE_SCRIPT), configFilePath="~/.zcode/v2/provider_config.json")
    zcode["models"].update(primaryModel=f"{b}/kimi-k3", fallbackModel=f"{b}/deepseek-v4-pro-0813", defaultEffort="max")
    zargs = "-p {prompt} --cwd {cwd} --mode "
    zcode["adapter"].update(execTemplate="node {bin} " + zargs + "build --json --no-color",
                            readonlyTemplate="node {bin} " + zargs + "plan --json --no-color",
                            resumeTemplate="node {bin} --resume {session_id} " + zargs + "build --json --no-color",
                            syncDesktopIndex=True)
    claude.update(name="Claude Code", configFilePath="~/.claude.json")
    claude["models"]["primaryModel"] = "claude-sonnet-4-6"
    gemini.update(name="Gemini CLI", configFilePath="~/.gemini/settings.json")
    gemini["models"]["primaryModel"] = "gemini-2.5-pro"
    for engine, flag in [(claude, "--model"), (gemini, "-m")]:
        args = "-p {prompt} " + flag + " {model}"
        plan = " --permission-mode plan" if engine is claude else ""
        engine["adapter"].update(execTemplate="{bin} " + args + " --output-format json",
                                 readonlyTemplate="{bin} " + args + plan + " --output-format json",
                                 resumeTemplate="{bin} --resume {session_id} " + args + " --output-format json")
    scenarios = {key: {"enabled": False, "engineId": "", "model": "", "fallbackModel": "",
                       "effort": "xhigh" if key == "architecture_concurrency" else "max"}
                 for key in ("wide_context", "architecture_concurrency", "chinese_business_security", "unit_tests_and_tools")}
    return {
        "version": 2, "updatedAtMs": 0, "engines": engines,
        "workflowRoles": {"primaryBuilder": {"engineId": "codex", "model": "auto", "effort": "xhigh"},
                          "reviewer": {"mode": "auto_heterogeneous", "engineId": "", "model": "auto", "effort": "max"},
                          "scenarios": scenarios},
        "policy": {"costStrategy": "effect_first", "defaultIsolation": "worktree", "hideDisabledEngineTasks": False},
    }


def update_fields(base: dict, patch: Any) -> None:
    if not isinstance(patch, dict):
        return
    for key, value in base.items():
        supplied = patch.get(key)
        if isinstance(value, dict):
            update_fields(value, supplied)
        elif type(supplied) is type(value):
            base[key] = supplied


def legacy_zcode_scenarios(routes: dict, scenarios: dict) -> None:
    # V1 seeded these selectors from installed providers. A fully saved, untouched
    # settings form must not accidentally opt its owner into scenario routing.
    models = [p["provider_id"] + "/" + m for p in discover_zcode_models()["providers"] for m in p["models"]]
    b, t = ZCODE_PROVIDER_BAILIAN + "/", ZCODE_PROVIDER_TOKENHUB + "/"
    bk, bd, bq = b + "kimi-k3", b + "deepseek-v4-pro-0813", b + "qwen3.8-max"
    tk, td, tg, tf = t + "kimi-k3", t + "deepseek-v4-pro-0813", t + "glm-5.3", t + "deepseek-v4.1-flash"
    for key, target, effort, pairs in [
        ("wide_1m_context", "wide_context", "max", [(tg, bk), (bk, bd), (bd, tk)]),
        ("reasoning_and_business", "chinese_business_security", "max", [(bk, tk), (tk, bq), (bq, bd)]),
        ("fast_tool_and_plugin", "unit_tests_and_tools", "xhigh", [(bq, tf), (tf, bk), (bk, tk)]),
    ]:
        route = routes.get(key)
        if not isinstance(route, dict):
            continue
        old = {"effort": effort}
        benchmark = {"effort": effort}
        for i, (slot, preferred) in enumerate(zip(("primary", "fallback1", "fallback2"), pairs)):
            benchmark[slot] = preferred[0]
            old[slot] = next((m for m in preferred if m in models),
                             models[i] if len(models) > i else models[0] if models else preferred[0])
        if all(any(route.get(k) and route[k] != v for k, v in defaults.items()) for defaults in (old, benchmark)):
            backup = route.get("fallback1") or route.get("fallback2") or old["fallback1"]
            if route.get("fallback2") and route["fallback2"] != old["fallback2"] and route.get("fallback1") == old["fallback1"]:
                backup = route["fallback2"]
            scenarios[target].update(enabled=True, engineId="zcode", model=route.get("primary") or old["primary"],
                                     fallbackModel=backup,
                                     effort=route.get("effort") or effort)


def migrate_v1(saved: dict, config: dict) -> None:
    codex, zcode = config["engines"][:2]
    c, z = saved.get("codex") or {}, saved.get("zcode") or {}
    update_fields(codex, {"enabled": c.get("enabled"), "binPath": c.get("binPath"),
                          "models": {"primaryModel": c.get("flagshipModel"), "defaultEffort": c.get("defaultEffort"),
                                     "fallbackModel": "" if c.get("fastModel") == "auto" else c.get("fastModel")}})
    routes = z.get("routes") or {}
    code = routes.get("code_and_audit") or {}
    update_fields(zcode, {"enabled": z.get("enabled"), "binPath": z.get("scriptPath"),
                          "models": {"primaryModel": code.get("primary") or None, "fallbackModel": code.get("fallback1") or None,
                                     "defaultEffort": z.get("defaultEffort")},
                          "adapter": {"syncDesktopIndex": z.get("syncDesktopIndex")}})
    roles = config["workflowRoles"]
    if routes:
        legacy_zcode_scenarios(routes, roles["scenarios"])
    update_fields(config["policy"], {"defaultIsolation": c.get("defaultIsolation")})
    if (saved.get("policy") or {}).get("reviewPolicy") == "codex_only":
        roles["reviewer"].update(mode="explicit", engineId="codex")
    engines = {e["id"]: e for e in config["engines"]}
    seen = {"codex", "zcode"}
    for old in saved.get("customAgents") or []:
        key = validate_engine_id(old["id"], seen)
        engine = engines.get(key)
        if engine is None:
            engine = custom_engine(key)
            config["engines"].append(engine)
        name = old.get("name")
        update_fields(engine, {"name": "Claude Code" if key == "claude" and name == "Claude Code CLI" else name,
                               "binPath": old.get("binPath"), "enabled": old.get("enabled"),
                               "configFilePath": old.get("configFilePath"),
                               "models": {"primaryModel": old.get("defaultModel"), "defaultEffort": old.get("effort")}})
        args = (old.get("argsTemplate") or "").strip()
        if args:
            engine["adapter"]["execTemplate"] = args if "{bin}" in args else "{bin} " + args


def validate_engine_id(key: str, seen: set) -> str:
    if not isinstance(key, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,31}", key) or key in ("auto", "all"):
        raise ValueError(f"Invalid CLI engine ID: {key}")
    if key in seen:
        raise ValueError(f"Duplicate CLI engine ID: {key}")
    seen.add(key)
    return key


def load_engine_config() -> dict[str, Any]:
    config = default_engine_config()
    try:
        saved = json.loads(engine_config_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return config
    if not isinstance(saved, dict):
        return config
    legacy = saved.get("version") != 2 or any(k in saved for k in ("codex", "zcode", "customAgents"))
    if legacy:
        migrate_v1(saved, config)
    if "engines" in saved:
        current = {e["id"]: e for e in config["engines"]}
        engines = []
        seen: set[str] = set()
        for row in saved["engines"]:
            key = validate_engine_id(row.get("id"), seen)
            engine = current.get(key) or custom_engine(key)
            update_fields(engine, {k: v for k, v in row.items() if k not in ("builtin", "kind")})
            engines.append(engine)
        for key, engine in current.items():
            if engine["builtin"] and key not in seen:
                if saved.get("version") == 2:
                    engine["enabled"] = False
                engines.append(engine)
        config["engines"] = engines
    update_fields(config["policy"], saved.get("policy"))
    update_fields(config["workflowRoles"], saved.get("workflowRoles"))
    update_fields(config, {"updatedAtMs": saved.get("updatedAtMs")})
    active = [e["id"] for e in config["engines"] if e["enabled"]]
    if not active:
        recovered = config["engines"][0]
        if saved.get("version") != 2 and (saved.get("codex") or {}).get("enabled") is False:
            recovered = next(e for e in config["engines"] if e["id"] == "zcode")
        recovered["enabled"] = True
        active = [recovered["id"]]
    roles = config["workflowRoles"]
    missing_builder = saved.get("version") == 2 and not (saved.get("workflowRoles", {}).get("primaryBuilder") or {}).get("engineId")
    if missing_builder or roles["primaryBuilder"]["engineId"] not in active:
        roles["primaryBuilder"].update(engineId=active[0], model="auto")
    reviewer = roles["reviewer"]
    if reviewer["mode"] != "explicit" or reviewer["engineId"] not in active:
        reviewer.update(mode="auto_heterogeneous", engineId="")
    return config


def zcode_config_path(config_file: str = "") -> Path:
    if not config_file or config_file == "~/.zcode/v2/provider_config.json":
        config_file = (Path(os.environ["ZCODE_HOME"]) / "v2" / "provider_config.json"
                       if os.environ.get("ZCODE_HOME") else ZCODE_PERSONAL_PROVIDER_CONFIG)
    return Path(os.environ.get("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE") or config_file).expanduser()


def discover_zcode_models(config_file: str = "") -> dict[str, Any]:
    """Inspect local ~/.zcode/v2/provider_config.json for configured providers and models."""
    cfg_path = zcode_config_path(config_file)
    if not cfg_path.exists():
        return {"exists": False, "source_file": str(cfg_path), "providers": []}
    try:
        raw = json.loads(cfg_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"exists": False, "source_file": str(cfg_path), "providers": []}

    root = raw.get("config") if isinstance(raw, dict) else None
    rules_config = root.get("providerConfigRules") if isinstance(root, dict) else None
    rules = rules_config.get("providerRules") if isinstance(rules_config, dict) else None
    providers: list[dict[str, Any]] = []
    for r in rules if isinstance(rules, list) else []:
        if not isinstance(r, dict):
            continue
        pid = str(r.get("providerId") or "").strip()
        pname = str(r.get("providerName") or ZCODE_PROVIDER_LABELS.get(pid, pid)).strip()
        rcfg = r.get("config") if isinstance(r.get("config"), dict) else {}
        models = rcfg.get("modelOrder") or rcfg.get("personalModelIds") or []
        models = models if isinstance(models, list) else []
        if pid:
            providers.append(
                {
                    "provider_id": pid,
                    "provider_name": pname,
                    "models": [str(m) for m in models if isinstance(m, str) and "/" not in m],
                }
            )
    return {
        "exists": True,
        "source_file": str(cfg_path),
        "providers": providers,
    }


def pick_supported_effort(preferred_chain: tuple[str, ...], supported_efforts: list[str]) -> str:
    if not supported_efforts:
        return preferred_chain[0]
    for eff in preferred_chain:
        if eff in supported_efforts:
            return eff
    return supported_efforts[-1]


def classify_difficulty(prompt: str, files_hint: list[str] | None = None) -> tuple[str, str]:
    """Deterministically classify task difficulty from prompt text and file hints."""
    text = prompt.lower()
    files_count = len(files_hint or [])

    if any(kw in text for kw in EXTREME_KEYWORDS):
        return "extreme", "matched extreme-tier architectural/concurrency/audit keyword"
    if any(kw in text for kw in HARD_KEYWORDS) or files_count >= 5:
        reason = (
            "matched hard-tier complexity keyword"
            if any(kw in text for kw in HARD_KEYWORDS)
            else f"broad scope ({files_count} target files)"
        )
        return "hard", reason
    if (any(kw in text for kw in LOW_KEYWORDS) or len(prompt.strip()) <= 140) and files_count <= 2:
        if any(kw in text for kw in LOW_KEYWORDS):
            return "low", "matched low-tier routine/doc/test keyword"
        if len(prompt.strip()) <= 140:
            return "low", "short localized prompt (<=140 chars)"
    return "medium", "default medium-tier implementation scope"


def validate_model(value: str) -> str:
    if not isinstance(value, str) or not MODEL_ID.fullmatch(value):
        raise ValueError("Invalid model ID: expected 1–160 characters from A-Z, a-z, 0-9 or ._/:@-")
    return value


def validate_effort(value: str) -> str:
    if value not in VALID_EFFORTS:
        raise ValueError(f"Invalid reasoning effort: expected one of {', '.join(VALID_EFFORTS)}")
    return value


def selected_model(value: str | None) -> str | None:
    return validate_model(value) if value not in (None, "", "auto") else None


def match_scenario(prompt: str, files_hint: list[str] | None, difficulty: str, prefer_wide: bool) -> str | None:
    text = prompt.lower()
    if prefer_wide or len(files_hint or []) >= 10 or any(k in text for k in (
        "wide context", "wide_context", "1m context", "whole repository", "repo-wide", "long context", "100万", "全库", "超长上下文", "长上下文",
    )):
        return "wide_context"
    if any(k in text for k in ("architecture", "concurrency", "concurrent", "race condition", "deadlock", "distributed",
                                "架构", "并发", "死锁", "分布式")):
        return "architecture_concurrency"
    if any(k in text for k in ("chinese_business_security", "business logic", "business rules", "security audit",
                                "business security", "中文", "业务", "安全", "审批", "合规", "风控", "审计")):
        return "chinese_business_security"
    if any(k in text for k in ("unit test", "unit_test", "unittest", "pytest", "tooling", "tools", "plugin", "单测",
                                "单元测试", "测试工具", "插件", "工具", "脚本")):
        return "unit_tests_and_tools"
    return None


def registered_engine(config: dict, engine_id: str) -> dict:
    engine = next((e for e in config["engines"] if e["id"] == engine_id), None)
    if engine is None:
        raise ValueError(f"Unknown CLI engine: {engine_id}")
    if not engine["enabled"]:
        raise ValueError(f"Engine '{engine_id}' is disabled in engine_config.json")
    return engine


def resolve_run_target(requested_backend, prompt, files_hint, difficulty, prefer_wide, explicit_model, explicit_effort, config):
    if explicit_model is not None:
        validate_model(explicit_model)
    if explicit_effort is not None:
        validate_effort(explicit_effort)
    roles = config["workflowRoles"]
    role = {}
    scenario = None
    backend = requested_backend
    if backend in (None, "auto"):
        active = [e["id"] for e in config["engines"] if e["enabled"]]
        if not active:
            raise ValueError("至少需要启用 1 个 CLI 引擎，无法全部关闭")
        role = roles["primaryBuilder"]
        backend = role["engineId"] if role["engineId"] in active else active[0]
        key = match_scenario(prompt, files_hint, difficulty, prefer_wide)
        candidate = roles["scenarios"].get(key, {})
        if candidate.get("enabled") and candidate.get("engineId") in active:
            scenario, role, backend = key, candidate, candidate["engineId"]
    engine = registered_engine(config, backend)
    effort = explicit_effort or role.get("effort")
    if effort:
        validate_effort(effort)
    return {"backend": backend, "engine": engine, "scenario": scenario, "scenario_role": role if scenario else {},
            "model": selected_model(explicit_model) or selected_model(role.get("model")),
            "fallback_model": selected_model(role.get("fallbackModel")),
            "effort": effort}


def engine_bin(engine: dict) -> str | None:
    configured = os.path.expanduser(engine["binPath"])
    if engine["kind"] == "zcode":
        script = Path(configured or ZCODE_SCRIPT)
        return str(script) if script.is_file() else None
    if engine["kind"] == "codex" and not configured:
        return get_codex_bin()
    return find_binary(configured or engine["id"])


def is_engine_available(engine: dict) -> bool:
    return bool(engine_bin(engine) and (engine["kind"] != "zcode" or get_node_bin()))


def resolve_zcode_model_and_fallbacks(
    *,
    difficulty: str,
    prompt: str,
    files_hint: list[str] | None = None,
    explicit_model: str | None = None,
    explicit_effort: str | None = None,
    prefer_wide: bool = False,
    is_review: bool = False,
    engine: dict | None = None,
    scenario_override: dict | None = None,
) -> dict[str, Any]:
    """Select the optimal ZCode flagship model & multi-provider failover chain based on live benchmarks."""
    if difficulty == "auto":
        effective_difficulty, difficulty_reason = classify_difficulty(prompt, files_hint)
    else:
        effective_difficulty = difficulty
        difficulty_reason = f"explicit difficulty={difficulty}"

    use_wide = prefer_wide or len(files_hint or []) >= 10
    text_l = prompt.lower()
    is_code_heavy = is_review or effective_difficulty == "hard" or any(kw in text_l for kw in CODE_IMPL_KEYWORDS)

    if use_wide:
        scenario = "wide_1m_context"
        base_chain = [
            (ZCODE_PROVIDER_TOKENHUB, "glm-5.3", "max", "腾讯TokenHub 100万窗口主选"),
            (ZCODE_PROVIDER_BAILIAN, "kimi-k3", "max", "阿里云百炼 一级热备"),
            (ZCODE_PROVIDER_BAILIAN, "deepseek-v4-pro-0813", "max", "阿里云百炼 二级热备"),
        ]
    elif is_code_heavy:
        scenario = "code_and_audit_flagship"
        base_chain = [
            (ZCODE_PROVIDER_BAILIAN, "kimi-k3", "max", "阿里云百炼 多轮工具/代码审计主选(6.1s)"),
            (ZCODE_PROVIDER_BAILIAN, "deepseek-v4-pro-0813", "max", "阿里云百炼 深度代码一级热备(TTFT 2.2s)"),
            (ZCODE_PROVIDER_TOKENHUB, "deepseek-v4-pro-0813", "max", "腾讯TokenHub 跨渠道二级热备"),
            (ZCODE_PROVIDER_TOKENHUB, "kimi-k3", "max", "腾讯TokenHub 跨渠道三级热备"),
        ]
    elif effective_difficulty in ("medium", "extreme"):
        scenario = "reasoning_and_business_flagship"
        base_chain = [
            (ZCODE_PROVIDER_BAILIAN, "kimi-k3", "max", "阿里云百炼 综合/业务主选(6.1s)"),
            (ZCODE_PROVIDER_TOKENHUB, "kimi-k3", "max", "腾讯TokenHub 同模型一级热备"),
            (ZCODE_PROVIDER_BAILIAN, "qwen3.8-max", "xhigh", "阿里云百炼 异构二级热备(7.8s)"),
        ]
    else:
        scenario = "fast_tool_flagship"
        base_chain = [
            (ZCODE_PROVIDER_BAILIAN, "qwen3.8-max", "xhigh", "阿里云百炼 工具/轻量主选(7.8s)"),
            (ZCODE_PROVIDER_TOKENHUB, "deepseek-v4.1-flash", "max", "腾讯TokenHub 零报错一级热备"),
            (ZCODE_PROVIDER_BAILIAN, "kimi-k3", "max", "阿里云百炼 二级热备"),
        ]

    if explicit_model is not None:
        validate_model(explicit_model)
    if engine is None:
        engine = next(e for e in load_engine_config()["engines"] if e["id"] == "zcode")
    settings = engine["models"]
    scenario_override = scenario_override or {}
    discovered_z = discover_zcode_models(engine["configFilePath"])
    dynamic_labels = dict(ZCODE_PROVIDER_LABELS)
    for p in discovered_z.get("providers", []):
        if isinstance(p, dict) and p.get("provider_id") and p.get("provider_name"):
            dynamic_labels[str(p["provider_id"])] = str(p["provider_name"])

    configured_effort = settings["defaultEffort"] if engine_config_path().is_file() else None
    preferred_effort = explicit_effort or scenario_override.get("effort") or configured_effort
    if preferred_effort is not None:
        validate_effort(preferred_effort)
    chain: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()

    def _add_candidate(pid: str, mid: str, eff: str, note: str) -> None:
        if not pid or not mid:
            return
        key = (pid, mid)
        if key in seen:
            return
        seen.add(key)
        chain.append(
            {
                "provider_id": pid,
                "provider_label": dynamic_labels.get(pid, pid),
                "model_id": mid,
                "full_model": f"{pid}/{mid}",
                "effort": preferred_effort or eff,
                "note": note,
            }
        )

    if explicit_model and explicit_model.strip() and explicit_model.strip() not in ("zcode-default", "auto"):
        raw_m = explicit_model.strip()
        if "/" in raw_m:
            pid, mid = raw_m.split("/", 1)
            eff = "xhigh" if "qwen" in mid else "max"
            _add_candidate(pid.strip(), mid.strip(), eff, "用户显式指定渠道与模型")
        else:
            eff = "xhigh" if "qwen" in raw_m else "max"
            if raw_m == "glm-5.3":
                _add_candidate(ZCODE_PROVIDER_TOKENHUB, raw_m, eff, "用户显式指定 100万窗口 GLM-5.3")
            elif raw_m == "deepseek-v4.1-flash":
                _add_candidate(ZCODE_PROVIDER_TOKENHUB, raw_m, eff, "用户显式指定 DeepSeek-V4.1-Flash")
            else:
                _add_candidate(ZCODE_PROVIDER_BAILIAN, raw_m, eff, "用户显式指定模型(阿里云百炼优先)")
                if raw_m in ("kimi-k3", "deepseek-v4-pro-0813"):
                    _add_candidate(ZCODE_PROVIDER_TOKENHUB, raw_m, eff, "用户显式指定模型(腾讯TokenHub同模热备)")

    def add_setting(model, note):
        if not selected_model(model):
            return
        pid, sep, mid = model.partition("/")
        if not sep:
            pid, mid = next((p["provider_id"] for p in discovered_z["providers"] if model in p["models"]),
                            ZCODE_PROVIDER_BAILIAN), model
        _add_candidate(pid, mid, scenario_override.get("effort") or settings["defaultEffort"], note)

    add_setting(scenario_override.get("model"), "场景主选模型")
    add_setting(scenario_override.get("fallbackModel"), "场景备用模型")
    default_pair = (f"{ZCODE_PROVIDER_BAILIAN}/kimi-k3", f"{ZCODE_PROVIDER_BAILIAN}/deepseek-v4-pro-0813")
    if (settings["primaryModel"], settings["fallbackModel"]) != default_pair:
        add_setting(settings["primaryModel"], "设置页主选模型")
        add_setting(settings["fallbackModel"], "设置页一级热备")

    for pid, mid, eff, note in base_chain:
        _add_candidate(pid, mid, eff, note)

    # Also append any user-discovered local ZCode provider models for universal portability
    for p in discovered_z.get("providers", []):
        pid = str(p.get("provider_id") or "").strip()
        for mid in p.get("models", []):
            eff = "xhigh" if "qwen" in str(mid) else "max"
            _add_candidate(pid, str(mid).strip(), eff, "本机自动发现渠道兜底")

    primary = chain[0]
    return {
        "requested_difficulty": difficulty,
        "effective_difficulty": effective_difficulty,
        "difficulty_reason": difficulty_reason,
        "scenario": scenario,
        "prefer_wide": use_wide,
        "provider_id": primary["provider_id"],
        "provider_label": primary["provider_label"],
        "model_id": primary["model_id"],
        "model": primary["full_model"],
        "effort": primary["effort"],
        "fallback_chain": chain,
        "rr_slot": None,
        "route_note": (
            f"zcode scenario={scenario}, difficulty={effective_difficulty} -> "
            f"{primary['provider_label']}/{primary['model_id']} (effort={primary['effort']}, "
            f"backups={len(chain) - 1})"
        ),
    }


def resolve_model_and_effort(
    *,
    difficulty: str,
    prompt: str,
    files_hint: list[str] | None = None,
    explicit_model: str | None = None,
    explicit_effort: str | None = None,
    quality: str = "smart",
    alternate: bool | None = None,
    prefer_wide: bool = False,
    config_file: str = "",
) -> dict[str, Any]:
    """Dynamically route across newest official Codex models by quality mode & difficulty."""
    if difficulty == "auto":
        effective_difficulty, difficulty_reason = classify_difficulty(prompt, files_hint)
    else:
        effective_difficulty = difficulty
        difficulty_reason = f"explicit difficulty={difficulty}"

    use_alternate = (quality in ("smart", "balanced")) if alternate is None else alternate
    frontier = discover_frontier_models(config_file)
    flagship = frontier["flagship"]
    wide_fast = frontier["wide_fast"]
    flagship_slug = flagship["slug"] if flagship else None
    wide_slug = wide_fast["slug"] if wide_fast else None

    flagship_ctx = flagship["context_window"] if flagship else 0
    wide_ctx = wide_fast["context_window"] if wide_fast else 0
    wide_auto = (
        difficulty == "auto"
        and len(files_hint or []) >= 10
        and wide_fast is not None
        and wide_ctx > flagship_ctx
    )
    use_wide = prefer_wide or wide_auto

    rr_slot: int | None = None
    target_meta: dict[str, Any] | None
    if quality == "smart":
        if effective_difficulty == "low":
            target_meta = wide_fast or flagship
            effort_chain = ("medium", "high", "low")
            role_label = "wide_fast"
        elif effective_difficulty == "medium":
            if use_wide and wide_fast:
                target_meta = wide_fast
                effort_chain = ("high", "xhigh", "medium")
                role_label = "wide_fast (prefer-wide)"
            elif use_alternate and not explicit_model and flagship and wide_fast and flagship_slug != wide_slug:
                with locked_state() as state:
                    rr_slot = int(state.get("rr_counter", 0))
                    state["rr_counter"] = rr_slot + 1
                if rr_slot % 2 == 0:
                    target_meta = wide_fast
                    effort_chain = ("high", "xhigh", "medium")
                    role_label = f"wide_fast (smart slot {rr_slot})"
                else:
                    target_meta = flagship
                    effort_chain = ("high", "xhigh", "medium")
                    role_label = f"flagship (smart slot {rr_slot})"
            else:
                target_meta = flagship or wide_fast
                effort_chain = ("high", "xhigh", "medium")
                role_label = "flagship"
        elif effective_difficulty == "hard":
            target_meta = wide_fast if (use_wide and wide_fast) else flagship
            effort_chain = ("xhigh", "max", "high")
            role_label = "wide_fast" if (use_wide and wide_fast) else "flagship"
        else:
            target_meta = wide_fast if (use_wide and wide_fast) else flagship
            effort_chain = ("max", "ultra", "xhigh", "high")
            role_label = "wide_fast" if (use_wide and wide_fast) else "flagship"
    elif quality == "max":
        if effective_difficulty == "low":
            target_meta = wide_fast if (use_wide and wide_fast) else flagship
            effort_chain = ("high", "xhigh", "medium")
            role_label = "wide_fast" if (use_wide and wide_fast) else "flagship"
        elif effective_difficulty == "medium":
            if use_wide and wide_fast:
                target_meta = wide_fast
                effort_chain = ("max", "xhigh", "high")
                role_label = "wide_fast (prefer-wide)"
            elif use_alternate and not explicit_model and flagship and wide_fast and flagship_slug != wide_slug:
                with locked_state() as state:
                    rr_slot = int(state.get("rr_counter", 0))
                    state["rr_counter"] = rr_slot + 1
                if rr_slot % 2 == 0:
                    target_meta = flagship
                    effort_chain = ("xhigh", "max", "high")
                    role_label = f"flagship (max-alt slot {rr_slot})"
                else:
                    target_meta = wide_fast
                    effort_chain = ("max", "xhigh", "high")
                    role_label = f"wide_fast (max-alt slot {rr_slot})"
            else:
                target_meta = flagship
                effort_chain = ("xhigh", "max", "high")
                role_label = "flagship"
        elif effective_difficulty == "hard":
            target_meta = wide_fast if (use_wide and wide_fast) else flagship
            effort_chain = ("max", "xhigh", "high")
            role_label = "wide_fast" if (use_wide and wide_fast) else "flagship"
        else:
            target_meta = wide_fast if (use_wide and wide_fast) else flagship
            effort_chain = ("ultra", "max", "xhigh", "high")
            role_label = "wide_fast" if (use_wide and wide_fast) else "flagship"
    else:
        if effective_difficulty == "low":
            target_meta = wide_fast or flagship
            effort_chain = ("medium", "high", "low")
            role_label = "wide_fast"
        elif effective_difficulty == "medium":
            if use_alternate and not explicit_model and flagship and wide_fast and flagship_slug != wide_slug:
                with locked_state() as state:
                    rr_slot = int(state.get("rr_counter", 0))
                    state["rr_counter"] = rr_slot + 1
                if rr_slot % 2 == 0:
                    target_meta = wide_fast
                    effort_chain = ("high", "medium")
                    role_label = f"wide_fast (balanced slot {rr_slot})"
                else:
                    target_meta = flagship
                    effort_chain = ("medium", "high")
                    role_label = f"flagship (balanced slot {rr_slot})"
            else:
                target_meta = wide_fast or flagship
                effort_chain = ("high", "medium")
                role_label = "wide_fast"
        elif effective_difficulty == "hard":
            target_meta = flagship
            effort_chain = ("high", "xhigh", "medium")
            role_label = "flagship"
        else:
            target_meta = flagship
            effort_chain = ("xhigh", "max", "high")
            role_label = "flagship"

    routed_model = target_meta["slug"] if target_meta else None
    final_model = explicit_model or routed_model

    if explicit_effort:
        final_effort = explicit_effort
    else:
        matched_meta = next(
            (m for m in frontier["listed_models"] if m["slug"] == final_model),
            target_meta,
        )
        supported_effs = matched_meta["supported_efforts"] if matched_meta else []
        final_effort = pick_supported_effort(effort_chain, supported_effs)

    model_label = final_model or "codex-cli-default"
    route_note = (
        f"quality={quality}, difficulty={effective_difficulty} -> "
        f"{'explicit override' if explicit_model else role_label}: {model_label} (effort={final_effort})"
    )
    return {
        "requested_difficulty": difficulty,
        "effective_difficulty": effective_difficulty,
        "difficulty_reason": difficulty_reason,
        "quality_mode": quality,
        "prefer_wide": use_wide,
        "model": final_model,
        "effort": final_effort,
        "rr_slot": rr_slot,
        "cache_client_version": frontier["client_version"],
        "discovered_flagship": flagship_slug,
        "discovered_wide_fast": wide_slug,
        "route_note": route_note,
    }


def inspect_git(workdir: Path) -> dict[str, Any]:
    git_bin = get_git_bin()
    if not git_bin:
        return {"is_git_repo": False, "repo_root": None, "head_sha": None, "branch": None}

    top = subprocess.run(
        [git_bin, "-C", str(workdir), "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
    )
    if top.returncode != 0:
        return {"is_git_repo": False, "repo_root": None, "head_sha": None, "branch": None}

    repo_root = Path(top.stdout.strip()).resolve()
    head = subprocess.run(
        [git_bin, "-C", str(repo_root), "rev-parse", "--verify", "HEAD"],
        capture_output=True,
        text=True,
    )
    head_sha = head.stdout.strip() if head.returncode == 0 else None

    branch_proc = subprocess.run(
        [git_bin, "-C", str(repo_root), "rev-parse", "--abbrev-ref", "HEAD"],
        capture_output=True,
        text=True,
    )
    branch = branch_proc.stdout.strip() if branch_proc.returncode == 0 else None
    return {
        "is_git_repo": True,
        "repo_root": str(repo_root),
        "head_sha": head_sha,
        "branch": branch,
    }


def resolve_isolation(
    requested_isolation: str,
    sandbox: str,
    git_info: dict[str, Any],
) -> tuple[str, str]:
    """Determine effective isolation ('worktree' vs 'inplace') with safe fallbacks."""
    is_git = git_info["is_git_repo"]
    has_head = bool(git_info["head_sha"])

    if requested_isolation == "inplace":
        return "inplace", "explicitly requested inplace execution"

    if requested_isolation == "worktree":
        if not is_git or not has_head:
            raise ValueError(
                "worktree isolation requires a Git repository with at least one commit (HEAD)."
            )
        return "worktree", "explicitly requested isolated Git worktree"

    if sandbox == "read-only":
        return "inplace", "auto isolation uses inplace for read-only sandbox"
    if not is_git or not has_head:
        return "inplace", "auto isolation fell back to inplace (non-Git or repo without HEAD commit)"
    return "worktree", "auto isolation selected isolated Git worktree for workspace-write"


def create_worktree(repo_root: str, task_id: str, base_sha: str) -> tuple[Path, str]:
    git_bin = get_git_bin()
    if not git_bin:
        raise RuntimeError("git executable not found")
    repo_slug = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(repo_root).name).strip("-") or "repo"
    wt_path = WORKTREES_DIR / repo_slug / task_id
    wt_path.parent.mkdir(parents=True, exist_ok=True)
    branch_name = f"agy-worker/{task_id}"
    proc = subprocess.run(
        [git_bin, "-C", repo_root, "worktree", "add", "-b", branch_name, str(wt_path), base_sha],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"git worktree add failed: {(proc.stderr or proc.stdout).strip()}"
        )
    return wt_path, branch_name


def remove_worktree(
    repo_root: str,
    worktree_path: str | None,
    branch_name: str | None,
    *,
    delete_branch: bool = False,
    force: bool = False,
) -> dict[str, Any]:
    git_bin = get_git_bin()
    if not git_bin:
        raise RuntimeError("git executable not found")
    details: dict[str, Any] = {"worktree_removed": False, "branch_deleted": False, "messages": []}

    if worktree_path and Path(worktree_path).exists():
        cmd = [git_bin, "-C", repo_root, "worktree", "remove"]
        if force:
            cmd.append("--force")
        cmd.append(worktree_path)
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(
                f"git worktree remove failed: {(proc.stderr or proc.stdout).strip()}"
            )
        details["worktree_removed"] = True
        details["messages"].append(f"Removed worktree {worktree_path}")
    else:
        subprocess.run([git_bin, "-C", repo_root, "worktree", "prune"], capture_output=True, text=True)
        details["messages"].append("Worktree directory already absent; ran git worktree prune")

    if delete_branch and branch_name:
        flag = "-D" if force else "-d"
        proc = subprocess.run(
            [git_bin, "-C", repo_root, "branch", flag, branch_name],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            details["messages"].append(
                f"Branch {branch_name} not deleted: {(proc.stderr or proc.stdout).strip()}"
            )
        else:
            details["branch_deleted"] = True
            details["messages"].append(f"Deleted branch {branch_name}")

    return details


def cap_lines(text: str, max_lines: int = 40) -> str:
    lines = [ln for ln in text.splitlines() if ln.strip() != ""]
    if len(lines) <= max_lines:
        return "\n".join(lines)
    kept = lines[:max_lines]
    kept.append(f"... ({len(lines) - max_lines} more lines truncated)")
    return "\n".join(kept)


def collect_git_truth(workdir: Path, base_sha: str | None) -> dict[str, Any]:
    git_bin = get_git_bin()
    if not git_bin or not workdir.exists():
        return {"is_git": False}

    check = subprocess.run(
        [git_bin, "-C", str(workdir), "rev-parse", "--is-inside-work-tree"],
        capture_output=True,
        text=True,
    )
    if check.returncode != 0:
        return {"is_git": False}

    status_proc = subprocess.run(
        [git_bin, "-C", str(workdir), "status", "--short"],
        capture_output=True,
        text=True,
    )
    head_proc = subprocess.run(
        [git_bin, "-C", str(workdir), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
    )
    current_sha = head_proc.stdout.strip() if head_proc.returncode == 0 else None

    diff_cmd = [git_bin, "-C", str(workdir), "diff", "--stat"]
    if base_sha:
        diff_cmd.append(base_sha)
    diff_proc = subprocess.run(diff_cmd, capture_output=True, text=True)

    return {
        "is_git": True,
        "head_sha": current_sha,
        "base_sha": base_sha,
        "has_new_commits": bool(base_sha and current_sha and current_sha != base_sha),
        "status_short": cap_lines(status_proc.stdout, 40),
        "diff_stat": cap_lines(diff_proc.stdout, 40),
    }


def build_worker_prompt(
    user_prompt: str,
    *,
    sandbox: str,
    network: bool = False,
    is_resume: bool = False,
    files_hint: list[str] | None = None,
) -> str:
    scope_line = f"- Priority files/paths: {', '.join(files_hint)}\n" if files_hint else ""
    net_note = " (network_access=true; keep external actions strictly scoped)" if network else ""
    if is_resume:
        return (
            f"{user_prompt.strip()}\n\n"
            "[Execution Contract]\n"
            f"- Sandbox: {sandbox}{net_note}. Do not merge or switch outside this worktree.\n"
            f"{scope_line}"
            "- Run the relevant verification checks/tests before finishing and report exact outcomes concisely.\n"
        )
    return (
        f"{user_prompt.strip()}\n\n"
        "[Execution Contract]\n"
        f"- Sandbox: {sandbox}{net_note}. Keep changes scoped to this task and never auto-merge.\n"
        f"{scope_line}"
        "- Before finishing, run appropriate verification (tests/lint/build/typecheck) and summarize facts concisely.\n"
    )


def extract_session_id_from_obj(obj: Any) -> str | None:
    """Recursively locate a thread_id / session_id / sessionId field in parsed JSON."""
    if isinstance(obj, dict):
        for key in ("thread_id", "session_id", "sessionId", "conversation_id"):
            val = obj.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        for val in obj.values():
            found = extract_session_id_from_obj(val)
            if found:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = extract_session_id_from_obj(item)
            if found:
                return found
    return None


def parse_codex_events(events_text: str) -> dict[str, Any]:
    session_id: str | None = None
    usage: dict[str, Any] | None = None
    last_agent_text: str | None = None
    errors: list[str] = []

    for raw_line in events_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(ev, dict):
            continue

        if session_id is None:
            session_id = extract_session_id_from_obj(ev)

        ev_type = str(ev.get("type", ""))
        if ev_type == "turn.completed" and isinstance(ev.get("usage"), dict):
            usage = ev["usage"]
        elif isinstance(ev.get("usage"), dict) and usage is None:
            usage = ev["usage"]

        if ev_type in ("error", "turn.failed"):
            msg = ev.get("message") or (ev.get("error") or {}).get("message")
            if isinstance(msg, str) and msg.strip():
                errors.append(msg.strip())

        item = ev.get("item")
        if isinstance(item, dict) and item.get("type") == "agent_message":
            text = item.get("text")
            if isinstance(text, str) and text.strip():
                last_agent_text = text.strip()

    return {
        "session_id": session_id,
        "usage": usage,
        "last_agent_text": last_agent_text,
        "errors": errors[-5:],
    }


def parse_report_file(
    report_path: Path,
    fallback_text: str | None,
    stderr_text: str,
    exit_code: int,
    event_errors: list[str] | None = None,
) -> dict[str, Any]:
    candidate_text = ""
    if report_path.exists():
        candidate_text = report_path.read_text(encoding="utf-8", errors="replace").strip()
    if not candidate_text and fallback_text:
        candidate_text = fallback_text.strip()

    if candidate_text:
        try:
            parsed = json.loads(candidate_text)
            if isinstance(parsed, dict) and "summary" in parsed:
                return parsed
        except json.JSONDecodeError:
            pass

    if event_errors and exit_code != 0:
        err_summary = "\n".join(event_errors).strip()[:1500]
        return {
            "status": "failed",
            "summary": err_summary,
            "files_modified": [],
            "commands_run": [],
            "verification_passed": False,
            "risks_or_followups": ["Worker emitted JSONL error event; inspect events.jsonl."],
            "notes_for_orchestrator": "",
        }

    tail = "\n".join((candidate_text or stderr_text).splitlines()[-20:])
    return {
        "status": "completed" if exit_code == 0 else "failed",
        "summary": tail[:1500] if tail else f"Worker exited with code {exit_code} without structured report.",
        "files_modified": [],
        "commands_run": [],
        "verification_passed": exit_code == 0,
        "risks_or_followups": [] if exit_code == 0 else ["Structured JSON report missing; inspect logs."],
        "notes_for_orchestrator": "",
    }


def parse_generic_cli_output(stdout: str, stderr: str, exit_code: int) -> dict[str, Any]:
    """Read structured reports, Claude/Gemini result envelopes, event streams or plain text."""
    try:
        events = json.loads(stdout)
        events = events if isinstance(events, list) else [events]
    except ValueError:
        events = []
        for line in stdout.splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                events.append(line)
    session_id = usage = None
    report = {}
    summary = ""
    for event in events:
        if isinstance(event, str):
            if event.strip():
                summary = "\n".join([summary, event]).strip()
            continue
        if not isinstance(event, dict):
            continue
        session_id = extract_session_id_from_obj(event) or session_id
        usage = event.get("usage") or event.get("stats") or usage
        result = event.get("report", event.get("result", event))
        if isinstance(result, str):
            try:
                result = json.loads(result)
            except ValueError:
                pass
        if isinstance(result, dict) and isinstance(result.get("summary"), str):
            report = result
            summary = report["summary"]
            continue
        for key in ("report", "result", "response", "text", "content", "message", "output"):
            value = event.get(key)
            if isinstance(value, dict):
                value = value.get("text") or value.get("content")
            if isinstance(value, list):
                value = "\n".join(v["text"] for v in value if isinstance(v, dict) and isinstance(v.get("text"), str))
            if isinstance(value, str) and value.strip():
                summary = value.strip()
                break
    summary = summary or stdout.strip() or stderr.strip() or f"CLI exited with code {exit_code}."
    normalized = {"status": "completed", "files_modified": [], "commands_run": [], "verification_passed": False,
                  "risks_or_followups": [], "notes_for_orchestrator": "", **report, "summary": summary if report else summary[:2000]}
    if exit_code:
        normalized.update(status="failed", verification_passed=False)
    return {"session_id": session_id, "usage": usage, "report": normalized}


def write_zcode_run_provider_config(
    run_dir: Path,
    provider_id: str,
    model_id: str,
    effort: str | None = None,
    config_file: str = "",
) -> Path:
    """Create a per-run isolated provider_config.json that pins ZCode CLI to provider_id/model_id."""
    base_path = zcode_config_path(config_file)
    try:
        cfg = json.loads(base_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        cfg = {}
    except (OSError, ValueError) as exc:
        raise ValueError(f"Cannot read ZCode provider config: {base_path}") from exc
    c_root = cfg.setdefault("config", {})
    cur_order = list(c_root.get("providerOrder") or [])
    c_root["providerOrder"] = [provider_id] + [p for p in cur_order if p != provider_id]

    sel: dict[str, Any] = {"providerId": provider_id, "modelId": model_id}
    if effort and effort not in ("n/a", "auto"):
        sel["options"] = {"reasoningLevel": effort}
    c_root["defaultModelSelection"] = sel

    rules = c_root.get("providerConfigRules", {}).get("providerRules", [])
    if isinstance(rules, list):
        for rule in rules:
            if isinstance(rule, dict) and rule.get("providerId") == provider_id:
                rcfg = rule.setdefault("config", {})
                m_order = list(rcfg.get("modelOrder") or [])
                rcfg["modelOrder"] = [model_id] + [m for m in m_order if m != model_id]
                p_ids = list(rcfg.get("personalModelIds") or [])
                rcfg["personalModelIds"] = [model_id] + [m for m in p_ids if m != model_id]

    run_dir.mkdir(parents=True, exist_ok=True)
    out_file = run_dir / "provider_config.json"
    out_file.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out_file


def build_zcode_env(override_personal_config: Path | None = None) -> dict[str, str]:
    """Inject ZCode.app provider config paths when invoking bundled zcode.cjs directly."""
    env = os.environ.copy()
    if ZCODE_BUILTIN_PROVIDER_CONFIG.exists() and "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE" not in env:
        env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"] = str(ZCODE_BUILTIN_PROVIDER_CONFIG)
    if override_personal_config and override_personal_config.exists():
        env["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"] = str(override_personal_config)
    elif ZCODE_PERSONAL_PROVIDER_CONFIG.exists() and "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE" not in env:
        env["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"] = str(ZCODE_PERSONAL_PROVIDER_CONFIG)
    return env


def sync_zcode_session_to_desktop_index(
    *,
    session_id: str | None,
    workspace_path: Path,
    title_hint: str,
    model_full: str,
    effort: str,
    sandbox: str,
    status: str,
    summary_text: str = "",
    worktree_root: str | None = None,
) -> bool:
    """Sync a ZCode CLI session into ~/.zcode/v2/tasks-index.sqlite so it appears in ZCode.app Desktop."""
    if not session_id or not session_id.startswith("sess_"):
        return False
    idx_db_path = Path(os.environ.get("ZCODE_TASKS_INDEX_DB", str(ZCODE_TASKS_INDEX_DB)))
    cli_db_path = Path(os.environ.get("ZCODE_CLI_DB", str(ZCODE_CLI_DB)))
    if not idx_db_path.exists():
        return False

    ws_str = str(workspace_path.resolve())
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    clean_title = re.sub(r"\s+", " ", title_hint.replace("[Execution Contract]", "").strip())[:90] or session_id
    actual_model = model_full
    created_ms = now_ms
    updated_ms = now_ms

    if cli_db_path.exists():
        try:
            with contextlib.closing(
                sqlite3.connect(f"file:{cli_db_path}?mode=ro", uri=True, timeout=2.0)
            ) as conn_cli:
                cur_cli = conn_cli.cursor()
                srow = cur_cli.execute(
                    "SELECT title, time_created, time_updated FROM session WHERE id = ?",
                    (session_id,),
                ).fetchone()
                if srow:
                    if srow[0] and str(srow[0]).strip():
                        clean_title = str(srow[0]).strip()[:120]
                    if srow[1] is not None:
                        created_ms = int(srow[1])
                    if srow[2] is not None:
                        updated_ms = int(srow[2])
                urow = cur_cli.execute(
                    "SELECT provider_id, model_id FROM model_usage WHERE session_id = ? ORDER BY started_at DESC LIMIT 1",
                    (session_id,),
                ).fetchone()
                if urow and urow[0] and urow[1]:
                    actual_model = f"{urow[0]}/{urow[1]}"
        except (sqlite3.Error, ValueError, TypeError, OSError):
            pass

    zmode = "plan" if sandbox == "read-only" else "build"
    zstatus = "completed" if status == "completed" else ("failed" if status in ("failed", "timed_out") else "running")
    thought_level = effort if effort not in ("n/a", "", None) else "max"

    try:
        with contextlib.closing(sqlite3.connect(str(idx_db_path), timeout=4.0)) as conn:
            cur = conn.cursor()
            cur.execute("PRAGMA busy_timeout = 4000;")

            # Match or register project & project_root so ZCode Desktop groups the task under its project folder
            prow = cur.execute(
                "SELECT project_id, root_path FROM project_roots WHERE ? = root_path OR ? LIKE root_path || '/%' ORDER BY LENGTH(root_path) DESC LIMIT 1",
                (ws_str, ws_str),
            ).fetchone()
            if prow:
                project_id, root_path = str(prow[0]), str(prow[1])
            else:
                project_id = str(uuid.uuid4())
                root_path = ws_str
                proj_name = workspace_path.name or "Workspace"
                cur.execute(
                    """
                    INSERT OR IGNORE INTO projects (
                        project_id, host_id, name, name_overridden, position,
                        pinned, pinned_at, deleted, deleted_at, created_at, updated_at
                    ) VALUES (?, 'local', ?, 0, 0, 0, NULL, 0, NULL, ?, ?)
                    """,
                    (project_id, proj_name, created_ms, updated_ms),
                )
                cur.execute(
                    """
                    INSERT OR IGNORE INTO project_roots (project_id, root_path, position, is_primary)
                    VALUES (?, ?, 0, 1)
                    """,
                    (project_id, root_path),
                )

            meta_obj = {
                "taskId": session_id,
                "traceId": str(uuid.uuid4()),
                "title": clean_title,
                "titleOverridden": False,
                "workspacePath": root_path,
                "createdAt": created_ms,
                "updatedAt": updated_ms,
                "mode": zmode,
                "model": actual_model,
                "thoughtLevel": thought_level,
                "provider": "glm",
                "status": zstatus,
                "target": None,
            }
            searchable = f"{clean_title}\n{summary_text}".strip()[:4000]

            cur.execute(
                """
                INSERT INTO tasks (
                    workspace_key, workspace_path, workspace_identity, task_id, title,
                    task_status, provider, mode, model, migration_source, forked_from_task_id,
                    created_at, updated_at, unread_at, last_unread_at, pinned, archived, deleted,
                    title_overridden, meta_json, searchable_text, cron_automation_id, off_peak_task_id,
                    host_id, root_path, project_id, execution_directories, sort_order,
                    cli_title, handoff_pending, cli_title_source, cli_created_at, cli_updated_at,
                    cli_last_outcome, cli_deleted, worktree_root
                ) VALUES (
                    ?, ?, NULL, ?, ?,
                    ?, 'glm', ?, ?, NULL, NULL,
                    ?, ?, NULL, ?, 0, 0, 0,
                    0, ?, ?, NULL, NULL,
                    'local', ?, ?, NULL, NULL,
                    ?, 0, 'generated', ?, ?,
                    ?, 0, ?
                )
                ON CONFLICT(workspace_key, task_id) DO UPDATE SET
                    title = excluded.title,
                    task_status = excluded.task_status,
                    mode = excluded.mode,
                    model = excluded.model,
                    updated_at = excluded.updated_at,
                    meta_json = excluded.meta_json,
                    searchable_text = excluded.searchable_text,
                    cli_title = excluded.cli_title,
                    cli_updated_at = excluded.cli_updated_at,
                    cli_last_outcome = excluded.cli_last_outcome,
                    worktree_root = COALESCE(excluded.worktree_root, tasks.worktree_root)
                """,
                (
                    root_path,
                    root_path,
                    session_id,
                    clean_title,
                    zstatus,
                    zmode,
                    actual_model,
                    created_ms,
                    updated_ms,
                    updated_ms,
                    json.dumps(meta_obj, ensure_ascii=False),
                    searchable,
                    root_path,
                    project_id,
                    clean_title,
                    created_ms,
                    updated_ms,
                    zstatus,
                    worktree_root,
                ),
            )

            cur.execute(
                """
                INSERT OR IGNORE INTO task_group_admissions (
                    workspace_key, task_id, system_kind, user_organized, creation_id
                ) VALUES (?, ?, NULL, 1, ?)
                """,
                (root_path, session_id, str(uuid.uuid4())),
            )

            node_key = json.dumps([root_path, session_id], ensure_ascii=False, separators=(",", ":"))
            cur.execute(
                """
                INSERT OR IGNORE INTO task_group_view_node_orders (
                    node_type, node_key, sort_order, created_at, updated_at
                ) VALUES ('task', ?, 0, ?, ?)
                """,
                (node_key, created_ms, updated_ms),
            )

            conn.commit()
        return True
    except (sqlite3.Error, ValueError, TypeError, OSError):
        return False


def make_task_id(prefix: str = "task") -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"{prefix}-{stamp}-{uuid.uuid4().hex[:6]}"


def build_codex_exec_cmd(
    *,
    codex_bin: str,
    workdir: Path,
    model: str | None,
    effort: str | None,
    sandbox: str,
    network: bool = False,
    report_path: Path,
    is_git_repo: bool,
) -> list[str]:
    if network and sandbox != "workspace-write":
        raise ValueError("--network requires --sandbox workspace-write.")
    cmd = [
        codex_bin,
        "exec",
        "-C",
        str(workdir),
    ]
    if model:
        cmd.extend(["-m", validate_model(model)])
    if effort:
        cmd.extend(["-c", f'model_reasoning_effort="{validate_effort(effort)}"'])
    cmd.extend([
        "-s",
        sandbox,
    ])
    if network:
        cmd.extend(["-c", "sandbox_workspace_write.network_access=true"])
    cmd.extend([
        "-c",
        'approval_policy="never"',
        "--json",
        "--output-schema",
        str(SCHEMA_PATH),
        "-o",
        str(report_path),
    ])
    if not is_git_repo:
        cmd.append("--skip-git-repo-check")
    cmd.append("-")
    return cmd


def build_codex_resume_cmd(
    *,
    codex_bin: str,
    session_id: str,
    model: str | None,
    effort: str | None,
    sandbox: str,
    network: bool = False,
    report_path: Path,
    is_git_repo: bool,
) -> list[str]:
    if network and sandbox != "workspace-write":
        raise ValueError("--network requires --sandbox workspace-write.")
    cmd = [
        codex_bin,
        "exec",
        "resume",
    ]
    if model:
        cmd.extend(["-m", validate_model(model)])
    if effort:
        cmd.extend(["-c", f'model_reasoning_effort="{validate_effort(effort)}"'])
    cmd.extend([
        "-c",
        f'sandbox_mode="{sandbox}"',
    ])
    if network:
        cmd.extend(["-c", "sandbox_workspace_write.network_access=true"])
    cmd.extend([
        "-c",
        'approval_policy="never"',
        "--json",
        "--output-schema",
        str(SCHEMA_PATH),
        "-o",
        str(report_path),
    ])
    if not is_git_repo:
        cmd.append("--skip-git-repo-check")
    cmd.extend([session_id, "-"])
    return cmd


def run_subprocess_with_timeout(
    cmd: list[str],
    *,
    cwd: Path,
    stdin_text: str | None,
    timeout: int,
    env: dict[str, str] | None = None,
) -> tuple[int, str, str, bool]:
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd),
            input=stdin_text,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return proc.returncode, proc.stdout, proc.stderr, False
    except subprocess.TimeoutExpired as exc:
        out = exc.stdout if isinstance(exc.stdout, str) else (exc.stdout.decode("utf-8", "replace") if exc.stdout else "")
        err = exc.stderr if isinstance(exc.stderr, str) else (exc.stderr.decode("utf-8", "replace") if exc.stderr else "")
        return 124, out, f"{err}\n[dispatcher] Timed out after {timeout}s".strip(), True


def plan_routing(target, config, *, prompt, difficulty, quality, alternate=None, files_hint=None, prefer_wide=False, review=False):
    engine = target["engine"]
    settings = engine["models"]
    model, effort = target["model"], target["effort"]
    validate_effort(effort or settings["defaultEffort"])
    fallback = target["fallback_model"] or selected_model(settings["fallbackModel"])
    if engine["kind"] == "zcode":
        routing = resolve_zcode_model_and_fallbacks(
            difficulty=difficulty, prompt=prompt, files_hint=files_hint, explicit_model=model,
            explicit_effort=effort, prefer_wide=prefer_wide, is_review=review, engine=engine,
            scenario_override=target["scenario_role"],
        )
    elif engine["kind"] == "codex":
        if quality == "smart":
            quality = "max" if config["policy"]["costStrategy"] == "effect_first" else "balanced"
        routing = resolve_model_and_effort(
            difficulty=difficulty, prompt=prompt, files_hint=files_hint, explicit_model=model or selected_model(settings["primaryModel"]),
            explicit_effort=effort or (settings["defaultEffort"] if quality != "balanced" else None),
            quality=quality, alternate=alternate, prefer_wide=prefer_wide, config_file=engine["configFilePath"],
        )
    else:
        effective = classify_difficulty(prompt, files_hint)[0] if difficulty == "auto" else difficulty
        routing = {"model": model or selected_model(settings["primaryModel"]), "effort": effort or settings["defaultEffort"],
                   "requested_difficulty": difficulty, "effective_difficulty": effective}
    if engine["kind"] != "zcode":
        routing["fallback_chain"] = [{"full_model": m, "effort": routing["effort"]}
                                     for m in dict.fromkeys([routing["model"], *([fallback] if fallback else [])])]
    routing["fallback_model"] = next((c["full_model"] for c in routing["fallback_chain"][1:]), None)
    if target["scenario"]:
        routing["workflow_scenario"] = target["scenario"]
    return routing


def build_generic_cli_cmd(template, *, bin_path, prompt, cwd, model, effort, sandbox, session_id):
    tokens = shlex.split(template)
    if not tokens:
        raise ValueError("Missing CLI command template")
    values = {"bin": bin_path, "prompt": prompt, "cwd": cwd, "model": selected_model(model),
              "effort": validate_effort(effort) if effort else "", "sandbox": sandbox, "session_id": session_id}
    optional = {"{model}": {"-m", "--model"}, "{session_id}": {"--resume"}}
    result = []
    i = 0
    while i < len(tokens):
        token = tokens[i]
        i += 1
        if i < len(tokens) and token in optional.get(tokens[i], set()) and not values[tokens[i][1:-1]]:
            i += 1
            continue
        if (token == "{session_id}" and not session_id) or (token == "{model}" and not values["model"]):
            continue
        if token in ("--model={model}", "-m={model}") and not values["model"]:
            continue
        if token == "--resume={session_id}" and not session_id:
            continue
        # Substitute once on the template token. Braces in the prompt remain literal.
        result.append(re.sub(r"\{(bin|prompt|cwd|model|effort|sandbox|session_id)\}",
                             lambda m: str(values[m[1]] or ""), token))
    return result


def generic_template(engine, sandbox, session_id):
    adapter = engine["adapter"]
    if sandbox != "read-only":
        return adapter["resumeTemplate"] if session_id else adapter["execTemplate"]
    template = adapter["readonlyTemplate"]
    if session_id and "{session_id}" not in template:
        # Retain the session selector from the resume command and permissions from the read-only command.
        resume = shlex.split(adapter["resumeTemplate"])
        for i, token in enumerate(resume):
            if "{session_id}" in token:
                selector = [token]
                if token == "{session_id}" and i and resume[i - 1].startswith("-"):
                    selector.insert(0, resume[i - 1])
                return template + " " + shlex.join(selector)
        raise ValueError(f"No read-only resume selector configured for {engine['id']}")
    return template


def engine_command(engine, *, binary, workdir, prompt, model, effort, sandbox, network, output_path,
                   is_git_repo, session_id=None, review_args=None):
    if engine["kind"] == "codex":
        if review_args is not None:
            cmd = [binary, "exec", "review"]
            if model:
                cmd.extend(["-m", validate_model(model)])
            if effort:
                cmd.extend(["-c", f'model_reasoning_effort="{validate_effort(effort)}"'])
            cmd.extend(["-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"',
                        "--json", "-o", str(output_path), *review_args])
        else:
            opts = dict(codex_bin=binary, model=model, effort=effort, sandbox=sandbox, network=network,
                        report_path=output_path, is_git_repo=is_git_repo)
            if session_id:
                cmd = build_codex_resume_cmd(session_id=session_id, **opts)
            else:
                cmd = build_codex_exec_cmd(workdir=workdir, **opts)
        catalog = codex_catalog_override(engine["configFilePath"])
        if catalog and Path(catalog).is_file():
            cmd[1:1] = ["-c", "model_catalog_json=" + json.dumps(catalog, ensure_ascii=False)]
        return cmd
    if engine["kind"] == "zcode":
        cmd = [get_node_bin() or "node", binary]
        if session_id:
            cmd.extend(["--resume", session_id])
        return cmd + ["-p", prompt, "--cwd", str(workdir), "--mode", "plan" if sandbox == "read-only" else "build",
                      "--json", "--no-color"]
    return build_generic_cli_cmd(generic_template(engine, sandbox, session_id), bin_path=binary,
                                 prompt=prompt, cwd=workdir, model=model, effort=effort,
                                 sandbox=sandbox, session_id=session_id)


def run_generic_cli_with_failover(*, engine, routing, workdir, prompt, sandbox, run_dir, timeout,
                                  session_id=None, network=False, is_git_repo=False, review_args=None, dry_run=False):
    """Preview or run the same argv for each model, collecting per-attempt outcomes across CLI adapters."""
    kind = engine["kind"]
    binary = engine_bin(engine)
    if not dry_run and (not binary or (kind == "zcode" and not get_node_bin())):
        raise ValueError(f"CLI runtime not found for engine '{engine['id']}'")
    binary = binary or os.path.expanduser(engine["binPath"]) or engine["id"]
    output = run_dir / ("review_output.txt" if review_args is not None else "last_message.json")
    attempts = []
    candidates = routing["fallback_chain"][:MAX_FAILOVER_ATTEMPTS]
    for candidate in candidates:
        model, effort = candidate["full_model"], candidate["effort"]
        cmd = engine_command(engine, binary=binary, workdir=workdir, prompt=prompt, model=model, effort=effort,
                             sandbox=sandbox, network=network, output_path=output, is_git_repo=is_git_repo,
                             session_id=session_id, review_args=review_args)
        if dry_run:
            return {"command": cmd}
        env = None
        if kind == "zcode":
            override = write_zcode_run_provider_config(run_dir, candidate["provider_id"], candidate["model_id"],
                                                      effort, engine["configFilePath"])
            env = build_zcode_env(override)
        if kind == "codex":
            output.unlink(missing_ok=True)  # A failed primary can leave its report behind.
        stdin_text = prompt if kind == "codex" and cmd[-1] == "-" else None
        rc, stdout, stderr, timed_out = run_subprocess_with_timeout(cmd, cwd=workdir, stdin_text=stdin_text,
                                                                  timeout=timeout, env=env)
        attempts.append({"attempt": len(attempts) + 1, **candidate, "exit_code": rc, "timed_out": timed_out})
        if rc == 0 and not timed_out:
            break
    routing.update(model=model, effort=effort, attempts=attempts, failover_triggered=len(attempts) > 1)
    if kind == "zcode":
        routing.update({k: candidate[k] for k in ("provider_id", "provider_label", "model_id")})
    (run_dir / "events.jsonl").write_text(stdout, encoding="utf-8")
    (run_dir / "stderr.log").write_text(stderr, encoding="utf-8")
    if kind == "codex":
        parsed = parse_codex_events(stdout)
        if review_args is not None:
            summary = (output.read_text(encoding="utf-8", errors="replace").strip() if output.exists()
                       else parsed["last_agent_text"] or stderr.strip())
            report = {"summary": summary, "status": "completed" if rc == 0 else "failed"}
        else:
            report = parse_report_file(output, parsed["last_agent_text"], stderr, rc, parsed["errors"])
    else:
        parsed = parse_generic_cli_output(stdout, stderr, rc)
        report = parsed["report"]
    if rc != 0:
        report.update(status="failed", verification_passed=False)
    return {"exit_code": rc, "timed_out": timed_out, "session_id": parsed["session_id"] or session_id,
            "usage": parsed["usage"], "report": report, "model_used": model, "effort_used": effort}


def execute_single_task(
    *,
    prompt: str,
    cwd: Path,
    backend: str,
    difficulty: str,
    model: str | None,
    effort: str | None,
    quality: str,
    alternate: bool | None,
    prefer_wide: bool,
    sandbox: str,
    network: bool = False,
    isolation: str,
    timeout: int,
    files_hint: list[str] | None,
    task_id: str | None,
    dry_run: bool,
) -> dict[str, Any]:
    if not cwd.exists() or not cwd.is_dir():
        raise ValueError(f"Target cwd does not exist or is not a directory: {cwd}")
    if network and sandbox != "workspace-write":
        raise ValueError("--network requires --sandbox workspace-write.")

    config = load_engine_config()
    target = resolve_run_target(backend, prompt, files_hint, difficulty, prefer_wide, model, effort, config)
    backend, engine = target["backend"], target["engine"]
    git_info = inspect_git(cwd)
    if isolation == "auto" and config["policy"]["defaultIsolation"] == "inplace":
        isolation = "inplace"
    eff_isolation, isolation_reason = resolve_isolation(isolation, sandbox, git_info)
    tid = task_id or make_task_id("run")
    routing = plan_routing(target, config, prompt=prompt, difficulty=difficulty, quality=quality,
                           alternate=alternate, files_hint=files_hint, prefer_wide=prefer_wide)
    run_dir = RUNS_DIR / tid
    worker_prompt = build_worker_prompt(prompt, sandbox=sandbox, network=network, files_hint=files_hint)
    options = dict(engine=engine, routing=routing, prompt=worker_prompt, sandbox=sandbox, network=network,
                   run_dir=run_dir, timeout=timeout, is_git_repo=git_info["is_git_repo"])
    if dry_run:
        preview_workdir = WORKTREES_DIR / Path(git_info["repo_root"]).name / tid if eff_isolation == "worktree" else cwd
        preview = run_generic_cli_with_failover(**options, workdir=preview_workdir, dry_run=True)
        return {
            "dry_run": True,
            "task_id": tid,
            "backend": backend,
            "routing": routing,
            "isolation": eff_isolation,
            "isolation_reason": isolation_reason,
            "sandbox": sandbox,
            "network": network,
            "git": git_info,
            "preview_workdir": str(preview_workdir),
            **preview,
        }

    if not is_engine_available(engine):
        raise ValueError(f"CLI runtime not found for engine '{backend}'")
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "prompt.txt").write_text(worker_prompt, encoding="utf-8")

    workdir = cwd
    worktree_path: str | None = None
    branch_name: str | None = None
    if eff_isolation == "worktree":
        wt, br = create_worktree(git_info["repo_root"], tid, git_info["head_sha"])
        workdir = wt
        worktree_path = str(wt)
        branch_name = br

    execution = run_generic_cli_with_failover(**options, workdir=workdir)
    model_used, effort_used = execution["model_used"], execution["effort_used"]
    report, session_id = execution["report"], execution["session_id"]
    rc, timed_out = execution["exit_code"], execution["timed_out"]
    desktop_synced = False
    git_truth = collect_git_truth(workdir, git_info["head_sha"])
    now = utc_now()
    final_status = "timed_out" if timed_out else report.get("status", "completed" if rc == 0 else "failed")

    if engine["kind"] == "zcode" and engine["adapter"]["syncDesktopIndex"] and session_id:
        desktop_synced = sync_zcode_session_to_desktop_index(
            session_id=session_id,
            workspace_path=Path(git_info["repo_root"]) if git_info.get("repo_root") else cwd,
            title_hint=prompt,
            model_full=model_used or "qwen-alibaba-model-studio-cn/kimi-k3",
            effort=effort_used or "max",
            sandbox=sandbox,
            status=final_status,
            summary_text=report.get("summary", ""),
            worktree_root=worktree_path,
        )

    task_record = {
        "task_id": tid,
        "backend": backend,
        "model": model_used,
        "effort": effort_used,
        "difficulty": routing["effective_difficulty"],
        "repo_root": git_info["repo_root"],
        "is_git_repo": git_info["is_git_repo"],
        "base_sha": git_info["head_sha"],
        "original_cwd": str(cwd),
        "workdir": str(workdir),
        "worktree_path": worktree_path,
        "branch": branch_name,
        "isolation": eff_isolation,
        "sandbox": sandbox,
        "network": network,
        "session_id": session_id,
        "desktop_synced": desktop_synced,
        "status": final_status,
        "exit_code": rc,
        "created_at": now,
        "updated_at": now,
        "run_dir": str(run_dir),
    }

    result = {
        "task_id": tid,
        "backend": backend,
        "model_used": model_used,
        "effort_used": effort_used,
        "routing": routing,
        "isolation": eff_isolation,
        "isolation_reason": isolation_reason,
        "sandbox": sandbox,
        "network": network,
        "workdir": str(workdir),
        "branch": branch_name,
        "session_id": session_id,
        "desktop_synced": desktop_synced,
        "exit_code": rc,
        "timed_out": timed_out,
        "usage": execution["usage"],
        "report": report,
        "git_truth": git_truth,
        "run_dir": str(run_dir),
    }
    (run_dir / "result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    with locked_state() as state:
        state["tasks"][tid] = task_record
    return result


def generic_model_ids(engine: dict) -> set[str]:
    ids = {engine["models"]["primaryModel"], engine["models"]["fallbackModel"]}
    if engine["id"] == "claude":
        ids.update(("claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"))
    if engine["id"] == "gemini":
        ids.update(("gemini-2.5-pro", "gemini-2.5-flash"))

    def add_model(item):
        if isinstance(item, dict):
            item = next((item[k] for k in ("id", "modelId", "model_id", "slug", "name") if item.get(k)), None)
        if isinstance(item, str) and item.strip():
            ids.add(item.strip())

    def visit(value):
        if isinstance(value, list):
            for item in value:
                visit(item)
        elif isinstance(value, dict):
            for key, child in value.items():
                field = key.lower().replace("_", "").replace("-", "")
                if field.endswith(("model", "modelid", "modelname")):
                    add_model(child)
                elif field in ("models", "modelids", "modelorder", "availablemodels", "modelnames"):
                    if isinstance(child, (list, dict)):
                        for item in child:
                            add_model(item)
                visit(child)

    if engine["configFilePath"]:
        try:
            raw = json.loads(Path(engine["configFilePath"]).expanduser().read_text(encoding="utf-8"))
            visit({"models": raw} if isinstance(raw, list) else raw)
        except (OSError, ValueError):
            pass
    return ids - {"", "auto"}


def cmd_health(_args: argparse.Namespace) -> int:
    config = load_engine_config()
    entries = {e["id"]: e for e in config["engines"]}
    candidates = list_codex_candidates()
    codex_bin = engine_bin(entries["codex"])
    node_bin = get_node_bin()
    git_bin = get_git_bin()
    zscript = Path(entries["zcode"]["binPath"] or ZCODE_SCRIPT).expanduser()
    zcode_exists = zscript.is_file()
    codex_ver = probe_version([codex_bin, "--version"]) if codex_bin else None
    node_ver = probe_version([node_bin, "--version"]) if node_bin else None
    git_ver = probe_version([git_bin, "--version"]) if git_bin else None
    zcode_ver = probe_version([node_bin, str(zscript), "--version"]) if node_bin and zcode_exists else None
    frontier = discover_frontier_models(entries["codex"]["configFilePath"])
    zcode_models = discover_zcode_models(entries["zcode"]["configFilePath"])
    engines = {}
    for key, engine in entries.items():
        if key == "codex":
            binary = codex_bin
            exists = any(p.is_file() for p in codex_cache_paths(engine["configFilePath"]))
            count = len(frontier["listed_models"])
        elif key == "zcode":
            binary = str(zscript) if zcode_exists else None
            exists = zcode_config_path(engine["configFilePath"]).is_file()
            count = sum(len(p["models"]) for p in zcode_models["providers"])
        else:
            binary = engine_bin(engine)
            exists = bool(engine["configFilePath"] and Path(engine["configFilePath"]).expanduser().is_file())
            count = len(generic_model_ids(engine))
        engines[key] = {"id": key, "enabled": engine["enabled"], "detected_bin": binary,
                        "available": bool(binary and (key != "zcode" or node_bin)),
                        "config_exists": exists, "models_count": count}
    healthy = bool(git_bin and SCHEMA_PATH.exists() and any(e["enabled"] and e["available"] for e in engines.values()))
    payload = {
        "healthy": healthy,
        "engines": engines,
        "workflow_roles": config["workflowRoles"],
        "schema_exists": SCHEMA_PATH.exists(),
        "state_dir": str(STATE_DIR),
        "default_quality_mode": "smart",
        "codex": {"bin": codex_bin, "version": codex_ver, "candidates": candidates},
        "zcode": {
            "node_bin": node_bin,
            "node_version": node_ver,
            "script": str(zscript),
            "script_exists": zcode_exists,
            "version": zcode_ver,
            "cli_db_exists": ZCODE_CLI_DB.exists(),
            "tasks_index_db_exists": ZCODE_TASKS_INDEX_DB.exists(),
            "providers": zcode_models.get("providers", []),
        },
        "git": {"bin": git_bin, "version": git_ver},
        "frontier_models": {
            "exists": frontier["exists"],
            "source_file": frontier["source_file"],
            "client_version": frontier["client_version"],
            "flagship": frontier["flagship"],
            "wide_fast": frontier["wide_fast"],
            "listed_models_count": len(frontier["listed_models"]),
            "listed_slugs": frontier["listed_slugs"],
        },
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if healthy else 1


def cmd_run(args: argparse.Namespace) -> int:
    prompt_text = sys.stdin.read() if args.prompt == "-" else args.prompt
    result = execute_single_task(
        prompt=prompt_text,
        cwd=Path(args.cwd).resolve(),
        backend=args.backend,
        difficulty=args.difficulty,
        model=args.model,
        effort=args.effort,
        quality=args.quality,
        alternate=args.alternate,
        prefer_wide=args.prefer_wide,
        sandbox=args.sandbox,
        network=args.network,
        isolation=args.isolation,
        timeout=args.timeout,
        files_hint=args.files,
        task_id=args.task_id,
        dry_run=args.dry_run,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("dry_run") or result.get("exit_code", 1) == 0 else 1


def cmd_batch(args: argparse.Namespace) -> int:
    manifest_path = Path(args.manifest).resolve()
    items = json.loads(manifest_path.read_text(encoding="utf-8"))
    if isinstance(items, dict) and "tasks" in items:
        items = items["tasks"]
    if not isinstance(items, list) or not items:
        raise ValueError("Manifest must be a non-empty JSON list or an object with a 'tasks' list.")

    default_cwd = Path(args.cwd).resolve() if args.cwd else Path.cwd().resolve()

    def _run_item(idx: int, item: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        item_cwd = Path(item.get("cwd", default_cwd)).resolve()
        item_sandbox = item.get("sandbox", "workspace-write")
        item_iso = item.get("isolation", "auto")
        if len(items) > 1 and item_sandbox == "workspace-write" and item_iso == "auto":
            item_iso = "worktree"
        item_alt = item.get("alternate")
        if item_alt is None and "no_alternate" in item:
            item_alt = not bool(item["no_alternate"])
        item_network = bool(item.get("network", args.network))
        res = execute_single_task(
            prompt=item["prompt"],
            cwd=item_cwd,
            backend=item.get("backend", args.backend),
            difficulty=item.get("difficulty", "auto"),
            model=item.get("model"),
            effort=item.get("effort"),
            quality=item.get("quality", args.quality),
            alternate=item_alt,
            prefer_wide=bool(item.get("prefer_wide", False)),
            sandbox=item_sandbox,
            network=item_network,
            isolation=item_iso,
            timeout=int(item.get("timeout", args.timeout)),
            files_hint=item.get("files"),
            task_id=item.get("task_id"),
            dry_run=args.dry_run,
        )
        return idx, res

    ordered: list[dict[str, Any] | None] = [None] * len(items)
    with ThreadPoolExecutor(max_workers=max(1, args.max_concurrency)) as pool:
        futures = [pool.submit(_run_item, i, item) for i, item in enumerate(items)]
        for fut in as_completed(futures):
            idx, res = fut.result()
            ordered[idx] = res

    results = [r for r in ordered if r is not None]
    failed = [r for r in results if not r.get("dry_run") and r.get("exit_code", 1) != 0]
    summary = {
        "batch_total": len(results),
        "batch_failed": len(failed),
        "dry_run": args.dry_run,
        "results": results,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if not failed else 1


def cmd_resume(args: argparse.Namespace) -> int:
    prompt_text = sys.stdin.read() if args.prompt == "-" else args.prompt
    task_record: dict[str, Any] | None = None
    if args.task_id:
        with locked_state() as state:
            task_record = state["tasks"].get(args.task_id)
        if not task_record:
            raise ValueError(f"Unknown task_id: {args.task_id}")

    session_id = args.session_id or (task_record or {}).get("session_id")
    if not session_id:
        raise ValueError("No session_id available to resume (pass --session-id or valid --task-id).")
    # Find the original registry entry for session-only resumes, including custom sessions.
    if not task_record:
        with locked_state() as state:
            task_record = next((t for t in state["tasks"].values() if t.get("session_id") == session_id
                                and args.backend in (None, "auto", t.get("backend"))), None)
    original = task_record or {}
    config = load_engine_config()
    inferred_backend = original.get("backend") or ("zcode" if session_id.startswith("sess_") else "codex")
    backend = args.backend if args.backend not in (None, "auto") else inferred_backend
    if task_record and backend != inferred_backend:
        raise ValueError(f"Task belongs to engine '{inferred_backend}', not '{backend}'")
    workdir = Path(args.cwd or original.get("workdir") or ".").resolve()
    if not workdir.is_dir():
        raise ValueError(f"Workdir does not exist: {workdir}")
    sandbox = args.sandbox or original.get("sandbox", "workspace-write")
    network = args.network if args.network is not None else sandbox == "workspace-write" and original.get("network", False)
    if network and sandbox != "workspace-write":
        raise ValueError("--network requires --sandbox workspace-write.")
    base_sha = original.get("base_sha")
    git_info = inspect_git(workdir)
    inherit = args.difficulty == "auto" and not args.prefer_wide and args.quality == "smart"
    target = resolve_run_target(backend, prompt_text, None, args.difficulty, args.prefer_wide,
                                args.model or (original.get("model") if inherit else None),
                                args.effort or (original.get("effort") if inherit else None), config)
    engine = target["engine"]
    routing = plan_routing(target, config, prompt=prompt_text, difficulty=args.difficulty, quality=args.quality,
                           alternate=args.alternate, prefer_wide=args.prefer_wide)
    resume_tid = args.task_id or original.get("task_id") or make_task_id("resume")
    turn_id = make_task_id("turn")
    run_dir = Path(original.get("run_dir") or RUNS_DIR / resume_tid) / turn_id
    worker_prompt = build_worker_prompt(prompt_text, sandbox=sandbox, network=network, is_resume=True)
    options = dict(engine=engine, routing=routing, workdir=workdir, prompt=worker_prompt, sandbox=sandbox,
                   network=network, run_dir=run_dir, timeout=args.timeout, session_id=session_id,
                   is_git_repo=git_info["is_git_repo"])
    if args.dry_run:
        preview = run_generic_cli_with_failover(**options, dry_run=True)
        print(json.dumps({"dry_run": True, "task_id": resume_tid, "backend": backend, "session_id": session_id,
                          "workdir": str(workdir), "sandbox": sandbox, "network": network, "routing": routing,
                          **preview}, ensure_ascii=False, indent=2))
        return 0
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "prompt.txt").write_text(worker_prompt, encoding="utf-8")
    execution = run_generic_cli_with_failover(**options)
    model_used, effort_used = execution["model_used"], execution["effort_used"]
    report, new_session_id = execution["report"], execution["session_id"]
    rc, timed_out = execution["exit_code"], execution["timed_out"]
    desktop_synced = False
    git_truth = collect_git_truth(workdir, base_sha)
    final_status = "timed_out" if timed_out else report.get("status", "completed" if rc == 0 else "failed")

    if engine["kind"] == "zcode" and engine["adapter"]["syncDesktopIndex"] and new_session_id:
        ws_root = (
            Path(task_record["repo_root"])
            if (task_record and task_record.get("repo_root"))
            else (Path(git_info["repo_root"]) if git_info.get("repo_root") else workdir)
        )
        desktop_synced = sync_zcode_session_to_desktop_index(
            session_id=new_session_id,
            workspace_path=ws_root,
            title_hint=prompt_text,
            model_full=model_used or "qwen-alibaba-model-studio-cn/kimi-k3",
            effort=effort_used or "max",
            sandbox=sandbox,
            status=final_status,
            summary_text=report.get("summary", ""),
            worktree_root=task_record.get("worktree_path") if task_record else None,
        )

    result = {
        "task_id": resume_tid,
        "turn_id": turn_id,
        "backend": backend,
        "model_used": model_used,
        "effort_used": effort_used,
        "routing": routing,
        "sandbox": sandbox,
        "network": network,
        "workdir": str(workdir),
        "session_id": new_session_id,
        "desktop_synced": desktop_synced,
        "exit_code": rc,
        "timed_out": timed_out,
        "usage": execution["usage"],
        "report": report,
        "git_truth": git_truth,
        "run_dir": str(run_dir),
    }
    (run_dir / "result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    if task_record:
        with locked_state() as state:
            if resume_tid in state["tasks"]:
                record = state["tasks"][resume_tid]
                record.update(model=model_used, effort=effort_used, session_id=new_session_id, desktop_synced=desktop_synced,
                              status=final_status, exit_code=rc, updated_at=utc_now())
                if args.task_id:
                    record.update(sandbox=sandbox, network=network)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if rc == 0 else 1


def cmd_review(args: argparse.Namespace) -> int:
    task_record: dict[str, Any] | None = None
    if args.task_id:
        with locked_state() as state:
            task_record = state["tasks"].get(args.task_id)
        if not task_record:
            raise ValueError(f"Unknown task_id: {args.task_id}")

    workdir = Path(args.cwd or (task_record["workdir"] if task_record else ".")).resolve()
    if not workdir.exists():
        raise ValueError(f"Workdir does not exist: {workdir}")

    base_sha = args.base or (task_record.get("base_sha") if task_record else None)
    git_truth = collect_git_truth(workdir, base_sha)

    config = load_engine_config()
    roles = config["workflowRoles"]
    reviewer = roles["reviewer"]
    author_backend = (task_record or {}).get("backend") or roles["primaryBuilder"]["engineId"]
    auto = args.backend == "auto"
    reviewer_mode = reviewer["mode"] if auto else "explicit"
    if reviewer_mode == "explicit":
        backend = reviewer["engineId"] if auto else args.backend
        review_note = f"Explicit read-only reviewer: {backend}."
    else:
        active = [e for e in config["engines"] if e["enabled"]]
        others = [e for e in active if e["id"] != author_backend]
        if others:
            backend = next((e for e in others if is_engine_available(e)), others[0])["id"]
            review_note = f"Heterogeneous read-only review: {author_backend} -> {backend}."
        else:
            backend = active[0]["id"]
            review_note = f"Only {backend} is enabled; read-only self-review."
    model = selected_model(args.model) or (selected_model(reviewer["model"]) if auto and reviewer_mode == "explicit" else None)
    effort = args.effort or (reviewer["effort"] if auto else None)
    target = resolve_run_target(backend, args.prompt or "code review", None, "hard", False, model, effort, config)
    engine = target["engine"]
    if engine["kind"] == "codex" and not target["model"] and not selected_model(engine["models"]["primaryModel"]):
        frontier = discover_frontier_models(engine["configFilePath"])
        flagship, wide = frontier["flagship"], frontier["wide_fast"]
        if flagship and wide and (task_record or {}).get("model") == flagship["slug"]:
            target["model"] = wide["slug"]
    routing = plan_routing(target, config, prompt=args.prompt or "code review", difficulty="hard",
                           quality=args.quality, review=True)
    review_id = make_task_id("review")
    run_dir = RUNS_DIR / review_id
    review_prompt = args.prompt or (
        "请对当前工作区相对基准提交 "
        f"{base_sha or 'HEAD'} 的源码改动执行严格的只读代码审计（Code Review，忽略 dist/、node_modules/ 等编译打包产物）。"
        "重点排查：1) 会算错钱、丢数据、越权、发错消息或导致线上故障的严重问题（写清具体触发路径）；"
        "2) 边界条件遗漏、并发/状态同步缺陷与未覆盖的测试；3) 给出明确结论（通过 / 需修复项）。"
    )

    review_base = base_sha if git_truth.get("has_new_commits") and not args.uncommitted else None
    review_args = [] if git_truth.get("is_git") else ["--skip-git-repo-check"]
    if args.prompt and engine["kind"] == "codex":
        # Codex review accepts either a scope flag or custom instructions on stdin.
        scope = f"changes relative to {review_base}" if review_base else "uncommitted changes"
        review_prompt = f"Review the {scope}.\n\n{args.prompt}"
        review_args.append("-")
    elif review_base:
        review_args.extend(["--base", review_base])
    else:
        review_args.append("--uncommitted")
    options = dict(engine=engine, routing=routing, workdir=workdir, prompt=review_prompt, sandbox="read-only",
                   run_dir=run_dir, timeout=args.timeout, review_args=review_args)
    context = {"review_id": review_id, "backend": backend, "author_backend": author_backend,
               "reviewer_mode": reviewer_mode, "review_note": review_note, "sandbox": "read-only",
               "routing": routing, "workdir": str(workdir)}
    if args.dry_run:
        preview = run_generic_cli_with_failover(**options, dry_run=True)
        print(json.dumps({**context, **preview, "dry_run": True, "review_model": routing["model"],
                          "review_effort": routing["effort"]}, ensure_ascii=False, indent=2))
        return 0

    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "prompt.txt").write_text(review_prompt, encoding="utf-8")
    execution = run_generic_cli_with_failover(**options)
    rc, timed_out = execution["exit_code"], execution["timed_out"]
    review_model, review_effort = execution["model_used"], execution["effort_used"]
    review_text = execution["report"]["summary"]
    session_id = execution["session_id"]
    desktop_synced = False
    if engine["kind"] == "zcode" and engine["adapter"]["syncDesktopIndex"] and session_id:
        desktop_synced = sync_zcode_session_to_desktop_index(
            session_id=session_id, workspace_path=workdir, title_hint=f"[代码审查] {args.task_id or workdir.name}",
            model_full=review_model, effort=review_effort, sandbox="read-only",
            status="completed" if rc == 0 else "failed", summary_text=review_text)
    now = utc_now()
    final_status = "timed_out" if timed_out else ("completed" if rc == 0 else "failed")
    review_record = {
        "task_id": review_id,
        "backend": backend,
        "model": review_model,
        "effort": review_effort,
        "difficulty": "hard",
        "repo_root": str(workdir) if git_truth.get("is_git") else None,
        "is_git_repo": bool(git_truth.get("is_git")),
        "base_sha": base_sha,
        "original_cwd": str(workdir),
        "workdir": str(workdir),
        "worktree_path": None,
        "branch": None,
        "isolation": "inplace",
        "sandbox": "read-only",
        "network": False,
        "session_id": session_id,
        "desktop_synced": desktop_synced,
        "status": final_status,
        "exit_code": rc,
        "created_at": now,
        "updated_at": now,
        "run_dir": str(run_dir),
    }
    payload = {
        **context,
        "task_id": args.task_id,
        "review_model": review_model,
        "review_effort": review_effort,
        "session_id": session_id,
        "exit_code": rc,
        "timed_out": timed_out,
        "usage": execution["usage"],
        "review_summary": review_text[:3000],
        "git_truth": git_truth,
        "run_dir": str(run_dir),
        "report": {
            "status": final_status,
            "summary": review_text[:2000],
            "files_modified": [],
            "commands_run": [],
            "verification_passed": rc == 0,
            "risks_or_followups": [],
            "notes_for_orchestrator": review_note,
        },
    }
    (run_dir / "result.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    with locked_state() as state:
        state["tasks"][review_id] = review_record
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if rc == 0 else 1


def cmd_status(args: argparse.Namespace) -> int:
    with locked_state() as state:
        tasks = state.get("tasks", {})
        if args.task_id:
            if args.task_id not in tasks:
                raise ValueError(f"Unknown task_id: {args.task_id}")
            rec = dict(tasks[args.task_id])
            rec["worktree_exists"] = bool(rec.get("worktree_path") and Path(rec["worktree_path"]).exists())
            print(json.dumps(rec, ensure_ascii=False, indent=2))
            return 0
        summary_list = []
        for tid, rec in sorted(tasks.items(), key=lambda kv: kv[1].get("updated_at", ""), reverse=True):
            summary_list.append(
                {
                    "task_id": tid,
                    "backend": rec.get("backend"),
                    "model": rec.get("model"),
                    "effort": rec.get("effort"),
                    "status": rec.get("status"),
                    "isolation": rec.get("isolation"),
                    "branch": rec.get("branch"),
                    "session_id": rec.get("session_id"),
                    "desktop_synced": rec.get("desktop_synced", False),
                    "worktree_exists": bool(rec.get("worktree_path") and Path(rec["worktree_path"]).exists()),
                    "updated_at": rec.get("updated_at"),
                }
            )
        print(
            json.dumps(
                {
                    "rr_counter": state.get("rr_counter", 0),
                    "total_tasks": len(summary_list),
                    "tasks": summary_list,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0


def cmd_cleanup(args: argparse.Namespace) -> int:
    with locked_state() as state:
        rec = state["tasks"].get(args.task_id)
        if not rec:
            raise ValueError(f"Unknown task_id: {args.task_id}")

    if not rec.get("repo_root"):
        result = {"task_id": args.task_id, "message": "Task was non-Git inplace; nothing to remove."}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    details = remove_worktree(
        rec["repo_root"],
        rec.get("worktree_path"),
        rec.get("branch"),
        delete_branch=args.delete_branch,
        force=args.force,
    )
    with locked_state() as state:
        if args.task_id in state["tasks"]:
            state["tasks"][args.task_id]["status"] = "cleaned"
            state["tasks"][args.task_id]["updated_at"] = utc_now()

    print(json.dumps({"task_id": args.task_id, **details}, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Local multi-agent dispatcher (workflow roles and registered CLI engines)."
    )
    sub = parser.add_subparsers(dest="subcommand", required=True)

    sub.add_parser("health", help="Check registered CLI engines, Git, and model discovery.")

    p_run = sub.add_parser(
        "run",
        help="Dispatch one coding/analysis task using workflow roles and model routing.",
    )
    p_run.add_argument("--cwd", default=".", help="Target repository or working directory.")
    p_run.add_argument("--prompt", required=True, help="Task prompt or '-' for stdin.")
    p_run.add_argument("--backend", default="auto", help="Registered engine ID or auto for workflow routing.")
    p_run.add_argument("--difficulty", choices=VALID_DIFFICULTIES, default="auto")
    p_run.add_argument("--quality", choices=VALID_QUALITIES, default="smart", help="Quality/quota routing mode (default: smart).")
    p_run.add_argument("--prefer-wide", action="store_true", help="Prefer largest-context model (gpt-6.2-sol 500k on Codex; glm-5.3 1M on ZCode).")
    p_run.add_argument("--model", type=validate_model, default=None, help="Explicit model slug override (supports Codex slugs or ZCode modelId / providerId/modelId).")
    p_run.add_argument("--effort", choices=VALID_EFFORTS, default=None, help="Explicit reasoning effort override.")
    p_run.add_argument("--alternate", dest="alternate", action="store_true", default=None, help="Enable alternation across flagship/wide_fast on medium.")
    p_run.add_argument("--no-alternate", dest="alternate", action="store_false", help="Disable alternation on medium.")
    p_run.add_argument("--sandbox", choices=VALID_SANDBOXES, default="workspace-write")
    p_run.add_argument("--network", action="store_true", help="Enable sandbox_workspace_write.network_access=true while preserving filesystem sandbox outside workdir.")
    p_run.add_argument("--isolation", choices=VALID_ISOLATIONS, default="auto")
    p_run.add_argument("--timeout", type=int, default=600)
    p_run.add_argument("--files", nargs="*", default=None, help="Optional target file hints.")
    p_run.add_argument("--task-id", default=None)
    p_run.add_argument("--dry-run", action="store_true")

    p_batch = sub.add_parser("batch", help="Dispatch parallel independent tasks from a JSON manifest.")
    p_batch.add_argument("--manifest", required=True, help="Path to JSON list or {tasks:[...]} file.")
    p_batch.add_argument("--backend", default="auto", help="Default engine ID or auto for workflow routing.")
    p_batch.add_argument("--cwd", default=None, help="Default cwd when task item omits cwd.")
    p_batch.add_argument("--quality", choices=VALID_QUALITIES, default="smart")
    p_batch.add_argument("--network", action="store_true", help="Default network_access=true for batch tasks (overridable per item).")
    p_batch.add_argument("--max-concurrency", type=int, default=3)
    p_batch.add_argument("--timeout", type=int, default=600)
    p_batch.add_argument("--dry-run", action="store_true")

    p_res = sub.add_parser("resume", help="Continue an existing worker session in its workdir.")
    p_res.add_argument("--task-id", default=None)
    p_res.add_argument("--session-id", default=None)
    p_res.add_argument("--cwd", default=None)
    p_res.add_argument("--backend", default=None)
    p_res.add_argument("--prompt", required=True, help="Follow-up prompt or '-' for stdin.")
    p_res.add_argument("--difficulty", choices=VALID_DIFFICULTIES, default="auto")
    p_res.add_argument("--quality", choices=VALID_QUALITIES, default="smart")
    p_res.add_argument("--prefer-wide", action="store_true")
    p_res.add_argument("--model", type=validate_model, default=None)
    p_res.add_argument("--effort", choices=VALID_EFFORTS, default=None)
    p_res.add_argument("--alternate", dest="alternate", action="store_true", default=None)
    p_res.add_argument("--no-alternate", dest="alternate", action="store_false")
    p_res.add_argument("--sandbox", choices=VALID_SANDBOXES, default=None)
    p_res.add_argument("--network", dest="network", action="store_true", default=None, help="Enable workspace-write network access on resume.")
    p_res.add_argument("--no-network", dest="network", action="store_false", help="Disable workspace-write network access on resume.")
    p_res.add_argument("--timeout", type=int, default=600)
    p_res.add_argument("--dry-run", action="store_true")

    p_rev = sub.add_parser("review", help="Run non-interactive read-only heterogeneous code review (--backend auto or an engine ID).")
    p_rev.add_argument("--task-id", default=None)
    p_rev.add_argument("--cwd", default=None)
    p_rev.add_argument("--backend", default="auto")
    p_rev.add_argument("--quality", choices=VALID_QUALITIES, default="smart")
    p_rev.add_argument("--model", type=validate_model, default=None)
    p_rev.add_argument("--effort", choices=VALID_EFFORTS, default=None)
    p_rev.add_argument("--base", default=None, help="Base Git branch or SHA.")
    p_rev.add_argument("--uncommitted", action="store_true")
    p_rev.add_argument("--prompt", default=None)
    p_rev.add_argument("--timeout", type=int, default=300)
    p_rev.add_argument("--dry-run", action="store_true")

    p_st = sub.add_parser("status", help="Inspect tracked task metadata and round-robin state.")
    p_st.add_argument("--task-id", default=None)

    p_cln = sub.add_parser("cleanup", help="Remove a task's managed Git worktree (and optionally branch).")
    p_cln.add_argument("--task-id", required=True)
    p_cln.add_argument("--delete-branch", action="store_true")
    p_cln.add_argument("--force", action="store_true")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    handlers = {
        "health": cmd_health,
        "run": cmd_run,
        "batch": cmd_batch,
        "resume": cmd_resume,
        "review": cmd_review,
        "status": cmd_status,
        "cleanup": cmd_cleanup,
    }
    try:
        return handlers[args.subcommand](args)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
