# V1 references

`v1-inventory.json`: 26 explicit source/config file references với SHA-256, cùng runtime references không đọc nội dung. `v1-sanitized.json`: chỉ allowlisted config values, project/check definitions, MCP command/args/tool names và app setting key names; không phải full config backup.

Không có SQLite data, OAuth/API key, worker token/capability, app session, private transcript hoặc copied installer trong thư mục này. Đường dẫn máy cá nhân được giữ có chủ đích để audit/migration mapping, nên repository vẫn local/private. Không push nếu chưa review dữ liệu path/project names.

Source references không phải relocated runtime. V1 vẫn chạy từ bridge root cũ; V2 không owns hoặc updates các file đó. Xem [audit](../docs/audit/v1-inventory.md).
