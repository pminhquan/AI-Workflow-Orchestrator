import {existsSync,lstatSync,readdirSync} from 'node:fs';
import {scopedPath} from '../core/util.mjs';
import {canonicalWorkspace,isSensitivePath} from './contracts.mjs';

// Detection supplies reviewable advice only. No package scripts, wrappers,
// plugins, build files or language tools are executed or trusted by detection.
export function suggestProjectChecks(workspaceRoot){
 const workspace=canonicalWorkspace(workspaceRoot);
 const has=name=>{try{return existsSync(scopedPath(workspace,name))&&lstatSync(scopedPath(workspace,name)).isFile();}catch{return false;}};
 const samples={python:[],node:[],dotnet:[]};
 let visited=0;
 function scan(directory='',depth=0){
  if(depth>2||visited>300)return;
  const absolute=directory?scopedPath(workspace,directory):workspace;
  for(const name of readdirSync(absolute).sort()){
   if(++visited>300)return;
   const relative=directory?directory+'/'+name:name;
   if(isSensitivePath(relative)||['node_modules','state','dist','build','target','coverage'].includes(name.toLowerCase()))continue;
   let stat;try{stat=lstatSync(scopedPath(workspace,relative));}catch{continue;}
   if(stat.isDirectory()&&(depth===0?['src','tests','test'].includes(name):true))scan(relative,depth+1);
   else if(stat.isFile()){
    if(/\.py$/.test(name)&&samples.python.length<3)samples.python.push(relative);
    if(/\.[cm]?[jt]sx?$/.test(name)&&samples.node.length<3)samples.node.push(relative);
    if(/\.(?:slnx?|csproj|fsproj|vbproj)$/.test(name)&&samples.dotnet.length<3)samples.dotnet.push(relative);
   }
  }
 }
 scan();
 const suggestions=[];
 const add=(framework,evidence,command)=>suggestions.push({framework,evidence,command,execution:'NOT_RUN',requires_review:true});
 if(samples.python.length||has('pyproject.toml')||has('pytest.ini')||has('requirements.txt')||has('setup.py'))add('Python',[...['pyproject.toml','pytest.ini','requirements.txt','setup.py'].filter(has),...samples.python],['python','-m','pytest']);
 if(has('package.json'))add('Node.js / TypeScript',['package.json',...(has('tsconfig.json')?['tsconfig.json']:[])],['npm','test']);
 if(!has('package.json')&&samples.node.length)add('Node.js / TypeScript',samples.node,['node','--test']);
 if(has('pom.xml'))add('Java / Maven',['pom.xml'],['mvn','test']);
 if(has('build.gradle')||has('build.gradle.kts'))add('Java / Gradle',['build.gradle','build.gradle.kts'].filter(has),['gradle','test']);
 const dotnet=samples.dotnet;
 if(dotnet.length)add('.NET',dotnet,['dotnet','test']);
 return {frameworks:suggestions.length?suggestions.map(item=>item.framework):['Other / unknown'],suggested_checks:suggestions,functional_tests:'NOT_RUN',automatic_execution:false};
}
