---
name: multi-agent-dispatch
description: >-
  Delegate coding, refactoring, debugging, or review work from Google
  Antigravity (Brain) to local OpenAI Codex CLI (Hand), dynamically routing the
  newest official frontier models with default --quality smart via isolated Git
  worktrees, Blackboard sync, and compact JSON reports.
---

# Multi-Agent Dispatch (`Antigravity Brain ↔ Codex CLI Hand`)

Use [dispatch.py](./scripts/dispatch.py) for the **Brain → Blackboard → Hand → Audit** loop.

## When to Delegate vs Handle Directly

- **Handle directly in Antigravity (Brain)**: requirement alignment (`/grill-me`), web research, architecture design, updating `docs/BLACKBOARD.md`, tiny 1-file edits (<= 20 lines), final diff/test audit, and browser/UI acceptance.
- **Delegate to Codex CLI (Hand)**: feature implementation, multi-file edits, test suites, debugging, refactoring, or parallel sub-module work.

## Blackboard Sync & Quota-Saving Rules

1. **Shared Blackboard (`docs/BLACKBOARD.md`)**: Before dispatching, write confirmed goals, constraints, and task acceptance criteria to `docs/BLACKBOARD.md` and commit locally so Codex Worktrees inherit complete context from `HEAD`. After auditing Codex results, update `docs/BLACKBOARD.md` with completed items and next tasks.
2. **Coarse-grained single-turn tasks**: Instruct Codex inside its prompt to read `docs/BLACKBOARD.md`, implement changes, **and run tests/linters/typechecks itself** before returning.
3. **Structured short reports**: `dispatch.py` passes [report_schema.json](./resources/report_schema.json) and collects `git status --short` / `git diff --stat`, keeping Antigravity context clean and compact.
4. **Worktree isolation & human merge gate**:
   - Git write tasks default to `--isolation worktree` (`agy-worker/<task_id>`).
   - **NEVER auto-merge** worker branches or push to GitHub without explicit user approval.
5. **Brain-driven iteration**: Review each report in Antigravity, decide the next prompt, and use `resume --task-id <id>` (reusing the Worktree & session) or launch the next `run`.

## Dynamic Frontier Discovery & Smart Quality-Quota Routing (`--quality smart` Default)

`dispatch.py` dynamically reads `~/.codex/models_cache.json`, identifies the newest official generation's **flagship** and **wide_fast** siblings, and calibrates reasoning effort against `supported_reasoning_levels`:

| `--difficulty` | `--quality smart` (**Default**) | `--quality max` | `--quality balanced` |
| :--- | :--- | :--- | :--- |
| `low` | `wide_fast` + `medium` | `flagship` + `high` | `wide_fast` + `medium` |
| `medium` | Alternates `wide_fast` ↔ `flagship` at `high` | `flagship` + `xhigh` | Alternates `wide_fast (high)` ↔ `flagship (medium)` |
| `hard` | `flagship` + `xhigh` | `flagship` + `max` | `flagship` + `high` |
| `extreme` | `flagship` + `max` | `flagship` + `ultra` | `flagship` + `xhigh` |
| `auto` (default) | Heuristic classifier -> tier above | Heuristic classifier -> tier above | Heuristic classifier |

- Pass `--prefer-wide` (or `>=10` `--files` under `auto`) to route large-context sweeps to `wide_fast`.
- Pass `--model` / `--effort` anytime to override explicitly.

## Command Reference

Run via `python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py <subcommand>`:

1. **Preflight health & frontier model discovery check**:
   ```bash
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py health
   ```
2. **Single task dispatch**:
   ```bash
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py run \
     --cwd /path/to/repo \
     --difficulty auto \
     --prompt "Read docs/BLACKBOARD.md, implement task X with unit tests, and run tests to verify."
   ```
3. **Parallel batch dispatch**:
   ```bash
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py batch \
     --cwd /path/to/repo \
     --max-concurrency 3 \
     --manifest /path/to/tasks.json
   ```
4. **Resume an existing worker session**:
   ```bash
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py resume \
     --task-id <task_id> \
     --prompt "Fix edge case noted in audit and re-run tests."
   ```
5. **Read-only code review**:
   ```bash
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py review \
     --task-id <task_id>
   ```
6. **Inspect state & clean up worktree after user approves/merges**:
   ```bash
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py status
   python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py cleanup --task-id <task_id> --delete-branch
   ```
