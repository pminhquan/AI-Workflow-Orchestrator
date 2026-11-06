import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,utimesSync,statSync,renameSync,unlinkSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ROOT,inside,sha256} from '../../src/core/util.mjs';
import {isSensitivePath,validateScopePath} from '../../src/desktop-inbox/contracts.mjs';
import {captureWorkspace,readBoundedBytes} from '../../src/desktop-inbox/verification.mjs';
import {captureWorkspaceFast,invalidateWorkspaceCache} from '../../src/desktop-inbox/fast-snapshot.mjs';
import {assertAuditableScopes} from '../../src/desktop-inbox/workspace-files.mjs';

function fixture(){
 const root=resolve(ROOT,'state','test-source-snapshot-'+randomUUID()),workspace=resolve(root,'workspace');
 mkdirSync(workspace,{recursive:true});
 const put=(p,text='ordinary fixture\n')=>{const full=resolve(workspace,p);mkdirSync(dirname(full),{recursive:true});writeFileSync(full,text);};
 put('README.md','# Ordinary project\n');
 const git=(...args)=>execFileSync('git',['-c','core.autocrlf=false','-C',workspace,...args],{windowsHide:true,encoding:'utf8'}).trim();
 return {root,workspace,put,git,close(){invalidateWorkspaceCache(workspace);assert.ok(inside(resolve(ROOT,'state'),root)&&root!==resolve(ROOT,'state'));rmSync(root,{recursive:true,force:true});}};
}

test('ordinary auth/token source is eligible and changes are captured without granting credentials',()=>{
 const f=fixture();try{
  const sources=['auth.js','tokenizer.py','token_utils.py','src/auth/handler.js','src/tokens/lexer.py','cookie_policy.py','secret_manager.py'];
  for(const p of sources){f.put(p);assert.equal(isSensitivePath(p),false);validateScopePath(f.workspace,p);}
  validateScopePath(f.workspace,'src/auth');validateScopePath(f.workspace,'src/tokens');
  const before=captureWorkspace(f.workspace);assert.deepEqual(captureWorkspaceFast(f.workspace,{verifyHashes:true}),before);
  for(const p of sources){assert.ok(before.entries[p]);f.put(p,'modified source\n');}
  const after=captureWorkspace(f.workspace);for(const p of sources)assert.notEqual(after.entries[p],before.entries[p]);
  for(const p of ['.env','.env.production','.git/config','.aws/credentials','.ssh/id_rsa','private.pem','src/auth.json','src/oauth_tokens.json','src/token_cache.json','credentials.txt','sessions/private.json']){
   assert.equal(isSensitivePath(p),true,p);assert.throws(()=>validateScopePath(f.workspace,p),/Sensitive/);
  }
  for(const p of ['.env','.aws/credentials','src/auth.json','private.pem'])f.put(p,'not read');
  assert.equal(captureWorkspace(f.workspace).hash,after.hash);
 }finally{f.close();}
});

test('recursive dependency/cache pruning supports monorepos and Python venv; state is root-only',()=>{
 const f=fixture();try{
  for(const p of ['packages/app/node_modules/dep.js','packages/py/venv/Lib/module.py','packages/py/.venv/Lib/module.py','nested/__pycache__/module.pyc','nested/.mypy_cache/cache.json','build/generated.mjs','dist/bundle.js','state/runtime.json'])f.put(p);
  for(const p of ['src/state/reducer.js','packages/app/src/source.js'])f.put(p);
  const actual=captureWorkspace(f.workspace);assert.deepEqual(Object.keys(actual.entries).sort(),['README.md','packages/app/src/source.js','src/state/reducer.js']);
  assert.deepEqual(captureWorkspaceFast(f.workspace,{verifyHashes:true}),actual);
  for(const p of ['packages/py/venv/Lib/module.py','packages/app/node_modules/dep.js','build/generated.mjs','state'])assert.throws(()=>assertAuditableScopes(f.workspace,[p]),/excluded/);
  assert.equal(assertAuditableScopes(f.workspace,['src/state/reducer.js']),true);
 }finally{f.close();}
});

test('nested dependencies do not consume the ordinary source file limit',()=>{
 const f=fixture();try{
  for(let i=0;i<2001;i++)f.put('packages/app/node_modules/pkg/file-'+i+'.js','x');
  assert.deepEqual(Object.keys(captureWorkspace(f.workspace).entries),['README.md']);
  assert.deepEqual(Object.keys(captureWorkspaceFast(f.workspace).entries),['README.md']);
 }finally{f.close();}
});

