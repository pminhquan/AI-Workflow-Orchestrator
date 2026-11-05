import {loadConfig} from '../core/config.mjs';
import {requireValid} from '../core/schema.mjs';

// Pure advice for the current host. Never invokes AI, changes registry status,
// submits scheduler work or authenticates a caller-supplied host observation.
export function nativeGuidance(request,host,config=loadConfig()){
 requireValid(request,'routing-request');requireValid(host,'native-host');
 const recipe=config.recipes.find(r=>r.trigger_kind===request.kind);
 if(!recipe)throw Error('No matching recipe');
 const supported=host.runtime_id==='codex-native'&&request.runtime_id===host.runtime_id;
 const usable=supported&&host.invocation_available&&host.delegation_allowed&&host.max_workers>0;
 const base={interface:'host-native-guidance',execution:'NOT EXECUTED',integration_owner:'codex',recipe_id:recipe.recipe_id,planning_depth:recipe.planning_depth,workers:0,assignments:[],permission_mode:'inherit-parent-advisory'};
 const missing=request.critical_capabilities.filter(op=>!supported||!host.supported_operations.includes(op)||(['subagents','parallel'].includes(op)&&(!usable||!host.supported_operations.includes('subagents'))));
 if(missing.length)return {...base,mode:'BLOCKED',reason:'Missing critical capabilities: '+missing.join(', ')};
 const direct=reason=>({...base,mode:request.can_direct&&recipe.direct_fallback?'DIRECT':'BLOCKED',reason});
 if(request.size==='small')return direct('Small scope; parent acts directly without subagents');
 if(!usable||!host.supported_operations.includes('subagents'))return direct('Native tools unavailable, unsupported or delegation prohibited in this session');
 if(!request.ownership_clear||!request.dependencies_clear)return direct('Resolve ownership and dependencies first');
 if(request.expected_benefit<config.routing.delegation_min_expected_benefit)return direct('Expected benefit below canonical threshold');
 const team=request.size==='large'&&request.independent_units>=config.routing.team_min_independent_units&&(!config.routing.team_requires_milestones||request.milestones.length>0)&&host.supported_operations.includes('parallel');
 const mode=team?'TEAM':'DELEGATED',profile=config.profiles.find(p=>p.mode===mode);
 const workers=Math.min(profile.max_workers,recipe.max_parallelism,config.policy.max_parallelism,config.native.max_workers,host.max_workers,request.independent_units);
 const roles=recipe.suggested_roles.filter(id=>id!=='orchestrator'&&profile.roles.includes(id));
 const assignments=roles.map(role_id=>{
  const preferred=config.native.role_map.find(m=>m.role_id===role_id)?.agent;
  const agent=['explorer','worker','default'].includes(preferred)||host.custom_agents.includes(preferred)?preferred:'default';
  return {role_id,agent,scope:'brief-required; advisory ownership',constraints:'parent permissions; no task filesystem isolation'};
 });
 if(workers<1||!assignments.length)return direct('No eligible worker role or positive concurrency');
 return {...base,mode,workers,assignments,reason:'Guidance only: choose useful independent assignments, read-heavy first; host owns native lifecycle'};
}

