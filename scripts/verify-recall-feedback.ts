/** Deterministic G5 feedback-loop check: a recall receipt survives restart,
 * only returned ids can receive feedback, and conflicting rewrites are refused. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GraphMemory } from '../src/core/graph-memory.js';

async function main() {
  const original = process.env.MEMORY_DB_PATH;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-recall-feedback-'));
  const dbPath = path.join(dir, 'memory.db');
  process.env.MEMORY_DB_PATH = dbPath;
  try {
    const first = new GraphMemory();
    await first.init();
    const node = await first.createNode({ dimension: 'fact', layer: 'L1', content: 'The service listens on loopback.', embedding: [1, ...Array(383).fill(0)] });
    const recall = await first.recall({ nodeId: node.id, runId: 'run-1', hostId: 'host-1', maxDepth: 0 });
    if (recall.results.length !== 1 || recall.results[0].node.id !== node.id) throw new Error('recall did not return its seed');
    const readEvents = await first.actionLogPage({action:'memory_read',limit:10});
    if (readEvents.log.length !== 1 || readEvents.log[0].nodeId !== node.id) throw new Error('delivered recall result did not produce a node-local read event');
    if (readEvents.log[0].reason.includes(node.content)) throw new Error('read event duplicated private content');
    if (JSON.parse(readEvents.log[0].reason).path?.[0] !== node.id) throw new Error('read event did not preserve the actual recall path');
    const cursor = readEvents.log[0].id;
    if ((await first.actionLogAfter(cursor)).length !== 0) throw new Error('forward cursor replayed old actions');
    await first.getNodeById(node.id,{trackAccess:true});
    const expanded = await first.actionLogAfter(cursor);
    if (expanded.length !== 1 || expanded[0].action !== 'memory_read' || !expanded[0].reason.includes('expand')) throw new Error('tracked direct read did not enter the live stream');
    const firstReceipt = await first.reportRecallFeedback({ recallId: recall.recallId, runId: 'run-1', hostId: 'host-1', decisions: [{ memoryId: node.id, disposition: 'used', reason: 'supported the deployment answer' }] });
    if (firstReceipt.recorded !== 1) throw new Error('feedback was not recorded');
    const replay = await first.reportRecallFeedback({ recallId: recall.recallId, runId: 'run-1', hostId: 'host-1', decisions: [{ memoryId: node.id, disposition: 'used', reason: 'supported the deployment answer' }] });
    if (replay.replayed !== 1) throw new Error('identical feedback was not idempotent');
    await first.close();
    const reopened = new GraphMemory();
    await reopened.init();
    const summary = await reopened.recallFeedbackSummary();
    if (summary.recalls !== 1 || summary.returned !== 1 || summary.decisions.used !== 1 || summary.unreported !== 0) throw new Error('feedback did not survive restart');
    let conflict = false;
    try { await reopened.reportRecallFeedback({ recallId: recall.recallId, decisions: [{ memoryId: node.id, disposition: 'rejected' }] }); } catch { conflict = true; }
    if (!conflict) throw new Error('conflicting adoption feedback was accepted');
    await reopened.close();
    console.log('PASS recall feedback: durable, scoped, idempotent, conflict-protected');
  } finally {
    if (original === undefined) delete process.env.MEMORY_DB_PATH; else process.env.MEMORY_DB_PATH = original;
    await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
