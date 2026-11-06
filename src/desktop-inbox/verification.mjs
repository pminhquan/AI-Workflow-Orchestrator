import {existsSync,lstatSync,readdirSync,realpathSync,openSync,fstatSync,readSync,closeSync} from 'node:fs';
import {isAbsolute,relative} from 'node:path';
import {sha256,scopedPath} from '../core/util.mjs';
import {changedFiles,verifyScope,CheckRunner} from '../verification/checks.mjs';
import {validateReport,isSensitivePath,canonicalWorkspace,MAX_REPORT_BYTES,noKnownSecrets} from './contracts.mjs';

export const MAX_WORKSPACE_BYTES=64*1024*1024;
export const MAX_WORKSPACE_FILE_BYTES=16*1024*1024;

export const EXCLUDED_ROOTS = ['.git','.venv','node_modules','state','__pycache__','.pytest_cache','dist','build','.next','.turbo','coverage','target','.idea','.vscode'];

export function readBoundedBytes(path,limit) {
  const fd = openSync(path,'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw Error('Nonregular/oversize local file');
    const buffer = Buffer.alloc(stat.size+1);
    let count = 0, size;
    while (count < buffer.length && (size = readSync(fd,buffer,count,buffer.length-count,null)) > 0) count += size;
    if (count !== stat.size) throw Error('Local file changed while reading');
    return buffer.subarray(0,count);
  } finally { closeSync(fd); }
}

// Audit of ordinary project files, not a filesystem sandbox. Never traverse the
// dependency/runtime roots listed above, symlinks, or recognizable private files.
export function captureWorkspace(workspace) {
  workspace = realpathSync(workspace);
  const entries = Object.create(null);
  let count = 0, bytes = 0;
  function visit(relativePath) {
    if (isSensitivePath(relativePath)) return;
    const path = scopedPath(workspace,relativePath);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(relativePath+'/'+child);
    } else {
      if (!stat.isFile() || ++count > 2000 || (bytes += stat.size) > MAX_WORKSPACE_BYTES) throw Error('Workspace snapshot limit/nonregular file');
      const data = readBoundedBytes(path,Math.min(MAX_WORKSPACE_FILE_BYTES,MAX_WORKSPACE_BYTES-(bytes-stat.size)));
      bytes += data.length-stat.size;
      entries[relativePath] = sha256(data);
    }
  }
  for (const name of readdirSync(workspace).sort()) {
    if (EXCLUDED_ROOTS.includes(name.toLowerCase())) continue;
    if (name === '.codex') {
      const configRoot = scopedPath(workspace,name);
      if (!lstatSync(configRoot).isDirectory()) throw Error('Project .codex must be a regular directory');
      // Do not traverse private configuration. Only the project-local MCP file
      // explicitly requested for this bridge is eligible for a parent hash.
      const children = readdirSync(configRoot);
      // Other private Codex entries are outside this ordinary source audit.
      // Do not traverse them or expose their contents to workers.
      if (children.includes('config.toml')) {
        const config = readBoundedBytes(scopedPath(workspace,'.codex/config.toml'),32768);
        noKnownSecrets(config.toString('utf8'));
        entries['.codex/config.toml'] = sha256(config);
      }
      continue;
    }
    visit(name);
  }
  return {entries,hash:sha256(entries)};
}

function readReport(inbox,record) {
  const path = scopedPath(inbox.root,record.job.expected_output);
  if (!existsSync(path) || lstatSync(path).size > 32768) throw Error('Missing/oversize worker report');
  const bytes = readBoundedBytes(path,32768);
  if (sha256(bytes) !== record.report_sha256) throw Error('Worker report changed after collection');
  return validateReport(JSON.parse(bytes.toString('utf8')),record.job);
}

// Read an already completed file handoff. No inbox submission, dispatch, state
// transition or execution-attribution upgrade is performed here.
export function inspectHandoffArtifacts(job) {
  const workspace = canonicalWorkspace(job.workspace_root);
  if (typeof job.output_directory !== 'string' || !isAbsolute(job.output_directory)) throw Error('Handoff requires a bound output directory');
  const directory = scopedPath(workspace,relative(workspace,job.output_directory).replaceAll('\\','/'));
  const reportBytes = readBoundedBytes(scopedPath(directory,'report.json'),MAX_REPORT_BYTES);
  const resultBytes = readBoundedBytes(scopedPath(directory,'result.md'),MAX_REPORT_BYTES);
  const decoder = new TextDecoder('utf-8',{fatal:true});
  const result = decoder.decode(resultBytes);
  if (!result.trim()) throw Error('Empty result.md');
  const original = JSON.parse(decoder.decode(reportBytes));
  const report = validateReport(original,job,{legacyResultText:result});
  return {report,result,report_sha256:sha256(reportBytes),result_sha256:sha256(resultBytes),
    normalization:{evidence_alias:Object.hasOwn(original,'completion_evidence'),
      errors_source:Object.hasOwn(original,'errors')?'report.json':'explicit worker no-errors declaration in result.md'}};
}

export async function verifyJob(inbox,taskId,{checks = {},review,snapshot = captureWorkspace} = {}) {
  const record = inbox.get(taskId), job = record.job;
  if (record.state !== 'RESULT_READY') throw Error('Only RESULT_READY can be verified');
  if (record.outcome === 'CANCELLED') throw Error('Cancelled task cannot be verified');
  if (record.outcome === 'RELEASED') throw Error('Released task cannot be verified');
  const report = readReport(inbox,record);
  if (report.status !== 'reported' || report.blockers.length || report.errors.length) throw Error('Worker blocked/failed or reported errors; parent acceptance unavailable');
  if (typeof review !== 'function') throw Error('Independent parent source/findings review is required');
  const before = snapshot(job.workspace_root);
  const actual = changedFiles(record.baseline,before);
  verifyScope(actual,report.changed_files,job.write_scope);
  // Fresh runner every acceptance, no cache and no command derived from task text.
  const specs = {};
  for (const id of job.verification_commands) {
    if (!Object.hasOwn(checks,id)) throw Error('Unknown trusted host check: '+id);
    specs[id] = {...structuredClone(checks[id]),cacheable:false};
  }
  const runner = new CheckRunner(specs), receipts = [];
  for (const id of job.verification_commands) {
    const receipt = await runner.run(job.workspace_root,id);
    receipts.push({check_id:id,exit_code:receipt.exit_code,passed:receipt.passed,
      output:receipt.output,input_hash:receipt.input_hash,spec_hash:receipt.spec_hash,
      executed_at:receipt.executed_at,reused:receipt.reused});
    if (!receipt.passed || receipt.reused) throw Error('Fresh host check failed: '+id);
  }
  const decision = await review({job:structuredClone(job),report:structuredClone(report),
    actual_changed_files:actual,checks:structuredClone(receipts)});
  if (!decision || decision.accepted !== true) throw Error('Parent review did not accept findings');
  const after = snapshot(job.workspace_root);
  if (before.hash !== after.hash) throw Error('Workspace changed during parent verification');
  readReport(inbox,record);
  const hostReceipt = {kind:'desktop-inbox.host-receipt@1',task_id:job.task_id,
    attempt_id:job.attempt_id,workspace_root:job.workspace_root,report_sha256:record.report_sha256,
    job_sha256:sha256(job),baseline_sha256:record.baseline.hash,after_sha256:after.hash,
    checks:receipts,actual_changed_files:actual,accepted:true,verified_at:new Date().toISOString()};
  return inbox.verify(taskId,hostReceipt);
}
