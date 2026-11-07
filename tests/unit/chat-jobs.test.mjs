import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ROOT, inside } from '../../src/core/util.mjs';
import { callTool, jobStatus, main, serveMcp, submitJob } from '../../src/chat-jobs.mjs';

function fixture(t) {
  const root = resolve(ROOT, 'state/test-gui-jobs-' + randomUUID());
  mkdirSync(root, { recursive: true });
  t.after(() => {
    assert.ok(root !== resolve(ROOT, 'state') && inside(resolve(ROOT, 'state'), root));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, input: { workspace_root: root, project_name: 'Test Project', request: 'Sửa lỗi\nGiữ nguyên cấu hình', job_id: randomUUID() } };
}

test('full brief, job status path and selected GUI model survive the handoff', async t => {
  const { root, input } = fixture(t);
  let sent;
  const output = await submitJob(input, {
    lockRoot: root, now: new Date('2026-11-06T18:00:00Z'),
    invoke: async args => {
      sent = args;
      return { status: 'submitted', project_name: 'Test Project', selected_model: 'GUI model', foreground_unchanged: true };
    }
  });
  assert.equal(sent.expected_project, 'Test Project');
  assert.equal(sent.mode, 'submit');
  assert.deepEqual(Object.keys(sent).sort(), ['expected_project', 'mode', 'prompt']);
  assert.match(sent.prompt, /^Sửa lỗi Giữ nguyên cấu hình/);
  assert.ok(sent.prompt.includes(output.job_path.replaceAll('\\', '/')));
  assert.match(output.job_path.replaceAll('\\', '/'), /2026-11-07\/010000-/);
  assert.equal(output.delivery.selected_model, 'GUI model');
  const job = JSON.parse(readFileSync(output.job_path, 'utf8'));
  assert.equal(job.request, input.request);
  assert.equal(output.request, undefined);
  job.state = 'done';
  job.summary = 'Reviewed';
  job.checks = [{ command: 'node --test', exit_code: 0 }];
  writeFileSync(output.job_path, '\uFEFF' + JSON.stringify(job));
  const final = jobStatus(root, output.job_path);
  assert.equal(final.state, 'done');
  assert.equal(final.summary, 'Reviewed');
  assert.equal(final.checks[0].exit_code, 0);
  assert.equal(final.delivery.status, 'submitted');
  assert.equal(final.request, undefined);
});

test('only a positively unsent attempt can be retried with the same UUID', async t => {
  const { root, input } = fixture(t);
  let attempts = 0;
  const options = { lockRoot: root, invoke: async () => {
    attempts += 1;
    return attempts === 1 ? { status: 'not_sent', reason: 'Existing draft' } : { status: 'submitted' };
  } };
  const first = await submitJob(input, options);
  assert.equal(first.delivery.status, 'not_sent');
  assert.equal((await submitJob(input, options)).job_path, first.job_path);
  assert.equal((await submitJob(input, options)).delivery.status, 'submitted');
  assert.equal(attempts, 2);
  await assert.rejects(submitJob({ ...input, request: 'Other brief' }, options), /different request/);
});

test('helper failure is uncertain and never replays', async t => {
  const { root, input } = fixture(t);
  let attempts = 0;
  const options = { lockRoot: root, invoke: async () => { attempts += 1; throw Error('Disconnected'); } };
  assert.equal((await submitJob(input, options)).delivery.status, 'uncertain');
  assert.equal((await submitJob(input, options)).delivery.status, 'uncertain');
  assert.equal(attempts, 1);
});

test('a prepared receipt recovers the original status path even on the next day', async t => {
  const { root, input } = fixture(t);
  const first = await submitJob(input, {
    lockRoot: root, now: new Date('2026-11-06T16:00:00Z'), invoke: async () => ({ status: 'not_sent' })
  });
  // Simulate an interruption after writing the receipt and before writing status.
  unlinkSync(first.job_path);
  const retry = await submitJob(input, {
    lockRoot: root, now: new Date('2026-11-07T16:00:00Z'), invoke: async () => ({ status: 'submitted' })
  });
  assert.equal(retry.job_path, first.job_path);
  assert.equal(retry.delivery.status, 'submitted');
});

test('GUI submissions are serialized across workspaces using the same sender lock', async t => {
  const { root, input } = fixture(t);
  const other = fixture(t);
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const first = submitJob(input, { lockRoot: root, invoke: async () => { await gate; return { status: 'submitted' }; } });
  try {
    await assert.rejects(submitJob(other.input, { lockRoot: root, invoke: async () => assert.fail('Concurrent submit') }), /locked/i);
  } finally { finish(); await first; }
});

test('rejects relative workspaces, foreign status paths and model override options', async t => {
  const { root, input } = fixture(t);
  await assert.rejects(submitJob({ ...input, workspace_root: '.' }), /absolute workspace/);
  assert.throws(() => jobStatus(root, resolve(root, 'foreign.json')), /outside/);
  await assert.rejects(callTool('submit_job', { ...input, model: 'other' }), /model/);
  await assert.rejects(main(['submit', '--model', 'other']), /Unsupported/);
  await assert.rejects(submitJob({ ...input, request: 'a'.repeat(8100) }, { lockRoot: root }), /8000/);
});

test('MCP advertises and calls the GUI tools through JSON-RPC stdio', async t => {
  const { root, input } = fixture(t);
  const messages = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'submit_job', arguments: input } }
  ].map(message => JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  let raw = '';
  const sink = new Writable({ write(chunk, _encoding, done) { raw += chunk; done(); } });
  await serveMcp(Readable.from(messages), sink, { lockRoot: root, invoke: async () => ({ status: 'submitted' }) });
  const output = raw.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(output[0].result.protocolVersion, '2025-11-25');
  assert.deepEqual(output[1].result.tools.map(item => item.name), ['inspect_gui', 'submit_job', 'job_status']);
  assert.equal(output[2].result.structuredContent.delivery.status, 'submitted');
  assert.equal(output[2].result.structuredContent.request, undefined);
});
