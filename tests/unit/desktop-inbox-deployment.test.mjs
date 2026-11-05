import test from 'node:test';
import assert from 'node:assert/strict';
import {deploymentPlan,appReceiverPlan,validateManifest,planRegistration,rollbackRegistration,rollbackFilePlan,SIDECAR_ID,APP_RECEIVER_ID} from '../../src/desktop-inbox/deployment.mjs';

test('candidate manifest matches documented command schema and plan never installs or enables',()=>{
  const a = deploymentPlan(), b = deploymentPlan();
  assert.deepEqual(a,b); assert.equal(a.status,'BLOCKED');
  assert.equal(a.install,false); assert.equal(a.enable,false); assert.equal(a.live_dispatch,false);
  assert.equal(a.manifest.restart_policy,'never'); assert.equal(a.files.length,16);
  assert.throws(()=>validateManifest({...a.manifest,enabled:true}),/Unsupported/);
  assert.throws(()=>validateManifest({...a.manifest,builtin:'schedule'}),/Unsupported/);
  assert.throws(()=>validateManifest({builtin:'private-api'}),/Unsupported/);
});

test('registration/rollback preserves user files, other Sidecars and concurrent settings',()=>{
  const before = {sidecars:{existing:{enabled:true,projectId:'other'}},userSettings:{theme:'dark'}};
  const saved = structuredClone(before);
  const plan = planRegistration(before,{enabled:false,projectId:'reviewed-project'});
  assert.deepEqual(before,saved);
  plan.after.sidecars.concurrent = {enabled:false}; plan.after.userSettings.theme = 'light';
  const result = rollbackRegistration(plan.after,plan.receipt);
  assert.deepEqual(result,{sidecars:{...before.sidecars,concurrent:{enabled:false}},userSettings:{theme:'light'}});
  assert.throws(()=>planRegistration(plan.after,{enabled:false,projectId:'another'}),/collision/);
  plan.after.sidecars[SIDECAR_ID].projectId = 'concurrent-edit';
  assert.throws(()=>rollbackRegistration(plan.after,plan.receipt),/conflict/);
});

test('rollback only removes an unchanged addition and preserves concurrent file contents',()=>{
  const plan = planRegistration({existing:'keep'},{enabled:false,projectId:'reviewed'});
  assert.deepEqual(rollbackRegistration(plan.after,plan.receipt),{existing:'keep'});
  assert.deepEqual(rollbackFilePlan({'own.mjs':'hash','edited.mjs':'new','user.mjs':'keep'},
    {'own.mjs':'hash','edited.mjs':'old','absent.mjs':'old'}),[
    {path:'own.mjs',action:'REMOVE UNCHANGED OWNED ADDITION'},
    {path:'edited.mjs',action:'CONFLICT; PRESERVE'},
    {path:'absent.mjs',action:'ALREADY ABSENT'}]);
});

test('App receiver plan is disabled and reuses collision-safe section rollback',()=>{
 const plan=appReceiverPlan();assert.equal(plan.install,false);assert.equal(plan.enable,false);
 assert.equal(plan.manifest.restart_policy,'never');assert.equal(plan.sidecar_id,APP_RECEIVER_ID);
 assert.deepEqual(plan,appReceiverPlan());
 assert.throws(()=>planRegistration({}, {enabled:true,projectId:'REVIEW_REQUIRED'},APP_RECEIVER_ID),/Invalid/);
 const old={sidecars:{'codex-bridge':{enabled:true,projectId:'legacy'}},other:'preserve'};
 const registration=planRegistration(old,{enabled:true,projectId:'reviewed'},APP_RECEIVER_ID);
 assert.deepEqual(rollbackRegistration(registration.after,registration.receipt),old);
 registration.after.sidecars[APP_RECEIVER_ID].enabled=false;
 assert.throws(()=>rollbackRegistration(registration.after,registration.receipt),/conflict/);
});
