/**
 * Smoke test — no network, no LLM: exercises graph core with a temp DB.
 * Run: npm run smoke  (or npx tsx scripts/smoke.ts)
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { GraphMemory } from '../src/core/graph-memory.js';
import { MemoryConsolidation } from '../src/core/memory-consolidation.js';
import { MemoryPipelineManager } from '../src/core/memory-pipeline.js';
import { MindPond } from '../src/index.js';
import { getEmbeddingService } from '../src/core/embedding.js';

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-smoke-'));
  process.env.MEMORY_DB_PATH = path.join(tmpDir, 'smoke.db');

  const g = new GraphMemory();
  await g.init();

  // 1. create 3 nodes
  const a = await g.createNode({ dimension: 'fact', layer: 'L1', content: 'K10 固件 v2.7.4 修复了拍照旧缓冲问题', importance: 6 });
  const b = await g.createNode({ dimension: 'lesson', layer: 'L1', content: '照片收到了不等于照片是新的，要看曝光特征', importance: 7 });
  const c = await g.createNode({ dimension: 'event', layer: 'L1', content: '嘟嘟今天完成了数学作业第3页', importance: 4 });
  console.log(`nodes: a=${a.id} b=${b.id} c=${c.id}`);

  // 2. related edges (as LLM would via save related[]) — connections are BIDIRECTIONAL
  await g.upsertEdge(a.id, b.id, 'caused-by', 0.9);
  await g.upsertEdge(c.id, a.id, 'related', 0.4);
  const conns = await g.getConnections(a.id);
  const outConns = conns.filter(x => x.direction === 'out');
  const inConns = conns.filter(x => x.direction === 'in');
  console.log(`connections of a: out=${outConns.length} in=${inConns.length} (expect 1/1)`);
  if (outConns.length !== 1 || inConns.length !== 1) throw new Error('bidirectional connections failed');
  if (inConns[0].node.id !== c.id) throw new Error('incoming neighbor should be c');

  // 3. degree cap: fill a's OUT edges to 6 then try a 7th stronger
  for (let i = 0; i < 5; i++) {
    const n = await g.createNode({ dimension: 'fact', layer: 'L1', content: `filler ${i}`, importance: 1 });
    await g.upsertEdge(a.id, n.id, 'related', 0.3 + i * 0.05);
  }
  const strong = await g.createNode({ dimension: 'fact', layer: 'L1', content: 'strong newcomer', importance: 5 });
  await g.upsertEdge(a.id, strong.id, 'similar-to', 0.95);
  const after = await g.getConnections(a.id);
  const outAfter = after.filter(x => x.direction === 'out');
  console.log(`degree cap: out=${outAfter.length} total=${after.length} (expect 6 out, 7 total)`);
  if (outAfter.length !== 6) throw new Error('degree cap failed');
  if (!outAfter.some(x => x.node.id === strong.id)) throw new Error('strong edge should evict weakest');

  // 4. search hits
  const hits = await g.search({ query: '拍照 旧缓冲', limit: 5 });
  console.log(`search "拍照 旧缓冲": ${hits.length} hits, top="${hits[0]?.node.content?.slice(0, 30)}"`);
  if (hits.length === 0) throw new Error('search failed');

  // 5. update: meta (importance clamp) + content rewrite
  const metaOk = await g.updateNodeMeta(c.id, { importance: 42, tags: ['homework', 'math'] });
  if (!metaOk) throw new Error('updateNodeMeta failed');
  const cAfter = await g.getNodeById(c.id, { trackAccess: false });
  console.log(`update meta: importance=${cAfter?.importance} (expect 10, clamped)`);
  if (cAfter?.importance !== 10) throw new Error('importance clamp failed');
  await g.updateNodeContent(c.id, '嘟嘟今天完成了数学作业第3页和第4页');
  const cRewritten = await g.getNodeById(c.id, { trackAccess: false });
  if (!cRewritten?.content.includes('第4页')) throw new Error('updateNodeContent failed');
  console.log('update content: ok');

  // 6. dedupe scan/resolve (needs embedding model; skip gracefully if offline)
  const embOk = await getEmbeddingService().testConnection();
  if (embOk) {
    const d1 = await g.createNode({ dimension: 'fact', layer: 'L1', content: '用户偏好用深色模式写代码', importance: 5 });
    const d2 = await g.createNode({ dimension: 'fact', layer: 'L1', content: '用户偏好用深色模式写代码', importance: 8 });
    await g.upsertEdge(d1.id, a.id, 'related', 0.6);
    const groups = await g.findDuplicates(0.92);
    const group = groups.find(gr => gr.keep.id === d2.id || gr.duplicates.some(d => d.node.id === d2.id));
    console.log(`dedupe scan: ${groups.length} group(s), target found=${!!group}`);
    if (!group) throw new Error('dedupe scan missed identical-content pair');
    const doomed = group.keep.id === d2.id ? d1.id : d2.id;
    const kept = group.keep.id === d2.id ? d2.id : d1.id;
    const res = await g.mergeDuplicates(kept, [doomed], 'smoke dedupe');
    console.log(`dedupe resolve: merged=${res.merged} edgesMoved=${res.edgesMoved} (expect 1/1)`);
    if (res.merged !== 1 || res.edgesMoved !== 1) throw new Error('mergeDuplicates failed');
    if ((await g.getNodeById(doomed, { trackAccess: false }))?.supersededBy!==kept) throw new Error('source body must be retained and superseded');
    const keptConns = await g.getConnections(kept);
    if (!keptConns.some(x => x.node.id === a.id)) throw new Error('edge should be repointed to keeper');
  } else {
    console.log('dedupe scan/resolve: SKIP (embedding model offline, zero-vector guard verified instead)');
    const probe = await g.createNode({ dimension: 'fact', layer: 'L1', content: 'no-vector probe', importance: 3 });
    const probeRow = await g.getNodeById(probe.id, { trackAccess: false });
    if (probeRow?.embedding && probeRow.embedding.length > 0 && !probeRow.embedding.some(v => v !== 0)) {
      throw new Error('zero vector must not be stored');
    }
  }

  // 6.5 edge review two-phase (no LLM: feed synthetic verdicts)
  const consolidation = new MemoryConsolidation(g);
  const reviewBatch = await consolidation.buildEdgeReviewBatch();
  if (!reviewBatch || reviewBatch.items.length === 0) throw new Error('edge review batch empty');
  console.log(`edge review batch: ${reviewBatch.items.length} edge(s), prompt ${reviewBatch.prompt.length} chars`);
  // A score-only review cannot reconstruct the lost original situation.
  const top = [...reviewBatch.items].sort((x, y) => y.weight - x.weight)[0];
  const changed = await consolidation.commitEdgeReviewVerdicts(reviewBatch.items, [{ idx: top.idx, score: 0 }]);
  if (changed !== 0) throw new Error('context-free legacy review must defer');
  const current = await g.getEdgeById(top.edgeId);
  if (current?.weight !== top.weight) throw new Error('missing context must not lower weight');
  console.log('legacy review preserves associations without situational evidence');
  await g.updateEdgeWeight(top.edgeId, top.weight, 'explicit admin weight update audit check');

  // 7. edge delete + node delete (cascade) + audit log
  const edgeToKill = (await g.getConnections(b.id)).find(x => x.direction === 'in' && x.node.id === a.id);
  if (!edgeToKill) throw new Error('expected a→b edge on b');
  const edgeDel = await g.deleteEdge(edgeToKill.edge.id, 'smoke edge cleanup');
  if (!edgeDel) throw new Error('deleteEdge failed');
  await g.deleteNode(b.id, 'smoke node cleanup');
  if (await g.getNodeById(b.id, { trackAccess: false })) throw new Error('node b should be deleted');

  const log = await g.getActionLog(200);
  const actions = new Set(log.map(l => l.action));
  const required = ['node_created', 'node_updated', 'node_deleted', 'edge_created', 'edge_deleted', 'edge_reweighted'];
  const missing = required.filter(r => !actions.has(r));
  console.log(`audit log: ${log.length} entries, actions=[${[...actions].join(',')}]`);
  if (missing.length > 0) throw new Error(`audit log missing: ${missing.join(',')}`);

  // 8. stats sanity
  const stats = await g.getStats();
  console.log(`stats: total=${stats.total}`);

  // 9. Regression: session scope remains enforced during graph ripple.
  process.env.MEMORY_DB_PATH = path.join(tmpDir, 'scope.db');
  const scoped = new GraphMemory();
  await scoped.init();
  const own = await scoped.createNode({ dimension: 'fact', layer: 'L1', content: 'scope alpha marker', sessionId: 'A' });
  const other = await scoped.createNode({ dimension: 'fact', layer: 'L1', content: 'scope private bravo', sessionId: 'B' });
  await scoped.upsertEdge(own.id, other.id, 'related', 0.95);
  const scopedHits = await scoped.search({ query: 'scope alpha marker', sessionId: 'A', minScore: 0 });
  if (scopedHits.some(hit => hit.node.id === other.id)) throw new Error('session scope leaked through graph traversal');
  console.log('session scope: ok');

  // 9.5 Regression: foreign-key cascades are really active, not only declared
  // in the schema (old SQLite connections left orphan edges behind).
  const cascadeFrom = await scoped.createNode({ dimension: 'fact', layer: 'L1', content: 'cascade source' });
  const cascadeTo = await scoped.createNode({ dimension: 'fact', layer: 'L1', content: 'cascade target' });
  await scoped.upsertEdge(cascadeFrom.id, cascadeTo.id, 'related', 0.8);
  await scoped.deleteNode(cascadeTo.id);
  if ((await scoped.getConnections(cascadeFrom.id)).some(link => link.node.id === cascadeTo.id)) throw new Error('foreign-key cascade left an orphan edge');
  console.log('foreign-key cascade: ok');

  // 10. Regression: a durable job cannot be overwritten by a later ingest,
  // and malformed host output releases the same job instead of losing it.
  process.env.MEMORY_DB_PATH = path.join(tmpDir, 'jobs.db');
  const jobsGraph = new GraphMemory();
  await jobsGraph.init();
  const rawA = await jobsGraph.createNode({ dimension: 'event', layer: 'L0', content: 'raw source A', sessionId: 'A' });
  const rawB = await jobsGraph.createNode({ dimension: 'event', layer: 'L0', content: 'raw source B', sessionId: 'B' });
  const jobs = new MemoryPipelineManager(jobsGraph, undefined, { everyNConversations: 100 });
  jobs.notifyMessage(rawA.id);
  await jobs.extractL1();
  const firstJob = await jobs.getExtractionJob();
  if (!firstJob || firstJob.l0Messages[0]?.id !== rawA.id) throw new Error('first extraction job missing source A');
  jobs.notifyMessage(rawB.id);
  await jobs.extractL1();
  const invalid = await jobs.commitExtraction(firstJob.id, 'not json', firstJob.attempts);
  if (invalid.completed) throw new Error('invalid extraction reply should not complete a job');
  const retried = await jobs.getExtractionJob();
  if (!retried || retried.id !== firstJob.id || retried.l0Messages[0]?.id !== rawA.id) throw new Error('released extraction job was not recoverable');
  const committed = await jobs.commitExtraction(retried.id, JSON.stringify({ memories: [{ content: 'fact derived from A', type: 'fact', priority: 5, source_message_ids: ['msg-0'] }] }), retried.attempts);
  if (!committed.completed || committed.atomsCreated !== 1) throw new Error('durable extraction commit failed');
  const atom = (await jobsGraph.getNodesByLayer('L1', 10)).find(node => node.content === 'fact derived from A');
  const atomLinks = atom ? await jobsGraph.getConnections(atom.id) : [];
  if (!atom || atom.sessionId !== 'A' || !atomLinks.some(link => link.node.id === rawA.id)) throw new Error('extraction source/session attribution failed');
  jobs.stop();
  console.log('durable extraction jobs: ok');

  // 11. Regression: L1→L2 aggregates edges are read in their actual direction.
  process.env.MEMORY_DB_PATH = path.join(tmpDir, 'l2.db');
  const l2Graph = new GraphMemory();
  await l2Graph.init();
  await l2Graph.createNode({ dimension: 'fact', layer: 'L1', content: 'scene source one', sessionId: 'S' });
  await l2Graph.createNode({ dimension: 'fact', layer: 'L1', content: 'scene source two', sessionId: 'S' });
  const fakeLlm = { chat: async () => ({ choices: [{ message: { content: JSON.stringify({ scenes: [{ theme: 'test', summary: 'one scene', atomIndices: [0, 1] }] }) } }] }) } as any;
  const l2 = new MemoryConsolidation(l2Graph, fakeLlm, { l2MinAtoms: 2 });
  if (await l2.aggregateL2() !== 1 || await l2.aggregateL2() !== 0) throw new Error('L2 aggregation reprocessed already grouped atoms');
  console.log('L2 aggregation idempotence: ok');

  // 11.5 Regression: HTTP/MCP service mode can also advance L1 → L2 → L3
  // without owning an LLM key, and commits may only use issued batch contents.
  await l2Graph.createNode({ dimension: 'fact', layer: 'L1', content: 'global scene source one' });
  await l2Graph.createNode({ dimension: 'fact', layer: 'L1', content: 'global scene source two' });
  await l2Graph.createNode({ dimension: 'fact', layer: 'L1', content: 'global scene source three' });
  await l2Graph.createNode({ dimension: 'fact', layer: 'L1', content: 'global scene source four' });
  const hostL2 = new MemoryConsolidation(l2Graph, undefined, { l2MinAtoms: 2, l2MaxBatch: 2, l3MinScenes: 3 });
  const [hostBatch, secondHostBatch] = await Promise.all([hostL2.buildL2Batch(), hostL2.buildL2Batch()]);
  if (!hostBatch || !secondHostBatch || hostBatch.atoms.length !== 2 || secondHostBatch.atoms.length !== 2 ||
    hostBatch.atoms.some(atom => secondHostBatch.atoms.some(other => other.id === atom.id))) throw new Error('host L2 batch missing or duplicated under concurrency');
  const hostCommit = await hostL2.commitL2Batch(hostBatch.batchId, JSON.stringify({ scenes: [{ theme: 'global', summary: 'global scene summary', atomIndices: [0, 1] }] }));
  const secondHostCommit = await hostL2.commitL2Batch(secondHostBatch.batchId, JSON.stringify({ scenes: [{ theme: 'global', summary: 'second global scene summary', atomIndices: [0, 1] }] }));
  // R04: a consumed batchId is voided — recommitting it is a structured stale_lease, not a silent no-op.
  const reusedConsumedBatch = await hostL2.commitL2Batch(hostBatch.batchId, '{}').then(
    () => false,
    (err: any) => err?.code === 'stale_lease',
  );
  if (!hostCommit.completed || !secondHostCommit.completed || hostCommit.scenes !== 1 || secondHostCommit.scenes !== 1 || !reusedConsumedBatch) {
    throw new Error('host L2 batch capability or commit failed');
  }
  await l2Graph.createNode({ dimension: 'event', layer: 'L2', content: 'global scene two' });
  await l2Graph.createNode({ dimension: 'event', layer: 'L2', content: 'global scene three' });
  const personaBatch = await hostL2.buildL3Batch();
  if (!personaBatch) throw new Error('host L3 batch missing');
  const personaCommit = await hostL2.commitL3Batch(personaBatch.batchId, 'The user prefers concise, reliable systems and keeps their long-term profile global.');
  if (!personaCommit.completed || (await l2Graph.getUnscopedNodesByLayer('L3', 1)).length !== 1) throw new Error('host L3 commit failed');
  console.log('host-driven L2/L3 batches: ok');

  // 12. Regression: degree cap remains correct under same-process concurrency.
  process.env.MEMORY_DB_PATH = path.join(tmpDir, 'degree-concurrent.db');
  const concurrent = new GraphMemory();
  await concurrent.init();
  const hub = await concurrent.createNode({ dimension: 'fact', layer: 'L1', content: 'concurrent hub' });
  const leaves = await Promise.all(Array.from({ length: 12 }, (_, index) => concurrent.createNode({ dimension: 'fact', layer: 'L1', content: `concurrent leaf ${index}` })));
  await Promise.all(leaves.map(leaf => concurrent.upsertEdge(hub.id, leaf.id, 'related', 0.5)));
  if ((await concurrent.getConnections(hub.id)).filter(link => link.direction === 'out').length !== 6) throw new Error('concurrent degree cap failed');
  console.log('concurrent degree cap: ok');

  // 13. Regression: a reader refreshes its independent ANN index after another
  // GraphMemory instance writes the same SQLite pond.
  process.env.MEMORY_DB_PATH = path.join(tmpDir, 'cross-instance.db');
  const reader = new GraphMemory();
  const writer = new GraphMemory();
  await reader.init();
  await writer.init();
  const external = await writer.createNode({ dimension: 'fact', layer: 'L1', content: 'cross instance embedding', embedding: [1, ...Array(383).fill(0)] });
  const refreshed = await reader.search({ query: 'unrelated retrieval probe', embedding: external.embedding, minScore: 0.3 });
  if (!refreshed.some(hit => hit.node.id === external.id)) throw new Error('cross-instance ANN refresh failed');
  console.log('cross-instance index refresh: ok');

  // 14. Regression: the public LLMFn contract is adapted to LLMClient rather
  // than receiving an internal message array and producing an unread string.
  process.env.MEMORY_DB_PATH = path.join(tmpDir, 'public-llm.db');
  let receivedPrompt = '';
  const pond = new MindPond({ llm: async (prompt) => {
    receivedPrompt = prompt;
    return JSON.stringify({ memories: [{ content: 'public adapter fact', type: 'fact', priority: 5, source_message_ids: ['msg-0'] }] });
  } });
  await pond.init();
  await pond.ingestTranscript('public adapter raw', 'P');
  await pond.extract();
  if (!receivedPrompt.includes('public adapter raw') || !(await pond.list({ layer: 'L1', sessionId: 'P' })).nodes.some(node => node.content === 'public adapter fact')) {
    throw new Error('public LLMFn adapter did not produce a scoped L1 atom');
  }
  await pond.close();
  console.log('public LLMFn adapter: ok');

  await Promise.all([scoped.close(), jobsGraph.close(), l2Graph.close(), concurrent.close(), reader.close(), writer.close()]);

  console.log('SMOKE PASS');
  process.exit(0);
}

main().catch((err) => {
  console.error('SMOKE FAIL:', err);
  process.exit(1);
});
