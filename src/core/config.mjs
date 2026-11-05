import {readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT,readJSON} from './util.mjs';
import {requireValid} from './schema.mjs';
const files=dir=>readdirSync(resolve(ROOT,dir)).filter(n=>n.endsWith('.json')).sort().map(n=>readJSON(resolve(ROOT,dir,n)));
export function loadConfig(){
 const roles=files('agents/roles').map(x=>requireValid(x,'role'));
 const recipes=files('workflows/recipes').map(x=>requireValid(x,'recipe'));
 const capabilities=requireValid(readJSON(resolve(ROOT,'config/integrations/capabilities.json')),'capabilities').runtimes;
 const profiles=requireValid(readJSON(resolve(ROOT,'agents/teams/profiles.json')),'teams').profiles;
 for(const [items,key] of [[roles,'role_id'],[recipes,'recipe_id'],[capabilities,'runtime_id'],[profiles,'mode']])if(new Set(items.map(x=>x[key])).size!==items.length)throw Error('Duplicate '+key);
 for(const recipe of recipes)for(const id of recipe.suggested_roles)if(!roles.some(r=>r.role_id===id))throw Error('Unknown recipe role '+id);
 for(const profile of profiles)for(const id of profile.roles)if(!roles.some(r=>r.role_id===id))throw Error('Unknown team role '+id);
 for(const runtime of capabilities)if(runtime.enabled&&(!['mock','replay'].includes(runtime.runtime_id)||!runtime.verified||runtime.policy_status!=='allowed-offline'))throw Error('Only verified offline runtimes may be enabled in the foundation');
 const policy=requireValid(readJSON(resolve(ROOT,'config/workflow/policy.json')),'policy');
 const routing=requireValid(readJSON(resolve(ROOT,'config/routing/rules.json')),'routing-rules');
 requireValid(readJSON(resolve(ROOT,'config/deployment/compiler.json')),'compiler-config');
 const components=requireValid(readJSON(resolve(ROOT,'config/deployment/components.json')),'components').components;
 if(new Set(components.map(x=>x.logical_component)).size!==components.length)throw Error('Duplicate component');
 return {roles,recipes,capabilities,profiles,policy,routing};
}
