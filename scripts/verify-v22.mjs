import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {ROOT,readJSON,writeJSON,sha256} from '../src/core/util.mjs';
import {verifyV1} from '../src/core/deployment.mjs';

const runs=[];
function run(name,args,executable=process.execPath){
 const r=spawnSync(executable,args,{cwd:ROOT,encoding:'utf8',windowsHide:true,shell:false,timeout:60000,maxBuffer:4*1024*1024});
 const log={args,exit_code:r.status,stdout:r.stdout??'',stderr:r.stderr??'',error:r.error?.message??null};
 writeJSON(resolve(ROOT,'state/v2.2-verification',name+'.json'),log);
 runs.push({name,exit_code:r.status,log:'state/v2.2-verification/'+name+'.json'});return log;
}
const tests=run('tests',['src/cli.mjs','test']);
const summary=Object.fromEntries(['tests','pass','fail','skipped'].map(key=>[key,Number(tests.stdout.match(new RegExp('(?:# |ℹ )'+key+' (\\d+)'))?.[1]??NaN)]));
const failures=[...tests.stdout.matchAll(/^(?:✖ (.+) \([\d.]+(?:ms|s)\)|not ok \d+ - (.+))$/gm)].map(m=>m[1]??m[2]);
const known='V1 source and installed config checksums match the read-only baseline';
const v1=verifyV1();
const knownV1Failure=tests.exit_code===1&&summary.fail===1&&failures.length>0&&failures.every(x=>x===known)&&v1.status!=='PASS';
const testRegression=!Number.isFinite(summary.tests)||summary.tests<1||summary.skipped!==0||tests.exit_code!==0&&!knownV1Failure;
const scenarios=run('scenarios',['benchmarks/run.mjs']);
const compile1=run('compile-first',['src/cli.mjs','compile']);
const compile2=run('compile-repeat',['src/cli.mjs','compile']);
const validation=run('schema-validation',['src/cli.mjs','validate']);
const toml=run('toml-syntax',['-c',"import pathlib,tomllib; files=list(pathlib.Path('agents/generated').rglob('*.toml')); [tomllib.loads(p.read_text(encoding='utf-8')) for p in files]; print(f'{len(files)} TOML files parsed with Python tomllib')"],'python');
const preview=run('onboarding-dry-run',['src/cli.mjs','bundle-plan','tests/fixtures/project-bundle.json']);
const v1Check=run('v1-baseline',['src/cli.mjs','verify-v1']);
const parse=log=>{try{return JSON.parse(log.stdout);}catch{return null;}};
const deterministic=compile1.exit_code===0&&compile2.exit_code===0&&parse(compile2)?.diffs?.length===0;
const beforePath=resolve(ROOT,'state/v2.2-v1-before.json');
const before=existsSync(beforePath)?readJSON(beforePath):null;
const taskUnchanged=!!before?.files?.length&&before.files.every(f=>(existsSync(f.path)?sha256(readFileSync(f.path)):null)===f.sha256);
const unchangedBaseline=readJSON(resolve(ROOT,'legacy/v1-inventory.json'));
const installationsAbsent=['.codex','.agents'].every(p=>!existsSync(resolve(ROOT,p)));
const capabilities=readJSON(resolve(ROOT,'config/integrations/capabilities.json')).runtimes;
const adaptersDisabled=capabilities.filter(r=>!['mock','replay'].includes(r.runtime_id)).every(r=>!r.enabled&&!r.verified&&r.concurrency===0);
const regression=testRegression||[scenarios,validation,toml,preview].some(r=>r.exit_code!==0)||!deterministic||!taskUnchanged||!installationsAbsent||!adaptersDisabled;
const inputs={};
for(const dir of ['src','config','agents','workflows','tests','benchmarks','scripts','docs']){
 const visit=path=>{if(lstatSync(path).isDirectory())for(const child of readdirSync(path).sort())visit(resolve(path,child));else{const name=relative(ROOT,path).replaceAll('\\','/');if(name!=='docs/audit/v2.2-verification.json')inputs[name]=sha256(readFileSync(path));}};visit(resolve(ROOT,dir));
}
for(const name of ['README.md','AGENTS.md','CHANGELOG.md','package.json','.gitignore'])inputs[name]=sha256(readFileSync(resolve(ROOT,name)));
const result={schema_version:'1.0',date:'2026-11-05',node:process.version,status:regression?'V2 REGRESSION':v1.status==='PASS'?'PASS':'V1 '+v1.status,v2_regression:regression,tests:{...summary,known_v1_failure:knownV1Failure},offline_scenarios:parse(scenarios),schema_valid:parse(validation)?.valid===true,deterministic_compile:deterministic,toml_syntax:toml.exit_code===0?'OFFLINE-TESTED':'FAIL',onboarding:'dry-run; no target writes',v1:{baseline_status:v1.status,task_before_after:taskUnchanged?'UNCHANGED':'NOT VERIFIED / CHANGED',baseline_rewritten:false,allowlisted_files:unchangedBaseline.files.length},security:{native_discovery_directories_absent:installationsAbsent,nonoffline_scheduler_adapters_disabled:adaptersDisabled,antigravity_invoked:false,global_config_written:false,installation:false,deployment:false,push:false},native_smoke:'See v2.2-native-smoke.json; separate actual native participation, not scheduler receipts',runs,input_fingerprint:sha256(inputs),input_hashes:inputs,claim:'Offline regression plus separately recorded native read-heavy participation; no production or performance claim.'};
writeJSON(resolve(ROOT,'docs/audit/v2.2-verification.json'),result);
console.log(JSON.stringify({...result,input_hashes:undefined},null,2));
if(regression||v1.status!=='PASS'||v1Check.exit_code!==0)process.exitCode=1;
