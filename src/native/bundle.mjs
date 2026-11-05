import {existsSync,readFileSync,mkdirSync,writeFileSync,readdirSync,realpathSync} from 'node:fs';
import {resolve,dirname,isAbsolute} from 'node:path';
import {ROOT,scopedPath,sha256} from '../core/util.mjs';
import {requireValid} from '../core/schema.mjs';
import {loadConfig} from '../core/config.mjs';
import {buildArtifacts} from '../compiler/index.mjs';

// Prepare only. This module has no installation/global-config/reload operation.
export function planBundle(spec,config=loadConfig()){
 requireValid(spec,'project-bundle');
 const target=isAbsolute(spec.project_root)?spec.project_root:scopedPath(ROOT,spec.project_root);
 const root=realpathSync(target); // Target must exist; only declared instruction/profile paths are inspected.
 if(resolve(target).toLowerCase()!==root.toLowerCase())throw Error('Linked project roots are unsupported');
 const artifacts=buildArtifacts(config),files={};
 files['AGENTS.snippet.md']=artifacts['codex-guidance/AGENTS.snippet.md'];
 files['workflow.md']=artifacts['codex-guidance/workflow.md']+`\nProject: ${spec.project_id}\nProject validation commands (review before running; generator never executes them):\n`+spec.validation_commands.map(c=>'- '+c).join('\n')+'\n';
 for(const r of config.recipes)files['recipes/'+r.recipe_id+'.json']=artifacts['codex-guidance/recipes/'+r.recipe_id+'.json'];
 for(const p of config.native.profiles)files[p.name+'.toml']=artifacts['codex-guidance/'+p.name+'.toml'];
 const mapping={'AGENTS.snippet.md':'AGENTS.md','workflow.md':'.workflow-orchestrator/workflow.md',...Object.fromEntries(config.recipes.map(r=>['recipes/'+r.recipe_id+'.json','.workflow-orchestrator/recipes/'+r.recipe_id+'.json'])),...Object.fromEntries(config.native.profiles.map(p=>[p.name+'.toml','.codex/agents/'+p.name+'.toml']))};
 const agentsExist=existsSync(scopedPath(root,'.codex/agents'));
 const changes=Object.entries(mapping).map(([source,path])=>{
  const targetPath=scopedPath(root,path),exists=existsSync(targetPath);
  const action=path==='AGENTS.md'&&exists?'MANUAL-MERGE-REQUIRED':exists||path.startsWith('.codex/agents/')&&agentsExist?'CONFLICT':'ADD';
  return {source,path,action,before:exists?sha256(readFileSync(targetPath)):null,after:sha256(files[source]),diff:action==='ADD'?files[source].split('\n').map(line=>'+'+line).join('\n'):'Existing content preserved; review staged proposal and merge separately.'};
 });
 const hashes=Object.fromEntries(Object.entries(files).map(([name,content])=>[name,sha256(content)]));
 files['bundle-manifest.json']=JSON.stringify({schema_version:'1.0',project_id:spec.project_id,version:'2.2.0-foundation',canonical_fingerprint:sha256(artifacts),files:hashes,install:false,global_config:false,custom_discovery:'NOT VERIFIED'},null,2)+'\n';
 return {dry_run:true,execution:'NOT EXECUTED',install:false,project_id:spec.project_id,status:changes.some(c=>c.action!=='ADD')?'REVIEW REQUIRED':'READY FOR REVIEW',files,changes,rollback:['Before opt-in: record exact target scope, backups/hashes, diff and fresh checks.','No target changes made by generator. After manual opt-in, remove only added files whose hashes still match the reviewed bundle.','Restore only the reviewed AGENTS section from backup; preserve concurrent edits. Never overwrite .codex/agents, global config, auth or security settings.']};
}

export function stageBundle(spec,config=loadConfig()){
 const plan=planBundle(spec,config),relative='state/bundles/'+spec.project_id;
 const folder=scopedPath(ROOT,relative);
 // Immutable by fingerprint. New canonical inputs need a new reviewed project_id.
 if(existsSync(folder)){
  const walk=(base,prefix='')=>readdirSync(base,{withFileTypes:true}).flatMap(entry=>{
   const name=prefix+entry.name,path=scopedPath(folder,name);
   return entry.isDirectory()?walk(path,name+'/'):[name];
  });
  const actual=walk(folder).sort(),expected=Object.keys(plan.files).sort();
  if(JSON.stringify(actual)!==JSON.stringify(expected)||expected.some(name=>sha256(readFileSync(scopedPath(folder,name)))!==sha256(plan.files[name])))throw Error('Staged bundle drift or changed inputs; preserve it and use a new project_id');
 }else{
  mkdirSync(folder,{recursive:true});
  for(const [name,content] of Object.entries(plan.files)){const path=scopedPath(folder,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,content,{flag:'wx'});}
 }
 return {dry_run:true,install:false,status:plan.status,staging_directory:relative,files:Object.keys(plan.files),changes:plan.changes,rollback:plan.rollback};
}
