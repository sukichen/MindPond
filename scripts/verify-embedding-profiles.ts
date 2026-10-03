import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {GraphMemory} from '../src/core/graph-memory.js';
import {getEmbeddingService} from '../src/core/embedding.js';
import {embeddingProfileSchema,embeddingRuntimeSchema,embeddingSpaceKey,retrievalConfigSchema} from '../src/core/embedding-profiles.js';
import {ProfileVectorIndex} from '../src/core/profile-vector-index.js';
import {LocalProfileEncoder,profileArtifactDigest} from '../src/core/profile-embedding.js';
import type {ProfileEncoder} from '../src/core/profile-embedding.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-profiles-'));
process.env.EMBEDDING_ZH_ENABLED='false';
const legacy=getEmbeddingService(),original=legacy.generateEmbedding;
legacy.generateEmbedding=async()=>[1,...Array(383).fill(0)];
const profile=embeddingProfileSchema.parse({id:'fixture',label:'Public fixture',model:'fixture/model',dimensions:3,pooling:'mean'});
const other={...profile,id:'other',model:'fixture/other',pooling:'cls' as const};
const runtime=embeddingRuntimeSchema.parse({});
assert.notEqual(embeddingSpaceKey(profile,'artifact-a'),embeddingSpaceKey(other,'artifact-a'));
assert.notEqual(embeddingSpaceKey(profile,'artifact-a'),embeddingSpaceKey(profile,'artifact-b'));
assert.notEqual(embeddingSpaceKey(profile,'artifact-a'),embeddingSpaceKey({...profile,queryPrefix:'query: '},'artifact-a'));
assert.equal(embeddingSpaceKey(profile,'artifact-a'),embeddingSpaceKey({...profile,label:'Different display name',id:'alias'},'artifact-a'));
assert.throws(()=>retrievalConfigSchema.parse({profiles:[{profile},{profile}]}));
let started!:()=>void,release!:()=>void,holding=false;
const entered=new Promise<void>(r=>started=r),blocked=new Promise<void>(r=>release=r);
const roles:string[]=[];let rankerFails=false;
const encoder:()=>ProfileEncoder=()=>({
 async encode(text,role){
  roles.push(role);
  if(holding&&role==='document'&&text==='Public slow original'){holding=false;started();await blocked;}
  const vector=text.includes('anchor-only')?[0,0,1]:text.includes('other')?[0,1,0]:[1,0,0];
  return {vectors:[vector],device:'cpu'};
 },async close(){},status(){return {actualDevice:'cpu'};},
});
const graph=new GraphMemory('.',{dbPath:path.join(dir,'fixture.db'),retrieval:{profiles:[{profile},{profile:other},{profile:{...profile,id:'same-model-gpu',label:'GPU alias'},runtime:{device:'auto'}}],rerankers:[{profile:{id:'fixture-rank',label:'Public rerank fixture',model:'fixture/reranker'}}]},retrievalDependencies:{artifactDigest:async()=> 'public-fixture-digest',encoder,rerank:async(_p,_query,documents)=>{if(rankerFails)throw new Error('Public reranker unavailable fixture');return documents.map(text=>text.includes('other')?10:0);}}});
try{
 await graph.init();
 const a=await graph.saveMemory('Public loopback binding constraint',{sessionId:'scope-a',memberships:[{spaceId:'project',memoryType:'fact'}]});
 const b=await graph.saveMemory('Public other body with supported constraint',{sessionId:'scope-a',memberships:[{spaceId:'project',memoryType:'fact'}],anchors:[{text:'anchor-only trigger',basis:'supported constraint',spaceId:'project',memoryType:'fact'}]});
 const foreign=await graph.saveMemory('Public loopback foreign session',{sessionId:'scope-b',memberships:[{spaceId:'project',memoryType:'fact'}]});
 const beforeGeneration=await (graph as any).db.get("SELECT value FROM memory_meta WHERE key='index_generation'");
 const partial=await graph.buildRetrievalProfile('fixture',1) as any;assert.equal(partial.coverage.remaining,3);
 await assert.rejects(graph.activateRetrievalProfile('fixture'),/not completely indexed/);
 await assert.rejects(graph.search({query:'loopback',retrievalProfile:'fixture'}),/pending vectors/);
 assert.equal((await graph.retrievalProfiles()).activeProfile,'legacy');
 const built=await graph.buildRetrievalProfile('fixture',64) as any;assert(built.coverage.complete);assert(roles.includes('document')&&roles.includes('anchor'));
 await graph.activateRetrievalProfile('fixture');
 assert.deepEqual(await (graph as any).db.get("SELECT value FROM memory_meta WHERE key='index_generation'"),beforeGeneration,'Building/activating a model space must not invalidate unrelated legacy indexes');
 const recalled=await graph.recall({query:'loopback',sessionId:'scope-a',spaceId:'project',retrievalProfile:'fixture',maxDepth:0});
 assert(recalled.results.some(hit=>hit.node.id===a.id));assert(!recalled.results.some(hit=>hit.node.id===foreign.id));
 assert.equal(recalled.retrieval?.profile?.selected,'fixture');assert.equal(recalled.retrieval?.degraded,false);
 const anchors=await graph.search({query:'anchor-only',sessionId:'scope-a',spaceId:'project',retrievalProfile:'fixture',maxDepth:0});
 assert(anchors.some(hit=>hit.node.id===b.id&&hit.matchedAnchors?.some(anchor=>anchor.channel==='anchor-profile')));
 await assert.rejects(graph.search({query:'loopback',retrievalProfile:'other'}),/pending vectors/);
 await graph.buildRetrievalProfile('other',64);
 const catalog=await graph.retrievalProfiles();assert.notEqual(catalog.profiles.find((p:any)=>p.id==='fixture')?.spaceKey,catalog.profiles.find((p:any)=>p.id==='other')?.spaceKey);
 const db=(graph as any).db;
 const spaces=await db.all('SELECT DISTINCT space_key FROM memory_profile_vectors');assert.equal(spaces.length,2);
 const source=await graph.getNodeById(a.id,{trackAccess:false});
 await graph.editMemory(a.id,{content:'Public corrected loopback constraint',expectedUpdatedAt:source!.updatedAt,context:{sessionId:'scope-a'},reason:'Public fixture correction'});
 assert.equal((await db.get("SELECT COUNT(*) n FROM memory_profile_vectors WHERE memory_id=?",[a.id])).n,0);
 const fallback=await graph.search({query:'loopback',sessionId:'scope-a'});assert.equal(fallback.retrieval?.profile?.selected,'legacy');assert(fallback.retrieval?.degraded);
 await graph.buildRetrievalProfile('fixture',64);
 const slow=await graph.saveMemory('Public slow original');holding=true;
 const build=graph.buildRetrievalProfile('fixture',64);await entered;
 await graph.editMemory(slow.id,{content:'Public other corrected body',context:{domains:[{kind:'personal',id:'default'}]},reason:'Edit while optional inference is in flight'});
 release();const raced=await build as any;assert.equal(raced.skipped,1);
 assert.equal((await db.get("SELECT COUNT(*) n FROM memory_profile_vectors WHERE memory_id=?",[slow.id])).n,0);
 await graph.buildRetrievalProfile('fixture',64);
 assert.equal((await graph.retrievalProfiles()).profiles.find((p:any)=>p.id==='fixture')?.coverage.complete,true);
 await graph.activateRetrievalProfile('same-model-gpu');assert.equal((await graph.retrievalProfiles()).activeProfile,'same-model-gpu');
 const peer=new GraphMemory('.',{dbPath:path.join(dir,'fixture.db'),retrieval:{profiles:[{profile},{profile:{...profile,id:'same-model-gpu',label:'GPU alias'},runtime:{device:'auto'}}]},retrievalDependencies:{artifactDigest:async()=> 'public-fixture-digest',encoder}});
 await peer.init();try{assert.equal((await peer.retrievalProfiles()).activeProfile,'same-model-gpu');assert.deepEqual(await (peer as any).profileRetrieval.startupProfiles(),['same-model-gpu']);const shared=await peer.search({query:'Public',sessionId:'scope-a'});assert.equal(shared.retrieval?.profile?.selected,'same-model-gpu');assert(shared.every(hit=>hit.node.id!==foreign.id));
 const later=await graph.saveMemory('Public durable finding after profile activation',{domain:{kind:'personal',id:'default'}});
 await assert.rejects(peer.search({query:'Public',retrievalProfile:'same-model-gpu'}),/pending vectors/);
 const deadline=Date.now()+12000;let complete=false;
 while(Date.now()<deadline){complete=!!(await peer.retrievalProfiles()).profiles.find((p:any)=>p.id==='same-model-gpu')?.coverage.complete;if(complete)break;await new Promise(r=>setTimeout(r,100));}
 assert(complete,'Persisted activated profile must resume background indexing on another host');
 assert((await peer.search({query:'durable finding',retrievalProfile:'same-model-gpu'})).some(hit=>hit.node.id===later.id));
 assert((await (graph as any).db.get("SELECT COUNT(*) n FROM memory_action_log WHERE action='embedding_profile_build'")).n>0);}finally{await peer.close();}
 const incompatible=new GraphMemory('.',{dbPath:path.join(dir,'fixture.db'),retrieval:{profiles:[{profile}]},retrievalDependencies:{artifactDigest:async()=> 'different-installed-artifact',encoder}});
 await incompatible.init();try{await assert.rejects(incompatible.search({query:'Public',retrievalProfile:'fixture'}),/pending vectors/);const fallback=await incompatible.search({query:'Public',sessionId:'scope-a'});assert.equal(fallback.retrieval?.profile?.selected,'legacy');assert.equal(fallback.retrieval?.profile?.fallbackReason,'active_profile_not_configured');}finally{await incompatible.close();}
 console.log('PASS shared DB activation survives another process; different artifact cannot reuse the same-width index');
 const aliasHits=await graph.search({query:'Public',sessionId:'scope-a'});assert.equal(aliasHits.retrieval?.profile?.selected,'same-model-gpu');
 await graph.activateRetrievalProfile('legacy');assert.equal((await graph.retrievalProfiles()).activeProfile,'legacy');
 const plain=await graph.recall({query:'Public',sessionId:'scope-a',reranker:'fixture-rank',limit:20,maxDepth:0,contextBudgetBytes:20000});
 assert.equal(plain.results[0].node.id,b.id);assert(plain.results.every(hit=>hit.node.id!==foreign.id));
 const withoutRank=await graph.search({query:'Public',sessionId:'scope-a',limit:20,maxDepth:0});
 assert.deepEqual(new Set(plain.results.map(hit=>hit.node.id)),new Set(withoutRank.map(hit=>hit.node.id)));
 assert(plain.results.every(hit=>hit.score===withoutRank.find(original=>original.node.id===hit.node.id)!.score));
 rankerFails=true;const rankFallback=await graph.search({query:'Public',sessionId:'scope-a',limit:20,maxDepth:0,reranker:'fixture-rank'});assert(rankFallback.retrieval?.degraded);assert(rankFallback.retrieval?.channels.some(channel=>channel.channel==='reranker'&&channel.status==='failed'));assert.deepEqual(rankFallback.map(hit=>[hit.node.id,hit.score]),withoutRank.map(hit=>[hit.node.id,hit.score]));
 await assert.rejects(graph.search({query:'missing text',reranker:'unknown'}),/Unknown reranker/);
 console.log('PASS optional reranking preserves candidate IDs, original ripple scores and domain boundaries with byte-budget assembly');
 assert(await graph.getNodeById(a.id,{trackAccess:false}));
 console.log('PASS model-space identity, bounded build/activation, anchor recall, session boundary, dirty-default fallback, edit CAS and legacy rollback');
}finally{release?.();await graph.close();legacy.generateEmbedding=original;}

