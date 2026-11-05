import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT,inside} from '../../src/core/util.mjs';
import {
 HEARTBEAT_MAX_AGE_MS,
 TARGET_OBSERVATION_TTL_MS,
 READINESS_REASONS,
 isWorkspaceSlotHeld,
 parseStrictIsoMs,
 evaluateBridgeReadiness,
 inspectWorkspaceReadiness
} from '../../src/desktop-inbox/readiness.mjs';
import {
 activeTargetPath,
 openLiveInbox,
 registerLocalWorkspace,
 resolveWorkspaceConfig,
 sidecarHeartbeatPath,
 writeActiveTarget,
 writeSidecarHeartbeat
} from '../../src/desktop-inbox/live-bridge.mjs';
import {createLiveToolHandler} from '../../src/desktop-inbox/live-mcp-server.mjs';
import {bridgeDoctor} from '../../src/desktop-inbox/bridge-cli.mjs';

function createReadinessFixture({allowNewConversation=false,initialNowMs=1_700_000_000_000}={}){
 const rel=`state/test-readiness-${randomUUID()}`;
 const dir=resolve(ROOT,rel);
 const stateDirectory=`${rel}/live-state`;
 const workspace=resolve(dir,'workspace-primary');
 const otherWorkspace=resolve(dir,'workspace-foreign');
 mkdirSync(workspace,{recursive:true});
 mkdirSync(otherWorkspace,{recursive:true});
 writeFileSync(resolve(workspace,'README.md'),'# Readiness Fixture\n');
 writeFileSync(resolve(otherWorkspace,'README.md'),'# Foreign Workspace\n');

 let clockMs=initialNowMs;
 const now=()=>clockMs;
 const setNow=ms=>{clockMs=ms;};
 const config=registerLocalWorkspace(workspace,{allowNewConversation,stateDirectory});
 const callTool=createLiveToolHandler({defaultWorkspaceRoot:workspace,stateDirectory,now});

 return {
  rel,
  dir,
  stateDirectory,
  workspace,
  otherWorkspace,
  config,
  now,
  setNow,
  callTool,
  makeValidHeartbeat(overrides={}){
   return {
    format:'desktop-inbox.sidecar-heartbeat@1',
    pid:4242,
    status:'RUNNING',
    updated_at:new Date(clockMs).toISOString(),
    agentapi_available:true,
    ls_address_present:true,
    code_version:'2.5.1',
    ...overrides
   };
  },
  makeValidTarget(overrides={}){
   return {
    format:'desktop-inbox.active-target@1',
    workspace_root:config.workspace_root,
    project_id:config.slug,
    conversation_id:'conv-ready-101',
    event_name:'SessionStart',
    model_name:'gemini-2.5-pro',
    updated_at:new Date(clockMs).toISOString(),
    ...overrides
   };
  },
  close(){
   const stateRoot=resolve(ROOT,'state');
   assert.ok(inside(stateRoot,dir)&&dir!==stateRoot);
   rmSync(dir,{recursive:true,force:true});
  }
 };
}

test('heartbeat updates during readiness I/O do not cause false future diagnoses in shared evaluator, CLI or MCP',async()=>{
 const readStatuses=[
  options=>inspectWorkspaceReadiness(options),
  options=>bridgeDoctor(options),
  ({workspaceRoot,...options})=>createLiveToolHandler({defaultWorkspaceRoot:workspaceRoot,...options})('bridge_status',{})
 ];
 for(const readStatus of readStatuses){
  const f=createReadinessFixture();
  try{
   writeActiveTarget(f.workspace,{conversationId:'clock-race-fixture',stateDirectory:f.stateDirectory,now:f.now});
   writeSidecarHeartbeat('RUNNING',{stateDirectory:f.stateDirectory,now:f.now,extra:{agentapi_available:true,ls_address_present:true}});
   let clockMs=f.now();
   let samples=0;
   const advancingClock=()=>{
    const sampled=clockMs;
    if(samples++===0){
     clockMs+=100;
     // Model a Sidecar update after the initial clock sample, before file reads.
     writeSidecarHeartbeat('RUNNING',{stateDirectory:f.stateDirectory,now:()=>clockMs,extra:{agentapi_available:true,ls_address_present:true}});
    }
    return sampled;
   };
   const status=await readStatus({workspaceRoot:f.workspace,stateDirectory:f.stateDirectory,now:advancingClock});
   assert.equal(status.ready_to_dispatch,true);
   assert.equal(status.heartbeat_age_ms,0);
   assert.deepEqual(status.reason_codes,[]);
  }finally{
   f.close();
  }
 }
});

