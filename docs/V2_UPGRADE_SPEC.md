# Antigravity-Lead-Codex v2.0 完整升级与重构执行指令

## 0. 角色、核心定位与不可违背的产品原则

你正在将 `Koala973/antigravity-lead-codex` 从 v1.x 升级为 **v2.0.0**。

### 产品定位（必须贯彻到每一行代码、文案与文档）
1. **不做 T3 Code 同质化复制品**：本插件服务的用户留在 **Google Antigravity** 中使用（保留 Antigravity 作为 Brain 与原生 Mac/浏览器 Computer Use 能力），不试图兼容十几个第三方 Agent，只把 **`Antigravity ⇄ OpenAI Codex CLI`** 这一条链路打磨到极致。
2. **双层产品结构（单飞核心 + 可选增强）**：
   - **第一层（Core，默认推荐、独立完整）**：`plugins/codex-console` —— **"The Missing Visual Console for `codex exec` & Codex Worktrees"**。任何人都可以只安装它（`--console-only` 为一等公民安装路径），零外部路由依赖即可获得：Codex 任务/子代理实时流、额度环形仪、内联 Diff 审查、进程中止/超时控制、只读诊断、像素互动紫猫与一键发回对话。
   - **第二层（Optional Add-ons，按需增强）**：`skills/multi-agent-dispatch`（隔离 Git Worktree 调度）+ `plugins/codex-auto-router`（Brain-Hand 协作门禁与规则）+ **Computer Use 反向验收闭环（CU Bridge）**。
3. **拆掉受众天花板（English-First + 全平台 + 低门槛）**：
   - 整个产品（UI、服务端错误、提示词模板、进度摘要、GitHub 首页）**默认英文（`en`）**，中文（`zh-CN`）作为一等内置 Locale，在设置页提供语言切换并持久化。
   - **彻底移除对 `bash` 与 POSIX `fcntl` 的硬依赖**，让 Windows / macOS / Linux 原生可用，并尽量消除 Node 22.5–22.12 的 `node:sqlite` 版本踩坑。

### 执行纪律（严格按 Wave 推进）
- 仓库内共有 4 个 Wave（Wave 1 ~ Wave 4）。**严禁跨 Wave 混改**。每完成一个 Wave，必须跑通该 Wave 的全部自动化校验、构建与测试，并确认无遗留回归后再进入下一个 Wave。
- 涉及现有 `plugins/codex-console/dist/app.html` 等构建产物时，源码修改后必须重新构建，确保源码与构建产物完全同步。
- 禁止编造测试结果或跳过边界检查；所有声明的功能（如 CI、离线安装、Hook 门禁）必须与代码实效 100% 一致。

---

## Wave 1：工程可信度止血、CI 激活与版本统一（P0）

**目标**：消除开源仓库的“信任负资产”，让 CI 真正跑起来，版本号单一事实来源，清理文档与代码的虚假/冲突声明。

### 具体改造要求
1. **激活 GitHub Actions CI & Release**：
   - 将 `docs/workflows/ci.yml` 与 `docs/workflows/release.yml` 正式迁移到 `.github/workflows/ci.yml` 与 `.github/workflows/release.yml`（`docs/workflows/` 中不再保留伪装成 CI 的 YAML，可删或改为说明链接）。
   - 在 `.github/workflows/ci.yml` 中增加：
     - 顶层 `permissions: contents: read`、`concurrency` 取消旧运行、`timeout-minutes`。
     - **构建产物一致性门禁**：运行 `npm run build:ui` 后执行 `git diff --exit-code plugins/codex-console/dist/`，防止源码与 `dist/app.html` 脱节。
     - **真实安装与握手测试**：在临时 `GEMINI_CONFIG_DIR` 目录运行安装脚本与 `doctor`，执行真实 MCP stdio `initialize` + `tools/list` + `resources/read` 握手。
     - **Python 与 Node 版本矩阵**：至少覆盖 `ubuntu-latest`、`macos-latest`（Wave 2 后补入 `windows-latest`）。
   - 修复 `.github/workflows/release.yml` 与 `scripts/package-release.sh`：
     - 打包时包含测试验证所需脚本或拆分为“先跑全部测试 → 再打包 → 在干净临时目录解压 Release tarball 执行 `--no-build` 安装与握手测试 → 生成 `SHA256SUMS.txt` → 发布 GitHub Release”。
     - 解决 `--no-build` 的“假离线”问题：若发布包定位为离线包，需明确处理或内置 prod 依赖说明，或清晰区分“预构建 UI 包”与“完全离线包”，不再误导用户。
