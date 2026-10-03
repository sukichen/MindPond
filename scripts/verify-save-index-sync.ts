import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GraphMemory } from '../src/core/graph-memory.js';
import { getEmbeddingService } from '../src/core/embedding.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-save-index-'));
process.env.MEMORY_DB_PATH = path.join(dir, 'pond.db');
process.env.EMBEDDING_ZH_ENABLED = 'false';
const embeddings = getEmbeddingService();
const original = embeddings.generateEmbedding;
embeddings.generateEmbedding = async () => [1, ...Array(383).fill(0)];
const first = new GraphMemory();
const second = new GraphMemory();

try {
  await first.init();
  await second.init();

  const originalLoad = (first as any).loadIndex.bind(first);
  let reloads = 0;
  (first as any).loadIndex = async () => { reloads++; await originalLoad(); };

  const own = await first.saveMemory('alpha unique local memory');
  await first.search({ query: 'alpha unique local memory', maxDepth: 0, minScore: 0 });
  assert.equal(reloads, 0, 'local save must update the vector index without a full reload');
  assert((first as any).vectorIndex.get(own.id), 'local save must be in the vector index');

  const external = await second.saveMemory('beta external memory');
  await first.search({ query: 'beta external memory', maxDepth: 0, minScore: 0 });
  assert.equal(reloads, 1, 'an external save must invalidate the local index');
  assert((first as any).vectorIndex.get(external.id), 'external save must become visible');

  await second.saveMemory('gamma second external memory');
  await first.saveMemory('delta local save after external write');
  await first.search({ query: 'gamma second external memory', maxDepth: 0, minScore: 0 });
  assert.equal(reloads, 2, 'local save must not acknowledge unseen external writes');

  await first.saveMemory('epsilon fresh local memory');
  await first.search({ query: 'epsilon fresh local memory', maxDepth: 0, minScore: 0 });
  assert.equal(reloads, 2, 'later local saves must stay incremental');
  const unseen = await second.saveMemory('zeta unseen external memory before legacy write');
  await first.createNode({dimension:'fact', content:'eta legacy library save'});
  await first.search({query:'zeta unseen external memory',maxDepth:0,minScore:0});
  assert.equal(reloads,3,'legacy generation updates must not hide unseen external writes');
  assert((first as any).vectorIndex.get(unseen.id));

  const before = Number(await first.getMeta('index_generation'));
  await Promise.all(Array.from({length:20},(_,i)=>((i%2 ? first : second) as any).bumpIndexGeneration()));
  assert.equal(Number(await first.getMeta('index_generation')),before+20,'cross-process increments must not be lost');
  console.log('Save/index sync: local fast path, legacy invalidation and atomic concurrent generations PASS');
} finally {
  await first.close();
  await second.close();
  embeddings.generateEmbedding = original;
  await fs.rm(dir, { recursive: true, force: true });
}