test('constants, frozen reason enum, and strict ISO-8601 parser validate edge cases including epoch 0',()=>{
 assert.equal(HEARTBEAT_MAX_AGE_MS,15_000);
 assert.equal(TARGET_OBSERVATION_TTL_MS,2*60*60*1000);
 assert.equal(Number.isFinite(TARGET_OBSERVATION_TTL_MS),true);
 assert.equal(Object.isFrozen(READINESS_REASONS),true);
 assert.deepEqual(Object.keys(READINESS_REASONS),[
  'HEARTBEAT_MISSING',
  'HEARTBEAT_MALFORMED',
  'SIDECAR_NOT_RUNNING',
  'HEARTBEAT_FUTURE',
  'HEARTBEAT_STALE',
  'AGENTAPI_UNAVAILABLE',
  'LS_ADDRESS_MISSING',
  'TARGET_MISSING',
  'TARGET_MALFORMED',
  'TARGET_FOREIGN_WORKSPACE',
  'TARGET_FOREIGN_PROJECT',
  'TARGET_FUTURE',
  'TARGET_STALE',
  'WORKSPACE_SLOT_HELD'
 ]);

 assert.equal(parseStrictIsoMs('1970-01-01T00:00:00.000Z'),0);
 assert.equal(parseStrictIsoMs('1970-01-01T00:00:00Z'),0);
 assert.equal(parseStrictIsoMs('2026-11-06T00:18:35+07:00'),Date.parse('2026-11-05T17:18:35.000Z'));
 assert.equal(parseStrictIsoMs('2026-11-05T17:18:35.25Z'),Date.parse('2026-11-05T17:18:35.250Z'));

 for(const bad of [
  null,
  undefined,
  0,
  {},
  '',
  '   ',
  '2026-11-05',
  '2026-11-05T17:18:35',
  '2026-11-05 17:18:35Z',
  'Thu, 05 Nov 2026 17:18:35 GMT',
  '2026-02-30T00:00:00.000Z',
  '2026-11-05T17:18:35+25:00'
 ]){
  assert.equal(parseStrictIsoMs(bad),null);
 }

 assert.throws(()=>evaluateBridgeReadiness({targetTtlMs:Infinity}),/positive finite/);
 assert.throws(()=>evaluateBridgeReadiness({heartbeatMaxAgeMs:0}),/positive finite/);
});

test('clean READY_TO_DISPATCH and epoch timestamp 0 work deterministically without claiming GUI focus',()=>{
 const h=createReadinessFixture({initialNowMs:0});
 try{
  const hbZero=h.makeValidHeartbeat({updated_at:'1970-01-01T00:00:00.000Z'});
  const targetZero=h.makeValidTarget({updated_at:'1970-01-01T00:00:00.000Z'});

  for(const clockArg of [()=>0,0]){
   const ready=evaluateBridgeReadiness({
    workspaceRoot:h.workspace,
    projectId:h.config.slug,
    heartbeat:hbZero,
    target:targetZero,
    records:[],
    now:clockArg
   });
   assert.equal(ready.ready_to_dispatch,true);
   assert.equal(ready.readiness_status,'READY_TO_DISPATCH');
   assert.deepEqual(ready.reason_codes,[]);
   assert.equal(ready.slot_available,true);
   assert.equal(ready.active_task,null);
   assert.equal(ready.sidecar_running,true);
   assert.equal(ready.sidecar_agentapi_available,true);
   assert.equal(ready.sidecar_ls_address_present,true);
   assert.equal(ready.sidecar_code_version,'2.5.1');
   assert.equal(ready.heartbeat_age_ms,0);
   assert.equal(ready.target_age_ms,0);
   assert.deepEqual(ready.active_gui_target,targetZero);
   assert.deepEqual(ready.target_observation,{
    present:true,
    valid:true,
    bound:true,
    fresh:true,
    age_ms:0,
    ttl_ms:TARGET_OBSERVATION_TTL_MS,
    conversation_id:'conv-ready-101',
    source:'hook_beacon_observation',
    proves_gui_focus:false
   });
  }
 }finally{
  h.close();
 }
});

