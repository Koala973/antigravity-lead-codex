# Antigravity Lead Codex + ZCode 协同黑板 (`docs/BLACKBOARD.md`)

## 1. 目标与边界

1. **三层智能体协同架构（不计成本、只看最高效果）**：
   - **主控（Antigravity 哈基咪 · Gemini Ultra 5x）**：需求澄清（`/grill-me`）、架构拍板、前端视觉与交互打磨、50 行以内局部修改、浏览器/接口真实环境终审、分支合并与发布。
   - **双主力执行手（Codex GPT 20x + ZCode 国模旗舰池）**：
     - 核心后端架构、高难并发/状态机排障优先派 **Codex**（`gpt-6.2-astra` / `gpt-6.2-sol`）；
     - 100 万超长上下文全库扫街、中文复杂业务、飞书/办公插件任务、批量模块开发派 **ZCode**（阿里云百炼 + 腾讯 TokenHub 双渠道自动点将 + 跨渠道三级自动热备）；
   - **异构交叉初审 + 主控实测终审**：
     - 谁写的代码绝不用同一个模型自审：Codex 写的任务由 ZCode（`deepseek-v4-pro-0813` / `kimi-k3` 最高推理 `max`）做后台交叉静态审查；ZCode 写的任务由 Codex（`gpt-6.2-astra`）做后台交叉静态审查；涉及钱、权限、登录、对外发消息的核心文件采用双引擎叠加最高推理深审；
     - 后台审查通过后，由主控亲自核对差异并走完浏览器与真实接口终审。

2. **调度器升级（`skills/multi-agent-dispatch/scripts/dispatch.py`）**：
   - 激活 `--backend zcode` 为一等公民，支持 `run`、`batch`、`resume`、`review`（新增 `--backend auto` 在 `review` 时自动按原任务引擎切换异构引擎做交叉审查）。
   - 基于实测跑分实现 ZCode 双渠道（`qwen-alibaba-model-studio-cn` 阿里云百炼 + `e2a41300-b652-45ec-9f78-ebd2ec7889be` 腾讯 TokenHub）按难度/场景自动选模与失败热备切换：
     - `prefer_wide` / `>=10 files`：`腾讯TokenHub/glm-5.3 (max)` → `阿里云百炼/kimi-k3 (max)` → `阿里云百炼/deepseek-v4-pro-0813 (max)`
     - `hard` / `review` / 代码实现与排障：`阿里云百炼/kimi-k3 (max)` → `阿里云百炼/deepseek-v4-pro-0813 (max)` → `腾讯TokenHub/deepseek-v4-pro-0813 (max)` → `腾讯TokenHub/kimi-k3 (max)`
     - `medium` / `extreme` / 业务与方案推演：`阿里云百炼/kimi-k3 (max)` → `腾讯TokenHub/kimi-k3 (max)` → `阿里云百炼/qwen3.8-max (xhigh)`
     - `low` / 工具与轻量任务：`阿里云百炼/qwen3.8-max (xhigh)` → `腾讯TokenHub/deepseek-v4.1-flash (max)` → `阿里云百炼/kimi-k3 (max)`
   - 每次运行在 `run_dir/provider_config.json` 生成独立临时配置注入 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`，并发安全且不污染全局配置。
   - **ZCode 桌面端双向同步**：ZCode CLI 任务完成后自动将会话索引同步写入 `~/.zcode/v2/tasks-index.sqlite`（`tasks`、`task_group_admissions`、`task_group_view_node_orders`）与项目归属，使反重力派发的 ZCode 任务直接显示在 ZCode 桌面端左侧任务列表中。

3. **右侧栏可视化控制台升级（`plugins/codex-console`）**：
   - 显示名称统一更名为 **`Antigravity Lead Codex`**（顶部简写徽章 `Antig Lead Codex`）。
   - **双引擎全量聚合**：`CodexStore` 同时只读聚合 Codex（`~/.codex/*.sqlite`）与 ZCode（`~/.zcode/cli/db/db.sqlite` + `~/.zcode/v2/tasks-index.sqlite`）以及 `multi-agent-dispatch/state.json`。
   - 任务卡片与详情展示引擎徽章（`Codex` / `ZCode`）与具体模型名，支持顶部引擎筛选（`全部` / `Codex` / `ZCode`）；默认置顶反重力派发任务，同时在「桌面端历史」折叠区展示 Codex 与 ZCode 桌面端原有任务。
   - 支持对 ZCode 会话查看完整对话流、发起只读诊断/只读提问（`--resume <id> --mode plan`）、同步续跑（`--resume <id> --mode build`）以及新建受管子代理时直接选择引擎（`Codex` 或 `ZCode`）。

## 2. 验收清单

- [x] 完成本机双渠道 9 模型实测跑分与数据库结构核实
- [x] `dispatch.py` 支持 ZCode 智能选模、三级跨渠道热备、`resume`、`review`（含 `--backend auto` 异构交叉审查）与 ZCode 桌面端 `tasks-index.sqlite` 同步
- [x] `plugins/codex-console` 完成 `Antigravity Lead Codex` 更名与 Codex + ZCode 双引擎任务/详情/只读诊断/续跑/新建子代理聚合
- [x] 更新协同规则 `AGENTS.md` 与 `SKILL.md`，执行异构交叉代码审查并跑通全部自动化测试与 `doctor.sh`
