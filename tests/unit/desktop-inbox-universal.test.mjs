import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,rmSync,symlinkSync,utimesSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PassThrough} from 'node:stream';
import {ROOT,inside,sha256} from '../../src/core/util.mjs';
import {canonicalWorkspace,validateScopePath} from '../../src/desktop-inbox/contracts.mjs';
import {createLiveToolHandler,startLiveStdioServer} from '../../src/desktop-inbox/live-mcp-server.mjs';
import {resolveRequestWorkspace} from '../../src/desktop-inbox/workspace-context.mjs';
import {suggestProjectChecks} from '../../src/desktop-inbox/project-checks.mjs';
import {openLiveInbox,writeActiveTarget,activeTargetPath,workspaceStateRelative,listLiveWorkspaces} from '../../src/desktop-inbox/live-bridge.mjs';
import {processBeaconInput} from '../../src/desktop-inbox/hook-beacon.mjs';
import {runLiveSidecarTick,startLiveSidecar} from '../../src/desktop-inbox/live-sidecar.mjs';
import {inspectWorkspaceReadiness,TARGET_OBSERVATION_TTL_MS} from '../../src/desktop-inbox/readiness.mjs';
import {validateSubtaskPlan} from '../../src/desktop-inbox/subtask-planner.mjs';
import {captureWorkspace} from '../../src/desktop-inbox/verification.mjs';
import {captureWorkspaceFast} from '../../src/desktop-inbox/fast-snapshot.mjs';
import {submitWorkerReport} from '../../src/desktop-inbox/report-cli.mjs';
import {readSelectedReceiver} from '../../src/desktop-inbox/selected-receiver.mjs';

function fixture(){
 const relative=`state/test-universal-${randomUUID()}`,root=resolve(ROOT,relative),stateDirectory=`${relative}/live`;
 const a=resolve(root,'project A'),b=resolve(root,'project B');
 for(const directory of [a,b]){mkdirSync(directory,{recursive:true});writeFileSync(resolve(directory,'README.md'),'# Independent project\n');}
 return {root,a,b,stateDirectory,close(){assert.ok(inside(resolve(ROOT,'state'),root)&&root!==resolve(ROOT,'state'));rmSync(root,{recursive:true,force:true});}};
}
const submit=(workspace_root)=>({workspace_root,request:'Read README only',read_scope:['README.md'],write_scope:[],acceptance_criteria:['Accurate source finding'],verification_commands:['noop']});
const successfulTransport=()=>({started:true,exit_code:0,spawn_error:null,timed_out:false,output_overflow:false,stdout_sha256:sha256('ok'),stderr_sha256:sha256('')});

test('final review: mechanical and parent verification rehash same-size preserved-mtime external edits',async()=>{
 const f=fixture();try{
  const other=resolve(f.a,'other.txt');writeFileSync(other,'AAAA');utimesSync(other,1600000000,1600000000);
  const originalTime=statSync(other).mtime;
  const call=createLiveToolHandler({stateDirectory:f.stateDirectory});
  writeActiveTarget(f.a,{conversationId:'fresh-hash-chat',stateDirectory:f.stateDirectory});
  const job=await call('submit_job',submit(f.a));
  await runLiveSidecarTick({stateDirectory:f.stateDirectory,invokeAgentapi:async()=>successfulTransport()});
  submitWorkerReport({briefPath:job.brief_json_path,stateDirectory:f.stateDirectory,summary:'Read-only finding'});
  writeFileSync(other,'BBBB');utimesSync(other,originalTime,originalTime);
  const result=await call('get_job_result',{workspace_root:f.a,task_id:job.task_id,auto_verify:true});
  assert.equal(result.auto_verification.passed,false);
  assert.equal(result.state,'RESULT_READY');
  await assert.rejects(call('verify_job',{workspace_root:f.a,task_id:job.task_id,accepted:true,review_notes:['Reject external out-of-scope mutation']}),/Out-of-scope/);
 }finally{f.close();}
});

test('final review: report CLI rejects altered job or foreign output paths before writing',async()=>{
 const f=fixture();try{
  const call=createLiveToolHandler({stateDirectory:f.stateDirectory});
  const job=await call('submit_job',submit(f.a));
  const original=readFileSync(job.brief_json_path,'utf8');
  const foreign=resolve(f.b,'unexpected.md');
  for(const alter of [brief=>{brief.paths.result_path=foreign;},brief=>{brief.job.write_scope=['README.md'];}]){
   const brief=JSON.parse(original);alter(brief);writeFileSync(job.brief_json_path,JSON.stringify(brief));
   assert.throws(()=>submitWorkerReport({briefPath:job.brief_json_path,stateDirectory:f.stateDirectory,summary:'Invalid brief'}),/brief.*(binding|match|path)|immutable/i);
   assert.equal(existsSync(foreign),false);
  }
 }finally{f.close();}
});