test('heartbeat failure modes and transport/LS gates block ready_to_dispatch accurately',()=>{
 const h=createReadinessFixture();
 try{
  const target=h.makeValidTarget();

  // 1. Missing heartbeat
  const missing=evaluateBridgeReadiness({
   workspaceRoot:h.workspace,
   projectId:h.config.slug,
   heartbeat:null,
   target,
   now:h.now
  });
  assert.equal(missing.ready_to_dispatch,false);
  assert.equal(missing.sidecar_running,false);
  assert.equal(missing.heartbeat_age_ms,null);
  assert.deepEqual(missing.reason_codes,[READINESS_REASONS.HEARTBEAT_MISSING]);

  // 2. Malformed schemas
  for(const badHb of [
   'not-an-object',
   [],
   {},
   h.makeValidHeartbeat({format:'wrong@1'}),
   h.makeValidHeartbeat({pid:0}),
   h.makeValidHeartbeat({pid:-5}),
   h.makeValidHeartbeat({status:'   '}),
   h.makeValidHeartbeat({updated_at:'not-iso'})
  ]){
   const res=evaluateBridgeReadiness({
    workspaceRoot:h.workspace,
    projectId:h.config.slug,
    heartbeat:badHb,
    target,
    now:h.now
   });
   assert.equal(res.ready_to_dispatch,false);
   assert.equal(res.sidecar_running,false);
   assert.deepEqual(res.reason_codes,[READINESS_REASONS.HEARTBEAT_MALFORMED]);
  }

  // 3. Corrupt JSON on disk via inspectWorkspaceReadiness
  writeActiveTarget(h.workspace,{conversationId:'conv-disk-1',stateDirectory:h.stateDirectory,now:h.now});
  const hbPath=sidecarHeartbeatPath(h.stateDirectory);
  mkdirSync(resolve(hbPath,'..'),{recursive:true});
  writeFileSync(hbPath,'{corrupt-json');
  const corruptDisk=inspectWorkspaceReadiness({workspaceRoot:h.workspace,stateDirectory:h.stateDirectory,now:h.now});
  assert.equal(corruptDisk.ready_to_dispatch,false);
  assert.equal(corruptDisk.heartbeat,null);
  assert.deepEqual(corruptDisk.reason_codes,[READINESS_REASONS.HEARTBEAT_MALFORMED]);

  writeFileSync(hbPath,'null\n');
  const nullDisk=inspectWorkspaceReadiness({workspaceRoot:h.workspace,stateDirectory:h.stateDirectory,now:h.now});
  assert.deepEqual(nullDisk.reason_codes,[READINESS_REASONS.HEARTBEAT_MALFORMED]);

  // 4. STOPPED / RELOADING status
  for(const status of ['STOPPED','RELOADING']){
   const nonRunning=evaluateBridgeReadiness({
    workspaceRoot:h.workspace,
    projectId:h.config.slug,
    heartbeat:h.makeValidHeartbeat({status}),
    target,
    now:h.now
   });
   assert.equal(nonRunning.ready_to_dispatch,false);
   assert.equal(nonRunning.sidecar_running,false);
   assert.deepEqual(nonRunning.reason_codes,[READINESS_REASONS.SIDECAR_NOT_RUNNING]);
  }

  // 5. Boundary freshness (14_999 fresh vs 15_000 stale) and future skew
  const justFresh=evaluateBridgeReadiness({
   workspaceRoot:h.workspace,
   projectId:h.config.slug,
   heartbeat:h.makeValidHeartbeat({updated_at:new Date(h.now()-HEARTBEAT_MAX_AGE_MS+1).toISOString()}),
   target,
   now:h.now
  });
  assert.equal(justFresh.ready_to_dispatch,true);
  assert.equal(justFresh.sidecar_running,true);

  const exactStale=evaluateBridgeReadiness({
   workspaceRoot:h.workspace,
   projectId:h.config.slug,
   heartbeat:h.makeValidHeartbeat({updated_at:new Date(h.now()-HEARTBEAT_MAX_AGE_MS).toISOString()}),
   target,
   now:h.now
  });
  assert.equal(exactStale.ready_to_dispatch,false);
  assert.equal(exactStale.sidecar_running,false);
  assert.deepEqual(exactStale.reason_codes,[READINESS_REASONS.HEARTBEAT_STALE]);

  const futureHb=evaluateBridgeReadiness({
   workspaceRoot:h.workspace,
   projectId:h.config.slug,
   heartbeat:h.makeValidHeartbeat({updated_at:new Date(h.now()+1000).toISOString()}),
   target,
   now:h.now
  });
  assert.equal(futureHb.ready_to_dispatch,false);
  assert.equal(futureHb.sidecar_running,false);
  assert.equal(futureHb.heartbeat_age_ms,-1000);
  assert.deepEqual(futureHb.reason_codes,[READINESS_REASONS.HEARTBEAT_FUTURE]);

  // 6. Transport & LS checks
  const noAgentapi=evaluateBridgeReadiness({
   workspaceRoot:h.workspace,
   projectId:h.config.slug,
   heartbeat:h.makeValidHeartbeat({agentapi_available:false}),
   target,
   now:h.now
  });
  assert.equal(noAgentapi.sidecar_running,true);
  assert.equal(noAgentapi.sidecar_agentapi_available,false);
  assert.equal(noAgentapi.ready_to_dispatch,false);
  assert.deepEqual(noAgentapi.reason_codes,[READINESS_REASONS.AGENTAPI_UNAVAILABLE]);

  const missingLs=evaluateBridgeReadiness({
   workspaceRoot:h.workspace,
   projectId:h.config.slug,
   heartbeat:h.makeValidHeartbeat({ls_address_present:false}),
   target,
   now:h.now
  });
  assert.equal(missingLs.sidecar_running,true);
  assert.equal(missingLs.sidecar_ls_address_present,false);
  assert.equal(missingLs.ready_to_dispatch,false);
  assert.deepEqual(missingLs.reason_codes,[READINESS_REASONS.LS_ADDRESS_MISSING]);

  const bothMissing=evaluateBridgeReadiness({
   workspaceRoot:h.workspace,
   projectId:h.config.slug,
   heartbeat:{
    format:'desktop-inbox.sidecar-heartbeat@1',
    pid:4242,
    status:'RUNNING',
    updated_at:new Date(h.now()).toISOString()
   },
   target,
   now:h.now
  });
  assert.equal(bothMissing.sidecar_agentapi_available,null);
  assert.equal(bothMissing.sidecar_ls_address_present,null);
  assert.deepEqual(bothMissing.reason_codes,[
   READINESS_REASONS.AGENTAPI_UNAVAILABLE,
   READINESS_REASONS.LS_ADDRESS_MISSING
  ]);
 }finally{
  h.close();
 }
});

