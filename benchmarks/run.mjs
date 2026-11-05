import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {setup,fixture} from '../tests/helpers.mjs';
import {MockAdapter} from '../src/adapters/offline.mjs';
import {route} from '../src/core/router.mjs';
import {ROOT,readJSON,writeJSON} from '../src/core/util.mjs';
const definitions=readJSON(resolve(ROOT,'benchmarks/scenarios.json'));
const request=extra=>({...fixture('routing.json'),...extra});
const accept=async(h,id)=>{await h.scheduler.verify(id);h.scheduler.accept(id);};
const scenarios={
 'simple-direct':async()=>assert.equal(route(request({kind:'fix',size:'small'})).mode,'DIRECT'),
 'medium-one-worker':async h=>{assert.equal(route(request({})).workers,1);h.scheduler.submit([h.task()],'medium');await h.scheduler.runReady(new MockAdapter());await accept(h,'sample');},
 'independent-parallel':async h=>{h.scheduler.submit([h.task('a'),h.task('b')],'parallel');assert.equal((await h.scheduler.runReady(new MockAdapter())).started.length,2);},
 'complex-dependency-graph':async h=>{h.scheduler.submit([h.task('a'),h.task('b'),h.task('c',{dependencies:['a','b']})],'dag');await h.scheduler.runReady(new MockAdapter());for(const id of ['a','b'])await accept(h,id);assert.deepEqual((await h.scheduler.runReady(new MockAdapter())).started,['c']);await accept(h,'c');},
 'worker-unavailable':async h=>{h.scheduler.submit([h.task()],'unavailable');const a=new MockAdapter({available:false});assert.equal((await h.scheduler.runReady(a)).status,'BLOCKED');assert.equal(a.calls,0);},
 'unsupported-adapter':async()=>assert.equal(route(request({runtime_id:'unsupported',can_direct:false})).mode,'BLOCKED'),
 'duplicate-submission':async h=>{h.scheduler.submit([h.task()],'same');h.scheduler.submit([h.task()],'same');assert.equal(Object.keys(h.store.data.tasks).length,1);},
 'scope-conflict':async h=>{h.scheduler.submit([h.task('a',{write_scope:['sample.txt']}),h.task('b',{write_scope:['sample.txt']})],'conflict');assert.equal((await h.scheduler.runReady(new MockAdapter())).started.length,1);},
 'stale-checks':async h=>{const r=await h.checks.run(h.workspace,'fixture-content');writeFileSync(resolve(h.workspace,'sample.txt'),'changed');assert.equal(h.checks.isFresh(r.id,h.workspace,'fixture-content'),false);},
 'invalid-report':async h=>{h.scheduler.submit([h.task()],'invalid');await h.scheduler.runReady(new MockAdapter({reports:{sample:fixture('reports/malicious.json')}}));assert.equal(h.scheduler.get('sample').status,'failed');},
 'worker-failure':async h=>{h.scheduler.submit([h.task()],'failed');await h.scheduler.runReady(new MockAdapter({failures:{sample:1}}));assert.equal(h.scheduler.get('sample').status,'failed');},
 'retry-exhaustion':async h=>{h.scheduler.submit([h.task('sample',{retry_budget:0})],'exhausted');await h.scheduler.runReady(new MockAdapter({failures:{sample:1}}));assert.throws(()=>h.scheduler.retry('sample'),/exhausted/);},
 'partial-completion':async h=>{h.scheduler.submit([h.task()],'partial');await h.scheduler.runReady(new MockAdapter({reports:{sample:fixture('reports/partial.json')}}));assert.equal(h.scheduler.get('sample').status,'partial');assert.throws(()=>h.scheduler.accept('sample'));},
 'cancellation':async h=>{h.scheduler.submit([h.task()],'cancel');const work=h.scheduler.runReady(new MockAdapter({delay_ms:100}));h.scheduler.cancel('sample');await work;assert.equal(h.scheduler.get('sample').status,'canceled');},
 'no-op-validation-reuse':async h=>{await h.checks.run(h.workspace,'fixture-content');assert.equal((await h.checks.run(h.workspace,'fixture-content')).reused,true);assert.equal(h.checks.executions,1);},
};
const rows=[];
for(const name of definitions.scenarios){
 const h=setup(),started=performance.now();
 try{await scenarios[name](h);rows.push({scenario:name,status:'OFFLINE-TESTED',timing_kind:'synthetic worker / local functional harness',harness_elapsed_ms:performance.now()-started,local_check_executions:h.checks.executions,metrics:Object.fromEntries(definitions.metrics.map(key=>[key,key==='quality'?'functional assertions passed':null]))});}
 catch(e){rows.push({scenario:name,status:'FAIL',error:e.message});process.exitCode=1;}
 finally{h.close();}
}
const result={schema_version:'1.0',claim:'Functional offline evidence only. No measured AI workflow speed or cost improvement.',live_ai_calls:0,comparison_groups:definitions.comparison_groups.map(group=>({group,status:'NOT VERIFIED',measurements:null})),rows};
writeJSON(resolve(ROOT,'state/benchmark-results.json'),result);
console.log(JSON.stringify({passed:rows.filter(x=>x.status==='OFFLINE-TESTED').length,failed:rows.filter(x=>x.status==='FAIL').length,live_ai_calls:0,performance_improvement_claim:null,result:'state/benchmark-results.json'},null,2));
