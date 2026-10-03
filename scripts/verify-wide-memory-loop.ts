/** Real SQLite paths: old-vector coverage, >5000 lexical matches, scoped scenes,
 * one-call stage receipts, optimistic edits and durable partial failures. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { GraphMemory } from '../src/core/graph-memory.js';
import { getEmbeddingService } from '../src/core/embedding.js';
import { hostOperations } from '../src/core/host-contract.js';
import { HostSessionService } from '../src/integrations/host-session.js';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-wide-loop-'));
process.env.MEMORY_DB_PATH=path.join(temp,'graph.db');
const embedding=getEmbeddingService(),original=embedding.generateEmbedding;
const vector=[1,...Array(383).fill(0)];embedding.generateEmbedding=async()=>vector;
const graph=new GraphMemory();
try {
  await graph.init();
  const domain={kind:'personal' as const,id:'default'},context={sessionId:'native-a',domains:[domain,{kind:'session' as const,id:'native-a'}]};
  const oldest=await graph.saveMemory('Old but independently useful architecture explanation.',{domain,memberships:[{spaceId:'wide',memoryType:'fact'}]});
  const db=(graph as any).db;
  const other=Buffer.from(new Float32Array([0,1,...Array(382).fill(0)]).buffer);
  const start=performance.now();
  await db.exec('BEGIN IMMEDIATE');
  for(let i=0;i<10050;i++){
    await db.run("INSERT INTO nodes(id,dimension,layer,content,embedding,importance,tags,domain_kind,domain_id,created_at,updated_at) VALUES (?,'fact','L1',?, ?,5,'[]','personal','default',1,1)",['filler-'+i,'sharedneedle lower relevance filler '+i,other]);
    await db.run("INSERT INTO memory_memberships(id,memory_id,space_id,memory_type,active,version,created_at,updated_at) VALUES (?,?,'wide','fact',1,1,1,1)",['member-'+i,'filler-'+i]);
  }
  await db.run("UPDATE memory_meta SET value=CAST(value AS INTEGER)+1 WHERE key='index_generation'");await db.exec('COMMIT');
  const vectorHit=await graph.search({query:'Old explanation',embedding:vector,spaceId:'wide',limit:1,maxDepth:0});
  assert.equal(vectorHit[0]?.node.id,oldest.id,'oldest vector must remain searchable beyond 10k newer records');
  assert.equal(graph.retrievalCoverage().indexedVectors,10051);
  const late=await graph.saveMemory('sharedneedle uniqueneedle '+('Detailed procedure, prerequisites, exceptions and a question? '.repeat(30)),{domain,memberships:[{spaceId:'wide',memoryType:'fact'}]});
  embedding.generateEmbedding=async()=>[];
  const lexical=await graph.search({query:'sharedneedle uniqueneedle',spaceId:'wide',limit:1,maxDepth:0});
  assert.equal(lexical[0]?.node.id,late.id,'best lexical match after 5000 partial matches must win; rich/question bodies are not penalized');
  const fts=(graph as any).textIndexReady;(graph as any).textIndexReady=false;
  const fallback=await graph.search({query:'sharedneedle uniqueneedle',spaceId:'wide',limit:1,maxDepth:0});
  assert.equal(fallback[0]?.node.id,late.id,'FTS-independent fallback must preserve coverage');(graph as any).textIndexReady=fts;
  const scope=[{spaceId:'workflow',memoryType:'fact'}];
  const a=await graph.saveMemory('Alpha environment cause remains provisional: observed ECONNREFUSED, next check is bind address.',{domain,memberships:scope});
  const b=await graph.saveMemory('Beta project accepts deterministic receipt IDs.',{domain,memberships:scope});
  const brief=await graph.taskBrief('Review environment',{...context,query:'Alpha',queries:['Beta'],includeDirectory:true,limit:2,candidateLimit:20,contextBudgetBytes:12000,runId:'run',hostId:'host'});
  assert.deepEqual(new Set(brief.results.map(r=>r.id)),new Set([a.id,b.id]));
  assert(brief.directory?.groups.some(g=>g.spaceId==='workflow'));
  const before=await graph.getNodeById(a.id,{trackAccess:false,context});assert(before);
  const stage={...context,hostId:'host',runId:'run',stageId:'stage-1',operations:[
    {id:'save',kind:'save' as const,input:{content:'Gamma fix is provisional until tested with actual proxy configuration.',domain,memberships:scope}},
    {id:'edit',kind:'update' as const,nodeId:a.id,input:{content:before.content+' Observed local proxy binds loopback; production deployment not checked.',expectedUpdatedAt:before.updatedAt,reason:'Include newly inspected bind condition'}},
    {id:'adoption',kind:'use_report' as const,input:{recallId:brief.recallId,task:'Review environment',outcome:'partial' as const,observations:[{memoryId:a.id,disposition:'used' as const,reason:'Identified the next environment check',context:'Debugging ECONNREFUSED'}]}},
    {id:'denied',kind:'save' as const,input:{content:'Forbidden unrelated personal identity',domain:{kind:'personal' as const,id:'foreign'}}},
  ]};
  const first=await graph.finishMemoryStage(stage);assert.equal(first.status,'partial');
  assert.deepEqual(first.receipts.map(r=>r.status),['completed','completed','completed','failed']);
  assert.deepEqual(await graph.finishMemoryStage(stage),first,'retry after lost reply must reproduce completed save/edit/use receipts');
  await assert.rejects(graph.finishMemoryStage({...stage,operations:[]}),/idempotency_conflict/);
  const history=await graph.memoryHistory(a.id,context);assert(history.log.some(r=>r.action==='node_updated'));assert.equal(history.editHistory.length,1);assert(history.summary);assert(!('before' in history.editHistory[0]));const fullHistory=await graph.memoryHistory(a.id,context,undefined,3,true);assert(fullHistory.editHistory?.[0].before);
  const exported=await graph.exportMemory(context,{limit:2,maxBytes:500000});
  assert.equal(exported.memories.length,2);assert(exported.nextCursor);
  assert(exported.markdown.includes('Source references:'));assert(exported.memories.every(m=>m.updatedAt>0));
  const nextExport=await graph.exportMemory(context,{limit:2,afterId:exported.nextCursor!});
  assert(!nextExport.memories.some(m=>exported.memories.some(previous=>previous.id===m.id)), 'export cursor must not repeat IDs');
  const long=await graph.saveMemory('Very long valid body '+('conditions and exceptions '.repeat(200)),{domain,memberships:scope});
  await assert.rejects(graph.exportMemory(context,{afterId:long.id.slice(0,-1)+String.fromCharCode(long.id.charCodeAt(long.id.length-1)-1),maxBytes:1024,limit:1}),/budget/);
  const freshEdit=await graph.getNodeById(a.id,{trackAccess:false,context});assert(freshEdit);
  await graph.editMemory(a.id,{content:freshEdit.content+' Later independent revision.',expectedUpdatedAt:freshEdit.updatedAt,context,reason:'Verify old receipt never overwrites a later revision'});
  const replay=await graph.finishMemoryStage(stage);assert.deepEqual(replay.receipts,first.receipts);
  assert((await graph.getNodeById(a.id,{trackAccess:false,context}))!.content.endsWith('Later independent revision.'));
  const peer=new GraphMemory();await peer.init();
  try {
    const concurrent={...context,hostId:'host',runId:'concurrent',stageId:'shared-stage',operations:[{id:'save',kind:'save' as const,input:{content:'Concurrent stage retry is one memory',domain,memberships:scope}}]};
    const [left,right]=await Promise.all([graph.finishMemoryStage(concurrent),peer.finishMemoryStage(concurrent)]);
    assert.deepEqual(left,right,'different DB connections must share stage and per-item receipts');
  }finally{await peer.close();}

  await graph.ingestTranscript('Original scene: user says Alpha proxy ECONNREFUSED on localhost. The assistant proposes checking the bind address.', 'native-a','scene-1');
  await graph.ingestTranscript('PRIVATE OTHER SESSION Alpha proxy', 'native-b','scene-2');
  const events=await graph.eventRecall({...context,query:'Alpha proxy',limit:10});
  assert(events.results.some(r=>r.node.content.includes('Original scene')));assert(!JSON.stringify(events).includes('PRIVATE OTHER'));assert(events.results.every(r=>r.depth===0 && (r.node.kind==='event'||r.node.layer==='L0')));
  const service=new HostSessionService(graph,[domain],'test-native-host');
  await assert.rejects(service.call('native-a','memory_event_search',{query:'Alpha',sessionId:'native-b'}),/outside the trusted context/);
  await assert.rejects(service.call('native-a','memory_history',{nodeId:a.id,domains:[{kind:'personal',id:'foreign'}]}),/outside/);
  const ops=new Map(hostOperations(graph).map(op=>[op.name,op]));
  const op=ops.get('memory_finish')!;
  assert.throws(()=>op.schema.parse({...stage,operations:[{id:'bad',kind:'update',nodeId:a.id,input:{expectedUpdatedAt:1,reason:'widen',context:{domains:[{kind:'personal',id:'foreign'}]}}}]}),'nested context is not accepted');
  await graph.setSessionState('native-a','closed');
  assert(!(await graph.memoryDirectory(context)).groups.some(g=>g.domainKind==='session'));
  assert.equal((await graph.eventRecall({...context,query:'Original scene'})).results.length,0);
  console.log(JSON.stringify({status:'PASS',records:10051,elapsedMs:Math.round(performance.now()-start),coverage:graph.retrievalCoverage(),rssMb:Math.round(process.memoryUsage().rss/1048576)}));
} finally {await graph.close();embedding.generateEmbedding=original;await fs.rm(temp,{recursive:true,force:true});}
