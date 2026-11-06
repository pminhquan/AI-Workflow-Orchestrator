import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT,inside,sha256} from '../../src/core/util.mjs';
import {createLiveToolHandler} from '../../src/desktop-inbox/live-mcp-server.mjs';
import {openLiveInbox,inferJobScopes} from '../../src/desktop-inbox/live-bridge.mjs';
import {submitWorkerReport} from '../../src/desktop-inbox/report-cli.mjs';
import {parentReview} from '../desktop-review-fixtures.mjs';

async function ready({write=false}={}){
 const relative='state/test-audit-review-'+randomUUID(),root=resolve(ROOT,relative),workspace=resolve(root,'project'),stateDirectory=relative+'/bridge';
 mkdirSync(workspace,{recursive:true});writeFileSync(resolve(workspace,'README.md'),'# Reviewed fixture\n');
 const call=createLiveToolHandler({stateDirectory});
 const job=await call('submit_job',{workspace_root:workspace,request:write?'Update README':'Read README',read_scope:['README.md'],write_scope:write?['README.md']:[],acceptance_criteria:['Heading is accurate'],verification_commands:['noop']});
 const {inbox}=openLiveInbox(workspace,{stateDirectory}),claim=inbox.claim(job.task_id);inbox.beginDispatch(job.task_id,claim.claim_id);inbox.recordDelivery(job.task_id,claim.claim_id,{kind:'OFFLINE_TEST',started:true,exit_code:0});
 if(write)writeFileSync(resolve(workspace,'README.md'),'# Worker reviewed fixture\n');
 submitWorkerReport({briefPath:job.brief_json_path,stateDirectory,summary:'Heading is Reviewed fixture',inspected:['README.md']});
 const result=await call('get_job_result',{workspace_root:workspace,task_id:job.task_id,auto_verify:true}),actualJob=inbox.get(job.task_id).job;
 const evidence=parentReview({job:actualJob,report:result.worker_report,review_context:result.auto_verification.review_context,actual_changed_files:result.auto_verification.actual_changed_files,checks:result.auto_verification.checks}).evidence;
 return {root,workspace,stateDirectory,call,job,inbox,evidence,close(){assert.ok(inside(resolve(ROOT,'state'),root));rmSync(root,{recursive:true,force:true});}};
}

test('audit: accepted alone cannot mark an unreviewed result VERIFIED',async()=>{
 const h=await ready();try{await assert.rejects(h.call('verify_job',{workspace_root:h.workspace,task_id:h.job.task_id,accepted:true}),/PARENT_REVIEW_REQUIRED/);assert.equal(h.inbox.get(h.job.task_id).state,'RESULT_READY');}finally{h.close();}
});

test('audit: review binds job, attempt, report and exact diff fingerprint',async()=>{
 const h=await ready();try{
  for(const patch of [{task_id:randomUUID()},{attempt_id:randomUUID()},{report_sha256:'0'.repeat(64)},{diff_fingerprint:'0'.repeat(64)}])await assert.rejects(h.call('verify_job',{workspace_root:h.workspace,task_id:h.job.task_id,accepted:true,review_evidence:{...h.evidence,...patch}}),/PARENT_REVIEW_MISMATCH/);
  const verified=await h.call('verify_job',{workspace_root:h.workspace,task_id:h.job.task_id,accepted:true,review_evidence:h.evidence});assert.equal(verified.state,'VERIFIED');assert.deepEqual(verified.host_receipt.review_evidence,h.evidence);
 }finally{h.close();}
});

test('audit: review requires inspected files, acceptance notes and matching check evidence',async()=>{
 const h=await ready();try{
  for(const patch of [{files_inspected:[]},{notes:[]},{acceptance_assessment:[]},{acceptance_assessment:[{criterion:'Heading is accurate',met:false,evidence:'not met'}]},{check_results:[]},{check_results:h.evidence.check_results.map(c=>({...c,input_hash:sha256('wrong input')}))}])await assert.rejects(h.call('verify_job',{workspace_root:h.workspace,task_id:h.job.task_id,accepted:true,review_evidence:{...h.evidence,...patch}}));
  assert.equal(h.inbox.get(h.job.task_id).state,'RESULT_READY');
 }finally{h.close();}
});

test('audit: a changed source invalidates previously prepared review metadata',async()=>{
 const h=await ready();try{writeFileSync(resolve(h.workspace,'README.md'),'# Different source\n');await assert.rejects(h.call('verify_job',{workspace_root:h.workspace,task_id:h.job.task_id,accepted:true,review_evidence:h.evidence}),/Out-of-scope/);assert.equal(h.inbox.get(h.job.task_id).state,'RESULT_READY');}finally{h.close();}
});

test('audit: same in-scope changed-file list with different bytes invalidates review fingerprint',async()=>{
 const h=await ready({write:true});try{writeFileSync(resolve(h.workspace,'README.md'),'# Unreviewed later edit\n');await assert.rejects(h.call('verify_job',{workspace_root:h.workspace,task_id:h.job.task_id,accepted:true,review_evidence:h.evidence}),/PARENT_REVIEW_MISMATCH: diff_fingerprint/);assert.equal(h.inbox.get(h.job.task_id).state,'RESULT_READY');}finally{h.close();}
});

test('audit: tokens or filenames do not grant implicit write scope',()=>{
 const root=resolve(ROOT,'state/test-scope-'+randomUUID());mkdirSync(root,{recursive:true});try{
  writeFileSync(resolve(root,'unrelated.mjs'),'export const validation=true;');
  assert.throws(()=>inferJobScopes(root,'Fix validation'),/WRITE_SCOPE_REQUIRED/);
  assert.throws(()=>inferJobScopes(root,'Update unrelated.mjs'),/WRITE_SCOPE_REQUIRED/);
  assert.throws(()=>inferJobScopes(root,'Read',{readOnly:true,writeScope:['unrelated.mjs']}),/conflicts/);
  assert.deepEqual(inferJobScopes(root,'Fix validation',{readScope:['unrelated.mjs'],writeScope:['unrelated.mjs']}).writeScope,['unrelated.mjs']);
  assert.deepEqual(inferJobScopes(root,'Read validation',{readOnly:true}).writeScope,[]);
 }finally{assert.ok(inside(resolve(ROOT,'state'),root));rmSync(root,{recursive:true,force:true});}
});
