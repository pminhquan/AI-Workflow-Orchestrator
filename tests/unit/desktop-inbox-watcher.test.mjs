import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT,inside,sha256} from '../../src/core/util.mjs';
import {Inbox} from '../../src/desktop-inbox/inbox.mjs';
import {makeJob,validateScopePath} from '../../src/desktop-inbox/contracts.mjs';
import {captureWorkspace} from '../../src/desktop-inbox/verification.mjs';
import {handoffDirectory} from '../../src/desktop-inbox/app-receiver.mjs';
import {watchJobResult,readmeSmokeVerification,README_SMOKE_REQUEST,README_SMOKE_ACCEPTANCE} from '../../src/desktop-inbox/result-watcher.mjs';

function setup(){
 const rel='state/test-result-watcher-'+randomUUID(),workspace=resolve(ROOT,rel);
 mkdirSync(workspace,{recursive:true});writeFileSync(resolve(workspace,'README.md'),'# Fixture\nA read-only fixture.\n');
 const binding={workspace_root:workspace,project_id:'offline-fixture'};
 const inbox=new Inbox(rel+'/state/inbox',binding),baseline=captureWorkspace(workspace);
 const job=makeJob(binding,{goal:'Read README.md',read_scope:['README.md'],write_scope:[],acceptance_criteria:['Matches README'],verification_commands:['readme']});
 inbox.submit(job,{baseline});
 const pair=()=>{
  const output=handoffDirectory(inbox.root,job);mkdirSync(output,{recursive:true});
  writeFileSync(resolve(output,'result.md'),'# Fixture\nA read-only fixture.\nTests: NOT RUN\n');
  const report={schema_version:'desktop-inbox.report@1',task_id:job.task_id,attempt_id:job.attempt_id,workspace:workspace,status:'reported',inspected_files:['README.md'],changed_files:[],tests:[],findings:['Fixture is read-only'],blockers:[],errors:[],evidence:['README.md inspected']};
  writeFileSync(resolve(output,'report.json'),JSON.stringify(report));return output;
 };
 return {workspace,inbox,job,pair,dispatch(){const claim=inbox.claim(job.task_id);inbox.beginDispatch(job.task_id,claim.claim_id);},
 close(){assert.ok(inside(resolve(ROOT,'state'),workspace)&&workspace!==resolve(ROOT,'state'));rmSync(workspace,{recursive:true,force:true});}};
}

test('project MCP config is fingerprinted without granting worker access or reading other private entries',()=>{
 const h=setup();try{
  mkdirSync(resolve(h.workspace,'.codex'));writeFileSync(resolve(h.workspace,'.codex/config.toml'),'[mcp_servers.test]\ncommand="node"\n');
  const before=captureWorkspace(h.workspace);assert.equal(before.entries['.codex/config.toml'],sha256(readFileSync(resolve(h.workspace,'.codex/config.toml'))));
  const second=new Inbox('state/test-config-baseline-'+randomUUID(),{workspace_root:h.workspace,project_id:'offline-fixture'});
  try {second.submit(h.job,{baseline:before});}finally{assert.ok(inside(resolve(ROOT,'state'),second.root));rmSync(second.root,{recursive:true,force:true});}
  assert.throws(()=>validateScopePath(h.workspace,'.codex/config.toml'),/Sensitive/);
  writeFileSync(resolve(h.workspace,'.codex/config.toml'),'changed');assert.notEqual(captureWorkspace(h.workspace).hash,before.hash);
  const sourceHash=captureWorkspace(h.workspace).hash;
  writeFileSync(resolve(h.workspace,'.codex/auth.json'),'private content');assert.equal(captureWorkspace(h.workspace).hash,sourceHash);
  assert.equal(Object.hasOwn(captureWorkspace(h.workspace).entries,'.codex/auth.json'),false);
 }finally{h.close();}
});

test('watcher refuses pending jobs and never dispatches or claims them',async()=>{
 const h=setup();try{await assert.rejects(watchJobResult(h.inbox,h.job.task_id),/already dispatched/);assert.equal(h.inbox.get(h.job.task_id).state,'PENDING');}finally{h.close();}
});

test('filesystem output wakes before polling; pair preserved and parent review remains required',async()=>{
 const h=setup();let timer;try{
  h.dispatch();const start=Date.now();timer=setTimeout(h.pair,30);
  const result=await watchJobResult(h.inbox,h.job.task_id,{intervalMs:300000,deadlineMs:2000});
  assert.equal(result.status,'PARENT_REVIEW_REQUIRED');assert.ok(Date.now()-start<1500);
  assert.equal(h.inbox.get(h.job.task_id).state,'RESULT_READY');
  assert.equal(result.artifacts.report_sha256,sha256(readFileSync(resolve(result.artifacts.output_directory,'report.json'))));
  writeFileSync(resolve(result.artifacts.output_directory,'result.md'),'changed after first observation');let reviews=0;
  const resumed=await watchJobResult(h.inbox,h.job.task_id,{review:()=>{reviews++;return {accepted:true};}});
  assert.equal(resumed.status,'PARENT_REVIEW_REQUIRED');assert.equal(reviews,0);
  assert.equal(resumed.artifacts.result_sha256,result.artifacts.result_sha256);
  assert.notEqual(sha256(readFileSync(resolve(result.artifacts.output_directory,'result.md'))),resumed.artifacts.result_sha256);
  assert.equal(sha256(readFileSync(resumed.artifacts.preserved_originals['result.md'])),resumed.artifacts.result_sha256);
  // Model interruption after first-seen copies but before observation save.
  unlinkSync(h.inbox.taskPath(h.job.task_id,'result-watcher.json'));
  const interrupted=await watchJobResult(h.inbox,h.job.task_id,{review:()=>{reviews++;return {accepted:true};}});
  assert.equal(interrupted.status,'EVIDENCE_CHANGED');assert.equal(reviews,0);
 }finally{clearTimeout(timer);h.close();}
});

