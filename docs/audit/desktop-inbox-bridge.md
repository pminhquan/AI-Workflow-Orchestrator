# Desktop inbox bridge candidate — implementation and activation review

Ngày: 05/11/2026, Asia/Bangkok. Giữ V2.3 foundation-only.

**Đã implement và kiểm thử offline. Chưa có real Desktop execution.** Live transport bị khóa trong code; sửa các review flags không mở khóa được. Không có installer, global config write, đăng nhập, consumer dispatch hoặc V1 mutation.

## A. V1: dùng lại nguyên tắc, không import runtime

Đã đọc V2 source/contracts, `legacy/v1-sanitized.json`, [V1 compatibility audit](v2.3-bridge-compatibility.md) và [migration runbook](../operations/migration-rollback.md). Không invoke hoặc import V1 runtime, không đọc ledger, auth, worker capabilities hoặc private navigation/session databases.

| Hành vi | Quyết định |
|---|---|
| Workspace/project binding, task/attempt identity | ADAPT: canonical root, stable project ID và strict matching |
| Acknowledgement tách completion | ADOPT: transport receipt, worker report và host acceptance là ba evidence khác nhau |
| Parent verification và provenance | ADAPT: actual snapshot/diff, fresh registered checks, review findings, giữ nguyên report bytes |
| Uncertain delivery/restart/cancellation | ADOPT: durable intent trước send; không retry; không coi local cancel là dừng worker |
| V1 SQLite/store/scheduler/sidecar implementation | REJECT: không copy hoặc kết nối; candidate chỉ là mailbox, không DAG/agent scheduler |
| Focused-pane/private navigation discovery | REJECT: không dùng port/window title/CDP/session scraping để đoán conversation |

V2 `CheckRunner`, hashing/path utilities và schema subset được dùng lại. Không thay routing/capability registry hoặc native permissions.

## B. Official capabilities và compatibility

