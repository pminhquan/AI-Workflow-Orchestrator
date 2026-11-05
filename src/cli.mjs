import {existsSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {ROOT,readJSON,sha256} from './core/util.mjs';
import {loadConfig} from './core/config.mjs';
import {route} from './core/router.mjs';
import {compile,generatedDrift} from './compiler/index.mjs';
import {inventory,diffConfig,planInstall,rollbackPlan,verifyV1} from './core/deployment.mjs';
const [command,...args]=process.argv.slice(2);
try{
 if(args.some(a=>a.startsWith('--')))throw Error('No mutation/install flags supported');
 let result;
 switch(command){
 case 'doctor':{const c=loadConfig();const v1=verifyV1();result={node:process.version,project:ROOT,activation:c.policy.activation,live_dispatch:c.policy.live_dispatch,offline_runtimes:c.capabilities.filter(r=>r.enabled).map(r=>r.runtime_id),v1_status:v1.status,external_integrations:'disabled',secrets_inspected:false};if(v1.status!=='PASS')process.exitCode=1;break;}
 case 'validate':{
  const c=loadConfig(),discrepancies=generatedDrift(c);
  result={valid:!discrepancies.length,roles:c.roles.length,recipes:c.recipes.length,profiles:c.profiles.length,generated_drift:discrepancies};if(discrepancies.length)process.exitCode=1;break;}
 case 'inventory':result=inventory();break;
 case 'diff-config':result=diffConfig();break;
 case 'plan-install':result=planInstall();break;
 case 'rollback-plan':result=rollbackPlan();break;
 case 'compile':result=compile();break;
 case 'verify-v1':result=verifyV1();if(result.status!=='PASS')process.exitCode=1;break;
 case 'route':if(!args[0])throw Error('route requires a local request JSON path');result=route(readJSON(resolve(args[0])));break;
 case 'test':{const r=spawnSync(process.execPath,['--test','tests/unit/*.test.mjs','tests/integration/*.test.mjs'],{cwd:ROOT,stdio:'inherit',windowsHide:true,shell:false});process.exitCode=r.status??1;break;}
 default:throw Error('Commands: doctor, inventory, validate, diff-config, plan-install, test, rollback-plan, compile, route <json>, verify-v1');
 }
 if(result!==undefined)console.log(JSON.stringify(result,null,2));
}catch(e){console.error(JSON.stringify({status:'ERROR',message:e.message}));process.exitCode=1;}
