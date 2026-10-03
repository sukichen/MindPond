import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GraphMemory } from '../src/core/graph-memory.js';
import { getEmbeddingService } from '../src/core/embedding.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-graph-dimensions-'));
process.env.MEMORY_DB_PATH = path.join(dir, 'pond.db');
process.env.EMBEDDING_ZH_ENABLED = 'false';
getEmbeddingService().generateEmbedding = async () => [];
const graph = new GraphMemory();
try {
  await graph.init();
  const bridge = await graph.saveMemory('Recovery lesson and reproducible procedure.', {
    dimensions: ['lesson', 'skill'], sessionId: 'coverage',
    memberships: [{ spaceId: 'project:coverage', memoryType: 'lesson' }],
  });
  const decision = await graph.saveMemory('Use the validated recovery path.', {
    dimensions: ['decision'], sessionId: 'coverage',
    memberships: [{ spaceId: 'project:coverage', memoryType: 'decision' }],
  });
  await (graph as any).db.run('UPDATE nodes SET created_at=? WHERE id IN (?,?)',
    [Date.now() - 60_000, bridge.id, decision.id]);
  for (let i = 0; i < 10; i++) await graph.saveMemory(`Recent fact ${i}.`, {
    dimensions: ['fact'], sessionId: 'coverage',
    memberships: [{ spaceId: 'project:coverage', memoryType: 'fact' }],
  });
  await graph.saveMemory('Unrelated space fact.', {
    dimensions: ['fact'], sessionId: 'coverage',
    memberships: [{ spaceId: 'project:fact-only', memoryType: 'fact' }],
  });
  const view = await graph.getFullGraph(4, undefined, { spaceId: 'project:coverage' });
  assert.equal(view.nodes.length, 4);
  const identities = new Set(view.nodes.flatMap(node => node.dimensions ?? [node.dimension]));
  assert.deepEqual([...identities].sort(), ['decision', 'fact', 'lesson', 'skill']);
  assert(view.nodes.some(node => node.id === bridge.id && node.dimension === 'lesson'));
  const skillView = await graph.getFullGraph(4, undefined, { spaceId: 'project:coverage', memoryType: 'skill' });
  assert.deepEqual(skillView.nodes.map(node => node.id), [bridge.id]);
  const otherSpace = await graph.getFullGraph(4, undefined, { spaceId: 'project:fact-only' });
  assert(otherSpace.nodes.every(node => !node.dimensions?.includes('skill')));
  console.log('Graph dimension coverage: rare bridge identity, strict limit and space filter PASS');
} finally {
  await graph.close();
  await fs.rm(dir, { recursive: true, force: true });
}
