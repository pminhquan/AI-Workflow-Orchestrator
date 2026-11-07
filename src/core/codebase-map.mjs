import {lstatSync,readdirSync,realpathSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ROOT,scopedPath} from './util.mjs';
import {readBoundedBytes} from './local-files.mjs';

const EXCLUDED_ROOTS = [
 '.git','state','node_modules','venv','.venv','__pycache__','.pytest_cache','.mypy_cache','.ruff_cache',
 '.tox','.nox','.next','.turbo','.gradle','.cache','.idea','.vscode','dist','build','coverage','target','bin','obj'
];
const privateComponent=/^(?:\.git|\.aws|\.ssh|\.gemini|\.codex|\.antigravity|\.azure|\.gcp|\.config|\.netrc|\.npmrc|\.pypirc|\.env(?:\..*)?|id_rsa.*|id_ed25519.*)$/i;
const privateFile=/^(?:\.?(?:credentials?|tokens?|cookies?|cookiejar|auth(?:entication)?|oauth|secrets?|keyring)(?:[-_.][A-Za-z0-9_-]+)*\.(?:json|jsonl|ya?ml|toml|ini|cfg|conf|txt)|application_default_credentials\.json|mcp_config\.json|bridge\.config\.json)$/i;
const bareCredentialStore=/^(?:credentials?|tokens?|cookies?|cookiejar|keyring)$/i;
const privateRuntimeRoot=/^(?:sessions?|transcripts?|cookies?|credentials?|tokens?|keyring)$/i;

function isSensitivePath(path,{directory=false}={}) {
 const parts=path.split('/');
 if(parts.some(part=>privateComponent.test(part)||/\.(?:pem|key|sqlite\d*|db|p12|pfx|kdbx)$/i.test(part)))return true;
 if(privateRuntimeRoot.test(parts[0]))return true;
 const leaf=parts.at(-1);
 return privateFile.test(leaf)||(!directory&&bareCredentialStore.test(leaf));
}

function canonicalWorkspace(root) {
 if(typeof root!=='string'||root!==root.trim()||/[\x00-\x1f\x7f]/.test(root)||!isAbsolute(root)||
    /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(root)||root.startsWith('\\\\')||root.startsWith('//')) {
  throw Error('Workspace must be an absolute canonical local directory');
 }
 const resolved=resolve(root),actual=realpathSync(root);
 const norm=path=>process.platform==='win32'?path.toLowerCase():path;
 if(norm(resolved)!==norm(actual)||!lstatSync(actual).isDirectory()||lstatSync(resolved).isSymbolicLink()) {
  throw Error('Workspace aliases/links are unsupported');
 }
 return actual;
}