test('target missing, malformed, foreign workspace (existing and nonexistent), foreign project, future, and stale TTL are rejected safely',()=>{
 const h=createReadinessFixture({allowNewConversation:true});
 try{
  const heartbeat=h.makeValidHeartbeat();

  // 1. Missing target even when allowNewConversation is true
  const missing=evaluateBridgeReadiness({
   workspaceRoot:h.workspace,
   projectId:h.config.slug,
   allowNewConversation:true,
   heartbeat,
   target:null,
   now:h.now
  });
  assert.equal(missing.ready_to_dispatch,false);
  assert.equal(missing.active_gui_target,null);
  assert.equal(missing.target_observation.present,false);
  assert.deepEqual(missing.reason_codes,[READINESS_REASONS.TARGET_MISSING]);

  // 2. Malformed target schemas (including relative path and traversal segments)
  for(const badTarget of [
   'invalid',
   {},
   h.makeValidTarget({format:'bad-target@1'}),
   h.makeValidTarget({conversation_id:''}),
   h.makeValidTarget({conversation_id:'../escape'}),
   h.makeValidTarget({conversation_id:'has spaces'}),
   h.makeValidTarget({workspace_root:'relative/workspace'}),
   h.makeValidTarget({workspace_root:`${h.workspace}/../escape`}),
   h.makeValidTarget({project_id:''}),
   h.makeValidTarget({updated_at:'bad-date'})
  ]){
   const res=evaluateBridgeReadiness({
    workspaceRoot:h.workspace,
    projectId:h.config.slug,
    heartbeat,
    target:badTarget,
    now:h.now
   });
   assert.equal(res.ready_to_dispatch,false);
   assert.equal(res.target_observation.valid,false);
   assert.deepEqual(res.reason_codes,[READINESS_REASONS.TARGET_MALFORMED]);
  }

  // 3. Corrupt target JSON on disk via inspectWorkspaceReadiness
  writeSidecarHeartbeat('RUNNING',{
   stateDirectory:h.stateDirectory,
   now:h.now,
   extra:{agentapi_available:true,ls_address_present:true}
  });
  const tPath=activeTargetPath(h.workspace,h.stateDirectory);
  mkdirSync(resolve(tPath,'..'),{recursive:true});
  writeFileSync(tPath,'{broken-target-json');
  const corruptTargetDisk=inspectWorkspaceReadiness({workspaceRoot:h.workspace,stateDirectory:h.stateDirectory,now:h.now});
  assert.equal(corruptTargetDisk.ready_to_dispatch,false);
  assert.deepEqual(corruptTargetDisk.reason_codes,[READINESS_REASONS.TARGET_MALFORMED]);

  // 4. Foreign workspace_root: existing other directory AND non-existing synthetic directory (must not crash!)
  const foreignOtherConfig=resolveWorkspaceConfig(h.otherWorkspace,{stateDirectory:h.stateDirectory});
  const foreignExisting=evaluateBridgeReadiness({
   workspaceRoot:h.workspace,
   projectId:h.config.slug,
   heartbeat,
   target:h.makeValidTarget({workspace_root:foreignOtherConfig.workspace_root}),
   now:h.now
  });
  assert.equal(foreignExisting.ready_to_dispatch,false);
  assert.equal(foreignExisting.active_gui_target,null);
  assert.equal(foreignExisting.target_observation.valid,true);
  assert.equal(foreignExisting.target_observation.bound,false);
  assert.equal(foreignExisting.target_observation.conversation_id,null);
  assert.deepEqual(foreignExisting.reason_codes,[READINESS_REASONS.TARGET_FOREIGN_WORKSPACE]);

  const nonexistentForeignDir=resolve(h.dir,'nonexistent-foreign-workspace');
  assert.equal(existsSync(nonexistentForeignDir),false);
  const foreignMissingDir=evaluateBridgeReadiness({
   workspaceRoot:h.workspace,
   projectId:h.config.slug,
   heartbeat,
   target:h.makeValidTarget({workspace_root:nonexistentForeignDir}),
   now:h.now
  });
  assert.equal(foreignMissingDir.ready_to_dispatch,false);
  assert.equal(foreignMissingDir.active_gui_target,null);
  assert.equal(foreignMissingDir.target_observation.bound,false);
  assert.deepEqual(foreignMissingDir.reason_codes,[READINESS_REASONS.TARGET_FOREIGN_WORKSPACE]);

  // Also verify foreign target written directly to disk is reported as TARGET_FOREIGN_WORKSPACE (not swallowed as null/missing)
  writeFileSync(tPath,JSON.stringify(h.makeValidTarget({workspace_root:nonexistentForeignDir}))+'\n');
  const foreignDisk=inspectWorkspaceReadiness({workspaceRoot:h.workspace,stateDirectory:h.stateDirectory,now:h.now});
  assert.deepEqual(foreignDisk.reason_codes,[READINESS_REASONS.TARGET_FOREIGN_WORKSPACE]);

  // 5. Foreign project_id
  const foreignProject=evaluateBridgeReadiness({
   workspaceRoot:h.workspace,
   projectId:h.config.slug,
   heartbeat,
   target:h.makeValidTarget({project_id:'foreign-project-99999999'}),
   now:h.now
  });
  assert.equal(foreignProject.ready_to_dispatch,false);
  assert.equal(foreignProject.active_gui_target,null);
  assert.equal(foreignProject.target_observation.bound,false);
  assert.deepEqual(foreignProject.reason_codes,[READINESS_REASONS.TARGET_FOREIGN_PROJECT]);

  // 6. Future target & finite TTL staleness boundary
  const futureTarget=evaluateBridgeReadiness({
   workspaceRoot:h.workspace,
   projectId:h.config.slug,
   heartbeat,
   target:h.makeValidTarget({updated_at:new Date(h.now()+500).toISOString()}),
   now:h.now
  });
  assert.equal(futureTarget.ready_to_dispatch,false);
  assert.equal(futureTarget.target_observation.fresh,false);
  assert.equal(futureTarget.target_age_ms,-500);
  assert.deepEqual(futureTarget.reason_codes,[READINESS_REASONS.TARGET_FUTURE]);

  const justInsideTtl=evaluateBridgeReadiness({
   workspaceRoot:h.workspace,
   projectId:h.config.slug,
   heartbeat,
   target:h.makeValidTarget({updated_at:new Date(h.now()-TARGET_OBSERVATION_TTL_MS+1).toISOString()}),
   now:h.now
  });
  assert.equal(justInsideTtl.ready_to_dispatch,true);
  assert.equal(justInsideTtl.target_observation.fresh,true);

  const staleTarget=evaluateBridgeReadiness({
   workspaceRoot:h.workspace,
   projectId:h.config.slug,
   heartbeat,
   target:h.makeValidTarget({updated_at:new Date(h.now()-TARGET_OBSERVATION_TTL_MS).toISOString()}),
   now:h.now
  });
  assert.equal(staleTarget.ready_to_dispatch,false);
  assert.equal(staleTarget.target_observation.bound,true);
  assert.equal(staleTarget.target_observation.fresh,false);
  assert.deepEqual(staleTarget.reason_codes,[READINESS_REASONS.TARGET_STALE]);
 }finally{
  h.close();
 }
});

