import {existsSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {ROOT} from '../core/util.mjs';
import {canonicalWorkspace,sameWorkspace} from './contracts.mjs';
import {readBoundedBytes} from './verification.mjs';
import {
 DEFAULT_LIVE_STATE,
 activeTargetPath,
 checkedStateDirectory,
 existingLiveInbox,
 readTargetCandidates,
 resolveWorkspaceConfig,
 sidecarHeartbeatPath
} from './live-bridge.mjs';

export const HEARTBEAT_MAX_AGE_MS=15_000;
export const TARGET_OBSERVATION_TTL_MS=2*60*60*1000;

export const READINESS_REASONS=Object.freeze({
 HEARTBEAT_MISSING:'HEARTBEAT_MISSING',
 HEARTBEAT_MALFORMED:'HEARTBEAT_MALFORMED',
 SIDECAR_NOT_RUNNING:'SIDECAR_NOT_RUNNING',
 HEARTBEAT_FUTURE:'HEARTBEAT_FUTURE',
 HEARTBEAT_STALE:'HEARTBEAT_STALE',
 AGENTAPI_UNAVAILABLE:'AGENTAPI_UNAVAILABLE',
 LS_ADDRESS_MISSING:'LS_ADDRESS_MISSING',
 TARGET_MISSING:'TARGET_MISSING',
 TARGET_MALFORMED:'TARGET_MALFORMED',
 TARGET_FOREIGN_WORKSPACE:'TARGET_FOREIGN_WORKSPACE',
 TARGET_FOREIGN_PROJECT:'TARGET_FOREIGN_PROJECT',
 TARGET_FUTURE:'TARGET_FUTURE',
 TARGET_STALE:'TARGET_STALE',
 TARGET_AMBIGUOUS:'TARGET_AMBIGUOUS',
 WORKSPACE_SLOT_HELD:'WORKSPACE_SLOT_HELD'
});

const TARGET_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STRICT_ISO_TZ=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function isPlainObject(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const proto=Object.getPrototypeOf(value);
 return proto===Object.prototype||proto===null;
}

function resolveNowMs(now=Date.now){
 const value=typeof now==='function'?now():now;
 if(typeof value!=='number'||!Number.isFinite(value)){
  throw Error('Invalid clock value for readiness evaluation');
 }
 return value;
}

function isCleanAbsolutePath(value){
 if(typeof value!=='string'||!value.length||value!==value.trim())return false;
 if(/[\x00-\x1f]/.test(value))return false;
 if(!isAbsolute(value))return false;
 if(/(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(value))return false;
 return true;
}

export function isWorkspaceSlotHeld(record){
 if(!record||typeof record!=='object')return false;
 if(record.state==='VERIFIED'||record.outcome==='RELEASED')return false;
 if(record.outcome==='UNCERTAIN_DELIVERY')return true;
 if(record.outcome==='CANCELLED')return ['DISPATCHED','RESULT_READY'].includes(record.state);
 return record.outcome!=='FAILED';
}

export function parseStrictIsoMs(value){
 if(typeof value!=='string'||!value.length)return null;
 const ms=Date.parse(value);
 if(!Number.isFinite(ms))return null;
 if(new Date(ms).toISOString()===value)return ms;
 const match=STRICT_ISO_TZ.exec(value);
 if(!match)return null;
 const year=Number(match[1]);
 const month=Number(match[2]);
 const day=Number(match[3]);
 const hour=Number(match[4]);
 const minute=Number(match[5]);
 const second=Number(match[6]);
 const millis=match[7]?Number(match[7].padEnd(3,'0')):0;
 let offsetMinutes=0;
 if(match[8]!=='Z'){
  const sign=match[9]==='+'?1:-1;
  const offH=Number(match[10]);
  const offM=Number(match[11]);
  if(offH>23||offM>59)return null;
  offsetMinutes=sign*(offH*60+offM);
 }
 const check=new Date(ms+offsetMinutes*60_000);
 if(
  check.getUTCFullYear()!==year||
  check.getUTCMonth()+1!==month||
  check.getUTCDate()!==day||
  check.getUTCHours()!==hour||
  check.getUTCMinutes()!==minute||
  check.getUTCSeconds()!==second||
  check.getUTCMilliseconds()!==millis
 ){
  return null;
 }
 return ms;
}

export function evaluateBridgeReadiness({
 workspaceRoot=ROOT,
 projectId,
 allowNewConversation=false,
 heartbeat,
 heartbeatError=null,
 target,
 targetError=null,
 targetAmbiguous=false,
 records=[],
 now=Date.now,
 heartbeatMaxAgeMs=HEARTBEAT_MAX_AGE_MS,
 targetTtlMs=TARGET_OBSERVATION_TTL_MS
}={}){
 void allowNewConversation;
 if(typeof heartbeatMaxAgeMs!=='number'||!Number.isFinite(heartbeatMaxAgeMs)||heartbeatMaxAgeMs<=0){
  throw Error('heartbeatMaxAgeMs must be a positive finite number');
 }
 if(typeof targetTtlMs!=='number'||!Number.isFinite(targetTtlMs)||targetTtlMs<=0){
  throw Error('targetTtlMs must be a positive finite number');
 }
 const nowMs=resolveNowMs(now);
 const canonicalWs=canonicalWorkspace(workspaceRoot);
 const reasonCodes=[];

 let heartbeatValid=false;
 let heartbeatAgeMs=null;
 let sidecarRunning=false;

 if(heartbeatError){
  reasonCodes.push(READINESS_REASONS.HEARTBEAT_MALFORMED);
 }else if(heartbeat===null||heartbeat===undefined){
  reasonCodes.push(READINESS_REASONS.HEARTBEAT_MISSING);
 }else{
  const hbMs=isPlainObject(heartbeat)?parseStrictIsoMs(heartbeat.updated_at):null;
  if(
   !isPlainObject(heartbeat)||
   heartbeat.format!=='desktop-inbox.sidecar-heartbeat@1'||
   !Number.isInteger(heartbeat.pid)||
   heartbeat.pid<=0||
   typeof heartbeat.status!=='string'||
   !heartbeat.status.trim()||
   hbMs===null
  ){
   reasonCodes.push(READINESS_REASONS.HEARTBEAT_MALFORMED);
  }else{
   heartbeatValid=true;
   heartbeatAgeMs=nowMs-hbMs;
   if(heartbeat.status!=='RUNNING'){
    reasonCodes.push(READINESS_REASONS.SIDECAR_NOT_RUNNING);
   }
   if(heartbeatAgeMs<0){
    reasonCodes.push(READINESS_REASONS.HEARTBEAT_FUTURE);
   }else if(heartbeatAgeMs>=heartbeatMaxAgeMs){
    reasonCodes.push(READINESS_REASONS.HEARTBEAT_STALE);
   }
   sidecarRunning=heartbeat.status==='RUNNING'&&heartbeatAgeMs>=0&&heartbeatAgeMs<heartbeatMaxAgeMs;
   if(heartbeat.agentapi_available!==true){
    reasonCodes.push(READINESS_REASONS.AGENTAPI_UNAVAILABLE);
   }
   if(heartbeat.ls_address_present!==true){
    reasonCodes.push(READINESS_REASONS.LS_ADDRESS_MISSING);
   }
  }
 }

 let targetStructurallyValid=false;
 let targetValidAndBound=false;
 let targetFresh=false;
 let targetAgeMs=null;

 if(targetError){
  reasonCodes.push(READINESS_REASONS.TARGET_MALFORMED);
 }else if(target===null||target===undefined){
  reasonCodes.push(READINESS_REASONS.TARGET_MISSING);
 }else{
  const targetMs=isPlainObject(target)?parseStrictIsoMs(target.updated_at):null;
  if(
   !isPlainObject(target)||
   target.format!=='desktop-inbox.active-target@1'||
   typeof target.conversation_id!=='string'||
   !TARGET_ID.test(target.conversation_id)||
   !isCleanAbsolutePath(target.workspace_root)||
   typeof target.project_id!=='string'||
   !target.project_id.trim()||
   targetMs===null
  ){
   reasonCodes.push(READINESS_REASONS.TARGET_MALFORMED);
  }else{
   targetStructurallyValid=true;
   let workspaceBound=false;
   if(existsSync(target.workspace_root)){
    try{
     workspaceBound=sameWorkspace(target.workspace_root,canonicalWs);
    }catch{
     workspaceBound=false;
    }
   }
   if(!workspaceBound){
    reasonCodes.push(READINESS_REASONS.TARGET_FOREIGN_WORKSPACE);
   }
   let projectBound=true;
   if(typeof projectId==='string'&&projectId.length>0&&target.project_id!==projectId){
    projectBound=false;
    reasonCodes.push(READINESS_REASONS.TARGET_FOREIGN_PROJECT);
   }
   targetValidAndBound=workspaceBound&&projectBound;
   targetAgeMs=nowMs-targetMs;
   if(targetAgeMs<0){
    reasonCodes.push(READINESS_REASONS.TARGET_FUTURE);
   }else if(targetAgeMs>=targetTtlMs){
    reasonCodes.push(READINESS_REASONS.TARGET_STALE);
   }else{
    targetFresh=true;
   }
  }
 }

 const held=Array.isArray(records)?(records.find(isWorkspaceSlotHeld)??null):null;
 const slotAvailable=held===null;
 if(!slotAvailable){
  reasonCodes.push(READINESS_REASONS.WORKSPACE_SLOT_HELD);
 }

 if(targetAmbiguous)reasonCodes.push(READINESS_REASONS.TARGET_AMBIGUOUS);
 const readyToDispatch=reasonCodes.length===0;
 return {
  ready_to_dispatch:readyToDispatch,
  readiness_status:readyToDispatch?'READY_TO_DISPATCH':'NOT_READY',
  reason_codes:reasonCodes,
  slot_available:slotAvailable,
  active_task:held?{
   task_id:held.job.task_id,
   attempt_id:held.job.attempt_id,
   state:held.state,
   outcome:held.outcome,
   created_at:held.job.created_at
  }:null,
  sidecar_running:sidecarRunning,
  sidecar_agentapi_available:heartbeatValid&&typeof heartbeat.agentapi_available==='boolean'?heartbeat.agentapi_available:null,
  sidecar_ls_address_present:heartbeatValid&&typeof heartbeat.ls_address_present==='boolean'?heartbeat.ls_address_present:null,
  sidecar_code_version:heartbeatValid&&typeof heartbeat.code_version==='string'?heartbeat.code_version:null,
  heartbeat_age_ms:heartbeatAgeMs,
  heartbeat_max_age_ms:heartbeatMaxAgeMs,
  active_gui_target:targetValidAndBound&&!targetAmbiguous?target:null,
  target_age_ms:targetAgeMs,
  target_ttl_ms:targetTtlMs,
  target_observation:{
   present:target!==null&&target!==undefined&&!targetError,
   valid:targetStructurallyValid,
   bound:targetValidAndBound,
   fresh:targetFresh&&!targetAmbiguous,
   age_ms:targetAgeMs,
   ttl_ms:targetTtlMs,
   conversation_id:targetValidAndBound&&!targetAmbiguous?target.conversation_id:null,
   source:'hook_beacon_observation',
   proves_gui_focus:false
  }
 };
}

function readRawJsonFile(path,limit=8192){
 if(!existsSync(path))return {value:null,error:null};
 try{
  const bytes=readBoundedBytes(path,limit);
  const decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  const parsed=JSON.parse(decoded);
  if(parsed===null)return {value:null,error:'JSON root cannot be null'};
  return {value:parsed,error:null};
 }catch(error){
  return {value:null,error:error?.message??'Invalid JSON file'};
 }
}

export function inspectWorkspaceReadiness({
 workspaceRoot=ROOT,
 stateDirectory=DEFAULT_LIVE_STATE,
 records=null,
 now=Date.now,
 heartbeatMaxAgeMs=HEARTBEAT_MAX_AGE_MS,
 targetTtlMs=TARGET_OBSERVATION_TTL_MS
}={}){
 const checkedState=checkedStateDirectory(stateDirectory);
 const clockFn=typeof now==='function'?now:()=>now;
 resolveNowMs(clockFn);
 let config;
 let inboxRecords;
 if(records===null){
  const opened=existingLiveInbox(workspaceRoot,{stateDirectory:checkedState,now:clockFn});
  config=opened.config;
  inboxRecords=opened.inbox?opened.inbox.list():[];
 }else{
  config=resolveWorkspaceConfig(workspaceRoot,{stateDirectory:checkedState});
  inboxRecords=records;
 }
 const rawHeartbeat=readRawJsonFile(sidecarHeartbeatPath(checkedState),8192);
 const rawTarget=readRawJsonFile(activeTargetPath(config.workspace_root,checkedState),8192);
 const sampledNowMs=resolveNowMs(clockFn);
 let targetAmbiguous=false,candidateError=null;
 try{
  const activeMs=isPlainObject(rawTarget.value)?parseStrictIsoMs(rawTarget.value.updated_at):null;
  const candidates=readTargetCandidates(config.workspace_root,{stateDirectory:checkedState});
  const freshIds=new Set();
  for(const target of candidates){
   const checked=evaluateBridgeReadiness({workspaceRoot:config.workspace_root,projectId:config.slug,target,heartbeat:rawHeartbeat.value,now:sampledNowMs,targetTtlMs});
   if(checked.target_observation.bound&&checked.target_observation.fresh){
    const candidateMs=parseStrictIsoMs(target.updated_at);
    if(activeMs===null||(candidateMs!==null&&candidateMs>=activeMs)){
     freshIds.add(target.conversation_id);
    }
   }
  }
  targetAmbiguous=freshIds.size>1;
 }catch(error){candidateError=error.message;}
 const evaluation=evaluateBridgeReadiness({
  workspaceRoot:config.workspace_root,
  projectId:config.slug,
  allowNewConversation:config.allow_new_conversation,
  heartbeat:rawHeartbeat.value,
  heartbeatError:rawHeartbeat.error,
  target:rawTarget.value,
  targetError:rawTarget.error??candidateError,
  targetAmbiguous,
  records:inboxRecords,
  now:sampledNowMs,
  heartbeatMaxAgeMs,
  targetTtlMs
 });
 return {
  config,
  heartbeat:isPlainObject(rawHeartbeat.value)?rawHeartbeat.value:null,
  ...evaluation
 };
}
