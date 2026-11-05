import {mkdirSync,openSync,closeSync,unlinkSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROOT,scopedPath,readJSON,writeJSON} from './util.mjs';
// One local process with atomic replacement and an exclusive lock; no live ledger access.
export class OfflineStore{
 constructor(directory='state/offline'){
  if(!directory.startsWith('state/'))throw Error('Offline store must be under project state/');
  this.directory=scopedPath(ROOT,directory);mkdirSync(this.directory,{recursive:true});
  this.lock=scopedPath(this.directory,'store.lock');
  this.path=scopedPath(this.directory,'store.json');
  try{this.fd=openSync(this.lock,'wx');}catch(e){throw Error('Offline store locked; do not start another writer: '+e.code);}
  try{
   this.data=existsSync(this.path)?readJSON(this.path):{schema_version:'1.0',submissions:{},tasks:{},events:[]};
   if(this.data.schema_version!=='1.0')throw Error('Unknown store version');
  }catch(e){this.close();throw e;}
 }
 commit(data){writeJSON(this.path,data);this.data=data;}
 close(){if(this.fd!==undefined){closeSync(this.fd);this.fd=undefined;unlinkSync(this.lock);}}
}
