# Profile compiler

## Pipeline

Validate role → validate tool/permission representation → render stable bytes → compare previous generated hashes → refuse unexplained drift → write staging → checksum/provenance manifest. Không timestamps/randomness trong artifacts. Diff so với lần generate trước nằm trong `state/compiler-diff.json`; không tích lũy history vào artifact làm mất determinism.

`agents/generated/checksums.json` bảo vệ các file đã quản lý; artifact sửa tay hoặc mất file làm compile fail. `validate` so sánh canonical re-render với output hiện tại. `manifest.json` chứa role, target, source hash, upstream commit, output hash, enforcement và installation=false. Unknown schema keyword, unknown tool hoặc unknown target không được bỏ qua.

## Ma trận foundation

| Target | Có output | Trạng thái |
|---|---|---|
| Mock | Sáu role JSON, giữ nguyên permissions | OFFLINE-TESTED |
| Codex native | `orchestrator.toml`, chỉ inherited-parent policy | NOT VERIFIED |
| Antigravity native | Explorer, Code Reviewer, Evidence Auditor Markdown với read/search tools | NOT VERIFIED |
| Codex role yêu cầu read-only hoặc task-scoped write/tools | Không emit executable profile | UNSUPPORTED |
| Antigravity role cần scoped writes/check shell hoặc inherited all tools | Không emit executable profile | UNSUPPORTED |

Tổng: 10 profile artifacts, một generation manifest và một checksum index. Có 8 kết quả UNSUPPORTED trong 18 role-target combinations. Một role không support không ngăn việc compile các combination an toàn khác; CLI trả ma trận kết quả rõ ràng, không coi các lỗi này là successful conversion.

V2.2 thêm 9 artifacts trong `codex-guidance/`: guide, AGENTS snippet, năm recipes chọn đọc theo nhu cầu và hai advisory review TOML. Chúng đi qua cùng compiler/checksum/drift gate, không phải chuyển đổi lossless các hard-constraint roles. Tổng payload hiện là 19, ngoài manifest/index. `native_guidance` trong manifest ghi `execution: NOT EXECUTED`, custom discovery NOT VERIFIED. Profile names có prefix `awo-`, không che built-ins. Bundle dùng output của canonical compiler, không tự sửa generated source.

## Provider constraints đã kiểm tra từ tài liệu

Theo [OpenAI Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), custom agent TOML yêu cầu `name`, `description`, `developer_instructions`; sandbox và approval settings theo parent. Vì vậy compiler không phát `sandbox_mode` như một per-agent security gate. Upstream adapter wshobson vẫn phát heuristic này tại commit đã pin; cách đó bị reject trong project này.

Theo [Google Custom subagents](https://antigravity.google/docs/subagents), native Markdown dùng YAML frontmatter và native tool names. Compiler chỉ map read/search sang `view_file`/`grep_search`, đặt shell policy là chuỗi `"off"`, không yêu cầu MCP riêng. Chưa test enforcement/inheritance trong app đã cài, nên activation vẫn BLOCKED. Unknown tools dễ gây lỗi theo tài liệu; converter từ chối chúng.

Không compile hard permissions thành SKILL.md advisory để giả vờ đã enforce. Skills là hướng mở rộng sau, nếu role chỉ chứa guidance hoặc đã có security envelope riêng được kiểm chứng. Không tạo marketplace hay tự reload definitions.

Project-local target paths chỉ có trong dry-run component manifest, hiện không tồn tại `.codex/agents/` hoặc `.agents/agents/` live discovery directories. Staging nằm dưới `agents/generated/` để tránh tự discover.
