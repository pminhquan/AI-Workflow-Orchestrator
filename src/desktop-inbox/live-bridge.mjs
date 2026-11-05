import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync,readdirSync,lstatSync} from 'node:fs';
import {basename,dirname,resolve} from 'node:path';
import {ROOT,safeRelative,scopedPath,sha256} from '../core/util.mjs';
import {Inbox} from './inbox.mjs';
import {UUID,MAX_REPORT_BYTES,canonicalWorkspace,sameWorkspace,validateReport} from './contracts.mjs';
import {readBoundedBytes} from './verification.mjs';
import {renderSubtaskPlanMarkdown} from './subtask-planner.mjs';

export const DEFAULT_LIVE_STATE='state/desktop-inbox-live';
const TARGET_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function checkedStateDirectory(stateDirectory=DEFAULT_LIVE_STATE){
 safeRelative(stateDirectory);
 if(!stateDirectory.startsWith('state/')||stateDirectory==='state/')throw Error('Live bridge state must be under canonical state/');
 return stateDirectory;
}

export function atomicWriteBytes(path,bytes,{exclusive=false}={}){
 mkdirSync(dirname(path),{recursive:true});
 const temp=path+'.tmp-'+randomUUID();let fd;
 try{
  fd=openSync(temp,'wx');writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;
  if(exclusive){if(existsSync(path))throw Object.assign(Error('File already exists'),{code:'EEXIST'});renameSync(temp,path);}
  else renameSync(temp,path);
 }finally{
  if(fd!==undefined)closeSync(fd);
  if(existsSync(temp))unlinkSync(temp);
 }
}
export function atomicWriteJSON(path,value,options={}){
 return atomicWriteBytes(path,Buffer.from(JSON.stringify(value,null,2)+'\n','utf8'),options);
}
export function atomicWriteText(path,text,options={}){
 return atomicWriteBytes(path,Buffer.from(String(text),'utf8'),options);
}
export function readBoundedJSON(path,limit=65536){
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readBoundedBytes(path,limit)));
}

export function workspaceSlug(workspaceRoot){
 const canonical=canonicalWorkspace(workspaceRoot);
 const normalized=process.platform==='win32'?canonical.toLowerCase():canonical;
 const rawBase=basename(canonical).replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48);
 const safeBase=rawBase&&/^[A-Za-z0-9]/.test(rawBase)?rawBase:'workspace';
 return `${safeBase}-${sha256(normalized).slice(0,8)}`;
}

export function workspaceStateRelative(workspaceRoot,stateDirectory=DEFAULT_LIVE_STATE){
 return `${checkedStateDirectory(stateDirectory)}/workspaces/${workspaceSlug(workspaceRoot)}`;
}
export function workspaceInboxRelative(workspaceRoot,stateDirectory=DEFAULT_LIVE_STATE){
 return `${workspaceStateRelative(workspaceRoot,stateDirectory)}/inbox`;
}
export function activeTargetPath(workspaceRoot,stateDirectory=DEFAULT_LIVE_STATE){
 return scopedPath(ROOT,`${workspaceStateRelative(workspaceRoot,stateDirectory)}/active-target.json`);
}
export function sidecarHeartbeatPath(stateDirectory=DEFAULT_LIVE_STATE){
 return scopedPath(ROOT,`${checkedStateDirectory(stateDirectory)}/sidecar-heartbeat.json`);
}

function validateCheckSpecs(checks){
 const result={};
 for(const [id,spec] of Object.entries(checks??{})){
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(id))throw Error('Invalid check ID: '+id);
  if(!spec||!Array.isArray(spec.args)||spec.args.some(arg=>typeof arg!=='string')||!Array.isArray(spec.inputs)||!spec.inputs.length||!Number.isInteger(spec.timeout_ms)||spec.timeout_ms<1||spec.timeout_ms>5000)throw Error('Invalid check specification: '+id);
  spec.inputs.forEach(safeRelative);
  result[id]={args:[...spec.args],inputs:[...spec.inputs],timeout_ms:spec.timeout_ms,cacheable:false};
 }
 return result;
}

