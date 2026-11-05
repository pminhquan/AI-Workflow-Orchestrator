# Desktop Bridge Optimization — Readiness & Phase Telemetry

Canonical modules:
- Shared readiness evaluator: `src/desktop-inbox/readiness.mjs`
- Phase & outcome-separated telemetry: `src/desktop-inbox/telemetry.mjs`
- Live MCP server (`bridge_status`, `submit_job`): `src/desktop-inbox/live-mcp-server.mjs`
- Operator CLI (`doctor`, `status`, `metrics`, `release-stuck`): `src/desktop-inbox/bridge-cli.mjs`

---

## 1. Shared Truthful Readiness (`src/desktop-inbox/readiness.mjs`)

Both MCP `bridge_status` and CLI `bridge-cli.mjs doctor|status` evaluate readiness through `inspectWorkspaceReadiness` / `evaluateBridgeReadiness`, using the same policy for the same observations. The evaluation clock is sampled after reading heartbeat and target files to avoid false future diagnoses during a Sidecar update.

### Constants & Finite TTLs
- `HEARTBEAT_MAX_AGE_MS = 15000` (15 seconds): maximum age of `sidecar-heartbeat.json` (`desktop-inbox.sidecar-heartbeat@1`).
- `TARGET_OBSERVATION_TTL_MS = 7200000` (2 hours): finite TTL for `active-target.json` (`desktop-inbox.active-target@1`) written by `.agents/hooks.json` (`SessionStart` / `PreInvocation`).

### Observation Boundary (Not Focused-Chat Proof)
`active-target.json` records a **Hook Beacon observation** (`target_observation.source = "hook_beacon_observation"`, `target_observation.proves_gui_focus = false`). It proves a GUI hook fired for that `workspace_root`, `project_id`, and `conversation_id` within `TARGET_OBSERVATION_TTL_MS`; it does **not** claim OS window focus or active tab visibility.

### Readiness Fields & Stable `reason_codes`
`ready_to_dispatch` is `true` (`readiness_status = "READY_TO_DISPATCH"`, `reason_codes = []`) **if and only if** all gates pass simultaneously:

| Gate | Required Condition | Failure `reason_codes` |
|---|---|---|
| Sidecar Heartbeat | Valid JSON/schema, `status === "RUNNING"`, `0 <= heartbeat_age_ms < HEARTBEAT_MAX_AGE_MS` | `HEARTBEAT_MISSING`, `HEARTBEAT_MALFORMED`, `SIDECAR_NOT_RUNNING`, `HEARTBEAT_FUTURE`, `HEARTBEAT_STALE` |
| Transport & LS | `agentapi_available === true` and `ls_address_present === true` | `AGENTAPI_UNAVAILABLE`, `LS_ADDRESS_MISSING` |
| Target Beacon | Valid JSON/schema, canonical `workspace_root` & `project_id` match, `0 <= target_age_ms < TARGET_OBSERVATION_TTL_MS` | `TARGET_MISSING`, `TARGET_MALFORMED`, `TARGET_FOREIGN_WORKSPACE`, `TARGET_FOREIGN_PROJECT`, `TARGET_FUTURE`, `TARGET_STALE` |
| Workspace Slot | No held task (`slot_available === true`) | `WORKSPACE_SLOT_HELD` |

### Compatibility Guarantees
- **CLI onboarding compatibility**: `bridgeDoctor` preserves `status: "READY" | "INCOMPLETE_ONBOARDING"` for file onboarding checks while adding `ready_to_dispatch`, `readiness_status`, `reason_codes`, `slot_available`, `heartbeat_age_ms`, `target_age_ms`, and `target_observation`.
- **Queued `submit_job` compatibility**: When `slot_available === true` and `ready_to_dispatch === false` (for example while waiting for Sidecar startup or a fresh GUI hook beacon), `submit_job` continues to queue `PENDING` jobs durably without creating a new conversation (`allow_new_conversation` defaults to `false`).

---

