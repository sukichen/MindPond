/** A05 core contract: synthetic extraction/profile proposals, no live model claims. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GraphMemory } from '../src/core/graph-memory.js';
import { MemoryPipelineManager } from '../src/core/memory-pipeline.js';
import { prepareLifecycleEvent, type LifecycleEvent } from '../src/core/lifecycle.js';
import { getEmbeddingService } from '../src/core/embedding.js';
import { hostOperations } from '../src/core/host-contract.js';

const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-lifecycle-'));
process.env.EMBEDDING_ZH_ENABLED='false';
const embedding=getEmbeddingService(), generate=embedding.generateEmbedding;
embedding.generateEmbedding=async()=>[1,...Array(383).fill(0)];
const dbPath=path.join(temp,'pond.db');
let g=new GraphMemory('.',{dbPath}), pipeline:MemoryPipelineManager|undefined;
const scope={spaceId:'example/review',memoryType:'fact'};
const sessionId='review-session', domain={kind:'session' as const,id:sessionId};
const context={sessionId,domains:[domain]};
const event:LifecycleEvent={kind:'before_compact',hostId:'fixture-host',runId:'review-1',checkpointId:'checkpoint-1',sessionId,...scope,observations:[
  {id:'routing',content:'Routing module review: development requests use the local proxy. Production routing was not reviewed.',sourceRefs:[{uri:'repo:router.ts',context:'main',revision:'r1',fingerprint:'router-r1'}]},
  {id:'storage',content:'Storage module review: local writes are transactional. Cross-process race behavior is unverified.',sourceRefs:[{uri:'repo:storage.ts',context:'main',revision:'r1',fingerprint:'storage-r1'}]},
]};
try {
  await g.init();
  const changes=async()=>(await (g as any).db.get('SELECT total_changes() AS n')).n;
  const before=await changes();
  const start=await prepareLifecycleEvent(g,{...event,kind:'start',observations:[]});
  assert.equal(start.state,'search_required');
  assert.equal((start as any).next.arguments.sessionId,sessionId);
  assert.equal((await prepareLifecycleEvent(g,{...event,observations:[]})).state,'review_required');
  assert.equal((await prepareLifecycleEvent(g,{...event,origin:'maintenance'})).state,'ignored');
  assert.equal((await prepareLifecycleEvent(g,{...event,toolName:'memory_save'})).state,'ignored');
  assert.equal(await changes(),before,'advice and recursion exclusions must not write');
  const captured=await prepareLifecycleEvent(g,event);
  assert.equal(captured.state,'deferred');
  assert.equal((await g.getNodesByLayer('L1',20)).length,0,'pending observations are not facts');
  assert.deepEqual(await prepareLifecycleEvent(g,{...event,observations:[...event.observations!].reverse()}),captured);
  await assert.rejects(prepareLifecycleEvent(g,{...event,observations:[{...event.observations![0],content:'Changed observation'}]}),/idempotency_conflict/);
  await assert.rejects(prepareLifecycleEvent(g,{...event,sessionId:undefined}),/sessionId/);
  console.log('PASS lifecycle advice, recursion exclusion, atomic session capture and stable event retry');

  await g.close();g=new GraphMemory('.',{dbPath});await g.init();
  assert.deepEqual(await prepareLifecycleEvent(g,event),captured,'restart/handoff replays original event IDs');
  pipeline=new MemoryPipelineManager(g);
  assert.equal(await pipeline.getExtractionJob({sessionId:'another-session'}),null);
  assert.equal(await pipeline.getExtractionJob({domains:[]}),null);
  const job=await pipeline.getExtractionJob(context);assert(job);
  assert.equal(job.id,(captured as any).extractionJobId);
  assert.match(job.prompt,/source_observation_ids/);assert.match(job.prompt,/Production routing was not reviewed/);
  assert.equal(job.captureContext!.spaceId,scope.spaceId);
  await assert.rejects(pipeline.commitExtraction(job.id,'{"memories":[]}',job.attempts,{sessionId:'another-session'}),/outside the trusted context/);
  assert(await g.getLeasedExtractionJob(job.id),'foreign rejection cannot release owner lease');
  const memories=event.observations!.map(o=>({content:o.content,type:'fact',dimensions:['fact'],priority:6,source_message_ids:['msg-0'],source_observation_ids:[o.id]}));
  await assert.rejects(pipeline.commitExtraction(job.id,JSON.stringify({memories:[memories[0],{...memories[1],source_observation_ids:['invented']}]}),job.attempts,context),/source_observation_ids/);
  assert.equal((await g.getNodesByLayer('L1',20)).length,0,'invalid second source cannot partially commit first');
  const reply=JSON.stringify({memories});
  const receipt=await pipeline.commitExtraction(job.id,reply,job.attempts,context);
  assert.equal(receipt.atomsCreated,2);
  assert.deepEqual(await pipeline.commitExtraction(job.id,reply,job.attempts,context),receipt);
  const nodes=await g.getNodesByLayer('L1',20);
  assert.equal(nodes.length,2);
  for(const o of event.observations!) {
    const node=nodes.find(n=>n.content===o.content)!;assert(node);
    const detail=(await g.getNodeById(node.id,{trackAccess:false}))!;
    assert.deepEqual(detail.sourceRefs,o.sourceRefs);
    assert.deepEqual(detail.domain,domain);
    assert.deepEqual((await g.getMemberships(node.id)).map(m=>({spaceId:m.spaceId,memoryType:m.memoryType})),[scope]);
    await g.observeSource({...o.sourceRefs![0],status:'present',expectedVersion:0});
  }
  console.log('PASS restart extraction, scoped claim/commit, evidence binding, atomic rejection and receipt recovery');

  const ids=await Promise.all(nodes.map(async n=>(await g.getMemberships(n.id))[0].id));
  const org=await g.claimOrganizationJob({...scope,domain,sessionId,membershipIds:ids});assert(org);
  const profileReceipt=await g.commitOrganizationPlan(org.id,{operations:[{kind:'synthesize',membershipIds:ids,
    content:'Reviewed local routing and storage responsibilities. Production routing and cross-process races remain unverified.',reason:'Both observations support a partial workflow profile.',
    profile:{title:'Local workflow review',coverage:['Local routing','Local storage'],unknowns:['Production routing','Cross-process races']},
    supports:ids.map(id=>({membershipId:id,claim:'Supports one reviewed local module responsibility',context:'main r1, local review only'}))}]});
  const profileId=(await g.getMemberships(profileReceipt.createdMemoryIds[0]))[0].id;
  const view=await g.getProfile(profileId,{context});
  assert.equal(view.supports.length,2);assert.equal(view.freshness.status,'checked');
  assert.equal((await g.getNodesByLayer('L1',20)).filter(n=>nodes.some(old=>old.id===n.id)).length,2);
  await g.observeSource({...event.observations![0].sourceRefs![0],revision:'r2',fingerprint:'router-r2',status:'present',expectedVersion:1});
  assert.equal((await g.getProfile(profileId,{context})).freshness.status,'needs_review');
  console.log('PASS captured module evidence feeds non-destructive profile; source changes require review, not a false verdict');

  const closing=await prepareLifecycleEvent(g,{...event,checkpointId:'checkpoint-2'});
  const closingJob=await pipeline.getExtractionJob(context);assert.equal(closingJob!.id,(closing as any).extractionJobId);
  await g.setSessionState(sessionId,'closed');
  await assert.rejects(pipeline.commitExtraction(closingJob!.id,reply,closingJob!.attempts,context),/closed/);
  await assert.rejects(g.commitExtractedMemories(closingJob!.id,[],closingJob!.attempts),/closed/);
  assert.equal(await pipeline.getExtractionJob(context),null);
  assert(hostOperations(g).some(op=>op.name==='memory_lifecycle_policy'));
  console.log('PASS session closure fences pending lifecycle commits and claims');
} finally {pipeline?.stop();await pipeline?.drain();await g.close();embedding.generateEmbedding=generate;await fs.rm(temp,{recursive:true,force:true});}
