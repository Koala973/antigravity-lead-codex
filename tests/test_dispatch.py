import contextlib
import importlib.util
import io
import json
import os
import pathlib
import sqlite3
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
        self.config_file = self.root / "engine_config.json"
        env = mock.patch.dict(os.environ, {
            "AGY_ENGINE_CONFIG_FILE": str(self.config_file), "AGY_DISPATCH_STATE_DIR": str(self.root),
            "AGY_MODELS_CACHE_FILE": str(self.root / "models_cache.json"),
            "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE": str(self.root / "provider_config.json"),
        })
        env.start()
        self.addCleanup(env.stop)
        paths = mock.patch.multiple(self.dispatch, STATE_DIR=self.root, STATE_FILE=self.root / "state.json",
                                    LOCK_FILE=self.root / "state.lock", RUNS_DIR=self.root / "runs",
                                    WORKTREES_DIR=self.root / "trees")
        paths.start()
        self.addCleanup(paths.stop)
        self.config = self.dispatch.default_engine_config()
        self.engines = {e["id"]: e for e in self.config["engines"]}

    def save(self):
        self.config_file.write_text(json.dumps(self.config))

    def cli(self, *argv):
        args = self.dispatch.build_parser().parse_args(argv)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = getattr(self.dispatch, "cmd_" + args.subcommand)(args)
        self.assertEqual(code, 0, output.getvalue())
        return json.loads(output.getvalue())

    def test_registry_defaults_and_open_parser(self):
        self.assertEqual(self.dispatch.load_engine_config(), self.config)
        self.assertEqual([e["id"] for e in self.config["engines"] if e["enabled"]], ["codex"])
        parser = self.dispatch.build_parser()
        self.assertEqual(parser.parse_args(["run", "--prompt", "hi"]).backend, "auto")
        for cmd in ("run", "resume", "review"):
            self.assertEqual(parser.parse_args([cmd, "--backend", "my-cli", "--prompt", "hi"]).backend, "my-cli")

    def test_all_disabled_v2_load_heals_first_engine_and_roles(self):
        self.config["engines"] = [self.engines[k] for k in ("gemini", "codex", "zcode", "claude")]
        for e in self.config["engines"]:
            e["enabled"] = False
        self.config["workflowRoles"]["primaryBuilder"].update(engineId="zcode", model="stale-model")
        self.config["workflowRoles"]["reviewer"].update(mode="explicit", engineId="claude")
        self.save()
        config = self.dispatch.load_engine_config()
        self.assertEqual([e["id"] for e in config["engines"] if e["enabled"]], ["gemini"])
        self.assertEqual(config["workflowRoles"]["primaryBuilder"], {"engineId": "gemini", "model": "auto", "effort": "xhigh"})
        self.assertEqual(config["workflowRoles"]["reviewer"]["mode"], "auto_heterogeneous")
        preview = self.cli("run", "--cwd", str(self.root), "--prompt", "check", "--dry-run")
        self.assertEqual(preview["backend"], "gemini")

    def test_synthesized_disabled_engines_cannot_run_resume_or_review(self):
        self.assertFalse(self.config_file.exists())
        for engine_id in ("zcode", "claude", "gemini"):
            for argv in (["run"], ["resume", "--session-id", "fixture"], ["review"]):
                with self.subTest(engine=engine_id, cmd=argv[0]), self.assertRaisesRegex(ValueError, f"Engine '{engine_id}' is disabled"):
                    self.cli(*argv, "--cwd", str(self.root), "--backend", engine_id, "--prompt", "check", "--dry-run")

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

    def test_configured_effort_and_model_validation_before_execution(self):
        invalid = 'high"\ninvalid=true'
        roles = self.config["workflowRoles"]
        self.engines["codex"]["models"]["defaultEffort"] = invalid
        self.save()
        with self.assertRaisesRegex(ValueError, "Invalid reasoning effort"):
            self.cli("run", "--backend", "codex", "--cwd", str(self.root), "--prompt", "demo", "--dry-run")
        self.engines["codex"]["models"]["defaultEffort"] = "high"
        for role, command, args in [(roles["primaryBuilder"], "run", []),
                                    (roles["scenarios"]["wide_context"], "run", ["--prefer-wide"]),
                                    (roles["reviewer"], "review", [])]:
            with self.subTest(role=role, command=command):
                role.update(engineId="codex", effort=invalid)
                if "enabled" in role:
                    role["enabled"] = True
                if "mode" in role:
                    role["mode"] = "explicit"
                self.save()
                with self.assertRaisesRegex(ValueError, "Invalid reasoning effort"):
                    self.cli(command, "--cwd", str(self.root), "--prompt", "check", "--dry-run", *args)
                role["effort"] = "high"
        self.engines["codex"]["models"]["fallbackModel"] = "model\n"
        self.save()
        with self.assertRaisesRegex(ValueError, "Invalid model"):
            self.cli("run", "--cwd", str(self.root), "--prompt", "check", "--dry-run")
        manifest = self.root / "invalid-batch.json"
        manifest.write_text(json.dumps([{"prompt": "demo", "effort": invalid}]))
        with self.assertRaisesRegex(ValueError, "Invalid reasoning effort"):
            self.cli("batch", "--manifest", str(manifest), "--cwd", str(self.root), "--dry-run")

    def test_v1_migration_and_dynamic_config_path(self):
        saved = {
            "codex": {"enabled": False, "binPath": "codex-local", "flagshipModel": "custom-codex",
                      "fastModel": "auto", "defaultEffort": "high", "defaultIsolation": "inplace"},
            "zcode": {"enabled": True, "scriptPath": "z-custom", "syncDesktopIndex": False, "routes": {
                "code_and_audit": {"primary": "team/main", "fallback1": "team/backup"},
                "reasoning_and_business": {"primary": "team/business"},
                "wide_1m_context": {"primary": "team/wide", "fallback1": "team/wide-2", "effort": "low"},
                "fast_tool_and_plugin": {"primary": "qwen-alibaba-model-studio-cn/qwen3.8-max", "effort": "xhigh"},
            }},
            "customAgents": [{"id": "my-cli", "name": "My CLI", "binPath": "worker", "enabled": True,
                              "defaultModel": "my-model", "argsTemplate": "--ask {prompt}"}],
            "policy": {"reviewPolicy": "codex_only", "hideDisabledEngineTasks": True},
        }
        self.config_file.write_text(json.dumps(saved))
        migrated = self.dispatch.load_engine_config()
        self.assertEqual(set(migrated), set(self.config))
        engines = {e["id"]: e for e in migrated["engines"]}
        self.assertFalse(engines["codex"]["enabled"])
        self.assertEqual(engines["codex"]["models"], {"primaryModel": "custom-codex", "fallbackModel": "", "defaultEffort": "high"})
        self.assertEqual(migrated["policy"], {"costStrategy": "effect_first", "defaultIsolation": "inplace", "hideDisabledEngineTasks": True})
        self.assertEqual(engines["zcode"]["binPath"], "z-custom")
        self.assertFalse(engines["zcode"]["adapter"]["syncDesktopIndex"])
        self.assertEqual(engines["zcode"]["models"]["fallbackModel"], "team/backup")
        self.assertEqual(engines["my-cli"]["adapter"]["execTemplate"], "{bin} --ask {prompt}")
        roles = migrated["workflowRoles"]
        self.assertEqual(roles["primaryBuilder"]["engineId"], "zcode")
        self.assertEqual(roles["reviewer"]["mode"], "auto_heterogeneous")
        self.assertEqual(roles["scenarios"]["wide_context"], {"enabled": True, "engineId": "zcode", "model": "team/wide",
                                                              "fallbackModel": "team/wide-2", "effort": "low"})
        self.assertTrue(roles["scenarios"]["chinese_business_security"]["enabled"])
        self.assertFalse(roles["scenarios"]["unit_tests_and_tools"]["enabled"])
        other = self.root / "other.json"
        other.write_text(json.dumps({"codex": {"enabled": False}, "zcode": {"enabled": False},
                                     "policy": {"reviewPolicy": "codex_only"}}))
        with mock.patch.object(self.dispatch, "ENGINE_CONFIG_FILE", other):
            recovered = self.dispatch.load_engine_config()
            self.assertTrue(any(e["enabled"] for e in recovered["engines"]))
            self.assertFalse(next(e for e in recovered["engines"] if e["id"] == "codex")["enabled"])
            self.assertEqual(recovered["workflowRoles"]["reviewer"]["mode"], "auto_heterogeneous")
            other.write_text(json.dumps({"policy": {"reviewPolicy": "codex_only"}}))
            self.assertEqual(self.dispatch.load_engine_config()["workflowRoles"]["reviewer"]["engineId"], "codex")

    def test_auto_builder_batch_and_disabled_engine(self):
        self.engines["codex"]["enabled"] = False
        for engine_id in ("zcode", "claude"):
            with self.subTest(engine=engine_id):
                self.engines[engine_id]["enabled"] = True
                self.config["workflowRoles"]["primaryBuilder"].update(engineId=engine_id, model="team/builder", effort="high")
                self.save()
                preview = self.cli("run", "--cwd", str(self.root), "--prompt", "build", "--dry-run")
                self.assertEqual((preview["backend"], preview["routing"]["model"], preview["routing"]["effort"]),
                                 (engine_id, "team/builder", "high"))
        manifest = self.root / "batch.json"
        manifest.write_text(json.dumps([{"prompt": "build", "sandbox": "read-only"},
                                        {"prompt": "build", "sandbox": "read-only", "backend": "zcode"}]))
        results = self.cli("batch", "--manifest", str(manifest), "--cwd", str(self.root), "--dry-run")["results"]
        self.assertEqual([r["backend"] for r in results], ["claude", "zcode"])
        with self.assertRaisesRegex(ValueError, "Engine 'codex' is disabled"):
            self.cli("run", "--backend", "codex", "--prompt", "noop", "--dry-run")
        with self.assertRaisesRegex(ValueError, "Unknown CLI engine"):
            self.cli("run", "--backend", "nonexistent", "--prompt", "noop", "--dry-run")

    def test_workflow_scenarios_and_precedence(self):
        self.engines["zcode"]["enabled"] = True
        self.engines["claude"]["enabled"] = True
        roles = self.config["workflowRoles"]
        roles["primaryBuilder"].update(engineId="claude", model="builder")
        for key, prompt, options in [
            ("wide_context", "read project", ["--prefer-wide"]),
            ("architecture_concurrency", "Fix concurrency in the cache", []),
            ("chinese_business_security", "校对中文业务规则", []),
            ("unit_tests_and_tools", "Add unit tests", []),
        ]:
            with self.subTest(scenario=key):
                scenario = roles["scenarios"][key]
                scenario.update(engineId="zcode", model="team/scenario", fallbackModel="team/backup", effort="low")
                argv = ["run", "--backend", "auto", "--cwd", str(self.root), "--prompt", prompt, "--dry-run", *options]
                self.save()
                self.assertEqual(self.cli(*argv)["routing"]["model"], "builder")
                scenario["enabled"] = True
                self.save()
                selected = self.cli(*argv)
                self.assertEqual(selected["backend"], "zcode")
                routing = selected["routing"]
                self.assertEqual(routing["workflow_scenario"], key)
                self.assertEqual(routing["effort"], "low")
                self.assertEqual([c["full_model"] for c in routing["fallback_chain"][:2]], ["team/scenario", "team/backup"])
                explicit = self.cli(*argv, "--model", "team/cli", "--effort", "high")["routing"]
                self.assertEqual((explicit["model"], explicit["effort"]), ("team/cli", "high"))
                self.assertEqual([c["full_model"] for c in explicit["fallback_chain"][:3]],
                                 ["team/cli", "team/scenario", "team/backup"])
                self.engines["zcode"]["enabled"] = False
                self.save()
                self.assertEqual(self.cli(*argv)["backend"], "claude")
                self.engines["zcode"]["enabled"] = True

    def test_heterogeneous_explicit_and_sole_engine_review(self):
        roles = self.config["workflowRoles"]
        self.engines["claude"]["enabled"] = True
        for author, reviewer, enabled, explicit in [
            ("codex", "zcode", ["codex", "zcode"], False), ("zcode", "codex", ["codex", "zcode"], False),
            ("codex", "claude", ["codex", "zcode", "claude"], True), ("codex", "claude", ["codex", "claude"], False),
            ("zcode", "zcode", ["zcode"], False),
        ]:
            with self.subTest(author=author, reviewer=reviewer, explicit=explicit):
                for engine in self.engines.values():
                    engine["enabled"] = engine["id"] in enabled
                roles["reviewer"].update(mode="explicit" if explicit else "auto_heterogeneous",
                                         engineId=reviewer if explicit else "", model="review-model" if explicit else "auto", effort="max")
                self.save()
                self.dispatch.STATE_FILE.write_text(json.dumps({"tasks": {"author": {"backend": author, "workdir": str(self.root)}}}))
                with mock.patch.object(self.dispatch, "is_engine_available", return_value=False):
                    review = self.cli("review", "--task-id", "author", "--backend", "auto", "--dry-run")
                self.assertEqual(review["backend"], reviewer)
                self.assertEqual(review["reviewer_mode"], roles["reviewer"]["mode"])
                self.assertEqual(review["sandbox"], "read-only")
                if author == reviewer:
                    self.assertIn("self-review", review["review_note"])
                if explicit:
                    self.assertEqual((review["review_model"], review["review_effort"]), ("review-model", "max"))
                    self.assertIn("--permission-mode", review["command"])
                if reviewer == "zcode":
                    self.assertIn("plan", review["command"])
        for e in self.engines.values():
            e["enabled"] = True
        roles["primaryBuilder"]["engineId"] = "codex"
        self.save()
        with mock.patch.object(self.dispatch, "is_engine_available", side_effect=lambda e: e["id"] == "gemini"):
            result = self.cli("review", "--cwd", str(self.root), "--dry-run")
        self.assertEqual((result["author_backend"], result["backend"]), ("codex", "gemini"))

    def test_generic_argv_is_literal_and_optional_selectors(self):
        prompt = 'quotes " and \' with spaces\n$(touch MARKER); `touch MARKER` {model} {session_id}'
        engine = self.dispatch.custom_engine("my-cli")
        for entry in (self.engines["claude"], self.engines["gemini"], engine):
            template = entry["adapter"]["resumeTemplate"]
            args = self.dispatch.build_generic_cli_cmd(template, bin_path="/a b/cli", prompt=prompt, cwd=self.root,
                                                       model="auto", effort="high", sandbox="read-only", session_id="")
            self.assertEqual(args[:3], ["/a b/cli", "-p", prompt])
            for flag in ("--model", "-m", "--resume"):
                self.assertNotIn(flag, args)
        args = self.dispatch.build_generic_cli_cmd('{bin} "--message={prompt}" {cwd} {effort}/{sandbox} --resume {session_id}',
                                                   bin_path="cli", prompt=prompt, cwd=self.root, model="m",
                                                   effort="high", sandbox="read-only", session_id="a b")
        self.assertEqual(args, ["cli", "--message=" + prompt, str(self.root), "high/read-only", "--resume", "a b"])

    def test_generic_cli_run_resume_review_and_failover(self):
        binary = self.root / "fixture cli"
        binary.write_text("""#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
model = args[args.index('--model') + 1]
if model == 'unavailable':
    sys.exit(9)
print(json.dumps({'session_id': 'sess_custom', 'usage': {'input_tokens': 7}}))
print(json.dumps({'result': {'summary': json.dumps(args), 'verification_passed': True}}))
""")
        binary.chmod(0o755)
        engine = self.dispatch.custom_engine("my-cli")
        engine.update(enabled=True, binPath=str(binary))
        engine["models"].update(primaryModel="unavailable", fallbackModel="working")
        engine["adapter"]["readonlyTemplate"] += " --permissions {sandbox}"
        self.config["engines"].append(engine)
        self.config["workflowRoles"]["primaryBuilder"]["engineId"] = "my-cli"
        self.config["workflowRoles"]["reviewer"].update(mode="explicit", engineId="my-cli")
        self.save()
        prompt = """a "quoted" prompt; $(touch MARKER) `touch MARKER` {cwd}"""
        argv = ["run", "--cwd", str(self.root), "--prompt", prompt, "--task-id", "fixture"]
        preview = self.cli(*argv, "--dry-run")
        self.assertIn(prompt, preview["command"][2])
        run = self.cli(*argv)
        self.assertEqual(run["session_id"], "sess_custom")
        self.assertEqual(run["usage"], {"input_tokens": 7})
        self.assertEqual(run["model_used"], "working")
        self.assertEqual([a["exit_code"] for a in run["routing"]["attempts"]], [9, 0])
        self.assertTrue(run["routing"]["failover_triggered"])
        self.assertTrue(json.loads(run["report"]["summary"])[1].startswith(prompt))
        self.assertFalse((self.root / "MARKER").exists())
        resume = self.cli("resume", "--backend", "auto", "--session-id", "sess_custom", "--prompt", "continue", "--sandbox", "read-only")
        resumed = json.loads(resume["report"]["summary"])
        self.assertIn("--resume", resumed)
        self.assertIn("sess_custom", resumed)
        self.assertIn("read-only", resumed)
        self.assertEqual(resume["task_id"], "fixture")
        record = json.loads(self.dispatch.STATE_FILE.read_text())["tasks"]["fixture"]
        self.assertEqual(record["sandbox"], "workspace-write")
        review = self.cli("review", "--task-id", "fixture")
        self.assertIn("read-only", json.loads(review["review_summary"]))
        self.assertTrue(review["routing"]["failover_triggered"])
        self.assertEqual(self.dispatch.parse_generic_cli_output("plain text", "", 0)["report"]["summary"], "plain text")
        self.assertEqual(self.dispatch.parse_generic_cli_output("", "bad", 1)["report"]["status"], "failed")

    def test_codex_configured_bin_cache_and_timeout_failover(self):
        cache = self.root / "catalog.json"
        cache.write_text(json.dumps({"models": [{"slug": "gpt-9", "visibility": "list"}]}))
        codex = self.engines["codex"]
        codex.update(binPath=sys.executable, configFilePath=str(cache))
        codex["models"].update(fallbackModel="backup", defaultEffort="high")
        self.save()
        argv = ["run", "--backend", "codex", "--cwd", str(self.root), "--prompt", "demo"]
        with mock.patch.dict(os.environ):
            del os.environ["AGY_MODELS_CACHE_FILE"]
            preview = self.cli(*argv, "--dry-run")
            self.assertEqual(preview["command"][0], sys.executable)
            self.assertIn("model_catalog_json=" + json.dumps(str(cache)), preview["command"])
            self.assertEqual((preview["routing"]["model"], preview["routing"]["effort"]), ("gpt-9", "high"))
            with mock.patch.object(self.dispatch, "run_subprocess_with_timeout", side_effect=[
                (124, "", "timeout", True), (0, '{"type":"thread.started","thread_id":"ok"}', "", False),
            ]) as execute:
                result = self.cli(*argv)
        self.assertEqual(result["model_used"], "backup")
        self.assertTrue(result["routing"]["attempts"][0]["timed_out"])
        self.assertEqual(execute.call_args_list[1].args[0][execute.call_args_list[1].args[0].index("-m") + 1], "backup")

    def test_failover_attempts_are_strictly_capped(self):
        self.engines["zcode"].update(enabled=True, binPath=str(self.root / "z.cjs"))
        (self.root / "z.cjs").write_text("console.log('ok')")
        self.save()
        routing = {
            "fallback_chain": [
                {"provider_id": "p", "provider_label": "P", "model_id": f"m{i}", "full_model": f"p/m{i}", "effort": "max"}
                for i in range(12)
            ]
        }
        with mock.patch.object(self.dispatch, "get_node_bin", return_value=sys.executable), \
                mock.patch.object(self.dispatch, "run_subprocess_with_timeout", return_value=(124, "", "timeout", True)) as runner:
            res = self.dispatch.run_generic_cli_with_failover(
                engine=self.engines["zcode"], routing=routing, workdir=self.root, prompt="audit",
                sandbox="read-only", run_dir=self.root / "cap-run", timeout=10,
            )
        self.assertEqual(res["exit_code"], 124)
        self.assertEqual(runner.call_count, self.dispatch.MAX_FAILOVER_ATTEMPTS)
        self.assertEqual(len(routing["attempts"]), self.dispatch.MAX_FAILOVER_ATTEMPTS)

    def test_zcode_configured_provider_script_and_desktop_switch(self):
        script = self.root / "fixture-zcode"
        script.write_text("""import json, os
p = json.load(open(os.environ['ZCODE_PERSONAL_PROVIDER_CONFIG_FILE']))
print(json.dumps({'session_id':'sess_ztest', 'result': p['config']['defaultModelSelection']['modelId']}))
""")
        cfg = self.root / "providers.json"
        cfg.write_text(json.dumps({"config": {"providerConfigRules": {"providerRules": [
            {"providerId": "team", "config": {"personalModelIds": ["zmain"]}}]}}}))
        zcode = self.engines["zcode"]
        zcode.update(enabled=True, binPath=str(script), configFilePath=str(cfg))
        zcode["models"].update(primaryModel="team/zmain", fallbackModel="team/zbackup", defaultEffort="high")
        zcode["adapter"]["syncDesktopIndex"] = False
        self.save()
        with mock.patch.dict(os.environ), mock.patch.object(self.dispatch, "get_node_bin", return_value=sys.executable), \
                mock.patch.object(self.dispatch, "sync_zcode_session_to_desktop_index") as sync:
            del os.environ["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"]
            result = self.cli("run", "--backend", "zcode", "--cwd", str(self.root), "--task-id", "zt", "--prompt", "demo")
            self.assertEqual(result["report"]["summary"], "zmain")
            self.assertFalse(result["desktop_synced"])
            self.cli("resume", "--task-id", "zt", "--prompt", "demo")
            self.cli("review", "--backend", "zcode", "--task-id", "zt")
            sync.assert_not_called()
        self.assertNotIn("defaultModelSelection", json.loads(cfg.read_text())["config"])

    def test_health_with_only_non_codex_engine(self):
        for e in self.engines.values():
            e["enabled"] = e["id"] == "claude"
        self.engines["claude"].update(binPath=sys.executable, configFilePath=str(self.root / "no-claude.json"))
        self.engines["gemini"]["configFilePath"] = str(self.root / "no-gemini.json")
        self.save()
        with mock.patch.object(self.dispatch, "get_codex_bin", return_value=None), \
                mock.patch.object(self.dispatch, "list_codex_candidates", return_value=[]):
            health = self.cli("health")
        self.assertTrue(health["healthy"])
        self.assertTrue(health["engines"]["claude"]["available"])
        self.assertFalse(health["engines"]["codex"]["available"])
        self.assertEqual(health["workflow_roles"]["primaryBuilder"]["engineId"], "claude")
        self.assertEqual(health["engines"]["claude"]["models_count"], 3)
        self.assertTrue({"codex", "zcode", "git", "frontier_models"} <= health.keys())

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
