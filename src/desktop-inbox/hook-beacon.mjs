import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DEFAULT_LIVE_STATE,writeActiveTarget} from './live-bridge.mjs';
import {canonicalWorkspace} from './contracts.mjs';

function extractWorkspaces(payload){
 const candidates=[];
 if(Array.isArray(payload?.workspacePaths))candidates.push(...payload.workspacePaths);
 if(Array.isArray(payload?.workspace_roots))candidates.push(...payload.workspace_roots);
 for(const key of ['workspacePath','workspace_root','workspace','cwd']){
  if(typeof payload?.[key]==='string'&&payload[key].trim())candidates.push(payload[key]);
 }
 const unique=[];
 for(const raw of candidates){
  if(typeof raw!=='string'||!existsSync(raw))continue;
  try{
   const canonical=canonicalWorkspace(raw);
   const norm=process.platform==='win32'?canonical.toLowerCase():canonical;
   if(!unique.some(item=>(process.platform==='win32'?item.toLowerCase():item)===norm))unique.push(canonical);
  }catch{}
 }
 return unique;
}

export function processBeaconInput(payload,{eventName='SessionStart',stateDirectory=DEFAULT_LIVE_STATE,now=Date.now}={}){
 const conversationId=payload?.conversationId??payload?.conversation_id??payload?.sessionId??null;
 if(typeof conversationId!=='string'||!conversationId.trim())return {updated:[],skipped:'missing_conversation_id'};
 const event=String(payload?.hookEventName??payload?.event??eventName??'SessionStart');
 const modelName=payload?.modelName??payload?.model??null;
 const workspaces=extractWorkspaces(payload);
 const updated=[];
 for(const ws of workspaces){
  const res=writeActiveTarget(ws,{conversationId,eventName:event,modelName,stateDirectory,now});
  updated.push({workspace_root:ws,conversation_id:res.target.conversation_id,path:res.path});
 }
 return {updated,skipped:updated.length?null:'no_valid_workspace'};
}

async function readStdinBounded(limit=65536,timeoutMs=1500){
 if(process.stdin.isTTY)return '';
 return await new Promise(resolveInput=>{
  const chunks=[];let total=0,done=false;
  const finish=()=>{if(done)return;done=true;clearTimeout(timer);resolveInput(Buffer.concat(chunks).toString('utf8'));};
  const timer=setTimeout(finish,timeoutMs);
  process.stdin.on('data',chunk=>{
   if(done)return;
   const buf=Buffer.from(chunk);
   if(total+buf.length<=limit){chunks.push(buf);total+=buf.length;}
   else finish();
  });
  process.stdin.on('end',finish);
  process.stdin.on('error',finish);
 });
}

export async function main(args=process.argv.slice(2)){
 let eventName='SessionStart',stateDirectory=DEFAULT_LIVE_STATE,seedWorkspace=null,seedConversation=null,seedModel=null;
 for(let i=0;i<args.length;i++){
  const arg=args[i];
  if(arg==='--state'&&args[i+1]){stateDirectory=args[++i];}
  else if(arg==='--seed-workspace'&&args[i+1]){seedWorkspace=args[++i];}
  else if(arg==='--conversation'&&args[i+1]){seedConversation=args[++i];}
  else if(arg==='--model'&&args[i+1]){seedModel=args[++i];}
  else if(!arg.startsWith('--'))eventName=arg;
 }
 if(seedWorkspace&&seedConversation){
  const res=writeActiveTarget(seedWorkspace,{conversationId:seedConversation,eventName,modelName:seedModel,stateDirectory});
  process.stdout.write(JSON.stringify({ok:true,target:res.target,path:res.path})+'\n');
  return;
 }
 try{
  const raw=await readStdinBounded();
  if(raw.trim()){
   const payload=JSON.parse(raw);
   processBeaconInput(payload,{eventName,stateDirectory});
  }
 }catch{
  // Hooks must never block or fail a live Antigravity Desktop conversation turn.
 }
 process.stdout.write('{}\n');
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 main().catch(()=>{process.stdout.write('{}\n');process.exitCode=0;});
}
