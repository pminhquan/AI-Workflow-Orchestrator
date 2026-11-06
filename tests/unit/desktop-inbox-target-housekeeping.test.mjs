import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT,inside,sha256} from '../../src/core/util.mjs';
import {writeActiveTarget,readTargetCandidates,pruneTargetObservations,workspaceStateRelative,openLiveInbox} from '../../src/desktop-inbox/live-bridge.mjs';
import {makeJob} from '../../src/desktop-inbox/contracts.mjs';
import {captureWorkspace} from '../../src/desktop-inbox/verification.mjs';

function fixture(){const relative='state/test-target-prune-'+randomUUID(),root=resolve(ROOT,relative),workspace=resolve(root,'project'),stateDirectory=relative+'/bridge';mkdirSync(workspace,{recursive:true});writeFileSync(resolve(workspace,'README.md'),'fixture');return {root,workspace,stateDirectory,close(){assert.ok(inside(resolve(ROOT,'state'),root));rmSync(root,{recursive:true,force:true});}};}
function observations(f,template,count,stamp){const directory=resolve(ROOT,workspaceStateRelative(f.workspace,f.stateDirectory),'targets');for(let i=0;i<count;i++){const id='observation-'+i;writeFileSync(resolve(directory,sha256(id)+'.json'),JSON.stringify({...template,conversation_id:id,updated_at:new Date(stamp).toISOString()}));}}

test('audit: 129 expired observations are pruned without deleting current target',()=>{
 const f=fixture();try{const now=Date.now(),old=now-3*3600000;
  const first=writeActiveTarget(f.workspace,{conversationId:'old-active',stateDirectory:f.stateDirectory,now:()=>old});observations(f,first.target,129,old);
  assert.equal(readTargetCandidates(f.workspace,{stateDirectory:f.stateDirectory}).length,130);
  writeActiveTarget(f.workspace,{conversationId:'fresh-active',stateDirectory:f.stateDirectory,now:()=>now});
  assert.deepEqual(readTargetCandidates(f.workspace,{stateDirectory:f.stateDirectory}).map(c=>c.conversation_id),['fresh-active']);
 }finally{f.close();}
});

test('audit: 129 fresh observations are retained and not silently guessed away',()=>{
 const f=fixture();try{const now=Date.now(),first=writeActiveTarget(f.workspace,{conversationId:'active',stateDirectory:f.stateDirectory,now:()=>now});observations(f,first.target,129,now);
  assert.equal(pruneTargetObservations(f.workspace,{stateDirectory:f.stateDirectory,now:()=>now}).removed,0);
  assert.equal(readTargetCandidates(f.workspace,{stateDirectory:f.stateDirectory}).length,130);
 }finally{f.close();}
});

test('audit: malformed or removed-workspace observations cannot break target updates',()=>{
 const f=fixture();try{const now=Date.now(),first=writeActiveTarget(f.workspace,{conversationId:'active',stateDirectory:f.stateDirectory,now:()=>now});
  const directory=resolve(ROOT,workspaceStateRelative(f.workspace,f.stateDirectory),'targets');
  for(const [id,workspace_root] of [['invalid',{}],['removed',resolve(f.root,'no-longer-exists')]])writeFileSync(resolve(directory,sha256(id)+'.json'),JSON.stringify({...first.target,workspace_root,conversation_id:id}));
  assert.doesNotThrow(()=>writeActiveTarget(f.workspace,{conversationId:'new-active',stateDirectory:f.stateDirectory,now:()=>now}));
  assert.equal(readTargetCandidates(f.workspace,{stateDirectory:f.stateDirectory}).length,4);
 }finally{f.close();}
});

test('audit: an uncertain active job receiver survives TTL housekeeping',()=>{
 const f=fixture();try{const now=Date.now(),old=now-3*3600000;
  writeActiveTarget(f.workspace,{conversationId:'held-receiver',stateDirectory:f.stateDirectory,now:()=>old});
  const {inbox,config}=openLiveInbox(f.workspace,{stateDirectory:f.stateDirectory});const job=makeJob(config.binding,{goal:'Read',read_scope:['README.md'],write_scope:[],acceptance_criteria:['Read only'],verification_commands:['noop']});inbox.submit(job,{baseline:captureWorkspace(f.workspace)});const claim=inbox.claim(job.task_id);inbox.beginDispatch(job.task_id,claim.claim_id);inbox.recordDelivery(job.task_id,claim.claim_id,{kind:'OFFLINE_TEST',started:true,exit_code:1,target_conversation_id:'held-receiver'});inbox.fail(job.task_id,claim.claim_id,'Uncertain',{uncertain:true});
  writeActiveTarget(f.workspace,{conversationId:'fresh-receiver',stateDirectory:f.stateDirectory,now:()=>now});
  const ids=readTargetCandidates(f.workspace,{stateDirectory:f.stateDirectory}).map(c=>c.conversation_id).sort();assert.deepEqual(ids,['fresh-receiver','held-receiver']);assert.equal(inbox.get(job.task_id).outcome,'UNCERTAIN_DELIVERY');
 }finally{f.close();}
});
