import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT,inside,sha256} from '../../src/core/util.mjs';
import {captureWorkspace} from '../../src/desktop-inbox/verification.mjs';
import {captureWorkspaceFast,getSnapshotCacheStats,invalidateWorkspaceCache} from '../../src/desktop-inbox/fast-snapshot.mjs';
import {openLiveInbox,registerLocalWorkspace,writeActiveTarget} from '../../src/desktop-inbox/live-bridge.mjs';
import {bridgeDoctor,bridgeMetrics,releaseStuckJobs} from '../../src/desktop-inbox/bridge-cli.mjs';
import {createLiveToolHandler,LIVE_MCP_TOOLS} from '../../src/desktop-inbox/live-mcp-server.mjs';
import {TARGET_OBSERVATION_TTL_MS} from '../../src/desktop-inbox/readiness.mjs';
import {defaultInvokeAgentapi,inspectAgentapiEnv,resolveAgentapiCommand,runLiveSidecarTick} from '../../src/desktop-inbox/live-sidecar.mjs';
import {submitWorkerReport} from '../../src/desktop-inbox/report-cli.mjs';
import {onboardWorkspace} from '../../scripts/onboard-desktop-bridge.mjs';

function createFixture(){
 const rel=`state/test-live-bridge-${randomUUID()}`;
 const dir=resolve(ROOT,rel);
 const stateDirectory=`${rel}/live-state`;
 const workspace=resolve(dir,'project');
 mkdirSync(resolve(workspace,'src'),{recursive:true});
 writeFileSync(resolve(workspace,'README.md'),'# Sample Target Repo\nReady for Codex Boss orchestration.\n');
 writeFileSync(resolve(workspace,'src/feature.mjs'),'export const version = 1;\n');
 // Ensure real-world gitignored files (.env, dist/) never crash workspace snapshots or leak into hashes
 writeFileSync(resolve(workspace,'.env'),'LOCAL_DEV_ONLY=1\n');
 mkdirSync(resolve(workspace,'dist'),{recursive:true});
 writeFileSync(resolve(workspace,'dist/bundle.js'),'console.log("built");\n');

 onboardWorkspace(workspace,{stateDirectory});
 const callTool=createLiveToolHandler({defaultWorkspaceRoot:workspace,stateDirectory});
 return {
  rel,
  dir,
  stateDirectory,
  workspace,
  callTool,
  close(){
   const stateRoot=resolve(ROOT,'state');
   assert.ok(inside(stateRoot,dir)&&dir!==stateRoot);
   rmSync(dir,{recursive:true,force:true});
  }
 };
}

function runNodeScript(scriptRelPath,args,{input='',cwd=ROOT}={}){
 return new Promise((accept,reject)=>{
  const child=spawn(process.execPath,[resolve(ROOT,scriptRelPath),...args],{cwd,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk.toString('utf8');});
  child.stderr.on('data',chunk=>{stderr+=chunk.toString('utf8');});
  child.on('error',reject);
  child.on('close',code=>code===0?accept({stdout,stderr}):reject(Error(`Exit ${code}: ${stderr||stdout}`)));
  if(input)child.stdin.end(input);else child.stdin.end();
 });
}