2. **建立单一版本源（统一升级到 `2.0.0`）**：
   - 同步以下全部位置的版本号为 `2.0.0`：
     - `plugins/codex-console/plugin.json`
     - `plugins/codex-console/package.json`
     - `plugins/codex-console/package-lock.json`
     - `plugins/codex-console/server/index.mjs`（`McpServer` version）
     - `plugins/codex-console/ui/main.js`（`App` version）
     - `plugins/codex-auto-router/plugin.json`
     - `README.md` / `README_EN.md`（或调整后的英文主 README）徽章与 `CHANGELOG.md`
   - 在 `scripts/package-release.sh` 与 CI 中增加版本号一致性校验脚本，任何一处不一致直接 fail。
3. **补齐开源社区基础设施**：
   - 新增 `.github/ISSUE_TEMPLATE/bug_report.yml`、`.github/ISSUE_TEMPLATE/feature_request.yml`、`.github/PULL_REQUEST_TEMPLATE.md`、`CONTRIBUTING.md`、`SECURITY.md`。
4. **诚实清理伪抽象**：
   - 在 `skills/multi-agent-dispatch/scripts/dispatch.py` 中移除或诚实标注仅支持 `codex`（如仅保留内部向后兼容校验，不在 CLI/文档中用 `VALID_BACKENDS = ("codex", "auto")` 暗示支持其他 CLI）。
   - 修复 `scripts/privacy-check.sh`：避免写入共享路径 `/tmp/alc_privacy_hit.txt`（改用 `mktemp` + `trap` 清理），并增加对常见 Secret/Token 正则（如 `sk-`、`ghp_`、`AIza`）的防泄漏扫描。

### Wave 1 验收标准
- 本地与 CI 脚本检查全部通过；版本号全仓唯一且一致；`dist/app.html` 校验通过；`.github/` 模板与工作流就位。

---

## Wave 2：安全加固、进程可控性、状态一致性与全平台改造（P0–P1）

**目标**：彻底修补安全旁路与凭据泄露风险，解决后台孤儿进程/假死/截断误判问题，并打通原生 Windows 与 Node 版本兼容。

### 2.1 修复安全漏洞与门禁冲突
1. **统一规则并真正启用门禁**：
   - 解决 `plugins/codex-auto-router/rules/AGENTS.md`（写着“不用等确认自动推进”）与 `docs/CAPABILITIES.md`（写着四大必停确认门禁）之间的直接冲突，明确以统一策略为准。
   - 检查 `plugins/codex-auto-router/hooks.json`：不再默认 `"enabled": false` 却在 README 宣称已保护用户；若启用 Hook，将 `command` 改为跨平台安全路径（不依赖不确定 CWD 的 `./hooks/allow_dispatch.py`），并确保 `allow_dispatch.py` 的文档注释与 `DEFER_TO_STANDARD_APPROVAL` 返回值语义一致、经过真实 Hook 契约测试。
2. **堵住执行端的所有 `--network` 与写操作旁路**：
   - 不能只靠拦截 `run_command` 命令行字符串！必须在 `dispatch.py` 的 `run`、`batch`（逐条校验 manifest 中的 `"network": true`）、`resume`（禁止静默继承 `original["network"]` 绕过确认）以及 `plugins/codex-console/server/index.mjs` 的 `spawn_codex_worker` / `send_codex_message` 入口处建立**服务端/执行端策略校验**：
     - 非明确批准的网络任务禁止启动（例如要求显式 `--network-approved` / UI 二次确认或作用域开关，且禁止在未批准时静默继承）。
     - 非 Git 目录或无 HEAD 时，`--isolation auto` **禁止静默回退为 `inplace` 直接改原目录**——必须显式要求用户传入 `--isolation inplace`，否则安全失败报错。
   - 取消 `-c approval_policy="never"` 作为不可切换的硬编码默认值：支持传入可控审批策略（如 `on-request` / `on-failure` / `never`），并在单机调度记录中留痕。
