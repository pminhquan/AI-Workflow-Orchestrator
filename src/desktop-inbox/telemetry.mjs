export const PHASE_NAMES = [
  'queue_to_claim_ms',
  'claim_to_dispatch_ms',
  'transport_return_ms',
  'dispatch_to_report_ms',
  'report_to_verify_ms',
  'total_ms'
];

export const UNSUPPORTED_TIMINGS = [
  'subtask_fanout_ms',
  'subagent_wakeup_ms'
];

export const TASK_BUCKETS = [
  'verified',
  'released',
  'failed',
  'uncertain',
  'cancelled',
  'active'
];

const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;

export function parseEventTimestampMs(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const match = ISO_TIMESTAMP_RE.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  if (match[8]) {
    const tzHour = Number(match[9]);
    const tzMinute = Number(match[10]);
    if (tzHour > 23 || tzMinute > 59) return null;
  }
  const calendarCheck = new Date(0);
  calendarCheck.setUTCFullYear(year, month - 1, day);
  if (
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== month - 1 ||
    calendarCheck.getUTCDate() !== day
  ) {
    return null;
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

export function safeDurationMs(startMs, endMs) {
  if (
    typeof startMs !== 'number' ||
    typeof endMs !== 'number' ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs)
  ) {
    return null;
  }
  if (endMs < startMs) return null;
  if (endMs === startMs) return 0;
  return endMs - startMs;
}

export function summarizeDurations(samples) {
  const valid = Array.isArray(samples)
    ? samples.filter(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    : [];
  const count = valid.length;
  if (count === 0) {
    return { count: 0, average_ms: null, median_ms: null, p95_ms: null };
  }
  const sorted = [...valid].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mid = Math.floor(count / 2);
  const median_ms = count % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  const p95Index = Math.min(count - 1, Math.ceil(count * 0.95) - 1);
  return {
    count,
    average_ms: Math.round(sum / count),
    median_ms,
    p95_ms: sorted[p95Index]
  };
}

export function classifyTaskBucket(record) {
  if (record?.state === 'VERIFIED' && record?.outcome === null) return 'verified';
  if (record?.outcome === 'RELEASED') return 'released';
  if (record?.outcome === 'FAILED') return 'failed';
  if (record?.outcome === 'UNCERTAIN_DELIVERY') return 'uncertain';
  if (record?.outcome === 'CANCELLED') return 'cancelled';
  return 'active';
}

function firstStateEventMs(events, state) {
  const hit = events.find(ev => ev?.state === state);
  return hit ? parseEventTimestampMs(hit.at) : null;
}

function findTransportReturnEvent(events) {
  const byReason = events.find(
    ev =>
      ev?.state === 'DISPATCHED' &&
      (ev.outcome === null || ev.outcome === undefined) &&
      typeof ev.reason === 'string' &&
      ev.reason.startsWith('Transport returned')
  );
  if (byReason) return byReason;
  const dispatchedNullOutcome = events.filter(
    ev => ev?.state === 'DISPATCHED' && (ev.outcome === null || ev.outcome === undefined)
  );
  if (dispatchedNullOutcome.length >= 2) return dispatchedNullOutcome[1];
  return null;
}

export function deriveTaskTelemetry(record) {
  const events = Array.isArray(record?.events) ? record.events : [];
  const queuedAt = firstStateEventMs(events, 'PENDING');
  const claimedAt = firstStateEventMs(events, 'CLAIMED');
  const dispatchIntentAt = firstStateEventMs(events, 'DISPATCHED');
  const offeredOnly=record?.delivery?.delivery_confirmed===false;
  const transportEvent = offeredOnly?null:findTransportReturnEvent(events);
  const transportReturnAt = transportEvent
    ? parseEventTimestampMs(transportEvent.at)
    : (!offeredOnly&&record?.delivery?.status === 'RECORDED'
        ? parseEventTimestampMs(record.delivery.dispatched_at)
        : null);
  const reportAt = firstStateEventMs(events, 'RESULT_READY');
  const verifiedAt = firstStateEventMs(events, 'VERIFIED');

  const queue_to_claim_ms = safeDurationMs(queuedAt, claimedAt);
  const claim_to_dispatch_ms = safeDurationMs(claimedAt, dispatchIntentAt);
  const transport_return_ms = safeDurationMs(dispatchIntentAt, transportReturnAt);
  const dispatch_to_report_ms = safeDurationMs(transportReturnAt, reportAt);
  const report_to_verify_ms = safeDurationMs(reportAt, verifiedAt);
  const total_ms = safeDurationMs(queuedAt, verifiedAt);

  return {
    task_id: record?.job?.task_id ?? null,
    attempt_id: record?.job?.attempt_id ?? null,
    workspace_root: record?.job?.workspace_root ?? null,
    state: record?.state ?? null,
    outcome: record?.outcome ?? null,
    bucket: classifyTaskBucket(record),
    phases: {
      queue_to_claim_ms,
      claim_to_dispatch_ms,
      transport_return_ms,
      dispatch_to_report_ms,
      report_to_verify_ms,
      total_ms
    },
    unmeasured: {
      subtask_fanout_ms: null,
      subagent_wakeup_ms: null
    },
    legacy: {
      queue_to_dispatch_ms: safeDurationMs(queuedAt, dispatchIntentAt),
      worker_execution_ms: safeDurationMs(dispatchIntentAt, reportAt),
      total_turnaround_ms: safeDurationMs(queuedAt, verifiedAt)
    }
  };
}

function compareCodeUnits(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function summarizeTaskPhases(taskItems) {
  const out = {};
  for (const phase of PHASE_NAMES) {
    out[phase] = summarizeDurations(taskItems.map(item => item.phases[phase]));
  }
  return out;
}

export function aggregateRecordsTelemetry(records = []) {
  const list = Array.isArray(records) ? records : [];
  const byState = { PENDING: 0, CLAIMED: 0, DISPATCHED: 0, RESULT_READY: 0, VERIFIED: 0 };
  const byOutcome = { NONE: 0, FAILED: 0, CANCELLED: 0, UNCERTAIN_DELIVERY: 0, RELEASED: 0 };

  for (const record of list) {
    if (typeof record?.state === 'string') {
      byState[record.state] = (byState[record.state] ?? 0) + 1;
    }
    const outcomeKey = record?.outcome ?? 'NONE';
    byOutcome[outcomeKey] = (byOutcome[outcomeKey] ?? 0) + 1;
  }

  const tasks = list
    .map((record, index) => ({ task: deriveTaskTelemetry(record), index }))
    .sort((left, right) =>
      compareCodeUnits(left.task.workspace_root ?? '', right.task.workspace_root ?? '') ||
      compareCodeUnits(left.task.task_id ?? '', right.task.task_id ?? '') ||
      compareCodeUnits(left.task.attempt_id ?? '', right.task.attempt_id ?? '') ||
      (left.index - right.index)
    )
    .map(entry => entry.task);

  const outcomeGroups = {};
  for (const bucket of TASK_BUCKETS) {
    const bucketTasks = tasks.filter(item => item.bucket === bucket);
    outcomeGroups[bucket] = {
      count: bucketTasks.length,
      task_ids: bucketTasks
        .map(item => item.task_id)
        .filter(taskId => typeof taskId === 'string'),
      phases: summarizeTaskPhases(bucketTasks)
    };
  }

  const verifiedTasks = tasks.filter(item => item.bucket === 'verified');

  return {
    total_tasks: list.length,
    by_state: byState,
    by_outcome: byOutcome,
    queue_to_dispatch_ms: summarizeDurations(tasks.map(item => item.legacy.queue_to_dispatch_ms)),
    worker_execution_ms: summarizeDurations(tasks.map(item => item.legacy.worker_execution_ms)),
    total_turnaround_ms: summarizeDurations(tasks.map(item => item.legacy.total_turnaround_ms)),
    phase_names: [...PHASE_NAMES],
    unsupported_timings: [...UNSUPPORTED_TIMINGS],
    verified_phases: summarizeTaskPhases(verifiedTasks),
    outcome_groups: outcomeGroups,
    tasks
  };
}
