# Antigravity Lead Codex 协同黑板 (`docs/BLACKBOARD.md`)

## 1. 重构目标：平权引擎池 + 工作流角色分配

将原“Codex 必选写死 + ZCode 独占路由表”架构重构为：
1. **通用平权引擎池（Unified Engine Registry）**：内置 `codex`、`zcode`、`claude`、`gemini`，支持用户新增/删除自定义 CLI 引擎；所有引擎共享同一套 Schema，系统仅要求**至少启用 1 个引擎**即可运行。
2. **基于工作流的角色分配（Workflow-First Role Routing）**：
   - **P0 主流程**：`primaryBuilder`（主力施工引擎）与 `reviewer`（代码审查引擎，支持 `auto_heterogeneous` 自动异构互审或 `explicit` 指定任意已启用引擎）。
   - **P1 可选专项场景分流（4 项，默认关闭并跟随主力施工引擎）**：
     - `wide_context`：超长上下文全库扫街（10+ 文件摸底）
     - `architecture_concurrency`：核心架构重构与并发状态机排障
     - `chinese_business_security`：中文复杂业务逻辑与安全测试分析
     - `unit_tests_and_tools`：批量单元测试补齐与插件/脚本工具调用

## 2. 本次协同分工

- **主控（Antigravity Gemini）**：定稿 Schema 与接口契约、重构前端 `plugins/codex-console/ui/{main.js,styles.css}`、构建 `dist/app.html`、浏览器深浅色/宽窄屏实测终审、同步全局配置并发布推送。
- **后端施工（Codex CLI · 隔离 Worktree）**：升级 `plugins/codex-console/server/{engine-config.mjs,codex-store.mjs,runner.mjs,index.mjs}`、`skills/multi-agent-dispatch/scripts/dispatch.py` 及对应测试 `tests/test_dispatch.py`、`tests/test-mcp-console.mjs`。
- **异构交叉审计（ZCode CLI · `max` 推理）**：对 Codex 工作树改动及整体交付执行只读代码审查，拦截严重缺陷。

## 3. `engine_config.json` v2 数据契约

路径：`~/.local/state/multi-agent-dispatch/engine_config.json`（环境变量 `AGY_ENGINE_CONFIG_FILE` 可覆盖）。

