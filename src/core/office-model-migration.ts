/** One-time data migration. Request handling uses only the role-based model. */
import {randomUUID} from 'node:crypto';
import type {Database} from 'sqlite';
export async function migrateOfficeRoleModel(db:Database,now:number){
  if(await db.get("SELECT 1 FROM office_meta WHERE key='role-model.v1'"))return;
  const seats=await db.all(`SELECT s.*,a.principal,a.name agent_name,a.state agent_state FROM office_seats s
    JOIN office_agents a ON a.id=s.agent_id LEFT JOIN role_seats rs ON rs.seat_id=s.id
    WHERE rs.role_id IS NULL ORDER BY a.id,s.id`);
  for(const seat of seats){
    const name=(seat.label?.trim()||seat.agent_name).slice(0,120);
    const role={id:randomUUID(),name};
    await db.run('INSERT INTO character_roles(id,principal,name,introduction,state,revision,primary_seat,created_at) VALUES(?,?,?,?,?,1,?,?)',[role.id,seat.principal,name,seat.role||'办公室参与者',seat.agent_state==='active'?'active':'disabled',seat.id,now]);
    const sessions='SELECT id FROM office_sessions WHERE seat_id=?';
    await db.run(`UPDATE office_items SET status='open',revision=revision+1,epoch=epoch+1,lease_hash=NULL,lease_until=NULL,session_id=NULL WHERE status='claimed' AND session_id IN (${sessions})`,[seat.id]);
    await db.run(`UPDATE office_sessions SET state='closed' WHERE id IN (${sessions})`,[seat.id]);
    await db.run('INSERT INTO role_seats VALUES(?,?)',[seat.id,role.id]);
    await db.run('INSERT INTO role_events(role_id,kind,body,ts) VALUES(?,?,?,?)',[role.id,'role_migrated',JSON.stringify({seatId:seat.id}),now]);
    await db.run('UPDATE character_roles SET primary_seat=COALESCE(primary_seat,?) WHERE id=?',[seat.id,role.id]);
  }
  const bindings=await db.all(`SELECT DISTINCT b.id,b.runtime_id,b.role_id FROM role_bindings b JOIN role_applications a
    ON a.principal=b.principal AND a.connector_id=b.connector_id AND a.runtime_id=b.runtime_id
    WHERE a.mode='explicit_context' AND b.state='active'`);
  for(const binding of bindings){
    const sessions='SELECT id FROM office_sessions WHERE seat_id IN (SELECT seat_id FROM role_seats WHERE role_id=?)';
    await db.run(`UPDATE office_items SET status='open',revision=revision+1,epoch=epoch+1,lease_hash=NULL,lease_until=NULL,session_id=NULL WHERE status='claimed' AND session_id IN (${sessions})`,[binding.role_id]);
    await db.run(`UPDATE office_sessions SET state='closed' WHERE id IN (${sessions})`,[binding.role_id]);
    await db.run("UPDATE role_bindings SET state='revoked',epoch=epoch+1 WHERE id=?",[binding.id]);
    await db.run('DELETE FROM role_connection_requests WHERE runtime_id=?',[binding.runtime_id]);
    await db.run('INSERT INTO role_events(role_id,kind,body,ts) VALUES(?,?,?,?)',[binding.role_id,'binding_revoked',JSON.stringify({bindingId:binding.id,reason:'Chat identity requires user activation'}),now]);
  }
  await db.run("UPDATE role_applications SET state='cancelled',revision=revision+1 WHERE mode='explicit_context' AND state='pending'");
  await db.run("UPDATE role_applications SET mode='connection' WHERE mode='explicit_context'");
  if(await db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='role_office_contexts'")){
    const sessions='SELECT work_session_id FROM role_office_contexts';
    await db.run(`UPDATE office_items SET status='open',revision=revision+1,epoch=epoch+1,lease_hash=NULL,lease_until=NULL,session_id=NULL WHERE status='claimed' AND session_id IN (${sessions})`);
    await db.run(`UPDATE office_sessions SET state='closed' WHERE id IN (${sessions})`);
    await db.exec('DROP TABLE role_office_contexts');
  }
  await db.run('DELETE FROM office_response_pages');
  await db.run("INSERT INTO office_meta VALUES('role-model.v1',?)",[String(now)]);
}
