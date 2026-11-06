import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,existsSync,copyFileSync,chmodSync,rmSync,realpathSync} from 'node:fs';
import {resolve,delimiter} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ROOT,inside} from '../../src/core/util.mjs';
import {resolveAgentapiCommand,inspectAgentapiEnv,defaultInvokeAgentapi} from '../../src/desktop-inbox/live-sidecar.mjs';
import {evaluateBridgeReadiness} from '../../src/desktop-inbox/readiness.mjs';

// A renamed local Node executable runs tiny fixture scripts. No App, LS network,
// credentials or private conversation state is used by these tests.
const root=resolve(ROOT,'state/transport-path-'+randomUUID()),bin=resolve(root,'bin with spaces'),a=resolve(root,'project A'),b=resolve(root,'project B');
for(const p of [bin,a,b])mkdirSync(p,{recursive:true});
writeFileSync(resolve(root,'package.json'),' {"type":"commonjs"}\n');
const exe=resolve(bin,process.platform==='win32'?'agentapi.exe':'agentapi');copyFileSync(process.execPath,exe);if(process.platform!=='win32')chmodSync(exe,0o755);
const script=`const fs=require('node:fs'),path=require('node:path');fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({entry:path.basename(process.argv[1]),args:process.argv.slice(2),project:process.env.ANTIGRAVITY_PROJECT_ID??null,cwd:process.cwd()})+'\\n');if(process.env.FIXTURE_STDERR)process.stderr.write(process.env.FIXTURE_STDERR);process.exit(Number(process.env.FIXTURE_EXIT_CODE??0));`;
for(const cwd of [a,b])for(const entry of ['send-message','agentapi'])writeFileSync(resolve(cwd,entry),script);
function envFor(name,extra={}){
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('ANTIGRAVITY_')&&key.toUpperCase()!=='PATH'));
 return {...env,PATH:bin,FIXTURE_LOG:resolve(root,name+'.log'),...extra};
}
const readLog=env=>existsSync(env.FIXTURE_LOG)?readFileSync(env.FIXTURE_LOG,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
after(()=>{assert.ok(root!==resolve(ROOT,'state')&&inside(resolve(ROOT,'state'),root));rmSync(root,{recursive:true,force:true});});

test('documented PATH executable works without any undocumented Antigravity env',async()=>{
 const env=envFor('documented');
 const command=resolveAgentapiCommand(['send-message','receiver-a','literal & | $ goal'],env);
 assert.equal(command.source,'PATH');assert.equal(command.executable,realpathSync(exe));assert.equal(command.support,'DOCUMENTED');
 const capabilities=inspectAgentapiEnv(env);assert.equal(capabilities.agentapi_available,true);assert.equal(capabilities.ls_address_present,false);assert.equal(capabilities.legacy_compatibility,false);
 const result=await defaultInvokeAgentapi(['send-message','receiver-a','literal & | $ goal'],{cwd:a,env});
 assert.equal(result.exit_code,0);assert.equal(result.executable_source,'PATH');assert.equal(result.transport_support,'DOCUMENTED');
 assert.deepEqual(readLog(env),[{entry:'send-message',args:['receiver-a','literal & | $ goal'],project:null,cwd:a}]);
});

test('PATH wins over custom compatibility route and a failure sends exactly once without leaking stderr',async()=>{
 const simulatedValue='sk-'+'x'.repeat(32),env=envFor('failed',{ANTIGRAVITY_AGENTAPI_EXE:process.execPath,FIXTURE_EXIT_CODE:'1',FIXTURE_STDERR:'ECONNREFUSED authorization: Bearer '+simulatedValue+' private-receiver-value'});
 const result=await defaultInvokeAgentapi(['send-message','receiver-a','goal'],{cwd:a,env});
 assert.equal(result.exit_code,1);assert.equal(result.executable_source,'PATH');assert.equal(readLog(env).length,1);assert.equal(readLog(env)[0].entry,'send-message');
 assert.equal(result.diagnostic_code,'ECONNREFUSED');assert.ok(result.diagnostic_summary.length<=240);assert.equal(result.diagnostic_summary.includes(simulatedValue),false);assert.equal(result.diagnostic_summary.includes('private-receiver-value'),false);assert.match(result.diagnostic_summary,/uncertain/);assert.equal('stdout_text' in result,false);
});

test('legacy custom CLI stays explicit NOT VERIFIED and never performs metadata lookup or project rewrite',async()=>{
 const env=envFor('legacy',{PATH:'',ANTIGRAVITY_AGENTAPI_EXE:process.execPath,ANTIGRAVITY_PROJECT_ID:'explicit-static-project'});
 const command=resolveAgentapiCommand(['send-message','receiver-a','goal'],env);assert.equal(command.source,'ANTIGRAVITY_AGENTAPI_EXE');assert.equal(command.support,'LEGACY_COMPAT_NOT_VERIFIED');assert.deepEqual(command.args,['agentapi','send-message','receiver-a','goal']);
 const result=await defaultInvokeAgentapi(['send-message','receiver-a','goal'],{cwd:a,env});assert.equal(result.exit_code,0);assert.equal(result.transport_support,'LEGACY_COMPAT_NOT_VERIFIED');
 assert.deepEqual(readLog(env),[{entry:'agentapi',args:['send-message','receiver-a','goal'],project:'explicit-static-project',cwd:a}]);
});

test('missing PATH executable fails before spawn and relative or cwd entries cannot supply it',async()=>{
 const env=envFor('missing',{PATH:'.'+delimiter+'relative'+delimiter,ANTIGRAVITY_AGENTAPI_EXE:'relative-custom.exe'});
 writeFileSync(resolve(a,process.platform==='win32'?'agentapi.exe':'agentapi'),'not an executable');
 assert.equal(resolveAgentapiCommand(['send-message','receiver-a','goal'],env).executable,null);assert.equal(inspectAgentapiEnv(env).agentapi_available,false);
 const result=await defaultInvokeAgentapi(['send-message','receiver-a','goal'],{cwd:a,env});assert.equal(result.started,false);assert.equal(result.spawn_error,'ENOENT');assert.equal(result.diagnostic_code,'EXECUTABLE_NOT_FOUND');assert.equal(readLog(env).length,0);
});

test('PATH route preserves caller-provided receiver and cwd for independent projects',async()=>{
 const env=envFor('projects');await defaultInvokeAgentapi(['send-message','receiver-a','read A'],{cwd:a,env});await defaultInvokeAgentapi(['send-message','receiver-b','read B'],{cwd:b,env});
 assert.deepEqual(readLog(env).map(x=>({receiver:x.args[0],cwd:x.cwd,project:x.project})),[{receiver:'receiver-a',cwd:a,project:null},{receiver:'receiver-b',cwd:b,project:null}]);
});

test('readiness does not require undocumented LS env on documented PATH, but preserves binding checks',()=>{
 const now=Date.now(),heartbeat={format:'desktop-inbox.sidecar-heartbeat@1',pid:process.pid,status:'RUNNING',updated_at:new Date(now).toISOString(),...inspectAgentapiEnv(envFor('readiness'))};
 const target={format:'desktop-inbox.active-target@1',conversation_id:'receiver-a',workspace_root:a,project_id:'fixture',updated_at:new Date(now).toISOString()};
 const options={workspaceRoot:a,projectId:'fixture',heartbeat,target,now:()=>now};
 assert.equal(evaluateBridgeReadiness(options).ready_to_dispatch,true);
 assert.ok(evaluateBridgeReadiness({...options,target:{...target,workspace_root:b}}).reason_codes.includes('TARGET_FOREIGN_WORKSPACE'));
 const legacy={...heartbeat,agentapi_source:'ANTIGRAVITY_AGENTAPI_EXE',agentapi_support:'LEGACY_COMPAT_NOT_VERIFIED',path_agentapi_available:false};
 assert.ok(evaluateBridgeReadiness({...options,heartbeat:legacy}).reason_codes.includes('LS_ADDRESS_MISSING'));
});
