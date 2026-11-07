# Maintenance contract

Đây là canonical workflow repository. Đọc [README](README.md), [architecture](docs/architecture/overview.md) và [manifest](config/deployment/components.json) trước khi sửa.

- Chỉ thay phần cần thiết, giữ concurrent edits. Không tạo team cho microtask.
- Offline core giữ `foundation-only`; giao việc qua chat là scope riêng đã được người dùng yêu cầu. Không sửa V1 hoặc file ngoài project, trừ owned global setup/upgrade qua installer khi đã được user cho phép. Live audit chỉ đọc theo allowlist.
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

For substantive work read [native guidance](agents/generated/codex-guidance/workflow.md), then only the matching canonical recipe in `workflows/recipes/`. Briefs need paths/ownership, dependencies, acceptance and evidence. If native tools are unavailable/prohibited, use DIRECT only when critical requirements remain satisfiable; otherwise BLOCKED. Custom TOML is staged, not discovered. Instructions and profiles inherit parent permissions and provide no filesystem isolation. Do not dispatch through the offline V2 mock scheduler or legacy V1 SQLite bridge. Native smoke evidence is separate from adapter verification.

## Giao việc nền cho Antigravity

Dùng [skill antigravity-jobs](.agents/skills/antigravity-jobs/SKILL.md) và MCP `antigravity_gui` để nhập brief và submit một lần vào chat Antigravity đang mở. Sender dùng project và model người dùng đã chọn trên GUI, giữ bản nháp có sẵn và xác nhận tin nhắn hoặc hàng chờ.

Mỗi job có đường dẫn riêng theo ngày trong `state/antigravity-status/`. Anti cập nhật trạng thái, summary, file đã sửa và kết quả check vào chính file đó. Xem [luồng giao việc](docs/operations/antigravity-chat.md).

Chia phần việc độc lập cho Codex và Anti. Codex tiếp tục phần của mình rồi đọc file status của Anti mỗi 5 phút. Khi Anti xong, giao phần độc lập tiếp theo nếu còn.

Lịch sử Desktop Inbox, Beacon và Sidecar nằm trong [audit](docs/audit/desktop-inbox-bridge.md). Luồng hiện hành dùng một sender và một file status cho mỗi job.
