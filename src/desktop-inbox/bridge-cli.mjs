import {existsSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ROOT,scopedPath} from '../core/util.mjs';
import {canonicalWorkspace} from './contracts.mjs';
import {captureWorkspaceFast,getSnapshotCacheStats} from './fast-snapshot.mjs';
import {
 DEFAULT_LIVE_STATE,
 existingLiveInbox,
 listLiveWorkspaces,
 openLiveInbox
} from './live-bridge.mjs';
import {inspectWorkspaceReadiness} from './readiness.mjs';
import {aggregateRecordsTelemetry} from './telemetry.mjs';

function hasRegularFile(root,rel){
 try{
  const full=scopedPath(root,rel);
  return existsSync(full)&&lstatSync(full).isFile();
 }catch{
  return false;
 }
}

export function bridgeDoctor({
 workspaceRoot=ROOT,
 stateDirectory=DEFAULT_LIVE_STATE,
 now=Date.now,
 heartbeatMaxAgeMs,
 targetTtlMs
}={}){
 const readiness=inspectWorkspaceReadiness({
  workspaceRoot,
  stateDirectory,
  now,
  ...(heartbeatMaxAgeMs!==undefined?{heartbeatMaxAgeMs}:{}),
  ...(targetTtlMs!==undefined?{targetTtlMs}:{})
 });
 const {config}=readiness;
 const hasHooks=hasRegularFile(config.workspace_root,'.agents/hooks.json');
 const hasWorkerSkill=hasRegularFile(config.workspace_root,'.agents/skills/codex-worker/SKILL.md');
 const hasBossSkill=hasRegularFile(config.workspace_root,'.agents/skills/antigravity-orchestrator/SKILL.md');
 const hasCodexConfig=hasRegularFile(config.workspace_root,'.codex/config.toml');
 const hasStagedSidecar=hasRegularFile(ROOT,'integrations/antigravity-inbox/awo-bridge.sidecar.json');
 const clockFn=typeof now==='function'?now:()=>now;
 const snapStart=clockFn();
 const snap=captureWorkspaceFast(config.workspace_root);
 const snapshotMs=Math.max(0,clockFn()-snapStart);
 const snapshotFiles=Object.keys(snap.entries).length;
 return {
  status:(hasHooks&&hasWorkerSkill&&hasCodexConfig)?'READY':'INCOMPLETE_ONBOARDING',
  workspace_root:config.workspace_root,
  project_id:config.slug,
  checks_registered:Object.keys(config.checks),
  allow_new_conversation:config.allow_new_conversation,
  files:{
   hooks:hasHooks,
   worker_skill:hasWorkerSkill,
   boss_skill:hasBossSkill,
   codex_mcp:hasCodexConfig,
   staged_sidecar:hasStagedSidecar
  },
  active_gui_target:readiness.active_gui_target,
  sidecar_running:readiness.sidecar_running,
  sidecar_agentapi_available:readiness.sidecar_agentapi_available,
  sidecar_ls_address_present:readiness.sidecar_ls_address_present,
  sidecar_code_version:readiness.sidecar_code_version,
  sidecar_heartbeat:readiness.heartbeat,
  heartbeat_age_ms:readiness.heartbeat_age_ms,
  heartbeat_max_age_ms:readiness.heartbeat_max_age_ms,
  target_age_ms:readiness.target_age_ms,
  target_ttl_ms:readiness.target_ttl_ms,
  target_observation:readiness.target_observation,
  slot_available:readiness.slot_available,
  active_task:readiness.active_task,
  ready_to_dispatch:readiness.ready_to_dispatch,
  readiness_status:readiness.readiness_status,
  reason_codes:readiness.reason_codes,
  snapshot_ms:snapshotMs,
  snapshot_files:snapshotFiles,
  snapshot_cache:getSnapshotCacheStats()
 };
}

export function bridgeMetrics({workspaceRoot=null,stateDirectory=DEFAULT_LIVE_STATE}={}){
 const targets=workspaceRoot?[canonicalWorkspace(workspaceRoot)]:listLiveWorkspaces({stateDirectory});
 const records=[];
 for(const ws of targets){
  const {inbox}=existingLiveInbox(ws,{stateDirectory});
  if(inbox)records.push(...inbox.list());
 }
 return {
  workspace_root:workspaceRoot?targets[0]:null,
  workspaces_scanned:targets.length,
  ...aggregateRecordsTelemetry(records)
 };
}

export function releaseStuckJobs({workspaceRoot=null,stateDirectory=DEFAULT_LIVE_STATE,reason='Operator released active slot via bridge-cli'}={}){
 const targets=workspaceRoot?[canonicalWorkspace(workspaceRoot)]:listLiveWorkspaces({stateDirectory});
 const releasedTasks=[];
 for(const ws of targets){
  const {inbox}=openLiveInbox(ws,{stateDirectory});
  for(const record of inbox.list()){
   if(record.state!=='VERIFIED'&&record.outcome!=='RELEASED'){
    const updated=inbox.release(record.job.task_id,reason);
    releasedTasks.push({
     task_id:updated.job.task_id,
     workspace_root:updated.job.workspace_root,
     state:updated.state,
     previous_outcome:record.outcome,
     outcome:updated.outcome
    });
   }
  }
 }
 return {
  released_count:releasedTasks.length,
  released_tasks:releasedTasks
 };
}

export function main(args=process.argv.slice(2)){
 const opts={command:null,workspaceRoot:null,stateDirectory:DEFAULT_LIVE_STATE,reason:'Operator released active slot via bridge-cli'};
 for(let i=0;i<args.length;i++){
  const arg=args[i],val=args[i+1];
  if(arg==='--workspace'&&val)opts.workspaceRoot=resolve(args[++i]);
  else if(arg==='--state'&&val)opts.stateDirectory=args[++i];
  else if(arg==='--reason'&&val)opts.reason=args[++i];
  else if(!arg.startsWith('--')&&opts.command===null)opts.command=arg;
  else throw Error('Unknown or incomplete option: '+arg);
 }
 const command=opts.command??'status';
 let out;
 if(command==='doctor'){
  out=bridgeDoctor({workspaceRoot:opts.workspaceRoot??ROOT,stateDirectory:opts.stateDirectory});
 }else if(command==='status'){
  const doctor=bridgeDoctor({workspaceRoot:opts.workspaceRoot??ROOT,stateDirectory:opts.stateDirectory});
  const metrics=bridgeMetrics({workspaceRoot:opts.workspaceRoot,stateDirectory:opts.stateDirectory});
  out={...doctor,metrics};
 }else if(command==='metrics'){
  out=bridgeMetrics({workspaceRoot:opts.workspaceRoot,stateDirectory:opts.stateDirectory});
 }else if(command==='release-stuck'){
  out=releaseStuckJobs({workspaceRoot:opts.workspaceRoot,stateDirectory:opts.stateDirectory,reason:opts.reason});
 }else{
  throw Error(`Unknown bridge-cli command: ${command} (expected doctor|status|metrics|release-stuck)`);
 }
 process.stdout.write(JSON.stringify(out,null,2)+'\n');
 return out;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{main();}
 catch(error){process.stderr.write(JSON.stringify({ok:false,error:error.message})+'\n');process.exitCode=1;}
}
