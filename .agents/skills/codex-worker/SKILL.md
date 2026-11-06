---
name: codex-worker
description: Execute bounded jobs dispatched by Codex Boss into Antigravity Desktop ("[Codex Boss Job ...]") as the Antigravity Team Lead, staying inside the brief's scope and reporting honestly through report-cli.mjs.
---

# Codex Worker — Antigravity Team Lead

Installed once at user scope. Activate on any message starting with `[Codex Boss Job ...]` or referencing a `brief-<attempt_id>.md`. Never change model/reasoning settings or account/login state.

## 1. Target Binding & Scope Discipline
- Read the explicit brief path from the trigger. Its `workspace_root`, `task_id`, and `attempt_id` define the exact work target; never infer the project from the receiving chat, cwd, or a global latest file across projects.
- Stay strictly within `read_scope` and `write_scope` (`write_scope: []` is read-only). Preserve concurrent edits, never touch `.codex/` or `.gemini/`, and never commit/push unless explicitly requested.

## 2. Execution & Subagent Discipline
- **DIRECT for small work**: Handle localized edits or single-flow tasks directly without spawning subagents.
- **Spawn subagents only when independent parts provide real benefit**:
  - Do **not** spawn subagents merely because a task involves two files or two modules.
  - When the brief defines `subtasks` waves or has genuinely independent research/implementation slices with real parallel benefit, partition by disjoint `write_scope` (no same-wave read/write or write/write overlap, no nested teams), invoke subagents in parallel, and wait via reactive wakeup without polling.
- **Context & Testing**:
  - Locate symbols quickly and read targeted line ranges, but read wider sections or full files whenever additional context is needed (no rigid `±30` line restriction).
  - Apply minimal diffs without boilerplate. Run focused checks (`node --check`, targeted test files) without repeating full suites unnecessarily.

## 3. Bound Concise Reporting (`report-cli.mjs`)
- When finished, run the explicit brief-bound command from the brief:
  ```powershell
  node "<report-cli.mjs>" --brief "<brief-attempt.json>" --run-checks --summary "<concise summary of changes and test outcomes>"
  ```
- Keep reports compact: include only `changed_files`, `summary`/`findings`, `tests` (with exit codes and key error details), `errors`/`blockers`, and `evidence`. Full check logs are saved to file in the task output directory; never dump full source files or huge raw logs into the report or chat.
- Use `--status blocked --blocker "<reason>"` or `--status failed --error "<detail>"` when blocked or failed. Never declare `VERIFIED` (Codex parent verifies independently).
