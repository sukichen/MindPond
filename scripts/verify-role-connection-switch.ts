/** Real HTTP MCP with two harnesses and persistent roles; fictional data only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {GraphMemory} from '../src/core/graph-memory.js';
import {getEmbeddingService} from '../src/core/embedding.js';
import {createNetworkMcpApp} from '../src/integrations/network-server.js';
import {tokenDigest} from '../src/integrations/network-config.js';
import {roleRuntimeId} from '../src/core/roles.js';
import {roleConnectionDownload} from '../src/integrations/office-connection.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-role-switch-')),file=path.join(dir,'fixture.db');
const graph=new GraphMemory('.',{dbPath:file}),admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const embedding=getEmbeddingService(),generate=embedding.generateEmbedding;embedding.generateEmbedding=async()=>[1,...Array(383).fill(0)];
const clients:Client[]=[];let listener:any,network:ReturnType<typeof createNetworkMcpApp>|undefined,reopened:GraphMemory|undefined;
const tokens=Object.fromEntries(['codex','opencode','other'].map(id=>[id,('fictional-'+id+'-').repeat(4).slice(0,43)]));
try{
 await graph.init();const db=(graph as any).db;
 for(const id of ['codex','opencode','other'])await graph.offices.configureAgent({id,principal:id==='other'?'another-human':'human',name:id+' fixture',host:id==='codex'?'codex':'opencode',state:'active',expectedRevision:0},admin);
 const allowedHosts=['127.0.0.1'];network=createNetworkMcpApp(graph,{allowedHosts,maxPerAccount:20,configuration:async()=>({version:2,grants:Object.keys(tokens).map(id=>({principal:id==='other'?'another-human':'human',agentId:id,credentialId:id,tokenHash:tokenDigest(tokens[id]),domains:[],toolProfile:'office' as const}))})});
 listener=network.app.listen(0,'127.0.0.1');await new Promise<void>(r=>listener.once('listening',r));const port=listener.address().port;allowedHosts.push('127.0.0.1:'+port);
 const connect=async(id:string,memory=false,token=tokens[id])=>{const client=new Client({name:'fixture-'+id,version:'1'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${memory?'/memory/mcp':'/mcp'}`),{requestInit:{headers:{Authorization:'Bearer '+token}}}));return client;};
 console.log('PASS fixture registered hosts');
 const a=await connect('codex'),b=await connect('opencode'),am=await connect('codex',true),bm=await connect('opencode',true),foreign=await connect('other');
 const raw=async(c:Client,name:string,args:any={},chat='a',harness='codex')=>c.callTool({name,arguments:args,_meta:{[harness==='codex'?'threadId':'ai.opencode/sessionID']:chat}});
 const call=async(c:Client,name:string,args:any={},chat='a',harness='codex')=>{const result:any=await raw(c,name,args,chat,harness);assert(!result.isError,JSON.stringify(result));return JSON.parse(result.content.find((x:any)=>x.type==='text').text);};
 const makeRole=async(chat:string)=>{const app=await call(a,'role_application',{action:'submit',name:'Fixture '+chat,introduction:'Portable fictional role',reason:'Isolation regression',key:'apply'},chat);return graph.roles.review({applicationId:app.applicationId,expectedRevision:1,action:'approve'},admin);};
 const role=await makeRole('a'),reviewer=await makeRole('reviewer');
 const actor={v:1 as const,principal:'human',agentId:'codex',transport:'http-mcp' as const,runtimeId:roleRuntimeId('human','codex','codex','a'),roleId:role.roleId,roleBindingId:role.bindingId,roleBindingEpoch:1,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
 await graph.roles.configureOffice({id:'room',title:'Portable room',state:'active',expectedRevision:0,seats:[{id:'worker',roleId:role.roleId,label:'Worker',role:'worker'},{id:'reviewer',roleId:reviewer.roleId,label:'Reviewer',role:'reviewer'}]},admin);
 const opened=(await graph.offices.open({assignmentId:'worker'},actor)).context!;
 const task=await graph.offices.item({action:'create',workSessionId:opened.workSessionId,title:'Migration work',acceptance:'Same role',owner:'worker',reviewer:'reviewer',key:'task'},actor);
 await graph.offices.item({action:'claim',workSessionId:opened.workSessionId,itemId:task.item.id,expectedRevision:task.item.revision,key:'claim'},actor);
 const learned=await call(am,'memory_save',{content:'Verified fictional knowledge follows the role',idempotencyKey:'learned'});
 const source=await graph.saveMemory('Independent source for the portable role'),copy=(await graph.memoryOwners.allocate([source.id],role.roleId)).copies[0];
 const message=await call(a,'office_message',{action:'send',recipient:role.roleId,officeId:'room',body:'Please preserve this in-progress message',key:'message'},'reviewer');
 await call(a,'office_message',{action:'take',messageId:message.messageId,key:'take'});
 const material=await call(a,'office_material',{action:'publish',officeId:'room',title:'Preserved material',content:'Fictional handoff text',key:'material'});
 console.log('PASS role knowledge, messages and assigned office seeded');
 const credential=await graph.memoryOwners.issue(role.roleId),pinned=await connect('codex',true,credential.token);
 assert.equal((await call(pinned,'memory_identity')).owner.id,role.roleId);
 console.log('PASS role credential resolves current host');
 const target=(await call(b,'role_sync',{},'b','opencode')).activation;
 const foreignRequest=(await call(foreign,'role_sync',{},'foreign','opencode')).activation;
 let current=(await graph.roles.registry(admin)).roles.find((r:any)=>r.id===role.roleId)!;
 assert.equal(current.connection.connectorId,'codex');assert.equal(current.connection.host,'codex');assert(current.connection.chatRef);
 await assert.rejects(graph.roles.activate({requestId:foreignRequest.id,roleId:role.roleId,expectedRevision:current.revision},admin),(e:any)=>e.code==='invalid_input');
 // Failed target authorization must leave every binding, lease and credential intact.
 await graph.offices.configureProject({id:'limited',title:'Restricted project',members:['codex'],enabled:true,expectedRevision:0},admin);
 await db.run('INSERT INTO office_project_links VALUES(?,?)',['room','limited']);
 await assert.rejects(graph.roles.activate({requestId:target.id,roleId:role.roleId,expectedRevision:current.revision},admin),(e:any)=>e.code==='scope_denied');
 assert.equal((await call(am,'memory_identity')).owner.id,role.roleId);assert(await graph.memoryOwners.credential(credential.token));
 assert.equal((await db.get('SELECT status FROM office_items WHERE id=?',[task.item.id])).status,'claimed');
 await graph.offices.configureProject({id:'limited',title:'Restricted project',members:['codex','opencode'],enabled:true,expectedRevision:1},admin);
 const liveSession=(await graph.offices.open({assignmentId:'worker'},actor)).context!;const readyTask=await db.get('SELECT revision FROM office_items WHERE id=?',[task.item.id]);await graph.offices.item({action:'claim',workSessionId:liveSession.workSessionId,itemId:task.item.id,expectedRevision:readyTask.revision,key:'reclaim'},actor);
 const wait=raw(a,'office_wait',{waitMs:3000});
 for(let n=0;n<100;n++){if(await db.get("SELECT 1 FROM role_message_waits WHERE state='waiting'"))break;await new Promise(r=>setTimeout(r,10));}
 assert(await db.get("SELECT 1 FROM role_message_waits WHERE state='waiting'"));
 // Force failure after revocation starts: all changes must roll back together.
 await db.exec("CREATE TRIGGER fail_switch BEFORE UPDATE ON office_seats WHEN NEW.agent_id='opencode' BEGIN SELECT RAISE(ABORT,'switch fixture failure'); END");
 await assert.rejects(graph.roles.activate({requestId:target.id,roleId:role.roleId,expectedRevision:current.revision},admin),/switch fixture failure/);
 assert.equal((await graph.roles.identity(actor))!.roleId,role.roleId);assert(await graph.memoryOwners.credential(credential.token));
 await db.exec('DROP TRIGGER fail_switch');
 await graph.roles.activate({requestId:target.id,roleId:role.roleId,expectedRevision:current.revision},admin);
 console.log('PASS atomic host switch');
 const waited:any=await wait;assert(waited.isError,'in-flight original chat wait must be fenced');
 assert((await raw(am,'memory_identity')).isError);assert((await raw(a,'office_directory')).isError);
 await assert.rejects(()=>raw(pinned,'memory_identity'),(e:any)=>e.code===401,'dedicated credentials from the previous binding are revoked');
 assert.equal((await call(bm,'memory_identity',{},'b','opencode')).owner.id,role.roleId);
 assert.equal((await call(bm,'memory_get',{nodeId:learned.id},'b','opencode')).content,'Verified fictional knowledge follows the role');
 assert.equal((await call(bm,'memory_get',{nodeId:copy.copyId},'b','opencode')).provenance.sourceId,source.id);
 const synced=await call(b,'role_sync',{},'b','opencode');assert(synced.processing.some((m:any)=>m.messageId===message.messageId));assert(synced.assignments.some((o:any)=>o.assignmentId==='worker'));
 assert.equal((await db.get('SELECT agent_id FROM office_seats WHERE id=?',['worker'])).agent_id,'opencode');
 assert.equal((await db.get('SELECT status FROM office_items WHERE id=?',[task.item.id])).status,'open');
 assert.equal((await db.get('SELECT state FROM office_sessions WHERE id=?',[opened.workSessionId])).state,'closed');
 assert.equal((await call(b,'office_material',{action:'get',officeId:'room',materialId:material.materialId,number:0},'b','opencode')).chunk.content,'Fictional handoff text');
 await call(b,'office_message',{action:'finish',messageId:message.messageId,result:'Continued from another harness',key:'finish'},'b','opencode');
 current=(await graph.roles.registry(admin)).roles.find((r:any)=>r.id===role.roleId)!;assert.equal(current.connection.connectorId,'opencode');
 // Return to the exact original native chat and fence OpenCode in turn.
 const back=(await call(a,'role_sync')).activation;await graph.roles.activate({requestId:back.id,roleId:role.roleId,expectedRevision:current.revision},admin);
 assert.equal((await call(am,'memory_identity')).owner.id,role.roleId);assert((await raw(bm,'memory_identity',{},'b','opencode')).isError);
 // Switching away and back must never resurrect a write already preparing embeddings.
 let began!:()=>void,release!:()=>void;const started=new Promise<void>(r=>began=r),gate=new Promise<void>(r=>release=r);
 embedding.generateEmbedding=async text=>{if(text.includes('Round trip fenced knowledge')){began();await gate;}return [1,...Array(383).fill(0)];};
 const preparing=raw(am,'memory_save',{content:'Round trip fenced knowledge',idempotencyKey:'round-trip-fence'});await started;
 const again=(await call(b,'role_sync',{},'b','opencode')).activation;
 current=(await graph.roles.registry(admin)).roles.find((r:any)=>r.id===role.roleId)!;await graph.roles.activate({requestId:again.id,roleId:role.roleId,expectedRevision:current.revision},admin);
 const returnAgain=(await call(a,'role_sync')).activation;current=(await graph.roles.registry(admin)).roles.find((r:any)=>r.id===role.roleId)!;
 await graph.roles.activate({requestId:returnAgain.id,roleId:role.roleId,expectedRevision:current.revision},admin);release();assert((await preparing).isError);
 assert.equal((await db.get("SELECT COUNT(*) n FROM nodes WHERE content='Round trip fenced knowledge'")).n,0,'binding generation is checked under the writer lock');
 assert.equal((await db.get("SELECT COUNT(*) n FROM role_bindings WHERE role_id=? AND state='active'",[role.roleId])).n,1);
 assert(!(await db.all('PRAGMA table_info(character_roles)')).some((c:any)=>c.name==='connector_id'));
 // The originating harness can be deleted once its role has moved elsewhere.
 await graph.offices.configureAgent({id:'disposable',principal:'human',name:'Disposable fixture',host:'opencode',state:'active',expectedRevision:0},admin);
 const disposable={v:1 as const,principal:'human',agentId:'disposable',runtimeId:'temporary',transport:'http-mcp' as const,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
 const draft=await graph.roles.application({action:'submit',name:'Independent role',introduction:'Not owned by its originating host',reason:'Origin cleanup',key:'apply'},disposable);
 const independent=await graph.roles.review({applicationId:draft.applicationId,expectedRevision:1,action:'approve'},admin);
 const destination=(await call(b,'role_sync',{},'independent-target','opencode')).activation;
 await graph.roles.activate({requestId:destination.id,roleId:independent.roleId,expectedRevision:1},admin);
 await graph.offices.deleteAgent({id:'disposable',expectedRevision:1},admin);
 assert.equal((await graph.roles.registry(admin)).roles.find((r:any)=>r.id===independent.roleId)!.connection.connectorId,'opencode');
 // Simulate a pre-upgrade role schema, then verify one-time column removal.
 await db.exec('ALTER TABLE character_roles ADD COLUMN connector_id TEXT');await db.run("UPDATE character_roles SET connector_id='codex'");
 reopened=new GraphMemory('.',{dbPath:file});await reopened.init();assert(!(await (reopened as any).db.all('PRAGMA table_info(character_roles)')).some((c:any)=>c.name==='connector_id'));
 assert.equal((await reopened.roles.registry(admin)).roles.find((r:any)=>r.id===role.roleId)!.connection.connectorId,'codex');assert(await reopened.getNodeById(copy.copyId));
 assert.equal((await db.all('PRAGMA foreign_key_check')).length,0);
 for(const host of ['codex','opencode','claude']){const config=roleConnectionDownload({host,connectorId:'fixture',roleId:role.roleId,url:'https://memory.example/mcp',token:'synthetic-'.repeat(4)});assert(config.text.includes('Bearer synthetic-'));if(host==='codex'){assert(config.filename.endsWith('.toml'));assert(!config.text.includes('bearer_token_env_var'));}else{const c=JSON.parse(config.text);assert.equal(Object.keys(c.mcp??c.mcpServers).length,2);}}
 console.log('PASS portable roles: real HTTP Codex↔OpenCode, current connection projection, same knowledge/copies/materials/processing mail/offices, project/account guards, rollback, fenced wait/leases/credentials, single active binding, schema migration and host-correct downloads');
}finally{await Promise.allSettled(clients.map(c=>c.close()));await network?.close(listener);await reopened?.close();await graph.close();embedding.generateEmbedding=generate;await fs.rm(dir,{recursive:true,force:true});}
