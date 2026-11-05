import {readFileSync,readdirSync,lstatSync,existsSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {spawn} from 'node:child_process';
import {sha256,scopedPath,safeRelative,inScope} from '../core/util.mjs';
export function snapshot(workspace,inputs=null){
 const entries={};let count=0,bytes=0;
 function visit(name){
  const path=scopedPath(workspace,name);
  if(!existsSync(path)){entries[name]='missing';return;}
  const stat=lstatSync(path);
  if(stat.isDirectory()){for(const child of readdirSync(path).sort())visit(name?name+'/'+child:child);return;}
  if(!stat.isFile())throw Error('Nonregular input');
  count++;bytes+=stat.size;if(count>2000||bytes>16*1024*1024)throw Error('Snapshot limit exceeded');
  entries[name]=sha256(readFileSync(path));
 }
 if(inputs)for(const name of [...inputs].sort())visit(safeRelative(name));
 else for(const name of readdirSync(workspace).sort())visit(name);
 return {entries,hash:sha256(entries)};
}
export function changedFiles(before,after){return [...new Set([...Object.keys(before.entries),...Object.keys(after.entries)])].filter(p=>before.entries[p]!==after.entries[p]).sort();}
export function verifyScope(actual,declared,scope){
 for(const p of [...actual,...declared]){safeRelative(p);if(!inScope(p,scope))throw Error('Out-of-scope write: '+p);}
 if(JSON.stringify([...actual].sort())!==JSON.stringify([...declared].sort()))throw Error('Report changed_files does not match actual workspace changes');
}
export class CheckRunner{
 #receipts=new Map();
 constructor(specs,{now=Date.now}={}){this.specs=structuredClone(specs);this.now=now;this.executions=0;}
 spec(id){
  if(!Object.hasOwn(this.specs,id))throw Error('Unknown registered check '+id);
  const spec=this.specs[id];
  if(!Array.isArray(spec.args)||spec.args.some(x=>typeof x!=='string')||!spec.inputs?.length||!Number.isInteger(spec.timeout_ms)||spec.timeout_ms<1||spec.timeout_ms>5000)throw Error('Invalid registered check');
  spec.inputs.forEach(safeRelative);return spec;
 }
 identity(workspace,id){const spec=this.spec(id);return {input_hash:snapshot(workspace,spec.inputs).hash,spec_hash:sha256({spec,executable:process.execPath,node:process.version,platform:process.platform})};}
 isFresh(id,workspace,checkId){
  const receipt=this.#receipts.get(id);if(!receipt?.passed||receipt.workspace!==workspace||receipt.check_id!==checkId)return false;
  const age=this.now()-receipt.executed_at;if(age<0||age>3600000)return false;
  const fingerprint=this.identity(workspace,checkId);return receipt.input_hash===fingerprint.input_hash&&receipt.spec_hash===fingerprint.spec_hash;
 }
 async run(workspace,id){
  const spec=this.spec(id),before=this.identity(workspace,id);
  if(spec.cacheable)for(const old of this.#receipts.values())if(this.isFresh(old.id,workspace,id))return {...old,reused:true,execution_ms:0};
  this.executions++;const started=this.now();let output='';
  const outcome=await new Promise(resolveResult=>{
   let timeout=false,error=null;
   const child=spawn(process.execPath,spec.args,{cwd:workspace,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
   const capture=data=>{output=(output+data).slice(-8000);};
   child.stdout.on('data',capture);child.stderr.on('data',capture);
   const timer=setTimeout(()=>{timeout=true;child.kill();},spec.timeout_ms);
   child.on('error',e=>{error=e.code;});
   child.on('close',exit_code=>{clearTimeout(timer);resolveResult({exit_code,timed_out:timeout,spawn_error:error});});
  });
  const after=this.identity(workspace,id),stable=after.input_hash===before.input_hash;
  const receipt={id:sha256({workspace,id,before,started,sequence:this.#receipts.size}),workspace,check_id:id,...before,...outcome,passed:outcome.exit_code===0&&!outcome.timed_out&&!outcome.spawn_error&&stable,stable_inputs:stable,executed_at:started,execution_ms:this.now()-started,reused:false,output};
  this.#receipts.set(receipt.id,receipt);return {...receipt};
 }
}
