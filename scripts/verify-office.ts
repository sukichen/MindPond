import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GraphMemory } from '../src/core/graph-memory.js';
import { getEmbeddingService } from '../src/core/embedding.js';
import { createNetworkMcpApp } from '../src/integrations/network-server.js';
import { issueNetworkGrant, readNetworkConfiguration } from '../src/integrations/network-config.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-office-')),
  configFile = path.join(dir, 'accounts.json');
const graph = new GraphMemory('.', { dbPath: path.join(dir, 'db') }),
  embedding = getEmbeddingService(),
  generate = embedding.generateEmbedding;
embedding.generateEmbedding = async () => [1, ...Array(383).fill(0)];
const admin = {
  v: 1 as const,
  principal: 'user',
  operator: true,
  issuedAt: 0,
  expiresAt: Number.MAX_SAFE_INTEGER
};
let network: ReturnType<typeof createNetworkMcpApp> | undefined,
  listener: import('node:http').Server | undefined;
const clients: Client[] = [],
  tokens: Record<string, string> = {};
const decode = (r: any) => JSON.parse(r.content.find((c: any) => c.type === 'text').text);
const call = async (c: Client, name: string, args: any = {}) => {
  const r = await c.callTool({ name, arguments: args });
  assert(!r.isError, JSON.stringify(r));
  return decode(r);
};
const denied = async (c: Client, name: string, args: any = {}) => {
  const r = await c.callTool({ name, arguments: args });
  assert(r.isError, JSON.stringify(r));
};
try {
  await graph.init();
  const legacyFile = path.join(dir, 'legacy.token');
  await issueNetworkGrant({ configFile, tokenFile: legacyFile, principal: 'legacy-account' });
  tokens.legacy = (await fs.readFile(legacyFile, 'utf8')).trim();
  for (const id of ['codex', 'opencode', 'restricted']) {
    await graph.offices.configureAgent(
      { id, principal: 'same-account', name: id, host: id, state: 'active', expectedRevision: 0 },
      admin
    );
    const tokenFile = path.join(dir, id + '.token');
    await issueNetworkGrant({
      configFile,
      tokenFile,
      principal: 'same-account',
      agentId: id,
      assignmentIds: id === 'restricted' ? ['seat-restricted'] : undefined
    });
    tokens[id] = (await fs.readFile(tokenFile, 'utf8')).trim();
  }
  assert.equal((await readNetworkConfiguration(configFile)).grants.length, 4);
  const office = {
    id: 'office',
    title: 'Fix login',
    goal: 'Fix real error',
    acceptance: 'Reproduce then test',
    expectedRevision: 0,
    deadline: Date.now() + 3600000,
    maxRounds: 2,
    state: 'active',
    seats: [
      { id: 'seat-dev', agentId: 'codex', label: 'Chat A development', role: 'worker' },
      { id: 'seat-review', agentId: 'codex', label: 'Chat B review', role: 'reviewer' },
      { id: 'seat-other', agentId: 'opencode', label: 'Other developer', role: 'worker' },
      { id: 'seat-restricted', agentId: 'restricted', label: 'Restricted', role: 'worker' },
      { id: 'seat-unavailable', agentId: 'restricted', label: 'Not granted', role: 'reviewer' }
    ]
  };
  await graph.offices.configureOffice(office, admin);
  const hosts: string[] = ['127.0.0.1:7904'];
  network = createNetworkMcpApp(graph, {
    configuration: () => readNetworkConfiguration(configFile),
    allowedHosts: hosts,
    maxPerAccount: 16
  });
  hosts.push('127.0.0.1:7904');
  listener = network.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => listener!.once('listening', r));
  const port = (listener.address() as any).port;
  hosts.push('127.0.0.1:' + port);
  const connect = async (id: string) => {
    const c = new Client({ name: id, version: 'test' });
    clients.push(c);
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: 'Bearer ' + tokens[id] } }
      })
    );
    return c;
  };
  const legacy = await connect('legacy');
  assert.equal(
    (await call(legacy, 'work_workspaces')).principal,
    'legacy-account',
    'migrated grants retain legacy tools'
  );
  assert.equal((await call(legacy, 'memory_capabilities')).mcpConnection.agentId, null);
  const a = await connect('codex'),
    other = await connect('opencode'),
    restricted = await connect('restricted');
  await denied(a, 'work_workspaces');
  const brief=await call(a,'memory_brief',{task:'Check independent office collaboration'});assert.equal(brief.collaboration.identity.agentId,'codex');assert(!('updates' in brief.collaboration));
  assert(a.getInstructions()?.includes('work_bootstrap'));
  assert((await a.listTools()).tools.some((t) => t.name === 'work_guide_get'));
  assert.equal((await call(a, 'work_bootstrap')).context, null);
  const dev = (await call(a, 'work_session_open', { assignmentId: 'seat-dev' })).context,
    review = (await call(a, 'work_session_open', { assignmentId: 'seat-review' })).context,
    second = (await call(other, 'work_session_open', { assignmentId: 'seat-other' })).context;
  await denied(a, 'work_session_open', { assignmentId: 'seat-dev' });
  await denied(other, 'work_bootstrap', { workSessionId: dev.workSessionId });
  await denied(restricted, 'work_session_open', { assignmentId: 'seat-unavailable' });
  assert.equal((await call(restricted, 'work_bootstrap')).seats.length, 1);
  const args = (context: any, key: string, extra: any = {}) => ({
    workSessionId: context.workSessionId,
    key,
    ...extra
  });
  const q = await call(
    a,
    'work_office_exchange',
    args(dev, 'request', {
      action: 'send',
      kind: 'request',
      recipient: 'seat-review',
      body: 'What evidence do you need?'
    })
  );
  assert.equal(
    (
      await call(
        a,
        'work_office_exchange',
        args(dev, 'request', {
          action: 'send',
          kind: 'request',
          recipient: 'seat-review',
          body: 'What evidence do you need?'
        })
      )
    ).messageId,
    q.messageId
  );
  await denied(
    a,
    'work_office_exchange',
    args(dev, 'request', {
      action: 'send',
      kind: 'request',
      recipient: 'seat-review',
      body: 'Changed payload'
    })
  );
  const timeout = await call(a, 'work_office_wait', {
    workSessionId: dev.workSessionId,
    waitMs: 100
  });
  assert.equal(timeout.status, 'timeout');
  assert.equal(timeout.resume.workSessionId, dev.workSessionId);
  const inbox = await call(a, 'work_office_exchange', args(review, 'inbox', { action: 'inbox' }));
  assert.equal(inbox.items[0].id, q.messageId);
  assert.equal(inbox.items[0].receipt, 'unread');
  assert.equal(
    (await call(a, 'work_office_exchange', args(dev, 'inbox', { action: 'inbox' }))).items.length,
    0
  );
  await denied(
    other,
    'work_office_exchange',
    args(second, 'bad-reply', {
      action: 'send',
      kind: 'reply',
      recipient: 'seat-dev',
      requestId: q.messageId,
      final: true,
      body: 'Impersonation'
    })
  );
  const waiting = call(a, 'work_office_wait', {
    workSessionId: dev.workSessionId,
    requestId: q.messageId,
    afterSeq: q.seq,
    waitMs: 3000
  });
  await call(
    a,
    'work_office_exchange',
    args(review, 'reply', {
      action: 'send',
      kind: 'reply',
      recipient: 'seat-dev',
      requestId: q.messageId,
      final: true,
      body: 'Send exact patch and command output.'
    })
  );
  assert.equal((await waiting).status, 'matched');
  assert.equal(
    (
      await call(a, 'work_office_wait', {
        workSessionId: dev.workSessionId,
        requestId: q.messageId,
        afterSeq: q.seq,
        waitMs: 100
      })
    ).status,
    'matched',
    'reply-before-wait survives race'
  );
  const longBody = '场景细节'.repeat(4000);
  const large = await call(
    a,
    'work_office_exchange',
    args(dev, 'large-message', {
      action: 'send',
      kind: 'inform',
      recipient: 'seat-review',
      body: longBody
    })
  );
  const page = await call(a, 'work_office_get', {
    officeId: 'office',
    afterSeq: large.seq - 1,
    limit: 1
  });
  assert(page.events[0].detailAvailable);
  let offset = 0,
    assembled = '',
    hash = '';
  while (true) {
    const chunk = await call(a, 'work_office_get', {
      officeId: 'office',
      eventSeq: large.seq,
      offset
    });
    assembled += chunk.content;
    hash = chunk.sha256;
    if (chunk.nextOffset === null) break;
    offset = chunk.nextOffset;
  }
  assert.equal(JSON.parse(assembled).body.body, longBody);
  assert.equal(createHash('sha256').update(assembled).digest('hex'), hash);
  const largeInbox = await call(
    a,
    'work_office_exchange',
    args(review, 'large-inbox', { action: 'inbox', afterSeq: large.seq - 1 })
  );
  assert(largeInbox.items[0].detailAvailable);
  assert.equal(largeInbox.nextCursor, large.seq);
  const text = 'Patch and test evidence in a different filesystem. 中文正文。',
    sha = createHash('sha256').update(text).digest('hex');
  const material = await call(
    a,
    'work_material',
    args(dev, 'begin', {
      action: 'begin',
      label: 'Exact patch',
      version: 'sha+dirtyhash',
      bytes: Buffer.byteLength(text),
      chunks: 1,
      sha256: sha
    })
  );
  await denied(
    a,
    'work_material',
    args(review, 'read-draft', { action: 'get', materialId: material.materialId })
  );
  await denied(
    a,
    'work_material',
    args(dev, 'finalize-early', { action: 'finalize', materialId: material.materialId })
  );
  await call(
    a,
    'work_material',
    args(dev, 'chunk', {
      action: 'chunk',
      materialId: material.materialId,
      number: 0,
      content: text
    })
  );
  await call(
    a,
    'work_material',
    args(dev, 'finalize', { action: 'finalize', materialId: material.materialId })
  );
  assert.equal(
    (
      await call(
        a,
        'work_material',
        args(review, 'read', { action: 'get', materialId: material.materialId })
      )
    ).chunk.content,
    text
  );
  const created = await call(
    a,
    'work_office_item',
    args(dev, 'create', {
      action: 'create',
      title: 'Fix handler',
      acceptance: 'Run exact test',
      owner: 'seat-dev',
      reviewer: 'seat-review'
    })
  );
  const contender = await connect('codex');
  const claims = await Promise.all(
    [a, contender].map((c, n) =>
      c.callTool({
        name: 'work_office_item',
        arguments: args(dev, 'claim-' + n, {
          action: 'claim',
          itemId: created.item.id,
          expectedRevision: created.item.revision
        })
      })
    )
  );
  assert.equal(claims.filter((r) => !r.isError).length, 1);
  const claim = decode(claims.find((r) => !r.isError));
  const submission = await call(
    a,
    'work_office_item',
    args(dev, 'submit', {
      action: 'submit',
      itemId: created.item.id,
      expectedRevision: claim.item.revision,
      leaseToken: claim.leaseToken,
      codeVersion: 'version1',
      materialId: material.materialId,
      summary: 'Fix + evidence'
    })
  );
  await denied(
    a,
    'work_office_item',
    args(dev, 'self-review', {
      action: 'verify',
      itemId: created.item.id,
      expectedRevision: submission.item.revision,
      roundId: submission.roundId,
      codeVersion: 'version1',
      verdict: 'passed',
      summary: 'No',
      evidence: 'Not run'
    })
  );
  const pending = call(a, 'work_office_wait', {
    workSessionId: dev.workSessionId,
    itemId: created.item.id,
    roundId: submission.roundId,
    codeVersion: 'version1',
    waitMs: 3000
  });
  await call(
    a,
    'work_office_item',
    args(review, 'verify', {
      action: 'verify',
      itemId: created.item.id,
      expectedRevision: submission.item.revision,
      roundId: submission.roundId,
      codeVersion: 'version1',
      verdict: 'passed',
      summary: 'Actual check passes',
      evidence: 'Executed command: fixture; exit0'
    })
  );
  assert.equal((await pending).round.state, 'passed');
  const moved = await call(
    a,
    'work_office_item',
    args(dev, 'create2', {
      action: 'create',
      title: 'Transfer item',
      acceptance: 'Done',
      owner: 'seat-dev',
      reviewer: 'seat-review'
    })
  );
  const transfer = await call(
    a,
    'work_office_item',
    args(dev, 'transfer', {
      action: 'transfer',
      itemId: moved.item.id,
      expectedRevision: 1,
      target: 'seat-other'
    })
  );
  assert.equal(transfer.item.owner, 'seat-dev');
  const accepted = await call(
    other,
    'work_office_item',
    args(second, 'accept', {
      action: 'transfer_accept',
      itemId: moved.item.id,
      expectedRevision: transfer.item.revision
    })
  );
  assert.equal(accepted.item.owner, 'seat-other');
  const observed = await call(a, 'work_office_get', { officeId: 'office' });
  assert(!JSON.stringify(observed).includes(claim.leaseToken));
  assert(!JSON.stringify(observed).includes('lease_hash'));
  const saved = await call(a, 'memory_save', {
    workSessionId: dev.workSessionId,
    content: 'Private unfinished development hypothesis.',
    dimensions: ['work']
  });
  await denied(a, 'memory_get', { workSessionId: review.workSessionId, nodeId: saved.id });
  assert.equal(
    (await call(a, 'memory_get', { workSessionId: dev.workSessionId, nodeId: saved.id })).id,
    saved.id
  );
  const rc = await connect('codex');
  assert.equal(
    (
      await call(rc, 'work_session_open', {
        assignmentId: 'seat-dev',
        workSessionId: dev.workSessionId
      })
    ).context.workSessionId,
    dev.workSessionId
  );
  assert.equal(
    (await call(rc, 'memory_get', { workSessionId: dev.workSessionId, nodeId: saved.id })).id,
    saved.id,
    'memory scope survives MCP connection changes'
  );
  const revokeWait = restricted
    .callTool({
      name: 'work_office_wait',
      arguments: {
        workSessionId: (
          await call(restricted, 'work_session_open', { assignmentId: 'seat-restricted' })
        ).context.workSessionId,
        waitMs: 3000
      }
    })
    .then(
      (r) => r,
      (e) => ({ isError: true, transportError: e.code })
    );
  const waitDeadline = Date.now() + 3000;
  while (
    !(await graph.offices.get({ officeId: 'office' }, admin)).waits.some(
      (w: any) => w.seat_id === 'seat-restricted'
    )
  ) {
    assert(Date.now() < waitDeadline);
    await new Promise((r) => setTimeout(r, 15));
  }
  await graph.offices.configureAgent(
    {
      id: 'restricted',
      principal: 'same-account',
      name: 'Restricted',
      host: 'other',
      state: 'disabled',
      expectedRevision: 1
    },
    admin
  );
  assert((await revokeWait).isError);
  assert(!JSON.stringify(await call(a, 'work_bootstrap')).includes(tokens.codex));
  await graph.offices.configureProject(
    {
      id: 'project',
      title: 'Reusable project',
      members: ['codex', 'opencode'],
      enabled: true,
      expectedRevision: 0
    },
    admin
  );
  await graph.offices.configureOffice(
    {
      ...office,
      projectId: 'project',
      seats: office.seats.filter((s) => s.agentId !== 'restricted'),
      expectedRevision: 1
    },
    admin
  );
  await denied(a, 'work_bootstrap', { workSessionId: dev.workSessionId });
  const renewedSession = (await call(a, 'work_session_open', { assignmentId: 'seat-dev' })).context;
  await graph.offices.configureProject(
    {
      id: 'project',
      title: 'Reusable project',
      members: ['opencode'],
      enabled: true,
      expectedRevision: 1
    },
    admin
  );
  await denied(a, 'work_bootstrap', { workSessionId: renewedSession.workSessionId });
  assert.equal((await call(a, 'work_bootstrap')).seats.length, 0);
  await assert.rejects(
    graph.offices.open({ assignmentId: 'seat-other' }, admin),
    'browser user cannot impersonate a worker'
  );
  console.log(
    'PASS office v2 HTTP: same-account agents/roles, context fencing, exact replies/rounds, material integrity, two-phase transfer, session-memory isolation/reconnect, revocation during wait; no credentials/leases in projection'
  );
} finally {
  await Promise.allSettled(clients.map((c) => c.close()));
  await network?.close(listener);
  await graph.close();
  embedding.generateEmbedding = generate;
  await fs.rm(dir, { recursive: true, force: true });
}
