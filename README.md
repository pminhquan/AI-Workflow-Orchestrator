# AI Workflow Orchestrator 2.3 — Practical validation / Foundation

Canonical repository: `<REVIEW_CHECKOUT>`.

**Foundation only. V2 chưa kích hoạt. V1 giữ nguyên.** Đây là công cụ CLI và thư viện offline nhỏ, không phải một dispatcher AI production. Không có dashboard, daemon, API key hoặc dependency bên thứ ba.

## Chạy nhanh

Yêu cầu Node.js >=22; đã kiểm tra trên Windows với Node v26.13.0. Không cần `npm install`.

```powershell
Set-Location '<REVIEW_CHECKOUT>'
node src/cli.mjs doctor
node src/cli.mjs validate
node src/cli.mjs route tests/fixtures/routing.json
node src/cli.mjs inventory
node src/cli.mjs diff-config
node src/cli.mjs plan-install
node src/cli.mjs rollback-plan
node src/cli.mjs test
node benchmarks/run.mjs
```

`node src/cli.mjs compile` tạo artifact deterministic trong `agents/generated/`, kiểm tra drift trước khi ghi đè file đã quản lý và lưu diff vào `state/compiler-diff.json`. Lần chạy lại không thay input phải có `diffs: []`. Không có lệnh install/apply/reload; mọi flag như `--apply` đều bị từ chối.

## Những gì hoạt động

- **WORKING:** doctor/inventory/validate/diff-config/plan-install/test/rollback-plan; staging compiler, checksum và provenance.
- **SESSION-VERIFIED:** native Codex delegation với hai default subagents chỉ đọc, parent đối chiếu source; xem [smoke evidence](docs/audit/v2.2-native-smoke.json). Không suy ra custom profile discovery hoặc native scheduler adapter đã working.
- **OFFLINE-TESTED V2.2:** host-native decision guidance, hai advisory review profiles, project-local bundle preview/diff/staging; không cài lên project khác.
- **V2.3:** target-bound staging và collision fixes; runnable isolated onboarding/update/manual rollback fixture. SIMPLE do main xử lý, MEDIUM có một native default reviewer thật. Fresh parent-session/custom discovery vẫn NOT VERIFIED; real project opt-in chưa chạy.
- **OFFLINE-TESTED:** sáu role, ba mode, năm recipe được router sử dụng; mock/replay scheduling, idempotency, DAG, scope conflicts, host receipts, freshness, retry/rework, cancellation và durable state một process.
- **NOT VERIFIED:** artifact native Codex/Antigravity theo tài liệu chính thức, chưa cài/chạy trong ứng dụng.
- **UNSUPPORTED:** conversion làm mất hard constraints, consumer external dispatch, adapter không được triển khai hoặc xác minh.
- **DESIGN-ONLY:** activation, native scheduler adapter, Gemini API, worktree creation/merge automation, benchmark AI thực và process isolation production.

## Đọc tiếp

- [Kiến trúc và trust boundaries](docs/architecture/overview.md)
- [Compiler và giới hạn quyền](docs/architecture/compiler.md)
- [Contracts và lifecycle](docs/architecture/contracts.md)
- [Research đã pin version](docs/research/upstream-evaluation.md)
- [V1 audit và migration mapping](docs/audit/v1-inventory.md)
- [Component manifest](config/deployment/components.json)
- [CLI và phục hồi](docs/operations/cli.md)
- [Migration/activation/rollback](docs/operations/migration-rollback.md)
- [Benchmark protocol](benchmarks/README.md)
- [Acceptance evidence](docs/audit/acceptance.md)
- [Native Codex guide và capability matrix](docs/operations/native-codex.md)
- [Onboarding project mới, dry-run và rollback](docs/operations/project-onboarding.md)
- [V2.2 initial review](docs/audit/v2.2-initial-review.md)
- [V2.3 review](docs/audit/v2.3-review.md), [native events index](docs/audit/v2.3-native.json), [regression evidence](docs/audit/v2.3-verification.json)
- [Legacy ADOPT/ADAPT/REJECT](docs/research/legacy-workflow-comparison.md) và [V1 bridge compatibility](docs/audit/v2.3-bridge-compatibility.md)

## Dùng trong Codex Desktop

Giao task bình thường tại GUI. `AGENTS.md` yêu cầu conditional delegation: DIRECT cho việc nhỏ, DELEGATED cho một brief độc lập, TEAM cho milestones độc lập với tối đa hai workers. Parent review và verify. Không cần gọi CLI mỗi microtask; không cần dashboard. Các quyền của parent vẫn áp dụng. Native profile staging chưa được cài/discover.

