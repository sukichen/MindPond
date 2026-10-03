/**
 * Deterministic acceptance test for the user-defined MindPond topology.
 * Run: npx tsx scripts/verify-space-ripple.ts
 * No LLM, API key, embedding server, or production database is used.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraphMemory } from '../src/core/graph-memory.js';

const vector = [1, ...Array(383).fill(0)];

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindpond-space-ripple-'));
  const previous = process.env.MEMORY_DB_PATH;
  process.env.MEMORY_DB_PATH = path.join(dir, 'acceptance.db');
  const graph = new GraphMemory();
  try {
    await graph.init();
    const create = (content: string, memberships: Array<{ spaceId: string; memoryType: string }>) =>
      graph.createNode({ dimension: 'fact', layer: 'L1', content, memberships, embedding: vector });

    const a = await create('入口：本地调试服务的配置。', [
      { spaceId: 'project-A', memoryType: 'configuration' },
      { spaceId: 'project-B', memoryType: 'configuration' },
    ]);
    const b = await create('项目 A 本地服务监听 7903。', [{ spaceId: 'project-A', memoryType: 'configuration' }]);
    const c = await create('项目 A 的 7903 仅绑定 127.0.0.1，远程访问经过代理。', [{ spaceId: 'project-A', memoryType: 'configuration' }]);
    const d = await create('项目 B 本地服务监听 8800。', [{ spaceId: 'project-B', memoryType: 'configuration' }]);
    const wrongType = await create('项目 A 的付款对账流程。', [{ spaceId: 'project-A', memoryType: 'finance' }]);
    const [aA, aB] = await graph.getMemberships(a.id, { activeOnly: true });
    const bA = (await graph.getMemberships(b.id, { activeOnly: true }))[0];
    const cA = (await graph.getMemberships(c.id, { activeOnly: true }))[0];
    const dB = (await graph.getMemberships(d.id, { activeOnly: true }))[0];
    const wrong = (await graph.getMemberships(wrongType.id, { activeOnly: true }))[0];

    await graph.upsertAssociation(aA.id, bA.id, 'project-A', 'configuration', 0.9);
    await graph.upsertAssociation(bA.id, cA.id, 'project-A', 'configuration', 0.9);
    await graph.upsertAssociation(aB.id, dB.id, 'project-B', 'configuration', 0.9);
    let crossRejected = false;
    try { await graph.upsertAssociation(aA.id, wrong.id, 'project-A', 'configuration', 0.9); }
    catch { crossRejected = true; }

    const all = await graph.search({ nodeId: a.id, maxDepth: 2, minScore: 0.1, limit: 20 });
    const aOnly = await graph.search({ nodeId: a.id, spaceId: 'project-A', memoryType: 'configuration', maxDepth: 2, minScore: 0.1, limit: 20 });
    const reverse = await graph.search({ nodeId: c.id, spaceId: 'project-A', memoryType: 'configuration', maxDepth: 2, minScore: 0.1, limit: 20 });
    const byId = new Map(all.map(hit => [hit.node.id, hit]));
    const aById = new Map(aOnly.map(hit => [hit.node.id, hit]));
    const reverseById = new Map(reverse.map(hit => [hit.node.id, hit]));
    const checks = [
      ['same body can live in two independent spaces', all.some(hit => hit.node.id === b.id) && all.some(hit => hit.node.id === d.id)],
      ['two 0.9 hops multiply only on their own path (0.81)', Math.abs((byId.get(c.id)?.score ?? 0) - 0.81) < 1e-9],
      ['space filter keeps the A ripple out of B', aById.has(b.id) && aById.has(c.id) && !aById.has(d.id)],
      ['association is discoverable from either endpoint', reverseById.has(b.id) && reverseById.has(a.id)],
      ['different type cannot be associated into configuration', crossRejected && !aById.has(wrongType.id)],
    ] as const;

    // Organization makes one richer replacement active in the same space,
    // while preserving both source bodies as derived_from provenance.
    const job = await graph.claimOrganizationJob({ spaceId: 'project-A', memoryType: 'configuration', maxMembers: 8 });
    if (!job) throw new Error('expected an organization job');
    const committed = await graph.commitOrganizationPlan(job.id, { operations: [{
      kind: 'consolidate', membershipIds: [bA.id, cA.id],
      content: '项目 A 的本地调试服务监听 7903，仅绑定 127.0.0.1；远程访问必须经代理转发，不能直接开放该端口。',
      reason: '端口、绑定和远程访问限制是同一配置复用单元。',
    }] });
    const sourceMemberships = [...await graph.getMemberships(b.id), ...await graph.getMemberships(c.id)];
    const replacement = await graph.getNodeById(committed.createdMemoryIds[0], { trackAccess: false });
    checks.push(['consolidation replaces only the selected active memberships and preserves rich content',
      committed.createdMemoryIds.length === 1 && !!replacement?.content.includes('127.0.0.1') && sourceMemberships.every(m => !m.active)]);

    // Unreviewed material remains discoverable without losing its uncertainty
    // marker; retrieval never upgrades it to verified knowledge.
    const unreviewed = await graph.createNode({
      dimension: 'fact', layer: 'L1', content: 'UNREVIEWED_TEST_93 raw tool output',
      tags: ['unreviewed-finding'],
      memberships: [{ spaceId: 'project-A', memoryType: 'configuration' }], embedding: vector,
    });
    const ordinaryMaterial = await graph.search({ nodeId: unreviewed.id });
    const auditMaterial = await graph.search({ nodeId: unreviewed.id, tags: ['unreviewed-finding'] });
    const ordinaryText = await graph.search({ query: 'UNREVIEWED_TEST_93', minScore: 0 });
    checks.push(['unreviewed material remains discoverable with its explicit uncertainty marker',
      ordinaryMaterial.some(hit => hit.node.id === unreviewed.id && hit.node.tags.includes('unreviewed-finding')) && auditMaterial.some(hit => hit.node.id === unreviewed.id)
      && ordinaryText.some(hit => hit.node.id === unreviewed.id)]);

    for (const [name, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
    if (checks.some(([, passed]) => !passed)) process.exitCode = 1;
  } finally {
    await graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.MEMORY_DB_PATH; else process.env.MEMORY_DB_PATH = previous;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