test('final review: missing verified receipt cannot authorize a saved receiver',async()=>{
 const f=fixture();try{
  const call=createLiveToolHandler({stateDirectory:f.stateDirectory});await call('bridge_status',{workspace_root:f.a});
  writeFileSync(resolve(ROOT,f.stateDirectory,'selected-receiver.json'),JSON.stringify({format:'desktop-inbox.selected-receiver@1',enabled:true,conversation_id:'unproven-chat',selected_at:new Date().toISOString(),verified_task_id:randomUUID(),verified_attempt_id:randomUUID(),host_receipt_sha256:sha256('missing receipt'),proves_gui_focus:false}));
  assert.throws(()=>readSelectedReceiver({stateDirectory:f.stateDirectory}),/SELECTED_RECEIVER_INVALID/);
 }finally{f.close();}
});

test('final review: a corrupt inbox fails closed without starving an independent workspace',async()=>{
 const f=fixture();try{
  const call=createLiveToolHandler({stateDirectory:f.stateDirectory});
  writeActiveTarget(f.a,{conversationId:'receiver-a',stateDirectory:f.stateDirectory});writeActiveTarget(f.b,{conversationId:'receiver-b',stateDirectory:f.stateDirectory});
  const a=await call('submit_job',submit(f.a)),b=await call('submit_job',submit(f.b));
  const recordPath=resolve(a.task_directory,'record.json'),record=JSON.parse(readFileSync(recordPath,'utf8'));record.format='corrupt';writeFileSync(recordPath,JSON.stringify(record));
  let sends=0;const tick=await runLiveSidecarTick({stateDirectory:f.stateDirectory,invokeAgentapi:async()=>{sends++;return successfulTransport();}});
  assert.equal(sends,1);assert.ok(tick.actions.some(action=>action.action==='WORKSPACE_ERROR'));
  assert.equal(openLiveInbox(f.b,{stateDirectory:f.stateDirectory}).inbox.get(b.task_id).state,'DISPATCHED');
 }finally{f.close();}
});

test('idle sidecar does not wake itself by constructing and locking inboxes',async()=>{
 const f=fixture(),controller=new AbortController();let timer;
 try{
  openLiveInbox(f.a,{stateDirectory:f.stateDirectory});
  timer=setTimeout(()=>controller.abort(),700);
  const result=await startLiveSidecar({stateDirectory:f.stateDirectory,pollIntervalMs:5000,signal:controller.signal});
  assert.ok(result.ticks<=2,`Self-wakeup loop: ${result.ticks} ticks in a quiet 700ms window`);
 }finally{clearTimeout(timer);f.close();}
});

test('manifest-free Python projects are detected from bounded source evidence',()=>{
 const f=fixture();try{
  mkdirSync(resolve(f.a,'src/handler'),{recursive:true});writeFileSync(resolve(f.a,'src/handler/main.py'),'print("never execute detection")\n');
  const advice=suggestProjectChecks(f.a);assert.deepEqual(advice.frameworks,['Python']);
  assert.deepEqual(advice.suggested_checks[0].evidence,['src/handler/main.py']);assert.equal(advice.automatic_execution,false);
 }finally{f.close();}
});

test('ordinary assets above the old total limit are audited while the per-file limit remains enforced',()=>{
 const f=fixture();try{
  const asset=Buffer.alloc(9*1024*1024,7);
  writeFileSync(resolve(f.a,'first.bin'),asset);writeFileSync(resolve(f.a,'second.bin'),asset);
  const full=captureWorkspace(f.a),fast=captureWorkspaceFast(f.a,{verifyHashes:true});
  assert.equal(full.hash,fast.hash);assert.equal(Object.keys(full.entries).length,3);
  writeFileSync(resolve(f.a,'oversize.bin'),Buffer.alloc(16*1024*1024+1));
  assert.throws(()=>captureWorkspace(f.a),/oversize/i);
  assert.throws(()=>captureWorkspaceFast(f.a,{verifyHashes:true}),/oversize/i);
 }finally{f.close();}
});

