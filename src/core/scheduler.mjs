import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT,scopedPath,safeRelative,overlaps,sha256,canonical} from './util.mjs';
import {requireValid} from './schema.mjs';
import {loadConfig} from './config.mjs';
import {available} from './router.mjs';
import {MockAdapter,ReplayAdapter} from '../adapters/offline.mjs';
import {snapshot,changedFiles,verifyScope} from '../verification/checks.mjs';
export class Scheduler{
 constructor(store,checks,{config=loadConfig(),now=Date.now}={}){this.store=store;this.checks=checks;this.config=config;this.now=now;this.controllers=new Map();this.executing=false;}
 get(id){if(!Object.hasOwn(this.store.data.tasks,id))throw Error('Unknown task '+id);const t=structuredClone(this.store.data.tasks[id]);if(t.status==='review')t.metrics.review_wait_ms=this.now()-t.reported_at;return t;}
 mutate(id,update,event){const data=structuredClone(this.store.data);const t=data.tasks[id];if(!t)throw Error('Unknown task');update(t);data.events.push({time:this.now(),task_id:id,type:event});this.store.commit(data);return structuredClone(t);}
 submit(tasks,idempotencyKey){
  if(!Array.isArray(tasks)||!tasks.length||tasks.length>100)throw Error('Expected 1-100 tasks');
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(idempotencyKey))throw Error('Invalid idempotency key');
  const digest=sha256(tasks),old=Object.hasOwn(this.store.data.submissions,idempotencyKey)?this.store.data.submissions[idempotencyKey]:null;
  if(old){if(old.digest!==digest)throw Error('Idempotency key reused with different payload');return old.ids.map(id=>this.get(id));}
  const data=structuredClone(this.store.data);
  for(const task of tasks){
   requireValid(task,'task-brief');safeRelative(task.task_id);if(Object.hasOwn(data.tasks,task.task_id))throw Error('Duplicate task ID');
   for(const p of [...task.relevant_files,...task.read_scope,...task.write_scope,...task.expected_artifacts]){safeRelative(p);if(p.split('/').some(s=>s.toLowerCase()==='.git'))throw Error('Git internals are outside task scope');}
   const workspace=scopedPath(ROOT,safeRelative(task.workspace));realpathSync(workspace);
   for(const p of [...task.read_scope,...task.write_scope])scopedPath(workspace,p);
   for(const id of task.required_checks)this.checks.spec(id);
   data.tasks[task.task_id]={brief:structuredClone(task),workspace,status:'queued',attempt:0,queued_at:this.now(),receipts:[],metrics:{retry_count:0,human_interventions:0},report:null,attempt_history:[]};
  }
  const visiting=new Set(),visited=new Set();
  function visit(id){if(visiting.has(id))throw Error('Dependency cycle');if(visited.has(id))return;if(!Object.hasOwn(data.tasks,id))throw Error('Unknown dependency '+id);const t=data.tasks[id];visiting.add(id);for(const dep of t.brief.dependencies)visit(dep);visiting.delete(id);visited.add(id);}
  for(const id of Object.keys(data.tasks))visit(id);
  data.submissions[idempotencyKey]={digest,ids:tasks.map(x=>x.task_id)};this.store.commit(data);return tasks.map(t=>this.get(t.task_id));
 }
 conflict(a,b){const paths=(record,scopes)=>scopes.map(p=>resolve(record.workspace,p).replaceAll('\\','/'));const aw=paths(a,a.brief.write_scope),bw=paths(b,b.brief.write_scope),ar=paths(a,a.brief.read_scope),br=paths(b,b.brief.read_scope);return aw.some(x=>[...bw,...br].some(y=>overlaps(x,y)))||bw.some(x=>ar.some(y=>overlaps(x,y)));}
 async runReady(adapter,{limit=2,timeout_ms=1000}={}){
  if(this.executing)throw Error('A scheduler batch is already running');
  if(!(adapter instanceof MockAdapter)&&!(adapter instanceof ReplayAdapter))throw Error('Only offline adapters implemented');
  const cap=this.config.capabilities.find(x=>x.runtime_id===adapter.runtime_id);
  if(!available(cap)||!cap.supported_operations.includes('execute')||!adapter.available)return {status:'BLOCKED',reason:'Offline worker preflight failed',started:[]};
  if(!Number.isInteger(limit)||limit<1||limit>this.config.policy.max_parallelism||!Number.isInteger(timeout_ms)||timeout_ms<1||timeout_ms>this.config.policy.max_wait_ms)throw Error('Invalid scheduling bounds');
  const selected=[],all=Object.values(this.store.data.tasks);
  for(const record of all){
   if(record.status!=='queued')continue;
   if(record.brief.allowed_execution_mode==='DIRECT'){this.mutate(record.brief.task_id,t=>{t.status='blocked';t.blocker='DIRECT tasks cannot be dispatched to a worker';},'mode_blocked');continue;}
   const deps=record.brief.dependencies.map(id=>this.get(id));
   if(deps.some(d=>['failed','blocked','canceled','partial'].includes(d.status))){this.mutate(record.brief.task_id,t=>{t.status='blocked';t.blocker='Dependency did not complete';},'dependency_blocked');continue;}
   if(deps.some(d=>d.status!=='done'))continue;
   if(selected.length>=Math.min(limit,cap.concurrency))break;
   if([...all.filter(x=>['running','review'].includes(x.status)),...selected].some(x=>this.conflict(record,x)))continue;
   selected.push(record);
  }
  if(!selected.length)return {status:'idle',started:[]};
  this.executing=true;
  try{await Promise.all(selected.map(t=>this.execute(t.brief.task_id,adapter,timeout_ms)));}
  finally{this.executing=false;}
  return {status:'settled',started:selected.map(t=>t.brief.task_id)};
 }
 async execute(id,adapter,timeout_ms){
  const controller=new AbortController();this.controllers.set(id,controller);
  let timer;
  try{
   const prior=this.get(id);const before=snapshot(prior.workspace);
   const record=this.mutate(id,t=>{t.status='running';t.attempt++;t.started_at=this.now();t.before=before;t.metrics.queue_delay_ms=t.started_at-t.queued_at;},'started');
   const report=await Promise.race([adapter.execute(record.brief,record.attempt,controller.signal),new Promise((_,no)=>{timer=setTimeout(()=>{controller.abort();no(Error('Bounded worker timeout'));},timeout_ms);})]);
   if(this.get(id).status==='canceled')return;
   requireValid(report,'worker-report');
   if(report.task_id!==id||report.attempt!==record.attempt)throw Error('Report identity mismatch');
   const actual=changedFiles(before,snapshot(record.workspace));verifyScope(actual,report.changed_files,record.brief.write_scope);
   for(const p of report.artifacts){safeRelative(p);scopedPath(record.workspace,p);if(![...record.brief.read_scope,...record.brief.write_scope].some(s=>p===s||p.startsWith(s+'/')))throw Error('Out-of-scope artifact');}
   this.mutate(id,t=>{t.report=report;t.actual_changed_files=actual;t.status=report.status;t.reported_at=this.now();t.metrics.worker_execution_ms=t.reported_at-t.started_at;},'reported');
  }catch(e){if(this.get(id).status!=='canceled')this.mutate(id,t=>{t.status='failed';t.error=String(e.message);},'failed');}
  finally{clearTimeout(timer);this.controllers.delete(id);}
 }
 async verify(id){
  const record=this.get(id);if(record.status!=='review')throw Error('Task not awaiting review');
  const receipts=[];for(const check of record.brief.required_checks)receipts.push(await this.checks.run(record.workspace,check));
  // Races or check-side writes cannot hide behind a worker report.
  const actual=changedFiles(record.before,snapshot(record.workspace));verifyScope(actual,record.report.changed_files,record.brief.write_scope);
  return this.mutate(id,t=>{if(t.status!=='review'||t.attempt!==record.attempt)throw Error('Task changed during verification');t.receipts=receipts;t.metrics.verification_ms=receipts.reduce((n,r)=>n+r.execution_ms,0);},'checked');
 }
 accept(id){
  const record=this.get(id);if(record.status!=='review')throw Error('Task not awaiting review');
  verifyScope(changedFiles(record.before,snapshot(record.workspace)),record.report.changed_files,record.brief.write_scope);
  for(const check of record.brief.required_checks)if(!record.receipts.some(r=>r.check_id===check&&this.checks.isFresh(r.id,record.workspace,check)))throw Error('Fresh host receipt required: '+check);
  for(const artifact of record.brief.expected_artifacts)if(!record.report.artifacts.includes(artifact))throw Error('Expected artifact missing from report');
  const after=snapshot(record.workspace,record.brief.expected_artifacts);
  if(Object.values(after.entries).some(x=>x==='missing'))throw Error('Expected artifact does not exist');
  return this.mutate(id,t=>{t.status='done';t.completed_at=this.now();t.metrics.review_wait_ms=t.completed_at-t.reported_at;},'accepted');
 }
 retry(id){
  return this.mutate(id,t=>{if(!['failed','partial','review','blocked'].includes(t.status))throw Error('Task is not eligible for rework');if(t.attempt===0)throw Error('No failed attempt to retry');if(t.attempt>t.brief.retry_budget)throw Error('Retry budget exhausted');t.attempt_history??=[];t.attempt_history.push({attempt:t.attempt,status:t.status,report:t.report,receipts:t.receipts,error:t.error??null});t.status='queued';t.metrics.retry_count++;t.queued_at=this.now();t.receipts=[];t.report=null;},'rework');
 }
 cancel(id){const t=this.get(id);if(['done','canceled'].includes(t.status))throw Error('Task already terminal');this.controllers.get(id)?.abort();return this.mutate(id,t=>{t.status='canceled';},'canceled');}
 recover(){
  for(const t of Object.values(this.store.data.tasks))if(t.status==='running')this.mutate(t.brief.task_id,r=>{r.status='blocked';r.blocker='Interrupted attempt; inspect before retry. No automatic redispatch.';},'recovered_blocked');
 }
}
