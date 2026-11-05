import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateBinding,activationBlockers} from './binding.mjs';
import {Inbox} from './inbox.mjs';
import {pollInbox,createMockTransport} from './sidecar.mjs';

// This entry point is for an App-managed command Sidecar candidate. It does not
// launch the App, agy, agentapi, a service, or any external authentication flow.
export async function main(args = process.argv.slice(2)) {
  if (args.length < 1 || args.length > 2 || (args[1] && !['--mock-once','--mock-poll'].includes(args[1]))) throw Error('Expected binding JSON path [--mock-once|--mock-poll]');
  const binding = JSON.parse(readFileSync(resolve(args[0]),'utf8'));
  if (binding.enabled === false) { console.log(JSON.stringify({status:'DISABLED',live_dispatch:false})); return; }
  validateBinding(binding);
  if (!args[1]) throw Error('Activation BLOCKED: '+activationBlockers(binding).join('; '));
  const inbox = new Inbox('state/desktop-inbox',binding);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    await pollInbox(inbox,binding,{offline:true,transport:createMockTransport(),
      signal:controller.signal,maxTicks:args[1] === '--mock-once' ? 1 : Infinity,
      onEvent:result=>console.log(JSON.stringify(result))});
  } finally { process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error=>{console.error(JSON.stringify({status:'BLOCKED',error:error.message}));process.exitCode=1;});
}
