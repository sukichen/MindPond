/** R01 gate: unified errors, input normalization and logical idempotency.
 * Covers fixture scenarios T01–T04 (see evals/fixtures/) through the real
 * GraphMemory service boundary, plus HTTP error-contract parity on a real
 * server process. Fails non-zero on any violation. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'url';
import { GraphMemory } from '../src/core/graph-memory.js';
import { MindPondError, toStructuredError } from '../src/core/errors.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-errors-'));
process.env.MEMORY_DB_PATH = path.join(dir, 'pond.db');
process.env.EMBEDDING_ZH_ENABLED = 'false';
const g = new GraphMemory();
const scope = { spaceId: 'verify/errors', memoryType: 'knowledge' };
const db = () => (g as any).db;

const save = (content: string, options: any = {}) => g.saveMemory(content, { memberships: [scope], ...options });
const workRows = async () => g.listHostWork(scope.spaceId, scope.memoryType);
const checkpointPayload = (memoryIds: string[], checkpointId: string) => ({
  hostId: 'verify-host', runId: 'run-1', checkpointId,
  spaceId: scope.spaceId, memoryType: scope.memoryType,
  outcome: 'saved' as const, reason: 'Verify error contract', memoryIds,
});

let passed = 0;
const ok = (label: string) => { passed += 1; console.log(`PASS ${label}`); };

try {
  await g.init();

  // ---- T01: identical delivery 100× converges to one logical work + one result ----
  const first = await save('T01 identical payload', { idempotencyKey: 't01-key' });
  for (let i = 0; i < 99; i += 1) {
    const receipt = await save('T01 identical payload', { idempotencyKey: 't01-key' });
    assert.equal(receipt.id, first.id);
  }
  const t01Count = await db().get('SELECT COUNT(*) AS n FROM nodes WHERE content=?', ['T01 identical payload']);
  assert.equal(t01Count.n, 1, '100 identical saves must create exactly one node');
  const cp = await g.checkpoint(checkpointPayload([first.id], 'cp-t01'));
  for (let i = 0; i < 99; i += 1) {
    const again = await g.checkpoint(checkpointPayload([first.id], 'cp-t01'));
    assert.equal(again.workId, cp.workId);
  }
  assert.equal((await workRows()).length, 1, '100 identical checkpoints must keep a single host_work row');
  ok('T01 same key/payload ×100 → one node, one receipt, one host_work');

  // Normalization: padded text, reordered memoryIds, implicit domain stay the same request
  const normA = await g.checkpoint({ ...checkpointPayload([first.id], 'cp-norm'), reason: '  Verify error contract  ', memoryIds: [first.id, first.id] });
  assert.equal(normA.workId, cp.workId, 'trimmed reason + deduped ids converge on the same work');
  ok('T01 checkpoint hash is computed over the normalized payload');

  // ---- T02a: same key, different content → structured conflict ----
  await assert.rejects(
    save('T01 different payload', { idempotencyKey: 't01-key' }),
    (err: any) => err instanceof MindPondError && err.code === 'idempotency_conflict' && err.retryable === false && typeof err.nextAction === 'string',
  );
  ok('T02a same key different content → idempotency_conflict (structured, non-retryable)');

  // ---- T02b: same key, different domain → independent saves, no cross receipts ----
  const alice = await g.saveMemory('T02 shared content across identities', { memberships: [scope], idempotencyKey: 't02-key', domain: { kind: 'personal', id: 'alice' } });
  const bob = await g.saveMemory('T02 shared content across identities', { memberships: [scope], idempotencyKey: 't02-key', domain: { kind: 'personal', id: 'bob' } });
  assert.notEqual(alice.id, bob.id, 'identities reusing a key must stay independent');
  assert.equal((await db().get('SELECT COUNT(*) AS n FROM nodes WHERE content=?', ['T02 shared content across identities'])).n, 2);
  // no cross-domain receipt: alice retry still returns alice's receipt
  assert.equal((await g.saveMemory('T02 shared content across identities', { memberships: [scope], idempotencyKey: 't02-key', domain: { kind: 'personal', id: 'alice' } })).id, alice.id);
  ok('T02b same key in another domain → independent logical saves, no cross receipts');

  // ---- T02c: pre-upgrade unscoped key migrates on exact retry, never leaks ----
  const mig = await save('T02 legacy migration payload', { idempotencyKey: 'mig-key' });
  const scopedKey = `save:personal\u0000default:mig-key`;
  const priorHash = (await db().get('SELECT request_hash FROM memory_receipts WHERE key=?', [scopedKey])).request_hash;
  await db().run('DELETE FROM memory_receipts WHERE key=?', [scopedKey]);
  await db().run('INSERT INTO memory_receipts(key,request_hash,payload) VALUES (?,?,?)', ['save:mig-key', priorHash, JSON.stringify({ id: mig.id })]);
  const migRetry = await save('T02 legacy migration payload', { idempotencyKey: 'mig-key' });
  assert.equal(migRetry.id, mig.id, 'same-domain retry of a pre-upgrade receipt returns the original result');
  assert(await db().get('SELECT 1 AS x FROM memory_receipts WHERE key=?', [scopedKey]), 'retry migrates the receipt to the scoped key');
  ok('T02c pre-upgrade unscoped receipt key migrates on exact retry');

  // ---- T03a: exact duplicate sourceRefs normalize away ----
  const refs = [{ uri: 'repo:x/a.ts', context: 'main', revision: 'r1' }];
  const dupSaved = await save('T03 duplicate sourceRefs', { sourceRefs: [...refs, ...refs] });
  const stored = JSON.parse((await db().get('SELECT payload FROM memory_sources WHERE memory_id=?', [dupSaved.id])).payload);
  assert.equal(stored.length, 1, 'exact duplicate sourceRefs must dedupe');
  ok('T03a exact duplicate sourceRefs → normalized to one reference');

  // ---- T03b: same locator, different revision → typed conflict with field path ----
  await assert.rejects(
    save('T03 revision conflict', { sourceRefs: [...refs, { ...refs[0], revision: 'r2' }] }),
    (err: any) => err instanceof MindPondError && err.code === 'source_revision_conflict' && err.field === 'sourceRefs[1]' && err.retryable === false,
  );
  ok('T03b same locator different revision → source_revision_conflict with field path');

  // ---- T04: permanent failure does not grow the queue, re-keyed deliveries converge ----
  const w1 = await g.checkpoint(checkpointPayload([first.id], 'cp-t04'));
  assert(w1.workId);
  const claim = await g.claimHostWork(scope.spaceId, scope.memoryType);
  assert.equal(claim!.id, w1.workId);
  await g.finishHostWork({ workId: claim!.id, leaseToken: claim!.leaseToken, outcome: 'failed', reason: 'permanent validation error (simulated)' });
  for (const checkpointId of ['cp-t04-retry-1', 'cp-t04-retry-2', 'cp-t04-retry-3']) {
    const retried = await g.checkpoint(checkpointPayload([first.id], checkpointId));
    assert.equal(retried.workId, w1.workId, `re-keyed delivery must converge on the failed work (${checkpointId})`);
  }
  assert.equal((await workRows()).length, 1, 'failed work must not spawn new queue records');
  ok('T04 re-keyed deliveries of a failed payload converge; queue does not grow');

  // stale lease: core throws the raw error; boundaries classify it (verified below)
  await assert.rejects(
    g.finishHostWork({ workId: 'does-not-exist', leaseToken: 'x', outcome: 'failed', reason: 'bogus' }),
    /stale_work_lease/,
  );
  assert.deepEqual(toStructuredError(new Error('stale_work_lease')), { code: 'stale_lease', message: 'stale_work_lease', retryable: true, nextAction: '重新领取任务后携带当前租约与 attempts 重试' });
  ok('stale lease → stale_lease at the boundary (structured, retryable after re-claim)');

  // ---- legacy bare errors classify at the boundary ----
  assert.equal(toStructuredError(new Error('stale_observation: reload current source observation')).code, 'stale_version');
  assert.equal(toStructuredError(new Error('Only failed work may be explicitly retried')).code, 'invalid_input');
  assert.equal(toStructuredError(new Error('Checkpoint memory outside active domain scope')).code, 'scope_denied');
  ok('legacy error messages classify into the unified table');

  // ---- HTTP error-contract parity on a real server process ----
  const distServer = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.js');
  await fs.access(distServer);
  const httpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-errors-http-'));
  const port = 7923;
  const child = spawn(process.execPath, [distServer], { env: { ...process.env, MEMORY_DB_PATH: path.join(httpDir, 'http.db'), MEMORY_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30000;
    while (!output.includes('listening') && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    assert(output.includes('listening'), 'server did not start');
    const post = async (url: string, body: unknown) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const saveFirst = await post('/api/memory/save', { content: 'HTTP T01 payload', idempotencyKey: 'http-key', memberships: [scope] });
    assert.equal(saveFirst.status, 200);
    const conflict = await post('/api/memory/save', { content: 'HTTP T01 different payload', idempotencyKey: 'http-key', memberships: [scope] });
    assert.equal(conflict.status, 409);
    const conflictBody = await conflict.json() as any;
    assert.equal(conflictBody.code, 'idempotency_conflict');
    assert.equal(conflictBody.retryable, false);
    assert.equal(conflictBody.ok, false);
    assert.equal((await post('/api/memory/save', { content: '' })).status, 400);
    const stale = await post('/api/host/work/finish', { workId: 'nope', leaseToken: 'x', outcome: 'failed', reason: 'bogus' });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as any).code, 'stale_lease');
    ok('HTTP surfaces {ok:false,error,code,retryable,nextAction} with mapped statuses');
  } finally {
    child.kill('SIGTERM');
  }

  console.log(`\nverify:errors PASS (${passed} sections)`);
  process.exit(0);
} catch (err) {
  console.error('verify:errors FAIL', err);
  process.exit(1);
}