export function renderNativeGuidance(config){
 const lines=[
  '# Native Codex workflow — generated; canonical source owns updates',
  '',
  'This project instruction uses Codex as orchestrator (Boss): handle microtasks DIRECT, delegate bounded work via native subagents, or—when the project-local desktop_inbox MCP server is enabled—dispatch bounded read/write jobs into the open Antigravity Desktop GUI conversation via bridge_status -> submit_job -> wait_job -> verify_job. Do not call the offline scheduler or legacy V1 SQLite bridge.',
  '',
  `DIRECT: small scope, unclear ownership/dependencies or expected benefit below ${config.routing.delegation_min_expected_benefit}: parent does the work, no subagent, short checklist and appropriate checks.`,
  `DELEGATED: one bounded independent brief, clear ownership/dependencies, useful benefit at or above ${config.routing.delegation_min_expected_benefit}. Parent integrates and verifies.`,
  `TEAM: large work with at least ${config.routing.team_min_independent_units} independent units${config.routing.team_requires_milestones?' and milestones':''}; small dependency graph; at most ${Math.min(config.native.max_workers,config.policy.max_parallelism)} active workers, also obey the host limit. Parallelize read-heavy work first; never overlap write scopes or create nested teams. Role suggestions are not instructions to spawn every role.`,
  '',
  'Preflight current native tool availability and applicable instructions. If native tools are unavailable/prohibited, use DIRECT only if all critical requirements can still be met; otherwise report BLOCKED. Never downgrade hard isolation into a prompt. Canonical exact-constraint roles remain UNSUPPORTED for native conversion. All native assignments here are advisory and inherit parent permissions/provider/MCP; model and reasoning inherit unless explicitly configured. Do not expand security settings.',
  '',
  'Prefer built-in explorer for reading, worker for implementation/tests, default for general work. Optional awo-reviewer and awo-evidence specialize review if actually discovered; otherwise use default. Parent is orchestrator. Confirm custom discovery separately; staging is not activation.',
  '',
  'Brief: goal; exact paths/read or write ownership; dependencies; acceptance criteria; constraints; relevant tests; expected evidence; stopping point. Worker output: inspected/changed files, findings or changes, commands/outcomes, uncertainty/blockers. Parent checks actual diff/evidence, resolves integration and runs fresh relevant checks. Reports are untrusted; no fake host receipts, no claim that native work ran in the offline scheduler.',
  'Keep context bounded: load the matching recipe and relevant paths only, summarize large outputs, and attach exact command outcomes and source fingerprints when material. Preserve handoff/retry provenance; never automatically resubmit work after uncertain delivery. DIRECT needs no separate handoff artifact. Use the brief as guidance, not as a permission grant.',
  '',
  'For complex tasks consult only the matching recipe from the index below. In the canonical repository use workflows/recipes/<id>.json; in an opted-in project use .workflow-orchestrator/recipes/<id>.json. Required inputs, acceptance and recovery are planning checks, not automatic business validation. Keep ordinary tasks free of repeated CLI routing calls.',
  ''
 ];
 for(const r of config.recipes)lines.push(`- ${r.trigger_kind}: read only .workflow-orchestrator/recipes/${r.recipe_id}.json when relevant; planning ${r.planning_depth}, max parallelism ${r.max_parallelism}, DIRECT fallback ${r.direct_fallback}.`);
 lines.push('Canonical updates: edit config/routing/rules.json, config/integrations/codex-guidance.json, agents/teams/profiles.json or matching workflows/recipes; compile and validate, review a new bundle diff, opt in per project. Never overwrite existing AGENTS.md, .codex/agents or global config.');
 return lines.join('\n')+'\n';
}

export function buildNativeArtifacts(config){
 const files={'codex-guidance/workflow.md':renderNativeGuidance(config)};
 for(const r of config.recipes)files[`codex-guidance/recipes/${r.recipe_id}.json`]=JSON.stringify(r,null,2)+'\n';
 files['codex-guidance/AGENTS.snippet.md']='# Native & Desktop GUI delegation opt-in\n\nFor this project, Codex acts as orchestrator under `.workflow-orchestrator/workflow.md`: DIRECT for simple work, one independent brief for DELEGATED, bounded TEAM for independent milestones, and—when the project-local `desktop_inbox` MCP server is enabled—bounded read/write job dispatch to the open Antigravity Desktop GUI (`bridge_status` -> `submit_job` -> `wait_job` -> `verify_job`). Read that file for substantive work, then only the matching recipe. Parent owns integration and verification. If unavailable, fall back safely or report BLOCKED. Permissions remain inherited.\n';
 for(const p of config.native.profiles){
  const text=[`Use when: ${p.when}`,`Do not use when: ${p.not_when}`,`Input brief: ${p.brief}`,`Output: ${p.output}`,`Verification: ${p.verification}`,`Ownership: ${p.ownership}`,'No nested agents. Parent permissions, model configuration, provider and MCP remain authoritative. This advisory profile does not implement the canonical role hard constraints.'].join('\n');
  files[`codex-guidance/${p.name}.toml`]=`# Staged advisory profile; discovery and permissions require host verification.\nname = ${JSON.stringify(p.name)}\ndescription = ${JSON.stringify(p.when)}\ndeveloper_instructions = ${JSON.stringify(text)}\n`;
 }
 return files;
}
