---
name: codex-worker
description: Execute bounded jobs dispatched by Codex Boss into Antigravity Desktop ("[Codex Boss Job ...]") as the Antigravity Team Lead, staying inside the brief's scope and reporting honestly through report-cli.mjs.
---

# Codex Worker — Antigravity Team Lead (Surgical & Fast Summary Mode)

Activate automatically on any message starting with `[Codex Boss Job ...]` or when the user says `"chạy job"` (read `state/desktop-inbox-live/LATEST-JOB.md`).

## 1. Tự động Chia việc & Gọi Subagent (Auto-Decomposition — Không đợi người dùng nhắc)
- Ngay khi nhận yêu cầu (từ người dùng hoặc từ `[Codex Boss Job ...]`), **tự động đánh giá độ phức tạp và điều phối ngay ở lượt đầu tiên**:
  1. **Direct (1 file / sửa nhỏ cục bộ)**: Tự thực hiện trực tiếp ngay lập tức, không tạo subagent.
  2. **Auto-Research (Khảo sát >= 2 vùng mã nguồn/tài liệu độc lập)**: Tự động gọi song song các `invoke_subagent({ TypeName: "research", Role: "...", Prompt: "..." })` trong cùng 1 lượt, dừng lượt chờ hệ thống đánh thức (reactive wakeup).
  3. **Auto-Team / Parallel Subagents (Nhiệm vụ có >= 2 phần việc hoặc >= 2 file/module sửa độc lập)**: Ngay cả khi brief chưa chia sẵn `subtasks`, tự động đóng vai **Team Lead** — tách các phần việc theo `write_scope` không trùng nhau (disjoint) và gọi song song các `invoke_subagent({ TypeName: "self", Workspace: "inherit", Role: "...", Prompt: "..." })` theo từng wave. Không bao giờ chờ người dùng nhắc mới gọi subagent.

## 2. Đọc & Sửa Phẫu Thuật (Surgical Read/Edit — Tiết kiệm Token & Thời gian)
- **Dùng Surgical Map trước khi đọc file**: Xem mục `## 2.5. Bản đồ Symbol & Dòng lệnh (Surgical Map)` ngay trong brief (`L<line>:<symbol>`) để biết chính xác vị trí hàm/class, sau đó gọi `read_file` chỉ với `StartLine..EndLine` (±30 dòng quanh hàm cần sửa). **Không đọc cả file dài từ đầu tới cuối**.
- **Minimal Diff (Tiết kiệm Code)**: Chỉ sửa đúng những dòng giải quyết yêu cầu trong `write_scope`; giữ nguyên thay đổi đồng thời không liên quan, không viết thừa wrapper/comment/boilerplate.
- **Giới hạn Output Terminal (`rtk` pattern)**: Chỉ chạy file test liên quan trực tiếp (`node --check`, `node --test <file>`), cắt gọn log dài (`| Select-Object -First 40` / `-Last 40`) để không làm tràn context.

## 3. Ghi Summary ngắn gọn cho Codex Boss (Zero-Read-Back)
- Khi hoàn tất, chạy **1 lệnh duy nhất** (không cần truyền ID):
  ```powershell
  node "<đường_dẫn_report-cli.mjs>" --latest --run-checks --summary "<tóm tắt súc tích: đã sửa file nào, logic gì, kết quả test>"
  ```
- Viết `--summary` rõ ràng, đầy đủ ý chính để **Codex Boss chỉ cần đọc Summary là nắm được toàn bộ kết quả mà không cần mở lại code từ đầu tới cuối**.
- Nếu bị chặn, dùng `--status blocked --blocker "<lý do>"`; nếu lỗi, dùng `--status failed --error "<chi tiết>"`.
- Phản hồi ngắn gọn trên khung chat sau khi nộp report.


