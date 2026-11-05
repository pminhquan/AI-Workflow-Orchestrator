import {existsSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {scopedPath,sha256} from '../core/util.mjs';
import {CheckRunner,changedFiles,verifyScope} from '../verification/checks.mjs';
import {validateReport} from './contracts.mjs';
import {captureWorkspace,readBoundedBytes} from './verification.mjs';
import {DEFAULT_LIVE_STATE,atomicWriteJSON,atomicWriteText,collectWorkerReport,openLiveInbox,readBoundedJSON,resolveWorkspaceConfig} from './live-bridge.mjs';

function splitList(values){
 const out=[];
 for(const raw of values){
  for(const part of String(raw).split(',')){
   const norm=part.trim().replaceAll('\\','/');
   if(norm&&!out.some(existing=>existing.toLowerCase()===norm.toLowerCase()))out.push(norm);
  }
 }
 return out;
}

function parseTestSpec(raw){
 const text=String(raw);
 const first=text.indexOf('::');
 if(first===-1)return {command:text.trim(),exit_code:0,output:'executed'};
 const second=text.indexOf('::',first+2);
 if(second===-1){
  const code=Number.parseInt(text.slice(first+2),10);
  return {command:text.slice(0,first).trim(),exit_code:Number.isInteger(code)?code:null,output:''};
 }
 const codeRaw=text.slice(first+2,second).trim();
 const code=codeRaw===''||codeRaw.toLowerCase()==='null'?null:Number.parseInt(codeRaw,10);
 return {command:text.slice(0,first).trim(),exit_code:Number.isInteger(code)?code:null,output:text.slice(second+2)};
}

function defaultInspectedFiles(job,actualChanged){
 const out=[];
 const add=p=>{const norm=p.replaceAll('\\','/');if(!out.some(x=>x.toLowerCase()===norm.toLowerCase()))out.push(norm);};
 for(const item of job.read_scope){
  try{
   const full=scopedPath(job.workspace_root,item);
   if(existsSync(full)&&lstatSync(full).isFile())add(item);
  }catch{}
 }
 for(const item of actualChanged)add(item);
 return out;
}

function autoEvidence(job,inspectedFiles,actualChanged){
 const items=[];
 for(const rel of [...actualChanged,...inspectedFiles].slice(0,8)){
  try{
   const full=scopedPath(job.workspace_root,rel);
   if(existsSync(full)&&lstatSync(full).isFile()){
    const digest=sha256(readBoundedBytes(full,4*1024*1024));
    items.push(`${rel} (sha256:${digest})`);
   }else if(!existsSync(full)&&actualChanged.includes(rel)){
    items.push(`${rel} (deleted)`);
   }
  }catch{}
 }
 return items;
}

export function submitWorkerReport({briefPath,status='reported',summary='',inspected=[],changed=null,findings=[],evidence=[],blockers=[],errors=[],tests=[],stateDirectory=DEFAULT_LIVE_STATE}={}){
 if(!briefPath)throw Error('Missing required --brief <brief.json>');
 const brief=readBoundedJSON(resolve(briefPath),65536);
 if(brief?.format!=='desktop-inbox.brief@1'||!brief?.job?.task_id)throw Error('Invalid brief JSON format');
 const job=brief.job;
 const {inbox}=openLiveInbox(job.workspace_root,{stateDirectory});
 const record=inbox.get(job.task_id);
 const currentSnapshot=captureWorkspace(job.workspace_root);
 const actualChanged=changedFiles(record.baseline,currentSnapshot);
 const changedList=changed===null?actualChanged:splitList(changed);
 if(status==='reported'){
  verifyScope(actualChanged,changedList,job.write_scope);
 }
 const inspectedList=inspected.length?splitList(inspected):defaultInspectedFiles(job,actualChanged);
 const findingsList=[...findings.map(String).map(s=>s.trim()).filter(Boolean)];
 if(!findingsList.length&&summary.trim())findingsList.push(summary.trim());
 if(!findingsList.length)findingsList.push(`Completed ${status} report for task ${job.task_id}`);
 const evidenceList=[...evidence.map(String).map(s=>s.trim()).filter(Boolean)];
 if(!evidenceList.length&&status==='reported')evidenceList.push(...autoEvidence(job,inspectedList,changedList));
 if(!evidenceList.length&&summary.trim())evidenceList.push(summary.trim());
 const report={
  schema_version:'desktop-inbox.report@1',
  task_id:job.task_id,
  attempt_id:job.attempt_id,
  workspace:job.workspace_root,
  status,
  inspected_files:inspectedList,
  changed_files:changedList,
  tests:tests.map(parseTestSpec),
  findings:findingsList,
  blockers:blockers.map(String).map(s=>s.trim()).filter(Boolean),
  errors:errors.map(String).map(s=>s.trim()).filter(Boolean),
  evidence:evidenceList
 };
 const validated=validateReport(report,job);
 const resultMd=[
  `# Worker Result — \`${job.task_id}\``,
  '',
  `- **Attempt ID:** \`${job.attempt_id}\``,
  `- **Workspace:** \`${job.workspace_root}\``,
  `- **Status:** \`${validated.status}\``,
  '',
  '## Summary & Findings',
  ...validated.findings.map(item=>`- ${item}`),
  '',
  '## Changed Files',
  ...(validated.changed_files.length?validated.changed_files.map(item=>`- \`${item}\``):['- NONE']),
  '',
  '## Evidence',
  ...(validated.evidence.length?validated.evidence.map(item=>`- ${item}`):['- NONE']),
  '',
  '## Tests',
  ...(validated.tests.length?validated.tests.map(t=>`- \`${t.command}\` (exit ${t.exit_code}): ${t.output}`):['- NOT RUN']),
  '',
  `Errors: ${validated.errors.length?validated.errors.join('; '):'NONE'}`,
  ''
 ].join('\n');
 atomicWriteText(brief.paths.result_path,resultMd);
 atomicWriteJSON(brief.paths.report_path,validated);
 if(!existsSync(brief.paths.collected_report_path)){
  atomicWriteJSON(brief.paths.collected_report_path,validated,{exclusive:true});
 }
 const updated=collectWorkerReport(inbox,job.task_id);
 return {
  ok:true,
  task_id:job.task_id,
  attempt_id:job.attempt_id,
  inbox_state:updated.state,
  changed_files:validated.changed_files,
  result_path:brief.paths.result_path,
  report_path:brief.paths.report_path,
  collected_report_path:brief.paths.collected_report_path
 };
}

export async function runPreReportChecks(briefPath,{stateDirectory=DEFAULT_LIVE_STATE}={}){
 if(!briefPath)throw Error('Missing required --brief <brief.json>');
 const brief=readBoundedJSON(resolve(briefPath),65536);
 if(brief?.format!=='desktop-inbox.brief@1'||!brief?.job)throw Error('Invalid brief JSON format');
 const config=resolveWorkspaceConfig(brief.job.workspace_root,{stateDirectory});
 const runner=new CheckRunner(config.checks);
 const commands=Array.isArray(brief.job.verification_commands)?brief.job.verification_commands:[];
 const receipts=await Promise.all(commands.map(id=>runner.run(brief.job.workspace_root,id)));
 return {
  all_passed:receipts.every(r=>r.passed),
  checks:receipts.map(r=>({
   check_id:r.check_id,
   passed:r.passed,
   exit_code:r.exit_code,
   execution_ms:r.execution_ms,
   output:String(r.output??'').trim().slice(0,500)
  })),
  formatted_tests:receipts.map(r=>`check:${r.check_id}::${r.exit_code??1}::${(String(r.output??'').trim().replace(/\r?\n/g,' ').slice(0,240)||(r.passed?'ok':'failed'))}`)
 };
}

export async function main(args=process.argv.slice(2)){
 const opts={briefPath:null,status:'reported',summary:'',inspected:[],changed:null,findings:[],evidence:[],blockers:[],errors:[],tests:[],runChecks:false,stateDirectory:DEFAULT_LIVE_STATE};
 for(let i=0;i<args.length;i++){
  const flag=args[i],val=args[i+1];
  if(flag==='--brief'&&val)opts.briefPath=args[++i];
  else if(flag==='--status'&&val)opts.status=args[++i];
  else if(flag==='--summary'&&val)opts.summary=args[++i];
  else if(flag==='--inspected'&&val)opts.inspected.push(args[++i]);
  else if(flag==='--changed'&&val){if(opts.changed===null)opts.changed=[];opts.changed.push(args[++i]);}
  else if(flag==='--finding'&&val)opts.findings.push(args[++i]);
  else if(flag==='--evidence'&&val)opts.evidence.push(args[++i]);
  else if(flag==='--blocker'&&val)opts.blockers.push(args[++i]);
  else if(flag==='--error'&&val)opts.errors.push(args[++i]);
  else if(flag==='--test'&&val)opts.tests.push(args[++i]);
  else if(flag==='--run-checks')opts.runChecks=true;
  else if(flag==='--state'&&val)opts.stateDirectory=args[++i];
  else throw Error('Unknown or incomplete option: '+flag);
 }
 if(opts.runChecks){
  const precheck=await runPreReportChecks(opts.briefPath,{stateDirectory:opts.stateDirectory});
  opts.tests.push(...precheck.formatted_tests);
  if(!precheck.all_passed&&opts.status==='reported'){
   throw Error('Pre-report verification checks failed; fix before reporting to Codex Boss: '+precheck.checks.filter(c=>!c.passed).map(c=>`${c.check_id} (exit ${c.exit_code}): ${c.output}`).join(' | '));
  }
 }
 const out=submitWorkerReport(opts);
 process.stdout.write(JSON.stringify(out,null,2)+'\n');
 return out;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 main().catch(error=>{
  process.stderr.write(JSON.stringify({ok:false,error:error.message})+'\n');
  process.exitCode=1;
 });
}
