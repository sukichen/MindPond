import type { Database } from 'sqlite';

/** Operator-only hard deletion. The caller owns one BEGIN IMMEDIATE
 * transaction, including revision checks and the durable deletion audit. */
export async function deleteRoleData(db: Database, roleId: string) {
  await db.run('DELETE FROM memory_role_credentials WHERE role_id=?',[roleId]);
  await db.run('DELETE FROM role_connection_requests WHERE runtime_id IN (SELECT runtime_id FROM role_bindings WHERE role_id=?)',[roleId]);
  await db.run('DELETE FROM office_response_pages');
  await db.run('DELETE FROM office_exports');
  for(const table of ['office_probe_leases','office_wait_queue'])await db.run(`DELETE FROM ${table} WHERE binding_id IN (SELECT id FROM role_bindings WHERE role_id=?)`,[roleId]);
  await db.run("DELETE FROM office_protocol_tasks WHERE EXISTS (SELECT 1 FROM role_bindings b WHERE b.role_id=? AND instr(owner,':'||b.id||':')>0)",[roleId]);
  await db.run('DELETE FROM office_control_requests WHERE role_id=?',[roleId]);
  await db.run('DELETE FROM office_host_reports WHERE role_id=?',[roleId]);
  await db.run('DELETE FROM office_collaboration_receipts WHERE EXISTS (SELECT 1 FROM role_bindings b WHERE b.role_id=? AND substr(actor,1,length(b.id)+1)=b.id||\':\')',[roleId]);
  const seats = 'SELECT seat_id FROM role_seats WHERE role_id=?';
  // Keep office history and materials, but fence every old assignment and
  // cancel work that can no longer be completed by its assigned participants.
  await db.run(`UPDATE office_rounds SET state='superseded',result=? WHERE state='pending'
    AND item_id IN (SELECT id FROM office_items WHERE (owner IN (${seats}) OR reviewer IN (${seats}))
      AND status NOT IN ('completed','cancelled'))`, [JSON.stringify({reason:'Role deleted by user'}),roleId,roleId]);
  await db.run(`UPDATE office_items SET status='cancelled',revision=revision+1,epoch=epoch+1,
    lease_hash=NULL,lease_until=NULL,session_id=NULL,transfer_to=NULL,transfer_epoch=NULL
    WHERE (owner IN (${seats}) OR reviewer IN (${seats})) AND status NOT IN ('completed','cancelled')`, [roleId,roleId]);
  await db.run(`UPDATE office_items SET transfer_to=NULL,transfer_epoch=NULL,revision=revision+1
    WHERE transfer_to IN (${seats})`,[roleId]);
  await db.run(`UPDATE offices SET revision=revision+1 WHERE id IN
    (SELECT office_id FROM office_seats WHERE id IN (${seats}))`, [roleId]);
  await db.run(`UPDATE office_seats SET enabled=0,revision=revision+1 WHERE id IN (${seats})`, [roleId]);
  await deleteMessageReceipts(db,'sender=? OR recipient=?',[roleId,roleId]);
  await db.run('DELETE FROM role_message_states WHERE message_id IN (SELECT id FROM role_messages WHERE sender=? OR recipient=?)', [roleId,roleId]);
  await db.run('DELETE FROM role_messages WHERE sender=? OR recipient=?', [roleId,roleId]);
  await db.run('DELETE FROM role_links WHERE sender=? OR recipient=?', [roleId,roleId]);
  await db.run('DELETE FROM building_receipts WHERE actor=? OR binding_id IN (SELECT id FROM role_bindings WHERE role_id=?)', [roleId,roleId]);
  await db.run(`DELETE FROM role_receipts WHERE (principal,connector_id,runtime_id) IN
    (SELECT principal,connector_id,runtime_id FROM role_bindings WHERE role_id=?)`, [roleId]);
  await db.run('DELETE FROM role_message_waits WHERE role_id=? OR binding_id IN (SELECT id FROM role_bindings WHERE role_id=?)', [roleId,roleId]);
  await db.run('DELETE FROM role_bindings WHERE role_id=?', [roleId]);
  await db.run('DELETE FROM role_applications WHERE role_id=?', [roleId]);
  await db.run('DELETE FROM role_seats WHERE role_id=?', [roleId]);
  await db.run('DELETE FROM character_roles WHERE id=?', [roleId]);
  // Office-owned historical records retain attribution by their old seat ID.
  // They grant no permission: the seat is disabled and the role is gone.
}

