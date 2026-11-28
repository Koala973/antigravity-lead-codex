#!/usr/bin/env python3
"""Local multi-agent dispatcher for Antigravity (Brain) -> Codex CLI (Hand).

Dynamically discovers the newest official Codex frontier models from models_cache.json,
defaults to smart quality+quota (--quality smart) routing across flagship and wide_fast
models (with --quality max and --quality balanced overrides), manages isolated Git
worktrees, enforces safe headless sandbox overrides, and returns compact structured
JSON summaries to preserve Antigravity context quota.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import re
import shutil
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

BIN_DIRS = ("~/.local/bin", "~/.npm-global/bin", "~/.volta/bin", "/opt/homebrew/bin", "/usr/local/bin")
BUNDLED_CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"
FALLBACK_FLAGSHIP = "gpt-6.2-astra"
FALLBACK_WIDE_FAST = "gpt-6.2-sol"

VALID_DIFFICULTIES = ("auto", "low", "medium", "hard", "extreme")
VALID_QUALITIES = ("smart", "max", "balanced")
# This dispatcher exclusively targets OpenAI Codex CLI.
SUPPORTED_BACKEND = "codex"
# Internal backward-compatibility aliases accepted for legacy callers/manifests/state.
_COMPAT_BACKENDS = (SUPPORTED_BACKEND, "auto")
VALID_EFFORTS = ("low", "medium", "high", "xhigh", "max", "ultra")
MODEL_ID = re.compile(r"[A-Za-z0-9._/:@-]{1,160}")
VALID_SANDBOXES = ("read-only", "workspace-write")
VALID_ISOLATIONS = ("auto", "worktree", "inplace")

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
            data = json.loads(STATE_FILE.read_text(encoding="utf-8")) if STATE_FILE.exists() else {}
            if not isinstance(data, dict) or not isinstance(data.get("tasks", {}), dict):
                raise ValueError(f"Invalid dispatch state: {STATE_FILE}")
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
    resolved = shutil.which(os.path.expanduser(name))
    if resolved:
        return resolved
    for candidate in fallbacks:
        expanded = os.path.expanduser(candidate)
        if os.path.isfile(expanded) and os.access(expanded, os.X_OK):
            return expanded
    return None


def parse_codex_semver(version_text: str | None) -> tuple[int, int, int, int, int]:
    """Parse 'codex-cli 0.171.0-alpha.13' into a sortable tuple where stable > prerelease."""
    if not isinstance(version_text, str) or not version_text:
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
        shutil.which(os.path.expanduser(os.environ.get("CODEX_BIN") or "codex")),
        shutil.which("codex"),
        *(os.path.join(directory, "codex") for directory in BIN_DIRS),
        BUNDLED_CODEX_BIN,
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
    override = os.environ.get("CODEX_BIN")
    fallbacks = tuple(os.path.join(directory, "codex") for directory in BIN_DIRS)
    return (override and find_binary(override)) or find_binary("codex", (*fallbacks, BUNDLED_CODEX_BIN))


def get_node_bin() -> str | None:
    override = os.environ.get("NODE_BIN")
    fallbacks = tuple(os.path.join(directory, "node") for directory in BIN_DIRS)
    return (override and find_binary(override)) or find_binary("node", fallbacks)


def get_git_bin() -> str | None:
    return find_binary("git", ("/usr/bin/git", "/opt/homebrew/bin/git"))


def probe_version(cmd: list[str]) -> str | None:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
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
    if not isinstance(slug, str) or not MODEL_ID.fullmatch(slug):
        return None
    if entry.get("visibility") not in (None, "list") or entry.get("supported_in_api") is False:
        return None
    raw_levels = entry.get("supported_reasoning_levels")
    efforts: list[str] = []
    if isinstance(raw_levels, list):
        for lvl in raw_levels:
            effort = lvl.get("effort") if isinstance(lvl, dict) else lvl
            if effort in VALID_EFFORTS:
                efforts.append(effort)
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

    def _flagship_rank(m: dict[str, Any]) -> tuple[int, int, int, str]:
        desc = m["description"].lower()
        slug_l = m["slug"].lower()
        if any(token in slug_l.split("-") for token in ("astra", "pro", "max")):
            tier = 0
        elif "most capable" in desc or "complex" in desc:
            tier = 1
        else:
            tier = 2
        return (tier, m["priority"], -m["context_window"], m["slug"])

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


def validate_model(value: str) -> str:
    if not isinstance(value, str) or not MODEL_ID.fullmatch(value):
        raise ValueError("Invalid model ID: expected 1–160 characters from A-Z, a-z, 0-9 or ._/:@-")
    return value


def validate_effort(value: str) -> str:
    if value not in VALID_EFFORTS:
        raise ValueError(f"Invalid reasoning effort: expected one of {', '.join(VALID_EFFORTS)}")
    return value


def normalize_backend(value: str) -> str:
    if value in _COMPAT_BACKENDS:
        return SUPPORTED_BACKEND
    raise ValueError(f"Unsupported backend: {value} (only '{SUPPORTED_BACKEND}' is supported)")


def parse_backend_arg(value: str) -> str:
    try:
        return normalize_backend(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def selected_model(value: str | None) -> str | None:
    return validate_model(value) if value not in (None, "auto") else None


def discover_frontier_models() -> dict[str, Any]:
    """Use the first usable Codex catalog, respecting isolated homes and explicit overrides."""
    override = os.environ.get("AGY_MODELS_CACHE_FILE")
    home = Path(os.environ.get("CODEX_HOME") or "~/.codex").expanduser()
    paths = [Path(override).expanduser()] if override else [
        home / "models_cache.json", home / "models_cache.codex_work_desktop.json",
    ]
    for path in paths:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        entries = raw.get("models") if isinstance(raw, dict) else raw
        if not isinstance(entries, list):
            continue
        by_slug = {}
        for entry in entries:
            model = normalize_cached_model(entry) if isinstance(entry, dict) else None
            if model:
                by_slug.setdefault(model["slug"], model)
        if not by_slug:
            continue
        models = sorted(by_slug.values(), key=lambda m: (-m["gen"][0], -m["gen"][1], m["priority"], m["slug"]))
        flagship, wide_fast = pick_frontier_roles(models)
        return {
            "exists": True, "source_file": str(path),
            "client_version": raw.get("client_version") if isinstance(raw, dict) else None,
            "flagship": flagship, "wide_fast": wide_fast,
            "listed_models": models, "listed_slugs": [m["slug"] for m in models],
        }

    path = next((p for p in paths if p.is_file()), paths[0])
    return {
        "exists": path.is_file(), "source_file": str(path), "client_version": None,
        "flagship": normalize_cached_model({"slug": FALLBACK_FLAGSHIP}),
        "wide_fast": normalize_cached_model({"slug": FALLBACK_WIDE_FAST}),
        "listed_models": [], "listed_slugs": [],
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
) -> dict[str, Any]:
    """Pick a repeatable route for the workload; rotate medium tasks only when requested."""
    if difficulty not in VALID_DIFFICULTIES or quality not in VALID_QUALITIES:
        raise ValueError(f"Unsupported routing: quality={quality}, difficulty={difficulty}")
    explicit_model = selected_model(explicit_model)
    if explicit_effort is not None:
        validate_effort(explicit_effort)
    if difficulty == "auto":
        effective_difficulty, difficulty_reason = classify_difficulty(prompt, files_hint)
    else:
        effective_difficulty, difficulty_reason = difficulty, f"explicit difficulty={difficulty}"

    frontier = discover_frontier_models()
    flagship, wide_fast = frontier["flagship"], frontier["wide_fast"]
    flagship_slug, wide_slug = flagship["slug"], wide_fast["slug"]
    use_wide = prefer_wide or (difficulty == "auto" and len(files_hint or []) >= 10
                               and wide_fast["context_window"] > flagship["context_window"])
    if not use_wide:
        use_wide = ((effective_difficulty == "low" and quality != "max")
                    or (effective_difficulty == "medium" and quality == "balanced"))
    rr_slot = None
    if alternate and not prefer_wide and not explicit_model and effective_difficulty == "medium" and wide_slug != flagship_slug:
        with locked_state() as state:
            rr_slot = int(state.get("rr_counter", 0))
            state["rr_counter"] = rr_slot + 1
        use_wide = rr_slot % 2 == (1 if quality == "max" else 0)

    target = wide_fast if use_wide else flagship
    final_model = explicit_model or target["slug"]
    efforts_by_quality = {
        "smart": {"low": ("medium", "high", "low"), "medium": ("high", "xhigh", "medium"),
                  "hard": ("xhigh", "max", "high"), "extreme": ("max", "ultra", "xhigh", "high")},
        "max": {"low": ("high", "xhigh", "medium"), "medium": ("xhigh", "max", "high"),
                "hard": ("max", "xhigh", "high"), "extreme": ("ultra", "max", "xhigh", "high")},
        "balanced": {"low": ("medium", "high", "low"), "medium": ("high", "medium"),
                     "hard": ("high", "xhigh", "medium"), "extreme": ("xhigh", "max", "high")},
    }
    supported = next((m["supported_efforts"] for m in frontier["listed_models"] if m["slug"] == final_model), [])
    final_effort = explicit_effort or pick_supported_effort(efforts_by_quality[quality][effective_difficulty], supported)
    role = "explicit override" if explicit_model else ("wide_fast" if use_wide else "flagship")
    route_note = f"quality={quality}, difficulty={effective_difficulty} -> {role}: {final_model} (effort={final_effort})"
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


def worktree_path_for(repo_root: str, task_id: str) -> Path:
    repo_slug = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(repo_root).name).strip("-") or "repo"
    return WORKTREES_DIR / repo_slug / task_id


def create_worktree(repo_root: str, task_id: str, base_sha: str) -> tuple[Path, str]:
    git_bin = get_git_bin()
    if not git_bin:
        raise RuntimeError("git executable not found")
    wt_path = worktree_path_for(repo_root, task_id)
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
                if exit_code != 0:
                    parsed.update(status="failed", verification_passed=False)
                else:
                    parsed.setdefault("status", "completed")
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
    if sandbox not in VALID_SANDBOXES:
        raise ValueError(f"Unsupported sandbox: {sandbox}")
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
    if sandbox not in VALID_SANDBOXES:
        raise ValueError(f"Unsupported sandbox: {sandbox}")
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
    cmd.extend(["--", session_id, "-"])
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
    if sandbox not in VALID_SANDBOXES:
        raise ValueError(f"Unsupported sandbox: {sandbox}")
    if network and sandbox != "workspace-write":
        raise ValueError("--network requires --sandbox workspace-write.")

    backend = normalize_backend(backend)
    if task_id and (Path(task_id).name != task_id or task_id in (".", "..")):
        raise ValueError("Task ID must be a single path component.")
    if isolation not in VALID_ISOLATIONS:
        raise ValueError(f"Unsupported isolation: {isolation}")
    git_info = inspect_git(cwd)
    eff_isolation, isolation_reason = resolve_isolation(isolation, sandbox, git_info)
    tid = task_id or make_task_id("run")

    codex_bin = get_codex_bin()
    if not codex_bin and not dry_run:
        raise RuntimeError("codex CLI not found")
    routing = resolve_model_and_effort(
        difficulty=difficulty,
        prompt=prompt,
        files_hint=files_hint,
        explicit_model=model,
        explicit_effort=effort,
        quality=quality,
        alternate=alternate,
        prefer_wide=prefer_wide,
    )
    model_used = routing["model"]
    effort_used = routing["effort"]

    run_dir = RUNS_DIR / tid
    report_path = run_dir / "last_message.json"
    worker_prompt = build_worker_prompt(prompt, sandbox=sandbox, network=network, is_resume=False, files_hint=files_hint)

    workdir = cwd
    worktree_path = None
    branch_name = None
    if not dry_run:
        run_dir.mkdir(parents=True, exist_ok=False)
    if eff_isolation == "worktree":
        if dry_run:
            workdir = worktree_path_for(git_info["repo_root"], tid)
        else:
            try:
                workdir, branch_name = create_worktree(git_info["repo_root"], tid, git_info["head_sha"])
            except (OSError, RuntimeError):
                run_dir.rmdir()
                raise
        worktree_path = str(workdir)

    cmd = build_codex_exec_cmd(
        codex_bin=codex_bin or "codex",
        workdir=workdir,
        model=model_used,
        effort=effort_used,
        sandbox=sandbox,
        network=network,
        report_path=report_path,
        is_git_repo=git_info["is_git_repo"],
    )
    if dry_run:
        return {
            "dry_run": True, "task_id": tid, "backend": backend, "routing": routing,
            "isolation": eff_isolation, "isolation_reason": isolation_reason, "sandbox": sandbox,
            "network": network, "git": git_info, "preview_workdir": str(workdir), "command": cmd,
        }

    (run_dir / "prompt.txt").write_text(worker_prompt, encoding="utf-8")
    rc, stdout_text, stderr_text, timed_out = run_subprocess_with_timeout(
        cmd, cwd=workdir, stdin_text=worker_prompt, timeout=timeout
    )
    (run_dir / "events.jsonl").write_text(stdout_text, encoding="utf-8")
    (run_dir / "stderr.log").write_text(stderr_text, encoding="utf-8")
    parsed_events = parse_codex_events(stdout_text)
    report = parse_report_file(
        report_path,
        parsed_events["last_agent_text"],
        stderr_text,
        rc,
        event_errors=parsed_events["errors"],
    )
    session_id = parsed_events["session_id"]
    usage = parsed_events["usage"]

    git_truth = collect_git_truth(workdir, git_info["head_sha"])
    now = utc_now()
    final_status = "timed_out" if timed_out else report.get("status", "completed" if rc == 0 else "failed")

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
        "exit_code": rc,
        "timed_out": timed_out,
        "usage": usage,
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


def cmd_health(_args: argparse.Namespace) -> int:
    candidates = list_codex_candidates()
    codex_bin = get_codex_bin()
    node_bin = get_node_bin()
    git_bin = get_git_bin()

    codex_ver = probe_version([codex_bin, "--version"]) if codex_bin else None
    node_ver = probe_version([node_bin, "--version"]) if node_bin else None
    git_ver = probe_version([git_bin, "--version"]) if git_bin else None
    frontier = discover_frontier_models()

    healthy = bool(
        codex_bin
        and codex_ver
        and git_bin
        and SCHEMA_PATH.exists()
    )

    payload = {
        "healthy": healthy,
        "schema_exists": SCHEMA_PATH.exists(),
        "state_dir": str(STATE_DIR),
        "default_quality_mode": "smart",
        "codex": {"bin": codex_bin, "version": codex_ver, "candidates": candidates},
        "node": {"bin": node_bin, "version": node_ver},
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
        # Enforce worktree isolation when multiple concurrent write tasks share a Git repo
        if len(items) > 1 and item_sandbox == "workspace-write" and item_iso == "auto":
            item_iso = "worktree"
        item_alt = item.get("alternate")
        if item_alt is None and "no_alternate" in item:
            item_alt = not bool(item["no_alternate"])
        item_network = item.get("network", args.network)
        if not isinstance(item_network, bool):
            raise ValueError("Manifest network must be true or false.")
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


def codex_tasks(state: dict[str, Any]) -> dict[str, Any]:
    """Return only Codex records, including older records without a backend field."""
    return {tid: task for tid, task in state["tasks"].items()
            if isinstance(task, dict) and task.get("backend", SUPPORTED_BACKEND) in _COMPAT_BACKENDS}


def cmd_resume(args: argparse.Namespace) -> int:
    prompt_text = sys.stdin.read() if args.prompt == "-" else args.prompt
    task_record: dict[str, Any] | None = None
    if args.task_id:
        with locked_state() as state:
            task_record = codex_tasks(state).get(args.task_id)
        if not task_record:
            raise ValueError(f"Unknown task_id: {args.task_id}")

    session_id = args.session_id or (task_record or {}).get("session_id")
    if not session_id:
        raise ValueError("No session_id available to resume (pass --session-id or valid --task-id).")
    if task_record and args.session_id and args.session_id != task_record.get("session_id"):
        raise ValueError("The supplied session ID does not match the saved task.")
    if not task_record:
        with locked_state() as state:
            task_record = next((t for t in state["tasks"].values()
                                if isinstance(t, dict) and t.get("session_id") == session_id), None)
            if task_record and task_record.get("backend", SUPPORTED_BACKEND) not in _COMPAT_BACKENDS:
                raise ValueError("The saved session does not belong to Codex.")
    original = task_record or {}
    backend = "codex"
    workdir = Path(args.cwd or original.get("workdir") or ".").resolve()
    if not workdir.is_dir():
        raise ValueError(f"Workdir does not exist: {workdir}")

    sandbox = args.sandbox or original.get("sandbox", "workspace-write")
    network = args.network
    if network is None:
        network = sandbox == "workspace-write" and original.get("network", False)
    if network and sandbox != "workspace-write":
        raise ValueError("--network requires --sandbox workspace-write.")
    base_sha = original.get("base_sha")
    git_info = inspect_git(workdir)
    codex_bin = get_codex_bin()
    if not codex_bin and not args.dry_run:
        raise RuntimeError("codex CLI not found")
    inherit = args.difficulty == "auto" and not args.prefer_wide and args.quality == "smart"
    routing = resolve_model_and_effort(
        difficulty=args.difficulty,
        prompt=prompt_text,
        explicit_model=args.model or (original.get("model") if inherit else None),
        explicit_effort=args.effort or (original.get("effort") if inherit else None),
        quality=args.quality,
        alternate=args.alternate,
        prefer_wide=args.prefer_wide,
    )
    model_used = routing["model"]
    effort_used = routing["effort"]
    resume_tid = args.task_id or original.get("task_id") or make_task_id("resume")
    turn_id = make_task_id("turn")
    run_dir = Path(original.get("run_dir") or RUNS_DIR / resume_tid) / turn_id
    report_path = run_dir / "last_message.json"
    worker_prompt = build_worker_prompt(prompt_text, sandbox=sandbox, network=network, is_resume=True)

    cmd = build_codex_resume_cmd(
        codex_bin=codex_bin or "codex",
        session_id=session_id,
        model=model_used,
        effort=effort_used,
        sandbox=sandbox,
        network=network,
        report_path=report_path,
        is_git_repo=git_info["is_git_repo"],
    )
    if args.dry_run:
        print(
            json.dumps(
                {
                    "dry_run": True,
                    "task_id": resume_tid,
                    "backend": backend,
                    "session_id": session_id,
                    "workdir": str(workdir),
                    "sandbox": sandbox,
                    "network": network,
                    "routing": routing,
                    "command": cmd,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    run_dir.mkdir(parents=True, exist_ok=False)
    (run_dir / "prompt.txt").write_text(worker_prompt, encoding="utf-8")

    rc, stdout_text, stderr_text, timed_out = run_subprocess_with_timeout(
        cmd, cwd=workdir, stdin_text=worker_prompt, timeout=args.timeout
    )
    (run_dir / "events.jsonl").write_text(stdout_text, encoding="utf-8")
    (run_dir / "stderr.log").write_text(stderr_text, encoding="utf-8")
    parsed_events = parse_codex_events(stdout_text)
    report = parse_report_file(
        report_path,
        parsed_events["last_agent_text"],
        stderr_text,
        rc,
        event_errors=parsed_events["errors"],
    )
    new_session_id = parsed_events["session_id"] or session_id
    usage = parsed_events["usage"]

    git_truth = collect_git_truth(workdir, base_sha)
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
        "exit_code": rc,
        "timed_out": timed_out,
        "usage": usage,
        "report": report,
        "git_truth": git_truth,
        "run_dir": str(run_dir),
    }
    (run_dir / "result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    if task_record:
        with locked_state() as state:
            record = state["tasks"].get(resume_tid)
            if record:
                record.update(model=model_used, effort=effort_used, session_id=new_session_id,
                              status="timed_out" if timed_out else report["status"],
                              exit_code=rc, updated_at=utc_now())
                if args.task_id:
                    record.update(sandbox=sandbox, network=network)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if rc == 0 else 1


def cmd_review(args: argparse.Namespace) -> int:
    task_record: dict[str, Any] | None = None
    if args.task_id:
        with locked_state() as state:
            task_record = codex_tasks(state).get(args.task_id)
        if not task_record:
            raise ValueError(f"Unknown task_id: {args.task_id}")

    workdir = Path(args.cwd or (task_record["workdir"] if task_record else ".")).resolve()
    if not workdir.exists():
        raise ValueError(f"Workdir does not exist: {workdir}")

    base_sha = args.base or (task_record.get("base_sha") if task_record else None)
    git_truth = collect_git_truth(workdir, base_sha)
    backend = "codex"

    codex_bin = get_codex_bin()
    if not codex_bin and not args.dry_run:
        raise RuntimeError("codex CLI not found")
    frontier = discover_frontier_models()
    flagship = frontier["flagship"]
    wide_fast = frontier["wide_fast"]
    flagship_slug, wide_slug = flagship["slug"], wide_fast["slug"]
    author_model = task_record.get("model") if task_record else None

    review_model = selected_model(args.model) or (wide_slug if author_model == flagship_slug else flagship_slug)

    if args.effort:
        review_effort = validate_effort(args.effort)
    else:
        matched = next((m for m in frontier["listed_models"] if m["slug"] == review_model), None)
        effs = matched["supported_efforts"] if matched else []
        chain = ("max", "xhigh", "high") if args.quality == "max" else ("high", "xhigh", "medium")
        review_effort = pick_supported_effort(chain, effs)

    review_id = make_task_id("review")
    run_dir = RUNS_DIR / review_id
    review_out = run_dir / "review_output.txt"

    cmd = [
        codex_bin or "codex",
        "exec",
        "review",
    ]
    if review_model:
        cmd.extend(["-m", review_model])
    if review_effort:
        cmd.extend(["-c", f'model_reasoning_effort="{review_effort}"'])
    cmd.extend([
        "-c",
        'sandbox_mode="read-only"',
        "-c",
        'approval_policy="never"',
        "--json",
        "-o",
        str(review_out),
    ])
    review_base = base_sha if not args.uncommitted and (args.base or git_truth.get("has_new_commits")) else None
    scope = (f"changes relative to {review_base}" if review_base
             else "the staged, unstaged, and untracked changes in the working tree")
    # Codex review accepts a scope flag OR a custom stdin prompt. Keep the scope and exclusions together.
    stdin_prompt = f"Review {scope}. Focus on source changes and ignore dist/ and node_modules/."
    if args.prompt:
        stdin_prompt += "\n\n" + args.prompt
    if not git_truth.get("is_git"):
        cmd.append("--skip-git-repo-check")
    cmd.append("-")

    if args.dry_run:
        print(
            json.dumps(
                {
                    "dry_run": True,
                    "review_id": review_id,
                    "sandbox": "read-only",
                    "backend": backend,
                    "review_model": review_model,
                    "review_effort": review_effort,
                    "workdir": str(workdir),
                    "command": cmd,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    run_dir.mkdir(parents=True, exist_ok=False)
    (run_dir / "prompt.txt").write_text(stdin_prompt, encoding="utf-8")
    rc, stdout_text, stderr_text, timed_out = run_subprocess_with_timeout(
        cmd, cwd=workdir, stdin_text=stdin_prompt, timeout=args.timeout
    )
    (run_dir / "events.jsonl").write_text(stdout_text, encoding="utf-8")
    (run_dir / "stderr.log").write_text(stderr_text, encoding="utf-8")

    parsed_events = parse_codex_events(stdout_text)
    review_text = (
        review_out.read_text(encoding="utf-8", errors="replace").strip()
        if review_out.exists()
        else (parsed_events["last_agent_text"] or "\n".join(stderr_text.splitlines()[-20:]))
    )
    usage = parsed_events["usage"]
    session_id = parsed_events["session_id"]

    payload = {
        "review_id": review_id,
        "task_id": args.task_id,
        "backend": backend,
        "review_model": review_model,
        "review_effort": review_effort,
        "workdir": str(workdir),
        "session_id": session_id,
        "exit_code": rc,
        "timed_out": timed_out,
        "usage": usage,
        "review_summary": review_text[:3000],
        "git_truth": git_truth,
        "run_dir": str(run_dir),
    }
    now = utc_now()
    status = "timed_out" if timed_out else ("completed" if rc == 0 else "failed")
    payload["sandbox"] = "read-only"
    payload["report"] = {"status": status, "summary": review_text[:2000], "files_modified": [],
                         "commands_run": [], "verification_passed": rc == 0, "risks_or_followups": [],
                         "notes_for_orchestrator": ""}
    (run_dir / "result.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with locked_state() as state:
        state["tasks"][review_id] = {
            "task_id": review_id, "backend": backend, "model": review_model, "effort": review_effort,
            "difficulty": "hard", "repo_root": str(workdir) if git_truth.get("is_git") else None,
            "is_git_repo": bool(git_truth.get("is_git")), "base_sha": base_sha, "original_cwd": str(workdir),
            "workdir": str(workdir), "worktree_path": None, "branch": None, "isolation": "inplace",
            "sandbox": "read-only", "network": False, "session_id": session_id, "status": status,
            "exit_code": rc, "created_at": now, "updated_at": now, "run_dir": str(run_dir),
        }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if rc == 0 else 1


def cmd_status(args: argparse.Namespace) -> int:
    with locked_state() as state:
        tasks = codex_tasks(state)
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
                    "backend": "codex",
                    "session_id": rec.get("session_id"),
                    "model": rec.get("model"),
                    "effort": rec.get("effort"),
                    "status": rec.get("status"),
                    "isolation": rec.get("isolation"),
                    "branch": rec.get("branch"),
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
        rec = codex_tasks(state).get(args.task_id)
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
        description="Local multi-agent dispatcher (Antigravity Brain -> Codex CLI Hand)."
    )
    sub = parser.add_subparsers(dest="subcommand", required=True)

    sub.add_parser("health", help="Check local Codex CLI, Git, Node, and model cache readiness.")

    p_run = sub.add_parser(
        "run",
        help="Dispatch one coding/analysis task. Defaults to smart quality-quota (--quality smart) dynamic frontier routing.",
    )
    p_run.add_argument("--cwd", default=".", help="Target repository or working directory.")
    p_run.add_argument("--prompt", required=True, help="Task prompt or '-' for stdin.")
    p_run.add_argument("--backend", type=parse_backend_arg, default=SUPPORTED_BACKEND, help=argparse.SUPPRESS)
    p_run.add_argument("--difficulty", choices=VALID_DIFFICULTIES, default="auto")
    p_run.add_argument("--quality", choices=VALID_QUALITIES, default="smart", help="Quality/quota routing mode (default: smart).")
    p_run.add_argument("--prefer-wide", action="store_true", help="Prefer largest-context frontier sibling for wide repo sweeps.")
    p_run.add_argument("--model", type=validate_model, default=None, help="Explicit model slug override (supports any future official slug).")
    p_run.add_argument("--effort", choices=VALID_EFFORTS, default=None, help="Explicit Codex reasoning effort override.")
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
    p_batch.add_argument("--backend", type=parse_backend_arg, default=SUPPORTED_BACKEND, help=argparse.SUPPRESS)
    p_batch.add_argument("--manifest", required=True, help="Path to JSON list or {tasks:[...]} file.")
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
    p_res.add_argument("--backend", type=parse_backend_arg, default=SUPPORTED_BACKEND, help=argparse.SUPPRESS)
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

    p_rev = sub.add_parser("review", help="Run non-interactive read-only Codex code review.")
    p_rev.add_argument("--task-id", default=None)
    p_rev.add_argument("--cwd", default=None)
    p_rev.add_argument("--backend", type=parse_backend_arg, default=SUPPORTED_BACKEND, help=argparse.SUPPRESS)
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
