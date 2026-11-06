import {randomUUID} from 'node:crypto';
import {lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {requireValid} from '../core/schema.mjs';
import {safeRelative,scopedPath,inScope} from '../core/util.mjs';

export const MAX_JOB_BYTES=8192;
export const MAX_REPORT_BYTES=32768;
export const MAX_JOB_AGE_MS=10*60*1000;
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const secretPatterns=[/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,/\bAIza[\w-]{35}\b/,/\bgh[pousr]_[A-Za-z0-9]{20,}\b/,/\bsk-[A-Za-z0-9_-]{24,}\b/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/(?:authorization\s*[:=]\s*bearer|aws_secret_access_key\s*[:=])\s*[A-Za-z0-9/+_=.-]{8,}/i];
const privateComponent=/^(?:\.git|\.aws|\.ssh|\.gemini|\.codex|\.antigravity|\.azure|\.gcp|\.config|\.netrc|\.npmrc|\.pypirc|\.env(?:\..*)?|id_rsa.*|id_ed25519.*)$/i;
const privateFile=/^(?:\.?(?:credentials?|tokens?|cookies?|cookiejar|auth(?:entication)?|oauth|secrets?|keyring)(?:[-_.][A-Za-z0-9_-]+)*\.(?:json|jsonl|ya?ml|toml|ini|cfg|conf|txt)|application_default_credentials\.json|mcp_config\.json|bridge\.config\.json)$/i;
const bareCredentialStore=/^(?:credentials?|tokens?|cookies?|cookiejar|keyring)$/i;
const privateRuntimeRoot=/^(?:sessions?|transcripts?|cookies?|credentials?|tokens?|keyring)$/i;
// Protect known credential/runtime paths, not source identifiers such as
// auth.js, tokenizer.py, token_utils.py or src/auth/handlers.js.
export const isSensitivePath=(path,{directory=false}={})=>{
 const parts=path.split('/');
 if(parts.some(part=>privateComponent.test(part)||/\.(?:pem|key|sqlite\d*|db|p12|pfx|kdbx)$/i.test(part)))return true;
 if(privateRuntimeRoot.test(parts[0]))return true;
 const leaf=parts.at(-1);
 return privateFile.test(leaf)||(!directory&&bareCredentialStore.test(leaf));
};

export function boundedJSON(value,limit,label='Payload'){
 let text;try{text=JSON.stringify(value);}catch{throw Error(label+' is not serializable JSON');}
 if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>limit)throw Error(label+' size limit exceeded');
 return text;
}
export function noKnownSecrets(value){
 if(secretPatterns.some(pattern=>pattern.test(JSON.stringify(value))))throw Error('Known credential/secret pattern rejected');
 // Detection is deliberately bounded; callers must also review inputs for arbitrary secrets.
}
export function canonicalWorkspace(root){
 if(typeof root!=='string'||root!==root.trim()||/[\x00-\x1f\x7f]/.test(root)||!isAbsolute(root)||/(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(root)||root.startsWith('\\\\')||root.startsWith('//'))throw Error('Workspace must be an absolute canonical local directory');
 const resolved=resolve(root),actual=realpathSync(root);
 const normalized=value=>process.platform==='win32'?value.toLowerCase():value;
 if(normalized(resolved)!==normalized(actual)||!lstatSync(actual).isDirectory()||lstatSync(resolved).isSymbolicLink())throw Error('Workspace aliases/links are unsupported');
 return actual;
}
export function sameWorkspace(left,right){const a=canonicalWorkspace(left),b=canonicalWorkspace(right);return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;}
export function validateScopePath(workspace,path){
 safeRelative(path);
 if(path.length>240||/[*?<>|"\x7f]/.test(path))throw Error('Sensitive or unsupported scope path');
 const full=scopedPath(workspace,path);
 if(isSensitivePath(path,{directory:lstatSync(full,{throwIfNoEntry:false})?.isDirectory()}))throw Error('Sensitive or unsupported scope path');
 return full;
}
// The parent fingerprints its explicitly managed project MCP configuration.
// This exception does not make private config available to worker read/write scopes.
export function validateSnapshotPath(workspace,path){
 if(path==='.codex/config.toml')return scopedPath(workspace,path);
 return validateScopePath(workspace,path);
}
function uniquePaths(paths){if(new Set(paths.map(path=>path.toLowerCase())).size!==paths.length)throw Error('Case-aliased duplicate scope path');}
export const reportRelativePath=job=>'tasks/'+job.task_id+'/report-'+job.attempt_id+'.json';
export const originalReportRelativePath=job=>'tasks/'+job.task_id+'/original-report-'+job.attempt_id+'.json';

export function validateJob(job,binding,{now=Date.now,checkFreshness=true}={}){
 boundedJSON(job,MAX_JOB_BYTES,'Job');requireValid(job,'desktop-inbox-job');noKnownSecrets(job);
 const workspace=canonicalWorkspace(binding.workspace_root);
 if(!sameWorkspace(job.workspace_root,workspace))throw Error('Wrong workspace binding');
 if(job.project_id!==binding.project_id)throw Error('Wrong project binding');
 if(job.expected_output!==reportRelativePath(job))throw Error('Output path does not match task and attempt');
 const created=Date.parse(job.created_at);
 if(!Number.isFinite(created)||new Date(created).toISOString()!==job.created_at)throw Error('Invalid created_at');
 if(checkFreshness&&(created>now()+30000||now()-created>MAX_JOB_AGE_MS))throw Error('Stale or future job');
 for(const paths of [job.read_scope,job.write_scope]){uniquePaths(paths);for(const path of paths)validateScopePath(workspace,path);}
 for(const text of [job.goal,...job.acceptance_criteria])if(!text.trim()||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))throw Error('Invalid task text');
 return job;
}
export function makeJob(binding,fields,{now=Date.now}={}){
 const job={schema_version:'desktop-inbox.job@1',task_id:randomUUID(),attempt_id:randomUUID(),workspace_root:canonicalWorkspace(binding.workspace_root),project_id:binding.project_id,created_at:new Date(now()).toISOString(),...fields};
 if(!Object.hasOwn(job,'expected_output'))job.expected_output=reportRelativePath(job);
 validateJob(job,binding,{now});return job;
}
export function normalizeReport(input,{legacyResultText}={}){
 boundedJSON(input,MAX_REPORT_BYTES,'Report');noKnownSecrets(input);
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Report must be an object');
 const report=structuredClone(input),has=key=>Object.hasOwn(input,key);
 for(const key of ['errors','evidence','blockers','completion_evidence']){
  if(has(key)&&(!Array.isArray(input[key])||input[key].length>32||input[key].some(item=>typeof item!=='string'||!item.length)))throw Error('Invalid report string array: '+key);
 }
 if(has('completion_evidence')){
  if(has('evidence')&&JSON.stringify(input.evidence)!==JSON.stringify(input.completion_evidence))throw Error('Conflicting evidence and completion_evidence');
  report.evidence=structuredClone(input.completion_evidence);delete report.completion_evidence;
 }
 if(!has('errors')){
  // Blockers are unmet prerequisites, not runtime errors. An empty blockers list
  // never supplies errors. Only this explicit legacy worker declaration may do so.
  const legacy=has('blockers')&&has('completion_evidence')&&input.schema_version==='desktop-inbox.report@1';
  const declarations=new Set(['Errors: NONE','Errors: []',
   'Không có lỗi phát sinh trong quá trình đọc `README.md` và tạo báo cáo kết quả.']);
  if(legacyResultText!==undefined&&(typeof legacyResultText!=='string'||Buffer.byteLength(legacyResultText,'utf8')>MAX_REPORT_BYTES))throw Error('Invalid legacy result text');
  const lines=typeof legacyResultText==='string'?legacyResultText.split(/\r?\n/).map(line=>line.trim().replace(/^-\s+/,'')):[];
  const explicit=lines.some(line=>declarations.has(line));
  const contradictory=lines.some(line=>/^Errors:/i.test(line)&&!declarations.has(line));
  if(!legacy||!explicit||contradictory)throw Error('Missing required errors; blockers is not an errors alias and no unambiguous legacy declaration was supplied');
  report.errors=[]; // A worker claim from result.md, not independently proven absence of errors.
 }
 requireValid(report,'desktop-inbox-report');return report;
}
export function validateReport(input,job,options={}){
 const report=normalizeReport(input,options);
 if(report.task_id!==job.task_id||report.attempt_id!==job.attempt_id)throw Error('Worker report task/attempt mismatch');
 if(!sameWorkspace(report.workspace,job.workspace_root))throw Error('Worker report workspace mismatch');
 for(const [paths,scope] of [[report.inspected_files,[...job.read_scope,...job.write_scope]],[report.changed_files,job.write_scope]]){
  uniquePaths(paths);for(const path of paths){validateScopePath(job.workspace_root,path);if(!inScope(path,scope))throw Error('Worker report path outside scope');}
 }
 if(report.status==='reported'&&!report.evidence.length)throw Error('Reported completion requires evidence');
 return report;
}
