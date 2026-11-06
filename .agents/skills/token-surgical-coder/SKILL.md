---
name: token-surgical-coder
description: Token-saving, context-compressing, and surgical code editing discipline synthesized from top engineering agent practices (Map-First range reads, rtk-style terminal output capping, minimal diffs, and zero-read-back summaries).
---

# Token & Surgical Coding Discipline

Apply these 5 high-ROI rules on every coding, debugging, or refactoring task to minimize token burn, execution latency, and unnecessary code churn:

## 1. Map-First & Surgical Range Reads (`codebase-map` / `tokenmiser` pattern)
- **Never** read a >150-line file from line 1 to EOF just to locate a function.
- First check the embedded **Surgical Map** (`L<line>:<symbol>`) in the job brief, or run:
  ```powershell
  node "src/desktop-inbox/codebase-map.mjs" "<workspace>" [scope...]
  ```
  or `rg -n "<symbol>" <path>` to get the exact line number.
- Call `read_file` with `StartLine` and `EndLine` (±30 lines around the target symbol).

## 2. Terminal Output Capping (`rtk` / Context-Guard pattern)
- Unbounded terminal logs are the #1 cause of context window bloat (consuming 50–80% of session tokens).
- Run **only the specific test file** related to your change (`node --test tests/unit/target.test.mjs`, `pytest tests/test_target.py -q`), never the full test suite in an edit loop.
- Cap verbose command outputs in PowerShell with `| Select-Object -First 40` or `| Select-Object -Last 40`.

## 3. Surgical Edits & Code Economy (Minimal Diff)
- Modify **only** the exact lines required. Do not reformat unchanged blocks, do not rewrite adjacent working functions, and do not add speculative abstractions, wrapper helpers, or verbose boilerplate comments.
- Prefer compact, idiomatic expressions that match the surrounding codebase style.

## 4. Fail-Fast Single Verification (`superpowers` TDD-lite pattern)
- Syntax-check modified files first (`node --check <file>`), then run the single closest unit/integration test once.
- Once the targeted test passes, stop running redundant checks and report immediately.

## 5. Delta-Only Handoff (`Zero-Read-Back` pattern)
- Never paste entire modified files into the chat response or summary.
- Report only: (a) changed file paths + line ranges, (b) 1–2 sentence core logic delta, and (c) exact test command + exit code.