3. **凭据与环境变量最小化隔离**：
   - 重写 `plugins/codex-console/server/runner.mjs` 的 `buildExecEnv()` 与 `dispatch.py` 的 `run_subprocess_with_timeout()`：改为**环境变量白名单**（仅保留 `PATH`、`HOME`/`USERPROFILE`、`CODEX_HOME`、`LANG`/`LC_ALL`、`TERM`、`TMPDIR`/`TEMP`、`SystemRoot` 等运行必需变量及显式授权变量），**剥离 `ANTIGRAVITY_*`、`OPENAI_API_KEY`、`GH_TOKEN`、云厂商密钥等无关宿主环境**。
   - `runs/` 目录与临时输出文件设置仅当前用户可读权限（POSIX `0o700`/`0o600`）。
   - 修复 `scripts/install.sh` 中将 `ANTIGRAVITY_CSRF_TOKEN` 明文暴露在 `curl -H` 命令行参数列表（`ps` 可见）的问题（改用 `curl -K -` 通过 stdin 传入 header）。
   - 对 `CODEX_BIN` / `PYTHON_BIN` / `AGY_DISPATCH_SCRIPT` 的环境变量覆盖增加安全边界校验（校验存在性与规范路径），并在 `console_ops` / 错误中脱敏敏感字段。

### 2.2 修复后台进程可控性与状态一致性
1. **进程组管理、停止取消与超时闭环（`plugins/codex-console/server/runner.mjs` & `index.mjs`）**：
   - `startProcess` 必须返回并登记 `child` 到内存 `Map<opId, { child, pgid, timeoutHandle }>`。
   - 使用独立进程组启动子进程（POSIX `detached: true` + `process.kill(-pid, 'SIGTERM')` 超时后 `SIGKILL`；Windows 使用进程树终止），确保连同孙进程一起杀净。
   - **新增 MCP 工具 `console_stop_op`（`model` + `app` 可见）并在 UI 中提供“停止运行”按钮**。
   - 为 `exec_resume`、`spawn_worker`、`dispatch_resume` 全部设置默认安全超时（不再 `timeout = 0` 永不超时），同时增加并发准入信号量（默认并发上限如 `4`，防止连点烧光额度）。
   - `server/index.mjs` 注册 `SIGINT`/`SIGTERM`/`exit` 优雅关闭，清理所有托管子进程；`console-db.mjs` 启动恢复时记录清晰的重启中断原因，避免数据库状态与孤儿写进程冲突。
2. **修复 250KB stdout 截断误判 `blocked` 的严重 Bug**：
   - `spawnWorker` 回调禁止只依赖内存中 250KB 上限的 `stdout` 去 `JSON.parse`：优先从 `dispatch.py` 落盘的 `result.json`（先定位对应 `run_dir/result.json` 或在 `dispatch.py` 支持 `--result-file` / `--compact-json`）读取完整结构化报告；若确实解析失败，显式记录解析错误并将绑定状态标为 `unknown`/`parse_error`，**绝不能把已成功的任务误标为 `blocked`**。
3. **修复 `dispatch.py` “先执行后记账”与进程树清理**：
   - **先落账再执行**：在创建 Worktree / `run_dir` 后、启动 `codex exec` 前，立刻把 `status: "running"` 的记录写入 `state.json`（哪怕运行到一半崩溃，也能被控制台看见并支持 `cleanup` 回收）。异常退出未创建会话时提供安全回滚或标记为可清理。
   - `run_subprocess_with_timeout` 改用 `subprocess.Popen` + `start_new_session=True`（Windows 使用 `CREATE_NEW_PROCESS_GROUP` + `taskkill /T /F`），超时杀干净整个进程树。
   - 为所有 `git` 子命令（`inspect_git`、`collect_git_truth`、`create_worktree`、`remove_worktree`）加上 `timeout`（如 `15–30s`）。
   - `cmd_cleanup` 若删除分支失败，状态设为 `partial_cleaned` 而非谎报 `cleaned`。
   - `parse_report_file` 缺失有效结构化报告时，不再仅因 `exit_code == 0` 就设为 `verification_passed = True`（应设为 `False` 或 `null` 并写明缺失结构化报告）。
   - `cmd_resume` 无论是否命中 `task_record`，只要有新 `session_id` 就确保状态表同步更新，避免多轮后 session 漂移。
   - 为 `state.json`、`runs/` 与 `console_ops` 增加可配置的保留/归档清理策略（防止无限膨胀）。
