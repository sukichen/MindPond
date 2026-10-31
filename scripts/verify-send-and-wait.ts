/** Synthetic SQLite + actual MCP handlers. No real hosts, models or production data. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {performance} from 'node:perf_hooks';
import express from 'express';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {GraphMemory} from '../src/core/graph-memory.js';import {roleRuntimeId} from '../src/core/roles.js';
import {createMemoryMcpServer} from '../src/mcp-service.js';import {officeWorkbench} from '../src/integrations/office-workbench.js';import {MindPondError} from '../src/core/errors.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-send-wait-')),file=path.join(dir,'fixture.db');
const graph=new GraphMemory('.',{dbPath:file}),peer=new GraphMemory('.',{dbPath:file}),admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const actor=(chat:string)=>({v:1 as const,principal:'human',agentId:'host',runtimeId:roleRuntimeId('human','host','codex',chat),runtimeMode:'codex_metadata' as const,nativeChatId:chat,transport:'http-mcp' as const,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER});
let service:ReturnType<typeof createMemoryMcpServer>|undefined,client:Client|undefined,http:any,authorized=true,passed=0;let drainInbox=async()=>{};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const until=async(fn:()=>Promise<any>,ms=2000)=>{const start=performance.now();while(performance.now()-start<ms){const r=await fn();if(r)return r;await sleep(15);}throw Error('Fixture condition timed out');};
const test=async(name:string,run:()=>Promise<void>)=>{try{await drainInbox();await run();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name,e);throw e;}};
const rejects=(run:()=>Promise<unknown>,code:string)=>assert.rejects(run,(e:any)=>{assert.equal(e.code,code,e.message);assert(e.nextAction);return true;});
try{
 await graph.init();await graph.offices.configureAgent({id:'host',principal:'human',name:'Synthetic host',host:'generic',state:'active',expectedRevision:0},admin);
 const roles=[];for(const name of ['a','b','c']){const p=await graph.roles.application({action:'submit',name:'Synthetic '+name,introduction:'Fictional test role',reason:'Send-wait regression',key:'apply'},actor(name));roles.push((await graph.roles.review({action:'approve',applicationId:p.applicationId,expectedRevision:1},admin)).roleId);}
 await graph.roles.configureOffice({id:'room',title:'Fixture room',state:'active',expectedRevision:0,seats:roles.map((roleId,n)=>({id:'seat-'+n,roleId,label:'Fixture',role:'member'}))},admin);
 await peer.init();const db=(graph as any).db;
 service=createMemoryMcpServer(graph,{trusted:actor('a'),authorizeWait:async()=>{if(!authorized)throw new MindPondError('scope_denied','Synthetic credential revoked');}});client=new Client({name:'send-wait-fixture',version:'1'});const [s,c]=InMemoryTransport.createLinkedPair();await Promise.all([service.server.connect(s),client.connect(c)]);
 const raw=(args:any)=>client!.callTool({name:'office_message',arguments:args,_meta:{threadId:'a'}},undefined,{timeout:10000});
 const call=async(args:any)=>{let r:any=await raw(args);assert(!r.isError,JSON.stringify(r));let value=JSON.parse(r.content[0].text);if(value.paged){let text='',offset=0;do{const page:any=await client!.callTool({name:'office_context',arguments:{action:'page',id:value.id,offset},_meta:{threadId:'a'}});assert(!page.isError);const part=JSON.parse(page.content[0].text);text+=part.text;if(part.nextOffset===null)break;offset=part.nextOffset;}while(true);r=JSON.parse(text);value=JSON.parse(r.content[0].text);}return value;};
 drainInbox=async()=>{for(const state of ['pending','processing']){const page=await graph.building.receive({action:'list',state,limit:20},actor('a'));for(const m of page.messages){if(m.state==='pending')await graph.building.message({action:'take',messageId:m.id,key:'cleanup-take-'+m.id},actor('a'));await graph.building.message({action:'finish',messageId:m.id,result:'Fixture cleanup',key:'cleanup-finish-'+m.id},actor('a'));}}};
 const setMin=async(minimumSeconds:number)=>{const current=await graph.building.replyWaitPolicy.get();return graph.building.replyWaitPolicy.manage({action:'set',minimumSeconds,expectedRevision:current.revision},admin);};
 const send=(key:string,extra:any={})=>({action:'send',recipient:roles[1],body:'Synthetic '+key,key,...extra});
 const originalFor=(key:string)=>db.get('SELECT * FROM role_messages WHERE sender=? AND body=?',[roles[0],'Synthetic '+key]);
 await test('schema/semantic errors send nothing; ordinary sends still return immediately',async()=>{
  const tools=(await client!.listTools()).tools.find(t=>t.name==='office_message')!;assert(tools.inputSchema.properties?.waitForReply);assert(tools.inputSchema.properties?.waitSeconds);
  const count=(await db.get('SELECT count(*) n FROM role_messages')).n;
  for(const i of [send('bad-duration',{waitForReply:true,waitSeconds:0}),send('needs-opt-in',{waitSeconds:1}),send('too-long',{waitForReply:true,waitSeconds:301}),{action:'get',messageId:'absent',waitForReply:true}]){const r:any=await raw(i);assert(r.isError);assert.equal((await db.get('SELECT count(*) n FROM role_messages')).n,count);}
  const start=performance.now(),sent=await call(send('ordinary',{waitForReply:false}));assert(performance.now()-start<1000);assert(sent.messageId);assert.equal(sent.replyWait,undefined);
  await rejects(()=>graph.building.messageWithReplyWait({...send('bad-recipient'),recipient:'missing',waitForReply:true,waitSeconds:1},actor('a')),'invalid_input');assert.equal((await db.get('SELECT count(*) n FROM role_message_waits')).n,0);
 });
 await test('real lower-bound window ignores other recipients; same connection stays available for other roles',async()=>{
  await setMin(3);let settled=false;const start=performance.now(),waiting=call(send('floor',{waitForReply:true,waitSeconds:1})).finally(()=>{settled=true;});const original=await until(()=>originalFor('floor'));
  await graph.building.message({action:'send',recipient:roles[1],body:'Mail to another recipient',key:'unrelated'},actor('c'));await sleep(300);assert(!settled,'mail addressed to another role must not end waiting');
  const observed=await graph.building.receive({action:'list'},actor('b'));assert(observed.messages.some((m:any)=>m.id===original.id),'receiver can use same graph while sender waits');
  const result=await waiting;assert(performance.now()-start>=2900);assert.equal(result.replyWait.status,'timeout');assert.equal(result.replyWait.requestedSeconds,1);assert.equal(result.replyWait.effectiveSeconds,3);assert.equal(result.replyWait.minimumApplied,true);assert.equal(result.sent,true);assert.equal((await db.get('SELECT count(*) n FROM role_messages WHERE sender=? AND body=?',[roles[0],'Synthetic floor'])).n,1);
 });
 await test('an early internal timeout cannot violate the human minimum window',async()=>{
  await setMin(1);const original=graph.building.wait.bind(graph.building);let attempts=0;(graph.building as any).wait=async(...args:any[])=>{attempts++;return attempts===1?{status:'timeout',nextCursor:0}:(original as any)(...args);};
  const start=performance.now();try{const result=await call(send('early-timeout',{waitForReply:true,waitSeconds:1}));assert.equal(result.replyWait.status,'timeout');assert(performance.now()-start>=990);assert(attempts>=2);}finally{(graph.building as any).wait=original;await setMin(3);}
 });
 await test('linked reply returns before minimum with complete body and processing state; invitations alone do not wake',async()=>{
  const invitation=await graph.discussions.run({action:'create',officeId:'room',title:'Separate topic',question:'Invite only',doneWhen:'A decision',participants:[roles[0]],key:'invitation'},actor('c'));
  const start=performance.now();let settled=false;const waiting=call(send('linked',{waitForReply:true,waitSeconds:1})).finally(()=>{settled=true;});const original=await until(()=>originalFor('linked'));await sleep(100);assert(!settled,'invitation is not feedback');
  const reply=await peer.building.message({action:'send',replyTo:original.id,body:'Linked feedback',key:'linked-answer'},actor('b'));const result=await waiting;assert(performance.now()-start<2600);assert.equal(result.replyWait.status,'matched');assert.equal(result.replyWait.message.id,reply.messageId);assert.equal(result.receivedMessageId,reply.messageId);assert.equal(result.replyWait.message.body,'Linked feedback');assert.equal(result.replyWait.message.complete,true);assert.equal(result.replyWait.isReplyToSentMessage,true);assert.equal((await graph.building.message({action:'get',messageId:reply.messageId},actor('a'))).message.state,'processing');
  const room=await graph.discussions.run({action:'get',id:invitation.room.id},admin);await graph.discussions.run({action:'close',id:invitation.room.id,expectedRevision:room.room.revision},admin);
 });
 await test('taking is not feedback; finishing generates a linked result and reports current original state',async()=>{
  let settled=false;const waiting=call(send('completion',{waitForReply:true,waitSeconds:1})).finally(()=>{settled=true;});const original=await until(()=>originalFor('completion'));
  await graph.building.message({action:'take',messageId:original.id,key:'take'},actor('b'));await sleep(100);assert(!settled);await peer.building.message({action:'finish',messageId:original.id,result:'Verified fixture result',key:'finish'},actor('b'));
  const result=await waiting;assert.equal(result.state,'archived');assert.equal(result.replyWait.message.kind,'completion');assert.equal(result.replyWait.message.body,'Verified fixture result');
 });
 await test('any new inbox message returns complete content without get/page and does not pretend to complete the original request',async()=>{
  const text='🦆'.repeat(9990)+' important end';const pending=raw(send('full-inbox',{waitForReply:true,waitSeconds:1}));await until(()=>originalFor('full-inbox'));
  const incoming=await graph.building.message({action:'send',recipient:roles[0],body:text,metadata:{context:'Fictional complete message'},key:'full-inbox-message'},actor('c'));
  const result:any=await pending;assert(!result.isError);const value=JSON.parse(result.content[0].text);assert(!value.paged);assert.equal(value.receivedMessageId,incoming.messageId);assert.equal(value.replyWait.message.body,text);assert.equal(value.replyWait.message.metadata.context,'Fictional complete message');assert.deepEqual(value.replyWait.message.sourceRef,(await graph.building.message({action:'get',messageId:incoming.messageId},actor('a'))).sourceRef);assert.equal(value.replyWait.message.state,'processing');assert.equal(value.replyWait.message.complete,true);assert.equal(value.replyWait.isReplyToSentMessage,false);assert.equal(value.replyWait.wakeReason,'incoming_message');assert.equal(value.state,'pending');
 });
 await test('lost-response retry recovers processing delivery; archived work is not redelivered and send never duplicates',async()=>{
  const original=await originalFor('floor'),reply=await graph.building.message({action:'send',replyTo:original.id,body:'Late feedback',key:'late'},actor('b'));
  const first=await call(send('floor',{waitForReply:true,waitSeconds:2}));assert.equal(first.receivedMessageId,reply.messageId);assert.equal(first.replyWait.message.state,'processing');
  const retried=await call(send('floor',{waitForReply:true,waitSeconds:1}));assert.equal(retried.receivedMessageId,reply.messageId);assert.equal(retried.replyWait.message.body,'Late feedback');
  await graph.building.message({action:'finish',messageId:reply.messageId,result:'Reviewed',key:'finish-late'},actor('a'));
  const next=await graph.building.message({action:'send',recipient:roles[0],body:'Next new work',key:'next-new'},actor('c'));const again=await call(send('floor',{waitForReply:true,waitSeconds:1}));assert.equal(again.receivedMessageId,next.messageId);assert.equal(again.replyWait.isReplyToSentMessage,false);assert.equal((await call(send('floor'))).messageId,original.id);
  assert.equal((await db.get('SELECT count(*) n FROM role_messages WHERE sender=? AND body=?',[roles[0],'Synthetic floor'])).n,1);
 });
 await test('concurrent distinct sends atomically claim distinct new work; duplicate send retries recover one delivery',async()=>{
  const one=call(send('parallel-one',{waitForReply:true,waitSeconds:1})),two=call(send('parallel-two',{waitForReply:true,waitSeconds:1}));await until(async()=>await originalFor('parallel-one')&&await originalFor('parallel-two'));
  const sources=await Promise.all([graph.building.message({action:'send',recipient:roles[0],body:'First parallel work',key:'parallel-in-1'},actor('b')),peer.building.message({action:'send',recipient:roles[0],body:'Second parallel work',key:'parallel-in-2'},actor('c'))]);
  const results=await Promise.all([one,two]);assert.equal(new Set(results.map(r=>r.receivedMessageId)).size,2);assert(results.every(r=>sources.some(s=>s.messageId===r.receivedMessageId)));assert(results.every(r=>r.replyWait.message.state==='processing'));
  for(const result of results)await graph.building.message({action:'finish',messageId:result.receivedMessageId,result:'Parallel fixture done',key:'parallel-done-'+result.receivedMessageId},actor('a'));
  const same1=call(send('parallel-same',{waitForReply:true,waitSeconds:1})),same2=call(send('parallel-same',{waitForReply:true,waitSeconds:1}));await until(()=>originalFor('parallel-same'));
  const single=await graph.building.message({action:'send',recipient:roles[0],body:'One recoverable delivery',key:'parallel-single'},actor('b'));const same=await Promise.all([same1,same2]);assert(same.every(r=>r.receivedMessageId===single.messageId));assert.equal((await db.get('SELECT count(*) n FROM role_messages WHERE sender=? AND body=?',[roles[0],'Synthetic parallel-same'])).n,1);
 });
 await test('cancellation after inbox discovery leaves new work pending and unclaimed',async()=>{
  const abort=new AbortController(),original=graph.building.wait.bind(graph.building);
  (graph.building as any).wait=async(...args:any[])=>{const result=await (original as any)(...args);if(result.status==='matched')abort.abort();return result;};
  try{const pending=graph.building.messageWithReplyWait(send('cancel-before-take',{waitForReply:true,waitSeconds:1}),actor('a'),{signal:abort.signal});await until(()=>originalFor('cancel-before-take'));const incoming=await graph.building.message({action:'send',recipient:roles[0],body:'Do not claim after cancellation',key:'cancel-inbox'},actor('b'));const result=await pending;assert.equal(result.replyWait.status,'cancelled');assert.equal(result.receivedMessageId,undefined);assert.equal((await graph.building.message({action:'get',messageId:incoming.messageId},actor('a'))).message.state,'pending');}finally{(graph.building as any).wait=original;}
 });
 await test('five-minute policy is used even for 10 seconds; cancellation preserves the committed send',async()=>{
  await setMin(300);const abort=new AbortController(),waiting=graph.building.messageWithReplyWait(send('five-minute',{waitForReply:true,waitSeconds:10}),actor('a'),{signal:abort.signal});
  const original=await until(()=>originalFor('five-minute')),record=await until(()=>db.get("SELECT * FROM role_message_waits WHERE role_id=? AND state='waiting' ORDER BY started_at DESC LIMIT 1",[roles[0]]));assert(record.expires_at-record.started_at>=299000);assert.equal(JSON.parse(record.conditions).purpose,'sent_message_inbox');const recovery=(await graph.roles.sync(actor('a'))).waitRecovery.find((w:any)=>w.id===record.id);assert.equal(recovery.sentMessageId,original.id);assert.equal(recovery.sendKey,'five-minute');assert.equal(recovery.resume.replyTo,undefined,'inbox recovery must not silently narrow to linked replies');
  abort.abort();const result=await waiting;assert.equal(result.messageId,original.id);assert.equal(result.sent,true);assert.equal(result.replyWait.status,'cancelled');assert.equal(result.replyWait.effectiveSeconds,300);
 });
 await test('user stop and active discussion interrupt without treating work as a reply; joined roles cannot send',async()=>{
  const waiting=call(send('stop',{waitForReply:true,waitSeconds:1}));await until(()=>originalFor('stop'));const control=await peer.officeCollaboration.requestControl({roleId:roles[0],action:'stop',reason:'Synthetic stop'},admin);const result=await waiting;assert.equal(result.replyWait.status,'control');assert.equal(result.replyWait.controlRequests[0].id,control.id);await graph.officeCollaboration.host({action:'ack',requestId:control.id,outcome:'acknowledged',evidence:'Fixture stopped'},actor('a'));
  const room=await graph.discussions.run({action:'create',officeId:'room',title:'Focus',question:'Synthetic focus',doneWhen:'Conclude',participants:[roles[1]],key:'focus'},actor('a'));
  const count=(await db.get('SELECT count(*) n FROM role_messages')).n;await rejects(()=>graph.building.messageWithReplyWait(send('blocked-in-room',{waitForReply:true,waitSeconds:1}),actor('a')),'scope_denied');assert.equal((await db.get('SELECT count(*) n FROM role_messages')).n,count);
  const current=await graph.discussions.run({action:'get',id:room.room.id},admin);await graph.discussions.run({action:'close',id:room.room.id,expectedRevision:current.room.revision},admin);
 });
 await test('wait-time credential revocation returns an accurate sent receipt and no reply body',async()=>{
  const pending=raw(send('revoked',{waitForReply:true,waitSeconds:1}));const original=await until(()=>originalFor('revoked'));authorized=false;const result:any=await pending;authorized=true;assert(result.isError);const error=JSON.parse(result.content[0].text).error;assert.equal(error.code,'scope_denied');assert.equal(error.details.sent,true);assert.equal(error.details.messageId,original.id);assert(error.nextAction.includes('key'));
 });
 await test('a failure after handler completion also reports sent=true instead of an ambiguous send failure',async()=>{
  const message=await call(send('post-check')),reply=await graph.building.message({action:'send',replyTo:message.messageId,body:'Private post-check reply',key:'post-reply'},actor('b'));
  const original=graph.building.messageWithReplyWait.bind(graph.building);(graph.building as any).messageWithReplyWait=async(...args:any[])=>{const result=await (original as any)(...args);authorized=false;return result;};
  try{const result:any=await raw(send('post-check',{waitForReply:true,waitSeconds:1}));assert(result.isError);const error=JSON.parse(result.content[0].text).error;assert.equal(error.details.sent,true);assert.equal(error.details.messageId,message.messageId);assert(!JSON.stringify(error).includes('Private post-check reply'));}finally{authorized=true;(graph.building as any).messageWithReplyWait=original;}
  assert((await graph.building.message({action:'get',messageId:reply.messageId},actor('a'))).message);
 });
 await test('policy is human-only, CAS-protected, idempotent and visible across SQLite processes',async()=>{
  await rejects(()=>graph.building.replyWaitPolicy.manage({action:'set',minimumSeconds:1,expectedRevision:0},actor('a')),'scope_denied');
  const old=await peer.building.replyWaitPolicy.get(),input={action:'set',minimumSeconds:4,expectedRevision:old.revision};const changed=await peer.building.replyWaitPolicy.manage(input,admin);assert.equal((await graph.building.replyWaitPolicy.get()).minimumSeconds,4);assert.equal((await peer.building.replyWaitPolicy.manage(input,admin)).replayed,true);await rejects(()=>graph.building.replyWaitPolicy.manage({...input,minimumSeconds:5},admin),'stale_version');assert.equal(changed.maximumSeconds,300);assert.equal(changed.toolTimeoutSeconds,360);
 });
 await test('HTTP management requires login and returns policy in the normal state snapshot',async()=>{
  const app=express();app.use('/api/office-admin',express.json(),officeWorkbench(graph,{apiKey:'',operatorKey:'fixture-user',contextSecret:''}));http=app.listen(0,'127.0.0.1');await new Promise<void>(r=>http.once('listening',r));const base='http://127.0.0.1:'+http.address().port+'/api/office-admin/';let cookie='';const post=(route:string,body:any)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
  assert.equal((await post('reply-wait-policy',{action:'get'})).status,401);const login=await post('login',{operatorKey:'fixture-user'});cookie=login.headers.get('set-cookie')!.split(';')[0];const state=await post('state',{});assert.equal(state.status,200);assert.equal((await state.json() as any).replyWaitPolicy.minimumSeconds,4);
  assert.equal((await post('reply-wait-policy',{action:'set',minimumSeconds:301,expectedRevision:0})).status,400);assert.equal((await post('reply-wait-policy',{action:'get',minimumSeconds:0})).status,400);
 });
 assert.equal((await db.all('PRAGMA foreign_key_check')).length,0);assert.equal((await db.get('SELECT count(*) n FROM office_wait_queue')).n,0);
 console.log('PASS '+passed+' send-and-wait scenarios; three-second floor measured in real time, five-minute window recorded and interrupted deliberately');
}finally{authorized=true;await client?.close();await service?.close();if(http)await new Promise<void>(r=>http.close(()=>r()));await peer.close();await graph.close();await fs.rm(dir,{recursive:true,force:true});}
