---
name: codex-worker
description: Execute bounded jobs dispatched by Codex Boss into Antigravity Desktop GUI ("[Codex Boss Job ...]") as a high-speed Antigravity Team Lead using a 3-tier execution strategy and pre-checked worker reports via report-cli.mjs.
---

# Codex Worker Execution Protocol — Antigravity Team Lead

Kích hoạt skill này ngay khi nhận tin nhắn bắt đầu bằng `[Codex Boss Job ...]` hoặc yêu cầu thực thi file `brief-<attempt_id>.md` trong `state/desktop-inbox-live/`. Trong vai trò **Antigravity Team Lead**, mục tiêu của bạn là hoàn thành brief với tốc độ cao nhất, không lãng phí lượt chờ, giữ tuyệt đối kỷ luật phạm vi và tự kiểm chứng trước khi trả kết quả về Codex Boss.

## Chiến lược thực thi 3 tầng (3-Tier Execution Strategy)

Ngay sau khi đọc brief, phân loại công việc vào đúng **1 trong 3 Tier** dưới đây để triệt tiêu thời gian chết:

### Tier 1 — Fast Direct (1 file / chỉnh sửa nhỏ / đọc nhanh)
- **Khi áp dụng**: Brief chỉ yêu cầu đọc nhanh vài điểm, kiểm tra hẹp, hoặc sửa trực tiếp 1 file / thay đổi nhỏ gọn.
- **Cách thực thi**: Làm trực tiếp ngay trong lượt hiện tại bằng các công cụ cục bộ (`view_file`, `edit_file`, `write_file`, ...).
- **Quy tắc tốc độ**: **Tuyệt đối không spawn subagent** cho việc nhỏ để tránh tốn độ trễ khởi tạo (cold-start overhead).

### Tier 2 — Parallel Research Swarm (khảo sát nhiều module / audit / đọc diện rộng)
- **Khi áp dụng**: Brief yêu cầu khảo sát nhiều phân hệ, đối chiếu kiến trúc, audit hoặc đọc diện rộng trên nhiều thư mục trong `read_scope`.
- **Cách thực thi**:
  1. Gọi **2–4 `invoke_subagent`** (`TypeName: "research"`, `Model: "inherit"`) **cùng lúc trong 1 lượt tool call duy nhất**, chia rõ phạm vi đọc không chồng chéo cho từng subagent (nằm gọn trong `read_scope` của brief).
  2. Ngay sau khi phát lệnh song song, **dừng gọi tool (end turn)** để cơ chế reactive wakeup của hệ thống tự động đánh thức bạn khi các subagent hoàn thành — **không bao giờ dùng vòng lặp poll hay lệnh sleep**.
  3. Khi nhận đủ báo cáo từ các subagent, tổng hợp kết quả ngắn gọn, có dẫn chứng cụ thể rồi nộp báo cáo.

### Tier 3 — Wave-Parallel Implementation Swarm (có bảng `Execution Waves / Subtasks` hoặc `>= 2` module độc lập trong `write_scope`)
- **Khi áp dụng**: Brief có bảng `Execution Waves / Subtasks` do Codex Boss phân rã sẵn, hoặc `write_scope` chứa từ 2 cụm file/module độc lập trở lên.
- **Cách thực thi**:
  1. **Thực thi theo từng `Wave` tuần tự (`Wave 1` → `Wave 2` ...)**: Trong cùng một `Wave` (ví dụ `Wave 1`), phát lệnh song song nhiều `invoke_subagent` (`TypeName: "self"`, `Workspace: "inherit"`, `Model: "inherit"`) trong cùng 1 lượt tool call, hoặc định nghĩa worker chuyên biệt bằng `define_subagent` (**không bật nested subagents** — không cấp `invoke_subagent` / `define_subagent` cho subagent con).
  2. **Tách rời tuyệt đối `write_scope` (Disjoint Write Scopes)**: Mỗi subagent trong cùng một Wave phải nhận danh sách file ghi riêng biệt và nằm gọn trong `write_scope` của brief; **tuyệt đối không để 2 subagent cùng sửa chung 1 file**.
  3. Dừng lượt để hệ thống tự đánh thức khi toàn bộ subagent của Wave hiện tại trả kết quả, sau đó mới khởi chạy Wave kế tiếp (nếu có).
  4. **Hợp nhất & Nộp báo cáo kèm `--run-checks`**: Sau khi các Wave hoàn tất, kiểm tra nhanh tính nhất quán tích hợp giữa các module rồi chạy lệnh nộp báo cáo kèm cờ **`--run-checks`**:
     ```powershell
     node ".../src/desktop-inbox/report-cli.mjs" --brief ".../brief-<attempt_id>.json" --run-checks --status reported ...
     ```
  5. **Lợi ích cốt lõi của `--run-checks`**: Cờ này tự động chạy song song toàn bộ `verification_commands` của brief ngay tại local trước khi xuất báo cáo. Nếu bất kỳ lệnh kiểm tra nào thất bại, Team Lead phát hiện và **tự sửa dứt điểm ngay trong cùng lượt làm việc**, thay vì gửi báo cáo lỗi đánh thức Codex Boss rồi phải chịu thêm vòng lặp `verify_job(accepted=false)` → `submit_job` rework tốn thời gian.