4. **解决直读 SQLite 脆弱性与全量轮询 I/O 阻塞（`codex-store.mjs` & `quota.mjs`）**：
   - `getHealth()` 与 `getSnapshot()` 增加 **Codex SQLite Schema 版本/关键表列兼容探测**：若 `state_5.sqlite` 缺失关键列或查询异常，不再静默吞掉并返回“0 个任务”，而是返回显式 `schemaWarning` / `dbError` 并在 UI 顶部给出清晰可排障提示。
   - 修复时间排序混用与抖动：SQL 查询统一使用 `COALESCE(updated_at_ms, updated_at * 1000)` 排序，消灭 `Date.now()` 兜底导致的列表随机跳顶。
   - 性能优化：
     - `thread_goals` 与 `thread_spawn_edges` 按已加载的 `threadIds` 过滤查询，消灭全表扫描；
     - 为 `engine-config.mjs` 的 `models_cache.json` 解析与 `quota.mjs` 的 `sessions` 目录扫描加 `mtime`/TTL 缓存；
     - `getThreadDetail(threadId)` 改为单线程直查，不再为看一个详情重跑 `limit=200` 全量快照；
     - `console-db.mjs` 的 `listBindings` 用 `JOIN` 或批量查询消灭 N+1，`deleteBinding` 包进事务。

### 2.3 拆掉平台与 Node 版本门槛（原生支持 Windows + 宽容 Node LTS）
1. **消除 `bash` 启动依赖**：
   - `plugins/codex-console/mcp_config.json` 改为跨平台启动方式，例如：
     - 用跨平台 Node 入口或内置轻探测脚本启动 `server/index.mjs`（如优先调用系统 `node` 运行一个零依赖 `bin/boot.mjs` 来探测合适 Node 版本并拉起 `server/index.mjs`；对 macOS/Linux 若需探测 nvm/fnm/Homebrew，由跨平台 `boot.mjs` / `boot.sh` / `boot.cmd` 统一兜底，确保 Windows 原生不依赖 `bash.exe`）。
   - 修复 Node `>= 22.5` 声明陷阱：实际验证 `node:sqlite` 在 Node `22.5–22.12` 需要 `--experimental-sqlite` 标志（22.13+ 才免标志）。在启动器中智能判断：若当前 Node `>= 22.5 && < 22.13` 自动追加 `--experimental-sqlite`；或优先评估平滑兼容方案（例如当环境仅装有 Node 20 LTS 时给出明确指引，或使用轻量跨版本 SQLite 适配层），保证文档声明的版本下限 100% 实测可用。
2. **`dispatch.py` 与 `allow_dispatch.py` 原生跨平台**：
   - 移除 `dispatch.py` 顶层无条件 `import fcntl`：改为按 `os.name == "nt"` 分支使用 `msvcrt.locking` 或跨平台原子锁文件。
   - 所有 `subprocess.run(..., text=True)` 显式传递 `encoding="utf-8", errors="replace"`，防止中文 Windows `cp936/gbk` 解码崩溃。
   - 可执行文件探测兼容 Windows `PATHEXT`（`.exe` / `.cmd` / `.bat`）与 `%LOCALAPPDATA%` / `%APPDATA%`，`allow_dispatch.py` 的 `shlex.split(..., posix=(os.name != "nt"))` 与环境变量/路径匹配兼容 Windows 反斜杠与大小写不敏感路径。
   - 提供 `scripts/install.ps1` 与 `scripts/doctor.ps1`（或统一用 Node 编写跨平台安装与体检脚本，仅用极薄 shell/ps1 包装），并在 `.github/workflows/ci.yml` 增加 `windows-latest` 测试矩阵。

### Wave 2 验收标准
- 新增真实子进程超时、中断取消（`console_stop_op`）、250KB+ 超长 stdout 回退读 `result.json`、Schema 缺失显式报错、Hook 旁路拦截、跨平台锁与 Windows 路径测试，全绿通过。
- CI 在 Ubuntu、macOS、Windows 三平台全部跑通。

---

## Wave 3：全量英文默认 + 中英双语 Locale + 交互/Diff/Computer Use 护城河升级（P1–P2）

