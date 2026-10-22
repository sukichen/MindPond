/** Exercise the public layered MCP, actual ripple scoring and writer-time ACLs. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {GraphMemory} from '../src/core/graph-memory.js';
import {getEmbeddingService} from '../src/core/embedding.js';
import {roleRuntimeId} from '../src/core/roles.js';
import {createOwnerMemoryServer} from '../src/role-memory-service.js';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-layered-graph-'));
const graph=new GraphMemory('.',{dbPath:path.join(dir,'fixture.db')});
const embedding=getEmbeddingService(),originalEmbedding=embedding.generateEmbedding;
embedding.generateEmbedding=async()=>[1,...Array(383).fill(0)];
const admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const client=new Client({name:'graph-fixture',version:'1'}),service=createOwnerMemoryServer(graph);
try {
  await graph.init();
  await graph.offices.configureAgent({id:'host',principal:'human',name:'Fixture Codex',host:'codex',state:'active',expectedRevision:0},admin);
  const roles=[];
  for(const chat of ['worker','other']){
    const actor={...admin,operator:false,agentId:'host',transport:'http-mcp' as const,runtimeId:roleRuntimeId('human','host','codex',chat)};
    const app=await graph.roles.application({action:'submit',name:chat,introduction:'Fictional role',reason:'Graph isolation',key:'apply'},actor);
    roles.push(await graph.roles.review({action:'approve',applicationId:app.applicationId,expectedRevision:1},admin));
  }
  const seats=roles.map((r,i)=>({id:'seat-'+i,roleId:r.roleId,label:'Member '+i,role:'member'}));
  await graph.roles.configureOffice({id:'room',title:'Fixture office',state:'active',expectedRevision:0,seats},admin);
  const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([service.server.connect(a),client.connect(b)]);
  const raw=async(name:string,args:any={},chat:string|null='worker')=>client.callTool({name,arguments:args,...(chat?{_meta:{threadId:chat}}:{})});
  const call=async(name:string,args:any={},chat='worker')=>{const r:any=await raw(name,args,chat);assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
  const denied=async(name:string,args:any,chat:string|null='worker',code?:string)=>{const r:any=await raw(name,args,chat);assert(r.isError,'Expected denial: '+name);const data=JSON.parse(r.content[0].text);if(code)assert.equal(data.error.code,code,JSON.stringify(data));return data;};
  const tools=(await client.listTools()).tools;
  for(const name of ['memory_connections','memory_association_get','memory_association_upsert','memory_association_review','memory_association_delete'])assert(tools.some(t=>t.name===name),name);
  assert('related' in tools.find(t=>t.name==='memory_save')!.inputSchema.properties!);
  for(const t of tools)assert(!['domain','domains','roleId','ownerId','sessionId','spaceId'].some(k=>k in (t.inputSchema.properties??{})));
  const save=(content:string,key:string,extra:any={},chat='worker')=>call('memory_save',{content,idempotencyKey:key,...extra},chat);
  const get=(nodeId:string,chat='worker')=>call('memory_get',{nodeId},chat);
  const connections=(nodeId:string,chat='worker')=>call('memory_connections',{nodeId},chat);
  const type=(await graph.getDimensionPolicy()).defaultDimension;
  const otherType=(await graph.getDimensionConfiguration()).definitions.find(d=>d.enabled&&d.id!==type)!.id;
  const seed=await save('Fixture graph seed: verified environment procedure','seed',{anchors:[{text:'Fixture environment',basis:'verified environment procedure',spaceId:'memory',memoryType:type}]});
  const seedNode=await get(seed.id);assert.equal(seedNode.memberships[0].id,seed.memberships[0].id);assert.equal(seedNode.anchors[0].text,'Fixture environment');
  const basis={reason:'These steps solve the same verified incident',context:'Use together for the fixture runtime; other versions remain unverified'};
  const linked=await save('Fixture graph companion: complementary troubleshooting steps','linked',{related:[{memoryId:seed.id,score:0.8,...basis}]});
  assert.equal(linked.edgesCreated,1);
  const edge=(await connections(seed.id)).connections[0];assert.equal(edge.weight,0.8);assert.equal(edge.neighbor.id,linked.id);assert.equal(edge.evidenceCount,1);
  assert.equal((await connections(linked.id)).connections[0].id,edge.id,'same bidirectional graph, not an empty legacy edge table');
  const ctx=await graph.memoryOwners.context({kind:'agent',id:roles[0].roleId});
  const ripple=async()=>graph.search({nodeId:seed.id,...ctx,maxDepth:2,minScore:0,limit:30});
  assert.equal((await ripple()).find(r=>r.node.id===linked.id)!.score,0.8);
  const found=await call('memory_search',{query:'Fixture graph seed',contextBudgetBytes:8192});
  assert(found.results.some((r:any)=>r.id===seed.id&&Number.isFinite(r.score)));
  assert(found.retrieval&&Array.isArray(found.retrieval.channels),'retrieval diagnostics must reach the agent');
  assert.equal(found.contextBudget.used,Buffer.byteLength(JSON.stringify({results:found.results})));
  const detail=await call('memory_association_get',{id:edge.id});assert.equal(detail.evidence[0].context,basis.context);
  const updated=(await call('memory_association_upsert',{memberAId:seed.memberships[0].id,memberBId:linked.memberships[0].id,weight:0.9,...basis})).association;
  assert.equal(updated.id,edge.id);assert.equal(updated.weight,0.9);assert.equal(updated.evidence.length,1,'same evidence is not duplicated');
  await denied('memory_association_review',{id:edge.id,evidenceId:detail.evidence[0].id,decision:'retire',reason:'Fixture version replaced',expectedUpdatedAt:detail.updatedAt},'worker','stale_version');
  await call('memory_association_review',{id:edge.id,evidenceId:updated.evidence[0].id,decision:'retire',reason:'Fixture version replaced',expectedUpdatedAt:updated.updatedAt});
  assert(!(await ripple()).some(r=>r.node.id===linked.id),'retired evidence must stop propagation');
  const retired=await call('memory_association_get',{id:edge.id});assert.equal(retired.evidenceStatus,'retired');
  await call('memory_association_review',{id:edge.id,evidenceId:retired.evidence[0].id,decision:'confirm',reason:'Original fixture conditions verified again',expectedUpdatedAt:retired.updatedAt});
  assert.equal((await ripple()).find(r=>r.node.id===linked.id)!.score,0.9);
  const otherSeed=await save('Other role private source','other-seed',{},'other');
  const otherLinked=await save('Other role private companion','other-linked',{related:[{memoryId:otherSeed.id,score:0.7,...basis}]},'other');
  const otherEdge=(await connections(otherSeed.id,'other')).connections[0];
  for(const [name,args] of [
    ['memory_connections',{nodeId:otherSeed.id}],['memory_association_get',{id:otherEdge.id}],
    ['memory_association_upsert',{memberAId:seed.memberships[0].id,memberBId:otherLinked.memberships[0].id,weight:0.9,...basis}],
    ['memory_association_delete',{id:otherEdge.id,reason:'Must deny'}],
    ['memory_association_review',{id:otherEdge.id,evidenceId:'unknown',decision:'retire',reason:'Must deny',expectedUpdatedAt:otherEdge.updatedAt}]
  ] as const)await denied(name,args,'worker',['memory_connections','memory_association_upsert'].includes(name)?'scope_denied':'not_found');
  assert.equal((await call('memory_association_get',{id:otherEdge.id},'human-chat')).id,otherEdge.id);
  await denied('memory_save',{content:'Foreign link must not commit',idempotencyKey:'foreign-link',related:[{memoryId:otherSeed.id,score:0.8,...basis}]});
  const shared=await save('Fixture shared graph source','shared',{officeId:'room'});
  const sharedLinked=await save('Fixture shared graph companion','shared-linked',{officeId:'room',related:[{membershipId:shared.memberships[0].id,score:0.7,...basis}]});
  const sharedEdge=(await connections(shared.id)).connections[0];
  assert.equal((await connections(shared.id,'other')).connections[0].neighbor.owner.kind,'office');
  await denied('memory_association_upsert',{memberAId:seed.memberships[0].id,memberBId:shared.memberships[0].id,weight:0.9,...basis});
  await graph.memoryOwners.setPolicy(shared.id,true,0);
  await denied('memory_association_upsert',{memberAId:shared.memberships[0].id,memberBId:sharedLinked.memberships[0].id,weight:0.9,...basis},'worker','scope_denied');
  await denied('memory_association_delete',{id:sharedEdge.id,reason:'Must preserve human lock'},'worker','scope_denied');
  const sharedDetail=await call('memory_association_get',{id:sharedEdge.id});
  await denied('memory_association_review',{id:sharedEdge.id,evidenceId:sharedDetail.evidence[0].id,decision:'retire',reason:'Must preserve human lock',expectedUpdatedAt:sharedDetail.updatedAt},'worker','scope_denied');
  await denied('memory_save',{content:'Locked target must not commit','officeId':'room',idempotencyKey:'locked-link',related:[{memoryId:shared.id,score:0.9,...basis}]},'worker','scope_denied');
  await denied('memory_delete',{nodeId:sharedLinked.id,reason:'Cannot indirectly remove locked topology'},'worker','scope_denied');
  await denied('memory_update',{nodeId:sharedLinked.id,dimensions:[otherType],expectedUpdatedAt:(await get(sharedLinked.id)).updatedAt,reason:'Cannot bypass lock through membership replacement'},'worker','scope_denied');
  assert.equal((await connections(shared.id)).connections[0].weight,0.7);
  await call('memory_association_upsert',{memberAId:shared.memberships[0].id,memberBId:sharedLinked.memberships[0].id,weight:0.8,...basis},'human-chat');
  const archivedA=await save('Archived office source','archived-a',{officeId:'room'});
  const archivedB=await save('Archived office companion','archived-b',{officeId:'room',related:[{memoryId:archivedA.id,score:0.7,...basis}]});
  await call('memory_update',{nodeId:archivedB.id,dimensions:[otherType],expectedUpdatedAt:(await get(archivedB.id)).updatedAt,reason:'Human reclassified source'},'human-chat');
  assert.equal((await connections(archivedA.id)).total,0);
  await graph.memoryOwners.setPolicy(archivedA.id,true,0);
  await denied('memory_update',{nodeId:archivedB.id,dimensions:[type],expectedUpdatedAt:(await get(archivedB.id)).updatedAt,reason:'Cannot revive a locked neighbour through archived membership'},'worker','scope_denied');
  await call('memory_update',{nodeId:sharedLinked.id,dimensions:[type],expectedUpdatedAt:(await get(sharedLinked.id)).updatedAt,reason:'Unchanged classification is allowed'});
  console.log('PASS public graph catalog, scored saves/ripple, anchors, evidence review, role isolation and human-locked topology');

  // Six-neighbour replacement must not delete a locked third endpoint.
  const hub=await save('Fixture office hub','hub',{officeId:'room'}),leaves=[];
  for(let i=0;i<6;i++)leaves.push(await save('Fixture office leaf '+i,'leaf-'+i,{officeId:'room',related:[{memoryId:hub.id,score:0.2+i*0.05,...basis}]}));
  await graph.memoryOwners.setPolicy(leaves[0].id,true,0);
  await denied('memory_save',{content:'Eviction must roll back new node',officeId:'room',idempotencyKey:'eviction-locked',related:[{memoryId:hub.id,score:0.95,...basis}]},'worker','scope_denied');
  assert.equal((await connections(hub.id)).total,6);assert((await connections(hub.id)).connections.some((r:any)=>r.neighbor.id===leaves[0].id));
  assert(!(await graph.listNodes({operatorAll:true,limit:100})).nodes.some(n=>n.content==='Eviction must roll back new node'));
  const stronger=await save('Human approved stronger hub neighbour','stronger',{officeId:'room',related:[{memoryId:hub.id,score:0.95,...basis}]},'human-chat');
  assert.equal(stronger.edgesEvicted,1);assert.equal((await connections(hub.id)).total,6);assert(!(await connections(hub.id)).connections.some((r:any)=>r.neighbor.id===leaves[0].id));
  await denied('memory_save',{content:'Seven neighbours must not commit',officeId:'room',idempotencyKey:'seven',related:[...leaves,stronger].map(n=>({memoryId:n.id,score:0.95,...basis}))},'human-chat','invalid_input');
  console.log('PASS six-neighbour cap, protected eviction and atomic failed saves');

  // Pause a handler after resolving membership IDs but before the writer begins.
  const first=await save('Race office endpoint one','race-a',{officeId:'room'}),second=await save('Race office endpoint two','race-b',{officeId:'room'});
  const originalUpsert=graph.upsertAssociation;
  async function race(change:()=>Promise<unknown>){
    let enter!:()=>void,release!:()=>void;
    const entered=new Promise<void>(r=>enter=r),blocked=new Promise<void>(r=>release=r);
    graph.upsertAssociation=async(...args)=>{enter();await blocked;return originalUpsert.apply(graph,args);};
    const pending=raw('memory_association_upsert',{memberAId:first.memberships[0].id,memberBId:second.memberships[0].id,weight:0.8,...basis});
    try{await entered;await change();}finally{release();graph.upsertAssociation=originalUpsert;}
    assert((await pending).isError,'Writer must recheck current lock and office membership');
    assert.equal((await graph.listAssociations(first.id)).length,0);
  }
  await race(()=>graph.memoryOwners.setPolicy(second.id,true,0));
  await graph.memoryOwners.setPolicy(second.id,false,1);
  await race(()=>graph.roles.configureOffice({id:'room',title:'Fixture office',state:'active',expectedRevision:1,seats:[seats[1]]},admin));
  await denied('memory_connections',{nodeId:shared.id},'worker','scope_denied');
  await denied('memory_association_get',{id:sharedEdge.id},'worker','not_found');
  assert.equal((await connections(seed.id)).total,1,'private graph survives office reassignment');
  await call('memory_association_delete',{id:edge.id,reason:'Verified obsolete relationship'});
  assert.equal((await connections(seed.id)).total,0);assert(!(await ripple()).some(r=>r.node.id===linked.id));
  await denied('memory_association_get',{id:edge.id},'worker','not_found');
  await call('memory_update',{nodeId:seed.id,expectedUpdatedAt:(await get(seed.id)).updatedAt,anchors:[{text:'Environment recovery',basis:'verified environment procedure',spaceId:'memory',memoryType:type}],reason:'Verified additional recall entrance'});
  assert.equal((await get(seed.id)).anchors[0].text,'Environment recovery');
  for(const [name,args] of [
    ['memory_connections',{nodeId:seed.id}],['memory_association_get',{id:otherEdge.id}],
    ['memory_association_upsert',{memberAId:seed.memberships[0].id,memberBId:linked.memberships[0].id,weight:0.9,...basis}],
    ['memory_association_review',{id:otherEdge.id,evidenceId:'unknown',decision:'retire',reason:'No identity',expectedUpdatedAt:0}],
    ['memory_association_delete',{id:otherEdge.id,reason:'No identity'}]
  ] as const)await denied(name,args,null,'identity_required');
  assert.equal((await (graph as any).db.get('PRAGMA quick_check')).quick_check,'ok');
  console.log('PASS writer-time locking/reassignment, hard deletion, missing-identity rejection and SQLite integrity');
} finally {
  embedding.generateEmbedding=originalEmbedding;
  await client.close();await service.close();await graph.close();await fs.rm(dir,{recursive:true,force:true});
}
