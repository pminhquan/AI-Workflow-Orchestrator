---
name: antigravity-orchestrator
description: Orchestrate high-throughput tasks as Codex Boss by batching wave subtasks, running dual-engine parallel work alongside Antigravity Desktop GUI via desktop_inbox MCP, and performing single-pass independent verification.
---

# Codex Boss → Antigravity Desktop GUI High-Throughput Orchestration

Sử dụng skill này khi đóng vai trò **Codex Boss (Orchestrator)** điều phối công việc sang cửa sổ **Antigravity Desktop GUI** đang mở của người dùng thông qua MCP server `desktop_inbox`.

## Nguyên tắc nền tảng

- Người dùng tự chọn **Workspace** và **Model** trực tiếp trên giao diện Antigravity Desktop GUI. Không yêu cầu xác minh UUID project thủ công hay đổi model tự động.
- Việc siêu nhỏ (1–2 dòng sửa nhanh, tra cứu tức thì): xử lý `DIRECT` tại chỗ để tránh độ trễ điều phối không cần thiết.
- Mỗi workspace tại một thời điểm chỉ giữ **tối đa 1 job đang active** trên GUI để tránh xung đột snapshot/ghi file. Khi có nhiều đầu việc độc lập trong cùng milestone, **gom chúng vào mảng `subtasks` theo `wave` trong 1 lệnh `submit_job` duy nhất** thay vì gửi rời rạc nhiều job nhỏ.

## 4 Chiến thuật tăng tốc thông lượng tối đa (High-Throughput Playbook)

1. **Chống chia nhỏ vụn vặt (Anti-Drip-Feeding — Gom Wave `subtasks`)**:
   - Thay vì gửi 3–5 job nhỏ nối tiếp nhau qua MCP làm tốn nhiều vòng chờ khứ hồi, hãy gom các phần việc cùng milestone vào **1 lệnh `submit_job` duy nhất kèm mảng `subtasks`**:
     `[{ id, title, agent_type: "research"|"implementer"|"tester"|"reviewer", wave: 1, read_scope, write_scope, goal }]`.
   - MCP server `desktop_inbox` sẽ **kiểm tra toán học tự động** đảm bảo các subtask có cùng số `wave` hoàn toàn tách rời `write_scope` (không đụng file nhau) và nằm gọn trong scope tổng của job.
   - Phía Antigravity Desktop GUI (ở chế độ **Antigravity Team Lead**) sẽ đọc bảng Wave và tự bung dàn subagent chạy song song ngay trong 1 lượt!

2. **Phối hợp song song kép (Dual-Engine Parallelism: Codex + Antigravity chạy đồng thời)**:
   - Ngay sau khi gọi `submit_job` đẩy khối lượng việc nặng (triển khai đa module, UI, hoặc khảo sát diện rộng) sang Antigravity GUI, **trước khi gọi `wait_job` (hoặc song song trong thời gian GUI đang xử lý)**, Codex Boss hãy chủ động tự đọc/chuẩn bị module kế tiếp, thiết kế phương án tích hợp, hoặc dùng native `explorer` của Codex để rà soát phần phụ thuộc (miễn không ghi đè vào `write_scope` đang giao cho GUI) — tận dụng 100% thời gian chờ!

3. **Giảm tối đa lệnh thừa (Lean Turn Discipline)**:
   - Chỉ cần gọi `bridge_status` **1 lần ở đầu phiên** (hoặc khi nghi ngờ kẹt task / đổi phiên GUI), không gọi lặp lại trước mỗi lần `submit_job`.
   - Khi Antigravity Worker nộp báo cáo kèm cờ `--run-checks`, toàn bộ `verification_commands` đã vượt qua kiểm tra sơ bộ ngay tại worker. Nhờ đó chu trình nghiệm thu rút gọn tối đa: `wait_job` → đọc nhanh diff chính (`actual_changed_files`) → `verify_job({ task_id, accepted: true, review_notes: [...] })` gọn trong **1 nhịp**.

