import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT,inside} from '../../src/core/util.mjs';
import {createToolHandler,MCP_TOOLS} from '../../src/desktop-inbox/mcp-server.mjs';
import {Inbox} from '../../src/desktop-inbox/inbox.mjs';

function setup(){
 const relative='state/test-desktop-mcp-'+randomUUID(),root=resolve(ROOT,relative),workspace=resolve(root,'workspace');
 mkdirSync(workspace,{recursive:true});writeFileSync(resolve(workspace,'README.md'),'# Test Project\nLocal fixture.\n');
 const binding={schema_version:'desktop-inbox.binding@1',enabled:false,workspace_root:workspace,project_id:'fixture-project',conversation_mode:'new',conversation_id:null,runtime_version:'2.29.0',poll_interval_ms:1000,transport_timeout_ms:10000,
  review:{authorization:false,runtime:false,project:true,conversation:false,user_opt_in:false,authorization_reference:'',runtime_reference:'',project_reference:'fixture-only known binding',conversation_reference:''}};
 const directory=relative+'/inbox';
 const call=createToolHandler({readBinding:()=>binding,inboxDirectory:directory});
 const args=()=>({task_id:randomUUID(),attempt_id:randomUUID(),workspace_root:workspace,request:'Read README.md.',read_scope:['README.md'],write_scope:[],acceptance_criteria:['Project title matches README.'],verification_commands:['readme-check']});
 return {root,directory,binding,call,args,close(){assert.ok(inside(resolve(ROOT,'state'),root)&&root!==resolve(ROOT,'state'));rmSync(root,{recursive:true,force:true});}};
}
function rpc(id,method,params){return {jsonrpc:'2.0',...(id===undefined?{}:{id}),method,...(params===undefined?{}:{params})};}
async function wire(messages){
 const child=spawn(process.execPath,[resolve(ROOT,'src/desktop-inbox/mcp-server.mjs'),'--binding','state/missing-binding-for-mcp-test.json'],{cwd:ROOT,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
 let output='',error='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>error+=data);
 const timer=setTimeout(()=>child.kill(),5000);
 try{
  const completed=new Promise((accept,reject)=>{child.on('error',reject);child.on('close',code=>code===0?accept():reject(Error('stdio failed: '+code+' '+error)));});
  const payload=messages.map(value=>typeof value==='string'?value:JSON.stringify(value)).join('\n')+'\n';
  // Split frames to exercise streaming instead of relying on data chunk boundaries.
  child.stdin.write(payload.slice(0,31));child.stdin.end(payload.slice(31));await completed;
  assert.equal(error,'');return output.trim().split('\n').map(line=>JSON.parse(line));
 }finally{clearTimeout(timer);if(child.exitCode===null)child.kill();}
}
const init=rpc(1,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture-client',version:'1'}});
const initialized=rpc(undefined,'notifications/initialized');

test('stdio initialization discovers exactly three tools without opening an inbox or binding',async()=>{
 const messages=await wire([init,initialized,rpc(2,'tools/list'),rpc(3,'tools/call',{name:'get_job_status',arguments:{task_id:randomUUID()}})]);
 assert.equal(messages[0].result.protocolVersion,'2025-11-25');
 assert.deepEqual(messages[1].result.tools.map(tool=>tool.name),['submit_job','get_job_status','get_job_result']);
 assert.deepEqual(MCP_TOOLS.map(tool=>tool.name),messages[1].result.tools.map(tool=>tool.name));
 assert.equal(messages[2].result.isError,true);assert.match(messages[2].result.content[0].text,/ENOENT/);
});

test('protocol errors stay separate from tool failures and lifecycle is enforced',async()=>{
 const messages=await wire(['{bad',rpc(7,'tools/list'),init,initialized,rpc(8,'tools/call',{name:'not-a-tool',arguments:{}}),rpc(9,'tools/call',{name:'submit_job',arguments:{}}),rpc(10,'ping')]);
 assert.equal(messages[0].error.code,-32700);assert.equal(messages[1].error.code,-32000);
 assert.equal(messages[3].error.code,-32602);assert.equal(messages[4].result.isError,true);
 assert.match(messages[4].result.content[0].text,/Invalid tool arguments/);assert.deepEqual(messages[5].result,{});
});

test('unsupported initialize version negotiates an advertised supported version',async()=>{
 const messages=await wire([{...init,params:{...init.params,protocolVersion:'2099-01-01'}},initialized,rpc(2,'tools/list')]);
 assert.equal(messages[0].result.protocolVersion,'2025-11-25');assert.equal(messages[1].result.tools.length,3);
});

test('submit atomically queues fixed task/attempt IDs; read-only tools cannot deliver or verify',()=>{
 const h=setup();try{
  const args=h.args(),result=h.call('submit_job',args);
  assert.equal(result.task_id,args.task_id);assert.equal(result.attempt_id,args.attempt_id);assert.equal(result.state,'PENDING');
  assert.equal(result.dispatch_availability,'NOT_ATTEMPTED_BY_MCP');assert.equal(result.delivery,null);assert.equal(result.host_receipt,null);
  assert.match(result.output_directory,new RegExp('output-'+args.attempt_id+'$'));
  const inbox=resolve(ROOT,h.directory),recordPath=resolve(inbox,'tasks',args.task_id,'record.json');
  const before=readFileSync(recordPath),bindingBefore=readFileSync(resolve(inbox,'binding.json'));
  const status=h.call('get_job_status',{task_id:args.task_id}),read=h.call('get_job_result',{task_id:args.task_id});
  assert.equal(status.state,'PENDING');assert.equal(read.result_available,false);
  assert.deepEqual(readFileSync(recordPath),before);assert.deepEqual(readFileSync(resolve(inbox,'binding.json')),bindingBefore);
  assert.equal(existsSync(resolve(inbox,'transaction.lock')),false);
  assert.equal(readdirSync(resolve(inbox,'tasks')).length,1);
  assert.throws(()=>h.call('submit_job',args),/Duplicate/);assert.throws(()=>h.call('submit_job',h.args()),/active/);
  assert.equal(readdirSync(resolve(inbox,'tasks')).length,1);
 }finally{h.close();}
});

test('scope, identity, acceptance and project gates reject invalid jobs before publication',()=>{
 const h=setup();try{
  for(const patch of [{task_id:'../escape'},{attempt_id:'not-an-id'},{acceptance_criteria:[]},{read_scope:['../README.md']},{write_scope:['.codex/config.toml']},{verification_commands:[]},{output_directory:'untrusted'},{request:' '}])assert.throws(()=>h.call('submit_job',{...h.args(),...patch}));
  h.binding.project_id='REVIEW_REQUIRED';h.binding.review.project=false;
  assert.throws(()=>h.call('submit_job',h.args()),/PROJECT_BINDING_NOT_VERIFIED/);
  assert.equal(existsSync(resolve(ROOT,h.directory,'tasks')),false);
 }finally{h.close();}
});

test('status/result reads do not initialize nonexistent state or accept caller completion claims',()=>{
 const h=setup();try{
  for(const name of ['get_job_status','get_job_result']){
   assert.throws(()=>h.call(name,{task_id:randomUUID()}),/ENOENT/);
   assert.throws(()=>h.call(name,{task_id:randomUUID(),status:'VERIFIED',host_receipt:{accepted:true}}),/Invalid tool arguments/);
  }
  assert.equal(existsSync(resolve(ROOT,h.directory)),false);
 }finally{h.close();}
});

test('get_job_result returns only hash-matching canonical report data and never promotes completion',()=>{
 const h=setup();try{
  const submitted=h.call('submit_job',h.args()),inbox=new Inbox(h.directory,h.binding);
  const claimed=inbox.claim(submitted.task_id);inbox.beginDispatch(submitted.task_id,claimed.claim_id);
  const report={schema_version:'desktop-inbox.report@1',task_id:submitted.task_id,attempt_id:submitted.attempt_id,
   workspace:h.binding.workspace_root,status:'reported',inspected_files:['README.md'],changed_files:[],tests:[],
   findings:['Test Project'],blockers:[],errors:[],evidence:['README inspected by fixture only']};
  writeFileSync(submitted.collected_report_path,JSON.stringify(report)+'\n');inbox.acceptReport(submitted.task_id);
  const result=h.call('get_job_result',{task_id:submitted.task_id});
  assert.equal(result.result_available,true);assert.equal(result.state,'RESULT_READY');assert.equal(result.host_receipt,null);
  assert.deepEqual(result.worker_report.errors,[]);assert.deepEqual(result.worker_report.evidence,report.evidence);
  writeFileSync(submitted.collected_report_path,JSON.stringify({...report,findings:['changed after collection']})+'\n');
  assert.throws(()=>h.call('get_job_result',{task_id:submitted.task_id}),/changed after collection/);
 }finally{h.close();}
});
