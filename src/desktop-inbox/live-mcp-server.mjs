import {randomUUID} from 'node:crypto';
import {existsSync,watch} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ROOT,scopedPath,sha256} from '../core/util.mjs';
import { validate } from '../core/schema.mjs';
import {changedFiles} from '../verification/checks.mjs';
import {UUID,MAX_JOB_BYTES,MAX_REPORT_BYTES,MAX_JOB_AGE_MS,boundedJSON,makeJob,validateReport} from './contracts.mjs';
import {readBoundedBytes,runMechanicalVerification,verifyJob} from './verification.mjs';
import {captureWorkspaceFast,getSnapshotCacheStats} from './fast-snapshot.mjs';
import {SUBTASK_AGENT_TYPES,validateSubtaskPlan} from './subtask-planner.mjs';
import {
 DEFAULT_LIVE_STATE,
 ensureWorkspaceRegistration,
 buildSingleLineTrigger,
 checkedStateDirectory,
 collectWorkerReport,
 findTaskAcrossWorkspaces,
 inferJobScopes,
 jobPaths,
 openLiveInbox,
 resolveLatestWorkspaceTask,
 writeJobBrief
} from './live-bridge.mjs';
import {inspectWorkspaceReadiness} from './readiness.mjs';
import {resolveRequestWorkspace} from './workspace-context.mjs';
import {assertAuditableScopes} from './workspace-files.mjs';
import {suggestProjectChecks} from './project-checks.mjs';
import {readSelectedReceiver,resolveEffectiveReceiver,selectVerifiedReceiver,selectedReadiness,bindSelectedReceiver} from './selected-receiver.mjs';

const text={type:'string',minLength:1};
const taskIdSchema={type:'string',pattern:UUID.source};
const pathList={type:'array',maxItems:32,uniqueItems:true,items:text};
const checkIdSchema={type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'};
const hashSchema={type:'string',pattern:'^[a-f0-9]{64}$'};
const reviewSchema={type:'object',additionalProperties:false,
 required:['task_id','attempt_id','workspace_root','report_sha256','diff_fingerprint','files_inspected','acceptance_assessment','notes','check_results'],
 properties:{task_id:taskIdSchema,attempt_id:taskIdSchema,workspace_root:text,report_sha256:hashSchema,diff_fingerprint:hashSchema,
  files_inspected:{type:'array',minItems:1,maxItems:128,uniqueItems:true,items:text},
  acceptance_assessment:{type:'array',minItems:1,maxItems:16,items:{type:'object',additionalProperties:false,required:['criterion','met','evidence'],properties:{criterion:text,met:{type:'boolean'},evidence:text}}},
  notes:{type:'array',minItems:1,maxItems:16,items:text},
  check_results:{type:'array',maxItems:16,items:{type:'object',additionalProperties:false,required:['check_id','passed','input_hash','spec_hash'],properties:{check_id:checkIdSchema,passed:{type:'boolean'},input_hash:hashSchema,spec_hash:hashSchema}}}}};

export const LIVE_MCP_TOOLS=[
 {
  name:'bridge_status',
  description:'Check Antigravity Desktop GUI active conversation beacon, sidecar heartbeat, registered verification checks, and whether the workspace slot is free.',
  inputSchema:{
   type:'object',
   additionalProperties:false,
   properties:{workspace_root:text,use_selected_receiver:{type:'boolean'}}
  },
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
 },
 {
  name:'submit_job',
  description:'Queue a task (with optional parallel wave subtasks) for Antigravity Desktop GUI. The live sidecar delivers a concise single-line trigger into the open GUI conversation and submits it automatically.',
  inputSchema:{
   type:'object',
   additionalProperties:false,
   required:['request'],
   properties:{
    task_id:taskIdSchema,
    attempt_id:taskIdSchema,
    workspace_root:text,
    use_selected_receiver:{type:'boolean'},
    replace_active:{type:'boolean'},
    read_only:{type:'boolean'},
    request:text,
    read_scope:{...pathList,minItems:1},
    write_scope:pathList,
    subtasks:{
     type:'array',
     minItems:1,
     items:{
      type:'object',
      additionalProperties:false,
      required:['id','title','goal'],
      properties:{
       id:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'},
       title:text,
       goal:text,
       wave:{type:'integer',minimum:1,maximum:8},
       agent_type:{type:'string',enum:SUBTASK_AGENT_TYPES},
       read_scope:pathList,
       write_scope:pathList
      }
     }
    },
    acceptance_criteria:{type:'array',minItems:1,maxItems:16,uniqueItems:true,items:text},
    verification_commands:{type:'array',minItems:1,maxItems:8,uniqueItems:true,items:checkIdSchema}
   }
  },
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}
 },
 {
  name:'wait_job',
  description:'Event-driven wait for RESULT_READY, failure/release or timeout. auto_verify=true runs fresh mechanical checks only; independent parent review and verify_job are still required.',
  inputSchema:{
   type:'object',
   additionalProperties:false,
   properties:{
    task_id:taskIdSchema,
    workspace_root:text,
    timeout_sec:{type:'integer',minimum:1,maximum:110},
    auto_verify:{type:'boolean'}
   }
  },
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}
 },
 {
  name:'get_job_status',
  description:'Inspect durable job state, delivery receipt, and current workspace diff without waiting. Omit task_id to inspect the latest workspace job.',
  inputSchema:{
   type:'object',
   additionalProperties:false,
   properties:{task_id:taskIdSchema,workspace_root:text}
  },
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}
 },
 {
  name:'get_job_result',
  description:'Read the concise worker summary, changed files, and test outcomes without reading full source files. Omit task_id to read the latest workspace job.',
  inputSchema:{
   type:'object',
   additionalProperties:false,
   properties:{task_id:taskIdSchema,workspace_root:text,auto_verify:{type:'boolean'}}
  },
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}
 },
 {
  name:'verify_job',
  description:'Independently verify scope/diff, run fresh registered host checks, and mark VERIFIED (or set accepted=false to release for rework). Omit task_id to verify the latest workspace job.',
  inputSchema:{
   type:'object',
   additionalProperties:false,
   required:['accepted'],
   properties:{
    task_id:taskIdSchema,
    workspace_root:text,
    accepted:{type:'boolean'},
    select_receiver:{type:'boolean'},
    review_notes:{type:'array',maxItems:16,items:text},
    review_evidence:reviewSchema
   }
  },
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}
 },
 {
  name:'release_job',
  description:'Explicitly release a blocked, failed, cancelled, or uncertain job so a new task or rework attempt can be submitted on the workspace. Omit task_id to release the latest workspace job.',
  inputSchema:{
   type:'object',
   additionalProperties:false,
   properties:{
    task_id:taskIdSchema,
    workspace_root:text,
    reason:text
   }
  },
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}
 }
];

