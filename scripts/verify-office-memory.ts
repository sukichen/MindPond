/** Exercise real MCP handlers and writer-time authorization, without model calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {GraphMemory} from '../src/core/graph-memory.js';
import {createOwnerMemoryServer} from '../src/role-memory-service.js';
import {roleRuntimeId} from '../src/core/roles.js';
import {getEmbeddingService} from '../src/core/embedding.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-office-memory-')),graph=new GraphMemory('.',{dbPath:path.join(dir,'test.db')});
const embedding=getEmbeddingService(),original=embedding.generateEmbedding;
embedding.generateEmbedding=async()=>[1,...Array(383).fill(0)];
const admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const services:ReturnType<typeof createOwnerMemoryServer>[]=[],clients:Client[]=[];
try{
 await graph.init();
 await graph.offices.configureAgent({id:'host',principal:'human',name:'Fictional Codex',host:'codex',state:'active',expectedRevision:0},admin);
 const roles=[];
 for(const chat of ['worker','colleague','outsider']){
  const actor={...admin,operator:false,agentId:'host',transport:'http-mcp' as const,runtimeId:roleRuntimeId('human','host','codex',chat)};
  const app=await graph.roles.application({action:'submit',name:chat,introduction:'Fictional test role',reason:'Shared memory permissions',key:'apply'},actor);
  roles.push({...await graph.roles.review({action:'approve',applicationId:app.applicationId,expectedRevision:1},admin),actor});
 }
 const seats=roles.slice(0,2).map((r,i)=>({id:'seat-'+i,roleId:r.roleId,label:'Member '+i,role:'member'}));
 await graph.roles.configureOffice({id:'room',title:'Fictional room',state:'active',expectedRevision:0,seats},admin);
 await graph.roles.configureOffice({id:'other-room',title:'Other room',state:'active',expectedRevision:0,seats:[{id:'other-seat',roleId:roles[2].roleId,label:'Other',role:'member'}]},admin);
 async function connect(options:Parameters<typeof createOwnerMemoryServer>[1]={}){const service=createOwnerMemoryServer(graph,options),client=new Client({name:'fixture',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();services.push(service);clients.push(client);await Promise.all([service.server.connect(a),client.connect(b)]);return client;}
 const local=await connect(),remote=await connect({trusted:roles[0].actor});
 const raw=async(c:Client,name:string,args:any={},chat?:string)=>c.callTool({name,arguments:args,...(chat?{_meta:{threadId:chat}}:{})});
 const call=async(c:Client,name:string,args:any={},chat?:string)=>{const r:any=await raw(c,name,args,chat);assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
 const denied=async(c:Client,name:string,args:any={},chat?:string)=>{const r:any=await raw(c,name,args,chat);assert(r.isError,'Expected denial: '+name);return JSON.parse(r.content[0].text);};
 assert.equal((await call(local,'memory_identity',{},'worker')).owner.id,roles[0].roleId,'stdio native metadata resolves role, never human fallback');
 assert.equal((await denied(local,'memory_identity')).error.code,'identity_required','unidentified local calls must never become human');
 assert.equal((await call(local,'memory_save',{content:'Unbound human lesson',idempotencyKey:'human'},'unapproved')).owner.kind,'user');
 const privateMemory=await call(local,'memory_save',{content:'## Private task technique',idempotencyKey:'private'},'worker');
 assert.equal((await graph.memoryOwners.owner((await graph.getNodeById(privateMemory.id))!)).id,roles[0].roleId);
 await denied(local,'memory_get',{nodeId:privateMemory.id},'colleague');
 const shared=await call(local,'memory_save',{content:'## Room skill\n\nVerified steps, version and evidence.',officeId:'room',idempotencyKey:'shared'},'worker');
 assert.equal(shared.owner.kind,'office');
 assert.equal((await call(local,'memory_get',{nodeId:shared.id},'colleague')).owner.id,'room');
 assert.equal((await call(remote,'memory_get',{nodeId:shared.id})).owner.id,'room','authenticated host and local native chat share exact policy');
 await denied(local,'memory_get',{nodeId:shared.id},'outsider');
 await denied(local,'memory_save',{content:'Cross room rejected',officeId:'other-room',idempotencyKey:'cross'},'worker');
 const list=await call(local,'memory_directory',{},'worker');assert(list.memories.some((n:any)=>n.id===privateMemory.id));assert(list.memories.some((n:any)=>n.id===shared.id));
 assert((await call(local,'memory_directory',{officeId:'room'},'worker')).memories.every((n:any)=>n.owner.kind==='office'));
 await denied(local,'memory_directory',{officeId:'other-room'},'worker');
 const bounded=await call(local,'memory_search',{query:'Room skill',contextBudgetBytes:2048},'colleague');assert(bounded.results.some((n:any)=>n.id===shared.id));assert(Buffer.byteLength(JSON.stringify({results:bounded.results}))<=2048);
 let node=await call(local,'memory_get',{nodeId:shared.id},'colleague');
 await call(local,'memory_update',{nodeId:shared.id,content:'## Room skill\n\nUpdated by another member.',expectedUpdatedAt:node.updatedAt,reason:'Verified new evidence'},'colleague');
 const lock=await graph.memoryOwners.setPolicy(shared.id,true,0);
 await assert.rejects(graph.memoryOwners.setPolicy(shared.id,false,0),/stale_version/);
 node=await call(local,'memory_get',{nodeId:shared.id},'worker');assert(node.officePolicy.locked);
 await denied(local,'memory_update',{nodeId:shared.id,content:'Must not override rules',expectedUpdatedAt:node.updatedAt,reason:'Forbidden'},'worker');
 await denied(local,'memory_delete',{nodeId:shared.id,reason:'Forbidden'},'worker');
 await graph.editMemory(shared.id,{content:'## Human rule\n\nHuman edits remain allowed.',expectedUpdatedAt:node.updatedAt,reason:'Human reviewed'});
 assert((await call(local,'memory_get',{nodeId:shared.id},'colleague')).officePolicy.locked,'human edit does not unlock');
 await graph.memoryOwners.setPolicy(shared.id,false,lock.revision);
 // Human locks during expensive embedding; the writer must recheck after model work.
 let started!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>started=r),blocked=new Promise<void>(r=>release=r);
 embedding.generateEmbedding=async()=>{started();await blocked;return [1,...Array(383).fill(0)];};
 node=await call(local,'memory_get',{nodeId:shared.id},'worker');
 const inFlight=raw(local,'memory_update',{nodeId:shared.id,content:'Blocked late office edit',expectedUpdatedAt:node.updatedAt,reason:'Race fixture'},'worker');
 await entered;await graph.memoryOwners.setPolicy(shared.id,true,2);release();assert((await inFlight).isError);
 assert.equal((await graph.getNodeById(shared.id))!.content,node.content);
 embedding.generateEmbedding=async()=>[1,...Array(383).fill(0)];
 // Membership removed while embedding. No shared node may commit afterwards.
 let begin!:()=>void,resume!:()=>void;const begun=new Promise<void>(r=>begin=r),pause=new Promise<void>(r=>resume=r);
 embedding.generateEmbedding=async()=>{begin();await pause;return [1,...Array(383).fill(0)];};
 const removedWrite=raw(local,'memory_save',{content:'Removed member late publish',officeId:'room',idempotencyKey:'removed'},'worker');
 await begun;await graph.roles.configureOffice({id:'room',title:'Fictional room',state:'active',expectedRevision:1,seats:[seats[1]]},admin);resume();assert((await removedWrite).isError);
 assert(!(await graph.listNodes({operatorAll:true})).nodes.some(n=>n.content==='Removed member late publish'));
 embedding.generateEmbedding=async()=>[1,...Array(383).fill(0)];
 await denied(local,'memory_get',{nodeId:shared.id},'worker');
 assert.equal((await call(local,'memory_get',{nodeId:privateMemory.id},'worker')).owner.kind,'agent');
 // Human allocation is an independent copy of the actual version, not an ownership move.
 const assigned=(await graph.memoryOwners.allocate([shared.id],roles[0].roleId)).copies[0];
 const copy=await call(local,'memory_get',{nodeId:assigned.copyId},'worker');assert.equal(copy.provenance.sourceId,shared.id);
 await call(local,'memory_update',{nodeId:copy.id,content:'Private practice notes',expectedUpdatedAt:copy.updatedAt,reason:'Independent role practice'},'worker');
 assert.notEqual((await graph.getNodeById(shared.id))!.content,'Private practice notes');
 // Paused rooms remain readable to current members, but roles cannot publish changes.
 await graph.roles.configureOffice({id:'room',title:'Fictional room',state:'paused',expectedRevision:2},admin);
 await call(local,'memory_get',{nodeId:shared.id},'colleague');
 await denied(local,'memory_save',{content:'Paused room update',officeId:'room',idempotencyKey:'paused'},'colleague');
 await graph.roles.deleteOffice({id:'room',expectedRevision:3},admin);
 await denied(local,'memory_get',{nodeId:shared.id},'colleague');
 assert.equal((await graph.memoryOwners.present((await graph.getNodeById(shared.id))!)).owner.kind,'office','human management retains office knowledge after office deletion');
 assert((await graph.memoryOwners.offices()).some(o=>o.id==='room'&&o.state==='deleted'));
 assert((await graph.listNodes({...await graph.memoryOwners.context({kind:'user',id:'default'},'room')})).nodes.some(m=>m.id===shared.id),'Human management can filter preserved knowledge by a deleted office');
 assert((await graph.recall({query:'Human rule',...await graph.memoryOwners.context({kind:'user',id:'default'},'room')})).results.some(m=>m.node.id===shared.id));
 await denied(local,'memory_directory',{officeId:'room'},'colleague');
 await assert.rejects(graph.roles.configureOffice({id:'room',title:'Different audience',state:'active',expectedRevision:0,seats:[seats[0]]},admin),/retained knowledge/,'deleted office IDs cannot expose preserved knowledge to a new audience');
 assert.equal((await (graph as any).db.get('PRAGMA quick_check')).quick_check,'ok');
 console.log('PASS layered office memory: native stdio role attribution, own/office discovery, peer sharing, outsider/private fencing, human locks/CAS, lock and removal during embedding, independent assignment, paused/deleted room behavior and preserved knowledge');
}finally{embedding.generateEmbedding=original;for(const c of clients)await c.close().catch(()=>{});for(const s of services)await s.close().catch(()=>{});await graph.close();await fs.rm(dir,{recursive:true,force:true});}
