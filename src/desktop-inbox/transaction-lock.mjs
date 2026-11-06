import {randomUUID} from 'node:crypto';
import {openSync,closeSync,writeFileSync,readFileSync,fsyncSync,fstatSync,lstatSync,unlinkSync,constants} from 'node:fs';

const FORMAT='desktop-inbox.transaction-lock@1';
const NONCE=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sleeper=new Int32Array(new SharedArrayBuffer(4));
const sameFile=(a,b)=>a?.dev===b?.dev&&a?.ino===b?.ino;

function readOwner(path){
 let fd;
 try{
  const prior=lstatSync(path);
  if(prior.isSymbolicLink()||!prior.isFile()||prior.size<1||prior.size>2048)return null;
  fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const stat=fstatSync(fd);
  if(!sameFile(prior,stat)||stat.size>2048)return null;
  const raw=readFileSync(fd,'utf8');if(Buffer.byteLength(raw)>2048)return null;
  const owner=JSON.parse(raw);
  if(owner?.format!==FORMAT||!Number.isInteger(owner.pid)||owner.pid<1||!NONCE.test(owner.nonce??''))return null;
  if(!sameFile(stat,lstatSync(path)))return null;
  return {...owner,dev:stat.dev,ino:stat.ino};
 }catch{return null;}finally{if(fd!==undefined)closeSync(fd);}
}
function matches(path,owner){const current=readOwner(path);return current?.pid===owner.pid&&current?.nonce===owner.nonce&&sameFile(current,owner);}
function positivelyDead(pid){try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}}

function createOwned(path){
 const fd=openSync(path,'wx');let owner;
 try{
  const data={format:FORMAT,pid:process.pid,nonce:randomUUID()};
  writeFileSync(fd,JSON.stringify(data)+'\n');fsyncSync(fd);
  const stat=fstatSync(fd);owner={...data,dev:stat.dev,ino:stat.ino};
 }catch(error){
  try{if(sameFile(lstatSync(path),fstatSync(fd)))unlinkSync(path);}catch{}
  closeSync(fd);throw error;
 }
 let released=false;
 return ()=>{
  if(released)return;released=true;
  try{if(matches(path,owner))unlinkSync(path);}finally{closeSync(fd);}
 };
}

function reapOrphan(path){
 const owner=readOwner(path);
 if(!owner||!positivelyDead(owner.pid))return false;
 // Serialise reapers for THIS immutable owner nonce. A stale reaper cannot
 // remove a new live owner's lock after another reaper has replaced it.
 // An abandoned reaping gate stays fail-closed for manual review.
 let release;
 try{release=createOwned(path+'.reap-'+owner.nonce);}catch(error){if(error.code==='EEXIST')return false;throw error;}
 try{
  if(!matches(path,owner)||!positivelyDead(owner.pid))return false;
  unlinkSync(path);return true;
 }finally{release();}
}

// Caller supplies a checked state path with an existing regular parent. This
// synchronous mailbox API waits briefly without a CPU busy loop; PID age is
// never evidence of death, and malformed/legacy locks are never broken.
export function acquireTransactionLock(path,{timeoutMs=250,retryMs=10}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<0||timeoutMs>1000||!Number.isInteger(retryMs)||retryMs<1||retryMs>25)throw Error('Invalid bounded transaction lock wait');
 const deadline=performance.now()+timeoutMs;let attempted=false;
 while(true){
  if(attempted&&performance.now()>=deadline){const error=Error('Inbox transaction locked; bounded wait exhausted, live/unknown ownership requires review');error.code='TRANSACTION_LOCK_TIMEOUT';throw error;}
  attempted=true;
  try{return createOwned(path);}catch(error){if(error.code!=='EEXIST')throw error;}
  if(reapOrphan(path))continue;
  const remaining=deadline-performance.now();
  if(remaining<=0){const error=Error('Inbox transaction locked; bounded wait exhausted, live/unknown ownership requires review');error.code='TRANSACTION_LOCK_TIMEOUT';throw error;}
  Atomics.wait(sleeper,0,0,Math.min(retryMs,remaining));
 }
}
export function withTransactionLock(path,fn,options){
 const release=acquireTransactionLock(path,options);
 try{return fn();}finally{release();}
}
