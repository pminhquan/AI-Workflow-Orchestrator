# Global Desktop Bridge

Cài bridge một lần ở phạm vi người dùng. Codex giữ workspace và phạm vi của từng job; Antigravity nhận brief, thực hiện và nộp báo cáo. Parent kiểm tra thay đổi và chạy lại checks trước khi nghiệm thu.

## Cài và rollback

Chạy từ canonical repository:

```powershell
node scripts/install-global-desktop-bridge.mjs --dry-run
node scripts/install-global-desktop-bridge.mjs --install
node scripts/install-global-desktop-bridge.mjs --status
node scripts/install-global-desktop-bridge.mjs --uninstall --dry-run
```

Installer sở hữu sáu mục tiêu ở phạm vi người dùng, mỗi mục chỉ merge phần của nó:

| Mục tiêu | Nội dung sở hữu |
|---|---|
| `~/.codex/config.toml` | Khối đánh dấu `desktop_inbox` MCP, không đặt `cwd` hoặc `--workspace` |
| `~/.codex/AGENTS.md` | Mục hướng dẫn workflow mặc định có marker `awo-global-workflow` |
| `~/.agents/skills/antigravity-orchestrator/` | Boss skill |
| `~/.gemini/config/hooks.json` | Hook `awo-desktop-bridge-beacon` |
| `~/.gemini/config/skills/codex-worker/` | Worker skill |
| `~/.gemini/config/sidecars/` | Một Sidecar tương thích; dùng lại registration có sẵn, từ chối nhiều registration trùng |

Mỗi thay đổi có backup và receipt trong ignored `state/desktop-inbox-live/global-install/`. Dùng nguyên `rollback_command` trong receipt để gỡ đúng installation. Rollback chỉ đảo phần đã sở hữu, giữ các chỉnh sửa không liên quan và file tương thích đã có từ trước. Owned content bị sửa sẽ cần review. Receipt được ghi trước config; kể cả lỗi giữa lúc ghi file và cập nhật tiến độ vẫn có thể rollback. Installer không đổi auth, model, permission, approval hay sandbox.

Project mới không cần hook, skill, MCP config cục bộ hay `onboard-desktop-bridge.mjs`; cấu hình toàn cục thuộc installer và receipt. Cấu hình project cũ được giữ nguyên cho tới khi migration được kiểm chứng. Tác vụ coding thông thường trong workspace hiện tại dùng workflow này theo hướng dẫn mặc định; việc nhỏ vẫn DIRECT.

## Workspace và nơi nhận

Mỗi lời gọi truyền `workspace_root` từ `environment_context` hiện tại. Server từ chối đường dẫn tương đối, thiếu, không tồn tại hoặc qua link/junction. Workspace đăng ký lười trong central state, không ghi file đăng ký vào project.

Client có MCP roots được kiểm tra bằng `roots/list` ở từng request. Client không có roots dùng tham số do Codex truyền từ ngữ cảnh phiên: đây là **model-mediated context**, không phải xác nhận root độc lập từ host. Server không fallback về canonical repository hay thư mục khởi động.

Có hai cách chọn nơi nhận:

| Chế độ | Điều kiện |
|---|---|
| Matching workspace | Beacon phải đúng workspace, còn hạn và không có nhiều conversation mơ hồ. |
| User-selected receiver | Người dùng chọn một chat nhận việc cố định, độc lập với workspace của job. Sau một job được gửi thật và parent kiểm chứng, dùng `verify_job(..., select_receiver: true)` để lưu lựa chọn. |

Khi đã lưu receiver, các job sau dùng receiver đó. `use_selected_receiver: false` trên status/submit quay lại matching workspace. Receiver là địa chỉ đã chọn, không phải bằng chứng chat đang focus. Brief vẫn giới hạn workspace, read/write scope; chọn receiver không bao giờ đổi work root và không mở rộng quyền của app. Với job mới, route nhận được lưu kèm checksum của selection đã đóng băng (route phiên bản 2) và bị từ chối trước khi gửi nếu proof thiếu hoặc nội dung đổi; route phiên bản 1 cũ vẫn đọc được. Checksum chỉ phát hiện hỏng/sửa nhầm, không phải xác thực mật mã hay sandbox.

Chat mới chưa phát hook cần một tin nhắn khởi tạo. Hook ghi conversation ID, workspace paths và timestamp ở SessionStart/PreInvocation/PostInvocation/Stop. Một cửa sổ mở nhưng chưa có event chưa chứng minh target sẵn sàng.

## Phối hợp và trạng thái

