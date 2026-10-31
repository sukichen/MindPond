import express from 'express';
/** Real HTTP MCP, human control plane and isolated SQLite; no external dependencies. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {GraphMemory} from '../src/core/graph-memory.js';
import {getEmbeddingService} from '../src/core/embedding.js';
import {createNetworkMcpApp} from '../src/integrations/network-server.js';
import {officeWorkbench} from '../src/integrations/office-workbench.js';
import {tokenDigest} from '../src/integrations/network-config.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-office-resources-')),file=path.join(dir,'fixture.db');
const graph=new GraphMemory('.',{dbPath:file}),admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const token=randomBytes(32).toString('base64url'),embedding=getEmbeddingService(),generate=embedding.generateEmbedding;
embedding.generateEmbedding=async()=>[1,...Array(383).fill(0)];
let listener:any,network:ReturnType<typeof createNetworkMcpApp>|undefined,workbench:ReturnType<typeof officeWorkbench>|undefined,reopened:GraphMemory|undefined;const clients:Client[]=[];
try{
 await graph.init();const db=(graph as any).db;
 await graph.offices.configureAgent({id:'fixture-host',principal:'human',name:'Fixture Codex',host:'codex',state:'active',expectedRevision:0},admin);
 const hosts=['127.0.0.1'];network=createNetworkMcpApp(graph,{allowedHosts:hosts,maxPerAccount:20,configuration:async()=>({version:2,grants:[{principal:'human',agentId:'fixture-host',credentialId:'fixture-host',tokenHash:tokenDigest(token),domains:[],toolProfile:'office' as const}]})});
 workbench=officeWorkbench(graph,{apiKey:'',operatorKey:'fixture-control',contextSecret:''});const app=express();app.use('/api/office-admin',express.json({limit:'1mb'}),workbench);app.use(network.app);
 listener=app.listen(0,'127.0.0.1');await new Promise<void>(r=>listener.once('listening',r));const base='http://127.0.0.1:'+listener.address().port;hosts.push(new URL(base).host);
 const client=new Client({name:'fixture-office',version:'1'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
 const raw=(name:string,args:any={},chat='a')=>client.callTool({name,arguments:args,_meta:{threadId:chat}});
 const call=async(name:string,args:any={},chat='a')=>{const r:any=await raw(name,args,chat);assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
 const deny=async(name:string,args:any,code:string,chat='a')=>{const r:any=await raw(name,args,chat);assert(r.isError,JSON.stringify(r));let parsed;try{parsed=JSON.parse(r.content[0].text);}catch{assert.equal(code,'invalid_input');assert.match(r.content[0].text,/validat|unrecognized|unknown|argument/i);return;}assert.equal(parsed.error.code,code,JSON.stringify(r));};
 const roles:any[]=[];
 for(const chat of ['a','b','c','outside']){const app=await call('role_application',{action:'submit',name:'Fixture '+chat,introduction:'Reusable verified work only',reason:'Resources regression',key:'apply'},chat);roles.push(await graph.roles.review({applicationId:app.applicationId,expectedRevision:1,action:'approve'},admin));}
 const seats=roles.slice(0,3).map((r,i)=>({id:'seat-'+i,roleId:r.roleId,label:'Duty '+i,role:'member'}));
 const tools=(await client.listTools()).tools.map(t=>t.name);assert(tools.includes('office_discussion')&&tools.includes('office_script'));assert(!tools.some(n=>n.startsWith('memory_')),'Office never reintroduces Memory read/write tools');
 const script={action:'save',filename:'check-env.py',language:'Python 3',description:'Verify a fictional environment',usage:'Review source and run only in the authorized project. No installation required.',content:'print("合成源码🙂")\n'.repeat(1300),expectedRevision:0,key:'private-script'};
 const saved=await call('office_script',script);assert.equal((await call('office_script',script)).id,saved.id);
 assert.equal((await call('office_script',{action:'list'},'b')).scripts.length,0);
 await deny('office_script',{action:'get',id:saved.id},'not_found','b');await deny('office_script',{...script,key:'spoof',roleId:roles[0].roleId},'invalid_input','b');
 await deny('office_script',{...script,key:'traversal',filename:'../escape.py'},'invalid_input');await deny('office_script',{...script,key:'reserved',filename:'NUL.py'},'invalid_input');
 let offset:any=0,source='';do{const page=await call('office_script',{action:'get',id:saved.id,offset,characters:257,expectedRevision:1});assert(!/[\uD800-\uDBFF]$/.test(page.content));source+=page.content;offset=page.nextOffset;}while(offset!==null);
 assert.equal(source,script.content);assert.equal(createHash('sha256').update(source).digest('hex'),saved.sha256);
 const disposable={...script,key:'deleted-script',content:'echo disposable\n'},deleted=await call('office_script',disposable);
 await call('office_script',{action:'delete',id:deleted.id,expectedRevision:1});
 await deny('office_script',disposable,'not_found');
 await deny('office_script',{...disposable,id:deleted.id,key:'reuse-deleted-id'},'not_found');
 assert(!(await call('office_script',{action:'list'})).scripts.some((r:any)=>r.id===deleted.id),'lost-response retry must not resurrect deleted scripts');
 await deny('office_script',{action:'get',id:saved.id,offset:20},'invalid_input');
 const edited=await Promise.all(['first','second'].map(key=>raw('office_script',{...script,id:saved.id,expectedRevision:1,key,content:'print("'+key+'")\n'})));assert.equal(edited.filter((r:any)=>!r.isError).length,1);
 await deny('office_script',{action:'get',id:saved.id,offset:20,expectedRevision:1},'stale_version');
 console.log('PASS role-private scripts need no office: save/list/get/edit/delete, peer isolation, versioned downloads and retries all work before office creation');
 await graph.roles.configureOffice({id:'room',title:'Fixture office',state:'active',expectedRevision:0,seats},admin);
 await graph.roles.configureOffice({id:'outside-room',title:'Another office',state:'active',expectedRevision:0,seats:[{id:'outside-seat',roleId:roles[3].roleId,label:'Outside',role:'member'}]},admin);
 const shared=await call('office_script',{...script,officeId:'room',key:'shared',content:'echo fixture-only\n',filename:'verify.sh',language:'POSIX sh'});
 assert.equal((await call('office_script',{action:'get',officeId:'room',id:shared.id},'b')).content,'echo fixture-only\n');await deny('office_script',{action:'get',officeId:'room',id:shared.id},'scope_denied','outside');
 await deny('office_script',{...script,id:saved.id,key:'collision',expectedRevision:0},'not_found','b');
 await graph.scripts.run({...script,officeId:'room',id:shared.id,key:'lock',expectedRevision:1,locked:true,content:'echo fixture-only\n',filename:'verify.sh',language:'POSIX sh'},admin);
 await deny('office_script',{action:'delete',officeId:'room',id:shared.id,expectedRevision:2},'scope_denied','b');
 await deny('office_script',{...script,locked:false,key:'unlock'},'scope_denied');
 console.log('PASS script libraries: MCP discovery, role/office isolation, safe names, complete Unicode downloads/SHA-256, CAS, idempotency, foreign ID fencing and human locks');

 await deny('office_message',{action:'send',officeId:'room',recipient:roles[3].roleId,body:'Must not cross office membership',key:'outside-office-recipient'},'scope_denied');
 const mail=await call('office_message',{action:'send',officeId:'room',recipient:roles[0].roleId,body:'Ordinary work stays at the seat',key:'ordinary'},'b');
 const create={action:'create',officeId:'room',title:'Resolve one fixture question',question:'Private temporary question sentinel',doneWhen:'Two participants agree on a verified next step',participants:[roles[1].roleId],key:'meeting'};
 const room=await call('office_discussion',create);const roomId=room.room.id;await deny('office_discussion',{action:'get',id:roomId,officeId:'outside-room'},'not_found');await deny('office_discussion',{action:'wait',id:roomId,officeId:'outside-room',waitMs:100},'not_found');await deny('office_discussion',{action:'close',summary:'Regression summary: checked the current state; no additional notification.',key:randomUUID(),id:roomId,officeId:'outside-room',expectedRevision:room.room.revision},'not_found');assert.equal((await call('office_discussion',create)).room.id,roomId);
 const facility=await graph.building.snapshot('room',admin),facilityDelta=await graph.building.snapshot('room',admin,facility.revision);
 assert.equal(facilityDelta.unchanged,true);assert.equal(facilityDelta.meetings[0].id,roomId);assert.equal(facilityDelta.activity.find((r:any)=>r.roleId===roles[0].roleId).discussionId,roomId);assert.equal(facilityDelta.meetings[0].members.find((m:any)=>m.roleId===roles[1].roleId).state,'invited');assert(!JSON.stringify(facilityDelta.meetings).includes(create.question),'scene metadata must not include temporary transcript/question bodies');
 assert.equal((await call('role_sync')).discussions.active.id,roomId);assert.equal((await graph.building.snapshot('room',admin)).activity.find((r:any)=>r.roleId===roles[0].roleId).discussionTitle,create.title);assert.equal((await call('role_sync',{},'b')).discussions.invitations[0].id,roomId);
 const inviteWake=await call('office_wait',{waitMs:30000},'b');assert.equal(inviteWake.status,'discussion');assert.equal(inviteWake.wakeReason,'discussion_invitation');assert.equal(inviteWake.requestedWaitMs,30000);assert(inviteWake.elapsedMs<5000);assert(inviteWake.nextAction.includes('join or decline'));assert.equal(inviteWake.discussions.active,null,'wait never joins an invitation');
 const focusWake=await call('office_wait',{waitMs:30000});assert.equal(focusWake.wakeReason,'active_discussion');assert.equal(focusWake.nextCall.tool,'office_discussion');assert.deepEqual(focusWake.nextCall.arguments,{action:'get',id:roomId});assert(focusWake.elapsedMs<5000);assert(!focusWake.pending&&!focusWake.resume,'discussion focus must not masquerade as a resumable mailbox timeout');
 await deny('office_receive',{action:'take',key:'must-wait'},'invalid_input');await deny('office_message',{action:'take',messageId:mail.messageId,key:'must-wait'},'invalid_input');
 assert.equal((await call('office_receive',{action:'list'})).messages.find((m:any)=>m.id===mail.messageId).state,'pending');
 const firstPost=await call('office_discussion',{action:'post',id:roomId,body:'Private temporary post sentinel',key:'post'});
 assert.equal((await call('office_discussion',{action:'get',id:roomId},'b')).posts.length,0,'invited roles must join before reading posts');
 await deny('office_discussion',{action:'post',id:roomId,body:'Not joined',key:'no'},'scope_denied','b');
 await deny('office_discussion',{action:'get',id:roomId},'not_found','c');await deny('office_discussion',{action:'wait',id:roomId,waitMs:100},'not_found','c');assert.equal((await call('office_discussion',{action:'list',officeId:'room'},'c')).rooms.length,0);
 await deny('office_discussion',{action:'get',id:roomId},'scope_denied','outside');
 await call('office_discussion',{action:'join',id:roomId},'b');
 let finished=false;const waiting=call('office_discussion',{action:'wait',id:roomId,afterSeq:firstPost.seq,waitMs:3000}).then(r=>{finished=true;return r;});await new Promise(r=>setTimeout(r,150));assert(!finished,'discussion wait must stay open instead of returning unchanged attention');
 await call('office_discussion',{action:'post',id:roomId,body:'Verified next step sentinel',key:'peer-post'},'b');const matched=await waiting;assert.equal(matched.status,'matched');assert.equal(matched.post.body,'Verified next step sentinel');assert.equal(matched.post.processingState,'unprocessed');assert.equal((await call('office_discussion',{action:'finish',id:roomId,postSeqs:[matched.post.seq]})).member.unprocessedPosts,0,'a post delivered by wait can be explicitly handled');assert.equal((await graph.building.snapshot('room',admin)).meetings[0].members.find((m:any)=>m.roleId===roles[1].roleId).unprocessedPosts,1,'posting a reply does not implicitly acknowledge the sender’s retrieved work');
 const parallel=await call('office_discussion',{...create,participants:[roles[1].roleId],title:'Independent question',key:'parallel'},'c');
 await deny('office_discussion',{action:'join',id:parallel.room.id},'invalid_input','b');
 await call('office_discussion',{action:'leave',summary:'Regression summary: checked the current state; no additional notification.',key:randomUUID(),id:roomId},'b');await call('office_discussion',{action:'join',id:parallel.room.id},'b');
 await call('office_discussion',{action:'leave',summary:'Regression summary: checked the current state; no additional notification.',key:randomUUID(),id:parallel.room.id},'b');await call('office_discussion',{action:'join',id:roomId},'b');assert((await call('office_discussion',{action:'get',id:roomId},'b')).posts.length);await call('office_discussion',{action:'leave',summary:'Regression summary: checked the current state; no additional notification.',key:randomUUID(),id:roomId},'b');await call('office_discussion',{action:'join',id:parallel.room.id},'b');
 const stale=await call('office_discussion',{action:'get',id:roomId});
 const domain=await graph.memoryOwners.domain({kind:'office',id:'room'}),memory=await graph.saveMemory('A selected verified conclusion, independent of the temporary transcript',{domain});
 await call('office_discussion',{action:'export',id:roomId,memoryId:memory.id});
 await deny('office_discussion',{action:'close',summary:'Regression summary: checked the current state; no additional notification.',key:randomUUID(),id:roomId,expectedRevision:stale.room.revision},'stale_version');
 const unrelated=await graph.officeCollaboration.boundResponse({content:[{type:'text',text:'Unrelated response sentinel '.repeat(400)}]},2048,admin);
 const unrelatedId=JSON.parse(unrelated.content[0].text).id;assert(unrelatedId);
 const current=await call('office_discussion',{action:'get',id:roomId});await call('office_discussion',{action:'close',summary:'Regression summary: checked the current state; no additional notification.',key:randomUUID(),id:roomId,expectedRevision:current.room.revision});
 assert((await graph.officeCollaboration.responsePage({id:unrelatedId,characters:100},admin)).text.includes('Unrelated response sentinel'),'closing one discussion must not invalidate unrelated response pages');
 assert.equal((await db.get('SELECT COUNT(*) n FROM office_discussion_posts WHERE room_id=?',[roomId])).n,0);assert.equal((await db.get('SELECT COUNT(*) n FROM office_discussion_exports WHERE room_id=?',[roomId])).n,0);
 assert(await graph.getNodeById(memory.id));assert.equal((await call('office_discussion',create)).closed,true,'retrying create must not resurrect deleted content');
 for(const table of ['role_events','memory_action_log','office_response_pages']){const rows=JSON.stringify(await db.all('SELECT * FROM '+table));assert(!rows.includes('Private temporary question sentinel')&&!rows.includes('Private temporary post sentinel'),'transcripts must not leak into durable logs/caches');}
 const taken=await call('office_receive',{action:'take',key:'after-meeting'});assert(taken.messages.some((m:any)=>m.id===mail.messageId));
 console.log('PASS discussions: explicit join, invited/outsider privacy, five-minute-capable real waiting, parallel rooms/one focus, deferred ordinary mail, memory export, CAS close and physical content/cache deletion');

 const login=await fetch(base+'/api/office-admin/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({operatorKey:'fixture-control'})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0];
 const manage=async(route:string,args:any,origin=base,auth=true)=>{const r=await fetch(base+'/api/office-admin/'+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(auth?{Cookie:cookie}:{})},body:JSON.stringify(args)});return {status:r.status,body:await r.json() as any};};
 assert.equal((await manage('scripts',{action:'list',roleId:roles[0].roleId},base,false)).status,401);assert.equal((await manage('scripts',{action:'list',roleId:roles[0].roleId},'https://foreign.invalid')).status,403);
 assert.equal((await manage('scripts',{action:'list',roleId:roles[0].roleId})).body.scripts[0].id,saved.id);
 const meeting=await call('office_discussion',{action:'get',id:parallel.room.id},'c');
 const conclusion=await manage('discussion-memory',{id:parallel.room.id,expectedRevision:meeting.room.revision,content:'Human-reviewed fixture conclusion',key:'human-conclusion'});assert.equal(conclusion.status,200,JSON.stringify(conclusion));assert.equal((await graph.getNodeById(conclusion.body.memoryId))!.domain.id,domain.id);
 const retry=await manage('discussion-memory',{id:parallel.room.id,expectedRevision:meeting.room.revision,content:'Human-reviewed fixture conclusion',key:'human-conclusion'});assert.equal(retry.status,200,JSON.stringify(retry));assert.equal(retry.body.memoryId,conclusion.body.memoryId,'lost-response retry must return the same conclusion');
 assert.equal((await manage('discussion-memory',{id:parallel.room.id,expectedRevision:meeting.room.revision,content:'Changed payload',key:'human-conclusion'})).body.code,'idempotency_conflict');
 const concurrentRevision=(await call('office_discussion',{action:'get',id:parallel.room.id},'c')).room.revision;
 const concurrent=await Promise.all([1,2].map(()=>manage('discussion-memory',{id:parallel.room.id,expectedRevision:concurrentRevision,content:'Concurrent exact conclusion',key:'k'.repeat(256)})));assert(concurrent.every(r=>r.status===200),JSON.stringify(concurrent));assert.equal(concurrent[0].body.memoryId,concurrent[1].body.memoryId);
 const closing=await call('office_discussion',{...create,key:'close-during-save'});
 let begin!:()=>void,release!:()=>void;const started=new Promise<void>(r=>begin=r),released=new Promise<void>(r=>release=r),stub=embedding.generateEmbedding;
 embedding.generateEmbedding=async content=>{if(content==='Close-race conclusion'){begin();await released;}return stub.call(embedding,content);};
 try{
  const pending=manage('discussion-memory',{id:closing.room.id,expectedRevision:closing.room.revision,content:'Close-race conclusion',key:'close-race'});
  await started;await call('office_discussion',{action:'close',summary:'Regression summary: checked the current state; no additional notification.',key:randomUUID(),id:closing.room.id,expectedRevision:closing.room.revision});release();assert.equal((await pending).body.code,'not_found');
  assert.equal((await db.get('SELECT COUNT(*) n FROM nodes WHERE content=?',['Close-race conclusion'])).n,0,'closing during embedding must roll back the selected memory and its receipt');
 }finally{release();embedding.generateEmbedding=stub;}
 console.log('PASS human routes: authenticated/CSRF fenced script management and selected independent office-memory export');

 // More than one attention page must never hide focus or bypass ordinary-mail priority.
 await call('office_discussion',{action:'leave',summary:'Regression summary: checked the current state; no additional notification.',key:randomUUID(),id:parallel.room.id},'c');
 for(let n=0;n<5;n++){
  const officeId='busy-office-'+n;
  await graph.roles.configureOffice({id:officeId,title:'Invitation load fixture '+n,state:'active',expectedRevision:0,seats:[{id:'busy-a-'+n,roleId:roles[0].roleId,label:'A',role:'member'},{id:'busy-c-'+n,roleId:roles[2].roleId,label:'C',role:'member'}]},admin);
  for(let k=0;k<14;k++){const r=await call('office_discussion',{...create,officeId,participants:[roles[0].roleId],key:'invite-'+n+'-'+k},'c');await call('office_discussion',{action:'leave',summary:'Regression summary: checked the current state; no additional notification.',key:randomUUID(),id:r.room.id},'c');}
 }
 const focused=await call('office_discussion',{...create,key:'focus-after-invitations'});
 assert.equal((await call('role_sync',{responseBudgetBytes:65536})).discussions.active.id,focused.room.id,'invitation limit must not hide an active discussion');
 await deny('office_receive',{action:'take',key:'overloaded-focus'},'invalid_input');
 await call('office_discussion',{action:'close',summary:'Regression summary: checked the current state; no additional notification.',key:randomUUID(),id:focused.room.id,expectedRevision:focused.room.revision});
 const visibleInvite=await call('office_discussion',{...create,participants:[roles[0].roleId],key:'visible-after-hidden-invites'},'c');
 const bound=await db.get("SELECT * FROM role_bindings WHERE role_id=? AND state='active'",[roles[0].roleId]);
 const unfiltered=await db.all("SELECT r.id FROM office_discussion_members m JOIN office_discussions r ON r.id=m.room_id WHERE m.role_id=? AND m.state IN ('joined','invited') ORDER BY (m.state='joined') DESC,r.created_at,r.id LIMIT 66",[roles[0].roleId]);assert(!unfiltered.some((r:any)=>r.id===visibleInvite.room.id),'the original unfiltered window must actually exclude the permitted invitation in this fixture');
 const narrowAttention=await graph.discussions.attention({v:1,principal:bound.principal,agentId:bound.connector_id,runtimeId:bound.runtime_id,roleId:bound.role_id,roleBindingId:bound.id,roleBindingEpoch:bound.epoch,assignmentIds:['seat-0'],transport:'http-mcp',issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER});
 assert(narrowAttention.invitations.some((r:any)=>r.id===visibleInvite.room.id),'inaccessible invitations cannot fill the preview window and hide accessible invitations');
 await call('office_discussion',{action:'close',summary:'Regression summary: checked the current state; no additional notification.',key:randomUUID(),id:visibleInvite.room.id,expectedRevision:visibleInvite.room.revision},'c');
 for(let n=0;n<5;n++)await graph.roles.deleteOffice({id:'busy-office-'+n,expectedRevision:1},admin);
 console.log('PASS high invitation volume: active focus remains visible and ordinary mail stays deferred');

 const identity=(await call('role_sync')).identity;const roleNow=(await graph.roles.registry(admin)).roles.find((r:any)=>r.id===roles[0].roleId)!;const credential=await graph.memoryOwners.issue(roleNow.id);
 await call('role_application',{action:'submit',name:'Pending target fixture',introduction:'Native target already observed',reason:'Pending application must not hide the chat',key:'new-app'},'new-target');
 let registry=await graph.roles.registry(admin);assert(registry.chats.some((c:any)=>c.native_chat_id==='a'&&c.role_id===roleNow.id));assert(registry.chats.some((c:any)=>c.native_chat_id==='new-target'&&!c.role_id));
 await assert.rejects(graph.roles.disconnect({roleId:roleNow.id,expectedRevision:999,bindingId:identity.bindingId},admin),(e:any)=>e.code==='stale_version');
 const disconnect=await manage('role/disconnect',{roleId:roleNow.id,expectedRevision:roleNow.revision,bindingId:identity.bindingId});assert.equal(disconnect.status,200);assert.equal(await graph.memoryOwners.credential(credential.token),null);
 assert.equal((await call('role_sync')).identity,null);assert.equal((await call('role_sync')).activation.state,'disconnected');
 registry=await graph.roles.registry(admin);let detached=registry.roles.find((r:any)=>r.id===roleNow.id)!;assert.equal(detached.connection,null);
 const native=registry.chats.find((c:any)=>c.native_chat_id==='new-target');
 const linked=await manage('role/connect',{roleId:roleNow.id,expectedRevision:detached.revision,targetRuntimeId:native.runtime_id});assert.equal(linked.status,200,JSON.stringify(linked));
 assert.equal((await call('role_sync',{},'new-target')).identity.roleId,roleNow.id);assert.equal((await call('office_script',{action:'get',id:saved.id},'new-target')).script.role_id,roleNow.id);
 const regAfter=await graph.roles.registry(admin);detached=regAfter.roles.find((r:any)=>r.id===roleNow.id)!;assert(!regAfter.pending.some((p:any)=>p.native_chat_id==='new-target'));
 await assert.rejects(graph.roles.connect({roleId:roleNow.id,expectedRevision:detached.revision,targetRuntimeId:regAfter.chats.find((c:any)=>c.native_chat_id==='b').runtime_id},admin),(e:any)=>e.code==='invalid_input');
 console.log('PASS connections: native sessions visible including occupied/pending chats, explicit disconnect/CAS, credential revocation, no automatic reapplication, and identity/script continuity on a different observed chat');

 await graph.roles.configureOffice({id:'room',title:'Fixture office',state:'active',expectedRevision:1,seats:[seats[2]]},admin);
 const detachedScript=await call('office_script',{action:'get',id:saved.id},'new-target');assert.equal(detachedScript.script.role_id,roleNow.id);assert.equal(detachedScript.script.office_id,null);
 const detachedEdit=await call('office_script',{...script,id:saved.id,expectedRevision:detachedScript.script.revision,key:'edit-after-office-exit',content:'print("Role-private without an office")\n'},'new-target');assert.equal(detachedEdit.revision,detachedScript.script.revision+1);
 await deny('office_script',{action:'get',officeId:'room',id:shared.id},'scope_denied','new-target');await deny('office_discussion',{action:'get',id:parallel.room.id},'scope_denied','b');
 await graph.roles.configureOffice({id:'outside-room',title:'Another office',state:'active',expectedRevision:1,seats:[{id:'outside-seat',roleId:roles[3].roleId,label:'Outside',role:'member'},{id:'moved-b-seat',roleId:roles[1].roleId,label:'New duty',role:'member'}]},admin);
 const movedFocus=await call('office_discussion',{...create,officeId:'outside-room',participants:[roles[3].roleId],key:'moved-focus'},'b');assert(movedFocus.room.id,'moving offices must release an inaccessible old focus even without role_sync');await call('office_discussion',{action:'leave',summary:'Regression summary: checked the current state; no additional notification.',key:randomUUID(),id:movedFocus.room.id},'b');assert.equal((await call('role_sync',{},'b')).discussions.active,null);
 await db.run('UPDATE office_discussions SET expires_at=? WHERE id=?',[Date.now()-1,parallel.room.id]);assert(!(await graph.building.snapshot('room',admin)).meetings.some((r:any)=>r.id===parallel.room.id),'expired rooms leave the scene even before the cleanup timer');await graph.discussions.sweep();assert.equal((await db.get('SELECT COUNT(*) n FROM office_discussion_posts WHERE room_id=?',[parallel.room.id])).n,0);
 reopened=new GraphMemory('.',{dbPath:file});await reopened.init();assert.equal((await reopened.scripts.run({action:'list',roleId:roleNow.id},admin)).scripts[0].id,saved.id);assert.equal((await db.get('PRAGMA quick_check')).quick_check,'ok');assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]);
 await reopened.close();reopened=undefined;
 await graph.roles.deleteOffice({id:'room',expectedRevision:2},admin);assert.equal((await db.get('SELECT COUNT(*) n FROM office_scripts WHERE office_id=?',['room'])).n,0);assert(await graph.getNodeById(memory.id));
 const afterOfficeDeletion=await call('office_script',{action:'get',id:saved.id},'new-target');assert.equal(afterOfficeDeletion.content,'print("Role-private without an office")\n');assert((await call('office_script',{action:'list'},'new-target')).scripts.some((r:any)=>r.id===saved.id));
 console.log('PASS leaving/deleting an office preserves private role scripts and editing access; switching chats preserves the same role-owned library');
 const deleting=(await graph.roles.registry(admin)).roles.find((r:any)=>r.id===roleNow.id)!;await graph.roles.deleteRole({roleId:roleNow.id,expectedRevision:deleting.revision},admin);assert.equal((await db.get('SELECT COUNT(*) n FROM office_scripts WHERE role_id=?',[roleNow.id])).n,0);assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]);
 console.log('PASS revocation, expiry cleanup, restart, scoped deletion cascades, independent memory retention and SQLite integrity');
}finally{for(const c of clients)await c.close();(workbench as any)?.closeObservers?.();await network?.close();if(listener)await new Promise<void>(r=>listener.close(r));await reopened?.close();await graph.close();embedding.generateEmbedding=generate;await fs.rm(dir,{recursive:true,force:true});}
