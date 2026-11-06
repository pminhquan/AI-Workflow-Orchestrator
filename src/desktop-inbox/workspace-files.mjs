import {existsSync,lstatSync,readdirSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {safeRelative,scopedPath} from '../core/util.mjs';
import {canonicalWorkspace,isSensitivePath,validateScopePath} from './contracts.mjs';
import {resolveCheckExecutable} from '../verification/checks.mjs';

const DEPENDENCIES=new Set(['node_modules','venv','.venv','__pycache__','.pytest_cache','.mypy_cache','.ruff_cache','.tox','.nox','.next','.turbo','.gradle','.cache','.idea','.vscode']);
const ARTIFACTS=new Set(['dist','build','coverage','target','bin','obj']);
export const EXCLUDED_ROOTS=['.git','state',...DEPENDENCIES,...ARTIFACTS];
const blockedParts=path=>path.split('/').some((p,i)=>(i===0&&p.toLowerCase()==='state')||DEPENDENCIES.has(p.toLowerCase()));
const artifactParts=path=>path.split('/').some(p=>ARTIFACTS.has(p.toLowerCase()));

function trackedSource(workspace){
 if(!existsSync(resolve(workspace,'.git')))return new Set();
 const executable=resolveCheckExecutable({executable:'git'});
 if(!executable)throw Error('Workspace Git inventory unavailable: trusted PATH git executable is missing');
 const git=args=>execFileSync(executable,['--no-optional-locks','-c','core.fsmonitor=false','-C',workspace,...args],{windowsHide:true,encoding:'utf8',timeout:3000,maxBuffer:2*1024*1024});
 try{
  const actual=realpathSync(git(['rev-parse','--show-toplevel']).trim());
  const norm=p=>process.platform==='win32'?p.toLowerCase():p;
  if(norm(actual)!==norm(workspace))throw Error('Git root does not match workspace');
  const files=git(['ls-files','--cached','-z']).split('\0').filter(Boolean);
  if(files.length>20000)throw Error('Git inventory limit exceeded');
  return new Set(files.filter(p=>{safeRelative(p);return !isSensitivePath(p)&&!blockedParts(p);}));
 }catch(error){throw Error('Workspace Git inventory unavailable; verification incomplete: '+error.message);}
}

// One bounded ordinary-source walk for full and advisory snapshots. Git only
// preserves tracked source under artifact-like names; Git ignores never hide
// ordinary source. Private paths and dependency/runtime exclusions stay closed.
export function workspaceFiles(workspace){
 workspace=canonicalWorkspace(workspace);
 const tracked=trackedSource(workspace),prefixes=new Set(),files=[];
 for(const p of tracked){const parts=p.split('/');for(let i=1;i<parts.length;i++)prefixes.add(parts.slice(0,i).join('/'));}
 const add=p=>{if(files.length>=2000)throw Error('Workspace snapshot limit exceeded');files.push(p);};
 function walk(directory='',trackedOnly=false){
  const absolute=directory?scopedPath(workspace,directory):workspace;
  for(const entry of readdirSync(absolute,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
   const rel=directory?directory+'/'+entry.name:entry.name;
   if(rel==='.codex'){
    if(entry.isSymbolicLink())continue;
    const config=resolve(workspace,'.codex/config.toml'),stat=lstatSync(config,{throwIfNoEntry:false});
    if(stat){if(stat.isSymbolicLink()||!stat.isFile())throw Error('Managed MCP config is not an auditable regular file');add('.codex/config.toml');}
    continue;
   }
   if(isSensitivePath(rel,{directory:entry.isDirectory()})||blockedParts(rel))continue;
   const isTracked=tracked.has(rel),hasTracked=prefixes.has(rel);
   if(entry.isSymbolicLink()){
    if(isTracked||hasTracked)throw Error('Tracked source link is not auditable: '+rel);
    continue;
   }
   if(trackedOnly&&!isTracked&&!hasTracked)continue;
   if(entry.isDirectory()){
    const artifact=ARTIFACTS.has(entry.name.toLowerCase());
    if(artifact&&!hasTracked)continue;
    walk(rel,trackedOnly||artifact);
   }else if(entry.isFile()){
    scopedPath(workspace,rel);add(rel);
   }else throw Error('Workspace contains a nonregular source entry: '+rel);
  }
 }
 walk();return files;
}

// A declared scope must not silently fall outside the snapshot's audit domain.
export function assertAuditableScopes(workspace,scopes){
 workspace=canonicalWorkspace(workspace);const tracked=trackedSource(workspace);
 for(const rel of scopes){
  validateScopePath(workspace,rel);
  if(blockedParts(rel)||(artifactParts(rel)&&!tracked.has(rel)))throw Error('Scope is excluded from source verification: '+rel+'; use exact managed source files');
 }
 return true;
}
