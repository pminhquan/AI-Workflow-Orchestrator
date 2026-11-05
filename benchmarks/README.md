# Evaluation protocol

`node benchmarks/run.mjs` chạy 15 scenarios trong `scenarios.json`, không gọi AI hoặc network. Mỗi scenario tạo sandbox local, thực hiện routing/scheduling/check assertions rồi cleanup đúng path. Kết quả ở ignored `state/benchmark-results.json`.

`harness_elapsed_ms` chỉ là thời gian chạy harness với synthetic worker. Metrics AI thực (latency/planning/dispatch/queue/worker/review/verification/integration/retry/intervention/quality/tokens/cost) được chuẩn bị nhưng để null trừ kết quả functional assertions. Không tuyên bố performance improvement. Unit/integration tests còn kiểm tra negative cases và stale receipts kỹ hơn.

Future comparison groups: A Codex DIRECT, B native DELEGATED, C native TEAM, D official external API executor nếu được triển khai riêng. Chưa chạy controlled comparison; tất cả benchmark groups NOT VERIFIED. Một read-heavy native smoke không phải performance benchmark.

Ưu tiên end-to-end correctness, human interventions, planning/delegation overhead, integration/review time và rework. Token usage chỉ ghi khi nguồn native thực sự cung cấp; nếu không thì null. Raw smoke participation ở `docs/audit/v2.2-native-smoke.json`; không lấy mock timing làm speedup hay token savings.

Để trial có giá trị: dùng bộ task/dataset cố định có acceptance/tests, environment/provider/model versions và commit hashes; cùng scope/context/caching policy, luân phiên thứ tự chạy, nhiều repetition; lưu raw phase timestamps và nguồn số liệu. Tách queue wait, worker time và review wait, không gán wall-clock toàn job cho inference. Ghi failure/retry/human intervention và chất lượng trước khi so latency; không loại failure một cách chọn lọc. Token/cost giữ null khi provider không cung cấp. Đặt budget và supported integration scope trước khi gọi AI; lần build này không làm trial đó.
