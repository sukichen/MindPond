import {OFFICE_WAIT_MS, officeWaitResult, officeWaitSchema, validateWaitFilters} from './office-wait-policy.js';
/** Experimental MCP 2025-11-25 Tasks, for a fixed authenticated host session.
 * Polling evaluates durable message conditions; no detached model or hidden worker.
 * A process restart preserves handles, while binding epochs and grants fence reads. */
import type { Database } from 'sqlite';
import type { TaskStore, CreateTaskOptions } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import type { Request, RequestId, Task, Result } from '@modelcontextprotocol/sdk/types.js';
import type { GraphMemory } from './graph-memory.js';
import type { TrustedCallContext } from './trust.js';
import { randomUUID } from 'node:crypto';
import { MindPondError } from './errors.js';
export class OfficeTaskStore implements TaskStore {
    constructor(private db: Database, private graph: GraphMemory, private write: <T>(f: () => Promise<T>) => Promise<T>, private actor: TrustedCallContext) { }
    private async owner() { const b = await this.graph.roles.binding(this.actor); return this.actor.principal + ':' + b!.id + ':' + b!.epoch; }
    private project(row: any): Task { return { taskId: row.id, status: row.state, statusMessage: row.message ?? undefined, createdAt: new Date(row.created_at).toISOString(), lastUpdatedAt: new Date(row.updated_at).toISOString(), ttl: row.expires_at - row.created_at, pollInterval: 1000 }; }
    async createTask(options: CreateTaskOptions, _requestId: RequestId, request: Request) {
        if (request.params?.name !== 'office_wait_task')
            throw new Error('Only office_wait_task supports tasks');
        const args = officeWaitSchema.parse(request.params.arguments ?? {});
        validateWaitFilters(args);
        const waitMs = args.waitMs ?? OFFICE_WAIT_MS;
        return this.write(async () => {
            const owner = await this.owner();
            if (args.replyTo)
                await this.graph.building.message({ action: 'get', messageId: args.replyTo }, this.actor);
            const id = randomUUID(), now = Date.now(), ttl = Math.min(3600000, Math.max(waitMs + 60000, options.ttl ?? 3600000));
            await this.db.run('DELETE FROM office_protocol_tasks WHERE expires_at<=?', [now]);
            if ((await this.db.get("SELECT COUNT(*) n FROM office_protocol_tasks WHERE owner=? AND state='working'", [owner])).n >= 8 || (await this.db.get('SELECT COUNT(*) n FROM office_protocol_tasks')).n >= 1024)
                throw new MindPondError('temporarily_unavailable', 'Task capacity reached', { retryable: true });
            await this.db.run("INSERT INTO office_protocol_tasks VALUES(?,?,'working',?,?,?, ?,NULL,NULL)", [id, owner, JSON.stringify({ ...args, afterSeq: args.afterSeq ?? 0, waitMs }), now, now, now + ttl]);
            return this.project(await this.db.get('SELECT * FROM office_protocol_tasks WHERE id=?', [id]));
        });
    }
    async getTask(id: string) {
        return this.write(async () => {
            const owner = await this.owner();
            const row = await this.db.get('SELECT * FROM office_protocol_tasks WHERE id=? AND owner=? AND expires_at>?', [id, owner, Date.now()]);
            if (!row)
                return null;
            if (row.state === 'working') {
                const condition=JSON.parse(row.conditions),ready=await this.graph.building.pollWait(condition,this.actor),elapsed=Date.now()-row.created_at;
                if (ready || elapsed>=condition.waitMs) {
                    const payload=officeWaitResult(ready??{status:'timeout',nextCursor:condition.afterSeq},condition,elapsed);
                    await this.db.run("UPDATE office_protocol_tasks SET state='completed',result=?,updated_at=? WHERE id=? AND state='working'", [JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }] }), Date.now(), id]);
                    return this.project(await this.db.get('SELECT * FROM office_protocol_tasks WHERE id=?', [id]));
                }
            }
            return this.project(row);
        });
    }
    async storeTaskResult(id: string, status: 'completed' | 'failed', result: Result) {
        await this.write(async () => {
            const owner = await this.owner();
            await this.db.run("UPDATE office_protocol_tasks SET state=?,result=?,updated_at=? WHERE id=? AND owner=? AND expires_at>? AND state='working'",
                [status, JSON.stringify(result), Date.now(), id, owner, Date.now()]);
        });
    }
    async getTaskResult(id: string): Promise<Result> {
        return this.write(async () => {
            const task = await this.getTask(id);
            if (!task) throw new Error('Task unavailable');
            const row = await this.db.get('SELECT result FROM office_protocol_tasks WHERE id=?', [id]);
            if (!row?.result) throw new Error('Task is not complete');
            return JSON.parse(row.result);
        });
    }
    async updateTaskStatus(id: string, status: Task['status'], message?: string) {
        await this.write(async () => {
            const owner = await this.owner(), now = Date.now();
            const result = await this.db.run("UPDATE office_protocol_tasks SET state=?,message=?,updated_at=? WHERE id=? AND owner=? AND expires_at>? AND state='working'",
                [status, message ?? null, now, id, owner, now]);
            if (!result.changes && !await this.db.get('SELECT 1 FROM office_protocol_tasks WHERE id=? AND owner=? AND expires_at>?',[id,owner,now]))
                throw new Error('Task unavailable');
        });
    }
    async listTasks(cursor?: string) { const owner = await this.owner(), rows = await this.db.all('SELECT * FROM office_protocol_tasks WHERE owner=? AND id>? AND expires_at>? ORDER BY id LIMIT 51', [owner, cursor ?? '', Date.now()]); const tasks = []; for (const row of rows.slice(0, 50)) {
        const task = await this.getTask(row.id);
        if (task)
            tasks.push(task);
    } return { tasks, ...(rows.length > 50 ? { nextCursor: rows[49].id } : {}) }; }
}
