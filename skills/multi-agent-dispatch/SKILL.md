---
name: multi-agent-dispatch
description: >-
  Use this skill when delegating coding, refactoring, debugging, cross-engine
  code review, large-context sweeps, or opt-in networked CLI/MCP tasks from
  Google Antigravity (Brain) to local OpenAI Codex CLI (GPT-6.2) and ZCode CLI
  (Alibaba Bailian + Tencent TokenHub national flagships: deepseek-v4-pro-0813,
  kimi-k3, glm-5.3 1M context, qwen3.8-max) via isolated Git worktrees,
  automatic failover, ZCode Desktop index sync, and compact JSON reports.
---

# Multi-Agent Dispatch (`Antigravity Brain ↔ Codex 20x & ZCode Flagships`)

Use [dispatch.py](./scripts/dispatch.py) for the **Brain → Blackboard → Dual-Engine Hand → Heterogeneous Cross-Review → Brain Final Audit** loop.

## 1. Dual-Engine Division of Labor (Max Effectiveness, Cost-Unconstrained)

| Engine | Flagship Models | Best-Fit Scenarios |
| :--- | :--- | :--- |
| **Antigravity (Brain)** | Gemini Ultra 5x | Requirement clarification (`/grill-me`), architecture decisions, frontend/UI visual & animation polish, <=50-line edits, live browser (`chrome-devtools`) & API end-to-end verification, merge & release. |
| **Codex CLI (`--backend codex`)** | `gpt-6.2-astra` (272k), `gpt-6.2-sol` (500k) | Deep backend architecture, complex concurrency/state-machine debugging, OS kernel-level `workspace-write` sandboxed execution, and cross-reviewing ZCode changes. |
| **ZCode CLI (`--backend zcode`)** | Dual-channel (`阿里云百炼` + `腾讯TokenHub`): `deepseek-v4-pro-0813`, `kimi-k3`, `glm-5.3` (1M context), `qwen3.8-max`, `deepseek-v4.1-flash` | 1M ultra-wide repo sweeps (`--prefer-wide` / `>=10` files -> `glm-5.3`), Chinese business logic & security analysis (`kimi-k3`), multi-module code & unit test generation (`deepseek-v4-pro-0813`), Lark/Feishu & office plugin workflows (`qwen3.8-max`), and cross-reviewing Codex changes. |

## 2. ZCode Benchmark-Verified Routing & 3-Tier Cross-Provider Failover

`dispatch.py` dynamically generates an isolated `run_dir/provider_config.json` per run (injected via `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`) with `reasoningLevel: "max"` (or `"xhigh"` on `qwen3.8-max`), and automatically fails over across providers if a channel times out or errors:

| Scenario / Flag | Primary Selection | 1st Failover (Hot Backup) | 2nd Failover (Heterogeneous Backup) |
| :--- | :--- | :--- | :--- |
| **Code Impl / Debug / Audit (`hard` / `review`)** | `阿里云百炼 / kimi-k3 (max)` | `阿里云百炼 / deepseek-v4-pro-0813 (max)` | `腾讯TokenHub / deepseek-v4-pro-0813 (max)` |
| **Business Logic / Architecture / Security (`medium` / `extreme`)** | `阿里云百炼 / kimi-k3 (max)` | `腾讯TokenHub / kimi-k3 (max)` | `阿里云百炼 / qwen3.8-max (xhigh)` |
| **1M Wide Context Sweep (`--prefer-wide` or `>=10` files)** | `腾讯TokenHub / glm-5.3 (max, 1M window)` | `阿里云百炼 / kimi-k3 (max)` | `阿里云百炼 / deepseek-v4-pro-0813 (max)` |
| **Plugin / Fast Tool Task (`low`)** | `阿里云百炼 / qwen3.8-max (xhigh)` | `腾讯TokenHub / deepseek-v4.1-flash (max)` | `阿里云百炼 / kimi-k3 (max)` |

Every completed ZCode CLI task is also automatically synced into `~/.zcode/v2/tasks-index.sqlite` so it appears in both Antigravity's right side-pane (`Antigravity Lead Codex`) and `ZCode.app` Desktop's left task list.

## 3. Heterogeneous Cross-Engine Code Review (`dispatch.py review --backend auto`)

Never let a model review its own code:
- `dispatch.py review --task-id <id> --backend auto` (default) inspects the author task's `backend`:
  - If authored by **Codex**, it automatically routes the static code review to **ZCode** (`deepseek-v4-pro-0813` at `max` reasoning);
  - If authored by **ZCode**, it automatically routes the static code review to **Codex** (`gpt-6.2-astra` at `high`/`max` reasoning).
- For core files touching money, auth/permissions, or outbound messaging, run both engines at maximum reasoning depth, followed by Antigravity's live browser/API verification.

## 4. Command Reference

1. **Health & dual-engine model discovery**:
   ```bash
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py health
   ```
2. **Dispatch to Codex or ZCode**:
   ```bash
   # Codex flagship dispatch
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py run \
     --cwd /path/to/repo \
     --backend codex \
     --difficulty auto \
     --prompt "Read docs/BLACKBOARD.md, implement module X, and run tests."

   # ZCode flagship dispatch (auto-selects Bailian/TokenHub flagship + syncs to ZCode Desktop)
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py run \
     --cwd /path/to/repo \
     --backend zcode \
     --difficulty auto \
     --prompt "Read docs/BLACKBOARD.md, implement module Y with unit tests, and run tests."
   ```
3. **Heterogeneous cross-engine code review (`--backend auto` default)**:
   ```bash
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py review \
     --task-id <task_id> \
     --backend auto
   ```
4. **Resume an existing Codex or ZCode session**:
   ```bash
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py resume \
     --task-id <task_id> \
     --prompt "Fix edge case noted in cross-review and re-run tests."
   ```
