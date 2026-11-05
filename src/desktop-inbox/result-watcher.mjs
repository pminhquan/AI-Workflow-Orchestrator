import {watch,existsSync,openSync,closeSync,unlinkSync,renameSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {scopedPath,sha256} from '../core/util.mjs';
import {Inbox} from './inbox.mjs';
import {canonicalWorkspace,sameWorkspace} from './contracts.mjs';
import {handoffDirectory} from './app-receiver.mjs';
import {inspectHandoffArtifacts,readBoundedBytes,verifyJob} from './verification.mjs';

function save(path,value) {
 const temp=path+'.tmp-'+randomUUID();
 try {writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});renameSync(temp,path);}
 finally {if(existsSync(temp))unlinkSync(temp);}
}

// Trusted, deliberately narrow automatic review for this repository's README
// smoke only. General implementation tasks still require a parent callback.
export const README_SMOKE_ACCEPTANCE=[
 'Include the first README heading verbatim and quote its sentence beginning “Đây là” verbatim as the purpose.',
 'Compute the raw README.md SHA-256 and include it in result.md and report.json evidence.',
 'Declare tests NOT RUN in result.md; use tests: [], changed_files: [], errors: [] and blockers: [].'
];
export const README_SMOKE_REQUEST='Read README.md. Return the project name and describe its purpose in one sentence.\n\nWrite result.md and report.json to the supplied output directory.\n\nPreserve task_id and attempt_id.\n\nDo not modify source, install packages, access external services, commit, push or deploy.';
export function readmeSmokeVerification(record) {
 const job=record.job;
 if(!sameWorkspace(job.workspace_root,canonicalWorkspace(resolve(import.meta.dirname,'../..')))||
   JSON.stringify(job.read_scope)!=='["README.md"]'||job.write_scope.length||
   JSON.stringify(job.verification_commands)!=='["readme-smoke"]'||job.goal!==README_SMOKE_REQUEST||
   JSON.stringify(job.acceptance_criteria)!==JSON.stringify(README_SMOKE_ACCEPTANCE))throw Error('Automatic README review is restricted to the canonical read-only smoke request and acceptance');
 const expected=record.baseline.entries['README.md'];
 if(!/^[a-f0-9]{64}$/.test(expected??''))throw Error('README baseline hash missing');
 const checks={'readme-smoke':{args:['-e',`const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');assert.equal(crypto.createHash('sha256').update(fs.readFileSync('README.md')).digest('hex'),${JSON.stringify(expected)});console.log('README baseline SHA-256 matches')`],inputs:['README.md'],timeout_ms:2000}};
 const review=({report,artifacts})=>{
  const bytes=readBoundedBytes(scopedPath(job.workspace_root,'README.md'),1024*1024),text=bytes.toString('utf8');
  const title=text.match(/^#\s+(.+)$/m)?.[1]?.trim(),purpose=text.match(/Đây là [^\r\n]+?\./u)?.[0];
  if(!title||!purpose)throw Error('Canonical README title/purpose sentence unavailable');
  if(sha256(bytes)!==expected||!artifacts.result.includes(title)||!artifacts.result.includes(purpose)||
    !artifacts.result.includes(expected)||!report.evidence.some(value=>value.includes(expected))||
    !/\bNOT RUN\b/i.test(artifacts.result)||report.tests.length||JSON.stringify(report.inspected_files)!=='["README.md"]')throw Error('README smoke content/hash/tests declaration mismatch');
  return {accepted:true};
 };
 return {checks,review};
}

// Only observes an already dispatched task. It cannot submit, claim or dispatch.
// The small observation record stays beside the existing durable job record.
export async function watchJobResult(inbox,taskId,{signal,intervalMs=300000,deadlineMs=1800000,
 checks={},review,onStatus=()=>{}}={}) {
 if(!Number.isInteger(intervalMs)||intervalMs<10||intervalMs>300000||!Number.isInteger(deadlineMs)||deadlineMs<10||deadlineMs>1800000)throw Error('Watcher must be bounded to at most 300-second polling / 30 minutes');
 let record=inbox.get(taskId);
 if(!['DISPATCHED','RESULT_READY','VERIFIED'].includes(record.state))throw Error('Watcher requires an already dispatched job');
 const job=record.job,dir=inbox.taskPath(taskId).replace(/[\\/]record\.json$/,''),path=inbox.taskPath(taskId,'result-watcher.json');
 const lock=inbox.taskPath(taskId,'result-watcher.lock'),fd=openSync(lock,'wx');
 const cpuStart=process.cpuUsage();
 let watcher,state,wake;
 try {
  if(existsSync(path)) {
   state=JSON.parse(readBoundedBytes(path,16384).toString('utf8'));
   if(state.format!=='desktop-inbox.result-watcher@1'||state.task_id!==taskId||state.attempt_id!==job.attempt_id||
     !Number.isFinite(state.deadline_at)||!Number.isFinite(state.started_at)||state.deadline_at-state.started_at>1800000||state.deadline_at<state.started_at)throw Error('Invalid durable watcher identity/deadline');
  } else {
   const dispatchAt=Date.parse(record.events.find(event=>event.state==='DISPATCHED')?.at);
   if(!Number.isFinite(dispatchAt))throw Error('Durable dispatch timestamp missing');
   const startedAt=Math.min(Date.now(),dispatchAt);
   state={format:'desktop-inbox.result-watcher@1',task_id:taskId,attempt_id:job.attempt_id,
    started_at:startedAt,deadline_at:startedAt+deadlineMs,status:'WAITING',checks:0,artifacts:null,last_error:null};
  }
  const output=handoffDirectory(inbox.root,job),prefix=relative(dir,output).replaceAll('\\','/');
  watcher=watch(dir,{recursive:true},(_event,name)=>{
   const entry=String(name??'').replaceAll('\\','/');
   if(entry===prefix||entry.startsWith(prefix+'/'))wake?.();
  });
  watcher.on('error',error=>{state.last_error='Filesystem notification unavailable: '+error.code;wake?.();});
  const finish=status=>{
   state.status=status;state.updated_at=Date.now();const cpu=process.cpuUsage(cpuStart);
   state.observer={elapsed_wall_ms:state.updated_at-state.started_at,invocation_cpu_user_us:cpu.user,
    invocation_cpu_system_us:cpu.system,process_max_rss_kb:process.resourceUsage().maxRSS};
   save(path,state);onStatus(structuredClone(state));return structuredClone(state);
  };
  // Terminal observations are not a retry queue. A parent can deliberately run
  // verifyJob separately after reviewing/resolving a failure; restarting this
  // observer never supplies that decision or extends the original deadline.
  if(record.state==='VERIFIED')return finish('VERIFIED');
  if(['TIMED_OUT','CANCELLED','STOPPED','VERIFICATION_FAILED','PARENT_REVIEW_REQUIRED','EVIDENCE_CHANGED'].includes(state.status))return finish(state.status);
  while(true) {
   if(signal?.aborted)return finish('CANCELLED');
   record=inbox.get(taskId);
   if(record.state==='VERIFIED')return finish('VERIFIED');
   if(record.outcome==='CANCELLED'||record.outcome==='FAILED')return finish('STOPPED');
   if(Date.now()>=state.deadline_at)return finish('TIMED_OUT');
   state.checks++;
   if(existsSync(output)&&existsSync(scopedPath(output,'report.json'))&&existsSync(scopedPath(output,'result.md'))) {
    let collected=false;
    try {
     const artifacts=inspectHandoffArtifacts({...job,output_directory:output});
     if(state.artifacts&&(state.artifacts.report_sha256!==artifacts.report_sha256||state.artifacts.result_sha256!==artifacts.result_sha256)) {
      state.last_error='Previously observed handoff evidence changed';return finish('EVIDENCE_CHANGED');
     }
     // Immutable copies also cover interruption before the observation record
     // is saved. Never overwrite either the App pair or these first-seen bytes.
     const preserved={};
     for(const [name,hash] of [['report.json',artifacts.report_sha256],['result.md',artifacts.result_sha256]]) {
      const original=readBoundedBytes(scopedPath(output,name),32768);
      if(sha256(original)!==hash)throw Error('Handoff changed during collection');
      const snapshot=inbox.taskPath(taskId,'app-original-'+job.attempt_id+'-'+name);
      if(existsSync(snapshot)&&sha256(readBoundedBytes(snapshot,32768))!==hash) {
       state.last_error='Preserved original handoff evidence changed';return finish('EVIDENCE_CHANGED');
      }
      if(!existsSync(snapshot))writeFileSync(snapshot,original,{flag:'wx'});
      preserved[name]=snapshot;
     }
     const canonical=Buffer.from(JSON.stringify(artifacts.report,null,2)+'\n');
     const expected=scopedPath(inbox.root,job.expected_output);
     // Never overwrite the App's original pair or an existing bridge report.
     if(existsSync(expected)) {
      if(sha256(readBoundedBytes(expected,32768))!==sha256(canonical))throw Error('Bridge report differs from collected original');
     } else writeFileSync(expected,canonical,{flag:'wx'});
     state.artifacts={output_directory:output,report_sha256:artifacts.report_sha256,result_sha256:artifacts.result_sha256,
      normalized_report_sha256:sha256(canonical),normalization:artifacts.normalization,preserved_originals:preserved};
     if(record.state==='DISPATCHED')inbox.acceptReport(taskId);
     collected=true;
     state.last_error=null;
     if(typeof review!=='function')return finish('PARENT_REVIEW_REQUIRED');
     // A trusted parent callback and registered checks own acceptance. Worker
     // text, an exit-zero transport or file presence never accepts a result.
     await verifyJob(inbox,taskId,{checks,review:async context=>{
      const decision=await review({...context,artifacts});
      const after=inspectHandoffArtifacts({...job,output_directory:output});
      if(after.report_sha256!==artifacts.report_sha256||after.result_sha256!==artifacts.result_sha256)throw Error('Original handoff changed during parent review');
      return decision;
     }});
     return finish('VERIFIED');
    } catch(error) {state.last_error=error.message;if(collected)return finish('VERIFICATION_FAILED');}
   }
   finish('WAITING');
   await new Promise(resolveWait=>{
    const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);wake=undefined;resolveWait();};
    const timer=setTimeout(done,Math.min(intervalMs,Math.max(1,state.deadline_at-Date.now())));
    wake=done;signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();
   });
  }
 } finally {watcher?.close();closeSync(fd);unlinkSync(lock);}
}

export async function main(args=process.argv.slice(2)) {
 const smoke=args.length===7&&args[6]==='--readme-smoke';
 if((args.length!==6&&!smoke)||args[0]!=='--binding'||args[2]!=='--inbox'||args[4]!=='--task')throw Error('Expected --binding <JSON> --inbox <state path> --task <UUID> [--readme-smoke]');
 const binding=JSON.parse(readBoundedBytes(resolve(args[1]),8192).toString('utf8'));
 const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try {
  const inbox=new Inbox(args[3],binding),result=await watchJobResult(inbox,args[5],{...(smoke?readmeSmokeVerification(inbox.get(args[5])):{}),signal:controller.signal,onStatus:value=>console.log(JSON.stringify(value))});
  if(['VERIFICATION_FAILED','TIMED_OUT','STOPPED','EVIDENCE_CHANGED'].includes(result.status))process.exitCode=1;
  if(result.status==='CANCELLED')process.exitCode=130;
  return result;
 }
 finally {process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(JSON.stringify({status:'BLOCKED',error:error.message}));process.exitCode=1;});
