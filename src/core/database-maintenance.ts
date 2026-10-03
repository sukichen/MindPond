import type { Database } from 'sqlite';
import { randomUUID } from 'node:crypto';

/** Operator-only integrity maintenance. Never infers semantic relations. */
export async function auditDatabase(db:Database) {
  const integrity=await db.all('PRAGMA quick_check');
  const foreignKeys=await db.all('PRAGMA foreign_key_check');
  const dangling=await db.all<Array<{id:string;superseded_by:string;domain_kind:string;domain_id:string}>>(`SELECT id,superseded_by,domain_kind,domain_id FROM nodes
    WHERE superseded_by IS NOT NULL AND NOT EXISTS(SELECT 1 FROM nodes replacement WHERE replacement.id=nodes.superseded_by)`);
  const foreignAssociations=await db.all<Array<{id:string}>>(`SELECT a.id FROM memory_associations a
    JOIN memory_memberships ma ON ma.id=a.member_a_id JOIN nodes na ON na.id=ma.memory_id
    JOIN memory_memberships mb ON mb.id=a.member_b_id JOIN nodes nb ON nb.id=mb.memory_id
    WHERE na.domain_kind!=nb.domain_kind OR na.domain_id!=nb.domain_id`);
  const healthy=integrity.length===1&&Object.values(integrity[0])[0]==='ok'&&foreignKeys.length===0&&foreignAssociations.length===0;
  return {healthy,integrity,foreignKeys,dangling,foreignAssociations};
}

/** Caller must make a consistent backup and own an exclusive transaction.
 * Missing replacements remain excluded; no old fact is silently resurrected.
 * A self supersession is an explicit administrative quarantine marker, not a
 * replacement fact. The original missing target remains in the repair record. */
export async function quarantineDatabaseIssues(db:Database) {
  const audit=await auditDatabase(db);
  if(audit.integrity.length!==1 || Object.values(audit.integrity[0])[0]!=='ok')throw new Error('Database corruption requires recovery, not semantic repair');
  if(audit.foreignKeys.some(row=>row.table!=='nodes' || row.parent!=='nodes'))throw new Error('Unsupported foreign-key violation; no changes applied');
  const repairId=randomUUID(),at=Date.now();
  await db.exec(`CREATE TABLE IF NOT EXISTS memory_repair_quarantine(
    repair_id TEXT NOT NULL,kind TEXT NOT NULL,object_id TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,
    PRIMARY KEY(kind,object_id));`);
  for(const issue of audit.dangling) {
    const members=await db.all('SELECT * FROM memory_memberships WHERE memory_id=?',[issue.id]);
    await db.run('INSERT OR IGNORE INTO memory_repair_quarantine VALUES (?,?,?,?,?)',[repairId,'missing_replacement',issue.id,JSON.stringify({node:issue,members}),at]);
    await db.run('UPDATE memory_memberships SET active=0,version=version+1,updated_at=? WHERE memory_id=? AND active=1',[at,issue.id]);
    await db.run('UPDATE nodes SET superseded_by=id,updated_at=? WHERE id=?',[at,issue.id]);
    await db.run('INSERT INTO memory_action_log(ts,action,node_id,domain_kind,domain_id,reason) VALUES (?,?,?,?,?,?)',
      [at,'memory_repair_quarantined',issue.id,issue.domain_kind,issue.domain_id,JSON.stringify({repairId,reason:'missing_replacement',previousTarget:issue.superseded_by,requiresSemanticReview:true})]);
  }
  for(const issue of audit.foreignAssociations) {
    const association=await db.get('SELECT * FROM memory_associations WHERE id=?',[issue.id]);
    const evidence=await db.all('SELECT * FROM association_evidence WHERE association_id=?',[issue.id]);
    const legacy=issue.id.startsWith('legacy-assoc:')?await db.get('SELECT * FROM edges WHERE id=?',[issue.id.slice(13)]):undefined;
    await db.run('INSERT OR IGNORE INTO memory_repair_quarantine VALUES (?,?,?,?,?)',[repairId,'cross_domain_association',issue.id,JSON.stringify({association,evidence,legacy}),at]);
    await db.run('DELETE FROM association_evidence WHERE association_id=?',[issue.id]);
    await db.run('DELETE FROM memory_associations WHERE id=?',[issue.id]);
    if(legacy)await db.run('DELETE FROM edges WHERE id=?',[legacy.id]);
    await db.run('INSERT INTO memory_action_log(ts,action,edge_id,reason) VALUES (?,?,?,?)',[at,'association_quarantined',issue.id,JSON.stringify({repairId,reason:'cross_domain_association'})]);
  }
  if(audit.dangling.length||audit.foreignAssociations.length)await db.run("UPDATE memory_meta SET value=CAST(value AS INTEGER)+1 WHERE key='index_generation'");
  const after=await auditDatabase(db);
  if(!after.healthy)throw new Error('Integrity repair incomplete; transaction must roll back');
  return {repairId,quarantinedMemories:audit.dangling.length,quarantinedAssociations:audit.foreignAssociations.length,healthy:after.healthy};
}
