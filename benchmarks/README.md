# Evaluation protocol

`node benchmarks/run.mjs` chạy 15 scenarios trong `scenarios.json`, không gọi AI hoặc network. Mỗi scenario tạo sandbox local, thực hiện routing/scheduling/check assertions rồi cleanup đúng path. Kết quả ở ignored `state/benchmark-results.json`.

`harness_elapsed_ms` chỉ là thời gian chạy harness với synthetic worker. Metrics AI thực (latency/planning/dispatch/queue/worker/review/verification/integration/retry/intervention/quality/tokens/cost) được chuẩn bị nhưng để null trừ kết quả functional assertions. Không tuyên bố performance improvement. Unit/integration tests còn kiểm tra negative cases và stale receipts kỹ hơn.

Future comparison groups: Codex only, Codex +1 worker, Codex +2 workers, native Teamwork trial riêng qua phương thức hỗ trợ. Hiện tất cả NOT VERIFIED, không có số speedup/cost giả.

Để trial có giá trị: dùng bộ task/dataset cố định có acceptance/tests, environment/provider/model versions và commit hashes; cùng scope/context/caching policy, luân phiên thứ tự chạy, nhiều repetition; lưu raw phase timestamps và nguồn số liệu. Tách queue wait, worker time và review wait, không gán wall-clock toàn job cho inference. Ghi failure/retry/human intervention và chất lượng trước khi so latency; không loại failure một cách chọn lọc. Token/cost giữ null khi provider không cung cấp. Đặt budget và supported integration scope trước khi gọi AI; lần build này không làm trial đó.
