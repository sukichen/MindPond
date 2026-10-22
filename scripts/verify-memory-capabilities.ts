/** Actual HTTP Memory calls, complete capability accounting and runtime
 * semantics. A healthy library-only test is not a usable agent interface. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {GraphMemory} from '../src/core/graph-memory.js';
import {getEmbeddingService} from '../src/core/embedding.js';
import {roleRuntimeId} from '../src/core/roles.js';
import {createMemoryMcpServer} from '../src/mcp-service.js';
import {createNetworkMcpApp} from '../src/integrations/network-server.js';
import {tokenDigest} from '../src/integrations/network-config.js';
import {MEMORY_CAPABILITY_CONTRACT} from '../src/core/memory-capability-contract.js';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-capabilities-'));
const graph=new GraphMemory('.',{dbPath:path.join(dir,'fixture.db')});
const embedding=getEmbeddingService(),originalEmbedding=embedding.generateEmbedding;
embedding.generateEmbedding=async()=>[1,...Array(383).fill(0)];
const admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const clients:Client[]=[];let http:any,network:any,library:any;
try{
 await graph.init();await graph.offices.configureAgent({id:'host',principal:'human',name:'Fixture Codex',host:'codex',state:'active',expectedRevision:0},admin);
 const roles=[];
 for(const chat of ['worker','other']){
  const actor={...admin,operator:false,agentId:'host',transport:'http-mcp' as const,runtimeId:roleRuntimeId('human','host','codex',chat)};
  const app=await graph.roles.application({action:'submit',name:chat,introduction:'Fictional capability reviewer',reason:'Public API regression',key:'apply'},actor);
  roles.push(await graph.roles.review({action:'approve',applicationId:app.applicationId,expectedRevision:1},admin));
 }
 const seats=roles.map((r,i)=>({id:'seat-'+i,roleId:r.roleId,label:'Member '+i,role:'member'}));
 await graph.roles.configureOffice({id:'room',title:'Fixture room',state:'active',expectedRevision:0,seats},admin);
 const token=('fixture-'+ 'c'.repeat(40)).slice(0,43);
 const configuration=async()=>({version:2 as const,grants:[{principal:'human',agentId:'host',credentialId:'fixture',tokenHash:tokenDigest(token),domains:[{kind:'personal' as const,id:'default'}],toolProfile:'work' as const}]});
 network=createNetworkMcpApp(graph,{configuration,allowedHosts:['127.0.0.1']});http=network.app.listen(0,'127.0.0.1');await new Promise<void>(r=>http.once('listening',r));
 const port=http.address().port;await network.close();await new Promise<void>(r=>http.close(r));
 network=createNetworkMcpApp(graph,{configuration,allowedHosts:['127.0.0.1:'+port]});http=network.app.listen(port,'127.0.0.1');await new Promise<void>(r=>http.once('listening',r));
 const client=new Client({name:'capability-fixture',version:'1'});clients.push(client);
 await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+port+'/memory/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
 const raw=(name:string,args:any={},chat='worker')=>client.callTool({name,arguments:args,_meta:{threadId:chat}});
 const call=async(name:string,args:any={},chat='worker')=>{const r:any=await raw(name,args,chat);assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
 const denied=async(name:string,args:any,code?:string,chat='worker')=>{const r:any=await raw(name,args,chat);assert(r.isError,'Expected denial for '+name);const d=JSON.parse(r.content[0].text);if(code)assert.equal(d.error.code,code,JSON.stringify(d));return d;};
 const action=(tool:string,args:any={},chat='worker')=>call('memory_action',{tool,arguments:args},chat);
 const failAction=(tool:string,args:any,code?:string,chat='worker')=>denied('memory_action',{tool,arguments:args},code,chat);
 const catalog=await call('memory_capabilities');
 const available=new Set([...catalog.directTools,...catalog.actions.map((a:any)=>a.name)]);
 const required=new Set(MEMORY_CAPABILITY_CONTRACT.flatMap(f=>[...f.public]));
 for(const name of required)assert(available.has(name),'Missing layered capability: '+name);
 for(const name of available)if(!required.has(name))assert.fail('Unaccounted public capability: '+name);
 // Compare against the real library catalog. New internal features cannot be
 // silently lost at the public boundary without updating this decision table.
 library=createMemoryMcpServer(graph,{toolProfile:'full'});const legacy=new Client({name:'library-catalog',version:'1'});clients.push(legacy);
 const [x,y]=InMemoryTransport.createLinkedPair();await Promise.all([library.server.connect(x),legacy.connect(y)]);
 const old=(await legacy.listTools()).tools.filter(t=>t.name.startsWith('memory_')).map(t=>t.name);
 const accounted=MEMORY_CAPABILITY_CONTRACT.flatMap(f=>[...f.library]);
 assert.equal(new Set(accounted).size,accounted.length,'A capability needs one explicit classification');
 assert.deepEqual([...old].sort(),accounted.sort(),'Every library tool must be restored/replaced or explicitly bounded');
 for(const name of available){
  if(name==='memory_action')continue;
  const described=await call('memory_action',{tool:name,describe:true});
  assert(described.inputSchema&&described.description,name);
  for(const forbidden of ['roleId','ownerId','domain','domains','sessionId','workspace'])assert(!(forbidden in described.inputSchema.properties),name+' exposes '+forbidden);
 }
 await failAction('not_a_tool',{},'invalid_input');await failAction('memory_action',{},'invalid_input');
 const searchSchema=await call('memory_action',{tool:'memory_search',describe:true});
 for(const field of ['queries','maxDepth','minScore','useAnchors','sourceContext','retrievalProfile','reranker','vectorAlgorithm','candidateLimit','dimension'])assert(field in searchSchema.inputSchema.properties,field);
 console.log('PASS real HTTP progressive discovery, schema coverage and complete library-to-layered capability accounting');

 const save=(content:string,key:string,extra:any={},chat='worker')=>call('memory_save',{content,idempotencyKey:key,...extra},chat);
 const get=(nodeId:string,chat='worker')=>call('memory_get',{nodeId},chat);
 const source={uri:'fixture:repo/config',context:'verified fixture checkout',revision:'v1',fingerprint:'hash-v1'};
 const a=await save('Capability source A: verified fixture environment procedure','a',{sourceRefs:[source]});
 const b=await save('Capability source B: complementary verified fixture command','b',{sourceRefs:[source]});
 const foreign=await save('Private other role source with identical URI','other',{sourceRefs:[source]},'other');
 const shared=await save('Shared fixture office rule','shared',{officeId:'room',sourceRefs:[source]});
 const before=await graph.listNodes({operatorAll:true});
 const preview=await action('memory_save_validate',{content:'Independent useful preview',related:[{memoryId:a.id,score:0.8,reason:'Verified workflow',context:'Fixture environment only'}]});
 assert(preview.valid);assert.equal((await graph.listNodes({operatorAll:true})).total,before.total);
 const newPlacement=await action('memory_membership_add',{nodeId:a.id,spaceId:'independent-perspective',memoryType:(await graph.getDimensionPolicy()).defaultDimension});
 assert.equal(newPlacement.membership.memoryId,a.id);assert.equal((await graph.listNodes({operatorAll:true})).total,before.total);
 const graphView=await action('memory_host_snapshot',{view:'graph',limit:100});assert(graphView.nodes.every((n:any)=>n.id!==foreign.id));
 const scopes=await action('memory_spaces');assert(scopes.some((s:any)=>s.spaceId==='independent-perspective'));
 await denied('memory_search',{query:'fixture',retrievalProfile:'missing-profile'},'invalid_input');
 const recalled=await call('memory_search',{query:'Capability source',queries:['verified fixture'],maxDepth:0,useAnchors:false,retrievalProfile:'legacy',candidateLimit:20,limit:20});
 assert(recalled.results.every((r:any)=>r.depth===0));assert(!recalled.results.some((r:any)=>r.id===foreign.id));
 const used=await call('memory_use_report',{reportId:'actual-use',recallId:recalled.recallId,task:'Verify public feedback loop',outcome:'completed',observations:[
  {memoryId:a.id,disposition:'used',reason:'Applied the verified environment procedure',issue:'missing_anchor',context:'A distinct query phrase needs review',sourceRefs:[source]},
  {memoryId:b.id,disposition:'used',reason:'Applied the complementary command'}],
  coUses:[{memoryIds:[a.id,b.id],spaceId:'memory',memoryType:a.memberships[0].memoryType,reason:'Both were actually needed',context:'The tested fixture environment'}]});
 assert.equal(used.signals.length,2);assert.equal((await call('memory_connections',{nodeId:a.id})).total,0,'Feedback cannot silently create graph edges');
 const signals=await action('memory_improvement_list');assert.equal(signals.signals.length,2);
 assert.equal((await action('memory_improvement_list',{},'other')).signals.length,0);
 await action('memory_improvement_resolve',{signalId:signals.signals[0].id,status:'reviewed',reason:'Checked actual evidence'});
 await failAction('memory_improvement_resolve',{signalId:signals.signals[1].id,status:'dismissed',reason:'Must not cross roles'},undefined,'other');
 assert.equal((await action('memory_improvement_list',{},'human')).signals.length,1,'Human sees all owners’ remaining suggestions');
 console.log('PASS retrieval controls, non-writing preview, independent memberships and completed feedback/correction/co-use loop');

 assert.equal((await action('memory_source_get',{nodeId:a.id,uri:source.uri,context:source.context})).version,0);
 await action('memory_source_observe',{nodeId:a.id,...source,revision:'v2',fingerprint:'hash-v2',status:'present',expectedVersion:0});
 assert.equal((await action('memory_source_get',{nodeId:a.id,uri:source.uri,context:source.context})).version,1);
 assert.equal((await action('memory_source_get',{nodeId:foreign.id,uri:source.uri,context:source.context},'other')).version,0);
 assert.equal((await graph.getMemoryFreshness(a.memberships[0].id)).status,'needs_review');
 assert.equal((await graph.getMemoryFreshness(foreign.memberships[0].id)).status,'unknown');
 await action('memory_source_observe',{nodeId:foreign.id,...source,status:'present',expectedVersion:0},'other');
 assert.equal((await graph.getMemoryFreshness(foreign.memberships[0].id)).status,'checked');
 await failAction('memory_source_get',{nodeId:a.id,uri:'fixture:unread-source',context:source.context},'invalid_input');
 await failAction('memory_source_get',{nodeId:foreign.id,uri:source.uri,context:source.context},'scope_denied');
 const editing=await save('Original history fixture','history');const oldNode=await get(editing.id);
 await call('memory_update',{nodeId:editing.id,expectedUpdatedAt:oldNode.updatedAt,content:'Updated history fixture',reason:'Verified actual source'});
 await denied('memory_update',{nodeId:editing.id,expectedUpdatedAt:oldNode.updatedAt,content:'Stale edit must not commit',reason:'Stale version fixture'},'stale_version');
 const history=await action('memory_edit_history',{nodeId:editing.id});assert.equal(history.length,1);
 assert((await action('memory_history',{nodeId:editing.id})).editHistory.length);
 await action('memory_edit_restore',{nodeId:editing.id,revisionId:history[0].id,expectedUpdatedAt:(await get(editing.id)).updatedAt,reason:'Restore unchanged latest edit'});
 assert.equal((await get(editing.id)).content,'Original history fixture');
 const exported=await action('memory_export',{limit:50});assert(exported.memories.some((n:any)=>n.id===a.id));assert(!exported.memories.some((n:any)=>n.id===foreign.id));
 assert((await action('memory_export',{limit:50},'human')).memories.some((n:any)=>n.id===foreign.id));
 console.log('PASS source observations/freshness isolated per owner, optimistic edit errors, history/undo and scoped Markdown export');

 const locked=await graph.memoryOwners.setPolicy(shared.id,true,0);
 const stage={stageId:'milestone',operations:[
  {id:'save',kind:'save',input:{content:'Durable milestone knowledge'}},
  {id:'office',kind:'save',input:{officeId:'room',content:'Blocked publication linked to a protected rule',related:[{memoryId:shared.id,score:0.8,reason:'Must respect lock',context:'Locked fixture rule'}]}},
  {id:'edit',kind:'update',nodeId:editing.id,input:{content:'Milestone revision',expectedUpdatedAt:(await get(editing.id)).updatedAt,reason:'Milestone verification'}}
 ]};
 const finish=await action('memory_finish',stage);assert.equal(finish.status,'partial');assert.deepEqual(finish.receipts.map((r:any)=>r.status),['completed','failed','completed']);
 const retry=await action('memory_finish',stage);assert.equal(retry.receipts[0].receipt.id,finish.receipts[0].receipt.id);assert.equal((await get(editing.id)).content,'Milestone revision');
 await failAction('memory_finish',{...stage,operations:[{id:'changed',kind:'save',input:{content:'Changed stage payload'}}]},'idempotency_conflict');
 await failAction('memory_finish',{stageId:'spoof',operations:[{id:'save',kind:'save',input:{content:'Must not write',domain:{kind:'personal',id:'default'}}}]},'invalid_input');
 await graph.memoryOwners.setPolicy(shared.id,false,locked.revision);
 const officeStage={stageId:'office-milestone',operations:[{id:'save',kind:'save',input:{content:'Shared stage knowledge',officeId:'room'}}]};
 assert.equal((await action('memory_finish',officeStage)).status,'completed');
 console.log('PASS milestone partial receipts, exact replay/CAS, changed-payload rejection and nested identity-selector rejection');

 const claim=await action('memory_organization_claim',{membershipIds:[a.memberships[0].id,b.memberships[0].id]});assert(claim.job&&claim.prompt);
 await failAction('memory_organization_renew',{jobId:claim.job.id},'scope_denied','other');
 const plan={operations:[{kind:'associate',membershipIds:[a.memberships[0].id,b.memberships[0].id],weight:0.75,reason:'Verified complementary skills',context:'Tested fixture runtime only'}]};
 assert((await action('memory_organization_validate',{jobId:claim.job.id,plan})).valid);
 await action('memory_organization_commit',{jobId:claim.job.id,plan});assert.equal((await call('memory_connections',{nodeId:a.id})).connections[0].weight,0.75);
 const synthesis=await action('memory_organization_claim',{membershipIds:[a.memberships[0].id,b.memberships[0].id]});
 const made=await action('memory_organization_commit',{jobId:synthesis.job.id,plan:{operations:[{kind:'synthesize',membershipIds:[a.memberships[0].id,b.memberships[0].id],content:'Supported fixture environment profile',reason:'Integrate complementary evidence without deleting sources',profile:{title:'Environment profile',coverage:['Verified environment procedure and command'],unknowns:['Other runtimes unverified']},supports:[a,b].map(n=>({membershipId:n.memberships[0].id,claim:'Supplies a verified step',context:'Fixture runtime'}))}]}});
 const profileNode=await get(made.createdMemoryIds[0]);const profile=await action('memory_profile_get',{membershipId:profileNode.memberships[0].id});assert.equal(profile.supports.length,2);
 assert((await action('memory_profile_history',{membershipId:profileNode.memberships[0].id})).length);
 assert.equal((await get(a.id)).id,a.id,'Synthesis preserves useful child knowledge');
 await failAction('memory_profile_get',{membershipId:profileNode.memberships[0].id},'scope_denied','other');
 const request=await action('memory_organization_request_start',{membershipId:editing.memberships[0].id,batchSize:1,limit:2,idempotencyKey:'pass'});
 assert.equal(request.total,2);assert((await action('memory_organization_requests')).some((r:any)=>r.requestId===request.requestId));
 await failAction('memory_organization_request_status',{requestId:request.requestId},'scope_denied','other');
 const batch=await action('memory_organization_request_next',{requestId:request.requestId});assert(batch.batch&&batch.task.prompt);
 await action('memory_organization_commit',{jobId:batch.batch.id,plan:{operations:batch.batch.members.map((m:any)=>({kind:'keep',membershipIds:[m.membership.id],reason:'Reviewed; no supported change'}))}});
 await action('memory_organization_request_report',{requestId:request.requestId,jobId:batch.batch.id,result:'committed'});
 const partial=await action('memory_organization_request_finish',{requestId:request.requestId,reason:'budget_exhausted'});assert.equal(partial.status,'partial');assert(partial.receipt.uncovered.length);
 assert((await action('memory_organization_request_events',{requestId:request.requestId})).events.length);
 console.log('PASS organization snapshots, safe synthesis/profile reads, durable request resume/report and honest partial coverage');

 // Revocation affects progressive actions and receipt replay on the SAME MCP.
 await graph.roles.configureOffice({id:'room',title:'Fixture room',state:'active',expectedRevision:1,seats:[seats[1]]},admin);
 await failAction('memory_source_get',{nodeId:shared.id,uri:source.uri,context:source.context},'scope_denied');
 const replay=await action('memory_finish',officeStage);assert.equal(replay.status,'partial');assert.equal(replay.receipts[0].status,'failed');
 assert.equal((await graph.getNodeById(finish.receipts[0].receipt.id))!.content,'Durable milestone knowledge');
 const identity=await call('memory_identity');assert.equal(identity.owner.id,roles[0].roleId);
 assert.equal((await (graph as any).db.get('PRAGMA quick_check')).quick_check,'ok');
 console.log('PASS office revocation fences advanced reads and cached milestone receipts; private knowledge and SQLite integrity retained');
}finally{
 embedding.generateEmbedding=originalEmbedding;
 for(const c of clients)await c.close();await library?.close();await network?.close();if(http)await new Promise<void>(r=>http.close(r));await graph.close();await fs.rm(dir,{recursive:true,force:true});
}