test('one global handler isolates two non-onboarded projects, no root fallback or target project writes',async()=>{
 const f=fixture();try{
  const call=createLiveToolHandler({stateDirectory:f.stateDirectory});
  await assert.rejects(call('bridge_status',{}),/WORKSPACE_CONTEXT_REQUIRED/);
  const a=await call('bridge_status',{workspace_root:f.a});
  const b=await call('bridge_status',{workspace_root:f.b});
  assert.notEqual(a.project_id,b.project_id);
  assert.equal(a.workspace_context.source,'session_context_argument');
  assert.equal(a.workspace_context.host_attested,false);
  assert.deepEqual(readdirSync(f.a),['README.md']);assert.deepEqual(readdirSync(f.b),['README.md']);
  assert.equal(listLiveWorkspaces({stateDirectory:f.stateDirectory}).length,2);
  const jobA=await call('submit_job',submit(f.a)),jobB=await call('submit_job',submit(f.b));
  await assert.rejects(call('get_job_status',{workspace_root:f.b,task_id:jobA.task_id}),/not found|ENOENT/i);
  assert.equal((await call('get_job_status',{workspace_root:f.a,task_id:jobA.task_id})).task_id,jobA.task_id);
  assert.equal((await call('get_job_status',{workspace_root:f.b,task_id:jobB.task_id})).task_id,jobB.task_id);
  assert.deepEqual(readdirSync(f.a),['README.md']);
 }finally{f.close();}
});

test('trusted roots are resolved afresh; ambiguity and conflicting explicit roots fail closed',async()=>{
 const f=fixture();try{
  let selected=f.a;
  const context={getWorkspaceRoots:async()=>[{uri:pathToFileURL(selected).href}]};
  const call=createLiveToolHandler({stateDirectory:f.stateDirectory});
  assert.equal((await call('bridge_status',{},context)).workspace_root,canonicalWorkspace(f.a));
  selected=f.b;
  assert.equal((await call('bridge_status',{},context)).workspace_root,canonicalWorkspace(f.b));
  await assert.rejects(call('bridge_status',{workspace_root:f.a},context),/MISMATCH/);
  await assert.rejects(resolveRequestWorkspace({getWorkspaceRoots:async()=>[{uri:pathToFileURL(f.a).href},{uri:pathToFileURL(f.b).href}]}),/AMBIGUOUS/);
  await assert.rejects(resolveRequestWorkspace({getWorkspaceRoots:async()=>[]}),/CONTEXT_REQUIRED/);
 }finally{f.close();}
});

test('stdio negotiates roots and handles roots responses outside the awaiting tool queue',async()=>{
 const f=fixture();const input=new PassThrough(),output=new PassThrough();let server;
 try{
  const messages=[];let buffer='',selected=f.a;
  const result=new Promise((accept,reject)=>{
   const timer=setTimeout(()=>reject(Error('stdio roots test timed out')),4000);
   output.on('data',chunk=>{
    buffer+=chunk.toString();let at;
    while((at=buffer.indexOf('\n'))>=0){
     const message=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);messages.push(message);
     if(message.method==='roots/list')input.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{roots:[{uri:pathToFileURL(selected).href}]}})+'\n');
     if(message.id===2){assert.equal(message.result.structuredContent.workspace_root,canonicalWorkspace(f.a));selected=f.b;input.write(JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'bridge_status',arguments:{}}})+'\n');}
     if(message.id===3){clearTimeout(timer);accept(message);}
    }
   });
  });
  server=startLiveStdioServer({input,output,callTool:createLiveToolHandler({stateDirectory:f.stateDirectory})});
  for(const message of [{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{roots:{listChanged:true}},clientInfo:{name:'test',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'bridge_status',arguments:{}}}])input.write(JSON.stringify(message)+'\n');
  const last=await result;assert.equal(last.result.isError,false);assert.equal(last.result.structuredContent.workspace_root,canonicalWorkspace(f.b));
  assert.equal(messages.filter(message=>message.method==='roots/list').length,2);
 }finally{server?.close();f.close();}
});

