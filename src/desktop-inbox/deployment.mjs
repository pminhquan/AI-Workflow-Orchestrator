import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT,canonical,sha256} from '../core/util.mjs';

export const SIDECAR_ID = 'desktop-inbox-candidate';
export const APP_RECEIVER_ID = 'codex-inbox-once';
const candidateFiles = ['sidecar.json','binding.example.json','config.fragment.json'];
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

export function validateManifest(manifest) {
  const allowed = ['command','builtin','args','restart_policy','description','env','display_name'];
  if (!plain(manifest) || Object.keys(manifest).some(key=>!allowed.includes(key)) ||
      Number(Object.hasOwn(manifest,'command'))+Number(Object.hasOwn(manifest,'builtin')) !== 1 ||
      (manifest.command !== undefined && (typeof manifest.command !== 'string' || !manifest.command.trim())) ||
      (manifest.builtin !== undefined && manifest.builtin !== 'schedule') ||
      (manifest.args !== undefined && (!Array.isArray(manifest.args) || manifest.args.some(arg=>typeof arg !== 'string'))) ||
      (manifest.restart_policy !== undefined && !['always','on-failure','never'].includes(manifest.restart_policy)) ||
      (manifest.env !== undefined && (!plain(manifest.env) || Object.values(manifest.env).some(value=>typeof value !== 'string')))) throw Error('Unsupported documented Sidecar manifest');
  for (const key of ['description','display_name']) if (manifest[key] !== undefined && typeof manifest[key] !== 'string') throw Error('Invalid manifest text');
  return structuredClone(manifest);
}

// Plan only. No global reads, writes, backup copies, application reload or install.
export function deploymentPlan() {
  const files = candidateFiles.map(name=>{
    const source = resolve(ROOT,'integrations/antigravity-inbox',name);
    return {source,sha256:sha256(readFileSync(source)),action:'REVIEW ONLY; not copied'};
  });
  const manifest = validateManifest(JSON.parse(readFileSync(files[0].source,'utf8')));
  const sourceFiles = ['binding.mjs','cli.mjs','contracts.mjs','deployment.mjs','inbox.mjs','sidecar.mjs','sidecar-runner.mjs','verification.mjs'];
  for (const name of sourceFiles) {
    const source = resolve(ROOT,'src/desktop-inbox',name);
    files.push({source,sha256:sha256(readFileSync(source)),action:'REVIEW ONLY; canonical dependency'});
  }
  for (const name of ['desktop-inbox-job','desktop-inbox-report']) {
    const source = resolve(ROOT,'workflows/schemas',name+'.schema.json');
    files.push({source,sha256:sha256(readFileSync(source)),action:'REVIEW ONLY; canonical dependency'});
  }
  for (const name of ['src/core/util.mjs','src/core/schema.mjs','src/verification/checks.mjs']) {
    const source = resolve(ROOT,name);
    files.push({source,sha256:sha256(readFileSync(source)),action:'REVIEW ONLY; existing trusted dependency'});
  }
  return {status:'BLOCKED',sidecar_id:SIDECAR_ID,install:false,enable:false,live_dispatch:false,
    manifest,files,global_targets:['~/.gemini/config/sidecars/'+SIDECAR_ID+'/sidecar.json','~/.gemini/config/config.json:sidecars.'+SIDECAR_ID],
    required_gates:['Official account/terms clarification for Codex-inbox App-owned Sidecar',
      'Installed 2.29.0 documented runtime/target contract evidence',
      'Reviewed canonical workspace and real App project ID',
      'Existing mode: supported stable conversation ID plus matching-project proof; otherwise STOP this mode',
      'New mode: separately approved new App conversation with matching configured projectId; never claim focused chat',
      'Explicit activation scope and backup/checksum/diff/rollback review',
      'Separate approval for exactly one harmless read-only real pilot'],
    backup_plan:'Before any future mutation: app-owned config backup outside Git, exact owned section/files manifest and hashes; never overwrite or export auth/session state into this repo.',
    rollback_plan:'Disable only this owned Sidecar through supported controls; retain in-flight uncertainty. Remove only unchanged owned additions. Preserve other sidecars, settings and concurrent edits. Do not claim a running agent was stopped.'};
}

