/** Cross-feature lifecycle regressions. Synthetic SQLite; no host/model automation. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {GraphMemory} from '../src/core/graph-memory.js';
import {roleRuntimeId} from '../src/core/roles.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-consistency-')),file=path.join(dir,'fixture.db');
const graph=new GraphMemory('.',{dbPath:file}),peer=new GraphMemory('.',{dbPath:file});
const admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const actor=(chat:string)=>({v:1 as const,principal:'human',agentId:'host',runtimeId:roleRuntimeId('human','host','codex',chat),transport:'http-mcp' as const,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER});
const a=actor('a'),b=actor('b');let failures=0;
const test=async(name:string,run:()=>Promise<void>)=>{try{await run();console.log('PASS '+name);}catch(e){failures++;console.error('FAIL '+name,e);}};
try{
 await graph.init();await graph.offices.configureAgent({id:'host',principal:'human',name:'Synthetic host',host:'codex',state:'active',expectedRevision:0},admin);
 const roles=[];for(const context of [a,b]){const p=await graph.roles.application({action:'submit',name:context.runtimeId===a.runtimeId?'A':'B',introduction:'Synthetic feature consistency',reason:'Regression',key:'apply'},context);roles.push(await graph.roles.review({action:'approve',applicationId:p.applicationId,expectedRevision:1},admin));}
 const seats=roles.map((r,n)=>({id:'seat-'+n,roleId:r.roleId,label:'Synthetic duty',role:'member'}));
 await graph.roles.configureOffice({id:'room',title:'Synthetic office',state:'active',expectedRevision:0,seats},admin);await peer.init();
 await test('human stop interrupts ordinary wait across SQLite connections without claiming messages',async()=>{
  const start=performance.now(),waiting=graph.building.wait({waitMs:2000},b);await new Promise(r=>setTimeout(r,60));
  const request=await peer.officeCollaboration.requestControl({roleId:roles[1].roleId,action:'stop',reason:'Synthetic user stop'},admin);
  try{const result=await waiting;assert.equal(result.status,'control');assert.equal(result.controlRequests[0].id,request.id);assert.equal(result.wakeReason,'user_control_requested');assert.equal((await graph.officeCollaboration.controls(roles[1].roleId,b)).find((r:any)=>r.id===request.id).state,'requested','delivery must not acknowledge the user request');assert(performance.now()-start<1700);}
  finally{await graph.officeCollaboration.host({action:'ack',requestId:request.id,outcome:'acknowledged',evidence:'Synthetic stop applied'},b);}
 });
 const mail=await graph.building.message({action:'send',officeId:'room',recipient:roles[1].roleId,body:'Synthetic ordinary task',key:'mail'},a);
 const room=await graph.discussions.run({action:'create',officeId:'room',title:'One question',question:'Synthetic question',doneWhen:'Verified conclusion',participants:[roles[1].roleId],key:'room'},a);await graph.discussions.run({action:'join',id:room.room.id},b);
 await test('human pause interrupts discussion wait and preserves unprocessed work',async()=>{
  const waiting=graph.discussions.wait({action:'wait',id:room.room.id,waitMs:2000},b);await new Promise(r=>setTimeout(r,60));
  const request=await peer.officeCollaboration.requestControl({roleId:roles[1].roleId,action:'pause',reason:'Synthetic human pause'},admin);
  try{const result=await waiting;assert.equal(result.status,'control');assert.equal(result.controlRequests[0].id,request.id);assert.equal(result.discussionId,room.room.id);}
  finally{await graph.officeCollaboration.host({action:'ack',requestId:request.id,outcome:'acknowledged',evidence:'Synthetic pause applied'},b);}
 });
 await test('experimental Tasks use the same discussion priority as office_wait',async()=>{
  const store=graph.officeTaskStore(b),task=await store.createTask({},1,{method:'tools/call',params:{name:'office_wait_task',arguments:{waitMs:2000}}});
  assert.equal((await store.getTask(task.taskId))?.status,'completed');const payload=JSON.parse((await store.getTaskResult(task.taskId)).content[0].text as string);
  assert.equal(payload.status,'discussion');assert.equal(payload.wakeReason,'active_discussion');assert.equal(payload.message,undefined);assert.equal(payload.nextCall.tool,'office_discussion');
 });
 await test('another role control cannot wake or disclose through this discussion wait',async()=>{
  const request=await graph.officeCollaboration.requestControl({roleId:roles[0].roleId,action:'pause',reason:'A-only instruction'},admin);
  try{const direct=await graph.building.wait({waitMs:200},b);assert.equal(direct.status,'discussion');assert.equal(direct.controlRequests,undefined);const start=performance.now(),wait=await graph.discussions.wait({action:'wait',id:room.room.id,waitMs:200},b);assert.equal(wait.status,'timeout');assert(performance.now()-start>=190);assert.equal(wait.controlRequests,undefined);}
  finally{await graph.officeCollaboration.host({action:'ack',requestId:request.id,outcome:'acknowledged',evidence:'A paused'},a);}
 });
 const latest=await graph.discussions.run({action:'get',id:room.room.id},admin);await graph.discussions.run({action:'close',id:room.room.id,expectedRevision:latest.room.revision},admin);
 await test('experimental Tasks prioritize user control over available mail and return public continuation',async()=>{
  const request=await graph.officeCollaboration.requestControl({roleId:roles[1].roleId,action:'stop',reason:'Do not consume the queued work'},admin);
  try{const store=graph.officeTaskStore(b),task=await store.createTask({},2,{method:'tools/call',params:{name:'office_wait_task',arguments:{waitMs:100}}});await store.getTask(task.taskId);const payload=JSON.parse((await store.getTaskResult(task.taskId)).content[0].text as string);assert.equal(payload.status,'control');assert.equal(payload.controlRequests[0].id,request.id);}
  finally{await graph.officeCollaboration.host({action:'ack',requestId:request.id,outcome:'acknowledged',evidence:'Synthetic stop applied'},b);}
 });
 await test('experimental task timeout preserves the exact public reply filter without taking mail',async()=>{
  const store=graph.officeTaskStore(b),task=await store.createTask({},3,{method:'tools/call',params:{name:'office_wait_task',arguments:{replyTo:mail.messageId,waitMs:100}}});await new Promise(r=>setTimeout(r,120));
  const payload=JSON.parse((await store.getTaskResult(task.taskId)).content[0].text as string);assert.equal(payload.status,'timeout');assert.equal(payload.wakeReason,'deadline_reached');assert.equal(payload.resume.replyTo,mail.messageId);assert.equal(payload.resume.waitMs,100);assert.equal(payload.resume.requestId,undefined);assert(payload.elapsedMs>=100);assert.equal((await graph.building.message({action:'get',messageId:mail.messageId},b)).message.state,'pending');
 });
 await graph.roles.configureOffice({id:'room',title:'Synthetic office',state:'active',expectedRevision:1,seats:[seats[0]]},admin);
 await test('role resume attention agrees with its addressed inbox after leaving an office',async()=>{
  const inbox=await graph.building.receive({action:'list',state:'pending'},b);assert(inbox.messages.some((m:any)=>m.id===mail.messageId));
  const access={roleId:roles[1].roleId,authorize:async()=>{await graph.roles.binding(b);}};const resumed=await graph.roleContinuity.resume(access);assert.equal(resumed.attention.pendingMessages,inbox.messages.length);
  await graph.building.message({action:'take',messageId:mail.messageId,key:'take'},b);assert.equal((await graph.roleContinuity.resume(access)).attention.processingMessages,1);
 });
 await test('deleting a source office preserves role-owned unsent departure drafts',async()=>{
  const duty=roles.map((r,n)=>({id:'draft-seat-'+n,roleId:r.roleId,label:'Synthetic draft duty',role:'member'}));
  await graph.roles.configureOffice({id:'draft-office',title:'Draft source',state:'active',expectedRevision:0,seats:duty},admin);
  const meeting=await graph.discussions.run({action:'create',officeId:'draft-office',title:'Draft check',question:'Synthetic draft question',doneWhen:'Preserve private draft',participants:[roles[1].roleId],key:'draft-room'},a);
  await graph.roles.configureOffice({id:'draft-office',title:'Draft source',state:'paused',expectedRevision:1,seats:duty},admin);
  const exit=await graph.discussions.run({action:'leave',id:meeting.room.id,summary:'Verified synthetic outcome',key:'exit',messages:[{recipient:roles[1].roleId,body:'Private role-owned unsent draft sentinel'}]},a);assert.equal(exit.notifications.pending,1);
  // Recreate the installed cascade schema with a real pending payload/receipt,
  // then let another process's normal startup migration preserve those rows.
  const db=(graph as any).db;
  await (graph as any).growthWrite(()=>db.exec(`ALTER TABLE office_discussion_departures RENAME TO fixture_departures;
   CREATE TABLE office_discussion_departures(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,office_id TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,role_id TEXT NOT NULL REFERENCES character_roles(id) ON DELETE CASCADE,key TEXT NOT NULL,hash TEXT NOT NULL,messages TEXT NOT NULL,pending_count INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(role_id,room_id,key));
   INSERT INTO office_discussion_departures SELECT * FROM fixture_departures;DROP TABLE fixture_departures;`));
  const before=await db.get('SELECT * FROM office_discussion_departures WHERE id=?',[exit.departureId]);await peer.discussions.init();
  assert.deepEqual(await db.get('SELECT * FROM office_discussion_departures WHERE id=?',[exit.departureId]),before,'migration must preserve ID, body, hash, key, errors and pending count');
  assert(!(await db.all('PRAGMA foreign_key_list(office_discussion_departures)')).some((k:any)=>k.table==='offices'));
  await graph.roles.deleteOffice({id:'draft-office',expectedRevision:2},admin);
  const retained=await graph.discussions.run({action:'departure_get',departureId:exit.departureId,messageIndex:0},a);assert.equal(retained.payload.body,'Private role-owned unsent draft sentinel');
  await assert.rejects(graph.roles.configureOffice({id:'draft-office',title:'Different room must use another ID',state:'active',expectedRevision:0,seats:duty},admin),(e:any)=>e.code==='invalid_input');
 });
 const db=(graph as any).db;assert.equal((await db.get('PRAGMA quick_check')).quick_check,'ok');assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]);
 if(failures)throw Error(failures+' feature consistency regressions failed');
}finally{await peer.close();await graph.close();await fs.rm(dir,{recursive:true,force:true});}
