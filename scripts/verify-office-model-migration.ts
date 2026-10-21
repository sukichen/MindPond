/** Data conversion is transactional and runs once; public participants are roles. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {GraphMemory} from '../src/core/graph-memory.js';
import {getEmbeddingService} from '../src/core/embedding.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-office-model-'));
const file=path.join(dir,'fixture.db'),graph=new GraphMemory('.',{dbPath:file});let reopened:GraphMemory|undefined;
const embedding=getEmbeddingService(),original=embedding.generateEmbedding;embedding.generateEmbedding=async()=>[1,...Array(383).fill(0)];
const admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
try{
 await graph.init();const db=(graph as any).db;
 await graph.offices.configureAgent({id:'fixture',principal:'human',host:'codex',name:'Fixture host',state:'active',expectedRevision:0},admin);
 const roles=[];
 for(const name of ['Main','Other']){
  const actor={...admin,operator:false,agentId:'fixture',runtimeId:name,transport:'http-mcp' as const};
  const app=await graph.roles.application({action:'submit',name,introduction:'Fictional',reason:'Migration fixture',key:'apply'},actor);
  roles.push(await graph.roles.review({action:'approve',applicationId:app.applicationId,expectedRevision:1},admin));
 }
 const human=await graph.saveMemory('Fictional source knowledge'),copy=(await graph.memoryOwners.allocate([human.id],roles[0].roleId)).copies[0];
 await graph.building.message({action:'send',recipient:roles[1].roleId,kind:'inform',body:'Preserve this message',key:'message'}, {...admin,operator:false,agentId:'fixture',runtimeId:'Main',transport:'http-mcp'});
 await graph.offices.configureOffice({id:'room',title:'Fictional room',state:'active',expectedRevision:0,seats:[{id:'seat-a',agentId:'fixture',label:'Main'},{id:'seat-b',agentId:'fixture',label:'Other'}]},admin);
 await graph.offices.configureOffice({id:'second',title:'Second room',state:'active',expectedRevision:0,seats:[{id:'seat-c',agentId:'fixture',label:'Main'}]},admin);
 await graph.roles.configureOffice({id:'mapped',title:'Mapped room',state:'active',expectedRevision:0,seats:roles.map((r,i)=>({id:'mapped-'+i,roleId:r.roleId,agentId:'fixture',label:'Mapped '+i,role:i?'reviewer':'worker'}))},admin);
 const mainActor={...admin,operator:false,agentId:'fixture',runtimeId:'Main',transport:'http-mcp' as const,roleId:roles[0].roleId,roleBindingId:roles[0].bindingId,roleBindingEpoch:1};
 const session=(await graph.offices.open({assignmentId:'mapped-0'},mainActor)).context!;
 const task=await graph.offices.item({action:'create',workSessionId:session.workSessionId,title:'Release claim during migration',owner:'mapped-0',reviewer:'mapped-1',acceptance:'Preserved and released',key:'task'},mainActor);
 await graph.offices.item({action:'claim',workSessionId:session.workSessionId,itemId:task.item.id,expectedRevision:task.item.revision,key:'claim'},mainActor);
 await db.exec('CREATE TABLE role_office_contexts(binding_id TEXT,seat_id TEXT,work_session_id TEXT)');
 await db.run('INSERT INTO role_office_contexts VALUES(?,?,?)',[roles[0].bindingId,'mapped-0',session.workSessionId]);
 const rawSession=(await graph.offices.open({assignmentId:'seat-a'},{...admin,operator:false,agentId:'fixture',runtimeId:'raw',transport:'http-mcp'})).context!;
 await db.run("UPDATE role_applications SET mode='explicit_context' WHERE name='Main'");
 await db.run("DELETE FROM office_meta WHERE key='role-model.v1'");
 const before=await db.get('SELECT COUNT(*) n FROM character_roles'),nodes=await db.get('SELECT COUNT(*) n FROM nodes');
 await db.exec("CREATE TRIGGER fail_role_migration BEFORE INSERT ON role_seats WHEN NEW.seat_id='seat-b' BEGIN SELECT RAISE(ABORT,'fixture migration failure'); END");
 await assert.rejects(graph.roles.migrateModel(),/migration failure/);
 assert.equal((await db.get('SELECT COUNT(*) n FROM role_seats')).n,2);assert.equal((await db.get('SELECT COUNT(*) n FROM character_roles')).n,before.n);assert.equal((await db.get("SELECT state FROM role_bindings WHERE runtime_id='Main'")).state,'active');assert(!await db.get("SELECT 1 FROM office_meta WHERE key='role-model.v1'"));
 await db.exec('DROP TRIGGER fail_role_migration');await graph.roles.migrateModel();
 assert.equal((await db.get('SELECT COUNT(*) n FROM role_seats')).n,5);assert.equal((await db.get('SELECT COUNT(*) n FROM character_roles')).n,before.n+3);
 assert.notEqual((await db.get("SELECT role_id FROM role_seats WHERE seat_id='seat-a'")).role_id,roles[0].roleId);assert.notEqual((await db.get("SELECT role_id FROM role_seats WHERE seat_id='seat-b'")).role_id,roles[1].roleId);
 assert.equal((await db.get("SELECT state FROM role_bindings WHERE runtime_id='Main'")).state,'revoked');assert.equal((await db.get("SELECT state FROM role_bindings WHERE runtime_id='Other'")).state,'active');
 assert.equal((await db.get('SELECT COUNT(*) n FROM nodes')).n,nodes.n);assert(await graph.getNodeById(copy.copyId));assert.equal((await db.get('SELECT body FROM role_messages')).body,'Preserve this message');assert.equal((await db.all('PRAGMA foreign_key_check')).length,0);
 await assert.rejects(graph.roles.configureOffice({id:'bad',title:'Invalid participant',state:'active',expectedRevision:0,seats:[{id:'bad-seat',agentId:'fixture',label:'Missing role'}]},admin),(e:any)=>e.code==='invalid_input');
 assert.equal((await db.get('SELECT state FROM office_sessions WHERE id=?',[rawSession.workSessionId])).state,'closed');
 assert.equal((await db.get('SELECT state FROM office_sessions WHERE id=?',[session.workSessionId])).state,'closed');assert.equal((await db.get('SELECT status FROM office_items WHERE id=?',[task.item.id])).status,'open');assert(!await db.get("SELECT 1 FROM sqlite_master WHERE name='role_office_contexts'"));
 assert.equal((await db.get("SELECT role_id FROM role_seats WHERE seat_id='mapped-0'")).role_id,roles[0].roleId);
 await graph.roles.migrateModel();reopened=new GraphMemory('.',{dbPath:file});await reopened.init();assert.equal((await (reopened as any).db.get('SELECT COUNT(*) n FROM character_roles')).n,before.n+3);assert.equal((await (reopened as any).db.get('SELECT COUNT(*) n FROM role_seats')).n,5);
 const office=await fs.readFile(new URL('../web/office.js',import.meta.url),'utf8');const start=office.indexOf('  function seatChoices()'),end=office.indexOf('  function renderCharacters',start);
 const context=vm.createContext({state:{data:{characters:{roles:[{id:'role-a',name:'Role A',introduction:'Approved',state:'active'},{id:'role-b',name:'Disabled',introduction:'Not available',state:'disabled'}]},agents:[{id:'host',name:'Host only',state:'active'}]}}});
 vm.runInContext(office.slice(start,end)+'\nglobalThis.choices=seatChoices;',context);assert.deepEqual(JSON.parse(JSON.stringify(context.choices())),[{value:'role-a',name:'Role A · Approved'}]);
 for(const file of ['office.js','app.js','index.html','collaboration.html','office-collaboration.js','office-guide.html']){const text=await fs.readFile(new URL('../web/'+file,import.meta.url),'utf8');assert(!/旧连接|旧角色|旧工位|旧工作流|历史角色/.test(text),'obsolete product wording in '+file);}
 console.log('PASS one-time office role migration: rollback, stable IDs/knowledge/messages, unique role seats, chat reactivation, restart idempotency, strict participant model and current UI choices');
}finally{await reopened?.close();await graph.close();embedding.generateEmbedding=original;await fs.rm(dir,{recursive:true,force:true});}
