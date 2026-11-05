# AI Workflow Orchestrator 2.2 — Native guidance / Foundation

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
