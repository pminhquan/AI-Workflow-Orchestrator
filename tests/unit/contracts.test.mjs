import test from 'node:test';
import assert from 'node:assert/strict';
import {validate,schema,requireValid} from '../../src/core/schema.mjs';
import {safeRelative,overlaps} from '../../src/core/util.mjs';
import {loadConfig} from '../../src/core/config.mjs';
import {fixture} from '../helpers.mjs';
for(const name of ['successful','partial','failed'])test('valid report: '+name,()=>assert.equal(validate(fixture('reports/'+name+'.json'),schema('worker-report')).valid,true));
test('malicious report cannot claim PASS, grant permissions or escape paths',()=>{
 const r=validate(fixture('reports/malicious.json'),schema('worker-report'));assert.equal(r.valid,false);assert.ok(r.errors.length>=3);
});
test('schema engine rejects unsupported keywords instead of skipping constraints',()=>assert.throws(()=>validate({},{$ref:'other'}),/Unsupported schema/));
test('task rejects empty acceptance, excessive retry and unknown properties',()=>{
 const t=fixture('task.json');t.acceptance_criteria=[];t.retry_budget=9;t.worker_token='not-a-real-token';assert.equal(validate(t,schema('task-brief')).valid,false);
});
test('strict scoped paths include Windows aliases and traversal',()=>{
 for(const p of ['../x','C:/x','a\\x','/x','a/../b','a//b','a:stream','NUL.txt','a.','a/./b','x\u0000'])assert.throws(()=>safeRelative(p));
 assert.equal(safeRelative('src/core/file.mjs'),'src/core/file.mjs');assert.equal(overlaps('SRC','src/a.mjs'),true);assert.equal(overlaps('src/a','src/ab'),false);
});
test('canonical registries are valid and cross-referenced',()=>{const c=loadConfig();assert.equal(c.roles.length,6);assert.equal(c.recipes.length,5);assert.equal(c.profiles.length,3);assert.deepEqual(c.capabilities.filter(c=>c.enabled).map(c=>c.runtime_id),['mock','replay']);});
