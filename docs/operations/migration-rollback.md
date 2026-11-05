# Migration, activation và rollback

## Hiện tại

V2 foundation chỉ là source-of-truth cho definitions mới và offline tooling. Chưa thay thế ownership của live V1 runtime/config. Component manifest phân loại `legacy-reference`, `staged`, `app-owned`; không có file live nào được chuyển sang quyền quản lý V2. `plan-install` không có apply path.

## Activation tương lai — DESIGN-ONLY

1. User chọn scope/provider chính thức và duyệt native integration độc lập. Research lại docs/version/policy; xác nhận cài đặt thực tế và quyền của parent session. Không bật consumer wrapper hoặc lấy login token.
2. Chạy doctor/validate/test/verify-v1; xem semantic diff của canonical, staged và installed config. Xác định chủ sở hữu từng section/file và những concurrent edits.
3. Tạo backup có kiểm soát theo allowlist, checksum và restore manifest; secrets vẫn do app lưu, không đưa vào Git. Snapshot hiện tại đã làm sạch không đủ để rollback nguyên config có secrets.
4. Chạy riêng native smoke trial qua phương thức được hỗ trợ, không bật scheduler live. Xác nhận exact tool names, inherited MCP/permissions và read/write isolation bằng negative tests. Khi không express được hard constraint, giữ UNSUPPORTED.
5. Nếu sau này cần ghi code song song, dùng native worktree tool được hỗ trợ, explicit file ownership, dependency graph và integration owner. Worktree chỉ tách Git edits, không thay OS sandbox; tránh same-path conflicts.
6. Tạo installation plan cụ thể cho từng owned target, backup/diff/rollback. Chỉ activation sau scope mới của user; không bulk replace global AGENTS, `.codex`, `.gemini` hoặc application settings.
7. Nếu migrate ledger, thiết kế riêng offline sanitized export/validation và cutover. Chỉ một dispatcher sở hữu ledger; không kết nối V2 vào SQLite V1. Không migrate worker capabilities hoặc private conversations.
8. Đo trial jobs thực theo benchmark protocol trước khi quyết định dùng nhiều worker mặc định. Không dựa vào mocked latency hoặc stars.

## Rollback

Lần build này không sửa live, nên không có live rollback cần thực hiện. Có thể giữ hoặc archive repository mà V1 không đổi.

Khi activation tương lai thất bại: dừng nhận việc V2 bằng control được hỗ trợ, giữ evidence/in-flight status, không giả vờ cancellation đã dừng agent. So sánh installed hash với activation backup; restore chỉ owned files/marked sections, preserve concurrent user edits. Remove chỉ profiles do V2 cài nếu trước đó không tồn tại; kiểm tra V1 source/config hashes và app health. Không khôi phục toàn bộ app-owned auth/settings/ledger từ bản snapshot đã làm sạch.

## Policy blockers

- [Google FAQ](https://antigravity.google/docs/faq) không hỗ trợ wrapping consumer headless `agy` bên trong third-party coding agents; dùng supported native workflow hoặc official Gemini API theo scope riêng.
- [Teamwork docs](https://antigravity.google/docs/teamwork/) hiện dùng `/teamwork`, khác tên preview trong brief. Slash command không chứng minh externally callable API hay account entitlement trên máy này.
- [OpenAI subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) kế thừa parent permissions. Per-agent read-only prompt không tạo sandbox riêng.
- Không có API key/billing/provider integration trial trong foundation; capability availability để unknown và execution disabled.