test('onboarding, hook beacon, write-scoped submit_job, single-line sidecar dispatch, report-cli, event-driven wait_job and verify_job work end-to-end',async()=>{
 const h=createFixture();
 try{
  // 1. Verify onboarded workspace passes strict snapshot rules and skips .env & dist/
  const snap=captureWorkspace(h.workspace);
  assert.ok(Object.hasOwn(snap.entries,'.codex/config.toml'));
  assert.ok(Object.hasOwn(snap.entries,'.agents/hooks.json'));
  assert.ok(Object.hasOwn(snap.entries,'.agents/skills/codex-worker/SKILL.md'));
  assert.equal(Object.hasOwn(snap.entries,'.env'),false);
  assert.equal(Object.hasOwn(snap.entries,'dist/bundle.js'),false);

  // 2. Simulate Antigravity Desktop GUI firing SessionStart hook via stdin
  const hookPayload=JSON.stringify({
   conversationId:'gui-session-live-42',
   workspacePaths:[h.workspace],
   modelName:'gemini-2.5-pro'
  });
  const hookOut=await runNodeScript('src/desktop-inbox/hook-beacon.mjs',['SessionStart','--state',h.stateDirectory],{input:hookPayload});
  assert.equal(hookOut.stdout.trim(),'{}');

  // 3. Codex Boss checks bridge_status before Sidecar has emitted a heartbeat:
  // slot is free so submit_job can queue, but ready_to_dispatch is truthfully false (HEARTBEAT_MISSING)
  const statusBefore=await h.callTool('bridge_status',{});
  assert.equal(statusBefore.active_gui_target.conversation_id,'gui-session-live-42');
  assert.equal(statusBefore.slot_available,true);
  assert.equal(statusBefore.ready_to_dispatch,false);
  assert.ok(statusBefore.reason_codes.includes('HEARTBEAT_MISSING'));
  assert.equal(statusBefore.target_observation.proves_gui_focus,false);
  assert.ok(statusBefore.available_checks.includes('noop'));

  // 4. Codex Boss submits a multi-line WRITE-SCOPED job (queued cleanly even before Sidecar is ready)
  const multiLineGoal='Update src/feature.mjs:\n1. Export version = 2\n2. Add greet(name) helper returning `Hello, ${name}`';
  const submitted=await h.callTool('submit_job',{
   request:multiLineGoal,
   read_scope:['README.md','src/feature.mjs'],
   write_scope:['src/feature.mjs'],
   acceptance_criteria:['version equals 2','greet("Codex") returns "Hello, Codex"'],
   verification_commands:['noop']
  });
  assert.equal(submitted.state,'PENDING');
  assert.equal(submitted.target_conversation_id,'gui-session-live-42');
  assert.equal(/[\r\n]/.test(submitted.single_line_trigger),false);
  assert.equal(existsSync(submitted.brief_md_path),true);
  assert.equal(existsSync(submitted.brief_json_path),true);

  // 5. Sidecar tick dispatches single-line prompt via agentapi send-message <conversationId> <trigger>
  const agentCalls=[];
  const healthySidecarEnv={
   ...process.env,
   ANTIGRAVITY_AGENTAPI_EXE:process.execPath,
   ANTIGRAVITY_LS_ADDRESS:'127.0.0.1:55555'
  };
  const sidecarTick=await runLiveSidecarTick({
   stateDirectory:h.stateDirectory,
   env:healthySidecarEnv,
   invokeAgentapi:async argv=>{
    agentCalls.push(argv);
    return {started:true,spawn_error:null,exit_code:0,exit_signal:null,timed_out:false,output_overflow:false,stdout_sha256:sha256('ok'),stderr_sha256:sha256(''),stdout_bytes:2,stderr_bytes:0};
   }
  });
  assert.equal(agentCalls.length,1);
  assert.equal(agentCalls[0][0],'send-message');
  assert.equal(agentCalls[0][1],'gui-session-live-42');
  assert.equal(/[\r\n]/.test(agentCalls[0][2]),false);
  assert.equal(sidecarTick.actions[0].action,'DISPATCHED');

  // 6. Codex Boss waits asynchronously via wait_job while Antigravity Worker edits file and runs report-cli.mjs
  const startedWait=Date.now();
  const waitPromise=h.callTool('wait_job',{task_id:submitted.task_id,timeout_sec:10});
  setTimeout(()=>{
   writeFileSync(resolve(h.workspace,'src/feature.mjs'),'export const version = 2;\nexport const greet = name => `Hello, ${name}`;\n');
   submitWorkerReport({
    briefPath:submitted.brief_json_path,
    status:'reported',
    summary:'Updated version to 2 and added greet(name) helper.',
    inspected:['README.md','src/feature.mjs'],
    tests:['node -e "import(\'./src/feature.mjs\')"::0::ok'],
    stateDirectory:h.stateDirectory
   });
  },50);

  const waited=await waitPromise;
  assert.equal(waited.timed_out,false);
  assert.ok(Date.now()-startedWait<3000,'wait_job should wake immediately on filesystem event');
  assert.equal(waited.state,'RESULT_READY');
  assert.deepEqual(waited.worker_report.changed_files,['src/feature.mjs']);
  assert.equal(waited.worker_report.errors.length,0);
  assert.ok(waited.worker_report.evidence.some(item=>item.includes('src/feature.mjs')));

  // 7. Codex Boss independently verifies and closes the job
  const verified=await h.callTool('verify_job',{
   task_id:submitted.task_id,
   accepted:true,
   review_notes:['Diff matches write_scope and acceptance criteria.']
  });
  assert.equal(verified.verified,true);
  assert.equal(verified.state,'VERIFIED');
  assert.equal(verified.host_receipt.accepted,true);
  assert.deepEqual(verified.host_receipt.actual_changed_files,['src/feature.mjs']);

  // 8. Workspace slot is free again after VERIFIED
  const statusAfter=await h.callTool('bridge_status',{});
  assert.equal(statusAfter.active_task,null);
  assert.equal(statusAfter.ready_to_dispatch,true);
 }finally{
  h.close();
 }
});

