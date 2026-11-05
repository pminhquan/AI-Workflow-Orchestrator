import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, inside, scopedPath, sha256 } from '../../src/core/util.mjs';
import { makeJob } from '../../src/desktop-inbox/contracts.mjs';
import { captureWorkspace } from '../../src/desktop-inbox/verification.mjs';
import { atomicWriteJSON, openLiveInbox } from '../../src/desktop-inbox/live-bridge.mjs';
import { bridgeMetrics } from '../../src/desktop-inbox/bridge-cli.mjs';
import {
  PHASE_NAMES,
  TASK_BUCKETS,
  UNSUPPORTED_TIMINGS,
  aggregateRecordsTelemetry,
  classifyTaskBucket,
  deriveTaskTelemetry,
  parseEventTimestampMs,
  safeDurationMs,
  summarizeDurations
} from '../../src/desktop-inbox/telemetry.mjs';

function createTempTelemetryEnv() {
  const rel = `state/test-telemetry-${randomUUID()}`;
  const dir = resolve(ROOT, rel);
  const stateDirectory = `${rel}/live-state`;
  const workspace = resolve(dir, 'project');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(resolve(workspace, 'README.md'), '# Telemetry Test Workspace\n');
  return {
    rel,
    dir,
    stateDirectory,
    workspace,
    cleanup() {
      const stateRoot = resolve(ROOT, 'state');
      assert.ok(inside(stateRoot, dir) && dir !== stateRoot);
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function writeValidWorkerReport(inbox, job, findings = ['Verified cleanly']) {
  const report = {
    schema_version: 'desktop-inbox.report@1',
    task_id: job.task_id,
    attempt_id: job.attempt_id,
    workspace: job.workspace_root,
    status: 'reported',
    inspected_files: ['README.md'],
    changed_files: [],
    tests: [],
    findings,
    blockers: [],
    errors: [],
    evidence: ['README.md (inspected)']
  };
  atomicWriteJSON(scopedPath(inbox.root, job.expected_output), report, { exclusive: true });
}

test('parseEventTimestampMs, safeDurationMs, and summarizeDurations enforce epoch-0 validity, nonmonotonic null, and p95', () => {
  // Timestamp 0 must never be falsy-rejected
  assert.equal(parseEventTimestampMs('1970-01-01T00:00:00.000Z'), 0);
  assert.equal(parseEventTimestampMs('1970-01-01T00:00:00Z'), 0);
  assert.equal(parseEventTimestampMs('1970-01-01T07:00:00+07:00'), 0);
  assert.equal(parseEventTimestampMs('2026-11-05T17:18:38.250Z'), Date.parse('2026-11-05T17:18:38.250Z'));

  // Missing, non-string, non-ISO, and impossible calendar dates return null
  assert.equal(parseEventTimestampMs(null), null);
  assert.equal(parseEventTimestampMs(undefined), null);
  assert.equal(parseEventTimestampMs(0), null);
  assert.equal(parseEventTimestampMs(''), null);
  assert.equal(parseEventTimestampMs('   '), null);
  assert.equal(parseEventTimestampMs('12345'), null);
  assert.equal(parseEventTimestampMs('subtask 12ms'), null);
  assert.equal(parseEventTimestampMs('2026-11-05'), null);
  assert.equal(parseEventTimestampMs('2026-02-30T00:00:00.000Z'), null);
  assert.equal(parseEventTimestampMs('2026-13-01T00:00:00.000Z'), null);

  // safeDurationMs preserves zero intervals and returns null (never 0) for negative/invalid
  assert.equal(safeDurationMs(0, 0), 0);
  assert.equal(safeDurationMs(0, 145), 145);
  assert.equal(safeDurationMs(500, 500), 0);
  assert.equal(safeDurationMs(500, 499), null);
  assert.equal(safeDurationMs(10, -5), null);
  assert.equal(safeDurationMs(null, 100), null);
  assert.equal(safeDurationMs(100, null), null);
  assert.equal(safeDurationMs(Number.NaN, 100), null);
  assert.equal(safeDurationMs(100, Number.POSITIVE_INFINITY), null);

  // summarizeDurations handles empty, odd, even, nearest-rank p95, and filters invalid samples
  assert.deepEqual(summarizeDurations([]), {
    count: 0,
    average_ms: null,
    median_ms: null,
    p95_ms: null
  });
  assert.deepEqual(summarizeDurations([null, undefined, Number.NaN, -10]), {
    count: 0,
    average_ms: null,
    median_ms: null,
    p95_ms: null
  });
  assert.deepEqual(summarizeDurations([0]), {
    count: 1,
    average_ms: 0,
    median_ms: 0,
    p95_ms: 0
  });
  assert.deepEqual(summarizeDurations([40, 10, 20, 30]), {
    count: 4,
    average_ms: 25,
    median_ms: 25,
    p95_ms: 40
  });

  const twenty = Array.from({ length: 20 }, (_, idx) => (idx + 1) * 10);
  assert.deepEqual(summarizeDurations(twenty), {
    count: 20,
    average_ms: 105,
    median_ms: 105,
    p95_ms: 190
  });
});

test('full VERIFIED lifecycle starting at epoch timestamp 0 derives exact 6 phases and delivery fallback', () => {
  const env = createTempTelemetryEnv();
  try {
    let clockMs = 0; // "1970-01-01T00:00:00.000Z"
    const { inbox, config } = openLiveInbox(env.workspace, {
      stateDirectory: env.stateDirectory,
      now: () => clockMs
    });
    const baseline = captureWorkspace(env.workspace);

    const job = makeJob(
      config.binding,
      {
        task_id: '00000000-0000-4000-8000-000000000001',
        attempt_id: '00000000-0000-4000-8000-000000000101',
        goal: 'Epoch zero telemetry verification',
        read_scope: ['README.md'],
        write_scope: [],
        acceptance_criteria: ['All six phases measured'],
        verification_commands: ['noop']
      },
      { now: () => clockMs }
    );

    // 1. Queue at t = 0 ("1970-01-01T00:00:00.000Z")
    const submitted = inbox.submit(job, { baseline });
    assert.equal(submitted.events[0].at, '1970-01-01T00:00:00.000Z');

    // 2. Claim at t = 25ms
    clockMs = 25;
    const claimed = inbox.claim(job.task_id);

    // 3. Begin dispatch intent at t = 60ms
    clockMs = 60;
    inbox.beginDispatch(job.task_id, claimed.claim_id);

    // 4. Transport return recorded at t = 150ms
    clockMs = 150;
    inbox.recordDelivery(job.task_id, claimed.claim_id, {
      kind: 'ANTIGRAVITY_AGENTAPI',
      mode: 'send-message',
      dispatched_at: new Date(clockMs).toISOString(),
      started: true,
      exit_code: 0
    });

    // 5. Worker report accepted at t = 1150ms (with decoy timing strings in findings)
    clockMs = 1150;
    writeValidWorkerReport(inbox, job, [
      'subtask took 12ms',
      'subtask_fanout_ms=12ms, subagent_wakeup_ms=4ms'
    ]);
    const ready = inbox.acceptReport(job.task_id);

    // 6. Parent verifies at t = 1400ms
    clockMs = 1400;
    const verifiedRecord = inbox.verify(job.task_id, {
      kind: 'desktop-inbox.host-receipt@1',
      task_id: job.task_id,
      attempt_id: job.attempt_id,
      workspace_root: config.workspace_root,
      report_sha256: ready.report_sha256,
      job_sha256: sha256(ready.job),
      baseline_sha256: baseline.hash,
      after_sha256: baseline.hash,
      checks: [{ check_id: 'noop', exit_code: 0, passed: true }],
      actual_changed_files: [],
      accepted: true,
      verified_at: new Date(clockMs).toISOString()
    });

    const derived = deriveTaskTelemetry(verifiedRecord);
    assert.equal(derived.task_id, job.task_id);
    assert.equal(derived.attempt_id, job.attempt_id);
    assert.equal(derived.workspace_root, config.workspace_root);
    assert.equal(derived.state, 'VERIFIED');
    assert.equal(derived.outcome, null);
    assert.equal(derived.bucket, 'verified');
    assert.deepEqual(derived.phases, {
      queue_to_claim_ms: 25,
      claim_to_dispatch_ms: 35,
      transport_return_ms: 90,
      dispatch_to_report_ms: 1000,
      report_to_verify_ms: 250,
      total_ms: 1400
    });
    assert.deepEqual(derived.unmeasured, {
      subtask_fanout_ms: null,
      subagent_wakeup_ms: null
    });
    assert.deepEqual(derived.legacy, {
      queue_to_dispatch_ms: 60,
      worker_execution_ms: 1090,
      total_turnaround_ms: 1400
    });

    // Synthetic check: fallback to delivery.dispatched_at when transport event is absent but RECORDED
    const fallbackRecord = structuredClone(verifiedRecord);
    fallbackRecord.events = fallbackRecord.events.filter(
      ev => !(ev.state === 'DISPATCHED' && ev.reason.startsWith('Transport returned'))
    );
    fallbackRecord.delivery = { status: 'RECORDED', dispatched_at: '1970-01-01T00:00:00.200Z' };
    const fallbackDerived = deriveTaskTelemetry(fallbackRecord);
    assert.equal(fallbackDerived.phases.transport_return_ms, 140);
    assert.equal(fallbackDerived.phases.dispatch_to_report_ms, 950);

    // Without a transport-return timestamp, neither phase may invent that boundary.
    const crashRecord = structuredClone(fallbackRecord);
    crashRecord.delivery = { status: 'ATTEMPTING', started: null };
    const crashDerived = deriveTaskTelemetry(crashRecord);
    assert.equal(crashDerived.phases.transport_return_ms, null);
    assert.equal(crashDerived.phases.dispatch_to_report_ms, null);
    assert.equal(crashDerived.legacy.worker_execution_ms, 1090);

    const partialSummary = aggregateRecordsTelemetry([verifiedRecord, crashRecord]);
    assert.equal(partialSummary.verified_phases.dispatch_to_report_ms.count, 1);
    assert.equal(partialSummary.verified_phases.dispatch_to_report_ms.average_ms, 1000);
  } finally {
    env.cleanup();
  }
});

test('outcome separation isolates VERIFIED phases from RELEASED, FAILED, UNCERTAIN_DELIVERY, CANCELLED, and ACTIVE records', () => {
  const ws = resolve(ROOT, 'state');
  const mkEvent = (ms, state, outcome = null, reason = 'step') => ({
    at: new Date(ms).toISOString(),
    state,
    outcome,
    reason
  });

  // Two VERIFIED tasks with clean timings
  const verifiedFast = {
    format: 'desktop-inbox.record@1',
    job: { task_id: '00000000-0000-4000-8000-000000000001', attempt_id: '00000000-0000-4000-8000-000000000101', workspace_root: ws },
    state: 'VERIFIED',
    outcome: null,
    delivery: { status: 'RECORDED', dispatched_at: new Date(100).toISOString() },
    events: [
      mkEvent(0, 'PENDING', null, 'Host submitted job'),
      mkEvent(10, 'CLAIMED', null, 'Sidecar claimed job'),
      mkEvent(30, 'DISPATCHED', null, 'Durable dispatch intent; receipt and execution not yet known'),
      mkEvent(100, 'DISPATCHED', null, 'Transport returned; this is not worker completion'),
      mkEvent(400, 'RESULT_READY', null, 'Matching worker report preserved; parent verification required'),
      mkEvent(500, 'VERIFIED', null, 'Codex parent accepted independently checked result')
    ]
  };

  const verifiedSlow = {
    format: 'desktop-inbox.record@1',
    job: { task_id: '00000000-0000-4000-8000-000000000002', attempt_id: '00000000-0000-4000-8000-000000000102', workspace_root: ws },
    state: 'VERIFIED',
    outcome: null,
    delivery: { status: 'RECORDED', dispatched_at: new Date(200).toISOString() },
    events: [
      mkEvent(0, 'PENDING', null, 'Host submitted job'),
      mkEvent(30, 'CLAIMED', null, 'Sidecar claimed job'),
      mkEvent(70, 'DISPATCHED', null, 'Durable dispatch intent; receipt and execution not yet known'),
      mkEvent(200, 'DISPATCHED', null, 'Transport returned; this is not worker completion'),
      mkEvent(900, 'RESULT_READY', null, 'Matching worker report preserved; parent verification required'),
      mkEvent(1100, 'VERIFIED', null, 'Codex parent accepted independently checked result')
    ]
  };

  // RELEASED after rejection in RESULT_READY (99,000ms outlier must NOT pollute verified_phases!)
  const releasedRejected = {
    format: 'desktop-inbox.record@1',
    job: { task_id: '00000000-0000-4000-8000-000000000003', attempt_id: '00000000-0000-4000-8000-000000000103', workspace_root: ws },
    state: 'RESULT_READY',
    outcome: 'RELEASED',
    delivery: { status: 'RECORDED', dispatched_at: new Date(1000).toISOString() },
    events: [
      mkEvent(0, 'PENDING', null, 'Host submitted job'),
      mkEvent(200, 'CLAIMED', null, 'Sidecar claimed job'),
      mkEvent(500, 'DISPATCHED', null, 'Durable dispatch intent; receipt and execution not yet known'),
      mkEvent(1000, 'DISPATCHED', null, 'Transport returned; this is not worker completion'),
      mkEvent(100000, 'RESULT_READY', null, 'Matching worker report preserved; parent verification required'),
      mkEvent(105000, 'RESULT_READY', 'RELEASED', 'Rejected for rework')
    ]
  };

  // FAILED pre-spawn ENOENT
  const failedSpawn = {
    format: 'desktop-inbox.record@1',
    job: { task_id: '00000000-0000-4000-8000-000000000004', attempt_id: '00000000-0000-4000-8000-000000000104', workspace_root: ws },
    state: 'DISPATCHED',
    outcome: 'FAILED',
    delivery: { status: 'RECORDED', started: false, spawn_error: 'ENOENT', dispatched_at: new Date(8000).toISOString() },
    events: [
      mkEvent(0, 'PENDING', null, 'Host submitted job'),
      mkEvent(4000, 'CLAIMED', null, 'Sidecar claimed job'),
      mkEvent(6000, 'DISPATCHED', null, 'Durable dispatch intent; receipt and execution not yet known'),
      mkEvent(8000, 'DISPATCHED', null, 'Transport returned; this is not worker completion'),
      mkEvent(8010, 'DISPATCHED', 'FAILED', 'agentapi unavailable (ENOENT)')
    ]
  };

  // UNCERTAIN_DELIVERY (e.g. sidecar recovery before recordDelivery, with decoy reason text)
  const uncertainRecovered = {
    format: 'desktop-inbox.record@1',
    job: { task_id: '00000000-0000-4000-8000-000000000005', attempt_id: '00000000-0000-4000-8000-000000000105', workspace_root: ws },
    state: 'DISPATCHED',
    outcome: 'UNCERTAIN_DELIVERY',
    delivery: { status: 'ATTEMPTING', started: null },
    events: [
      mkEvent(0, 'PENDING', null, 'Host submitted job'),
      mkEvent(5000, 'CLAIMED', null, 'Sidecar claimed job'),
      mkEvent(9000, 'DISPATCHED', null, 'Durable dispatch intent; receipt and execution not yet known'),
      mkEvent(15000, 'DISPATCHED', 'UNCERTAIN_DELIVERY', 'Transport returned error during crash recovery')
    ]
  };

  // CANCELLED while PENDING
  const cancelledPending = {
    format: 'desktop-inbox.record@1',
    job: { task_id: '00000000-0000-4000-8000-000000000006', attempt_id: '00000000-0000-4000-8000-000000000106', workspace_root: ws },
    state: 'PENDING',
    outcome: 'CANCELLED',
    delivery: null,
    events: [
      mkEvent(0, 'PENDING', null, 'Host submitted job'),
      mkEvent(300, 'PENDING', 'CANCELLED', 'Cancelled before dispatch')
    ]
  };

  // ACTIVE tasks (one PENDING, one DISPATCHED)
  const activePending = {
    format: 'desktop-inbox.record@1',
    job: { task_id: '00000000-0000-4000-8000-000000000007', attempt_id: '00000000-0000-4000-8000-000000000107', workspace_root: ws },
    state: 'PENDING',
    outcome: null,
    delivery: null,
    events: [mkEvent(1000, 'PENDING', null, 'Host submitted job')]
  };

  const activeDispatched = {
    format: 'desktop-inbox.record@1',
    job: { task_id: '00000000-0000-4000-8000-000000000008', attempt_id: '00000000-0000-4000-8000-000000000108', workspace_root: ws },
    state: 'DISPATCHED',
    outcome: null,
    delivery: { status: 'RECORDED', dispatched_at: new Date(1350).toISOString() },
    events: [
      mkEvent(1000, 'PENDING', null, 'Host submitted job'),
      mkEvent(1100, 'CLAIMED', null, 'Sidecar claimed job'),
      mkEvent(1200, 'DISPATCHED', null, 'Durable dispatch intent; receipt and execution not yet known'),
      mkEvent(1350, 'DISPATCHED', null, 'Transport returned; this is not worker completion')
    ]
  };

  assert.equal(classifyTaskBucket(verifiedFast), 'verified');
  assert.equal(classifyTaskBucket(releasedRejected), 'released');
  assert.equal(classifyTaskBucket(failedSpawn), 'failed');
  assert.equal(classifyTaskBucket(uncertainRecovered), 'uncertain');
  assert.equal(classifyTaskBucket(cancelledPending), 'cancelled');
  assert.equal(classifyTaskBucket(activePending), 'active');
  assert.equal(classifyTaskBucket(activeDispatched), 'active');

  // Feed in shuffled order to also verify deterministic task ordering
  const agg = aggregateRecordsTelemetry([
    activeDispatched,
    failedSpawn,
    verifiedSlow,
    cancelledPending,
    releasedRejected,
    verifiedFast,
    uncertainRecovered,
    activePending
  ]);

  assert.equal(agg.total_tasks, 8);
  assert.deepEqual(agg.phase_names, PHASE_NAMES);
  assert.deepEqual(agg.unsupported_timings, UNSUPPORTED_TIMINGS);
  assert.deepEqual(Object.keys(agg.outcome_groups), TASK_BUCKETS);

  // Deterministic order by workspace_root, task_id, attempt_id
  assert.deepEqual(
    agg.tasks.map(t => t.task_id),
    [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000005',
      '00000000-0000-4000-8000-000000000006',
      '00000000-0000-4000-8000-000000000007',
      '00000000-0000-4000-8000-000000000008'
    ]
  );

  // verified_phases strictly reflects ONLY verifiedFast & verifiedSlow
  // queue_to_claim: [10, 30] -> avg 20, median 20, p95 30
  // claim_to_dispatch: [20, 40] -> avg 30, median 30, p95 40
  // transport_return: [70, 130] -> avg 100, median 100, p95 130
  // dispatch_to_report: [300, 700] -> avg 500, median 500, p95 700
  // report_to_verify: [100, 200] -> avg 150, median 150, p95 200
  // total_ms: [500, 1100] -> avg 800, median 800, p95 1100
  assert.deepEqual(agg.verified_phases, {
    queue_to_claim_ms: { count: 2, average_ms: 20, median_ms: 20, p95_ms: 30 },
    claim_to_dispatch_ms: { count: 2, average_ms: 30, median_ms: 30, p95_ms: 40 },
    transport_return_ms: { count: 2, average_ms: 100, median_ms: 100, p95_ms: 130 },
    dispatch_to_report_ms: { count: 2, average_ms: 500, median_ms: 500, p95_ms: 700 },
    report_to_verify_ms: { count: 2, average_ms: 150, median_ms: 150, p95_ms: 200 },
    total_ms: { count: 2, average_ms: 800, median_ms: 800, p95_ms: 1100 }
  });
  assert.deepEqual(agg.outcome_groups.verified.phases, agg.verified_phases);
  assert.equal(agg.outcome_groups.verified.count, 2);

  // Separate non-verified buckets capture partial phases cleanly
  assert.equal(agg.outcome_groups.released.count, 1);
  assert.equal(agg.outcome_groups.released.phases.dispatch_to_report_ms.average_ms, 99000);
  assert.equal(agg.outcome_groups.released.phases.report_to_verify_ms.count, 0);
  assert.equal(agg.outcome_groups.released.phases.total_ms.count, 0);

  assert.equal(agg.outcome_groups.failed.count, 1);
  assert.equal(agg.outcome_groups.failed.phases.transport_return_ms.average_ms, 2000);
  assert.equal(agg.outcome_groups.failed.phases.dispatch_to_report_ms.count, 0);

  // Decoy recovery event with outcome !== null and reason starting with "Transport returned" must NOT fake transport_return_ms
  assert.equal(agg.outcome_groups.uncertain.count, 1);
  assert.equal(agg.outcome_groups.uncertain.phases.claim_to_dispatch_ms.average_ms, 4000);
  assert.equal(agg.outcome_groups.uncertain.phases.transport_return_ms.count, 0);

  assert.equal(agg.outcome_groups.cancelled.count, 1);
  assert.equal(agg.outcome_groups.cancelled.phases.queue_to_claim_ms.count, 0);

  assert.equal(agg.outcome_groups.active.count, 2);
  assert.equal(agg.outcome_groups.active.phases.transport_return_ms.count, 1);
  assert.equal(agg.outcome_groups.active.phases.transport_return_ms.average_ms, 150);
});

test('missing, malformed, and nonmonotonic event timestamps return null and are never clamped to 0', () => {
  const nonmonotonicRecord = {
    format: 'desktop-inbox.record@1',
    job: {
      task_id: '00000000-0000-4000-8000-000000000010',
      attempt_id: '00000000-0000-4000-8000-000000000110',
      workspace_root: resolve(ROOT, 'state')
    },
    state: 'VERIFIED',
    outcome: null,
    delivery: { status: 'RECORDED', dispatched_at: '1970-01-01T00:00:00.800Z' },
    events: [
      { at: '1970-01-01T00:00:01.000Z', state: 'PENDING', outcome: null, reason: 'submitted at 1000ms' },
      { at: '1970-01-01T00:00:00.900Z', state: 'CLAIMED', outcome: null, reason: 'clock backwards to 900ms' },
      { at: '1970-01-01T00:00:00.850Z', state: 'DISPATCHED', outcome: null, reason: 'clock backwards to 850ms' },
      { at: '1970-01-01T00:00:00.800Z', state: 'DISPATCHED', outcome: null, reason: 'Transport returned; clock backwards to 800ms' },
      { at: '1970-01-01T00:00:00.700Z', state: 'RESULT_READY', outcome: null, reason: 'clock backwards to 700ms' },
      { at: '1970-01-01T00:00:00.600Z', state: 'VERIFIED', outcome: null, reason: 'clock backwards to 600ms' }
    ]
  };

  const malformedRecord = {
    format: 'desktop-inbox.record@1',
    job: {
      task_id: '00000000-0000-4000-8000-000000000011',
      attempt_id: '00000000-0000-4000-8000-000000000111',
      workspace_root: resolve(ROOT, 'state')
    },
    state: 'VERIFIED',
    outcome: null,
    delivery: { status: 'RECORDED', dispatched_at: 'not-a-timestamp' },
    events: [
      { at: 'bad-pending', state: 'PENDING', outcome: null, reason: 'bad' },
      { at: '', state: 'CLAIMED', outcome: null, reason: 'empty' },
      { at: '2026-02-30T00:00:00.000Z', state: 'DISPATCHED', outcome: null, reason: 'invalid calendar date' },
      { at: null, state: 'RESULT_READY', outcome: null, reason: 'missing at' },
      { at: 'subtask took 12ms', state: 'VERIFIED', outcome: null, reason: 'free text in at' }
    ]
  };

  for (const rec of [nonmonotonicRecord, malformedRecord]) {
    const t = deriveTaskTelemetry(rec);
    for (const phase of PHASE_NAMES) {
      assert.equal(t.phases[phase], null, `Expected ${phase} to be null, never clamped to 0`);
    }
    assert.equal(t.legacy.queue_to_dispatch_ms, null);
    assert.equal(t.legacy.worker_execution_ms, null);
    assert.equal(t.legacy.total_turnaround_ms, null);
  }

  const agg = aggregateRecordsTelemetry([nonmonotonicRecord, malformedRecord]);
  assert.equal(agg.total_tasks, 2);
  assert.equal(agg.outcome_groups.verified.count, 2);
  for (const phase of PHASE_NAMES) {
    assert.deepEqual(agg.verified_phases[phase], {
      count: 0,
      average_ms: null,
      median_ms: null,
      p95_ms: null
    });
  }
  assert.equal(agg.queue_to_dispatch_ms.count, 0);
  assert.equal(agg.worker_execution_ms.count, 0);
  assert.equal(agg.total_turnaround_ms.count, 0);
});

test('bridgeMetrics CLI integration preserves legacy fields and exposes phase and outcome metrics cleanly', () => {
  const env = createTempTelemetryEnv();
  try {
    let clockMs = 1_700_000_000_000;
    const { inbox, config } = openLiveInbox(env.workspace, {
      stateDirectory: env.stateDirectory,
      now: () => clockMs
    });
    const baseline = captureWorkspace(env.workspace);

    // Task 1: Full VERIFIED task
    const job1 = makeJob(
      config.binding,
      {
        task_id: '00000000-0000-4000-8000-000000000021',
        attempt_id: '00000000-0000-4000-8000-000000000121',
        goal: 'First live telemetry task',
        read_scope: ['README.md'],
        write_scope: [],
        acceptance_criteria: ['Verified'],
        verification_commands: ['noop']
      },
      { now: () => clockMs }
    );
    inbox.submit(job1, { baseline });
    clockMs += 15;
    const claim1 = inbox.claim(job1.task_id);
    clockMs += 25;
    inbox.beginDispatch(job1.task_id, claim1.claim_id);
    clockMs += 60;
    inbox.recordDelivery(job1.task_id, claim1.claim_id, {
      kind: 'ANTIGRAVITY_AGENTAPI',
      mode: 'send-message',
      dispatched_at: new Date(clockMs).toISOString(),
      started: true,
      exit_code: 0
    });
    clockMs += 400;
    writeValidWorkerReport(inbox, job1, ['subtask took 12ms; subagent_wakeup_ms=9ms']);
    const ready1 = inbox.acceptReport(job1.task_id);
    clockMs += 100;
    inbox.verify(job1.task_id, {
      kind: 'desktop-inbox.host-receipt@1',
      task_id: job1.task_id,
      attempt_id: job1.attempt_id,
      workspace_root: config.workspace_root,
      report_sha256: ready1.report_sha256,
      job_sha256: sha256(ready1.job),
      baseline_sha256: baseline.hash,
      after_sha256: baseline.hash,
      checks: [{ check_id: 'noop', exit_code: 0, passed: true }],
      actual_changed_files: [],
      accepted: true,
      verified_at: new Date(clockMs).toISOString()
    });

    // Task 2: FAILED pre-spawn ENOENT task (released afterwards -> bucket 'released')
    clockMs += 1000;
    const job2 = makeJob(
      config.binding,
      {
        task_id: '00000000-0000-4000-8000-000000000022',
        attempt_id: '00000000-0000-4000-8000-000000000122',
        goal: 'Failed then released task',
        read_scope: ['README.md'],
        write_scope: [],
        acceptance_criteria: ['Released'],
        verification_commands: ['noop']
      },
      { now: () => clockMs }
    );
    inbox.submit(job2, { baseline });
    clockMs += 500;
    const claim2 = inbox.claim(job2.task_id);
    clockMs += 500;
    inbox.beginDispatch(job2.task_id, claim2.claim_id);
    clockMs += 500;
    inbox.recordDelivery(job2.task_id, claim2.claim_id, {
      kind: 'ANTIGRAVITY_AGENTAPI',
      mode: 'send-message',
      dispatched_at: new Date(clockMs).toISOString(),
      started: false,
      spawn_error: 'ENOENT',
      exit_code: null
    });
    inbox.fail(job2.task_id, claim2.claim_id, 'agentapi unavailable (ENOENT)');
    inbox.release(job2.task_id, 'Operator cleared failed task');

    // Task 3: Active PENDING task
    clockMs += 1000;
    const job3 = makeJob(
      config.binding,
      {
        task_id: '00000000-0000-4000-8000-000000000023',
        attempt_id: '00000000-0000-4000-8000-000000000123',
        goal: 'Currently pending task',
        read_scope: ['README.md'],
        write_scope: [],
        acceptance_criteria: ['Pending'],
        verification_commands: ['noop']
      },
      { now: () => clockMs }
    );
    inbox.submit(job3, { baseline });

    const metrics = bridgeMetrics({
      workspaceRoot: env.workspace,
      stateDirectory: env.stateDirectory
    });

    assert.equal(metrics.workspace_root, config.workspace_root);
    assert.equal(metrics.workspaces_scanned, 1);
    assert.equal(metrics.total_tasks, 3);
    assert.deepEqual(metrics.by_state, {
      PENDING: 1,
      CLAIMED: 0,
      DISPATCHED: 1,
      RESULT_READY: 0,
      VERIFIED: 1
    });
    assert.deepEqual(metrics.by_outcome, {
      NONE: 2,
      FAILED: 0,
      CANCELLED: 0,
      UNCERTAIN_DELIVERY: 0,
      RELEASED: 1
    });

    // Legacy summaries coexist and now include p95_ms
    assert.deepEqual(metrics.queue_to_dispatch_ms, {
      count: 2,
      average_ms: 520,
      median_ms: 520,
      p95_ms: 1000
    });
    assert.deepEqual(metrics.worker_execution_ms, {
      count: 1,
      average_ms: 460,
      median_ms: 460,
      p95_ms: 460
    });
    assert.deepEqual(metrics.total_turnaround_ms, {
      count: 1,
      average_ms: 600,
      median_ms: 600,
      p95_ms: 600
    });

    // Verified phases reflect ONLY job1, uncontaminated by job2's 500ms intervals
    assert.deepEqual(metrics.verified_phases, {
      queue_to_claim_ms: { count: 1, average_ms: 15, median_ms: 15, p95_ms: 15 },
      claim_to_dispatch_ms: { count: 1, average_ms: 25, median_ms: 25, p95_ms: 25 },
      transport_return_ms: { count: 1, average_ms: 60, median_ms: 60, p95_ms: 60 },
      dispatch_to_report_ms: { count: 1, average_ms: 400, median_ms: 400, p95_ms: 400 },
      report_to_verify_ms: { count: 1, average_ms: 100, median_ms: 100, p95_ms: 100 },
      total_ms: { count: 1, average_ms: 600, median_ms: 600, p95_ms: 600 }
    });

    assert.equal(metrics.outcome_groups.verified.count, 1);
    assert.deepEqual(metrics.outcome_groups.verified.task_ids, [job1.task_id]);
    assert.equal(metrics.outcome_groups.released.count, 1);
    assert.deepEqual(metrics.outcome_groups.released.task_ids, [job2.task_id]);
    assert.equal(metrics.outcome_groups.released.phases.transport_return_ms.average_ms, 500);
    assert.equal(metrics.outcome_groups.active.count, 1);
    assert.deepEqual(metrics.outcome_groups.active.task_ids, [job3.task_id]);
    assert.equal(metrics.tasks.length, 3);
    assert.deepEqual(metrics.tasks[0].unmeasured, {
      subtask_fanout_ms: null,
      subagent_wakeup_ms: null
    });

    // Multi-workspace scan mode (workspaceRoot omitted) also works cleanly
    const globalMetrics = bridgeMetrics({ stateDirectory: env.stateDirectory });
    assert.equal(globalMetrics.workspace_root, null);
    assert.equal(globalMetrics.workspaces_scanned, 1);
    assert.equal(globalMetrics.total_tasks, 3);
  } finally {
    env.cleanup();
  }
});
