import importlib.util
import json
import os
import pathlib
import sqlite3
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent


def load_module(name: str, rel_path: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel_path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class DispatchAndHookTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dispatch = load_module("dispatch", "skills/multi-agent-dispatch/scripts/dispatch.py")
        cls.hook = load_module("allow_dispatch", "plugins/codex-auto-router/hooks/allow_dispatch.py")

    def test_semver_ordering(self):
        parse = self.dispatch.parse_codex_semver
        self.assertGreater(parse("codex-cli 0.171.0"), parse("codex-cli 0.171.0-alpha.13"))
        self.assertGreater(parse("codex-cli 0.172.0-alpha.1"), parse("codex-cli 0.171.0"))

    def test_valid_backends_codex_and_zcode(self):
        self.assertEqual(self.dispatch.VALID_BACKENDS, ("codex", "zcode"))
        self.assertEqual(self.dispatch.VALID_REVIEW_BACKENDS, ("auto", "codex", "zcode"))

    def test_zcode_model_routing_and_failover_chain(self):
        # 1. Code implementation / review -> Bailian kimi-k3 first (best multi-turn tool stability), Bailian deepseek-v4-pro-0813 second, TokenHub deepseek third
        r_code = self.dispatch.resolve_zcode_model_and_fallbacks(
            difficulty="hard",
            prompt="Refactor database concurrency state machine and add unit tests",
            is_review=False,
        )
        self.assertEqual(r_code["model"], "qwen-alibaba-model-studio-cn/kimi-k3")
        self.assertEqual(r_code["effort"], "max")
        self.assertGreaterEqual(len(r_code["fallback_chain"]), 3)
        self.assertEqual(
            r_code["fallback_chain"][1]["full_model"],
            "qwen-alibaba-model-studio-cn/deepseek-v4-pro-0813",
        )
        self.assertEqual(
            r_code["fallback_chain"][2]["full_model"],
            "e2a41300-b652-45ec-9f78-ebd2ec7889be/deepseek-v4-pro-0813",
        )

        # 2. Wide context (>=10 files or prefer_wide) -> TokenHub glm-5.3 (1M context) first
        r_wide = self.dispatch.resolve_zcode_model_and_fallbacks(
            difficulty="auto",
            prompt="Sweep repository",
            files_hint=[f"f{i}.py" for i in range(12)],
            prefer_wide=False,
        )
        self.assertEqual(r_wide["model"], "e2a41300-b652-45ec-9f78-ebd2ec7889be/glm-5.3")
        self.assertEqual(r_wide["scenario"], "wide_1m_context")

        # 3. Medium business/general -> Bailian kimi-k3 first, TokenHub kimi-k3 second
        r_med = self.dispatch.resolve_zcode_model_and_fallbacks(
            difficulty="medium",
            prompt="撰写业务安全运营方案与多方审批说明",
        )
        self.assertEqual(r_med["model"], "qwen-alibaba-model-studio-cn/kimi-k3")
        self.assertEqual(
            r_med["fallback_chain"][1]["full_model"],
            "e2a41300-b652-45ec-9f78-ebd2ec7889be/kimi-k3",
        )

        # 4. Low difficulty -> Bailian qwen3.8-max first, TokenHub deepseek-v4.1-flash second
        r_low = self.dispatch.resolve_zcode_model_and_fallbacks(
            difficulty="low",
            prompt="summarize readme",
        )
        self.assertEqual(r_low["model"], "qwen-alibaba-model-studio-cn/qwen3.8-max")
        self.assertEqual(
            r_low["fallback_chain"][1]["full_model"],
            "e2a41300-b652-45ec-9f78-ebd2ec7889be/deepseek-v4.1-flash",
        )

    def test_engine_config_override_for_optional_zcode_routes(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg_file = pathlib.Path(tmp) / "engine_config.json"
            cfg_file.write_text(
                json.dumps(
                    {
                        "codex": {"required": True, "enabled": True},
                        "zcode": {
                            "enabled": True,
                            "routes": {
                                "code_and_audit": {
                                    "primary": "custom-provider/deepseek-r1-custom",
                                    "fallback1": "qwen-alibaba-model-studio-cn/kimi-k3",
                                    "effort": "max",
                                }
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )
            old_path = self.dispatch.ENGINE_CONFIG_FILE
            self.dispatch.ENGINE_CONFIG_FILE = cfg_file
            try:
                routed = self.dispatch.resolve_zcode_model_and_fallbacks(
                    difficulty="hard",
                    prompt="Implement API endpoint and unit tests",
                )
                self.assertEqual(routed["model"], "custom-provider/deepseek-r1-custom")
                self.assertEqual(routed["fallback_chain"][0]["note"], "设置页主选模型")
            finally:
                self.dispatch.ENGINE_CONFIG_FILE = old_path

    def test_zcode_desktop_index_sync(self):
        with tempfile.TemporaryDirectory() as tmp:
            idx_db = pathlib.Path(tmp) / "tasks-index.sqlite"
            conn = sqlite3.connect(str(idx_db))
            conn.executescript(
                """
                CREATE TABLE projects (
                    project_id TEXT PRIMARY KEY, host_id TEXT, name TEXT, name_overridden INTEGER,
                    position INTEGER, pinned INTEGER, pinned_at INTEGER, deleted INTEGER,
                    deleted_at INTEGER, created_at INTEGER, updated_at INTEGER
                );
                CREATE TABLE project_roots (
                    project_id TEXT, root_path TEXT, position INTEGER, is_primary INTEGER
                );
                CREATE TABLE tasks (
                    workspace_key TEXT, workspace_path TEXT, workspace_identity TEXT,
                    task_id TEXT, title TEXT, task_status TEXT, provider TEXT, mode TEXT,
                    model TEXT, migration_source TEXT, forked_from_task_id TEXT,
                    created_at INTEGER, updated_at INTEGER, unread_at INTEGER, last_unread_at INTEGER,
                    pinned INTEGER, archived INTEGER, deleted INTEGER, title_overridden INTEGER,
                    meta_json TEXT, searchable_text TEXT, cron_automation_id TEXT, off_peak_task_id TEXT,
                    host_id TEXT, root_path TEXT, project_id TEXT, execution_directories TEXT,
                    sort_order INTEGER, cli_title TEXT, handoff_pending INTEGER, cli_title_source TEXT,
                    cli_created_at INTEGER, cli_updated_at INTEGER, cli_last_outcome TEXT,
                    cli_deleted INTEGER, worktree_root TEXT,
                    PRIMARY KEY (workspace_key, task_id)
                );
                CREATE TABLE task_group_admissions (
                    workspace_key TEXT, task_id TEXT, system_kind TEXT, user_organized INTEGER, creation_id TEXT,
                    PRIMARY KEY (workspace_key, task_id)
                );
                CREATE TABLE task_group_view_node_orders (
                    node_type TEXT, node_key TEXT PRIMARY KEY, sort_order INTEGER, created_at INTEGER, updated_at INTEGER
                );
                """
            )
            conn.close()

            old_idx = os.environ.get("ZCODE_TASKS_INDEX_DB")
            old_cli = os.environ.get("ZCODE_CLI_DB")
            os.environ["ZCODE_TASKS_INDEX_DB"] = str(idx_db)
            os.environ["ZCODE_CLI_DB"] = str(pathlib.Path(tmp) / "nonexistent.sqlite")
            try:
                ok = self.dispatch.sync_zcode_session_to_desktop_index(
                    session_id="sess_test_123456",
                    workspace_path=ROOT,
                    title_hint="Verify ZCode desktop sync",
                    model_full="qwen-alibaba-model-studio-cn/deepseek-v4-pro-0813",
                    effort="max",
                    sandbox="read-only",
                    status="completed",
                    summary_text="All checks passed.",
                )
                self.assertTrue(ok)
                conn = sqlite3.connect(str(idx_db))
                row = conn.execute("SELECT task_id, title, model, task_status FROM tasks").fetchone()
                conn.close()
                self.assertEqual(row[0], "sess_test_123456")
                self.assertEqual(row[2], "qwen-alibaba-model-studio-cn/deepseek-v4-pro-0813")
                self.assertEqual(row[3], "completed")
            finally:
                if old_idx is None:
                    os.environ.pop("ZCODE_TASKS_INDEX_DB", None)
                else:
                    os.environ["ZCODE_TASKS_INDEX_DB"] = old_idx
                if old_cli is None:
                    os.environ.pop("ZCODE_CLI_DB", None)
                else:
                    os.environ["ZCODE_CLI_DB"] = old_cli

    def test_hook_blocks_shell_chaining_and_gates_worker_merge(self):
        self.assertFalse(self.hook.is_pure_dispatch_command("python3 dispatch.py status && rm -rf /"))
        self.assertTrue(self.hook.has_unsafe_shell_syntax("echo a | cat"))

        res = self.hook.evaluate_hook(
            {
                "toolCall": {
                    "name": "run_command",
                    "args": {"CommandLine": "git merge agy-worker/feat-auth"},
                }
            }
        )
        self.assertEqual(res["decision"], "force_ask")
        self.assertEqual(self.hook.evaluate_hook(None)["decision"], "ask")

    def test_network_flag_command_building_and_guardrails(self):
        report_path = pathlib.Path("/tmp/report.json")
        workdir = pathlib.Path("/tmp/demo-repo")

        offline_cmd = self.dispatch.build_codex_exec_cmd(
            codex_bin="codex",
            workdir=workdir,
            model="gpt-6.2-sol",
            effort="high",
            sandbox="workspace-write",
            network=False,
            report_path=report_path,
            is_git_repo=True,
        )
        self.assertNotIn("sandbox_workspace_write.network_access=true", offline_cmd)
        self.assertIn("workspace-write", offline_cmd)

        net_cmd = self.dispatch.build_codex_exec_cmd(
            codex_bin="codex",
            workdir=workdir,
            model="gpt-6.2-sol",
            effort="high",
            sandbox="workspace-write",
            network=True,
            report_path=report_path,
            is_git_repo=True,
        )
        self.assertIn("sandbox_workspace_write.network_access=true", net_cmd)
        self.assertIn("workspace-write", net_cmd)
        self.assertNotIn("danger-full-access", net_cmd)

        resume_net_cmd = self.dispatch.build_codex_resume_cmd(
            codex_bin="codex",
            session_id="01a9-demo",
            model="gpt-6.2-sol",
            effort="high",
            sandbox="workspace-write",
            network=True,
            report_path=report_path,
            is_git_repo=True,
        )
        self.assertIn("sandbox_workspace_write.network_access=true", resume_net_cmd)

        with self.assertRaises(ValueError):
            self.dispatch.build_codex_exec_cmd(
                codex_bin="codex",
                workdir=workdir,
                model="gpt-6.2-sol",
                effort="high",
                sandbox="read-only",
                network=True,
                report_path=report_path,
                is_git_repo=True,
            )

    def test_hook_gates_network_dispatch_and_forbids_danger_mode(self):
        script = self.hook.DISPATCH_SCRIPT

        offline = self.hook.evaluate_hook(
            {
                "toolCall": {
                    "name": "run_command",
                    "args": {"CommandLine": f'python3 {script} run --cwd /tmp --prompt "fix bug"'},
                }
            }
        )
        self.assertEqual(offline["decision"], "allow")

        networked = self.hook.evaluate_hook(
            {
                "toolCall": {
                    "name": "run_command",
                    "args": {"CommandLine": f'python3 {script} run --cwd /tmp --network --prompt "sync api"'},
                }
            }
        )
        self.assertEqual(networked["decision"], "force_ask")
        self.assertFalse(self.hook.is_pure_dispatch_command(f'python3 {script} run --network --prompt "x"'))

        danger = self.hook.evaluate_hook(
            {
                "toolCall": {
                    "name": "run_command",
                    "args": {"CommandLine": f'python3 {script} run --sandbox danger-full-access --prompt "x"'},
                }
            }
        )
        self.assertEqual(danger["decision"], "ask")


if __name__ == "__main__":
    unittest.main()