test('uncertain delivery, rejected verification and out-of-scope edits are handled safely with release_job rework',async()=>{
 const h=createFixture();
 try{
  await runNodeScript('src/desktop-inbox/hook-beacon.mjs',['SessionStart','--seed-workspace',h.workspace,'--conversation','gui-rework-conv','--state',h.stateDirectory]);

  // Unknown check ID rejected before queuing
  await assert.rejects(
   h.callTool('submit_job',{
    request:'Check unknown command rejection',
    read_scope:['README.md'],
    acceptance_criteria:['Rejected cleanly'],
    verification_commands:['nonexistent-check']
   }),
   /Unknown verification check/
  );

  // Uncertain delivery holds slot until Codex Boss explicitly calls release_job
  const first=await h.callTool('submit_job',{
   request:'Inspect README',
   read_scope:['README.md'],
   acceptance_criteria:['Read README']
  });
  await runLiveSidecarTick({
   stateDirectory:h.stateDirectory,
   invokeAgentapi:async()=>({started:true,spawn_error:null,exit_code:1,exit_signal:null,timed_out:false,output_overflow:false,stdout_sha256:sha256(''),stderr_sha256:sha256('err'),stdout_bytes:0,stderr_bytes:3})
  });
  const uncertainStatus=await h.callTool('get_job_status',{task_id:first.task_id});
  assert.equal(uncertainStatus.outcome,'UNCERTAIN_DELIVERY');
  await assert.rejects(
   h.callTool('submit_job',{request:'Parallel blocked',read_scope:['README.md'],acceptance_criteria:['Blocked']}),
   /active or uncertain/
  );

  const released=await h.callTool('release_job',{task_id:first.task_id,reason:'Confirmed GUI idle; releasing uncertain task'});
  assert.equal(released.outcome,'RELEASED');

  // Submit reworkable job, reject via verify_job(accepted=false), and submit follow-up
  const second=await h.callTool('submit_job',{
   request:'Read-only check',
   read_scope:['README.md'],
   write_scope:[],
   acceptance_criteria:['No edits allowed']
  });
  await runLiveSidecarTick({
   stateDirectory:h.stateDirectory,
   invokeAgentapi:async()=>({started:true,spawn_error:null,exit_code:0,exit_signal:null,timed_out:false,output_overflow:false,stdout_sha256:sha256(''),stderr_sha256:sha256(''),stdout_bytes:0,stderr_bytes:0})
  });

  // Out-of-scope write rejected by report-cli
  writeFileSync(resolve(h.workspace,'src/feature.mjs'),'export const unauthorized = true;\n');
  assert.throws(()=>submitWorkerReport({
   briefPath:second.brief_json_path,
   status:'reported',
   summary:'Edited out of scope',
   stateDirectory:h.stateDirectory
  }),/Out-of-scope write/);
  // Restore clean file and submit valid report
  writeFileSync(resolve(h.workspace,'src/feature.mjs'),'export const version = 1;\n');
  submitWorkerReport({
   briefPath:second.brief_json_path,
   status:'reported',
   summary:'Read README cleanly',
   stateDirectory:h.stateDirectory
  });

  // Reject for rework via verify_job(accepted=false) -> auto-releases slot!
  const rejected=await h.callTool('verify_job',{task_id:second.task_id,accepted:false,review_notes:['Add deeper section breakdown']});
  assert.equal(rejected.verified,false);
  assert.equal(rejected.released,true);
  assert.equal(rejected.outcome,'RELEASED');

  const third=await h.callTool('submit_job',{
   request:'Follow-up rework task',
   read_scope:['README.md'],
   acceptance_criteria:['Includes deeper section breakdown']
  });
  assert.equal(third.state,'PENDING');
 }finally{
  h.close();
 }
});

