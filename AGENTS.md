# Maintenance contract

Đây là canonical workflow repository. Đọc [README](README.md), [architecture](docs/architecture/overview.md) và [manifest](config/deployment/components.json) trước khi sửa.

- Chỉ thay phần cần thiết, giữ concurrent edits. Không tạo team cho microtask.
- Offline core giữ `foundation-only`; App-owned live bridge là scope riêng đã được người dùng yêu cầu. Không sửa V1 hoặc file ngoài project, trừ owned global setup/upgrade qua installer khi đã được user cho phép. Live audit chỉ đọc theo allowlist.
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

## Codex Boss → Antigravity Desktop GUI Bridge

The live App-owned bridge is installed once at user scope by `scripts/install-global-desktop-bridge.mjs` (six owned targets, durable receipt, exact rollback; see [operation guide](docs/operations/global-desktop-bridge.md)). New projects need no copied hooks, skills or MCP config. It is separate from the offline Mock/Replay core. When the global `desktop_inbox` MCP server is available, Codex acts as **Boss** for substantive coding in the CURRENT workspace:

- Pass `workspace_root` from the current session environment on every call; never use another project, the server cwd or this repository as the work root. Without MCP roots this is model-supplied context, not host attestation.
- Routing is strict (fresh matching-workspace Beacon from `src/desktop-inbox/hook-beacon.mjs`; a fresh chat needs one hook event) or an explicitly chosen persistent receiving chat created from a parent-VERIFIED delivery. The receiver never changes the work root, grants no permission and does not prove GUI focus.
- Read [.agents/skills/antigravity-orchestrator/SKILL.md](.agents/skills/antigravity-orchestrator/SKILL.md) (Boss) or [.agents/skills/codex-worker/SKILL.md](.agents/skills/codex-worker/SKILL.md) (Worker).
- Loop: `bridge_status` → `submit_job` (explicit scopes, acceptance, `verification_commands`, optional `subtasks` waves) → check about every five minutes while doing useful work → inspect result and diff → `verify_job`. Antigravity subagent headcount is adaptive to useful independent subtasks and actual platform/payload bounds (no arbitrary two-worker or eight-subtask cap; native Codex and offline profiles keep their own limits), with disjoint write scopes, no same-wave read/write conflicts, no nested teams, and one active GUI job per workspace. Handle trivial 1–2 line tasks DIRECT.
- Never retry uncertain delivery automatically. A worker report is never verification. Fresh Codex global discovery was session-verified; fresh Antigravity global discovery, host-attested roots and GUI focus remain NOT VERIFIED; the legacy V1 checksum drift is a separate baseline and is never reset.

## Antigravity Autonomous Execution (Auto-Divide, Auto-Subagent & Surgical Mode)

Khi nhận bất kỳ yêu cầu nào từ người dùng hoặc từ `[Codex Boss Job ...]`, Antigravity **tự động phân tích, chia việc và điều phối subagent ngay trong lượt đầu tiên mà không cần người dùng nhắc**:

- **Tự động quyết định chế độ thực thi (Auto-Tiering)**:
  1. **DIRECT (Việc nhỏ / 1 file / sửa cục bộ)**: Tự thực hiện ngay lập tức, không tạo subagent.
  2. **AUTO-RESEARCH (Khảo sát ≥ 2 vùng mã nguồn/tài liệu độc lập)**: Tự động gọi song song các `invoke_subagent` (`TypeName: "research"`) trong cùng một lượt, sau đó dừng lượt chờ kết quả trả về (reactive wakeup, không poll).
  3. **AUTO-TEAM / PARALLEL SUBAGENTS (Nhiệm vụ có ≥ 2 phần việc hoặc ≥ 2 file/module sửa độc lập)**: Tự động đóng vai **Team Lead** ngay cả khi prompt chưa chia sẵn subtask — tách các phần việc theo `write_scope` không trùng nhau (disjoint), gọi song song các `invoke_subagent` (`TypeName: "self"`, `Workspace: "inherit"`) kèm phạm vi file và dòng lệnh cụ thể, chờ các subagent hoàn tất rồi tích hợp và kiểm tra.
- **Đọc/Sửa Phẫu Thuật & Tiết Kiệm Token (Always-On)**:
  - Tra cứu vị trí hàm/class bằng `src/desktop-inbox/codebase-map.mjs` (hoặc mục Surgical Map trong brief / `rg -n`) trước khi đọc; chỉ gọi `read_file` theo khoảng `StartLine..EndLine` (±30 dòng quanh vị trí cần sửa), tuyệt đối không đọc tràn cả file dài từ đầu tới cuối.
  - Chỉ sửa đúng những dòng cần thiết (Minimal Diff, không viết thừa boilerplate/wrapper), chỉ chạy đúng file test liên quan và cắt gọn log terminal dài (`| Select-Object -First 40`).
  - Khi hoàn tất job từ Codex Boss, chạy `node "src/desktop-inbox/report-cli.mjs" --latest --run-checks --summary "<tóm tắt súc tích>"` để Codex chỉ đọc Summary mà không phải đọc lại toàn bộ code.

