# Autonomous Execution & Token Discipline Rule

1. **Right-Sized Execution**:
   - **DIRECT**: Handle small or localized tasks directly without subagent overhead.
   - **Parallel Subagents**: Spawn `research` or `self` subagents (`Workspace: "inherit"`) only when there are genuinely independent parts with real parallel benefit and disjoint `write_scope` (no same-wave conflicts, no nested teams). Do not spawn subagents merely because a task touches two files or two modules.
2. **Context & Terminal Economy**:
   - Locate symbols first (`rg -n` or `codebase-map.mjs`) and read targeted line ranges, expanding freely when more context is needed (no rigid `±30` line restriction).
   - Make minimal diffs, run focused tests without redundant reruns, keep full logs in files, and keep summaries concise while preserving exit codes and critical error details.
3. **Explicit Bound Reporting (Codex Boss Jobs)**:
   - When completing a `[Codex Boss Job ...]`, run `node "src/desktop-inbox/report-cli.mjs" --brief "<brief-attempt.json>" --run-checks --summary "<concise summary>"` so the report stays bound to the exact `workspace_root`, `task_id`, and `attempt_id`.
