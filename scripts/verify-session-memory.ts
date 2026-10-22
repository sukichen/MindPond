/** Actual HTTP/stdio identity transitions, office moves and activation management. Disposable data only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {GraphMemory} from '../src/core/graph-memory.js';
import {createNetworkMcpApp} from '../src/integrations/network-server.js';
import {createOwnerMemoryServer} from '../src/role-memory-service.js';
import {tokenDigest} from '../src/integrations/network-config.js';
import {getEmbeddingService} from '../src/core/embedding.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-session-memory-')),graph=new GraphMemory('.',{dbPath:path.join(dir,'fixture.db')});
const admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const clients:Client[]=[],local=createOwnerMemoryServer(graph),embedding=getEmbeddingService(),original=embedding.generateEmbedding;
embedding.generateEmbedding=async()=>[1,...Array(383).fill(0)];let network:any,server:any;
const call=async(c:Client,name:string,args:any={},chat='chat-a',source='codex')=>{const r:any=await c.callTool({name,arguments:args,_meta:{[source==='codex'?'threadId':'ai.opencode/sessionID']:chat}});return {r,data:JSON.parse(r.content[0].text)};};
const ok=async(c:Client,name:string,args:any={},chat='chat-a',source='codex')=>{const {r,data}=await call(c,name,args,chat,source);assert(!r.isError,JSON.stringify(data));return data;};
try{
 await graph.init();const db=(graph as any).db;
 await graph.offices.configureAgent({id:'host',principal:'human',name:'My development machine',host:'codex',state:'active',expectedRevision:0},admin);
 const token='a'.repeat(43),grant={principal:'human',agentId:'host',tokenHash:tokenDigest(token),domains:[{kind:'personal' as const,id:'default'}]};
 network=createNetworkMcpApp(graph,{configuration:async()=>({grants:[grant]}),allowedHosts:['127.0.0.1']});server=network.app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const port=server.address().port;
 await network.close();await new Promise<void>(r=>server.close(r));network=createNetworkMcpApp(graph,{configuration:async()=>({grants:[grant]}),allowedHosts:['127.0.0.1:'+port]});server=network.app.listen(port,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 async function remote(endpoint:string){const c=new Client({name:'fixture',version:'1'});clients.push(c);await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+port+endpoint),{requestInit:{headers:{Authorization:'Bearer '+token}}}));return c;}
 const office=await remote('/mcp'),memory=await remote('/memory/mcp'),stdio=new Client({name:'local-fixture',version:'1'});clients.push(stdio);const [x,y]=InMemoryTransport.createLinkedPair();await Promise.all([local.server.connect(x),stdio.connect(y)]);
 const personal=await ok(memory,'memory_save',{content:'Shared keyword human production lesson',idempotencyKey:'human-save'},'human-chat');assert.deepEqual(personal.owner,{kind:'user',id:'default'});
 assert.deepEqual((await ok(stdio,'memory_identity',{},'human-chat')).owner,{kind:'user',id:'default'});
 assert.equal((await ok(memory,'memory_identity')).identity.mode,'unbound_chat');assert.equal((await ok(memory,'memory_identity')).identity.chat.id,'chat-a');
 const pending=await ok(office,'role_application',{action:'submit',name:'Cartoon engineer',introduction:'Fictional reviewer',reason:'Fixture',key:'apply'});
 assert.equal((await ok(memory,'memory_identity')).owner.kind,'user','a pending application is not a role binding');
 const approved=await graph.roles.review({applicationId:pending.applicationId,expectedRevision:1,action:'approve'},admin);
 for(const c of [memory,stdio])assert.equal((await ok(c,'memory_identity')).owner.id,approved.roleId,'approval takes effect on the same transport');
 const own=await ok(memory,'memory_save',{content:'Shared keyword role-private lesson',idempotencyKey:'role-save'});assert.equal(own.owner.id,approved.roleId);
 assert((await call(memory,'memory_get',{nodeId:personal.id})).r.isError);
 const appB=await ok(office,'role_application',{action:'submit',name:'Other engineer',introduction:'Fictional',reason:'Fixture',key:'apply'},'peer');
 const peer=await graph.roles.review({applicationId:appB.applicationId,expectedRevision:1,action:'approve'},admin);
 const peerMemory=await ok(memory,'memory_save',{content:'Shared keyword peer-private lesson',idempotencyKey:'peer-save'},'peer');
 assert((await call(memory,'memory_get',{nodeId:peerMemory.id})).r.isError);
 const room=(id:string,revision:number,seats:any[])=>graph.roles.configureOffice({id,title:id,state:'active',expectedRevision:revision,seats},admin);
 await room('room-a',0,[{id:'seat-a',roleId:approved.roleId,label:'Engineer',role:'member'}]);await room('room-b',0,[{id:'seat-b',roleId:peer.roleId,label:'Peer',role:'member'}]);
 const a=await ok(memory,'memory_save',{officeId:'room-a',content:'Shared keyword office A procedure',idempotencyKey:'a'});
 const b=await ok(memory,'memory_save',{officeId:'room-b',content:'Shared keyword office B procedure',idempotencyKey:'b'},'peer');
 assert(!(await call(memory,'memory_get',{nodeId:a.id})).r.isError);assert((await call(memory,'memory_get',{nodeId:b.id})).r.isError);
 await room('room-a',1,[]);await room('room-b',1,[{id:'seat-b',roleId:peer.roleId,label:'Peer',role:'member'},{id:'seat-engineer',roleId:approved.roleId,label:'Engineer',role:'member'}]);
 for(const c of [memory,stdio]){assert((await call(c,'memory_get',{nodeId:a.id})).r.isError,'office move removes old access immediately');assert.equal((await ok(c,'memory_get',{nodeId:b.id})).id,b.id);assert.equal((await ok(c,'memory_get',{nodeId:own.id})).id,own.id);}
 const directory=await ok(memory,'memory_directory',{limit:50});assert(directory.memories.some((m:any)=>m.id===b.id));assert(!directory.memories.some((m:any)=>[a.id,personal.id,peerMemory.id].includes(m.id)));
 for(const c of [memory,stdio]){for(const id of [personal.id,own.id,peerMemory.id,a.id,b.id])assert.equal((await ok(c,'memory_get',{nodeId:id},'human-chat')).id,id);const all=await ok(c,'memory_directory',{limit:50},'human-chat');assert([own.id,peerMemory.id,a.id,b.id].every(id=>all.memories.some((m:any)=>m.id===id)));const found=await ok(c,'memory_search',{query:'Shared keyword',limit:30},'human-chat');assert([own.id,peerMemory.id,a.id,b.id].every(id=>found.results.some((m:any)=>m.id===id)));}
 await graph.memoryOwners.setPolicy(b.id,true,0);const detail=await ok(memory,'memory_get',{nodeId:b.id},'human-chat');await ok(memory,'memory_update',{nodeId:b.id,expectedUpdatedAt:detail.updatedAt,content:'Shared keyword human corrected office B',reason:'Human management'},'human-chat');assert((await call(memory,'memory_update',{nodeId:b.id,expectedUpdatedAt:detail.updatedAt,content:'Disallowed',reason:'Role cannot edit lock'})).r.isError);
 // The actual native IDs must be available to humans and the calling chat.
 const sync=await ok(office,'role_sync',{},'ses_open_code_123','opencode');assert.equal(sync.activation.chat.id,'ses_open_code_123');assert.equal(sync.pondId,(await ok(memory,'memory_identity')).pondId);
 let registry=await graph.roles.registry(admin);const request=registry.connections.find((r:any)=>r.id===sync.activation.id);assert.equal(request.native_chat_id,'ses_open_code_123');assert.equal(request.chat_source,'opencode');assert.equal(registry.roles.find((r:any)=>r.id===approved.roleId).connection.chat.id,'chat-a');
 await assert.rejects(graph.roles.resolveConnection({requestId:request.id,expectedRevision:1,action:'delete'}),/management approval/);
 await graph.roles.resolveConnection({requestId:request.id,expectedRevision:1,action:'delete'},admin);assert(!await db.get('SELECT 1 FROM role_connection_requests WHERE id=?',[request.id]));
 const after=await ok(office,'role_sync',{},'ses_open_code_123','opencode');assert.equal(after.activation.state,'deleted');assert.match(after.activation.notice,/Automatic sync will not create/);assert(!(await graph.roles.registry(admin)).connections.some((r:any)=>r.runtime_id===request.runtime_id));
 await assert.rejects(graph.roles.activate({requestId:request.id,roleId:approved.roleId,expectedRevision:1},admin),/expired or missing/);
 const rejection=await ok(office,'role_sync',{},'reject-me');await graph.roles.resolveConnection({requestId:rejection.activation.id,expectedRevision:1,action:'reject'},admin);assert.equal((await ok(office,'role_sync',{},'reject-me')).activation.state,'rejected');
 const app=await ok(office,'role_application',{action:'submit',name:'Delete this application',introduction:'Remove this private draft',reason:'Fixture',key:'delete-app'},'delete-app');await graph.roles.deleteApplication({applicationId:app.applicationId,expectedRevision:1},admin);assert(!await db.get('SELECT 1 FROM role_applications WHERE id=?',[app.applicationId]));assert.equal((await ok(office,'role_sync',{},'delete-app')).activation.state,'deleted');
 // Human -> role approval during expensive save cannot misattribute a write.
 const waitApp=await ok(office,'role_application',{action:'submit',name:'Race role',introduction:'Fictional',reason:'Fixture',key:'apply'},'approval-race');
 let enter!:()=>void,resume!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>resume=r);embedding.generateEmbedding=async()=>{enter();await gate;return [1,...Array(383).fill(0)];};
 const late=call(memory,'memory_save',{content:'Must not commit across human role transition',idempotencyKey:'approval-race'},'approval-race');await entered;await graph.roles.review({applicationId:waitApp.applicationId,expectedRevision:1,action:'approve'},admin);resume();assert((await late).r.isError);embedding.generateEmbedding=async()=>[1,...Array(383).fill(0)];assert(!(await graph.listNodes({operatorAll:true,limit:100})).nodes.some(n=>n.content==='Must not commit across human role transition'));
 console.log('PASS identified unbound human all-owner read/search/write, in-place approval to role, private fencing, current-office move, human locked-memory edits, native chat locators, rejected/deleted request suppression without slots, real application deletion and human-to-role save fence');
}finally{embedding.generateEmbedding=original;for(const c of clients)await c.close().catch(()=>{});await local.close();await network?.close();if(server)await new Promise<void>(r=>server.close(()=>r()));await graph.close();await fs.rm(dir,{recursive:true,force:true});}
