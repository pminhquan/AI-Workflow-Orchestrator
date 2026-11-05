import test from 'node:test';
import assert from 'node:assert/strict';
import {buildArtifacts,convert} from '../../src/compiler/index.mjs';
import {loadConfig} from '../../src/core/config.mjs';
import {sha256} from '../../src/core/util.mjs';
const roles=loadConfig().roles;
test('compiler outputs deterministic bytes, checksums and provenance',()=>{
 const a=buildArtifacts(),b=buildArtifacts();assert.deepEqual(a,b);const m=JSON.parse(a['manifest.json']);
 for(const r of m.results.filter(x=>x.path)){assert.equal(r.sha256,sha256(a[r.path]));assert.equal(r.provenance[0].commit.length,40);}
 assert.equal(m.results.length,18);assert.equal(Object.keys(a).length,11);
});
test('Codex native TOML is generated only for inherited parent constraints',()=>{
 const role=roles.find(r=>r.role_id==='orchestrator');const r=convert(role,'codex-native');assert.equal(r.status,'NOT VERIFIED');assert.match(r.content,/developer_instructions =/);assert.doesNotMatch(r.content,/sandbox_mode|approval_policy/);
});
test('Codex cannot silently turn read-only prompts into a sandbox',()=>assert.equal(convert(roles.find(r=>r.role_id==='explorer'),'codex-native').status,'UNSUPPORTED'));
test('Antigravity read-only roles use exact native tools and no shell',()=>{
 const r=convert(roles.find(r=>r.role_id==='explorer'),'antigravity-native');assert.equal(r.status,'NOT VERIFIED');assert.match(r.content,/\["view_file","grep_search"\]/);assert.match(r.content,/commandExecutionPolicy: "off"/);assert.doesNotMatch(r.content,/run_command/);
});
test('native write scope, unknown target and unknown tools fail explicitly',()=>{
 const r=roles.find(r=>r.role_id==='implementer');assert.equal(convert(r,'antigravity-native').status,'UNSUPPORTED');assert.equal(convert(r,'new-provider').status,'UNSUPPORTED');assert.equal(convert({...r,allowed_tools:['grant-admin']},'mock').status,'UNSUPPORTED');
});
test('invalid role cannot be compiled',()=>assert.throws(()=>convert({...roles[0],permissions:{}},'mock'),/role:/));
test('mock conversion preserves permission constraints exactly',()=>{for(const role of roles)assert.deepEqual(JSON.parse(convert(role,'mock').content).permissions,role.permissions);});