```json
{
  "version": 2,
  "updatedAtMs": 1732671000000,
  "engines": [
    {
      "id": "codex",
      "name": "OpenAI Codex",
      "builtin": true,
      "kind": "codex",
      "enabled": true,
      "binPath": "",
      "configFilePath": "~/.codex/models_cache.json",
      "models": {
        "primaryModel": "auto",
        "fallbackModel": "",
        "defaultEffort": "xhigh"
      },
      "adapter": {
        "execTemplate": "codex exec -C {cwd} -m {model} -c model_reasoning_effort=\"{effort}\" -s {sandbox} --json -",
        "readonlyTemplate": "codex exec review -m {model} -c model_reasoning_effort=\"{effort}\" -c sandbox_mode=\"read-only\" --json",
        "resumeTemplate": "codex exec resume -m {model} -c model_reasoning_effort=\"{effort}\" {session_id} -",
        "syncDesktopIndex": false
      }
    },
    {
      "id": "zcode",
      "name": "ZCode CLI",
      "builtin": true,
      "kind": "zcode",
      "enabled": true,
      "binPath": "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
      "configFilePath": "~/.zcode/v2/provider_config.json",
      "models": {
        "primaryModel": "qwen-alibaba-model-studio-cn/kimi-k3",
        "fallbackModel": "qwen-alibaba-model-studio-cn/deepseek-v4-pro-0813",
        "defaultEffort": "max"
      },
      "adapter": {
        "execTemplate": "node {bin} -p {prompt} --cwd {cwd} --mode build --json --no-color",
        "readonlyTemplate": "node {bin} -p {prompt} --cwd {cwd} --mode plan --json --no-color",
        "resumeTemplate": "node {bin} --resume {session_id} -p {prompt} --cwd {cwd} --mode build --json --no-color",
        "syncDesktopIndex": true
      }
    },
    {
      "id": "claude",
      "name": "Claude Code",
      "builtin": true,
      "kind": "custom_cli",
      "enabled": false,
      "binPath": "claude",
      "configFilePath": "~/.claude.json",
      "models": {
        "primaryModel": "claude-sonnet-4-6",
        "fallbackModel": "",
        "defaultEffort": "high"
      },
      "adapter": {
        "execTemplate": "{bin} -p {prompt} --model {model} --output-format json",
        "readonlyTemplate": "{bin} -p {prompt} --model {model} --permission-mode plan --output-format json",
        "resumeTemplate": "{bin} --resume {session_id} -p {prompt} --model {model} --output-format json",
        "syncDesktopIndex": false
      }
    },
    {
      "id": "gemini",
      "name": "Gemini CLI",
      "builtin": true,
      "kind": "custom_cli",
      "enabled": false,
      "binPath": "gemini",
      "configFilePath": "~/.gemini/settings.json",
      "models": {
        "primaryModel": "gemini-2.5-pro",
        "fallbackModel": "",
        "defaultEffort": "high"
      },
      "adapter": {
        "execTemplate": "{bin} -p {prompt} -m {model} --output-format json",
        "readonlyTemplate": "{bin} -p {prompt} -m {model} --output-format json",
        "resumeTemplate": "{bin} --resume {session_id} -p {prompt} -m {model} --output-format json",
        "syncDesktopIndex": false
      }
    }
  ],
  "workflowRoles": {
    "primaryBuilder": {
      "engineId": "codex",
      "model": "auto",
      "effort": "xhigh"
    },
    "reviewer": {
      "mode": "auto_heterogeneous",
      "engineId": "",
      "model": "auto",
      "effort": "max"
    },
    "scenarios": {
      "wide_context": {
        "enabled": false,
        "engineId": "",
        "model": "",
        "fallbackModel": "",
        "effort": "max"
      },
      "architecture_concurrency": {
        "enabled": false,
        "engineId": "",
        "model": "",
        "fallbackModel": "",
        "effort": "xhigh"
      },
      "chinese_business_security": {
        "enabled": false,
        "engineId": "",
        "model": "",
        "fallbackModel": "",
        "effort": "max"
      },
      "unit_tests_and_tools": {
        "enabled": false,
        "engineId": "",
        "model": "",
        "fallbackModel": "",
        "effort": "max"
      }
    }
  },
  "policy": {
    "costStrategy": "effect_first",
    "defaultIsolation": "worktree",
    "hideDisabledEngineTasks": false
  }
}
```

### 3.1 校验与兼容规则
- **至少启用 1 个引擎**：保存配置时若 `engines.filter(e => e.enabled).length === 0`，直接拒绝并抛出清晰错误。
- **角色自动兜底**：若 `primaryBuilder.engineId` 指向已停用或不存在的引擎，自动切换至第一个已启用引擎；若 `reviewer.mode === 'explicit'` 但目标引擎已停用，自动回退为 `auto_heterogeneous`。
- **v1 自动迁移**：读取到旧版 v1 `engine_config.json`（含顶层 `codex` / `zcode` / `customAgents`）时，在 `loadEngineConfig()` 与 `dispatch.py` 中自动无损迁移为 v2 结构，并在保存时输出规范 v2。
- **自定义引擎 ID 约束**：仅允许小写字母、数字、连字符和下划线（`/^[a-z0-9][a-z0-9_-]{0,31}$/`），不可重复，不可为 `auto` 或 `all`。

