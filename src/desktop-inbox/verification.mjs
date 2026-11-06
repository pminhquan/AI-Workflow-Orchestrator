import {existsSync,lstatSync,openSync,fstatSync,readSync,closeSync,constants} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {isAbsolute,relative} from 'node:path';
import {sha256,scopedPath} from '../core/util.mjs';
import {changedFiles,verifyScope,CheckRunner} from '../verification/checks.mjs';
import {validateReport,canonicalWorkspace,MAX_REPORT_BYTES,noKnownSecrets} from './contracts.mjs';
import {workspaceFiles,assertAuditableScopes,EXCLUDED_ROOTS as SOURCE_EXCLUSIONS} from './workspace-files.mjs';

import {reviewBinding,validateParentReview} from './review-evidence.mjs';

export const MAX_WORKSPACE_BYTES=64*1024*1024;
export const MAX_WORKSPACE_FILE_BYTES=16*1024*1024;

export const EXCLUDED_ROOTS = SOURCE_EXCLUSIONS;

export function readBoundedBytes(path,limit) {
  const prior=lstatSync(path);
  if(prior.isSymbolicLink()||!prior.isFile())throw Error('Nonregular local file');
  const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
  const fd = openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw Error('Nonregular/oversize local file');
    if(!same(prior,stat))throw Error('Local file changed before reading');
    const buffer = Buffer.alloc(stat.size+1);
    let count = 0, size;
    while (count < buffer.length && (size = readSync(fd,buffer,count,buffer.length-count,null)) > 0) count += size;
    if (count !== stat.size||!same(stat,fstatSync(fd))||!same(stat,lstatSync(path))) throw Error('Local file changed while reading');
    return buffer.subarray(0,count);
  } finally { closeSync(fd); }
}