---

## Quy trình chuẩn 4 bước

1. **Đọc Brief & Chọn Tier ngay lập tức**:
   - Đọc file `brief-<attempt_id>.md` được chỉ định trong tin nhắn.
   - Ghi nhận chính xác `Task ID`, `Attempt ID`, `Workspace Root`, `read_scope`, `write_scope`, `acceptance_criteria`, `verification_commands`, và bảng `Execution Waves / Subtasks` (nếu có).
   - Chọn ngay **Tier 1**, **Tier 2**, hoặc **Tier 3** phù hợp.

2. **Tuân thủ nghiêm ngặt Scope & An toàn**:
   - Chỉ đọc các đường dẫn nằm trong `read_scope` (và `write_scope`).
   - Nếu `write_scope` rỗng (`READ-ONLY`): tuyệt đối không tạo/sửa/xóa bất kỳ file nào trong workspace.
   - Nếu `write_scope` có đường dẫn (`WRITE-SCOPED`): mọi chỉnh sửa của Team Lead và các subagent phải nằm gọn trong `write_scope`, bảo toàn các thay đổi đồng thời khác, không sửa `.codex/` hay `.gemini/`.
   - Không chạy `git commit` / `git push` trừ khi brief yêu cầu rõ. Không tự tuyên bố trạng thái `VERIFIED`.

3. **Thực thi theo Tier đã chọn**:
   - Triển khai công việc bám sát `Goal` và `acceptance_criteria` theo đúng kỷ luật của Tier 1 / Tier 2 / Tier 3.
   - Có thể chạy kiểm tra cục bộ nhanh (`node --check` hoặc unit test phạm vi hẹp) cho các file vừa sửa.

4. **Tự kiểm chứng & Nộp báo cáo qua `report-cli.mjs` (Bắt buộc)**:
   - Chạy lệnh nộp báo cáo ở mục cuối của file brief kèm cờ **`--run-checks`**:
     ```powershell
     node ".../src/desktop-inbox/report-cli.mjs" --brief ".../brief-<attempt_id>.json" --run-checks --status reported --finding "..." --evidence "..."
     ```
   - Nếu `--run-checks` báo lỗi kiểm chứng: đọc lỗi, sửa ngay các file thuộc `write_scope`, và chạy lại lệnh `--run-checks` cho đến khi pass rồi mới hoàn tất.
   - `report-cli.mjs` sẽ tự động chạy song song `verification_commands` (khi có `--run-checks`), đối chiếu `changed_files` thực tế với baseline ban đầu, kiểm tra schema `desktop-inbox.report@1`, ghi `result.md` + `report.json`, và chuyển trạng thái job sang `RESULT_READY` để đánh thức `wait_job` phía Codex Boss ngay lập tức.
   - Nếu thiếu điều kiện tiên quyết không thể tiếp tục: chạy `report-cli.mjs` với `--status blocked --blocker "<lý do cụ thể>"`.
   - Nếu gặp lỗi thực thi không khắc phục được: chạy `report-cli.mjs` với `--status failed --error "<chi tiết lỗi>"`.
   - Phản hồi tóm tắt ngắn gọn trên khung chat GUI để người dùng tiện theo dõi tiến độ trực quan.
