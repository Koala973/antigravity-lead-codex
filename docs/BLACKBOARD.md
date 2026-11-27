# Antigravity Lead Codex 协同黑板 (`docs/BLACKBOARD.md`)

## 1. 产品定位与本轮目标

专注 **Antigravity（Gemini 大脑）⇄ OpenAI Codex（执行之手）** 零配置开箱即用互通。本轮在已上线的极简清爽默认界面 / 可选紫光流光风格 / 像素紫猫基础上，统一落地「动态」页的**顶部悬浮最新进展卡**与**思考/工具调用可切换收拢展开展现**：

1. **动态页顶部悬浮进度卡（零额度本地提炼）**：
   - 固定悬浮在「动态」流最上方，视觉与 `minimal` / `glow` 两套风格及浅/深色主题完全统一。
   - **中文概览**：优先提炼线程最新中文阶段播报或完成摘要为一句清晰进度；当最新活动为英文思考、命令、工具调用、搜索或英文回复时，通过纯本地零延迟、零额度规则引擎映射为自然中文一句概览。
   - **真实多步骤进度表（仿反重力 1、2、3 步清单）**：严格按线程自身真实数据提取步骤（`plan` 计划项 / 显式勾选与编号清单 → 多条阶段播报 `phase: 'commentary'` 或多轮 `agentMessage` → 子代理活动 `subAgentActivity`）；无真实多步骤时保持紧凑单句概览，绝不捏造步骤。支持点击卡片头展开/收起步骤表（窄屏 `<= 640px` 默认折叠，宽屏自动展开，状态跨刷新保持）。
2. **思考与工具调用补全 + 双模式可选展示**：
   - 后端补全读取本地库里的 `mcpToolCall`（工具）与 `webSearch`（搜索），与现有 `reasoning`（思考）、`commandExecution`（命令）、`fileChange`（文件）统一归入过程流。
   - **两种模式可选**：
     - `grouped`（默认）：把两条正式回复之间连续的过程项按段合并成一条紧凑可点击胶囊（如 `▸ 过程记录 · 6 项（思考 2 · 命令 3 · 工具 1）`），在动态页点击胶囊原地展开看明细，点击单条看完整内容，且展开状态跨 4 秒自动刷新不重置。
     - `expanded`：像原有样式一样逐条直接平铺展开，依然可逐条点击。
   - **动态页快捷切换 + 设置页全局统一**：在动态页子导航栏右侧（`↓ 最新` 旁）提供一键切换按钮（`过程: 收拢` / `过程: 展开`），与设置页同步持久化到 `console.sqlite`。
3. **设置页极简统一**：
   - 沿用 `console.sqlite` 的 `ui_prefs` 表与 `console_ui_prefs` 工具，新增 2 项偏好：
     ```json
     {
       "uiStyle": "minimal",
       "catEnabled": true,
       "catLinkTaskStatus": false,
       "progressCardEnabled": true,
       "traceDisplayMode": "grouped"
     }
     ```
   - 设置页新增一张同规格「动态显示」卡片（顶部悬浮进度卡开关 + 思考与工具调用二选一），底部统一放置「恢复默认选项」按钮。

## 2. 服务端与数据契约

1. **`plugins/codex-console/server/console-db.mjs` & `index.mjs`**：
   - `DEFAULT_UI_PREFS` 扩展 `progressCardEnabled: true` 与 `traceDisplayMode: 'grouped'`（仅允许 `'grouped' | 'expanded'`）。
   - `console_ui_prefs` 的严格参数校验与 `resetUiPrefs()` 覆盖全部 5 项设置。
2. **`plugins/codex-console/server/progress-summary.mjs`（新增纯函数模块）**：
   - `buildThreadProgress({ task, items, subAgentItems })`：零依赖纯函数，输出：
     ```js
     {
       statusCode, statusLabel, statusTone,
       summary,          // 一句中文最新进展概览（<= 96 字）
       currentAction,    // 可选：运行中时的当前微动作中文提示
       steps,            // [{ index, title, status: 'done'|'in_progress'|'pending'|'failed' }]
       completedSteps,
       totalSteps,
       source,           // 'plan' | 'commentary' | 'subagents' | 'summary'
       updatedAtMs,
     }
     ```
   - 提供可单测的英文→中文动作/技术短语本地提炼函数，避免直接把整段生硬英文暴露在概览里。
3. **`plugins/codex-console/server/codex-store.mjs`**：
   - `getThreadDetail(threadId)` 增补查询 `mcpToolCall`、`webSearch` 纳入 `messages`（同时保留 `agentMessage` 的 `phase` 字段，过程项最近上限提升至 120 条，总条数上限 160 条），并读取该线程的 `plan` 与 `subAgentActivity` 构建并返回 `progress` 字段。
   - `dispatch` 合成任务同样返回合理的 `progress` 对象。

## 3. 前端改造契约（`plugins/codex-console/ui/`）

- `main.js` & `styles.css`：
  - `TRACE_LABELS` 补全 `mcpToolCall -> '工具'`、`webSearch -> '搜索'`。
  - 「动态」页顶部渲染可悬浮/停靠的 `.progress-card`（受 `uiPrefs.progressCardEnabled` 控制），含 2–4 字状态标签、一句中文概览、多步骤进度计数与迷你进度条，以及点击展开/收起的 `1、2、3` 步骤表；完整适配 `minimal` 与 `glow` 双风格及浅深色/窄屏。
  - 「动态」页子导航栏新增 `#btnToggleTraceMode`（与设置页双向同步）；`grouped` 模式下按连续段渲染 `<details class="trace-group">` 胶囊，跨刷新保留用户已展开的分组和明细行。
  - 「设置」页新增「动态显示」卡片并将「恢复默认选项」统一置于设置页底部。

## 4. 验收清单

- [x] Codex 完成 `console-db.mjs`、`progress-summary.mjs`、`codex-store.mjs`、`index.mjs`、`main.js`、`styles.css` 与 `tests/test-mcp-console.mjs` 改造并跑通全部测试
- [x] 主控（Gemini）执行异构审计、真实浏览器截图检查（极简/流光双风格、浅深色、窄侧栏 460px、多步骤展开/收起、过程胶囊收拢/展开、设置页统一性）并完成矫正
- [x] 更新配套技能与说明文档，构建 `dist/app.html`，通过 `privacy-check.sh`、`install.sh --no-build`、`doctor.sh`，提交并推送 `main`
