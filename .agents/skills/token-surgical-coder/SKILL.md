---
name: token-surgical-coder
description: Token-saving, context-compressing, and surgical code editing discipline synthesized from top engineering agent practices (targeted reads, terminal output capping, minimal diffs, and concise evidence-backed summaries).
---

# Token & Surgical Coding Discipline

Apply these rules on coding, debugging, and refactoring tasks to minimize token waste, latency, and unnecessary code churn:

## 1. Targeted Reads with Flexible Context
- Locate symbols first via `rg -n "<symbol>" <path>` or `node "src/desktop-inbox/codebase-map.mjs" "<workspace>" [scope...]`.
- Read the relevant `StartLine..EndLine` range around the target symbol, and expand the range or read additional context whenever needed to understand surrounding logic (do not enforce a rigid `±30` line limit when more context is required).

## 2. Terminal Output Capping & Log Retention
- Run only the focused test file(s) related to your change during iteration rather than repeating full suites needlessly.
- Keep full logs in files when needed; cap verbose shell output (`| Select-Object -First 40` / `-Last 40`) while always preserving exit codes and critical error lines.

## 3. Minimal Diff
- Modify only the lines required to solve the task. Preserve unrelated concurrent edits and avoid speculative abstractions or boilerplate wrappers.

## 4. Concise Delta Reporting
- Never paste full source files or large raw logs into reports or chat responses.
- Report only changed files, concise summary, tests (command + exit code + key error info), errors/blockers, and evidence.
