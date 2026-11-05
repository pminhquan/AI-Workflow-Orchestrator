import test from 'node:test';
import assert from 'node:assert/strict';
import {planInstall,diffConfig,rollbackPlan,inventory,verifyV1} from '../../src/core/deployment.mjs';
test('install plan is always dry-run and protects all V1 and app-owned components',()=>{
 const plan=planInstall();assert.equal(plan.dry_run,true);assert.equal(plan.activation,'BLOCKED');assert.equal(plan.steps.length,7);assert.ok(plan.protected_components.includes('v1-private-ledger'));assert.ok(plan.steps.every(s=>s.action.includes('no copy')));
});
test('audit references are never proposed as replacement config contents',()=>{
 const diff=diffConfig();for(const row of diff.changes.filter(x=>x.method.includes('audit-reference')))assert.equal(row.proposed_hash,null);
});
test('no live rollback is required and app-owned state is never read for drift',()=>{
 assert.equal(rollbackPlan().changes_made_to_live,0);for(const row of inventory().filter(x=>x.management==='app-owned'))assert.equal(row.current_target_hash,null);
});
test('V1 source and installed config checksums match the read-only baseline',()=>assert.equal(verifyV1().status,'PASS'));
