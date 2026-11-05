import test from 'node:test';
import assert from 'node:assert/strict';
import {route} from '../../src/core/router.mjs';
import {loadConfig} from '../../src/core/config.mjs';
import {fixture} from '../helpers.mjs';
const request=extra=>({...fixture('routing.json'),...extra});
test('simple task uses DIRECT without a task graph',()=>{const r=route(request({kind:'fix',size:'small'}));assert.equal(r.mode,'DIRECT');assert.equal(r.recipe_id,'simple-fix');assert.equal(r.workers,0);assert.equal(r.interface,'offline-routing-recommendation');assert.equal(r.execution,'NOT EXECUTED');});
test('medium task uses one offline worker',()=>{const r=route(request({}));assert.equal(r.mode,'DELEGATED');assert.equal(r.workers,1);});
test('large independent milestones use TEAM bounded to two',()=>{const r=route(request({size:'large',independent_units:5,milestones:['inspect','integrate']}));assert.equal(r.mode,'TEAM');assert.equal(r.workers,2);});
test('length or large scope alone does not create TEAM',()=>assert.equal(route(request({size:'large',independent_units:1})).mode,'DELEGATED'));
for(const runtime_id of ['antigravity-native','legacy-desktop-bridge','missing','gemini-api'])test('unavailable/unsupported runtime safely degrades: '+runtime_id,()=>assert.equal(route(request({runtime_id})).mode,'DIRECT'));
test('missing critical capability blocks rather than silent degradation',()=>assert.equal(route(request({runtime_id:'antigravity-native',critical_capabilities:['teamwork']})).mode,'BLOCKED'));
test('worker unavailable and DIRECT forbidden is BLOCKED',()=>assert.equal(route(request({runtime_id:'missing',can_direct:false})).mode,'BLOCKED'));
test('unclear ownership and low benefit avoid delegation',()=>{assert.equal(route(request({ownership_clear:false})).mode,'DIRECT');assert.equal(route(request({expected_benefit:0})).mode,'DIRECT');});
test('unverified backend cannot be selected even when enabled',()=>{const c=loadConfig();c.capabilities.find(x=>x.runtime_id==='mock').verified=false;assert.equal(route(request({}),c).mode,'DIRECT');});
test('all five recipes are consumed by the routing engine',()=>{for(const kind of ['fix','feature','refactor','research','review'])assert.ok(route(request({kind})).recipe_id);});
test('recipe roles must be eligible in selected team and empty selection falls back',()=>{
 const c=loadConfig();c.profiles.find(p=>p.mode==='DELEGATED').roles=['orchestrator','implementer'];
 assert.deepEqual(route(request({}),c).roles,['orchestrator','implementer']);
 c.profiles.find(p=>p.mode==='DELEGATED').roles=['orchestrator'];assert.equal(route(request({}),c).mode,'DIRECT');
});
test('TEAM milestone requirement follows canonical routing policy',()=>{
 const c=loadConfig(),r=request({size:'large',independent_units:2,milestones:[]});assert.equal(route(r,c).mode,'DELEGATED');
 c.routing.team_requires_milestones=false;assert.equal(route(r,c).mode,'TEAM');
});
