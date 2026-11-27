---
name: multi-agent-dispatch
description: >-
  Use this skill when delegating coding, refactoring, debugging, read-only code
  review, or opt-in networked CLI/MCP tasks from Google Antigravity (Gemini
  Brain) to local OpenAI Codex CLI (Execution Hand) via isolated Git worktrees
  and compact JSON reports.
---

# Multi-Agent Dispatch (`Antigravity Brain ↔ OpenAI Codex Hand`)

Use [dispatch.py](./scripts/dispatch.py) for the zero-configuration **Gemini Brain → Blackboard → Codex Hand → Brain Final Audit** loop.

## 1. Out-of-the-Box Workflow (Gemini Brain ↔ Codex Hand)

- **Antigravity (Brain · Gemini)**: Requirement alignment (`/grill-me`), architecture decisions, frontend/UI visual & interaction polish, <=50-line edits, diff audit & correction on Codex output, live browser (`chrome-devtools`) & API end-to-end verification, merge & release.
- **OpenAI Codex CLI (Execution Hand)**: Automatically discovers the newest official flagship & wide-fast models (`gpt-6.2-astra` / `gpt-6.2-sol`) from `~/.codex/models_cache.json` with zero user configuration. Handles backend modules, complex concurrency/state-machine debugging, unit test hardening, and fast read-only cross-review of frontend edits inside isolated Git worktrees.

## 2. Command Reference

1. **Health & automatic Codex model discovery**:
   ```bash
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py health
   ```
2. **Dispatch a coding/debugging task in an isolated Git worktree**:
   ```bash
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py run \
     --cwd /path/to/repo \
     --difficulty auto \
     --prompt "Read docs/BLACKBOARD.md, implement module X, and run tests."
   ```
3. **Fast read-only code review (ignores `dist/` / `node_modules/` automatically)**:
   ```bash
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py review \
     --cwd /path/to/repo \
     --uncommitted
   ```
4. **Resume an existing managed session**:
   ```bash
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py resume \
     --task-id <task_id> \
     --prompt "Fix edge case noted in review and re-run tests."
   ```
