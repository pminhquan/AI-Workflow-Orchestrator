import {isAbsolute, resolve} from 'node:path';
import {canonicalWorkspace} from './contracts.mjs';

const keys = ['schema_version','enabled','workspace_root','project_id','conversation_mode',
  'conversation_id','runtime_version','poll_interval_ms','transport_timeout_ms','review'];
const reviewFlags = ['authorization','runtime','project','conversation','user_opt_in'];
const references = ['authorization_reference','runtime_reference','project_reference','conversation_reference'];
const opaqueId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const equalPath = (a,b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function exact(object, allowed) {
  if (!object || typeof object !== 'object' || Array.isArray(object) ||
      Object.keys(object).length !== allowed.length || allowed.some(key => !Object.hasOwn(object,key))) {
    throw Error('Malformed binding: unexpected or missing fields');
  }
}

export function validateBinding(binding) {
  exact(binding,keys);
  if (binding.schema_version !== 'desktop-inbox.binding@1' || typeof binding.enabled !== 'boolean') throw Error('Invalid binding version/enabled');
  if (typeof binding.workspace_root !== 'string' || !isAbsolute(binding.workspace_root) ||
      !equalPath(resolve(binding.workspace_root),canonicalWorkspace(binding.workspace_root)) ||
      !equalPath(binding.workspace_root,resolve(binding.workspace_root))) throw Error('Binding requires canonical workspace');
  if (!opaqueId(binding.project_id)) throw Error('Binding requires a stable project ID');
  if (binding.enabled && binding.project_id === 'REVIEW_REQUIRED') throw Error('Placeholder project is not a binding');
  if (!['existing','new'].includes(binding.conversation_mode)) throw Error('Unsupported conversation mode');
  if (binding.conversation_mode === 'existing' && !opaqueId(binding.conversation_id)) throw Error('Existing conversation ID is missing or invalid; focus discovery is unsupported');
  if (binding.conversation_mode === 'new' && binding.conversation_id !== null) throw Error('New conversation mode cannot claim an existing conversation');
  if (typeof binding.runtime_version !== 'string' || !/^\d+\.\d+\.\d+$/.test(binding.runtime_version)) throw Error('Invalid runtime version');
  if (!Number.isInteger(binding.poll_interval_ms) || binding.poll_interval_ms < 1000 || binding.poll_interval_ms > 60000) throw Error('Invalid poll interval');
  if (!Number.isInteger(binding.transport_timeout_ms) || binding.transport_timeout_ms < 10 || binding.transport_timeout_ms > 30000) throw Error('Invalid transport timeout');
  exact(binding.review,[...reviewFlags,...references]);
  if (reviewFlags.some(key => typeof binding.review[key] !== 'boolean') || references.some(key => typeof binding.review[key] !== 'string' || binding.review[key].length > 1000)) throw Error('Malformed review evidence');
  return structuredClone(binding);
}

export function activationBlockers(binding) {
  // No app/session discovery, no permission expansion and no implicit opt-in.
  const blockers = [];
  if (!binding.enabled) blockers.push('Candidate disabled');
  for (const flag of reviewFlags) {
    if (flag === 'conversation' && binding.conversation_mode === 'new') continue;
    if (!binding.review[flag]) blockers.push('Review required: '+flag);
  }
  for (const key of references) {
    if (key === 'conversation_reference' && binding.conversation_mode === 'new') continue;
    if (!binding.review[key].trim()) blockers.push('Evidence required: '+key);
  }
  // Vendor docs do not specify a receipt/target identity contract for 2.29.0.
  // Do not turn editable booleans into proof of compatibility or authorization.
  blockers.push('Live transport remains unsupported in this foundation build; reviewed installed-runtime and policy integration is required');
  return blockers;
}

export function validateCapabilities(request = {}) {
  const allowed = new Set(['conversation_mode','hard_filesystem_isolation','stop_running_agent']);
  if (Object.keys(request).some(key => !allowed.has(key))) throw Error('Unsupported capability constraint');
  if (request.hard_filesystem_isolation || request.stop_running_agent || request.conversation_mode === 'focused') throw Error('UNSUPPORTED: hard isolation, native cancellation or focused-chat discovery');
  if (request.conversation_mode && !['existing','new'].includes(request.conversation_mode)) throw Error('Unsupported conversation mode');
  return {status:'OFFLINE-TESTED',live_dispatch:false,hard_filesystem_isolation:false,stop_running_agent:false};
}
