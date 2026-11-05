// Test-only stand-in. Its stdout is a MOCK contract, never an official agentapi schema.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const stateRoot=resolve(root,'state');
function fixturePath(value){
 const absolute=resolve(value),rel=relative(stateRoot,absolute);
 if(!rel||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel))throw Error('Mock fixture paths must stay under repository state');
 return absolute;
}

const args=process.argv.slice(2),mode=args[0];
if(!((mode==='send-message'&&args.length===3)||(mode==='new-conversation'&&args.length===2)))throw Error('Unexpected mock argv');
const payload=JSON.parse(args.at(-1));
if(payload.protocol!=='desktop-inbox.prompt@1')throw Error('Unexpected mock prompt protocol');
const scenario=process.env.DESKTOP_INBOX_MOCK_SCENARIO||'success';
if(scenario==='timeout'){
 await new Promise(resolveWait=>setTimeout(resolveWait,10000));
 process.exit(3);
}
if(scenario==='invalid-response'){
 process.stdout.write('intentionally invalid MOCK response\n');
 process.exit(0);
}
if(scenario==='failure'){
 process.stderr.write('Intentional MOCK transport failure\n');
 process.exit(2);
}
if(scenario!=='success'&&scenario!=='report-mismatch')throw Error('Unknown trusted mock scenario');
const job=payload.job,workspace=fixturePath(job.workspace_root);
const readme=readFileSync(resolve(workspace,'README.md'),'utf8');
const reportPath=fixturePath(payload.report_path);
const report={
 schema_version:'desktop-inbox.report@1',task_id:job.task_id,
 attempt_id:scenario==='report-mismatch'?'wrong-attempt':job.attempt_id,
 workspace:job.workspace_root,status:'reported',inspected_files:['README.md'],changed_files:[],tests:[],
 findings:['MOCK inspected README.md: '+readme.trim().slice(0,180)],blockers:[],errors:[],
 evidence:['MOCK read-only inspection; host verification remains required.']
};
mkdirSync(dirname(reportPath),{recursive:true});
writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({mock:true,accepted:true,conversation_id:mode==='send-message'?args[1]:'offline-new-conversation',argv:args})+'\n');
