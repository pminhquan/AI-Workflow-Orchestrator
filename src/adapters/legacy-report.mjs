import {requireValid} from '../core/schema.mjs';
import {safeRelative} from '../core/util.mjs';
// Offline compatibility only. Never accept/copy worker credentials or a live task body.
export function translateLegacyReport(report,{task_id,attempt}){
 const keys=new Set(['status','summary','changed_files','tests','risks']);
 if(!report||typeof report!=='object'||Object.keys(report).some(k=>!keys.has(k)))throw Error('Unsupported legacy report fields; private credentials/task state must not be imported');
 if(!['review','blocked','failed'].includes(report.status)||typeof report.summary!=='string'||!report.summary.trim())throw Error('Invalid legacy report');
 for(const key of ['changed_files','tests','risks'])if(!Array.isArray(report[key])||report[key].some(x=>typeof x!=='string'||!x.length))throw Error('Invalid legacy report array');
 report.changed_files.forEach(safeRelative);
 return requireValid({schema_version:'1.0',task_id,attempt,status:report.status,summary:report.summary,changed_files:report.changed_files,artifacts:[],tests:report.tests.map(command=>({command,outcome:'not-run'})),evidence_refs:[],known_limitations:['Legacy worker claims imported offline; test outcomes and subagent usage are unverified until host verification.'],risks:report.risks,blockers:report.status==='blocked'?['Imported legacy blocker requires host review.']:[],subagent_usage:null},'worker-report');
}
