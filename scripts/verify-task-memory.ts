/** Real DB check for the task brief → feedback → review loop, including scope. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GraphMemory } from '../src/core/graph-memory.js';
import { getEmbeddingService } from '../src/core/embedding.js';
import { hostOperations } from '../src/core/host-contract.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-task-memory-'));
const oldDb = process.env.MEMORY_DB_PATH;
process.env.MEMORY_DB_PATH = path.join(dir, 'graph.db');
const embedding = getEmbeddingService();
const oldGenerate = embedding.generateEmbedding;
embedding.generateEmbedding = async () => [1, ...Array(383).fill(0)];
const graph = new GraphMemory();
try {
  await graph.init();
  const placement = [{spaceId:'project',memoryType:'fact'}];
  const a = await graph.saveMemory('Proxy listens on localhost for the development setup.', {memberships:placement});
  const b = await graph.saveMemory('Deployment settings are unknown until the deployment manifest is checked.', {memberships:placement});
  await graph.saveMemory('Another session secret.', {memberships:placement,sessionId:'other'});
  const ops = new Map(hostOperations(graph).map(op => [op.name,op]));
  const run = (name:string, args:unknown) => {const op=ops.get(name)!;return op.run(op.schema.parse(args));};
  const brief = await run('memory_brief',{task:'Review the proxy deployment',domains:[{kind:'personal',id:'default'}],spaceId:'project',hostId:'test-host',runId:'test-run',limit:8,contextBudgetBytes:12000});
  assert.ok(brief.recallId);
  const ids = new Set(brief.results.map((r:any)=>r.id));
  assert.ok(ids.has(a.id) && ids.has(b.id), 'both relevant memories must be delivered');
  assert.equal(brief.results.some((r:any)=>r.content.includes('secret')),false,'brief must preserve domain boundary');
  assert.ok(brief.contextBudget.used <= 12000);
  const input = {reportId:'report-1',recallId:brief.recallId,runId:'test-run',hostId:'test-host',task:'Review proxy deployment',outcome:'completed',
    observations:[{memoryId:a.id,disposition:'used',reason:'Explained the local bind',issue:'incomplete',context:'Production deployment remains unknown'},
      {memoryId:b.id,disposition:'used',reason:'Prevented a production claim'}],
    coUses:[{memoryIds:[a.id,b.id],spaceId:'project',memoryType:'fact',reason:'Needed together to distinguish development from deployment',context:'Proxy deployment review'}]};
  const receipt = await run('memory_use_report',input);
  assert.equal(receipt.feedback.recorded,2);
  assert.equal(receipt.signals.length,2);
  assert.deepEqual(await run('memory_use_report',input),receipt,'same report must replay exactly');
  await assert.rejects(run('memory_use_report',{...input,task:'Changed task'}),/idempotency_conflict/);
  await assert.rejects(run('memory_use_report',{...input,reportId:'bad-id',observations:[{memoryId:'not-returned',disposition:'used',reason:'fake'}],coUses:[]}),/returned memories/);
  assert.equal((await graph.graphNeighborhood(a.id,{domains:[{kind:'personal',id:'default'}]})).associations?.length??0,0,'feedback must not create edges');
  const signals=(await run('memory_improvement_list',{domains:[{kind:'personal',id:'default'}]})).signals;
  assert.equal(signals.length,2);
  assert.equal((await run('memory_improvement_list',{sessionId:'other',domains:[{kind:'session',id:'other'}]})).signals.length,0);
  const resolved=await run('memory_improvement_resolve',{signalId:signals[0].id,status:'deferred',reason:'Await manifest',domains:[{kind:'personal',id:'default'}]});
  assert.equal(resolved.status,'deferred');
  assert.equal((await run('memory_improvement_list',{domains:[{kind:'personal',id:'default'}]})).signals.length,1);
  await assert.rejects(run('memory_use_report',{...input,reportId:'wrong-space',coUses:[{...input.coUses[0],spaceId:'another-project'}]}),/one active domain\/space\/type/);
  assert.equal((await run('memory_improvement_list',{domains:[{kind:'personal',id:'default'}]})).signals.length,1,'failed report must leave no signal');
  const reopened = new GraphMemory();
  try {
    await reopened.init();
    assert.equal((await reopened.listImprovementSignals({domains:[{kind:'personal',id:'default'}]})).length,1,'pending suggestion must survive restart');
    assert.deepEqual(await reopened.reportMemoryUse(input),receipt,'report receipt must survive restart');
  } finally { await reopened.close(); }
  console.log('PASS task memory: brief budget/scope, actual feedback, idempotent review signals, no auto edge');
} finally {
  await graph.close();
  embedding.generateEmbedding=oldGenerate;
  if(oldDb===undefined)delete process.env.MEMORY_DB_PATH;else process.env.MEMORY_DB_PATH=oldDb;
  await fs.rm(dir,{recursive:true,force:true});
}
