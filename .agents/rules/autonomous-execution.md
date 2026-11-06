# Autonomous Subagent & Surgical Execution Rule

Apply automatically on every turn without waiting for the user to ask for subagents or token optimization:

1. **Auto-Decompose & Spawn Subagents**:
   - **1 file / small localized edit**: Execute **DIRECT** immediately.
   - **Broad read/discovery across >= 2 independent areas**: Immediately spawn parallel `research` subagents via `invoke_subagent({ TypeName: "research", ... })` in a single turn and wait for reactive wakeup.
   - **Multi-part implementation / >= 2 independent files or modules**: Automatically act as **Team Lead** — partition work into disjoint `write_scope` slices and spawn parallel `self` subagents via `invoke_subagent({ TypeName: "self", Workspace: "inherit", ... })` in waves (never overlap write files in the same wave; never create nested teams).
2. **Surgical Read/Edit & Token Economy**:
   - Locate symbols and line numbers first (`src/desktop-inbox/codebase-map.mjs` or `rg -n`), then call `read_file` with `StartLine` and `EndLine` (±30 lines). Never read entire large files end-to-end.
   - Apply minimal diffs without boilerplate. Run only the targeted test file and cap verbose shell output (`| Select-Object -First 40`).
3. **Zero-ID Fast Reporting (Codex Boss Jobs)**:
   - When finishing a `[Codex Boss Job ...]` or `LATEST-JOB.md`, run `node "src/desktop-inbox/report-cli.mjs" --latest --run-checks --summary "<concise summary>"` so Codex Boss only reads `concise_summary`.
