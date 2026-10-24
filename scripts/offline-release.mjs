#!/usr/bin/env node
/** Freeze an already installed, reviewed production dependency tree. No install/download. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parseArgs,promisify} from 'node:util';
import {createRequire} from 'node:module';
import {execFile,spawn} from 'node:child_process';
const exec=promisify(execFile),sha=data=>createHash('sha256').update(data).digest('hex');
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
async function files(root,directory=root){
 const out=[];for(const name of (await fs.readdir(directory)).sort()){
  const file=path.join(directory,name),relative=path.relative(root,file).split(path.sep).join('/');if(directory===root&&['manifest.json','manifest.sha256'].includes(name))continue;
  const stat=await fs.lstat(file);
  if(stat.isSymbolicLink()){const target=await fs.realpath(file);if(!inside(root,target))throw Error('Release contains an external symbolic link: '+relative);out.push({path:relative,link:await fs.readlink(file)});}
  else if(stat.isDirectory())out.push(...await files(root,file));
  else if(stat.isFile())out.push({path:relative,bytes:stat.size,sha256:sha(await fs.readFile(file))});else throw Error('Unsupported release file: '+relative);
 }return out;
}
const platform=()=>({platform:process.platform,arch:process.arch,nodeMajor:Number(process.versions.node.split('.')[0]),nodeAbi:process.versions.modules,libc:process.report.getReport().header.glibcVersionRuntime??null});
async function smoke(directory){
 const privateData=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-offline-smoke-'));let child,exited,client;
 try{
  const app=path.join(directory,'app');const env={PATH:process.env.PATH??'',...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}),MEMORY_DB_PATH:path.join(privateData,'synthetic.db'),MEMORY_HOST:'127.0.0.1',MEMORY_PORT:'0',MEMORY_API_KEY:'',MEMORY_OPERATOR_KEY:'',MEMORY_CONTEXT_SECRET:'',MINDPOND_MCP_ACCOUNTS:'',MINDPOND_EMBEDDING_MODE:'text',EMBEDDING_ZH_ENABLED:'false',EMBEDDING_MODEL_DIR:path.join(privateData,'no-models')};
  child=spawn(process.execPath,[path.join(app,'dist/server.js')],{cwd:app,env,stdio:['ignore','pipe','pipe']});let output='';
  let spawnError;exited=new Promise(r=>{child.once('exit',r);child.once('error',error=>{spawnError=error;r();});});for(const stream of [child.stdout,child.stderr])stream.on('data',v=>{output=(output+v).slice(-128000);});
  const deadline=Date.now()+30000;while(!/listening on .*:(\d+)/.test(output)&&child.exitCode===null&&!spawnError&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
  const port=/listening on .*:(\d+)/.exec(output)?.[1];if(!port)throw Error('Offline runtime failed to start; validate Node/SQLite platform compatibility. '+output);
  const health=await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(5000)});if(!health.ok)throw Error('Offline health check failed');
  const ready=await fetch('http://127.0.0.1:'+port+'/ready',{signal:AbortSignal.timeout(10000)});if(!ready.ok)throw Error('Offline database readiness failed');
  const require=createRequire(path.join(app,'package.json')),{Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
  client=new Client({name:'offline-smoke',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(app,'dist/mcp.js')],cwd:app,env,stderr:'pipe'}));
  const tools=await client.listTools();if(!tools.tools.some(t=>t.name==='memory_identity'))throw Error('Offline Memory MCP discovery failed');
  const identity=await client.callTool({name:'memory_identity',arguments:{},_meta:{threadId:'synthetic-offline-chat'}},undefined,{timeout:10000});if(identity.isError)throw Error('Offline Memory MCP identity failed');
  return {passed:true,scope:'Isolated text-mode HTTP, SQLite and Memory MCP discovery/identity; no external network/model/harness/production data tested.'};
 }finally{
  await client?.close().catch(()=>{});
  if(child?.exitCode===null){child.kill('SIGTERM');let timer;await Promise.race([exited,new Promise(r=>{timer=setTimeout(()=>{child.kill('SIGKILL');r();},8000);})]);clearTimeout(timer);await exited;}
  await fs.rm(privateData,{recursive:true,force:true});
 }
}
export async function verifyRelease(directory,{runSmoke=false}={}){
 const root=await fs.realpath(directory),manifestText=await fs.readFile(path.join(root,'manifest.json'),'utf8');
 const expected=(await fs.readFile(path.join(root,'manifest.sha256'),'utf8')).trim();if(sha(manifestText)!==expected)throw Error('Release manifest digest mismatch');
 const manifest=JSON.parse(manifestText);if(manifest.format!=='mindpond.offline-release.v1')throw Error('Unknown release format');
 if(JSON.stringify(manifest.platform)!==JSON.stringify(platform()))throw Error('This runtime was prepared for a different OS/architecture/Node ABI/libc. Prepare on the target platform.');
 const actual=await files(root);if(JSON.stringify(actual)!==JSON.stringify(manifest.files))throw Error('Release contents differ from the manifest; missing, changed or extra files found');
 return {version:manifest.version,manifestSha256:expected,fileCount:actual.length,bytes:actual.reduce((n,f)=>n+(f.bytes??0),0),platform:manifest.platform,...(runSmoke?{smoke:await smoke(root)}:{smoke:{passed:null,reason:'Not requested'}})};
}
async function build(output){
 const source=await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')),destination=path.resolve(output);
 if(!path.isAbsolute(output)||inside(source,destination))throw Error('Choose a new absolute output directory outside the source checkout');
 const parent=await fs.realpath(path.dirname(destination));if(inside(source,parent))throw Error('Output parent must be outside the checkout');
 const pkg=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8')),lock=JSON.parse(await fs.readFile(path.join(source,'npm-shrinkwrap.json'),'utf8'));
 if(pkg.version!==lock.version)throw Error('Package and lock version differ');
 // Never include a source DB/config, the entire checkout or the entire development tree.
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-offline-build-'));let created=false;
 try{
  const packed=JSON.parse((await exec('npm',['pack','--json','--pack-destination',temp],{cwd:source,maxBuffer:4000000})).stdout)[0];
  await fs.mkdir(destination,{mode:0o700});created=true;const app=path.join(destination,'app');await fs.mkdir(app,{mode:0o700});
  await exec('tar',['-xzf',path.join(temp,packed.filename),'--strip-components=1','-C',app]);
  for(const [relative,entry] of Object.entries(lock.packages??{})){
   if(!relative||entry.dev||entry.peer)continue;
   if(!relative.startsWith('node_modules/')||relative.split('/').includes('..'))throw Error('Unsupported dependency location');
   const installed=path.join(source,relative);let metadata;
   try{if(!(await fs.lstat(installed)).isDirectory())throw Error('Dependency must be a real directory');metadata=JSON.parse(await fs.readFile(path.join(installed,'package.json'),'utf8'));}catch(error){if(entry.optional&&error.code==='ENOENT')continue;throw Error('Required production dependency unavailable: '+relative);}
   if(metadata.version!==entry.version)throw Error('Installed dependency does not match shrinkwrap: '+relative);
   const target=path.join(app,relative);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
   await fs.cp(installed,target,{recursive:true,verbatimSymlinks:true,filter:file=>!path.relative(installed,file).split(path.sep).includes('node_modules')});
  }
  await fs.copyFile(fileURLToPath(import.meta.url),path.join(destination,'verify.mjs'));
  await fs.writeFile(path.join(destination,'README.txt'),'MindPond '+pkg.version+'\nRun: node app/dist/server.js\nVerify: node verify.mjs verify --directory . --smoke\nSet a private MEMORY_DB_PATH and authentication before deployment. Node.js is not bundled. This platform-specific tree contains no user data, models or optional inference runtime. Keep upstream license notices. Record manifest.sha256 separately before transfer.\n',{mode:0o600});
  const manifest={format:'mindpond.offline-release.v1',version:pkg.version,createdAt:new Date().toISOString(),platform:platform(),lockSha256:sha(await fs.readFile(path.join(source,'npm-shrinkwrap.json'))),files:await files(destination)};
  const text=JSON.stringify(manifest,null,2)+'\n';await fs.writeFile(path.join(destination,'manifest.json'),text,{mode:0o600});await fs.writeFile(path.join(destination,'manifest.sha256'),sha(text)+'\n',{mode:0o600});
  return await verifyRelease(destination,{runSmoke:true});
 }catch(error){if(created)await fs.rm(destination,{recursive:true,force:true});throw error;}finally{await fs.rm(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {values,positionals}=parseArgs({allowPositionals:true,options:{output:{type:'string'},directory:{type:'string'},smoke:{type:'boolean'}}});
 try{const result=positionals[0]==='build'&&values.output?await build(values.output):positionals[0]==='verify'&&values.directory?await verifyRelease(values.directory,{runSmoke:values.smoke}):null;if(!result)throw Error('Usage: node offline-release.mjs build --output /private/new-directory | verify --directory /private/release [--smoke]');console.log(JSON.stringify(result,null,2));}catch(error){console.error(error.message);process.exitCode=1;}
}
