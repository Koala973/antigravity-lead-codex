---
name: codex-console
description: >-
  Use the Antigravity Lead Codex MCP server and side-pane UI to visualize,
  inspect, diagnose, queue/resume, and track cross-session Change-to-Thread
  bindings across local OpenAI Codex CLI/Desktop threads and
  multi-agent-dispatch Worktrees.
---

# Antigravity Lead Codex（侧栏可视化控制台）

`codex-console`（显示名称 **Antigravity Lead Codex**）专注 **Antigravity（Gemini 大脑）⇄ OpenAI Codex（执行之手）** 开箱即用互通，提供：
1. **Antigravity 侧栏 / 左侧全局页面 UI**（MCP App `open_codex_console`），实时只读聚合：
   - Codex 本地库：`~/.codex/{state_5,goals_1,queue_1,thread_history_1}.sqlite`
   - 调度台账：`~/.local/state/multi-agent-dispatch/state.json`
   在统一界面中置顶展示反重力派发的 Codex 任务，并在可折叠的「GPT」分组下查看和接手 Codex 桌面端原有任务；「设置」页仅提供极简外观风格（默认极简清爽 / 可选紫光流光卡片）与顶部像素小猫开关（默认纯互动模式 / 可选联动任务状态）。
2. **主控编排与 SQLite 跨会话协作工具**（Antigravity Brain 可直接调用）：
   - `open_codex_console`: 打开或刷新侧栏 `Antigravity Lead Codex` 面板（可传 `tab`、`threadId`、`query`）。
   - `list_codex_tasks`: 按项目、状态（`running`/`blocked`/`exec_done`）、`onlyExec` 检索本地 Codex 任务。
   - `get_codex_task_detail`: 读取指定 Codex 会话的最近对话流、Goal 状态、Git Worktree 变更与控制台历史诊断。
   - `ask_codex_readonly`: 走 `codex exec fork --ephemeral -c sandbox_mode="read-only"` 执行非侵入式只读提问或一键诊断卡点。
   - `send_codex_message`: 向目标 Codex 会话投递指令，支持排队唤醒、同步续跑、`dispatch.py resume` 与 60 秒防重投保护。
   - `spawn_codex_worker`: 调用 `multi-agent-dispatch` 在隔离 Git Worktree（或非 Git 目录 `inplace`）中新建 Codex 受管子代理。
   - `manage_collab_binding`: 读写 `${PLUGIN_DATA}/console.sqlite` 中的 `Change / BLACKBOARD 任务 ↔ Codex 会话 ID` 绑定表（`ownerRole` 支持 `codex` / `antigravity` / `shared`）。
   - `console_ui_prefs`: 读取、保存或重置极简外观与像素小猫偏好（`uiStyle`、`catEnabled`、`catLinkTaskStatus`）。
