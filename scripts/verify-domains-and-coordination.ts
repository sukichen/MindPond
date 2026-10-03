import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GraphMemory } from '../src/core/graph-memory.js';
import { signTeamWriteGrant, type TeamWriteGrant } from '../src/core/domain.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-domains-'));
process.env.MEMORY_DB_PATH = path.join(dir, 'pond.db');
process.env.EMBEDDING_MODEL_DIR = path.join(dir, 'no-models');
process.env.MEMORY_TEAM_AUTH_SECRET = 'fixture-only-team-secret';
const g = new GraphMemory();
const membership = (saved: any) => saved.memberships[0].id as string;
const grant = (operations: TeamWriteGrant['operations']): string => signTeamWriteGrant({
  v: 1, authorizationId: 'fixture-user-event', teamId: 'team-red', requestId: 'user-request-1',
  operations, issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 60_000,
}, process.env.MEMORY_TEAM_AUTH_SECRET!);

try {
  await g.init();
  const scope = { spaceId: 'project/runtime', memoryType: 'knowledge' };
  const personal = await g.saveMemory('PERSONAL_TOKEN: durable tooling rule with a condition.', { memberships: [scope] });
  const session = await g.saveMemory('SESSION_TOKEN: current investigation hypothesis.', { sessionId: 'session-a', memberships: [scope] });
  assert.equal((await g.getNodeById(personal.id, { trackAccess: false }))!.domain.kind, 'personal');
  assert.deepEqual((await g.getNodeById(session.id, { trackAccess: false }))!.domain, { kind: 'session', id: 'session-a' });

  const normal = await g.search({ query: 'TOKEN', sessionId: 'session-a', ...scope, limit: 20, minScore: 0 });
  assert(normal.some(hit => hit.node.content.includes('PERSONAL_TOKEN')));
  assert(normal.some(hit => hit.node.content.includes('SESSION_TOKEN')));
  const nextSession = await g.search({ query: 'TOKEN', sessionId: 'session-b', ...scope, limit: 20, minScore: 0 });
  assert(nextSession.some(hit => hit.node.content.includes('PERSONAL_TOKEN')));
  assert(!nextSession.some(hit => hit.node.content.includes('SESSION_TOKEN')));
  assert(!(await g.search({ query: 'TOKEN', ...scope, limit: 20, minScore: 0 })).some(hit => hit.node.content.includes('SESSION_TOKEN')));

  await assert.rejects(g.saveMemory('TEAM_TOKEN: unapproved shared conclusion.', { domain: { kind: 'team', id: 'team-red' }, memberships: [scope] }), /team_write_unauthorized/);
  const team = await g.saveMemory('TEAM_TOKEN: user-approved shared conclusion.', { domain: { kind: 'team', id: 'team-red' }, memberships: [scope], teamAuthorization: grant(['save']) });
  assert.equal((await g.search({ query: 'TEAM_TOKEN', domains: [{ kind: 'team', id: 'team-red' }], ...scope, limit: 20, minScore: 0 })).length, 1);
  const defaultTeamSearch = await g.search({ query: 'TEAM_TOKEN', ...scope, limit: 20, minScore: 0 });
  assert(!defaultTeamSearch.some(hit => hit.node.content.includes('user-approved shared')));
  await assert.rejects(g.upsertAssociation(membership(personal), membership(team), scope.spaceId, scope.memoryType, 0.8, { reason: 'Both mention a rule', context: 'fixture' }), /cannot cross memory domains/);
  const teamPeer = await g.saveMemory('TEAM_TOKEN: second user-approved shared conclusion.', { domain: { kind: 'team', id: 'team-red' }, memberships: [scope], teamAuthorization: grant(['save']) });
  await assert.rejects(g.upsertAssociation(membership(team), membership(teamPeer), scope.spaceId, scope.memoryType, 0.8, { reason: 'Shared review', context: 'fixture' }), /team_write_unauthorized/);
  const teamAssociation = await g.upsertAssociation(membership(team), membership(teamPeer), scope.spaceId, scope.memoryType, 0.8, { reason: 'Shared review', context: 'fixture' }, grant(['association']));
  await assert.rejects(g.deleteAssociation(teamAssociation.id), /team_write_unauthorized/);
  assert.equal(await g.deleteAssociation(teamAssociation.id, 'fixture cleanup', grant(['association'])), true);

  const context = await g.createWorkContext({ goal: 'Review one isolated fixture', participants: ['agent-a', 'agent-b'], sessionRefs: ['session-a'] });
  const first = await g.createWorkTask({ contextId: context.id, title: 'Read the entry point', acceptanceCriteria: ['Cite the condition'] });
  const second = await g.createWorkTask({ contextId: context.id, title: 'Review persistence', dependencies: [first.id] });
  await assert.rejects(g.claimWorkTask({ taskId: second.id, agentId: 'agent-b' }), /dependencies/);
  const claimed = await g.claimWorkTask({ taskId: first.id, agentId: 'agent-a', expectedRevision: first.revision });
  await assert.rejects(g.claimWorkTask({ taskId: first.id, agentId: 'agent-b' }), /not available/);
  const submitted = await g.transitionWorkTask({ taskId: first.id, agentId: 'agent-a', eventId: 'submit-entry', expectedRevision: claimed.task.revision, leaseToken: claimed.leaseToken, status: 'submitted', reason: 'Read and cited the fixture', resultRefs: ['repo:fixture/entry.ts'] });
  const completed = await g.transitionWorkTask({ taskId: first.id, agentId: 'reviewer', eventId: 'accept-entry', expectedRevision: submitted.revision, status: 'completed', reason: 'Acceptance criteria verified' });
  assert.equal(completed.status, 'completed');
  assert.equal((await g.claimWorkTask({ taskId: second.id, agentId: 'agent-b' })).task.status, 'claimed');

  // ── M05（roadmap 2026-09-11）：任务事件幂等回执/保留语义/租约续期/旧领取者 ──
  const nodeCount = async () => ((await (g as any).db.get('SELECT COUNT(*) AS n FROM nodes')) as any).n;
  const nodesBeforeM05 = await nodeCount();
  const m05 = await g.createWorkContext({ goal: 'M05 collaboration semantics', participants: ['agent-a', 'agent-b'] });

  // M05.c：验收请求未提供 resultRefs → 保留提交证据；显式提供才改写
  const t1 = await g.createWorkTask({ contextId: m05.id, title: 'Preserve evidence on acceptance' });
  const c1 = await g.claimWorkTask({ taskId: t1.id, agentId: 'agent-a' });
  const s1 = await g.transitionWorkTask({ taskId: t1.id, agentId: 'agent-a', eventId: 'm05-submit-1', expectedRevision: c1.task.revision, leaseToken: c1.leaseToken, status: 'submitted', reason: 'Evidence attached', resultRefs: ['repo:m05/evidence-1'] });
  const done1 = await g.transitionWorkTask({ taskId: t1.id, agentId: 'agent-b', eventId: 'm05-accept-1', expectedRevision: s1.revision, status: 'completed', reason: 'Accepted without restating evidence' });
  assert.deepEqual(done1.resultRefs, ['repo:m05/evidence-1']);

  // M05.b：重复事件同载荷返回原回执（revision/事件数不变）；不同载荷冲突
  const replay = await g.transitionWorkTask({ taskId: t1.id, agentId: 'agent-b', eventId: 'm05-accept-1', expectedRevision: s1.revision, status: 'completed', reason: 'Accepted without restating evidence' });
  assert.equal(replay.revision, done1.revision);
  assert.deepEqual(replay.resultRefs, done1.resultRefs);
  await assert.rejects(g.transitionWorkTask({ taskId: t1.id, agentId: 'agent-b', eventId: 'm05-accept-1', expectedRevision: s1.revision, status: 'completed', reason: 'Different acceptance wording' }), /idempotency_conflict/);

  // M05.b+d：续租延长领取资格且不改 revision；租约过期后旧领取者不能提交，
  // 也不能续租（资格随租约失效）；新领取者接管提交后旧 token 不能覆盖。
  const t2 = await g.createWorkTask({ contextId: m05.id, title: 'Lease renewal and stale claimant' });
  const c2 = await g.claimWorkTask({ taskId: t2.id, agentId: 'agent-a', leaseMs: 10_000 });
  const renewed = await g.renewWorkTaskLease({ taskId: t2.id, agentId: 'agent-a', leaseToken: c2.leaseToken, leaseMs: 10_000 });
  assert.equal(renewed.revision, c2.task.revision);
  assert((renewed.leaseUntil ?? 0) > (c2.task.leaseUntil ?? 0));
  await (g as any).db.run('UPDATE work_tasks SET lease_until=? WHERE id=?', [Date.now() - 1, t2.id]);
  await assert.rejects(g.transitionWorkTask({ taskId: t2.id, agentId: 'agent-a', eventId: 'm05-submit-2', expectedRevision: c2.task.revision, leaseToken: c2.leaseToken, status: 'submitted', reason: 'Late submit after expiry' }), /stale_task_lease/);
  await assert.rejects(g.renewWorkTaskLease({ taskId: t2.id, agentId: 'agent-a', leaseToken: c2.leaseToken }), /stale_task_lease/);
  const c2b = await g.claimWorkTask({ taskId: t2.id, agentId: 'agent-b' });
  const s2b = await g.transitionWorkTask({ taskId: t2.id, agentId: 'agent-b', eventId: 'm05-submit-2b', expectedRevision: c2b.task.revision, leaseToken: c2b.leaseToken, status: 'submitted', reason: 'New claimant submits', resultRefs: ['repo:m05/new-evidence'] });
  await assert.rejects(g.transitionWorkTask({ taskId: t2.id, agentId: 'agent-a', eventId: 'm05-submit-2c', expectedRevision: s2b.revision, leaseToken: c2.leaseToken, status: 'submitted', reason: 'Stale claimant overwrites' }), /Only claimed work may be submitted|stale_task_lease/);

  // A replay is still an authorized read, never a way to bypass scope checks.
  const replayArgs={taskId:t2.id,agentId:'agent-b',eventId:'m05-submit-2b',expectedRevision:c2b.task.revision,leaseToken:c2b.leaseToken,status:'submitted' as const,reason:'New claimant submits',resultRefs:['repo:m05/new-evidence']};
  await assert.rejects(g.transitionWorkTask({...replayArgs,domains:[{kind:'personal',id:'other'}]}),/outside readable domains/);
  await assert.rejects(g.transitionWorkTask({...replayArgs,agentId:'other-agent'}),/idempotency_conflict/);
  await assert.rejects(g.transitionWorkTask({...replayArgs,expectedRevision:c2b.task.revision+1}),/idempotency_conflict/);
  assert.equal((await g.listWorkContexts([])).length,0);
  await assert.rejects(g.listWorkTasks(t2.contextId,[]),/outside readable domains/);
  console.log('PASS collaboration replay rechecks domains/actor/revision; explicit empty SDK scope never falls back');


  // Lease validity uses the time after acquiring the write lock, not call arrival.
  const timedTask=await g.createWorkTask({contextId:m05.id,title:'Fence a queued expired submission'});
  let controlledNow=Date.now();
  (g as any).clock=()=>controlledNow;
  const timedClaim=await g.claimWorkTask({taskId:timedTask.id,agentId:'agent-a',leaseMs:10000});
  let entered!:()=>void,release!:()=>void;
  const acquired=new Promise<void>(resolve=>{entered=resolve;});
  const holding=(g as any).withWriteLock(async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});});
  await acquired;
  const queued=g.transitionWorkTask({taskId:timedTask.id,agentId:'agent-a',eventId:'late-queued',expectedRevision:timedClaim.task.revision,leaseToken:timedClaim.leaseToken,status:'submitted',reason:'Queued after lease expiry'});
  const refused=assert.rejects(queued,/stale_task_lease/);
  controlledNow+=20000;release();await holding;await refused;
  (g as any).clock=Date.now;
  console.log('PASS queued collaboration submission rechecks lease time after write-lock acquisition');

  // M05.d：任务流转不自动产生知识节点（todo 变更不入知识图）
  assert.equal(await nodeCount(), nodesBeforeM05);

  await assert.rejects(g.createWorkContext({ domain: { kind: 'team', id: 'team-red' }, goal: 'Shared work without a user request' }), /team_write_unauthorized/);
  assert.equal((await g.createWorkContext({ domain: { kind: 'team', id: 'team-red' }, goal: 'User-authorized shared review', teamAuthorization: grant(['task_context']) })).domain.kind, 'team');

  const sessionContext = await g.createWorkContext({ domain: { kind: 'session', id: 'session-a' }, goal: 'Session-only coordination', sessionRefs: ['session-a'] });
  await g.createWorkTask({ contextId: sessionContext.id, domains: [sessionContext.domain], title: 'Temporary task' });

  await g.setSessionState('session-a', 'closed');
  assert(!(await g.search({ query: 'SESSION_TOKEN', sessionId: 'session-a', ...scope, limit: 20, minScore: 0 })).some(hit => hit.node.content.includes('current investigation')));
  assert.equal((await g.listWorkContexts([{ kind: 'session', id: 'session-a' }])).length, 0);
  await assert.rejects(g.listWorkTasks(sessionContext.id, [{ kind: 'session', id: 'session-a' }]), /session is closed/);
  await assert.rejects(g.createWorkContext({ domain: { kind: 'session', id: 'session-a' }, goal: 'Must not revive a closed session' }), /closed session/);
  assert.equal((await g.purgeClosedSession('session-a')).deletedNodes, 1);
  assert.equal(await g.getNodeById(session.id, { trackAccess: false }), null);
  console.log('PASS: session lifecycle isolation, personal/team domains, signed user-initiated team writes, and collaboration tasks with idempotent event receipts, evidence preservation, lease renewal and stale-claimant rejection');
} finally {
  await g.close();
  await fs.rm(dir, { recursive: true, force: true });
}
