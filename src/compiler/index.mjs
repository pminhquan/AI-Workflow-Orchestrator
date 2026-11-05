import {mkdirSync,readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {ROOT,sha256,canonical,scopedPath,readJSON,writeJSON} from '../core/util.mjs';
import {requireValid} from '../core/schema.mjs';
import {loadConfig} from '../core/config.mjs';
import {buildNativeArtifacts} from '../native/guidance.mjs';
const unsupported=reason=>({status:'UNSUPPORTED',reason});
const instructions=role=>[role.purpose,role.verification_responsibility,role.escalation_behavior,'Use the task-brief@1.0 and worker-report@1.0 contracts. Parent permissions remain authoritative.'].join('\n');
export function convert(role,target){
 requireValid(role,'role');
 const supportedTools=new Set(['read','search','write','check','inherit-parent']);
 if(role.allowed_tools.some(t=>!supportedTools.has(t)))return unsupported('Unknown tool; refusing a lossy conversion');
 if(target==='mock')return {status:'OFFLINE-TESTED',extension:'json',content:JSON.stringify(role,null,2)+'\n',enforcement:'offline host contract validation; not OS isolation'};
 if(target==='codex-native'){
  // Current official docs: custom profiles cannot override parent sandbox or approval mode.
  if(role.permissions.mode!=='inherit-parent'||canonical(role.allowed_tools)!==canonical(['inherit-parent'])||canonical(role.permissions.read)!==canonical(['parent-approved'])||canonical(role.permissions.write)!==canonical(['parent-approved']))return unsupported('Codex profiles inherit parent permissions and MCP. Exact per-agent tool/path/write restrictions cannot be encoded safely.');
  return {status:'NOT VERIFIED',extension:'toml',content:`# Staged only. Inherits parent permissions; grants no additional rights.\nname = ${JSON.stringify(role.role_id)}\ndescription = ${JSON.stringify(role.purpose)}\ndeveloper_instructions = ${JSON.stringify(instructions(role))}\n`,enforcement:'inherits parent; no new permission restrictions promised'};
 }
 if(target==='antigravity-native'){
  if(role.permissions.mode!=='read-only'||role.permissions.write.length||canonical(role.permissions.read)!==canonical(['parent-approved'])||role.allowed_tools.some(t=>!['read','search'].includes(t)))return unsupported('Task-scoped write/check tools require verified host isolation; native frontmatter alone cannot constrain shell or file paths.');
  const tools=role.allowed_tools.map(t=>({read:'view_file',search:'grep_search'})[t]);
  return {status:'NOT VERIFIED',extension:'md',content:`---\nname: ${JSON.stringify(role.role_id)}\ndescription: ${JSON.stringify(role.purpose)}\ntools: ${JSON.stringify(tools)}\nmainAgent: false\nsubagent: true\nmodel: inherit\ncommandExecutionPolicy: "off"\nmcpServers: []\n---\n\n${instructions(role)}\n\nRead access remains limited by the parent application's grants. Only the declared read/search tools are permitted. No write, shell or external dispatch capability is requested.\n`,enforcement:'documented native tool allowlist; actual inheritance and installed app behavior require separate verification'};
 }
 return unsupported('Unknown compilation target');
}
export function buildArtifacts(config=loadConfig()){
 const files={},results=[];
 for(const target of ['mock','codex-native','antigravity-native'])for(const role of config.roles){
  const converted=convert(role,target);const source='agents/roles/'+role.role_id+'.json';
  const entry={role_id:role.role_id,target,status:converted.status,source,source_sha256:sha256(readFileSync(resolve(ROOT,source))),provenance:role.source_provenance};
  if(converted.content){const path=target+'/'+role.role_id+'.'+converted.extension;files[path]=converted.content;Object.assign(entry,{path,sha256:sha256(converted.content),enforcement:converted.enforcement,installed:false});}
  else entry.reason=converted.reason;
  results.push(entry);
 }
 const guidance=buildNativeArtifacts(config);Object.assign(files,guidance);
 files['manifest.json']=JSON.stringify({schema_version:'1.0',source_version:'2.2.0-foundation',activation:'staging-only',results,native_guidance:{status:'OFFLINE-TESTED',execution:'NOT EXECUTED',custom_discovery:'NOT VERIFIED',permission_mode:config.native.permission_mode,source:'config/integrations/codex-guidance.json',source_sha256:sha256(config.native),files:Object.keys(guidance)}},null,2)+'\n';
 return files;
}
export function generatedDrift(config=loadConfig()){
 const files=buildArtifacts(config),folder=scopedPath(ROOT,'agents/generated'),discrepancies=[];
 for(const [name,content] of Object.entries(files)){const path=scopedPath(folder,name);if(!existsSync(path)||sha256(readFileSync(path))!==sha256(content))discrepancies.push(name);}
 const expectedIndex=Object.fromEntries(Object.entries(files).map(([name,content])=>[name,sha256(content)]));
 const index=scopedPath(folder,'checksums.json');if(!existsSync(index)||canonical(readJSON(index))!==canonical(expectedIndex))discrepancies.push('checksums.json');
 return discrepancies;
}
export function compile(config=loadConfig()){
 const folder=scopedPath(ROOT,'agents/generated');mkdirSync(folder,{recursive:true});
 const next=buildArtifacts(config);const indexPath=scopedPath(folder,'checksums.json');const previous=existsSync(indexPath)?readJSON(indexPath):{};
 const diffs=[];
 for(const [name,hash] of Object.entries(previous)){
  const path=scopedPath(folder,name);if(!existsSync(path)||sha256(readFileSync(path))!==hash)throw Error('Generated artifact drift; preserve and review before compiling: '+name);
 }
 for(const [name,content] of Object.entries(next)){
  const path=scopedPath(folder,name);
  if(existsSync(path)&&!Object.hasOwn(previous,name))throw Error('Unowned generated file: '+name);
  const hash=sha256(content);if(previous[name]!==hash)diffs.push({path:name,change:previous[name]?'changed':'added',before:previous[name]??null,after:hash});
 }
 for(const name of Object.keys(previous))if(!Object.hasOwn(next,name))diffs.push({path:name,change:'removed',before:previous[name],after:null});
 for(const item of diffs)if(item.change==='removed')unlinkSync(scopedPath(folder,item.path));
 for(const [name,content] of Object.entries(next)){const path=scopedPath(folder,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,content);}
 writeJSON(indexPath,Object.fromEntries(Object.entries(next).map(([name,content])=>[name,sha256(content)])));
 writeJSON(scopedPath(ROOT,'state/compiler-diff.json'),{schema_version:'1.0',diffs});
 return {status:'staging-only',artifacts:Object.keys(next).length-1,diffs,results:JSON.parse(next['manifest.json']).results};
}
