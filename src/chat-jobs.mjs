import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { validate } from './core/schema.mjs';
import { ROOT, inside, sha256 } from './core/util.mjs';
import { atomicWriteJSON, readBoundedBytes, verifyPathSafety } from './core/local-files.mjs';
import { acquireTransactionLock } from './core/transaction-lock.mjs';

const FORMAT = 'antigravity-gui-job@1';
const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_BYTES = 131072;
const STRING = { type: 'string', minLength: 1 };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const tools = [
  { name: 'inspect_gui', description: 'Read the currently open Antigravity project and GUI-selected model.', inputSchema: object({}) },
  {
    name: 'submit_job', description: 'Enter and submit the brief once in the currently selected Antigravity chat, with a separate project status file.',
    inputSchema: object({ workspace_root: STRING, request: STRING, job_id: STRING, project_name: STRING }, ['workspace_root', 'request'])
  },
  {
    name: 'job_status', description: 'Read compact status and delivery evidence for the exact job path.',
    inputSchema: object({ workspace_root: STRING, job_path: STRING }, ['workspace_root', 'job_path'])
  }
];

function workspace(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw Error('An absolute workspace is required');
  const root = verifyPathSafety(path);
  if (!statSync(root).isDirectory()) throw Error('Workspace must be a directory');
  return root;
}

function readJSON(path) {
  verifyPathSafety(path);
  return JSON.parse(readBoundedBytes(path, MAX_BYTES).toString('utf8').replace(/^\uFEFF/, ''));
}

function receiptPath(root, id) {
  if (!JOB_ID.test(id ?? '')) throw Error('Invalid job UUID');
  return verifyPathSafety(resolve(root, 'state/antigravity-input', id + '.json'));
}

function checkedJobPath(root, path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw Error('An absolute job path is required');
  const checked = verifyPathSafety(path);
  if (!inside(resolve(root, 'state/antigravity-status'), checked)) throw Error('Job path is outside the project status folder');
  return checked;
}

function readJob(root, path) {
  const job = readJSON(checkedJobPath(root, path));
  const match = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (![FORMAT, 'antigravity-file-job@1'].includes(job.format) || !match(String(job.workspace_root ?? ''), root) ||
      !JOB_ID.test(job.id ?? '') || !['queued', 'running', 'done', 'blocked'].includes(job.state)) {
    throw Error('Invalid job for this workspace');
  }
  return job;
}

export function jobStatus(root, path) {
  root = workspace(root);
  const job = readJob(root, path);
  const receiptFile = receiptPath(root, job.id);
  const receipt = existsSync(receiptFile) ? readJSON(receiptFile) : null;
  const delivery = receipt?.delivery?.status === 'submitting'
    ? { status: 'uncertain', reason: 'Previous attempt has no final receipt' }
    : receipt?.delivery ?? null;
  return {
    job_path: resolve(path), id: job.id, state: job.state, summary: job.summary ?? '',
    changed_files: job.changed_files ?? [], checks: job.checks ?? [], delivery
  };
}

function findPowerShell() {
  if (process.platform !== 'win32') throw Error('The background Antigravity sender requires Windows');
  const searchPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const candidates = searchPath.split(delimiter).map(item => item.replace(/^"|"$/g, ''))
    .filter(isAbsolute).map(item => resolve(item, 'pwsh.exe'));
  if (process.env.SystemRoot) candidates.push(resolve(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'));
  const exe = candidates.find(path => existsSync(path) && statSync(path).isFile());
  if (!exe) throw Error('PowerShell executable not found');
  return exe;
}

export async function invokeGui(request) {
  const exe = findPowerShell();
  return await new Promise((accept, reject) => {
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-File', resolve(ROOT, 'src/antigravity-input.ps1')], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    let output = '';
    let failure;
    const timer = setTimeout(() => {
      failure = Error('Antigravity input helper timed out');
      child.kill();
    }, 27000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > MAX_BYTES) {
        failure = Error('Antigravity input helper returned too much output');
        child.kill();
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) return reject(failure ?? Error('Antigravity input helper exited ' + code));
      try { accept(JSON.parse(output)); } catch { reject(Error('Antigravity input helper returned invalid JSON')); }
    });
    child.stdin.end(JSON.stringify(request), 'utf8');
  });
}

function makeJobPath(root, id, now) {
  const local = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).format(now);
  return verifyPathSafety(resolve(root, 'state/antigravity-status', local.slice(0, 10),
    local.slice(11).replaceAll(':', '') + '-' + id + '.json'));
}

function composerText(request, path) {
  const brief = request.trim().replace(/\r\n?|\n|\t/g, ' ');
  const text = brief + ' | Job status: "' + path.replaceAll('\\', '/') +
    '". Update this JSON at the same path using a temporary file and rename. Set state=running, then done or blocked. Set summary, changed_files and checks (command, exit_code). If blocked, include the reason and next step in summary. Preserve id, format, workspace_root and request. The request field holds the original brief formatting.';
  if (text.length > 8000 || /[\x00-\x1f\x7f]/.test(text)) throw Error('The complete brief and status instructions must fit in 8000 printable characters');
  return text;
}