test('global hook stores minimal per-conversation observations, ambiguity blocks all real dispatch',async()=>{
 const f=fixture();try{
  const now=()=>Date.parse('2026-11-06T01:00:00.000Z');
  const payload={conversationId:'one',workspacePaths:[f.a],timestamp:new Date(now()).toISOString(),lastUserInput:'NEVER PERSIST THIS',transcriptPath:'PRIVATE'};
  processBeaconInput(payload,{stateDirectory:f.stateDirectory,now});
  processBeaconInput({...payload,conversationId:'two'},{stateDirectory:f.stateDirectory,now});
  const observed=readFileSync(activeTargetPath(f.a,f.stateDirectory),'utf8');
  assert.ok(!observed.includes('NEVER PERSIST')&&!observed.includes('PRIVATE'));
  const status=inspectWorkspaceReadiness({workspaceRoot:f.a,stateDirectory:f.stateDirectory,now});
  assert.ok(status.reason_codes.includes('TARGET_AMBIGUOUS'));assert.equal(status.active_gui_target,null);
  const call=createLiveToolHandler({stateDirectory:f.stateDirectory,now});await call('submit_job',submit(f.a));
  let count=0;await runLiveSidecarTick({stateDirectory:f.stateDirectory,now,invokeAgentapi:async()=>{count++;return successfulTransport();}});
  assert.equal(count,0);
  const dir=resolve(ROOT,workspaceStateRelative(f.a,f.stateDirectory),'targets');
  for(const name of readdirSync(dir)){const record=JSON.parse(readFileSync(resolve(dir,name),'utf8'));assert.deepEqual(record.workspace_paths,[canonicalWorkspace(f.a)]);assert.ok(!('lastUserInput' in record));}
 }finally{f.close();}
});

for(const variant of ['stale','future','wrong-project','malformed'])test(`Sidecar never dispatches a ${variant} target rejected by shared readiness`,async()=>{
 const f=fixture();try{
  const now=()=>Date.parse('2026-11-06T01:00:00.000Z');
  writeActiveTarget(f.a,{conversationId:'target',stateDirectory:f.stateDirectory,now:variant==='stale'?()=>now()-TARGET_OBSERVATION_TTL_MS:variant==='future'?()=>now()+10000:now});
  const path=activeTargetPath(f.a,f.stateDirectory);
  if(variant==='wrong-project'){const record=JSON.parse(readFileSync(path,'utf8'));record.project_id='foreign';writeFileSync(path,JSON.stringify(record));}
  if(variant==='malformed')writeFileSync(path,'{bad');
  const call=createLiveToolHandler({stateDirectory:f.stateDirectory,now});const job=await call('submit_job',submit(f.a));
  let invocations=0;
  const tick=await runLiveSidecarTick({stateDirectory:f.stateDirectory,now,invokeAgentapi:async()=>{invocations++;return successfulTransport();}});
  assert.equal(invocations,0);assert.equal(tick.actions[0].action,'WAITING_FOR_GUI_SESSION');
  assert.equal((await call('get_job_status',{workspace_root:f.a,task_id:job.task_id})).state,'PENDING');
 }finally{f.close();}
});

test('global no-onboarding handoff reaches parent verification with noop explicitly NOT_RUN',async()=>{
 const f=fixture();try{
  const call=createLiveToolHandler({stateDirectory:f.stateDirectory});
  processBeaconInput({conversationId:'only',workspacePaths:[f.a]},{stateDirectory:f.stateDirectory});
  const job=await call('submit_job',submit(f.a));
  let invocations=0;await runLiveSidecarTick({stateDirectory:f.stateDirectory,invokeAgentapi:async()=>{invocations++;return successfulTransport();}});
  assert.equal(invocations,1);
  submitWorkerReport({briefPath:job.brief_json_path,summary:'README names Independent project',inspected:['README.md'],evidence:['README.md:1'],stateDirectory:f.stateDirectory});
  const verified=await call('verify_job',{workspace_root:f.a,task_id:job.task_id,accepted:true,review_notes:['Parent checked README first line']});
  assert.equal(verified.state,'VERIFIED');assert.equal(verified.functional_tests,'NOT_RUN');
  assert.deepEqual(verified.actual_changed_files,[]);assert.deepEqual(readdirSync(f.a),['README.md']);
 }finally{f.close();}
});

test('framework detection suggests reviewed checks without executing repository scripts',()=>{
 const f=fixture();try{
  writeFileSync(resolve(f.a,'package.json'),JSON.stringify({scripts:{test:'DO NOT EXECUTE'}}));
  for(const filename of ['tsconfig.json','pyproject.toml','pom.xml','build.gradle.kts','Example.sln'])writeFileSync(resolve(f.a,filename),'');
  const found=suggestProjectChecks(f.a);
  assert.equal(found.suggested_checks.length,5);assert.ok(found.suggested_checks.every(item=>item.execution==='NOT_RUN'&&item.requires_review));
  assert.equal(found.automatic_execution,false);assert.equal(found.functional_tests,'NOT_RUN');
  assert.deepEqual(suggestProjectChecks(f.b).frameworks,['Other / unknown']);
 }finally{f.close();}
});