function validateScopePath(workspace,path) {
 if(path.length>240||/[*?<>|"\x7f]/.test(path))throw Error('Unsupported scope path');
 const full=scopedPath(workspace,path);
 if(isSensitivePath(path,{directory:lstatSync(full,{throwIfNoEntry:false})?.isDirectory()}))throw Error('Sensitive scope path');
 return full;
}

const CODE_EXT=/\.(?:mjs|cjs|js|ts|tsx|jsx|py|go|rs|java|cs|rb|php|ps1|sh)$/i;
const DOC_OR_CONFIG_EXT=/\.(?:md|json|toml|ya?ml)$/i;
const SYMBOL_PATTERNS=[
 /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
 /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
 /^\s*export\s+(?:const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/,
 /^(?:async\s+)?def\s+([A-Za-z_]\w*)/,
 /^class\s+([A-Za-z_]\w*)/,
 /^\s*(?:pub\s+)?(?:async\s+)?(?:fn|func|struct|enum|trait|interface)\s+([A-Za-z_]\w*)/
];

function extractFileSymbols(fullPath,maxSymbols=12,maxBytes=256*1024){
 const stat=lstatSync(fullPath,{throwIfNoEntry:false});
 if(!stat||!stat.isFile()||stat.size>maxBytes)return null;
 const raw=new TextDecoder('utf-8',{fatal:false}).decode(readBoundedBytes(fullPath,maxBytes));
 const lines=raw.split(/\r?\n/);
 const symbols=[];
 if(CODE_EXT.test(fullPath)){
  for(let i=0;i<lines.length&&symbols.length<maxSymbols;i++){
   const line=lines[i];
   for(const rx of SYMBOL_PATTERNS){
    const m=rx.exec(line);
    if(m&&m[1]){
     const token=`L${i+1}:${m[1]}`;
     if(!symbols.includes(token))symbols.push(token);
     break;
    }
   }
  }
 }
 return {lines:lines.length,symbols};
}

export function buildSurgicalSymbolMap(workspaceRoot,scopePaths=[],{maxFiles=12,maxSymbolsPerFile=12}={}){
 const ws=canonicalWorkspace(workspaceRoot);
 const orderedScopes=[];
 const addScope=p=>{
  const norm=String(p??'').trim().replaceAll('\\','/').replace(/^\/+|\/+$/g,'');
  if(norm&&!orderedScopes.some(x=>x.toLowerCase()===norm.toLowerCase()))orderedScopes.push(norm);
 };
 for(const s of scopePaths)addScope(s);
 if(!orderedScopes.length){
  for(const name of readdirSync(ws).sort()){
   if(!EXCLUDED_ROOTS.includes(name.toLowerCase())&&name!=='.codex'&&!isSensitivePath(name))addScope(name);
  }
 }

 const files=[];
 const seen=new Set();
 function collect(relPath,depth=0){
  if(files.length>=maxFiles||depth>3||isSensitivePath(relPath))return;
  const key=relPath.toLowerCase();
  if(seen.has(key))return;
  let full;
  try{full=validateScopePath(ws,relPath);}catch{return;}
  const stat=lstatSync(full,{throwIfNoEntry:false});
  if(!stat)return;
  if(stat.isFile()){
   if(CODE_EXT.test(relPath)||DOC_OR_CONFIG_EXT.test(relPath)){
    seen.add(key);
    const info=extractFileSymbols(full,maxSymbolsPerFile);
    if(info)files.push({path:relPath,...info});
   }
   return;
  }
  if(stat.isDirectory()){
   const children=readdirSync(full).sort();
   // Prioritize code files before subdirectories or docs
   const sorted=[
    ...children.filter(c=>CODE_EXT.test(c)),
    ...children.filter(c=>!CODE_EXT.test(c)&&!DOC_OR_CONFIG_EXT.test(c)),
    ...children.filter(c=>DOC_OR_CONFIG_EXT.test(c))
   ];
   for(const child of sorted){
    if(files.length>=maxFiles)break;
    if(EXCLUDED_ROOTS.includes(child.toLowerCase())||child==='.codex')continue;
    collect(`${relPath}/${child}`,depth+1);
   }
  }
 }

 for(const s of orderedScopes){
  if(files.length>=maxFiles)break;
  collect(s,0);
 }
 return {workspace_root:ws,files};
}

export function renderSurgicalMapMarkdown(mapResult){
 if(!mapResult?.files?.length)return '';
 const lines=[
  '## 2.5. Bản đồ Symbol & Dòng lệnh (Surgical Map — Đọc theo khoảng dòng `StartLine..EndLine`, tránh đọc cả file)',
  ''
 ];
 for(const f of mapResult.files){
  const symText=f.symbols.length?` — ${f.symbols.map(s=>`\`${s}\``).join(', ')}`:'';
  lines.push(`- \`${f.path}\` (${f.lines} lines)${symText}`);
 }
 return lines.join('\n');
}

export function main(args=process.argv.slice(2)){
 const workspaceRoot=args[0]?resolve(args[0]):ROOT;
 const scopes=args.slice(1);
 const map=buildSurgicalSymbolMap(workspaceRoot,scopes);
 const md=renderSurgicalMapMarkdown(map);
 process.stdout.write((md||'# Empty symbol map')+'\n');
 return map;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 main();
}
