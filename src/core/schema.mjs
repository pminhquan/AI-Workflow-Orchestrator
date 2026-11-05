import {readJSON,ROOT} from './util.mjs';
import {resolve} from 'node:path';
// Deliberate JSON Schema 2020-12 subset. Unsupported keywords fail closed.
const keywords=new Set(['$schema','$id','title','description','type','const','enum','properties','required','additionalProperties','items','minItems','maxItems','uniqueItems','minLength','pattern','minimum','maximum']);
function assertSchema(s){
 for(const k of Object.keys(s))if(!keywords.has(k))throw Error('Unsupported schema keyword: '+k);
 for(const child of Object.values(s.properties??{}))assertSchema(child);
 if(s.items)assertSchema(s.items);
}
export function validate(value,schema){
 assertSchema(schema);const errors=[];
 function visit(v,s,p){
  const type=v===null?'null':Array.isArray(v)?'array':typeof v;
  if(s.type){const ts=Array.isArray(s.type)?s.type:[s.type];if(!ts.some(t=>t===type||(t==='integer'&&Number.isInteger(v)))){errors.push(p+': expected '+ts.join('|'));return;}}
  if('const' in s&&v!==s.const)errors.push(p+': invalid constant');
  if(s.enum&&!s.enum.includes(v))errors.push(p+': invalid enum');
  if(type==='string'){
   if(s.minLength!==undefined&&v.length<s.minLength)errors.push(p+': too short');
   if(s.pattern&&!new RegExp(s.pattern).test(v))errors.push(p+': invalid pattern');
  }
  if(type==='number'){
   if(!Number.isFinite(v))errors.push(p+': nonfinite number');
   if(s.minimum!==undefined&&v<s.minimum)errors.push(p+': below minimum');
   if(s.maximum!==undefined&&v>s.maximum)errors.push(p+': above maximum');
  }
  if(type==='array'){
   if(s.minItems!==undefined&&v.length<s.minItems)errors.push(p+': too few items');
   if(s.maxItems!==undefined&&v.length>s.maxItems)errors.push(p+': too many items');
   if(s.uniqueItems&&new Set(v.map(x=>JSON.stringify(x))).size!==v.length)errors.push(p+': duplicate items');
   if(s.items)v.forEach((x,i)=>visit(x,s.items,p+'['+i+']'));
  }
  if(type==='object'){
   for(const k of s.required??[])if(!Object.hasOwn(v,k))errors.push(p+'.'+k+': required');
   for(const [k,x] of Object.entries(v)){
    if(Object.hasOwn(s.properties??{},k))visit(x,s.properties[k],p+'.'+k);
    else if(s.additionalProperties===false)errors.push(p+'.'+k+': unknown property');
   }
  }
 }
 visit(value,schema,'$');return {valid:errors.length===0,errors};
}
export function schema(name){return readJSON(resolve(ROOT,'workflows/schemas',name+'.schema.json'));}
export function requireValid(value,name){const r=validate(value,schema(name));if(!r.valid)throw Error(name+': '+r.errors.join('; '));return value;}