test('slot-holding states block ready_to_dispatch while VERIFIED, RELEASED, pre-dispatch CANCELLED, and FAILED free the slot',()=>{
 const h=createReadinessFixture();
 try{
  const heartbeat=h.makeValidHeartbeat();
  const target=h.makeValidTarget();
  const sampleRecord=(state,outcome=null)=>({
   state,
   outcome,
   job:{
    task_id:'11111111-1111-4111-8111-111111111111',
    attempt_id:'22222222-2222-4222-8222-222222222222',
    created_at:new Date(h.now()).toISOString()
   }
  });

  for(const [state,outcome] of [
   ['PENDING',null],
   ['CLAIMED',null],
   ['DISPATCHED',null],
   ['RESULT_READY',null],
   ['DISPATCHED','UNCERTAIN_DELIVERY'],
   ['DISPATCHED','CANCELLED'],
   ['RESULT_READY','CANCELLED']
  ]){
   const rec=sampleRecord(state,outcome);
   assert.equal(isWorkspaceSlotHeld(rec),true,`Expected held for ${state}/${outcome}`);
   const res=evaluateBridgeReadiness({
    workspaceRoot:h.workspace,
    projectId:h.config.slug,
    heartbeat,
    target,
    records:[rec],
    now:h.now
   });
   assert.equal(res.slot_available,false);
   assert.equal(res.ready_to_dispatch,false);
   assert.equal(res.active_task.task_id,rec.job.task_id);
   assert.deepEqual(res.reason_codes,[READINESS_REASONS.WORKSPACE_SLOT_HELD]);
  }

  for(const [state,outcome] of [
   ['VERIFIED',null],
   ['PENDING','RELEASED'],
   ['DISPATCHED','RELEASED'],
   ['PENDING','CANCELLED'],
   ['CLAIMED','CANCELLED'],
   ['CLAIMED','FAILED'],
   ['DISPATCHED','FAILED']
  ]){
   const rec=sampleRecord(state,outcome);
   assert.equal(isWorkspaceSlotHeld(rec),false,`Expected free for ${state}/${outcome}`);
   const res=evaluateBridgeReadiness({
    workspaceRoot:h.workspace,
    projectId:h.config.slug,
    heartbeat,
    target,
    records:[rec],
    now:h.now
   });
   assert.equal(res.slot_available,true);
   assert.equal(res.ready_to_dispatch,true);
   assert.equal(res.active_task,null);
   assert.deepEqual(res.reason_codes,[]);
  }
 }finally{
  h.close();
 }
});