// Ordinary source audit, not OS isolation. Enumeration is shared with the
// advisory cache; final verification always reads fresh file bytes.
export function captureWorkspace(workspace) {
  workspace=canonicalWorkspace(workspace);
  const entries=Object.create(null);let bytes=0;
  for(const rel of workspaceFiles(workspace)){
    const path=scopedPath(workspace,rel),stat=lstatSync(path);
    if((bytes+=stat.size)>MAX_WORKSPACE_BYTES)throw Error('Workspace snapshot limit exceeded');
    const limit=rel==='.codex/config.toml'?32768:MAX_WORKSPACE_FILE_BYTES;
    const data=readBoundedBytes(path,Math.min(limit,MAX_WORKSPACE_BYTES-(bytes-stat.size)));
    bytes+=data.length-stat.size;
    if(rel==='.codex/config.toml')noKnownSecrets(data.toString('utf8'));
    entries[rel]=sha256(data);
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

export function validateChangedSourceSyntax(workspaceRoot,actualChanged) {
  for (const rel of actualChanged) {
    const full = scopedPath(workspaceRoot,rel);
    if (!existsSync(full) || !lstatSync(full).isFile()) continue;
    if (/\.json$/i.test(rel)) {
      try {
        JSON.parse(readBoundedBytes(full,MAX_WORKSPACE_FILE_BYTES).toString('utf8'));
      } catch (err) {
        throw Error('Invalid JSON syntax in changed file '+rel+': '+err.message);
      }
    } else if (/\.(mjs|cjs|js)$/i.test(rel)) {
      const check = spawnSync(process.execPath,['--check',full],{cwd:workspaceRoot,windowsHide:true,timeout:5000,encoding:'utf8'});
      if (check.status !== 0) {
        throw Error('Syntax check failed for changed file '+rel+': '+String(check.stderr || check.stdout || 'syntax error').trim().slice(0,240));
      }
    }
  }
}

export async function runMechanicalVerification(inbox,taskId,{checks = {},snapshot = captureWorkspace} = {}) {
  let record = null, job = null;
  try {
    record = inbox.get(taskId);
    job = record.job;
    if (record.state !== 'RESULT_READY') throw Error('Only RESULT_READY can be verified');
    if (record.outcome === 'CANCELLED') throw Error('Cancelled task cannot be verified');
    if (record.outcome === 'RELEASED') throw Error('Released task cannot be verified');
    if (record.outcome === 'FAILED') throw Error('Failed task cannot be verified');
    const report = readReport(inbox,record);
    if (report.status !== 'reported' || report.blockers.length || report.errors.length) throw Error('Worker blocked/failed or reported errors; parent acceptance unavailable');
    assertAuditableScopes(job.workspace_root,[...job.read_scope,...job.write_scope]);
    const before = snapshot(job.workspace_root);
    const actual = changedFiles(record.baseline,before);
    verifyScope(actual,report.changed_files,job.write_scope);
    validateChangedSourceSyntax(job.workspace_root,actual);
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
    const after = snapshot(job.workspace_root);
    if (before.hash !== after.hash) throw Error('Workspace changed during parent verification');
    readReport(inbox,record);
    return {
      passed:true,
      mechanical_only:true,
      verified:false,
      requires_parent_review:true,
      task_id:job.task_id,
      attempt_id:job.attempt_id,
      workspace_root:job.workspace_root,
      baseline_hash:record.baseline.hash,
      snapshot_hash:before.hash,
      report_sha256:record.report_sha256,
      actual_changed_files:actual,
      scope_valid:true,
      checks:receipts,
      acceptance_criteria:structuredClone(job.acceptance_criteria),
      review_context:reviewBinding(job,{report_sha256:record.report_sha256,baseline_sha256:record.baseline.hash,after_sha256:before.hash,actual_changed_files:actual}),
      review_assurance:'PARENT_ASSERTION_REQUIRED_NOT_PROOF_OF_READING',
      error:null
    };
  } catch (err) {
    return {
      passed:false,
      mechanical_only:true,
      verified:false,
      requires_parent_review:true,
      task_id:job?.task_id ?? taskId,
      attempt_id:job?.attempt_id ?? null,
      workspace_root:job?.workspace_root ?? null,
      baseline_hash:record?.baseline?.hash ?? null,
      snapshot_hash:null,
      report_sha256:record?.report_sha256 ?? null,
      actual_changed_files:[],
      scope_valid:false,
      checks:[],
      acceptance_criteria:structuredClone(job?.acceptance_criteria ?? []),
      error:err.message
    };
  }
}

export async function verifyJob(inbox,taskId,{checks = {},review,snapshot = captureWorkspace} = {}) {
  const record = inbox.get(taskId), job = record.job;
  if (record.state !== 'RESULT_READY') throw Error('Only RESULT_READY can be verified');
  if (record.outcome === 'CANCELLED') throw Error('Cancelled task cannot be verified');
  if (record.outcome === 'RELEASED') throw Error('Released task cannot be verified');
  if (record.outcome === 'FAILED') throw Error('Failed task cannot be verified');
  const report = readReport(inbox,record);
  if (report.status !== 'reported' || report.blockers.length || report.errors.length) throw Error('Worker blocked/failed or reported errors; parent acceptance unavailable');
  if (typeof review !== 'function') throw Error('Independent parent source/findings review is required');
  assertAuditableScopes(job.workspace_root,[...job.read_scope,...job.write_scope]);
    const before = snapshot(job.workspace_root);
  const actual = changedFiles(record.baseline,before);
  verifyScope(actual,report.changed_files,job.write_scope);
  validateChangedSourceSyntax(job.workspace_root,actual);
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
  const binding=reviewBinding(job,{report_sha256:record.report_sha256,baseline_sha256:record.baseline.hash,after_sha256:before.hash,actual_changed_files:actual});
  const decision = await review({job:structuredClone(job),report:structuredClone(report),review_context:binding,
    actual_changed_files:actual,checks:structuredClone(receipts)});
  if (!decision || decision.accepted !== true) throw Error('Parent review did not accept findings');
  const evidence=validateParentReview(decision.evidence,{job,report_sha256:record.report_sha256,baseline_sha256:record.baseline.hash,after_sha256:before.hash,actual_changed_files:actual,checks:receipts});
  const after = snapshot(job.workspace_root);
  if (before.hash !== after.hash) throw Error('Workspace changed during parent verification');
  readReport(inbox,record);
  const hostReceipt = {kind:'desktop-inbox.host-receipt@1',task_id:job.task_id,
    attempt_id:job.attempt_id,workspace_root:job.workspace_root,report_sha256:record.report_sha256,
    job_sha256:sha256(job),baseline_sha256:record.baseline.hash,after_sha256:after.hash,
    checks:receipts,actual_changed_files:actual,accepted:true,review_evidence:evidence,
    ...(Array.isArray(decision.notes) && decision.notes.length ? {review_notes:decision.notes.map(String)} : {}),
    verified_at:new Date().toISOString()};
  return inbox.verify(taskId,hostReceipt);
}
