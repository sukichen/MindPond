/** Real files and HTTP processes; fictional data, no production paths/models. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {request} from 'node:http';
import {GraphMemory} from '../src/core/graph-memory.js';
import {reservePrivateBackup} from '../src/core/sqlite-files.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createNetworkMcpApp} from '../src/integrations/network-server.js';
import {issueNetworkGrant,readNetworkConfiguration} from '../src/integrations/network-config.js';
import {checkNetworkCredential} from '../src/integrations/network-auth-check.js';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-production-boundaries-'));
const oldMode=process.env.MINDPOND_EMBEDDING_MODE,oldRoot=process.env.MINDPOND_LOCAL_INFERENCE_ROOT,oldMask=process.umask(0o022);
const children:ChildProcess[]=[],graphs:GraphMemory[]=[];
process.env.MINDPOND_EMBEDDING_MODE='text';process.env.MINDPOND_LOCAL_INFERENCE_ROOT=path.join(dir,'no-runtime');
async function start(name:string,extra:Record<string,string>={},command=['dist/server.js']){
  const child=spawn(process.execPath,command,{env:{...process.env,MEMORY_DB_PATH:path.join(dir,name+'.db'),MEMORY_HOST:'127.0.0.1',MEMORY_PORT:'0',MEMORY_API_KEY:'',MEMORY_OPERATOR_KEY:'',MEMORY_CONTEXT_SECRET:'',MEMORY_TRUST_PROXY:'',MEMORY_ALLOW_UNAUTHENTICATED_NETWORK:'',MEMORY_CORS_ORIGINS:'',MINDPOND_EMBEDDING_CONFIG:'',EMBEDDING_ZH_ENABLED:'false',...extra},stdio:['ignore','pipe','pipe']});children.push(child);
  return await new Promise<string>((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Fixture startup timeout')),15000);child.once('exit',()=>{clearTimeout(timer);reject(Error('Fixture stopped before listening'));});const observe=(chunk:Buffer)=>{output=(output+chunk).slice(-16000);const found=output.match(/listening on (?:https?:\/\/)?127.0.0.1:(\d+)/);if(found){clearTimeout(timer);resolve('http://127.0.0.1:'+found[1]);}};child.stdout!.on('data',observe);child.stderr!.on('data',observe);});
}
async function stop(child:ChildProcess){
  if(child.exitCode!==null)return;
  await new Promise<void>(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),10000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});
}
// Node fetch rewrites Host. Use the real wire header for rebinding/proxy tests.
async function raw(url:string,headers:Record<string,string>){
  return new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders}>((resolve,reject)=>{
    const req=request(url,{headers},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers}));});req.on('error',reject);req.end();
  });
}
try{
  const file=path.join(dir,'new-directory','fixture.db'),graph=new GraphMemory('.',{dbPath:file});graphs.push(graph);await graph.init();
  await graph.saveMemory('Private fixture knowledge');
  if(process.platform!=='win32'){
    assert.equal((await fs.stat(path.dirname(file))).mode&0o777,0o700);
    for(const suffix of ['','-wal','-shm'])assert.equal((await fs.stat(file+suffix)).mode&0o777,0o600);
    for(const suffix of ['','-wal','-shm'])await fs.chmod(file+suffix,0o666);
    const second=new GraphMemory('.',{dbPath:file});graphs.push(second);await second.init();
    for(const suffix of ['','-wal','-shm'])assert.equal((await fs.stat(file+suffix)).mode&0o777,0o600);
    await second.close();
  }
  const backup=path.join(dir,'private-backup.db');await reservePrivateBackup(backup);await (graph as any).db.run('VACUUM INTO ?',[backup]);
  if(process.platform!=='win32')assert.equal((await fs.stat(backup)).mode&0o777,0o600);
  const snapshot=await fs.readFile(backup);await assert.rejects(reservePrivateBackup(backup),{code:'EEXIST'});assert.deepEqual(await fs.readFile(backup),snapshot);
  console.log('PASS new/existing databases and WAL/SHM are private; backups are private before data and never overwrite an existing snapshot');
  const unassigned=await graph.saveMemory('Unassigned historical knowledge must remain human-owned',{domain:{kind:'personal',id:'agent:namespace-fixture'}});
  await (graph as any).db.run("INSERT INTO character_roles(id,principal,name,introduction,state,revision,created_at) VALUES('namespace-fixture','human','Fictional role','','active',1,0)");
  await assert.rejects(graph.memoryOwners.domain({kind:'agent',id:'namespace-fixture'}),/conflicts with existing unassigned knowledge/);
  assert.equal((await graph.memoryOwners.present((await graph.getNodeById(unassigned.id,{trackAccess:false}))!)).owner.kind,'user');
  console.log('PASS role namespace creation cannot silently adopt unassigned human knowledge');

  const configFile=path.join(dir,'accounts.json'),accountToken=path.join(dir,'account.token'),hostToken=path.join(dir,'host.token');
  await issueNetworkGrant({configFile,tokenFile:accountToken,principal:'fixture-human',personalId:'fixture-personal',toolProfile:'full'});
  await issueNetworkGrant({configFile,tokenFile:hostToken,principal:'fixture-human',agentId:'new-host'});
  await graph.offices.configureAgent({id:'new-host',principal:'fixture-human',name:'Fictional host',host:'codex',state:'active',expectedRevision:0},{v:1,principal:'operator',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER});
  assert.equal((await readNetworkConfiguration(configFile)).version,2);
  assert.equal((await checkNetworkCredential({configFile,tokenFile:accountToken,dbPath:file})).reason,'account_requires_host_registration');
  const allowedHosts=['127.0.0.1'],network=createNetworkMcpApp(graph,{allowedHosts,configuration:()=>readNetworkConfiguration(configFile)}),clients:Client[]=[];
  const listener=network.app.listen(0,'127.0.0.1');await new Promise<void>(r=>listener.once('listening',r));
  const networkUrl='http://127.0.0.1:'+(listener.address() as import('node:net').AddressInfo).port;allowedHosts.push(new URL(networkUrl).host);
  const token=(await fs.readFile(accountToken,'utf8')).trim();
  async function connect(endpoint:string,credential=token){const client=new Client({name:'production-fixture',version:'1'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(networkUrl+endpoint),{requestInit:{headers:{Authorization:'Bearer '+credential}}}));return client;}
  try{
    for(const endpoint of ['/mcp','/memory/mcp'])await assert.rejects(connect(endpoint),(e:any)=>e.code===403,'Account-only credentials require a registered host; never personal-domain tool access');
    const hostCredential=(await fs.readFile(hostToken,'utf8')).trim();
    const accounts=await Promise.all(Array.from({length:10},()=>connect('/mcp',hostCredential)));
    assert(!(await accounts[0].callTool({name:'role_sync',arguments:{}})).isError);
    assert((await accounts[0].listTools()).tools.every(t=>!t.name.startsWith('memory_')));
  }finally{await Promise.all(clients.map(c=>c.close()));await network.close(listener);}
  console.log('PASS account-only credentials denied; registered hosts expose only Office tools and more than eight connections initialize');
  assert.throws(()=>createNetworkMcpApp(graph,{allowedHosts,configuration:()=>readNetworkConfiguration(configFile),maxPerAccount:0}),/connection limits/);
  const cliUrl=await start('mcp',{MINDPOND_MCP_MAX_CONNECTIONS:'3',MINDPOND_MCP_MAX_PER_ACCOUNT:'2'},['dist/mcp-http.js','serve','--config',configFile,'--db',file,'--port','0']);
  const cliClients:Client[]=[],cliTransports:StreamableHTTPClientTransport[]=[];
  async function cliConnect(){const c=new Client({name:'quota-fixture',version:'1'}),t=new StreamableHTTPClientTransport(new URL(cliUrl+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+(await fs.readFile(hostToken,'utf8')).trim()}}});cliClients.push(c);cliTransports.push(t);await c.connect(t);}
  try{await cliConnect();await cliConnect();await assert.rejects(cliConnect(),(error:any)=>error.code===429);await cliTransports[0].terminateSession();await cliConnect();}
  finally{await Promise.all(cliClients.map(c=>c.close()));await stop(children[children.length-1]);}
  console.log('PASS actual MCP CLI uses configured quotas, releases terminated sessions and accepts its advertised ephemeral port');

  const url=await start('local');
  assert.equal((await fetch(url+'/api/memory/list?scope=operator')).status,200);
  assert.equal((await raw(url+'/api/memory/list?scope=operator',{Host:'untrusted.example'})).status,403);
  assert.equal((await raw(url+'/api/memory/list?scope=operator',{Host:'untrusted.example','X-Forwarded-Host':'localhost'})).status,403);
  assert.equal((await fetch(url+'/api/maintenance/run',{method:'POST',headers:{Origin:'https://untrusted.example','Content-Type':'text/plain'}})).status,403);
  assert.equal((await fetch(url+'/api/memory/save',{method:'POST',headers:{Origin:'https://untrusted.example','Content-Type':'application/json'},body:'{malformed'})).status,403,'Reject foreign origin before parsing a body');
  assert.equal((await fetch(url+'/api/memory/list?scope=operator',{headers:{Origin:url}})).status,200);
  const malformed=await fetch(url+'/api/memory/save',{method:'POST',headers:{'Content-Type':'application/json'},body:'{private malformed payload'});assert.equal(malformed.status,400);const malformedText=await malformed.text();assert.equal(JSON.parse(malformedText).code,'invalid_input');assert(!malformedText.includes('private malformed payload'));assert(!malformedText.includes('SyntaxError'));
  const oversized=await fetch(url+'/api/memory/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:'x'.repeat(2*1024*1024)})});assert.equal(oversized.status,413);assert.equal((await oversized.json() as any).code,'invalid_input');
  const proxy=await start('proxy',{MEMORY_API_KEY:'fictional-api',MEMORY_TRUST_PROXY:'loopback',MEMORY_CORS_ORIGINS:'https://allowed.example'});
  const headers={'x-api-key':'fictional-api',Host:'workbench.example','X-Forwarded-Proto':'https',Origin:'https://workbench.example'};
  assert.equal((await raw(proxy+'/api/memory/list?scope=operator',headers)).status,200);
  assert.equal((await raw(proxy+'/api/memory/list?scope=operator',{...headers,Origin:'https://untrusted.example'})).status,403);
  const cors=await raw(proxy+'/api/memory/list?scope=operator',{...headers,Origin:'https://allowed.example'});assert.equal(cors.status,200);assert.equal(cors.headers['access-control-allow-origin'],'https://allowed.example');
  console.log('PASS unauthenticated local Host and cross-origin API boundaries; authenticated same-origin proxy and explicit CORS remain usable');

  const profile={id:'fixture',label:'Fictional profile',model:'fixture/model',dimensions:3};
  const options={dbPath:path.join(dir,'profiles.db'),retrieval:{profiles:[{profile}],defaultProfile:'fixture',buildOnStartup:true},retrievalDependencies:{artifactDigest:async()=> 'fictional-artifact-digest'}};
  const vectors=new GraphMemory('.',options);graphs.push(vectors);await vectors.init();await vectors.saveMemory('Retained text in an unavailable vector profile');
  for(const mode of ['text','auto']){
    process.env.MINDPOND_EMBEDDING_MODE=mode;
    const reason=mode==='text'?'text_mode':'local_runtime_not_installed';
    assert.deepEqual(await (vectors as any).profileRetrieval.startupProfiles(),[]);
    await assert.rejects(vectors.buildRetrievalProfile('fixture'),/disabled or not installed/);
    await assert.rejects(vectors.activateRetrievalProfile('fixture'),/disabled or not installed/);
    await assert.rejects(vectors.search({query:'Retained text',retrievalProfile:'fixture'}),/disabled or not installed/);
    const hits=await vectors.search({query:'Retained text'});assert(hits.length);assert.equal(hits.retrieval?.profile?.selected,'legacy');assert.equal(hits.retrieval?.profile?.fallbackReason,reason);
    assert.equal((await vectors.retrievalProfiles()).profiles.find((p:any)=>p.id==='fixture')?.error,reason);
    assert.equal((vectors as any).profileBuildScheduled.size,0);
  }
  assert.equal((await (vectors as any).db.get("SELECT COUNT(*) n FROM memory_action_log WHERE action='embedding_profile_build'")).n,0);
  console.log('PASS missing/disabled inference cannot activate/build or reschedule active profiles; text recall and explicit fallback reasons survive');
}finally{
  await Promise.all(children.map(stop));for(const graph of graphs)await graph.close();
  process.umask(oldMask);if(oldMode===undefined)delete process.env.MINDPOND_EMBEDDING_MODE;else process.env.MINDPOND_EMBEDDING_MODE=oldMode;if(oldRoot===undefined)delete process.env.MINDPOND_LOCAL_INFERENCE_ROOT;else process.env.MINDPOND_LOCAL_INFERENCE_ROOT=oldRoot;await fs.rm(dir,{recursive:true,force:true});
}
