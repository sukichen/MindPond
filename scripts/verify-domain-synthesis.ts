/**
 * M02.c verify: profiles synthesize by ownership domain, not source session.
 *
 * Roadmap M02: material owned by the same personal domain must synthesize
 * even when captured in different source sessions (sessionId is source
 * metadata); conversely, organization claims stay domain-scoped, so session
 * materials of different sessions can never enter one synthesis.
 *
 * Regression target: validateSynthesis used to require all sources to share
 * one sessionId — blocking legitimate same-personal-domain synthesis across
 * source sessions, while the domain rule (consolidate) is the real boundary.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GraphMemory } from '../src/core/graph-memory.js';
import type { SynthesizeOperation } from '../src/core/growth.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-synthesis-'));
process.env.MEMORY_DB_PATH = path.join(dir, 'pond.db');
process.env.EMBEDDING_MODEL_DIR = path.join(dir, 'no-models');
const g = new GraphMemory();
const scope = { spaceId: 'project/synthesis', memoryType: 'knowledge' };

try {
  await g.init();

  // Same personal domain, two different source sessions (the M02 requirement).
  const a = await g.saveMemory('PERSONAL_A_TOKEN: tooling rule captured while working in session-a.', {
    domain: { kind: 'personal', id: 'default' }, sessionId: 'session-a', memberships: [scope], source: 'knowledge',
  });
  const b = await g.saveMemory('PERSONAL_B_TOKEN: complementary tooling rule captured in session-b.', {
    domain: { kind: 'personal', id: 'default' }, sessionId: 'session-b', memberships: [scope], source: 'knowledge',
  });

  const job = await g.claimOrganizationJob({
    domain: { kind: 'personal', id: 'default' }, spaceId: scope.spaceId, memoryType: scope.memoryType,
    membershipIds: [a.memberships[0].id, b.memberships[0].id],
  });
  assert.ok(job, 'same-domain materials must be claimable into one organization job');

  const synthesis: SynthesizeOperation = {
    kind: 'synthesize',
    membershipIds: [a.memberships[0].id, b.memberships[0].id],
    content: 'SYNTH_TOKEN: unified tooling rule synthesised from personal knowledge captured across two source sessions.',
    profile: { title: 'Tooling rule', coverage: ['Both source rules'], unknowns: ['Runtime behaviour'] },
    reason: 'Two complementary observations of one durable personal rule.',
    supports: [
      { membershipId: a.memberships[0].id, claim: 'Rule part A', context: 'session-a capture' },
      { membershipId: b.memberships[0].id, claim: 'Rule part B', context: 'session-b capture' },
    ],
  };

  const committed = await g.commitOrganizationPlan(job.id, {
    operations: [synthesis],
  } as never);
  assert.equal(committed.createdMemoryIds.length, 1, 'synthesis across source sessions in one personal domain must commit');

  const profileNode = await g.getNodeById(committed.createdMemoryIds[0], { trackAccess: false });
  assert.ok(profileNode);
  assert.deepEqual(profileNode.domain, { kind: 'personal', id: 'default' },
    'synthesized profile keeps the ownership domain of the job');
  assert.equal(profileNode.source, 'synthesis');

  // Sources keep their own session provenance; nothing was rewritten.
  for (const [node, expected] of [[a, 'session-a'], [b, 'session-b']] as const) {
    const still = await g.getNodeById(node.id, { trackAccess: false });
    assert.equal(still?.sessionId, expected, `source keeps its own source session (${expected})`);
    assert.deepEqual(still?.domain, { kind: 'personal', id: 'default' });
  }

  // Cross-domain boundary stays closed: one organization job can never span
  // two session domains, even when a raw membership id is supplied.
  const s1 = await g.saveMemory('SESSION_S1_TOKEN: session one investigation note.', {
    sessionId: 's1', memberships: [scope],
  });
  const s2 = await g.saveMemory('SESSION_S2_TOKEN: session two investigation note.', {
    sessionId: 's2', memberships: [scope],
  });
  await assert.rejects(
    g.claimOrganizationJob({
      domain: { kind: 'session', id: 's1' }, spaceId: scope.spaceId, memoryType: scope.memoryType,
      membershipIds: [s1.memberships[0].id, s2.memberships[0].id],
    }),
    /outside this space|unavailable/,
    'a session-domain organization job cannot reach another session\'s material',
  );

  console.log('PASS: synthesis groups by ownership domain; source sessions stay provenance-only');
} finally {
  await g.close();
  await fs.rm(dir, { recursive: true, force: true });
}
