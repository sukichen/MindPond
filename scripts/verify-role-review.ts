/** Regression cases found by the second role/session review. No live data/models. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GraphMemory } from '../src/core/graph-memory.js';
import type { TrustedCallContext } from '../src/core/trust.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-role-review-'));
const graph = new GraphMemory('.', { dbPath: path.join(dir, 'fixture.db') });
const second = new GraphMemory('.', { dbPath: path.join(dir, 'fixture.db') });
const admin: TrustedCallContext = { v: 1, principal: 'operator', operator: true, issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
const failures: string[] = [];
async function check(name: string, run: () => Promise<void>) {
  try { await run(); console.log('PASS ' + name); }
  catch (e) { failures.push(name); console.error('FAIL ' + name + ': ' + String(e)); }
}
try {
  await graph.init(); await second.init();
  await graph.offices.configureAgent({ id: 'cli', principal: 'owner', name: 'Fixture', host: 'codex', state: 'active', expectedRevision: 0 }, admin);
  async function character(runtimeId: string) {
    const actor: TrustedCallContext = { v: 1, principal: 'owner', agentId: 'cli', transport: 'http-mcp', runtimeId, issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
    const app = await graph.roles.application({ action: 'submit', name: runtimeId, introduction: 'Synthetic reviewer', reason: 'Fixture', key: runtimeId }, actor);
    const approved = await graph.roles.review({ applicationId: app.applicationId, expectedRevision: 1, action: 'approve' }, admin);
    return { ...actor, roleId: approved.roleId, roleBindingId: approved.bindingId, roleBindingEpoch: 1 };
  }
  const a = await character('a'), b = await character('b');
  await graph.roles.configureOffice({ id: 'room', title: 'Fixture', goal: 'Review', acceptance: 'Evidence', expectedRevision: 0, state: 'active', deadline: Date.now() + 3600000, maxRounds: 3, seats: [
    { id: 'dev', agentId: 'cli', roleId: a.roleId, label: 'Developer', role: 'worker' },
    { id: 'test', agentId: 'cli', roleId: b.roleId, label: 'Reviewer', role: 'reviewer' }
  ] }, admin);
  const opened = await graph.offices.open({ assignmentId: 'dev' }, a);
  assert.equal((await graph.roles.officeContext(a)).workSessionId, opened.context!.workSessionId, 'implicit role context resumes an explicit authorized session');
  // Remove only the cache to preserve the original explicit-session failure case.
  const db = (graph as any).db;
  await db.run('DELETE FROM role_office_contexts WHERE binding_id=?', a.roleBindingId);
  const created = await graph.offices.item({ action: 'create', workSessionId: opened.context!.workSessionId, title: 'Fix fixture', acceptance: 'Exact evidence', owner: 'dev', reviewer: 'test', key: 'create' }, a);
  await check('role inbox exposes office messages AND assigned work', async () => {
    const reviewSession = await graph.roles.officeContext(b);
    await graph.offices.exchange({ action: 'send', workSessionId: reviewSession.workSessionId, recipient: 'dev', kind: 'request', body: 'Please inspect this fixture', key: 'office-msg' }, b);
    const inbox = await graph.roles.receive({}, a);
    assert(inbox.officePending?.some((x: any) => x.kind === 'message' && x.assignmentId === 'dev'));
    assert(inbox.officePending?.some((x: any) => x.kind === 'item' && x.itemId === created.item.id));
  });
  const claimed = await graph.offices.item({ action: 'claim', workSessionId: opened.context!.workSessionId, itemId: created.item.id, expectedRevision: created.item.revision, key: 'claim' }, a);
  assert(claimed);
  const outgoing = await graph.offices.exchange({ action: 'send', workSessionId: opened.context!.workSessionId, recipient: 'test', kind: 'request', body: 'Await verification', key: 'wait-request' }, a);
  let started!: () => void;
  const waitStarted = new Promise<void>(resolve => { started = resolve; });
  const originalRun = db.run.bind(db);
  db.run = async (sql: string, ...args: any[]) => {
    const result = await originalRun(sql, ...args);
    if (sql.startsWith('INSERT INTO office_waits')) started();
    return result;
  };
  const waiting = graph.offices.wait({ workSessionId: opened.context!.workSessionId, requestId: outgoing.messageId, waitMs: 3000 }, a).then(() => false, () => true);
  try { await waitStarted; } finally { db.run = originalRun; }
  await graph.roles.configure({ roleId: a.roleId, expectedRevision: 1, name: 'a', introduction: 'Disabled', state: 'disabled' }, admin);
  await check('disable fences explicit office sessions and leases', async () => {
    assert.equal((await db.get('SELECT state FROM office_sessions WHERE id=?', opened.context!.workSessionId)).state, 'closed');
    assert.equal((await db.get('SELECT status FROM office_items WHERE id=?', created.item.id)).status, 'open');
    await assert.rejects(graph.offices.resolveContext(opened.context!.workSessionId, a));
    assert(await waiting, 'in-flight wait must fail on revocation, not return timeout/success');
  });
  await graph.roles.configure({ roleId: a.roleId, expectedRevision: 2, name: 'a', introduction: 'Restored', state: 'active' }, admin);
  await check('stale binding epoch cannot reopen or send after restore', async () => {
    await assert.rejects(graph.roles.officeContext(a));
    await assert.rejects(graph.roles.exchange({ action: 'send', recipient: b.roleId, kind: 'inform', body: 'Stale', key: 'stale' }, a));
    await assert.rejects(graph.offices.open({ assignmentId: 'dev' }, a));
    assert((await graph.roles.officeContext({ ...a, roleBindingEpoch: 3 })).workSessionId);
  });
  await check('expired context cannot read role inbox', async () => {
    await assert.rejects(graph.roles.receive({}, { ...b, expiresAt: 1 }));
  });
  await check('role discovery/source attribution obey restricted assignments', async () => {
    const restricted = { ...b, assignmentIds: ['not-this-office'] };
    assert.deepEqual((await graph.roles.sync(restricted)).assignments, []);
    assert.deepEqual((await graph.roles.receive({}, restricted)).officePending, []);
    await assert.rejects(graph.roles.exchange({ action: 'send', recipient: a.roleId, kind: 'inform', body: 'Unauthorized source', officeId: 'room', key: 'bad-source' }, restricted));
  });
  await check('completed office requests disappear from role summary', async () => {
    const reviewSession = await graph.roles.officeContext(b);
    await graph.offices.exchange({ action: 'send', workSessionId: reviewSession.workSessionId, recipient: 'dev', kind: 'reply', requestId: outgoing.messageId, final: true, body: 'Done', key: 'wait-final' }, b);
    const inbox = await graph.roles.receive({}, b);
    assert(!inbox.officePending.some((x: any) => x.messageId === outgoing.messageId));
    assert(inbox.officePending.some((x: any) => x.messageKind === 'reply') === false, 'sender cannot see another seat reply inbox');
  });
  await check('cross-process role snapshot never swallows a concurrent approval', async () => {
    const runtime: TrustedCallContext = { v: 1, principal: 'owner', agentId: 'cli', transport: 'http-mcp', runtimeId: 'race', issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
    const app = await second.roles.application({ action: 'submit', name: 'race', introduction: 'Race fixture', reason: 'Fixture', key: 'race' }, runtime);
    const original = db.all.bind(db); let inserted = false;
    db.all = async (sql: string, ...args: any[]) => {
      const rows = await original(sql, ...args);
      if (!inserted && sql.includes('SELECT r.*,b.id binding_id')) {
        inserted = true;
        await second.roles.review({ applicationId: app.applicationId, expectedRevision: 1, action: 'approve' }, admin);
      }
      return rows;
    };
    let snapshot: any;
    try { snapshot = await graph.roles.registry(admin); } finally { db.all = original; }
    const followup = await graph.roles.state(admin, snapshot.revision);
    assert(snapshot.roles.some((r: any) => r.name === 'race') || !('unchanged' in followup && followup.unchanged), 'stale snapshot must leave a newer cursor for the next poll');
  });
} finally {
  await second.close(); await graph.close(); await fs.rm(dir, { recursive: true, force: true });
}
assert.deepEqual(failures, [], 'Role review regressions');