[Sidecars](https://antigravity.google/docs/sidecars) xác nhận App quản lý command-sidecar lifecycle, manifest `sidecar.json`, global `sidecars[id].enabled/projectId`, cung cấp `agentapi` trên PATH của Sidecar. Runtime có data/logs/events; data path được cung cấp qua `ANTIGRAVITY_EXECUTABLE_DATA_DIR`. Candidate không đọc nội bộ các thư mục này.

Hai argv được tài liệu hóa:

```text
agentapi send-message <conversation_id> <prompt>
agentapi new-conversation <prompt>
```

Tạo conversation cần configured `projectId`. Manifest candidate dùng các fields chính thức; `enabled` nằm ở config fragment riêng. [Schedule command](https://antigravity.google/docs/commands/schedule) là conversation-scoped wake-up; khác builtin schedule của Sidecar. Candidate dùng command poller, không thêm agent scheduler hoặc lịch `/schedule`.

Tài liệu không mô tả focused-chat lookup, project-validation API cho existing ID, output/event receipt schema, completion/cancel API hoặc version guarantee cho App 2.29.0. Các khoảng trống này không được lấp bằng private calls. JSON trả về trong tests là **MOCK contract do repository định nghĩa**, không phải vendor response schema.

App binary đã được xác định 2.29.0 trong [feasibility evidence](antigravity-desktop-feasibility.md); task này không probe runtime, gọi agentapi/help, điều khiển GUI hoặc đọc account details. Installed-runtime compatibility: **NOT VERIFIED**.

## C. Files implemented

| Path | Nội dung |
|---|---|
| `src/desktop-inbox/contracts.mjs`, `inbox.mjs` | Strict jobs/reports; atomic state transitions, claim, cancellation/recovery, original report preservation |
| `src/desktop-inbox/binding.mjs` | Reviewed binding, capability rejection và unconditional live blocker |
| `src/desktop-inbox/sidecar.mjs`, `sidecar-runner.mjs` | Documented argv builder, fixed mock executable, polling/consumer lock; default disabled |
| `src/desktop-inbox/verification.mjs` | Bounded snapshots, actual diff, fresh host checks và required parent review |
| `src/desktop-inbox/deployment.mjs`, `cli.mjs` | Review-only deployment plan, pure registration/rollback helpers, local submit/status/collect/cancel |
| `workflows/schemas/desktop-inbox-{job,report}.schema.json` | Strict public contracts |
| `integrations/antigravity-inbox/` | Canonical manifest, disabled binding example và disabled global config fragment; không được cài |
| `tests/unit/desktop-inbox*.test.mjs`, `tests/integration/desktop-inbox.test.mjs` | Negative, lifecycle, subprocess mock, concurrency, acceptance và rollback tests |
| `tests/fixtures/desktop-inbox/mock-agentapi.mjs` | Synthetic agentapi executable, chỉ đọc fixture README và ghi report dưới canonical state |
| `scripts/desktop-inbox-smoke.mjs` | Runnable offline smoke, lưu đầy đủ evidence ngoài Git |

README và architecture mô tả candidate. Không nâng version. Manifest trong `integrations/` là canonical review input, không phải installed hoặc compiler-generated artifact. Compiler hiện có vẫn được chạy và kiểm tra deterministic.

## D. Inbox contract và guarantees

Job có `schema_version`, `task_id`, `attempt_id`, `workspace_root`, `project_id`, `goal`, `read_scope`, `write_scope`, `acceptance_criteria`, `verification_commands`, `created_at`, `expected_output`.

- UUID v4 cho task/attempt, duplicate task luôn bị từ chối, không tự tạo attempt thay thế.
- Workspace phải canonical local directory; identity đối chiếu với binding được lưu tại inbox. Một production inbox cố định: `state/desktop-inbox`.
- Relative paths từ chối traversal, Windows ADS/reserved names/wildcards, link/junction và các private/credential paths nhận diện được. Output phải chính xác `tasks/<task_id>/report-<attempt_id>.json` trong inbox.
- Job tối đa 8 KiB; report 32 KiB; record 1 MiB. Reject unknown/malformed fields, jobs cũ quá 10 phút hoặc future quá 30 giây. Lịch sử vẫn đọc được sau expiry; expired pending không được claim/send.
- Known credential patterns bị reject. Đây không phải detector cho mọi loại secret; người tạo brief vẫn phải review nội dung và scope.
- `verification_commands` là **registered host check IDs**, không phải shell text. Parent cấp trusted specs riêng. Task/worker không được cung cấp executable, env hoặc shell pipeline cho host.
- Atomic file publication và exclusive transaction lock dùng chung giữa processes. Durable dispatch intent được ghi **trước** mock subprocess; restart không resend. Incomplete/corrupt records và abandoned locks fail closed, không tự xóa lock.
- Một active task cho mỗi workspace trong inbox đã review. Không tạo global lease/service: hai inbox roots khác nhau không cung cấp OS-global exclusion; initial deployment chỉ được cấu hình một inbox/consumer cho workspace.
- Không shell interpolation: executable mock cố định; prompt là một JSON argv. Prompt-injection test chứng minh literal transport, không chứng minh model tuân thủ scope hoặc filesystem isolation.

```text
PENDING → CLAIMED → DISPATCHED → RESULT_READY → VERIFIED
outcome: null | FAILED | CANCELLED | UNCERTAIN_DELIVERY
```

DISPATCHED ghi send intent, không khẳng định message đã tới agent. Receipt chỉ ghi transport outcome. Chỉ proven pre-spawn ENOENT/EACCES mới được xem là chưa gửi; timeout, bad response hoặc post-spawn error giữ uncertain outcome và workspace slot. Local cancellation sau intent cũng giữ slot, không claim worker đã dừng. Claim chưa dispatch khi restart thành FAILED; dispatched chưa có result thành UNCERTAIN_DELIVERY. Không auto-retry hoặc auto-unlock.

Worker report bắt buộc task/attempt/workspace khớp; status chỉ `reported|blocked|failed`, cùng `inspected_files`, `changed_files`, `tests`, `findings`, `blockers`, **`errors` và `evidence`**. `blockers` là prerequisites chưa đáp ứng; `errors` là execution errors do worker khai báo, hai fields không phải aliases. Không nhận PASS/VERIFIED/CLOSED hoặc worker-authored host receipt. Original bytes được copy exclusive và hash; cả output lẫn preserved original được đối chiếu khi verify.

Compatibility normalization chỉ đổi `completion_evidence` sang `evidence` khi là string array hợp lệ; nếu cả hai tồn tại phải giống nhau chính xác, nếu không reject. Canonical schema không nhận alias. Adapter không đổi `blockers` thành `errors`, kể cả khi blockers rỗng. Legacy report thiếu `errors` chỉ được bổ sung `[]` nếu thuộc format cũ và parent cung cấp `result.md` có một khai báo no-errors được nhận diện rõ: dòng `Errors: NONE`, `Errors: []`, hoặc câu nguyên văn của pilot “Không có lỗi phát sinh trong quá trình đọc `README.md` và tạo báo cáo kết quả.”. Khai báo Errors khác mâu thuẫn sẽ bị từ chối. Đây là worker declaration được giữ provenance, không phải bằng chứng độc lập không có lỗi. Thiếu khai báo hoặc sai kiểu dữ liệu phải báo lỗi, không suy diễn.

`inspectHandoffArtifacts()` đọc và hash riêng `result.md`/`report.json` của handoff đã có, trả canonical report sau normalization; không submit job, không dispatch hoặc thay đổi state. Parent kiểm tra content/source/diff riêng. Output gốc và các verification receipts trước đó không được sửa. Regression coverage bao gồm missing/types/conflicts/identity/forged completion và host rejection khi worker khai báo errors.

Parent dùng fresh `CheckRunner` không cache, kiểm tra actual diff khớp report/write scope, snapshot không thay đổi trong verification, rồi callback review source/findings trước acceptance. Host receipts có fingerprints, exit codes và provenance riêng; report tests chỉ là claims. Baseline/snapshot bao phủ ordinary files, tối đa 2.000 files/16 MiB; không traverse root `.git`, `.venv`, `node_modules`, `state`, `__pycache__`, `.pytest_cache`. Không claim phát hiện writes trong các excluded roots hoặc ngoài workspace. Recognizable private paths khác làm snapshot fail trước khi đọc. Same-account processes vẫn có thể sửa state; đây không phải sandbox hoặc tamper-proof attestation.

## E. Existing Desktop conversation targeting: NOT VERIFIED

**Documented known-ID send khác focused-chat discovery.** `existing` mode bắt buộc ID ổn định và đúng project evidence; không đoán focus. Chưa có ID thật, supported project-membership proof hoặc runtime receipt contract trên máy, nên mode thật dừng.

`new` mode được test bằng mock với argv `new-conversation`; thiết kế dựa vào App-owned configured `projectId`. Nó tạo **conversation App mới trong cùng project**, không phải chat hiện tại. Không dùng CLI conversations riêng. Chưa tạo conversation App thật.

## F. Offline integration tests và evidence

Lệnh tái lập:

```powershell
node --test tests/unit/desktop-inbox*.test.mjs tests/integration/desktop-inbox.test.mjs
node scripts/desktop-inbox-smoke.mjs
node src/desktop-inbox/cli.mjs plan
node src/desktop-inbox/sidecar-runner.mjs integrations/antigravity-inbox/binding.example.json
```

Lệnh cuối trả DISABLED, không poll hoặc dispatch. Local CLI `submit <binding.json> <brief.json>` chỉ ghi inbox và baseline; `status`, `collect`, `cancel` không gọi consumer. Không có CLI command tự accept kết quả. Parent dùng `verifyJob` sau review, với trusted check specs và review callback. `--mock-once`/`--mock-poll` của runner chỉ chạy mock và không bypass live blocker.

Coverage: valid/missing/malformed job, wrong project/workspace, duplicate, claim từ hai Node processes, missing conversation ID, bad response/failure/timeout, report mismatch và raw retention, unexpected edits, cancellation, restart/recovery, literal prompt injection, polling interval/consumer lock, rollback preserving concurrent files/config, unsupported hard isolation/native stop/focus discovery, và `__proto__` filename regression. Live mode vẫn reject kể cả mọi editable review flags được bật.

Kết quả fresh và exact commands/exit codes được lưu tại `state/desktop-inbox-verification-2026-11-05/verification.json`; smoke evidence path được ghi trong file này. Không coi mock latency là Antigravity performance.

| Fresh check | Kết quả |
|---|---|
| Focused inbox suites | **44/44 PASS**, 0 fail/skip, exit 0 |
| Retained mock smoke | OFFLINE-TESTED; matching original report, fresh host check exit 0, mock lifecycle VERIFIED |
| Candidate runner mặc định | DISABLED, exit 0, không dispatch |
| Deployment plan CLI | BLOCKED review plan, exit 0, không install/enable |
| `node src/cli.mjs compile` | Exit 0, `diffs: []` |
| `node src/cli.mjs validate` | PASS, exit 0, generated drift `[]` |
| `node src/cli.mjs test` | **135/136 PASS**, exit 1; duy nhất V1 baseline checksum gate |
| `node src/cli.mjs verify-v1` | DRIFT, exit 1, `.codex/config.toml` như evidence trước task |

Không sửa V1 baseline để làm xanh gate. Mock smoke cuối nằm ở `state/desktop-inbox-smoke-2d19e640-aa96-4bc4-a86e-9af35281c8d5/`; task `198f6da0-4521-4896-adab-11f43b3ad7be`, attempt `e0da3151-e8ff-4b35-afb5-b4b17c34f17b`. Original report và host receipt tách riêng. Independent review đã phát hiện và sửa snapshot omission với `__proto__`; regression hiện PASS.

## G. Activation readiness: BLOCKED

[FAQ](https://antigravity.google/docs/faq) nói consumer plans không hỗ trợ wrap `agy` trong third-party coding agents/apps, đồng thời hạn chế third-party software dùng Antigravity login. Đây làm rõ hơn kết luận CLI trước đó: consumer CLI wrapping là **UNSUPPORTED**. Candidate này không gọi `agy` hoặc truy cập auth.

[Terms khoản 6](https://antigravity.google/terms) vẫn hạn chế third-party access. Official App-owned Sidecar là extension surface thật; tài liệu khảo sát không xác nhận ngoại lệ cho **Codex → inbox → Sidecar** orchestration. App khởi chạy Sidecar không tự chứng minh quyền dùng kiến trúc này. Account applicability: **UNKNOWN**, activation **BLOCKED**; không dùng Sidecar để lách restriction.

`deploymentPlan()` liệt kê exact candidate/dependency hashes, target paths, backup và rollback gates nhưng không cài. Trước activation tương lai phải xác minh supported runtime/target contract, policy/account applicability, output-path permission trong scope đã duyệt và explicit activation approval. Booleans/reference strings không được xem là proof: live transport còn bị khóa trong foundation code và cần review triển khai riêng sau khi có evidence hợp lệ.

Backup tương lai nằm ngoài Git, giữ full app config do user/app quản lý; không xuất auth/session vào repo. Dùng ID riêng `desktop-inbox-candidate`, abort nếu tồn tại; chỉ merge owned section, không overwrite user settings/V1. Rollback chỉ gỡ unchanged owned additions/entry, giữ concurrent edits và in-flight uncertainty. Không restart app hoặc tự thay global permissions.

## H. One-time manual binding

Hiện không có thao tác manual nào đủ để bật live path an toàn. Cần xác nhận chính thức cho kiến trúc/account trước.

Khi điều kiện đó được giải quyết, user review **một lần** binding gồm canonical workspace root và App project ID. Existing mode còn cần conversation ID qua supported surface và evidence ID thuộc project đó; nếu không có, STOP existing mode. Chỉ chọn `new` mode khi user đồng ý rõ một App conversation mới. Chưa tìm thấy cách supported để lấy các identity này từ focused pane; không yêu cầu đoán/copy private IDs hoặc đọc session databases. Đây là config binding một lần, không phải copy-paste từng task.

## I. Real one-job pilot: NOT RUN

Không có activation approval hoặc resolved support/policy gates; không gửi consumer job. Vì vậy chưa có bằng chứng App-owned Sidecar thật claim, intended App conversation nhận, worker thực thi hoặc parent verify real result. Chỉ smoke mock đi đủ lifecycle và được lưu với `actual_antigravity_execution:false`.

Pilot tương lai chỉ được thực hiện sau opt-in riêng: đúng một README task không nhạy cảm, read-only, không network/AWS/deploy/Git writes; cần chứng minh cả sáu acceptance steps bằng runtime evidence hợp lệ, không dựa vào mock hoặc process exit 0.

## J. Optimization

Chưa có real success nên dispatch/completion latency và usage cost là **NOT MEASURED**; không đưa ra speedup hoặc tối ưu suy đoán. Candidate đã có bounded polling, single consumer và no-resend để correctness có thể test offline. Giữ DIRECT cho microtasks và native Codex cho brief độc lập. Chỉ sau real pilot thành công mới chọn một tối ưu dựa trên measurement thực.

## Existing manual Desktop handoff — contract reconciliation

User đã quan sát một lần Antigravity Desktop execution cho task `fd72b689-d40f-4722-871c-a1fe61f34435`, attempt `4b0a7abe-8b23-42ba-9700-034e592c2602`. Hai output gốc nằm trong ignored `state/desktop-relay-pilot-fd72b689-d40f-4722-871c-a1fe61f34435/output/`. Reconciliation chỉ dùng lại files này; không tạo pilot/job mới hoặc yêu cầu Anti chạy lại. Historical request, relay prompt, reports và receipts giữ nguyên.

Canonical contract của source/template/verifier hiện thống nhất `errors`/`evidence`; normalization áp dụng quy tắc ở trên. Content/contract verification tách khỏi execution attribution: provenance vẫn **user-observed Desktop execution; independent App receipt unavailable**. Automatic Codex-to-Antigravity dispatch vẫn **NOT TESTED**. Các kết luận offline và chưa có automated pilot ở trên là lịch sử của lần build; manual file handoff không mở live transport hoặc gỡ policy/runtime/target gates.

Fresh reconciliation evidence và normalized report được lưu riêng trong `state/desktop-relay-pilot-fd72b689-d40f-4722-871c-a1fe61f34435/contract-reconciliation-20261105/`. Không cập nhật V1 checksum baseline hoặc nâng workflow version.