test('a user-selected VERIFIED receiver accepts a different work root without inventing a matching Beacon',async()=>{
 const f=fixture();try{
  const call=createLiveToolHandler({stateDirectory:f.stateDirectory});
  processBeaconInput({conversationId:'chosen-existing-chat',workspacePaths:[f.a]},{stateDirectory:f.stateDirectory});
  const first=await call('submit_job',submit(f.a));
  await runLiveSidecarTick({stateDirectory:f.stateDirectory,env:{ANTIGRAVITY_AGENTAPI_EXE:process.execPath,ANTIGRAVITY_LS_ADDRESS:'local-test'},invokeAgentapi:async()=>successfulTransport()});
  submitWorkerReport({briefPath:first.brief_json_path,summary:'Independent project README checked',inspected:['README.md'],evidence:['README.md:1'],stateDirectory:f.stateDirectory});
  await call('verify_job',{workspace_root:f.a,task_id:first.task_id,accepted:true,select_receiver:true});
  const strict=await call('bridge_status',{workspace_root:f.b,use_selected_receiver:false});
  assert.ok(strict.reason_codes.includes('TARGET_MISSING'));
  const selected=await call('bridge_status',{workspace_root:f.b});
  assert.equal(selected.ready_to_dispatch,true);assert.equal(selected.delivery_target.mode,'user_selected_receiver');
  assert.equal(selected.delivery_target.proves_gui_focus,false);assert.equal(selected.active_gui_target,null);
  const second=await call('submit_job',submit(f.b)),calls=[];
  await runLiveSidecarTick({stateDirectory:f.stateDirectory,invokeAgentapi:async args=>{calls.push(args);return successfulTransport();}});
  assert.equal(calls.length,1);assert.equal(calls[0][1],'chosen-existing-chat');
  submitWorkerReport({briefPath:second.brief_json_path,summary:'Second workspace independently inspected',inspected:['README.md'],evidence:['README.md:1'],stateDirectory:f.stateDirectory});
  const verified=await call('verify_job',{workspace_root:f.b,task_id:second.task_id,accepted:true});
  assert.equal(verified.state,'VERIFIED');assert.deepEqual(verified.actual_changed_files,[]);
  assert.deepEqual(readdirSync(f.b),['README.md']);
 }finally{f.close();}
});

test('canonical local paths reject missing, relative, traversal, whitespace, files and junctions',()=>{
 const f=fixture();try{
  for(const root of ['relative',resolve(f.root,'absent'),f.a+' ',resolve(f.a,'README.md'),f.a+'/../project B'])assert.throws(()=>canonicalWorkspace(root));
  const alias=resolve(f.root,'alias');symlinkSync(f.a,alias,process.platform==='win32'?'junction':'dir');assert.throws(()=>canonicalWorkspace(alias));
  const child=resolve(f.a,'link');symlinkSync(f.b,child,process.platform==='win32'?'junction':'dir');assert.throws(()=>validateScopePath(f.a,'link/README.md'));
 }finally{f.close();}
});

test('normal private .codex entries are not traversed or exposed by either snapshot',()=>{
 const f=fixture();try{
  mkdirSync(resolve(f.a,'.codex/agents'),{recursive:true});writeFileSync(resolve(f.a,'.codex/agents/user.toml'),'private configuration');
  const full=captureWorkspace(f.a),fast=captureWorkspaceFast(f.a,{verifyHashes:true});
  assert.deepEqual(Object.keys(full.entries),['README.md']);assert.equal(full.hash,fast.hash);
 }finally{f.close();}
});

