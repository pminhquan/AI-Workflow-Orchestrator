import {withTransactionLock} from './transaction-lock.mjs';
import {randomUUID} from 'node:crypto';
import {openSync,closeSync,readSync,writeFileSync,fsyncSync,fstatSync,mkdirSync,renameSync,unlinkSync,linkSync,existsSync,readdirSync,lstatSync} from 'node:fs';
import {ROOT,scopedPath,safeRelative,sha256,inScope} from '../core/util.mjs';
import {UUID,canonicalWorkspace,sameWorkspace,validateJob,validateReport,validateScopePath,validateSnapshotPath,MAX_REPORT_BYTES,boundedJSON,noKnownSecrets,originalReportRelativePath} from './contracts.mjs';
import {validateParentReview} from './review-evidence.mjs';

const HASH=/^[a-f0-9]{64}$/;
const STATES=['PENDING','CLAIMED','DISPATCHED','RESULT_READY','VERIFIED'];
const OUTCOMES=[null,'FAILED','CANCELLED','UNCERTAIN_DELIVERY','RELEASED'];
const RECORD_LIMIT=1024*1024;
const clone=value=>structuredClone(value);
function id(value){if(typeof value!=='string'||!UUID.test(value))throw Error('Invalid task/claim ID');return value;}

function readBounded(path,limit){
 const fd=openSync(path,'r');
 try{
  const stat=fstatSync(fd);if(!stat.isFile()||stat.size>limit)throw Error('Nonregular or oversized inbox file');
  const buffer=Buffer.alloc(limit+1);let count=0,n;
  while(count<buffer.length&&(n=readSync(fd,buffer,count,buffer.length-count,null))>0)count+=n;
  if(count>limit)throw Error('Inbox file size limit exceeded');
  const raw=buffer.subarray(0,count);return {raw,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw))};
 }finally{closeSync(fd);}
}
function atomicWrite(path,value,{exclusive=false,raw=null}={}){
 const bytes=raw??Buffer.from(JSON.stringify(value,null,2)+'\n');
 const temp=path+'.tmp-'+randomUUID();let fd;
 try{
  fd=openSync(temp,'wx');writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;
  if(exclusive){linkSync(temp,path);unlinkSync(temp);}else renameSync(temp,path);
 }finally{
  if(fd!==undefined)closeSync(fd);
  if(existsSync(temp))unlinkSync(temp);
 }
}
function validateBaseline(baseline,workspace){
 if(!baseline)throw Error('Missing/invalid host baseline');
 boundedJSON(baseline,600000,'Baseline');
 if(!baseline||typeof baseline!=='object'||Array.isArray(baseline)||Object.keys(baseline).sort().join(',')!=='entries,hash'||!baseline.entries||typeof baseline.entries!=='object'||Array.isArray(baseline.entries)||!HASH.test(baseline.hash)||sha256(baseline.entries)!==baseline.hash)throw Error('Missing/invalid host baseline');
 if(Object.keys(baseline.entries).length>2000)throw Error('Baseline entry limit exceeded');
 for(const [path,hash] of Object.entries(baseline.entries)){validateSnapshotPath(workspace,path);if(hash!=='missing'&&!HASH.test(hash))throw Error('Invalid baseline hash');}
 return baseline;
}
function active(record){
 if(record.state==='VERIFIED'||record.outcome==='RELEASED')return false;
 if(record.outcome==='UNCERTAIN_DELIVERY')return true;
 if(record.outcome==='CANCELLED')return ['DISPATCHED','RESULT_READY'].includes(record.state);
 return record.outcome!=='FAILED';
}