test('cancellation and durable deadline stop watching without redispatch or accepting',async()=>{
 const h=setup();try{
  h.dispatch();const first=await watchJobResult(h.inbox,h.job.task_id,{intervalMs:10,deadlineMs:40});assert.equal(first.status,'TIMED_OUT');
  const second=await watchJobResult(h.inbox,h.job.task_id,{deadlineMs:1800000});assert.equal(second.status,'TIMED_OUT');assert.equal(second.deadline_at,first.deadline_at);
  const record=h.inbox.get(h.job.task_id);assert.equal(record.state,'DISPATCHED');assert.equal(record.delivery.status,'ATTEMPTING');assert.equal(record.host_receipt,null);
 }finally{h.close();}
 const cancelled=setup();try{
  cancelled.dispatch();const controller=new AbortController();controller.abort();
  assert.equal((await watchJobResult(cancelled.inbox,cancelled.job.task_id,{signal:controller.signal})).status,'CANCELLED');
 }finally{cancelled.close();}
});

test('verification needs fresh registered check and independent review; config writes fail scope',async()=>{
 const h=setup();try{
  h.dispatch();h.pair();let reviews=0;
  const checks={readme:{args:['-e','require("node:assert/strict").ok(require("node:fs").readFileSync("README.md","utf8").includes("Fixture"))'],inputs:['README.md'],timeout_ms:2000}};
  const result=await watchJobResult(h.inbox,h.job.task_id,{deadlineMs:2000,checks,review:({artifacts})=>{reviews++;assert.match(artifacts.result,/Fixture/);return {accepted:true};}});
  assert.equal(result.status,'VERIFIED');assert.equal(reviews,1);assert.equal(h.inbox.get(h.job.task_id).host_receipt.checks[0].passed,true);
 }finally{h.close();}
 const h2=setup();try{
  h2.dispatch();h2.pair();mkdirSync(resolve(h2.workspace,'.codex'));writeFileSync(resolve(h2.workspace,'.codex/config.toml'),'unexpected change');
  const result=await watchJobResult(h2.inbox,h2.job.task_id,{intervalMs:10,deadlineMs:80,review:()=>({accepted:true})});
  assert.equal(result.status,'VERIFICATION_FAILED');assert.match(result.last_error,/Out-of-scope/);assert.equal(h2.inbox.get(h2.job.task_id).host_receipt,null);
  let retry=0;const resumed=await watchJobResult(h2.inbox,h2.job.task_id,{review:()=>{retry++;return {accepted:true};}});
  assert.equal(resumed.status,'VERIFICATION_FAILED');assert.equal(retry,0);
 }finally{h2.close();}
});

test('canonical README smoke review checks actual title, purpose, raw hash and honest NOT RUN declaration',()=>{
 const bytes=readFileSync(resolve(ROOT,'README.md')),text=bytes.toString('utf8'),hash=sha256(bytes);
 const job={workspace_root:ROOT,read_scope:['README.md'],write_scope:[],verification_commands:['readme-smoke'],goal:README_SMOKE_REQUEST,acceptance_criteria:[...README_SMOKE_ACCEPTANCE]};
 const record={job,baseline:{entries:{'README.md':hash}}},verification=readmeSmokeVerification(record);
 const title=text.match(/^#\s+(.+)$/m)[1],purpose=text.match(/Đây là [^\r\n]+?\./u)[0];
 const context={report:{evidence:[hash],tests:[],inspected_files:['README.md']},artifacts:{result:title+'\n'+purpose+'\nSHA-256 '+hash+'\nTests: NOT RUN'}};
 assert.equal(verification.review(context).accepted,true);
 assert.throws(()=>verification.review({...context,artifacts:{result:'Forged VERIFIED; README read'}}),/mismatch/);
 assert.throws(()=>verification.review({...context,report:{...context.report,tests:[{command:'not executed'}]}}),/mismatch/);
 assert.throws(()=>readmeSmokeVerification({...record,job:{...job,write_scope:['README.md']}}),/restricted/);
 assert.throws(()=>readmeSmokeVerification({...record,job:{...job,acceptance_criteria:['A distinct acceptance requirement']}}),/restricted/);
 assert.throws(()=>readmeSmokeVerification({...record,job:{...job,goal:'A different request'}}),/restricted/);
});