function loadWorkspaceRegistry(stateDirectory=DEFAULT_LIVE_STATE){
 const canonicalPath=scopedPath(ROOT,'config/integrations/desktop-workspaces.json');
 const base=existsSync(canonicalPath)?readBoundedJSON(canonicalPath,65536):{default_checks:{noop:{args:['-e',"process.stdout.write('ok\\n')"],inputs:['README.md'],timeout_ms:2000}},workspaces:[]};
 const localPath=scopedPath(ROOT,`${checkedStateDirectory(stateDirectory)}/workspaces.json`);
 const local=existsSync(localPath)?readBoundedJSON(localPath,65536):{workspaces:[]};
 return {
  defaultChecks:validateCheckSpecs(base.default_checks),
  entries:[...(Array.isArray(base.workspaces)?base.workspaces:[]),...(Array.isArray(local.workspaces)?local.workspaces:[])]
 };
}

export function resolveWorkspaceConfig(workspaceRoot=ROOT,{stateDirectory=DEFAULT_LIVE_STATE}={}){
 const workspace=canonicalWorkspace(workspaceRoot);
 const slug=workspaceSlug(workspace);
 const registry=loadWorkspaceRegistry(stateDirectory);
 const checks={...registry.defaultChecks};
 let allowNewConversation=false;
 for(const entry of registry.entries){
  if(!entry||typeof entry.workspace_root!=='string')continue;
  const candidatePath=entry.workspace_root==='.'?ROOT:entry.workspace_root;
  if(!existsSync(candidatePath))continue;
  let candidate;try{candidate=canonicalWorkspace(candidatePath);}catch{continue;}
  if(!sameWorkspace(candidate,workspace))continue;
  Object.assign(checks,validateCheckSpecs(entry.checks));
  if(typeof entry.allow_new_conversation==='boolean')allowNewConversation=entry.allow_new_conversation;
 }
 return {
  workspace_root:workspace,
  slug,
  binding:{workspace_root:workspace,project_id:slug},
  allow_new_conversation:allowNewConversation,
  checks
 };
}

export function registerLocalWorkspace(workspaceRoot,{allowNewConversation=false,checks={},stateDirectory=DEFAULT_LIVE_STATE}={}){
 const workspace=canonicalWorkspace(workspaceRoot);
 const validatedChecks=validateCheckSpecs(checks);
 const localPath=scopedPath(ROOT,`${checkedStateDirectory(stateDirectory)}/workspaces.json`);
 const current=existsSync(localPath)?readBoundedJSON(localPath,65536):{schema_version:'desktop-inbox.local-workspaces@1',workspaces:[]};
 const list=Array.isArray(current.workspaces)?current.workspaces.filter(item=>{
  if(!item||typeof item.workspace_root!=='string'||!existsSync(item.workspace_root))return true;
  try{return !sameWorkspace(item.workspace_root,workspace);}catch{return true;}
 }):[];
 list.push({workspace_root:workspace,allow_new_conversation:Boolean(allowNewConversation),checks:validatedChecks,updated_at:new Date().toISOString()});
 atomicWriteJSON(localPath,{schema_version:'desktop-inbox.local-workspaces@1',workspaces:list});
 return resolveWorkspaceConfig(workspace,{stateDirectory});
}

export function writeActiveTarget(workspaceRoot,{conversationId,eventName='SessionStart',modelName=null,stateDirectory=DEFAULT_LIVE_STATE,now=Date.now}={}){
 const config=resolveWorkspaceConfig(workspaceRoot,{stateDirectory});
 if(typeof conversationId!=='string'||!TARGET_ID.test(conversationId.trim()))throw Error('Invalid conversationId for active target');
 const payload={
  format:'desktop-inbox.active-target@1',
  workspace_root:config.workspace_root,
  project_id:config.slug,
  conversation_id:conversationId.trim(),
  event_name:String(eventName??'SessionStart').slice(0,64),
  model_name:typeof modelName==='string'&&modelName.trim()?modelName.trim().slice(0,128):null,
  updated_at:new Date(now()).toISOString()
 };
 const path=activeTargetPath(config.workspace_root,stateDirectory);
 atomicWriteJSON(path,payload);
 return {path,target:payload};
}

