import contextlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

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

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = pathlib.Path(temp.name)
        self.cache = self.root / "models_cache.json"
        env = mock.patch.dict(os.environ, {
            "AGY_DISPATCH_STATE_DIR": str(self.root), "AGY_MODELS_CACHE_FILE": str(self.cache),
            "CODEX_HOME": str(self.root), "CODEX_BIN": sys.executable,
        })
        env.start()
        self.addCleanup(env.stop)
        paths = mock.patch.multiple(self.dispatch, STATE_DIR=self.root, STATE_FILE=self.root / "state.json",
                                    LOCK_FILE=self.root / "state.lock", RUNS_DIR=self.root / "runs",
                                    WORKTREES_DIR=self.root / "trees")
        paths.start()
        self.addCleanup(paths.stop)

    def cli(self, *argv):
        args = self.dispatch.build_parser().parse_args(argv)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = getattr(self.dispatch, "cmd_" + args.subcommand)(args)
        self.assertEqual(code, 0, output.getvalue())
        return json.loads(output.getvalue())

    def test_codex_backend_defaults_and_alias(self):
        self.assertEqual(self.dispatch.SUPPORTED_BACKEND, "codex")
        self.assertFalse(hasattr(self.dispatch, "VALID_BACKENDS"))
        parser = self.dispatch.build_parser()
        for cmd, required in (("run", ["--prompt", "fix"]), ("batch", ["--manifest", "tasks.json"]),
                              ("resume", ["--prompt", "next"]), ("review", [])):
            help_buf = io.StringIO()
            with contextlib.redirect_stdout(help_buf), self.assertRaises(SystemExit):
                parser.parse_args([cmd, "--help"])
            self.assertNotIn("{codex,auto}", help_buf.getvalue())
            self.assertEqual(parser.parse_args([cmd, *required]).backend, "codex")
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                parser.parse_args([cmd, *required, "--backend", "other-cli"])
        for cmd, required in (("run", ["--prompt", "docs"]), ("review", []),
                              ("resume", ["--prompt", "continue", "--session-id", "fixture"])):
            preview = self.cli(cmd, "--cwd", str(self.root), "--backend", "auto", "--dry-run", *required)
            self.assertEqual(preview["backend"], "codex")
            self.assertEqual(preview["command"][:2], [sys.executable, "exec"])

    def test_cli_model_and_effort_validation(self):
        parser = self.dispatch.build_parser()
        for command in ("run", "resume", "review"):
            for flag, value in [
                ("--effort", "extreme"), ("--effort", 'high"\ninvalid=true'), ("--model", "line\n"),
                ("--model", "bad/model;extra"), ("--model", '"quoted"'), ("--model", "x" * 161), ("--model", ""),
            ]:
                with self.subTest(command=command, flag=flag, value=value), contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as error:
                        parser.parse_args([command, "--prompt", "test", flag, value])
                    self.assertEqual(error.exception.code, 2)
            for level in self.dispatch.VALID_EFFORTS:
                args = parser.parse_args([command, "--prompt", "test", "--effort", level, "--model", "org/model.v2:fast@a-b_c"])
                self.assertEqual(args.model, "org/model.v2:fast@a-b_c")
                self.assertEqual(args.effort, level)

    def test_cache_precedence_filters_and_frontier_roles(self):
        models = [
            {"slug": "gpt-6.10-sol", "priority": 0, "context_window": 500000},
            {"slug": "gpt-6.10-astra", "priority": 2, "context_window": 300000,
             "supported_reasoning_levels": [{"effort": "high"}, {"effort": "invalid"}]},
            {"slug": "gpt-6.2-astra", "priority": 0},
            {"slug": "gpt-7-hidden", "visibility": "hide"},
            {"slug": "gpt-7-private", "supported_in_api": False},
            {"slug": "gpt-999 ;invalid"},
        ]
        self.cache.write_text(json.dumps({"models": models}))
        hard = dict(difficulty="hard", prompt="work")
        target = self.dispatch.resolve_model_and_effort(**hard)
        self.assertEqual((target["model"], target["effort"]), ("gpt-6.10-astra", "high"))
        self.assertEqual(target["discovered_wide_fast"], "gpt-6.10-sol")
        self.assertEqual(self.dispatch.resolve_model_and_effort(**hard, prefer_wide=True)["model"], "gpt-6.10-sol")
        self.assertEqual(self.dispatch.resolve_model_and_effort(difficulty="low", prompt="edit")["model"], "gpt-6.10-sol")
        for _ in range(2):
            self.assertEqual(self.dispatch.resolve_model_and_effort(difficulty="medium", prompt="build")["model"],
                             "gpt-6.10-astra")
        self.assertFalse(self.dispatch.STATE_FILE.exists())
        desktop = self.root / "models_cache.codex_work_desktop.json"
        desktop.write_text(json.dumps([{"slug": "gpt-8-codex"}]))
        with mock.patch.dict(os.environ):
            del os.environ["AGY_MODELS_CACHE_FILE"]
            self.assertEqual(self.dispatch.discover_frontier_models()["source_file"], str(self.cache))
            self.cache.write_bytes(b"\xff")
            catalog = self.dispatch.discover_frontier_models()
            self.assertEqual((catalog["source_file"], catalog["wide_fast"]["slug"]), (str(desktop), "gpt-8-codex"))
        self.assertEqual(self.dispatch.resolve_model_and_effort(**hard)["model"], "gpt-6.2-astra")
        self.cache.unlink()
        catalog = self.dispatch.discover_frontier_models()
        self.assertFalse(catalog["exists"])
        self.assertEqual(catalog["listed_models"], [])
        self.assertEqual(catalog["wide_fast"]["slug"], "gpt-6.2-sol")

    def test_batch_alias_order_and_manifest_checks(self):
        manifest = self.root / "batch.json"
        argv = ["batch", "--backend", "auto", "--manifest", str(manifest), "--cwd", str(self.root), "--dry-run"]
        items = [{"prompt": "fix", "isolation": "inplace", "difficulty": d} for d in ("hard", "low")]
        manifest.write_text(json.dumps({"tasks": items}))
        batch = self.cli(*argv)
        self.assertEqual(batch["batch_failed"], 0)
        self.assertEqual([r["backend"] for r in batch["results"]], ["codex", "codex"])
        self.assertEqual([r["routing"]["model"] for r in batch["results"]], ["gpt-6.2-astra", "gpt-6.2-sol"])
        for field, value, message in [
            ("effort", "unknown", "Invalid reasoning effort"), ("model", "bad id", "Invalid model"),
            ("backend", "other-cli", "Unsupported backend"), ("sandbox", "invalid", "Unsupported sandbox"),
            ("network", "false", "network must be true or false"), ("task_id", "../outside", "single path"),
        ]:
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, message):
                manifest.write_text(json.dumps([{"prompt": "fix", field: value}]))
                self.cli(*argv)
        manifest.write_text(json.dumps([{"prompt": "fix", "sandbox": "read-only", "network": True}]))
        with self.assertRaisesRegex(ValueError, "--network requires"):
            self.cli(*argv)

    def test_run_resume_review_status_cleanup(self):
        binary = self.root / "codex"
        binary.write_text(
            "#!/usr/bin/env python3\n"
            "import json, pathlib, sys\n"
            "if '--version' in sys.argv:\n"
            "    print('codex-cli 1.2.3')\n"
            "    sys.exit(0)\n"
            "prompt = sys.stdin.read()\n"
            "output = pathlib.Path(sys.argv[sys.argv.index('-o') + 1])\n"
            "report = json.dumps({'status': 'completed', 'summary': prompt})\n"
            "output.write_text(prompt if 'review' in sys.argv else report)\n"
            "print(json.dumps({'type': 'thread.started', 'thread_id': 'review-session' if 'review' in sys.argv else 'task-session'}))\n"
        )
        binary.chmod(0o755)
        repo = self.root / "example repo"
        repo.mkdir()
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        subprocess.run(["git", "-C", str(repo), "-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture",
                        "commit", "--allow-empty", "-qm", "initial"], check=True)
        with mock.patch.dict(os.environ, {"CODEX_BIN": str(binary)}):
            with mock.patch.object(self.dispatch, "list_codex_candidates", return_value=[]):
                self.assertTrue(self.cli("health")["healthy"])
            run = self.cli("run", "--cwd", str(repo), "--task-id", "demo", "--prompt", "update source",
                           "--network", "--difficulty", "hard")
            self.assertTrue(pathlib.Path(run["workdir"]).is_dir())
            self.assertEqual((run["session_id"], run["branch"]), ("task-session", "agy-worker/demo"))
            self.assertEqual(run["model_used"], "gpt-6.2-astra")
            resume = self.cli("resume", "--session-id", run["session_id"], "--prompt", "inspect",
                              "--backend", "auto", "--sandbox", "read-only")
            self.assertEqual((resume["task_id"], resume["model_used"]), ("demo", run["model_used"]))
            self.assertFalse(resume["network"])
            self.assertTrue(self.cli("status", "--task-id", "demo")["network"])
            review = self.cli("review", "--backend", "auto", "--task-id", "demo", "--base", "HEAD",
                              "--prompt", "check the diff")
            self.assertEqual((review["review_model"], review["sandbox"]), ("gpt-6.2-sol", "read-only"))
            for instruction in ("dist/", "node_modules/", "relative to HEAD", "check the diff"):
                self.assertIn(instruction, review["review_summary"])
            self.assertEqual(self.cli("status", "--task-id", review["review_id"])["status"], "completed")
            self.assertTrue(self.cli("cleanup", "--task-id", "demo", "--delete-branch")["worktree_removed"])
            self.assertEqual(self.cli("status", "--task-id", "demo")["status"], "cleaned")

    def test_legacy_tasks_and_damaged_state(self):
        tasks = {"old": {"session_id": "codex-session"}, "other": {"backend": "retired", "session_id": "old-session"}}
        self.dispatch.STATE_FILE.write_text(json.dumps({"tasks": tasks}))
        status = self.cli("status")
        self.assertEqual([r["task_id"] for r in status["tasks"]], ["old"])
        for command in ("cleanup", "review"):
            with self.assertRaisesRegex(ValueError, "Unknown task_id"):
                self.cli(command, "--task-id", "other")
        with self.assertRaisesRegex(ValueError, "does not belong to Codex"):
            self.cli("resume", "--session-id", "old-session", "--prompt", "next", "--dry-run")
        self.assertEqual(json.loads(self.dispatch.STATE_FILE.read_text())["tasks"], tasks)
        self.dispatch.STATE_FILE.write_text("truncated")
        with self.assertRaises(json.JSONDecodeError):
            self.cli("status")
        self.assertEqual(self.dispatch.STATE_FILE.read_text(), "truncated")

    def test_failed_cli_and_missing_session_surface_cleanly(self):
        with mock.patch.object(self.dispatch, "run_subprocess_with_timeout", return_value=(1, "", "CLI failed", False)):
            output = io.StringIO()
            args = self.dispatch.build_parser().parse_args(["run", "--cwd", str(self.root), "--prompt", "check"])
            with contextlib.redirect_stdout(output):
                self.assertEqual(self.dispatch.cmd_run(args), 1)
        result = json.loads(output.getvalue())
        self.assertEqual(result["report"]["status"], "failed")
        self.assertEqual(self.cli("status", "--task-id", result["task_id"])["status"], "failed")
        with self.assertRaisesRegex(ValueError, "No session_id"):
            self.cli("resume", "--task-id", result["task_id"], "--prompt", "continue")
        error = subprocess.run([sys.executable, str(pathlib.Path(self.dispatch.__file__)), "resume", "--prompt", "test"],
                               capture_output=True, text=True)
        self.assertEqual(error.returncode, 2)
        self.assertIn("No session_id", json.loads(error.stderr)["error"])

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
