import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,openSync,readFileSync,writeFileSync,closeSync,unlinkSync,watch} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ROOT,scopedPath,sha256} from '../core/util.mjs';
import {MAX_JOB_AGE_MS} from './contracts.mjs';
import {inspectWorkspaceReadiness} from './readiness.mjs';
import {readJobReceiver,resolveEffectiveReceiver} from './selected-receiver.mjs';
import {
 DEFAULT_LIVE_STATE,
 buildSingleLineTrigger,
 checkedStateDirectory,
 collectWorkerReport,
 listLiveWorkspaces,
 existingLiveInbox,
 readActiveTarget,
 readBoundedJSON,
 resolveWorkspaceConfig,
 writeJobBrief,
 writeSidecarHeartbeat
} from './live-bridge.mjs';

export function isPidAlive(pid){
 if(!Number.isInteger(pid)||pid<=0)return false;
 if(pid===process.pid)return true;
 try{process.kill(pid,0);return true;}
 catch(error){return error?.code==='EPERM';}
}

function acquireProcessLock(lockPath){
 mkdirSync(resolve(lockPath,'..'),{recursive:true});
 if(existsSync(lockPath)){
  try{
   const existing=readBoundedJSON(lockPath,4096);
   if(isPidAlive(existing?.pid)&&existing.pid!==process.pid){
    const err=Error(`Sidecar lock held by active PID ${existing.pid}`);
    err.code='ELOCKED';
    throw err;
   }
  }catch(error){
   if(error?.code==='ELOCKED')throw error;
  }
  try{unlinkSync(lockPath);}catch{}
 }
 const fd=openSync(lockPath,'wx');
 try{
  writeFileSync(fd,JSON.stringify({pid:process.pid,started_at:new Date().toISOString()})+'\n');
 }finally{
  closeSync(fd);
 }
 return ()=>{try{if(existsSync(lockPath))unlinkSync(lockPath);}catch{}};
}

const SIDECAR_CODE_VERSION='2.6.0';
const WATCHED_MODULES=[
 fileURLToPath(import.meta.url),
 ...['live-bridge','selected-receiver','readiness','contracts','inbox'].map(name=>scopedPath(ROOT,`src/desktop-inbox/${name}.mjs`))
];

function computeCodeFingerprint(){
 try{
  return sha256(WATCHED_MODULES.map(file=>existsSync(file)?readFileSync(file,'utf8'):'').join('\n---\n')).slice(0,16);
 }catch{
  return 'unknown';
 }
}

export function resolveAgentapiCommand(argv,env=process.env){
 const customExe=typeof env?.ANTIGRAVITY_AGENTAPI_EXE==='string'?env.ANTIGRAVITY_AGENTAPI_EXE.trim():'';
 if(customExe){
  return {executable:customExe,args:['agentapi',...argv],source:'ANTIGRAVITY_AGENTAPI_EXE'};
 }
 return {executable:'agentapi',args:[...argv],source:'PATH'};
}

export function inspectAgentapiEnv(env=process.env){
 const customExe=typeof env?.ANTIGRAVITY_AGENTAPI_EXE==='string'?env.ANTIGRAVITY_AGENTAPI_EXE.trim():'';
 const lsAddress=typeof env?.ANTIGRAVITY_LS_ADDRESS==='string'?env.ANTIGRAVITY_LS_ADDRESS.trim():'';
 return {
  agentapi_source:customExe?'ANTIGRAVITY_AGENTAPI_EXE':'PATH',
  agentapi_available:customExe?existsSync(customExe):false,
  ls_address_present:Boolean(lsAddress)
 };
}

