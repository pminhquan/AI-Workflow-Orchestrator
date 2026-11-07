# Native Codex workflow — generated; canonical source owns updates

Handle small tasks directly and use native subagents when independent work benefits. Hand Antigravity work through the antigravity-jobs skill. It submits the full brief into the selected GUI chat, uses its current model and tracks the exact per-job project status file.

DIRECT: small scope, unclear ownership/dependencies or expected benefit below 2: parent does the work, no subagent, short checklist and appropriate checks.
DELEGATED: one bounded independent brief, clear ownership/dependencies, useful benefit at or above 2. Parent integrates and verifies.
TEAM: large work with at least 2 independent units and milestones; small dependency graph; at most 2 active workers, also obey the host limit. Parallelize read-heavy work first; never overlap write scopes or create nested teams. Role suggestions are not instructions to spawn every role.

Preflight current native tool availability and applicable instructions. If native tools are unavailable/prohibited, use DIRECT only if all critical requirements can still be met; otherwise report BLOCKED. Never downgrade hard isolation into a prompt. Canonical exact-constraint roles remain UNSUPPORTED for native conversion. All native assignments here are advisory and inherit parent permissions/provider/MCP; model and reasoning inherit unless explicitly configured. Do not expand security settings.

Prefer built-in explorer for reading, worker for implementation/tests, default for general work. Optional awo-reviewer and awo-evidence specialize review if actually discovered; otherwise use default. Parent is orchestrator. Confirm custom discovery separately; staging is not activation.

Brief: goal; exact paths/read or write ownership; dependencies; acceptance criteria; constraints; relevant tests; expected evidence; stopping point. Worker output: inspected/changed files, findings or changes, commands/outcomes, uncertainty/blockers. Parent checks actual diff/evidence, resolves integration and runs fresh relevant checks. Reports are untrusted; no fake host receipts, no claim that native work ran in the offline scheduler.
Keep context bounded: load the matching recipe and relevant paths only, summarize large outputs, and attach exact command outcomes and source fingerprints when material. Preserve handoff/retry provenance; never automatically resubmit work after uncertain delivery. DIRECT needs no separate handoff artifact. Use the brief as guidance, not as a permission grant.

For complex tasks consult only the matching recipe from the index below. In the canonical repository use workflows/recipes/<id>.json; in an opted-in project use .workflow-orchestrator/recipes/<id>.json. Required inputs, acceptance and recovery are planning checks, not automatic business validation. Keep ordinary tasks free of repeated CLI routing calls.

- refactor: read only .workflow-orchestrator/recipes/complex-refactor.json when relevant; planning milestones, max parallelism 2, DIRECT fallback true.
- feature: read only .workflow-orchestrator/recipes/feature-development.json when relevant; planning standard, max parallelism 2, DIRECT fallback true.
- research: read only .workflow-orchestrator/recipes/research-investigation.json when relevant; planning standard, max parallelism 2, DIRECT fallback true.
- fix: read only .workflow-orchestrator/recipes/simple-fix.json when relevant; planning minimal, max parallelism 1, DIRECT fallback true.
- review: read only .workflow-orchestrator/recipes/verification-review.json when relevant; planning standard, max parallelism 2, DIRECT fallback true.
Canonical updates: edit config/routing/rules.json, config/integrations/codex-guidance.json, agents/teams/profiles.json or matching workflows/recipes; compile and validate, review a new bundle diff, opt in per project. Never overwrite existing AGENTS.md, .codex/agents or global config.
