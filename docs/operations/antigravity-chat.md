# Giao việc qua chat Antigravity

Chọn project, chat và model trong Antigravity. Codex gửi brief qua MCP `antigravity_gui` vào ô nhập đang mở. Người dùng tiếp tục làm việc ở cửa sổ hiện tại. Sender xác nhận prompt xuất hiện trong chat hoặc hàng chờ của app.

## Cài một lần

```powershell
node scripts/install-chat-jobs.mjs --install --dry-run
node scripts/install-chat-jobs.mjs --install
```

Bộ cài quản lý một mục MCP và một skill của Codex, cùng đoạn hướng dẫn có marker. Backup và receipt nằm trong `state/antigravity-gui-install/`. Dùng `--uninstall` để rollback.

MCP cung cấp `inspect_gui`, `submit_job` và `job_status`. CLI gọi cùng sender và dùng được trong phiên chưa nạp MCP.

```powershell
node src/chat-jobs.mjs inspect
node src/chat-jobs.mjs submit --workspace (Get-Location).Path --request-file "state/request.txt" --job-id "<UUID>"
node src/chat-jobs.mjs status --workspace (Get-Location).Path --job "<job_path trả về>"
```

## Theo dõi job

Mỗi job có một file trong `state/antigravity-status/YYYY-MM-DD/`. Anti dùng file tạm cùng thư mục rồi đổi tên thay file status để Codex luôn đọc được JSON hoàn chỉnh. Các trường cần cập nhật là `state`, `summary`, `changed_files` và `checks`. `job_status` trả kết quả gọn và trạng thái gửi, kèm model được đọc từ GUI. Codex làm phần việc độc lập và đọc status mỗi 5 phút.

Nếu đặt `state` thành `blocked`, Anti ghi lý do và bước tiếp theo trong `summary`. Codex đọc được nguyên nhân từ chính file job.

Sender đọc ô chat và nút Send qua Windows UI Automation rồi gửi thông điệp vào cửa sổ đích. Nó cần một cửa sổ Antigravity không thu nhỏ với một ô nhập xác định. Đối chiếu project dựa vào tên hiển thị trong app, vì vậy tên project cần phân biệt được với các workspace khác. Bản nháp có sẵn được giữ. Brief được nhập đầy đủ dưới dạng một dòng, tối đa 8000 ký tự gồm phần hướng dẫn status. File job giữ định dạng gốc.

Lần gửi có kết quả `not_sent` có thể thử lại với cùng UUID sau khi xử lý lý do. Nếu lần đầu đã điền prompt nhưng dừng trước Submit, sender nhận diện đúng prompt đó khi thử lại. Với `uncertain`, đối chiếu chat hoặc status trước khi quyết định giao lại.
