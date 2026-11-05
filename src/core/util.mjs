import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,renameSync,realpathSync,lstatSync,existsSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname,sep} from 'node:path';
export const ROOT=resolve(import.meta.dirname,'../..');
export const readJSON=p=>JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/,''));
export const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
export const sha256=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:canonical(v)).digest('hex');
export function writeJSON(p,v){mkdirSync(dirname(p),{recursive:true});const temp=p+'.tmp';writeFileSync(temp,JSON.stringify(v,null,2)+'\n',{flag:'wx'});renameSync(temp,p);}
export function safeRelative(p){
 if(typeof p!=='string'||!p.length||isAbsolute(p)||/[:\\\x00-\x1f]/.test(p)||p.split('/').some(x=>!x||x==='.'||x==='..'||/[. ]$/.test(x)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(x)))throw Error('Unsafe relative path: '+p);
 return p;
}
export function inside(root,p){const r=relative(root,p);return r===''||(!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r));}
// Check every existing ancestor, including junctions; lexical containment alone is insufficient.
export function scopedPath(root,p){
 safeRelative(p);root=realpathSync(root);const target=resolve(root,p);
 if(!inside(root,target))throw Error('Path outside workspace');
 let cursor=root;
 for(const part of p.split('/')){cursor=resolve(cursor,part);if(existsSync(cursor)){if(lstatSync(cursor).isSymbolicLink()||!inside(root,realpathSync(cursor)))throw Error('Links/junctions not supported in scoped paths');}}
 return target;
}
export function overlaps(a,b){a=a.toLowerCase().replace(/\/$/,'');b=b.toLowerCase().replace(/\/$/,'');return a===b||a.startsWith(b+'/')||b.startsWith(a+'/');}
export const inScope=(p,scope)=>scope.some(s=>p.toLowerCase()===s.toLowerCase()||p.toLowerCase().startsWith(s.toLowerCase()+'/'));