function formatRecord(inbox,record){
 const paths=jobPaths(inbox,record.job);
 let actualChangedFiles=null;
 if(record.state==='PENDING')actualChangedFiles=[];
 else if(record.state==='VERIFIED'&&Array.isArray(record.host_receipt?.actual_changed_files))actualChangedFiles=record.host_receipt.actual_changed_files;
 else if(record.state==='RESULT_READY'){
  try{actualChangedFiles=changedFiles(record.baseline,captureWorkspaceFast(record.job.workspace_root));}catch{}
 }
 return {
  task_id:record.job.task_id,
  attempt_id:record.job.attempt_id,
  workspace_root:record.job.workspace_root,
  project_id:record.job.project_id,
  state:record.state,
  handoff_status:record.outcome??(record.state==='PENDING'?'WAITING_FOR_RECEIVER':record.state==='RESULT_READY'?'REPORTED_AWAITING_PARENT':record.state==='DISPATCHED'&&record.delivery?.delivery_confirmed===false?'WAITING_FOR_USER_HANDOFF':record.state==='DISPATCHED'?'TRANSPORT_ATTEMPTED_AWAITING_REPORT':record.state),
  outcome:record.outcome,
  write_scope:record.job.write_scope,
  verification_commands:record.job.verification_commands,
  functional_tests:record.job.verification_commands.every(id=>id==='noop')?'NOT_RUN':'SEE_CHECK_RESULTS',
  ...paths,
  delivery:record.delivery,
  report_sha256:record.report_sha256,
  host_receipt:record.host_receipt,
  actual_changed_files:actualChangedFiles,
  events:record.events
 };
}

