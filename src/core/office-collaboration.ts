/** Optional collaboration records. Room membership grants shared office knowledge, never private role knowledge or host control. */
import type { Database } from 'sqlite';
import type { GraphMemory } from './graph-memory.js';
import type { TrustedCallContext } from './trust.js';
import { trustedDomainSet } from './trust.js';
import { MindPondError } from './errors.js';
import { createHash, randomUUID } from 'node:crypto';
import { stableJSON } from './growth.js';
import { previewText } from './office-context.js';
import { officeWaitCapacity } from './office-wait-policy.js';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { auditDatabase } from './database-maintenance.js';
type Row = Record<string, any>;
const fail = (message: string,code:'scope_denied'|'invalid_input'|'not_found'): never => { throw new MindPondError(code, message); };
const hash = (value: unknown) => createHash('sha256').update(stableJSON(value)).digest('hex');
async function fileHash(filename: string) { const digest = createHash('sha256'); for await (const chunk of createReadStream(filename))
    digest.update(chunk); return digest.digest('hex'); }
export class OfficeCollaboration {
    constructor(private db: Database, private graph: GraphMemory, private write: <T>(f: () => Promise<T>) => Promise<T>, private databasePath: string, private clock = Date.now) { }
    async init() {
        await this.db.exec(`
    CREATE TABLE IF NOT EXISTS office_collaboration_records(id TEXT PRIMARY KEY,office_id TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,role_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS office_collaboration_page ON office_collaboration_records(office_id,kind,created_at,id);
    CREATE TABLE IF NOT EXISTS office_collaboration_receipts(actor TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,office_id TEXT,PRIMARY KEY(actor,key));
    CREATE TABLE IF NOT EXISTS office_host_reports(role_id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,payload TEXT NOT NULL,observed_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS office_probe_leases(id TEXT PRIMARY KEY,binding_id TEXT NOT NULL UNIQUE,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS office_control_requests(id TEXT PRIMARY KEY,role_id TEXT NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,state TEXT NOT NULL,requested_at INTEGER NOT NULL,acknowledged_at INTEGER,evidence TEXT);
    CREATE TABLE IF NOT EXISTS office_response_pages(id TEXT PRIMARY KEY,actor TEXT NOT NULL,payload TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS office_backup_records(id TEXT PRIMARY KEY,filename TEXT NOT NULL,created_at INTEGER NOT NULL,sha256 TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS office_layout_snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT,office_id TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,revision INTEGER NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(office_id,revision));
    CREATE TABLE IF NOT EXISTS office_wait_queue(id TEXT PRIMARY KEY,principal TEXT NOT NULL,binding_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS office_wait_turns(principal TEXT PRIMARY KEY,admitted_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS office_protocol_tasks(id TEXT PRIMARY KEY,owner TEXT NOT NULL,state TEXT NOT NULL,conditions TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,result TEXT,message TEXT);
    CREATE TABLE IF NOT EXISTS office_exports(id TEXT PRIMARY KEY,office_id TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,owner TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,sha256 TEXT,bytes INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS office_export_rows(snapshot_id TEXT NOT NULL REFERENCES office_exports(id) ON DELETE CASCADE,section TEXT NOT NULL,position INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(snapshot_id,section,position));
    CREATE INDEX IF NOT EXISTS office_queue_state ON office_wait_queue(state,expires_at);
  `);
    }
    private admin(a?: TrustedCallContext) { if (!a?.operator || a.expiresAt <= this.clock())
        fail('User management required', 'scope_denied'); }
    private async identity(a?: TrustedCallContext) { const b = await this.graph.roles.binding(a); if (!b)
        fail('Approved role required', 'scope_denied'); return b!; }
    private async memory(id: string, a: TrustedCallContext) {
        const row = await this.db.get<Row>('SELECT domain_kind,domain_id FROM nodes WHERE id=?', [id]);
        if (!row)
            return null;
        const context=a.operator?undefined:await this.graph.memoryOwners.context({kind:'agent',id:(await this.identity(a)).role_id});
        if(context&&!context.domains.some(d=>d.kind===row.domain_kind&&d.id===row.domain_id))return null;
        return this.graph.getNodeById(id,{trackAccess:false,context});
    }
    async room(officeId: string, a?: TrustedCallContext, writing = false) {
        const room = await this.db.get<Row>('SELECT * FROM offices WHERE id=?', [officeId]);
        if (!room)
            fail('Office not found in the permitted rooms', 'not_found');
        if (a?.operator)
            this.admin(a);
        else {
            const b = await this.identity(a);
            const seats = await this.graph.offices.authorizedSeats({ ...a!, roleId: b.role_id, roleBindingId: b.id, roleBindingEpoch: b.epoch });
            if (!seats.some(s => s.office_id === officeId))
                fail('Office not found in the permitted rooms', 'not_found');
        }
        if (writing && room!.state !== 'active')
            throw new MindPondError('invalid_input', 'Office is not open for changes');
        return room!;
    }
    private async once(i: Row, a: TrustedCallContext, fn: () => Promise<Row>) {
        const b = await this.identity(a), actor = b.id + ':' + b.epoch;
        if (!i.key)
            throw new MindPondError('invalid_input', 'A stable key is required');
        const fingerprint = hash(i), old = await this.db.get<Row>('SELECT * FROM office_collaboration_receipts WHERE actor=? AND key=?', [actor, i.key]);
        if (old) {
            if (old.hash !== fingerprint)
                throw new MindPondError('idempotency_conflict', 'Key already used with different content');
            return JSON.parse(old.result);
        }
        const result = await fn();
        await this.db.run('INSERT INTO office_collaboration_receipts VALUES(?,?,?,?,?)', [actor, i.key, fingerprint, JSON.stringify(result), i.officeId ?? null]);
        return result;
    }
    async event(officeId: string, roleId: string | null, kind: string, body: Row) {
        await this.db.run('INSERT INTO office_events(office_id,seat_id,actor,kind,body,ts) VALUES(?,NULL,?,?,?,?)', [officeId, JSON.stringify({ roleId }), kind, JSON.stringify(body), this.clock()]);
    }
    async publish(i: Row, a?: TrustedCallContext) {
        return this.write(async () => {
            await this.room(i.officeId, a, true);
            const b = await this.identity(a);
            return this.once(i, a!, async () => {
                if (i.kind === 'broadcast') {
                    const recipients = [...new Set<string>(i.recipients)];
                    if (!recipients.length)
                        throw new MindPondError('invalid_input', 'Choose recipients explicitly');
                    // Every delivery checks its own recipient and room permission in the same transaction.
                    const groupId = randomUUID(), deliveries = [];
                    for (const recipient of recipients) {
                        if (!await this.db.get('SELECT 1 FROM role_seats rs JOIN office_seats s ON s.id=rs.seat_id WHERE rs.role_id=? AND s.office_id=? AND s.enabled=1', [recipient, i.officeId]))
                            fail('Recipient is not in this office', 'scope_denied');
                        const sent = await this.graph.building.message({ action: 'send', recipient, officeId: i.officeId, body: i.body, key: groupId + ':' + recipient, metadata: { broadcastId: groupId, topic: i.topic ?? null } }, a);
                        deliveries.push({ recipient, ...sent });
                    }
                    return { id: groupId, officeId: i.officeId, deliveries };
                }
                const id = randomUUID(), payload: Row = { ...i, id, author: b.role_id };
                delete payload.key;
                if (i.kind === 'handoff')
                    for (const materialId of i.materialIds ?? [])
                        if (!await this.db.get('SELECT 1 FROM office_materials WHERE id=? AND office_id=?', [materialId, i.officeId]))
                            fail('Material is outside this office', 'scope_denied');
                if (i.kind === 'learning') {
                    const memory = await this.memory(i.memoryId, a!);
                    if (!memory)
                        fail('Memory unavailable in the host grant', 'scope_denied');
                    // Store attribution and an immutable evidence digest, not a copy of private memory.
                    payload.memoryDomain = memory!.domain;
                    payload.memoryRevision = memory!.updatedAt;
                    payload.memoryHash = hash(memory!.content);
                    payload.reuseEvidence = { level: 'attributed_report' };
                    if (i.recallId) {
                        const recall = await this.db.get<Row>('SELECT result_ids FROM memory_recalls WHERE id=?', [i.recallId]);
                        if (!recall || !JSON.parse(recall.result_ids).some((r: Row) => r.id === i.memoryId))
                            fail('Memory was not in this recall','invalid_input');
                        payload.reuseEvidence = { level: 'recorded_recall', recallId: i.recallId };
                    }
                    if (i.useReportId && !['used', 'rejected'].includes(i.outcome))
                        throw new MindPondError('invalid_input', 'Use report requires used or rejected outcome');
                    if (i.useReportId) {
                        const report = await this.db.get<Row>('SELECT recall_id,payload FROM memory_use_reports WHERE id=?', [i.useReportId]);
                        if (!report || !JSON.parse(report.payload).observations.some((r: Row) => r.memoryId === i.memoryId && r.disposition === (i.outcome === 'used' ? 'used' : 'rejected')))
                            fail('Matching memory use report unavailable','invalid_input');
                        payload.reuseEvidence = { level: 'recorded_use_report', recallId: report!.recall_id, useReportId: i.useReportId };
                    }
                    if (i.messageId) {
                        const source = await this.graph.building.message({ action: 'get', messageId: i.messageId }, a);
                        if (source.message.officeId !== i.officeId)
                            fail('Learning source must be in this office','invalid_input');
                    }
                }
                payload.digest = hash(payload);
                await this.db.run('INSERT INTO office_collaboration_records VALUES(?,?,?,?,?,?)', [id, i.officeId, b.role_id, i.kind, JSON.stringify(payload), this.clock()]);
                await this.event(i.officeId, b.role_id, i.kind === 'learning' ? 'experience_' + i.outcome : i.kind, { recordId: id, title: i.kind === 'learning' ? '经验整理 / 复用' : i.title, phase: i.phase ?? null, area: i.area ?? null });
                return { id, officeId: i.officeId, digest: payload.digest };
            });
        });
    }
    async records(i: Row, a?: TrustedCallContext) {
        await this.room(i.officeId, a);
        const cursor=i.afterId?await this.db.get<Row>("SELECT created_at,id FROM office_collaboration_records WHERE id=? AND office_id=? AND (? IS NULL OR kind=?) AND (? IS NULL OR json_extract(payload,'$.messageId')=?)",[i.afterId,i.officeId,i.kind??null,i.kind??null,i.messageId??null,i.messageId??null]):null;
        if(i.afterId&&!cursor)throw new MindPondError('invalid_input','Record cursor scope changed or expired');
        const rows = await this.db.all<Row[]>("SELECT * FROM office_collaboration_records WHERE office_id=? AND (? IS NULL OR kind=?) AND (? IS NULL OR id=?) AND (? IS NULL OR json_extract(payload,'$.messageId')=?) AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT ?", [i.officeId, i.kind ?? null, i.kind ?? null, i.id ?? null, i.id ?? null, i.messageId ?? null, i.messageId ?? null, cursor?.created_at??-1,cursor?.created_at??-1,cursor?.id??'',(i.limit ?? 20) + 1]);
        const result = [];
        for (const r of rows.slice(0, i.limit ?? 20)) {
            const payload = JSON.parse(r.payload);
            if (r.kind === 'learning') {
                const node = await this.memory(payload.memoryId, a!);
                if (!node)
                    continue;
                payload.preview = previewText(node.content, 600);
                payload.freshness = node.updatedAt === payload.memoryRevision ? 'same_revision' : 'changed';
            }
            result.push({ ...r, payload });
        }
        return { records: result, hasMore: rows.length > (i.limit ?? 20), nextAfterId: rows[Math.min(rows.length, i.limit ?? 20) - 1]?.id ?? i.afterId ?? '' };
    }
    async handoffContext(i: Row, a?: TrustedCallContext) {
        await this.room(i.officeId, a);
        const b = a?.operator ? null : await this.identity(a);
        const messages = await this.db.all<Row[]>(`SELECT m.id,m.sender_name,m.recipient_name,s.state,substr(m.body,1,240) preview FROM role_messages m JOIN role_message_states s ON s.message_id=m.id WHERE m.office_id=? ${b ? 'AND (m.sender=? OR m.recipient=?)' : ''} ORDER BY m.seq DESC LIMIT 10`, b ? [i.officeId, b.role_id, b.role_id] : [i.officeId]);
        const materials = await this.db.all('SELECT id,label,version,sha256,bytes FROM office_materials WHERE office_id=? ORDER BY id LIMIT 20', [i.officeId]);
        return { officeId: i.officeId, messages, materials, records: await this.records({ ...i, kind: 'handoff' }, a), notice: 'Source-linked previews. Verify the repository commit and any private-memory grants before continuing.' };
    }
    async relations(i: Row, a?: TrustedCallContext) {
        await this.room(i.officeId, a);
        const b = a?.operator ? null : await this.identity(a);
        const rows = await this.db.all<Row[]>(`SELECT m.id,m.sender,m.recipient,m.sender_name,m.recipient_name,m.created_at,s.state,s.taken_at,m.reply_to FROM role_messages m JOIN role_message_states s ON s.message_id=m.id WHERE m.office_id=? AND s.state NOT IN ('resolved','accepted','archived') ${b ? 'AND (m.sender=? OR m.recipient=?)' : ''} ORDER BY m.created_at LIMIT 100`, b ? [i.officeId, b.role_id, b.role_id] : [i.officeId]);
        return { observedAt: this.clock(), waiting: rows.map(r => ({ ...r, elapsedMs: this.clock() - r.created_at, meaning: r.state === 'processing' ? 'claimed' : 'delivery_pending' })) };
    }
    async host(i: Row, a?: TrustedCallContext) {
        const b = await this.identity(a);
        if (i.action === 'status')
            return { identity: { roleId: b.role_id, bindingId: b.id }, report: await this.db.get('SELECT payload,observed_at FROM office_host_reports WHERE role_id=?', [b.role_id]), controls: await this.controls(b.role_id, a) };
        if (i.action === 'confirm')
            return this.write(async () => {
                const row = await this.db.get<Row>('SELECT * FROM office_host_reports WHERE role_id=? AND binding_id=?', [b.role_id, b.id]);
                if (!row)
                    fail('Run a probe first','invalid_input');
                const report = JSON.parse(row!.payload);
                if (report.probeId !== i.probeId)
                    fail('Probe receipt does not match the latest probe','invalid_input');
                report.clientReceived = true;
                report.clientRoundTripMs = i.clientRoundTripMs;
                report.confirmedAt = this.clock();
                await this.db.run('UPDATE office_host_reports SET payload=?,observed_at=? WHERE role_id=?', [JSON.stringify(report), this.clock(), b.role_id]);
                return report;
            });
        if (i.action === 'ack')
            return this.write(async () => {
                const request = await this.db.get<Row>('SELECT * FROM office_control_requests WHERE id=? AND role_id=?', [i.requestId, b.role_id]);
                if (!request)
                    fail('Control request unavailable','not_found');
                if (request!.state !== 'requested' && (request!.state !== i.outcome || request!.evidence !== i.evidence))
                    throw new MindPondError('idempotency_conflict', 'Control response already recorded with different evidence');
                if (request!.state === 'requested')
                    await this.db.run("UPDATE office_control_requests SET state=?,acknowledged_at=?,evidence=? WHERE id=?", [i.outcome, this.clock(), i.evidence, i.requestId]);
                if (request!.state === 'requested')
                    await this.db.run('INSERT INTO role_events(role_id,kind,body,ts) VALUES(?,?,?,?)', [b.role_id, 'control_acknowledged', JSON.stringify({ requestId: i.requestId, action: request!.action, outcome: i.outcome, evidence: i.evidence }), this.clock()]);
                return { request: await this.db.get('SELECT * FROM office_control_requests WHERE id=?', [i.requestId]), notice: 'Acknowledgement is attributed host evidence; it does not independently prove process termination.' };
            });
        const started = this.clock();
        const lease = randomUUID();
        await this.write(async () => { await this.db.run('DELETE FROM office_probe_leases WHERE expires_at<=?', [this.clock()]); if ((await this.db.get('SELECT COUNT(*) n FROM office_probe_leases')).n >= 32 || await this.db.get('SELECT 1 FROM office_probe_leases WHERE binding_id=?', [b.id]))
            throw new MindPondError('temporarily_unavailable', 'A host probe is already active or probe capacity is full', { retryable: true }); await this.db.run('INSERT INTO office_probe_leases VALUES(?,?,?)', [lease, b.id, this.clock() + (i.waitMs ?? 0) + 10000]); });
        try {
            await new Promise<void>((resolve, reject) => { const signal = i.signal as AbortSignal | undefined; const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); }, abort = () => { clearTimeout(timer); reject(new MindPondError('temporarily_unavailable', 'Probe cancelled')); }; const timer = setTimeout(done, i.waitMs ?? 0); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted)
                abort(); });
            return await this.write(async () => {
                // Recheck approval after the timed probe, including revocation during the wait.
                const current = await this.identity(a);
                if (current.id !== b.id || current.epoch !== b.epoch)
                    fail('Binding changed during probe', 'scope_denied');
                const payload = { probeId: randomUUID(), client: i.client ?? 'unspecified', reportedTimeoutMs: i.toolTimeoutMs ?? null, reportedCapabilities: i.capabilities ?? {}, measuredWaitMs: this.clock() - started, roleId: b.role_id, bindingId: b.id, authenticatedCall: true, clientVersion: i.clientVersion ?? null };
                await this.db.run('INSERT INTO office_host_reports VALUES(?,?,?,?) ON CONFLICT(role_id) DO UPDATE SET binding_id=excluded.binding_id,payload=excluded.payload,observed_at=excluded.observed_at', [b.role_id, b.id, JSON.stringify(payload), this.clock()]);
                return { ...payload, controls: await this.controls(b.role_id, a), notice: 'Client properties are self-reported. The caller must confirm receipt to prove its timeout actually allows this duration.' };
            });
        }
        finally {
            await this.write(async()=>{await this.db.run('DELETE FROM office_probe_leases WHERE id=?', [lease]);});
        }
    }
    async controls(roleId: string, a?: TrustedCallContext) {
        if (!a?.operator) {
            const b = await this.identity(a);
            if (b.role_id !== roleId)
                fail('Own role only', 'scope_denied');
        }
        else
            this.admin(a);
        return this.db.all('SELECT * FROM office_control_requests WHERE role_id=? ORDER BY requested_at DESC LIMIT 20', [roleId]);
    }
    async requestControl(i: Row, a?: TrustedCallContext) {
        this.admin(a);
        return this.write(async () => {
            if (!await this.db.get('SELECT 1 FROM character_roles WHERE id=?', [i.roleId]))
                fail('Role unavailable','not_found');
            if ((await this.db.get("SELECT COUNT(*) n FROM office_control_requests WHERE role_id=? AND state='requested'", [i.roleId])).n >= 20)
                throw new MindPondError('temporarily_unavailable', 'This role already has 20 unacknowledged requests');
            const id = randomUUID();
            await this.db.run("INSERT INTO office_control_requests VALUES(?,?,?,?,'requested',?,NULL,NULL)", [id, i.roleId, i.action, i.reason, this.clock()]);
            await this.db.run('INSERT INTO role_events(role_id,kind,body,ts) VALUES(?,?,?,?)', [i.roleId, 'user_control_requested', JSON.stringify({ requestId: id, action: i.action, reason: i.reason, requestedBy: a!.principal }), this.clock()]);
            return { id, state: 'requested', notice: 'Waiting for the host to acknowledge. This does not stop an external process by itself.' };
        });
    }
    private responseActor(a: TrustedCallContext) {
        const scope=hash({domains:[...trustedDomainSet(a).keys()].sort(),assignments:a.assignmentIds?[...a.assignmentIds].sort():null,operator:!!a.operator});
        return a.principal + ':' + (a.roleBindingId ?? a.runtimeId ?? a.agentId ?? 'local') + ':' + (a.roleBindingEpoch ?? 0)+':'+scope;
    }
    async responsePage(i: Row, a: TrustedCallContext) {
        const actor = this.responseActor(a);
        const row = await this.db.get<Row>('SELECT payload FROM office_response_pages WHERE id=? AND actor=? AND expires_at>?', [i.id, actor, this.clock()]);
        if (!row)
            fail('Response expired or unavailable','not_found');
        const offset = i.offset ?? 0, text = row!.payload;
        if (!Number.isInteger(offset) || offset < 0 || offset > text.length || (offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1])))
            throw new MindPondError('invalid_input', 'Invalid response page offset');
        let end = Math.min(offset + (i.characters ?? 1024), text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]))
            end--;
        return { id: i.id, text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null, totalCharacters: text.length, encoding: 'JSON text; concatenate all pages before parsing' };
    }
    async boundResponse(result: Row, budget: number, a: TrustedCallContext) {
        if (Buffer.byteLength(JSON.stringify(result)) <= budget)
            return result;
        return this.write(async () => {
            const actor = this.responseActor(a), id = randomUUID();
            await this.db.run('DELETE FROM office_response_pages WHERE expires_at<=?', [this.clock()]);
            if ((await this.db.get<Row>('SELECT COUNT(*) n FROM office_response_pages WHERE actor=?', [actor]))!.n >= 32)
                throw new MindPondError('temporarily_unavailable', 'Read or wait for earlier response pages to expire');
            const total = await this.db.get('SELECT COUNT(*) n,COALESCE(SUM(length(CAST(payload AS BLOB))),0) bytes FROM office_response_pages');
            if (total.n >= 512 || total.bytes + Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024)
                throw new MindPondError('temporarily_unavailable', 'Response storage is full; retry later');
            await this.db.run('INSERT INTO office_response_pages VALUES(?,?,?,?)', [id, actor, JSON.stringify(result), this.clock() + 3600000]);
            return { ...(result.isError ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify({ paged: true, id, tool: 'office_context', action: 'page', offset: 0, characters: Math.max(64, Math.floor((budget - 1200) / 12)), totalBytes: Buffer.byteLength(JSON.stringify(result)), notice: 'Complete response retained for one hour; read pages before repeating a mutation. Correlation and identity are in the retained response.' }) }] };
        });
    }
    async layout(officeId: string, a?: TrustedCallContext) {
        const room = await this.room(officeId, a);
        const seats = await this.db.all('SELECT s.id,s.label,s.role,rs.role_id roleId FROM office_seats s LEFT JOIN role_seats rs ON rs.seat_id=s.id WHERE s.office_id=? AND s.enabled=1 ORDER BY s.id', [officeId]);
        await this.db.run('INSERT OR IGNORE INTO office_layout_snapshots(office_id,revision,payload,created_at) VALUES(?,?,?,?)', [officeId, room.revision, JSON.stringify({ seats }), this.clock()]);
    }
    async captureLayout(i: Row, a?: TrustedCallContext) {
        this.admin(a);
        return this.write(async () => {
            await this.room(i.officeId, a);
            const current = await this.db.all<Row[]>('SELECT s.id,s.label,rs.role_id roleId FROM office_seats s LEFT JOIN role_seats rs ON rs.seat_id=s.id WHERE s.office_id=? AND s.enabled=1', [i.officeId]);
            if (current.length !== i.seats.length || current.some(s => !i.seats.some((p: Row) => p.id === s.id && p.roleId === s.roleId)))
                throw new MindPondError('stale_version', 'Seats changed; refresh before capturing the layout');
            const id = randomUUID(), payload = { width: i.width, height: i.height, seats: i.seats.map((s: Row) => ({ ...s, label: current.find(r => r.id === s.id)!.label })), schema: 'mindpond.layout.v1' };
            await this.db.run("INSERT INTO office_collaboration_records VALUES(?,?,?,'layout',?,?)", [id, i.officeId, 'user', JSON.stringify(payload), this.clock()]);
            await this.event(i.officeId, null, 'layout_saved', { recordId: id });
            return { id };
        });
    }
    async permissions(i: Row, a?: TrustedCallContext) {
        this.admin(a);
        const role = await this.db.get<Row>('SELECT * FROM character_roles WHERE id=?', [i.roleId]);
        if (!role)
            fail('Role unavailable','not_found');
        return { role, offices: await this.db.all('SELECT s.office_id,o.title officeTitle,s.label,s.role,s.enabled FROM office_seats s JOIN offices o ON o.id=s.office_id JOIN role_seats rs ON rs.seat_id=s.id WHERE rs.role_id=?', [i.roleId]), contacts: await this.db.all('SELECT sender,recipient FROM role_links WHERE sender=? OR recipient=?', [i.roleId, i.roleId]), host: await this.db.get("SELECT h.* FROM office_host_reports h JOIN role_bindings b ON b.id=h.binding_id AND b.state='active' WHERE h.role_id=?", [i.roleId]), controls: await this.controls(i.roleId, a), notice: 'Same-account active roles may communicate. Cross-account links are directional. Memory grants come from the connection; team writes require their own signed grant. File access is supplied by the host.' };
    }
    async impact(i: Row, a?: TrustedCallContext) {
        this.admin(a);
        const params = [i.id], counts: Row = {};
        const queries = i.kind === 'office' ? { messages: 'SELECT COUNT(*) n FROM role_messages WHERE office_id=?', materials: 'SELECT COUNT(*) n FROM office_materials WHERE office_id=?', containers: 'SELECT COUNT(*) n FROM office_containers WHERE office_id=?', events: 'SELECT COUNT(*) n FROM office_events WHERE office_id=?', seats: 'SELECT COUNT(*) n FROM office_seats WHERE office_id=?', records: 'SELECT COUNT(*) n FROM office_collaboration_records WHERE office_id=?' } : i.kind === 'role' ? { messages: 'SELECT COUNT(*) n FROM role_messages WHERE sender=? OR recipient=?', seats: 'SELECT COUNT(*) n FROM role_seats WHERE role_id=?', bindings: 'SELECT COUNT(*) n FROM role_bindings WHERE role_id=?', workingCheckpoints:'SELECT COUNT(*) n FROM role_continuity_checkpoints WHERE role_id=?', workingTasks:'SELECT COUNT(*) n FROM role_continuity_tasks WHERE role_id=?', workingHistory:'SELECT COUNT(*) n FROM role_continuity_history WHERE role_id=?' } : { roles: "SELECT COUNT(*) n FROM role_bindings WHERE connector_id=? AND state='active'", seats: 'SELECT COUNT(*) n FROM office_seats WHERE agent_id=? AND enabled=1' };
        for (const [key, sql] of Object.entries(queries))
            counts[key] = (await this.db.get<Row>(sql, sql.includes('OR recipient=') ? [i.id, i.id] : params))!.n;
        return { kind: i.kind, id: i.id, counts, retainedOfficeMemories:i.kind==='office'?(await this.db.get("SELECT COUNT(*) n FROM nodes WHERE domain_kind='personal' AND domain_id=?",['office:'+i.id])).n:0, independentMemoriesDeleted: 0, notice: 'Snapshot only. Deletion rechecks revision and dependencies in its own transaction.' };
    }
    async exportPage(i: Row, a?: TrustedCallContext) {
        this.admin(a);
        await this.room(i.officeId, a);
        const sections: Record<string, string> = {
            office: 'SELECT id,title,goal,acceptance,state,revision,deadline,max_rounds,created_at FROM offices WHERE id=?',
            seats:'SELECT s.id,s.office_id,s.agent_id,s.label,s.role,s.enabled,rs.role_id roleId,r.name FROM office_seats s LEFT JOIN role_seats rs ON rs.seat_id=s.id LEFT JOIN character_roles r ON r.id=rs.role_id WHERE s.office_id=? ORDER BY s.id',
            messages: 'SELECT m.*,s.state,s.completion,s.taken_at,s.completed_at FROM role_messages m JOIN role_message_states s ON s.message_id=m.id WHERE m.office_id=? ORDER BY m.seq',
            materials: 'SELECT m.*,c.number,c.content FROM office_materials m JOIN office_chunks c ON c.material_id=m.id WHERE m.office_id=? ORDER BY m.id,c.number',
            events: 'SELECT * FROM office_events WHERE office_id=? ORDER BY seq',
            containers: 'SELECT * FROM office_containers WHERE office_id=? ORDER BY id',
            handoffs: "SELECT * FROM office_collaboration_records WHERE office_id=? AND kind IN ('handoff','marker','presence') ORDER BY created_at,id",
            layouts: "SELECT 'logical_seats' kind,CAST(id AS TEXT) id,payload,created_at FROM office_layout_snapshots WHERE office_id=? UNION ALL SELECT 'geometry' kind,id,payload,created_at FROM office_collaboration_records WHERE office_id=? AND kind='layout' ORDER BY created_at,id"
        };
        if (!sections[i.section])
            throw new MindPondError('invalid_input', 'Unknown export section');
        return this.write(async () => {
            const now = this.clock();
            await this.db.run('DELETE FROM office_exports WHERE expires_at<=?', [now]);
            let snapshotId = i.snapshotId;
            if (!snapshotId) {
                const total = await this.db.get<Row>('SELECT COUNT(*) n,COALESCE(SUM(bytes),0) bytes FROM office_exports');
                if (total!.n >= 8 || (await this.db.get<Row>('SELECT COUNT(*) n FROM office_exports WHERE owner=?', [a!.principal]))!.n >= 2)
                    throw new MindPondError('temporarily_unavailable', 'Export snapshot capacity reached; retry after expiry');
                snapshotId = randomUUID();
                await this.db.run('INSERT INTO office_exports(id,office_id,owner,created_at,expires_at) VALUES(?,?,?,?,?)', [snapshotId, i.officeId, a!.principal, now, now + 3600000]);
                let bytes = 0;
                const digest = createHash('sha256');
                // All sections are copied in one transaction. Later mutations cannot shift pages.
                for (const [section, sql] of Object.entries(sections)) {
                    let position = 0;
                    for (;;) {
                        const rows = await this.db.all<Row[]>(sql + ' LIMIT 100 OFFSET ?', section === 'layouts' ? [i.officeId, i.officeId, position] : [i.officeId, position]);
                        for (const row of rows) {
                            const payload = JSON.stringify(row);
                            bytes += Buffer.byteLength(payload);
                            if (bytes > 64 * 1024 * 1024 || bytes + total!.bytes > 128 * 1024 * 1024)
                                throw new MindPondError('temporarily_unavailable', 'Office export exceeds snapshot storage budget');
                            digest.update(section + '\n' + payload + '\n');
                            await this.db.run('INSERT INTO office_export_rows VALUES(?,?,?,?)', [snapshotId, section, position++, payload]);
                        }
                        if (rows.length < 100)
                            break;
                    }
                }
                await this.db.run('UPDATE office_exports SET bytes=?,sha256=? WHERE id=?', [bytes, digest.digest('hex'), snapshotId]);
            }
            const snapshot = await this.db.get<Row>('SELECT * FROM office_exports WHERE id=? AND office_id=? AND owner=? AND expires_at>?', [snapshotId, i.officeId, a!.principal, now]);
            if (!snapshot)
                fail('Export snapshot expired or unavailable','not_found');
            const rows = await this.db.all<Row[]>('SELECT payload FROM office_export_rows WHERE snapshot_id=? AND section=? AND position>=? ORDER BY position LIMIT 101', [snapshotId, i.section, i.offset ?? 0]);
            return { version: 'mindpond.office-export.v2', officeId: i.officeId, snapshotId, snapshotAt: snapshot!.created_at, sha256: snapshot!.sha256, section: i.section, rows: rows.slice(0, 100).map(r => JSON.parse(r.payload)), nextOffset: rows.length > 100 ? (i.offset ?? 0) + 100 : null, scope: 'Consistent one-hour snapshot. Export every section/page; private memories and credentials are excluded.' };
        });
    }
    async operations(i: Row, a?: TrustedCallContext): Promise<Row> {
        this.admin(a);
        if (i.action === 'capacity') {
            const limits = officeWaitCapacity({ MINDPOND_OFFICE_WAIT_PER_ACCOUNT: String(i.maxPerPrincipal), MINDPOND_OFFICE_WAIT_GLOBAL: String(i.maxGlobal) });
            await this.db.run("INSERT INTO office_meta(key,value) VALUES('waitCapacity',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(limits)]);
            return { scope: 'All MCP processes on this database', ...limits };
        }
        if (i.action === 'backup') {
            const directory = path.join(path.dirname(this.databasePath), '.mindpond-backups');
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            const id = randomUUID(), filename = path.join(directory, id + '.db');
            const reservation=await fs.open(filename,'wx',0o600);await reservation.close();
            try{await this.db.run('VACUUM INTO ?', [filename]);}catch(error){await fs.rm(filename,{force:true});throw error;}
            await fs.chmod(filename, 0o600);
            const sha256 = await fileHash(filename);
            await this.db.run('INSERT INTO office_backup_records VALUES(?,?,?,?)', [id, filename, this.clock(), sha256]);
            return { id, sha256, createdAt: this.clock(), notice: 'Private consistent database snapshot. No credential files included.' };
        }
        if (i.action === 'checkBackup') {
            const r = await this.db.get<Row>('SELECT * FROM office_backup_records WHERE id=?', [i.id]);
            if (!r)
                fail('Backup unavailable','not_found');
            const db = await open({ filename: r!.filename, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
            try {
                return { id: i.id, ...await auditDatabase(db), digestMatches: await fileHash(r!.filename) === r!.sha256, restore: { command: 'mindpond-maintenance --db <this-backup-file> --restore-to <new-database-file>', backupFile: r!.filename, notice: 'Restore creates a new database; stop writers before switching services to it. Running data is never overwritten.' } };
            }
            finally {
                await db.close();
            }
        }
        if (i.action === 'retentionPreview' || i.action === 'retentionApply')
            return this.write(async () => {
                const cutoff = this.clock() - (i.days ?? 30) * 86400000;
                const queries = { messageWaits: "DELETE FROM role_message_waits WHERE state<>'waiting' AND expires_at<?", legacyWaits: "DELETE FROM office_waits WHERE state<>'waiting' AND expires_at<?", responsePages: 'DELETE FROM office_response_pages WHERE expires_at<?', hostReports: 'DELETE FROM office_host_reports WHERE observed_at<?', finishedQueue: 'DELETE FROM office_wait_queue WHERE expires_at<?', protocolTasks: 'DELETE FROM office_protocol_tasks WHERE expires_at<?', probeLeases: 'DELETE FROM office_probe_leases WHERE expires_at<?', exportSnapshots: 'DELETE FROM office_exports WHERE expires_at<?' };
                const counts: Row = {};
                for (const [key, sql] of Object.entries(queries)) {
                    counts[key] = (await this.db.get<Row>(sql.replace(/^DELETE FROM (\w+)/, 'SELECT COUNT(*) n FROM $1'), [cutoff]))!.n;
                    if (i.action === 'retentionApply')
                        await this.db.run(sql, [cutoff]);
                }
                return { counts, cutoff, applied: i.action === 'retentionApply', preserved: 'Messages, materials, memories, handoffs, evidence and audit events are retained.' };
            });
        return { version: 'mindpond.office-operations.v1', observedAt: this.clock(), integrity: await auditDatabase(this.db), capacity: JSON.parse((await this.db.get("SELECT value FROM office_meta WHERE key='waitCapacity'"))?.value ?? JSON.stringify(officeWaitCapacity())), backlog: await this.db.all('SELECT state,COUNT(*) count FROM role_message_states GROUP BY state'), waits: await this.db.all('SELECT principal,state,COUNT(*) count,MIN(expires_at) nearestExpiry FROM office_wait_queue WHERE expires_at>? GROUP BY principal,state', [this.clock()]), hosts: await this.observations(a), backups: await this.db.all('SELECT id,created_at,sha256 FROM office_backup_records ORDER BY created_at DESC LIMIT 30'), protocolTasks: 'Experimental MCP Tasks are advertised for fixed authenticated host sessions. Check the actual client negotiation. Shared harness connections use ordinary message recovery.' };
    }
    async observations(a?: TrustedCallContext) { this.admin(a); return this.db.all('SELECT role_id,binding_id,payload,observed_at FROM office_host_reports'); }
}
