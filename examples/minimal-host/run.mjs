/** Package-only contract example. --smoke uses synthetic replies, not an LLM quality test. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MindPond, driveOrganizationRequest, protocolRulesResponse, retrievalStatus } from 'mindpond';

export async function runMinimalHost({ dbPath, llm }) {
  const pond = new MindPond({ dbPath });
  await pond.init();
  try {
    const dimensionPolicy = await pond.graph.getDimensionPolicy();
    const rules = {...protocolRulesResponse(),dimensionPolicy};
    const identity=dimensionPolicy.definitions.some(d=>d.id==='environment'&&d.enabled)?'environment':dimensionPolicy.defaultDimension;
    const scope = { spaceId: 'example/local-proxy', memoryType: identity };
    const content = 'The development proxy listens on localhost:7903. Production deployment is unverified.';
    const options = {
      domain: { kind: 'personal', id: 'default' }, dimensions:[identity], memberships: [scope], idempotencyKey: 'example/proxy-v1',
      anchors: [{ ...scope, text: 'development proxy address', basis: 'development proxy listens on localhost:7903' }],
    };
    const preview = await pond.validateSave(content, options);
    assert.equal(preview.valid, true);
    const saved = await pond.save(content, options);
    assert.equal((await pond.save(content, options)).id, saved.id);
    await pond.save('After changing the development proxy port, update its local launch configuration.', {
      dimensions:[identity], memberships: [scope], idempotencyKey: 'example/proxy-v2',
    });
    const request = await pond.graph.organizationRequests.createRequest({ ...scope, batchSize: 2 });
    const progress = await driveOrganizationRequest(pond.graph, { requestId: request.requestId, llm, budgetMs: 10000 });
    const hits = await pond.search('development proxy localhost', { ...scope, minScore: 0, limit: 5 });
    assert.ok(hits.some(hit => hit.node.id === saved.id));
    return { rulesVersion: rules.version, progress, savedId: saved.id, retrieval: retrievalStatus() };
  } finally { await pond.close(); }
}

if (process.argv.includes('--smoke')) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-minimal-'));
  try {
    const result = await runMinimalHost({ dbPath: path.join(temp, 'memory.db'), llm: {
      supportsCancel: true,
      generate: async (prompt, context) => {
        assert.ok(prompt.includes('Production deployment is unverified'));
        assert.ok(context.remainingBudgetMs > 0 && !context.signal.aborted);
        return '{"operations":[]}';
      },
    } });
    assert.equal(result.progress.status, 'completed');
    console.log(JSON.stringify({ test: 'synthetic package contract, not model quality', ...result }));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
