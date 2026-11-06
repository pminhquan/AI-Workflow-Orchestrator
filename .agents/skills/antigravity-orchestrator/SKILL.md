---
name: antigravity-orchestrator
description: Coordinate substantive coding, web/app development and debugging in the CURRENT Codex workspace with Antigravity Desktop. Choose DIRECT for small tasks, native review when useful, or bounded scoped Antigravity jobs; keep collaborating through implementation and verification.
---

# Codex Boss → Antigravity Desktop (Global Workflow)

Installed once at user scope. New projects require no local bridge setup, hooks, skills, or UUID input. Never assign or change Antigravity model/reasoning settings, and never switch accounts or alter login mechanisms.

## 1. Decision & Decomposition
- **DIRECT for small work**: Handle small or localized edits directly without bridge or subagent overhead.
- **Native subagents / Antigravity jobs**: Delegate only when there are genuinely independent parts and real execution benefit. Do **not** spawn subagents merely because a task touches two files or two modules.
- **One active write job per workspace**: Keep at most one active job per workspace while allowing other workspaces to run independently. Do **not** auto-release a running (`CLAIMED`/`DISPATCHED`) or `UNCERTAIN_DELIVERY` job just because a new prompt arrives.
- **Controlled write scope**: Never default `write_scope` to the entire workspace for a short prompt. Infer only the specific files needed from the request and actual workspace source, expanding in a controlled manner if the task requires it.

## 2. Brief, Waiting & Independent Parent Verification
1. **Submit (`submit_job`)**:
   - Pass `workspace_root` from the current session environment on every call (never use server cwd, another project, or the bridge repo).
   - Keep briefs compact: include only goal, relevant paths, dependencies (`subtasks` waves when independent parallel work is beneficial), `read_scope`, `write_scope` (`[]` if read-only), `acceptance_criteria`, and registered `verification_commands`. Never re-send full source files, full chat history, or large logs already saved in the workspace.
   - Routing uses a fresh matching-workspace Hook Beacon or an explicitly verified persistent receiver (`select_receiver: true`). A new hook alone never switches a verified receiver; if the target is ambiguous or missing, hold the job and report concisely rather than sending to an unverified chat. Never automatically retry `UNCERTAIN_DELIVERY`.
2. **Wait & Mechanical Check (`wait_job`)**:
   - Call `wait_job({ workspace_root, task_id, auto_verify: true })` (or check periodically on long jobs while doing useful parent work).
   - `auto_verify: true` performs **mechanical checks only** (task identity, scope, hashes, actual diff, syntax, registered checks) and leaves the job in `RESULT_READY`. It never replaces independent parent review.
3. **Parent Review & Close (`verify_job`)**:
   - Inspect `concise_summary`, meaningful source diffs, and `acceptance_criteria`. Run fresh checks proportional to risk without repeating redundant test suites needlessly.
   - Transition to `VERIFIED` only by calling `verify_job({ workspace_root, task_id, accepted: true, review_notes: [...] })` after verifying the changes and acceptance criteria (or `accepted: false` to reject/rework).

## 3. Context & Terminal Discipline
- Locate symbols with `rg -n` or `codebase-map.mjs` and read relevant ranges, expanding context freely whenever needed (never enforce a rigid `±30` line cap when more context is required).
- Keep full logs in files and cap noisy shell output (`| Select-Object -First 40`) while preserving exit codes and critical error details.
