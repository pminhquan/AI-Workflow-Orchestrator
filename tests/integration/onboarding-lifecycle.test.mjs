import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {resolve,relative,basename} from 'node:path';
import {spawnSync} from 'node:child_process';
import {setup} from '../helpers.mjs';
import {ROOT,scopedPath,sha256,inside} from '../../src/core/util.mjs';
import {loadConfig} from '../../src/core/config.mjs';
import {planBundle,stageBundle} from '../../src/native/bundle.mjs';

const specification=(h,id)=>({schema_version:'1.0',project_id:id,project_root:relative(ROOT,h.workspace).replaceAll('\\','/'),validation_commands:['node --test tests/totals.test.mjs']});
function cleanStage(id){const folder=scopedPath(ROOT,'state/bundles/'+id);assert.ok(inside(resolve(ROOT,'state/bundles'),folder));rmSync(folder,{recursive:true,force:true});}

test('planner reports regular-file ancestors and non-file target collisions without overwriting',()=>{
 const h=setup();try{
  writeFileSync(resolve(h.workspace,'.workflow-orchestrator'),'user file\n');writeFileSync(resolve(h.workspace,'.codex'),'user config file\n');mkdirSync(resolve(h.workspace,'AGENTS.md'));
  const plan=planBundle(specification(h,'file-collision'));
  assert.equal(plan.status,'REVIEW REQUIRED');assert.ok(plan.changes.every(c=>c.action==='CONFLICT'));
  assert.ok(plan.changes.some(c=>c.reason?.includes('ancestor')));
  assert.equal(readFileSync(resolve(h.workspace,'.workflow-orchestrator'),'utf8'),'user file\n');assert.equal(readFileSync(resolve(h.workspace,'.codex'),'utf8'),'user config file\n');
 }finally{h.close();}
});

test('planner rejects dangling junctions before recommending an opt-in',()=>{
 const h=setup();try{
  symlinkSync(resolve(h.dir,'missing-target'),resolve(h.workspace,'.codex'),'junction');
  assert.throws(()=>planBundle(specification(h,'dangling-target')),/Links|junctions/);
 }finally{h.close();}
});

test('immutable project bundle binds target root and preserves prior staging on changed inputs',()=>{
 const h=setup(),id='scope-'+basename(h.dir);try{
  const spec=specification(h,id),another=resolve(h.dir,'another');mkdirSync(another);
  const first=planBundle(spec);stageBundle(spec);
  const next=planBundle({...spec,project_root:another});
  assert.notEqual(JSON.parse(first.files['bundle-manifest.json']).project_scope_sha256,JSON.parse(next.files['bundle-manifest.json']).project_scope_sha256);
  assert.throws(()=>stageBundle({...spec,project_root:another}),/changed inputs/);
  assert.throws(()=>stageBundle({...spec,validation_commands:['node --test other.test.mjs']}),/changed inputs/);
  assert.equal(readFileSync(scopedPath(ROOT,'state/bundles/'+id+'/bundle-manifest.json'),'utf8'),first.files['bundle-manifest.json']);
 }finally{cleanStage(id);h.close();}
});

test('isolated coding project exercises reviewed placement, update diff and guarded manual rollback',()=>{
 const h=setup(),id='lifecycle-'+basename(h.dir),nextId=id+'-next';try{
  cpSync(resolve(ROOT,'tests/fixtures/onboarding-project'),h.workspace,{recursive:true});
  const init=spawnSync('git',['init','-q','--initial-branch=main'],{cwd:h.workspace,encoding:'utf8',windowsHide:true,shell:false});assert.equal(init.status,0,init.stderr);assert.ok(existsSync(resolve(h.workspace,'.git')));
  const spec=specification(h,id),agents=resolve(h.workspace,'AGENTS.md'),original=readFileSync(agents,'utf8'),source=resolve(h.workspace,'src/totals.mjs'),sourceHash=sha256(readFileSync(source));
  const first=planBundle(spec);stageBundle(spec);
  assert.equal(first.changes.find(c=>c.path==='AGENTS.md').action,'MANUAL-MERGE-REQUIRED');assert.equal(readFileSync(agents,'utf8'),original);
  // This is an explicit test-only simulation of the documented manual opt-in.
  // No production apply/installer API exists. Every target is this isolated fixture.
  let receipt=[];
  for(const change of first.changes.filter(c=>c.action==='ADD')){
   const path=scopedPath(h.workspace,change.path);assert.equal(existsSync(path),false);mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path,first.files[change.source],{flag:'wx'});receipt.push({path:change.path,hash:change.after});
  }
  const section='\n<!-- fixture opt-in start -->\n'+first.files['AGENTS.snippet.md']+'<!-- fixture opt-in end -->\n';writeFileSync(agents,original+section);
  for(const name of ['awo-reviewer','awo-evidence'])assert.ok(existsSync(scopedPath(h.workspace,'.codex/agents/'+name+'.toml')));
  assert.ok(existsSync(scopedPath(h.workspace,'.workflow-orchestrator/recipes/feature-development.json')));assert.equal(existsSync(resolve(h.workspace,'.codex/config.toml')),false);
  // Start a standalone fixture runner rather than inheriting the outer runner's child protocol.
  const fixtureEnv={...process.env};delete fixtureEnv.NODE_TEST_CONTEXT;
  const run=spawnSync(process.execPath,['--test','--test-reporter=tap','tests/totals.test.mjs'],{cwd:h.workspace,env:fixtureEnv,encoding:'utf8',windowsHide:true,shell:false});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/# pass 2/);
  const updated=loadConfig();updated.native.profiles[0].when+=' Include the approved additional review criterion.';
  const nextSpec={...spec,project_id:nextId},next=planBundle(nextSpec,updated);stageBundle(nextSpec,updated);
  assert.ok(next.changes.filter(c=>c.path.startsWith('.codex/agents/')).every(c=>c.action==='CONFLICT'));
  const reviewer=next.changes.find(c=>c.path==='.codex/agents/awo-reviewer.toml');assert.notEqual(reviewer.before,reviewer.after);assert.equal(sha256(readFileSync(agents)),sha256(original+section));
  // Review and update only receipt-owned, unchanged additions in the fixture.
  receipt=receipt.map(old=>{const path=scopedPath(h.workspace,old.path),change=next.changes.find(c=>c.path===old.path);assert.equal(sha256(readFileSync(path)),old.hash);writeFileSync(path,next.files[change.source]);return {path:old.path,hash:change.after};});
  const edited=receipt.find(r=>r.path==='.workflow-orchestrator/workflow.md'),editedPath=scopedPath(h.workspace,edited.path);writeFileSync(editedPath,readFileSync(editedPath,'utf8')+'\nConcurrent user edit\n');
  writeFileSync(agents,readFileSync(agents,'utf8')+'\nKeep concurrent project instructions.\n');
  const conflicts=[];
  for(const owned of receipt){const path=scopedPath(h.workspace,owned.path);if(sha256(readFileSync(path))!==owned.hash){conflicts.push(owned.path);continue;}rmSync(path);}
  // Restore only the reviewed instruction section; preserve all concurrent text.
  const current=readFileSync(agents,'utf8');assert.ok(current.includes(section));writeFileSync(agents,current.replace(section,''));
  assert.deepEqual(conflicts,['.workflow-orchestrator/workflow.md']);assert.match(readFileSync(editedPath,'utf8'),/Concurrent user edit/);
  assert.equal(readFileSync(agents,'utf8'),original+'\nKeep concurrent project instructions.\n');assert.equal(sha256(readFileSync(source)),sourceHash);
 }finally{cleanStage(id);cleanStage(nextId);h.close();}
});