const vectors=Array.from({length:200},(_,id)=>({id:String(id),ownerId:id<100?'allowed-'+id:'foreign-'+id,vector:[Math.sin(id+1),Math.cos(id+1),id/200]}));
const exact=new ProfileVectorIndex(),hnsw=new ProfileVectorIndex();
await exact.load(vectors,runtime);await hnsw.load(vectors,{...runtime,algorithm:'hnsw',efSearch:256});
const query=vectors[31].vector,allowed=new Set(vectors.slice(0,100).map(v=>v.ownerId));
const reference=exact.search(query,allowed,20,-1),approx=hnsw.search(query,allowed,20,-1);
assert(approx.every(hit=>allowed.has(hit.ownerId)));assert.equal(approx.length,20);
const referenceIds=new Set(reference.map(hit=>hit.id));assert(approx.filter(hit=>referenceIds.has(hit.id)).length>=18);
console.log('PASS optional HNSW scoped recall >= 90% versus exact; backend',JSON.stringify(hnsw.status()));
const chunks=[...Array.from({length:40},(_,i)=>({id:'long:'+i,ownerId:'long',vector:[1,0,0]})),{id:'short:0',ownerId:'short',vector:[.95,.3,0]}];
for(const algorithm of ['exact','hnsw'] as const){const index=new ProfileVectorIndex();await index.load(chunks,{...runtime,algorithm});assert.deepEqual(new Set(index.search([1,0,0],new Set(['long','short']),2,.3).map(hit=>hit.ownerId)),new Set(['long','short']));}
console.log('PASS long-memory chunks cannot starve other owners in exact or HNSW top-K');

