/** R04 gate: legacy consolidation paths converge on the current rules
 * (acceptance T21/T22). Runs a real strict-mode server (context+operator
 * secrets) and proves: weave/L2/L3 commits never consume their server-issued
 * offer before the verdict is accepted; source atoms/scenes/persona edited or
 * superseded since batch build are rejected as stale_version; multi-dimension
 * relations are placed at an explicit (or deterministically oldest) shared
 * membership instead of being silently dropped; invalid replies keep the batch
 * held for a corrected resubmission; every legacy operator surface is gated;
 * the discovery catalog advertises none of the legacy endpoints. A legacy-mode
 * server pins single-user compatibility, an in-process section pins messageId
 * idempotency (same messageId replays, different messageIds stay separate
 * events), and a cross-domain dedupe merge is refused as scope_denied. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'url';
import { GraphMemory } from '../src/core/graph-memory.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-legacycons-'));
const distServer = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.js');
await fs.access(distServer);

const CONTEXT_SECRET = 'verify-context-secret';
const OPERATOR_KEY = 'verify-operator-key';
const STRICT_PORT = 7926;
const LEGACY_PORT = 7927;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function startServer(port: number, extraEnv: Record<string, string>) {
  const child = spawn(process.execPath, [distServer], {
    env: { ...process.env, MEMORY_DB_PATH: path.join(dir, `pond-${port}.db`), MEMORY_PORT: String(port), EMBEDDING_ZH_ENABLED: 'false', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
  return {
    child,
    ready: async () => {
      const deadline = Date.now() + 30000;
      while (!output.includes('listening') && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
      assert(output.includes('listening'), `server ${port} did not start: ${output}`);
    },
    stop: async () => { child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve())); },
  };
}

let passed = 0;
const ok = (label: string) => { passed += 1; console.log(`PASS ${label}`); };

type Ctx = { operatorKey?: boolean };
const headers = (ctx: Ctx) => ({
  'Content-Type': 'application/json',
  ...(ctx.operatorKey ? { 'x-operator-key': OPERATOR_KEY } : {}),
});
const call = (base: string) => ({
  post: async (url: string, body: unknown, ctx: Ctx = {}) =>
    fetch(base + url, { method: 'POST', headers: headers(ctx), body: JSON.stringify(body) }),
  get: async (url: string, ctx: Ctx = {}) => fetch(base + url, { headers: headers(ctx) }),
});
const strict = call(`http://127.0.0.1:${STRICT_PORT}`);
const legacy = call(`http://127.0.0.1:${LEGACY_PORT}`);
const OP: Ctx = { operatorKey: true };

const expectError = async (label: string, res: Response, status: number, code: string) => {
  const body = await res.json() as any;
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.code, code, `${label}: expected code ${code}, got ${body.code} (${body.error})`);
  ok(label);
  return body;
};
const searchHits = async (query: string, marker: string) => {
  const res = await strict.post('/api/memory/search', { query, limit: 30 }, OP);
  const body = await res.json() as any;
  assert.equal(res.status, 200, `search failed: ${JSON.stringify(body)}`);
  return (body.results as Array<{ content: string }>).filter(r => r.content.includes(marker)).length;
};

const L2SCOPE = { spaceId: 'verify/consol', memoryType: 'knowledge' };
const WEAVE_SCOPE = { spaceId: 'verify/weave', memoryType: 'fact' };
const L2JSON = (summary: string, indices: number[]) => JSON.stringify({ scenes: [{ theme: 'verify', summary, atomIndices: indices }] });

try {
  const strictServer = startServer(STRICT_PORT, { MEMORY_CONTEXT_SECRET: CONTEXT_SECRET, MEMORY_OPERATOR_KEY: OPERATOR_KEY });
  const legacyServer = startServer(LEGACY_PORT, {});
  try {
    await Promise.all([strictServer.ready(), legacyServer.ready()]);

    // ---- discovery catalog must not advertise legacy consolidation endpoints ----
    const caps = await (await strict.get('/api/host/capabilities', OP)).text();
    assert.ok(!caps.includes('/api/weave') && !caps.includes('/api/consolidate') && !caps.includes('/api/memory/dedupe'),
      'discovery catalog must only promote the validated organization entries');
    ok('T21 discovery catalog contains no legacy weave/consolidate/dedupe endpoints');

    // ---- no operator capability → every legacy surface is closed (no bypass) ----
    await expectError('T21 weave/batch without operator denied', await strict.get('/api/weave/batch'), 403, 'scope_denied');
    await expectError('T21 weave/commit without operator denied', await strict.post('/api/weave/commit', { nodeId: 'x', links: [], candidateIds: [] }), 403, 'scope_denied');
    await expectError('T21 l2/commit without operator denied', await strict.post('/api/consolidate/l2/commit', { batchId: 'x', reply: '{}' }), 403, 'scope_denied');
    await expectError('T21 l3/commit without operator denied', await strict.post('/api/consolidate/l3/commit', { batchId: 'x', reply: 'x' }), 403, 'scope_denied');
    await expectError('T21 dedupe/scan without operator denied', await strict.post('/api/memory/dedupe/scan', {}), 403, 'scope_denied');

    // ---- seed: L1 atom groups per session, unscoped group, weave pairs ----
    const saveNode = async (body: any) => {
      const res = await strict.post('/api/memory/save', body, OP);
      const receipt = await res.json() as any;
      assert.equal(res.status, 200, `seed save failed: ${JSON.stringify(receipt)}`);
      return receipt;
    };
    const seedAtoms = async (sessionId: string | undefined, prefix: string, count: number) => {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const receipt = await saveNode({
          content: `${prefix} quartz oscillator drift compensation procedure step ${i} marker-${prefix}`,
          ...(sessionId ? { sessionId } : {}), memberships: [L2SCOPE],
        });
        ids.push(receipt.id);
      }
      await sleep(12); // keep per-session first-atom createdAt strictly ordered
      return ids;
    };
    await seedAtoms('s-l2', 'L2ATOM-A', 8);
    await seedAtoms('s-l2b', 'L2ATOM-B', 8);
    await seedAtoms('s-l2c', 'L2ATOM-C', 8);
    await seedAtoms(undefined, 'L2ATOM-G', 24);

    const weavePair = async (a: string, b: string) => {
      const shared = 'Quantum flux capacitor calibration requires temperature compensation across the whole duty cycle';
      const ra = await saveNode({ content: `${shared} WEAVE-${a}`, sessionId: 's-weave', memberships: [WEAVE_SCOPE] });
      const rb = await saveNode({ content: `${shared} WEAVE-${b}`, sessionId: 's-weave', memberships: [WEAVE_SCOPE] });
      for (const r of [ra, rb]) {
        const res = await strict.post('/api/memory/membership', { memoryId: r.id, spaceId: 'verify/weave', memoryType: 'lesson' }, OP);
        assert.equal(res.status, 200, `addMembership failed: ${await res.text()}`);
      }
      return { a: ra.id, b: rb.id };
    };
    // ---- T22 (HTTP): different idempotency keys keep separate events; same key replays ----
    const ingest = async (body: any) => {
      const res = await strict.post('/api/memory/ingest', body, OP);
      return { status: res.status, body: await res.json() as any };
    };
    const first = await ingest({ transcript: '[user] 继续', sessionId: 's-t22', idempotencyKey: 't22-msg-1' });
    assert.equal(first.status, 200, `ingest failed: ${JSON.stringify(first.body)}`);
    const replay = await ingest({ transcript: '[user] 继续', sessionId: 's-t22', idempotencyKey: 't22-msg-1' });
    assert.equal(replay.body.l0Id, first.body.l0Id, 'same key + same payload must replay the original receipt');
    const conflict = await ingest({ transcript: '[user] 继续上一轮', sessionId: 's-t22', idempotencyKey: 't22-msg-1' });
    assert.equal(conflict.status, 400, 'same key + different payload must conflict');
    assert.ok(JSON.stringify(conflict.body).includes('idempotency_conflict'));
    const second = await ingest({ transcript: '[user] 继续', sessionId: 's-t22', idempotencyKey: 't22-msg-2' });
    assert.equal(second.status, 200);
    assert.notEqual(second.body.l0Id, first.body.l0Id, 'a different messageId at a different time must stay a separate event');
    ok('T22 same key replays one event; different keys/time keep separate “继续” events');

    // ---- T21: L2 commit — stale source rejected, invalid reply keeps the batch held ----
    const l2Batch = async () => {
      const res = await strict.get('/api/consolidate/l2/batch', OP);
      const body = await res.json() as any;
      assert.equal(res.status, 200, `l2/batch failed: ${JSON.stringify(body)}`);
      return body.batch as { batchId: string; atoms: Array<{ idx: number; id: string; content: string }> } | null;
    };
    const l2Commit = async (batchId: string, reply: string) =>
      strict.post('/api/consolidate/l2/commit', { batchId, reply }, OP);

    const batch1 = await l2Batch();
    assert.ok(batch1 && batch1.atoms.length === 8, `expected the s-l2 batch of 8, got ${JSON.stringify(batch1)}`);
    await strict.post('/api/memory/update', { nodeId: batch1.atoms[3].id, content: `${batch1.atoms[3].content} UPDATED-AFTER-BUILD` }, OP);
    await expectError('T21 stale L2 source rejected as stale_version',
      await l2Commit(batch1.batchId, L2JSON('SCENE-STALE-MARKER grouping drifted atoms', [0, 1, 2])), 409, 'stale_version');
    assert.equal(await searchHits('SCENE-STALE-MARKER', 'SCENE-STALE-MARKER'), 0, 'no L2 scene may arise from a stale batch');
    await expectError('T21 stale batchId is voided after stale rejection',
      await l2Commit(batch1.batchId, L2JSON('SCENE-STALE-MARKER retry', [0, 1])), 409, 'stale_lease');

    const batch2 = await l2Batch();
    assert.ok(batch2, 's-l2 atoms are still ungrouped and must be re-offered');
    const committed2 = await l2Commit(batch2!.batchId, L2JSON('SCENE-OK-MARKER oscillator drift scenes', [0, 1, 2]));
    const committed2Body = await committed2.json() as any;
    assert.equal(committed2.status, 200, `valid L2 commit failed: ${JSON.stringify(committed2Body)}`);
    assert.equal(committed2Body.scenes, 1);

    const batch3 = await l2Batch();
    assert.ok(batch3, 's-l2b batch expected');
    await expectError('T21 invalid L2 reply rejected without consuming the batch',
      await l2Commit(batch3!.batchId, 'this is not json at all'), 400, 'invalid_input');
    const retried = await l2Commit(batch3!.batchId, L2JSON('SCENE-RETRY-MARKER same batchId after fix', [0, 1, 2, 3]));
    const retriedBody = await retried.json() as any;
    assert.equal(retried.status, 200, 'corrected reply must be accepted on the SAME batchId');
    assert.ok((retriedBody.scenes ?? 0) >= 1);

    const batch4 = await l2Batch();
    assert.ok(batch4, 's-l2c batch expected');
    const emptyVerdict = await l2Commit(batch4!.batchId, '{"scenes":[]}');
    assert.equal(emptyVerdict.status, 200);
    const emptyVerdictBody = await emptyVerdict.json() as any;
    assert.deepEqual(emptyVerdictBody, { ok: true, scenes: 0, completed: true }, 'an empty scenes verdict is a legitimate completed no-op');
    const batch5 = await l2Batch();
    assert.ok(batch5, 's-l2c atoms remain ungrouped after the empty verdict');
    const group5 = await l2Commit(batch5!.batchId, L2JSON('SCENE-C-GROUP-MARKER remaining atoms', [0, 1, 2, 3, 4, 5, 6, 7]));
    assert.equal(group5.status, 200);

    // ---- T21: L3 commit — stale scene / stale existing persona rejected ----
    for (let round = 0; round < 3; round += 1) {
      const batch = await l2Batch();
      assert.ok(batch && batch.atoms.length >= 8, `global L1 group round ${round}: ${JSON.stringify(batch)}`);
      const res = await l2Commit(batch!.batchId, L2JSON(`SCENE-GLOBAL-${round}-MARKER unscoped scene`, [0, 1, 2, 3, 4, 5, 6, 7]));
      assert.equal(res.status, 200, `global round ${round} commit failed: ${await res.text()}`);
    }
    const l3Batch = async () => {
      const res = await strict.get('/api/consolidate/l3/batch', OP);
      const body = await res.json() as any;
      assert.equal(res.status, 200, `l3/batch failed: ${JSON.stringify(body)}`);
      return body.batch as { batchId: string; scenes: Array<{ idx: number; id: string; content: string }>; existing: { id: string } | null } | null;
    };
    const l3Commit = async (batchId: string, reply: string) =>
      strict.post('/api/consolidate/l3/commit', { batchId, reply }, OP);

    const l3b1 = await l3Batch();
    assert.ok(l3b1 && l3b1.scenes.length === 3 && l3b1.existing === null, 'expected 3 unscoped scenes and no persona yet');
    await strict.post('/api/memory/update', { nodeId: l3b1.scenes[1].id, content: `${l3b1.scenes[1].content} UPDATED-AFTER-BUILD` }, OP);
    await expectError('T21 stale L3 scene rejected as stale_version',
      await l3Commit(l3b1.batchId, 'PERSONA-STALE-MARKER distilled from moved scenes'), 409, 'stale_version');
    const l3b2 = await l3Batch();
    assert.ok(l3b2 && l3b2.existing === null);
    const personaOk = await l3Commit(l3b2!.batchId, 'PERSONA-MARKER global operator profile distilled from unscoped scenes');
    assert.equal(personaOk.status, 200, `L3 create failed: ${await personaOk.text()}`);
    const l3b3 = await l3Batch();
    assert.ok(l3b3 && l3b3.existing, 'second L3 round must carry the existing persona');
    const personaNode = await strict.post('/api/memory/search', { query: 'PERSONA-MARKER global operator profile', limit: 10 }, OP);
    const personaId = ((await personaNode.json() as any).results as Array<{ id: string }>)[0].id;
    await strict.post('/api/memory/update', { nodeId: personaId, content: 'PERSONA-MARKER edited after the batch was issued' }, OP);
    await expectError('T21 stale existing persona rejected as stale_version',
      await l3Commit(l3b3!.batchId, 'PERSONA-STALE-MARKER overwriting an unseen edit'), 409, 'stale_version');
    const l3b4 = await l3Batch();
    assert.ok(l3b4);
    const personaV2 = await l3Commit(l3b4!.batchId, 'PERSONA-MARKER-v2 refreshed global operator profile from current scenes');
    assert.equal(personaV2.status, 200, `L3 refresh failed: ${await personaV2.text()}`);

    // ---- T21: weave commits — capability consumed once, placement explicit ----
    // Pairs are seeded here so they sit inside the newest-20 weave window.
    // pair2 is seeded only AFTER wb1 settles: batch matching drains the newest
    // unprocessed nodes, so a pre-seeded pair2 would be consumed before its turn.
    const pair1 = await weavePair('ONE', 'TWO');
    const weaveBatch = async () => {
      const res = await strict.get('/api/weave/batch', OP);
      const body = await res.json() as any;
      assert.equal(res.status, 200, `weave/batch failed: ${JSON.stringify(body)}`);
      return body.batch as { nodeId: string; nodeContent: string; candidates: Array<{ idx: number; id: string; content: string }>; prompt: string } | null;
    };
    const weaveCommit = async (nodeId: string, links: any[], candidateIds: string[]) =>
      strict.post('/api/weave/commit', { nodeId, links, candidateIds }, OP);
    const nextWeaveBatch = async (match: (b: NonNullable<Awaited<ReturnType<typeof weaveBatch>>>) => boolean) => {
      for (let i = 0; i < 60; i += 1) {
        const batch = await weaveBatch();
        if (!batch) return null;
        if (match(batch)) return batch;
        const drained = await weaveCommit(batch.nodeId, [], batch.candidates.map(c => c.id));
        assert.equal(drained.status, 200, `drain commit failed: ${await drained.text()}`);
      }
      return null;
    };
    const candidateIdx = (batch: { candidates: Array<{ id: string }> }, nodeId: string) => {
      const target = batch.candidates.find(c => c.id !== nodeId);
      assert.ok(target, 'the counterpart node must appear among the issued candidates');
      return target.id;
    };

    const wb1 = await nextWeaveBatch(b => [pair1.a, pair1.b].includes(b.nodeId));
    assert.ok(wb1, 'weave never offered the multi-dimension pair');
    const other1 = candidateIdx(wb1!, wb1!.nodeId);
    const woven1 = await weaveCommit(wb1!.nodeId, [{ idx: wb1!.candidates.find(c => c.id === other1)!.idx, label: 'related', weight: 0.5, reason: '两份石英校准记录共同回想可交叉验证温度补偿条件', context: '校准石英振荡器需要温度补偿时适用；单件故障排查不适用' }], wb1!.candidates.map(c => c.id));
    const woven1Body = await woven1.json() as any;
    assert.equal(woven1.status, 200, `weave commit failed: ${JSON.stringify(woven1Body)}`);
    assert.equal(woven1Body.woven, 1, 'a relation over two shared memberships must not be judged illegal or dropped');
    assert.equal(woven1Body.applied.length, 1);
    assert.equal(woven1Body.applied[0].spaceId, 'verify/weave');
    assert.equal(woven1Body.applied[0].memoryType, 'fact', 'default placement is the oldest shared membership');
    await expectError('T21 weave offer consumed exactly once after success',
      await weaveCommit(wb1!.nodeId, [], wb1!.candidates.map(c => c.id)), 409, 'stale_lease');

    const pair2 = await weavePair('THREE', 'FOUR');
    const wb2 = await nextWeaveBatch(b => [pair2.a, pair2.b].includes(b.nodeId));
    assert.ok(wb2, 'weave never offered the second multi-dimension pair');
    const cand2 = wb2!.candidates.map(c => c.id);
    const targetIdx2 = wb2!.candidates.find(c => c.id !== wb2!.nodeId)!.idx;
    await expectError('T21 invalid weave placement rejected without consuming the batch',
      await weaveCommit(wb2!.nodeId, [{ idx: targetIdx2, label: 'related', weight: 0.5, reason: '校准与维护记录需共同回想', context: '温度补偿场景适用', spaceId: 'verify/weave', memoryType: 'decision' }], cand2), 400, 'invalid_input');
    const woven2 = await weaveCommit(wb2!.nodeId, [{ idx: targetIdx2, label: 'related', weight: 0.5, reason: '校准与维护记录需共同回想', context: '温度补偿场景适用', spaceId: 'verify/weave', memoryType: 'lesson' }], cand2);
    const woven2Body = await woven2.json() as any;
    assert.equal(woven2.status, 200, `explicit placement commit failed: ${JSON.stringify(woven2Body)}`);
    assert.equal(woven2Body.applied[0].memoryType, 'lesson', 'an explicit placement must be honored');

    const wb3 = await nextWeaveBatch(b => !b.nodeId.startsWith('unused') && b.candidates.length > 0);
    assert.ok(wb3, 'a further weave batch with candidates expected for contradicts handling');
    const contradicted = await weaveCommit(wb3!.nodeId, [{ idx: 0, label: 'contradicts', weight: 0.4, reason: '表面矛盾', context: '条件未知' }], wb3!.candidates.map(c => c.id));
    assert.equal(contradicted.status, 200);
    const contradictedBody = await contradicted.json() as any;
    assert.equal(contradictedBody.woven, 0);
    assert.ok(contradictedBody.skipped.length === 1 && contradictedBody.skipped[0].reason.includes('organization'),
      'contradicts must be explicitly routed to the organization flow, not silently dropped');
    await expectError('T21 contradicts-only verdict consumed the batch exactly once',
      await weaveCommit(wb3!.nodeId, [], wb3!.candidates.map(c => c.id)), 409, 'stale_lease');

    const wb4 = await nextWeaveBatch(b => b.candidates.length > 0);
    assert.ok(wb4, 'a further weave batch expected for link validation');
    const badIdx = await weaveCommit(wb4!.nodeId, [{ idx: 999, label: 'related', weight: 0.5, reason: 'r', context: 'c' }], wb4!.candidates.map(c => c.id));
    assert.equal(badIdx.status, 400, 'out-of-range idx must be a structured rejection');
    assert.equal(((await badIdx.json() as any).field) ?? '', 'links[0].idx');
    const missingBasis = await weaveCommit(wb4!.nodeId, [{ idx: 0, label: 'related', weight: 0.5 }], wb4!.candidates.map(c => c.id));
    assert.equal(missingBasis.status, 400, 'missing reason/context must be a structured rejection');
    const drained4 = await weaveCommit(wb4!.nodeId, [], wb4!.candidates.map(c => c.id));
    assert.equal(drained4.status, 200, 'batch must stay held across rejections until an accepted verdict');
    ok('T21 weave verdict rejections keep the batch held; accepted verdicts consume it once');

    // ---- dedupe merge may never cross domains ----
    const keep = await saveNode({ content: 'DEDUPE-KEEP personal calibration fact', memberships: [L2SCOPE] });
    const gone = await saveNode({ content: 'DEDUPE-GONE session residue', sessionId: 's-dedupe', memberships: [L2SCOPE] });
    await expectError('T21 dedupe merge across domains refused',
      await strict.post('/api/memory/dedupe/resolve', { keepId: keep.id, deleteIds: [gone.id], reason: 'verify cross-domain fence' }, OP), 403, 'scope_denied');

    // ---- legacy mode (sample-agent compat): same flows work without any secrets ----
    const legacyL2 = await legacy.get('/api/consolidate/l2/batch');
    assert.equal(legacyL2.status, 200, 'legacy mode must keep parameter-supplied operator access');
    const legacyCommit = await legacy.post('/api/weave/commit', { nodeId: 'missing-node', links: [], candidateIds: [] });
    assert.equal(legacyCommit.status, 409, 'legacy mode keeps the structured offer contract');
    const legacyIngest1 = await (await legacy.post('/api/memory/ingest', { transcript: '[user] 继续', sessionId: 's-t22-legacy', idempotencyKey: 'lg-1' })).json() as any;
    const legacyIngest2 = await (await legacy.post('/api/memory/ingest', { transcript: '[user] 继续', sessionId: 's-t22-legacy', idempotencyKey: 'lg-2' })).json() as any;
    assert.notEqual(legacyIngest1.l0Id, legacyIngest2.l0Id, 'legacy mode keeps distinct events for distinct keys');
    ok('legacy mode: no-secret operator access, structured errors and messageId-scoped events intact');
  } finally {
    await Promise.all([strictServer.stop(), legacyServer.stop()]);
  }

  // ---- T22 in-process: saveMessage messageId semantics on a temp DB ----
  process.env.MEMORY_DB_PATH = path.join(dir, 'pond-inproc.db');
  const g = new GraphMemory();
  await g.init();
  try {
    const id1a = await g.saveMessage('s-m', '继续', 'user', 'm1');
    const id1b = await g.saveMessage('s-m', '继续', 'user', 'm1');
    assert.equal(id1b, id1a, 'same messageId re-delivery must return the original L0 node');
    await assert.rejects(
      () => g.saveMessage('s-m', '继续，把范围扩大到全部目录', 'user', 'm1'),
      /idempotency_conflict/, 'same messageId with different content must conflict',
    );
    const id2 = await g.saveMessage('s-m', '继续', 'user', 'm2');
    assert.notEqual(id2, id1a, 'a different messageId at a different time must stay a separate event');
    const id3 = await g.saveMessage('s-n', '继续', 'user', 'm1');
    assert.notEqual(id3, id1a, 'the receipt scope is (session, messageId) — another session never replays it');
    const row = await (g as any).db.get("SELECT COUNT(*) AS c FROM nodes WHERE layer='L0' AND session_id='s-m' AND content='[user] 继续'") as { c: number };
    assert.equal(row?.c, 2, 'two distinct “继续” events must exist as two L0 rows');
    ok('T22 in-process saveMessage: same messageId idempotent, different messageId/time/session kept separate');
  } finally {
    await g.close();
  }
} finally {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\nverify-legacy-consolidation: ${passed} section(s) passed`);
