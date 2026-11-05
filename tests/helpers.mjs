import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {ROOT,readJSON,inside} from '../src/core/util.mjs';
import {OfflineStore} from '../src/core/store.mjs';
import {Scheduler} from '../src/core/scheduler.mjs';
import {CheckRunner} from '../src/verification/checks.mjs';
export const fixture=p=>readJSON(resolve(ROOT,'tests/fixtures',p));
export function setup(){
 const rel='state/test-'+randomUUID(),dir=resolve(ROOT,rel),workspace=resolve(dir,'workspace');
 mkdirSync(workspace,{recursive:true});writeFileSync(resolve(workspace,'sample.txt'),'offline fixture\n');
 const store=new OfflineStore(rel+'/store'),checks=new CheckRunner(readJSON(resolve(ROOT,'config/workflow/checks.json'))),scheduler=new Scheduler(store,checks);
 const task=(id='sample',extra={})=>({...fixture('task.json'),task_id:id,workspace:rel+'/workspace',...extra});
 return {dir,workspace,store,checks,scheduler,task,close(){store.close();const stateRoot=resolve(ROOT,'state');if(!inside(stateRoot,dir)||dir===stateRoot||!dir.startsWith(stateRoot))throw Error('Unsafe test cleanup');rmSync(dir,{recursive:true,force:true});}};
}
