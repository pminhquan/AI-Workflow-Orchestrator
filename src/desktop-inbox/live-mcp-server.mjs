import {randomUUID} from 'node:crypto';
import {existsSync,watch} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ROOT,scopedPath,sha256} from '../core/util.mjs';
import { validate } from '../core/schema.mjs';
import {changedFiles} from '../verification/checks.mjs';
import {UUID,MAX_JOB_BYTES,MAX_REPORT_BYTES,boundedJSON,makeJob,validateReport} from './contracts.mjs';
import {readBoundedBytes,verifyJob} from './verification.mjs';
import {captureWorkspaceFast,getSnapshotCacheStats} from './fast-snapshot.mjs';
import {SUBTASK_AGENT_TYPES,validateSubtaskPlan} from './subtask-planner.mjs';
import {
 DEFAULT_LIVE_STATE,
 buildSingleLineTrigger,
 checkedStateDirectory,
 collectWorkerReport,
 findTaskAcrossWorkspaces,
 jobPaths,
 openLiveInbox,
 writeJobBrief
} from './live-bridge.mjs';
import {inspectWorkspaceReadiness} from './readiness.mjs';

const text={type:'string',minLength:1};
const taskIdSchema={type:'string',pattern:UUID.source};
const pathList={type:'array',maxItems:32,uniqueItems:true,items:text};
const checkIdSchema={type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'};

export const LIVE_MCP_TOOLS=[
 {
  name:'bridge_status',
  description:'Check Antigravity Desktop GUI active conversation beacon, sidecar heartbeat, registered verification checks, and whether the workspace slot is free.',
  inputSchema:{
   type:'object',
   additionalProperties:false,
   properties:{workspace_root:text}
  },
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
 },
 {
  name:'submit_job',
  description:'Queue a bounded read-only or write-scoped task (with optional parallel wave subtasks) for Antigravity Desktop GUI. The live sidecar delivers a concise single-line trigger into the open GUI conversation.',
  inputSchema:{
   type:'object',
   additionalProperties:false,
   required:['request','read_scope','acceptance_criteria'],
   properties:{
    task_id:taskIdSchema,
    attempt_id:taskIdSchema,
    workspace_root:text,
    request:text,
    read_scope:{...pathList,minItems:1},
    write_scope:pathList,
    subtasks:{
     type:'array',
     minItems:1,
     maxItems:8,
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
  description:'Event-driven wait until the Antigravity Worker submits its report (RESULT_READY), fails/releases, or timeout_sec elapses.',
  inputSchema:{
   type:'object',
   additionalProperties:false,
   required:['task_id'],
   properties:{
    task_id:taskIdSchema,
    workspace_root:text,
    timeout_sec:{type:'integer',minimum:1,maximum:110}
   }
  },
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}
 },
 {
  name:'get_job_status',
  description:'Inspect durable job state, delivery receipt, and current workspace diff without waiting.',
  inputSchema:{
   type:'object',
   additionalProperties:false,
   required:['task_id'],
   properties:{task_id:taskIdSchema,workspace_root:text}
  },
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}
 },
 {
  name:'get_job_result',
  description:'Read the hash-verified worker report, result.md summary, and actual changed files in the workspace.',
  inputSchema:{
   type:'object',
   additionalProperties:false,
   required:['task_id'],
   properties:{task_id:taskIdSchema,workspace_root:text}
  },
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}
 },
 {
  name:'verify_job',
  description:'Independently verify scope/diff, run fresh registered host checks, and mark VERIFIED (or set accepted=false to release for rework).',
  inputSchema:{
   type:'object',
   additionalProperties:false,
   required:['task_id','accepted'],
   properties:{
    task_id:taskIdSchema,
    workspace_root:text,
    accepted:{type:'boolean'},
    review_notes:{type:'array',maxItems:16,items:text}
   }
  },
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}
 },
 {
  name:'release_job',
  description:'Explicitly release a blocked, failed, cancelled, or uncertain job so a new task or rework attempt can be submitted on the workspace.',
  inputSchema:{
   type:'object',
   additionalProperties:false,
   required:['task_id'],
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
 else{
  try{actualChangedFiles=changedFiles(record.baseline,captureWorkspaceFast(record.job.workspace_root));}catch{}
 }
 return {
  task_id:record.job.task_id,
  attempt_id:record.job.attempt_id,
  workspace_root:record.job.workspace_root,
  project_id:record.job.project_id,
  state:record.state,
  outcome:record.outcome,
  write_scope:record.job.write_scope,
  verification_commands:record.job.verification_commands,
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
 formatted.worker_report=null;
 formatted.result_markdown=null;
 if(resultAvailable){
  const bytes=readBoundedBytes(scopedPath(inbox.root,record.job.expected_output),MAX_REPORT_BYTES);
  if(sha256(bytes)!==record.report_sha256)throw Error('Worker report changed after collection');
  formatted.worker_report=validateReport(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),record.job);
  if(existsSync(formatted.result_path)){
   try{formatted.result_markdown=new TextDecoder('utf-8',{fatal:true}).decode(readBoundedBytes(formatted.result_path,MAX_REPORT_BYTES));}catch{}
  }
 }
 return formatted;
}

export function createLiveToolHandler({
 defaultWorkspaceRoot=ROOT,
 stateDirectory=DEFAULT_LIVE_STATE,
 now=Date.now
}={}){
 const checkedState=checkedStateDirectory(stateDirectory);
 return async function callTool(name,args={}){
  const tool=LIVE_MCP_TOOLS.find(item=>item.name===name);
  if(!tool)throw Error('Unknown MCP tool: '+name);
  boundedJSON(args,MAX_JOB_BYTES,'Tool arguments');
  const checked=validate(args,tool.inputSchema);
  if(!checked.valid)throw Error('Invalid tool arguments: '+checked.errors.join('; '));

  if(name==='bridge_status'){
   const ws=args.workspace_root??defaultWorkspaceRoot;
   const readiness=inspectWorkspaceReadiness({workspaceRoot:ws,stateDirectory:checkedState,now});
   const {config}=readiness;
   return {
    workspace_root:config.workspace_root,
    project_id:config.slug,
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
   const ws=args.workspace_root??defaultWorkspaceRoot;
   const {inbox,config}=openLiveInbox(ws,{stateDirectory:checkedState,now});
   const verificationCommands=args.verification_commands?.length?args.verification_commands:['noop'];
   for(const checkId of verificationCommands){
    if(!Object.hasOwn(config.checks,checkId)){
     throw Error(`Unknown verification check "${checkId}" for workspace ${config.workspace_root}. Available checks: ${Object.keys(config.checks).join(', ')}`);
    }
   }
   const writeScope=args.write_scope??[];
   const subtaskPlan=args.subtasks?.length
    ?validateSubtaskPlan(args.subtasks,{readScope:args.read_scope,writeScope,workspaceRoot:config.workspace_root})
    :null;
   const job=makeJob(config.binding,{
    task_id:args.task_id??randomUUID(),
    attempt_id:args.attempt_id??randomUUID(),
    workspace_root:config.workspace_root,
    goal:args.request,
    read_scope:args.read_scope,
    write_scope:writeScope,
    acceptance_criteria:args.acceptance_criteria,
    verification_commands:verificationCommands
   },{now});
   const baseline=captureWorkspaceFast(config.workspace_root);
   const record=inbox.submit(job,{baseline});
   const paths=writeJobBrief(inbox,job,{subtaskPlan});
   const trigger=buildSingleLineTrigger(job,paths.brief_md_path,{subtaskPlan});
   const readiness=inspectWorkspaceReadiness({
    workspaceRoot:config.workspace_root,
    stateDirectory:checkedState,
    records:[],
    now
   });
   const targetConversationId=readiness.target_observation.bound&&readiness.target_observation.fresh
    ?readiness.target_observation.conversation_id
    :null;
   return {
    ...formatRecord(inbox,record),
    subtask_plan:subtaskPlan,
    single_line_trigger:trigger,
    target_conversation_id:targetConversationId,
    sidecar_running:readiness.sidecar_running,
    ready_to_dispatch:readiness.ready_to_dispatch,
    readiness_status:readiness.readiness_status,
    reason_codes:readiness.reason_codes,
    next_step:targetConversationId
     ?(readiness.ready_to_dispatch?'Call wait_job to await Antigravity GUI completion, then verify_job.':'Enable "AWO Desktop Bridge" in Antigravity Automations Dashboard (or paste single_line_trigger into GUI), then call wait_job.')
     :'Open a chat in Antigravity Desktop GUI for this workspace so the Hook Beacon captures conversationId, then Sidecar will auto-deliver.'
   };
  }

  const found=findTaskAcrossWorkspaces(args.task_id,{workspaceRoot:args.workspace_root??null,stateDirectory:checkedState,now});
  const {inbox,config}=openLiveInbox(found.config.workspace_root,{stateDirectory:checkedState,now});

  if(name==='release_job'){
   const released=inbox.release(args.task_id,args.reason??'Released by Codex Boss via MCP');
   return {released:true,...formatRecord(inbox,released)};
  }

  if(name==='get_job_status'){
   const record=collectWorkerReport(inbox,args.task_id);
   return formatRecord(inbox,record);
  }

  if(name==='get_job_result'){
   const record=collectWorkerReport(inbox,args.task_id);
   return attachWorkerReport(inbox,record,formatRecord(inbox,record));
  }

  if(name==='wait_job'){
   const timeoutMs=(args.timeout_sec??75)*1000;
   const deadline=Date.now()+timeoutMs;
   const taskDir=scopedPath(inbox.root,`tasks/${args.task_id}`);
   let watcher=null,wake=null;
   try{
    if(existsSync(taskDir)){
     watcher=watch(taskDir,{recursive:true},()=>{wake?.();});
     watcher.on('error',()=>{});
    }
    while(true){
     const record=collectWorkerReport(inbox,args.task_id);
     if(['RESULT_READY','VERIFIED'].includes(record.state)||record.outcome!==null){
      return {timed_out:false,...attachWorkerReport(inbox,record,formatRecord(inbox,record))};
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
   const current=collectWorkerReport(inbox,args.task_id);
   if(!args.accepted){
    const reason='Rejected by Codex Boss for rework'+(args.review_notes?.length?': '+args.review_notes.join('; '):'');
    const released=inbox.release(args.task_id,reason);
    return {verified:false,released:true,...formatRecord(inbox,released)};
   }
   if(current.state!=='RESULT_READY'){
    throw Error(`Task ${args.task_id} is in state ${current.state} (outcome=${current.outcome}); wait for RESULT_READY before verify_job.`);
   }
   const verified=await verifyJob(inbox,args.task_id,{
    checks:config.checks,
    review:async()=>({accepted:true,notes:args.review_notes??[]})
   });
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
 const send=value=>{if(!closed)output.write(JSON.stringify(value)+'\n');};
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
   phase='INITIALIZING';
   send({
    jsonrpc:'2.0',
    id,
    result:{
     protocolVersion,
     capabilities:{tools:{listChanged:false}},
     serverInfo:{name:'awo-live-desktop-bridge',version:'2.5.1'},
     instructions:'Codex Boss -> Antigravity Desktop GUI bridge. Check bridge_status, submit_job with bounded scopes, wait_job, inspect get_job_result, and verify_job.'
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
    const result=await callTool(params.name,params.arguments??{});
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
   if(line.length)queue=queue.then(()=>handleLine(line)).catch(()=>{});
  }
  if(pending.length>MAX_MESSAGE_BYTES){send(rpcError(null,-32600,'Message too large'));closed=true;input.destroy();}
 });
 input.on('end',()=>{if(!closed&&pending.length)send(rpcError(null,-32700,'Incomplete newline-delimited message'));});
 return {close(){closed=true;input.destroy();},get idle(){return queue;}};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{
  const args=process.argv.slice(2);
  let defaultWorkspaceRoot=process.cwd(),stateDirectory=DEFAULT_LIVE_STATE;
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