test('waves allow adaptive fanout (nine or more independent subtasks) while rejecting write/read conflicts and oversize payloads',async()=>{
 const f=fixture();try{
  const options={workspaceRoot:f.a,readScope:['README.md'],writeScope:['src']};
  const writer={id:'writer',title:'Writer',goal:'Write source',write_scope:['src/a.mjs']};
  const reader={id:'reader',title:'Reader',goal:'Read source',read_scope:['src']};
  for(const tasks of [[writer,reader],[reader,writer]])assert.throws(()=>validateSubtaskPlan(tasks,options),/Read\/write dependency/);
  assert.throws(()=>validateSubtaskPlan([writer,{...writer,id:'writer-2'}],options),/Overlapping subtask write_scope/);
  assert.equal(validateSubtaskPlan([writer,{...reader,wave:2}],options).max_parallelism,1);
  assert.equal(validateSubtaskPlan([writer,{...reader,read_scope:['src/b.mjs']}],options).max_parallelism,2);

  const nineIndependent=Array.from({length:9},(_,idx)=>({
   id:`sub-${idx+1}`,
   title:`Independent Subtask ${idx+1}`,
   goal:`Write module ${idx+1} cleanly`,
   wave:1,
   read_scope:['README.md'],
   write_scope:[`src/mod-${idx+1}.mjs`]
  }));
  const plan9=validateSubtaskPlan(nineIndependent,options);
  assert.equal(plan9.total_subtasks,9);
  assert.equal(plan9.max_parallelism,9);
  assert.equal(plan9.waves[0].subtasks.length,9);

  const call=createLiveToolHandler({stateDirectory:f.stateDirectory});
  const submitted9=await call('submit_job',{
   workspace_root:f.a,
   request:'Run nine independent same-wave subtasks',
   read_scope:['README.md'],
   write_scope:['src'],
   subtasks:nineIndependent,
   acceptance_criteria:['Nine subtasks accepted']
  });
  assert.equal(submitted9.subtask_plan.total_subtasks,9);
  assert.equal(submitted9.subtask_plan.max_parallelism,9);
  assert.match(submitted9.single_line_trigger,/SWARM 9x\/W1/);

  const oversizeSubtasks=Array.from({length:12},(_,idx)=>({
   id:`big-${idx+1}`,
   title:`Oversize Subtask ${idx+1}`,
   goal:'x'.repeat(500),
   wave:1,
   read_scope:['README.md']
  }));
  assert.throws(()=>validateSubtaskPlan(oversizeSubtasks,options),/Subtasks size limit exceeded/);
  await assert.rejects(call('submit_job',{
   workspace_root:f.a,
   request:'Oversize subtasks must reject in submit_job',
   read_scope:['README.md'],
   write_scope:['src'],
   subtasks:oversizeSubtasks,
   acceptance_criteria:['Rejected cleanly']
  }),/Subtasks size limit exceeded/);
  await assert.rejects(call('submit_job',{
   workspace_root:f.a,
   request:'x'.repeat(9000),
   read_scope:['README.md'],
   write_scope:['src'],
   acceptance_criteria:['Rejected cleanly']
  }),/Tool arguments size limit exceeded/);
  await assert.rejects(call('submit_job',{
   workspace_root:f.a,
   request:'Conflict in submit_job must reject',
   read_scope:['README.md'],
   write_scope:['src'],
   subtasks:[writer,reader],
   acceptance_criteria:['Rejected cleanly']
  }),/Read\/write dependency/);
 }finally{f.close();}
});

test('regression 1: auto_verify performs mechanical checks only and never auto-accepts broken or unreviewed source as VERIFIED',async()=>{
 const f=fixture();try{
  let t=Date.now()-15000;
  const now=()=>t;
  const call=createLiveToolHandler({stateDirectory:f.stateDirectory,now});
  processBeaconInput({conversationId:'chat-verify',workspacePaths:[f.a],timestamp:new Date(t).toISOString()},{stateDirectory:f.stateDirectory,now});
  writeFileSync(resolve(f.a,'helper.mjs'),'export function calcTotal(items) {\n return items.length;\n}\n');
  writeFileSync(resolve(f.a,'other.mjs'),'export const keep = true;\n');

  // Narrow scope inference: one-prompt request targeting calcTotal/helper.mjs scopes write_scope ONLY to helper.mjs (not README.md or other.mjs)
  const job1=await call('submit_job',{workspace_root:f.a,request:'Update calcTotal in helper.mjs to sum item values'});
  assert.deepEqual(job1.write_scope,['helper.mjs']);
  await runLiveSidecarTick({stateDirectory:f.stateDirectory,now,invokeAgentapi:async()=>successfulTransport()});

  // Worker writes syntactically broken source into helper.mjs
  writeFileSync(resolve(f.a,'helper.mjs'),'export function calcTotal(items) {\n return items.reduce(;\n}\n');
  submitWorkerReport({briefPath:job1.brief_json_path,summary:'Broken syntax edit',stateDirectory:f.stateDirectory,now});

  const resBroken=await call('get_job_result',{workspace_root:f.a,task_id:job1.task_id,auto_verify:true});
  assert.equal(resBroken.state,'RESULT_READY');
  assert.equal(resBroken.auto_verification.passed,false);
  assert.equal(resBroken.auto_verification.verified,false);
  assert.match(resBroken.auto_verification.error,/Syntax check failed/);

  const waitedBroken=await call('wait_job',{workspace_root:f.a,task_id:job1.task_id,auto_verify:true});
  assert.equal(waitedBroken.state,'RESULT_READY');
  assert.equal(waitedBroken.auto_verification.passed,false);
  await assert.rejects(call('verify_job',{workspace_root:f.a,task_id:job1.task_id,accepted:true}),/Syntax check failed/);

  // Reject broken job for rework, then test semantically wrong but syntactically valid source
  await call('verify_job',{workspace_root:f.a,task_id:job1.task_id,accepted:false,review_notes:['Fix syntax error']});
  writeFileSync(resolve(f.a,'helper.mjs'),'export function calcTotal(items) {\n return items.length;\n}\n');

  t+=1000;
  const job2=await call('submit_job',{workspace_root:f.a,request:'Update calcTotal in helper.mjs to sum numbers'});
  await runLiveSidecarTick({stateDirectory:f.stateDirectory,now,invokeAgentapi:async()=>successfulTransport()});
  writeFileSync(resolve(f.a,'helper.mjs'),'export function calcTotal() {\n return 0; // wrong logic\n}\n');
  submitWorkerReport({briefPath:job2.brief_json_path,summary:'Returned constant 0',stateDirectory:f.stateDirectory,now});

  // Even when mechanical checks pass, auto_verify=true MUST NOT transition state to VERIFIED before parent review
  const waitedMechanical=await call('wait_job',{workspace_root:f.a,auto_verify:true});
  assert.equal(waitedMechanical.task_id,job2.task_id);
  assert.equal(waitedMechanical.state,'RESULT_READY');
  assert.equal(waitedMechanical.auto_verification.passed,true);
  assert.equal(waitedMechanical.auto_verification.mechanical_only,true);
  assert.equal(waitedMechanical.auto_verification.verified,false);
  assert.equal(waitedMechanical.auto_verification.requires_parent_review,true);
  assert.deepEqual(waitedMechanical.auto_verification.actual_changed_files,['helper.mjs']);
 }finally{f.close();}
});