test('Git tracked artifact-named source is verified while ignored ordinary source is not hidden',()=>{
 const f=fixture();try{
  f.git('init','-q');f.put('.gitignore','build/\nnode_modules/\nsrc/ignored.py\n');
  f.put('build/tracked.mjs','export const n = 1;\n');f.put('build/untracked-generated.mjs','generated');f.put('src/ignored.py','ordinary ignored source\n');
  f.git('add','-f','--','build/tracked.mjs');
  const before=captureWorkspace(f.workspace);assert.ok(before.entries['build/tracked.mjs']);assert.ok(before.entries['src/ignored.py']);assert.equal(before.entries['build/untracked-generated.mjs'],undefined);
  assert.equal(assertAuditableScopes(f.workspace,['build/tracked.mjs']),true);assert.throws(()=>assertAuditableScopes(f.workspace,['build']),/exact managed source/);
  f.put('build/tracked.mjs','export const n = 2;\n');assert.notEqual(captureWorkspace(f.workspace).hash,before.hash);
  assert.deepEqual(captureWorkspaceFast(f.workspace,{verifyHashes:true}),captureWorkspace(f.workspace));
 }finally{f.close();}
});

test('unmanaged junction is skipped without reading outside; explicit/tracked link fails closed',()=>{
 const f=fixture();try{
  const outside=resolve(f.root,'outside');mkdirSync(outside);writeFileSync(resolve(outside,'private.txt'),'outside marker');
  symlinkSync(outside,resolve(f.workspace,'linked'),'junction');
  assert.deepEqual(Object.keys(captureWorkspace(f.workspace).entries),['README.md']);
  assert.deepEqual(Object.keys(captureWorkspaceFast(f.workspace).entries),['README.md']);
  assert.throws(()=>assertAuditableScopes(f.workspace,['linked/private.txt']),/Links|junction/);
  assert.throws(()=>readBoundedBytes(resolve(f.workspace,'linked'),1024),/Nonregular/);
  f.git('init','-q');const oid=execFileSync('git',['-C',f.workspace,'hash-object','-w','--stdin'],{input:'../outside',encoding:'utf8',windowsHide:true}).trim();
  f.git('update-index','--add','--cacheinfo','120000,'+oid+',linked');
  assert.throws(()=>captureWorkspace(f.workspace),/Tracked source link/);
 }finally{f.close();}
});

test('same-size preserved-mtime external writes invalidate advisory cache; final full hash stays fresh',async()=>{
 const f=fixture();try{
  f.put('helper.mjs','AAAA');const full=resolve(f.workspace,'helper.mjs');utimesSync(full,1600000000,1600000000);const t=statSync(full).mtime;
  const before=captureWorkspaceFast(f.workspace);await delay(30);f.put('helper.mjs','BBBB');utimesSync(full,t,t);
  const after=captureWorkspaceFast(f.workspace);assert.notEqual(after.hash,before.hash);assert.equal(after.entries['helper.mjs'],sha256('BBBB'));
  assert.deepEqual(after,captureWorkspace(f.workspace));assert.deepEqual(captureWorkspaceFast(f.workspace,{verifyHashes:true}),after);
 }finally{f.close();}
});

test('deletion and rename clear cached paths and preserve exact snapshot agreement',()=>{
 const f=fixture();try{
  f.put('old.js','source');captureWorkspaceFast(f.workspace);renameSync(resolve(f.workspace,'old.js'),resolve(f.workspace,'renamed.js'));
  const renamed=captureWorkspaceFast(f.workspace);assert.equal(renamed.entries['old.js'],undefined);assert.ok(renamed.entries['renamed.js']);
  unlinkSync(resolve(f.workspace,'renamed.js'));assert.deepEqual(captureWorkspaceFast(f.workspace),captureWorkspace(f.workspace));
 }finally{f.close();}
});

test('managed project MCP config is hashed while private sibling config remains protected',()=>{
 const f=fixture();try{
  f.put('.codex/config.toml','[mcp_servers.fixture]\ncommand="node"\n');f.put('.codex/auth.json','not read');
  const before=captureWorkspace(f.workspace);assert.equal(before.entries['.codex/config.toml'],sha256(readFileSync(resolve(f.workspace,'.codex/config.toml'))));
  assert.equal(before.entries['.codex/auth.json'],undefined);assert.throws(()=>validateScopePath(f.workspace,'.codex/config.toml'),/Sensitive/);
  assert.deepEqual(captureWorkspaceFast(f.workspace,{verifyHashes:true}),before);
 }finally{f.close();}
});

test('Git inventory never resolves an executable from the project cwd',()=>{
 const f=fixture(),previous=process.cwd();try{
  f.put('build/owned.mjs','export const owned=true;');f.git('init');f.git('add','-f','build/owned.mjs');
  f.put(process.platform==='win32'?'git.exe':'git','not an executable from trusted PATH');process.chdir(f.workspace);
  assert.ok(captureWorkspace(f.workspace).entries['build/owned.mjs']);
 }finally{process.chdir(previous);f.close();}
});

test('nested Gradle caches and .NET bin/obj outputs are outside ordinary source snapshots',()=>{
 const f=fixture();try{
  for(const p of ['packages/java/.gradle/cache.bin','packages/app/.cache/data.txt','src/App/bin/Debug/App.dll','src/App/obj/project.assets.json'])f.put(p,'generated');
  f.put('src/App/Program.cs','class Program {}');
  const snapshot=captureWorkspace(f.workspace);assert.deepEqual(Object.keys(snapshot.entries).sort(),['README.md','src/App/Program.cs']);
 }finally{f.close();}
});