test('live-mcp-server stdio protocol exposes all 7 Boss tools cleanly',async()=>{
 const h=createFixture();
 try{
  const requests=[
   {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'codex-boss',version:'1.0'}}},
   {jsonrpc:'2.0',method:'notifications/initialized'},
   {jsonrpc:'2.0',id:2,method:'tools/list'},
   {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'bridge_status',arguments:{}}}
  ];
  const payload=requests.map(r=>JSON.stringify(r)).join('\n')+'\n';
  const out=await runNodeScript('src/desktop-inbox/live-mcp-server.mjs',['--workspace',h.workspace,'--state',h.stateDirectory],{input:payload});
  const lines=out.stdout.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(lines[0].result.protocolVersion,'2025-11-25');
  assert.deepEqual(lines[1].result.tools.map(t=>t.name),LIVE_MCP_TOOLS.map(t=>t.name));
  assert.equal(lines[1].result.tools.length,7);
  assert.equal(lines[2].result.isError,false);
  assert.equal(lines[2].result.structuredContent.workspace_root,h.workspace);
 }finally{
  h.close();
 }
});

test('wave-parallel subtasks enforce disjoint write scopes, survive sidecar dispatch, and pre-flight --run-checks prevents premature rework',async()=>{
 const h=createFixture();
 try{
  writeFileSync(resolve(h.workspace,'src/moduleA.mjs'),'export const a = 1;\n');
  writeFileSync(resolve(h.workspace,'src/moduleB.mjs'),'export const b = 1;\n');

  // Register a real verification check requiring both moduleA.a === 2 and moduleB.b === 2
  registerLocalWorkspace(h.workspace,{
   stateDirectory:h.stateDirectory,
   checks:{
    'verify-ab':{
     args:['-e',"Promise.all([import('./src/moduleA.mjs'),import('./src/moduleB.mjs')]).then(([mA,mB])=>{if(mA.a!==2||mB.b!==2)process.exit(1);console.log('ab-ok');})"],
     inputs:['src/moduleA.mjs','src/moduleB.mjs'],
     timeout_ms:3000
    }
   }
  });
  await runNodeScript('src/desktop-inbox/hook-beacon.mjs',['SessionStart','--seed-workspace',h.workspace,'--conversation','gui-swarm-conv','--state',h.stateDirectory]);

  // 1. Overlapping write_scope in the SAME wave is mathematically rejected before queuing
  await assert.rejects(
   h.callTool('submit_job',{
    request:'Overlapping wave test',
    read_scope:['README.md'],
    write_scope:['src/moduleA.mjs','src/moduleB.mjs'],
    subtasks:[
     {id:'w1-a',title:'Worker A',wave:1,write_scope:['src/moduleA.mjs'],goal:'Edit moduleA'},
     {id:'w1-conflict',title:'Worker Conflict',wave:1,write_scope:['src/moduleA.mjs'],goal:'Also edit moduleA'}
    ],
    acceptance_criteria:['Rejected before submit']
   }),
   /Overlapping subtask write_scope in wave 1/
  );

  // 2. Read-only research subtask attempting to declare write_scope is rejected
  await assert.rejects(
   h.callTool('submit_job',{
    request:'Invalid research write scope',
    read_scope:['README.md'],
    write_scope:['src/moduleA.mjs'],
    subtasks:[
     {id:'res-bad',title:'Bad Research',agent_type:'research',wave:1,write_scope:['src/moduleA.mjs'],goal:'Should fail'}
    ],
    acceptance_criteria:['Rejected']
   }),
   /Read-only subtask agent_type cannot declare write_scope/
  );

  // 3. Valid multi-wave Swarm job succeeds and renders parallel wave matrix in brief.md
  const submitted=await h.callTool('submit_job',{
   request:'Upgrade moduleA and moduleB in parallel Wave 1, then review in Wave 2.',
   read_scope:['README.md','src/moduleA.mjs','src/moduleB.mjs'],
   write_scope:['src/moduleA.mjs','src/moduleB.mjs'],
   subtasks:[
    {id:'scan-readme',title:'Scan Architecture',agent_type:'research',wave:1,read_scope:['README.md'],goal:'Confirm module conventions'},
    {id:'impl-a',title:'Implement Module A',agent_type:'implementer',wave:1,read_scope:['src/moduleA.mjs'],write_scope:['src/moduleA.mjs'],goal:'Set a = 2'},
    {id:'impl-b',title:'Implement Module B',agent_type:'implementer',wave:1,read_scope:['src/moduleB.mjs'],write_scope:['src/moduleB.mjs'],goal:'Set b = 2'},
    {id:'review-ab',title:'Cross-check A & B',agent_type:'reviewer',wave:2,read_scope:['src/moduleA.mjs','src/moduleB.mjs'],goal:'Verify exports match'}
   ],
   acceptance_criteria:['moduleA exports a = 2','moduleB exports b = 2'],
   verification_commands:['verify-ab']
  });
  assert.equal(submitted.subtask_plan.total_subtasks,4);
  assert.equal(submitted.subtask_plan.max_parallelism,3);
  assert.match(submitted.single_line_trigger,/SWARM 4x\/W2/);

  const agentCalls=[];
  await runLiveSidecarTick({
   stateDirectory:h.stateDirectory,
   invokeAgentapi:async argv=>{
    agentCalls.push(argv);
    return {started:true,spawn_error:null,exit_code:0,exit_signal:null,timed_out:false,output_overflow:false,stdout_sha256:sha256('ok'),stderr_sha256:sha256(''),stdout_bytes:2,stderr_bytes:0};
   }
  });
  assert.match(agentCalls[0][2],/SWARM 4x\/W2/);
  const briefMarkdown=readFileSync(submitted.brief_md_path,'utf8');
  assert.match(briefMarkdown,/Wave 1/);
  assert.match(briefMarkdown,/Wave 2/);
  assert.match(briefMarkdown,/--run-checks/);

  // 4. Worker edits ONLY moduleA (forgetting moduleB) and runs report-cli.mjs --run-checks -> fails fast locally WITHOUT waking Codex Boss!
  writeFileSync(resolve(h.workspace,'src/moduleA.mjs'),'export const a = 2;\n');
  await assert.rejects(
   runNodeScript('src/desktop-inbox/report-cli.mjs',[
    '--brief',submitted.brief_json_path,
    '--run-checks',
    '--status','reported',
    '--summary','Partial edit',
    '--state',h.stateDirectory
   ]),
   /Pre-report verification checks failed/
  );
  const stillDispatched=await h.callTool('get_job_status',{task_id:submitted.task_id});
  assert.equal(stillDispatched.state,'DISPATCHED');

  // 5. Worker fixes moduleB in the same turn and re-runs report-cli.mjs --run-checks -> passes and auto-records check receipt!
  writeFileSync(resolve(h.workspace,'src/moduleB.mjs'),'export const b = 2;\n');
  await runNodeScript('src/desktop-inbox/report-cli.mjs',[
   '--brief',submitted.brief_json_path,
   '--run-checks',
   '--status','reported',
   '--summary','Completed Wave 1 & Wave 2 upgrades cleanly.',
   '--state',h.stateDirectory
  ]);

  const result=await h.callTool('get_job_result',{task_id:submitted.task_id});
  assert.equal(result.state,'RESULT_READY');
  assert.ok(result.worker_report.tests.some(t=>t.command==='check:verify-ab'&&t.exit_code===0));

  const verified=await h.callTool('verify_job',{task_id:submitted.task_id,accepted:true,review_notes:['Swarm output verified cleanly']});
  assert.equal(verified.state,'VERIFIED');

  // 6. Fast snapshot cache & bridge-cli doctor/metrics/release-stuck checks
  invalidateWorkspaceCache(h.workspace);
  const cold=captureWorkspaceFast(h.workspace);
  assert.equal(cold.hash,captureWorkspace(h.workspace).hash);
  const statsBefore=getSnapshotCacheStats();
  // Backdate mtime slightly outside 50ms racy window or verify doctor/metrics
  const doctor=bridgeDoctor({workspaceRoot:h.workspace,stateDirectory:h.stateDirectory});
  assert.equal(doctor.status,'READY');
  assert.ok(statsBefore.entries>0);
  const metrics=bridgeMetrics({workspaceRoot:h.workspace,stateDirectory:h.stateDirectory});
  assert.equal(metrics.total_tasks,1);
  assert.equal(metrics.by_state.VERIFIED,1);
  assert.ok(metrics.total_turnaround_ms.count===1);

  // Queue a stuck job and clear via releaseStuckJobs
  const stuck=await h.callTool('submit_job',{request:'Stuck job',read_scope:['README.md'],acceptance_criteria:['Released']});
  const unstuck=releaseStuckJobs({workspaceRoot:h.workspace,stateDirectory:h.stateDirectory});
  assert.equal(unstuck.released_count,1);
  assert.equal(unstuck.released_tasks[0].task_id,stuck.task_id);
 }finally{
  h.close();
 }
});

