/** A02: preview/save parity, structured correction and zero database writes. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GraphMemory } from '../src/core/graph-memory.js';
import { getEmbeddingService } from '../src/core/embedding.js';
import { normalizeAnchors } from '../src/core/anchors.js';
import { hostOperations } from '../src/core/host-contract.js';
import { signTeamWriteGrant } from '../src/core/domain.js';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-preview-'));
const env = { ...process.env };
process.env.MEMORY_DB_PATH = path.join(temp, 'memory.db');
process.env.EMBEDDING_ZH_ENABLED = 'false';
process.env.MEMORY_TEAM_AUTH_SECRET = 'isolated-test-secret';
const embedding = getEmbeddingService();
const generate = embedding.generateEmbedding;
embedding.generateEmbedding = async () => [1, ...Array(383).fill(0)];
const graph = new GraphMemory();
try {
  await graph.init();
  const placements = [{ spaceId: 'project', memoryType: 'fact' }];
  const first = await graph.saveMemory('known target', { memberships: placements });
  const other = await graph.saveMemory('private target', { memberships: placements, sessionId: 'other-session' });
  const previewOp = hostOperations(graph).find(op => op.name === 'memory_save_validate')!;
  const preview = (args: unknown) => previewOp.run(previewOp.schema.parse(args));
  const body = 'The proxy listens on localhost. Production deployment is unverified.';
  const anchor = { text: 'proxy address', basis: 'proxy listens on localhost', ...placements[0] };
  const basis = { score: 0.7, reason: 'same local environment', context: 'development only' };
  const source = { uri: 'repo:proxy.ts', context: 'main', revision: 'v1', locator: 'listen' };
  const changes = () => (graph as any).db.get('SELECT total_changes() AS n').then((r: any) => r.n);
  const before = await changes();
  const bad = await preview({ content: body, memberships: placements, anchors: [anchor, { ...anchor, text: 'bad address', basis: 'public interface' }] });
  assert.equal(bad.valid, false);
  assert.equal(bad.anchors.accepted, 1);
  assert.equal(bad.anchors.issues[0].field, 'anchors[1].basis');
  assert.equal(bad.anchors.issues[0].retryable, false);
  assert.throws(() => normalizeAnchors([anchor, { ...anchor, text: 'bad address', basis: 'public interface' }], body, placements),
    (e: any) => e.field === bad.anchors.issues[0].field && e.code === 'invalid_input');
  const malformed = await preview({ content: body, memberships: placements, anchors: [anchor, { text: 'missing fields' }] });
  assert.equal(malformed.valid, false);
  assert.equal(malformed.anchors.issues[0].field, 'anchors[1].basis');
  const good = await preview({ content: body, memberships: placements, anchors: [anchor], sourceRefs: [source, source],
    related: [{ membershipId: first.memberships[0].id, ...basis }] });
  assert.equal(good.valid, true);
  assert.equal(good.possibleExisting.status, 'ready');
  assert.ok(good.possibleExisting.results.some((r: any) => r.id === first.id), 'candidate preview should surface same-scope knowledge');
  assert.ok(!good.possibleExisting.results.some((r: any) => r.id === other.id), 'candidate preview must not expose another session');
  assert.equal(good.sourceRefs.length, 1);
  await assert.rejects(preview({ content: body, sourceRefs: [source, { ...source, revision: 'v2' }] }),
    (e: any) => e.code === 'source_revision_conflict');
  // An unreadable real ID and an absent ID must be indistinguishable.
  const foreign = await preview({ content: body, memberships: placements, related: [{ membershipId: other.memberships[0].id, ...basis }] });
  const absent = await preview({ content: body, memberships: placements, related: [{ membershipId: 'absent', ...basis }] });
  assert.equal(foreign.valid, false);
  assert.deepEqual(foreign.related, absent.related);
  assert.equal(await changes(), before, 'preview must not insert, update, delete, or generate work');

  // Preview is not a reservation: the final save must check current target state.
  await graph.deleteNode(first.id, 'test target removal');
  await assert.rejects(graph.saveMemory(body, { memberships: placements, related: [{ membershipId: first.memberships[0].id, ...basis }] }), /related target/);
  const invalidSave = { memberships: placements, related: [{ membershipId: other.memberships[0].id, ...basis }] };
  await assert.rejects(graph.saveMemory(body, invalidSave), /related target/);

  const domain = { kind: 'team' as const, id: 'test-team' };
  await assert.rejects(preview({ content: body, domain }), /team_write_unauthorized/);
  // Signing remains a host function; the preview accepts the same user grant as save.
  const teamAuthorization = signTeamWriteGrant({ v: 1, authorizationId: 'user-event', teamId: domain.id, operations: ['save'], requestId: 'explicit-team-request', issuedAt: Date.now(), expiresAt: Date.now() + 60000 }, process.env.MEMORY_TEAM_AUTH_SECRET!);
  const teamBefore = await changes();
  assert.equal((await preview({ content: body, domain, teamAuthorization })).valid, true);
  assert.equal(await changes(), teamBefore);
  console.log('PASS A02: indexed correction, shared constraints, source conflicts, domain parity, zero writes and stale target revalidation');
} finally {
  await graph.close();
  embedding.generateEmbedding = generate;
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  await fs.rm(temp, { recursive: true, force: true });
}
