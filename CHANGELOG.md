# Changelog

All notable changes to **antigravity-lead-codex** will be documented in this file.

## [1.0.0] - 2026-11-24

### Added
- **Codex Console (`plugins/codex-console`)**: Native Antigravity MCP App rendering in both the right auxiliary side pane (`aux_pane`) and left sidebar full-page view (`global`).
  - Dual-DB architecture: strictly read-only short-lived queries against `~/.codex/{state_5,goals_1,queue_1,thread_history_1}.sqlite` plus `~/.local/state/multi-agent-dispatch/state.json`, with local persistence (pins, aliases, diagnostic logs, cross-session bindings) isolated in `${PLUGIN_DATA}/console.sqlite`.
  - Apple Notes × Linear minimalist light/dark UI with full-frame violet gradient glow, unified dual-pane layout across all 3 tabs, soft-hide drawer (`已隐藏`), instant hover tooltips, and an original MIT-licensed pixel purple cat status pet (`working` / `strolling` / `sleeping zZz` / `blocked` / click `喵~`).
  - Live Codex Quota Ring in the top bar displaying the tightest bottleneck (`min(5h remaining, weekly remaining)`), with hover popover (per-window progress bars, exact reset countdown, plan tier, reset credits) powered by official `codex app-server` live RPC + instant local rollout fallback.
  - Antigravity-first task prioritization (`零重力拉起 / CLI 派发` pinned above collapsible Codex Desktop sessions).
  - Live auto-refreshing conversation feed (4s when running / 12s when idle), newest-first ordering by default, scroll-position preservation, and clean Markdown rendering.
  - Non-destructive read-only diagnosis (`一键诊断卡点` / `只读提问`) via `codex exec fork --ephemeral -c sandbox_mode="read-only"`.
  - Message dispatch bar supporting `codex queue --resume`, `codex exec resume`, `dispatch.py resume`, and 60s duplicate-send protection.
  - One-click **`发回当前对话`** (`app.sendMessage`) and workspace file open (`com.google.antigravity/toggle-aux-pane`).
  - Cross-session Change ↔ Codex Thread SQLite binding ledger (`跨会话协作` tab + `manage_collab_binding` MCP tool).
- **Codex Auto Router (`plugins/codex-auto-router`)**: Brain ↔ Hand collaboration rules (`rules/AGENTS.md`) and fail-safe PreToolUse merge-gate hook (`hooks/allow_dispatch.py`).
- **Multi-Agent Dispatch (`skills/multi-agent-dispatch`)**: Zero-dependency Python 3.10+ isolated Git Worktree dispatcher with dynamic frontier model discovery and `--quality smart|max|balanced` routing.
- **Tooling & CI**: Portable `bin/run-server.sh` Node 22+ resolver, `scripts/install.sh`, `scripts/doctor.sh`, `scripts/package-release.sh`, `scripts/privacy-check.sh`, and macOS/Ubuntu GitHub Actions CI + Release workflows.
