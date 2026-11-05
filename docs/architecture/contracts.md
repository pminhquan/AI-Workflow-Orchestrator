# Task, report và lifecycle

Contracts version `1.0`; JSON Schema trong `workflows/schemas/`. `src/core/schema.mjs` hỗ trợ type/nullable, required, strict properties, const/enum, array bounds/uniqueness, string pattern/length và numeric bounds. Keyword khác trả error; không phải implementation toàn bộ JSON Schema. Không dùng remote refs hoặc schema network fetch.

Task brief chứa task/parent/trace ID, goal, workspace, files, dependency IDs, read/write scope, constraints, acceptance, required checks, artifacts, allowed mode và retry budget. Workspace dùng đường dẫn relative trong canonical root cho offline harness. Không nhận arbitrary global workspace/live ledger path.

Worker report chứa task ID/attempt, summary, actual changed files, artifacts, test commands/outcomes, evidence refs, limitations/risks/blockers và subagent usage nullable. `subagent_usage=null` nghĩa là chưa xác minh; worker tự khai không trở thành số liệu native đáng tin.

```text
queued -> running -> review -> done (host accept)
                  -> partial / failed / blocked
review/partial/failed/blocked -> queued (explicit bounded rework)
queued/running/review -> canceled
interrupted running -> blocked (explicit recovery)
```

`idle` là kết quả một lần schedule không có task sẵn sàng, không phải task state. Worker unavailable trả BLOCKED preflight, task giữ queued và attempt không tăng. Dependency phải done mới release; partial/failure/cancel/block không được coi completed.

`DIRECT` trong brief không thể được dispatch sang worker. TEAM profile không tự spawn agent; foundation chỉ xử lý Mock/Replay bằng Promise concurrency có giới hạn. Scope conflict gồm write/write và read/write, case-insensitive và kiểm tra prefix theo path segment.

Host check receipts gắn input hash, check spec, Node executable identity/version, exit code, timeout, stable-input flag và thời điểm. Cache chỉ reuse passing receipt của cacheable check với source/spec còn khớp và tuổi không quá một giờ. Tất cả input ảnh hưởng đến kết quả phải khai báo trong check spec; check gọi dịch vụ ngoài không được cache hoặc dùng trong offline foundation.

Accept còn yêu cầu actual diff đúng write scope, report đổi file trung thực và expected artifacts tồn tại. Host vẫn chịu trách nhiệm kiểm tra tiêu chí nghiệp vụ; không chứng minh được mọi acceptance criterion chỉ bằng syntax/tests.

Fixtures có successful/review, partial, failed và malicious reports; malicious chứa PASS, permission escalation và traversal. Test runner chứng minh các report này không vượt gate.

Offline compatibility: `src/adapters/legacy-report.mjs` chỉ chuyển V1-shaped synthetic reports theo allowlist; field token/task-state bị từ chối, mọi test outcome cũ thành not-run. Replay vẫn phải qua fresh V2 host checks. Không import live ledger hoặc private reports.
