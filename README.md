# AI Workflow Orchestrator — Global Desktop Bridge

Canonical source for the offline core and the App-owned Desktop Bridge.

Đây là workflow giúp Codex và Antigravity phối hợp triển khai, kiểm chứng trong workspace hiện tại bằng cấu hình toàn máy.

**Offline core vẫn foundation; live Desktop Bridge là integration App-owned riêng.** Cài workflow một lần ở scope người dùng để Codex làm việc trong workspace hiện tại, tự chọn DIRECT/native/Antigravity và parent kiểm chứng. Không cần copy bridge vào từng project; xem [hướng dẫn global](docs/operations/global-desktop-bridge.md). Không có dashboard, key/billing mới hoặc dependency bên thứ ba.

## Chạy nhanh

Yêu cầu Node.js >=22; đã kiểm tra trên Windows với Node v26.13.0. Không cần `npm install`.

```powershell
Set-Location '<canonical-root>'
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

`node src/cli.mjs compile` tạo artifact deterministic trong `agents/generated/`, kiểm tra drift trước khi ghi đè file đã quản lý và lưu diff vào `state/compiler-diff.json`. Lần chạy lại không thay input phải có `diffs: []`. Core CLI không có install/apply/reload; global Desktop Bridge dùng installer riêng có receipt/rollback.

## Những gì hoạt động

- **WORKING:** doctor/inventory/validate/diff-config/plan-install/test/rollback-plan; staging compiler, checksum và provenance.
- **SESSION-VERIFIED:** native Codex delegation với hai default subagents chỉ đọc, parent đối chiếu source; xem [smoke evidence](docs/audit/v2.2-native-smoke.json). Không suy ra custom profile discovery hoặc native scheduler adapter đã working.
- **OFFLINE-TESTED V2.2:** host-native decision guidance, hai advisory review profiles, project-local bundle preview/diff/staging; không cài lên project khác.
- **V2.3:** target-bound staging và collision fixes; runnable isolated onboarding/update/manual rollback fixture. SIMPLE do main xử lý, MEDIUM có một native default reviewer thật. Fresh parent-session/custom discovery vẫn NOT VERIFIED; real project opt-in chưa chạy.
- **OFFLINE-TESTED:** sáu role, ba mode, năm recipe được router sử dụng; mock/replay scheduling, idempotency, DAG, scope conflicts, host receipts, freshness, retry/rework, cancellation và durable state một process.
- **SESSION-VERIFIED trên máy thử:** global Codex MCP/Boss discovery trong chat mới và hai job read-only tại hai workspace độc lập qua App-owned receiver, report và parent receipt thật. Runtime evidence giữ trong ignored state.
- **NOT VERIFIED:** custom native profiles/adapters, fresh Antigravity global skill/hook discovery, host-attested workspace roots và GUI focus.
- **UNSUPPORTED:** conversion làm mất hard constraints, unsupported consumer/headless automation, adapter không được triển khai hoặc xác minh.
- **DESIGN-ONLY:** activation của các offline scheduler adapters, native scheduler adapter, Gemini API, worktree creation/merge automation, benchmark AI thực và process isolation production.

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

`native-guide` chỉ trả advice, không spawn hoặc execute. Host fixture là synthetic observation cho unit tests, không phải runtime receipt. `bundle-stage` chỉ ghi `state/bundles/<project_id>`; existing target instructions/profiles luôn cần review. Opt-in này chỉ áp dụng cho staged native bundles; global Desktop Bridge không cần onboarding từng project.

V1 có checksum drift đã tồn tại trước V2.2. `test`, `doctor` và `verify-v1` tiếp tục báo lỗi gate này; không cập nhật baseline để đạt PASS. [V2.2 verification](docs/audit/v2.2-verification.json) phân biệt drift V1 và regression V2.

Runtime data nằm trong `state/` và bị Git ignore. Không đặt credentials, private transcripts hoặc bản sao SQLite V1 vào project. `legacy/` chỉ giữ reference/checksum và snapshot allowlist đã làm sạch.

## Legacy desktop inbox candidate — offline only

The older candidate (`src/desktop-inbox/sidecar.mjs` and its mock runner) remains **OFFLINE-TESTED**, disabled and separate from live V1. The supported App-owned path uses `live-mcp-server.mjs` and `live-sidecar.mjs`, described below. The official App-owned Sidecar surface documents sending to a supplied conversation ID; identifying the focused chat, installed-version compatibility and account/terms applicability remain **NOT VERIFIED**. The legacy mock runner keeps its live gate blocked; this does not describe the separate live App-owned modules.

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

The user-level installer registers `src/desktop-inbox/live-mcp-server.mjs` (`desktop_inbox`, no fixed workspace) with 7 tools (`bridge_status`, `submit_job`, `wait_job`, `get_job_status`, `get_job_result`, `verify_job`, `release_job`) so Codex acts as Boss (Orchestrator) and submits bounded read-only or write-scoped jobs directly into the open Antigravity Desktop GUI conversation:

- **Hook Beacon** (user-level hook → `src/desktop-inbox/hook-beacon.mjs`): records the active GUI `conversationId` per workspace on session/invocation events without manual UUID configuration. A fresh chat needs one initial hook event.
- **Wave-Parallel Subagent Fan-Out & Fast Stat Cache** (`src/desktop-inbox/subtask-planner.mjs` + `src/desktop-inbox/fast-snapshot.mjs`): lets Codex Boss bundle multi-module tasks into one `submit_job` with mathematically disjoint `subtasks` waves so Antigravity GUI spawns adaptive parallel `research` / `self` subagents in one turn (scaled to useful independent work and actual platform/payload bounds without an arbitrary two-worker or eight-subtask cap, while native/offline profiles keep their own limits), backed by a stat-cached bounded workspace snapshotter (64 MiB total, 16 MiB per file).
- **Live Sidecar** (`src/desktop-inbox/live-sidecar.mjs` + `integrations/antigravity-inbox/awo-bridge.sidecar.json`): watches `state/desktop-inbox-live/` with coalesced `fs.watch` wakeup and delivers a single-line trigger via `agentapi send-message <conversation_id> <trigger>` to the open GUI session.
- **Worker Pre-Check & Diagnostics CLI** (`src/desktop-inbox/report-cli.mjs --run-checks` + `src/desktop-inbox/bridge-cli.mjs`): runs `verification_commands` in parallel before reporting so Worker fixes issues before waking Codex Boss, plus `doctor` / `status` / `metrics` / `release-stuck` commands.
- **Global installer** (`scripts/install-global-desktop-bridge.mjs`): one-time `--dry-run`/`--install`/`--status`/`--uninstall` over six owned user-level targets with a durable receipt and exact rollback. New projects need no copied hooks, skills or MCP config. The older per-project `scripts/onboard-desktop-bridge.mjs` remains for legacy use.
- **Routing**: strict matching-workspace Beacon, or an explicitly chosen persistent receiving chat created from a parent-VERIFIED delivery. The receiver never changes the work root and grants no permission.

```powershell
node --test tests/integration/live-desktop-bridge.test.mjs
node src/desktop-inbox/bridge-cli.mjs doctor
node scripts/install-global-desktop-bridge.mjs --dry-run
```

Status: **OFFLINE-TESTED** with mocked transport, plus session evidence of read-only jobs to one chosen receiver for two other projects. Fresh Codex global discovery has been observed on the tested host. Fresh Antigravity global discovery, zero-interaction chat bootstrap, host-attested roots and GUI focus remain **NOT VERIFIED**. The V1 checksum drift above is a separate baseline. See the [operation guide](docs/operations/global-desktop-bridge.md). The offline Mock/Replay core above is independent of this live App-owned bridge.