function attachWorkerReport(inbox,record,formatted){
 const resultAvailable=['RESULT_READY','VERIFIED'].includes(record.state);
 formatted.result_available=resultAvailable;
 formatted.concise_summary=null;
 formatted.worker_report=null;
 formatted.result_markdown=null;
 if(resultAvailable){
  const bytes=readBoundedBytes(scopedPath(inbox.root,record.job.expected_output),MAX_REPORT_BYTES);
  if(sha256(bytes)!==record.report_sha256)throw Error('Worker report changed after collection');
  formatted.worker_report=validateReport(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),record.job);
  formatted.concise_summary={
   status:formatted.worker_report.status,
   headline:formatted.worker_report.findings[0]??'',
   findings:formatted.worker_report.findings,
   changed_files:formatted.worker_report.changed_files,
   tests:formatted.worker_report.tests.map(t=>`${t.command} (exit ${t.exit_code})`),
   blockers:formatted.worker_report.blockers,
   errors:formatted.worker_report.errors
  };
  if(existsSync(formatted.result_path)){
   try{formatted.result_markdown=new TextDecoder('utf-8',{fatal:true}).decode(readBoundedBytes(formatted.result_path,MAX_REPORT_BYTES));}catch{}
  }
 }
 return formatted;
}

export function createLiveToolHandler({
 defaultWorkspaceRoot=null,
 stateDirectory=DEFAULT_LIVE_STATE,
 now=Date.now
}={}){
 const checkedState=checkedStateDirectory(stateDirectory);
 return async function callTool(name,args={},context={}){
  const tool=LIVE_MCP_TOOLS.find(item=>item.name===name);
  if(!tool)throw Error('Unknown MCP tool: '+name);
   boundedJSON(args,name==='verify_job'?MAX_REPORT_BYTES:MAX_JOB_BYTES,'Tool arguments');
  const checked=validate(args,tool.inputSchema);
  if(!checked.valid)throw Error('Invalid tool arguments: '+checked.errors.join('; '));
  const workspaceContext=await resolveRequestWorkspace({requestedRoot:args.workspace_root,pinnedRoot:defaultWorkspaceRoot,getWorkspaceRoots:context.getWorkspaceRoots});
  ensureWorkspaceRegistration(workspaceContext.root,{stateDirectory:checkedState});

  if(name==='bridge_status'){
   const ws=workspaceContext.root;
   const selected=args.use_selected_receiver===false?null:readSelectedReceiver({stateDirectory:checkedState});
   const readiness=selectedReadiness(inspectWorkspaceReadiness({workspaceRoot:ws,stateDirectory:checkedState,now}),selected);
   const {config}=readiness;
   return {
    workspace_root:config.workspace_root,
    project_id:config.slug,
    workspace_context:workspaceContext,
    project_checks:suggestProjectChecks(config.workspace_root),
    delivery_target:readiness.delivery_target??{mode:'matching_workspace',proves_gui_focus:false},
    available_checks:Object.keys(config.checks),
    allow_new_conversation:config.allow_new_conversation,
    active_gui_target:readiness.active_gui_target,
    sidecar_heartbeat:readiness.heartbeat,
    sidecar_running:readiness.sidecar_running,
    sidecar_agentapi_available:readiness.sidecar_agentapi_available,
    sidecar_ls_address_present:readiness.sidecar_ls_address_present,
    sidecar_code_version:readiness.sidecar_code_version,
    heartbeat_age_ms:readiness.heartbeat_age_ms,
    heartbeat_max_age_ms:readiness.heartbeat_max_age_ms,
    target_age_ms:readiness.target_age_ms,
    target_ttl_ms:readiness.target_ttl_ms,
    target_observation:readiness.target_observation,
    slot_available:readiness.slot_available,
    active_task:readiness.active_task,
    snapshot_cache:getSnapshotCacheStats(),
    ready_to_dispatch:readiness.ready_to_dispatch,
    readiness_status:readiness.readiness_status,
    reason_codes:readiness.reason_codes
   };
  }

  if(name==='submit_job'){
   const ws=workspaceContext.root;
   const {inbox,config}=openLiveInbox(ws,{stateDirectory:checkedState,now});
   const verificationCommands=args.verification_commands?.length?args.verification_commands:['noop'];
   for(const checkId of verificationCommands){
    if(!Object.hasOwn(config.checks,checkId)){
     throw Error(`Unknown verification check "${checkId}" for workspace ${config.workspace_root}. Available checks: ${Object.keys(config.checks).join(', ')}`);
    }
   }
   const {readScope,writeScope}=inferJobScopes(config.workspace_root,args.request,{
    readScope:args.read_scope,
    writeScope:args.write_scope,
    readOnly:args.read_only,
    subtasks:args.subtasks
   });
   assertAuditableScopes(config.workspace_root,[...readScope,...writeScope]);
   const acceptanceCriteria=args.acceptance_criteria?.length?args.acceptance_criteria:['Complete requested task and provide concise summary'];
   const subtaskPlan=args.subtasks?.length
    ?validateSubtaskPlan(args.subtasks,{readScope,writeScope,workspaceRoot:config.workspace_root})
    :null;
   const replaceActive=args.replace_active===true;
   for(const existing of inbox.list()){
    if(existing.state==='PENDING'&&existing.outcome===null){
     const ageMs=now()-Date.parse(existing.job.created_at);
     if(replaceActive||ageMs>MAX_JOB_AGE_MS){
      try{inbox.release(existing.job.task_id,replaceActive?'Auto-released previous pending task on replace_active':'Auto-released expired pending task (>10m)');}catch{}
     }
    }
   }
   const job=makeJob(config.binding,{
    task_id:args.task_id??randomUUID(),
    attempt_id:args.attempt_id??randomUUID(),
    workspace_root:config.workspace_root,
    goal:args.request,
    read_scope:readScope,
    write_scope:writeScope,
    acceptance_criteria:acceptanceCriteria,
    verification_commands:verificationCommands
   },{now});
   const baseline=captureWorkspaceFast(config.workspace_root,{verifyHashes:true});
   const rawReadiness=inspectWorkspaceReadiness({
    workspaceRoot:config.workspace_root,
    stateDirectory:checkedState,
    records:[],
    now
   });
   const selected=args.use_selected_receiver===false?null:readSelectedReceiver({stateDirectory:checkedState});
   const effectiveSelected=resolveEffectiveReceiver(rawReadiness,selected);
   if(effectiveSelected)bindSelectedReceiver(inbox,job,effectiveSelected);
   const record=inbox.submit(job,{baseline});
   const paths=writeJobBrief(inbox,job,{subtaskPlan,stateDirectory:checkedState});
   const trigger=buildSingleLineTrigger(job,paths.brief_md_path,{subtaskPlan});
   const readiness=selectedReadiness(rawReadiness,effectiveSelected);
   const targetConversationId=effectiveSelected?.conversation_id??(readiness.target_observation.bound&&readiness.target_observation.fresh
    ?readiness.target_observation.conversation_id
    :null);
   return {
    ...formatRecord(inbox,record),
    subtask_plan:subtaskPlan,
    single_line_trigger:trigger,
    target_conversation_id:targetConversationId,
    delivery_target:readiness.delivery_target??{mode:'matching_workspace',proves_gui_focus:false},
    sidecar_running:readiness.sidecar_running,
    ready_to_dispatch:readiness.ready_to_dispatch,
    readiness_status:readiness.readiness_status,
    reason_codes:readiness.reason_codes,
    next_step:targetConversationId
     ?(readiness.ready_to_dispatch
      ?'Call wait_job({ workspace_root, task_id, auto_verify: true }) to await completion and mechanical check, then inspect changes and call verify_job.'
      :'Enable "AWO Desktop Bridge" in Antigravity Automations Dashboard (or paste single_line_trigger into GUI), then call wait_job.')
     :`Target receiver is unclear/missing (${readiness.reason_codes.join(', ')||'TARGET_MISSING'}); job is held safely in PENDING without sending to an unverified chat.`
   };
  }

  const found=args.task_id
   ?findTaskAcrossWorkspaces(args.task_id,{workspaceRoot:workspaceContext.root,stateDirectory:checkedState,now})
   :resolveLatestWorkspaceTask(workspaceContext.root,{stateDirectory:checkedState,now});
  const taskId=found.record.job.task_id;
  const {inbox,config}=openLiveInbox(found.config.workspace_root,{stateDirectory:checkedState,now});

  if(name==='release_job'){
   const released=inbox.release(taskId,args.reason??'Released by Codex Boss via MCP');
   return {released:true,...formatRecord(inbox,released)};
  }

  if(name==='get_job_status'){
   const record=collectWorkerReport(inbox,taskId);
   return formatRecord(inbox,record);
  }

  if(name==='get_job_result'){
   const record=collectWorkerReport(inbox,taskId);
   const formatted=attachWorkerReport(inbox,record,formatRecord(inbox,record));
   if(args.auto_verify&&record.state==='RESULT_READY'&&!['CANCELLED','RELEASED'].includes(record.outcome)){
    const autoVerification=await runMechanicalVerification(inbox,taskId,{
     checks:config.checks
    });
    formatted.auto_verification=autoVerification;
   }
   return formatted;
  }

  if(name==='wait_job'){
   const timeoutMs=(args.timeout_sec??75)*1000;
   const deadline=Date.now()+timeoutMs;
   const taskDir=scopedPath(inbox.root,`tasks/${taskId}`);
   let watcher=null,wake=null;
   try{
    if(existsSync(taskDir)){
     watcher=watch(taskDir,{recursive:true},()=>{wake?.();});
     watcher.on('error',()=>{});
    }
    while(true){
     const record=collectWorkerReport(inbox,taskId);
     if(['RESULT_READY','VERIFIED'].includes(record.state)||record.outcome!==null){
      const formatted=attachWorkerReport(inbox,record,formatRecord(inbox,record));
      if(args.auto_verify&&record.state==='RESULT_READY'&&!['CANCELLED','RELEASED'].includes(record.outcome)){
       const autoVerification=await runMechanicalVerification(inbox,taskId,{
        checks:config.checks
       });
       formatted.auto_verification=autoVerification;
      }
      return {timed_out:false,...formatted};
     }
     const remaining=deadline-Date.now();
     if(remaining<=0){
      return {timed_out:true,...attachWorkerReport(inbox,record,formatRecord(inbox,record))};
     }
     await new Promise(resolveWait=>{
      const done=()=>{clearTimeout(timer);wake=null;resolveWait();};
      const timer=setTimeout(done,Math.min(400,remaining));
      wake=done;
     });
    }
   }finally{
    watcher?.close();
   }
  }

  if(name==='verify_job'){
   const current=collectWorkerReport(inbox,taskId);
   if(!args.accepted){
    const reason='Rejected by Codex Boss for rework'+(args.review_notes?.length?': '+args.review_notes.join('; '):'');
    const released=inbox.release(taskId,reason);
    return {verified:false,released:true,...formatRecord(inbox,released)};
   }
   if(current.state!=='RESULT_READY'){
    throw Error(`Task ${taskId} is in state ${current.state} (outcome=${current.outcome}); wait for RESULT_READY before verify_job.`);
   }
   if(args.select_receiver&&(current.delivery?.kind!=='ANTIGRAVITY_AGENTAPI'||current.delivery?.started!==true||current.delivery?.exit_code!==0))throw Error('Select a recipient only from a real successful automatic delivery');
   const verified=await verifyJob(inbox,taskId,{
    checks:config.checks,
    review:async()=>({accepted:true,evidence:args.review_evidence,notes:args.review_evidence?.notes??[]})
   });
   if(args.select_receiver)selectVerifiedReceiver(verified,{stateDirectory:checkedState,now});
   return {verified:true,released:false,...attachWorkerReport(inbox,verified,formatRecord(inbox,verified))};
  }

  throw Error('Unhandled MCP tool: '+name);
 };
}

