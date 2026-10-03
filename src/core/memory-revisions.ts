import type { Database } from 'sqlite';
import { randomUUID } from 'node:crypto';
import { digest, stableJSON } from './growth.js';
import { MindPondError } from './errors.js';

/** Human edits are revisions, not database rollback points. Deleted nodes
 * cascade their history too; this store never resurrects purged material. */
export class MemoryRevisions {
  constructor(private db:Database) {}
  async init() {
    await this.db.exec(`CREATE TABLE IF NOT EXISTS memory_edit_revisions (
      id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, before_snapshot TEXT NOT NULL, after_snapshot TEXT NOT NULL,
      after_fingerprint TEXT NOT NULL, reason TEXT NOT NULL, restores_revision_id TEXT);
      CREATE INDEX IF NOT EXISTS memory_edit_history ON memory_edit_revisions(memory_id,created_at DESC);`);
  }
  async snapshot(id:string) {
    const node=await this.db.get<any>(`SELECT content,importance,tags,verified,dimension,dimensions,primary_dimension,layer,domain_kind,domain_id,session_id,superseded_by,updated_at FROM nodes WHERE id=?`,[id]);
    if(!node)throw new MindPondError('invalid_input','Memory not found');
    const memberships=await this.db.all<any[]>('SELECT id,space_id,memory_type,active,version FROM memory_memberships WHERE memory_id=? ORDER BY id',[id]);
    const sources=JSON.parse((await this.db.get<any>('SELECT payload FROM memory_sources WHERE memory_id=?',[id]))?.payload??'[]');
    const anchors=(await this.db.all<any[]>('SELECT id,text,basis,space_id,memory_type,content_hash,status,embedding,embedding_model,zh_embedding,zh_model FROM memory_anchors WHERE memory_id=? ORDER BY id',[id])).map(a=>({
      id:a.id,text:a.text,basis:a.basis,space_id:a.space_id,memory_type:a.memory_type,content_hash:a.content_hash,status:a.status,
      embedding:a.embedding?Buffer.from(a.embedding).toString('base64'):null,embeddingModel:a.embedding_model,
      zhEmbedding:a.zh_embedding?Buffer.from(a.zh_embedding).toString('base64'):null,zhModel:a.zh_model}));
    return {node,memberships,sources,anchors};
  }
  /** Include topology/evidence revisions; equal body text alone is not a
   * sufficient concurrency token after membership or relationship changes. */
  async fingerprint(id:string,legacy=false) {
    const associations=await this.db.all<any[]>(`SELECT a.* FROM memory_associations a WHERE
      a.member_a_id IN (SELECT id FROM memory_memberships WHERE memory_id=?) OR
      a.member_b_id IN (SELECT id FROM memory_memberships WHERE memory_id=?) ORDER BY a.id`,[id,id]);
    const evidence=await this.db.all<any[]>(`SELECT e.* FROM association_evidence e JOIN memory_associations a ON a.id=e.association_id WHERE
      a.member_a_id IN (SELECT id FROM memory_memberships WHERE memory_id=?) OR
      a.member_b_id IN (SELECT id FROM memory_memberships WHERE memory_id=?) ORDER BY e.id`,[id,id]);
    const edges=await this.db.all<any[]>('SELECT * FROM edges WHERE from_id=? OR to_id=? ORDER BY id',[id,id]);
    const snapshot=await this.snapshot(id);
    if(legacy)delete snapshot.node.primary_dimension;
    const semantic={...snapshot,anchors:snapshot.anchors.map(({embedding,embeddingModel,zhEmbedding,zhModel,...a})=>a)};
    return digest(stableJSON({snapshot:semantic,associations,evidence,edges}));
  }
  async record(id:string,before:Awaited<ReturnType<MemoryRevisions['snapshot']>>,reason:string,restoresRevisionId?:string) {
    const revisionId=randomUUID(),after=await this.snapshot(id);
    await this.db.run('INSERT INTO memory_edit_revisions(id,memory_id,created_at,before_snapshot,after_snapshot,after_fingerprint,reason,restores_revision_id) VALUES (?,?,?,?,?,?,?,?)',
      [revisionId,id,after.node.updated_at,stableJSON(before),stableJSON(after),await this.fingerprint(id),reason,restoresRevisionId??null]);
    return revisionId;
  }
  async get(id:string,revisionId:string) {
    const row=await this.db.get<any>('SELECT * FROM memory_edit_revisions WHERE id=? AND memory_id=?',[revisionId,id]);
    if(!row)throw new MindPondError('invalid_input','Revision not found for this memory');
    return {...row,before:JSON.parse(row.before_snapshot),after:JSON.parse(row.after_snapshot)};
  }
  async assertRestorable(id:string,revisionId:string) {
    const row=await this.get(id,revisionId);
    if(await this.fingerprint(id,!Object.prototype.hasOwnProperty.call(row.after.node,'primary_dimension'))!==row.after_fingerprint)throw new MindPondError('stale_version','Memory, memberships or relationships changed after this edit; compare history and create a new edit instead');
    const profile=await this.db.get<any>(`SELECT 1 FROM memory_memberships m WHERE m.memory_id=? AND
      (EXISTS(SELECT 1 FROM profile_records p WHERE p.membership_id=m.id) OR EXISTS(SELECT 1 FROM profile_supports s WHERE s.source_id=m.id)) LIMIT 1`,[id]);
    if(profile)throw new MindPondError('stale_version','Memory is a profile or supports one; revise through organization with its evidence instead of undoing in place');
    return row;
  }
  async history(id:string,limit=50) {
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new MindPondError('invalid_input','history limit must be 1–100');
    const rows=await this.db.all<any[]>('SELECT * FROM memory_edit_revisions WHERE memory_id=? ORDER BY created_at DESC,id DESC LIMIT ?',[id,limit]);
    const visible=(raw:string)=>{const value=JSON.parse(raw);return {...value,anchors:value.anchors.map(({embedding,embeddingModel,zhEmbedding,zhModel,...a}:any)=>a)};};
    return rows.map(r=>({id:r.id,at:r.created_at,reason:r.reason,restoresRevisionId:r.restores_revision_id??undefined,
      before:visible(r.before_snapshot),after:visible(r.after_snapshot)}));
  }
  /** Called only inside the same write transaction as the version recheck.
   * Increment versions; keep new placements inactive rather than erasing them. */
  async restoreDetails(id:string,before:Awaited<ReturnType<MemoryRevisions['snapshot']>>,now:number) {
    const dimensions=JSON.parse(before.node.dimensions??'[]');
    const primary=Object.prototype.hasOwnProperty.call(before.node,'primary_dimension') ? before.node.primary_dimension
      : dimensions.includes(before.node.dimension)?before.node.dimension:dimensions[0]??before.node.dimension;
    await this.db.run('UPDATE nodes SET dimension=?,dimensions=?,primary_dimension=? WHERE id=?',[before.node.dimension,before.node.dimensions,primary,id]);
    const active=new Map(before.memberships.map(m=>[m.id,m.active]));
    for(const m of await this.db.all<any[]>('SELECT id,active FROM memory_memberships WHERE memory_id=?',[id])) {
      const wanted=active.get(m.id)??0;
      if(m.active!==wanted)await this.db.run('UPDATE memory_memberships SET active=?,version=version+1,last_reviewed_at=NULL,updated_at=? WHERE id=?',[wanted,now,m.id]);
    }
    await this.db.run('DELETE FROM memory_sources WHERE memory_id=?',[id]);
    if(before.sources.length)await this.db.run('INSERT INTO memory_sources(memory_id,payload) VALUES (?,?)',[id,stableJSON(before.sources)]);
    await this.db.run('DELETE FROM memory_anchors WHERE memory_id=?',[id]);
    for(const a of before.anchors)await this.db.run(`INSERT INTO memory_anchors(id,memory_id,text,basis,space_id,memory_type,content_hash,status,embedding,embedding_model,zh_embedding,zh_model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [a.id,id,a.text,a.basis,a.space_id,a.memory_type,a.content_hash,a.status,
       a.embedding?Buffer.from(a.embedding,'base64'):null,a.embeddingModel??null,
       a.zhEmbedding?Buffer.from(a.zhEmbedding,'base64'):null,a.zhModel??null]);
  }
}
