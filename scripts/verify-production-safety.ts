/** Production safety regression suite, using disposable DBs and fault injection.
 * PASS means the reviewed failure is prevented by the current implementation.
 * Uses disposable SQLite databases and public fixture text; no model service.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphMemory } from '../src/core/graph-memory.js';
import { getEmbeddingService } from '../src/core/embedding.js';
import { createOpenCodeMemoryPlugin } from '../src/integrations/opencode-plugin.js';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { signContextToken } from '../src/core/trust.js';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-production-review-'));
process.env.EMBEDDING_ZH_ENABLED = 'false';
process.env.EMBEDDING_MODEL_DIR = path.join(temp, 'missing-model');
const embeddings = getEmbeddingService(), originalEmbedding = embeddings.generateEmbedding;
embeddings.generateEmbedding = async () => [1, ...Array(383).fill(0)];
const results: Array<{ id: string; status: string; evidence: unknown }> = [];
const record = (id: string, evidence: unknown) => {
  results.push({ id, status: 'PASS', evidence });
  console.log(id, 'PASS', JSON.stringify(evidence));
};
const graphAt = async (name: string) => {
  process.env.MEMORY_DB_PATH = path.join(temp, name);
  const graph = new GraphMemory(); await graph.init(); return graph;
};
try {
  // Hold a genuine save transaction immediately after its INSERT, then run a
  // public unqueued deletion. Inject a later failure and verify durable state.
  const graph = await graphAt('transaction.db');
  try {
    const victim = await graph.saveMemory('Committed memory that must remain deleted after a successful delete');
    const db = (graph as any).db, originalRun = db.run.bind(db);
    let insertedId = '', entered!: () => void, release!: () => void;
    const inserted = new Promise<void>(r => entered = r);
    const blocked = new Promise<void>(r => release = r);
    db.run = async (sql: string, ...args: unknown[]) => {
      const value = await originalRun(sql, ...args);
      if (sql.startsWith('INSERT INTO nodes (id, dimension, layer, content, embedding, importance, tags, source, domain_kind')) {
        insertedId = (args[0] as string[])[0]; entered(); await blocked;
        throw new Error('review-only injected save failure');
      }
      return value;
    };
    const save = graph.saveMemory('Uncommitted provisional body must not escape rollback')
      .then(() => 'unexpected success', e => String(e.message));
    await inserted;
    let readFinished=false,deleteFinished=false;
    const reading=graph.getNodeById(insertedId,{trackAccess:false}).then(node=>{readFinished=true;return node;});
    const requesting=graph.organizationRequests.createRequest({spaceId:'fixture',memoryType:'fact'});
    const deleting=graph.deleteNode(victim.id,'regression: concurrent delete').then(()=>{deleteFinished=true;});
    await new Promise(r=>setTimeout(r,30));
    assert(!readFinished && !deleteFinished,'Unrelated connection users must wait for the transaction owner');
    release();const failure=await save;
    const dirtyRead=await reading;await requesting;await deleting;db.run=originalRun;
    assert.equal(dirtyRead,null);assert.equal(await graph.getNodeById(victim.id,{trackAccess:false}),null);
    assert(failure.includes('injected'));
    record('F01',{dirtyReadPrevented:true,concurrentDeleteDurable:true,concurrentOrganizationAccepted:true});
    let backgroundFinished=false,finished!:()=>void;
    const backgroundDone=new Promise<void>(r=>finished=r);
    await (graph as any).growthWrite(async()=>{
      (graph as any).later(async()=>{await graph.getStats();backgroundFinished=true;finished();},0);
      await new Promise(r=>setTimeout(r,30));
      assert.equal(backgroundFinished,false,'Background timers cannot inherit a still-live transaction owner');
    });
    await backgroundDone;
  } finally { await graph.close(); }

  const dedupe = await graphAt('dedupe.db');
  try {
    const keep = await dedupe.saveMemory('Shared proxy procedure', { memberships: [{ spaceId: 'project-a', memoryType: 'fact' }] });
    const drop = await dedupe.saveMemory('Shared proxy procedure', { memberships: [{ spaceId: 'project-b', memoryType: 'fact' }],
      sourceRefs: [{ uri: 'file:///fixture/proxy.md', context: 'fixture', revision: 'v1' }] });
    const neighbor = await dedupe.saveMemory('Proxy limitation: local binding requires SSH tunnel', { memberships: [{ spaceId: 'project-b', memoryType: 'fact' }] });
    await dedupe.upsertAssociation(drop.memberships[0].id, neighbor.memberships[0].id, 'project-b', 'fact', 0.9,
      { reason: 'Same proxy procedure and its essential remote-use restriction', context: 'Remote debugging in project-b' });
    const outcome = await dedupe.mergeDuplicates(keep.id, [drop.id]);
    const kept = await dedupe.getNodeById(keep.id, { trackAccess: false });
    const placements = await dedupe.getMemberships(keep.id);
    const associationCount = await (dedupe as any).db.get('SELECT COUNT(*) n FROM memory_associations');
    assert(associationCount.n>=1);assert.equal(kept?.sourceRefs?.length,1);
    assert(placements.some(p=>p.spaceId==='project-b'));
    const carried=await dedupe.listAssociations(undefined,{membershipIds:placements.map(p=>p.id)});
    assert(carried.some(e=>e.evidence?.some(v=>v.context==='Remote debugging in project-b')));
    assert.equal((await dedupe.getNodeById(drop.id,{trackAccess:false}))?.supersededBy,keep.id);
    assert.equal((await dedupe.traceMemory(keep.id)).nodes.length,2);
    record('F02', { outcome, sourcesRetained:true,placementRetained:true,evidenceRetained:true,originalBodyTraceable:true });
    const local = await dedupe.saveMemory('Second local duplicate');
    const foreign = await dedupe.saveMemory('Different personal domain', { domain: { kind: 'personal', id: 'other' } });
    await assert.rejects(dedupe.mergeDuplicates(keep.id, [local.id, foreign.id]), /cannot cross/);
    assert(await dedupe.getNodeById(local.id,{trackAccess:false}));
    record('F03', { mergeRejected: true, earlierInputUnchanged: true });
    await dedupe.deleteNode(keep.id,'Delete current replacement without reviving old facts');
    const original=await dedupe.getNodeById(drop.id,{trackAccess:false});
    assert.equal(original?.quarantined,true);assert.equal(original?.supersededBy,drop.id);
    assert(!(await dedupe.search({query:'Shared proxy procedure',limit:50})).some(h=>h.node.id===drop.id));
    assert.equal((await (dedupe as any).db.all('PRAGMA foreign_key_check')).length,0);
    record('F14',{replacementDeletionDoesNotResurrectOldFact:true,originalStillInspectable:true,foreignKeysValid:true});
  } finally { await dedupe.close(); }

  const ripple = await graphAt('ripple.db');
  try {
    const nodes = await Promise.all(['A', 'B', 'C', 'D'].map(content => ripple.saveMemory(content,
      { memberships: [{ spaceId: 'ripple', memoryType: 'fact' }] })));
    for (const [a, b, weight] of [[0, 1, .95], [1, 2, .95], [0, 2, .8], [2, 3, .9]]) {
      await ripple.upsertAssociation(nodes[a].memberships[0].id, nodes[b].memberships[0].id,
        'ripple', 'fact', weight, { reason: 'Fixture contextual relation', context: 'Bounded-depth search review' });
    }
    const hits = await ripple.search({ nodeId: nodes[0].id, maxDepth: 2, minScore: .1, limit: 20 });
    assert.equal(hits.find(h=>h.node.id===nodes[3].id)?.score,.8*.9);
    record('F06', { validPath: 'A → C → D', pathDepth: 2, expectedScore: .8 * .9,
      returnedBodies: hits.map(h => h.node.content),
      shorterStatePreserved: true });
    // Compare bounded propagation with exhaustive walks on a cyclic small
    // graph. These include revisits; weights <=1 cannot improve a cycle.
    const adjacency:Array<Array<[number,number]>>=Array.from({length:4},()=>[]);
    for(const [a,b,w] of [[0,1,.95],[1,2,.95],[0,2,.8],[2,3,.9]]){adjacency[a].push([b,w]);adjacency[b].push([a,w]);}
    for(let depth=0;depth<=5;depth++) {
      const best=Array(4).fill(0);
      const walk=(at:number,score:number,used:number)=>{best[at]=Math.max(best[at],score);if(used<depth)for(const [next,w] of adjacency[at])walk(next,score*w,used+1);};
      walk(0,1,0);
      const actual=await ripple.search({nodeId:nodes[0].id,maxDepth:depth,minScore:.001,limit:20});
      nodes.forEach((node,i)=>assert(Math.abs((actual.find(h=>h.node.id===node.id)?.score??0)-best[i])<1e-10,'Bounded ripple disagrees with exhaustive walk'));
    }
  } finally { await ripple.close(); }

  const session = await graphAt('session-race.db');
  try {
    await session.setSessionState('fixture-session', 'active');
    let entered!: () => void, release!: () => void;
    const generating = new Promise<void>(r => entered = r), blocked = new Promise<void>(r => release = r);
    embeddings.generateEmbedding = async () => { entered(); await blocked; return [1, ...Array(383).fill(0)]; };
    const saving = session.saveMemory('Must not save after host closes the session', { sessionId: 'fixture-session' });
    await generating;
    await session.setSessionState('fixture-session', 'closed');
    release();await assert.rejects(saving,/closed/);
    assert.equal((await (session as any).db.get('SELECT COUNT(*) n FROM nodes')).n,0);
    record('F08',{lateSaveRejected:true});
  } finally { embeddings.generateEmbedding = async () => [1, ...Array(383).fill(0)]; await session.close(); }

  const backfill = await graphAt('backfill.db');
  const originalBatch = embeddings.generateBatch, originalConnection = embeddings.testConnection;
  try {
    const saved = await backfill.saveMemory('Old content before background embedding');
    const before = await backfill.getNodeById(saved.id, { trackAccess: false }); assert(before);
    await (backfill as any).db.run('UPDATE nodes SET embedding=NULL WHERE id=?', [saved.id]);
    let entered!: () => void, release!: () => void;
    const generating = new Promise<void>(r => entered = r), blocked = new Promise<void>(r => release = r);
    embeddings.testConnection = async () => true;
    embeddings.generateBatch = async (texts: string[]) => { entered(); await blocked; return texts.map(() => [1, ...Array(383).fill(0)]); };
    const filling = (backfill as any).backfillEmbeddings();
    await generating;
    embeddings.generateEmbedding = async () => [0, 1, ...Array(382).fill(0)];
    await backfill.editMemory(saved.id, { content: 'New content written while background generation was waiting', expectedUpdatedAt: before.updatedAt });
    const afterEdit = await backfill.getNodeById(saved.id, { trackAccess: false });
    assert.equal(afterEdit?.embedding[1], 1);
    release(); await filling;
    const afterFill = await backfill.getNodeById(saved.id, { trackAccess: false });
    assert.equal(afterFill?.content, afterEdit?.content); assert.equal(afterFill?.embedding[1],1);assert.equal(afterFill?.embedding[0],0);
    record('F13', { bodyRemainedNew: true, newContentVectorPreserved: true,
      oldVector: afterFill?.embedding.slice(0, 2), expectedNewVector: afterEdit?.embedding.slice(0, 2) });
  } finally {
    embeddings.generateBatch = originalBatch; embeddings.testConnection = originalConnection;
    embeddings.generateEmbedding = async () => [1, ...Array(383).fill(0)]; await backfill.close();
  }

  const provenance = await graphAt('provenance.db');
  try {
    const ref = { uri: 'file:///fixture/config.ts', context: 'fixture-main', revision: 'v1' };
    await provenance.observeSource({ ...ref, status: 'present', expectedVersion: 0 });
    const a = await provenance.saveMemory('Config API listens on loopback', { sourceRefs: [ref], memberships: [{ spaceId: 'config', memoryType: 'fact' }] });
    const b = await provenance.saveMemory('Config API binds to localhost only', { sourceRefs: [ref], memberships: [{ spaceId: 'config', memoryType: 'fact' }] });
    const before = await provenance.getMemoryFreshness(a.memberships[0].id);
    assert.equal(before.status, 'checked');
    const job = await provenance.claimOrganizationJob({ spaceId: 'config', memoryType: 'fact', membershipIds: [a.memberships[0].id, b.memberships[0].id] });
    assert(job);
    const merged = await provenance.commitOrganizationPlan(job.id, { operations: [{ kind: 'consolidate',
      membershipIds: job.members.map(m => m.membership.id), content: 'Config API binds only to loopback (localhost).', reason: 'Both descriptions express the same configuration constraint' }] });
    const id = merged.createdMemoryIds[0], member = (await provenance.getMemberships(id))[0];
    await provenance.observeSource({ ...ref, revision: 'v2', status: 'present', expectedVersion: 1 });
    const after = await provenance.getMemoryFreshness(member.id);
    const trace = await provenance.traceMemory(id);
    assert.equal(after.status,'needs_review');assert(after.reasons.length>0); assert.equal(trace.nodes.length, 3);
    record('F09', { beforeConsolidation: before, afterConsolidationAndSourceChange: after,
      originalSourcesStillTraceable: trace.nodes.length === 3, consolidatedSourceRefs: (await provenance.getNodeById(id, { trackAccess: false }))?.sourceRefs });
    const scoped = await provenance.actionLogPage({ nodeId: id, context: { domains: [{ kind: 'personal', id: 'default' }] } });
    const operator = await provenance.actionLogPage({ nodeId: id });
    assert(operator.log.some(l => l.action === 'organization_consolidate'));
    assert(scoped.log.some(l => l.action === 'organization_consolidate'));
    results.push({ id: 'V01', status: 'VERIFIED', evidence: { organizationVisibleInScopedHistory: true,
      mechanism: 'attribute_memory_action trigger fills domain attribution for node-bound inserts' } });
  } finally { await provenance.close(); }

  const degraded = await graphAt('degraded.db');
  try {
    await degraded.saveMemory('textchannel unique fixture marker');
    (degraded as any).annSearch = async () => [];
    const query = { query: 'textchannel unique fixture marker', useAnchors: false, maxDepth: 0 };
    assert((await degraded.search(query)).length > 0);
    (degraded as any).ngramSearch = async () => { throw new Error('review-only injected text-index query failure'); };
    await assert.rejects(degraded.search(query),(e:any)=>e.code==='temporarily_unavailable');
    (degraded as any).annSearch=async()=>{throw new Error('fixture vector channel failure');};
    (degraded as any).ngramSearch=async()=>[];
    const partial=await degraded.recall(query);
    assert.equal(partial.retrieval?.degraded,true);
    assert(partial.retrieval?.channels.some(c=>c.channel==='body-vector'&&c.status==='failed'));
    const db=(degraded as any).db,all=db.all.bind(db);
    db.all=async(sql:string,...args:unknown[])=>{if(sql.includes('index_rowid'))throw new Error('fixture index-load failure');return all(sql,...args);};
    (degraded as any).indexGeneration=-1;
    await assert.rejects(degraded.search(query),(e:any)=>e.code==='temporarily_unavailable');
    db.all=all;
    record('F10',{allFailedIsError:true,partialFailureVisible:true});
  } finally { await degraded.close(); }

  const httpPath = path.join(temp, 'http.db'), seed = await graphAt('http.db');
  let privateId = '';
  try {
    await seed.saveMemory('Default personal fixture private marker');
    privateId = (await seed.saveMemory('Owner B protected personal fixture', { domain: { kind: 'personal', id: 'owner-b' } })).id;
  } finally { await seed.close(); }
  const socket = net.createServer(); await new Promise<void>(r => socket.listen(0, '127.0.0.1', r));
  const port = (socket.address() as net.AddressInfo).port; await new Promise<void>(r => socket.close(() => r()));
  const secret = 'review-context-only-fixture';
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/server.js', import.meta.url))], {
    env: { ...process.env, MEMORY_DB_PATH: httpPath, MEMORY_PORT: String(port), MEMORY_HOST: '127.0.0.1',
      MEMORY_CONTEXT_SECRET: secret, MEMORY_API_KEY: '', MEMORY_OPERATOR_KEY: '', MEMORY_CORS_ORIGINS: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', x => logs += x); child.stderr.on('data', x => logs += x);
  const url = 'http://127.0.0.1:' + port;
  const token = (owner: string) => signContextToken({ principal: owner, domains: [{ kind: 'personal', id: owner }] }, secret);
  const request = async (route: string, body?: unknown, contextToken?: string) => {
    const response = await fetch(url + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(contextToken ? { 'x-mindpond-context': contextToken } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    for (let i = 0; i < 100 && !logs.includes('listening'); i++) await new Promise(r => setTimeout(r, 100));
    assert(logs.includes('listening'), logs);
    const denied = await request('/api/memory/node/' + privateId, undefined, token('owner-a'));
    assert.notEqual(denied.status, 200);
    const recalled = await request('/api/memory/search', { query: 'Owner B protected personal fixture', hostId: 'host-b', runId: 'run-b' }, token('owner-b'));
    assert.equal(recalled.status, 200); assert(recalled.body.results.some((r: any) => r.id === privateId));
    const forged = await request('/api/host/use-report', { reportId: 'foreign-report', recallId: recalled.body.recallId,
      hostId: 'host-b', runId: 'run-b', task: 'Unrelated caller', outcome: 'unknown', observations: [{ memoryId: privateId,
        disposition: 'rejected', issue: 'incorrect', reason: 'Foreign caller should not be able to enqueue this', context: 'Outside owner-a grant' }] }, token('owner-a'));
    assert.equal(forged.status,403);
    const signals = await request('/api/host/improvement/list', {}, token('owner-b'));
    assert(!signals.body.signals.some((s:any)=>s.memoryIds.includes(privateId)));
    const feedback={recallId:recalled.body.recallId,hostId:'host-b',runId:'run-b',decisions:[{memoryId:privateId,disposition:'used',reason:'Owner verified applicability'}]};
    assert.equal((await request('/api/memory/recall-feedback',feedback,token('owner-a'))).status,403);
    assert.equal((await request('/api/memory/recall-feedback',feedback,token('owner-b'))).status,200);
    assert.equal((await request('/api/memory/recall-feedback',feedback,token('owner-a'))).status,403,'A receipt replay cannot bypass current authorization');
    record('F07', { foreignDirectReadStatus: denied.status, foreignUseReportStatus: forged.status,
      foreignReviewSignalPrevented: true, precondition: 'Caller has recallId/nodeId and caller-authored hostId/runId; IDs are not authorization' });
    const anonymous = await request('/api/memory/search', { query: 'Default personal fixture private marker' });
    const anonymousSave = await request('/api/memory/save', { content: 'Anonymous fixture save without credentials' });
    assert.equal(anonymous.status,403);assert.equal(anonymousSave.status,403);
    record('F12', { contextSecretConfigured: true, apiKeyConfigured: false, anonymousDefaultPersonalReadStatus: anonymous.status,
      anonymousDefaultPersonalWriteStatus: anonymousSave.status, deploymentCondition: 'Strict context signing alone is not authentication' });
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>(r => { if (child.exitCode !== null) r(); else { child.once('exit', () => r()); setTimeout(() => { child.kill('SIGKILL'); r(); }, 3000).unref(); } });
  }

  const workerPath = fileURLToPath(new URL('../dist/integrations/host-worker.js', import.meta.url));
  const host = { directory: temp, worktree: temp, client: {
    session: { messages: async () => ({ data: [{ info: { id: 'fixture-message', role: 'user' },
      parts: [{ type: 'text', text: 'Public fixture scene: proxy review marker' }] }] }) },
    app: { log: async () => ({}) },
  } };
  const options = { workerPath, nodePath: process.execPath, timeoutMs: 20000 };
  const first = await createOpenCodeMemoryPlugin(host, { ...options, dbPath: path.join(temp, 'native-a.db') });
  try {
    await first.event({ event: { type: 'session.idle', properties: { sessionID: 'same-session' } } });
    const before = JSON.parse(await first.tool.memory_event_search.execute({ query: 'proxy review marker' }, { sessionID: 'same-session' }));
    assert(before.results.length > 0);
    const second = await createOpenCodeMemoryPlugin(host, { ...options, dbPath: path.join(temp, 'native-b.db') });
    try {
      await second.event({ event: { type: 'session.idle', properties: { sessionID: 'same-session' } } });
      const other = JSON.parse(await second.tool.memory_event_search.execute({ query: 'proxy review marker' }, { sessionID: 'same-session' }));
      const db = await open({ filename: path.join(temp, 'native-b.db'), driver: sqlite3.Database });
      const count = await db.get("SELECT COUNT(*) n FROM nodes WHERE layer='L0'"); await db.close();
      assert.equal(count.n,1);assert(other.results.length>0);
      record('F04', { firstDatabaseSceneCount: before.results.length, secondDatabaseSceneCount: other.results.length,
        secondDatabaseRawNodeCount: count.n, sameProjectAndNativeSessionDifferentDatabases: true });
    } finally { await second.dispose(); }
    const restorePath=path.join(temp,'native-restore.db');
    const empty=await graphAt('native-restore.db');await empty.close();
    const snapshot=path.join(temp,'native-restore.snapshot');await fs.copyFile(restorePath,snapshot);
    const captureOnce=await createOpenCodeMemoryPlugin(host,{...options,dbPath:restorePath});
    await captureOnce.event({event:{type:'session.idle',properties:{sessionID:'restore-session'}}});await captureOnce.dispose();
    await fs.copyFile(snapshot,restorePath);await fs.rm(restorePath+'-wal',{force:true});await fs.rm(restorePath+'-shm',{force:true});
    const afterRestore=await createOpenCodeMemoryPlugin(host,{...options,dbPath:restorePath});
    try{await afterRestore.event({event:{type:'session.idle',properties:{sessionID:'restore-session'}}});const scene=JSON.parse(await afterRestore.tool.memory_event_search.execute({query:'proxy review marker'},{sessionID:'restore-session'}));assert(scene.results.length>0,'ACK must be checked against restored DB receipt');}finally{await afterRestore.dispose();}
    await first.event({ event: { type: 'session.deleted', properties: { sessionID: 'same-session' } } });
    const closed = JSON.parse(await first.tool.memory_event_search.execute({ query: 'proxy review marker' }, { sessionID: 'same-session' }));
    assert.equal(closed.results.length, 0);
    await assert.rejects(first.tool.memory_action.execute({ tool: 'memory_session_state', arguments: { status: 'active' } }, { sessionID: 'same-session' }),/lifecycle|host|session/i);
    const reopened = JSON.parse(await first.tool.memory_event_search.execute({ query: 'proxy review marker' }, { sessionID: 'same-session' }));
    assert.equal(reopened.results.length,0);
    record('F05', { afterHostDeletionSceneCount: closed.results.length,
      afterAgentAuthoredReopenSceneCount: reopened.results.length });
  } finally { await first.dispose(); }
  const report = { verification:'production-safety',baselineCommit:'472e30e662941191e4266ce470b4b8c82c0c0d28', findings: results };
  if (process.env.MINDPOND_REVIEW_REPORT_PATH) await fs.writeFile(process.env.MINDPOND_REVIEW_REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  embeddings.generateEmbedding = originalEmbedding;
  await fs.rm(temp, { recursive: true, force: true });
}
