import {resolve} from 'node:path';
import {Inbox} from './inbox.mjs';
import {makeJob} from './contracts.mjs';
import {validateBinding} from './binding.mjs';
import {captureWorkspace,readBoundedBytes} from './verification.mjs';
import {deploymentPlan} from './deployment.mjs';

const read = (path,limit) => JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readBoundedBytes(resolve(path),limit)));
const [command,...args] = process.argv.slice(2);
try {
  let result;
  if (command === 'plan' && args.length === 0) result = deploymentPlan();
  else {
    if (!['submit','status','collect','cancel'].includes(command) || args.length !== 2) throw Error('Commands: plan | submit <binding.json> <brief.json> | status/collect/cancel <binding.json> <task_id>. No live dispatch or auto-accept command.');
    const binding = validateBinding(read(args[0],8192));
    const inbox = new Inbox('state/desktop-inbox',binding);
    if (command === 'submit') {
      const job = makeJob(binding,read(args[1],8192));
      result = inbox.submit(job,{baseline:captureWorkspace(binding.workspace_root)});
    } else if (command === 'collect') result = inbox.acceptReport(args[1]);
    else if (command === 'cancel') result = inbox.cancel(args[1]);
    else result = inbox.get(args[1]);
  }
  console.log(JSON.stringify(result,null,2));
} catch (error) {
  console.error(JSON.stringify({status:'ERROR',message:error.message})); process.exitCode = 1;
}
