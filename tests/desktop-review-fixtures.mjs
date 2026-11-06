import {readFileSync} from 'node:fs';
import {sha256} from '../src/core/util.mjs';
import {reviewBinding} from '../src/desktop-inbox/review-evidence.mjs';
import {createLiveToolHandler as rawHandler} from '../src/desktop-inbox/live-mcp-server.mjs';

// Explicit synthetic parent assertions for fixtures, never production acceptance.
export function parentReview(context,notes=['Parent fixture assertions checked source and acceptance']){
 const files=context.actual_changed_files.length?context.actual_changed_files:context.report.inspected_files;
 return {accepted:true,evidence:{...context.review_context,files_inspected:files,
  acceptance_assessment:context.job.acceptance_criteria.map(criterion=>({criterion,met:true,evidence:'Fixture source/content assertions and fresh registered check results'})),
  notes,check_results:context.checks.map(c=>({check_id:c.check_id,passed:c.passed,input_hash:c.input_hash,spec_hash:c.spec_hash}))},notes};
}

export function createReviewedToolHandler(options={}){
 const raw=rawHandler(options);
 return async(name,args={},context={})=>{
  if(name==='verify_job'&&args.accepted===true&&!args.review_evidence){
   const root=args.workspace_root??options.defaultWorkspaceRoot;
   const result=await raw('get_job_result',{...(root?{workspace_root:root}:{}),...(args.task_id?{task_id:args.task_id}:{}),auto_verify:true},context);
   const mechanical=result.auto_verification;
   if(mechanical?.passed){const job=JSON.parse(readFileSync(result.brief_json_path,'utf8')).job;
    const decision=parentReview({job,report:result.worker_report,review_context:mechanical.review_context,actual_changed_files:mechanical.actual_changed_files,checks:mechanical.checks},args.review_notes?.length?args.review_notes:undefined);
    args={...args,review_evidence:decision.evidence};
   }
  }
  return raw(name,args,context);
 };
}

export function reviewedReceipt(job,receipt){
 const checks=receipt.checks.map(c=>({...c,input_hash:c.input_hash??sha256('synthetic fixture input'),spec_hash:c.spec_hash??sha256('synthetic fixture spec')}));
 const context={job,report:{inspected_files:job.read_scope},review_context:reviewBinding(job,receipt),actual_changed_files:receipt.actual_changed_files,checks};
 return {...receipt,checks,review_evidence:parentReview(context,['Synthetic unit-test parent assertion; not live execution evidence']).evidence};
}
