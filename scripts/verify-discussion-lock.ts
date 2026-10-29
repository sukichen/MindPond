/** Real MCP roles and human HTTP controls, isolated SQLite and deterministic expiry. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {GraphMemory} from '../src/core/graph-memory.js';
import {roleRuntimeId} from '../src/core/roles.js';
import {createNetworkMcpApp} from '../src/integrations/network-server.js';
import {officeWorkbench} from '../src/integrations/office-workbench.js';
import {tokenDigest} from '../src/integrations/network-config.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-discussion-lock-')),file=path.join(dir,'fixture.db');
let now=Date.now();const graph=new GraphMemory('.',{dbPath:file,clock:()=>now});
const admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER},token=randomBytes(32).toString('base64url');
let server:any,network:ReturnType<typeof createNetworkMcpApp>|undefined,client:Client|undefined,peer:GraphMemory|undefined;
try{
 await graph.init();const db=(graph as any).db;
 await graph.offices.configureAgent({id:'host',principal:'human',name:'Synthetic host',host:'codex',state:'active',expectedRevision:0},admin);
 const allowedHosts=['127.0.0.1'];network=createNetworkMcpApp(graph,{allowedHosts,configuration:async()=>({version:2,grants:[{principal:'human',agentId:'host',credentialId:'host',tokenHash:tokenDigest(token),domains:[],toolProfile:'office' as const}]})});
 const app=express();app.use('/api/office-admin',express.json(),officeWorkbench(graph,{apiKey:'',operatorKey:'fixture-control',contextSecret:''}));app.use(network.app);
 server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;allowedHosts.push(new URL(base).host);
 client=new Client({name:'synthetic-lock',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
 const raw=(name:string,args:any={},chat='a')=>client!.callTool({name,arguments:args,_meta:{threadId:chat}});
 const call=async(name:string,args:any={},chat='a')=>{const r:any=await raw(name,args,chat);assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
 const blocked=async(args:any,chat='a')=>{const r:any=await raw('office_discussion',args,chat);assert(r.isError,JSON.stringify(r));const error=JSON.parse(r.content[0].text).error;assert.equal(error.code,'scope_denied');assert.match(error.message,/locked/i);assert.match(error.nextAction,/human/i);return error;};
 const post=(route:string,body:any,cookie='',origin=base)=>fetch(base+'/api/office-admin/'+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie},body:JSON.stringify(body)});
 const login=await post('login',{operatorKey:'fixture-control'}),cookie=login.headers.get('set-cookie')!.split(';')[0];
 const manage=async(route:string,body:any)=>{const r=await post(route,body,cookie);assert.equal(r.status,200,await r.clone().text());return r.json() as Promise<any>;};
 const roles:any[]=[];for(const chat of ['a','b','c','d']){const p=await call('role_application',{action:'submit',name:'Synthetic '+chat,introduction:'Lock fixture',reason:'Verify human control',key:'apply'},chat);roles.push(await graph.roles.review({action:'approve',applicationId:p.applicationId,expectedRevision:1},admin));}
 const seats=roles.map((r,i)=>({id:'seat-'+i,roleId:r.roleId,label:'Member '+i,role:'member'}));await graph.roles.configureOffice({id:'office',title:'Synthetic office',state:'active',expectedRevision:0,seats},admin);
 const create=(key:string,participants:string[])=>({action:'create',officeId:'office',title:key,question:'What is verified?',doneWhen:'Verified conclusion',participants,key,ttlHours:1});
 const room=await call('office_discussion',create('first',[roles[1].roleId,roles[3].roleId])),id=room.room.id;
 assert.equal(room.room.locked,false);assert.equal(room.room.lockRevision,1);await call('office_discussion',{action:'join',id},'b');
 const oldExit={action:'leave',id,summary:'Synthetic earlier phase',key:'earlier-exit'};await call('office_discussion',oldExit);await call('office_discussion',{action:'join',id});
 const second=await call('office_discussion',create('second',[roles[0].roleId]),'c');
 const initial=await manage('discussions',{action:'get',id}),originalExpiry=initial.room.expires_at;
 // Lock policy version is independent of ordinary discussion traffic.
 const beforePost=await call('office_discussion',{action:'post',id,body:'Traffic after opening the user page',key:'traffic'});
 const waiting=call('office_discussion',{action:'wait',id,afterSeq:beforePost.seq,afterRevision:beforePost.revision,waitMs:1500},'b');
 for(let n=0;n<30;n++){if((await db.get('SELECT count(*) n FROM office_discussion_waits')).n)break;await new Promise(r=>setTimeout(r,20));}
 const input={id,locked:true,expectedLockRevision:initial.room.lockRevision};
 assert.equal((await post('discussion-lock',input)).status,401);assert.equal((await post('discussion-lock',input,cookie,'https://untrusted.example')).status,403);
 const actor={v:1 as const,principal:'human',agentId:'host',transport:'http-mcp' as const,runtimeId:roleRuntimeId('human','host','codex','a'),issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
 await assert.rejects(graph.discussions.setLock(input,actor),(e:any)=>e.code==='scope_denied');
 const locked=await manage('discussion-lock',input);assert.equal(locked.locked,true);assert.equal(locked.lockRevision,2);assert.equal((await manage('discussion-lock',input)).changed,false);
 const update=await waiting;assert.equal(update.kind,'discussion_updated');assert.equal(update.locked,true);
 assert.equal((await call('role_sync')).discussions.active.locked,true);assert.equal((await manage('discussions',{action:'list',officeId:'office'})).rooms.find((r:any)=>r.id===id).locked,true);
 const scene=await graph.building.snapshot('office',admin);assert.equal(scene.meetings.find((r:any)=>r.id===id).locked,true);
 const before=await db.get('SELECT (SELECT count(*) FROM office_discussion_posts) posts,(SELECT count(*) FROM office_discussion_departures) exits,(SELECT count(*) FROM role_messages) mail');
 await blocked({action:'leave',id,summary:'Must stay',key:'blocked-exit',messages:[{recipient:roles[2].roleId,body:'Do not send'}]});
 await blocked({action:'close',id,expectedRevision:locked.revision,summary:'Cannot close',key:'blocked-close'});
 await blocked(oldExit);await blocked({action:'join',id:second.room.id});await blocked(create('escape',[roles[2].roleId]));await blocked({action:'join',id},'d');
 assert.deepEqual(await db.get('SELECT (SELECT count(*) FROM office_discussion_posts) posts,(SELECT count(*) FROM office_discussion_departures) exits,(SELECT count(*) FROM role_messages) mail'),before,'rejected movements cannot create summaries, drafts or outgoing messages');
 assert.equal((await call('office_discussion',{action:'join',id},'b')).room.locked,true,'existing members may restore their current attendance');
 const posted=await call('office_discussion',{action:'post',id,body:'Continue useful work while locked',key:'locked-post'});const read=await call('office_discussion',{action:'get',id},'b');assert(read.posts.some((p:any)=>p.seq===posted.seq));await call('office_discussion',{action:'finish',id,postSeqs:[posted.seq]},'b');
 console.log('PASS human authentication/CSRF, lock-only CAS despite new posts, idempotent controls, MCP/scene visibility, waiter notification, no exit/replay/join/create escapes and continued discussion');
 now+=2*3600000;await graph.discussions.sweep();assert(await db.get('SELECT 1 FROM office_discussions WHERE id=?',[id]));
 assert.equal((await graph.building.snapshot('office',admin)).activity.find((s:any)=>s.roleId===roles[0].roleId).discussionId,id,'paused expiry cannot silently return avatars to desks');
 peer=new GraphMemory('.',{dbPath:file,clock:()=>now});await peer.init();assert.equal((await peer.discussions.run({action:'get',id},admin)).room.locked,true);
 const unlocked=await peer.discussions.setLock({id,locked:false,expectedLockRevision:locked.lockRevision},admin);assert.equal(unlocked.expiresAt,originalExpiry+2*3600000);
 const relocked=await peer.discussions.setLock({id,locked:true,expectedLockRevision:unlocked.lockRevision},admin);
 await assert.rejects(graph.discussions.setLock({id,locked:false,expectedLockRevision:locked.lockRevision},admin),(e:any)=>e.code==='stale_version');
 const finalUnlock=await peer.discussions.setLock({id,locked:false,expectedLockRevision:relocked.lockRevision},admin);
 await call('office_discussion',{action:'leave',id,summary:'Human released the group; result recorded',key:'permitted-exit'});assert.equal((await call('role_sync')).discussions.active,null);
 now=finalUnlock.expiresAt+1;await graph.discussions.sweep();assert.equal(await db.get('SELECT 1 FROM office_discussions WHERE id=?',[id]),undefined);
 // Human termination and real authorization changes override the attendance lock.
 const last=await call('office_discussion',create('human-close',[roles[3].roleId]),'c');const lastLock=await manage('discussion-lock',{id:last.room.id,locked:true,expectedLockRevision:1});
 const closed=await manage('discussions',{action:'close',id:last.room.id,expectedRevision:lastLock.revision});assert.equal(closed.closed,true);
 const removed=await call('office_discussion',create('human-membership',[roles[3].roleId]),'c');await manage('discussion-lock',{id:removed.room.id,locked:true,expectedLockRevision:1});
 await graph.roles.configureOffice({id:'office',title:'Synthetic office',state:'active',expectedRevision:1,seats:seats.filter(s=>s.roleId!==roles[2].roleId)},admin);assert.equal((await call('role_sync',{},'c')).discussions.active,null);
 assert.equal((await db.get('PRAGMA quick_check')).quick_check,'ok');assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]);
 console.log('PASS locked expiry pause across restart, resumed remaining lifetime, cross-connection stale unlock protection, normal summary-first exit after unlock, human close/revocation overrides and SQLite integrity');
}finally{await client?.close();await network?.close();if(server)await new Promise<void>(r=>server.close(r));await peer?.close();await graph.close();await fs.rm(dir,{recursive:true,force:true});}
