# Contributing to Antigravity-Lead-Codex

Thank you for your interest in contributing to **Antigravity-Lead-Codex**!

## Project Scope & Design Principles

- **Focused Bridge (`Antigravity <-> OpenAI Codex CLI`)**: We optimize deeply for the Google Antigravity Brain + local OpenAI Codex CLI Hand workflow rather than building a generic wrapper for dozens of CLIs.
- **Two-Layer Architecture**:
  - **Core (`plugins/codex-console`)**: Standalone visual MCP App console (`--console-only` must always work independently).
  - **Optional Add-ons (`skills/multi-agent-dispatch`, `plugins/codex-auto-router`)**: Worktree dispatcher and collaboration gates.
- **Zero-CDN CSP Compliance**: `plugins/codex-console/dist/app.html` is bundled via Vite + `vite-plugin-singlefile` with zero external runtime network assets.

## Local Development Setup

Requirements:
- **Node.js `>= 22.5`** (with built-in `node:sqlite`)
- **Python `>= 3.10`** & **Git** (for `multi-agent-dispatch` and tests)

```bash
git clone https://github.com/Koala973/antigravity-lead-codex.git
cd antigravity-lead-codex
cd plugins/codex-console && npm ci && npm run build:ui
```

## Required Checks Before Opening a PR

Run the same checks enforced by `.github/workflows/ci.yml`:

```bash
# 1. Single-source version consistency
node scripts/check-version.mjs

# 2. Privacy, hardcoded-path & secret/token scan
bash scripts/privacy-check.sh

# 3. Rebuild UI bundle and confirm dist/app.html is in sync
(cd plugins/codex-console && npm run build:ui)
git diff --exit-code -- plugins/codex-console/dist/

# 4. Run automated test suites
node --no-warnings tests/test-wave1-guards.mjs
node --no-warnings tests/test-mcp-console.mjs
python3 -m unittest discover -s tests -p "test_*.py" -v
```

To verify an end-to-end installation without modifying your personal Antigravity config:

```bash
TMP_CFG="$(mktemp -d)"
GEMINI_CONFIG_DIR="$TMP_CFG" bash scripts/install.sh --no-build --yes
GEMINI_CONFIG_DIR="$TMP_CFG" bash scripts/doctor.sh
rm -rf "$TMP_CFG"
```

## Versioning Policy

`plugins/codex-console/package.json` is the canonical version source. Whenever bumping versions, keep `plugins/codex-console/package-lock.json`, `plugins/codex-console/plugin.json`, `plugins/codex-auto-router/plugin.json`, `plugins/codex-console/dist/app.html` (via `npm run build:ui`), `README.md`, `README_EN.md`, and `CHANGELOG.md` synchronized. `scripts/check-version.mjs` enforces this in CI and release packaging.

## Pull Request Guidelines

- Keep PRs focused and well-scoped; avoid mixing unrelated refactors.
- Add or update unit/integration tests for any behavioral change or bug fix.
- Never commit personal paths, local machine identifiers, or API tokens/secrets.