export async function deleteOfficeData(db: Database, officeId: string) {
  await db.run('DELETE FROM office_response_pages');
  await db.run('DELETE FROM office_collaboration_receipts WHERE office_id=?',[officeId]);
  const seats = 'SELECT id FROM office_seats WHERE office_id=?';
  const sessions = `SELECT id FROM office_sessions WHERE seat_id IN (${seats})`;
  await db.run("DELETE FROM office_protocol_tasks WHERE json_extract(conditions,'$.replyTo') IN (SELECT id FROM role_messages WHERE office_id=?) OR json_extract(json_extract(result,'$.content[0].text'),'$.message.officeId')=?",[officeId,officeId]);
  // Purge replay receipts while their referenced records still exist. A retry
  // must never return the text/content of a permanently deleted office.
  await db.run(`DELETE FROM building_receipts WHERE json_extract(result,'$.officeId')=?
    OR json_extract(result,'$.message.officeId')=?
    OR json_extract(result,'$.messageId') IN (SELECT id FROM role_messages WHERE office_id=?)
    OR json_extract(result,'$.materialId') IN (SELECT id FROM office_materials WHERE office_id=?)
    OR json_extract(result,'$.id') IN (SELECT id FROM office_containers WHERE office_id=?
      UNION SELECT id FROM office_materials WHERE office_id=?
      UNION SELECT id FROM role_messages WHERE office_id=?)`, [officeId,officeId,officeId,officeId,officeId,officeId,officeId]);
  await deleteMessageReceipts(db,'office_id=?',[officeId]);
  await db.run(`DELETE FROM office_receipts WHERE session_id IN (${sessions})`, [officeId]);
  await db.run('DELETE FROM office_acks WHERE message_id IN (SELECT id FROM office_messages WHERE office_id=?)', [officeId]);
  await db.run('DELETE FROM office_messages WHERE office_id=?', [officeId]);
  await db.run('DELETE FROM role_message_states WHERE message_id IN (SELECT id FROM role_messages WHERE office_id=?)', [officeId]);
  await db.run('DELETE FROM role_messages WHERE office_id=?', [officeId]);
  await db.run('DELETE FROM office_chunks WHERE material_id IN (SELECT id FROM office_materials WHERE office_id=?)', [officeId]);
  await db.run('DELETE FROM office_rounds WHERE item_id IN (SELECT id FROM office_items WHERE office_id=?)', [officeId]);
  await db.run('DELETE FROM office_items WHERE office_id=?', [officeId]);
  await db.run('DELETE FROM office_materials WHERE office_id=?', [officeId]);
  await db.run('DELETE FROM office_containers WHERE office_id=?', [officeId]);
  await db.run('DELETE FROM office_waits WHERE office_id=?', [officeId]);
  await db.run(`DELETE FROM office_sessions WHERE seat_id IN (${seats})`, [officeId]);
  await db.run(`DELETE FROM role_seats WHERE seat_id IN (${seats})`, [officeId]);
  await db.run('DELETE FROM office_seats WHERE office_id=?', [officeId]);
  await db.run('DELETE FROM office_project_links WHERE office_id=?', [officeId]);
  await db.run('DELETE FROM office_events WHERE office_id=?', [officeId]);
  await db.run('DELETE FROM offices WHERE id=?', [officeId]);
  await db.run(`UPDATE character_roles SET primary_seat=(SELECT MIN(rs.seat_id)
    FROM role_seats rs JOIN office_seats s ON s.id=rs.seat_id WHERE rs.role_id=character_roles.id AND s.enabled=1)
    WHERE primary_seat IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM role_seats rs JOIN office_seats s ON s.id=rs.seat_id
      WHERE rs.role_id=character_roles.id AND rs.seat_id=primary_seat AND s.enabled=1)`);
}

async function deleteMessageReceipts(db: Database, where: string, params: string[]) {
  for (const table of ['role_receipts','building_receipts']) {
    for (const field of ['$.messageId','$.id','$.message.id'])
      await db.run(`DELETE FROM ${table} WHERE json_extract(result,?) IN
        (SELECT id FROM role_messages WHERE ${where})`, [field,...params]);
  }
}
