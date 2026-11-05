import {requireValid} from './schema.mjs';
import {loadConfig} from './config.mjs';
export function available(runtime){return !!runtime&&runtime.enabled&&runtime.verified&&runtime.availability==='available'&&runtime.policy_status==='allowed-offline'&&runtime.concurrency>0;}
export function route(request,config=loadConfig()){
 requireValid(request,'routing-request');
 const recipe=config.recipes.find(x=>x.trigger_kind===request.kind);
 if(!recipe)throw Error('No matching recipe');
 const runtime=config.capabilities.find(x=>x.runtime_id===request.runtime_id);
 const missing=request.critical_capabilities.filter(x=>!available(runtime)||!runtime.supported_operations.includes(x));
 const base={interface:'offline-routing-recommendation',execution:'NOT EXECUTED',recipe_id:recipe.recipe_id,planning_depth:recipe.planning_depth,integration_owner:'codex',roles:[],workers:0,runtime_id:null};
 if(missing.length)return {...base,mode:'BLOCKED',reason:'Missing critical capabilities: '+missing.join(', ')};
 function direct(reason){return request.can_direct&&recipe.direct_fallback?{...base,mode:'DIRECT',roles:['orchestrator'],reason}:{...base,mode:'BLOCKED',reason:'DIRECT fallback prohibited: '+reason};}
 if(request.size==='small')return direct('Small scope; delegation overhead is unlikely to pay off');
 if(!available(runtime)||!runtime.supported_operations.includes('execute'))return direct('Worker unavailable, disabled, unsupported or unverified');
 if(!request.ownership_clear||!request.dependencies_clear)return direct('Ownership or dependencies need resolution before delegation');
 if(request.expected_benefit<config.routing.delegation_min_expected_benefit)return direct('Expected delegation benefit below threshold');
 const team=request.size==='large'&&request.independent_units>=config.routing.team_min_independent_units&&(!config.routing.team_requires_milestones||request.milestones.length>0)&&runtime.supported_operations.includes('parallel');
 const mode=team?'TEAM':'DELEGATED';
 const profile=config.profiles.find(x=>x.mode===mode);
 if(!recipe.suggested_roles.some(x=>x!=='orchestrator'&&profile.roles.includes(x)))return direct('No eligible role in selected team profile');
 return {...base,mode,roles:['orchestrator',...recipe.suggested_roles.filter(x=>x!=='orchestrator'&&profile.roles.includes(x))],workers:Math.min(profile.max_workers,recipe.max_parallelism,runtime.concurrency,request.independent_units,config.policy.max_parallelism),runtime_id:runtime.runtime_id,reason:team?'Independent milestones with bounded parallelism':'One bounded worker with Codex integration'};
}
