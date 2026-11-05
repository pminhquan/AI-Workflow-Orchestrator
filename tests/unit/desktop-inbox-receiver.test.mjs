import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT,inside,sha256} from '../../src/core/util.mjs';
import {makeJob} from '../../src/desktop-inbox/contracts.mjs';
import {Inbox} from '../../src/desktop-inbox/inbox.mjs';
import {captureWorkspace} from '../../src/desktop-inbox/verification.mjs';
import {validateAppProjectBinding,buildAppPrompt,handoffDirectory,runAppReceiverOnce} from '../../src/desktop-inbox/app-receiver.mjs';

function setup() {
  const rel='state/test-app-receiver-'+randomUUID(),dir=resolve(ROOT,rel),workspace=resolve(dir,'workspace');
  mkdirSync(workspace,{recursive:true});writeFileSync(resolve(workspace,'README.md'),'Offline receiver lifecycle fixture.\n');
  const sourcePath=rel+'/app-evidence.txt',proofPath=rel+'/project-proof.json';
  writeFileSync(resolve(ROOT,sourcePath),'OFFLINE TEST ONLY: simulated parent-reviewed evidence, not App receipt.');
  const binding={schema_version:'desktop-inbox.binding@1',enabled:true,workspace_root:workspace,
    project_id:'offline-project',conversation_mode:'new',conversation_id:null,runtime_version:'2.29.0',
    poll_interval_ms:2000,transport_timeout_ms:1000,review:{authorization:true,runtime:true,project:true,
      conversation:false,user_opt_in:true,authorization_reference:'<OFFLINE_FIXTURE_REFERENCE>',runtime_reference:'offline test fixture only',
      project_reference:proofPath,conversation_reference:''}};
  const proof={format:'desktop-inbox.parent-project-binding@1',workspace_root:workspace,project_id:binding.project_id,
    source_path:sourcePath,source_sha256:sha256(readFileSync(resolve(ROOT,sourcePath))),source_description:'Offline test source, not live proof',
    reviewed_by:'codex-parent',reviewed_at:new Date().toISOString()};
  writeFileSync(resolve(ROOT,proofPath),JSON.stringify(proof));
  const dataDirectory=resolve(dir,'sidecar/data');mkdirSync(dataDirectory,{recursive:true});mkdirSync(resolve(dir,'sidecar/events'));
  const inbox=new Inbox(rel+'/inbox',binding),baseline=captureWorkspace(workspace);
  const job=extra=>makeJob(binding,{goal:'Read README.md; do not execute $(anything).',read_scope:['README.md'],write_scope:[],
    acceptance_criteria:['Summary matches README'],verification_commands:['readme-check'],...extra});
  const submit=extra=>{const value=job(extra);inbox.submit(value,{baseline});return value;};
  return {rel,dir,workspace,sourcePath,proofPath,proof,binding,dataDirectory,inbox,baseline,job,submit,
    close(){assert.ok(inside(resolve(ROOT,'state'),dir)&&dir!==resolve(ROOT,'state'));rmSync(dir,{recursive:true,force:true});}};
}

test('receiver disabled or missing independent project evidence never claims a job',async()=>{
  const h=setup();try{
    const job=h.submit();let calls=0;
    const options={dataDirectory:h.dataDirectory,offlineTestInvoke:()=>{calls++;throw Error('unexpected');}};
    assert.equal((await runAppReceiverOnce(h.inbox,{...h.binding,enabled:false},options)).status,'DISABLED');
    assert.throws(()=>validateAppProjectBinding({...h.binding,review:{...h.binding.review,project:false}}),/review required: project/);
    writeFileSync(resolve(ROOT,h.proofPath),JSON.stringify({...h.proof,project_id:'another-project'}));
    await assert.rejects(runAppReceiverOnce(h.inbox,h.binding,options),/project binding/);
    assert.equal(h.inbox.get(job.task_id).state,'PENDING');assert.equal(calls,0);
  }finally{h.close();}
});

test('project review requires matching source bytes; flags cannot replace proof',()=>{
  const h=setup();try{
    const checked=validateAppProjectBinding(h.binding);assert.equal(checked.source_sha256,h.proof.source_sha256);
    assert.match(checked.attribution,/not App-signed/);
    writeFileSync(resolve(ROOT,h.sourcePath),'Changed evidence');
    assert.throws(()=>validateAppProjectBinding(h.binding),/source hash mismatch/);
    assert.throws(()=>validateAppProjectBinding({...h.binding,review:{...h.binding.review,project_reference:'README.md'}}),/canonical state evidence/);
  }finally{h.close();}
});

