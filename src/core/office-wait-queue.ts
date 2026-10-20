/** SQLite admission shared by all MCP processes using this database.
 * FIFO within an account, least-recently-admitted account first across accounts.
 * No database transaction remains open during the wait. */
import type { Database } from 'sqlite';
import { randomUUID } from 'node:crypto';
import { MindPondError } from './errors.js';
import { officeWaitCapacity } from './office-wait-policy.js';
export class OfficeWaitQueue {
    private stopping = new AbortController();
    constructor(private db: Database, private write: <T>(f: () => Promise<T>) => Promise<T>, private clock = Date.now) { }
    close() { this.stopping.abort(); }
    async run<T>(principal: string, bindingId: string, waitMs: number, signal: AbortSignal | undefined, authorize: () => Promise<void>, work: (remaining: number) => Promise<T>, timeout: () => T, ready?: () => Promise<T | undefined>): Promise<T> {
        if (signal?.aborted || this.stopping.signal.aborted)
            throw new MindPondError('temporarily_unavailable', 'Waiting cancelled', { retryable: true });
        await authorize();
        const immediate = await ready?.();
        if (immediate !== undefined)
            return immediate;
        const id = randomUUID(), deadline = this.clock() + waitMs;
        const defaults = officeWaitCapacity();
        const limits = await this.write(async () => { await this.db.run("INSERT OR IGNORE INTO office_meta(key,value) VALUES('waitCapacity',?)", [JSON.stringify(defaults)]); return JSON.parse((await this.db.get("SELECT value FROM office_meta WHERE key='waitCapacity'")).value) as typeof defaults; });
        const abort = AbortSignal.any([this.stopping.signal, ...(signal ? [signal] : [])]);
        await this.write(async () => {
            await this.db.run('DELETE FROM office_wait_queue WHERE expires_at<=?', [this.clock()]);
            if ((await this.db.get('SELECT COUNT(*) n FROM office_wait_queue')).n >= Math.min(8192, limits.maxGlobal * 8))
                throw new MindPondError('temporarily_unavailable', 'Wait queue is full', { retryable: true, retryAfterMs: 1000 });
            await this.db.run("INSERT INTO office_wait_queue VALUES(?,?,?,'queued',?,?)", [id, principal, bindingId, this.clock(), deadline + 10000]);
        });
        try {
            while (!abort.aborted && this.clock() < deadline) {
                await authorize();
                const arrived = await ready?.();
                if (arrived !== undefined)
                    return arrived;
                const admitted = await this.write(async () => {
                    const now = this.clock();
                    await this.db.run('DELETE FROM office_wait_queue WHERE expires_at<=?', [now]);
                    Object.assign(limits, JSON.parse((await this.db.get("SELECT value FROM office_meta WHERE key='waitCapacity'")).value));
                    if ((await this.db.get("SELECT COUNT(*) n FROM office_wait_queue WHERE state='running'")).n >= limits.maxGlobal)
                        return false;
                    const next = await this.db.get(`SELECT q.id FROM office_wait_queue q LEFT JOIN office_wait_turns t ON t.principal=q.principal
            WHERE q.state='queued' AND q.expires_at-10000>?
            AND (SELECT COUNT(*) FROM office_wait_queue r WHERE r.principal=q.principal AND r.state='running')<?
            ORDER BY COALESCE(t.admitted_at,0),q.created_at,q.rowid LIMIT 1`, [now, limits.maxPerPrincipal]);
                    if (next?.id !== id)
                        return false;
                    await this.db.run("UPDATE office_wait_queue SET state='running' WHERE id=?", [id]);
                    await this.db.run('INSERT INTO office_wait_turns VALUES(?,?) ON CONFLICT(principal) DO UPDATE SET admitted_at=excluded.admitted_at', [principal, now]);
                    return true;
                });
                if (admitted)
                    return await work(Math.max(100, deadline - this.clock()));
                await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); abort.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, 500); abort.addEventListener('abort', done, { once: true }); if (abort.aborted)
                    done(); });
            }
            if (abort.aborted)
                throw new MindPondError('temporarily_unavailable', 'Waiting cancelled', { retryable: true });
            return timeout();
        }
        finally {
            await this.write(async () => { await this.db.run('DELETE FROM office_wait_queue WHERE id=?', [id]); });
        }
    }
}