```powershell
node src/cli.mjs native-guide tests/fixtures/native-request.json tests/fixtures/native-host.json
node src/cli.mjs bundle-plan tests/fixtures/project-bundle.json
node src/cli.mjs bundle-stage tests/fixtures/project-bundle.json
```

`native-guide` chỉ trả advice, không spawn hoặc execute. Host fixture là synthetic observation cho unit tests, không phải runtime receipt. `bundle-stage` chỉ ghi `state/bundles/<project_id>`; existing target instructions/profiles luôn cần review. Onboarding từng project là opt-in riêng.

V1 có checksum drift đã tồn tại trước V2.2. `test`, `doctor` và `verify-v1` tiếp tục báo lỗi gate này; không cập nhật baseline để đạt PASS. [V2.2 verification](docs/audit/v2.2-verification.json) phân biệt drift V1 và regression V2.

Runtime data nằm trong `state/` và bị Git ignore. Không đặt credentials, private transcripts hoặc bản sao SQLite V1 vào project. `legacy/` chỉ giữ reference/checksum và snapshot allowlist đã làm sạch.

## Desktop inbox candidate — offline only

`src/desktop-inbox/` implements a bounded file inbox, mock Sidecar polling, preserved worker reports and fresh parent verification. It is **OFFLINE-TESTED**, disabled, and not connected to the routing registry or live V1. The official App-owned Sidecar surface documents sending to a supplied conversation ID; identifying the focused chat, installed-version compatibility and account/terms applicability remain **NOT VERIFIED**. Real dispatch is blocked in code, including when review flags are changed.

```powershell
node --test tests/unit/desktop-inbox*.test.mjs tests/integration/desktop-inbox.test.mjs
node scripts/desktop-inbox-smoke.mjs
node src/desktop-inbox/cli.mjs plan
```

The smoke uses a local mock executable and retains evidence in ignored state; it is not an Antigravity Desktop pilot. See the [implementation and activation review](docs/audit/desktop-inbox-bridge.md) for contracts, limits, one-time binding and rollback gates. No registration, global config change, installation or activation is performed.

## Project MCP / App receiver — staged

The earlier staged MCP server (`src/desktop-inbox/mcp-server.mjs`) exposes `submit_job`, `get_job_status` and
`get_job_result` over stdio, paired with the one-shot read-only `src/desktop-inbox/app-receiver.mjs`. See [binding, activation,
result watcher and rollback](docs/operations/desktop-mcp-relay.md).

## Live Codex Boss → Antigravity Desktop GUI Bridge

`.codex/config.toml` wires `src/desktop-inbox/live-mcp-server.mjs` (`desktop_inbox`) with 7 tools (`bridge_status`, `submit_job`, `wait_job`, `get_job_status`, `get_job_result`, `verify_job`, `release_job`) so Codex acts as Boss (Orchestrator) and submits bounded read-only or write-scoped jobs directly into the open Antigravity Desktop GUI conversation:

- **Hook Beacon** (`.agents/hooks.json` → `src/desktop-inbox/hook-beacon.mjs`): automatically captures the active GUI `conversationId` per workspace on `SessionStart` and `PreInvocation` without manual UUID configuration.
- **Wave-Parallel Subagent Fan-Out & Fast Stat Cache** (`src/desktop-inbox/subtask-planner.mjs` + `src/desktop-inbox/fast-snapshot.mjs`): lets Codex Boss bundle multi-module tasks into one `submit_job` with mathematically disjoint `subtasks` waves so Antigravity GUI spawns parallel `research` / `self` subagents in one turn, backed by a stat-cached `<5ms` workspace snapshotter.
- **Live Sidecar** (`src/desktop-inbox/live-sidecar.mjs` + `integrations/antigravity-inbox/awo-bridge.sidecar.json`): watches `state/desktop-inbox-live/` with coalesced `fs.watch` wakeup and delivers a single-line trigger via `agentapi send-message <conversation_id> <trigger>` to the open GUI session.
- **Worker Pre-Check & Diagnostics CLI** (`src/desktop-inbox/report-cli.mjs --run-checks` + `src/desktop-inbox/bridge-cli.mjs`): runs `verification_commands` in parallel before reporting so Worker fixes issues before waking Codex Boss, plus `doctor` / `status` / `metrics` / `release-stuck` commands.
- **Multi-Project Onboarding** (`scripts/onboard-desktop-bridge.mjs`): bootstraps `.agents/hooks.json`, `.agents/skills/`, and `.codex/config.toml` into any local repository while sharing the single `AWO Desktop Bridge` sidecar.

```powershell
node --test tests/integration/live-desktop-bridge.test.mjs
node src/desktop-inbox/bridge-cli.mjs doctor
node scripts/onboard-desktop-bridge.mjs <REVIEW_CHECKOUT> --dry-run
```
