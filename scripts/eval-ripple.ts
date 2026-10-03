/** Deterministic propagation diagnostics, NOT an end-to-end quality benchmark.
 * Run: npx tsx scripts/eval-ripple.ts [--strict]
 * Uses isolated temporary SQLite databases and supplied vectors/entry points.
 * No model, network, user memory, or production retrieval changes required.
 * Default exit status reports runner health; --strict also fails unmet targets.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { GraphMemory, type Dimension, type MemoryQuery } from '../src/core/graph-memory.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
type NodeSpec = { key: string; dimension?: Dimension; sessionId?: string; directMatch?: boolean };
type EdgeSpec = [string, string, string, number];
type Hit = { key: string; score: number; depth: number; path: string[] };
type Observation = { query: string; hits: Hit[] };
type Check = { expectation: string; passed: boolean };
type Fixture = {
  id: string;
  kind: 'invariant' | 'product-hypothesis';
  nodes: NodeSpec[];
  edges: EdgeSpec[];
  queries: { name: string; seed?: string; options?: Partial<MemoryQuery> }[];
  supersede?: [string, string];
  assess: (observations: Observation[]) => Check[];
};
const has = (o: Observation, key: string) => o.hits.some(hit => hit.key === key);
const fixtures: Fixture[] = [
  {
    id: 'parallel-entry-points', kind: 'invariant',
    nodes: [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd', directMatch: false }, { key: 'e', directMatch: false }, { key: 'f', directMatch: false }],
    edges: [['a', 'd', 'related', 0.9], ['b', 'e', 'related', 0.9], ['d', 'f', 'related', 0.9]],
    queries: [{ name: 'direct-only', options: { maxDepth: 0 } }, { name: 'parallel-expansion', options: { maxDepth: 2, minScore: 0.05 } }],
    assess: ([base, ripple]) => [
      { expectation: 'One search directly retrieves A, B and C as parallel depth-zero entry points, not a serial path.', passed: base.hits.length === 3 && ['a', 'b', 'c'].every(key => base.hits.some(hit => hit.key === key && hit.depth === 0)) },
      { expectation: 'Direct matches retain their own seed scores when propagation is enabled.', passed: base.hits.every(seed => ripple.hits.some(hit => hit.key === seed.key && hit.depth === 0 && hit.score === seed.score)) },
      { expectation: 'A-D and B-E are independent first-wave paths; only D-F creates a second-wave path.', passed: ripple.hits.some(hit => hit.key === 'd' && hit.path.join('/') === 'a/d') && ripple.hits.some(hit => hit.key === 'e' && hit.path.join('/') === 'b/e') && ripple.hits.some(hit => hit.key === 'f' && hit.path.join('/') === 'a/d/f') },
    ],
  },
  {
    id: 'forward-one-hop', kind: 'invariant', nodes: [{ key: 'symptom' }, { key: 'solution' }],
    edges: [['symptom', 'solution', 'related', 0.9]],
    queries: [{ name: 'no-ripple', seed: 'symptom', options: { maxDepth: 0 } }, { name: 'default', seed: 'symptom' }],
    assess: ([base, ripple]) => [{ expectation: 'An outgoing one-hop association adds evidence absent from a seed-only result.', passed: !has(base, 'solution') && has(ripple, 'solution') }],
  },
  {
    id: 'two-hop-threshold', kind: 'product-hypothesis', nodes: [{ key: 'symptom' }, { key: 'cause' }, { key: 'solution' }],
    edges: [['symptom', 'cause', 'related', 0.9], ['cause', 'solution', 'related', 0.9]],
    queries: [{ name: 'default', seed: 'symptom' }, { name: 'low-threshold-diagnostic', seed: 'symptom', options: { minScore: 0.05 } }],
    assess: ([normal, low]) => [
      { expectation: 'Default depth=2 should preserve a useful two-hop L1 path with both edge weights 0.9.', passed: has(normal, 'solution') },
      { expectation: 'Lowering only the threshold demonstrates that the path exists.', passed: has(low, 'solution') },
    ],
  },
  {
    id: 'cross-dimension-isolation', kind: 'product-hypothesis',
    nodes: [{ key: 'symptom', dimension: 'event' }, { key: 'lesson', dimension: 'lesson' }],
    edges: [['symptom', 'lesson', 'related', 0.8]],
    queries: [{ name: 'default', seed: 'symptom' }, { name: 'low-threshold-diagnostic', seed: 'symptom', options: { minScore: 0.05 } }],
    assess: ([normal, low]) => [
      { expectation: 'Different dimension/type spaces must not propagate into each other, even if an invalid legacy edge exists.', passed: !has(normal, 'lesson') },
      { expectation: 'Dimension isolation remains enforced when the score threshold is lowered; a penalty is not isolation.', passed: !has(low, 'lesson') },
    ],
  },
  {
    id: 'best-path-relaxation', kind: 'invariant',
    nodes: [{ key: 'seed' }, { key: 'early' }, { key: 'later' }, { key: 'target' }],
    edges: [['seed', 'early', 'related', 0.95], ['seed', 'later', 'related', 0.9], ['early', 'target', 'related', 0.6], ['later', 'target', 'related', 0.99]],
    queries: [{ name: 'diamond', seed: 'seed', options: { minScore: 0.05 } }],
    assess: ([o]) => {
      const target = o.hits.find(hit => hit.key === 'target');
      const best = 0.9 * 0.99;
      return [{ expectation: `A later stronger path must replace the first path (best score=${best.toFixed(8)}).`, passed: !!target && Math.abs(target.score - best) < 1e-8 && target.path[1] === 'later' }];
    },
  },
  {
    id: 'incoming-fixes-discovery', kind: 'product-hypothesis', nodes: [{ key: 'problem' }, { key: 'fix' }],
    edges: [['fix', 'problem', 'fixes', 0.9]],
    queries: [{ name: 'from-problem', seed: 'problem' }],
    assess: ([o]) => [{ expectation: 'Starting from a problem should discover a newer incoming fixes edge while preserving its semantic direction.', passed: has(o, 'fix') }],
  },
  {
    id: 'cycle-termination', kind: 'invariant', nodes: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
    edges: [['a', 'b', 'related', 0.9], ['b', 'c', 'related', 0.9], ['c', 'a', 'related', 0.9]],
    queries: [{ name: 'cycle', seed: 'a', options: { maxDepth: 5, minScore: 0 } }],
    assess: ([o]) => [{ expectation: 'A cycle terminates and returns each node once.', passed: o.hits.length === 3 && new Set(o.hits.map(hit => hit.key)).size === 3 }],
  },
  {
    id: 'scoped-traversal', kind: 'invariant',
    nodes: [{ key: 'own', sessionId: 'A' }, { key: 'private', sessionId: 'B' }, { key: 'global' }],
    edges: [['own', 'private', 'related', 0.95], ['own', 'global', 'related', 0.9]],
    queries: [{ name: 'session-A', seed: 'own', options: { sessionId: 'A', minScore: 0 } },{name:'parallel-readable-seeds',options:{sessionId:'A',maxDepth:0,minScore:0}}],
    assess: ([o,seeds]) => [{ expectation: 'A single session seed cannot traverse historical ordinary edges into personal or another session.', passed: has(o,'own') && !has(o, 'private') && !has(o, 'global') },{expectation:'Personal and current-session memories remain independent parallel retrieval entries; a foreign session is excluded.',passed:has(seeds,'own')&&has(seeds,'global')&&!has(seeds,'private')}],
  },
  {
    id: 'superseded-exclusion', kind: 'invariant', nodes: [{ key: 'seed' }, { key: 'old' }, { key: 'new' }],
    edges: [['seed', 'old', 'related', 0.95], ['seed', 'new', 'related', 0.9]], supersede: ['old', 'new'],
    queries: [{ name: 'current-only', seed: 'seed', options: { minScore: 0 } }],
    assess: ([o]) => [{ expectation: 'Superseded facts are absent from ordinary ripple results.', passed: !has(o, 'old') && has(o, 'new') }],
  },
];

async function main() {
  const original = { db: process.env.MEMORY_DB_PATH, zh: process.env.EMBEDDING_ZH_ENABLED, stderr: process.env.MINDPOND_LOG_STDERR };
  process.env.EMBEDDING_ZH_ENABLED = 'false';
  process.env.MINDPOND_LOG_STDERR = '1';
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-ripple-eval-'));
  const results: { id: string; kind: Fixture['kind']; observations: Observation[]; checks: Check[] }[] = [];
  try {
    for (const fixture of fixtures) {
      process.env.MEMORY_DB_PATH = path.join(temp, `${fixture.id}.db`);
      const graph = new GraphMemory();
      try {
        await graph.init();
        const ids = new Map<string, string>();
        for (const node of fixture.nodes) {
          const created = await graph.createNode({
            dimension: node.dimension ?? 'fact', layer: 'L1', content: `${fixture.id}: ${node.key}`,
            sessionId: node.sessionId, embedding: node.directMatch === false ? [0, 1, ...Array(382).fill(0)] : [1, ...Array(383).fill(0)],
          });
          ids.set(node.key, created.id);
        }
        for (const [from, to, label, weight] of fixture.edges) await graph.upsertEdge(ids.get(from)!, ids.get(to)!, label, weight);
        if (fixture.supersede) await graph.supersedeNode(ids.get(fixture.supersede[0])!, ids.get(fixture.supersede[1])!);
        const keys = new Map([...ids].map(([key, id]) => [id, key]));
        const observations: Observation[] = [];
        for (const query of fixture.queries) {
          const entry = query.seed ? { nodeId: ids.get(query.seed) } : { query: 'qxzvunique', embedding: [1, ...Array(383).fill(0)] };
          const hits = await graph.search({ ...entry, limit: 20, ...query.options });
          observations.push({ query: query.name, hits: hits.map(hit => ({ key: keys.get(hit.node.id)!, score: Number(hit.score.toFixed(8)), depth: hit.depth, path: hit.path.map(id => keys.get(id)!) })) });
        }
        results.push({ id: fixture.id, kind: fixture.kind, observations, checks: fixture.assess(observations) });
      } finally { await graph.close(); }
    }
    const sourceHashes: Record<string, string> = {};
    for (const name of ['src/core/graph-memory.ts', 'src/core/vector-index.ts', 'scripts/eval-ripple.ts']) {
      sourceHashes[name] = createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex');
    }
    const checks = results.flatMap(result => result.checks);
    const report = {
      generatedAt: new Date().toISOString(), nodeVersion: process.version, sourceHashes,
      scope: 'Synthetic supplied-vector/nodeId propagation diagnostics, including parallel entry points. No natural-language retrieval quality, generated-edge, answer-quality, cross-agent or scale claim.',
      designRevision: 'User correction: parallel seeds, independent dimension/type spaces, one memory may occupy several spaces, associative recall is bidirectional. Cross-dimension recall target withdrawn.',
      policy: 'Default exit code tests runner health; --strict fails unmet invariants and proposed product targets. Do not interpret check counts as quality scores.',
      summary: { fixtures: results.length, checks: checks.length, met: checks.filter(check => check.passed).length, unmet: checks.filter(check => !check.passed).length }, results,
    };
    const output = path.join(root, 'evals/results/ripple-diagnostic.json');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
    for (const result of results) {
      console.log(`${result.checks.every(check => check.passed) ? 'MET' : 'GAP'} ${result.id} (${result.kind})`);
      for (const check of result.checks.filter(check => !check.passed)) console.log(`  ${check.expectation}`);
    }
    console.log(`Report: ${output}`);
    if (process.argv.includes('--strict') && report.summary.unmet > 0) process.exitCode = 1;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
    for (const [key, value] of [['MEMORY_DB_PATH', original.db], ['EMBEDDING_ZH_ENABLED', original.zh], ['MINDPOND_LOG_STDERR', original.stderr]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