1. Codex chia phần độc lập, acceptance rõ và file ownership không chồng lấn.
2. Gửi job; tiếp tục phần việc của parent. Kiểm tra khoảng mỗi **5 phút**, hoặc khi có completion/error event, tránh lặp các lần chờ ngắn.
3. Worker chạy checks an toàn trong scope rồi dùng lệnh `report-cli --run-checks` với absolute brief path được cung cấp.
4. Parent đọc source/diff và report, đánh giá từng acceptance criterion và chạy checks mới. Lấy binding từ `auto_verification.review_context`, thêm files inspected, acceptance assessment, notes và check results vào `review_evidence` khi gọi `verify_job`. `accepted`/`review_notes` riêng lẻ không đủ; metadata chỉ là parent assertion, không chứng minh AI đã đọc code.
5. Tiếp tục giao milestone hữu ích tiếp theo; không dồn hết phần còn lại cho parent.

| Trạng thái | Bằng chứng |
|---|---|
| Prepared/queued | Có brief; chưa chứng minh đã gửi. |
| DISPATCHED | Có dispatch intent; xem transport receipt để biết kết quả gửi. |
| RESULT_READY | Có report đúng task/attempt; chờ parent. |
| VERIFIED | Parent đã kiểm tra scope, source/findings và fresh checks. |
| UNCERTAIN_DELIVERY | Giữ slot; không tự gửi lại. Cần review/release rõ ràng. |

Mỗi workspace tối đa một GUI job active. Số lượng subagent Antigravity trong mỗi wave thích ứng theo các phần việc độc lập thực sự hữu ích và giới hạn thực tế của payload/nền tảng (không có giới hạn cứng hai worker hay tám subtask; không spawn chỉ để lấy số lượng; các profile native Codex/offline giữ nguyên giới hạn riêng). Xung đột write/write và read/write trong cùng wave bị từ chối và phải chuyển sang wave sau. Không tạo nested teams. Với baseline toàn workspace hiện tại, stage riêng thay đổi của parent trong lúc Worker đang ghi, rồi tích hợp sau báo cáo.

## Checks và giới hạn

Framework detection chỉ gợi ý checks; không tự chạy script của repository. Chỉ `noop` nghĩa là parent functional tests **NOT RUN**; các test Worker tự khai vẫn cần kiểm chứng độc lập. Snapshot kiểm tra ordinary project files, có giới hạn tài nguyên và bỏ qua các vùng private/dependency; không phải filesystem sandbox.

Unit/integration fixtures dùng mocked transport là **OFFLINE-TESTED**. Trong một phiên, các job read-only tới receiver đã chọn cho hai project khác nhau đã có report và parent receipt; đây là bằng chứng phiên, không phải kiểm chứng tổng quát. Global MCP/Boss discovery đã được quan sát trong chat Codex mới trên máy thử. Còn **NOT VERIFIED**: discovery global trong client Antigravity mới, chat Antigravity mới chưa phát hook, host-attested roots và GUI focus. V1 checksum drift là baseline riêng, không liên quan tới bridge này.

Chẩn đoán: `bridge-cli.mjs doctor --workspace <absolute-root>`, `status`, `metrics`. Gỡ job cụ thể bằng `release_job`; đừng coi release là đã dừng Worker.

Tài liệu phạm vi cấu hình: [Codex config](https://learn.chatgpt.com/docs/config-file/config-basic), [Codex skills](https://learn.chatgpt.com/docs/build-skills), [Antigravity hooks](https://antigravity.google/docs/hooks), [Sidecars](https://antigravity.google/docs/sidecars).

## Correctness and trusted checks

Codex đọc source liên quan rồi gửi explicit `write_scope`; API không tự cấp scope từ token trùng tên. Source auth/token không phải credential store; `.env`, private keys và runtime folders vẫn bị bảo vệ. Snapshot dùng chung traversal, prune dependency/cache ở mọi độ sâu, giữ tracked ordinary source dưới build-like names, bỏ qua unmanaged links và từ chối tracked/explicit links. Baseline/final verification hash mới; cache chỉ advisory.

Trusted checks đăng ký executable + args trong central configuration; không lấy command từ prompt hoặc tự chạy framework scripts. Mặc định `shell:false`; shell:true chưa hỗ trợ vì chưa có nhu cầu được kiểm chứng. Runner có timeout tối đa 15 phút và cleanup process tree; parent MCP timeout hiện hữu là 120 giây nên end-to-end long parent-MCP checks chưa được xác minh. `noop` không chứng minh functional tests PASS.

Project mới có thể chỉ có `noop`. Codex cần review command/source inputs thực tế, rồi dùng `registerLocalWorkspace` từ absolute module path của bridge đã cài để đăng ký check vào central ignored state. Không cần user tự tạo config hoặc UUID trong project; không đăng ký command chỉ vì xuất hiện trong prompt hay framework detection.

Agentapi ưu tiên executable trên PATH theo tài liệu App-owned Sidecar. Không gọi get-conversation-metadata hoặc ghi đè project environment. Custom CLI cũ chỉ là compatibility route NOT VERIFIED nếu PATH thiếu; không fallback/retry sau khi đã gửi. Target observations hết TTL được dọn dưới lock, giữ active/selected/in-flight receiver. Transaction lock chỉ recover PID được xác minh đã chết; live/unknown owner giữ fail-closed.
