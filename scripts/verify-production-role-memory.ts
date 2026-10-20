/** Production regressions: real SQLite, MCP and HTTP; no model or live data. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {GraphMemory} from '../src/core/graph-memory.js';
import {getEmbeddingService} from '../src/core/embedding.js';
import {createOwnerMemoryServer} from '../src/role-memory-service.js';
import {memoryMcpEndpoint} from '../src/integrations/office-connection.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-production-memory-'));
const graph=new GraphMemory('.',{dbPath:path.join(dir,'fixture.db')});
const admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const actor={v:1 as const,principal:'human',agentId:'host',runtimeId:'chat-a',transport:'http-mcp' as const,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const embedding=getEmbeddingService(),original=embedding.generateEmbedding;
embedding.generateEmbedding=async()=>[1,...Array(383).fill(0)];
const children:ChildProcess[]=[];let service:ReturnType<typeof createOwnerMemoryServer>|undefined,client:Client|undefined;
async function web(extra:Record<string,string>={}){
  const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,MEMORY_DB_PATH:path.join(dir,'fixture.db'),MEMORY_HOST:'127.0.0.1',MEMORY_PORT:'0',MEMORY_API_KEY:'fixture-api',MEMORY_OPERATOR_KEY:'fixture-operator',MEMORY_CONTEXT_SECRET:'',EMBEDDING_ZH_ENABLED:'false',EMBEDDING_MODEL_DIR:path.join(dir,'missing-model'),...extra},stdio:['ignore','pipe','pipe']});children.push(child);
  let output='';child.stdout!.on('data',v=>output+=v);child.stderr!.on('data',v=>output+=v);
  const until=Date.now()+30000;while(!/listening on .*:(\d+)/.test(output)&&child.exitCode===null&&Date.now()<until)await new Promise(r=>setTimeout(r,40));
  const port=/listening on .*:(\d+)/.exec(output)?.[1];assert(port,output);return 'http://127.0.0.1:'+port;
}
try{
  await graph.init();await graph.offices.configureAgent({id:'host',principal:'human',name:'Fixture host',host:'opencode',state:'active',expectedRevision:0},admin);
  const app=await graph.roles.application({action:'submit',name:'Fixture role',introduction:'Fictional',reason:'Regression',key:'apply'},actor);
  const role=await graph.roles.review({action:'approve',applicationId:app.applicationId,expectedRevision:1},admin);
  service=createOwnerMemoryServer(graph,{trusted:actor});client=new Client({name:'role-regression',version:'1'});const [x,y]=InMemoryTransport.createLinkedPair();await Promise.all([service.server.connect(x),client.connect(y)]);
  const tool=async(name:string,args:Record<string,unknown>)=>{const r=await client!.callTool({name,arguments:args});return {r,data:JSON.parse((r.content as any[])[0].text)};};
  const owner=await graph.memoryOwners.domain({kind:'agent',id:role.roleId});
  let revision=1;
  async function blockedWrite(name:string,args:Record<string,unknown>,body:string){
    let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
    embedding.generateEmbedding=async content=>{if(content===body){enter();await gate;}return [1,...Array(383).fill(0)];};
    const pending=tool(name,args);await entered;
    await graph.roles.configure({roleId:role.roleId,expectedRevision:revision++,name:'Fixture role',introduction:'Fictional',state:'disabled'},admin);
    release();assert((await pending).r.isError,'revocation during embedding must reject the pending mutation');
    await graph.roles.configure({roleId:role.roleId,expectedRevision:revision++,name:'Fixture role',introduction:'Fictional',state:'active'},admin);
  }
  await blockedWrite('memory_save',{content:'blocked save',idempotencyKey:'blocked-save'},'blocked save');
  assert(!(await graph.listNodes({domains:[owner],activeOnly:true})).nodes.some(n=>n.content==='blocked save'));
  const seed=await graph.saveMemory('original role knowledge',{domain:owner});const before=await graph.getNodeById(seed.id);
  await blockedWrite('memory_update',{nodeId:seed.id,expectedUpdatedAt:before!.updatedAt,content:'blocked edit',reason:'Regression'},'blocked edit');
  assert.equal((await graph.getNodeById(seed.id))!.content,'original role knowledge');
  embedding.generateEmbedding=async()=>[1,...Array(383).fill(0)];
  const human=await graph.saveMemory('independent copy source'),db=(graph as any).db;
  const count=()=>db.get('SELECT COUNT(*) n FROM nodes').then((r:any)=>r.n),initial=await count();
  await db.exec("CREATE TRIGGER allocation_failure BEFORE INSERT ON memory_allocations BEGIN SELECT RAISE(ABORT,'fixture allocation failure'); END");
  await assert.rejects(graph.memoryOwners.allocate([human.id],role.roleId),/allocation failure/);assert.equal(await count(),initial,'copy, receipt and provenance must roll back together');
  await db.exec('DROP TRIGGER allocation_failure');const copy=(await graph.memoryOwners.allocate([human.id],role.roleId)).copies[0];assert.equal((await graph.memoryOwners.present((await graph.getNodeById(copy.copyId))!)).provenance.sourceId,human.id);
  const newActor={...actor,runtimeId:'new-chat'};const activation=await graph.roles.connectionRequest(newActor);assert(activation);
  const application=await graph.roles.application({action:'submit',name:'New chat',introduction:'Fictional',reason:'Regression',key:'new-chat'},newActor);
  assert.equal(await graph.roles.connectionRequest(newActor),null);assert(!(await graph.roles.registry(admin)).connections.some((r:any)=>r.runtime_id==='new-chat'),'pending application must not also appear as activation');
  await graph.roles.application({action:'cancel',applicationId:application.applicationId,key:'cancel-new'},newActor);
  const a=await graph.roles.connectionRequest({...actor,runtimeId:'move-a'}),b=await graph.roles.connectionRequest({...actor,runtimeId:'move-b'});
  await graph.roles.activate({requestId:a!.id,roleId:role.roleId,expectedRevision:revision},admin);
  await assert.rejects(graph.roles.activate({requestId:b!.id,roleId:role.roleId,expectedRevision:revision},admin),(e:any)=>e.code==='stale_version');
  console.log('PASS writer-lock revocation, atomic copy/provenance rollback, one pending operation per chat and activation CAS');
  assert.equal(memoryMcpEndpoint('https://memory.example/mindpond/mcp'),'https://memory.example/mindpond/memory/mcp');
  for(const url of ['https://memory.example/not-mcp','https://memory.example/memory/mcp','https://user:secret@memory.example/mcp'])assert.throws(()=>memoryMcpEndpoint(url));
  const base=await web();
  const request=(route:string,body?:unknown,headers:Record<string,string>={})=>fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','x-api-key':'fixture-api',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal((await request('/api/memory/owners')).status,403,'a configured operator key must be enforced without CONTEXT_SECRET');
  for(const route of ['/api/memory/list?scope=operator','/api/memory/node/'+human.id+'?scope=operator','/api/memory/stats'])assert.equal((await request(route)).status,403,'service key alone must not enter the human memory workbench');
  const manager={'x-operator-key':'fixture-operator'};const owners=await request('/api/memory/owners',undefined,manager);assert.equal(owners.status,200);assert.match(owners.headers.get('cache-control')??'',/no-store/);assert.equal((await owners.json()).memoryMcpUrl,null);
  assert.equal((await request('/api/memory/role-credential',{roleId:role.roleId},manager)).status,400,'no guessed localhost credential export');
  assert.equal((await db.get('SELECT COUNT(*) n FROM memory_role_credentials')).n,0);
  await graph.offices.settings(admin,'https://memory.example/mindpond/mcp');
  assert.equal((await request('/api/memory/role-credential',{roleId:role.roleId},{...manager,Origin:'https://untrusted.example'})).status,403);
  const first=await (await request('/api/memory/role-credential',{roleId:role.roleId},manager)).json();assert(first.token);assert.equal(first.memoryMcpUrl,'https://memory.example/mindpond/memory/mcp');
  assert.equal((await request('/api/memory/role-credential',{roleId:role.roleId},manager)).status,409);assert(await graph.memoryOwners.credential(first.token));
  const replacement=await (await request('/api/memory/role-credential',{roleId:role.roleId,replaceExisting:true},manager)).json();assert(replacement.token);assert.equal(await graph.memoryOwners.credential(first.token),null);
  const authority=await graph.offices.registry(admin),host=authority.agents.find((a:any)=>a.id==='host');await graph.offices.configureAgent({...host,expectedRevision:host.revision,state:'disabled'},admin);assert.equal(await graph.memoryOwners.credential(replacement.token),null,'disabling the host revokes role credential use too');
  const loginBody={apiKey:'fixture-api',operatorKey:'fixture-operator',cookiePath:'/mindpond/api/office-admin'};
  assert.equal((await request('/api/office-admin/login',loginBody,{'X-Forwarded-Proto':'https',Origin:base.replace('http:','https:')})).status,403,'forwarded protocol is untrusted by default');
  const proxy=await web({MEMORY_TRUST_PROXY:'loopback'});const login=await fetch(proxy+'/api/office-admin/login',{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-Proto':'https',Origin:proxy.replace('http:','https:')},body:JSON.stringify(loginBody)});
  assert.equal(login.status,200,await login.clone().text());assert.match(login.headers.get('set-cookie')??'',/Secure/);assert.match(login.headers.get('set-cookie')??'',/Path=\/mindpond\/api\/office-admin/);
  console.log('PASS management key enforcement, no-store, explicit credential rotation, configured public endpoints, host revocation and trusted local HTTPS proxy');
}finally{
  for(const child of children)if(child.exitCode===null){child.kill('SIGTERM');await new Promise<void>(r=>child.once('exit',()=>r()));}
  await client?.close();await service?.close();await graph.close();embedding.generateEmbedding=original;await fs.rm(dir,{recursive:true,force:true});
}
