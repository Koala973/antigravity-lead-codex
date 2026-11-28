# Changelog

All notable changes to **antigravity-lead-codex** will be documented in this file.

## [2.0.0] - Unreleased

### Added / Changed (Wave 1: Engineering Hygiene, CI Activation & Single Version Source)
- **Active GitHub Actions CI & Release Workflows**: Moved CI and Release workflows out of `docs/workflows/` into `.github/workflows/ci.yml` and `.github/workflows/release.yml` with explicit least-privilege `permissions`, `concurrency` cancellation, `timeout-minutes`, Node (`22`, `24`) × Python (`3.10`, `3.12`) matrix across `ubuntu-latest` and `macos-latest`, `dist/app.html` build-sync gating (`git diff --exit-code`), and end-to-end temp `GEMINI_CONFIG_DIR` install + `doctor.sh` + MCP stdio (`initialize` / `tools/list` / `resources/read`) verification.
- **Release Pipeline & Honest Prebuilt UI Archive**: Updated `release.yml` and `scripts/package-release.sh` to run the full test suite before packaging, verify the unpacked release tarball via `install.sh --no-build` + `doctor.sh` + MCP stdio handshake before generating `SHA256SUMS.txt` and publishing, and clearly distinguish the prebuilt UI release archive (`npm ci --omit=dev` still fetches production dependencies) from an air-gapped offline bundle.
- **Single Version Source (`2.0.0`) & Automated Consistency Guard**: Unified version metadata across `plugins/codex-console/package.json`, `package-lock.json`, `plugin.json`, `server/index.mjs`, `server/quota.mjs`, `ui/main.js`, `dist/app.html`, `plugins/codex-auto-router/plugin.json`, `README.md`, `README_EN.md`, and `CHANGELOG.md`, enforced by `scripts/check-version.mjs` in CI and release packaging.
- **Open-Source Community Infrastructure**: Added `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/feature_request.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `CONTRIBUTING.md`, and `SECURITY.md`.
- **Honest Codex-Only Backend & Hardened Privacy/Secret Scanner**: Removed the misleading public `VALID_BACKENDS = ("codex", "auto")` CLI abstraction in `skills/multi-agent-dispatch/scripts/dispatch.py` while preserving internal backward compatibility; upgraded `scripts/privacy-check.sh` to use `mktemp` + `trap` cleanup and added portable secret/token leak detection (`sk-`, `ghp_`, `AIza`, `AKIA`, Slack tokens, PEM private keys).

## [1.0.2] - 2026-11-25

### Added / 新增
- **Explicit Dispatch Gates & 4 Confirmation Checkpoints / 显式派发硬门禁与四大确认点**：更新 `codex-auto-router/rules/AGENTS.md`，在用户显式指派 Codex 时强制限制 Antigravity 最多执行 ≤3 步轻量只读预检，禁止静默越俎代庖；补齐派发计划、联网/外部写操作、阻塞上报、分支合并与远端推送四道确认门禁。
- **Opt-In `--network` Sandbox Flag / 受控 `--network` 联网沙箱开关**：`dispatch.py`（`run` / `batch` / `resume`）与 `codex-console` `spawn_codex_worker` 支持按需启用 `sandbox_workspace_write.network_access=true`，解锁外网请求与本机鉴权 CLI，同时继续锁死工作目录外文件写入隔离（绝不降级至 `danger-full-access`）；`allow_dispatch.py` Hook 对 `--network` 强制返回 `force_ask`。
- **Capability Matrix & Hand Extension Guide / 适配场景与扩展手册**：新增 [docs/CAPABILITIES.md](docs/CAPABILITIES.md)，给出三层适配场景矩阵及 `codex mcp add`（如无头 `chrome-devtools-mcp` / Playwright MCP）、`codex plugin add`、`~/.codex/skills/` 实测扩展配方，并补齐单元测试（5/5 通过）。

## [1.0.1] - 2026-11-25

### Improved / 优化
- **Pixel Purple Cat In-Place Meow / 像素紫猫原地停步喵叫**：点击右上角像素紫猫时改为捕获当前实时跑道坐标与朝向原地停步跳跃并冒出 `喵~`，消除回到默认位置的生硬瞬移。
- **Unified Dual-Pane Showcase / 双图实机展示升级**：README 升级为双 2× Retina 零马赛克展示图（`任务` 全景视图 + `子代理` 统一双栏审计视图）。

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
