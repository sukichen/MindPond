/** Production directory regression: exceed every former display limit. */
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {GraphMemory} from '../src/core/graph-memory.js';
import {officeWorkbench} from '../src/integrations/office-workbench.js';
import {readNetworkConfiguration,tokenDigest} from '../src/integrations/network-config.js';
import {randomBytes} from 'node:crypto';
import type {DirectoryWindows} from '../src/core/admin-directory.js';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-directory-'));
const graph=new GraphMemory('.',{dbPath:path.join(dir,'graph.db')});
const admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
let clock=Date.now(),server:ReturnType<express.Express['listen']>|undefined;
const pad=(n:number)=>String(n).padStart(4,'0');
try{
 await graph.init();const db=(graph as any).db;
 await (graph as any).growthWrite(async()=>{
  for(let n=0;n<140;n++){
   await db.run("INSERT INTO office_agents VALUES(?,?,?,'generic-http-mcp','active',1,NULL,?)",['host-'+pad(n),'human','Synthetic host '+n,clock]);
   await db.run('INSERT INTO office_projects VALUES(?,?,?,1,1)',['project-'+pad(n),'Synthetic project '+n,'["host-0139"]']);
  }
  for(let n=0;n<220;n++)await db.run("INSERT INTO offices VALUES(?,?,?,?,'active',1,0,0,?)",['office-'+pad(n),'Synthetic office '+n,'','',clock]);
  for(let n=0;n<525;n++){
   await db.run("INSERT INTO character_roles VALUES(?,?,?,?,'active',1,NULL,?)",['role-'+pad(n),'human','Synthetic role '+n,'Full synthetic introduction '+n,clock]);
   await db.run("INSERT INTO role_chat_sessions VALUES(?,?,'host-0139','codex',?,?)",['chat-'+pad(n),'human','thread-'+n,clock]);
  }
  for(let n=0;n<125;n++){
   await db.run("INSERT INTO role_applications VALUES(?,?,'host-0139',?,'new',?,? ,?,'pending',1,NULL,?)",['application-'+pad(n),'human','chat-'+pad(n),'Synthetic applicant '+n,'Synthetic introduction','Synthetic reason',clock]);
   await db.run("INSERT INTO role_connection_requests(id,principal,connector_id,runtime_id,created_at,last_seen) VALUES(?,?,'host-0139',?,?,?)",['request-'+pad(n),'human','chat-'+pad(n+125),clock,clock]);
  }
  await db.run("INSERT INTO office_seats VALUES('late-seat','office-0219','host-0139','Synthetic seat','member',1,1)");
  await db.run("INSERT INTO role_seats VALUES('late-seat','role-0524')");
 });
 const first=await graph.offices.registry(admin),roles=await graph.roles.registry(admin);
 assert.equal(first.agents.length,50);assert.equal(roles.roles.length,50);
 assert.equal(first.directory.agents.total,140);assert.equal(first.directory.offices.total,220);
 assert.equal(roles.directory.roles.total,525);assert.equal(roles.directory.pending.total,125);assert.equal(roles.directory.connections.total,125);assert.equal(roles.directory.chats.total,525);
 const windows:DirectoryWindows={};
 for(;;){const page=await graph.offices.registry(admin,windows),r=await graph.roles.registry(admin,windows);let more=false;
  for(const [key,meta] of Object.entries({...page.directory,...r.directory})){if(meta.nextCursor){(windows as any)[key]=meta.nextCursor;more=true;}}
  if(!more){assert.equal(page.agents.length,140);assert.equal(page.offices.length,220);assert.equal(page.projects.length,140);assert.equal(r.roles.length,525);assert.equal(r.chats.length,525);assert.equal(r.pending.length,125);assert.equal(r.connections.length,125);break;}
 }
 assert.equal((await graph.offices.agent('host-0139',admin))?.name,'Synthetic host 139');
 assert.deepEqual((await graph.offices.agentSeats('host-0139',admin)).map(s=>s.id),['late-seat']);
 const choices=await graph.offices.choices(admin);assert.equal(choices.roles.length,525);assert.equal(choices.projects.length,140);assert(!('introduction' in choices.roles[0]),'complete selectors must not repeat long profiles');
 // Insert and delete before a loaded boundary: no offset shift or stale row.
 await db.run("DELETE FROM character_roles WHERE id='role-0001'");
 await db.run("INSERT INTO character_roles VALUES('role-0001a','human','Inserted','Fixture','active',1,NULL,?)",[clock]);
 const updated=await graph.roles.registry(admin,windows);assert(updated.roles.some(r=>r.id==='role-0001a'));assert(!updated.roles.some(r=>r.id==='role-0001'));assert.equal(new Set(updated.roles.map(r=>r.id)).size,525);
 await assert.rejects(graph.offices.registry({...admin,operator:false}),/operator/);
 await assert.rejects(graph.offices.registry(admin,{agents:42 as any}),/cursor/);
 const app=express();app.use(express.json());app.use('/api/office-admin',officeWorkbench(graph,{operatorKey:'synthetic-operator',configFile:path.join(dir,'accounts.json')}));server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server!.once('listening',resolve));
 const base='http://127.0.0.1:'+(server.address() as any).port+'/api/office-admin/';let cookie='';
 const req=async(route:string,body:any={})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
 assert.equal((await req('state')).status,401);
 const login=await req('login',{operatorKey:'synthetic-operator'});assert.equal(login.status,200);cookie=login.headers.get('set-cookie')!.split(';')[0];
 await graph.offices.settings(admin,'https://mindpond.example.test/mcp');
 const response=await req('state',{selectedOfficeId:'office-0219'});assert.equal(response.status,200);const state=await response.json();assert(!state.offices.some((o:any)=>o.id==='office-0219'));assert.deepEqual(state.selectedOffice,{id:'office-0219',exists:true});assert.equal(state.choices.roles.length,525);
 const leanResponse=await req('state',{choicesRevision:state.choicesRevision,connectionTemplatesRevision:state.connectionTemplatesRevision,roleAfterSeq:state.characters.revision,roleDirectoryRevision:state.characters.directoryRevision});const lean=await leanResponse.json();
 assert.deepEqual(lean.choices,{unchanged:true});assert.deepEqual(lean.connectionTemplates,{unchanged:true});assert(lean.characters.unchanged);
 const fullBytes=Buffer.byteLength(JSON.stringify(state)),leanBytes=Buffer.byteLength(JSON.stringify(lean));assert(leanBytes<fullBytes/2,'stable polling should omit the large choice catalog and templates');console.log('Measured synthetic state response bytes: '+fullBytes+' -> '+leanBytes);
 for(const template of Object.values(state.connectionTemplates) as any[])assert.equal(template.identityMode,'connection','default must not guess native capability from a harness name');
 const project=await db.get("SELECT * FROM office_projects WHERE id='project-0139'");await graph.offices.configureProject({id:project.id,title:'Updated off-page title',members:JSON.parse(project.members),enabled:true,expectedRevision:project.revision},admin);
 const changedChoices=await(await req('state',{choicesRevision:state.choicesRevision,connectionTemplatesRevision:state.connectionTemplatesRevision})).json();assert(!changedChoices.choices.unchanged);assert(changedChoices.choices.projects.some((p:any)=>p.title==='Updated off-page title'));assert.deepEqual(changedChoices.connectionTemplates,{unchanged:true});
 await graph.offices.settings(admin,'https://mindpond.example.test/prefix/mcp');const changedUrl=await(await req('state',{connectionTemplatesRevision:state.connectionTemplatesRevision})).json();assert(!changedUrl.connectionTemplates.unchanged);assert(changedUrl.connectionTemplates['host-0000'].text.includes('/prefix/mcp'));
 const unknownRevision='0'.repeat(64);assert(!(await(await req('state',{choicesRevision:unknownRevision})).json()).choices.unchanged);assert.equal((await req('state',{choicesRevision:'bad'})).status,400);
 const cfg=await req('connection-template',{agentId:'host-0139',identityMode:'connection'});assert.equal(cfg.status,200,'off-page connections remain configurable');
 const issued=await req('credential',{id:'host-0139',expectedRevision:1,identityMode:'connection',assignmentIds:['late-seat']});assert.equal(issued.status,200,'credential scope validation must include off-page offices and connections');
 // Browser shortcut must not merge several manually managed credential policies.
 const configPath=path.join(dir,'accounts.json'),config=await readNetworkConfiguration(configPath),firstGrant=config.grants[0];
 const duplicate={...firstGrant,credentialId:'independent-credential',tokenHash:tokenDigest(randomBytes(32).toString('hex'))};delete duplicate.assignmentIds;config.grants.push(duplicate);const privateConfig=JSON.stringify(config);await fs.writeFile(configPath,privateConfig);
 const beforeHost=await graph.offices.agent('host-0139',admin);const ambiguous=await(await req('state')).json();assert.equal(ambiguous.credentialPolicies['host-0139'].ambiguous,true);assert.equal(ambiguous.credentialPolicies['host-0139'].credentialCount,2);
 const refused=await req('credential',{id:'host-0139',expectedRevision:beforeHost!.revision,identityMode:'connection'});assert.equal(refused.status,400);assert.equal((await refused.json()).code,'invalid_input');assert.deepEqual(await graph.offices.agent('host-0139',admin),beforeHost,'refusal must not disable a working host');assert.equal(await fs.readFile(configPath,'utf8'),privateConfig,'refusal must preserve every existing grant');
 // Host edits must invalidate role/chat views even without a new role event.
 const directoryBefore=await graph.roles.registry(admin);
 const changingHost=await graph.offices.agent('host-0139',admin);
 await graph.offices.configureAgent({...changingHost,expectedRevision:changingHost!.revision,name:'Renamed host',state:'disabled'},admin);
 const hostChanged:any=await graph.roles.state(admin,directoryBefore.revision,{},directoryBefore.directoryRevision);
 assert(!hostChanged.unchanged,'renaming/disabling a host must refresh linked role/chat labels');
 assert.equal(hostChanged.chats[0].connector_name,'Renamed host');assert.equal(hostChanged.chats[0].host_state,'disabled');
 const next=await req('state',{directoryThrough:{roles:state.characters.directory.roles.nextCursor,offices:state.directory.offices.nextCursor}});assert.equal(next.status,200);const expanded=await next.json();assert.equal(expanded.characters.roles.length,100);assert.equal(expanded.offices.length,100);
 assert.equal((await req('state',{directoryThrough:{roles:42}})).status,400);
 // Expired activation requests must update even without a new role event.
 const before=await graph.roles.registry(admin);await db.run('UPDATE role_connection_requests SET last_seen=?',[clock-86400001]);
 const expired:any=await graph.roles.state(admin,before.revision,{},before.directoryRevision);assert(!expired.unchanged);assert.equal(expired.directory.connections.total,0);
 console.log('PASS production directories: complete counts, expandable windows, stable insert/delete, all selector references, exact off-page configuration/credential grants, selected room existence, expiry and authorization');
}finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await graph.close();await fs.rm(dir,{recursive:true,force:true});}