**目标**：让全球英文开发者打开即用、体验对标顶级开发者工具；并把“Antigravity 宿主 + Codex 执行”的独有优势做成 T3 Code 无法替代的闭环护城河。

### 3.1 全面国际化（English Default + `en` / `zh-CN` Locale 切换）
1. **建立共享 i18n 机制**：
   - 新增轻量零外部依赖词典模块（如 `plugins/codex-console/shared/i18n.mjs`），以 **英文（`en`）作为唯一源字符串与默认值**，中文（`zh-CN`）作为内置切换语言。
   - 在 `console_ui_prefs` 与 `console.sqlite` `ui_prefs` 中新增 `locale: 'en' | 'zh-CN'`（默认 `'en'`），在设置页顶部或界面外观卡片中提供清晰的中/英切换开关。
2. **清理全部硬编码中文**：
   - `plugins/codex-console/ui/app.html`：`lang="en"`，启动文案 `"Connecting…"`。
   - `plugins/codex-console/ui/main.js`（当前 183 行含中文）、`ui/cat-pet.js`（小猫气泡 `Meow~` / `喵~` 随 locale 切换）、`server/*.mjs`（当前 215 行含中文）：全部接入 i18n。
   - 服务端对错误与状态返回结构化 code/英文默认文案，UI 按当前 `locale` 展示（含日期/相对时间、配额弹窗、设置项、诊断按钮与预设 Prompt 模板）。
   - `plugins/codex-auto-router/rules/AGENTS.md` 与 `skills/*/SKILL.md`：全部改写为清晰、通用的 **英文主版**（符合 Antigravity 全局生态），同时保留可参考的中文说明文档。
3. **重构 `server/progress-summary.mjs`**：
   - 将单向“英译中”重构为 **Locale-Aware Progress Summarizer**：
     - 当 `locale === 'en'`（默认）：本地零成本提炼紧凑、高信息密度的英文进展一句概览与 `1, 2, 3` 真实步骤表（保留文件名、测试数、构建结果等事实提取）；
     - 当 `locale === 'zh-CN'`：自动启用现有的中文语义映射规则引擎，输出自然中文概览。
4. **CI 增加 i18n 守卫**：
   - 增加自动化测试：扫描 `ui/`、`server/*.mjs`（词典目录与中文规则分支除外），阻止后续开发再次混入未托管的硬编码中文。

### 3.2 把 `codex-console` 做到“为它而装”的极致体验
1. **补齐关键日常工作流能力**：
   - **内联 Diff 审阅**：扩展 `console_git_inspect` 返回按文件可控截取的 `git diff -U3` 补丁，在「变更 (Changes)」页签内支持**原地展开语法着色/增删行高亮 Diff**（保持 Zero-CDN CSP 安全），支持勾选问题文件/片段一键 **`Send Review to Chat`**。
   - **子代理交互可控性增强**：在任务头与「子代理」页签提供 **Stop 中止**、**Clean Worktree（含未合并分支安全确认）**、以及 **One-Click Code Review（调用 `dispatch.py review` 只读交叉审查）**。
   - **实时流式日志预览（不依赖盲等刷新）**：对于正在运行中的受管任务，后台直接增量读取其 `run_dir/events.jsonl` 最新增量事件展示在动态流中（同时预留连接 `codex app-server` 进行实时事件订阅与 `turn/steer` / `turn/interrupt` 交互的适配器边界），显著降低用户等待焦虑。
   - **导出诊断包（Diagnostics Bundle）**：设置页增加一键导出脱敏诊断信息（系统/Node/Codex 版本、Schema 兼容状态、最近失败 `console_ops`、脱敏配置快照），方便 GitHub Issue 排障。
2. **UI 性能与工程优化**：
   - 优化 `ui/main.js` 局部渲染或状态切换（避免无变化轮询抖动、保持输入焦点与滚动锚点零闪跳），并用 **JSDOM 或 Playwright** 为前端补齐真实 DOM 测试（包含滚动锚点、分组折叠、语言切换、Stop/Diff 交互）。

