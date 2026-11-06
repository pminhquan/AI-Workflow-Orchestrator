import {readFileSync,readdirSync,lstatSync,existsSync,statSync,realpathSync} from 'node:fs';
import {resolve,relative,basename,isAbsolute,delimiter} from 'node:path';
import {spawn} from 'node:child_process';
import {sha256,scopedPath,safeRelative,inScope} from '../core/util.mjs';
export function snapshot(workspace,inputs=null){
 const entries={};let count=0,bytes=0;
 function visit(name,explicit=false){
  const path=scopedPath(workspace,name);
  if(!existsSync(path)){entries[name]='missing';return;}
  const stat=lstatSync(path);
  if(stat.isDirectory()){
   if(!explicit&&['__pycache__','.pytest_cache'].includes(basename(name)))return;
   for(const child of readdirSync(path).sort())visit(name?name+'/'+child:child);return;
  }
  if(!stat.isFile())throw Error('Nonregular input');
  count++;bytes+=stat.size;if(count>2000||bytes>16*1024*1024)throw Error('Snapshot limit exceeded');
  entries[name]=sha256(readFileSync(path));
 }
 if(inputs)for(const name of [...inputs].sort())visit(safeRelative(name),true);
 else for(const name of readdirSync(workspace).sort())visit(name);
 return {entries,hash:sha256(entries)};
}
export function changedFiles(before,after){return [...new Set([...Object.keys(before.entries),...Object.keys(after.entries)])].filter(p=>before.entries[p]!==after.entries[p]).sort();}
export function verifyScope(actual,declared,scope){
 for(const p of [...actual,...declared]){safeRelative(p);if(!inScope(p,scope))throw Error('Out-of-scope write: '+p);}
 if(JSON.stringify([...actual].sort())!==JSON.stringify([...declared].sort()))throw Error('Report changed_files does not match actual workspace changes');
}
export const MAX_CHECK_TIMEOUT_MS=15*60*1000;

// Specs come only from reviewed host configuration, never task text or framework detection.
// Shell execution intentionally remains unsupported until a concrete reviewed need exists.
export function normalizeCheckSpec(spec){
 if(!spec||!Array.isArray(spec.args)||spec.args.some(x=>typeof x!=='string'||x.includes('\0'))||!Array.isArray(spec.inputs)||!spec.inputs.length||!Number.isInteger(spec.timeout_ms)||spec.timeout_ms<1||spec.timeout_ms>MAX_CHECK_TIMEOUT_MS)throw Error('Invalid registered check');
 if(spec.executable!==undefined&&(typeof spec.executable!=='string'||!spec.executable.trim()||/[\x00-\x1f]/.test(spec.executable)))throw Error('Invalid registered executable');
 if(spec.executable!==undefined&&!isAbsolute(spec.executable)&&!/^[A-Za-z0-9._+-]+$/.test(spec.executable))throw Error('Use an absolute registered executable path for project wrappers');
 if(spec.executable!==undefined&&/\.(?:cmd|bat)$/i.test(spec.executable))throw Error('Shell scripts are unsupported with shell:false; register a reviewed native executable and args');
 if(spec.shell!==undefined&&spec.shell!==false)throw Error('Shell checks require a separately reviewed implementation; use executable + args with shell:false');
 spec.inputs.forEach(safeRelative);
 return {...(spec.executable!==undefined?{executable:spec.executable}:{}),args:[...spec.args],inputs:[...spec.inputs],timeout_ms:spec.timeout_ms,cacheable:spec.cacheable===true,shell:false};
}

export function resolveCheckExecutable(spec){
 const name=spec.executable??process.execPath;
 if(isAbsolute(name))return name;
 const pathKey=Object.keys(process.env).find(key=>key.toUpperCase()==='PATH');
 const extensions=process.platform==='win32'?['','.exe','.com']:[''];
 for(const directory of (process.env[pathKey]??'').split(delimiter)){
  // Never search cwd through an empty/relative PATH entry, even on Windows.
  if(!isAbsolute(directory))continue;
  for(const ext of extensions){
   const candidate=resolve(directory,name+ext);
   try{if(statSync(candidate).isFile())return realpathSync(candidate);}catch{}
  }
 }
 return null;
}

