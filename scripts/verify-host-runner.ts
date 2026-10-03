/** R02 gate: total budget, lease isolation and recovery (T05–T09, acceptance
 * handbook §2.2 verify:host-runner). Runs the real WorkDriver against a real
 * GraphMemory on a controlled clock: foreground sleeps (model calls, turn
 * deadlines, backoff) advance the fake timeline, while lease-renewal sleeps
 * are passive — the renewal side loop must never drive the request budget.
 * Fails non-zero on any violation. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GraphMemory } from '../src/core/graph-memory.js';
import type { SourceReference } from '../src/core/growth.js';
import { WorkDriver } from '../src/core/work-driver.js';
import type { ModelAdapter, ModelCallContext, WorkDriverResult, WorkPond, WorkTurnContext, WorkTurnResult } from '../src/core/work-driver.js';

// ---- controlled clock -------------------------------------------------------
const clockState = { now: 1_700_000_000_000 };
const now = () => clockState.now;
interface FakeTimer { at: number; resolve: () => void }
/** Foreground sleeps (model calls, turn deadlines, backoff) drive the clock. */
const timers: FakeTimer[] = [];
/** Background sleeps (lease renewal) never advance the clock — they only
 *  resolve once the timeline already reached them. This mirrors production:
 *  renewal is a side loop and must never extend the request budget (T05b). */
const background: FakeTimer[] = [];
const yieldTick = () => new Promise<void>(resolve => setImmediate(resolve));
const resolveDue = (list: FakeTimer[]) => {
  for (const t of list.filter(t => t.at <= clockState.now)) {
    const i = list.indexOf(t);
    if (i >= 0) list.splice(i, 1);
    t.resolve();
  }
};
const delay = (ms: number) => new Promise<void>(resolve => {
  timers.push({ at: clockState.now + Math.max(0, ms), resolve });
});
const passiveDelay = (ms: number) => new Promise<void>(resolve => {
  background.push({ at: clockState.now + Math.max(0, ms), resolve });
});
/** Advance the clock to the earliest foreground timer and settle what is due. */
async function step(): Promise<void> {
  const earliest = timers.reduce<FakeTimer | undefined>((a, b) => (!a || b.at < a.at ? b : a), undefined);
  if (earliest && earliest.at > clockState.now) clockState.now = earliest.at;
  resolveDue(background);
  resolveDue(timers);
  await yieldTick(); // let continuations run and register follow-ups
}
/** Advance the clock by a fixed amount (test-script pacing, e.g. T09 cancel). */
async function stepBy(ms: number): Promise<void> {
  clockState.now += Math.max(0, ms);
  resolveDue(background);
  resolveDue(timers);
  await yieldTick();
}
/** Run a driver to completion on the fake timeline: step while foreground
 *  timers are pending; yield through real-I/O gaps otherwise. Real-time idle
 *  guard: first-run embedding loads can block/occupy the loop for seconds. */
async function drain<T>(p: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = p.then((v: T) => { settled = true; return v; }, e => { settled = true; throw e; });
  let idleSince = Date.now();
  while (!settled) {
    if (timers.length) { idleSince = Date.now(); await step(); }
    else {
      if (Date.now() - idleSince > 30_000) throw new Error(`harness: work stalled with no pending timers (fg=${timers.length} bg=${background.length})`);
      await yieldTick();
    }
  }
  return tracked;
}

// ---- fixture ----------------------------------------------------------------
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-host-runner-'));
process.env.MEMORY_DB_PATH = path.join(dir, 'pond.db');
process.env.EMBEDDING_ZH_ENABLED = 'false';
const g = new GraphMemory('.', { clock: now });
const scope = { spaceId: 'verify/runner', memoryType: 'knowledge' };
const ref = (name: string): SourceReference => ({ uri: `repo:verify/${name}.ts`, context: 'main', revision: 'r1', fingerprint: `${name}-r1` });
const create = async (name: string) => g.saveMemory(`${name}: explicit code behavior with its constraints and evidence.`, { memberships: [scope], sourceRefs: [ref(name)] });
const db = () => (g as any).db;
const memberOf = (saved: { memberships?: Array<{ id: string }> }): string => {
  const id = saved.memberships?.[0]?.id;
  if (!id) throw new Error('fixture memory has no membership');
  return id;
};
const workRow = async (workId: string) => {
  const row = (await g.listHostWork(scope.spaceId, scope.memoryType)).find((w: { id: string }) => w.id === workId);
  if (!row) throw new Error(`work ${workId} missing`);
  return row;
};

