# Security Policy

## Supported Versions

| Version | Supported |
| :--- | :--- |
| `2.x` | Yes |
| `< 2.0.0` | No (upgrade to `2.x`) |

## Reporting a Vulnerability

Please **do not** open a public GitHub Issue for security vulnerabilities, credential leaks, sandbox bypasses, or hook evasion bugs.

Instead, report vulnerabilities privately via **GitHub Security Advisories**:
- Open [Security Advisories](https://github.com/Koala973/antigravity-lead-codex/security/advisories/new) on `Koala973/antigravity-lead-codex`.

Please include:
1. Affected component (`codex-console`, `multi-agent-dispatch`, `codex-auto-router`, or install/release scripts) and version.
2. Clear reproduction steps or a minimal proof of concept.
3. Expected security boundary vs. observed behavior.

We aim to acknowledge reports within 72 hours and coordinate a fix before public disclosure.

## Security Model & Boundaries

- **Read-Only Access to Codex SQLite DBs**: `codex-console` opens `~/.codex/*.sqlite` strictly read-only (`{ readOnly: true }`) and writes its own metadata exclusively to `${PLUGIN_DATA}/console.sqlite`.
- **Sandboxed Execution**: `multi-agent-dispatch` defaults to offline `workspace-write` inside isolated Git worktrees (`agy-worker/*`) and never drops to `danger-full-access`. Outbound network access (`--network`) is opt-in only.
- **No Secrets in Repository**: CI runs `scripts/privacy-check.sh` on every push and pull request to block hardcoded personal paths and common API keys/tokens (`sk-`, `ghp_`, `AIza`, `AKIA`, PEM private keys).
- **Zero External UI Assets**: The bundled side-pane UI (`plugins/codex-console/dist/app.html`) contains no external CDN scripts, stylesheets, or tracking beacons.
