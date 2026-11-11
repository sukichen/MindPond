import { randomUUID } from 'node:crypto';
import type { Database } from 'sqlite';

type Row = Record<string, any>;

export async function initSeatArchive(db:Database) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS office_seat_item_archive(
      id TEXT PRIMARY KEY, office_id TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
      continuation_id TEXT, snapshot TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS office_seat_item_archive_page ON office_seat_item_archive(office_id,id);
    CREATE INDEX IF NOT EXISTS office_seat_item_archive_task ON office_seat_item_archive(office_id,continuation_id)
      WHERE continuation_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS office_seat_round_archive(
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES office_seat_item_archive(id) ON DELETE CASCADE,
      number INTEGER NOT NULL, code_version TEXT NOT NULL, material_id TEXT NOT NULL, state TEXT NOT NULL, result TEXT
    );
    CREATE INDEX IF NOT EXISTS office_seat_round_archive_item ON office_seat_round_archive(item_id,number);
    CREATE VIEW IF NOT EXISTS office_seat_items_observed AS
      SELECT id,office_id,title,acceptance,owner,reviewer,parent_id,status,revision,epoch,lease_until,round_id,
        round_number,code_version,material_id,transfer_to,transfer_epoch,0 archived,NULL continuationId,
        NULL ownerName,NULL reviewerName
      FROM office_items
      UNION ALL
      SELECT a.id,a.office_id,
        json_extract(a.snapshot,'$.title'),json_extract(a.snapshot,'$.acceptance'),
        json_extract(a.snapshot,'$.owner'),json_extract(a.snapshot,'$.reviewer'),
        json_extract(a.snapshot,'$.parent_id'),json_extract(a.snapshot,'$.status'),
        json_extract(a.snapshot,'$.revision'),json_extract(a.snapshot,'$.epoch'),NULL,
        json_extract(a.snapshot,'$.round_id'),json_extract(a.snapshot,'$.round_number'),
        json_extract(a.snapshot,'$.code_version'),json_extract(a.snapshot,'$.material_id'),
        json_extract(a.snapshot,'$.transfer_to'),json_extract(a.snapshot,'$.transfer_epoch'),1,t.id,
        json_extract(a.snapshot,'$.ownerName'),json_extract(a.snapshot,'$.reviewerName')
      FROM office_seat_item_archive a LEFT JOIN office_guided_tasks t ON t.id=a.continuation_id AND t.office_id=a.office_id;
    CREATE VIEW IF NOT EXISTS office_seat_rounds_observed AS
      SELECT id,item_id,number,code_version,material_id,state,result FROM office_rounds
      UNION ALL SELECT id,item_id,number,code_version,material_id,state,result FROM office_seat_round_archive;
  `);
}

/** Runs once under the database writer lock, after roles and guided tasks exist. */
export async function retireSeatEngine(db:Database,now:number) {
  if(await db.get("SELECT 1 FROM office_meta WHERE key='seat-engine-retired.v1'"))return;
  const selectItems=`SELECT i.id,i.office_id,i.title,i.acceptance,i.owner,i.reviewer,i.parent_id,
    i.status,i.revision,i.epoch,i.round_id,i.round_number,i.code_version,i.material_id,i.transfer_to,i.transfer_epoch,
    os.label ownerName,rs.label reviewerName,r.role_id roleId,c.name roleName,o.state officeState,o.deadline,o.goal
    FROM office_items i JOIN offices o ON o.id=i.office_id LEFT JOIN office_seats os ON os.id=i.owner AND os.office_id=i.office_id
    LEFT JOIN office_seats rs ON rs.id=i.reviewer AND rs.office_id=i.office_id LEFT JOIN role_seats r ON r.seat_id=os.id
    LEFT JOIN character_roles c ON c.id=r.role_id WHERE i.id>? ORDER BY i.id LIMIT 100`;
  let archived=0,continued=0,unresolved=0,after='';
  for(;;){
    const rows=await db.all<Row[]>(selectItems,[after]);
    if(!rows.length)break;
    for(const row of rows) {
      const {roleId,roleName,officeState,deadline,goal,...snapshot}=row;
      const open=!['completed','cancelled'].includes(row.status);
      let taskId:string|null=null;
      if(open&&roleName&&['active','paused'].includes(officeState)&&deadline>now){
        taskId=await db.get('SELECT 1 FROM office_guided_tasks WHERE id=?',[row.id])?randomUUID():row.id;
        const material=row.material_id&&await db.get(
          "SELECT 1 FROM office_materials WHERE office_id=? AND id=? AND state='published'",[row.office_id,row.material_id]);
        await db.run(`INSERT INTO office_guided_tasks
          (id,office_id,owner_id,author,guided_by,title,goal,acceptance,instruction,memory_query,status,
           updated_at,create_key,create_hash,brief_material_id,created_at)
          VALUES(?,?,?,'seat-migration','human',?,?,?,?,?,'queued',?,?,?,?,?)`,[
          taskId,row.office_id,roleId,row.title,goal||row.title,row.acceptance||'核对原工位验收记录并交付当前结果。',
          '先核对现有成果与已发布材料，避免重复操作。缺少原始证据时向用户确认，再提交本轮交付。',
          row.title,now,row.id,'seat-engine-retired.v1',material?row.material_id:null,now]);
        await db.run("INSERT INTO office_guided_changes(task_id,audience,kind) VALUES(?,'owner','assignment')",[taskId]);
        await db.run("INSERT INTO office_events(office_id,seat_id,actor,kind,body,ts) VALUES(?,NULL,?,'guided_task',?,?)",[
          row.office_id,JSON.stringify({roleId:null}),JSON.stringify({action:'imported',taskId,title:row.title,
            revision:1,status:'queued',ownerId:roleId,ownerName:roleName,actorName:'迁移',seatItemId:row.id}),now]);
        continued++;
      }else if(open)unresolved++;
      await db.run('INSERT INTO office_seat_item_archive VALUES(?,?,?,?)',[row.id,row.office_id,taskId,JSON.stringify(snapshot)]);
      archived++;
      after=row.id;
    }
  }
  await db.exec(`
    INSERT INTO office_seat_round_archive SELECT id,item_id,number,code_version,material_id,state,result FROM office_rounds;
    DELETE FROM office_rounds;
    DELETE FROM office_items;
    UPDATE office_sessions SET state='closed' WHERE state<>'closed';
    UPDATE office_waits SET state='cancelled' WHERE state='waiting';
    DELETE FROM office_receipts;
    DELETE FROM office_exports;
  `);
  await db.run("INSERT INTO office_meta VALUES('seat-engine-retired.v1',?)",[JSON.stringify({at:now,archived,continued,unresolved})]);
}
