# Workflow checkpoint — 2026-11-06

This checkpoint preserves the Windows Desktop bridge v2.5.1 and the reviewed readiness/telemetry milestone. Continue development in the canonical repository; GitHub contains the sanitized publication snapshot described in [private-publication.md](private-publication.md).

## Verified evidence

- Read-only live smoke `1034dcb6-2545-49f9-b403-0454399aafb6`: actual Antigravity GUI delivery, two concurrent Wave-1 research workers, report with pre-checks, independent host acceptance, state `VERIFIED`.
- Write-scoped milestone `77838105-536f-4c94-bf25-c3856620a695`: two implementers with disjoint ownership, Team Lead integration, independent review and fresh host acceptance, state `VERIFIED`; eight source/test/document paths changed.
- Source includes shared readiness reasons and finite beacon TTL, per-task phase metrics and outcome-separated summaries. Clock sampling occurs after reading observations; an unknown transport-return boundary stays `null`.
- Latest canonical full suite before publication preparation: 184 tests, 183 pass, one existing V1 checksum drift failure. Validation passes with `generated_drift: []`. Never rewrite the private V1 baseline to make the suite green.
- Fresh CLI and freshly imported MCP handlers exercised the new readiness code. The already-connected MCP process still requires a new session/reload to load the revised module. No performance speedup is established.

## Publication and local state

Runtime reports, private V1 snapshots, machine-bound hook/Sidecar/binding files and machine-specific pilot audit documents remain local. The exact publication exclusions are recorded in `config/publication/allowlist.json`; source implementation and test files remain byte-identical in the export.

The sanitized snapshot cannot validate the private V1 baseline or execute legacy deployment-plan tests that require omitted machine-bound manifests. Report those limitations separately from canonical verification. The live bridge is not automatically installed or activated by cloning this snapshot. Generate local project hooks/MCP configuration using `scripts/onboard-desktop-bridge.mjs`; review and configure App-owned Sidecar registration separately.

## Next optimization scope

1. Reload the MCP session and verify the new readiness output through the connected tools.
2. Compare DIRECT and parallel execution on equivalent bounded tasks using measured phases; do not infer speedup from mock timings.
3. Enforce the two-worker limit consistently and add same-wave read/write dependency checks.
4. Extend live reliability evidence and Sidecar uptime/restart diagnostics without automatic retries after uncertain delivery.
