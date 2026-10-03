/** Current organization behavior audit, not an LLM-quality evaluation.
 * Run: npx tsx scripts/eval-organization.ts
 * Isolated temp DBs; deterministic embedding stub; synthetic host replies.
 * A successful exit means the observations were collected, not goals met.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { GraphMemory } from '../src/core/graph-memory.js';
import { MemoryConsolidation } from '../src/core/memory-consolidation.js';
import { getEmbeddingService } from '../src/core/embedding.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vector = [1, ...Array(383).fill(0)];
const reply = (summary: string) => JSON.stringify({ scenes: [{ theme: 'deployment', summary, atomIndices: [0, 1] }] });

async function main() {
  const originalEnv = { MEMORY_DB_PATH: process.env.MEMORY_DB_PATH, EMBEDDING_ZH_ENABLED: process.env.EMBEDDING_ZH_ENABLED, MINDPOND_LOG_STDERR: process.env.MINDPOND_LOG_STDERR };
  process.env.EMBEDDING_ZH_ENABLED = 'false';
  process.env.MINDPOND_LOG_STDERR = '1';
  const embedding = getEmbeddingService();
  const originalGenerate = embedding.generateEmbedding;
  embedding.generateEmbedding = async () => vector;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-organization-audit-'));
  const observations: { id: string; observed: unknown }[] = [];
  async function scenario(id: string, run: (graph: GraphMemory, consolidation: MemoryConsolidation, dbPath: string) => Promise<unknown>) {
    const dbPath = path.join(temp, `${id}.db`);
    process.env.MEMORY_DB_PATH = dbPath;
    const graph = new GraphMemory();
    try {
      await graph.init();
      const consolidation = new MemoryConsolidation(graph, undefined, { l2MinAtoms: 2 });
      observations.push({ id, observed: await run(graph, consolidation, dbPath) });
    } finally { await graph.close(); }
  }
  try {
    await scenario('l2-adds-summary-without-compacting', async (graph, consolidation) => {
      const first = await graph.createNode({ dimension: 'fact', content: 'Deploy the service on port 7903.', embedding: vector });
      const second = await graph.createNode({ dimension: 'fact', content: 'Bind the service to loopback; remote access uses the proxy.', embedding: vector });
      const batch = await consolidation.buildL2Batch();
      if (!batch) throw new Error('fixture did not produce an L2 batch');
      const result = await consolidation.commitL2Batch(batch.batchId, reply('Deploy on loopback port 7903 and use the proxy for remote access.'));
      const active = await graph.search({ query: 'service deployment', embedding: vector, minScore: 0, maxDepth: 0 });
      return { result, activeAfter: active.length, originalsStillReturned: [first, second].every(node => active.some(hit => hit.node.id === node.id)), layers: active.map(hit => hit.node.layer) };
    });
    await scenario('l2-malformed-response-reported-completed', async (graph, consolidation) => {
      for (const content of ['Deploy on port 7903.', 'Bind to loopback.']) await graph.createNode({ dimension: 'fact', content, embedding: vector });
      const batch = await consolidation.buildL2Batch();
      if (!batch) throw new Error('fixture did not produce a batch');
      return await consolidation.commitL2Batch(batch.batchId, 'this is not JSON');
    });
    await scenario('l2-mixes-legacy-types', async (graph, consolidation) => {
      await graph.createNode({ dimension: 'fact', content: 'Deploy on port 7903.', sessionId: 'S', embedding: vector });
      await graph.createNode({ dimension: 'lesson', content: 'Check credential cache when a deployment retries.', sessionId: 'S', embedding: vector });
      const batch = await consolidation.buildL2Batch();
      if (!batch) throw new Error('fixture did not produce a batch');
      const inputTypes = await Promise.all(batch.atoms.map(async atom => (await graph.getNodeById(atom.id, { trackAccess: false }))!.dimension));
      await consolidation.commitL2Batch(batch.batchId, reply('Deploy on port 7903; inspect the credential cache on retry.'));
      return { inputTypes, outputTypes: (await graph.getNodesByLayer('L2')).map(node => node.dimension) };
    });
    await scenario('stale-l2-source-not-rejected', async (graph, consolidation) => {
      const port = await graph.createNode({ dimension: 'fact', content: 'The current port is 7903.', embedding: vector });
      await graph.createNode({ dimension: 'fact', content: 'Bind to loopback.', embedding: vector });
      const batch = await consolidation.buildL2Batch();
      if (!batch) throw new Error('fixture did not produce a batch');
      await graph.updateNodeContent(port.id, 'The current port is 7904. Port 7903 is no longer used.');
      const result = await consolidation.commitL2Batch(batch.batchId, reply('The service binds to loopback on current port 7903.'));
      return { result, currentSource: (await graph.getNodeById(port.id, { trackAccess: false }))!.content, storedSummary: (await graph.getNodesByLayer('L2'))[0]?.content };
    });
    await scenario('dedupe-endpoint-does-not-integrate-content', async graph => {
      const keeper = await graph.createNode({ dimension: 'fact', content: 'Deploy the service on port 7903.', embedding: vector });
      const supplement = await graph.createNode({ dimension: 'fact', content: 'Deploy the service on port 7903. Bind only to loopback.', embedding: vector });
      const result = await graph.mergeDuplicates(keeper.id, [supplement.id], 'synthetic caller-selected merge');
      return { result, retainedContent: (await graph.getNodeById(keeper.id, { trackAccess: false }))!.content, supplementDeleted: !(await graph.getNodeById(supplement.id, { trackAccess: false })), qualification: 'Caller explicitly selected the merge; this shows the API lacks content integration, not that it autonomously decided these are exact duplicates.' };
    });
    await scenario('old-unlinked-memories-not-weave-anchors', async (graph, consolidation, dbPath) => {
      for (const content of ['A deployment retries because of cached credentials.', 'Recreating the runner clears its stale credential cache.']) await graph.createNode({ dimension: 'fact', content, embedding: vector });
      const db = await open({ filename: dbPath, driver: sqlite3.Database });
      try { await db.run('UPDATE nodes SET created_at = ?', [Date.now() - 48 * 3600_000]); } finally { await db.close(); }
      return { existingMemories: (await graph.getStats()).total, weaveBatch: await consolidation.buildWeaveBatch() };
    });
    const sourceHashes: Record<string, string> = {};
    for (const file of ['src/core/graph-memory.ts', 'src/core/memory-consolidation.ts', 'src/core/memory-pipeline.ts', 'scripts/eval-organization.ts']) sourceHashes[file] = createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex');
    const report = { generatedAt: new Date().toISOString(), nodeVersion: process.version, scope: 'Six deterministic current-implementation observations using synthetic inputs and replies; no LLM quality or production data evaluation.', sourceHashes, observations };
    const output = path.join(root, 'evals/results/organization-audit.json');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
    for (const observation of observations) console.log(JSON.stringify(observation));
    console.log(`Report: ${output}`);
  } finally {
    embedding.generateEmbedding = originalGenerate;
    await fs.rm(temp, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