const SUPPORTED_VERSIONS=['2025-11-25','2025-06-18'];
const MAX_MESSAGE_BYTES=65536;
function rpcError(id,code,message){return {jsonrpc:'2.0',id,error:{code,message}};}

export function startLiveStdioServer({input=process.stdin,output=process.stdout,callTool}={}){
 if(typeof callTool!=='function')throw Error('Tool handler required');
 let phase='NEW',pending=Buffer.alloc(0),closed=false,queue=Promise.resolve();
 let rootsSupported=false,requestSequence=0;
 const replies=new Map();
 const send=value=>{if(!closed)output.write(JSON.stringify(value)+'\n');};
 const getWorkspaceRoots=()=>{
  if(!rootsSupported)return Promise.resolve(null);
  return new Promise((accept,reject)=>{
   const id=`awo-roots-${++requestSequence}`;
   const timer=setTimeout(()=>{replies.delete(id);reject(Error('WORKSPACE_CONTEXT_UNAVAILABLE: client roots/list timed out'));},2000);
   replies.set(id,message=>{clearTimeout(timer);replies.delete(id);if(message.error||!Array.isArray(message.result?.roots))reject(Error('WORKSPACE_CONTEXT_UNAVAILABLE: invalid client roots/list response'));else accept(message.result.roots);});
   send({jsonrpc:'2.0',id,method:'roots/list',params:{}});
  });
 };
 async function handleLine(line){
  let message;
  try{message=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));}
  catch{send(rpcError(null,-32700,'Invalid UTF-8 or JSON'));return;}
  if(!message||Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||(Object.hasOwn(message,'id')&&!(typeof message.id==='string'||Number.isSafeInteger(message.id)))){
   send(rpcError(null,-32600,'Invalid JSON-RPC request'));return;
  }
  const {method,params,id}=message,isRequest=Object.hasOwn(message,'id');
  if(!isRequest){
   if(method==='notifications/initialized'&&phase==='INITIALIZING')phase='READY';
   return;
  }
  if(method==='ping'){send({jsonrpc:'2.0',id,result:{}});return;}
  if(method==='initialize'){
   if(phase!=='NEW'){send(rpcError(id,-32600,'Already initialized'));return;}
   if(!params||typeof params.protocolVersion!=='string'||!params.capabilities||typeof params.capabilities!=='object'||Array.isArray(params.capabilities)||!params.clientInfo||typeof params.clientInfo.name!=='string'||typeof params.clientInfo.version!=='string'){
    send(rpcError(id,-32602,'Invalid initialize params'));return;
   }
   const protocolVersion=SUPPORTED_VERSIONS.includes(params.protocolVersion)?params.protocolVersion:SUPPORTED_VERSIONS[0];
   rootsSupported=Boolean(params.capabilities.roots&&typeof params.capabilities.roots==='object');
   phase='INITIALIZING';
   send({
    jsonrpc:'2.0',
    id,
    result:{
     protocolVersion,
     capabilities:{tools:{listChanged:false}},
     serverInfo:{name:'awo-live-desktop-bridge',version:'2.6.0'},
     instructions:'Codex Boss -> Antigravity Desktop GUI bridge. Pass workspace_root from the current session environment on EVERY call when client MCP roots are unavailable. Never infer a root from server cwd. Check bridge_status, submit a scoped job, wait, inspect results and independently verify.'
    }
   });
   return;
  }
  if(phase!=='READY'){send(rpcError(id,-32000,'Initialize and send notifications/initialized first'));return;}
  if(method==='tools/list'){
   if(params&&Object.hasOwn(params,'cursor')){send(rpcError(id,-32602,'Pagination cursor unsupported'));return;}
   send({jsonrpc:'2.0',id,result:{tools:LIVE_MCP_TOOLS}});
   return;
  }
  if(method==='tools/call'){
   if(!params||typeof params.name!=='string'||!LIVE_MCP_TOOLS.some(tool=>tool.name===params.name)){
    send(rpcError(id,-32602,'Unknown tool'));return;
   }
   try{
    const result=await callTool(params.name,params.arguments??{},{getWorkspaceRoots});
    send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false}});
   }catch(error){
    send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:error.message}],isError:true}});
   }
   return;
  }
  send(rpcError(id,-32601,'Method not found'));
 }
 input.on('data',chunk=>{
  if(closed)return;
  pending=Buffer.concat([pending,Buffer.from(chunk)]);
  let at;
  while((at=pending.indexOf(10))!==-1){
   const line=pending.subarray(0,at).subarray(0,at>0&&pending[at-1]===13?at-1:at);
   pending=pending.subarray(at+1);
   if(line.length>MAX_MESSAGE_BYTES){send(rpcError(null,-32600,'Message too large'));closed=true;input.destroy();return;}
   if(line.length){
    // Responses to server->client roots requests must bypass the serialized
    // tool queue, which is currently awaiting that response.
    let response;try{response=JSON.parse(line.toString('utf8'));}catch{}
    if(response?.jsonrpc==='2.0'&&!Object.hasOwn(response,'method')&&replies.has(response.id))replies.get(response.id)(response);
    else queue=queue.then(()=>handleLine(line)).catch(()=>{});
   }
  }
  if(pending.length>MAX_MESSAGE_BYTES){send(rpcError(null,-32600,'Message too large'));closed=true;input.destroy();}
 });
 input.on('end',()=>{if(!closed&&pending.length)send(rpcError(null,-32700,'Incomplete newline-delimited message'));});
 return {close(){closed=true;input.destroy();},get idle(){return queue;}};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{
  const args=process.argv.slice(2);
  let defaultWorkspaceRoot=null,stateDirectory=DEFAULT_LIVE_STATE;
  for(let i=0;i<args.length;i+=2){
   if(!args[i+1])throw Error('Expected --workspace <path> [--state <state/dir>]');
   if(args[i]==='--workspace')defaultWorkspaceRoot=args[i+1];
   else if(args[i]==='--state')stateDirectory=args[i+1];
   else throw Error('Unknown MCP server option: '+args[i]);
  }
  startLiveStdioServer({callTool:createLiveToolHandler({defaultWorkspaceRoot,stateDirectory})});
 }catch(error){
  process.stderr.write(JSON.stringify({status:'ERROR',message:error.message})+'\n');
  process.exitCode=1;
 }
}