test('MCP handler allows queued submit_job when not ready while slot is free, never creates new conversation, and transitions cleanly',async()=>{
 const h=createReadinessFixture();
 try{
  // Write a stale target and leave heartbeat missing
  writeActiveTarget(h.workspace,{
   conversationId:'conv-stale-77',
   stateDirectory:h.stateDirectory,
   now:()=>h.now()-TARGET_OBSERVATION_TTL_MS-5000
  });

  const initialStatus=await h.callTool('bridge_status',{});
  assert.equal(initialStatus.ready_to_dispatch,false);
  assert.equal(initialStatus.readiness_status,'NOT_READY');
  assert.equal(initialStatus.slot_available,true);
  assert.equal(initialStatus.target_observation.proves_gui_focus,false);
  assert.equal(initialStatus.target_observation.fresh,false);
  assert.deepEqual(initialStatus.reason_codes,[
   READINESS_REASONS.HEARTBEAT_MISSING,
   READINESS_REASONS.TARGET_STALE
  ]);

  // submit_job MUST still succeed in queuing PENDING without creating any conversation
  const queued=await h.callTool('submit_job',{
   request:'Queue read-only README check before GUI/Sidecar ready',
   read_scope:['README.md'],
   write_scope:[],
   acceptance_criteria:['Queued safely as PENDING']
  });
  assert.equal(queued.state,'PENDING');
  assert.equal(queued.delivery,null);
  assert.equal(queued.target_conversation_id,null);
  assert.equal(queued.ready_to_dispatch,false);
  assert.deepEqual(queued.reason_codes,[
   READINESS_REASONS.HEARTBEAT_MISSING,
   READINESS_REASONS.TARGET_STALE
  ]);
  assert.equal(existsSync(queued.brief_md_path),true);

  // Subsequent bridge_status reflects held slot alongside underlying readiness issues
  const heldStatus=await h.callTool('bridge_status',{});
  assert.equal(heldStatus.slot_available,false);
  assert.equal(heldStatus.ready_to_dispatch,false);
  assert.equal(heldStatus.active_task.task_id,queued.task_id);
  assert.equal(heldStatus.active_task.state,'PENDING');
  assert.deepEqual(heldStatus.reason_codes,[
   READINESS_REASONS.HEARTBEAT_MISSING,
   READINESS_REASONS.TARGET_STALE,
   READINESS_REASONS.WORKSPACE_SLOT_HELD
  ]);

  // Release the queued task, refresh target + valid heartbeat with transport & LS address
  await h.callTool('release_job',{task_id:queued.task_id,reason:'Test cleanup before ready transition'});
  writeActiveTarget(h.workspace,{
   conversationId:'conv-fresh-88',
   stateDirectory:h.stateDirectory,
   now:h.now
  });
  writeSidecarHeartbeat('RUNNING',{
   stateDirectory:h.stateDirectory,
   now:h.now,
   extra:{
    code_version:'2.5.1',
    agentapi_available:true,
    ls_address_present:true
   }
  });

  const readyStatus=await h.callTool('bridge_status',{});
  assert.equal(readyStatus.ready_to_dispatch,true);
  assert.equal(readyStatus.readiness_status,'READY_TO_DISPATCH');
  assert.deepEqual(readyStatus.reason_codes,[]);
  assert.equal(readyStatus.slot_available,true);
  assert.equal(readyStatus.sidecar_running,true);
  assert.equal(readyStatus.sidecar_agentapi_available,true);
  assert.equal(readyStatus.sidecar_ls_address_present,true);
  assert.equal(readyStatus.active_gui_target.conversation_id,'conv-fresh-88');
  assert.equal(readyStatus.target_observation.proves_gui_focus,false);

  // Verify pre-spawn FAILED record in real Inbox does not hold slot in bridge_status
  const submitted2=await h.callTool('submit_job',{
   request:'Simulate pre-spawn ENOENT failure freeing slot',
   read_scope:['README.md'],
   acceptance_criteria:['Slot released on pre-spawn FAILED']
  });
  assert.equal(submitted2.ready_to_dispatch,true);
  assert.equal(submitted2.target_conversation_id,'conv-fresh-88');
  const {inbox}=openLiveInbox(h.workspace,{stateDirectory:h.stateDirectory,now:h.now});
  const claimed=inbox.claim(submitted2.task_id);
  inbox.beginDispatch(submitted2.task_id,claimed.claim_id);
  inbox.recordDelivery(submitted2.task_id,claimed.claim_id,{started:false,spawn_error:'ENOENT'});
  inbox.fail(submitted2.task_id,claimed.claim_id,'agentapi ENOENT');

  const afterPreSpawnFail=await h.callTool('bridge_status',{});
  assert.equal(afterPreSpawnFail.slot_available,true);
  assert.equal(afterPreSpawnFail.ready_to_dispatch,true);
  assert.deepEqual(afterPreSpawnFail.reason_codes,[]);
 }finally{
  h.close();
 }
});
