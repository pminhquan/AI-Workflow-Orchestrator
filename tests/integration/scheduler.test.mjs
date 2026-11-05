import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,symlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {MockAdapter,ReplayAdapter} from '../../src/adapters/offline.mjs';
import {OfflineStore} from '../../src/core/store.mjs';
import {Scheduler} from '../../src/core/scheduler.mjs';
import {CheckRunner,snapshot} from '../../src/verification/checks.mjs';
import {ROOT,readJSON} from '../../src/core/util.mjs';
import {setup,fixture} from '../helpers.mjs';
async function use(fn){const h=setup();try{return await fn(h);}finally{h.close();}}
test('host checks gate acceptance; report PASS text is insufficient',()=>use(async h=>{
 h.scheduler.submit([h.task()],'success');await h.scheduler.runReady(new MockAdapter());assert.equal(h.scheduler.get('sample').status,'review');assert.throws(()=>h.scheduler.accept('sample'),/Fresh host receipt/);await h.scheduler.verify('sample');assert.equal(h.scheduler.accept('sample').status,'done');
}));
test('duplicate submission is idempotent and changed payload is rejected atomically',()=>use(async h=>{
 const tasks=[h.task()];h.scheduler.submit(tasks,'same');h.scheduler.submit(tasks,'same');assert.equal(Object.keys(h.store.data.tasks).length,1);assert.throws(()=>h.scheduler.submit([h.task('other')],'same'),/different payload/);
}));
test('dependency cycles and unknown IDs leave no partial submission',()=>use(async h=>{
 assert.throws(()=>h.scheduler.submit([h.task('a',{dependencies:['b']}),h.task('b',{dependencies:['a']})],'cycle'),/cycle/);assert.equal(Object.keys(h.store.data.tasks).length,0);assert.throws(()=>h.scheduler.submit([h.task('a',{dependencies:['constructor']})],'unknown'),/Unknown dependency/);
}));
test('two independent tasks start together and a dependent waits for acceptance',()=>use(async h=>{
 h.scheduler.submit([h.task('a'),h.task('b'),h.task('c',{dependencies:['a','b']})],'dag');
 assert.deepEqual((await h.scheduler.runReady(new MockAdapter({delay_ms:5}))).started,['a','b']);assert.equal(h.scheduler.get('c').status,'queued');
 for(const id of ['a','b']){await h.scheduler.verify(id);h.scheduler.accept(id);}assert.deepEqual((await h.scheduler.runReady(new MockAdapter())).started,['c']);
}));
test('scope conflict serializes writers and holds ownership during review',()=>use(async h=>{
 h.scheduler.submit([h.task('a',{write_scope:['sample.txt']}),h.task('b',{write_scope:['sample.txt']})],'conflict');assert.deepEqual((await h.scheduler.runReady(new MockAdapter())).started,['a']);assert.equal((await h.scheduler.runReady(new MockAdapter())).status,'idle');
 await h.scheduler.verify('a');h.scheduler.accept('a');assert.deepEqual((await h.scheduler.runReady(new MockAdapter())).started,['b']);
}));
test('nested workspace aliases cannot bypass ownership tracking',()=>use(async h=>{
 const nested=resolve(h.workspace,'nested');mkdirSync(nested);writeFileSync(resolve(nested,'sample.txt'),'offline fixture\n');const a=h.task('a',{read_scope:['nested/sample.txt'],write_scope:['nested/sample.txt'],required_checks:[]});const b=h.task('b',{workspace:h.task().workspace+'/nested',write_scope:['sample.txt']});h.scheduler.submit([a,b],'nested');assert.deepEqual((await h.scheduler.runReady(new MockAdapter())).started,['a']);
}));
test('Git internals are protected and hidden writes cannot escape snapshot',()=>use(async h=>{
 assert.throws(()=>h.scheduler.submit([h.task('sample',{write_scope:['.git/config']})],'git-scope'),/Git internals/);
 class HiddenWorker extends MockAdapter{async execute(...args){mkdirSync(resolve(h.workspace,'.git'));writeFileSync(resolve(h.workspace,'.git/config'),'bad');return super.execute(...args);}}
 h.scheduler.submit([h.task()],'git-hidden');await h.scheduler.runReady(new HiddenWorker());assert.equal(h.scheduler.get('sample').status,'failed');
}));
test('unavailable worker preflight does not consume attempt or repeatedly dispatch',()=>use(async h=>{
 h.scheduler.submit([h.task()],'unavailable');const adapter=new MockAdapter({available:false});for(let i=0;i<2;i++)assert.equal((await h.scheduler.runReady(adapter)).status,'BLOCKED');assert.equal(adapter.calls,0);assert.equal(h.scheduler.get('sample').attempt,0);
}));
test('unimplemented adapters are rejected',()=>use(async h=>{await assert.rejects(h.scheduler.runReady({runtime_id:'legacy-desktop-bridge'}),/Only offline/);}));
test('DIRECT task authorization cannot be escalated to a worker',()=>use(async h=>{h.scheduler.submit([h.task('sample',{allowed_execution_mode:'DIRECT'})],'direct');const worker=new MockAdapter();await h.scheduler.runReady(worker);assert.equal(worker.calls,0);assert.equal(h.scheduler.get('sample').status,'blocked');}));
test('prototype mutation is rejected at the submission boundary',()=>use(async h=>{assert.throws(()=>h.scheduler.submit([h.task()],'__proto__'),/Invalid idempotency/);}));
test('stale checks require new evidence and no-op reuse runs no subprocess twice',()=>use(async h=>{
 const a=await h.checks.run(h.workspace,'fixture-content');const b=await h.checks.run(h.workspace,'fixture-content');assert.equal(b.reused,true);assert.equal(h.checks.executions,1);writeFileSync(resolve(h.workspace,'sample.txt'),'changed\n');assert.equal(h.checks.isFresh(a.id,h.workspace,'fixture-content'),false);const c=await h.checks.run(h.workspace,'fixture-content');assert.equal(c.passed,false);assert.equal(h.checks.executions,2);
}));
test('check spec and age changes invalidate receipts',()=>use(async h=>{
 let now=100;const runner=new CheckRunner(readJSON(resolve(ROOT,'config/workflow/checks.json')),{now:()=>now});const r=await runner.run(h.workspace,'fixture-content');now+=3600001;assert.equal(runner.isFresh(r.id,h.workspace,'fixture-content'),false);now=100;runner.specs['fixture-content'].args=['-e','process.exit(0)'];assert.equal(runner.isFresh(r.id,h.workspace,'fixture-content'),false);
}));
test('unknown and forged receipt references cannot satisfy checks',()=>use(async h=>{
 const report=fixture('reports/successful.json');report.evidence_refs=['forged-receipt'];h.scheduler.submit([h.task()],'forged');await h.scheduler.runReady(new MockAdapter({reports:{sample:report}}));assert.throws(()=>h.scheduler.accept('sample'),/Fresh host receipt/);
}));
test('invalid worker reports are failed; no fabricated PASS is accepted',()=>use(async h=>{
 h.scheduler.submit([h.task()],'invalid');await h.scheduler.runReady(new MockAdapter({reports:{sample:fixture('reports/malicious.json')}}));assert.equal(h.scheduler.get('sample').status,'failed');assert.throws(()=>h.scheduler.accept('sample'));
}));
test('actual out-of-scope writes are detected even when report hides them',()=>use(async h=>{
 class BadWorker extends MockAdapter{async execute(...args){writeFileSync(resolve(h.workspace,'unexpected.txt'),'bad');return super.execute(...args);}}
 h.scheduler.submit([h.task()],'scope');await h.scheduler.runReady(new BadWorker());assert.equal(h.scheduler.get('sample').status,'failed');assert.match(h.scheduler.get('sample').error,/Out-of-scope/);
}));
test('file writes hidden inside a report mismatch are rejected',()=>use(async h=>{
 const r=fixture('reports/successful.json');r.changed_files=['sample.txt'];h.scheduler.submit([h.task('sample',{write_scope:['sample.txt']})],'mismatch');await h.scheduler.runReady(new MockAdapter({reports:{sample:r}}));assert.match(h.scheduler.get('sample').error,/does not match/);
}));
test('worker failure requires explicit retry and exhaustion prevents repeated dispatch',()=>use(async h=>{
 h.scheduler.submit([h.task('sample',{retry_budget:1})],'failure');const adapter=new MockAdapter({failures:{sample:9}});await h.scheduler.runReady(adapter);assert.equal(h.scheduler.get('sample').status,'failed');assert.equal((await h.scheduler.runReady(adapter)).status,'idle');h.scheduler.retry('sample');await h.scheduler.runReady(adapter);assert.throws(()=>h.scheduler.retry('sample'),/exhausted/);assert.equal(adapter.calls,2);
}));
test('bounded rework succeeds and metrics record retries',()=>use(async h=>{
 h.scheduler.submit([h.task()],'retry');const adapter=new MockAdapter({failures:{sample:1}});await h.scheduler.runReady(adapter);h.scheduler.retry('sample');await h.scheduler.runReady(adapter);await h.scheduler.verify('sample');const r=h.scheduler.accept('sample');assert.equal(r.attempt,2);assert.equal(r.metrics.retry_count,1);assert.ok(r.metrics.review_wait_ms>=0);
}));
test('partial completion never releases dependencies as done',()=>use(async h=>{
 h.scheduler.submit([h.task(),h.task('next',{dependencies:['sample']})],'partial');await h.scheduler.runReady(new MockAdapter({reports:{sample:fixture('reports/partial.json')}}));assert.equal(h.scheduler.get('sample').status,'partial');assert.throws(()=>h.scheduler.accept('sample'));await h.scheduler.runReady(new MockAdapter());assert.equal(h.scheduler.get('next').status,'blocked');
}));
test('running cancellation aborts offline worker and cannot resurrect review',()=>use(async h=>{
 h.scheduler.submit([h.task()],'cancel');const running=h.scheduler.runReady(new MockAdapter({delay_ms:100}),{timeout_ms:500});h.scheduler.cancel('sample');await running;assert.equal(h.scheduler.get('sample').status,'canceled');assert.throws(()=>h.scheduler.accept('sample'));
}));
test('bounded waiting fails once and requires deliberate recovery',()=>use(async h=>{
 h.scheduler.submit([h.task()],'timeout');await h.scheduler.runReady(new MockAdapter({delay_ms:100}),{timeout_ms:10});assert.equal(h.scheduler.get('sample').status,'failed');assert.match(h.scheduler.get('sample').error,/timeout|Canceled/);
}));
test('durable store recovers interrupted tasks without redispatch',()=>use(async h=>{
 h.scheduler.submit([h.task()],'persist');h.scheduler.mutate('sample',t=>{t.status='running';t.attempt=1;},'interrupted');const relative=h.task().workspace.replace('/workspace','/store');h.store.close();const reopened=new OfflineStore(relative);try{const scheduler=new Scheduler(reopened,h.checks);scheduler.recover();assert.equal(scheduler.get('sample').status,'blocked');}finally{reopened.close();}
}));
test('exclusive state writer and live-ledger path protection',()=>use(async h=>{
 const rel=h.task().workspace.replace('/workspace','/store');assert.throws(()=>new OfflineStore(rel),/locked/);assert.throws(()=>new OfflineStore('../live'),/project state/);
}));
test('symlinks or junctions cannot bypass workspace containment',()=>use(async h=>{
 const outside=resolve(h.dir,'outside');mkdirSync(outside);symlinkSync(outside,resolve(h.workspace,'escape'),'junction');assert.throws(()=>snapshot(h.workspace),/Links|junction/);
}));
test('replay uses only sanitized fixture contracts',()=>use(async h=>{
 h.scheduler.submit([h.task()],'replay');await h.scheduler.runReady(new ReplayAdapter({sample:fixture('reports/successful.json')}));await h.scheduler.verify('sample');assert.equal(h.scheduler.accept('sample').status,'done');
}));