4. **Công cụ chẩn đoán nhanh (Fast Telemetry & Recovery CLI)**:
   - Khi cần kiểm tra nhanh telemetry cầu nối hoặc gỡ task bị kẹt trực tiếp từ terminal, dùng ngay:
     - `node src/desktop-inbox/bridge-cli.mjs status` — xem nhanh trạng thái beacon, sidecar, task đang chạy và thống kê telemetry.
     - `node src/desktop-inbox/bridge-cli.mjs release-stuck` — gỡ kẹt nhanh các job treo/dở dang để giải phóng slot cho phiên làm việc mới.
     - `node src/desktop-inbox/bridge-cli.mjs doctor --workspace <path>` — kiểm tra tổng thể cấu hình sẵn sàng của workspace.

---

## Quy trình điều phối tinh gọn trên MCP `desktop_inbox`

1. **Khởi động phiên (`bridge_status` — 1 lần đầu phiên)**:
   - Kiểm tra `active_gui_target` (đã có `conversation_id` từ Hook Beacon chưa), `sidecar_running` (Sidecar `AWO Desktop Bridge` đã chạy chưa), và `available_checks` (`noop`, `validate`, `unit-desktop-inbox`, ...).
   - Nếu `active_task` còn kẹt từ phiên cũ, gọi `release_job` (hoặc chạy `node src/desktop-inbox/bridge-cli.mjs release-stuck`) để giải phóng slot.

2. **Giao việc gom theo Wave (`submit_job`)**:
   - Truyền đầy đủ:
     - `request`: mục tiêu tổng thể của milestone, ngữ cảnh kỹ thuật và quy ước tích hợp.
     - `read_scope`: mảng đường dẫn tương đối Worker được phép đọc (ít nhất 1 đường dẫn).
     - `write_scope`: `[]` nếu chỉ đọc, hoặc hợp (union) tất cả đường dẫn tương đối Worker/subtasks được phép tạo/sửa.
     - `subtasks` *(khuyến nghị khi có `>= 2` phần việc độc lập)*: mảng `{ id, title, agent_type: "research"|"implementer"|"tester"|"reviewer", wave: 1, read_scope, write_scope, goal }` với `write_scope` tách rời tuyệt đối giữa các subtask cùng `wave`.
     - `acceptance_criteria`: các tiêu chí nghiệm thu cụ thể, kiểm chứng được.
     - `verification_commands`: chọn từ `available_checks` (ví dụ `["unit-desktop-inbox"]`, `["validate"]`, hoặc `["noop"]` cho task thuần đọc).
   - Nếu `sidecar_running = false`, nhắc người dùng bật **"AWO Desktop Bridge"** trong Automations Dashboard của Antigravity (hoặc dán `single_line_trigger` vào khung chat GUI).

3. **Tận dụng song song kép & Chờ theo sự kiện (`wait_job`)**:
   - Tranh thủ thực hiện phần đọc/chuẩn bị độc lập trên Codex (Dual-Engine Parallelism), sau đó gọi `wait_job({ task_id, timeout_sec: 75 })`.
   - Nếu trả về `timed_out: true` và trạng thái vẫn là `DISPATCHED` (swarm đang chạy Wave lớn), gọi lại `wait_job` thêm chu kỳ nữa.

4. **Đọc nhanh Diff & Nghiệm thu 1 nhịp (`get_job_result` → `verify_job`)**:
   - Đối chiếu kết quả báo cáo (`status === "reported"`, `changed_files` / `actual_changed_files`, kết quả `--run-checks` trong `tests`) và đọc lướt các diff trọng yếu (gọi `get_job_result` nếu cần xem chi tiết đầy đủ).
   - **Nếu đạt yêu cầu**: gọi ngay `verify_job({ task_id, accepted: true, review_notes: [...] })` để host chạy kiểm chứng độc lập cuối cùng và đóng dấu `VERIFIED`.
   - **Nếu cần sửa lại**: gọi `verify_job({ task_id, accepted: false, review_notes: [...] })` (tự động giải phóng slot sang `RELEASED`) rồi gửi `submit_job` mới với yêu cầu rework cụ thể.