## 2. Per-Task Phase & Outcome-Separated Telemetry (`src/desktop-inbox/telemetry.mjs`)

`bridgeMetrics` (`node src/desktop-inbox/bridge-cli.mjs metrics`) derives timing metrics strictly from existing durable `desktop-inbox.record@1` state transitions (`record.events` and `record.delivery`) without altering inbox/report schemas.

### Measured Per-Task Phases (`PHASE_NAMES`)
1. `queue_to_claim_ms`: `PENDING` → `CLAIMED`
2. `claim_to_dispatch_ms`: `CLAIMED` → durable `DISPATCHED` intent (`beginDispatch`)
3. `transport_return_ms`: durable `DISPATCHED` intent → `Transport returned` event (or recorded `delivery.dispatched_at`)
4. `dispatch_to_report_ms`: `Transport returned` → `RESULT_READY`; `null` when the transport-return boundary is unknown. Legacy `worker_execution_ms` remains durable dispatch intent → `RESULT_READY`.
5. `report_to_verify_ms`: `RESULT_READY` → `VERIFIED`
6. `total_ms`: `PENDING` → `VERIFIED`

### Monotonicity, Epoch-Zero & Unsupported Timings
- Timestamp `0` (`1970-01-01T00:00:00.000Z`) is treated as a valid timestamp (`0` ms).
- Missing, malformed, or nonmonotonic intervals (`endMs < startMs`) evaluate to `null` and are **never** clamped to `0`.
- Summary objects report `{ count, average_ms, median_ms, p95_ms }` (`null` statistics when `count === 0`).
- Free-text worker findings/summaries are **never** parsed into host timings. Sub-worker intervals not durably recorded by host/inbox (`subtask_fanout_ms`, `subagent_wakeup_ms`) are explicitly listed in `unsupported_timings` and set to `null` in `task.unmeasured`.

### Outcome-Separated Aggregation (`outcome_groups` & `verified_phases`)
Tasks are partitioned into six mutually-exclusive buckets (`verified`, `released`, `failed`, `uncertain`, `cancelled`, `active`):
- `verified_phases` summarizes **only** `verified` tasks (`state === "VERIFIED" && outcome === null`), preventing earlier failed, uncertain, or released attempts from distorting successful turnaround metrics.
- Legacy top-level fields (`total_tasks`, `by_state`, `by_outcome`, `queue_to_dispatch_ms`, `worker_execution_ms`, `total_turnaround_ms`) remain intact for backward compatibility.

---

## 3. Verification Status (`LIVE-VERIFIED` Smoke vs `OFFLINE-TESTED` Optimization)

- **Live Smoke Verified (`v2.5.1`)**:
  - Job `1034dcb6-2545-49f9-b403-0454399aafb6` verified Windows Sidecar `ANTIGRAVITY_AGENTAPI_EXE` + `['agentapi', ...argv]` delivery, Hook Beacon targeting, Wave-1 parallel execution in Antigravity Desktop GUI, `report-cli.mjs --run-checks`, and `verify_job` acceptance. The earlier failed job was released with `verify_job(accepted=false)`.
- **Offline & Integration Tested (Current Milestone)**:
  - `src/desktop-inbox/readiness.mjs`, `src/desktop-inbox/telemetry.mjs`, updated `bridge-cli.mjs`, updated `live-mcp-server.mjs`, `tests/unit/desktop-inbox-readiness.test.mjs`, `tests/unit/desktop-inbox-telemetry.test.mjs`, and `tests/integration/live-desktop-bridge.test.mjs`.
  - **Runtime Reload Note**: Fresh CLI invocations (`node src/desktop-inbox/bridge-cli.mjs status|doctor|metrics`) execute the new readiness and telemetry code immediately. An already-open Codex Desktop MCP stdio server process loads updated `live-mcp-server.mjs` only when a fresh MCP session/thread starts; no live MCP reload is claimed until exercised in a new session.
  - **No Speedup Claims**: Timing metrics observe actual durable event intervals; no throughput or speedup claim is inferred from unit/integration fixtures or subagent counts.