test('ANTIGRAVITY_AGENTAPI_EXE sidecar transport resolves agentapi subcommand and cross-project projectId',async()=>{
 const h=createFixture();
 try{
  // 1. Unit-check resolveAgentapiCommand & inspectAgentapiEnv
  const fallbackCmd=resolveAgentapiCommand(['send-message','conv-1','hi'],{});
  assert.deepEqual(fallbackCmd,{executable:'agentapi',args:['send-message','conv-1','hi'],source:'PATH'});
  assert.equal(inspectAgentapiEnv({}).agentapi_available,false);

  const customCmd=resolveAgentapiCommand(['send-message','conv-1','hi'],{ANTIGRAVITY_AGENTAPI_EXE:process.execPath,ANTIGRAVITY_LS_ADDRESS:'127.0.0.1:55555'});
  assert.deepEqual(customCmd,{executable:process.execPath,args:['agentapi','send-message','conv-1','hi'],source:'ANTIGRAVITY_AGENTAPI_EXE'});
  const envInfo=inspectAgentapiEnv({ANTIGRAVITY_AGENTAPI_EXE:process.execPath,ANTIGRAVITY_LS_ADDRESS:'127.0.0.1:55555'});
  assert.equal(envInfo.agentapi_available,true);
  assert.equal(envInfo.ls_address_present,true);

  // 2. End-to-end defaultInvokeAgentapi inside runLiveSidecarTick using ANTIGRAVITY_AGENTAPI_EXE = process.execPath
  await runNodeScript('src/desktop-inbox/hook-beacon.mjs',['SessionStart','--seed-workspace',h.workspace,'--conversation','conv-exe-live','--state',h.stateDirectory]);
  const submitted=await h.callTool('submit_job',{
   request:'Verify ANTIGRAVITY_AGENTAPI_EXE real spawn path',
   read_scope:['README.md'],
   acceptance_criteria:['Dispatched cleanly via ANTIGRAVITY_AGENTAPI_EXE']
  });

  // Place extensionless JS script named `agentapi` inside inbox.root so `node.exe agentapi <subcmd>` runs with shell:false
  const {inbox}=openLiveInbox(h.workspace,{stateDirectory:h.stateDirectory});
  const fakeAgentapiScript=[
   'const sub=process.argv[2];',
   'if(sub==="get-conversation-metadata"){',
   ' process.stdout.write(JSON.stringify({response:{conversationMetadata:{metadata:{projectId:"app-proj-resolved-77"}}}}));',
   ' process.exit(0);',
   '}',
   'if(sub==="send-message"){',
   ' if(process.argv[3]!=="conv-exe-live"||process.env.ANTIGRAVITY_PROJECT_ID!=="app-proj-resolved-77")process.exit(42);',
   ' process.stdout.write("delivered-ok");',
   ' process.exit(0);',
   '}',
   'process.exit(99);'
  ].join('\n');
  writeFileSync(resolve(inbox.root,'agentapi'),fakeAgentapiScript);

  const sidecarEnv={
   ...process.env,
   ANTIGRAVITY_AGENTAPI_EXE:process.execPath,
   ANTIGRAVITY_LS_ADDRESS:'127.0.0.1:55555',
   ANTIGRAVITY_PROJECT_ID:'initial-other-proj'
  };
  const tick=await runLiveSidecarTick({
   stateDirectory:h.stateDirectory,
   invokeAgentapi:defaultInvokeAgentapi,
   env:sidecarEnv
  });
  assert.equal(tick.actions.length,1);
  assert.equal(tick.actions[0].action,'DISPATCHED');
  assert.equal(tick.heartbeat.agentapi_available,true);
  assert.equal(tick.heartbeat.code_version,'2.5.1');

  const jobStatus=await h.callTool('get_job_status',{task_id:submitted.task_id});
  assert.equal(jobStatus.state,'DISPATCHED');
  assert.equal(jobStatus.outcome,null);
  assert.equal(jobStatus.delivery.executable_source,'ANTIGRAVITY_AGENTAPI_EXE');
  assert.equal(jobStatus.delivery.exit_code,0);

  const bridgeStatus=await h.callTool('bridge_status',{});
  assert.equal(bridgeStatus.sidecar_running,true);
  assert.equal(bridgeStatus.sidecar_agentapi_available,true);
  assert.equal(bridgeStatus.sidecar_code_version,'2.5.1');
 }finally{
  h.close();
 }
});