export async function submitJob(input, { invoke = invokeGui, now = new Date(), lockRoot = ROOT } = {}) {
  const { workspace_root, request, job_id = randomUUID(), project_name } = input;
  const root = workspace(workspace_root);
  if (typeof request !== 'string' || !request.trim()) throw Error('A job brief is required');
  const expectedProject = project_name ?? basename(root);
  if (typeof expectedProject !== 'string' || !expectedProject.trim() || /[\x00-\x1f\x7f]/.test(expectedProject)) throw Error('Invalid project name');
  const receiptFile = receiptPath(root, job_id);
  const lock = verifyPathSafety(resolve(lockRoot, 'state/antigravity-input/sender.lock'));
  mkdirSync(dirname(lock), { recursive: true });
  const release = acquireTransactionLock(lock);
  try {
    const previous = existsSync(receiptFile) ? readJSON(receiptFile) : null;
    const requestHash = sha256({ request, expectedProject });
    if (previous && previous.request_hash !== requestHash) throw Error('Job UUID already belongs to a different request');
    const jobPath = checkedJobPath(root, previous?.job_path ?? makeJobPath(root, job_id, now));
    const prompt = composerText(request, jobPath);
    const receipt = previous ?? { job_path: jobPath, request_hash: requestHash, delivery: { status: 'not_sent' } };
    if (!previous) atomicWriteJSON(receiptFile, receipt, { exclusive: true });
    if (existsSync(jobPath) || receipt.delivery.status !== 'not_sent') {
      const job = readJob(root, jobPath);
      if (job.id !== job_id) throw Error('Job receipt identity mismatch');
      if (receipt.delivery.status !== 'not_sent' || job.state !== 'queued') return jobStatus(root, jobPath);
    } else {
      atomicWriteJSON(jobPath, {
        format: FORMAT, id: job_id, workspace_root: root, created_at: now.toISOString(), request,
        state: 'queued', summary: '', changed_files: [], checks: []
      }, { exclusive: true });
    }
    receipt.delivery = { status: 'submitting' };
    atomicWriteJSON(receiptFile, receipt);
    try {
      const result = await invoke({ mode: 'submit', expected_project: expectedProject, prompt });
      if (!['submitted', 'not_sent', 'uncertain'].includes(result?.status)) throw Error('Unexpected input helper result');
      const { status, reason, project_name: project, selected_model, pid, foreground_unchanged, foreground_was_antigravity } = result;
      receipt.delivery = { status, reason, project_name: project, selected_model, pid, foreground_unchanged, foreground_was_antigravity };
    } catch (error) {
      receipt.delivery = { status: 'uncertain', reason: error.message };
    }
    atomicWriteJSON(receiptFile, receipt);
    return jobStatus(root, jobPath);
  } finally {
    release();
  }
}

export async function callTool(name, args, options = {}) {
  const tool = tools.find(item => item.name === name);
  if (!tool) throw Error('Unknown MCP tool');
  const result = validate(args, tool.inputSchema);
  if (!result.valid) throw Error(result.errors.join('; '));
  if (name === 'inspect_gui') return await (options.invoke ?? invokeGui)({ mode: 'inspect' });
  if (name === 'submit_job') return await submitJob(args, options);
  return jobStatus(args.workspace_root, args.job_path);
}

export async function serveMcp(input = process.stdin, output = process.stdout, options = {}) {
  const write = response => output.write(JSON.stringify({ jsonrpc: '2.0', ...response }) + '\n');
  let initialized = false;
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let msg;
    try {
      if (Buffer.byteLength(line) > MAX_BYTES) throw Error('Message exceeds size limit');
      msg = JSON.parse(line);
      if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') throw Error('Invalid JSON-RPC request');
      if (msg.id === undefined) continue;
      let result;
      if (msg.method === 'initialize') {
        initialized = true;
        const version = msg.params?.protocolVersion;
        result = {
          protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(version) ? version : '2025-11-25',
          capabilities: { tools: {} }, serverInfo: { name: 'antigravity_gui', version: '1.0.0' }
        };
      } else if (!initialized) throw Error('Initialize the MCP connection first');
      else if (msg.method === 'ping') result = {};
      else if (msg.method === 'tools/list') result = { tools };
      else if (msg.method === 'tools/call') {
        try {
          const data = await callTool(msg.params?.name, msg.params?.arguments ?? {}, options);
          result = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
        } catch (error) {
          result = { isError: true, content: [{ type: 'text', text: error.message }] };
        }
      } else {
        write({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
        continue;
      }
      write({ id: msg.id, result });
    } catch (error) {
      write({ id: msg?.id ?? null, error: { code: msg ? -32600 : -32700, message: error.message } });
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const allowed = { inspect: [], submit: ['workspace', 'request-file', 'job-id', 'project-name'], status: ['workspace', 'job'], serve: [] };
  if (!Object.hasOwn(allowed, command)) throw Error('Use inspect, submit, status, or serve');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2);
    if (!rest[i].startsWith('--') || !allowed[command].includes(key) || Object.hasOwn(options, key) || rest[i + 1] === undefined) {
      throw Error('Unsupported, duplicate or missing option: ' + rest[i]);
    }
    options[key] = rest[i + 1];
  }
  if (command === 'serve') return await serveMcp();
  if (command === 'inspect') return await invokeGui({ mode: 'inspect' });
  if (command === 'status') return jobStatus(options.workspace, options.job);
  return await submitJob({
    workspace_root: options.workspace, request: readBoundedBytes(options['request-file'], MAX_BYTES).toString('utf8').replace(/^\uFEFF/, ''),
    job_id: options['job-id'], project_name: options['project-name']
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(result => { if (result !== undefined) process.stdout.write(JSON.stringify(result) + '\n'); })
    .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
