# AI Workflow Orchestrator 2.1 — Foundation

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
- **OFFLINE-TESTED:** sáu role, ba mode, năm recipe được router sử dụng; mock/replay scheduling, idempotency, DAG, scope conflicts, host receipts, freshness, retry/rework, cancellation và durable state một process.
- **NOT VERIFIED:** artifact native Codex/Antigravity theo tài liệu chính thức, chưa cài/chạy trong ứng dụng.
- **UNSUPPORTED:** conversion làm mất hard constraints, consumer external dispatch, adapter không được triển khai hoặc xác minh.
- **DESIGN-ONLY:** activation, real native orchestration, Gemini API, worktree creation/merge automation, benchmark AI thực và process isolation production.

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

Runtime data nằm trong `state/` và bị Git ignore. Không đặt credentials, private transcripts hoặc bản sao SQLite V1 vào project. `legacy/` chỉ giữ reference/checksum và snapshot allowlist đã làm sạch.
