---
name: antigravity-orchestrator
description: Coordinate substantive coding, web/app development and debugging in the CURRENT Codex workspace with Antigravity Desktop. Choose DIRECT for small tasks, native review when useful, or bounded scoped Antigravity jobs; keep collaborating through implementation and verification.
---

# Codex Boss → Antigravity Desktop (Fast Zero-ID & Token-Saving Workflow)

The user already opens Antigravity Desktop GUI and selects the conversation, workspace, model, and reasoning level themselves. Never ask the user for `conversation_id`, `task_id`, model settings, or per-project setup.

## 1. Fast 2-Step Loop (Divide → Submit → Read Summary Only)

1. **Tự động Chia việc & Gửi thẳng vào khung chat đang mở (`submit_job`)**:
   - Không bao giờ chờ người dùng nhắc "hãy chia việc" hay "hãy dùng subagent":
     - Việc cực nhỏ 1–2 dòng: tự sửa **DIRECT** ngay.
     - Việc vừa/lớn hoặc từ >= 2 phần độc lập: **tự động tách thành `subtasks` theo từng wave (`wave: 1..8`)** với `write_scope` tách biệt (disjoint) và gọi `submit_job` ngay (không cần gọi `bridge_status` trước):
       - `workspace_root`: đường dẫn workspace hiện tại (bắt buộc).
       - `request`: mục tiêu tổng thể rõ ràng.
       - `replace_active: true`: tự động giải phóng job cũ bị kẹt để không bao giờ bị chặn.
       - `subtasks`: mảng các phần việc độc lập để Antigravity tự động spawn subagent song song.
       - `read_scope`, `write_scope`, `acceptance_criteria` là tùy chọn (`writeJobBrief` sẽ tự động đính kèm **Surgical Symbol & Line Map** `L<line>:<symbol>` cho Worker).
   - Live Sidecar tự động điền prompt vào khung chat Antigravity đang mở sẵn và bấm Submit.

2. **Chờ kết quả & Chỉ đọc Summary tiết kiệm token (`wait_job`)**:
   - Call `wait_job({ workspace_root, auto_verify: true })` (omit `task_id` — it automatically tracks the latest job and auto-verifies on completion).
   - When `wait_job` returns, read **ONLY `concise_summary`** (`headline`, `findings`, `changed_files`, `tests`, `errors`).
   - **Zero-Read-Back Rule**: Do **NOT** re-read modified files from start to finish or re-run the entire test suite after a clean `concise_summary` (`status: "reported"`, `errors: []`). Inspect specific source lines only if `concise_summary` reports a blocker, error, or ambiguity.

## 2. Surgical Context & Terminal Discipline (Boss Direct Work)
- **Map-First Range Reads**: When inspecting files yourself, locate symbols via `rg -n` or `node "<bridge_root>/src/desktop-inbox/codebase-map.mjs" "<workspace>" [scope]` and read only `StartLine..EndLine` (±30 lines) instead of full files.
- **Output Capping (`rtk` pattern)**: Run targeted test files rather than full suites during iteration, and cap noisy shell output (`| Select-Object -First 40` / `-Last 40`) to prevent context bloat.
- **Minimal Diff**: Edit only the lines needed; avoid boilerplate wrappers or unrequested refactoring.


