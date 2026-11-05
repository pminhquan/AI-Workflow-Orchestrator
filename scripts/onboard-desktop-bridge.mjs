import {existsSync,mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ROOT,scopedPath} from '../src/core/util.mjs';
import {canonicalWorkspace,sameWorkspace} from '../src/desktop-inbox/contracts.mjs';
import {registerLocalWorkspace} from '../src/desktop-inbox/live-bridge.mjs';

const CANONICAL_SKILLS=['codex-worker','antigravity-orchestrator'];
const READY_HINT='Run node src/desktop-inbox/bridge-cli.mjs doctor --workspace <path> to verify live readiness.';

function buildHookEntry(){
 const beaconPosix=scopedPath(ROOT,'src/desktop-inbox/hook-beacon.mjs').replaceAll('\\','/');
 return {
  enabled:true,
  SessionStart:[{type:'command',command:`node ${beaconPosix} SessionStart`,timeout:5}],
  PreInvocation:[{type:'command',command:`node ${beaconPosix} PreInvocation`,timeout:5}]
 };
}

function buildCodexMcpTomlSection(workspaceRoot){
 const serverPath=scopedPath(ROOT,'src/desktop-inbox/live-mcp-server.mjs');
 return [
  '# Project-local stdio MCP server for Codex Boss -> Antigravity Desktop GUI workflow.',
  '[mcp_servers.desktop_inbox]',
  'command = "node"',
  `args = ['${serverPath}', '--workspace', '${workspaceRoot}']`,
  `cwd = '${workspaceRoot}'`,
  'enabled = true',
  'enabled_tools = ["bridge_status", "submit_job", "wait_job", "get_job_status", "get_job_result", "verify_job", "release_job"]',
  'startup_timeout_sec = 10',
  'tool_timeout_sec = 120',
  ''
 ].join('\n');
}

export function onboardWorkspace(targetPath,{dryRun=false,force=false,allowNewConversation=false,stateDirectory}={}){
 const workspace=canonicalWorkspace(targetPath);
 const actions=[];

 const codexDir=resolve(workspace,'.codex');
 if(existsSync(codexDir)){
  const unexpected=readdirSync(codexDir).filter(name=>name!=='config.toml');
  if(unexpected.length)throw Error(`Target .codex/ contains private entries (${unexpected.join(', ')}) incompatible with workspace snapshot rules`);
 }

 // 1. .agents/hooks.json (merge safely)
 const hooksPath=resolve(workspace,'.agents/hooks.json');
 let hooksObj={};
 if(existsSync(hooksPath)){
  hooksObj=JSON.parse(readFileSync(hooksPath,'utf8'));
 }
 hooksObj['awo-desktop-bridge-beacon']=buildHookEntry();
 const nextHooks=JSON.stringify(hooksObj,null,2)+'\n';
 actions.push({path:hooksPath,action:existsSync(hooksPath)?'merge-hook':'create-hook'});
 if(!dryRun){mkdirSync(dirname(hooksPath),{recursive:true});writeFileSync(hooksPath,nextHooks,'utf8');}

 // 2. Copy canonical skills (.agents/skills/{codex-worker,antigravity-orchestrator}/SKILL.md)
 for(const skillName of CANONICAL_SKILLS){
  const srcSkill=scopedPath(ROOT,`.agents/skills/${skillName}/SKILL.md`);
  if(!existsSync(srcSkill))throw Error(`Missing canonical skill template: ${skillName}`);
  const dstSkill=resolve(workspace,`.agents/skills/${skillName}/SKILL.md`);
  if(!sameWorkspace(workspace,ROOT)){
   const content=readFileSync(srcSkill,'utf8');
   const existed=existsSync(dstSkill);
   actions.push({path:dstSkill,action:existed?'update-skill':'create-skill'});
   if(!dryRun){mkdirSync(dirname(dstSkill),{recursive:true});writeFileSync(dstSkill,content,'utf8');}
  }
 }

 // 3. .codex/config.toml
 const codexConfigPath=resolve(workspace,'.codex/config.toml');
 const mcpBlock=buildCodexMcpTomlSection(workspace);
 if(!existsSync(codexConfigPath)){
  actions.push({path:codexConfigPath,action:'create-codex-mcp'});
  if(!dryRun){mkdirSync(dirname(codexConfigPath),{recursive:true});writeFileSync(codexConfigPath,mcpBlock,'utf8');}
 }else{
  const currentToml=readFileSync(codexConfigPath,'utf8');
  if(!currentToml.includes('[mcp_servers.desktop_inbox]')){
   const merged=currentToml.trimEnd()+'\n\n'+mcpBlock;
   actions.push({path:codexConfigPath,action:'append-codex-mcp'});
   if(!dryRun)writeFileSync(codexConfigPath,merged,'utf8');
  }else if(force){
   actions.push({path:codexConfigPath,action:'overwrite-codex-mcp'});
   if(!dryRun)writeFileSync(codexConfigPath,mcpBlock,'utf8');
  }else{
   actions.push({path:codexConfigPath,action:'keep-existing-codex-mcp'});
  }
 }

 // 4. Register workspace in local live bridge registry
 let config=null;
 if(!dryRun){
  config=registerLocalWorkspace(workspace,{allowNewConversation,...(stateDirectory?{stateDirectory}:{})});
 }
 return {workspace_root:workspace,dry_run:dryRun,project_id:config?.slug??null,actions,ready_hint:READY_HINT};
}

export function main(args=process.argv.slice(2)){
 let target=null,dryRun=false,force=false,allowNewConversation=false,stateDirectory=undefined;
 for(let i=0;i<args.length;i++){
  const arg=args[i];
  if(arg==='--dry-run')dryRun=true;
  else if(arg==='--force')force=true;
  else if(arg==='--allow-new-conversation')allowNewConversation=true;
  else if(arg==='--state'&&args[i+1])stateDirectory=args[++i];
  else if(!arg.startsWith('--')&&!target)target=arg;
  else throw Error('Usage: node scripts/onboard-desktop-bridge.mjs <workspace-path> [--dry-run] [--force] [--allow-new-conversation]');
 }
 if(!target)throw Error('Usage: node scripts/onboard-desktop-bridge.mjs <workspace-path> [--dry-run] [--force] [--allow-new-conversation]');
 const res=onboardWorkspace(resolve(target),{dryRun,force,allowNewConversation,stateDirectory});
 process.stdout.write(JSON.stringify(res,null,2)+'\n');
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{main();}
 catch(error){process.stderr.write(JSON.stringify({status:'ERROR',message:error.message})+'\n');process.exitCode=1;}
}
