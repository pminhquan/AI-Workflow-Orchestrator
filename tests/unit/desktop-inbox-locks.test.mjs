import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,renameSync,symlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {ROOT,inside,sha256} from '../../src/core/util.mjs';
import {acquireTransactionLock,withTransactionLock} from '../../src/desktop-inbox/transaction-lock.mjs';
import {Inbox} from '../../src/desktop-inbox/inbox.mjs';
import {makeJob} from '../../src/desktop-inbox/contracts.mjs';

const helperURL=pathToFileURL(resolve(ROOT,'src/desktop-inbox/transaction-lock.mjs')).href;
const inboxURL=pathToFileURL(resolve(ROOT,'src/desktop-inbox/inbox.mjs')).href;
function fixture(){
 const rel='state/test-transaction-lock-'+randomUUID(),root=resolve(ROOT,rel),workspace=resolve(root,'workspace');mkdirSync(workspace,{recursive:true});writeFileSync(resolve(workspace,'README.md'),'# Lock fixture\n');
 return {rel,root,workspace,path:resolve(root,'transaction.lock'),close(){assert.ok(inside(resolve(ROOT,'state'),root)&&root!==resolve(ROOT,'state'));rmSync(root,{recursive:true,force:true});}};
}
function child(code){
 const process=spawn(globalThis.process.execPath,['--input-type=module','-e',code],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let output='',errors='';process.stdout.on('data',b=>output+=b);process.stderr.on('data',b=>errors+=b);
 const closed=once(process,'close');
 const ready=new Promise((accept,reject)=>{
  const timer=setTimeout(()=>reject(Error('Child readiness timed out: '+errors)),5000);
  process.stdout.on('data',()=>{if(output.includes('READY')){clearTimeout(timer);accept();}});
  process.once('error',e=>{clearTimeout(timer);reject(e);});
  process.once('close',()=>{clearTimeout(timer);if(!output.includes('READY'))reject(Error('Child closed before ready: '+errors));});
 });
 return {process,closed,ready,errors:()=>errors,async stop(){if(process.exitCode===null&&process.signalCode===null)process.kill();await closed;}};
}
function holder(path,holdMs=3000){return child(`import {acquireTransactionLock} from ${JSON.stringify(helperURL)};const release=acquireTransactionLock(${JSON.stringify(path)});console.log('READY');setTimeout(()=>release(),${holdMs});`);}

test('real process contention waits briefly and acquires after the live owner releases',async()=>{
 const f=fixture();let h;try{
  h=holder(f.path,100);await h.ready;const started=performance.now();const release=acquireTransactionLock(f.path,{timeoutMs:500,retryMs:5});
  assert.ok(performance.now()-started>=30);assert.ok(performance.now()-started<650);assert.equal(JSON.parse(readFileSync(f.path,'utf8')).pid,process.pid);release();
  const [code]=await h.closed;assert.equal(code,0,h.errors());assert.equal(existsSync(f.path),false);
 }finally{if(h)await h.stop();f.close();}
});

test('live PID ownership is never broken and contention timeout is bounded',async()=>{
 const f=fixture();let h;try{
  h=holder(f.path);await h.ready;const before=readFileSync(f.path,'utf8'),started=performance.now();
  assert.throws(()=>acquireTransactionLock(f.path,{timeoutMs:70,retryMs:5}),{code:'TRANSACTION_LOCK_TIMEOUT'});
  const elapsed=performance.now()-started;assert.ok(elapsed>=50&&elapsed<500,'bounded wait: '+elapsed);assert.equal(readFileSync(f.path,'utf8'),before);assert.doesNotThrow(()=>process.kill(h.process.pid,0));
 }finally{if(h)await h.stop();f.close();}
});

test('a positively exited process owner can be recovered without age-based guesses',async()=>{
 const f=fixture();let h;try{
  h=holder(f.path);await h.ready;const before=JSON.parse(readFileSync(f.path,'utf8'));await h.stop();
  const release=acquireTransactionLock(f.path);const after=JSON.parse(readFileSync(f.path,'utf8'));assert.equal(after.pid,process.pid);assert.notEqual(after.nonce,before.nonce);release();assert.equal(existsSync(f.path),false);
 }finally{if(h)await h.stop();f.close();}
});

test('unknown, empty legacy and permission-unknown lock owners remain untouched',t=>{
 const f=fixture();try{
  for(const text of ['', '{bad json}',JSON.stringify({pid:99999999})]){
   writeFileSync(f.path,text);assert.throws(()=>acquireTransactionLock(f.path,{timeoutMs:15,retryMs:3}),/locked/);assert.equal(readFileSync(f.path,'utf8'),text);
  }
  const text=JSON.stringify({format:'desktop-inbox.transaction-lock@1',pid:99999999,nonce:randomUUID()});writeFileSync(f.path,text);
  t.mock.method(process,'kill',()=>{const error=Error('permission denied');error.code='EPERM';throw error;});
  assert.throws(()=>acquireTransactionLock(f.path,{timeoutMs:15,retryMs:3}),/locked/);assert.equal(readFileSync(f.path,'utf8'),text);
 }finally{t.mock.restoreAll();f.close();}
});

test('a stale release does not delete a replacement owner or another lock nonce',()=>{
 const f=fixture();let first,second;try{
  first=acquireTransactionLock(f.path);renameSync(f.path,f.path+'.retired');second=acquireTransactionLock(f.path);const newer=readFileSync(f.path,'utf8');first();assert.equal(readFileSync(f.path,'utf8'),newer);second();assert.equal(existsSync(f.path),false);
 }finally{first?.();second?.();f.close();}
});

test('simultaneous real process reapers never overlap critical sections',async()=>{
 const f=fixture();let old,a,b;try{
  old=holder(f.path);await old.ready;await old.stop();const journal=resolve(f.root,'journal.log');writeFileSync(journal,'');
  const code=`import{appendFileSync}from'node:fs';import{withTransactionLock}from ${JSON.stringify(helperURL)};console.log('READY');withTransactionLock(${JSON.stringify(f.path)},()=>{appendFileSync(${JSON.stringify(journal)},'enter '+process.pid+'\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,80);appendFileSync(${JSON.stringify(journal)},'exit '+process.pid+'\\n');},{timeoutMs:1000,retryMs:5});`;
  a=child(code);b=child(code);await Promise.all([a.ready,b.ready]);const [[ca],[cb]]=await Promise.all([a.closed,b.closed]);assert.equal(ca,0,a.errors());assert.equal(cb,0,b.errors());
  const lines=readFileSync(journal,'utf8').trim().split('\n');assert.equal(lines.length,4);assert.equal(lines[0].replace('enter','exit'),lines[1]);assert.equal(lines[2].replace('enter','exit'),lines[3]);assert.notEqual(lines[0],lines[2]);assert.equal(existsSync(f.path),false);
 }finally{for(const h of[old,a,b])if(h)await h.stop();f.close();}
});

test('abandoned reap gate and symlink lock stay fail closed',async()=>{
 const f=fixture();let h;try{
  h=holder(f.path);await h.ready;await h.stop();const dead=JSON.parse(readFileSync(f.path,'utf8')),gate=f.path+'.reap-'+dead.nonce;writeFileSync(gate,'unknown owner');
  assert.throws(()=>acquireTransactionLock(f.path,{timeoutMs:20,retryMs:3}),/locked/);assert.equal(JSON.parse(readFileSync(f.path,'utf8')).nonce,dead.nonce);assert.equal(readFileSync(gate,'utf8'),'unknown owner');
  renameSync(f.path,f.path+'.retired');const target=resolve(f.root,'outside.txt');writeFileSync(target,'unchanged');
  if(process.platform!=='win32'){symlinkSync(target,f.path);assert.throws(()=>acquireTransactionLock(f.path,{timeoutMs:15,retryMs:3}),/locked/);assert.equal(readFileSync(target,'utf8'),'unchanged');}
 }finally{if(h)await h.stop();f.close();}
});

test('real crash after claim or durable dispatch recovers fail-closed without creating/retrying jobs',async()=>{
 const f=fixture();let h;try{
  const binding={workspace_root:f.workspace,project_id:'crash-lock-fixture'},directory=f.rel+'/inbox',inbox=new Inbox(directory,binding);const entries={'README.md':sha256(readFileSync(resolve(f.workspace,'README.md')))},baseline={entries,hash:sha256(entries)};
  const job=()=>makeJob(binding,{goal:'Read README',read_scope:['README.md'],write_scope:[],acceptance_criteria:['Accurate finding'],verification_commands:['noop']});
  for(const dispatch of[false,true]){
   const j=job();inbox.submit(j,{baseline});
   const code=`import{Inbox}from ${JSON.stringify(inboxURL)};const i=new Inbox(${JSON.stringify(directory)},${JSON.stringify(binding)});const c=i.claim(${JSON.stringify(j.task_id)});${dispatch?'i.beginDispatch(c.job.task_id,c.claim_id);':''}console.log('READY');setInterval(()=>{},1000);`;
   h=child(code);await h.ready;await h.stop();
   const beforeCount=inbox.list().length,changed=inbox.recover();assert.equal(changed.length,1);const r=inbox.get(j.task_id);assert.equal(r.state,dispatch?'DISPATCHED':'CLAIMED');assert.equal(r.outcome,dispatch?'UNCERTAIN_DELIVERY':'FAILED');assert.equal(inbox.list().length,beforeCount);assert.deepEqual(inbox.recover(),[]);
   if(dispatch)assert.throws(()=>inbox.submit(job(),{baseline}),/active or uncertain/);
   else assert.throws(()=>inbox.beginDispatch(j.task_id,r.claim_id),/not dispatchable/);
  }
 }finally{if(h)await h.stop();f.close();}
});

test('withTransactionLock releases on synchronous throw',()=>{
 const f=fixture();try{assert.throws(()=>withTransactionLock(f.path,()=>{throw Error('expected');}),/expected/);assert.equal(existsSync(f.path),false);}finally{f.close();}
});