test('receiver rejects unsupported existing conversation and writable jobs before dispatch',async()=>{
  const h=setup();try{
    assert.throws(()=>validateAppProjectBinding({...h.binding,conversation_mode:'existing',conversation_id:'existing-id'}),/new-conversation only/);
    const job=h.submit({write_scope:['README.md']});
    await assert.rejects(runAppReceiverOnce(h.inbox,h.binding,{dataDirectory:h.dataDirectory}),/read-only/);
    assert.equal(h.inbox.get(job.task_id).state,'PENDING');
  }finally{h.close();}
});

test('documented App runtime is required; output contract derives paths from validated identity',async()=>{
  const h=setup();try{
    const job=h.submit();
    await assert.rejects(runAppReceiverOnce(h.inbox,h.binding,{dataDirectory:null}),/App-owned Sidecar/);
    assert.equal(h.inbox.get(job.task_id).state,'PENDING');
    const prompt=JSON.parse(buildAppPrompt(job,h.inbox.root,h.binding));
    assert.equal(prompt.output_directory,handoffDirectory(h.inbox.root,job));
    assert.ok(prompt.output_directory.endsWith('output-'+job.attempt_id));
    assert.equal(prompt.output_contract['report.json'].task_id,job.task_id);
    assert.equal(prompt.output_contract['report.json'].attempt_id,job.attempt_id);
    assert.ok(Object.hasOwn(prompt.output_contract['report.json'],'errors'));
    assert.ok(Object.hasOwn(prompt.output_contract['report.json'],'evidence'));
    assert.equal(prompt.job.goal,job.goal);assert.equal(existsSync(resolve(h.workspace,'anything')),false);
  }finally{h.close();}
});

test('one durable intent invokes once; exit zero and forged claims never establish App receipt or completion',async()=>{
  const h=setup();try{
    const job=h.submit();let calls=0;
    const options={dataDirectory:h.dataDirectory,offlineTestInvoke:async prompt=>{
      calls++;assert.equal(JSON.parse(prompt).job.task_id,job.task_id);
      return {started:true,exit_code:0,spawn_error:null,timed_out:false,kind:'ANTIGRAVITY_APP_AGENTAPI',delivery_status:'VERIFIED',execution_status:'VERIFIED'};
    }};
    const result=await runAppReceiverOnce(h.inbox,h.binding,options);
    assert.equal(result.status,'AWAITING_ARTIFACTS');assert.equal(result.receipt.kind,'OFFLINE_TEST');
    assert.equal(result.receipt.delivery_status,'NOT VERIFIED');assert.equal(result.receipt.execution_status,'NOT VERIFIED');
    assert.deepEqual(result.receipt.event_references,[]);
    assert.equal(h.inbox.get(job.task_id).state,'DISPATCHED');
    assert.equal(h.inbox.get(job.task_id).report_sha256,null);
    assert.equal((await runAppReceiverOnce(h.inbox,h.binding,options)).status,'IDLE');assert.equal(calls,1);
    assert.throws(()=>h.inbox.claim(job.task_id),/not pending/);
  }finally{h.close();}
});

test('unknown delivery survives restart and cannot be redispatched',async()=>{
  const h=setup();try{
    const job=h.submit();let calls=0;
    const options={dataDirectory:h.dataDirectory,offlineTestInvoke:async()=>{calls++;return {started:true,exit_code:1,spawn_error:null,timed_out:false};}};
    const result=await runAppReceiverOnce(h.inbox,h.binding,options);
    assert.equal(result.status,'UNCERTAIN_DELIVERY');
    const restarted=new Inbox(h.rel+'/inbox',h.binding);
    assert.equal(restarted.get(job.task_id).outcome,'UNCERTAIN_DELIVERY');
    assert.equal((await runAppReceiverOnce(restarted,h.binding,options)).status,'IDLE');assert.equal(calls,1);
    assert.throws(()=>h.submit(),/active or uncertain/);
  }finally{h.close();}
});

test('pre-spawn absence fails without manufacturing a receipt or running another attempt',async()=>{
  const h=setup();try{
    const job=h.submit();
    const result=await runAppReceiverOnce(h.inbox,h.binding,{dataDirectory:h.dataDirectory,
      offlineTestInvoke:async()=>({started:false,exit_code:null,spawn_error:'ENOENT',timed_out:false})});
    assert.equal(result.status,'FAILED');assert.equal(result.agentapi_called,false);
    assert.equal(h.inbox.get(job.task_id).outcome,'FAILED');assert.deepEqual(result.receipt.event_references,[]);
  }finally{h.close();}
});