export function readActiveTarget(workspaceRoot,{stateDirectory=DEFAULT_LIVE_STATE}={}){
 const config=resolveWorkspaceConfig(workspaceRoot,{stateDirectory});
 const path=activeTargetPath(config.workspace_root,stateDirectory);
 if(!existsSync(path))return null;
 try{
  const data=readBoundedJSON(path,8192);
  if(data?.format!=='desktop-inbox.active-target@1'||!TARGET_ID.test(String(data.conversation_id??''))||!sameWorkspace(data.workspace_root,config.workspace_root))return null;
  return data;
 }catch{return null;}
}

export function writeSidecarHeartbeat(status,{stateDirectory=DEFAULT_LIVE_STATE,now=Date.now,extra={}}={}){
 const payload={
  format:'desktop-inbox.sidecar-heartbeat@1',
  pid:process.pid,
  status:String(status).slice(0,64),
  updated_at:new Date(now()).toISOString(),
  ...extra
 };
 atomicWriteJSON(sidecarHeartbeatPath(stateDirectory),payload);
 return payload;
}

export function readSidecarHeartbeat({stateDirectory=DEFAULT_LIVE_STATE}={}){
 const path=sidecarHeartbeatPath(stateDirectory);
 if(!existsSync(path))return null;
 try{return readBoundedJSON(path,8192);}catch{return null;}
}

export function openLiveInbox(workspaceRoot=ROOT,{stateDirectory=DEFAULT_LIVE_STATE,now=Date.now}={}){
 const config=resolveWorkspaceConfig(workspaceRoot,{stateDirectory});
 const inboxRelative=workspaceInboxRelative(config.workspace_root,stateDirectory);
 const inbox=new Inbox(inboxRelative,config.binding,{now});
 return {inbox,config,inboxRelative};
}

export function existingLiveInbox(workspaceRoot=ROOT,{stateDirectory=DEFAULT_LIVE_STATE,now=Date.now}={}){
 const config=resolveWorkspaceConfig(workspaceRoot,{stateDirectory});
 const inboxRelative=workspaceInboxRelative(config.workspace_root,stateDirectory);
 const root=scopedPath(ROOT,inboxRelative);
 if(!existsSync(root))return {inbox:null,config,inboxRelative};
 const bindingPath=scopedPath(root,'binding.json');
 if(!existsSync(bindingPath))return {inbox:null,config,inboxRelative};
 const stored=readBoundedJSON(bindingPath,4096);
 if(!stored||Object.keys(stored).sort().join(',')!=='project_id,workspace_root'||stored.project_id!==config.binding.project_id||!sameWorkspace(stored.workspace_root,config.binding.workspace_root))throw Error('Live inbox binding mismatch');
 const inbox=Object.assign(Object.create(Inbox.prototype),{root,binding:config.binding,now,lockPath:scopedPath(root,'transaction.lock')});
 return {inbox,config,inboxRelative};
}

export function listLiveWorkspaces({stateDirectory=DEFAULT_LIVE_STATE}={}){
 const dir=scopedPath(ROOT,`${checkedStateDirectory(stateDirectory)}/workspaces`);
 if(!existsSync(dir))return [];
 const results=[];
 for(const entry of readdirSync(dir).sort()){
  const wsDir=scopedPath(dir,entry);
  if(!lstatSync(wsDir).isDirectory())continue;
  const bindingPath=scopedPath(wsDir,'inbox/binding.json');
  const targetPath=scopedPath(wsDir,'active-target.json');
  let workspaceRoot=null;
  if(existsSync(bindingPath)){try{workspaceRoot=readBoundedJSON(bindingPath,4096).workspace_root;}catch{}}
  else if(existsSync(targetPath)){try{workspaceRoot=readBoundedJSON(targetPath,8192).workspace_root;}catch{}}
  if(workspaceRoot&&existsSync(workspaceRoot)){try{results.push(canonicalWorkspace(workspaceRoot));}catch{}}
 }
 return results;
}

