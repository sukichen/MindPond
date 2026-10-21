/** Layered ownership: human, private role and shared office knowledge.
 * Storage domains are internal; existing unassigned knowledge remains human-owned. */
import type { Database } from 'sqlite';
import type { GraphMemory, MemoryNode } from './graph-memory.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {roleRuntimeId} from './roles.js';
import { MindPondError } from './errors.js';
export type MemoryOwner = {
    kind: 'user';
    id: 'default';
} | {
    kind: 'agent';
    id: string;
} | { kind:'office'; id:string };
export class MemoryOwners {
    constructor(private db: Database, private graph: GraphMemory, private write: <T>(fn: () => Promise<T>) => Promise<T>) { }
    async init() {
        await this.db.exec(`
    CREATE TABLE IF NOT EXISTS memory_office_namespaces(office_id TEXT PRIMARY KEY,domain_id TEXT NOT NULL UNIQUE,title TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_office_policy(memory_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,locked INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS role_native_memory_lookup ON role_bindings(runtime_id) WHERE state='active';
    CREATE TABLE IF NOT EXISTS memory_role_namespaces(role_id TEXT PRIMARY KEY,domain_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS memory_allocations(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,source_hash TEXT NOT NULL,role_id TEXT NOT NULL,copy_id TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(source_id,role_id));
    CREATE INDEX IF NOT EXISTS memory_allocations_copy ON memory_allocations(copy_id);
    CREATE TABLE IF NOT EXISTS memory_role_credentials(id TEXT PRIMARY KEY,role_id TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,state TEXT NOT NULL,created_at INTEGER NOT NULL);
  `);
    }
    async role(roleId: string) { const r = await this.db.get(`SELECT r.id,r.name,r.state,r.principal,b.connector_id,a.name connector_name,a.host FROM character_roles r
      LEFT JOIN role_bindings b ON b.role_id=r.id AND b.state='active' LEFT JOIN office_agents a ON a.id=b.connector_id WHERE r.id=?`, [roleId]); if (!r || r.state !== 'active')
        throw new MindPondError('scope_denied', 'The memory role is unavailable or disabled'); return r; }
    async roleBinding(roleId: string) { return this.db.get("SELECT id,epoch,runtime_id,connector_id,principal FROM role_bindings WHERE role_id=? AND state='active'", [roleId]); }
    /** Native chat identity is supplied by the host, never by tool arguments.
     * Ambiguous matches require the authenticated host-specific Memory endpoint. */
    async nativeBinding(source:string,chatId:string) {
        const hosts=await this.db.all("SELECT id,principal FROM office_agents WHERE state='active'");
        const expected=new Map(hosts.map(h=>[roleRuntimeId(h.principal,h.id,source,chatId),h]));
        const rows=await this.db.all("SELECT b.* FROM role_bindings b JOIN character_roles r ON r.id=b.role_id WHERE b.state='active' AND r.state='active' AND b.runtime_id IN (SELECT value FROM json_each(?))",[JSON.stringify([...expected.keys()])]);
        const matches=rows.filter(r=>{const h=expected.get(r.runtime_id);return h&&h.id===r.connector_id&&h.principal===r.principal;});
        if(matches.length!==1)throw new MindPondError('scope_denied',matches.length?'This chat matches multiple host connections. Use the Memory endpoint generated for the intended host.':'This chat has no active role. Approve or activate it in Office, then retry Memory. It will not write human memory.');
        return matches[0];
    }
    async office(officeId:string) {
        const r=await this.db.get('SELECT id,title,state,revision FROM offices WHERE id=?',[officeId]);
        if(!r)throw new MindPondError('not_found','Office no longer exists');return r;
    }
    async offices(roleId?:string) {
        if(!roleId)return this.db.all("SELECT o.id,o.title,o.state FROM offices o UNION ALL SELECT n.office_id id,n.title,'deleted' state FROM memory_office_namespaces n WHERE NOT EXISTS(SELECT 1 FROM offices o WHERE o.id=n.office_id) ORDER BY title,id");
        const b=await this.roleBinding(roleId);if(!b)return [];
        const seats=await this.graph.offices.authorizedSeats({v:1,principal:b.principal,agentId:b.connector_id,runtimeId:b.runtime_id,transport:'http-mcp',roleId,roleBindingId:b.id,roleBindingEpoch:b.epoch,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER});
        const ids=[...new Set(seats.map(s=>s.office_id))].sort();
        return Promise.all(ids.map(async id=>{const o=await this.office(id);return {...o,seats:seats.filter(s=>s.office_id===id).map(s=>({id:s.id,revision:s.revision})).sort((a,b)=>a.id.localeCompare(b.id))};}));
    }
    async domain(owner:MemoryOwner) {
        if(owner.kind==='user')return {kind:'personal' as const,id:'default'};
        if(owner.kind==='office'){
            const o=await this.office(owner.id);
            const existing=await this.db.get('SELECT domain_id,title FROM memory_office_namespaces WHERE office_id=?',[o.id]);
            if(existing?.title===o.title)return {kind:'personal' as const,id:existing.domain_id};
            if(!existing&&await this.db.get("SELECT 1 FROM nodes WHERE domain_kind='personal' AND domain_id=?",['office:'+o.id]))throw new MindPondError('invalid_input','The office namespace conflicts with existing unassigned knowledge; human review is required.');
            await this.db.run('INSERT INTO memory_office_namespaces VALUES(?,?,?) ON CONFLICT(office_id) DO UPDATE SET title=excluded.title',[o.id,'office:'+o.id,o.title]);
            return {kind:'personal' as const,id:'office:'+o.id};
        }
        await this.role(owner.id);await this.db.run('INSERT OR IGNORE INTO memory_role_namespaces VALUES(?,?)',[owner.id,'agent:'+owner.id]);return {kind:'personal' as const,id:'agent:'+owner.id};
    }
    async context(owner:MemoryOwner,officeId?:string) {
        if(owner.kind==='user')return officeId?{domains:[await this.domain({kind:'office',id:officeId})]}:undefined;
        if(owner.kind!=='agent')throw new MindPondError('scope_denied','Memory actor must be a human or authenticated role');
        const rooms=await this.offices(owner.id);
        if(officeId&&!rooms.some(o=>o.id===officeId))throw new MindPondError('scope_denied','Your role is not a permitted member of this office');
        const domains=officeId?[]:[await this.domain(owner)];
        for(const o of rooms.filter(o=>!officeId||o.id===officeId))domains.push(await this.domain({kind:'office',id:o.id}));
        return {domains};
    }
    async owner(node:MemoryNode):Promise<MemoryOwner> {
        if(node.domain.kind==='personal'){
            const office=await this.db.get('SELECT office_id FROM memory_office_namespaces WHERE domain_id=?',[node.domain.id]);
            if(office)return {kind:'office',id:office.office_id};
            const role=await this.db.get('SELECT role_id FROM memory_role_namespaces WHERE domain_id=?',[node.domain.id]);
            if(role)return {kind:'agent',id:role.role_id};
        }
        return {kind:'user',id:'default'};
    }
    async policy(memoryId:string){return await this.db.get('SELECT locked,revision,updated_at updatedAt FROM memory_office_policy WHERE memory_id=?',[memoryId])??{locked:0,revision:0,updatedAt:null};}
    async setPolicy(memoryId:string,locked:boolean,expectedRevision:number){return this.write(async()=>{
        const n=await this.graph.getNodeById(memoryId,{trackAccess:false});if(!n)throw new MindPondError('not_found','Memory no longer exists');
        const owner=await this.owner(n);if(owner.kind!=='office')throw new MindPondError('invalid_input','Read-only policy applies to office memories');
        const prior=await this.policy(memoryId);if(prior.revision!==expectedRevision)throw new MindPondError('stale_version','Office memory permissions changed. Reload before saving.');
        const revision=prior.revision+1,at=Date.now();
        await this.db.run('INSERT INTO memory_office_policy VALUES(?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET locked=excluded.locked,revision=excluded.revision,updated_at=excluded.updated_at',[memoryId,locked?1:0,revision,at]);
        await this.db.run('INSERT INTO memory_action_log(ts,action,node_id,reason) VALUES(?,?,?,?)',[at,'office_memory_policy',memoryId,JSON.stringify({officeId:owner.id,locked,revision})]);
        return {locked,revision,updatedAt:at};
    });}
    async assertWritable(actor:MemoryOwner,target:MemoryOwner,memoryId?:string){
        if(actor.kind==='user')return;
        if(target.kind==='agent'&&actor.kind==='agent'&&target.id===actor.id)return;
        if(target.kind!=='office'||actor.kind!=='agent')throw new MindPondError('scope_denied','Cannot modify another owner’s knowledge');
        const room=(await this.offices(actor.id)).find(o=>o.id===target.id);
        if(!room||room.state!=='active')throw new MindPondError('scope_denied','Your role must be a current member of an active office to modify its memory');
        if(memoryId&&(await this.policy(memoryId)).locked)throw new MindPondError('scope_denied','This office memory is read-only for roles. Ask the human administrator to revise or unlock it.');
    }
    async present(node:MemoryNode) {
        const {embedding,domain,sessionId,...rest}=node,owner=await this.owner(node);
        const provenance=await this.db.get('SELECT source_id sourceId,source_revision sourceRevision,source_hash sourceHash,created_at assignedAt FROM memory_allocations WHERE copy_id=?',[node.id]);
        return {...rest,owner,...(owner.kind==='office'?{officePolicy:await this.policy(node.id)}:{}),...(provenance?{provenance}:{})};
    }
    async roles() { return this.db.all(`SELECT r.id,r.name,r.state,b.connector_id connectorId,a.name connectorName,a.host,a.state hostState,
      EXISTS(SELECT 1 FROM memory_role_credentials c WHERE c.role_id=r.id AND c.state='active') hasMemoryCredential
      FROM character_roles r LEFT JOIN role_bindings b ON b.role_id=r.id AND b.state='active'
      LEFT JOIN office_agents a ON a.id=b.connector_id ORDER BY r.name,r.id`); }
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
                const saved = await this.graph.saveMemory(n.content, { domain, dimensions: n.dimensions, importance: n.importance, tags: n.tags, source: 'external', anchors: (n.anchors ?? []).filter(a => a.status === 'active' && n.content.includes(a.basis)).slice(0, 6).map(a => ({ text: a.text, basis: a.basis, spaceId: 'memory', memoryType: (n.dimensions ?? [n.dimension]).includes(a.memoryType) ? a.memoryType : n.dimension })), memberships: (n.dimensions ?? [n.dimension]).filter(d => d !== 'event').map(memoryType => ({ spaceId: 'memory', memoryType })), sourceRefs, idempotencyKey: 'allocation:' + roleId + ':' + id + ':after:' + (old?.copy_id ?? 'initial') },{
                    authorize:async()=>{await this.role(roleId);},
                    saved:async copyId=>{await this.db.run('INSERT OR REPLACE INTO memory_allocations VALUES(?,?,?,?,?,?,?)',[randomUUID(),id,n.updatedAt,digest,roleId,copyId,Date.now()]);}
                });
                copies.push({ sourceId: id, copyId: saved.id, sourceRevision: n.updatedAt });
            }
            return { roleId, copies, independentCopies: true };
        })();
    }
    async issue(roleId: string, allowRotation=false) { return this.write(async () => { const role=await this.role(roleId); if(!role.connector_id||!await this.graph.offices.agentAuthority({v:1,principal:role.principal,agentId:role.connector_id,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER}))throw new MindPondError('invalid_input','请先在办公室将角色连接到可用聊天，再生成专用配置。'); if(!allowRotation&&await this.db.get("SELECT 1 FROM memory_role_credentials WHERE role_id=? AND state='active'",[roleId]))throw new MindPondError('stale_version','该角色已有专用连接配置。请明确确认替换；替换后当前配置立即失效。'); await this.db.run("UPDATE memory_role_credentials SET state='revoked' WHERE role_id=?", [roleId]); const token = 'mpr_' + randomBytes(32).toString('base64url'), id = randomUUID(); await this.db.run("INSERT INTO memory_role_credentials VALUES(?,?,?,'active',?)", [id, roleId, createHash('sha256').update(token).digest('hex'), Date.now()]); return { id, roleId, token, connection:{connectorId:role.connector_id,name:role.connector_name,host:role.host}, notice: 'Store in the host secret configuration, never in chat. Rotation revokes the previous role memory credential.' }; }); }
    async credential(token: string) { const r = await this.db.get("SELECT id,role_id FROM memory_role_credentials WHERE token_hash=? AND state='active'", [createHash('sha256').update(token).digest('hex')]); if (!r)
        return null; try {
        const role=await this.role(r.role_id);
        if(!role.connector_id||!await this.graph.offices.agentAuthority({v:1,principal:role.principal,agentId:role.connector_id,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER}))return null;
        return r;
    }
    catch {
        return null;
    } }
}