test('regression 2: uncertain delivery or running job is never auto-released or resent, while other workspaces run independently',async()=>{
 const f=fixture();try{
  let t=Date.now()-1000000;
  const now=()=>t;
  const call=createLiveToolHandler({stateDirectory:f.stateDirectory,now});
  processBeaconInput({conversationId:'chat-a',workspacePaths:[f.a],timestamp:new Date(t).toISOString()},{stateDirectory:f.stateDirectory,now});
  processBeaconInput({conversationId:'chat-b',workspacePaths:[f.b],timestamp:new Date(t).toISOString()},{stateDirectory:f.stateDirectory,now});

  const uncertainJob=await call('submit_job',{workspace_root:f.a,request:'Update README.md section'});
  let sendCalls=0;
  const tick1=await runLiveSidecarTick({
   stateDirectory:f.stateDirectory,
   now,
   invokeAgentapi:async()=>{
    sendCalls++;
    return {started:true,exit_code:null,spawn_error:null,timed_out:true,output_overflow:false,stdout_sha256:sha256(''),stderr_sha256:sha256('')};
   }
  });
  assert.equal(sendCalls,1,'Must not fallback-retry a timed-out send');
  assert.equal(tick1.actions[0].action,'UNCERTAIN_DELIVERY');

  // Advance clock > 10 minutes (MAX_JOB_AGE_MS): sidecar must NOT auto-release or resend uncertain delivery
  t+=700000;
  processBeaconInput({conversationId:'chat-a',workspacePaths:[f.a],timestamp:new Date(t).toISOString()},{stateDirectory:f.stateDirectory,now});
  await runLiveSidecarTick({
   stateDirectory:f.stateDirectory,
   now,
   invokeAgentapi:async()=>{sendCalls++;return successfulTransport();}
  });
  assert.equal(sendCalls,1,'Uncertain job must never be resent');
  const statusAfterTimeout=await call('get_job_status',{workspace_root:f.a,task_id:uncertainJob.task_id});
  assert.equal(statusAfterTimeout.outcome,'UNCERTAIN_DELIVERY');

  // New submit_job on workspace A (even with replace_active: true) must NOT release the uncertain job
  await assert.rejects(
   call('submit_job',{workspace_root:f.a,request:'Update README.md again',replace_active:true}),
   /active/
  );

  // Meanwhile workspace B operates independently
  const jobB=await call('submit_job',{workspace_root:f.b,request:'Read README.md in B',read_only:true});
  assert.equal(jobB.state,'PENDING');
 }finally{f.close();}
});