// Project-specific App receiver staging. This is deliberately not an installer;
// project proof, exact config backup/diff and a narrow approval precede any copy.
export function appReceiverPlan() {
 const names=['integrations/antigravity-inbox/app-receiver.sidecar.json',
  'integrations/antigravity-inbox/app-receiver.config.fragment.DISABLED.json',
  'integrations/antigravity-inbox/app-binding.json',
  'src/desktop-inbox/mcp-server.mjs','src/desktop-inbox/app-receiver.mjs','src/desktop-inbox/result-watcher.mjs'];
 const files=names.map(name=>({source:resolve(ROOT,name),sha256:sha256(readFileSync(resolve(ROOT,name)))}));
 return {status:'STAGED; PROJECT BINDING REQUIRED',sidecar_id:APP_RECEIVER_ID,install:false,enable:false,
  manifest:validateManifest(JSON.parse(readFileSync(files[0].source,'utf8'))),files,
  owned_targets:['~/.gemini/config/sidecars/'+APP_RECEIVER_ID+'/sidecar.json',
   '~/.gemini/config/config.json:sidecars.'+APP_RECEIVER_ID],
  backup:'Before approved activation: hash the current App config and save an ACL-preserving backup beside it; preserve all other keys. Abort on an existing receiver ID or changed reviewed hash. Never copy auth/session data into this repository.',
  sequence:['Parent reviews official App evidence of project ID and canonical local folder; records source hash and binding proof.',
   'Review runtime and supported use, prepare exact owned config diff, request only receiver installation/enablement.',
   'After approval and backup, queue exactly one job through MCP before enabling the one-shot receiver.',
   'App launches receiver through its supported lifecycle. Do not launch agentapi externally.',
   'After durable dispatch, run one cancellable result watcher; no redispatch.'],
  rollback:'Use existing rollbackRegistration/rollbackFilePlan with codex-inbox-once and activation hashes. Remove only unchanged owned additions; preserve concurrent changes and uncertain delivery. No App restart or worker-stop claim.'};
}

// Pure transformations for reviewed fixture/config planning. These helpers never
// open the real app config. A new ID cannot overwrite V1 or another user sidecar.
export function planRegistration(existing,entry,sidecarId = SIDECAR_ID) {
  if (!plain(existing) || !plain(entry) || ![SIDECAR_ID,APP_RECEIVER_ID].includes(sidecarId) ||
      Object.keys(entry).sort().join(',') !== 'enabled,projectId' || typeof entry.enabled !== 'boolean' ||
      typeof entry.projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry.projectId)||entry.projectId==='REVIEW_REQUIRED') throw Error('Invalid registration plan');
  if (existing.sidecars !== undefined && !plain(existing.sidecars)) throw Error('Sidecars section collision');
  if (Object.hasOwn(existing.sidecars ?? {},sidecarId)) throw Error('Existing Sidecar collision; preserve it');
  const after = structuredClone(existing);
  after.sidecars = {...after.sidecars,[sidecarId]:structuredClone(entry)};
  return {after,receipt:{sidecar_id:sidecarId,sidecars_previously_present:Object.hasOwn(existing,'sidecars'),installed_entry:structuredClone(entry)}};
}

export function rollbackRegistration(current,receipt) {
  if (!plain(current) || !plain(receipt) || ![SIDECAR_ID,APP_RECEIVER_ID].includes(receipt.sidecar_id) ||
      typeof receipt.sidecars_previously_present !== 'boolean' || !plain(receipt.installed_entry) ||
      !plain(current.sidecars) || !Object.hasOwn(current.sidecars,receipt.sidecar_id) ||
      canonical(current.sidecars[receipt.sidecar_id]) !== canonical(receipt.installed_entry)) throw Error('Rollback conflict: preserve concurrent or existing Sidecar edits');
  const result = structuredClone(current);
  delete result.sidecars[receipt.sidecar_id];
  if (!receipt.sidecars_previously_present && !Object.keys(result.sidecars).length) delete result.sidecars;
  return result;
}

export function rollbackFilePlan(currentHashes,ownedAddedHashes) {
  return Object.entries(ownedAddedHashes).map(([path,hash])=>({path,
    action:currentHashes[path] === hash ? 'REMOVE UNCHANGED OWNED ADDITION' :
      Object.hasOwn(currentHashes,path) ? 'CONFLICT; PRESERVE' : 'ALREADY ABSENT'}));
}