### 3.3 打造不可替代护城河：Computer Use 反向验收闭环（`CU Bridge`）
将用户在 Antigravity Mac 端的原生桌面 / 已登录浏览器 Computer Use 能力，与 Codex CLI 编码形成真正工程化的闭环：
1. **新增 CU 桥接数据表（`console.sqlite`）**：
   - `cu_requests`（id, thread_id, task_id, change_key, head_sha, target_type, base_url, steps_json, assertions_json, status: `pending|claimed|running|waiting_user|passed|failed|expired|cancelled`, lease_owner, lease_expires_at, attempt_count, idempotency_key）
   - `cu_evidence`（id, request_id, head_sha, kind: `screenshot|ax_tree|dom|console_log`, file_path, sha256, summary, created_at）
2. **权限分离的 MCP 工具契约**：
   - 暴露给 **Codex Worker / 调度器** 的只读与请求工具：`cu_request_verify`（提交带 `head_sha` 与断言步骤的验收请求）、`cu_get_status`、`cu_cancel_request`。
   - 暴露给 **Antigravity 主控** 的执行工具：`cu_claim_pending`、`cu_submit_evidence`（绑定 `head_sha`，防止旧截图验收新代码）。
3. **自动返修循环与安全边界**：
   - Codex 改完代码并过单测后发起 `cu_request_verify`（支持长等待或退出为 `blocked_waiting_cu`）；
   - Antigravity 在侧栏或对话中收到提醒，用原生 Mac Computer Use / 已登录浏览器完成真实界面联调与验收；
   - 若失败，将失败步骤、截图路径/摘要与控制台报错自动打包，通过 `dispatch.py resume` 或 `send_codex_message` 回传给 Codex 在同一 Worktree 定向修复（最多 2 轮防死循环）；
   - 遇到登录、2FA、付款或外部不可逆操作时进入 `waiting_user` 人工接管，敏感输入期间暂停截图落盘。

### Wave 3 验收标准
- 默认英文界面零中文泄漏且中英热切换生效；内联 Diff、Stop 中止、诊断包导出实测可用；前端 DOM 测试与 `quota.mjs` app-server replay 测试通过；`CU Bridge` 工具契约与返修状态机通过集成测试。

---

## Wave 4：v2.0 高 Star 传播重塑与生态发布（GTM）

**目标**：让任何陌生全球开发者在 **30 秒内看懂价值、60 秒内跑通安装、1 分钟内感受到惊喜**。

### 具体改造要求
1. **重构 GitHub 首页 `README.md`（English-First）与 `README_ZH.md`**：
   - 顶部保留清晰语言切换：`English | 简体中文`，去掉过载的长清单，直接用一句话讲清核心价值：
     > **"The missing visual console & Computer-Use bridge for OpenAI Codex CLI inside Google Antigravity."**
     > *"Stop hunting `codex exec` logs across hidden worktrees. See every thread, live quota, inline diff, and one-click diagnosis right in your side pane."*
   - **英雄区叙事视觉**：
     - 补充 **Before vs After 对比图**（左：Codex Desktop 失明 + 5 个混乱终端；右：一个清爽的侧栏控制台全部聚合）；
     - 补充 **20–40 秒动态演示 GIF**（真实录屏或脚本化生成：侧栏实时流 → 额度环悬停 → 内联 Diff → 一键诊断/停止 → 像素紫猫互动 → 发回对话）。
   - **安装路径极致简化**：
     - 首推 **`codex-console` 核心安装（最零门槛）**：macOS/Linux 单行命令 + Windows PowerShell `irm ... | iex` 单行命令，附带“先审阅脚本再执行”提示；
     - 将 `multi-agent-dispatch` + `codex-auto-router` + `CU Bridge` 作为清晰的 **Optional Power-User Add-ons** 分节介绍。
2. **更新文档体系与 `CHANGELOG.md`**：
   - 更新 `docs/ARCHITECTURE.md`、`docs/CAPABILITIES.md`、`docs/DOCTOR.md`、`CHANGELOG.md` 同步反映 v2.0 全部架构（跨平台启动、安全策略下沉、i18n、Inline Diff、CU Bridge、真实 CI 状态）。
   - 全仓运行 `privacy-check.sh`、全套 Node/Python/UI 测试、`build:ui`、`doctor`、`package-release.sh` 并发布 `v2.0.0` Tag。

### Wave 4 验收标准
- 英文 `README.md` 与中文 `README_ZH.md` 信息准确无过期承诺；全仓所有测试、构建、隐私扫描、跨平台 CI 全绿；Release 包在干净环境验证通过。
