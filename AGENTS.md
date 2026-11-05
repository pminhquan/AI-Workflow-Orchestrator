# Maintenance contract

Đây là canonical workflow repository. Đọc [README](README.md), [architecture](docs/architecture/overview.md) và [manifest](config/deployment/components.json) trước khi sửa.

- Chỉ thay phần cần thiết, giữ concurrent edits. Không tạo team cho microtask.
- Giữ `foundation-only`: không sửa live V1 hoặc file ngoài project root. Live audit chỉ đọc theo allowlist.
- Không tự cài third-party agents, cập nhật upstream, tạo key/billing, publish, deploy hoặc restart ứng dụng.
- Không điều khiển consumer Antigravity qua external automation không được hỗ trợ. Legacy bridge chỉ audit và offline compatibility research trong V2.
- Generated config phải deterministic; chạy compiler và validate. Không sửa tay generated files.
- Mọi routing change cần tests. Adapter change cần capability validation và negative tests cho unsupported constraints.
- Role/personality prompt không cấp quyền. Không sửa global permissions, security hooks hoặc approval policies; không bỏ security gates để chạy nhanh hơn.
- Không gọi integration là working khi chưa chạy thật; phân biệt OFFLINE-TESTED, DESIGN-ONLY, UNSUPPORTED và NOT VERIFIED.
- Mọi activation/migration tương lai cần explicit scope, backup, diff, fresh checks và rollback theo [runbook](docs/operations/migration-rollback.md).
- Chỉ mock/replay được execution trong foundation; không kết nối V1 ledger, không tạo dispatcher thứ hai và không đọc worker capabilities/private sessions.

Verification: `node src/cli.mjs test`, `node src/cli.mjs validate`, `node src/cli.mjs verify-v1`. Không suy diễn speedup từ mock timing hoặc số lượng file/agent.

## Native Codex delegation

This project requests native subagents when useful: DIRECT for small work; DELEGATED for one bounded independent brief; TEAM for useful independent milestones, at most two concurrent workers and the host limit. Do not spawn for prompt length alone. Prefer built-in explorer/worker/default; parent owns integration and fresh verification. Never overlap write scopes or create nested teams.

For substantive work read [native guidance](agents/generated/codex-guidance/workflow.md), then only the matching canonical recipe in `workflows/recipes/`. Briefs need paths/ownership, dependencies, acceptance and evidence. If native tools are unavailable/prohibited, use DIRECT only when critical requirements remain satisfiable; otherwise BLOCKED. Custom TOML is staged, not discovered. Instructions and profiles inherit parent permissions and provide no filesystem isolation. Do not use Antigravity for V2 implementation or dispatch through the offline scheduler/MCP/agentapi. Native smoke evidence is separate from adapter verification.
