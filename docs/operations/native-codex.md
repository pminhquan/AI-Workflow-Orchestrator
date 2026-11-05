# Native Codex V2.2

V2.3 follow-up: SIMPLE was completed by the parent without a child; MEDIUM used one default native read-only reviewer and parent verification. [Current native evidence](../audit/v2.3-native.json) distinguishes observed participation from fresh parent-session/custom discovery, both NOT VERIFIED. Only isolated offline onboarding was exercised; no real project was installed. The sections below also retain the original V2.2 smoke context.

Verified scope on 2026-11-05: installed Windows package `OpenAI.Codex 26.1029.7803.0`; two default native subagents completed read-heavy briefs in this session. No custom profile was selected. UI thread display was not visually inspected. Evidence: [smoke JSON](../audit/v2.2-native-smoke.json). This is a foundation release, not production readiness.

## Files Codex uses

In canonical project: root `AGENTS.md` requests conditional native delegation; for substantive work it points to `agents/generated/codex-guidance/workflow.md`, then the matching `workflows/recipes/*.json`. The generated guide reflects `config/routing/rules.json`, `config/workflow/policy.json`, `agents/teams/profiles.json`, recipes and `config/integrations/codex-guidance.json`. Codex reads instructions; it does not execute router JavaScript automatically. `native-guide <request.json> <host.json>` is an optional deterministic planning diagnostic, never a native API.

In an opted-in future project: existing `AGENTS.md` receives a reviewed snippet referring to `.workflow-orchestrator/workflow.md`; the latter points only to the matching `.workflow-orchestrator/recipes/<id>.json`. Optional standalone `.codex/agents/awo-reviewer.toml` and `awo-evidence.toml` participate only if the actual host discovers them. Staged files under `agents/generated/` or `state/bundles/` are not discovered. No files are installed by this release.

## Decisions and responsibility

- DIRECT: microtasks, tightly dependent work, unclear ownership or low expected benefit. Parent acts, validates appropriately; no worker.
- DELEGATED: one useful independent brief with clear ownership/dependencies and acceptance. Parent integrates and checks the result.
- TEAM: independent units and milestones justify a small DAG. Start with independent read-heavy work. At most two workers and the lower host limit; never concurrent writes to the same scope. Roles are a menu, not a required headcount.
- Unavailable/disabled/prohibited native tools: DIRECT if critical requirements survive; otherwise BLOCKED. A required hard filesystem boundary cannot be replaced with an instruction.

Brief: goal, exact paths, read/write ownership, dependencies, acceptance, constraints, relevant checks, expected output and stopping point. Output: inspected/changed paths, evidence with file:line references, actual commands/outcomes and uncertainties. Parent verifies actual files/diffs and fresh checks before accepting. Worker prose is not a host check receipt. Do not create nested teams or dispatch through Antigravity/MCP/agentapi.

## Current official configuration

[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) documents built-in `default`, `worker`, `explorer` and standalone agent TOML discovery in project `.codex/agents/` or personal `~/.codex/agents/`. Required keys: `name`, `description`, `developer_instructions`. This compiler emits only those keys. Built-ins are preferred; no duplicate custom explorer/worker/orchestrator is needed for this workflow. `awo-reviewer` specializes correctness/security review; `awo-evidence` audits claims against evidence. Each declares use/non-use, brief, output, verification and ownership assumptions.

Parent permissions/provider/MCP remain authoritative. Model/reasoning inherit unless explicit spawn/default/custom configuration selects them; custom-file values take precedence. A model selection without effort has special resolution rules: consult official docs before overriding. We emit no overrides. A prompt saying read-only does not enforce read-only access. Use genuinely restrictive parent permissions or an explicitly scoped isolated workspace when required; this release creates neither.

[Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents `[agents] enabled`, `max_concurrent_threads_per_session` (excludes parent), defaults and legacy `max_threads` alias. The guide caps work at two without modifying any config. A future reviewed project-local merge may set the current concurrency key; no config fragment is automatically installed and no global config is overwritten. Project config requires trust. [AGENTS discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md) walks global guidance then root-to-CWD instructions, with overrides taking precedence. A new session should confirm applicable instructions and custom discovery; writing staging cannot prove either.

The app documents inspectable subagent threads and returned summaries. Actual evidence here is the native `collaboration.spawn_agent` calls, two returned task names/results, and parent source cross-checks recorded in the conversation and smoke JSON. This tool surface offers no built-in/custom `agent_type` selector, so both calls are honestly recorded as default with explorer-like briefs. Do not claim the staged custom agents ran.

## Capability matrix

| Surface | Status | Boundary |
|---|---|---|
| Native default spawn/result in this session | SESSION-VERIFIED | Two read-heavy briefs only; no custom discovery or GUI visual verification |
| Generated guidance, bundle and TOML syntax | OFFLINE-TESTED | Planning artifacts, not execution receipts |
| Optional custom profile discovery/enforcement | NOT VERIFIED | Staged only |
| Codex scheduler adapter | NOT VERIFIED / disabled | No JS native invocation or second lifecycle |
| Exact hard-constraint role conversion | UNSUPPORTED | Existing strict refusals retained |
| Mock/Replay scheduling | OFFLINE-TESTED | Synthetic workers and real local fixture checks |
| Antigravity native Teamwork templates | NOT VERIFIED | Retained, no app invocation |
| Consumer Antigravity external dispatch | UNSUPPORTED / disabled | No login wrapper, automation, hidden endpoints or quota bypass |
| Official external API executor | DESIGN-ONLY | Separate supported API/auth/billing/permission review and opt-in needed |

Next official path: confirm supported provider API documentation, define a bounded executor contract and verification/billing requirements, review scopes, backup/diff/rollback and authorization before any activation. No API key, account, billing, deployment or external dispatch is created here.
