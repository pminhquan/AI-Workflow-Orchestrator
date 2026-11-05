import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {resolve,relative,basename} from 'node:path';
import {ROOT,sha256,inside,scopedPath,writeJSON} from '../../src/core/util.mjs';
import {planBundle,stageBundle} from '../../src/native/bundle.mjs';
import {verifyV1} from '../../src/core/deployment.mjs';
import {fixture,setup} from '../helpers.mjs';

test('project fixture preview protects existing AGENTS and does not install anything',()=>{
 const spec=fixture('project-bundle.json'),path=resolve(ROOT,spec.project_root,'AGENTS.md'),before=sha256(readFileSync(path));
 const a=planBundle(spec),b=planBundle(spec);assert.deepEqual(a,b);
 assert.equal(a.dry_run,true);assert.equal(a.install,false);assert.equal(a.status,'REVIEW REQUIRED');
 assert.equal(a.changes.find(c=>c.path==='AGENTS.md').action,'MANUAL-MERGE-REQUIRED');
 assert.equal(sha256(readFileSync(path)),before);assert.equal(existsSync(resolve(ROOT,spec.project_root,'.codex')),false);
 assert.match(a.files['workflow.md'],/example-backend-v22/);assert.match(a.files['workflow.md'],/node --test/);
});
test('staging is deterministic and immutable, conflicts preserve project files and global config is absent',()=>{
 const h=setup(),id='bundle-'+basename(h.dir),stage=scopedPath(ROOT,'state/bundles/'+id);
 const spec={schema_version:'1.0',project_id:id,project_root:relative(ROOT,h.workspace).replaceAll('\\','/'),validation_commands:['node --test']};
 try{
  mkdirSync(resolve(h.workspace,'.codex/agents'),{recursive:true});writeFileSync(resolve(h.workspace,'.codex/agents/user.toml'),'user-owned\n');
  writeFileSync(resolve(h.workspace,'.codex/config.toml'),'parent-owned\n');
  const a=planBundle(spec);assert.ok(a.changes.filter(c=>c.path.startsWith('.codex/agents/')).every(c=>c.action==='CONFLICT'));
  assert.ok(!a.changes.some(c=>c.path.endsWith('config.toml')));assert.ok(!Object.keys(a.files).some(p=>p.includes('config.toml')));
  stageBundle(spec);const before=sha256(readFileSync(resolve(stage,'bundle-manifest.json')));stageBundle(spec);assert.equal(sha256(readFileSync(resolve(stage,'bundle-manifest.json'))),before);
  assert.equal(readFileSync(resolve(h.workspace,'.codex/config.toml'),'utf8'),'parent-owned\n');assert.equal(readFileSync(resolve(h.workspace,'.codex/agents/user.toml'),'utf8'),'user-owned\n');
  writeFileSync(resolve(stage,'workflow.md'),'concurrent edit\n');assert.throws(()=>stageBundle(spec),/drift/);assert.equal(readFileSync(resolve(stage,'workflow.md'),'utf8'),'concurrent edit\n');
 }finally{if(inside(resolve(ROOT,'state/bundles'),stage)&&stage!==resolve(ROOT,'state/bundles'))rmSync(stage,{recursive:true,force:true});h.close();}
});
test('bundle refuses linked targets, unsafe IDs and traversal without installing',()=>{
 const h=setup();try{
  const spec={schema_version:'1.0',project_id:'safe',project_root:relative(ROOT,h.workspace).replaceAll('\\','/'),validation_commands:[]};
  assert.throws(()=>planBundle({...spec,project_id:'../outside'}),/project-bundle/);
  assert.throws(()=>planBundle({...spec,project_root:'../outside'}),/Unsafe/);
  const outside=resolve(h.dir,'outside');mkdirSync(outside);symlinkSync(outside,resolve(h.workspace,'.codex'),'junction');
  assert.throws(()=>planBundle(spec),/Links|Linked/);
 }finally{h.close();}
});
test('V1 reporting distinguishes missing/invalid baseline from real target drift; no synthetic PASS',()=>{
 const h=setup();try{
  const path=resolve(h.dir,'baseline.json');assert.equal(verifyV1(path).status,'BASELINE UNAVAILABLE');
  writeJSON(path,{files:[]});assert.equal(verifyV1(path).status,'BASELINE UNAVAILABLE');
  writeJSON(path,{files:[{path:resolve(h.workspace,'sample.txt'),sha256:'0'.repeat(64)}]});assert.equal(verifyV1(path).status,'DRIFT');
  writeJSON(path,{files:[{path:resolve(h.workspace,'sample.txt'),sha256:sha256(readFileSync(resolve(h.workspace,'sample.txt')))}]});assert.equal(verifyV1(path).status,'PASS');
 }finally{h.close();}
});