### 3.2 `getEngineDiscoverySnapshot()` 返回结构
```json
{
  "configPath": ".../engine_config.json",
  "config": { "...v2 config..." },
  "discovery": {
    "engines": {
      "<engineId>": {
        "id": "<engineId>",
        "available": true,
        "detectedBin": "/path/to/bin",
        "configExists": true,
        "resolvedConfigPath": "/path/to/config.json",
        "providers": [
          { "providerId": "...", "providerName": "...", "models": ["..."] }
        ],
        "models": [
          { "id": "...", "label": "...", "providerId": "", "providerName": "", "description": "", "contextWindow": 0 }
        ]
      }
    }
  }
}
```

### 3.3 `dispatch.py` 调度与审查契约
- `run`：`--backend` 默认 `auto`，接受 `auto` 或配置中的任意已启用引擎 ID（不再限于 `codex|zcode`）。
  - `backend=auto` 时：先匹配 `workflowRoles.scenarios` 中已启用的对应专项场景（命中则路由至该场景引擎与模型/热备），否则路由至 `workflowRoles.primaryBuilder`。
  - 显式传入 `--backend <id>` 时：查找引擎池中对应引擎并按其 `kind` 执行（`codex` / `zcode` 走内置深度适配；`custom_cli` 通过 `shlex.split` 解析 `adapter.*Template` 逐 token 替换占位符安全执行，严禁 `shell=True`）。
- `review`：`--backend` 默认 `auto`，接受 `auto` 或任意已启用引擎 ID。
  - `backend=auto` 时严格按 `workflowRoles.reviewer`：
    - `mode == "explicit"` 且目标引擎已启用 -> 直接使用该引擎；
    - `mode == "auto_heterogeneous"` -> 相对施工引擎（`task_record["backend"]` 或 `primaryBuilder.engineId`）选择另一个已启用的异构引擎（优先本机可用）；若只启用 1 个引擎则回退该引擎只读沙箱自审。
- `resume`：支持 `codex`、`zcode` 以及 `custom_cli`（通过 `adapter.resumeTemplate`）。
- `health`：`healthy` 判定为 `git` + `schema` 就绪且至少有 1 个已启用引擎本机可用；返回 `engines` 与 `workflow_roles` 摘要并保留 `codex` / `zcode` / `frontier_models` 字段。

### 3.4 `codex-console` Server 与 UI 联动契约
- `CodexStore.getSnapshot()`：
  - 按 `policy.hideDisabledEngineTasks` 过滤所有被停用引擎（包括 `codex` 或 `zcode`）的任务；
  - 将 `dispatch/state.json` 中来自任意自定义 CLI 引擎（如 `claude`/`gemini`/自定义）的任务也纳入统一 `tasks` 与 `managedAgents` 视图，使用引擎注册表中的展示名；
  - `stats` 新增 `engineCounts: Record<string, number>` 并保留 `codexCount`、`zcodeCount`。
- `CodexRunner.spawnWorker()`：默认 `backend = 'auto'`，透传任意有效引擎 ID 给 `dispatch.py run`；支持 `codex`/`zcode`/`custom_cli` 的续跑与只读提问。
- `index.mjs` MCP 工具：
  - `list_codex_tasks.engine`、`spawn_codex_worker.backend`、`manage_collab_binding.ownerRole` 均开放为字符串，不再写死 `codex|zcode` 枚举；
  - `console_engine_settings` 接收 v2 配置（也兼容迁移 v1 patch），执行至少 1 个引擎启用的校验。

## 4. 验收清单

- [x] Codex 完成后端与 `dispatch.py` 平权重构并通过 `tests/test_dispatch.py` 与 `tests/test-mcp-console.mjs`
- [x] ZCode 完成后端改动异构交叉代码审计，Codex 续跑修清全部 5 项 P1 并补齐回归测试
- [x] 主控合入后端改动，完成前端设置页与 Spawn Modal 的 V1 流光平权重构并构建 `dist/app.html`
- [x] Codex 完成前端改动快速只读交叉审查（62s），主控修清全部 3 项 P1，完成浏览器实测、`privacy-check.sh`、`install.sh --no-build`、`doctor.sh`
- [x] 提交并推送至 GitHub `main` 分支
