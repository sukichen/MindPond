import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'sqlite';
import { GraphMemory } from '../src/core/graph-memory.js';
import { hostOperations } from '../src/core/host-contract.js';
import { retireSeatEngine } from '../src/core/office-seat-archive.js';
import { roleRuntimeId } from '../src/core/roles.js';

process.env.MINDPOND_EMBEDDING_MODE='text';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-seat-retirement-'));
const dbPath=path.join(dir,'fixture.db');
const operator={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const open=async()=>{const graph=new GraphMemory(dir,{dbPath});await graph.init();return graph;};
const dbOf=(graph:GraphMemory)=>(graph as unknown as {db:Database}).db;
let graph=await open();
try{
  await graph.offices.configureAgent({id:'host',principal:'human',name:'Fixture',host:'codex',state:'active',expectedRevision:0},operator);
  const actor={v:1 as const,principal:'human',agentId:'host',runtimeId:roleRuntimeId('human','host','codex','fixture'),
    runtimeMode:'codex_metadata' as const,transport:'http-mcp' as const,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
  const application=await graph.roles.application({action:'submit',name:'Worker',introduction:'Fixture role',reason:'Retirement test',key:'apply'},actor);
  const role=await graph.roles.review({applicationId:application.applicationId,expectedRevision:1,action:'approve'},operator);
  await graph.roles.configureOffice({id:'room',title:'Office',goal:'Keep actual evidence',state:'active',expectedRevision:0,
    seats:[{id:'seat',roleId:role.roleId,label:'Worker seat',role:'member'}]},operator);
  const db=dbOf(graph);
  const material=await graph.building.material({action:'publish',officeId:'room',title:'Original log',version:'v1',content:'Original evidence',key:'publish'},actor);
  await db.run("INSERT INTO office_sessions VALUES('old-session','seat',1,'active',0)");
  await db.run("INSERT INTO office_waits VALUES('old-wait','room','old-session','{}','waiting',0,?)",[Date.now()+20000]);
  const insertItem=async(id:string,status:string,owner='seat')=>db.run(`INSERT INTO office_items
    (id,office_id,title,acceptance,owner,reviewer,status,revision,epoch,round_id,round_number,code_version,material_id,lease_hash,session_id)
    VALUES(?,'room',?,'Exact evidence',?,'seat',?,3,2,?,1,'v1',?,'test-lease','old-session')`,
    [id,id,owner,status,id+'-round',material.materialId]);
  await insertItem('old-continued','submitted');
  await insertItem('old-done','completed');
  await insertItem('old-unmapped','open','unavailable-seat');
  await db.run("INSERT INTO office_rounds VALUES('old-continued-round','old-continued',1,'v1',?,'pending',NULL)",[material.materialId]);
  await db.run("INSERT INTO office_rounds VALUES('old-done-round','old-done',1,'v1',?,'passed',?)",
    [material.materialId,JSON.stringify({summary:'Original completed review',evidence:'Exact checksum'})]);
  const event=await db.run("INSERT INTO office_events(office_id,seat_id,actor,kind,body,ts) VALUES('room','seat','{}','inform','{}',0)");
  await db.run("INSERT INTO office_messages VALUES('old-mail','room','seat','seat','inform','Historical seat text',NULL,0,?)",[event.lastID]);
  await db.run("INSERT INTO office_acks VALUES('old-mail','seat','read')");
  await db.run("DELETE FROM office_meta WHERE key='seat-engine-retired.v1'");
  await db.exec(`CREATE TEMP TRIGGER fail_archive_copy BEFORE INSERT ON office_seat_round_archive
    BEGIN SELECT RAISE(ABORT,'fixture copy failure'); END`);
  const internal=graph as unknown as {growthWrite<T>(fn:()=>Promise<T>):Promise<T>};
  await assert.rejects(internal.growthWrite(()=>retireSeatEngine(db,Date.now())),/fixture copy failure/);
  assert.equal((await db.get('SELECT COUNT(*) n FROM office_items')).n,3);
  assert.equal((await db.get('SELECT COUNT(*) n FROM office_seat_item_archive')).n,0);
  assert.equal((await db.get('SELECT COUNT(*) n FROM office_guided_tasks')).n,0);
  assert.equal((await db.get("SELECT state FROM office_sessions WHERE id='old-session'")).state,'active');
  await db.exec('DROP TRIGGER fail_archive_copy');

  await graph.close();
  graph=await open();
  const migrated=dbOf(graph);
  const counts=JSON.parse((await migrated.get("SELECT value FROM office_meta WHERE key='seat-engine-retired.v1'")).value);
  assert.equal(counts.archived,3);assert.equal(counts.continued,1);assert.equal(counts.unresolved,1);
  assert.equal((await migrated.get('SELECT COUNT(*) n FROM office_items')).n,0);
  assert.equal((await migrated.get('SELECT COUNT(*) n FROM office_rounds')).n,0);
  assert.equal((await migrated.get("SELECT state FROM office_sessions WHERE id='old-session'")).state,'closed');
  assert.equal((await migrated.get("SELECT state FROM office_waits WHERE id='old-wait'")).state,'cancelled');
  const task=(await graph.guidedTasks.run({action:'get',officeId:'room',taskId:'old-continued'},operator)).task;
  assert.equal(task.id,'old-continued');assert.equal(task.status,'queued');assert.equal(task.seatArchiveId,'old-continued');
  assert.equal(task.brief.materialId,material.materialId);
  assert.equal(task.result,null,'old submission never counts as a guided delivery');
  const observed=await graph.offices.get({officeId:'room',itemId:'old-continued'},operator);
  assert.equal(observed.item.status,'submitted');
  assert.equal(observed.item.archived,1);
  assert.equal(observed.item.continuationId,task.id);
  assert.equal(observed.rounds[0].state,'pending','archived rounds retain exact historical states');
  const round=await graph.offices.get({officeId:'room',roundId:'old-done-round'},operator);
  assert.equal(JSON.parse(round.content).result.evidence,'Exact checksum');
  const exported=await graph.officeCollaboration.exportPage({officeId:'room',section:'seatArchive'},operator);
  assert.equal(exported.rows.length,6);
  assert.equal(JSON.parse(exported.rows.find((row:{kind:string})=>row.kind==='message').payload).body,'Historical seat text');
  assert(!JSON.stringify(exported).includes('test-lease'),'archive excludes mutable authority and secrets');
  assert(!hostOperations(graph).some(tool=>tool.path.startsWith('/api/work/office/')));
  assert(hostOperations(graph).some(tool=>tool.name==='work_inbox'),'account handoffs are independent of the retired seat engine');
  await graph.close();
  graph=await open();
  assert.equal((await dbOf(graph).get('SELECT COUNT(*) n FROM office_guided_tasks')).n,1,'restart does not duplicate continuations');
  assert.equal((await dbOf(graph).get('SELECT COUNT(*) n FROM office_seat_item_archive')).n,3);
  await graph.roles.deleteOffice({id:'room',expectedRevision:1},operator);
  assert.equal((await dbOf(graph).get('SELECT COUNT(*) n FROM office_seat_item_archive')).n,0);
  assert.deepEqual(await dbOf(graph).all('PRAGMA foreign_key_check'),[]);
  console.log('PASS seat engine retirement: atomic restart-safe migration, original rounds and mail, pending work, private authority removal and archive deletion');
}finally{await graph.close();await fs.rm(dir,{recursive:true,force:true});}
