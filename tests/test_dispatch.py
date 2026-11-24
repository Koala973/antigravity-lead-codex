import importlib.util
import pathlib
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

    def test_valid_backends_codex_only(self):
        self.assertEqual(self.dispatch.VALID_BACKENDS, ("codex",))

    def test_hook_blocks_shell_chaining_and_gates_worker_merge(self):
        # Shell chaining must never be auto-allowed
        self.assertFalse(self.hook.is_pure_dispatch_command("python3 dispatch.py status && rm -rf /"))
        self.assertTrue(self.hook.has_unsafe_shell_syntax("echo a | cat"))

        # Merging agy-worker/* must force explicit human confirmation
        res = self.hook.evaluate_hook(
            {
                "toolCall": {
                    "name": "run_command",
                    "args": {"CommandLine": "git merge agy-worker/feat-auth"},
                }
            }
        )
        self.assertEqual(res["decision"], "force_ask")

        # Unknown / malformed payloads fail safe to standard approval
        self.assertEqual(self.hook.evaluate_hook(None)["decision"], "ask")


if __name__ == "__main__":
    unittest.main()
