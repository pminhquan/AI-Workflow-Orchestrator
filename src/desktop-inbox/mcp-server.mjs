import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Inbox} from './inbox.mjs';
import {validateBinding} from './binding.mjs';
import {UUID,MAX_JOB_BYTES,MAX_REPORT_BYTES,boundedJSON,makeJob,sameWorkspace,validateReport} from './contracts.mjs';
import {captureWorkspace,readBoundedBytes} from './verification.mjs';
import {ROOT,safeRelative,scopedPath,sha256} from '../core/util.mjs';
import {validate} from '../core/schema.mjs';

const text={type:'string',minLength:1};
const taskId={type:'string',pattern:UUID.source};
const paths={type:'array',maxItems:32,uniqueItems:true,items:text};
const lookup={type:'object',additionalProperties:false,required:['task_id'],properties:{task_id:taskId}};
export const MCP_TOOLS=[
 {name:'submit_job',description:'Atomically queue one validated local job. Submission is not delivery or execution. The App-owned receiver must independently validate activation and project proof.',
  inputSchema:{type:'object',additionalProperties:false,required:['task_id','workspace_root','request','read_scope','write_scope','acceptance_criteria','verification_commands'],properties:{
   task_id:taskId,attempt_id:taskId,workspace_root:text,request:text,read_scope:{...paths,minItems:1},write_scope:paths,
   acceptance_criteria:{type:'array',minItems:1,maxItems:16,uniqueItems:true,items:text},
   verification_commands:{type:'array',minItems:1,maxItems:8,uniqueItems:true,items:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'}}}},
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
 {name:'get_job_status',description:'Read an existing durable inbox record without dispatching, creating state or accepting worker claims.',inputSchema:lookup,
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
 {name:'get_job_result',description:'Return existing durable result paths and metadata. VERIFIED requires the independent parent verifier; this tool never accepts results.',inputSchema:lookup,
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}}
];

function readJSON(path,limit){return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readBoundedBytes(path,limit)));}
function checkedDirectory(directory){safeRelative(directory);if(!directory.startsWith('state/')||directory==='state/')throw Error('Inbox must be under canonical state/');return scopedPath(ROOT,directory);}
function resultPaths(inbox,job){
 const directory=scopedPath(inbox.root,'tasks/'+job.task_id+'/output-'+job.attempt_id);
 return {output_directory:directory,result_path:resolve(directory,'result.md'),report_path:resolve(directory,'report.json'),
  collected_report_path:scopedPath(inbox.root,job.expected_output)};
}
function metadata(inbox,record){
 return {task_id:record.job.task_id,attempt_id:record.job.attempt_id,workspace_root:record.job.workspace_root,
  project_id:record.job.project_id,state:record.state,outcome:record.outcome,claim_id:record.claim_id,
  ...resultPaths(inbox,record.job),delivery:record.delivery,
  report_sha256:record.report_sha256,report_original_path:record.report_original_path===null?null:scopedPath(inbox.root,record.report_original_path),
  host_receipt:record.host_receipt,events:record.events};
}

// Read-only calls reuse Inbox's bounded record validation without its mutating
// constructor (which initializes binding.json and takes a transaction lock).
function existingInbox(directory,binding,now){
 const root=checkedDirectory(directory),stored=readJSON(scopedPath(root,'binding.json'),4096);
 if(!stored||Object.keys(stored).sort().join(',')!=='project_id,workspace_root'||stored.project_id!==binding.project_id||!sameWorkspace(stored.workspace_root,binding.workspace_root))throw Error('Inbox binding mismatch');
 return Object.assign(Object.create(Inbox.prototype),{root,binding,now});
}

export function createToolHandler({readBinding,inboxDirectory='state/desktop-inbox-app',now=Date.now}={}){
 checkedDirectory(inboxDirectory);
 if(typeof readBinding!=='function')throw Error('A project-local binding reader is required');
 return function callTool(name,args){
  const tool=MCP_TOOLS.find(item=>item.name===name);
  if(!tool)throw Error('Unknown MCP tool');
  boundedJSON(args,MAX_JOB_BYTES,'Tool arguments');
  const checked=validate(args,tool.inputSchema);if(!checked.valid)throw Error('Invalid tool arguments: '+checked.errors.join('; '));
  const binding=validateBinding(readBinding());
  if(name==='submit_job'){
   // These are parent-reviewed configuration references, not independent App
   // attestation. The receiver has a separate live/project evidence gate.
   if(binding.project_id==='REVIEW_REQUIRED'||!binding.review.project||!binding.review.project_reference.trim())throw Error('PROJECT_BINDING_NOT_VERIFIED: no reviewed workspace/project evidence');
   if(!sameWorkspace(args.workspace_root,binding.workspace_root))throw Error('Wrong workspace binding');
   const {request,workspace_root,...fields}=args;
   const job=makeJob(binding,{...fields,workspace_root,goal:request},{now});
   const inbox=new Inbox(inboxDirectory,binding,{now});
   const record=inbox.submit(job,{baseline:captureWorkspace(binding.workspace_root)});
   return {...metadata(inbox,record),dispatch_availability:'NOT_ATTEMPTED_BY_MCP',
    pending_reason:'Queued only; an App-owned receiver must validate live activation and independent project evidence before delivery.'};
  }
  const inbox=existingInbox(inboxDirectory,binding,now),record=inbox.get(args.task_id);
  const result=metadata(inbox,record);
  if(name==='get_job_result'){
   result.result_available=['RESULT_READY','VERIFIED'].includes(record.state);
   result.worker_report=null;
   if(result.result_available){
    const bytes=readBoundedBytes(scopedPath(inbox.root,record.job.expected_output),MAX_REPORT_BYTES);
    if(sha256(bytes)!==record.report_sha256)throw Error('Worker report changed after collection');
    result.worker_report=validateReport(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),record.job);
   }
  }
  return result;
 };
}

const SUPPORTED_VERSIONS=['2025-11-25','2025-06-18'];
const MAX_MESSAGE_BYTES=65536;
function rpcError(id,code,message){return {jsonrpc:'2.0',id,error:{code,message}};}
export function startStdioServer({input=process.stdin,output=process.stdout,callTool}={}){
 if(typeof callTool!=='function')throw Error('Tool handler required');
 let phase='NEW',pending=Buffer.alloc(0),closed=false;
 const send=value=>output.write(JSON.stringify(value)+'\n');
 function receive(line){
  let message;try{message=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));}catch{send(rpcError(null,-32700,'Invalid UTF-8 or JSON'));return;}
  if(!message||Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||(Object.hasOwn(message,'id')&&!(typeof message.id==='string'||Number.isSafeInteger(message.id)))){send(rpcError(null,-32600,'Invalid JSON-RPC request'));return;}
  const {method,params,id}=message,request=Object.hasOwn(message,'id');
  if(!request){if(method==='notifications/initialized'&&phase==='INITIALIZING')phase='READY';return;}
  if(method==='ping'){send({jsonrpc:'2.0',id,result:{}});return;}
  if(method==='initialize'){
   if(phase!=='NEW'){send(rpcError(id,-32600,'Already initialized'));return;}
   if(!params||typeof params.protocolVersion!=='string'||!params.capabilities||typeof params.capabilities!=='object'||Array.isArray(params.capabilities)||!params.clientInfo||typeof params.clientInfo.name!=='string'||typeof params.clientInfo.version!=='string'){send(rpcError(id,-32602,'Invalid initialize params'));return;}
   // Version fallback is required by the supported 2025 lifecycle. We do not
   // advertise the incompatible 2026-07-28 discovery protocol.
   const protocolVersion=SUPPORTED_VERSIONS.includes(params.protocolVersion)?params.protocolVersion:SUPPORTED_VERSIONS[0];
   phase='INITIALIZING';send({jsonrpc:'2.0',id,result:{protocolVersion,capabilities:{tools:{listChanged:false}},serverInfo:{name:'desktop-inbox',version:'2.3.0-foundation'},instructions:'Queueing is not delivery. Only the parent verifier can mark jobs VERIFIED.'}});return;
  }
  if(phase!=='READY'){send(rpcError(id,-32000,'Initialize and send notifications/initialized first'));return;}
  if(method==='tools/list'){
   if(params&&Object.hasOwn(params,'cursor')){send(rpcError(id,-32602,'Pagination cursor unsupported'));return;}
   send({jsonrpc:'2.0',id,result:{tools:MCP_TOOLS}});return;
  }
  if(method==='tools/call'){
   if(!params||typeof params.name!=='string'||!MCP_TOOLS.some(tool=>tool.name===params.name)){send(rpcError(id,-32602,'Unknown tool'));return;}
   try{const result=callTool(params.name,params.arguments??{});send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false}});}
   catch(error){send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:error.message}],isError:true}});}
   return;
  }
  send(rpcError(id,-32601,'Method not found'));
 }
 input.on('data',chunk=>{
  if(closed)return;
  pending=Buffer.concat([pending,Buffer.from(chunk)]);
  let at;while((at=pending.indexOf(10))!==-1){const line=pending.subarray(0,at);pending=pending.subarray(at+1);if(line.length>MAX_MESSAGE_BYTES){send(rpcError(null,-32600,'Message too large'));closed=true;input.destroy();return;}if(line.length)receive(line);}
  if(pending.length>MAX_MESSAGE_BYTES){send(rpcError(null,-32600,'Message too large'));closed=true;input.destroy();}
 });
 input.on('end',()=>{if(!closed&&pending.length)send(rpcError(null,-32700,'Incomplete newline-delimited message'));});
 return {close(){closed=true;input.destroy();}};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{
  const args=process.argv.slice(2);let bindingPath='integrations/antigravity-inbox/app-binding.json',inboxDirectory='state/desktop-inbox-app';
  for(let i=0;i<args.length;i+=2){if(!args[i+1])throw Error('Expected --binding <path> --inbox <state/relative-directory>');if(args[i]==='--binding')bindingPath=args[i+1];else if(args[i]==='--inbox')inboxDirectory=args[i+1];else throw Error('Unknown server option');}
  const path=scopedPath(ROOT,bindingPath);
  startStdioServer({callTool:createToolHandler({readBinding:()=>readJSON(path,8192),inboxDirectory})});
 }catch(error){process.stderr.write(JSON.stringify({status:'ERROR',message:error.message})+'\n');process.exitCode=1;}
}
