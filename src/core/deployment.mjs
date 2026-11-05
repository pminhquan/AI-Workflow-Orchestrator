import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT,readJSON,sha256,scopedPath} from './util.mjs';
export function manifest(){return readJSON(resolve(ROOT,'config/deployment/components.json'));}
export function inventory(){
 return manifest().components.map(component=>{
  const source=component.canonical_source_path?scopedPath(ROOT,component.canonical_source_path):null;
  const sourceHash=source&&existsSync(source)?sha256(readFileSync(source)):null;
  const target=component.installed_target_path;
  const exists=target?existsSync(target):false;
  // Read only declared file targets. Never read directories, live ledger or auth stores.
  const targetHash=exists&&component.management!=='app-owned'?sha256(readFileSync(target)):null;
  return {...component,current_source_hash:sourceHash,current_target_hash:targetHash,installation_status:component.management==='app-owned'?'app-owned':exists?'existing-V1-or-unmanaged':'not-installed',drift_status:component.management==='app-owned'?'not-inspected':component.content_hash&&targetHash===component.content_hash?'baseline-matches':targetHash?'drift-or-different-version':'target-absent'};
 });
}
export function diffConfig(){return {dry_run:true,changes:inventory().map(c=>({component:c.logical_component,source:c.canonical_source_path,target:c.installed_target_path,baseline_hash:c.content_hash,current_hash:c.current_target_hash,proposed_hash:c.management==='staged'?c.current_source_hash:null,drift:c.drift_status,equal:c.management==='staged'&&c.current_source_hash!==null&&c.current_source_hash===c.current_target_hash,method:c.deployment_method,proposal:c.management==='staged'?{status:'staging-only; NOT VERIFIED',content:readFileSync(scopedPath(ROOT,c.canonical_source_path),'utf8')}:null}))};}
export function planInstall(){const components=inventory();return {dry_run:true,activation:'BLOCKED',reason:'Foundation only; no installer implemented. Explicit future activation, verified runtime controls, backup, diff and rollback are required.',protected_components:components.filter(c=>c.management!=='staged').map(c=>c.logical_component),steps:components.filter(c=>c.management==='staged').map(c=>({component:c.logical_component,source:c.canonical_source_path,target:c.installed_target_path,source_hash:c.current_source_hash,action:'review-only; no copy or reload',permission_requirements:c.permission_requirements,rollback_method:c.rollback_method}))};}
export function rollbackPlan(){return {dry_run:true,changes_made_to_live:0,action:'No live rollback needed for this foundation build.',future_steps:['Stop new V2 submissions through supported runtime controls.','Retain task evidence and inspect in-flight work before cancellation.','Compare installed hashes with pre-activation backup manifest.','Restore only owned changed sections after checking concurrent user edits.','Verify V1 source/config checksums and supported runtime health.','Never overwrite app-owned auth, sessions, permissions or the V1 ledger.']};}
export function verifyV1(){
 const before=readJSON(resolve(ROOT,'legacy/v1-inventory.json'));
 const files=before.files.map(f=>({path:f.path,exists:existsSync(f.path),unchanged:existsSync(f.path)&&sha256(readFileSync(f.path))===f.sha256}));
 return {status:files.every(f=>f.unchanged)?'PASS':'DRIFT',files,runtime_state:'not read or compared; app-owned and volatile'};
}
