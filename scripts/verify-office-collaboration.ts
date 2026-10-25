/** Cross-process records, authorization, protocol handles and complete-context recovery. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GraphMemory } from '../src/core/graph-memory.js';
import { OfficeWaitQueue } from '../src/core/office-wait-queue.js';
import { createMemoryMcpServer } from '../src/mcp-service.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { TrustedCallContext } from '../src/core/trust.js';
import {officeAdminServices} from '../src/integrations/office-admin-services.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-office-completion-'));
const graph = new GraphMemory('.', { dbPath: path.join(dir, 'test.db') }), other = new GraphMemory('.', { dbPath: path.join(dir, 'test.db') });
const admin: TrustedCallContext = { v: 1, principal: 'human', operator: true, issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
const actors: TrustedCallContext[] = [], clients: Client[] = [];
const servers: any[] = [];
try {
    await graph.init();
    await other.init();
    await graph.offices.configureAgent({ id: 'cli', principal: 'owner', name: 'Fixture', host: 'codex', state: 'active', expectedRevision: 0 }, admin);
    for (const runtimeId of ['a', 'b', 'c']) {
        const actor: TrustedCallContext = { v: 1, principal: 'owner', agentId: 'cli', transport: 'http-mcp', runtimeId, domains: [{ kind: 'personal', id: runtimeId }], issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
        const application = await graph.roles.application({ action: 'submit', name: runtimeId, introduction: 'Fixture role ' + runtimeId, reason: 'Isolated test', key: runtimeId }, actor), role = await graph.roles.review({ applicationId: application.applicationId, expectedRevision: 1, action: 'approve' }, admin);
        actor.domains=[await graph.memoryOwners.domain({kind:'agent',id:role.roleId})];
        actors.push({ ...actor, roleId: role.roleId, roleBindingId: role.bindingId, roleBindingEpoch: 1 });
    }
    const [a, b, c] = actors;
    await graph.roles.configureOffice({ id: 'room', title: 'Fixture room', state: 'active', expectedRevision: 0, seats: actors.map((p, n) => ({ id: 'seat-' + n, agentId: 'cli', roleId: p.roleId, label: String(n) })) }, admin);
    const adminRoutes=new Map<string,(req:any)=>Promise<unknown>>();
    officeAdminServices(graph,(name,fn)=>adminRoutes.set(name,fn),admin);
    const permissions:any=await adminRoutes.get('/permissions')!({body:{roleId:a.roleId}});
    assert.equal(permissions.offices[0].office_id,'room');
    assert.equal(permissions.knowledgePolicy.roleName,'a');
    assert.match(permissions.knowledgePolicy.description,/连接授权.*收窄/);
    assert.match(permissions.knowledgePolicy.description,/办公室/);
    assert(!('memoryGrants' in permissions),'Membership navigation must not invent effective connection grants');
    const input = { kind: 'broadcast', officeId: 'room', recipients: [b.roleId, c.roleId], body: 'Compare these sources', topic: 'evidence', key: 'group' };
    const broadcast = await graph.officeCollaboration.publish(input, a);
    assert.equal(broadcast.deliveries.length, 2);
    assert.deepEqual(await other.officeCollaboration.publish(input, a), broadcast, 'broadcast retries do not duplicate deliveries');
    await assert.rejects(graph.officeCollaboration.publish({ ...input, key: 'bad', recipients: [b.roleId, 'missing'] }, a));
    assert.equal((await graph.building.history({ officeId: 'room' }, admin)).messages.length, 2, 'invalid group rolls back all recipients');
    const first = broadcast.deliveries[0].messageId;
    const sequence=broadcast.deliveries[0].seq;
    assert.equal((await graph.building.message({action:'get',seq:sequence},b)).message.id,first);
    const messageEvent=await (graph as any).db.get("SELECT seq FROM office_events WHERE office_id='room' AND json_extract(body,'$.messageId')=? AND kind='message'",[first]);
    assert.equal((await graph.building.message({action:'get',officeId:'room',eventSeq:messageEvent.seq},b)).message.id,first,'office timeline event sequence is an explicit independent reference');
    await assert.rejects(graph.building.message({action:'get',eventSeq:messageEvent.seq},b),(e:any)=>e.code==='invalid_input');
    assert.equal((await graph.building.messagePreview({officeId:'room',seq:sequence},admin)).message.id,first);
    assert.equal((await graph.roles.messagePreview({seq:sequence},admin)).message.id,first);
    await assert.rejects(graph.building.message({action:'get',messageId:String(sequence)},b),(e:any)=>e.code==='invalid_input'&&e.field==='messageId');
    await assert.rejects(graph.building.message({action:'get',messageId:first,seq:sequence},b),(e:any)=>e.code==='invalid_input');
    await assert.rejects(graph.building.message({action:'get',seq:sequence},c),(e:any)=>e.code==='not_found');
    await assert.rejects(graph.building.message({action:'get',seq:9999999},c),(e:any)=>e.code==='not_found');
    const takeBySequence={action:'take',seq:sequence,key:'seq-take'};
    assert.equal((await graph.building.message(takeBySequence,b)).state,'processing');
    assert.equal((await graph.building.message({action:'take',messageId:first,key:'seq-take'},b)).state,'processing','selector normalization preserves idempotency');
    const finish=await graph.building.message({action:'finish',seq:sequence,key:'seq-finish',result:'Verified reference resolution'},b);
    assert.equal(finish.state,'archived');
    const counts=await graph.building.snapshot('room',admin);
    assert.equal(counts.counts.archived,1);assert.equal(counts.counts.processing,0);
    assert.equal((await other.building.snapshot('room',admin,counts.revision)).counts.total,counts.counts.total,'unchanged document snapshots still carry exact live totals');
    const pendingWindow=await graph.building.history({officeId:'room',state:'pending',knownIds:[first]},admin);
    assert.equal(pendingWindow.knownMessages[0].state,'archived');assert.equal(pendingWindow.knownMessages[0].matches,0,'a completed message leaves an applied pending filter');
    assert.equal(pendingWindow.knownMessages[0].result,'Verified reference resolution','already loaded messages must refresh their completion feedback, including outside the newest page');
    const reply = await graph.building.message({ action: 'send', replyTo: first, body: 'Please check the cited revision', key: 'reply' }, b);
    assert.equal((await graph.building.message({ action: 'get', messageId: reply.messageId }, a)).quote.id, first);
    const cursor = await graph.building.receive({ action: 'list', direction: 'sent' }, a);
    await assert.rejects(graph.building.receive({ action: 'list', query: 'different', cursorScope: cursor.cursorScope }, a), /scope changed/);
    assert.equal((await graph.building.history({ officeId: 'room', since: Date.now() + 10000 }, admin)).messages.length, 0);
    const privateMemory = await graph.saveMemory('Only actor a may read this lesson', { domain: await graph.memoryOwners.domain({kind:'agent',id:a.roleId!}), memberships: [{ spaceId: 'fixture', memoryType: 'work' }] });
    const learning = { kind: 'learning', officeId: 'room', title: 'Rechecked environment', memoryId: privateMemory.id, messageId: first, outcome: 'used', evidence: 'Validated the actual source at a pinned revision', key: 'learning' };
    await graph.officeCollaboration.publish(learning, a);
    await assert.rejects(graph.officeCollaboration.publish({ ...learning, key: 'false-recall', recallId: 'not-a-real-recall' }, a), /not in this recall/);
    assert.equal((await graph.officeCollaboration.records({ officeId: 'room', kind: 'learning' }, b)).records.length, 0, 'room membership grants no private-memory access');
    assert.equal((await graph.officeCollaboration.records({ officeId: 'room', kind: 'learning' }, a)).records[0].payload.memoryId, privateMemory.id);
    await assert.rejects(graph.officeCollaboration.publish({ ...learning, key: 'unauthorized' }, b), /Memory unavailable/);
    const handoff = await graph.officeCollaboration.publish({ kind: 'handoff', officeId: 'room', title: 'Versioned result', summary: 'Pinned source and reproduction', repository: 'fixture:repo', branch: 'fixture', commit: 'a'.repeat(40), checks: ['Reproduced then fixed'], unresolved: ['Review semantics'], nextSteps: ['Verify current sources'], key: 'handoff' }, a);
    assert(handoff.digest);
    assert.equal((await graph.officeCollaboration.handoffContext({ officeId: 'room' }, b)).records.records.length, 1);
    const control = await graph.officeCollaboration.requestControl({ roleId: b.roleId, action: 'pause', reason: 'Explicit user pause' }, admin);
    assert.equal((await other.roles.sync(b)).controlRequests[0].id, control.id);
    await assert.rejects(graph.officeCollaboration.host({ action: 'ack', requestId: control.id, outcome: 'acknowledged', evidence: 'Wrong role' }, a));
    const ack = await graph.officeCollaboration.host({ action: 'ack', requestId: control.id, outcome: 'acknowledged', evidence: 'Stopped work before further side effects' }, b);
    assert.equal(ack.request.state, 'acknowledged');
    const probe = await graph.officeCollaboration.host({ action: 'probe', waitMs: 100, client: 'Fixture', toolTimeoutMs: 360000 }, b);
    assert(probe.measuredWaitMs >= 80);
    await assert.rejects(graph.officeCollaboration.host({ action: 'confirm', probeId: 'wrong', clientRoundTripMs: 100 }, b));
    assert.equal((await graph.officeCollaboration.host({ action: 'confirm', probeId: probe.probeId, clientRoundTripMs: probe.measuredWaitMs }, b)).clientReceived, true);
    const taskStore = graph.officeTaskStore(b), task = await taskStore.createTask({ ttl: 3600000 }, 1, { method: 'tools/call', params: { name: 'office_wait_task', arguments: { afterSeq: 999999, waitMs: 100 } } });
    assert.equal(await other.officeTaskStore(a).getTask(task.taskId), null);
    await new Promise(r => setTimeout(r, 120));
    assert.equal((await other.officeTaskStore(b).getTask(task.taskId))?.status, 'completed', 'task timeout can be evaluated after reconnect');
    assert.equal(JSON.parse((await other.officeTaskStore(b).getTaskResult(task.taskId)).content[0].text).pending, true);
    const cancel = await taskStore.createTask({}, 2, { method: 'tools/call', params: { name: 'office_wait_task', arguments: { afterSeq: 999999 } } });
    await taskStore.updateTaskStatus(cancel.taskId, 'cancelled');
    assert.equal((await taskStore.getTask(cancel.taskId))?.status, 'cancelled');
    await graph.roles.configure({ roleId: a.roleId, expectedRevision: 1, name: 'A', introduction: 'Long capability description '.repeat(140), state: 'active' }, admin);
    const memoryServer = createMemoryMcpServer(graph, { trusted: a, toolProfile: 'work' });
    servers.push(memoryServer);
    const client = new Client({ name: 'budget-verification', version: '1' });
    clients.push(client);
    const [left, right] = InMemoryTransport.createLinkedPair();
    await Promise.all([memoryServer.server.connect(left), client.connect(right)]);
    const result: any = await client.callTool({ name: 'role_sync', arguments: { responseBudgetBytes: 2048 } });
    assert(Buffer.byteLength(JSON.stringify(result)) <= 2048, 'complete MCP envelope meets the requested budget');
    const pointer = JSON.parse(result.content[0].text);
    assert(pointer.paged);
    let text = '', offset = 0;
    for (let n = 0; n < 400; n++) {
        const page: any = await client.callTool({ name: 'office_context', arguments: { action: 'page', id: pointer.id, offset, characters: 1024, responseBudgetBytes: 2048 } });
        assert(Buffer.byteLength(JSON.stringify(page)) <= 2048);
        const data = JSON.parse(page.content[0].text);
        assert(!data.paged, 'page reads do not recursively page themselves');
        text += data.text;
        if (data.nextOffset === null)
            break;
        assert(data.nextOffset > offset);
        offset = data.nextOffset;
    }
    assert.equal(JSON.parse(JSON.parse(text).content[0].text).identity.introduction, 'Long capability description '.repeat(140));
    const bySequence:any=await client.callTool({name:'office_message',arguments:{action:'get',seq:sequence}});
    assert.equal(JSON.parse(bySequence.content[0].text).message.id,first);
    const wrongType:any=await client.callTool({name:'office_message',arguments:{action:'get',seq:String(sequence)}});
    assert(wrongType.isError,'schema rejects text in numeric seq');
    const missingMessage:any=await client.callTool({name:'office_message',arguments:{action:'get',seq:9999999}});
    assert.equal(JSON.parse(missingMessage.content[0].text).error.code,'not_found');
    const memoryRead:any=await client.callTool({name:'memory_get',arguments:{nodeId:privateMemory.id}});
    assert(memoryRead.isError,'Office never exposes personal-domain Memory tools, including when an embedding caller requests the work catalog');
    assert((await client.listTools()).tools.every(t=>!t.name.startsWith('memory_')));
    await assert.rejects(graph.officeCollaboration.responsePage({ id: pointer.id }, b));
    await assert.rejects(graph.officeCollaboration.responsePage({ id: pointer.id }, {...a,domains:[]}), (e:any)=>e.code==='not_found','a narrowed grant cannot read an earlier cached response');
    await assert.rejects(graph.officeCollaboration.responsePage({ id: pointer.id, offset: 9999999 }, a), /offset/);
    const negotiated = [];
    for await (const event of client.experimental.tasks.callToolStream({ name: 'office_wait_task', arguments: { afterSeq: 999999, waitMs: 100 } })) {
        negotiated.push(event);
    }
    assert(negotiated.some((e: any) => e.type === 'result'), 'real MCP task negotiation returns the deferred tool result');
    const capacityBefore = { per: process.env.MINDPOND_OFFICE_WAIT_PER_ACCOUNT, global: process.env.MINDPOND_OFFICE_WAIT_GLOBAL };
    process.env.MINDPOND_OFFICE_WAIT_PER_ACCOUNT = '1';
    process.env.MINDPOND_OFFICE_WAIT_GLOBAL = '1';
    try {
        await graph.officeCollaboration.operations({ action: 'capacity', maxPerPrincipal: 1, maxGlobal: 1 }, admin);
        const queues = [graph, other].map(g => new OfficeWaitQueue((g as any).db, f => (g as any).growthWrite(f)));
        const order: string[] = [];
        let started!: () => void, release!: () => void;
        const running = new Promise<void>(r => started = r), gate = new Promise<void>(r => release = r);
        const first = queues[0].run('A', 'binding-a', 5000, undefined, async () => { }, async () => { order.push('A1'); started(); await gate; return 'A1'; }, () => { throw Error('Unexpected queue timeout'); });
        await running;
        const second = queues[1].run('A', 'binding-a2', 5000, undefined, async () => { }, async () => { order.push('A2'); return 'A2'; }, () => { throw Error('Unexpected queue timeout'); });
        const third = queues[1].run('B', 'binding-b', 5000, undefined, async () => { }, async () => { order.push('B1'); return 'B1'; }, () => { throw Error('Unexpected queue timeout'); });
        for (let n = 0; n < 100; n++) {
            if ((await (graph as any).db.get("SELECT COUNT(*) n FROM office_wait_queue WHERE state='queued'")).n === 2)
                break;
            await new Promise(r => setTimeout(r, 10));
        }
        assert.equal((await (other as any).db.get("SELECT COUNT(*) n FROM office_wait_queue WHERE state='running'")).n, 1);
        release();
        await Promise.all([first, second, third]);
        assert.deepEqual(order, ['A1', 'B1', 'A2'], 'a busy account does not monopolize the cross-process wait slot');
        const controller = new AbortController();
        let holding!: () => void, unblock!: () => void;
        const held = new Promise<void>(r => holding = r), blocked = new Promise<void>(r => unblock = r);
        const holder = queues[0].run('A', 'held', 3000, undefined, async () => { }, async () => { holding(); await blocked; return true; }, () => false);
        await held;
        const cancelled = queues[1].run('B', 'cancelled', 3000, controller.signal, async () => { }, async () => true, () => false);
        const rejected = assert.rejects(cancelled, /cancelled/);
        controller.abort();
        await rejected;
        assert(!await (other as any).db.get('SELECT 1 FROM office_wait_queue WHERE binding_id=?', ['cancelled']), 'cancelled admission releases its lease');
        unblock();
        await holder;
        queues.forEach(q => q.close());
    }
    finally {
        if (capacityBefore.per === undefined)
            delete process.env.MINDPOND_OFFICE_WAIT_PER_ACCOUNT;
        else
            process.env.MINDPOND_OFFICE_WAIT_PER_ACCOUNT = capacityBefore.per;
        if (capacityBefore.global === undefined)
            delete process.env.MINDPOND_OFFICE_WAIT_GLOBAL;
        else
            process.env.MINDPOND_OFFICE_WAIT_GLOBAL = capacityBefore.global;
    }
    const frame = await graph.officeCollaboration.captureLayout({ officeId: 'room', width: 1000, height: 900, seats: actors.map((p, n) => ({ id: 'seat-' + n, roleId: p.roleId, x: n * 300, y: 0 })) }, admin);
    const history = await graph.building.replay({ action: 'index', officeId: 'room' }, admin);
    assert(history.layouts.some((l: any) => l.id === frame.id));
    const captureEvent = await (graph as any).db.get("SELECT seq,ts FROM office_events WHERE kind='layout_saved' ORDER BY seq DESC LIMIT 1");
    await graph.officeCollaboration.publish({ kind: 'marker', officeId: 'room', title: 'After capture', key: 'same-ms-marker' }, a);
    await (graph as any).db.run('UPDATE office_events SET ts=? WHERE office_id=?', [captureEvent.ts, 'room']);
    const layoutPage = await graph.building.replay({ action: 'page', officeId: 'room' }, admin);
    assert(layoutPage.events.filter((e: any) => e.seq < captureEvent.seq).every((e: any) => e.layoutId === null), 'equal timestamps never apply a future layout');
    assert(layoutPage.events.some((e: any) => e.seq > captureEvent.seq && e.layoutId === frame.id));
    const scoped = await graph.building.replay({ action: 'page', officeId: 'room', topic: 'evidence' }, admin);
    assert(scoped.events.length >= 2);
    assert((await graph.officeCollaboration.impact({ kind: 'office', id: 'room' }, admin)).counts.messages >= 3);
    const exported = await graph.officeCollaboration.exportPage({ officeId: 'room', section: 'handoffs' }, admin);
    assert.equal(exported.rows.length, 2);
    await graph.officeCollaboration.publish({ kind: 'marker', officeId: 'room', title: 'After export', key: 'after-export' }, a);
    assert.equal((await other.officeCollaboration.exportPage({ officeId: 'room', section: 'handoffs', snapshotId: exported.snapshotId }, admin)).rows.length, 2, 'snapshot pages are stable across concurrent writes');
    assert((await graph.officeCollaboration.exportPage({ officeId: 'room', section: 'layouts', snapshotId: exported.snapshotId }, admin)).rows.some((r: any) => r.kind === 'geometry'));
    await assert.rejects(graph.officeCollaboration.exportPage({ officeId: 'room', section: 'messages', snapshotId: exported.snapshotId }, { ...admin, principal: 'another-human' }), /unavailable/);
    await assert.rejects(graph.officeCollaboration.operations({ action: 'status' }, a));
    const backup = await graph.officeCollaboration.operations({ action: 'backup' }, admin), check = await graph.officeCollaboration.operations({ action: 'checkBackup', id: backup.id }, admin);
    assert(check.healthy && check.digestMatches);
    const restored = path.join(dir, 'restored.db');
    const restoration = await exec(process.execPath, ['dist/maintenance.js', '--db', check.restore.backupFile, '--restore-to', restored]);
    assert(JSON.parse(restoration.stdout).healthy);
    assert.equal((await fs.stat(restored)).mode & 0o777, 0o600);
    await assert.rejects(exec(process.execPath, ['dist/maintenance.js', '--db', check.restore.backupFile, '--restore-to', restored]), /EEXIST/, 'restore refuses to overwrite an existing database');
    const preview = await graph.officeCollaboration.operations({ action: 'retentionPreview', days: 1 }, admin);
    assert(!preview.applied);
    assert.equal((await graph.officeCollaboration.operations({ action: 'retentionApply', days: 1 }, admin)).applied, true);
    await graph.roles.link({sender:a.roleId,recipient:b.roleId,enabled:false},admin);
    await assert.rejects(graph.officeCollaboration.responsePage({id:pointer.id},a),(e:any)=>e.code==='not_found','contact permission changes invalidate cached envelopes');
    console.log('PASS collaboration: atomic per-recipient broadcast, quotes/query cursors, memory grant isolation, versioned handoffs, human controls, confirmed host probe, durable scoped MCP task handles, full-envelope budgets, historical layouts, exports and private backup integrity');
}
finally {
    for (const client of clients)
        await client.close();
    for (const server of servers)
        await server.close();
    await other.close();
    await graph.close();
    await fs.rm(dir, { recursive: true, force: true });
}
