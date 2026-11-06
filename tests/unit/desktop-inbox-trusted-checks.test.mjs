import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,existsSync,rmSync,copyFileSync,chmodSync} from 'node:fs';
import {resolve,delimiter} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {ROOT,inside} from '../../src/core/util.mjs';
import {CheckRunner,normalizeCheckSpec,MAX_CHECK_TIMEOUT_MS,snapshot} from '../../src/verification/checks.mjs';

function fixture(){
 const workspace=resolve(ROOT,'state/trusted-check-'+randomUUID());mkdirSync(workspace,{recursive:true});writeFileSync(resolve(workspace,'README.md'),'# Trusted check fixture\n');
 const spec=(args,extra={})=>({args,inputs:['README.md'],timeout_ms:3000,...extra});
 return {workspace,spec,close(){assert.ok(inside(resolve(ROOT,'state'),workspace));rmSync(workspace,{recursive:true,force:true});}};
}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};

test('legacy Node check and cache remain compatible, but environment change invalidates cache',async()=>{
 const h=fixture(),key='AWO_TEST_CHECK_FINGERPRINT',old=process.env[key];try{
  const runner=new CheckRunner({node:h.spec(['-e','process.stdout.write("legacy-ok")'],{cacheable:true})});
  const first=await runner.run(h.workspace,'node'),second=await runner.run(h.workspace,'node');assert.equal(first.passed,true);assert.equal(second.reused,true);assert.equal(runner.executions,1);
  process.env[key]=randomUUID();assert.equal(runner.isFresh(first.id,h.workspace,'node'),false);const third=await runner.run(h.workspace,'node');assert.equal(third.reused,false);assert.equal(third.passed,true);
 }finally{if(old===undefined)delete process.env[key];else process.env[key]=old;h.close();}
});

test('registered Python executable runs a real check and external runtime evidence is not cached',async t=>{
 const python=['python','python3'].find(executable=>spawnSync(executable,['--version'],{windowsHide:true,shell:false,timeout:2000}).status===0);
 if(!python){t.skip('Python runtime unavailable; functional Python check NOT RUN');return;}
 const h=fixture();try{
  const runner=new CheckRunner({py:h.spec(['-c','assert sum([2,3]) == 5; print("python-functional-ok")'],{executable:python,cacheable:true})});
  const first=await runner.run(h.workspace,'py'),second=await runner.run(h.workspace,'py');assert.equal(first.passed,true);assert.match(first.output,/python-functional-ok/);assert.equal(second.reused,false);assert.equal(runner.executions,2);
 }finally{h.close();}
});

test('Python import bytecode caches do not invalidate declared source directory inputs',async t=>{
 const python=['python','python3'].find(executable=>spawnSync(executable,['--version'],{windowsHide:true,shell:false,timeout:2000}).status===0);
 if(!python){t.skip('Python runtime unavailable; Python import check NOT RUN');return;}
 const h=fixture();try{
  mkdirSync(resolve(h.workspace,'src'));writeFileSync(resolve(h.workspace,'src/helper.py'),'VALUE = 7\n');
  const runner=new CheckRunner({py:h.spec(['-c','import sys; sys.path.insert(0,"src"); import helper; assert helper.VALUE == 7; print("import-ok")'],{executable:python,inputs:['src']})});
  const result=await runner.run(h.workspace,'py');assert.equal(result.passed,true);assert.equal(result.stable_inputs,true);assert.equal(existsSync(resolve(h.workspace,'src/__pycache__')),true);
 }finally{h.close();}
});

test('literal metacharacters remain executable args and never become shell syntax',async()=>{
 const h=fixture();try{
  const literal='literal & echo injected > injected.marker | %PATH% $(echo bad)';
  const runner=new CheckRunner({literal:h.spec(['-e','process.stdout.write(process.argv[1])',literal],{executable:process.execPath,shell:false})});
  const result=await runner.run(h.workspace,'literal');assert.equal(result.passed,true);assert.equal(result.output,literal);assert.equal(existsSync(resolve(h.workspace,'injected.marker')),false);
 }finally{h.close();}
});