function spawnAgentapiOnce(executable,args,{timeoutMs=15000,signal,cwd,env=process.env,captureStdoutText=false}={}){
 return new Promise(resolveCall=>{
  let started=false,spawnError=null,timedOut=false,overflow=false;
  let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0);
  const child=spawn(executable,args,{cwd,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.once('spawn',()=>{started=true;});
  child.once('error',error=>{spawnError=error.code??'SPAWN_ERROR';});
  const capture=(which,chunk)=>{
   if(which==='stdout')stdout=Buffer.concat([stdout,chunk]);
   else stderr=Buffer.concat([stderr,chunk]);
   if(stdout.length+stderr.length>65536){
    overflow=true;
    stdout=stdout.subarray(0,32768);
    stderr=stderr.subarray(0,32768);
    child.kill();
   }
  };
  child.stdout.on('data',data=>capture('stdout',data));
  child.stderr.on('data',data=>capture('stderr',data));
  const onAbort=()=>child.kill();
  const timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
  signal?.addEventListener('abort',onAbort,{once:true});
  if(signal?.aborted)onAbort();
  child.once('close',(exit_code,exit_signal)=>{
   clearTimeout(timer);
   signal?.removeEventListener('abort',onAbort);
   const out={
    started,
    spawn_error:spawnError,
    exit_code,
    exit_signal:exit_signal??null,
    timed_out:timedOut,
    output_overflow:overflow,
    stdout_sha256:sha256(stdout),
    stderr_sha256:sha256(stderr),
    stdout_bytes:stdout.length,
    stderr_bytes:stderr.length
   };
   if(captureStdoutText)out.stdout_text=stdout.toString('utf8');
   resolveCall(out);
  });
 });
}

export async function defaultInvokeAgentapi(argv,{timeoutMs=15000,signal,cwd,env=process.env}={}){
 const resolved=resolveAgentapiCommand(argv,env);
 let childEnv=env;
 if(resolved.source==='ANTIGRAVITY_AGENTAPI_EXE'&&argv[0]==='send-message'&&typeof argv[1]==='string'&&argv[1].length>0){
  try{
   const metaCall=await spawnAgentapiOnce(resolved.executable,['agentapi','get-conversation-metadata',argv[1]],{
    timeoutMs:Math.min(3500,timeoutMs),
    signal,
    cwd,
    env,
    captureStdoutText:true
   });
   if(metaCall.started&&metaCall.exit_code===0&&!metaCall.timed_out&&metaCall.stdout_text){
    const parsed=JSON.parse(metaCall.stdout_text);
    const meta=parsed?.response?.conversationMetadata?.metadata
     ??parsed?.response?.conversation_metadata?.metadata
     ??parsed?.conversationMetadata?.metadata
     ??parsed?.metadata
     ??null;
    const rawProjectId=meta?.projectId??meta?.project_id;
    const detectedProjectId=typeof rawProjectId==='string'?rawProjectId.trim():'';
    if(detectedProjectId)childEnv={...env,ANTIGRAVITY_PROJECT_ID:detectedProjectId};
   }
  }catch{}
 }
 const call=await spawnAgentapiOnce(resolved.executable,resolved.args,{timeoutMs,signal,cwd,env:childEnv});
 return {...call,executable_source:resolved.source};
}

export async function runLiveSidecarTick({
 stateDirectory=DEFAULT_LIVE_STATE,
 invokeAgentapi=defaultInvokeAgentapi,
 transportTimeoutMs=15000,
 codeFingerprint=computeCodeFingerprint(),
 env=process.env,
 signal,
 now=Date.now
}={}){
 const checkedState=checkedStateDirectory(stateDirectory);
 const workspaces=listLiveWorkspaces({stateDirectory:checkedState});
 const actions=[];
 let activeTargets=0;
 for(const ws of workspaces){
  if(signal?.aborted)break;
  try{
  const target=readActiveTarget(ws,{stateDirectory:checkedState});
  if(target?.conversation_id)activeTargets++;
  const {inbox,config}=existingLiveInbox(ws,{stateDirectory:checkedState,now});
  if(!inbox)continue;
  const records=inbox.list();
  for(const rec of records){
   if(rec.state==='DISPATCHED'&&!['FAILED','RELEASED'].includes(rec.outcome)){
    try{
     const updated=collectWorkerReport(inbox,rec.job.task_id);
     if(updated.state==='RESULT_READY'){
      actions.push({workspace_root:ws,task_id:rec.job.task_id,action:'COLLECTED_REPORT'});
      continue;
     }
    }catch(error){
     actions.push({workspace_root:ws,task_id:rec.job.task_id,action:'REPORT_ERROR',error:error.message});
    }
   }
  }
  const pending=inbox.list().find(rec=>rec.state==='PENDING'&&rec.outcome===null);
  if(!pending)continue;
  const ageMs=now()-Date.parse(pending.job.created_at);
  if(ageMs>MAX_JOB_AGE_MS){
   inbox.release(pending.job.task_id,'Auto-released expired pending job (>10m)');
   actions.push({workspace_root:ws,task_id:pending.job.task_id,action:'EXPIRED_RELEASED'});
   continue;
  }
  // Evaluate exactly the same workspace/age/ambiguity gates as the MCP status.
  // Ignore only the pending job's own slot when deciding whether it may dispatch.
  let selected=null;
  try{selected=readJobReceiver(inbox,pending.job);}catch(error){actions.push({workspace_root:ws,task_id:pending.job.task_id,action:'INVALID_DELIVERY_TARGET',error:error.message});continue;}
  const readiness=inspectWorkspaceReadiness({workspaceRoot:ws,stateDirectory:checkedState,records:[],now});
  const effectiveSelected=resolveEffectiveReceiver(readiness,selected);
  const targetReasons=effectiveSelected?[]:readiness.reason_codes.filter(code=>code.startsWith('TARGET_'));
  if(targetReasons.length){
   actions.push({workspace_root:ws,task_id:pending.job.task_id,action:'WAITING_FOR_GUI_SESSION',reason_codes:targetReasons});
   continue;
  }
  let mode=null,argv=null,conversationId=null;
  const paths=writeJobBrief(inbox,pending.job,{stateDirectory:checkedState});
  mkdirSync(paths.output_directory,{recursive:true});
  const trigger=buildSingleLineTrigger(pending.job,paths.brief_md_path);
  const dispatchTarget=effectiveSelected??readiness.active_gui_target;
  if(dispatchTarget?.conversation_id){
   mode='send-message';
   conversationId=dispatchTarget.conversation_id;
   argv=['send-message',conversationId,trigger];
  }else{
   actions.push({workspace_root:ws,task_id:pending.job.task_id,action:'WAITING_FOR_GUI_SESSION'});
   continue;
  }
  const claimed=inbox.claim(pending.job.task_id);
  inbox.beginDispatch(claimed.job.task_id,claimed.claim_id);
  let call;
  try{
   call=await invokeAgentapi(argv,{timeoutMs:transportTimeoutMs,signal,cwd:inbox.root,env});
  }catch{
   call={started:true,spawn_error:'UNKNOWN',exit_code:null,exit_signal:null,timed_out:false,output_overflow:false,stdout_sha256:sha256(''),stderr_sha256:sha256(''),stdout_bytes:0,stderr_bytes:0};
  }
  const dispatchLatencyMs=Math.max(0,now()-Date.parse(pending.job.created_at));
  const receipt={
   kind:'ANTIGRAVITY_AGENTAPI',
   mode,
   target_mode:effectiveSelected&&conversationId===effectiveSelected.conversation_id?'user_selected_receiver':'matching_workspace',
   target_conversation_id:conversationId,
   dispatched_at:new Date(now()).toISOString(),
   dispatch_latency_ms:dispatchLatencyMs,
   ...call
  };
  inbox.recordDelivery(claimed.job.task_id,claimed.claim_id,receipt);
  if(!call.started&&['ENOENT','EACCES'].includes(call.spawn_error)){
   inbox.fail(claimed.job.task_id,claimed.claim_id,`agentapi unavailable (${call.spawn_error})`);
   actions.push({workspace_root:ws,task_id:claimed.job.task_id,action:'FAILED_NO_AGENTAPI',error:call.spawn_error});
  }else if(call.exit_code===0&&!call.timed_out&&!call.spawn_error){
   actions.push({workspace_root:ws,task_id:claimed.job.task_id,action:'DISPATCHED',mode,conversation_id:conversationId,dispatch_latency_ms:dispatchLatencyMs});
  }else{
   inbox.fail(claimed.job.task_id,claimed.claim_id,'agentapi returned non-zero or timed out',{uncertain:true});
   actions.push({workspace_root:ws,task_id:claimed.job.task_id,action:'UNCERTAIN_DELIVERY',exit_code:call.exit_code});
  }
  }catch(error){
   actions.push({workspace_root:ws,action:'WORKSPACE_ERROR',error:String(error.message).slice(0,240)});
  }
 }
 const transportInfo=inspectAgentapiEnv(env);
 const heartbeat=writeSidecarHeartbeat('RUNNING',{
  stateDirectory:checkedState,
  now,
  extra:{
   code_version:SIDECAR_CODE_VERSION,
   code_fingerprint:codeFingerprint,
   ...transportInfo,
   workspaces_count:workspaces.length,
   active_targets:activeTargets,
   last_actions:actions.slice(0,8)
  }
 });
 return {status:'OK',workspaces_count:workspaces.length,active_targets:activeTargets,actions,heartbeat};
}

export async function startLiveSidecar({
 stateDirectory=DEFAULT_LIVE_STATE,
 pollIntervalMs=30000,
 transportTimeoutMs=15000,
 invokeAgentapi=defaultInvokeAgentapi,
 maxTicks=Infinity,
 env=process.env,
 signal,
 now=Date.now
}={}){
 if(!Number.isFinite(pollIntervalMs)||pollIntervalMs<100||pollIntervalMs>60000)throw Error('Sidecar fallback scan interval must be 100..60000 ms');
 const checkedState=checkedStateDirectory(stateDirectory);
 const stateRoot=scopedPath(ROOT,checkedState);
 mkdirSync(stateRoot,{recursive:true});
 const releaseLock=acquireProcessLock(scopedPath(stateRoot,'sidecar.lock'));
 const bootFingerprint=computeCodeFingerprint();
 let watcher=null,wake=null,ticks=0,coalesceTimer=null,dirty=true,lastScanAt=-Infinity,lastTick=null;
 try{
  for(const ws of listLiveWorkspaces({stateDirectory:checkedState})){
   try{const {inbox}=existingLiveInbox(ws,{stateDirectory:checkedState,now});inbox?.recover();}catch{}
  }
  try{
   watcher=watch(stateRoot,{recursive:true},(_event,name)=>{
    const rel=String(name??'').replaceAll('\\','/');
    if(rel.endsWith('sidecar-heartbeat.json')||rel.endsWith('sidecar.lock')||rel.endsWith('transaction.lock')||rel.includes('.tmp-'))return;
    dirty=true;
    clearTimeout(coalesceTimer);
    coalesceTimer=setTimeout(()=>{coalesceTimer=null;wake?.();},25);
   });
   watcher.on('error',()=>{});
  }catch{}
  while(!signal?.aborted&&ticks<maxTicks){
   ticks++;
   if(dirty||performance.now()-lastScanAt>=pollIntervalMs){
    dirty=false;lastScanAt=performance.now();
    lastTick=await runLiveSidecarTick({stateDirectory:checkedState,invokeAgentapi,transportTimeoutMs,codeFingerprint:bootFingerprint,env,signal,now});
   }else{
    writeSidecarHeartbeat('RUNNING',{stateDirectory:checkedState,now,extra:{code_version:SIDECAR_CODE_VERSION,code_fingerprint:bootFingerprint,...inspectAgentapiEnv(env),workspaces_count:lastTick?.workspaces_count??0,active_targets:lastTick?.active_targets??0,last_actions:[]}});
   }
   if(maxTicks===Infinity&&computeCodeFingerprint()!==bootFingerprint){
    writeSidecarHeartbeat('RELOADING',{stateDirectory:checkedState,now,extra:{ticks,code_version:SIDECAR_CODE_VERSION,reason:'source_code_updated'}});
    return {status:'RELOADING',ticks};
   }
   if(signal?.aborted||ticks>=maxTicks)break;
   await new Promise(resolveSleep=>{
    const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);wake=null;resolveSleep();};
    const timer=setTimeout(finish,Math.min(5000,pollIntervalMs));
    wake=finish;
    signal?.addEventListener('abort',finish,{once:true});
    if(signal?.aborted)finish();
   });
  }
  writeSidecarHeartbeat('STOPPED',{stateDirectory:checkedState,now,extra:{ticks,code_version:SIDECAR_CODE_VERSION}});
  return {status:'STOPPED',ticks};
 }finally{
  clearTimeout(coalesceTimer);
  watcher?.close();
  releaseLock();
 }
}

export async function main(args=process.argv.slice(2)){
 let stateDirectory=DEFAULT_LIVE_STATE,pollIntervalMs=30000,maxTicks=Infinity;
 for(let i=0;i<args.length;i++){
  if(args[i]==='--state'&&args[i+1])stateDirectory=args[++i];
  else if(args[i]==='--interval-ms'&&args[i+1])pollIntervalMs=Number.parseInt(args[++i],10);
  else if(args[i]==='--once')maxTicks=1;
  else throw Error('Unknown sidecar option: '+args[i]);
 }
 const controller=new AbortController();
 const stop=()=>controller.abort();
 process.once('SIGINT',stop);
 process.once('SIGTERM',stop);
 try{
  return await startLiveSidecar({stateDirectory,pollIntervalMs,maxTicks,signal:controller.signal});
 }finally{
  process.removeListener('SIGINT',stop);
  process.removeListener('SIGTERM',stop);
 }
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 main().catch(error=>{
  process.stderr.write(JSON.stringify({status:'ERROR',error:error.message})+'\n');
  process.exitCode=1;
 });
}
