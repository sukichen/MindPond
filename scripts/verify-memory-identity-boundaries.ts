/** Security regressions: role selection must survive missing, ambiguous and changing identity. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {GraphMemory} from '../src/core/graph-memory.js';
import {createOwnerMemoryServer} from '../src/role-memory-service.js';
import {roleRuntimeId} from '../src/core/roles.js';
import {createMemoryMcpServer} from '../src/mcp-service.js';
import {getEmbeddingService} from '../src/core/embedding.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-identity-boundaries-')),graph=new GraphMemory('.',{dbPath:path.join(dir,'fixture.db')});
const admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const actor=(host:string,chat:string)=>({...admin,operator:false,agentId:host,transport:'http-mcp' as const,runtimeId:roleRuntimeId('human',host,'codex',chat)});
const services:ReturnType<typeof createOwnerMemoryServer>[]=[],clients:Client[]=[];
const embedding=getEmbeddingService(),original=embedding.generateEmbedding;embedding.generateEmbedding=async()=>[1,...Array(383).fill(0)];
async function connect(options:Parameters<typeof createOwnerMemoryServer>[1]={}){const service=createOwnerMemoryServer(graph,options),c=new Client({name:'fixture',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();services.push(service);clients.push(c);await Promise.all([service.server.connect(a),c.connect(b)]);return c;}
async function call(c:Client,name:string,args:any={},meta?:any){const r:any=await c.callTool({name,arguments:args,...(meta?{_meta:meta}:{})});return {r,data:JSON.parse(r.content[0].text)};}
async function approve(host:string,chat:string){const a=await graph.roles.application({action:'submit',name:chat,introduction:'Fictional',reason:'Security regression',key:'apply'},actor(host,chat));return graph.roles.review({action:'approve',applicationId:a.applicationId,expectedRevision:1},admin);}
try{
 await graph.init();for(const host of ['host','second'])await graph.offices.configureAgent({id:host,principal:'human',host:'codex',name:host,state:'active',expectedRevision:0},admin);
 const a=await approve('host','a'),b=await approve('host','b');
 const factory=createMemoryMcpServer(graph,{trusted:actor('host','a'),toolProfile:'full'}),factoryClient=new Client({name:'factory-fixture',version:'1'}),[fx,fy]=InMemoryTransport.createLinkedPair();
 await Promise.all([factory.server.connect(fx),factoryClient.connect(fy)]);
 try{assert((await factoryClient.listTools()).tools.every(t=>!t.name.startsWith('memory_')),'the shared server factory cannot reintroduce role-to-personal bypass');assert((await factoryClient.callTool({name:'memory_save',arguments:{content:'Factory bypass',idempotencyKey:'factory'}})).isError);}finally{await factoryClient.close();await factory.close();}
 const human=await graph.saveMemory('Human identity boundary marker'),humanBefore=(await graph.getNodeById(human.id))!.content;
 const local=await connect({trusted:{...admin,domains:[{kind:'personal',id:'default'}],sessionId:'a'}});
 assert.equal((await call(local,'memory_identity',{}, {threadId:'a'})).data.owner.id,a.roleId);
 const missing=await call(local,'memory_save',{content:'Must not be human',idempotencyKey:'missing'});assert(missing.r.isError);assert.equal(missing.data.error.code,'identity_required');assert.equal(missing.data.error.details.unidentifiedCallsDenied,true);
 const conflict=await call(local,'memory_identity',{}, {threadId:'a','ai.opencode/sessionID':'a'});assert(conflict.r.isError);assert.equal(conflict.data.error.code,'invalid_input');
 const pin=await connect({roleId:a.roleId});assert.equal((await call(pin,'memory_identity')).data.error.code,'identity_required','a configured role ID alone is not authentication');
 assert.equal((await call(pin,'memory_identity',{}, {threadId:'a'})).data.owner.id,a.roleId);
 await approve('second','a');
 assert((await call(local,'memory_identity',{}, {threadId:'a'})).r.isError,'ambiguous native identity must not choose a recent role or become human');
 const exact=await connect({trusted:actor('host','a')});assert.equal((await call(exact,'memory_identity',{}, {threadId:'a'})).data.owner.id,a.roleId);
 await graph.offices.configureAgent({id:'second',principal:'human',host:'codex',name:'second',state:'disabled',expectedRevision:1},admin);
 const fixed=await connect({roleId:a.roleId,authorize:async()=>{}});
 assert.equal((await call(fixed,'memory_identity')).data.owner.id,a.roleId);
 await graph.offices.configureAgent({id:'host',principal:'human',host:'codex',name:'host',state:'disabled',expectedRevision:1},admin);
 assert((await call(fixed,'memory_get',{nodeId:human.id})).r.isError,'dedicated role calls still check the current host when chat metadata is absent');
 await graph.offices.configureAgent({id:'host',principal:'human',host:'codex',name:'host',state:'active',expectedRevision:2},admin);
 let enter!:()=>void,resume!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>resume=r);
 embedding.generateEmbedding=async()=>{enter();await gate;return [1,...Array(383).fill(0)];};
 const pending=call(local,'memory_save',{content:'Switched-role pending save must not commit',idempotencyKey:'switch'},{threadId:'a'});await entered;
 const next=await graph.roles.connectionRequest(actor('host','new-a'));assert(next);
 await graph.roles.activate({requestId:next.id,roleId:a.roleId,expectedRevision:1},admin);
 const prior=await graph.roles.connectionRequest(actor('host','a'));assert(prior);
 await graph.roles.activate({requestId:prior.id,roleId:b.roleId,expectedRevision:1},admin);
 resume();assert((await pending).r.isError,'role changes during expensive work fence the mutation before commit');
 embedding.generateEmbedding=async()=>[1,...Array(383).fill(0)];
 assert.equal((await call(local,'memory_identity',{}, {threadId:'a'})).data.owner.id,b.roleId);
 assert.equal((await call(local,'memory_identity')).data.error.code,'identity_required','a formerly identified transport cannot cache its last role for missing metadata');
 assert.equal((await graph.getNodeById(human.id))!.content,humanBefore);
 assert(!(await graph.listNodes({operatorAll:true})).nodes.some(n=>n.content==='Must not be human'||n.content==='Switched-role pending save must not commit'));
 console.log('PASS identity boundaries: startup operator ignored, missing/conflicting/ambiguous metadata denied, explicit host recovery, bare role IDs rejected, no-meta dedicated host revocation, role switch during embedding and no last-role cache/human mutation');
}finally{embedding.generateEmbedding=original;await Promise.allSettled(clients.map(c=>c.close()));await Promise.allSettled(services.map(s=>s.close()));await graph.close();await fs.rm(dir,{recursive:true,force:true});}
