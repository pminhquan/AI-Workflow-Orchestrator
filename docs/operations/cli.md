# Operations

Chạy từ canonical root bằng Node >=22; không cần install dependencies.

| Command | Tác dụng / side effects |
|---|---|
| `node src/cli.mjs doctor` | Đọc config/V1 allowlist hashes; không đổi live |
| `node src/cli.mjs inventory` | Component source/target/hash/status; app-owned contents không đọc |
| `node src/cli.mjs validate` | Validate canonical schema/cross refs và re-render/check generated drift |
| `node src/cli.mjs diff-config` | Hash/diff proposal cho staging; V1 references không phải replacement payload |
| `node src/cli.mjs plan-install` | Luôn dry-run/BLOCKED, chỉ review bốn future profile targets |
| `node src/cli.mjs rollback-plan` | Báo không có live write và future restore procedure |
| `node src/cli.mjs compile` | Ghi staging và diff riêng trong ignored state |
| `node src/cli.mjs route tests/fixtures/routing.json` | Trả recipe/mode/roles/workers/reason, không chạy worker |
| `node src/cli.mjs verify-v1` | So sánh 26 source/config hashes với baseline; không mở SQLite |
| `node src/cli.mjs test` | Node test suite; chỉ tạo/xóa sandbox fixture trong project state |
| `node benchmarks/run.mjs` | 15 synthetic functional scenarios; ignored `state/benchmark-results.json` |

`test` trả exit code của suite; validate/doctor/verify-v1 trả nonzero khi có lỗi/drift. `plan-install` trả exit 0 cho plan hợp lệ có activation=BLOCKED; đây không phải tín hiệu đã cài. Không hỗ trợ flag mutation như --apply.

Generated drift: đọc diff và bảo tồn chỉnh sửa tay; cập nhật canonical source đúng phạm vi. Không tự xóa artifact/index để qua gate. Sau review có thể tạo lại staging có backup/checksum riêng; không copy file sang native discovery directories trong foundation.

Offline store sử dụng exclusive `store.lock`; chỉ một writer. Sau hard crash, xác minh process đã dừng trước khi xóa riêng stale lock, giữ `store.json`; gọi `recover()` để chuyển interrupted running sang BLOCKED. Không tự dispatch lại task outcome không chắc chắn. Không tái sử dụng worker tokens/transcripts từ V1.

Receipts không persisted như quyền tin cậy qua restart: rerun registered check khi resume review. Retry/rework phải explicit và không vượt budget. Không có daemon sau khi CLI thoát.
