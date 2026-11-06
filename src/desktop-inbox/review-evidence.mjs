import {existsSync,lstatSync} from 'node:fs';
import {sha256,inScope} from '../core/util.mjs';
import {boundedJSON,noKnownSecrets,sameWorkspace,validateScopePath} from './contracts.mjs';

// A fingerprint binds a parent's assertion to bytes, not proof that an AI read them.
export function reviewBinding(job,{report_sha256,baseline_sha256,after_sha256,actual_changed_files}){
 return {task_id:job.task_id,attempt_id:job.attempt_id,workspace_root:job.workspace_root,report_sha256,
  diff_fingerprint:sha256({job_sha256:sha256(job),report_sha256,baseline_sha256,after_sha256,actual_changed_files:[...actual_changed_files].sort()})};
}

export function validateParentReview(evidence,{job,report_sha256,baseline_sha256,after_sha256,actual_changed_files,checks}){
 if(!evidence||Array.isArray(evidence)||typeof evidence!=='object')throw Error('PARENT_REVIEW_REQUIRED: explicit review evidence is required');
 boundedJSON(evidence,32768,'Parent review evidence');noKnownSecrets(evidence);
 const expected=reviewBinding(job,{report_sha256,baseline_sha256,after_sha256,actual_changed_files});
 const keys=[...Object.keys(expected),'files_inspected','acceptance_assessment','notes','check_results'];
 if(Object.keys(evidence).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(evidence,key)))throw Error('PARENT_REVIEW_REQUIRED: missing or unexpected review evidence');
 for(const key of ['task_id','attempt_id','report_sha256','diff_fingerprint'])if(evidence[key]!==expected[key])throw Error('PARENT_REVIEW_MISMATCH: '+key);
 if(!sameWorkspace(evidence.workspace_root,expected.workspace_root))throw Error('PARENT_REVIEW_MISMATCH: workspace_root');
 if(!Array.isArray(evidence.files_inspected)||!evidence.files_inspected.length||evidence.files_inspected.length>128||new Set(evidence.files_inspected).size!==evidence.files_inspected.length)throw Error('Parent review requires inspected files');
 for(const path of evidence.files_inspected){
  const full=validateScopePath(job.workspace_root,path);
  if(!inScope(path,[...job.read_scope,...job.write_scope])||existsSync(full)&&!lstatSync(full).isFile()||!existsSync(full)&&!actual_changed_files.includes(path))throw Error('Invalid parent inspected file: '+path);
 }
 if(actual_changed_files.some(path=>!evidence.files_inspected.includes(path)))throw Error('Parent review must cover every changed file');
 if(!Array.isArray(evidence.acceptance_assessment)||evidence.acceptance_assessment.length!==job.acceptance_criteria.length||evidence.acceptance_assessment.some((item,i)=>!item||item.criterion!==job.acceptance_criteria[i]||item.met!==true||typeof item.evidence!=='string'||!item.evidence.trim()))throw Error('Parent review must assess every acceptance criterion with evidence');
 if(!Array.isArray(evidence.notes)||!evidence.notes.length||evidence.notes.length>16||evidence.notes.some(note=>typeof note!=='string'||!note.trim()))throw Error('Parent review requires notes');
 if(!Array.isArray(evidence.check_results)||evidence.check_results.length!==checks.length||new Set(evidence.check_results.map(c=>c?.check_id)).size!==checks.length)throw Error('Parent review requires matching check results');
 for(const result of evidence.check_results){const check=checks.find(c=>c.check_id===result?.check_id);if(!check||result.passed!==true||check.passed!==true||check.exit_code!==0||check.reused===true||! /^[a-f0-9]{64}$/.test(result.input_hash??'')||! /^[a-f0-9]{64}$/.test(result.spec_hash??'')||result.input_hash!==check.input_hash||result.spec_hash!==check.spec_hash)throw Error('Parent review check evidence mismatch');}
 return structuredClone(evidence);
}
