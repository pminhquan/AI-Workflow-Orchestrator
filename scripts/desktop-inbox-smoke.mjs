// Retained OFFLINE evidence only. This never invokes a real App or agentapi.
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT,scopedPath,writeJSON,sha256} from '../src/core/util.mjs';
import {Inbox} from '../src/desktop-inbox/inbox.mjs';
import {makeJob} from '../src/desktop-inbox/contracts.mjs';
import {runOnce,createMockTransport} from '../src/desktop-inbox/sidecar.mjs';
import {captureWorkspace,verifyJob} from '../src/desktop-inbox/verification.mjs';
import {deploymentPlan} from '../src/desktop-inbox/deployment.mjs';

const relative = 'state/desktop-inbox-smoke-'+randomUUID(), evidenceRoot = scopedPath(ROOT,relative);
mkdirSync(evidenceRoot,{recursive:true});
const workspace = resolve(evidenceRoot,'workspace'); mkdirSync(workspace);
const readme = '# Offline fixture evidence\nHost can compare this exact content.\n';
writeFileSync(resolve(workspace,'README.md'),readme,{flag:'wx'});
const binding = {schema_version:'desktop-inbox.binding@1',enabled:true,workspace_root:workspace,
  project_id:'offline-project',conversation_mode:'existing',conversation_id:'offline-conversation',
  runtime_version:'2.29.0',poll_interval_ms:2000,transport_timeout_ms:2000,
  review:{authorization:false,runtime:false,project:false,conversation:false,user_opt_in:false,
    authorization_reference:'',runtime_reference:'',project_reference:'',conversation_reference:''}};
const inbox = new Inbox(relative+'/inbox',binding);
const job = makeJob(binding,{goal:'Inspect README.md and report actual contents. This is a MOCK fixture.',
  read_scope:['README.md'],write_scope:[],acceptance_criteria:['Findings include the fixture README title.'],
  verification_commands:['fixture-readme']});
writeJSON(resolve(evidenceRoot,'binding.mock.json'),binding);
writeJSON(resolve(evidenceRoot,'submitted.json'),inbox.submit(job,{baseline:captureWorkspace(workspace)}));
const transport = createMockTransport();
writeJSON(resolve(evidenceRoot,'dispatch.mock.json'),await runOnce(inbox,binding,{offline:true,transport}));
writeJSON(resolve(evidenceRoot,'collection.mock.json'),await runOnce(inbox,binding,{offline:true,transport}));
const checks = {'fixture-readme':{args:['-e',
  "const fs=require('node:fs');if(!fs.readFileSync('README.md','utf8').includes('Offline fixture evidence'))process.exit(1);console.log('Fresh host README check');"],
  inputs:['README.md'],timeout_ms:1000,cacheable:false}};
const verified = await verifyJob(inbox,job.task_id,{checks,review:async ({report,actual_changed_files})=>{
  const actual = readFileSync(resolve(workspace,'README.md'),'utf8');
  return {accepted:actual === readme && actual_changed_files.length === 0 &&
    report.findings.join('\n').includes(actual.trim()),notes:['Codex host compared findings with actual fixture README bytes.']};
}});
writeJSON(resolve(evidenceRoot,'verified.mock.json'),verified);
writeJSON(resolve(evidenceRoot,'deployment-plan.json'),deploymentPlan());
const result = {status:'OFFLINE-TESTED',transport:'MOCK EXECUTABLE',actual_antigravity_execution:false,
  live_dispatch:false,evidence_root:evidenceRoot,task_id:job.task_id,attempt_id:job.attempt_id,
  final_state:verified.state,readme_sha256:sha256(readFileSync(resolve(workspace,'README.md'))),
  host_checks:verified.host_receipt.checks.map(check=>({check_id:check.check_id,exit_code:check.exit_code,passed:check.passed,reused:check.reused})),
  worker_report_sha256:verified.report_sha256};
writeJSON(resolve(evidenceRoot,'result.json'),result);
console.log(JSON.stringify(result,null,2));