const previousDir=process.env.EMBEDDING_MODEL_DIR;process.env.EMBEDDING_MODEL_DIR=path.join(dir,'missing');
const unavailable=new LocalProfileEncoder(profile,{...runtime,device:'cuda',timeoutMs:15000});
try{
 await assert.rejects(unavailable.encode('Public fixture','query'),/model_unavailable/);
 const status=unavailable.status();assert(status.attempts.some((attempt:any)=>attempt.device==='cuda'));assert(status.attempts.some((attempt:any)=>attempt.device==='cpu'));
 console.log('PASS worker failure is bounded; explicit CUDA and CPU fallback attempts are observable; no remote model download');
 const fakeModel=path.join(process.env.EMBEDDING_MODEL_DIR!,profile.model);await fs.mkdir(path.join(fakeModel,'onnx'),{recursive:true});await fs.writeFile(path.join(fakeModel,'onnx/model_quantized.onnx'),'public digest fixture, not executable');await fs.writeFile(path.join(fakeModel,'tokenizer.json'),'{}');
 const before=await profileArtifactDigest(profile);await fs.writeFile(path.join(fakeModel,'tokenizer.json'),'{"changed":true}');assert.notEqual(await profileArtifactDigest(profile),before);
 const changed=new LocalProfileEncoder(profile,runtime,'embedding',before);try{await assert.rejects(changed.encode('Public query','query'),/model_artifact_changed/);}finally{await changed.close();}
 console.log('PASS changed tokenizer/model artifact is rejected before loading or writing vectors');
}finally{await unavailable.close();if(previousDir===undefined)delete process.env.EMBEDDING_MODEL_DIR;else process.env.EMBEDDING_MODEL_DIR=previousDir;await fs.rm(dir,{recursive:true,force:true});}
