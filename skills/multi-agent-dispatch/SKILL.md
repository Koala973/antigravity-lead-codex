---
name: multi-agent-dispatch
description: >-
  Use this skill when delegating coding, refactoring, debugging, cross-engine
  code review, or opt-in networked CLI/MCP tasks from Google Antigravity (Brain)
  to local OpenAI Codex CLI (default primary builder) or any enabled CLI engine
  configured in the Unified Engine Registry (ZCode, Claude Code, Gemini CLI, or
  custom CLIs) via isolated Git worktrees and compact JSON reports.
---

# Multi-Agent Dispatch (`Antigravity Brain ↔ Unified CLI Engine Registry`)

Use [dispatch.py](./scripts/dispatch.py) for the **Brain → Blackboard → Managed Engine Hand → Fast Cross-Review → Brain Final Audit** loop.

## 1. Default Workflow (Gemini Brain ↔ Codex Hand) & Equal-Rights Engine Pool

- **Antigravity (Brain · Gemini)**: Requirement alignment (`/grill-me`), architecture decisions, frontend/UI visual & interaction polish, <=50-line edits, diff audit & correction on worker output, live browser (`chrome-devtools`) & API end-to-end verification, merge & release.
- **Default Primary Builder (`--backend auto` → `codex`)**: OpenAI Codex CLI (`gpt-6.2-astra` / `gpt-6.2-sol`) handles backend modules, complex concurrency/state-machine debugging, unit test hardening, and fast read-only cross-review of frontend edits inside isolated Git worktrees.
- **Optional Equal-Rights Engines (`zcode`, `claude`, `gemini`, or custom CLIs)**: Managed via the Settings page (`~/.local/state/multi-agent-dispatch/engine_config.json`, v2 schema). Default installs enable `codex` only; users can enable/disable any engine (minimum 1 enabled), switch `primaryBuilder`, configure `reviewer` (`auto_heterogeneous` or `explicit`), or opt into scenario overrides.
- **Bounded Failover**: Multi-model failover chains are capped at 3 attempts (`MAX_FAILOVER_ATTEMPTS = 3`) so timeouts never stall indefinitely.

## 2. Command Reference

1. **Health & engine discovery**:
   ```bash
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py health
   ```
2. **Dispatch via workflow role (`--backend auto`, default) or explicit enabled engine**:
   ```bash
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py run \
     --cwd /path/to/repo \
     --backend auto \
     --difficulty auto \
     --prompt "Read docs/BLACKBOARD.md, implement module X, and run tests."
   ```
3. **Read-only code review (follows `workflowRoles.reviewer` when `--backend auto`)**:
   ```bash
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py review \
     --cwd /path/to/repo \
     --backend codex \
     --uncommitted
   ```
4. **Resume an existing managed session**:
   ```bash
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py resume \
     --task-id <task_id> \
     --prompt "Fix edge case noted in review and re-run tests."
   ```
