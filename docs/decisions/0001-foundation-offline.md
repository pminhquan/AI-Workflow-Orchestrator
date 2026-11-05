# ADR 0001: Foundation offline, V1 giữ nguyên

Status: accepted for this build, 2026-11-05.

Chọn Node ESM với built-in libraries, JSON config/schema và một offline atomic JSON store. Không thêm framework/SQLite/agent marketplace, không clone upstream toàn bộ và không chạy installer của họ. Roles được viết lại ngắn gọn từ nguyên tắc, không nhập persona.

Global AGENTS/skill yêu cầu Antigravity cho substantive implementation, nhưng brief lần này giới hạn V1 read-only và consumer external dispatch. Skill được dùng để đọc bridge_status một lần; không submit/claim/report/check/review task trong ledger V1. Codex tự triển khai project mới để không ghi ledger hoặc tiêu quota Google. Đây là áp dụng giới hạn cụ thể của nhiệm vụ, không thay đổi workflow global.

Native providers chỉ có capability metadata và conditional compiler targets; không có real launcher. Format documented không đồng nghĩa adapter được phép dispatch hoặc runtime đã verified. Google FAQ chặn consumer third-party wrapper; không suy diễn `/teamwork` là externally callable API. Official Gemini API được ghi riêng, billing/auth cần user scope tương lai.

Giá phải trả: chưa có integrated native execution, worktree creation hoặc real speed/cost comparison. Những phần này ghi DESIGN-ONLY/NOT VERIFIED; mục tiêu foundation vẫn kiểm chứng được bằng offline tests.
