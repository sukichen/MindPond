/** Real HTTP MCP requests with isolated roles, simultaneous rooms and human controls. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {GraphMemory} from '../src/core/graph-memory.js';
import {createNetworkMcpApp} from '../src/integrations/network-server.js';
import {officeWorkbench} from '../src/integrations/office-workbench.js';
import {tokenDigest} from '../src/integrations/network-config.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-discussion-lifecycle-'));
const graph=new GraphMemory('.',{dbPath:path.join(dir,'fixture.db')}),token=randomBytes(32).toString('base64url');
const admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
let network:ReturnType<typeof createNetworkMcpApp>|undefined,server:any,client:Client|undefined;
try{
 await graph.init();const db=(graph as any).db;
 await graph.offices.configureAgent({id:'host',principal:'human',name:'Synthetic host',host:'codex',state:'active',expectedRevision:0},admin);
 const hosts=['127.0.0.1'];network=createNetworkMcpApp(graph,{allowedHosts:hosts,configuration:async()=>({version:2,grants:[{principal:'human',agentId:'host',credentialId:'host',tokenHash:tokenDigest(token),domains:[],toolProfile:'office' as const}]})});
 const app=express();app.use('/api/office-admin',express.json(),officeWorkbench(graph,{apiKey:'',operatorKey:'fixture-control',contextSecret:''}));app.use(network.app);
 server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;hosts.push(new URL(base).host);
 client=new Client({name:'synthetic-lifecycle',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
 const raw=(args:any,chat='a',name='office_discussion')=>client!.callTool({name,arguments:args,_meta:{threadId:chat}});
 const call=async(args:any,chat='a',name='office_discussion')=>{const r:any=await raw(args,chat,name);assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
 const denied=async(args:any,chat:string,code='scope_denied')=>{const r:any=await raw(args,chat);assert(r.isError,JSON.stringify(r));const e=JSON.parse(r.content[0].text).error;assert.equal(e.code,code);assert(e.message&&e.nextAction);return e;};
 const roles:any[]=[];for(const chat of ['a','b','c','d','e']){const application=await call({action:'submit',name:'Synthetic '+chat,introduction:'Lifecycle fixture',reason:'Verify room isolation',key:'apply'},chat,'role_application');roles.push(await graph.roles.review({action:'approve',applicationId:application.applicationId,expectedRevision:1},admin));}
 await graph.roles.configureOffice({id:'office',title:'Synthetic office',state:'active',expectedRevision:0,seats:roles.map((r,i)=>({id:'seat-'+i,roleId:r.roleId,label:'Member '+i,role:'member'}))},admin);
 const create=(key:string,participants:string[])=>({action:'create',officeId:'office',title:key,question:'One independent question',doneWhen:'Verified conclusion',participants,key});
 const first=(await call(create('first',[roles[1].roleId,roles[4].roleId]))).room.id;
 await call({action:'join',id:first},'b');
 const second=(await call(create('second',[roles[3].roleId]),'c')).room.id;
 await call({action:'join',id:second},'d');
 const snapshots=()=>graph.building.snapshot('office',admin);
 const ids=async()=>((await snapshots()).meetings as any[]).map(r=>r.id).sort();
 assert.deepEqual(await ids(),[first,second].sort());
 const before=await db.all('SELECT * FROM office_discussions ORDER BY id');
 const invited=await denied({action:'close',id:first,expectedRevision:1,key:'invite-close',summary:'Cannot close from an invitation'},'e');assert.match(invited.message,/currently joined/i);
 await denied({action:'close',id:first,expectedRevision:1,key:'unrelated-close',summary:'Cannot close another room'},'c','not_found');
 assert.deepEqual(await db.all('SELECT * FROM office_discussions ORDER BY id'),before,'denied closes must not change either room');
 // A rejected invitation and ordinary office correspondence cannot end either meeting.
 assert.equal((await call({action:'decline',id:first},'e')).closed,false);
 await call({action:'send',officeId:'office',recipient:roles[0].roleId,body:'Ordinary work stays at the desk',key:'outside-mail'},'e','office_message');
 assert.deepEqual(await ids(),[first,second].sort());
 const incremental=await snapshots(),unchanged=await graph.building.snapshot('office',admin,incremental.revision);assert.equal(unchanged.unchanged,true);assert.equal(unchanged.meetings.length,2,'unchanged snapshots still carry all simultaneous rooms');
 // The creator leaves and starts another room; it loses closing authority over the first.
 await call({action:'leave',id:first,summary:'Hand over the first discussion to B',key:'leave-first'});
 const third=(await call(create('third',[roles[4].roleId]))).room.id;
 const revision=(await call({action:'get',id:first},'b')).room.revision;
 const exits=(await db.get('SELECT count(*) n FROM office_discussion_departures')).n;
 const outside=await denied({action:'close',id:first,expectedRevision:revision,key:'outside-creator-close',summary:'Must not delete another discussion',messages:[{recipient:roles[4].roleId,body:'Must not send'}]},'a');assert.equal(outside.details.membership,'left');
 assert.equal((await db.get('SELECT count(*) n FROM office_discussion_departures')).n,exits,'outside close cannot create an exit batch');
 assert.equal((await call({action:'get',id:first},'b')).room.revision,revision);
 assert.deepEqual(await ids(),[first,second,third].sort());
 // A noncreator who is still inside may close, with summary, CAS and current lock policy.
 const lock=await graph.discussions.setLock({id:first,locked:true,expectedLockRevision:1},admin);
 const locked=await denied({action:'close',id:first,expectedRevision:lock.revision,key:'locked-close',summary:'Wait for human unlock'},'b');assert.match(locked.message,/locked/i);
 const unlock=await graph.discussions.setLock({id:first,locked:false,expectedLockRevision:lock.lockRevision},admin);
 await denied({action:'close',id:first,expectedRevision:revision,key:'stale-close',summary:'Use current version'},'b','stale_version');
 await denied({action:'close',id:first,expectedRevision:unlock.revision,key:'no-summary'},'b','invalid_input');
 assert.equal((await call({action:'close',id:first,expectedRevision:unlock.revision,key:'close-first',summary:'B verified the conclusion; no follow-up notification'},'b')).closed,true);
 assert.deepEqual(await ids(),[second,third].sort());assert.equal((await call({},'c','role_sync')).discussions.active.id,second);
 assert.equal((await db.get('SELECT count(*) n FROM office_discussion_posts WHERE room_id=?',[first])).n,0);
 console.log('PASS simultaneous rooms, invited/unrelated/departed creator denial, deferred ordinary work, noncreator participant close with lock/CAS/summary and other rooms unchanged');
 // Last outside decline must not silently delete an empty, still-recoverable room.
 await call({action:'leave',id:third,summary:'Wait for the invited colleague',key:'leave-third'});
 assert.equal((await call({action:'decline',id:third},'e')).closed,false);
 assert.equal((await call({action:'decline',id:third},'e')).closed,false,'repeated decline remains harmless');
 await denied({action:'close',id:third,expectedRevision:1,key:'declined-close',summary:'Still outside'},'e');
 assert.deepEqual(await ids(),[second,third].sort());
 await call({action:'join',id:third},'e');
 assert.equal((await call({action:'leave',id:third,summary:'Final participant recorded the result',key:'final-leave'},'e')).closed,true,'only an actual participant exit may auto-close a room with no remaining invitees');
 assert.deepEqual(await ids(),[second]);
 // Human management can still close a locked room, without impersonating an attendee.
 const lastLock=await graph.discussions.setLock({id:second,locked:true,expectedLockRevision:1},admin);
 const login=await fetch(base+'/api/office-admin/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({operatorKey:'fixture-control'})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0];
 const closed=await fetch(base+'/api/office-admin/discussions',{method:'POST',headers:{'Content-Type':'application/json',Origin:base,Cookie:cookie},body:JSON.stringify({action:'close',id:second,expectedRevision:lastLock.revision})});assert.equal(closed.status,200);assert.equal((await closed.json() as any).closed,true);
 assert.deepEqual(await ids(),[]);assert.equal((await db.get('PRAGMA quick_check')).quick_check,'ok');assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]);
 console.log('PASS outside last-decline retention, explicit rejoin/final exit, human locked-room close and database integrity');
}finally{await client?.close();await network?.close();if(server)await new Promise<void>(r=>server.close(r));await graph.close();await fs.rm(dir,{recursive:true,force:true});}
