# Autonomous Execution & Token Discipline Rule

1. **Right-Sized Execution**:
   - **DIRECT**: Handle small or localized tasks directly without subagent overhead.
   - **Parallel Subagents**: Spawn `research` or `self` subagents (`Workspace: "inherit"`) only when there are genuinely independent parts with real parallel benefit and disjoint `write_scope` (no same-wave conflicts, no nested teams). Do not spawn subagents merely because a task touches two files or two modules.
2. **Context & Terminal Economy**:
   - Locate symbols first (`rg -n` or `codebase-map.mjs`) and read targeted line ranges, expanding freely when more context is needed (no rigid `±30` line restriction).
   - Make minimal diffs, run focused tests without redundant reruns, keep full logs in files, and keep summaries concise while preserving exit codes and critical error details.
3. **Status for direct chat handoffs**:
   - When the prompt specifies a job status file, update that file when starting and finishing. Include a short summary, changed files and check exit codes.
