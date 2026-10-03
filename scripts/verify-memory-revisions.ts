import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GraphMemory } from '../src/core/graph-memory.js';
import { getEmbeddingService } from '../src/core/embedding.js';
import { signTeamWriteGrant } from '../src/core/domain.js';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-edit-history-'));
process.env.EMBEDDING_ZH_ENABLED='false';
const dbPath=path.join(temp,'memory.db'),g=new GraphMemory('.',{dbPath});
const vector=[1,...Array(383).fill(0)],scope={spaceId:'project/revisions',memoryType:'fact'};
// Verify revision/index synchronization without a machine-specific model cache.
const embeddingService=getEmbeddingService(),originalEmbedding=embeddingService.generateEmbedding,originalBatch=embeddingService.generateBatch;
const originalConnection=embeddingService.testConnection,originalStatus=embeddingService.status;
embeddingService.generateEmbedding=async()=>vector.slice();
embeddingService.generateBatch=async texts=>texts.map(()=>vector.slice());
embeddingService.testConnection=async()=>true;
embeddingService.status=()=>({model:embeddingService.getModelName(),state:'ready'});
const personal={domains:[{kind:'personal' as const,id:'default'}]};
const get=async(id:string)=>(await g.getNodeById(id,{trackAccess:false}))!;
try {
  await g.init();
  const original='Proxy binds to loopback. Production remains unverified.';
  const n=await g.saveMemory(original,{dimension:'fact',dimensions:['fact'],memberships:[scope],
    sourceRefs:[{uri:'repo:proxy.ts',context:'main',revision:'r1'}],anchors:[{...scope,text:'loopback proxy',basis:'Proxy binds to loopback.'}]});
  const first=await g.editMemory(n.id,{content:'Development proxy listens on port 7903. Production remains unverified.',dimensions:['fact','lesson'],
    anchors:[{...scope,text:'development proxy port',basis:'Development proxy listens on port 7903.'}],sourceRefs:[{uri:'repo:proxy.ts',context:'main',revision:'r2'}],expectedUpdatedAt:(await get(n.id)).updatedAt,reason:'port evidence'});
  await assert.rejects(g.memoryEditHistory(n.id,{domains:[]}),/outside the readable domains/,'explicit empty grants cannot read personal history');
  await assert.rejects(g.restoreMemoryEdit(n.id,{revisionId:first.revisionId,expectedUpdatedAt:(await get(n.id)).updatedAt,reason:'no grants',context:{domains:[]}}),/outside the readable domains/,'explicit empty grants cannot restore personal memory');
  const history=await g.memoryEditHistory(n.id,personal);assert.equal(history.length,1);assert.equal(history[0].before.node.content,original);
  assert(!JSON.stringify(history).includes('embeddingModel'),'history responses omit binary vector details');
  const currentIndex=(g as any).vectorIndex.getAll().find((item:any)=>item.id===n.id);
  assert(currentIndex&&currentIndex.metadata.content.startsWith('Development proxy'),'edited body must stay in the live semantic index');
  const changed=await get(n.id),undo=await g.restoreMemoryEdit(n.id,{revisionId:first.revisionId,expectedUpdatedAt:changed.updatedAt,reason:'port observation was for another checkout',context:personal});
  const restoredIndex=(g as any).vectorIndex.getAll().find((item:any)=>item.id===n.id);
  assert(restoredIndex&&restoredIndex.metadata.content.startsWith('Proxy binds'),'undo must restore the live semantic index');
  const restored=await get(n.id);assert.equal(restored.content,original);assert.deepEqual(restored.dimensions,['fact']);assert.equal(restored.sourceRefs![0].revision,'r1');
  assert.equal(restored.anchors![0].text,'loopback proxy');assert.equal(restored.anchors![0].status,'active');
  assert((await (g as any).db.get('SELECT length(embedding) n FROM memory_anchors WHERE memory_id=?',[n.id])).n>0,'restored anchors keep their vector channel');
  assert.deepEqual((await g.getMemberships(n.id,{activeOnly:true})).map(m=>m.memoryType),['fact']);
  assert.equal((await g.memoryEditHistory(n.id,personal))[0].restoresRevisionId,first.revisionId);
  assert(restored.updatedAt>changed.updatedAt);assert.notEqual(undo.revisionId,first.revisionId);
  await assert.rejects(g.restoreMemoryEdit(n.id,{revisionId:first.revisionId,expectedUpdatedAt:restored.updatedAt,reason:'stale replay'}),/stale_version/);
  console.log('PASS edit history restores complete body/sources/dimensions/anchors as a new revision; old replay cannot overwrite it');

  const edit=await g.editMemory(n.id,{content:original+' A second review is pending.',expectedUpdatedAt:restored.updatedAt});
  const after=await get(n.id);
  await g.updateNodeContent(n.id,'A concurrent legacy caller changed the body.');
  await assert.rejects(g.restoreMemoryEdit(n.id,{revisionId:edit.revisionId,expectedUpdatedAt:(await get(n.id)).updatedAt,reason:'stale target'}),/stale_version/);
  assert.equal((await get(n.id)).content,'A concurrent legacy caller changed the body.');
  const another=await g.createNode({dimension:'fact',content:'The launcher configures the development proxy.',memberships:[scope],embedding:vector});
  const edit2=await g.editMemory(n.id,{content:original,expectedUpdatedAt:(await get(n.id)).updatedAt});
  const members=(await g.getMemberships(n.id,{activeOnly:true})),other=(await g.getMemberships(another.id))[0];
  await g.upsertAssociation(members[0].id,other.id,scope.spaceId,scope.memoryType,.6,{reason:'launcher and proxy must be reviewed together',context:'development only'});
  await assert.rejects(g.restoreMemoryEdit(n.id,{revisionId:edit2.revisionId,expectedUpdatedAt:(await get(n.id)).updatedAt,reason:'topology changed'}),/stale_version/);
  console.log('PASS subsequent legacy writes and association changes fence stale undo');

  const job=await g.claimOrganizationJob({...scope,membershipIds:[members[0].id,other.id]});assert(job);
  await g.commitOrganizationPlan(job.id,{operations:[{kind:'synthesize',membershipIds:[members[0].id,other.id],content:'Local proxy and launcher collaborate. Production remains unverified.',reason:'local workflow',
    profile:{title:'Local proxy workflow',coverage:['proxy','launcher'],unknowns:['production']},supports:[members[0].id,other.id].map(membershipId=>({membershipId,claim:'one component of local flow',context:'development only'}))}]});
  const supportedEdit=await g.editMemory(n.id,{content:original+' Reviewed again.',expectedUpdatedAt:(await get(n.id)).updatedAt});
  await assert.rejects(g.restoreMemoryEdit(n.id,{revisionId:supportedEdit.revisionId,expectedUpdatedAt:(await get(n.id)).updatedAt,reason:'would invalidate support'}),/profile/);
  console.log('PASS profile support prevents in-place undo and requires evidence-aware organization');

  const s=await g.createNode({dimension:'fact',sessionId:'private-session',content:'PRIVATE-REVISION-SOURCE',embedding:vector});
  const sr=await g.editMemory(s.id,{content:'PRIVATE-REVISION-UPDATED',expectedUpdatedAt:s.updatedAt});
  await assert.rejects(g.memoryEditHistory(s.id,personal));
  await assert.rejects(g.restoreMemoryEdit(s.id,{revisionId:sr.revisionId,expectedUpdatedAt:(await get(s.id)).updatedAt,reason:'foreign',context:personal}));
  await g.setSessionState('private-session','closed');
  await assert.rejects(g.restoreMemoryEdit(s.id,{revisionId:sr.revisionId,expectedUpdatedAt:(await get(s.id)).updatedAt,reason:'closed'}),/closed/);
  await g.purgeClosedSession('private-session');
  assert.equal((await (g as any).db.get('SELECT COUNT(*) n FROM memory_edit_revisions WHERE memory_id=?',[s.id])).n,0);
  console.log('PASS scoped history/restore, closed-session refusal and purge cascade');

  const dimensionsOnly=await g.createNode({dimension:'fact',dimensions:['fact'],content:'An internal review produced a reusable lesson.',memberships:[scope],embedding:vector});
  await g.editMemory(dimensionsOnly.id,{dimensions:['lesson'],expectedUpdatedAt:dimensionsOnly.updatedAt,reason:'reclassified after review'});
  const storedDimension=await (g as any).db.get('SELECT dimension,dimensions FROM nodes WHERE id=?',[dimensionsOnly.id]);
  assert.equal(storedDimension.dimension,'lesson','edited primary dimension must persist, not rely on read-time repair');
  assert.deepEqual(JSON.parse(storedDimension.dimensions),['lesson']);
  assert.deepEqual((await get(dimensionsOnly.id)).dimensions,['lesson']);
  await (g as any).db.run('UPDATE nodes SET embedding=NULL WHERE id=?',[dimensionsOnly.id]);
  (g as any).vectorIndex.remove(dimensionsOnly.id);
  await (g as any).backfillEmbeddings();
  assert((await g.search({query:'internal review reusable lesson',memoryType:'lesson'})).some(hit=>hit.node.id===dimensionsOnly.id),'The next scoped recall must pick up the committed backfill');
  const filled=(g as any).vectorIndex.getAll().find((item:any)=>item.id===dimensionsOnly.id);
  assert(filled&&filled.metadata.dimensions.includes('lesson'),'background vector backfill must retain scope metadata');
  assert.equal(filled.metadata.domain.kind,'personal');
  console.log('PASS dimension reclassification persists and vector backfill keeps scope metadata');

  process.env.MEMORY_TEAM_AUTH_SECRET='revision-test-only';
  const grant=signTeamWriteGrant({v:1,authorizationId:'test-user',teamId:'team-revisions',requestId:'user-edit',operations:['save','edit'],issuedAt:Date.now()-1000,expiresAt:Date.now()+60000},process.env.MEMORY_TEAM_AUTH_SECRET);
  const team=await g.createNode({dimension:'fact',domain:{kind:'team',id:'team-revisions'},content:'Team development constraints.',embedding:vector,teamAuthorization:grant});
  const tr=await g.editMemory(team.id,{content:'Team constraints updated.',expectedUpdatedAt:team.updatedAt,teamAuthorization:grant});
  await assert.rejects(g.restoreMemoryEdit(team.id,{revisionId:tr.revisionId,expectedUpdatedAt:(await get(team.id)).updatedAt,reason:'no user grant'}),/team_write_unauthorized/);
  await g.restoreMemoryEdit(team.id,{revisionId:tr.revisionId,expectedUpdatedAt:(await get(team.id)).updatedAt,reason:'user corrected the edit',teamAuthorization:grant});
  await g.close();await g.init();assert.equal((await g.memoryEditHistory(team.id,undefined)).length,2);
  console.log('PASS team restore requires fresh authorized edit capability; history persists across restart');
} finally {embeddingService.generateEmbedding=originalEmbedding;embeddingService.generateBatch=originalBatch;embeddingService.testConnection=originalConnection;embeddingService.status=originalStatus;await g.close();await fs.rm(temp,{recursive:true,force:true});}
