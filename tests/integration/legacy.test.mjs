import test from 'node:test';
import assert from 'node:assert/strict';
import {translateLegacyReport} from '../../src/adapters/legacy-report.mjs';
import {ReplayAdapter} from '../../src/adapters/offline.mjs';
import {fixture,setup} from '../helpers.mjs';
test('sanitized legacy replay still requires fresh V2 host checks',async()=>{
 const h=setup();try{const report=translateLegacyReport(fixture('legacy-report.json'),{task_id:'sample',attempt:1});assert.equal(report.tests[0].outcome,'not-run');h.scheduler.submit([h.task()],'legacy-replay');await h.scheduler.runReady(new ReplayAdapter({sample:report}));assert.throws(()=>h.scheduler.accept('sample'),/Fresh host receipt/);await h.scheduler.verify('sample');assert.equal(h.scheduler.accept('sample').status,'done');}finally{h.close();}
});
test('legacy credentials, task state and out-of-scope paths are never imported',()=>{
 const report=fixture('legacy-report.json');for(const changed of [{...report,worker_token:'synthetic-rejected'},{...report,status:'done'},{...report,changed_files:['../outside']}])assert.throws(()=>translateLegacyReport(changed,{task_id:'sample',attempt:1}));
});
