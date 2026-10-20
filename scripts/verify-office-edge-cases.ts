import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GraphMemory } from '../src/core/graph-memory.js';
import { createNetworkMcpApp } from '../src/integrations/network-server.js';
import { officeWorkbench } from '../src/integrations/office-workbench.js';
import { issueNetworkGrant, readNetworkConfiguration } from '../src/integrations/network-config.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-review-edges-'));
const graph = new GraphMemory('.', { dbPath: path.join(dir, 'db') });
const admin = {
  v: 1 as const,
  principal: 'review-user',
  operator: true,
  issuedAt: 0,
  expiresAt: Number.MAX_SAFE_INTEGER
};
const clients: any[] = [];
let network: any, listener: any, web: any;
let key = 0;
const result = (r: any) => JSON.parse(r.content.find((c: any) => c.type === 'text').text);
const call = async (c: any, name: string, args: any = {}) => {
  const r = await c.callTool({ name, arguments: args });
  assert(!r.isError, JSON.stringify(r));
  return result(r);
};
const report = (scenario: string, actual: any) => console.log(JSON.stringify({ scenario, actual }));
try {
  await graph.init();
  const configFile = path.join(dir, 'grants.json'),
    tokens: any = {};
  for (const id of ['dev', 'reviewer', 'target']) {
    await graph.offices.configureAgent(
      { id, principal: 'account', name: id, host: 'fixture', state: 'active', expectedRevision: 0 },
      admin
    );
    const tokenFile = path.join(dir, id + '.token');
    await issueNetworkGrant({ toolProfile: 'full', configFile, tokenFile, principal: 'account', agentId: id });
    tokens[id] = (await fs.readFile(tokenFile, 'utf8')).trim();
  }
  await graph.offices.configureOffice(
    {
      id: 'office',
      title: 'Review fixture',
      goal: 'Reproduce edge cases',
      acceptance: 'Explicit validation',
      state: 'active',
      expectedRevision: 0,
      deadline: Date.now() + 3600000,
      maxRounds: 20,
      seats: [
        { id: 'dev-seat', agentId: 'dev', label: 'Developer', role: 'worker' },
        { id: 'review-seat', agentId: 'reviewer', label: 'Verifier', role: 'reviewer' },
        { id: 'target-seat', agentId: 'target', label: 'Replacement', role: 'worker' }
      ]
    },
    admin
  );
  const hosts: string[] = ['127.0.0.1:7904'];
  network = createNetworkMcpApp(graph, {
    configuration: () => readNetworkConfiguration(configFile),
    allowedHosts: hosts,
    maxPerAccount: 16
  });
  listener = network.app.listen(0, '127.0.0.1');
  await new Promise((r) => listener.once('listening', r));
  hosts.push('127.0.0.1:' + listener.address().port);
  const cs: any = {},
    sessions: any = {};
  for (const [id, seat] of [
    ['dev', 'dev-seat'],
    ['reviewer', 'review-seat'],
    ['target', 'target-seat']
  ]) {
    const c = new Client({ name: id, version: 'review' });
    clients.push(c);
    cs[id] = c;
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`http://${hosts[1]}/mcp`), {
        requestInit: { headers: { Authorization: 'Bearer ' + tokens[id] } }
      })
    );
    sessions[id] = (
      await call(c, 'work_session_open', { assignmentId: seat })
    ).context.workSessionId;
  }
  const available = (await cs.dev.listTools()).tools.map((t: any) => t.name);
  assert(!available.includes('work_inbox'));
  assert(available.every((n:string)=>!n.startsWith('memory_')),'office does not expose memory tools');
  assert(!cs.dev.getInstructions().includes('work_inbox'));
  const resource = await cs.dev.readResource({ uri: 'mindpond://protocol/rules' });
  assert(!JSON.stringify(resource).includes('work_inbox'));
  report('v2 discovery names hidden legacy tools', {
    workInboxAvailable: false,
    initialInstructionsRecommendIt: false,
    protocolRulesRecommendIt: false
  });
  const op = (who: string, tool: string, args: any) =>
    call(cs[who], tool, { workSessionId: sessions[who], key: 'key-' + ++key, ...args });
  const create = () =>
    op('dev', 'work_office_item', {
      action: 'create',
      owner: 'dev-seat',
      reviewer: 'review-seat',
      title: 'Task',
      acceptance: 'Actual evidence'
    });
  const text = 'Exact fixture 中文 😀 '.repeat(2000);
  const publish = {
    action: 'publish',
    label: 'Fixture',
    version: 'v1',
    content: text,
    key: 'stable-publish'
  };
  const m = await op('dev', 'work_material', publish);
  assert.equal((await op('dev', 'work_material', publish)).materialId, m.materialId);
  const conflict = await cs.dev.callTool({
    name: 'work_material',
    arguments: { workSessionId: sessions.dev, ...publish, content: 'different' }
  });
  assert(conflict.isError);
  let body = '';
  for (let number = 0; number < m.chunks; number++) {
    const r = await op('reviewer', 'work_material', {
      action: 'get',
      materialId: m.materialId,
      number
    });
    assert(Buffer.byteLength(r.chunk.content) <= 16000);
    body += r.chunk.content;
  }
  assert.equal(body, text);
  assert.equal(m.bytes, Buffer.byteLength(text));
  assert.equal(m.sha256, createHash('sha256').update(text).digest('hex'));
  report('MCP-only Unicode publish', { chunks: m.chunks, complete: true, idempotent: true });
  const submit = (claimed: any, rev = claimed.item.revision) =>
    op('dev', 'work_office_item', {
      action: 'submit',
      itemId: claimed.item.id,
      expectedRevision: rev,
      leaseToken: claimed.leaseToken,
      codeVersion: 'v1',
      materialId: m.materialId,
      summary: 'Ready'
    });
  // Transfer proposal remains valid after submitting to the reviewer.
  const t = await create();
  const claim = await op('dev', 'work_office_item', {
    action: 'claim',
    itemId: t.item.id,
    expectedRevision: t.item.revision
  });
  const proposal = await op('dev', 'work_office_item', {
    action: 'transfer',
    itemId: t.item.id,
    expectedRevision: claim.item.revision,
    target: 'target-seat'
  });
  const submitted = await submit(claim, proposal.item.revision);
  const accepted = await cs.target.callTool({
    name: 'work_office_item',
    arguments: {
      workSessionId: sessions.target,
      key: 'late-transfer',
      action: 'transfer_accept',
      itemId: t.item.id,
      expectedRevision: submitted.item.revision
    }
  });
  assert(accepted.isError);
  assert.equal(submitted.item.transfer_to, null);
  const reviewed = await op('reviewer', 'work_office_item', {
    action: 'verify',
    itemId: t.item.id,
    expectedRevision: submitted.item.revision,
    roundId: submitted.roundId,
    codeVersion: 'v1',
    verdict: 'passed',
    summary: 'Validated',
    evidence: 'Fixture evidence'
  });
  assert.equal(reviewed.item.status, 'completed');
  report('transfer after submission fenced', { transferRejected: true, reviewCompleted: true });
  // A request-specific wait incorrectly filters an existing final reply by a later generic cursor.
  const q = await op('dev', 'work_office_exchange', {
    action: 'send',
    kind: 'request',
    recipient: 'review-seat',
    body: 'Please confirm'
  });
  const reply = await op('reviewer', 'work_office_exchange', {
    action: 'send',
    kind: 'reply',
    recipient: 'dev-seat',
    requestId: q.messageId,
    final: true,
    body: 'Confirmed'
  });
  const late = await op('reviewer', 'work_office_exchange', {
    action: 'send',
    kind: 'inform',
    recipient: 'dev-seat',
    body: 'Later informational event'
  });
  const wait = await call(cs.dev, 'work_office_wait', {
    workSessionId: sessions.dev,
    requestId: q.messageId,
    afterSeq: late.seq,
    waitMs: 100
  });
  assert.equal(wait.status, 'matched');
  assert.equal(wait.nextCursor, late.seq);
  report('known final reply with later cursor', {
    replySeq: reply.seq,
    afterSeq: late.seq,
    status: wait.status
  });
  // Complete a separate task with a long but valid verification record.
  const cursor = (await call(cs.reviewer, 'work_office_get', { officeId: 'office', limit: 100 }))
    .nextCursor;
  const assignmentWait = call(cs.reviewer, 'work_office_wait', {
    workSessionId: sessions.reviewer,
    afterSeq: cursor,
    waitMs: 1000
  });
  await new Promise((r) => setTimeout(r, 50));
  const t2 = await create(),
    c2 = await op('dev', 'work_office_item', {
      action: 'claim',
      itemId: t2.item.id,
      expectedRevision: t2.item.revision
    }),
    s2 = await submit(c2);
  const assignmentResult = await assignmentWait;
  assert.equal(assignmentResult.status, 'matched');
  assert.equal(assignmentResult.event.itemId, t2.item.id);
  report('reviewer inbox wait after new assigned submission', {
    status: assignmentResult.status,
    submittedItem: t2.item.id
  });
  await op('reviewer', 'work_office_item', {
    action: 'verify',
    itemId: t2.item.id,
    expectedRevision: s2.item.revision,
    roundId: s2.roundId,
    codeVersion: 'v1',
    verdict: 'passed',
    summary: 'Passed',
    evidence: 'Evidence '.repeat(1200)
  });
  const completedWait = await call(cs.reviewer, 'work_office_wait', {
    workSessionId: sessions.reviewer,
    itemId: t2.item.id,
    waitMs: 100
  });
  assert.equal(completedWait.status, 'terminal');
  assert.equal(completedWait.state, 'completed');
  report('reviewer waits after completion', { status: completedWait.status });
  // Actual browser management HTTP route loses offset for roundId.
  const app = express();
  app.use(express.json());
  app.use(
    '/api/office-admin',
    officeWorkbench(graph, {
      apiKey: 'fixture-api',
      operatorKey: 'fixture-operator',
      contextSecret: '',
      configFile
    })
  );
  web = app.listen(0, '127.0.0.1');
  await new Promise((r) => web.once('listening', r));
  const base = `http://127.0.0.1:${web.address().port}/api/office-admin/`;
  let cookie = '';
  const req = (route: string, body: any) =>
    fetch(base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body)
    });
  const login = await req('login', { apiKey: 'fixture-api', operatorKey: 'fixture-operator' });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  const first = await (
    await req('view', { officeId: 'office', roundId: s2.roundId, offset: 0 })
  ).json();
  const second = await (
    await req('view', { officeId: 'office', roundId: s2.roundId, offset: first.nextOffset })
  ).json();
  assert.equal(first.nextOffset, 8000);
  assert.equal(second.offset, 8000);
  assert.notEqual(second.content, first.content);
  assert.equal(second.nextOffset, null);
  assert.equal(JSON.parse(first.content + second.content).result.summary, 'Passed');
  report('browser long round pagination', {
    requestedOffset: 8000,
    returnedOffset: second.offset,
    nextOffset: second.nextOffset,
    samePage: false
  });
  // Plain rotation expands a restricted credential.
  await issueNetworkGrant({ toolProfile: 'full',
    configFile,
    tokenFile: path.join(dir, 'restricted.token'),
    principal: 'account',
    agentId: 'target',
    rotate: true,
    assignmentIds: ['target-seat']
  });
  const before = (await readNetworkConfiguration(configFile)).grants.find(
    (g) => g.agentId === 'target'
  );
  await issueNetworkGrant({ toolProfile: 'full',
    configFile,
    tokenFile: path.join(dir, 'rotated.token'),
    principal: 'account',
    agentId: 'target',
    rotate: true
  });
  const after = (await readNetworkConfiguration(configFile)).grants.find(
    (g) => g.agentId === 'target'
  );
  assert.deepEqual(before!.assignmentIds, ['target-seat']);
  assert.deepEqual(after!.assignmentIds, ['target-seat']);
  report('rotation without policy changes', {
    before: before!.assignmentIds,
    after: after!.assignmentIds ?? 'unrestricted'
  });
  // Explicit null is the only way to remove assignment restrictions on rotation.
  await issueNetworkGrant({ toolProfile: 'full',
    configFile,
    tokenFile: path.join(dir, 'unrestricted.token'),
    principal: 'account',
    agentId: 'target',
    rotate: true,
    assignmentIds: null
  });
  assert.equal(
    (await readNetworkConfiguration(configFile)).grants.find((g) => g.agentId === 'target')!
      .assignmentIds,
    undefined
  );
  // The real workbench preserves existing policy when rotating without edits.
  const state = await (await req('state', {})).json();
  await issueNetworkGrant({ toolProfile: 'full',
    configFile,
    tokenFile: path.join(dir, 'restricted-again.token'),
    principal: 'account',
    agentId: 'target',
    rotate: true,
    assignmentIds: ['target-seat'],
    personalId: 'original-domain'
  });
  const rotated = await req('credential', {
    id: 'target',
    expectedRevision: state.agents.find((a: any) => a.id === 'target').revision
  });
  assert.equal(rotated.status, 200);
  const policy = (await readNetworkConfiguration(configFile)).grants.find(
    (g) => g.agentId === 'target'
  )!;
  assert.deepEqual(policy.assignmentIds, ['target-seat']);
  assert.equal(policy.domains[0].id, 'original-domain');
  // Loaded second-page records continue to refresh, with no cross-office reads.
  for (let n = 0; n < 51; n++) await create();
  const firstPage = await call(cs.dev, 'work_office_get', { officeId: 'office' });
  const extra = await call(cs.dev, 'work_office_get', {
    officeId: 'office',
    itemsAfterId: firstPage.nextItemsAfterId
  });
  const changed = extra.items.find((t: any) => !['completed', 'cancelled'].includes(t.status));
  assert(changed);
  await graph.offices.cancelItem(
    { itemId: changed.id, expectedRevision: changed.revision, reason: 'fixture cancel' },
    admin
  );
  const refreshed = await (await req('view', { officeId: 'office', itemIds: [changed.id] })).json();
  assert.equal(refreshed.items.find((t: any) => t.id === changed.id).status, 'cancelled');
  assert.equal(refreshed.nextItemsAfterId, firstPage.nextItemsAfterId);
  const draftText = 'fixture text';
  for (let n = 0; n < 51; n++)
    await op('dev', 'work_material', {
      action: 'begin',
      label: 'Paged draft',
      version: 'v1',
      bytes: Buffer.byteLength(draftText),
      chunks: 1,
      sha256: createHash('sha256').update(draftText).digest('hex')
    });
  const materialPage = await call(cs.dev, 'work_office_get', { officeId: 'office' });
  const materialTail = await call(cs.dev, 'work_office_get', {
    officeId: 'office',
    materialsAfterId: materialPage.nextMaterialsAfterId
  });
  const draft = materialTail.materials.find((m: any) => m.state === 'draft');
  assert(draft);
  await op('dev', 'work_material', {
    action: 'chunk',
    materialId: draft.id,
    number: 0,
    content: draftText
  });
  const published = await op('dev', 'work_material', { action: 'finalize', materialId: draft.id });
  const materialRefresh = await (
    await req('view', {
      officeId: 'office',
      materialIds: [draft.id],
      afterSeq: published.seq
    })
  ).json();
  assert.equal(materialRefresh.materials.find((m: any) => m.id === draft.id).state, 'published');
  const materialDelta = await call(cs.dev, 'work_office_get', {
    officeId: 'office',
    afterSeq: published.seq - 1
  });
  assert.equal(materialDelta.materials.find((m: any) => m.id === draft.id).state, 'published');
  const pending = await call(cs.dev, 'work_office_wait', {
    workSessionId: sessions.dev,
    afterSeq: 1000000,
    waitMs: 100
  });
  assert(pending.nextAction.includes('work_office_wait'));
  assert(!pending.nextAction.includes('call work_wait'));
  console.log(
    'PASS office edge cases: discovery/cache, transfer-submit race, correlated and idle waits, terminal waits, browser pagination, safe rotation, MCP-only text publication, loaded-page refresh'
  );
} finally {
  for (const c of clients) await c.close().catch(() => {});
  if (network) await network.close();
  if (listener) await new Promise<void>((r) => listener.close(() => r()));
  if (web) await new Promise<void>((r) => web.close(() => r()));
  await graph.close();
  await fs.rm(dir, { recursive: true, force: true });
}