test('CLI bridgeDoctor and MCP bridge_status share identical readiness verdicts and bridgeMetrics isolates verified phases from released failures',async()=>{
 const h=createFixture();
 try{
  let clockMs=Date.now()-2000;
  const now=()=>clockMs;
  const callClocked=createLiveToolHandler({defaultWorkspaceRoot:h.workspace,stateDirectory:h.stateDirectory,now});

  const assertParity=async()=>{
   const mcp=await callClocked('bridge_status',{});
   const cli=bridgeDoctor({workspaceRoot:h.workspace,stateDirectory:h.stateDirectory,now});
   assert.equal(cli.status,'READY');
   assert.equal(cli.ready_to_dispatch,mcp.ready_to_dispatch);
   assert.equal(cli.readiness_status,mcp.readiness_status);
   assert.deepEqual(cli.reason_codes,mcp.reason_codes);
   assert.equal(cli.slot_available,mcp.slot_available);
   assert.deepEqual(cli.active_task,mcp.active_task);
   assert.equal(cli.sidecar_running,mcp.sidecar_running);
   assert.equal(cli.sidecar_agentapi_available,mcp.sidecar_agentapi_available);
   assert.equal(cli.sidecar_ls_address_present,mcp.sidecar_ls_address_present);
   assert.deepEqual(cli.target_observation,mcp.target_observation);
   return {mcp,cli};
  };

  // 1. Before target or heartbeat: both report HEARTBEAT_MISSING + TARGET_MISSING while slot_available is true
  const s1=await assertParity();
  assert.equal(s1.mcp.ready_to_dispatch,false);
  assert.equal(s1.mcp.slot_available,true);
  assert.deepEqual(s1.mcp.reason_codes,['HEARTBEAT_MISSING','TARGET_MISSING']);

  // 2. Write bound target + run sidecar tick missing LS address -> LS_ADDRESS_MISSING
  writeActiveTarget(h.workspace,{conversationId:'conv-parity-1',stateDirectory:h.stateDirectory,now});
  await runLiveSidecarTick({
   stateDirectory:h.stateDirectory,
   now,
   env:{...process.env,ANTIGRAVITY_AGENTAPI_EXE:process.execPath,ANTIGRAVITY_LS_ADDRESS:''}
  });
  const s2=await assertParity();
  assert.equal(s2.mcp.ready_to_dispatch,false);
  assert.deepEqual(s2.mcp.reason_codes,['LS_ADDRESS_MISSING']);

  // 3. Healthy sidecar env -> READY_TO_DISPATCH on both CLI and MCP
  const healthyEnv={...process.env,ANTIGRAVITY_AGENTAPI_EXE:process.execPath,ANTIGRAVITY_LS_ADDRESS:'127.0.0.1:55555'};
  await runLiveSidecarTick({stateDirectory:h.stateDirectory,now,env:healthyEnv});
  const s3=await assertParity();
  assert.equal(s3.mcp.ready_to_dispatch,true);
  assert.equal(s3.mcp.readiness_status,'READY_TO_DISPATCH');
  assert.deepEqual(s3.mcp.reason_codes,[]);

  // 4. First job fails transport (UNCERTAIN_DELIVERY) -> holds slot -> released via verify_job(accepted=false)
  const failedJob=await callClocked('submit_job',{
   request:'Simulate transport error then release',
   read_scope:['README.md'],
   acceptance_criteria:['Released cleanly']
  });
  const sHeld=await assertParity();
  assert.equal(sHeld.mcp.slot_available,false);
  assert.equal(sHeld.mcp.ready_to_dispatch,false);
  assert.deepEqual(sHeld.mcp.reason_codes,['WORKSPACE_SLOT_HELD']);

  clockMs+=120;
  await runLiveSidecarTick({
   stateDirectory:h.stateDirectory,
   now,
   env:healthyEnv,
   invokeAgentapi:async()=>{
    clockMs+=40;
    return {started:true,spawn_error:null,exit_code:1,exit_signal:null,timed_out:false,output_overflow:false,stdout_sha256:sha256(''),stderr_sha256:sha256('e'),stdout_bytes:0,stderr_bytes:1};
   }
  });
  clockMs+=30;
  await callClocked('verify_job',{task_id:failedJob.task_id,accepted:false,review_notes:['Transport failed; releasing']});

  // 5. Second job succeeds end-to-end -> VERIFIED
  clockMs+=50;
  const okJob=await callClocked('submit_job',{
   request:'Complete clean read-only check',
   read_scope:['README.md'],
   acceptance_criteria:['Verified cleanly']
  });
  clockMs+=80;
  await runLiveSidecarTick({
   stateDirectory:h.stateDirectory,
   now,
   env:healthyEnv,
   invokeAgentapi:async()=>{
    clockMs+=25;
    return {started:true,spawn_error:null,exit_code:0,exit_signal:null,timed_out:false,output_overflow:false,stdout_sha256:sha256('ok'),stderr_sha256:sha256(''),stdout_bytes:2,stderr_bytes:0};
   }
  });
  submitWorkerReport({
   briefPath:okJob.brief_json_path,
   status:'reported',
   summary:'Inspected README cleanly.',
   inspected:['README.md'],
   stateDirectory:h.stateDirectory
  });
  clockMs=Date.now()+60;
  await callClocked('verify_job',{task_id:okJob.task_id,accepted:true,review_notes:['Clean']});

  // 6. Advance past TARGET_OBSERVATION_TTL_MS while refreshing heartbeat -> TARGET_STALE parity
  clockMs+=TARGET_OBSERVATION_TTL_MS+1000;
  await runLiveSidecarTick({stateDirectory:h.stateDirectory,now,env:healthyEnv});
  const sStale=await assertParity();
  assert.equal(sStale.mcp.ready_to_dispatch,false);
  assert.deepEqual(sStale.mcp.reason_codes,['TARGET_STALE']);

  // 7. Verify bridgeMetrics separates verified_phases from released task phases
  const metrics=bridgeMetrics({workspaceRoot:h.workspace,stateDirectory:h.stateDirectory});
  assert.equal(metrics.total_tasks,2);
  assert.equal(metrics.outcome_groups.released.count,1);
  assert.equal(metrics.outcome_groups.verified.count,1);
  assert.equal(metrics.verified_phases.total_ms.count,1);
  assert.equal(metrics.verified_phases.queue_to_claim_ms.median_ms,80);
  assert.equal(metrics.verified_phases.claim_to_dispatch_ms.median_ms,0);
  assert.equal(metrics.verified_phases.transport_return_ms.median_ms,25);
  assert.ok(metrics.verified_phases.dispatch_to_report_ms.median_ms>=0);
  assert.ok(metrics.verified_phases.report_to_verify_ms.median_ms>=60);
  const sumPhases=metrics.verified_phases.queue_to_claim_ms.median_ms
   +metrics.verified_phases.claim_to_dispatch_ms.median_ms
   +metrics.verified_phases.transport_return_ms.median_ms
   +metrics.verified_phases.dispatch_to_report_ms.median_ms
   +metrics.verified_phases.report_to_verify_ms.median_ms;
  assert.equal(metrics.verified_phases.total_ms.median_ms,sumPhases);
 }finally{
  h.close();
 }
});