let passed = 0;
const ok = (label: string) => { passed += 1; console.log(`PASS ${label}`); };

const scriptedAdapter = (supportsCancel: boolean, script: (ctx: ModelCallContext) => Promise<string>): ModelAdapter =>
  ({ name: 'scripted', supportsCancel, call: ({ context }) => script(context) });
const immediateAdapter: ModelAdapter = { name: 'immediate', supportsCancel: true, call: async () => 'ok' };
const noChangeHandler = async (_ctx: WorkTurnContext): Promise<WorkTurnResult> => ({ outcome: 'no_change', reason: 'nothing to organize' });

try {
  await g.init();
  const m1 = await create('routing'), m2 = await create('storage');
  const checkpointFor = async (tag: string) => g.checkpoint({
    hostId: 'verify-driver', runId: `run-${tag}`, checkpointId: tag, ...scope,
    outcome: 'saved' as const, reason: `Verify ${tag}`, memoryIds: [m1.id, m2.id],
  });

  // ---- T05: 120s budget covers rate-limit waits, backoff and retries --------
  await checkpointFor('t05');
  const adapter: ModelAdapter = {
    name: 't05', supportsCancel: true,
    call: async ({ context }) => {
      if (context.turn === 1) { await delay(60_000); return 'LATE-TURN-1'; } // exceeds the 50s turn deadline
      await delay(30_000); return 'TURN2-TEXT';                              // resolves exactly at the 120s budget edge
    },
  };
  const driver = new WorkDriver(g, adapter, { totalBudgetMs: 120_000, turnDeadlineMs: 50_000, retryBackoffMs: 40_000, now, delay, renewDelay: passiveDelay });
  const r05 = await drain(driver.runOne(scope, async ctx => {
    const text = await ctx.callModel('organize');
    return { outcome: 'completed', reason: `submitted:${text}` };
  })) as WorkDriverResult;
  assert.equal(r05.budgetExhausted, true, 'budget must be marked exhausted');
  assert.equal(r05.turns, 2, `a reset-budget implementation would run extra turns, got ${r05.turns}`);
  assert.ok(r05.elapsedMs <= 120_000, `120s budget must not become ${r05.elapsedMs}ms`);
  assert.equal(r05.finalStatus, 'deferred');
  const t05row = await workRow(r05.workId!);
  assert.equal(t05row.status, 'leased', 'nothing may be submitted after budget exhaustion');
  assert.equal(t05row.receipt, null, 'late/edge results must never be committed (T05)');
  await g.cancelHostWork(r05.workId!, 'T05 cleanup: keep the queue deterministic');
  ok('T05 all waits/retries counted in one 120s budget; late result not submitted');

  // ---- renewal never resets the execution budget ---------------------------
  // Renewal is stubbed at the pond boundary: this scenario targets the
  // driver's cadence and budget discipline (the core's conditional renewal
  // UPDATE is exercised for real in T06). The stub keeps the harness
  // deterministic — fake time must never race real sqlite round-trips.
  await checkpointFor('t05b');
  let renewCount = 0;
  const countingPond: WorkPond = {
    claimHostWork: (s, m, d) => g.claimHostWork(s, m, d),
    renewHostWork: async () => { renewCount += 1; return { leaseUntil: now() + 300_000 }; },
    finishHostWork: input => g.finishHostWork(input),
    cancelHostWork: (id, reason) => g.cancelHostWork(id, reason),
  };
  const deadlines = new Set<number>();
  const turnTimes: number[] = [];
  const driverB = new WorkDriver(countingPond, scriptedAdapter(true, async () => { await delay(30_000); return 'text'; }),
    { totalBudgetMs: 120_000, turnDeadlineMs: 100_000, leaseMs: 30_000, retryBackoffMs: 1_000, now, delay, renewDelay: passiveDelay });
  const r05b = await drain(driverB.runOne(scope, async ctx => {
    deadlines.add(ctx.context.deadlineAt);
    turnTimes.push(clockState.now);
    await ctx.callModel('x');
    throw new Error('temporarily_unavailable: index rebuild in progress');
  })) as WorkDriverResult;
  assert.equal(r05b.budgetExhausted, true);
  assert.equal(deadlines.size, 1, 'the request deadline is fixed: renewal/retries never reset the budget');
  assert.ok(renewCount >= 2, `lease renewal must run on its own cadence (got ${renewCount})`);
  assert.equal((await workRow(r05b.workId!)).attempts, 1, 'renewal must not bump attempts');
  assert.ok(turnTimes.every((t, i) => i === 0 || t >= turnTimes[i - 1]), 'turns advance monotonically on the shared clock');
  await g.cancelHostWork(r05b.workId!, 'T05b cleanup: keep the queue deterministic');
  ok('T05b renewal extends the lease only; the budget deadline never resets');

  // ---- T06: crash recovery; a late executor can neither renew nor commit ----
  await checkpointFor('t06');
  const crash = await g.claimHostWork(scope.spaceId, scope.memoryType);
  assert(crash, 'work must be claimable');
  clockState.now += 60_000; // some execution time passes, then a routine renewal
  const renewedLease = await g.renewHostWork(crash.id, crash.leaseToken) as { leaseUntil: number };
  assert.ok(renewedLease.leaseUntil > crash.leaseUntil, 'a live lease renews and extends only the lease window');
  clockState.now += 300_001; // executor 1 "crashes": process gone, renewed lease expires
  await assert.rejects(g.renewHostWork(crash.id, crash.leaseToken), /stale_work_lease/, 'old token cannot renew after expiry');
  const rowsBeforeRecovery = (await g.listHostWork(scope.spaceId, scope.memoryType)).length;
  const driver2 = new WorkDriver(g, immediateAdapter, { totalBudgetMs: 60_000, now, delay, renewDelay: passiveDelay });
  const r06 = await driver2.runOne(scope, noChangeHandler) as WorkDriverResult;
  assert.equal(r06.workId, crash.id, 'the second executor must recover the same logical work');
  assert.equal(r06.finalStatus, 'completed');
  await assert.rejects(
    g.finishHostWork({ workId: crash.id, leaseToken: crash.leaseToken, outcome: 'no_change', reason: 'late executor tries to write' }),
    /stale_work_lease/, 'the crashed executor must not be able to commit late');
  const t06row = await workRow(crash.id);
  assert.equal(t06row.status, 'completed');
  assert.equal(t06row.attempts, 2, 'exactly one recovery claim happened');
  assert.equal((await g.listHostWork(scope.spaceId, scope.memoryType)).length, rowsBeforeRecovery, 'recovery must not duplicate the work row');
  ok('T06 crash recovery: second executor completes; old token cannot renew or submit');

  // cancel wins before expiry: cancelled work is not claimable afterwards
  await checkpointFor('t06b');
  const victim = await g.claimHostWork(scope.spaceId, scope.memoryType);
  assert(victim);
  const cancelRes = await g.cancelHostWork(victim.id, 'host stopped the request');
  assert.equal(cancelRes.status, 'cancelled');
  clockState.now += 300_001;
  assert.equal(await g.claimHostWork(scope.spaceId, scope.memoryType), null, 'cancelled work must not be re-claimed');
  ok('T06b cancelled work leaves the queue permanently');

  // ---- T07: committed but receipt lost → replay returns the original result -
  const m3 = await create('validation');
  const t07job = await g.claimOrganizationJob({ ...scope, membershipIds: [memberOf(m1), memberOf(m2)] });
  assert(t07job, 'organization job must be claimable');
  const keepPlan = { operations: [{ kind: 'keep' as const, membershipIds: [memberOf(m1), memberOf(m2)], reason: 'distinct constraints stay separate' }] };
  const nodesBefore = (await db().get('SELECT COUNT(*) AS n FROM nodes')).n;
  const receipt07 = await g.commitOrganizationPlan(t07job.id, keepPlan);
  assert.deepEqual(await g.commitOrganizationPlan(t07job.id, keepPlan), receipt07, 'retrying the same commit returns the original receipt');
  assert.equal((await db().get('SELECT COUNT(*) AS n FROM nodes')).n, nodesBefore, 'no duplicate bodies on commit replay');
  await assert.rejects(g.commitOrganizationPlan(t07job.id, { operations: [{ kind: 'keep', membershipIds: [memberOf(m3)], reason: 'other' }] }), /different plan|Completed job/);
  ok('T07 commit replay returns the original receipt without duplicate writes');

  // host_work finish replay is equally idempotent
  await checkpointFor('t07b');
  const t07claim = await g.claimHostWork(scope.spaceId, scope.memoryType);
  assert(t07claim);
  const finishInput = { workId: t07claim.id, leaseToken: t07claim.leaseToken, outcome: 'no_change' as const, reason: 'replay check' };
  assert.deepEqual(await g.finishHostWork(finishInput), { status: 'completed' });
  assert.deepEqual(await g.finishHostWork(finishInput), { status: 'completed' }, 'identical finish replay returns the original result');
  ok('T07b host_work finish replay is idempotent');

  // ---- T08: cancel vs commit — one atomic, persistent outcome ---------------
  // Both serial orders pin the state machine deterministically; the concurrent
  // race at the end asserts the invariant (scheduler may pick either winner).
  // organization job, serial: cancel wins
  const jobA = await g.claimOrganizationJob({ ...scope, membershipIds: [memberOf(m1), memberOf(m2)] });
  assert(jobA);
  assert.deepEqual(await g.cancelOrganizationJob(jobA.id), { status: 'cancelled' });
  await assert.rejects(g.commitOrganizationPlan(jobA.id, keepPlan), /stale_work_lease/, 'commit after a won cancel must be rejected');
  assert.ok((await db().get('SELECT cancelled_at FROM organization_jobs WHERE id=?', [jobA.id])).cancelled_at !== null);
  assert.equal((await db().get('SELECT COUNT(*) AS n FROM nodes')).n, nodesBefore, 'a cancelled job must not have written anything');
  // organization job, serial: commit wins — the receipt is preserved
  clockState.now += 300_001; // let the cancelled job's lease lapse so members free up
  const jobB = await g.claimOrganizationJob({ ...scope, membershipIds: [memberOf(m1), memberOf(m2)] });
  assert(jobB, 'members of a cancelled job must become claimable again after its lease lapses');
  const receiptB = await g.commitOrganizationPlan(jobB.id, keepPlan);
  const cancelB = await g.cancelOrganizationJob(jobB.id);
  assert.equal(cancelB.status, 'completed', 'cancel of a completed job reports the winner');
  assert.deepEqual(cancelB.receipt, receiptB, 'cancel of a completed job preserves the receipt');
  // organization job, concurrent race: exactly one persistent outcome
  const jobC = await g.claimOrganizationJob({ ...scope, membershipIds: [memberOf(m1), memberOf(m2)] });
  assert(jobC);
  const [cancelC, commitC] = await Promise.allSettled([
    g.cancelOrganizationJob(jobC.id),
    g.commitOrganizationPlan(jobC.id, keepPlan),
  ]);
  assert.equal((await db().get('SELECT COUNT(*) AS n FROM nodes')).n, nodesBefore, 'a raced job must not leave partial writes');
  if (commitC.status === 'fulfilled') {
    assert.equal(cancelC.status, 'fulfilled', 'cancel never rejects — it reports the persisted outcome');
    assert.equal((cancelC as PromiseFulfilledResult<{ status: string }>).value.status, 'completed');
    assert.deepEqual((cancelC as PromiseFulfilledResult<{ status: string; receipt?: unknown }>).value.receipt,
      (commitC as PromiseFulfilledResult<unknown>).value, 'late cancel preserves the commit receipt');
  } else {
    assert.equal(cancelC.status, 'fulfilled');
    assert.deepEqual((cancelC as PromiseFulfilledResult<{ status: string }>).value, { status: 'cancelled' });
    assert.match((commitC as PromiseRejectedResult).reason.message, /stale_work_lease/);
    assert.ok((await db().get('SELECT cancelled_at FROM organization_jobs WHERE id=?', [jobC.id])).cancelled_at !== null);
  }
  ok('T08 organization cancel/commit: both serial orders pinned; race yields exactly one persistent outcome');

  // host_work, both serial orders + one concurrent race
  await checkpointFor('t08');
  const hwA = await g.claimHostWork(scope.spaceId, scope.memoryType);
  assert(hwA);
  assert.deepEqual(await g.cancelHostWork(hwA.id, 'cancel first'), { status: 'cancelled' });
  await assert.rejects(
    g.finishHostWork({ workId: hwA.id, leaseToken: hwA.leaseToken, outcome: 'no_change', reason: 'finish after a won cancel' }),
    /stale_work_lease/, 'finish after a won cancel must be rejected');
  assert.equal((await workRow(hwA.id)).status, 'cancelled');
  await checkpointFor('t08b');
  const hwB = await g.claimHostWork(scope.spaceId, scope.memoryType);
  assert(hwB);
  assert.deepEqual(await g.finishHostWork({ workId: hwB.id, leaseToken: hwB.leaseToken, outcome: 'no_change', reason: 'finish first' }), { status: 'completed' });
  assert.equal((await g.cancelHostWork(hwB.id, 'cancel second')).status, 'completed', 'losing cancel reports the winner');
  assert.equal((await workRow(hwB.id)).status, 'completed');
  await checkpointFor('t08c');
  const hwC = await g.claimHostWork(scope.spaceId, scope.memoryType);
  assert(hwC);
  const [finishC, cancelC2] = await Promise.allSettled([
    g.finishHostWork({ workId: hwC.id, leaseToken: hwC.leaseToken, outcome: 'no_change', reason: 'raced finish' }),
    g.cancelHostWork(hwC.id, 'raced cancel'),
  ]);
  const rowC = (await workRow(hwC.id)).status;
  assert.ok(rowC === 'completed' || rowC === 'cancelled', 'the race must settle on exactly one persistent status');
  if (rowC === 'completed') {
    assert.equal(finishC.status, 'fulfilled');
    assert.equal((cancelC2 as PromiseFulfilledResult<{ status: string }>).value.status, 'completed', 'losing cancel reports the winner');
  } else {
    assert.deepEqual((cancelC2 as PromiseFulfilledResult<{ status: string }>).value, { status: 'cancelled' });
    assert.equal(finishC.status, 'rejected', 'finish after a won cancel must be rejected');
    assert.match((finishC as PromiseRejectedResult).reason.message, /stale_work_lease/);
  }
  ok('T08 host_work finish/cancel: both serial orders pinned; race yields exactly one persistent outcome');

  // ---- T09: a model that cannot be aborted — late results are rejected ------
  await checkpointFor('t09');
  // started-gate: the cancel must land while the model call is genuinely
  // in flight, so wait until the unabortable adapter has begun its delay.
  let modelStarted!: () => void;
  const modelInFlight = new Promise<void>(resolve => { modelStarted = resolve; });
  const driver9 = new WorkDriver(g, scriptedAdapter(false, async () => { modelStarted(); await delay(60_000); return 'T09-LATE-TEXT'; }),
    { totalBudgetMs: 120_000, turnDeadlineMs: 100_000, now, delay, renewDelay: passiveDelay });
  const run09 = driver9.runOne(scope, async ctx => {
    const text = await ctx.callModel('organize');
    return { outcome: 'completed', reason: `submitted:${text}` };
  }) as Promise<WorkDriverResult>;
  await modelInFlight;
  await stepBy(10_000);
  driver9.cancel('user asked to stop');
  const r09 = await drain(run09);
  assert.equal(r09.cancelled, true);
  assert.equal(r09.degraded, true, 'an unabortable call must be reported as degraded');
  assert.equal(r09.finalStatus, 'cancelled');
  const t09row = await workRow(r09.workId!);
  assert.equal(t09row.status, 'cancelled', 'the late model result must not complete the work');
  assert.equal(t09row.receipt, null, 'T09-LATE-TEXT must never reach a receipt');
  ok('T09 unabortable model: late submission discarded, run reported degraded+cancelled');

  // core-side backstop: after cancel the lease is dead, any late finish (even
  // from a misbehaving host) is rejected by the transactional guard.
  await checkpointFor('t09b');
  const t09claim = await g.claimHostWork(scope.spaceId, scope.memoryType);
  assert(t09claim);
  await g.cancelHostWork(t09claim.id, 'cancel before late finish');
  await assert.rejects(
    g.finishHostWork({ workId: t09claim.id, leaseToken: t09claim.leaseToken, outcome: 'no_change', reason: 'late finish after cancel' }),
    /stale_work_lease/, 'core must reject a finish against a cancelled work');
  ok('T09b core rejects late finish after cancel (transactional guard)');

  console.log(`PASS verify:host-runner: ${passed} scenarios (T05–T09) on the real service boundary`);
} catch (error) {
  console.error('FAIL verify:host-runner:', error);
  process.exitCode = 1;
} finally {
  await g.close();
  await fs.rm(dir, { recursive: true, force: true });
}
