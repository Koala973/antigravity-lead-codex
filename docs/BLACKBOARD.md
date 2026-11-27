# Antigravity Lead Codex 协同黑板 (`docs/BLACKBOARD.md`)

## 1. 产品定位与本轮目标

专注做好 **Antigravity（Gemini 大脑）⇄ OpenAI Codex（精准执行之手）** 互通，做到**开箱即用、零配置门槛、默认即最佳效果**：
1. **彻底去除 ZCode 及复杂多引擎池设置**：用户安装登录好 Antigravity 与 Codex 后默认即最佳旗舰路由，不再要求配置任何模型、路由或外部引擎。
2. **主界面默认回调至极简清爽风格（`b6c3644` 视觉基因）**：顶栏无边框下划线导航（任务 / 子代理 / 协作 / 设置）、微紫灰左栏两行摘要列表、纯白通透详情流（单行紫标思考/命令、`↓ 最新` 倒序切换、干净回复卡与柔紫底部发送框）。
3. **所有个性化改动均作为极简用户可选项**（仅保留在「设置」页）：
   - **界面风格**：`minimal`（极简清爽 · 默认）vs `glow`（紫光流光卡片 · 可选）
   - **顶部像素小猫**：`catEnabled`（默认开启，可关闭隐藏）与 `catLinkTaskStatus`（默认关闭纯互动模式，可开启联动任务运行/阻塞/休眠状态）
4. **1:1 重绘顶部像素紫猫并升级互动体验**：
   - 按用户像素图重绘（尖斜猫耳、方正纯紫猫身、大竖长墨黑眼、右侧翘尾、四条干净小短腿与浅灰脚影，彻底告别“螃蟹感”）。
   - 互动逻辑：常态左右来回跑 → 单击原地停住向上弹跳（`喵~`）→ 连续点击依次触发开心笑眼爱心、微怒颤动、生气炸毛左右高频颤动，停点后自动恢复跑动。

## 2. 服务端与持久化契约

1. **`plugins/codex-console/server/console-db.mjs`**：
   - 新增 `ui_prefs` 表（单行键值或固定 `id='default'`）持久化 3 项极简偏好：
     ```json
     {
       "uiStyle": "minimal",
       "catEnabled": true,
       "catLinkTaskStatus": false
     }
     ```
   - 提供 `getUiPrefs()`、`setUiPrefs(patch)`、`resetUiPrefs()`。
2. **`plugins/codex-console/server/codex-store.mjs` & `runner.mjs` & `index.mjs`**：
   - 纯聚焦本地 Codex 数据库（`state_5` / `goals_1` / `queue_1` / `thread_history_1`）与 `multi-agent-dispatch/state.json`，移除 ZCode 数据库读取、ZCode 渠道解析与多引擎注册表复杂逻辑。
   - `engine-config.mjs` 精简为纯只读的本机 Codex 环境与模型探测（`getCodexEnvironmentSnapshot()`），不再维护多引擎 `engine_config.json`。
   - `console_snapshot` 返回 `{ ...snap, quota, runtime, uiPrefs, codexEnv }`。
   - 新增/精简 MCP 工具 `console_ui_prefs`（`action: 'get' | 'save' | 'reset'`, `prefs: { uiStyle, catEnabled, catLinkTaskStatus }`），移除旧版 `console_engine_settings`。
3. **`skills/multi-agent-dispatch/scripts/dispatch.py`**：
   - 精简聚焦 Codex 旗舰调度（`health` / `run` / `batch` / `resume` / `review` / `status` / `cleanup`），开箱自动发现 `models_cache.json` 最新官方旗舰与宽窗口模型（`gpt-6.2-astra` / `gpt-6.2-sol`），按质量/难度智能选模，支持 `--network` 与隔离 Git Worktree；`review` 默认使用 Codex 只读模式（自动错开作者模型并忽略 `dist/` 打包产物）。移除 ZCode 专属代码与 `engine_config.json` 依赖。

## 3. 前端改造契约（`plugins/codex-console/ui/`）

- `cat-pet.js`：16×13 像素网格 1:1 复刻用户参考图（尖耳、方身、竖眼、翘尾、四短腿+底影），支持 `strolling` / `working` / `blocked` / `sleeping` / `hop` / `happy` / `shake` / `angry` 状态渲染。
- `main.js` & `styles.css`：
  - 默认 `data-ui-style="minimal"` 精准还原 `b6c3644` 极简清爽风（保留顶栏无边框下划线导航含「设置」页签、左侧搜索+分组+两行摘要、右侧单行紫标思考/命令+`↓ 最新`+极简回复卡+柔和紫晕发送卡）；
  - 可选 `data-ui-style="glow"` 通过 CSS 变量与伪元素叠加 V1 左上粗紫向右上极细收尖流光边框与柔和底部紫雾；
  - 极简「设置」页仅保留：只读环境状态卡 + 界面风格二选一 + 像素小猫双开关（显示小猫 / 联动任务状态）；
  - 极简 Spawn Modal 聚焦 Codex，置顶任务指令与工作目录，折叠可选参数（质量/难度/隔离/Task ID/Change 标识）。

## 4. 验收清单

- [x] Codex 完成后端、调度器、`cat-pet.js`、`main.js`、`styles.css` 与测试改造，并跑通全部单测与集成测试
- [x] 主控（Gemini）执行异构差异审计、真实浏览器截图检查（对比附图极简风、流光风、新像素猫静态与点击互动、深浅色与窄侧栏）并完成矫正
- [x] 构建 `dist/app.html`，通过 `privacy-check.sh`、`install.sh --no-build`、`doctor.sh`，提交并推送 `main`
