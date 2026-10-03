/**
 * M03 verify: session close / purge / restore semantics hold against the real
 * store, including restart and stale-work replay (roadmap M03 + handbook
 * M03.a–M03.d).
 *
 * Regression targets:
 *
 *  1. close → ordinary recall loses the session; controlled reopen
 *     (setSessionState active) is the only way back; reopen is audited.
 *  2. Expired cleanup invalidates old session work: closed-session
 *     host_work items and organization candidates are no longer claimable.
 *  3. purge removes temporary bodies, associations, indexes, profiles,
 *     candidate jobs and recallable caches; the action log keeps only
 *     sanitized audit rows — the deleted content can never be re-read
 *     through any API.
 *  4. Reusing a purged session id cannot revive content: a tombstone blocks
 *     save/ingest/checkpoint/reopen; stale work tokens stay stale; personal
 *     nodes whose source session was purged remain readable.
 *
 * Sections expected to FAIL before the M03 implementation are marked
 * [M03 gap]; they double as the failing-counterexample evidence.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { GraphMemory } from '../src/core/graph-memory.js';
import type { SynthesizeOperation } from '../src/core/growth.js';

const scope = { spaceId: 'project/lifecycle', memoryType: 'knowledge' };
let failures = 0;
let checks = 0;
function ok(condition: unknown, message: string): void {
  checks++;
  if (!condition) { failures++; console.log(`  FAIL  ${message}`); }
}
/** Collecting rejection check: a counterexample must not abort the run. */
async function rejects(pattern: RegExp, message: string, fn: () => Promise<unknown>): Promise<void> {
  checks++;
  try {
    await fn();
    failures++;
    console.log(`  FAIL  ${message} (resolved instead of rejecting)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!pattern.test(msg)) { failures++; console.log(`  FAIL  ${message} (wrong error: ${msg})`); }
  }
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  process.env.MEMORY_DB_PATH = path.join(dir, 'pond.db');
  process.env.EMBEDDING_MODEL_DIR = path.join(dir, 'no-models');
  return dir;
}

/** Raw table counters — purge residue is invisible through the node APIs. */
async function tableCounts(dbFile: string, session: string): Promise<Record<string, number>> {
  const raw = await open({ filename: dbFile, driver: sqlite3.Database });
  try {
    const one = async (sql: string, params: unknown[] = []) =>
      (await raw.get<{ n: number }>(sql, params as any[]))?.n ?? 0;
    const tombstoneTable = await raw.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='session_tombstones'");
    return {
      sessionNodes: await one("SELECT COUNT(*) AS n FROM nodes WHERE domain_kind='session' AND domain_id=?", [session]),
      profileRevisionsForSession: await one(
        `SELECT COUNT(*) AS n FROM profile_revisions WHERE profile_id IN (
           SELECT m.id FROM memory_memberships m JOIN nodes n ON n.id = m.memory_id
           WHERE n.domain_kind='session' AND n.domain_id=?)`, [session]),
      orphanProfileRevisions: await one(
        `SELECT COUNT(*) AS n FROM profile_revisions WHERE profile_id NOT IN (SELECT id FROM memory_memberships)`),
      organizationJobs: await one("SELECT COUNT(*) AS n FROM organization_jobs WHERE domain_kind='session' AND domain_id=?", [session]),
      hostWork: await one("SELECT COUNT(*) AS n FROM host_work WHERE domain_kind='session' AND domain_id=?", [session]),
      workContexts: await one("SELECT COUNT(*) AS n FROM work_contexts WHERE domain_kind='session' AND domain_id=?", [session]),
      tombstones: tombstoneTable?.n ? await one('SELECT COUNT(*) AS n FROM session_tombstones WHERE session_id=?', [session]) : 0,
    };
  } finally {
    await raw.close();
  }
}

async function leakScan(dbFile: string, session: string, tokens: string[]): Promise<string[]> {
  const raw = await open({ filename: dbFile, driver: sqlite3.Database });
  try {
    const leaks: string[] = [];
    const log = await raw.all<Array<{ action: string; reason: string | null }>>(
      'SELECT action, reason FROM memory_action_log');
    for (const row of log) {
      const text = `${row.action} ${row.reason ?? ''}`;
      for (const token of tokens) if (text.includes(token)) leaks.push(`action log ${row.action} leaks "${token}"`);
    }
    // Any surviving row in a session-owned table must not hold the body text.
    const payloadRows = await raw.all<Array<{ payload: string | null; snapshot: string | null; goal: string | null }>>(
      `SELECT payload, NULL AS snapshot, NULL AS goal FROM host_work WHERE domain_kind='session' AND domain_id=?
       UNION ALL SELECT NULL, snapshot, NULL FROM organization_payloads WHERE job_id IN (SELECT id FROM organization_jobs WHERE domain_kind='session' AND domain_id=?)
       UNION ALL SELECT NULL, NULL, goal FROM work_contexts WHERE domain_kind='session' AND domain_id=?`, [session, session, session]);
    for (const row of payloadRows) {
      const text = `${row.payload ?? ''} ${row.snapshot ?? ''} ${row.goal ?? ''}`;
      for (const token of tokens) if (text.includes(token)) leaks.push('work payload leaks deleted session content');
    }
    return [...new Set(leaks)];
  } finally {
    await raw.close();
  }
}

async function main(): Promise<void> {
  const dir = await makeTempDir('mindpond-lifecycle-');
  const dbFile = process.env.MEMORY_DB_PATH!;
  const g = new GraphMemory();
  try {
    await g.init();

    // ---- seed: session material, a personal fact sourced from it, org profile ----
    const a = await g.saveMemory('SESSION_LIFE_TOKEN_A: investigation note of the closed session.', {
      domain: { kind: 'session', id: 'life-s1' }, sessionId: 'life-s1',
      memberships: [scope], source: 'conversation',
    });
    const b = await g.saveMemory('SESSION_LIFE_TOKEN_B: complementary note of the same session.', {
      domain: { kind: 'session', id: 'life-s1' }, sessionId: 'life-s1',
      memberships: [scope], source: 'conversation',
    });
    const personal = await g.saveMemory('PERSONAL_LIFE_TOKEN: durable rule captured during life-s1.', {
      domain: { kind: 'personal', id: 'default' }, sessionId: 'life-s1',
      source: 'knowledge',
    });
    assert.ok(a.id && b.id && personal.id);

    // A durable profile over the session material (so purge has profile
    // history to clean), via the real organization flow.
    const job = await g.claimOrganizationJob({
      domain: { kind: 'session', id: 'life-s1' }, spaceId: scope.spaceId, memoryType: scope.memoryType,
      membershipIds: [a.memberships![0].id, b.memberships![0].id],
    });
    assert.ok(job, 'active session materials are organizable before close');
    const synthesis: SynthesizeOperation = {
      kind: 'synthesize',
      membershipIds: [a.memberships![0].id, b.memberships![0].id],
      content: 'SESSION_PROFILE_TOKEN: session-scoped synthesis of the two investigation notes.',
      profile: { title: 'Investigation', coverage: ['Both notes'], unknowns: ['Outcome'] },
      reason: 'Two halves of one investigation.',
      supports: [
        { membershipId: a.memberships![0].id, claim: 'Note A', context: 'life-s1' },
        { membershipId: b.memberships![0].id, claim: 'Note B', context: 'life-s1' },
      ],
    };
    const committed = await g.commitOrganizationPlan(job!.id, { operations: [synthesis] } as never);
    assert.equal(committed.createdMemoryIds.length, 1, 'session-domain synthesis commits');

    // Old pending work for this session (checkpoint with organization request).
    await g.checkpoint({
      hostId: 'life-host', runId: 'life-run', checkpointId: 'life-ckpt',
      domain: { kind: 'session', id: 'life-s1' }, spaceId: scope.spaceId, memoryType: scope.memoryType,
      outcome: 'saved', reason: 'session captured material', memoryIds: [a.id, b.id],
      requestOrganization: true,
    });
    const pendingBefore = await g.claimHostWork(scope.spaceId, scope.memoryType, { kind: 'session', id: 'life-s1' });
    assert.ok(pendingBefore, 'pending session work exists before close');

    // ---- S1: close hides the session from ordinary recall; reopen restores ----
    console.log('--- S1: close → invisible; controlled reopen → visible again ---');
    await g.setSessionState('life-s1', 'closed');
    const closedSearch = await g.search({ query: 'SESSION_LIFE_TOKEN_A investigation', sessionId: 'life-s1' });
    ok(!closedSearch.some(r => r.node.id === a.id), 'closed session is not returned by search');
    const closedList = await g.listNodes({ sessionId: 'life-s1' });
    ok(!closedList.nodes.some(n => n.id === a.id), 'closed session is not returned by list');
    await assert.rejects(
      g.getNodeById(a.id, { trackAccess: false, context: { sessionId: 'life-s1' } }),
      /closed/, 'bare-id read of a closed session node is rejected');
    // The closed job lease must not survive the close either.
    await rejects(/lease|expired|unknown|closed/i, '[M03 gap] organization lease of a closed session cannot commit afterwards',
      () => g.commitOrganizationPlan(job!.id, { operations: [synthesis] } as never));

    await g.setSessionState('life-s1', 'active');
    const reopened = await g.getNodeById(a.id, { trackAccess: false, context: { sessionId: 'life-s1' } });
    ok(reopened && reopened.content.includes('SESSION_LIFE_TOKEN_A'), 'controlled reopen restores readability');
    await g.setSessionState('life-s1', 'closed');

    // ---- S2 [M03 gap]: closed session work must be unclaimable ----
    console.log('--- S2: closed session invalidates pending work and candidates ---');
    const closedWorkClaim = await g.claimHostWork(scope.spaceId, scope.memoryType, { kind: 'session', id: 'life-s1' });
    ok(closedWorkClaim === null, '[M03 gap] closed session host_work must not be claimable');
    const closedOrgClaim = await g.claimOrganizationJob({
      domain: { kind: 'session', id: 'life-s1' }, spaceId: scope.spaceId, memoryType: scope.memoryType,
      membershipIds: [a.memberships![0].id, b.memberships![0].id],
    });
    ok(closedOrgClaim === null, '[M03 gap] closed session organization candidates must not be claimable');

    // ---- S3 [M03 gap]: purge removes everything recallable, log stays sanitized ----
    console.log('--- S3: purge cleanup scope and sanitized audit ---');
    await g.purgeClosedSession('life-s1');
    const afterPurge = await tableCounts(dbFile, 'life-s1');
    ok(afterPurge.sessionNodes === 0, 'purge deletes session bodies');
    ok(afterPurge.profileRevisionsForSession === 0 && afterPurge.orphanProfileRevisions === 0,
      `[M03 gap] purge removes profile history of the session (got ${JSON.stringify(afterPurge)})`);
    ok(afterPurge.organizationJobs === 0, `[M03 gap] purge removes session organization jobs (got ${afterPurge.organizationJobs})`);
    ok(afterPurge.hostWork === 0, `[M03 gap] purge removes session work items (got ${afterPurge.hostWork})`);
    ok(afterPurge.workContexts === 0, `[M03 gap] purge removes session collaboration contexts (got ${afterPurge.workContexts})`);
    ok(afterPurge.tombstones === 1, '[M03 gap] purge writes a reuse tombstone');

    const leaks = await leakScan(dbFile, 'life-s1', ['SESSION_LIFE_TOKEN_A', 'SESSION_LIFE_TOKEN_B', 'SESSION_PROFILE_TOKEN']);
    ok(leaks.length === 0, `[M03 gap] no API/table can re-read purged content (leaks: ${leaks.join('; ') || 'none'})`);
    const profileStill = await g.getProfileHistory('nonexistent-membership').catch(() => null);
    ok(profileStill !== undefined, 'profile history API stays answerable after purge');

    // ---- S4 [M03 gap]: tombstone blocks revival through any entry ----
    console.log('--- S4: purged session id cannot revive content ---');
    await rejects(/purged/, '[M03 gap] save into a purged session id must be rejected',
      () => g.saveMemory('REVIVE_TOKEN: replayed outbox save.', { domain: { kind: 'session', id: 'life-s1' }, sessionId: 'life-s1' }));
    await rejects(/purged/, '[M03 gap] ingest into a purged session id must be rejected',
      () => g.ingestTranscript('REVIVE_TOKEN: replayed raw capture', 'life-s1', 'replay-1'));
    await rejects(/purged/, '[M03 gap] a purged session cannot be reopened',
      () => g.setSessionState('life-s1', 'active'));
    await rejects(/purged/, '[M03 gap] checkpoint replay into a purged session must be rejected',
      () => g.checkpoint({
        hostId: 'life-host', runId: 'life-run', checkpointId: 'life-ckpt-2',
        domain: { kind: 'session', id: 'life-s1' }, spaceId: scope.spaceId, memoryType: scope.memoryType,
        outcome: 'saved', reason: 'stale replay', memoryIds: [a.id, b.id],
      }));
    await rejects(/stale|not|purged/i, '[M03 gap] stale work token cannot settle after purge',
      () => g.finishHostWork({ workId: pendingBefore!.id, leaseToken: pendingBefore!.leaseToken, outcome: 'completed', reason: 'stale worker finishes after purge' }));
    const reviveSearch = await g.search({ query: 'REVIVE_TOKEN', sessionId: 'life-s1' });
    ok(!reviveSearch.some(r => r.node.content.includes('REVIVE_TOKEN')), 'no revived content is searchable');

    // ---- S5: personal knowledge sourced from the session survives; restart holds ----
    console.log('--- S5: personal survives purge; tombstone and refusal survive restart ---');
    const personalAfter = await g.getNodeById(personal.id, { trackAccess: false, context: { domains: [{ kind: 'personal', id: 'default' }] } });
    ok(personalAfter && personalAfter.content.includes('PERSONAL_LIFE_TOKEN'),
      'personal knowledge sourced from the purged session is retained');
    await g.close();
    const g2 = new GraphMemory();
    try {
      await g2.init();
      const personalRestart = await g2.getNodeById(personal.id, { trackAccess: false, context: { domains: [{ kind: 'personal', id: 'default' }] } });
      ok(personalRestart && personalRestart.content.includes('PERSONAL_LIFE_TOKEN'), 'restart keeps the personal node');
      const still = await tableCounts(dbFile, 'life-s1');
      ok(still.tombstones === 1, 'restart keeps the purge tombstone');
      await rejects(/purged/, 'restart replay of the old session outbox stays rejected',
        () => g2.saveMemory('REVIVE_TOKEN2: post-restart replay.', { domain: { kind: 'session', id: 'life-s1' }, sessionId: 'life-s1' }));
      const searchable = await g2.search({ query: 'PERSONAL_LIFE_TOKEN durable rule' });
      ok(searchable.some(r => r.node.id === personal.id), 'personal knowledge remains recallable after restart');
    } finally {
      await g2.close();
    }

    console.log(`\nverify-session-lifecycle: ${checks - failures}/${checks} checks passed`);
    if (failures > 0) {
      console.log(`verify-session-lifecycle: FAILED — ${failures} check(s) violate the M03 matrix`);
      process.exitCode = 1;
    }
  } finally {
    try { await g.close(); } catch { /* closed in S5 */ }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('verify-session-lifecycle: fatal:', err);
  process.exit(1);
});
