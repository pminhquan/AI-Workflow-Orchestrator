import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {ROOT} from '../../src/core/util.mjs';
import {normalizeReport,validateReport} from '../../src/desktop-inbox/contracts.mjs';
import {buildPrompt} from '../../src/desktop-inbox/sidecar.mjs';

const job={task_id:'11111111-1111-4111-8111-111111111111',attempt_id:'22222222-2222-4222-8222-222222222222',
  workspace_root:resolve(ROOT,'tests/fixtures/coding-project'),read_scope:['README.md'],write_scope:[]};
const report=()=>({schema_version:'desktop-inbox.report@1',task_id:job.task_id,attempt_id:job.attempt_id,
  workspace:job.workspace_root,status:'reported',inspected_files:['README.md'],changed_files:[],
  tests:[],findings:['Read README'],blockers:[],errors:[],evidence:['README.md inspected']});
const legacy=()=>{const value=report();value.completion_evidence=value.evidence;delete value.evidence;delete value.errors;return value;};
const declaration='- Không có lỗi phát sinh trong quá trình đọc `README.md` và tạo báo cáo kết quả.';

test('canonical report and future prompt consistently require errors and evidence',()=>{
  assert.deepEqual(validateReport(report(),job),report());
  const prompt=JSON.parse(buildPrompt(job,resolve(ROOT,'state')));
  assert.ok(Object.hasOwn(prompt.report_contract,'errors'));
  assert.ok(Object.hasOwn(prompt.report_contract,'evidence'));
  assert.equal(Object.hasOwn(prompt.report_contract,'completion_evidence'),false);
});

test('legacy evidence alias is typed and normalized without mutating original input',()=>{
  const value=report();value.completion_evidence=value.evidence;delete value.evidence;
  const original=structuredClone(value),normalized=validateReport(value,job);
  assert.deepEqual(normalized.evidence,original.completion_evidence);
  assert.equal(Object.hasOwn(normalized,'completion_evidence'),false);
  assert.deepEqual(value,original);
});

test('legacy blockers never imply errors; explicit result declaration is required',()=>{
  assert.throws(()=>validateReport(legacy(),job),/Missing required errors/);
  assert.throws(()=>validateReport(legacy(),job,{legacyResultText:'No blockers were reported.'}),/Missing required errors/);
  const original=legacy();
  const normalized=validateReport(original,job,{legacyResultText:declaration});
  assert.deepEqual(normalized.errors,[]);assert.deepEqual(normalized.evidence,original.completion_evidence);
  assert.equal(Object.hasOwn(original,'errors'),false);
  const blocked={...legacy(),status:'blocked',blockers:['Missing prerequisite']};
  const compatible=normalizeReport(blocked,{legacyResultText:'Errors: NONE'});
  assert.deepEqual(compatible.blockers,['Missing prerequisite']);assert.deepEqual(compatible.errors,[]);
  assert.throws(()=>normalizeReport(legacy(),{legacyResultText:'Errors: NONE\nErrors: execution failed'}),/unambiguous/);
});

test('missing canonical fields are rejected instead of inventing empty arrays',()=>{
  for(const key of ['errors','evidence','task_id']){
    const value=report();delete value[key];assert.throws(()=>validateReport(value,job));
  }
  const missingErrors=report();delete missingErrors.errors;
  assert.throws(()=>validateReport(missingErrors,job,{legacyResultText:declaration}),/Missing required errors/);
});

test('canonical fields, legacy aliases and compatibility context reject incorrect types',()=>{
  for(const [key,value] of [['errors','none'],['evidence',null],['blockers',{}],['completion_evidence','README.md'],['errors',[{}]],['evidence',[null]]]){
    assert.throws(()=>validateReport({...report(),[key]:value},job),/Invalid report string array/);
  }
  assert.throws(()=>validateReport(legacy(),job,{legacyResultText:42}),/Invalid legacy result text/);
});

test('conflicting evidence aliases fail; errors and blockers remain distinct meanings',()=>{
  assert.throws(()=>validateReport({...report(),completion_evidence:['Different evidence']},job),/Conflicting/);
  assert.deepEqual(validateReport({...report(),completion_evidence:report().evidence},job),report());
  const distinct={...report(),status:'blocked',errors:['Runtime error'],blockers:['Missing prerequisite']};
  assert.deepEqual(validateReport(distinct,job),distinct);
});

test('task and attempt identity mismatches cannot be hidden by normalization',()=>{
  for(const key of ['task_id','attempt_id'])assert.throws(()=>validateReport({...report(),[key]:'33333333-3333-4333-8333-333333333333'},job),/mismatch/);
});

test('forged completion and host acceptance claims are rejected',()=>{
  for(const status of ['VERIFIED','CLOSED','PASS'])assert.throws(()=>validateReport({...report(),status},job));
  assert.throws(()=>validateReport({...report(),host_receipt:{accepted:true}},job),/unknown property/);
  assert.throws(()=>validateReport({...report(),evidence:[]},job),/requires evidence/);
});
