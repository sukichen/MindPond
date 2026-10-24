/** Role location, attention and knowledge authority are distinct. Exercise the
 * real independent Office/Memory HTTP MCPs across their complete transitions. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {GraphMemory} from '../src/core/graph-memory.js';
import {createNetworkMcpApp} from '../src/integrations/network-server.js';
import {tokenDigest} from '../src/integrations/network-config.js';

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-transitions-'));
const oldMode=process.env.MINDPOND_EMBEDDING_MODE;process.env.MINDPOND_EMBEDDING_MODE='text';
const graph=new GraphMemory('.',{dbPath:path.join(directory,'fixture.db')});
const admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const token=randomBytes(32).toString('base64url'),clients:Client[]=[];
let network:ReturnType<typeof createNetworkMcpApp>|undefined,listener:any;
try{
 await graph.init();const db=(graph as any).db;
 await graph.offices.configureAgent({id:'host',principal:'human',name:'Synthetic host',host:'generic-http-mcp',state:'active',expectedRevision:0},admin);
 const hosts=['127.0.0.1'];network=createNetworkMcpApp(graph,{allowedHosts:hosts,configuration:async()=>({version:2,grants:[{principal:'human',agentId:'host',credentialId:'host',tokenHash:tokenDigest(token),domains:[],toolProfile:'office' as const}]})});
 listener=network.app.listen(0,'127.0.0.1');await new Promise<void>(r=>listener.once('listening',r));const base='http://127.0.0.1:'+listener.address().port;hosts.push(new URL(base).host);
 async function connect(endpoint:string){const client=new Client({name:'synthetic-transition',version:'1'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(base+endpoint),{requestInit:{headers:{Authorization:'Bearer '+token}}}));return client;}
 const office=await connect('/mcp'),memory=await connect('/memory/mcp');
 const raw=(client:Client,name:string,args:any={},chat='worker')=>client.callTool({name,arguments:args,_meta:{threadId:chat}});
 async function call(client:Client,name:string,args:any={},chat='worker'){const result:any=await raw(client,name,args,chat);assert(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);}
 async function deny(client:Client,name:string,args:any,chat='worker'){const result:any=await raw(client,name,args,chat);assert(result.isError,'Expected denial: '+name);const error=JSON.parse(result.content[0].text).error;assert(['scope_denied','not_found','invalid_input'].includes(error.code),JSON.stringify(result));return error;}
 const roles:any[]=[];
 for(const chat of ['worker','peer','outside']){const app=await call(office,'role_application',{action:'submit',name:'Synthetic '+chat,introduction:'Transition fixture',reason:'User authorized test',key:'apply'},chat);roles.push(await graph.roles.review({applicationId:app.applicationId,expectedRevision:1,action:'approve'},admin));}
 const seats=(prefix:string)=>roles.slice(0,2).map((r,n)=>({id:prefix+'-'+n,roleId:r.roleId,label:'Duty '+n,role:'member'}));
 for(const id of ['a','b'])await graph.roles.configureOffice({id,title:'Office '+id,state:'active',expectedRevision:0,seats:seats(id)},admin);
 const own=await call(memory,'memory_save',{content:'Private worker technique',idempotencyKey:'own'});
 const peer=await call(memory,'memory_save',{content:'Peer private sentinel',idempotencyKey:'peer'},'peer');
 const human=await call(memory,'memory_save',{content:'Human private sentinel',idempotencyKey:'human'},'unbound');
 const sharedA=await call(memory,'memory_save',{officeId:'a',content:'Office A rule',idempotencyKey:'a'});
 const sharedB=await call(memory,'memory_save',{officeId:'b',content:'Office B task',idempotencyKey:'b'});
 await graph.memoryOwners.setPolicy(sharedA.id,true,0);
 const knowledge=async(chat='worker')=>{
  const identity=await call(memory,'memory_identity',{},chat);assert.equal(identity.owner.id,roles[0].roleId);assert.deepEqual(identity.offices.map((o:any)=>o.id),['a','b']);
  for(const node of [own,sharedA,sharedB])assert.equal((await call(memory,'memory_get',{nodeId:node.id},chat)).id,node.id);
  await deny(memory,'memory_get',{nodeId:peer.id},chat);await deny(memory,'memory_get',{nodeId:human.id},chat);
 };
 await knowledge();
 const prior=await call(office,'office_message',{action:'send',officeId:'a',recipient:roles[0].roleId,body:'Work taken before the meeting',key:'prior'},'peer');
 await call(office,'office_message',{action:'take',messageId:prior.messageId,key:'prior-take'});
 const mail=await call(office,'office_message',{action:'send',officeId:'a',recipient:roles[0].roleId,body:'Work waits at the desk',key:'pending'},'peer');
 const create=(officeId:string,key:string)=>({action:'create',officeId,title:'Focused '+key,question:'Verify one transition',doneWhen:'Record one verified result',participants:[roles[1].roleId],key});
 const roomA=await call(office,'office_discussion',create('a','first'));
 assert.equal((await call(office,'role_sync')).discussions.active.id,roomA.room.id);
 assert.equal((await graph.building.snapshot('a',admin)).meetings[0].members.find((r:any)=>r.roleId===roles[0].roleId).state,'joined');
 await call(office,'office_discussion',{action:'join',id:roomA.room.id},'peer');
 await knowledge();
 const locked=await call(memory,'memory_get',{nodeId:sharedA.id});await deny(memory,'memory_update',{nodeId:sharedA.id,expectedUpdatedAt:locked.updatedAt,content:'Must preserve human rule',reason:'Forbidden change'});
 const b=await call(memory,'memory_get',{nodeId:sharedB.id});await call(memory,'memory_update',{nodeId:sharedB.id,expectedUpdatedAt:b.updatedAt,content:'Office B verified progress',reason:'Already authorized member knowledge'});
 await deny(office,'office_receive',{action:'take',key:'meeting-take'});
 await call(office,'office_message',{action:'finish',messageId:prior.messageId,result:'Verified before entering discussion; explicitly finished now',key:'prior-finish'});
 assert.equal((await call(office,'office_message',{action:'get',messageId:mail.messageId})).message.state,'pending');
 const feedback=await call(office,'office_receive',{action:'list',state:'pending'},'peer');assert(feedback.messages.some((r:any)=>r.kind==='completion'&&r.replyTo===prior.messageId));
 assert.equal((await call(office,'office_message',{action:'get',messageId:prior.messageId})).message.state,'archived');
 await call(office,'office_discussion',{action:'post',id:roomA.room.id,body:'Selected conclusion only',key:'a-post'});
 const selected=await call(memory,'memory_save',{officeId:'a',content:'Verified reusable conclusion independent of the room',idempotencyKey:'conclusion'});
 await call(office,'office_discussion',{action:'export',id:roomA.room.id,memoryId:selected.id});
 await call(office,'office_discussion',{action:'leave',summary:'Regression summary: checked the current state; no additional notification.',key:randomUUID(),id:roomA.room.id});
 const left=await call(office,'office_discussion',{action:'get',id:roomA.room.id});assert.equal(left.invitation,'left');assert.deepEqual(left.posts,[]);
 await deny(office,'office_discussion',{action:'post',id:roomA.room.id,body:'Not joined',key:'left'});await deny(office,'office_discussion',{action:'wait',id:roomA.room.id,waitMs:100});
 await knowledge();
 const roomB=await call(office,'office_discussion',create('b','second'));
 await deny(office,'office_discussion',{action:'join',id:roomB.room.id},'peer');
 await call(office,'office_discussion',{action:'leave',summary:'Regression summary: checked the current state; no additional notification.',key:randomUUID(),id:roomA.room.id},'peer');await call(office,'office_discussion',{action:'join',id:roomB.room.id},'peer');
 const waiting=call(office,'office_discussion',{action:'wait',id:roomB.room.id,afterSeq:0,waitMs:2000});
 await new Promise(r=>setTimeout(r,100));const closing=await call(office,'office_discussion',{action:'get',id:roomB.room.id});
 await call(office,'office_discussion',{action:'close',summary:'Regression summary: checked the current state; no additional notification.',key:randomUUID(),id:roomB.room.id,expectedRevision:closing.room.revision});
 const ended=await waiting;assert.equal(ended.status,'terminal');assert.equal(ended.closed,true);assert(!ended.post);
 assert.equal((await call(office,'role_sync')).discussions.active,null);await knowledge();
 await call(office,'office_message',{action:'take',messageId:mail.messageId,key:'back-at-desk'});
 await call(office,'office_message',{action:'finish',messageId:mail.messageId,result:'Completed after leaving the meeting',key:'desk-finish'});
 assert.equal((await call(memory,'memory_get',{nodeId:selected.id})).id,selected.id);
 console.log('PASS meeting transitions: one focus, explicit join/leave, ordinary mail deferred, prior work can finish with feedback, knowledge scope/locks independent of physical position and close wakes wait without claiming task completion');

 await call(memory,'memory_action',{tool:'memory_continuity_task',arguments:{officeId:'a',key:'office-a-task',reason:'Before office move',task:{id:'a-task',expectedRevision:0,title:'Office A unfinished task',status:'doing',progress:'Recorded evidence',nextSteps:[],blockers:[],sources:[]}}});
 await call(memory,'memory_action',{tool:'memory_continuity_task',arguments:{key:'role-task',reason:'Role-owned work',task:{id:'role-task',expectedRevision:0,title:'Private role next step',status:'todo',progress:'Pending',nextSteps:[],blockers:[],sources:[]}}});
 const revokedRoom=await call(office,'office_discussion',create('a','before-removal'));
 // Leaving an office changes permission. Merely entering/leaving meetings did not.
 await graph.roles.configureOffice({id:'a',title:'Office a',state:'active',expectedRevision:1,seats:[seats('a')[1]]},admin);
 const identity=await call(memory,'memory_identity');assert.deepEqual(identity.offices.map((o:any)=>o.id),['b']);
 assert.equal((await call(office,'role_sync')).discussions.active,null);
 assert.equal((await db.get('SELECT state FROM office_discussion_members WHERE room_id=? AND role_id=?',[revokedRoom.room.id,roles[0].roleId])).state,'left','actual office removal releases the role focus');
 assert((await db.get('SELECT revision FROM office_discussions WHERE id=?',[revokedRoom.room.id])).revision>revokedRoom.room.revision,'automatic departure must update the observable discussion version');
 for(const node of [sharedA,selected])await deny(memory,'memory_get',{nodeId:node.id});
 await deny(memory,'memory_save',{officeId:'a',content:'Cannot write after removal',idempotencyKey:'revoked'});
 await deny(office,'office_discussion',{action:'get',id:roomA.room.id});
 await deny(office,'office_message',{action:'send',officeId:'a',recipient:roles[1].roleId,body:'Cannot send in a former office',key:'revoked'});
 assert.equal((await call(memory,'memory_get',{nodeId:own.id})).id,own.id);assert.equal((await call(memory,'memory_get',{nodeId:sharedB.id})).id,sharedB.id);
 const working=JSON.stringify(await call(memory,'memory_resume'));assert(!working.includes('a-task'));assert(working.includes('role-task'));
 // Addressed correspondence remains role history; membership does not erase a receipt.
 assert.equal((await call(office,'office_message',{action:'get',messageId:mail.messageId})).message.state,'archived');
 const direct=await call(office,'office_message',{action:'send',recipient:roles[2].roleId,body:'Explicit direct correspondence',key:'direct'});
 assert.equal((await call(office,'office_message',{action:'get',messageId:direct.messageId},'outside')).message.officeId,null);
 await deny(office,'office_message',{action:'send',officeId:'b',recipient:roles[2].roleId,body:'Not an office member',key:'outside'});
 console.log('PASS office removal: former shared memories/tasks/discussions/sends revoked immediately; private role knowledge and addressed history preserved; direct correspondence is explicit');

 await call(office,'role_sync',{},'replacement');const registry=await graph.roles.registry(admin),role=registry.roles.find((r:any)=>r.id===roles[0].roleId)!;
 const target=registry.chats.find((r:any)=>r.native_chat_id==='replacement')!;
 const pending=raw(office,'office_wait',{waitMs:2000,afterSeq:999999}).then(r=>r);
 await new Promise(r=>setTimeout(r,100));await graph.roles.connect({roleId:role.id,expectedRevision:role.revision,targetRuntimeId:target.runtime_id},admin);
 const interrupted:any=await pending;assert(interrupted.isError,'an in-flight role wait must not survive a binding change');
 const resumed=await call(memory,'memory_identity',{},'replacement');assert.equal(resumed.owner.id,role.id);assert.deepEqual(resumed.offices.map((o:any)=>o.id),['b']);
 assert.equal((await call(memory,'memory_get',{nodeId:own.id},'replacement')).id,own.id);await deny(memory,'memory_get',{nodeId:sharedA.id},'replacement');
 assert.equal((await call(memory,'memory_identity')).owner.kind,'user','the explicitly unbound former chat is human by the product contract');
 assert.equal((await call(memory,'memory_get',{nodeId:peer.id},'unbound')).id,peer.id,'identified unbound human chats still see all knowledge');
 // A role, rather than its harness/chat, owns discussion participation too.
 const handoffRoom=await call(office,'office_discussion',create('b','handoff-focus'),'replacement');
 await call(office,'role_sync',{},'second-replacement');const beforeSecond=await graph.roles.registry(admin),movingRole=beforeSecond.roles.find((r:any)=>r.id===role.id)!;
 const movingTarget=beforeSecond.chats.find((r:any)=>r.native_chat_id==='second-replacement')!;
 const discussionWait=raw(office,'office_discussion',{action:'wait',id:handoffRoom.room.id,afterSeq:0,waitMs:2000},'replacement');
 await new Promise(r=>setTimeout(r,100));await graph.roles.connect({roleId:movingRole.id,expectedRevision:movingRole.revision,targetRuntimeId:movingTarget.runtime_id},admin);
 assert((await discussionWait).isError,'discussion waits must not outlive their role binding');
 assert.equal((await call(office,'role_sync',{},'second-replacement')).discussions.active.id,handoffRoom.room.id,'the new chat restores the role discussion focus');
 assert.equal((await call(memory,'memory_get',{nodeId:own.id},'second-replacement')).id,own.id);await deny(memory,'memory_get',{nodeId:sharedA.id},'second-replacement');
 const lastRoom=await call(office,'office_discussion',{action:'get',id:handoffRoom.room.id},'second-replacement');
 await call(office,'office_discussion',{action:'close',summary:'Regression summary: checked the current state; no additional notification.',key:randomUUID(),id:handoffRoom.room.id,expectedRevision:lastRoom.room.revision},'second-replacement');
 // A bound role outside every office remains that role, never a human fallback.
 await graph.roles.configureOffice({id:'b',title:'Office b',state:'active',expectedRevision:1,seats:[seats('b')[1]]},admin);
 const outsideIdentity=await call(memory,'memory_identity',{},'second-replacement');assert.equal(outsideIdentity.owner.kind,'agent');assert.equal(outsideIdentity.owner.id,role.id);assert.deepEqual(outsideIdentity.offices,[]);
 assert.equal((await call(memory,'memory_get',{nodeId:own.id},'second-replacement')).id,own.id);await deny(memory,'memory_get',{nodeId:sharedB.id},'second-replacement');await deny(memory,'memory_get',{nodeId:human.id},'second-replacement');
 const outsideSave=await call(memory,'memory_save',{content:'Role-owned lesson outside every office',idempotencyKey:'outside-all'},'second-replacement');assert.equal(outsideSave.owner.id,role.id);
 assert(JSON.stringify(await call(memory,'memory_resume',{},'second-replacement')).includes('role-task'));
 assert(await graph.getNodeById(selected.id));assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]);
 console.log('PASS chat handoff: pending role wait loses authority, the same role resumes private/current-office knowledge on the target, and identified unbound human access remains available');
}finally{
 await Promise.allSettled(clients.map(c=>c.close()));await network?.close(listener);await graph.close();await fs.rm(directory,{recursive:true,force:true});
 if(oldMode===undefined)delete process.env.MINDPOND_EMBEDDING_MODE;else process.env.MINDPOND_EMBEDDING_MODE=oldMode;
}
