## Summary

<!-- Briefly describe what changed and why. -->

## Scope

- [ ] `plugins/codex-console` (MCP Server / UI)
- [ ] `skills/multi-agent-dispatch` (`dispatch.py`)
- [ ] `plugins/codex-auto-router` (Rules / Hooks)
- [ ] Scripts / CI / Documentation

## Verification Checklist

- [ ] `node scripts/check-version.mjs` passes (if version changed, all manifests, docs, and `dist/app.html` are synchronized)
- [ ] `bash scripts/privacy-check.sh` passes with 0 hits
- [ ] UI changes rebuilt via `cd plugins/codex-console && npm run build:ui` and `git diff --exit-code -- plugins/codex-console/dist/` is clean
- [ ] `node --no-warnings tests/test-wave1-guards.mjs` passes
- [ ] `node --no-warnings tests/test-mcp-console.mjs` passes
- [ ] `python3 -m unittest discover -s tests -p "test_*.py" -v` passes
- [ ] Real install + `scripts/doctor.sh` + MCP stdio handshake verified in a clean `GEMINI_CONFIG_DIR` (when touching installer, launcher, server, or UI)
