/** Public ownership is human user or an approved office role. Existing domains
 * remain a storage detail; old memories remain human-owned without destructive migration. */
import type { Database } from 'sqlite';
import type { GraphMemory, MemoryNode } from './graph-memory.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { MindPondError } from './errors.js';
export type MemoryOwner = {
    kind: 'user';
    id: 'default';
} | {
    kind: 'agent';
    id: string;
};
export class MemoryOwners {
    constructor(private db: Database, private graph: GraphMemory, private write: <T>(fn: () => Promise<T>) => Promise<T>) { }
    async init() {
        await this.db.exec(`
    CREATE TABLE IF NOT EXISTS memory_role_namespaces(role_id TEXT PRIMARY KEY,domain_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS memory_allocations(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,source_hash TEXT NOT NULL,role_id TEXT NOT NULL,copy_id TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(source_id,role_id));
    CREATE INDEX IF NOT EXISTS memory_allocations_copy ON memory_allocations(copy_id);
    CREATE TABLE IF NOT EXISTS memory_role_credentials(id TEXT PRIMARY KEY,role_id TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,state TEXT NOT NULL,created_at INTEGER NOT NULL);
  `);
    }
    async role(roleId: string) { const r = await this.db.get("SELECT id,name,state,principal,connector_id FROM character_roles WHERE id=?", [roleId]); if (!r || r.state !== 'active')
        throw new MindPondError('scope_denied', 'The memory role is unavailable or disabled'); return r; }
    async roleBinding(roleId: string) { return this.db.get("SELECT id,epoch,runtime_id FROM role_bindings WHERE role_id=? AND state='active' ORDER BY last_seen DESC,id LIMIT 1", [roleId]); }
    async domain(owner: MemoryOwner) { if (owner.kind === 'user')
        return { kind: 'personal' as const, id: 'default' }; await this.role(owner.id); await this.db.run('INSERT OR IGNORE INTO memory_role_namespaces VALUES(?,?)', [owner.id, 'agent:' + owner.id]); return { kind: 'personal' as const, id: 'agent:' + owner.id }; }
    async owner(node: MemoryNode): Promise<MemoryOwner> { const r = await this.db.get('SELECT role_id FROM memory_role_namespaces WHERE domain_id=?', [node.domain.id]); return node.domain.kind === 'personal' && r ? { kind: 'agent', id: r.role_id } : { kind: 'user', id: 'default' }; }
    async present(node: MemoryNode) { const { embedding, domain, sessionId, ...rest } = node; const provenance=await this.db.get('SELECT source_id sourceId,source_revision sourceRevision,source_hash sourceHash,created_at assignedAt FROM memory_allocations WHERE copy_id=?',[node.id]); return { ...rest, owner: await this.owner(node),...(provenance?{provenance}: {}) }; }
    async roles() { return this.db.all("SELECT id,name,state FROM character_roles ORDER BY name,id"); }
    async allocate(memoryIds: string[], roleId: string) {
        const sources = new Map<string, MemoryNode>();
        for (const id of [...new Set(memoryIds)]) {
            const n = await this.graph.getNodeById(id, { trackAccess: false });
            if (!n)
                throw new MindPondError('not_found', 'Selected memory no longer exists');
            if (n.dimension === 'event')
                throw new MindPondError('invalid_input', 'Assign knowledge memories; summarize raw conversation evidence first');
            sources.set(id, n);
        }
        return (async () => {
            const domain = await this.domain({ kind: 'agent', id: roleId }), copies = [];
            for (const id of [...new Set(memoryIds)]) {
                const n = sources.get(id)!;
                if ((await this.owner(n)).kind === 'agent' && (await this.owner(n)).id === roleId) {
                    copies.push({ sourceId: id, copyId: id, existing: true });
                    continue;
                }
                const old = await this.db.get('SELECT * FROM memory_allocations WHERE source_id=? AND role_id=?', [id, roleId]);
                if (old && await this.graph.getNodeById(old.copy_id, { trackAccess: false })) {
                    copies.push({ sourceId: id, copyId: old.copy_id, sourceRevision: old.source_revision, existing: true });
                    continue;
                }
                const digest = createHash('sha256').update(n.content).digest('hex');
                const originalRefs=n.sourceRefs??[];
                const sourceRefs=originalRefs.length<64?[...originalRefs,{uri:'mindpond:memory/'+id,revision:String(n.updatedAt),fingerprint:'sha256:'+digest,context:'Human-assigned independent copy; later edits do not modify the source.'}]:originalRefs;
                const saved = await this.graph.saveMemory(n.content, { domain, dimensions: n.dimensions, importance: n.importance, tags: n.tags, source: 'external', anchors: (n.anchors ?? []).filter(a => a.status === 'active' && n.content.includes(a.basis)).slice(0, 6).map(a => ({ text: a.text, basis: a.basis, spaceId: 'memory', memoryType: (n.dimensions ?? [n.dimension]).includes(a.memoryType) ? a.memoryType : n.dimension })), memberships: (n.dimensions ?? [n.dimension]).filter(d => d !== 'event').map(memoryType => ({ spaceId: 'memory', memoryType })), sourceRefs, idempotencyKey: 'allocation:' + roleId + ':' + id + ':after:' + (old?.copy_id ?? 'initial') });
                await this.write(async () => { await this.db.run('INSERT OR REPLACE INTO memory_allocations VALUES(?,?,?,?,?,?,?)', [randomUUID(), id, n.updatedAt, digest, roleId, saved.id, Date.now()]); });
                copies.push({ sourceId: id, copyId: saved.id, sourceRevision: n.updatedAt });
            }
            return { roleId, copies, independentCopies: true };
        })();
    }
    async issue(roleId: string) { return this.write(async () => { await this.role(roleId); await this.db.run("UPDATE memory_role_credentials SET state='revoked' WHERE role_id=?", [roleId]); const token = 'mpr_' + randomBytes(32).toString('base64url'), id = randomUUID(); await this.db.run("INSERT INTO memory_role_credentials VALUES(?,?,?,'active',?)", [id, roleId, createHash('sha256').update(token).digest('hex'), Date.now()]); return { id, roleId, token, notice: 'Store in the host secret configuration, never in chat. Rotation revokes the previous role memory credential.' }; }); }
    async credential(token: string) { const r = await this.db.get("SELECT id,role_id FROM memory_role_credentials WHERE token_hash=? AND state='active'", [createHash('sha256').update(token).digest('hex')]); if (!r)
        return null; try {
        await this.role(r.role_id);
        return r;
    }
    catch {
        return null;
    } }
}