export function findTaskAcrossWorkspaces(taskId,{workspaceRoot=null,stateDirectory=DEFAULT_LIVE_STATE,now=Date.now}={}){
 if(typeof taskId!=='string'||!UUID.test(taskId))throw Error('Invalid task_id');
 if(workspaceRoot){
  const opened=existingLiveInbox(workspaceRoot,{stateDirectory,now});
  if(!opened.inbox)throw Error('Task not found (workspace inbox not initialized): '+taskId);
  return {...opened,record:opened.inbox.get(taskId)};
 }
 for(const ws of listLiveWorkspaces({stateDirectory})){
  const opened=existingLiveInbox(ws,{stateDirectory,now});
  if(!opened.inbox)continue;
  const recordPath=scopedPath(opened.inbox.root,`tasks/${taskId}/record.json`);
  if(existsSync(recordPath))return {...opened,record:opened.inbox.get(taskId)};
 }
 throw Error('Task not found in any live workspace inbox: '+taskId);
}

export function jobPaths(inbox,job){
 const taskDir=scopedPath(inbox.root,`tasks/${job.task_id}`);
 const outputDirectory=scopedPath(inbox.root,`tasks/${job.task_id}/output-${job.attempt_id}`);
 return {
  task_directory:taskDir,
  brief_json_path:scopedPath(inbox.root,`tasks/${job.task_id}/brief-${job.attempt_id}.json`),
  brief_md_path:scopedPath(inbox.root,`tasks/${job.task_id}/brief-${job.attempt_id}.md`),
  output_directory:outputDirectory,
  result_path:resolve(outputDirectory,'result.md'),
  report_path:resolve(outputDirectory,'report.json'),
  collected_report_path:scopedPath(inbox.root,job.expected_output)
 };
}

export function writeJobBrief(inbox,job,{subtaskPlan=null}={}){
 const paths=jobPaths(inbox,job);
 if(!subtaskPlan&&existsSync(paths.brief_json_path)){
  try{subtaskPlan=readBoundedJSON(paths.brief_json_path,65536)?.subtask_plan??null;}catch{}
 }
 const reportCliPosix=scopedPath(ROOT,'src/desktop-inbox/report-cli.mjs').replaceAll('\\','/');
 const briefJsonPosix=paths.brief_json_path.replaceAll('\\','/');
 const briefPayload={
  format:'desktop-inbox.brief@1',
  job,
  subtask_plan:subtaskPlan??null,
  inbox_root:inbox.root,
  paths,
  report_cli:reportCliPosix
 };
 atomicWriteJSON(paths.brief_json_path,briefPayload);
 const modeLabel=job.write_scope.length?'WRITE-SCOPED (được phép sửa trong write_scope)':'READ-ONLY (chỉ đọc, tuyệt đối không sửa file trong workspace)';
 const writeLines=job.write_scope.length?job.write_scope.map(p=>`- \`${p}\``).join('\n'):'- *(Trống — nhiệm vụ chỉ đọc)*';
 const subtaskMd=subtaskPlan?['',renderSubtaskPlanMarkdown(subtaskPlan).trimEnd()]:[];
 const md=[
  `# Codex Boss Job Brief — \`${job.task_id}\``,
  '',
  `- **Task ID:** \`${job.task_id}\``,
  `- **Attempt ID:** \`${job.attempt_id}\``,
  `- **Workspace Root:** \`${job.workspace_root}\``,
  `- **Chế độ quyền hạn:** ${modeLabel}`,
  ...(subtaskPlan?[`- **Chế độ Swarm:** \`${subtaskPlan.total_subtasks} subtasks / ${subtaskPlan.waves.length} waves (max parallel: ${subtaskPlan.max_parallelism})\``]:[]),
  '',
  '## 1. Mục tiêu (Goal)',
  '',
  job.goal,
  ...subtaskMd,
  '',
  '## 2. Phạm vi file cho phép (Scope)',
  '',
  '### Read Scope (`read_scope`)',
  ...job.read_scope.map(p=>`- \`${p}\``),
  '',
  '### Write Scope (`write_scope`)',
  writeLines,
  '',
  '> Không đọc/ghi ngoài danh sách trên. Không sửa `.codex/`, `.gemini/`, không commit/push trừ khi được yêu cầu rõ, không tự ghi nhận trạng thái `VERIFIED` (Codex Boss sẽ tự verify độc lập).',
  '',
  '## 3. Tiêu chí nghiệm thu (`acceptance_criteria`) & Checks (`verification_commands`)',
  '',
  ...job.acceptance_criteria.map((item,idx)=>`${idx+1}. ${item}`),
  '',
  `- **Registered Host Checks:** ${job.verification_commands.map(c=>`\`${c}\``).join(', ')}`,
  '',
  '## 4. Lệnh tự kiểm chứng song song & nộp báo cáo về Codex Boss (BẮT BUỘC)',
  '',
  'Sau khi hoàn thành công việc, chạy **1 lệnh duy nhất** dưới đây (`--run-checks` sẽ chạy song song các check ngay tại local trước khi nộp để tránh phải rework):',
  '',
  '```powershell',
  `node "${reportCliPosix}" --brief "${briefJsonPosix}" --run-checks --status reported --summary "<tóm tắt kết quả ngắn gọn>" --inspected "${job.read_scope[0]}" --finding "<phát hiện hoặc thay đổi chính>" --evidence "<bằng chứng cụ thể: file/line/test/hash>"`,
  '```',
  '',
  '- Nếu có chạy thêm test khác, thêm `--test "<lệnh>::<exit_code>::<output_ngắn>"` (có thể lặp lại nhiều cờ `--finding`, `--evidence`, `--test`).',
  '- Nếu bị chặn bởi điều kiện thiếu, đổi `--status blocked` (bỏ `--run-checks`) và thêm `--blocker "<lý do>"`.',
  '- Nếu gặp lỗi thực thi, đổi `--status failed` (bỏ `--run-checks`) và thêm `--error "<lỗi>"`.',
  ''
 ].join('\n');
 atomicWriteText(paths.brief_md_path,md);
 return paths;
}

