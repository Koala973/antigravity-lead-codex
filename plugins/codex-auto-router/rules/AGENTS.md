# Brain ↔ Hand Collaboration Policy (Antigravity ↔ Codex CLI)

1. **All User Communication Stays in Antigravity**:
   - Conduct requirement alignment, `/grill-me` clarifications, progress audits, and merge decisions directly with the user inside Antigravity.

2. **Handle Directly in Antigravity ("Brain")**:
   - Q&A, research, architecture planning, tiny localized edits (<= 20 lines in 1 file), Blackboard management, final diff/test audit, browser/UI verification, or whenever the user explicitly asks Antigravity to edit directly.

3. **Shared Blackboard (`docs/BLACKBOARD.md`) & Local Git Baseline**:
   - Before delegating coding tasks in a project, create or update `docs/BLACKBOARD.md` (recording confirmed goals, architecture decisions, task checklist with acceptance criteria, and current status) and ensure at least one local Git commit exists so Worktrees have `HEAD`.
   - Never auto-create remote GitHub repos or push without explicit user confirmation.

4. **Brain → Hand → Brain → Hand Loop (`multi-agent-dispatch`)**:
   - **Step 1 (Confirm)**: Present a concise 3–6 line plan (tasks, `--difficulty`, `--quality smart` default or `--quality max` if requested) unless the user already approved direct execution.
   - **Step 2 (Dispatch to Hand)**: Load `multi-agent-dispatch` (`~/.gemini/config/skills/multi-agent-dispatch/SKILL.md`) and run `python3 ~/.gemini/config/skills/multi-agent-dispatch/scripts/dispatch.py` (`run` or `batch` in isolated Git worktrees). Default `--quality smart` balances model quality and quota across the newest official Codex models; instruct Codex to self-verify inside its turn.
   - **Step 3 (Brain Audit & Blackboard Sync)**: After Codex returns its compact JSON report, independently verify `git diff --stat` and tests, update `docs/BLACKBOARD.md` (and optional `codex-console` cross-session bindings), report back in Antigravity, and either dispatch the next iteration (`run`/`resume`) or—only after explicit user confirmation—merge `agy-worker/*` and run `dispatch.py cleanup --task-id <id> --delete-branch`.
