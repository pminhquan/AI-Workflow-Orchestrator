import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeGuidance,buildNativeArtifacts} from '../../src/native/guidance.mjs';
import {loadConfig} from '../../src/core/config.mjs';
import {fixture} from '../helpers.mjs';
const req=extra=>({...fixture('routing.json'),runtime_id:'codex-native',...extra});
const host=extra=>({...fixture('native-host.json'),...extra});

test('native guidance is advice only and never upgrades disabled offline adapter',()=>{
 const config=loadConfig(),before=structuredClone(config.capabilities),r=nativeGuidance(req({}),host({}),config);
 assert.equal(r.mode,'DELEGATED');assert.equal(r.workers,1);assert.equal(r.execution,'NOT EXECUTED');assert.deepEqual(config.capabilities,before);assert.equal(before.find(c=>c.runtime_id==='codex-native').enabled,false);
});
test('native DIRECT avoids subagents for microtasks and uncertain benefit/ownership',()=>{
 for(const changes of [{size:'small'},{expected_benefit:0},{ownership_clear:false},{dependencies_clear:false}]){
  const r=nativeGuidance(req(changes),host({}));assert.equal(r.mode,'DIRECT');assert.equal(r.workers,0);assert.deepEqual(r.assignments,[]);
 }
});
test('TEAM needs useful independent milestones and respects host downgrade',()=>{
 const request=req({size:'large',independent_units:4,milestones:['inspect','integrate']});
 assert.equal(nativeGuidance(request,host({})).workers,2);
 assert.equal(nativeGuidance(request,host({max_workers:1})).workers,1);
 assert.equal(nativeGuidance(request,host({supported_operations:['direct','subagents']})).mode,'DELEGATED');
 assert.equal(nativeGuidance({...request,milestones:[]},host({})).mode,'DELEGATED');
});
test('unsupported runtime, unavailable tools and prohibited delegation fallback safely',()=>{
 for(const changes of [{runtime_id:'antigravity-native'},{invocation_available:false},{delegation_allowed:false},{max_workers:0}]){
  assert.equal(nativeGuidance(req({}),host(changes)).mode,'DIRECT');
  assert.equal(nativeGuidance(req({can_direct:false}),host(changes)).mode,'BLOCKED');
 }
 assert.equal(nativeGuidance(req({critical_capabilities:['subagents']}),host({invocation_available:false})).mode,'BLOCKED');
 assert.equal(nativeGuidance(req({critical_capabilities:['parallel']}),host({supported_operations:['direct','parallel']})).mode,'BLOCKED');
 assert.equal(nativeGuidance(req({critical_capabilities:['task-isolation'],size:'small'}),host({})).mode,'BLOCKED');
 assert.throws(()=>nativeGuidance(req({}),host({supported_operations:['task-isolation']})),/native-host/);
});
test('role menu respects team eligibility and discovered custom profiles',()=>{
 const c=loadConfig();c.profiles.find(p=>p.mode==='DELEGATED').roles=['orchestrator','code-reviewer'];
 let r=nativeGuidance(req({kind:'review'}),host({}),c);assert.deepEqual(r.assignments.map(a=>a.agent),['default']);
 r=nativeGuidance(req({kind:'review'}),host({custom_agents:['awo-reviewer']}),c);assert.equal(r.assignments[0].agent,'awo-reviewer');
 c.profiles.find(p=>p.mode==='DELEGATED').roles=['orchestrator'];assert.equal(nativeGuidance(req({kind:'review'}),host({}),c).mode,'DIRECT');
 assert.ok(nativeGuidance(req({kind:'research'}),host({})).assignments.some(a=>a.agent==='explorer'));
});
test('guidance and advisory TOML are deterministic with inherited configuration',()=>{
 const c=loadConfig(),a=buildNativeArtifacts(c);assert.deepEqual(a,buildNativeArtifacts(c));
 assert.match(a['codex-guidance/workflow.md'],/at most 2 active workers/);
 assert.match(a['codex-guidance/workflow.md'],/No matching recipe|feature-development/);
 for(const p of c.native.profiles){const text=a['codex-guidance/'+p.name+'.toml'];assert.match(text,/parent|Parent/);assert.doesNotMatch(text,/^(?:model|sandbox_mode|approval_policy|mcp_servers)\s*=/m);}
 assert.throws(()=>nativeGuidance(req({}),host({max_workers:3})),/native-host/);
});
