/** Exercise the public request driver against a real temporary database. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { GraphMemory } from '../src/core/graph-memory.js';
import { driveOrganizationRequest } from '../src/core/organization-driver.js';
import { getEmbeddingService } from '../src/core/embedding.js';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-driver-'));
process.env.MEMORY_DB_PATH = path.join(temp, 'memory.db');
process.env.EMBEDDING_ZH_ENABLED = 'false';
const embedding = getEmbeddingService();
const generate = embedding.generateEmbedding;
embedding.generateEmbedding = async () => [1, ...Array(383).fill(0)];
let graph = new GraphMemory();
const create = async (spaceId: string) => {
  for (const content of ['development configuration', 'production remains unverified'])
    await graph.saveMemory(content, { memberships: [{ spaceId, memoryType: 'fact' }] });
  return graph.organizationRequests.createRequest({ spaceId, memoryType: 'fact', batchSize: 2 });
};
try {
  await graph.init();
  const logical = { spaceId: 'retry-create', memoryType: 'fact', idempotencyKey: 'host-event-1' };
  const original = await graph.organizationRequests.createRequest(logical);
  for (let i = 0; i < 20; i++) assert.equal((await graph.organizationRequests.createRequest(logical)).requestId, original.requestId);
  await assert.rejects(graph.organizationRequests.createRequest({ ...logical, spaceId: 'different' }), (e: any) => e.code === 'idempotency_conflict');
  const request = await create('budget');
  let late!: (s: string) => void;
  let calls = 0;
  let callSignal!: AbortSignal;
  const deadlineValues: number[] = [];
  const start = Date.now();
  const result = await driveOrganizationRequest(graph, { requestId: request.requestId, budgetMs: 180, llm: {
    supportsCancel: false,
    generate: async (prompt, context) => {
      calls++;
      deadlineValues.push(context.deadlineAt);
      callSignal = context.signal;
      if (calls === 1) return 'broken JSON';
      assert.match(prompt, /previous proposal was rejected/);
      return new Promise<string>(resolve => { late = resolve; });
    },
  } });
  assert.equal(calls, 2);
  assert.equal(new Set(deadlineValues).size, 1, 'retry cannot reset deadline');
  assert.equal(result.status, 'partial');
  assert.equal(result.receipt?.mutations, 0);
  assert.ok(callSignal.aborted);
  assert.ok(Date.now() - start < 2000, 'ignored cancellation must not block return');
  late('{"operations":[]}');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await graph.organizationRequests.getRequest(request.requestId))!.status, 'partial');

  const cancelled = await create('cancel');
  const controller = new AbortController();
  const cancelledResult = await driveOrganizationRequest(graph, { requestId: cancelled.requestId, budgetMs: 10000, signal: controller.signal, llm: {
    generate: async () => { controller.abort(); return new Promise<string>(() => {}); },
  } });
  assert.equal(cancelledResult.status, 'cancelled');
  // A real slow HTTP provider proves the signal reaches the transport, not
  // just an early return from the driver while a socket continues waiting.
  const networkRequest = await create('network-abort');
  const networkAbort = new AbortController();
  let disconnected!: () => void;
  const disconnectedPromise = new Promise<void>(resolve => { disconnected = resolve; });
  let received = 0;
  const provider = createServer((_req, res) => {
    received++;
    res.on('close', disconnected);
    networkAbort.abort(); // No response: cancel while the actual fetch is waiting.
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  try {
    const address = provider.address() as {port:number};
    const networkResult = await driveOrganizationRequest(graph, {requestId:networkRequest.requestId, budgetMs:2000, signal:networkAbort.signal,
      llm:{supportsCancel:true, generate:async(_prompt, context)=>(await fetch(`http://127.0.0.1:${address.port}/model`,{signal:context.signal})).text()}});
    assert.equal(networkResult.status,'cancelled');
    assert.equal(received,1);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([disconnectedPromise,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('cancel did not close the provider connection')),1500);})]);
    } finally {clearTimeout(timeout);}
    assert.equal(networkResult.receipt?.mutations,0);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve,reject)=>provider.close(error=>error?reject(error):resolve()));
  }
  console.log('PASS real HTTP model transport receives cancellation and closes its waiting connection');

  const raw = await create('direct-cancel');
  const claim = await graph.organizationRequests.nextBatch(raw.requestId);
  assert.ok(claim.batch);
  await graph.organizationRequests.cancelRequest(raw.requestId, 'user cancellation');
  await assert.rejects(graph.commitOrganizationPlan(claim.batch!.id, { operations: [] }), /cancelled|expired|stale/);
  await assert.rejects(graph.renewOrganizationJob(claim.batch!.id), /expired|completed/i);

  const atomic = await create('commit-deadline');
  const atomicBatch = await graph.organizationRequests.nextBatch(atomic.requestId);
  await assert.rejects(graph.commitOrganizationPlan(atomicBatch.batch!.id, { operations: [] }, undefined, { deadlineAt: Date.now() - 1 }), /deadline expired/);
  assert.equal((await graph.getOrganizationJob(atomicBatch.batch!.id))!.status, 'leased');
  await graph.releaseOrganizationJob(atomicBatch.batch!.id);
  const recovered = await create('lost-report');
  const done = await graph.organizationRequests.nextBatch(recovered.requestId);
  await graph.commitOrganizationPlan(done.batch!.id, { operations: [] });
  // Crash between commit and report: only durable request/job state survives.
  await graph.close();
  graph = new GraphMemory();
  await graph.init();
  const resumed = await driveOrganizationRequest(graph, { requestId: recovered.requestId, llm: {
    generate: async () => { throw new Error('already committed material must not go to the model again'); },
  } });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.concluded.no_change, 2);
  const expired = await create('expired-executor');
  const held = await graph.organizationRequests.nextBatch(expired.requestId);
  assert.equal((await graph.organizationRequests.nextBatch(expired.requestId)).batch, null, 'live lease waits');
  await graph.releaseOrganizationJob(held.batch!.id);
  const replacement = await graph.organizationRequests.nextBatch(expired.requestId);
  assert.ok(replacement.batch && replacement.batch.id !== held.batch!.id);
  await assert.rejects(graph.commitOrganizationPlan(held.batch!.id, { operations: [] }), /expired/);
  await graph.releaseOrganizationJob(replacement.batch!.id);
  console.log('PASS request driver: one deadline, actionable retry, non-cooperative abort, cancellation fencing, transaction deadline, restart receipt recovery and expired executor replacement');
} finally {
  await graph.close();
  embedding.generateEmbedding = generate;
  await fs.rm(temp, { recursive: true, force: true });
}