test('regression 3: worker reports bind strictly to workspace_root, task_id and attempt_id and never collide across projects',async()=>{
 const f=fixture();try{
  const call=createLiveToolHandler({stateDirectory:f.stateDirectory});
  const jobA=await call('submit_job',{workspace_root:f.a,request:'Update README.md in project A'});
  const jobB=await call('submit_job',{workspace_root:f.b,request:'Update README.md in project B'});

  // Unbound report without --brief, --workspace, or --task-id must reject instead of picking up global latest (project B)
  assert.throws(
   ()=>submitWorkerReport({summary:'Unbound report',stateDirectory:f.stateDirectory}),
   /Missing brief or workspace binding/
  );

  // Mismatched workspace or task_id with jobA's brief must reject
  assert.throws(
   ()=>submitWorkerReport({briefPath:jobA.brief_json_path,workspaceRoot:f.b,summary:'Wrong workspace',stateDirectory:f.stateDirectory}),
   /Workspace mismatch/
  );
  assert.throws(
   ()=>submitWorkerReport({briefPath:jobA.brief_json_path,taskId:jobB.task_id,summary:'Wrong task',stateDirectory:f.stateDirectory}),
   /Task ID mismatch/
  );

  // Reporting for project A via explicit briefPath updates only project A while project B stays PENDING
  writeFileSync(resolve(f.a,'README.md'),'# Independent project A updated\n');
  const repA=submitWorkerReport({
   briefPath:jobA.brief_json_path,
   workspaceRoot:f.a,
   taskId:jobA.task_id,
   attemptId:jobA.attempt_id,
   summary:'Updated project A README cleanly',
   stateDirectory:f.stateDirectory
  });
  assert.equal(repA.task_id,jobA.task_id);
  assert.equal(repA.inbox_state,'RESULT_READY');
  assert.equal((await call('get_job_status',{workspace_root:f.b,task_id:jobB.task_id})).state,'PENDING');
 }finally{f.close();}
});

test('regression 4: new hook beacon never overwrites a verified selected receiver and ambiguous strict targets hold the job',async()=>{
 const f=fixture();try{
  let t=Date.now()-20000;
  const now=()=>t;
  const call=createLiveToolHandler({stateDirectory:f.stateDirectory,now});

  // 1. Establish a parent-VERIFIED selected receiver on chat-verified
  processBeaconInput({conversationId:'chat-verified',workspacePaths:[f.a],timestamp:new Date(t).toISOString()},{stateDirectory:f.stateDirectory,now});
  const seedJob=await call('submit_job',submit(f.a));
  await runLiveSidecarTick({
   stateDirectory:f.stateDirectory,
   now,
   env:{ANTIGRAVITY_AGENTAPI_EXE:process.execPath,ANTIGRAVITY_LS_ADDRESS:'local-test'},
   invokeAgentapi:async()=>successfulTransport()
  });
  submitWorkerReport({briefPath:seedJob.brief_json_path,summary:'Seed verified receiver',inspected:['README.md'],evidence:['README.md:1'],stateDirectory:f.stateDirectory,now});
  await call('verify_job',{workspace_root:f.a,task_id:seedJob.task_id,accepted:true,select_receiver:true});
  assert.equal(readSelectedReceiver({stateDirectory:f.stateDirectory}).conversation_id,'chat-verified');

  // 2. A new hook fires on a different conversation (chat-intruder) with a newer timestamp
  t+=5000;
  processBeaconInput({conversationId:'chat-intruder',workspacePaths:[f.a],timestamp:new Date(t).toISOString()},{stateDirectory:f.stateDirectory,now});

  // Selected receiver MUST remain chat-verified (not overwritten or bypassed by the newer hook)
  assert.equal(readSelectedReceiver({stateDirectory:f.stateDirectory}).conversation_id,'chat-verified');
  const statusSelected=await call('bridge_status',{workspace_root:f.a});
  assert.equal(statusSelected.delivery_target.mode,'user_selected_receiver');
  assert.equal(statusSelected.delivery_target.conversation_id,'chat-verified');

  // 3. In strict mode (use_selected_receiver: false), the two fresh hooks on f.a flag TARGET_AMBIGUOUS and hold the job in PENDING
  const strictJob=await call('submit_job',{...submit(f.a),use_selected_receiver:false});
  assert.ok(strictJob.reason_codes.includes('TARGET_AMBIGUOUS'));
  assert.equal(strictJob.target_conversation_id,null);
  let strictCalls=0;
  const strictTick=await runLiveSidecarTick({
   stateDirectory:f.stateDirectory,
   now,
   invokeAgentapi:async()=>{strictCalls++;return successfulTransport();}
  });
  assert.equal(strictCalls,0,'Ambiguous target must hold job and never guess conversation');
  assert.equal(strictTick.actions.find(a=>a.task_id===strictJob.task_id).action,'WAITING_FOR_GUI_SESSION');
  assert.equal((await call('get_job_status',{workspace_root:f.a,task_id:strictJob.task_id})).state,'PENDING');
 }finally{f.close();}
});