test('an explicitly registered file inside a generated cache is still fingerprinted',()=>{
 const h=fixture();try{
  mkdirSync(resolve(h.workspace,'__pycache__'));const file=resolve(h.workspace,'__pycache__/explicit.bin');writeFileSync(file,'AAAA');
  const before=snapshot(h.workspace,['__pycache__/explicit.bin']);writeFileSync(file,'BBBB');const after=snapshot(h.workspace,['__pycache__/explicit.bin']);assert.notEqual(before.hash,after.hash);
 }finally{h.close();}
});

test('check timeouts above five seconds are registered, while oversized and shell specs fail closed',async()=>{
 const h=fixture();try{
  const spec=h.spec(['-e','process.stdout.write("ok")'],{timeout_ms:6000});assert.equal(normalizeCheckSpec(spec).timeout_ms,6000);assert.equal((await new CheckRunner({normal:spec}).run(h.workspace,'normal')).passed,true);
  for(const timeout_ms of [0,-1,MAX_CHECK_TIMEOUT_MS+1])assert.throws(()=>normalizeCheckSpec({...spec,timeout_ms}),/Invalid registered/);
  assert.throws(()=>normalizeCheckSpec({...spec,shell:true}),/Shell checks/);assert.throws(()=>normalizeCheckSpec({...spec,executable:'bad\0name'}),/Invalid registered executable/);
 }finally{h.close();}
});

test('unregistered check IDs are rejected and missing registered executables report spawn failure',async()=>{
 const h=fixture();try{
  const runner=new CheckRunner({missing:h.spec([],{executable:'awo-missing-'+randomUUID()})});await assert.rejects(runner.run(h.workspace,'unregistered'),/Unknown registered check/);
  const missing=await runner.run(h.workspace,'missing');assert.equal(missing.passed,false);assert.equal(missing.spawn_error,'ENOENT');assert.equal(missing.timed_out,false);
 }finally{h.close();}
});

test('bare trusted names do not resolve to cwd executables or relative PATH entries',async()=>{
 const h=fixture(),pathKey=Object.keys(process.env).find(key=>key.toUpperCase()==='PATH'),oldPath=process.env[pathKey];try{
  const name='awo-cwd-hijack-'+randomUUID()+(process.platform==='win32'?'.exe':'');
  copyFileSync(process.platform==='win32'?resolve(process.env.SystemRoot||'C:\\Windows','System32','cmd.exe'):'/bin/sh',resolve(h.workspace,name));
  if(process.platform!=='win32')chmodSync(resolve(h.workspace,name),0o755);
  process.env[pathKey]='.'+delimiter+oldPath;
  const args=process.platform==='win32'?['/d','/c','echo hijacked > owned.marker']:['-c','echo hijacked > owned.marker'];
  const result=await new CheckRunner({owned:h.spec(args,{executable:name})}).run(h.workspace,'owned');
  assert.equal(result.passed,false);assert.equal(result.spawn_error,'ENOENT');assert.equal(existsSync(resolve(h.workspace,'owned.marker')),false);
  assert.throws(()=>normalizeCheckSpec(h.spec([],{executable:'./wrapper'})),/absolute registered executable/);
  assert.throws(()=>normalizeCheckSpec(h.spec([],{executable:'mvn.cmd'})),/Shell scripts/);
 }finally{process.env[pathKey]=oldPath;h.close();}
});

test('timeout terminates the owned child process tree within a bounded cleanup window',async()=>{
 const h=fixture();let grandchild;try{
  const script='const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},10000)"],{stdio:"ignore"});process.stdout.write(String(child.pid));setInterval(()=>{},10000);';
  const started=Date.now(),result=await new CheckRunner({tree:h.spec(['-e',script],{timeout_ms:1200})}).run(h.workspace,'tree');
  grandchild=Number(result.output.trim());assert.ok(Number.isInteger(grandchild)&&grandchild>0,'grandchild PID emitted');assert.equal(result.passed,false);assert.equal(result.timed_out,true);assert.ok(Date.now()-started<5000);
  for(let i=0;i<20&&alive(grandchild);i++)await new Promise(resolveWait=>setTimeout(resolveWait,25));
  assert.equal(alive(grandchild),false);assert.equal(result.cleanup_error,undefined);
 }finally{
  if(grandchild&&alive(grandchild)){if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(grandchild),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});else try{process.kill(grandchild,'SIGKILL');}catch{}}
  h.close();
 }
});
