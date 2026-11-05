import {spawnSync} from 'node:child_process';
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {ROOT,writeJSON,sha256} from '../src/core/util.mjs';
const commands=[
 ['tests','src/cli.mjs','test'],
 ['benchmarks','benchmarks/run.mjs'],
 ['compile','src/cli.mjs','compile'],
 ['compile-repeat','src/cli.mjs','compile'],
 ...['doctor','inventory','validate','diff-config','plan-install','rollback-plan','verify-v1'].map(name=>[name,'src/cli.mjs',name]),
 ['route','src/cli.mjs','route','tests/fixtures/routing.json'],
];
const results=[];
for(const [name,...args] of commands){
 const r=spawnSync(process.execPath,args,{cwd:ROOT,encoding:'utf8',windowsHide:true,shell:false,timeout:30000,maxBuffer:2*1024*1024});
 const log={command:[process.execPath,...args],exit_code:r.status,stdout:r.stdout??'',stderr:r.stderr??'',error:r.error?.message??null};
 writeJSON(resolve(ROOT,'state/verification',name+'.json'),log);
 let assertion=true;
 if(name==='compile-repeat'&&r.status===0)assertion=JSON.parse(r.stdout).diffs.length===0;
 results.push({name,exit_code:r.status,assertion,log:'state/verification/'+name+'.json'});
 if(r.status!==0||!assertion){console.error(name+' failed');process.exitCode=1;}
}
const inputs={};
for(const dir of ['src','config','agents','workflows','tests','benchmarks','scripts']){
 function visit(path){if(lstatSync(path).isDirectory())for(const child of readdirSync(path).sort())visit(resolve(path,child));else inputs[relative(ROOT,path).replaceAll('\\','/')]=sha256(readFileSync(path));}
 visit(resolve(ROOT,dir));
}
writeJSON(resolve(ROOT,'state/verification/summary.json'),{schema_version:'1.0',date:'2026-11-05',node:process.version,results,input_fingerprint:sha256(inputs),input_hashes:inputs,claim:'Offline foundation verification only; no live AI workflow performance claim.'});
console.log(JSON.stringify({passed:results.filter(r=>r.exit_code===0&&r.assertion).length,total:results.length,source_fingerprint:sha256(inputs),summary:'state/verification/summary.json'},null,2));
