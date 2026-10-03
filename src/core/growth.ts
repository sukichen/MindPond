/** Generic source evidence and non-destructive profile support. No model or host filesystem access. */
import type { Database } from 'sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { domainKey } from './domain.js';
import type { MemoryDomainRef } from './domain.js';
import { MindPondError } from './errors.js';

export interface SourceReference {
  uri: string;
  context: string;
  revision: string;
  fingerprint?: string;
  locator?: string;
}
export interface ProfileSpec {
  title: string;
  coverage: string[];
  unknowns: string[];
}
export interface SynthesizeOperation {
  dimensions?: import('./knowledge.js').KnowledgeDimension[];
  anchors?: import('./anchors.js').MemoryAnchor[];
  kind: 'synthesize';
  membershipIds: string[];
  targetMembershipId?: string;
  content: string;
  profile: ProfileSpec;
  reason: string;
  supports: Array<{ membershipId: string; claim: string; context: string }>;
  importance?: number;
  tags?: string[];
}
export type Freshness = 'checked' | 'needs_review' | 'unknown';
export interface SourceObservation {
  uri: string; context: string; revision: string; fingerprint?: string;
  status: 'present' | 'missing'; expectedVersion: number;
}
export interface CheckpointInput {
  hostId: string; runId: string; checkpointId: string;
  domain?: MemoryDomainRef;
  spaceId: string; memoryType: string;
  outcome: 'saved' | 'no_change' | 'deferred'; reason: string;
  memoryIds?: string[];
  requestOrganization?: boolean;
}
export const textField = (value: unknown, name: string, max = 2000): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} requires 1–${max} characters`);
  return value.trim();
};
export function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([,v]) => v !== undefined)
    .sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k)+':'+stableJSON(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export const digest = (value: unknown) => createHash('sha256').update(stableJSON(value)).digest('hex');
export function normalizeSources(input: unknown): SourceReference[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 64) throw new Error('sourceRefs must contain at most 64 references');
  const result = input.map(r => ({
    uri: textField(r?.uri, 'source uri'), context: textField(r?.context, 'source context', 256),
    revision: textField(r?.revision, 'source revision', 256),
    ...(r?.fingerprint !== undefined ? {fingerprint: textField(r.fingerprint,'fingerprint',256)} : {}),
    ...(r?.locator !== undefined ? {locator: textField(r.locator,'locator')} : {}),
  }));
  // Exact duplicates normalize away (R01: repeated delivery must converge);
  // the same locator with a different revision/fingerprint is a conflict (T03),
  // never a silent overwrite of the recorded source identity.
  const byLocator = new Map<string, SourceReference>();
  for (const [index, ref] of result.entries()) {
    const locator = stableJSON([ref.uri, ref.context, ref.locator]);
    const prior = byLocator.get(locator);
    if (!prior) { byLocator.set(locator, ref); continue; }
    if (stableJSON(prior) === stableJSON(ref)) continue;
    throw new MindPondError('source_revision_conflict',
      `sourceRefs[${index}] reuses ${ref.uri} (context=${ref.context}${ref.locator ? `, locator=${ref.locator}` : ''}) with a different revision/fingerprint`,
      { field: `sourceRefs[${index}]`, retryable: false,
        nextAction: '同一 locator 只能携带一个版本：去除重复项，或作为显式修订提交并说明来源变更' });
  }
  return [...byLocator.values()];
}

export class GrowthStore {
  /** R02: every time-sensitive path reads the injected clock so fault tests
   *  (lease expiry, budgets) run on a controlled timeline. */
  constructor(readonly db: Database, private readonly clock: () => number = Date.now) {}
  async init() {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_sources (memory_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_observations (uri TEXT NOT NULL, context TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(uri,context));
      CREATE TABLE IF NOT EXISTS profile_records (membership_id TEXT PRIMARY KEY REFERENCES memory_memberships(id) ON DELETE CASCADE, revision INTEGER NOT NULL, body_version INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS profile_supports (profile_id TEXT NOT NULL REFERENCES profile_records(membership_id) ON DELETE CASCADE, source_id TEXT NOT NULL, source_version INTEGER NOT NULL, claim TEXT NOT NULL, context TEXT NOT NULL, PRIMARY KEY(profile_id,source_id));
      CREATE INDEX IF NOT EXISTS profile_support_source ON profile_supports(source_id);
      CREATE TABLE IF NOT EXISTS profile_revisions (profile_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(profile_id,revision));
      CREATE TABLE IF NOT EXISTS memory_receipts (key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_checkpoints (key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_work (id TEXT PRIMARY KEY, domain_kind TEXT NOT NULL DEFAULT 'personal', domain_id TEXT NOT NULL DEFAULT 'default', space_id TEXT NOT NULL, memory_type TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, lease_until INTEGER, lease_token TEXT, payload TEXT NOT NULL, receipt TEXT);
      CREATE INDEX IF NOT EXISTS host_work_queue ON host_work(domain_kind,domain_id,space_id,memory_type,status,available_at);
      INSERT OR IGNORE INTO memory_meta(key,value) VALUES ('growth_revision','0');
      CREATE TRIGGER IF NOT EXISTS growth_member_changed AFTER UPDATE OF version,active ON memory_memberships
      WHEN OLD.version != NEW.version OR OLD.active != NEW.active
      BEGIN
        UPDATE memory_meta SET value=CAST(value AS INTEGER)+1 WHERE key='growth_revision';
        INSERT INTO memory_action_log(ts,action,node_id,reason)
        SELECT NEW.updated_at,'profile_needs_review',m.memory_id,json_object('changedMembershipId',NEW.id,'profileMembershipId',m.id)
        FROM memory_memberships m WHERE m.id IN (
          WITH RECURSIVE affected(id) AS (SELECT profile_id FROM profile_supports WHERE source_id=NEW.id UNION SELECT s.profile_id FROM profile_supports s JOIN affected a ON s.source_id=a.id) SELECT id FROM affected
        );
      END;
      CREATE TRIGGER IF NOT EXISTS growth_member_deleted BEFORE DELETE ON memory_memberships
      BEGIN
        UPDATE memory_meta SET value=CAST(value AS INTEGER)+1 WHERE key='growth_revision';
        INSERT INTO memory_action_log(ts,action,node_id,reason)
        SELECT CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),'profile_needs_review',m.memory_id,json_object('deletedMembershipId',OLD.id,'profileMembershipId',m.id)
        FROM memory_memberships m WHERE m.id IN (
          WITH RECURSIVE affected(id) AS (SELECT profile_id FROM profile_supports WHERE source_id=OLD.id UNION SELECT s.profile_id FROM profile_supports s JOIN affected a ON s.source_id=a.id) SELECT id FROM affected
        );
      END;
    `);
    const cols=await this.db.all<any>('PRAGMA table_info(host_work)');const names=new Set(cols.map((c:any)=>c.name));
    if(!names.has('domain_kind'))await this.db.exec("ALTER TABLE host_work ADD COLUMN domain_kind TEXT NOT NULL DEFAULT 'personal'");
    if(!names.has('domain_id'))await this.db.exec("ALTER TABLE host_work ADD COLUMN domain_id TEXT NOT NULL DEFAULT 'default'");
    if(!names.has('payload_hash'))await this.db.exec('ALTER TABLE host_work ADD COLUMN payload_hash TEXT');
  }
  async audit(action: string, payload: unknown, nodeId?: string) {
    await this.db.run('INSERT INTO memory_action_log(ts,action,node_id,reason) VALUES (?,?,?,?)', [this.clock(),action,nodeId ?? null,stableJSON(payload)]);
  }
  async bump() { await this.db.run("UPDATE memory_meta SET value=CAST(value AS INTEGER)+1 WHERE key='growth_revision'"); }
  async revision(): Promise<number> { return Number((await this.db.get("SELECT value FROM memory_meta WHERE key='growth_revision'"))?.value ?? 0); }
  async sources(memoryId: string): Promise<SourceReference[]> {
    const row=await this.db.get('SELECT payload FROM memory_sources WHERE memory_id=?',[memoryId]);
    return row ? JSON.parse(row.payload) : [];
  }
  async metadataMany(memoryIds:string[]) {
    const ids=[...new Set(memoryIds)];
    const result=new Map<string,{sourceRefs:SourceReference[];profiles:Array<{membershipId:string;revision:number;title:string;coverage:string[];unknowns:string[]}>}>();
    for(const id of ids)result.set(id,{sourceRefs:[],profiles:[]});
    if(!ids.length)return result;
    const marks=ids.map(()=>'?').join(',');
    const sourceRows=await this.db.all(`SELECT memory_id,payload FROM memory_sources WHERE memory_id IN (${marks})`,ids);
    const profileRows=await this.db.all(`SELECT m.memory_id,p.membership_id,p.revision,p.payload FROM profile_records p JOIN memory_memberships m ON m.id=p.membership_id WHERE m.active=1 AND m.memory_id IN (${marks})`,ids);
    for(const r of sourceRows)result.get(r.memory_id)!.sourceRefs=JSON.parse(r.payload);
    for(const r of profileRows)result.get(r.memory_id)!.profiles.push({membershipId:r.membership_id,revision:r.revision,...JSON.parse(r.payload)});
    return result;
  }
  async metadata(memoryId: string) {return (await this.metadataMany([memoryId])).get(memoryId)!;}
  /** Bounded transitive traversal with UNION: a diamond is visited once, regardless of path count. */
  async closure(memberId: string): Promise<string[]> {
    const rows=await this.db.all(`WITH RECURSIVE deps(id) AS (SELECT ? UNION SELECT s.source_id FROM profile_supports s JOIN deps d ON s.profile_id=d.id) SELECT id FROM deps LIMIT 1001`,[memberId]);
    return rows.map(r=>r.id);
  }
  async ancestors(memberIds: string[]): Promise<string[]> {
    if (!memberIds.length) return [];
    const rows=await this.db.all(`WITH RECURSIVE affected(id) AS (SELECT id FROM memory_memberships WHERE id IN (${memberIds.map(()=>'?').join(',')}) UNION SELECT p.profile_id FROM profile_supports p JOIN affected a ON p.source_id=a.id) SELECT DISTINCT id FROM affected WHERE id IN (SELECT membership_id FROM profile_records)`,memberIds);
    return rows.map(r=>r.id);
  }
  async freshness(memberId: string, context?: string): Promise<{status:Freshness; reasons:string[]}> {
    const ids=await this.closure(memberId), reasons:string[]=[];
    let unknown=ids.length>1000, stale=false, hasEvidence=false;
    if(unknown) reasons.push('dependency_budget_exceeded');
    const marks=ids.map(()=>'?').join(',');
    const members=await this.db.all(`SELECT m.id,m.active,m.version,m.memory_id,n.superseded_by,p.body_version FROM memory_memberships m JOIN nodes n ON n.id=m.memory_id LEFT JOIN profile_records p ON p.membership_id=m.id WHERE m.id IN (${marks})`,ids);
    const map=new Map(members.map(m=>[m.id,m]));
    for(const id of ids) {
      const m=map.get(id);
      if(!m || !m.active || m.superseded_by) {stale=true;reasons.push('missing_or_inactive:'+id);continue;}
      if(m.body_version!==null && m.body_version!==undefined && m.body_version!==m.version) {stale=true;reasons.push('profile_body_edited:'+id);}
    }
    const edges=await this.db.all(`SELECT * FROM profile_supports WHERE profile_id IN (${marks})`,ids);
    for(const e of edges) if(map.get(e.source_id)?.version!==e.source_version) {stale=true;reasons.push('support_changed:'+e.source_id);}
    const memoryIds=[...new Set(members.map(m=>m.memory_id))];
    if(memoryIds.length) {
      const src=await this.db.all(`SELECT payload FROM memory_sources WHERE memory_id IN (${memoryIds.map(()=>'?').join(',')})`,memoryIds);
      const refs=src.flatMap(r=>JSON.parse(r.payload) as SourceReference[]);
      const observations=refs.length ? await this.db.all(`SELECT DISTINCT o.uri,o.context,o.payload FROM memory_sources ms, json_each(ms.payload) ref JOIN source_observations o ON o.uri=json_extract(ref.value,'$.uri') AND o.context=COALESCE(?,json_extract(ref.value,'$.context')) WHERE ms.memory_id IN (${memoryIds.map(()=>'?').join(',')})`,[context ?? null,...memoryIds]) : [];
      const observed=new Map(observations.map(o=>[stableJSON([o.uri,o.context]),JSON.parse(o.payload)]));
      // A source-free leaf is unknown, even if another branch of the profile has checked sources.
      const sourceMemories=new Set(await this.db.all(`SELECT memory_id FROM memory_sources WHERE memory_id IN (${memoryIds.map(()=>'?').join(',')})`,memoryIds).then(rs=>rs.map(r=>r.memory_id)));
      for(const m of members) if(!edges.some(e=>e.profile_id===m.id) && !sourceMemories.has(m.memory_id)) unknown=true;
      for(const ref of refs) {
        hasEvidence=true;
        const o=observed.get(stableJSON([ref.uri,context ?? ref.context]));
        if(!o) {unknown=true;reasons.push('source_unchecked:'+ref.uri);continue;}
        const same=ref.fingerprint && o.fingerprint ? ref.fingerprint===o.fingerprint : ref.revision===o.revision;
        if(o.status==='missing' || !same) {stale=true;reasons.push('source_changed:'+ref.uri);}
      }
    }
    return {status:stale?'needs_review':unknown||!hasEvidence?'unknown':'checked',reasons:[...new Set(reasons)].slice(0,64)};
  }
  async profileGet(memberId: string, opts:{offset?:number;limit?:number;sourceContext?:string}={}) {
    const p=await this.db.get('SELECT p.*,m.memory_id,m.space_id,m.memory_type,m.active,n.content FROM profile_records p JOIN memory_memberships m ON m.id=p.membership_id JOIN nodes n ON n.id=m.memory_id WHERE p.membership_id=?',[memberId]);
    if(!p || !p.active) throw new Error('Active profile not found');
    const offset=opts.offset ?? 0,limit=opts.limit ?? 20;
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100) throw new Error('Invalid profile pagination');
    const rows=await this.db.all('SELECT s.*,m.memory_id,m.active,m.version,n.content FROM profile_supports s LEFT JOIN memory_memberships m ON m.id=s.source_id LEFT JOIN nodes n ON n.id=m.memory_id WHERE s.profile_id=? ORDER BY s.source_id LIMIT ? OFFSET ?',[memberId,limit+1,offset]);
    const parents=await this.db.all('SELECT s.profile_id FROM profile_supports s JOIN memory_memberships m ON m.id=s.profile_id WHERE s.source_id=? AND m.active=1 ORDER BY s.profile_id LIMIT 101',[memberId]);
    return {membershipId:memberId,memoryId:p.memory_id,spaceId:p.space_id,memoryType:p.memory_type,revision:p.revision,profile:JSON.parse(p.payload),content:p.content,
      freshness:await this.freshness(memberId,opts.sourceContext),
      supports:rows.slice(0,limit).map(r=>({membershipId:r.source_id,memoryId:r.memory_id ?? null,sourceVersion:r.source_version,currentVersion:r.version ?? null,active:!!r.active,claim:r.claim,context:r.context,content:r.content ?? null})),
      nextOffset:rows.length>limit?offset+limit:null,parents:parents.slice(0,100).map(r=>r.profile_id),parentsTruncated:parents.length>100};
  }
  async validateSynthesis(op:SynthesizeOperation, byId:Map<string,any>) {
    textField(op.content,'profile content',100000);textField(op.reason,'synthesis reason');
    textField(op.profile?.title,'profile title',256);
    for(const field of ['coverage','unknowns'] as const) if(!Array.isArray(op.profile?.[field])||op.profile[field].length>64||op.profile[field].some(v=>typeof v!=='string'||!v.trim()||v.length>2000)) throw new Error(`profile.${field} must contain up to 64 meaningful strings`);
    if(!op.profile.coverage.length) throw new Error('Profile must state its actual coverage');
    if(op.membershipIds.length<2) throw new Error('synthesize requires at least two distinct sources');
    if(!Array.isArray(op.supports)||op.supports.length!==op.membershipIds.length||new Set(op.supports.map(s=>s.membershipId)).size!==op.supports.length||op.supports.some(s=>!op.membershipIds.includes(s.membershipId))) throw new Error('Each source requires one support claim and context');
    for(const s of op.supports) {textField(s.claim,'support claim');textField(s.context,'support context');}
    // Visibility boundary = ownership domain (M02): material in the same
    // personal/team domain may synthesize across source sessions — sessionId
    // is source metadata, not a scope.  Different domains never merge.
    if(new Set(op.membershipIds.map(id=>domainKey(byId.get(id)?.memory.domain ?? {kind:'personal',id:'default'}))).size!==1) throw new Error('Cannot synthesize across memory domains');
    if(op.targetMembershipId) {
      const target=byId.get(op.targetMembershipId);
      if(!target || op.membershipIds.includes(op.targetMembershipId)) throw new Error('Profile target must be a separate issued member');
      if(domainKey(target.memory.domain)!==domainKey(byId.get(op.membershipIds[0]).memory.domain)) throw new Error('Profile target domain mismatch');
      if(!await this.db.get('SELECT 1 FROM profile_records WHERE membership_id=?',[op.targetMembershipId])) throw new Error('Target is not a profile');
      const placements=await this.db.get('SELECT COUNT(*) AS n FROM memory_memberships WHERE memory_id=? AND active=1',[target.memory.id]);
      if(placements.n!==1) throw new Error('Shared profile body: create a separate scoped profile instead of rewriting other spaces');
      for(const id of op.membershipIds) {
        const descendants=await this.closure(id);
        if(descendants.length>1000) throw new Error('dependency_budget_exceeded');
        if(descendants.includes(op.targetMembershipId)) throw new Error('Profile support cycle');
      }
    }
  }
  async recordProfile(memberId:string,op:SynthesizeOperation,byId:Map<string,any>) {
    const m=await this.db.get('SELECT version,memory_id FROM memory_memberships WHERE id=?',[memberId]);
    const old=await this.db.get('SELECT revision FROM profile_records WHERE membership_id=?',[memberId]);
    const revision=(old?.revision ?? 0)+1;
    await this.db.run('INSERT INTO profile_records(membership_id,revision,body_version,payload) VALUES (?,?,?,?) ON CONFLICT(membership_id) DO UPDATE SET revision=excluded.revision,body_version=excluded.body_version,payload=excluded.payload',[memberId,revision,m.version,stableJSON(op.profile)]);
    await this.db.run('DELETE FROM profile_supports WHERE profile_id=?',[memberId]);
    for(const s of op.supports) await this.db.run('INSERT INTO profile_supports(profile_id,source_id,source_version,claim,context) VALUES (?,?,?,?,?)',[memberId,s.membershipId,byId.get(s.membershipId).membership.version,s.claim.trim(),s.context.trim()]);
    await this.db.run('INSERT INTO profile_revisions(profile_id,revision,payload) VALUES (?,?,?)',[memberId,revision,stableJSON({at:Date.now(),...op,sourceVersions:op.membershipIds.map(id=>({membershipId:id,version:byId.get(id).membership.version}))})]);
    await this.audit('profile_revised',{membershipId:memberId,revision,reason:op.reason},m.memory_id);
    await this.bump();
  }
  async observe(input:SourceObservation) {
    const ref=normalizeSources([input])[0];
    if(!['present','missing'].includes(input.status)||!Number.isInteger(input.expectedVersion)||input.expectedVersion<0) throw new Error('status and expectedVersion required');
    const old=await this.db.get('SELECT * FROM source_observations WHERE uri=? AND context=?',[ref.uri,ref.context]);
    const payload={...ref,status:input.status};
    // Identical retry returns the existing version, never overwrites a newer observation.
    if(old && old.payload===stableJSON(payload)) return {version:old.version,changed:false,affectedProfileIds:[]};
    if((old?.version ?? 0)!==input.expectedVersion) throw new Error('stale_observation: reload current source observation');
    const version=input.expectedVersion+1;
    await this.db.run('INSERT INTO source_observations(uri,context,version,payload) VALUES (?,?,?,?) ON CONFLICT(uri,context) DO UPDATE SET version=excluded.version,payload=excluded.payload',[ref.uri,ref.context,version,stableJSON(payload)]);
    const rows=await this.db.all('SELECT s.memory_id,s.payload,m.id FROM memory_sources s JOIN memory_memberships m ON m.memory_id=s.memory_id WHERE m.active=1');
    const direct=rows.filter(r=>(JSON.parse(r.payload) as SourceReference[]).some(s=>s.uri===ref.uri && s.context===ref.context)).map(r=>r.id);
    const affectedProfileIds=await this.ancestors(direct);
    await this.audit('source_observed',{...payload,version,affectedProfileIds});
    await this.bump();
    return {version,changed:true,affectedProfileIds};
  }
  async checkpoint(input:CheckpointInput) {
    for(const k of ['hostId','runId','checkpointId','spaceId','memoryType'] as const) textField(input[k],k,256);
    textField(input.reason,'reason');
    if(!['saved','no_change','deferred'].includes(input.outcome)) throw new Error('Invalid checkpoint outcome');
    if(input.requestOrganization!==undefined && typeof input.requestOrganization!=='boolean') throw new Error('requestOrganization must be boolean');
    const domain=input.domain ?? {kind:'personal' as const,id:'default'};
    if(!['session','personal','team'].includes(domain.kind)||typeof domain.id!=='string'||!domain.id.trim())throw new Error('Invalid checkpoint domain');
    const memoryIds=input.memoryIds ?? [];
    if(!Array.isArray(memoryIds)||memoryIds.length>64||memoryIds.some(id=>typeof id!=='string')) throw new Error('memoryIds must contain at most 64 IDs');
    if(input.outcome==='saved'&&!memoryIds.length) throw new Error('saved checkpoint requires memoryIds');
    // R01: hash the normalized logical payload, not raw input — default domains,
    // padded text or reordered memoryIds stay one and the same logical request.
    const normalized={hostId:input.hostId.trim(),runId:input.runId.trim(),checkpointId:input.checkpointId.trim(),domain,
      spaceId:input.spaceId.trim(),memoryType:input.memoryType.trim(),outcome:input.outcome,reason:input.reason.trim(),
      memoryIds:[...new Set(memoryIds)].sort(),requestOrganization:input.requestOrganization ?? input.outcome!=='no_change'};
    const hash=digest(normalized),legacyHash=digest(input);
    // Idempotency keys are scoped by domain (T02): two identities reusing the
    // same checkpointId never read each other's receipts.
    const key=stableJSON([normalized.hostId,domainKey(domain),normalized.runId,normalized.checkpointId]);
    const legacyKey=stableJSON([input.hostId,input.runId,input.checkpointId]);
    const conflict=new MindPondError('idempotency_conflict','checkpoint reuse with a different logical payload',
      {retryable:false,nextAction:'先按原 checkpointId 查回执；修改内容必须使用新的 checkpointId 并说明差异'});
    const previous=await this.db.get('SELECT * FROM host_checkpoints WHERE key=?',[key]);
    if(previous) {
      if(previous.request_hash!==hash) {
        if(previous.request_hash!==legacyHash)throw conflict;
        await this.db.run('UPDATE host_checkpoints SET request_hash=? WHERE key=?',[hash,key]);
      }
      return JSON.parse(previous.payload);
    }
    // Pre-upgrade rows live under the unscoped [hostId,runId,checkpointId] key.
    const legacyRow=await this.db.get('SELECT * FROM host_checkpoints WHERE key=?',[legacyKey]);
    if(legacyRow) {
      if(legacyRow.request_hash===hash||legacyRow.request_hash===legacyHash) {
        await this.db.run('INSERT OR REPLACE INTO host_checkpoints(key,request_hash,payload) VALUES (?,?,?)',[key,hash,legacyRow.payload]);
        return JSON.parse(legacyRow.payload);
      }
      // Different payload under the pre-upgrade key: treat as an independent
      // request only when the recorded work belongs to another domain (T02 —
      // never cross receipts within one identity scope).
      const priorPayload=JSON.parse(legacyRow.payload) as {workId?:string|null};
      const priorWork=priorPayload?.workId?await this.db.get('SELECT domain_kind,domain_id FROM host_work WHERE id=?',[priorPayload.workId]):undefined;
      if(!priorWork||(priorWork.domain_kind===domain.kind&&priorWork.domain_id===domain.id))throw conflict;
    }
    for(const id of memoryIds) if(!await this.db.get('SELECT 1 FROM memory_memberships m JOIN nodes n ON n.id=m.memory_id WHERE m.memory_id=? AND m.active=1 AND m.space_id=? AND m.memory_type=? AND n.domain_kind=? AND n.domain_id=?',[id,input.spaceId,input.memoryType,domain.kind,domain.id])) throw new Error('Checkpoint memory outside active domain scope');
    const need=input.requestOrganization ?? input.outcome!=='no_change';
    let workId:string|null=null;
    if(need) {
      // Logical work dedup (T01/T04): repeated or re-keyed deliveries of the
      // same payload converge on the existing non-terminal/failed row instead
      // of growing the queue or bypassing the retry cap with fresh keys.
      const workHash=digest({domain:domainKey(domain),spaceId:normalized.spaceId,memoryType:normalized.memoryType,outcome:normalized.outcome,memoryIds:normalized.memoryIds,requestOrganization:need});
      const existing=await this.db.get("SELECT id,status FROM host_work WHERE domain_kind=? AND domain_id=? AND space_id=? AND memory_type=? AND payload_hash=? AND status IN ('pending','leased','failed') ORDER BY available_at,id LIMIT 1",[domain.kind,domain.id,normalized.spaceId,normalized.memoryType,workHash]);
      if(existing) {
        workId=existing.id;
        await this.audit('host_work_deduplicated',{workId,status:existing.status,checkpointId:normalized.checkpointId});
      } else {
        workId=randomUUID();
        await this.db.run("INSERT INTO host_work(id,domain_kind,domain_id,space_id,memory_type,status,available_at,payload,payload_hash) VALUES (?,?,?,?,?,'pending',?,?,?)",[workId,domain.kind,domain.id,normalized.spaceId,normalized.memoryType,this.clock(),stableJSON({...input,domain}),workHash]);
      }
    }
    const receipt={checkpointId:input.checkpointId,outcome:input.outcome,workId};
    await this.db.run('INSERT INTO host_checkpoints(key,request_hash,payload) VALUES (?,?,?)',[key,hash,stableJSON(receipt)]);
    await this.audit('host_checkpoint',{...input,...receipt});
    return receipt;
  }
  async workClaim(spaceId:string,memoryType:string,domain:MemoryDomainRef={kind:'personal',id:'default'}) {
    textField(spaceId,'spaceId',128);textField(memoryType,'memoryType',128);
    const now=this.clock();
    const exhausted=await this.db.all("SELECT id FROM host_work WHERE domain_kind=? AND domain_id=? AND space_id=? AND memory_type=? AND status='leased' AND lease_until<? AND attempts>=5",[domain.kind,domain.id,spaceId,memoryType,now]);
    for(const item of exhausted){await this.db.run("UPDATE host_work SET status='failed' WHERE id=?",[item.id]);await this.audit('host_work_failed',{workId:item.id,reason:'lease_retry_limit'});}
    const row=await this.db.get("SELECT * FROM host_work WHERE domain_kind=? AND domain_id=? AND space_id=? AND memory_type=? AND ((status='pending' AND available_at<=?) OR (status='leased' AND lease_until<?)) AND NOT EXISTS (SELECT 1 FROM memory_domains d WHERE d.kind='session' AND d.kind=host_work.domain_kind AND d.id=host_work.domain_id AND d.status='closed') AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.session_id=host_work.domain_id AND host_work.domain_kind='session') ORDER BY available_at,id LIMIT 1",[domain.kind,domain.id,spaceId,memoryType,now,now]);
    if(!row)return null;
    const leaseToken=randomUUID(),leaseUntil=now+300000;
    // R02: the claim write re-checks availability in the UPDATE itself, so a
    // racing executor in another process cannot double-claim the same row.
    const claim=await this.db.run("UPDATE host_work SET status='leased',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=? AND ((status='pending' AND available_at<=?) OR (status='leased' AND lease_until<?))",[leaseToken,leaseUntil,row.id,now,now]);
    if(!claim.changes)return null;
    await this.audit('host_work_claimed',{workId:row.id,attempt:row.attempts+1});
    return {id:row.id,leaseToken,leaseUntil,attempts:row.attempts+1,checkpoint:JSON.parse(row.payload)};
  }
  async workRenew(workId:string,leaseToken:string) {
    const now=this.clock();
    // Renewal extends only the lease window — attempts and any execution
    // budget the driver tracks are never touched here (R02).
    const result=await this.db.run("UPDATE host_work SET lease_until=? WHERE id=? AND status='leased' AND lease_token=? AND lease_until>=?",[now+300000,workId,leaseToken,now]);
    if(!result.changes)throw new Error('stale_work_lease: renewal refused because the lease expired or was superseded');
    await this.audit('host_work_renewed',{workId});return {leaseUntil:now+300000};
  }
  async workRetry(workId:string,reason:string) {
    textField(reason,'retry reason');
    const result=await this.db.run("UPDATE host_work SET status='pending',attempts=0,available_at=?,lease_token=NULL,lease_until=NULL,receipt=NULL WHERE id=? AND status='failed'",[this.clock(),workId]);
    if(!result.changes)throw new Error('Only failed work may be explicitly retried');
    await this.audit('host_work_retried',{workId,reason});return {status:'pending'};
  }
  async workCancel(workId:string,reason:string) {
    textField(reason,'cancel reason');
    const row=await this.db.get('SELECT * FROM host_work WHERE id=?',[workId]);
    if(!row)throw new Error(`host work ${workId} not found`);
    // Terminal rows keep their receipts: cancelling never revokes results that
    // were already committed (T08).
    if(['completed','failed','cancelled'].includes(row.status))
      return {status:row.status,...(row.receipt?{receipt:JSON.parse(row.receipt)}:{})};
    const cancelled=await this.db.run("UPDATE host_work SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE id=? AND status IN ('pending','leased')",[workId]);
    if(!cancelled.changes){
      const latest=await this.db.get('SELECT status,receipt FROM host_work WHERE id=?',[workId]);
      return {status:latest?.status??'unknown',...(latest?.receipt?{receipt:JSON.parse(latest.receipt)}:{})};
    }
    await this.audit('host_work_cancelled',{workId,reason});
    return {status:'cancelled'};
  }
  async workFinish(input:{workId:string;leaseToken:string;outcome:'completed'|'no_change'|'deferred'|'failed';reason:string;organizationJobId?:string}) {
    textField(input.reason,'reason');
    if(!['completed','no_change','deferred','failed'].includes(input.outcome))throw new Error('Invalid work outcome');
    const row=await this.db.get('SELECT * FROM host_work WHERE id=?',[input.workId]);
    // Identical replay (response lost after the commit landed) returns the
    // original result instead of re-executing (T07).
    if(row?.receipt===stableJSON(input) && row.lease_token===input.leaseToken)return {status:row.status};
    const now=this.clock();
    // A late executor (expired lease, new claimant's token, cancelled or
    // finished row) can never write (T06/T09).
    if(!row||row.status!=='leased'||row.lease_token!==input.leaseToken||row.lease_until<now)
      throw new Error('stale_work_lease: lease expired, superseded or cancelled; the late result is discarded');
    if(input.outcome==='completed') {
      const job=await this.db.get("SELECT * FROM organization_jobs WHERE id=? AND status='completed'",[input.organizationJobId ?? '']);
      if(!job||job.domain_kind!==row.domain_kind||job.domain_id!==row.domain_id||job.space_id!==row.space_id||job.memory_type!==row.memory_type)throw new Error('completed work requires a completed organization job in its domain scope');
    }
    const status=input.outcome==='deferred'?(row.attempts>=5?'failed':'pending'):input.outcome==='failed'?'failed':'completed';
    // Conditional write: the arbiter for finish/cancel races and cross-process
    // double submission — exactly one executor's outcome lands (T08).
    const written=await this.db.run("UPDATE host_work SET status=?,available_at=?,receipt=? WHERE id=? AND status='leased' AND lease_token=? AND lease_until>=?",[status,now+60000,stableJSON(input),input.workId,input.leaseToken,now]);
    if(!written.changes)throw new Error('stale_work_lease: work changed concurrently; the submission is rejected');
    const {leaseToken: _leaseToken, ...auditInput}=input;
    await this.audit('host_work_finished',{...auditInput,status});
    return {status};
  }
}
