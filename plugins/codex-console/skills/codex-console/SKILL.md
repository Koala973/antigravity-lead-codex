---
name: codex-console
description: >-
  Use the Antigravity Lead Codex MCP server and side-pane UI to visualize,
  inspect, diagnose, queue/resume, and track cross-session Change-to-Thread
  bindings across local Codex CLI/Desktop threads, ZCode national flagship
  sessions, and multi-agent-dispatch Worktrees.
---

# Antigravity Lead Codex（右侧栏双引擎可视化控制台）

`codex-console`（显示名称 **Antigravity Lead Codex**，徽章 `Antig Lead Codex`）插件提供：
1. **Antigravity 侧栏 / 左侧全局页面 UI**（MCP App `open_codex_console`），实时只读聚合：
   - Codex 库：`~/.codex/{state_5,goals_1,queue_1,thread_history_1}.sqlite`
   - ZCode 库：`~/.zcode/cli/db/db.sqlite` 与 `~/.zcode/v2/tasks-index.sqlite`
   - 调度台账：`~/.local/state/multi-agent-dispatch/state.json`
   在统一界面中展示反重力派发的 Codex 与 ZCode 任务，并在「桌面端历史」分组下支持查看和接手 Codex 桌面端与 ZCode 桌面端原有任务。
2. **主控编排与 SQLite 跨会话协作工具**（Antigravity Brain 可直接调用）：
   - `open_codex_console`: 打开或刷新侧栏 `Antigravity Lead Codex` 面板（可传 `tab`、`threadId`、`query`）。
   - `list_codex_tasks`: 按项目、引擎（`all`/`codex`/`zcode`）、状态（`running`/`blocked`/`exec_done`）、`onlyExec` 检索本地 Codex 与 ZCode 任务。
   - `get_codex_task_detail`: 读取指定 Codex 或 ZCode 会话的最近对话流、Goal 状态、Git Worktree 变更与控制台历史诊断。
   - `ask_codex_readonly`: 对 Codex 会话走 `codex exec fork --ephemeral -c sandbox_mode="read-only"`，对 ZCode 会话走 `zcode.cjs --resume <id> --mode plan` 执行非侵入式只读提问或一键诊断卡点。
   - `send_codex_message`: 向 Codex 或 ZCode 目标会话投递指令，支持排队唤醒、同步续跑、`dispatch.py resume` 与 60 秒防重投保护。
   - `spawn_codex_worker`: 调用 `multi-agent-dispatch` 在隔离 Git Worktree（或非 Git 目录 `inplace`）中新建 Codex 或 ZCode 受管子代理（可传 `backend: "codex" | "zcode"` 与 `model`）。
   - `manage_collab_binding`: 读写 `${PLUGIN_DATA}/console.sqlite` 中的 `Change / BLACKBOARD 任务 ↔ Codex/ZCode 会话 ID` 绑定表（`ownerRole` 支持 `codex` / `zcode` / `antigravity` / `shared`）。
