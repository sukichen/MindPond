import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GraphMemory } from '../src/core/graph-memory.js';
import { getEmbeddingService } from '../src/core/embedding.js';
import { memorySavePolicyPayload } from '../src/core/save-policy.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-save-policy-'));
process.env.MEMORY_DB_PATH = path.join(dir, 'pond.db');
process.env.EMBEDDING_ZH_ENABLED = 'false';
const embeddings = getEmbeddingService(), original = embeddings.generateEmbedding;
embeddings.generateEmbedding = async () => [1, ...Array(383).fill(0)];
const g = new GraphMemory();
try {
  await g.init();
  const policy = memorySavePolicyPayload();
  assert.equal(policy.version, 'memory-save.v3.1');
  for (const marker of ['DECIDE WHETHER TO SAVE', 'CHOOSE ONE USEFUL UNIT', 'WRITE SELF-CONTAINED CONTENT']) assert(policy.text.includes(marker));
  const { related: _exampleRelated, content, ...example } = policy.example;
  const saved = await g.saveMemory(content, example);
  const node = await g.getNodeById(saved.id, { trackAccess: false }); assert(node);
  assert.equal(node.content, content); assert(node.content.includes('限制：'));
  const normalized = await g.saveMemory('  完整正文保留条件：仅适用于本地调试。  ', {
    tags: [' 调试 ', '调试'], memberships: [{ spaceId: ' P ', memoryType: ' config ' }, { spaceId: 'P', memoryType: 'config' }] });
  assert.equal(normalized.memberships.length, 1); assert.equal(normalized.memberships[0].spaceId, 'P');
  assert.deepEqual((await g.getNodeById(normalized.id, { trackAccess: false }))!.tags, ['调试']);
  const before = (await g.getStats()).total;
  for (const options of [{ importance: 5.5 }, { tags: [''] }, { tags: Array(17).fill('tag') }, { source: '' },
    { memberships: [] }, { memberships: [{ spaceId: ' ', memoryType: 'fact' }] }, { sessionId: '' }, { dimension: 'unknown' }]) {
    await assert.rejects(g.saveMemory('无效输入不可落库', options as any));
  }
  await assert.rejects(g.saveMemory('x'.repeat(policy.limits.content + 1)));
  assert.equal((await g.getStats()).total, before);
  console.log('PASS standardized policy example persists with conditions and exceptions intact');
  console.log('PASS tag/placement normalization and malformed-save rejection without partial writes');
} finally { await g.close(); embeddings.generateEmbedding = original; await fs.rm(dir, { recursive: true, force: true }); }