export function buildSingleLineTrigger(job,briefMdPath,{subtaskPlan=null}={}){
 if(!subtaskPlan){
  const siblingJson=String(briefMdPath).replace(/\.md$/i,'.json');
  if(existsSync(siblingJson)){try{subtaskPlan=readBoundedJSON(siblingJson,65536)?.subtask_plan??null;}catch{}}
 }
 const briefPosix=String(briefMdPath).replaceAll('\\','/');
 const mode=job.write_scope.length?'WRITE':'READ';
 const swarmTag=subtaskPlan?` | SWARM ${subtaskPlan.total_subtasks}x/W${subtaskPlan.waves.length}`:'';
 const cleanGoal=String(job.goal).replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim().slice(0,200);
 const trigger=`[Codex Boss Job ${job.task_id.slice(0,8)} | ${mode}${swarmTag}] Đọc và thực hiện đúng brief tại ${briefPosix} — Yêu cầu: ${cleanGoal}. Khi hoàn tất, chạy lệnh report-cli --run-checks trong brief để nộp báo cáo cho Codex.`.replace(/[\r\n\t\x00-\x1f]+/g,' ').trim();
 if(/[\r\n\0]/.test(trigger)||!trigger.length)throw Error('Single-line trigger invariant violated');
 return trigger;
}

export function collectWorkerReport(inbox,taskId){
 const record=inbox.get(taskId);
 if(['RESULT_READY','VERIFIED'].includes(record.state)||['FAILED','RELEASED'].includes(record.outcome))return record;
 if(record.state!=='DISPATCHED')return record;
 const paths=jobPaths(inbox,record.job);
 if(!existsSync(paths.collected_report_path)){
  if(!existsSync(paths.report_path))return record;
  const rawReport=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readBoundedBytes(paths.report_path,MAX_REPORT_BYTES)));
  const legacyResultText=existsSync(paths.result_path)?new TextDecoder('utf-8',{fatal:true}).decode(readBoundedBytes(paths.result_path,MAX_REPORT_BYTES)):undefined;
  const normalized=validateReport(rawReport,record.job,{legacyResultText});
  atomicWriteJSON(paths.collected_report_path,normalized,{exclusive:true});
 }
 return inbox.acceptReport(taskId);
}
