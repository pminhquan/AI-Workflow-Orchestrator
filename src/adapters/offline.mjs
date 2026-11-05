import {readJSON,ROOT,sha256} from '../core/util.mjs';
import {resolve} from 'node:path';
export class MockAdapter{
 constructor({delay_ms=0,reports={},failures={},available=true}={}){this.runtime_id='mock';this.delay_ms=delay_ms;this.reports=structuredClone(reports);this.failures=structuredClone(failures);this.available=available;this.calls=0;}
 async execute(task,attempt,signal){
  this.calls++;
  await new Promise((ok,no)=>{
   if(signal.aborted){no(Error('Canceled'));return;}
   const onAbort=()=>{clearTimeout(timer);no(Error('Canceled'));};
   const timer=setTimeout(()=>{signal.removeEventListener('abort',onAbort);ok();},this.delay_ms);
   signal.addEventListener('abort',onAbort,{once:true});
  });
  if(signal.aborted)throw Error('Canceled');
  if((this.failures[task.task_id]??0)>=attempt)throw Error('Synthetic worker failure');
  const base=this.reports[task.task_id]??readJSON(resolve(ROOT,'tests/fixtures/reports/successful.json'));
  return {...structuredClone(base),task_id:task.task_id,attempt};
 }
}
export class ReplayAdapter extends MockAdapter{
 constructor(reports){super({reports});this.runtime_id='replay';}
}
