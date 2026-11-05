# Upstream evaluation — 2026-11-05

Research targeted README, requested Agency files/runbooks/handoffs, harness mappings, and selected execution/verification/render/install files. No repo installers/scripts executed; no full clones. GitHub unauthenticated API hit a rate limit, so versions were resolved with read-only `git ls-remote HEAD`, then files fetched from raw URLs pinned to that SHA. File paths/content hashes and unavailable candidate license paths are recorded in `sources.json`.

| Repository | Useful concept | Adopt/Adapt/Reject | Reason | Integration cost | Source reference |
|---|---|---|---|---|---|
| msitarzewski/agency-agents | Role contracts, bounded QA handoffs, minimal diffs, evidence suited to the claim | Adapt | Synthesize six short roles and versioned contracts. Reject personas, mandatory screenshot commands, fixed team rosters/timelines and benchmark assertions. | Low: JSON metadata and fixtures | [Pinned source](https://github.com/msitarzewski/agency-agents/blob/b37b5bb33b78f2c1d6567d98e25ca818e3259219/engineering/engineering-multi-agent-systems-architect.md) |
| msitarzewski/agency-agents-app | Deterministic rendering, hash provenance, installed-state reconciliation and backup-before-write | Adapt | Use source/output hashes and explicit component ownership. Reject adding its UI, updater and installer into this foundation. | Low for hashes; high for app adoption | [Pinned source](https://github.com/msitarzewski/agency-agents-app/blob/dda50547cf7999820f8ed991800200488e237ec5/src-tauri/src/render/mod.rs) |
| wshobson/agents | Capability matrix and per-harness adapters/tool-name mappings | Adapt / Reject | Adopt fail-closed target conversion. Reject dropping allowlists or treating emitted sandbox_mode as enforced Codex per-agent security; official current docs take precedence. | Medium: small reviewed subset per provider | [Pinned source](https://github.com/wshobson/agents/blob/7e2fb559cf4b824b27f1fec49fe88f7511066d26/docs/harnesses.md) |
| obra/superpowers | Scoped plans, relevant-context handoffs, evidence before completion, native isolation first | Adapt | Use bounded tasks and independent host checks. Reject mandatory per-task agent spawning or complete process machinery for microtasks. Worktree execution remains future scope. | Low for practices; no framework install | [Pinned source](https://github.com/obra/superpowers/blob/22f0b463e7a5e579904dd6211a520321035526f7/skills/verification-before-completion/SKILL.md) |
| bmad-code-org/BMAD-METHOD | Right-sized planning and durable technical/product decisions | Adapt | Three modes and planning depth fit task scope. Reject the full methodology/install process; source README distinguishes stable v6.12 from v7 preview. Pin commit rather than assuming stable branch behavior. | Low: profiles and recipes | [Pinned source](https://github.com/bmad-code-org/BMAD-METHOD/blob/022be9314e4facd16826104a9f8033e1c5ed4fdc/README.md) |
| github/spec-kit | Acceptance-led specification, explicit dependency ordering and file-specific parallel work | Adapt | Use required inputs and dependency-aware contracts. Reject generating the full command/template workflow or treating broad upstream productivity claims as measured facts. | Low: schema and routing tests | [Pinned source](https://github.com/github/spec-kit/blob/ec9a6f3b94c0aa856f77e550785a1ddde1993de1/templates/tasks-template.md) |
| gastownhall/gastown | Durable attributed task state, isolated workers and a distinct integration owner | Adapt / Reject | Keep durable state/ownership concepts; reject convoys for every microtask, daemon hierarchy and broad persistent fleet infrastructure. Worktree/merge automation is design only. | Low for concepts; high for full adoption | [Pinned source](https://github.com/gastownhall/gastown/blob/466aa41c83ee73b1fa0eb79eb9d172fb1eca9476/docs/overview.md) |

## Versions and licensing

| Repository | Researched commit SHA | License checked | Reference |
|---|---|---|---|
| msitarzewski/agency-agents | `b37b5bb33b78f2c1d6567d98e25ca818e3259219` | MIT | [License](https://github.com/msitarzewski/agency-agents/blob/b37b5bb33b78f2c1d6567d98e25ca818e3259219/LICENSE) |
| msitarzewski/agency-agents-app | `dda50547cf7999820f8ed991800200488e237ec5` | MIT | [License](https://github.com/msitarzewski/agency-agents-app/blob/dda50547cf7999820f8ed991800200488e237ec5/LICENSE) |
| wshobson/agents | `7e2fb559cf4b824b27f1fec49fe88f7511066d26` | MIT | [License](https://github.com/wshobson/agents/blob/7e2fb559cf4b824b27f1fec49fe88f7511066d26/LICENSE) |
| obra/superpowers | `22f0b463e7a5e579904dd6211a520321035526f7` | MIT | [License](https://github.com/obra/superpowers/blob/22f0b463e7a5e579904dd6211a520321035526f7/LICENSE) |
| bmad-code-org/BMAD-METHOD | `022be9314e4facd16826104a9f8033e1c5ed4fdc` | MIT | [License](https://github.com/bmad-code-org/BMAD-METHOD/blob/022be9314e4facd16826104a9f8033e1c5ed4fdc/LICENSE) |
| github/spec-kit | `ec9a6f3b94c0aa856f77e550785a1ddde1993de1` | MIT | [License](https://github.com/github/spec-kit/blob/ec9a6f3b94c0aa856f77e550785a1ddde1993de1/LICENSE) |
| gastownhall/gastown | `466aa41c83ee73b1fa0eb79eb9d172fb1eca9476` | MIT | [License](https://github.com/gastownhall/gastown/blob/466aa41c83ee73b1fa0eb79eb9d172fb1eca9476/LICENSE) |

All seven LICENSE files at the pinned commits identify MIT. Only original code and concise conceptual synthesis are included; no upstream implementation/persona corpus was copied or vendored. Preserve these references and review exact attribution/license obligations before any future source reuse. No auto-updates or catalog installs.

Agency targeted files: orchestrator; multi-agent architect; minimal-change engineer; code reviewer; evidence collector; `strategy/runbooks.json`; `strategy/coordination/handoff-templates.md`. App inspection included renderer/install modules. wshobson inspection included `docs/harnesses.md`, `capabilities.py`, `codex.py`, `antigravity.py`. Superpowers inspection included plans, subagent development, worktrees and verification skills. Spec Kit included `spec-driven.md` and plan/tasks templates; Gas Town included overview. BMad scope was its README planning/durable-context guidance; no full workflow engine was imported.

## Provider evidence and conflicts

- [Official OpenAI subagent schema](https://learn.chatgpt.com/docs/agent-configuration/subagents) says custom agents inherit parent sandbox/approvals. The pinned wshobson converter's read-only sandbox heuristic is not accepted as enforcement here.
- [Google custom subagents](https://antigravity.google/docs/subagents) documents native definitions and tool names; generated formats are not installed-app verification.
- [Google Teamwork](https://antigravity.google/docs/teamwork/) currently uses `/teamwork`, while the supplied brief names `/teamwork-preview`. Do not infer an external API from either name.
- [Google FAQ](https://antigravity.google/docs/faq) distinguishes supported native/direct scripting usage from consumer third-party wrapping; legacy external dispatch stays disabled in V2.

Stars, subjective success ratios, speedup/cost targets and marketing statements are not evaluation evidence. No real AI benchmark was run, and mock timing is not reported as performance improvement.
