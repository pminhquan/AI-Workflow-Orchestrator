import {existsSync} from 'node:fs';
import {ROOT,scopedPath,sha256} from '../core/util.mjs';
import {UUID} from './contracts.mjs';
import {DEFAULT_LIVE_STATE,checkedStateDirectory,atomicWriteJSON,readBoundedJSON} from './live-bridge.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function selectionPath(stateDirectory){return scopedPath(ROOT,`${checkedStateDirectory(stateDirectory)}/selected-receiver.json`);}

// This is an explicit persistent recipient choice, not a Hook Beacon or proof
// of GUI focus. It is created only from a real, independently verified delivery.
export function selectVerifiedReceiver(record,{stateDirectory=DEFAULT_LIVE_STATE,now=Date.now}={}){
 if(record.state!=='VERIFIED'||record.outcome!==null||record.host_receipt?.accepted!==true||record.delivery?.kind!=='ANTIGRAVITY_AGENTAPI'||record.delivery.exit_code!==0||record.delivery.started!==true||!ID.test(record.delivery.target_conversation_id??''))throw Error('Receiver selection requires an actually delivered, parent-VERIFIED job');
 const selected={format:'desktop-inbox.selected-receiver@1',enabled:true,conversation_id:record.delivery.target_conversation_id,selected_at:new Date(now()).toISOString(),verified_task_id:record.job.task_id,verified_attempt_id:record.job.attempt_id,host_receipt_sha256:sha256(record.host_receipt),proves_gui_focus:false};
 atomicWriteJSON(selectionPath(stateDirectory),selected);return selected;
}

export function readSelectedReceiver({stateDirectory=DEFAULT_LIVE_STATE}={}){
 const path=selectionPath(stateDirectory);
 if(!existsSync(path))return null;
 const selected=readBoundedJSON(path,4096);
 try{assertSelectionProof(selected);}catch{throw Error('SELECTED_RECEIVER_INVALID: inspect the saved recipient choice');}
 return selected;
}

export function resolveEffectiveReceiver(readiness,selected){
 if(!selected)return null;
 if(readiness?.target_observation?.bound&&readiness?.target_observation?.fresh&&readiness?.active_gui_target?.conversation_id){
  const activeMs=Date.parse(readiness.active_gui_target.updated_at);
  const selectedMs=Date.parse(selected.selected_at);
  if(Number.isFinite(activeMs)&&Number.isFinite(selectedMs)&&activeMs>selectedMs){
   return null;
  }
 }
 return selected;
}

export function selectedReadiness(readiness,selected){
 const effective=resolveEffectiveReceiver(readiness,selected);
 if(!effective)return readiness;
 const reason_codes=readiness.reason_codes.filter(code=>!code.startsWith('TARGET_'));
 return {...readiness,reason_codes,ready_to_dispatch:reason_codes.length===0,readiness_status:reason_codes.length?'NOT_READY':'READY_TO_DISPATCH',delivery_target:{mode:'user_selected_receiver',conversation_id:effective.conversation_id,selected_at:effective.selected_at,verified_task_id:effective.verified_task_id,proves_gui_focus:false,workspace_match_required:false}};
}

export function refreshSelectedReceiverOnBeacon(conversationId,{stateDirectory=DEFAULT_LIVE_STATE,eventTimestamp=null,now=Date.now}={}){
 if(typeof conversationId!=='string'||!ID.test(conversationId.trim()))return null;
 const path=selectionPath(stateDirectory);
 if(!existsSync(path))return null;
 try{
  const current=readBoundedJSON(path,4096);
  assertSelectionProof(current);
  const nextIso=typeof eventTimestamp==='string'&&Number.isFinite(Date.parse(eventTimestamp))?new Date(Date.parse(eventTimestamp)).toISOString():new Date(now()).toISOString();
  if(Date.parse(nextIso)<Date.parse(current.selected_at))return current;
  const updated={...current,conversation_id:conversationId.trim(),selected_at:nextIso};
  assertSelectionProof(updated);
  atomicWriteJSON(path,updated);
  return updated;
 }catch{
  return null;
 }
}

function routePath(inbox,job){return scopedPath(inbox.root,`delivery-targets/${job.task_id}-${job.attempt_id}.json`);}
const SELECTION_FORMAT='desktop-inbox.selected-receiver@1';
const ROUTE_V1='desktop-inbox.delivery-target@1';
const ROUTE_V2='desktop-inbox.delivery-target@2';
// Full proof-field validation, used for version-2 routes.
function assertSelectionProof(selection){
  if(!selection||typeof selection!=='object'||Array.isArray(selection)||selection.format!==SELECTION_FORMAT||selection.enabled!==true||selection.proves_gui_focus!==false||!ID.test(selection.conversation_id??'')||!UUID.test(selection.verified_task_id??'')||!UUID.test(selection.verified_attempt_id??'')||!/^[a-f0-9]{64}$/.test(selection.host_receipt_sha256??'')||typeof selection.selected_at!=='string'||!Number.isFinite(Date.parse(selection.selected_at))||new Date(Date.parse(selection.selected_at)).toISOString()!==selection.selected_at)throw Error('Invalid bound delivery target: incomplete or invalid selection proof');
}
// New routes freeze the selection with a checksum. This detects accidental
// corruption or edits; it is not cryptographic authentication or a sandbox.
export function bindSelectedReceiver(inbox,job,selected){
  if(!selected)return;
  assertSelectionProof(selected);
  const selection=structuredClone(selected);
  atomicWriteJSON(routePath(inbox,job),{format:ROUTE_V2,task_id:job.task_id,attempt_id:job.attempt_id,job_sha256:sha256(job),selection,selection_sha256:sha256(selection)},{exclusive:true});
}
export function readJobReceiver(inbox,job){
  const path=routePath(inbox,job);if(!existsSync(path))return null;
  const route=readBoundedJSON(path,4096);
  const bound=route?.task_id===job.task_id&&route.attempt_id===job.attempt_id&&route.job_sha256===sha256(job);
  if(route?.format===ROUTE_V1){
   // Read compatibility for routes written before checksums existed.
   if(!bound||route.selection?.format!==SELECTION_FORMAT||!ID.test(route.selection.conversation_id??''))throw Error('Invalid bound delivery target');
   assertSelectionProof(route.selection);
   return route.selection;
  }
  if(route?.format!==ROUTE_V2||!bound)throw Error('Invalid bound delivery target');
  assertSelectionProof(route.selection);
  if(route.selection_sha256!==sha256(route.selection))throw Error('Invalid bound delivery target: selection checksum mismatch');
  return route.selection;
}
