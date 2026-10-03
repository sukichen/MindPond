import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { GraphMemory } from '../src/core/graph-memory.js';
import { auditDatabase,quarantineDatabaseIssues } from '../src/core/database-maintenance.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-repair-'));
const filename=path.join(dir,'memory.db');
process.env.EMBEDDING_MODEL_DIR=path.join(dir,'missing');
process.env.EMBEDDING_ZH_ENABLED='false';
const graph=new GraphMemory('.', {dbPath:filename});
let db:Awaited<ReturnType<typeof open>>|undefined;
try {
  await graph.init();
  const a=await graph.createNode({dimension:'fact',content:'Archived fixture claim, not known to be true',embedding:[1,...Array(383).fill(0)]});
  const b=await graph.createNode({dimension:'fact',content:'Other owner fixture claim',domain:{kind:'personal',id:'other'},embedding:[1,...Array(383).fill(0)]});
  const ma=(await graph.getMemberships(a.id))[0],mb=(await graph.getMemberships(b.id))[0];
  await graph.close();
  db=await open({filename,driver:sqlite3.Database});
  await db.exec('PRAGMA foreign_keys=OFF');
  await db.run('UPDATE nodes SET superseded_by=? WHERE id=?',['missing-target',a.id]);
  await db.run('INSERT INTO memory_associations(id,space_id,memory_type,member_a_id,member_b_id,weight,created_at,updated_at) VALUES (?,?,?,?,?,.9,1,1)',['invalid',ma.spaceId,ma.memoryType,...[ma.id,mb.id].sort()]);
  const before=await auditDatabase(db);assert(!before.healthy);assert.equal(before.dangling.length,1);assert.equal(before.foreignAssociations.length,1);
  const backup=path.join(dir,'backup.db');await db.run('VACUUM INTO ?',[backup]);
  await db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  const result=await quarantineDatabaseIssues(db);await db.exec('COMMIT');
  assert.equal(result.quarantinedMemories,1);assert.equal(result.quarantinedAssociations,1);assert((await auditDatabase(db)).healthy);
  assert.equal((await db.get('SELECT superseded_by FROM nodes WHERE id=?',[a.id])).superseded_by,a.id);
  assert.equal((await db.get('SELECT active FROM memory_memberships WHERE id=?',[ma.id])).active,0);
  assert.equal((await db.get('SELECT COUNT(*) n FROM nodes')).n,2,'No fabricated memory, no removed original');
  const q=await db.get("SELECT payload FROM memory_repair_quarantine WHERE kind='missing_replacement'");assert.equal(JSON.parse(q.payload).node.superseded_by,'missing-target');
  await db.exec('BEGIN IMMEDIATE');const retry=await quarantineDatabaseIssues(db);await db.exec('COMMIT');assert.equal(retry.quarantinedMemories+retry.quarantinedAssociations,0);
  const restored=await open({filename:backup,driver:sqlite3.Database});
  try {const original=await auditDatabase(restored);assert.equal(original.dangling[0].superseded_by,'missing-target');assert.equal(original.foreignAssociations.length,1);}finally{await restored.close();}
  console.log('PASS integrity quarantine: original facts/evidence retained, no resurrection, valid FKs, idempotence and consistent backup restore');
}finally{await graph.close();await db?.close();await fs.rm(dir,{recursive:true,force:true});}