// A file mailbox with transactional publication, not an agent scheduler or permission boundary.
export class Inbox{
 constructor(directory='state/desktop-inbox',binding,{now=Date.now}={}){
  safeRelative(directory);if(!directory.startsWith('state/')||directory==='state/')throw Error('Inbox must be under canonical state/');
  this.root=scopedPath(ROOT,directory);mkdirSync(this.root,{recursive:true});this.root=scopedPath(ROOT,directory);
  this.binding={workspace_root:canonicalWorkspace(binding.workspace_root),project_id:binding.project_id};
  if(typeof this.binding.project_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(this.binding.project_id))throw Error('Invalid project binding');
  this.now=now;this.lockPath=scopedPath(this.root,'transaction.lock');
  this.transaction(()=>{
   const path=scopedPath(this.root,'binding.json');
   if(existsSync(path)){
    const previous=readBounded(path,4096).value;
    if(Object.keys(previous).sort().join(',')!=='project_id,workspace_root'||previous.project_id!==this.binding.project_id||!sameWorkspace(previous.workspace_root,this.binding.workspace_root))throw Error('Inbox binding mismatch');
   }else atomicWrite(path,this.binding,{exclusive:true});
   mkdirSync(scopedPath(this.root,'tasks'),{recursive:true});
  });
 }
 transaction(fn){return withTransactionLock(this.lockPath,fn);}
 taskPath(taskId,name='record.json'){return scopedPath(this.root,'tasks/'+id(taskId)+'/'+safeRelative(name));}
 validateRecord(record){
  const keys=['format','job','state','outcome','claim_id','baseline','delivery','report_sha256','report_original_path','host_receipt','events'];
  boundedJSON(record,RECORD_LIMIT,'Record');
  if(!record||typeof record!=='object'||Object.keys(record).sort().join(',')!==keys.sort().join(',')||record.format!=='desktop-inbox.record@1'||!STATES.includes(record.state)||!OUTCOMES.includes(record.outcome)||!Array.isArray(record.events)||record.events.length<1||record.events.length>32)throw Error('Malformed inbox record');
  validateJob(record.job,this.binding,{now:this.now,checkFreshness:false});validateBaseline(record.baseline,this.binding.workspace_root);
  if(record.state==='PENDING'&&record.claim_id!==null)throw Error('Invalid pending claim');
  if(record.state!=='PENDING')id(record.claim_id);
  if(['PENDING','CLAIMED'].includes(record.state)&&(record.delivery!==null||record.report_sha256!==null||record.report_original_path!==null||record.host_receipt!==null))throw Error('Invalid pre-dispatch provenance');
  if(record.state==='DISPATCHED'&&(record.delivery===null||record.report_sha256!==null||record.report_original_path!==null||record.host_receipt!==null))throw Error('Invalid dispatched provenance');
  if(record.state==='RESULT_READY'&&record.host_receipt!==null)throw Error('Worker result cannot contain host acceptance');
  if(record.report_sha256!==null&&!HASH.test(record.report_sha256))throw Error('Invalid report hash');
  if(record.report_original_path!==null&&record.report_original_path!==originalReportRelativePath(record.job))throw Error('Invalid original report path');
  if(['RESULT_READY','VERIFIED'].includes(record.state)&&(!record.report_sha256||!record.report_original_path))throw Error('Missing report provenance');
  if(record.state==='VERIFIED'&&(!record.host_receipt||record.host_receipt.kind!=='desktop-inbox.host-receipt@1'||record.host_receipt.accepted!==true||record.host_receipt.task_id!==record.job.task_id||record.host_receipt.attempt_id!==record.job.attempt_id||record.host_receipt.report_sha256!==record.report_sha256||record.outcome!==null))throw Error('Invalid verified record');
  for(const event of record.events)if(!event||Object.keys(event).sort().join(',')!=='at,outcome,reason,state'||!STATES.includes(event.state)||!OUTCOMES.includes(event.outcome)||typeof event.reason!=='string'||event.reason.length>1024||!Number.isFinite(Date.parse(event.at)))throw Error('Invalid inbox event');
  const last=record.events.at(-1);if(last.state!==record.state||last.outcome!==record.outcome)throw Error('Record/event mismatch');
  if(record.delivery!==null)boundedJSON(record.delivery,32768,'Delivery receipt');
  return record;
 }
 load(taskId){const record=readBounded(this.taskPath(taskId),RECORD_LIMIT).value;this.validateRecord(record);if(record.job.task_id!==taskId)throw Error('Record filename/task mismatch');return record;}
 get(taskId){return clone(this.load(taskId));}
 list(){
  return readdirSync(scopedPath(this.root,'tasks')).sort().map(taskId=>{
   const path=scopedPath(this.root,'tasks/'+id(taskId));if(!lstatSync(path).isDirectory())throw Error('Unexpected inbox task entry');
   return clone(this.load(taskId));
  });
 }
 event(record,reason){record.events.push({at:new Date(this.now()).toISOString(),state:record.state,outcome:record.outcome,reason:String(reason).slice(0,1024)});}
 save(record){this.validateRecord(record);atomicWrite(this.taskPath(record.job.task_id),record);return clone(record);}
 mutate(taskId,fn){return this.transaction(()=>{const record=this.load(taskId);fn(record);return this.save(record);});}
 owner(record,claimId){if(record.claim_id!==id(claimId))throw Error('Wrong claim owner');}
 submit(job,{baseline}={}){
  return this.transaction(()=>{
   validateJob(job,this.binding,{now:this.now});validateBaseline(baseline,this.binding.workspace_root);
   const dir=scopedPath(this.root,'tasks/'+id(job.task_id));
   if(existsSync(dir))throw Error('Duplicate task submission');
   if(this.list().some(active))throw Error('Workspace already has an active or uncertain task');
   const record={format:'desktop-inbox.record@1',job:clone(job),state:'PENDING',outcome:null,claim_id:null,baseline:clone(baseline),delivery:null,report_sha256:null,report_original_path:null,host_receipt:null,events:[]};
   this.event(record,'Host submitted job');this.validateRecord(record);mkdirSync(dir);
   atomicWrite(this.taskPath(job.task_id),record,{exclusive:true});return clone(record);
  });
 }
 claim(taskId,claimId=randomUUID()){
  return this.mutate(taskId,record=>{
   if(record.state!=='PENDING'||record.outcome!==null)throw Error('Task is not pending');
   validateJob(record.job,this.binding,{now:this.now});record.claim_id=id(claimId);record.state='CLAIMED';this.event(record,'Sidecar claimed job');
  });
 }
 beginDispatch(taskId,claimId){
  return this.mutate(taskId,record=>{
   this.owner(record,claimId);if(record.state!=='CLAIMED'||record.outcome!==null)throw Error('Task is not dispatchable');
   validateJob(record.job,this.binding,{now:this.now});record.state='DISPATCHED';record.delivery={status:'ATTEMPTING',started:null};this.event(record,'Durable dispatch intent; receipt and execution not yet known');
  });
 }
 recordDelivery(taskId,claimId,receipt){
  return this.mutate(taskId,record=>{
   this.owner(record,claimId);if(record.state!=='DISPATCHED'||record.delivery?.status!=='ATTEMPTING')throw Error('Delivery already recorded or not dispatching');
   boundedJSON(receipt,32768,'Delivery receipt');noKnownSecrets(receipt);
   if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))throw Error('Invalid delivery receipt');
   record.delivery={...clone(receipt),status:'RECORDED'};this.event(record,'Transport returned; this is not worker completion');
  });
 }
 fail(taskId,claimId,reason,{uncertain=false}={}){
  return this.mutate(taskId,record=>{
   this.owner(record,claimId);if(!['CLAIMED','DISPATCHED'].includes(record.state)||record.outcome!==null)throw Error('Task cannot fail in this state');
   if(record.state==='DISPATCHED'&&!uncertain&&!(record.delivery?.started===false&&['ENOENT','EACCES'].includes(record.delivery?.spawn_error)))throw Error('Post-dispatch failure must retain uncertain delivery');
   record.outcome=uncertain?'UNCERTAIN_DELIVERY':'FAILED';this.event(record,reason);
  });
 }
 acceptReport(taskId){
  return this.mutate(taskId,record=>{
   if(record.state!=='DISPATCHED'||['FAILED','RELEASED'].includes(record.outcome))throw Error('Task cannot accept a worker report');
   const path=scopedPath(this.root,record.job.expected_output),{raw,value}=readBounded(path,MAX_REPORT_BYTES);validateReport(value,record.job);
   const original=originalReportRelativePath(record.job),originalPath=scopedPath(this.root,original);
   if(existsSync(originalPath)){if(sha256(readBounded(originalPath,MAX_REPORT_BYTES).raw)!==sha256(raw))throw Error('Original worker report already differs');}
   else atomicWrite(originalPath,null,{exclusive:true,raw});
   record.report_sha256=sha256(raw);record.report_original_path=original;record.state='RESULT_READY';this.event(record,'Matching worker report preserved; parent verification required');
  });
 }
 cancel(taskId){
  return this.mutate(taskId,record=>{
   if(record.state==='VERIFIED'||record.outcome!==null)throw Error('Task cannot be cancelled in this state');
   record.outcome='CANCELLED';this.event(record,['DISPATCHED','RESULT_READY'].includes(record.state)?'Cancelled locally; worker stop is not proven, workspace remains held':'Cancelled before dispatch');
  });
 }
 release(taskId,reason='Parent released workspace slot'){
  return this.mutate(taskId,record=>{
   if(record.state==='VERIFIED'||record.outcome==='RELEASED')throw Error('Task cannot be released in this state');
   record.outcome='RELEASED';this.event(record,reason);
  });
 }
 recover(){
  return this.transaction(()=>{
   const changed=[];
   for(const record of this.list()){
    if(record.outcome!==null)continue;
    if(record.state==='CLAIMED'){record.outcome='FAILED';this.event(record,'Restart before dispatch; no automatic retry');changed.push(this.save(record));}
    else if(record.state==='DISPATCHED'){record.outcome='UNCERTAIN_DELIVERY';this.event(record,'Restart after durable dispatch intent; never redispatch automatically');changed.push(this.save(record));}
   }
   return changed;
  });
 }
 verify(taskId,receipt){
  return this.mutate(taskId,record=>{
   if(record.state!=='RESULT_READY'||['CANCELLED','RELEASED'].includes(record.outcome))throw Error('Result is not eligible for parent verification');
   boundedJSON(receipt,65536,'Host receipt');
   const required=['kind','task_id','attempt_id','workspace_root','report_sha256','job_sha256','baseline_sha256','after_sha256','checks','actual_changed_files','accepted','verified_at'];
   if(!receipt||Object.keys(receipt).some(key=>![...required,'review_notes','review_evidence'].includes(key))||required.some(key=>!Object.hasOwn(receipt,key))||receipt.kind!=='desktop-inbox.host-receipt@1'||receipt.accepted!==true||receipt.task_id!==taskId||receipt.attempt_id!==record.job.attempt_id||!sameWorkspace(receipt.workspace_root,record.job.workspace_root)||receipt.report_sha256!==record.report_sha256||receipt.job_sha256!==sha256(record.job)||receipt.baseline_sha256!==record.baseline.hash||!HASH.test(receipt.after_sha256)||!Number.isFinite(Date.parse(receipt.verified_at)))throw Error('Host receipt does not match job, report and baseline');
   const verifiedAt=Date.parse(receipt.verified_at);if(verifiedAt>this.now()+30000||this.now()-verifiedAt>60000)throw Error('Stale host receipt');
   const {raw,value}=readBounded(scopedPath(this.root,record.job.expected_output),MAX_REPORT_BYTES);
   const report=validateReport(value,record.job);
   if(sha256(raw)!==record.report_sha256||sha256(readBounded(scopedPath(this.root,record.report_original_path),MAX_REPORT_BYTES).raw)!==record.report_sha256)throw Error('Worker report changed after collection');
   if(report.status!=='reported'||report.blockers.length||report.errors.length)throw Error('Worker report is blocked or failed or reported errors');
   if(!Array.isArray(receipt.checks)||receipt.checks.length!==record.job.verification_commands.length||new Set(receipt.checks.map(check=>check.check_id)).size!==receipt.checks.length||receipt.checks.some(check=>!record.job.verification_commands.includes(check.check_id)||check.exit_code!==0||check.passed!==true))throw Error('Fresh host checks did not pass');
   if(!Array.isArray(receipt.actual_changed_files)||new Set(receipt.actual_changed_files).size!==receipt.actual_changed_files.length||JSON.stringify([...receipt.actual_changed_files].sort())!==JSON.stringify([...report.changed_files].sort()))throw Error('Host actual changes do not match report');
   for(const path of receipt.actual_changed_files){validateScopePath(record.job.workspace_root,path);if(!inScope(path,record.job.write_scope))throw Error('Host found unexpected workspace changes');}
   validateParentReview(receipt.review_evidence,{job:record.job,...receipt});
   record.host_receipt=clone(receipt);record.state='VERIFIED';record.outcome=null;this.event(record,'Codex parent accepted independently checked result');
  });
 }
}