async function terminateCheckTree(child){
 if(!Number.isInteger(child.pid))return null;
 if(process.platform==='win32'){
  return new Promise(resolveCleanup=>{
   const killer=spawn(resolve(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});
   let done=false;
   const finish=error=>{if(done)return;done=true;clearTimeout(timer);if(error)child.kill('SIGKILL');resolveCleanup(error);};
   const timer=setTimeout(()=>{killer.kill();finish('PROCESS_TREE_CLEANUP_UNCONFIRMED');},2000);
   killer.once('error',()=>finish('PROCESS_TREE_CLEANUP_UNCONFIRMED'));
   killer.once('close',code=>finish(code===0?null:'PROCESS_TREE_CLEANUP_UNCONFIRMED'));
  });
 }
 try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code==='ESRCH')return null;return 'PROCESS_TREE_CLEANUP_UNCONFIRMED';}
 await new Promise(resolveWait=>setTimeout(resolveWait,250));
 try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')return 'PROCESS_TREE_CLEANUP_UNCONFIRMED';}
 return null;
}

export class CheckRunner{
 #receipts=new Map();
 constructor(specs,{now=Date.now}={}){this.specs=structuredClone(specs);this.now=now;this.executions=0;}
 spec(id){
  if(!Object.hasOwn(this.specs,id))throw Error('Unknown registered check '+id);
  return normalizeCheckSpec(this.specs[id]);
 }
 identity(workspace,id,executable=resolveCheckExecutable(this.spec(id))){
  const spec=this.spec(id);
  // Only a digest of the environment is retained: no credential values enter receipts.
  const environment_sha256=sha256(process.env);
  const nodeStat=lstatSync(process.execPath);
  return {input_hash:snapshot(workspace,spec.inputs).hash,spec_hash:sha256({spec,executable,node:process.version,platform:process.platform,arch:process.arch,environment_sha256,node_executable:{size:nodeStat.size,mtime:nodeStat.mtimeMs,ctime:nodeStat.ctimeMs,ino:nodeStat.ino}})};
 }
 isFresh(id,workspace,checkId){
  const receipt=this.#receipts.get(id);if(!receipt?.passed||receipt.workspace!==workspace||receipt.check_id!==checkId)return false;
  // Unknown external runtimes/toolchains are cheap to rerun and are never reused.
  if(this.spec(checkId).executable!==undefined)return false;
  const age=this.now()-receipt.executed_at;if(age<0||age>3600000)return false;
  const fingerprint=this.identity(workspace,checkId);return receipt.input_hash===fingerprint.input_hash&&receipt.spec_hash===fingerprint.spec_hash;
 }
 async run(workspace,id){
  const spec=this.spec(id),executable=resolveCheckExecutable(spec),before=this.identity(workspace,id,executable);
  if(spec.cacheable)for(const old of this.#receipts.values())if(this.isFresh(old.id,workspace,id))return {...old,reused:true,execution_ms:0};
  this.executions++;const started=this.now();let output='';
  const outcome=executable===null?{exit_code:null,timed_out:false,spawn_error:'ENOENT'}:await new Promise(resolveResult=>{
   let timeout=false,error=null,cleanupError=null,cleanup=Promise.resolve(),settled=false,hardStop;
   const child=spawn(executable,spec.args,{cwd:workspace,windowsHide:true,shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
   const capture=data=>{output=(output+data).slice(-8000);};
   child.stdout.on('data',capture);child.stderr.on('data',capture);
   const finish=async exit_code=>{
    if(settled)return;settled=true;clearTimeout(timer);await cleanup;clearTimeout(hardStop);
    resolveResult({exit_code,timed_out:timeout,spawn_error:error,...(cleanupError?{cleanup_error:cleanupError}:{})});
   };
   const timer=setTimeout(()=>{
    timeout=true;
    cleanup=terminateCheckTree(child).then(value=>{cleanupError=value;});
    // Lost descendant pipes must not keep a timed-out check unresolved forever.
    hardStop=setTimeout(()=>{cleanupError='PROCESS_TREE_CLEANUP_UNCONFIRMED';child.stdout.destroy();child.stderr.destroy();child.unref();void finish(null);},2500);
   },spec.timeout_ms);
   child.once('error',e=>{error=e.code??'SPAWN_ERROR';});
   child.once('close',exit_code=>{void finish(exit_code);});
  });
  const after=this.identity(workspace,id),stable=after.input_hash===before.input_hash&&after.spec_hash===before.spec_hash;
  const receipt={id:sha256({workspace,id,before,started,sequence:this.#receipts.size}),workspace,check_id:id,...before,...outcome,passed:outcome.exit_code===0&&!outcome.timed_out&&!outcome.spawn_error&&!outcome.cleanup_error&&stable,stable_inputs:stable,executed_at:started,execution_ms:this.now()-started,reused:false,output};
  this.#receipts.set(receipt.id,receipt);return {...receipt};
 }
}
