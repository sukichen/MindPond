/** Authenticated HTTP Office + Memory, two harnesses, isolated real SQLite. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {GraphMemory} from '../src/core/graph-memory.js';
import {createNetworkMcpApp} from '../src/integrations/network-server.js';
import {tokenDigest} from '../src/integrations/network-config.js';
import {roleRuntimeId} from '../src/core/roles.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-role-continuity-')),file=path.join(dir,'fixture.db');
const graph=new GraphMemory('.',{dbPath:file}),admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const tokens={codex:('fixture-codex-'.repeat(4)).slice(0,43),opencode:('fixture-opencode-'.repeat(4)).slice(0,43)};
const clients:Client[]=[];let listener:any,network:ReturnType<typeof createNetworkMcpApp>|undefined,reopened:GraphMemory|undefined;
try{
 await graph.init();const db=(graph as any).db;
 for(const host of ['codex','opencode'])await graph.offices.configureAgent({id:host,principal:'human',name:'Fictional '+host,host:host as 'codex'|'opencode',state:'active',expectedRevision:0},admin);
 const hosts=['127.0.0.1'];network=createNetworkMcpApp(graph,{allowedHosts:hosts,configuration:async()=>({version:2,grants:Object.entries(tokens).map(([agentId,token])=>({principal:'human',agentId,credentialId:agentId,tokenHash:tokenDigest(token),domains:[],toolProfile:'office' as const}))})});
 listener=network.app.listen(0,'127.0.0.1');await new Promise<void>(r=>listener.once('listening',r));const port=listener.address().port;hosts.push('127.0.0.1:'+port);
 const connect=async(host:keyof typeof tokens,memory=true)=>{const c=new Client({name:'fictional-'+host,version:'1'});clients.push(c);await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+port+(memory?'/memory/mcp':'/mcp')),{requestInit:{headers:{Authorization:'Bearer '+tokens[host]}}}));return c;};
 const memory=await connect('codex'),office=await connect('codex',false),target=await connect('opencode'),targetOffice=await connect('opencode',false);
 const raw=(name:string,args:any={},chat='worker',c=memory,host='codex')=>c.callTool({name,arguments:args,_meta:{[host==='codex'?'threadId':'ai.opencode/sessionID']:chat}});
 const call=async(name:string,args:any={},chat='worker',c=memory,host='codex')=>{const result:any=await raw(name,args,chat,c,host);assert(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);};
 const action=(tool:string,args:any={},chat='worker',c=memory,host='codex')=>call('memory_action',{tool,arguments:args},chat,c,host);
 const deny=async(tool:string,args:any,code:string,chat='worker',c=memory,host='codex')=>{const r:any=await raw('memory_action',{tool,arguments:args},chat,c,host);assert(r.isError,JSON.stringify(r));assert.equal(JSON.parse(r.content[0].text).error.code,code,JSON.stringify(r));};
 const roles=[];for(const chat of ['worker','peer']){const application=await call('role_application',{action:'submit',name:'Fictional '+chat,introduction:'Maintain the verified fixture task and preserve unfinished commitments',reason:'Continuity regression',key:'apply'},chat,office);roles.push(await graph.roles.review({applicationId:application.applicationId,expectedRevision:1,action:'approve'},admin));}
 const role=roles[0];
 const seats=roles.map((r,i)=>({id:'seat-'+i,roleId:r.roleId,label:'Member '+i,role:'member'}));await graph.roles.configureOffice({id:'room',title:'Fictional room',state:'active',expectedRevision:0,seats},admin);
 const blank=await call('memory_resume');assert.equal(blank.recordedCheckpoints,0);assert.equal(blank.activeTasks,0);assert.equal(blank.role.id,role.roleId);assert(blank.next.includes('never invent'));
 assert.equal((await call('memory_resume',{},'human')).mode,'human');assert.equal((await call('memory_directory',{},'human')).total,0);
 const summary={goal:'Finish fixture review',progress:'Checked the parser; generated files are still unverified',constraints:['Do not claim unrun checks'],nextSteps:['Inspect the generated fixture and run its local check'],blockers:['Waiting for the fixture material'],sources:[{kind:'external',uri:'repo:fixture/parser.ts',revision:'fixture-v1'}]};
 const task={id:'review-parser',expectedRevision:0,title:'Review parser',status:'doing',priority:3,progress:'Source checked; generated files not yet reviewed',nextSteps:['Run the fixture check'],sources:[]};
 const saved=await action('memory_continuity_checkpoint',{expectedRevision:0,summary,tasks:[task],key:'phase-one',reason:'Verified parser stage'});assert.equal(saved.checkpoint.revision,1);assert.equal(saved.tasks[0].revision,1);
 const resumed=await call('memory_resume');assert.equal(resumed.checkpoints[0].goal,summary.goal);assert.equal(resumed.tasks[0].id,task.id);assert.equal(resumed.tasks[0].status,'doing');assert.equal(Buffer.byteLength(JSON.stringify(resumed)),resumed.contextBudget.used);assert(resumed.contextBudget.used<=16384);
 assert.deepEqual(await action('memory_continuity_checkpoint',{expectedRevision:0,summary,tasks:[task],key:'phase-one',reason:'Verified parser stage'}),saved);
 await deny('memory_continuity_checkpoint',{expectedRevision:0,summary,key:'stale',reason:'Must not overwrite'},'stale_version');
 await deny('memory_continuity_checkpoint',{expectedRevision:1,summary:{...summary,progress:'Changed'},key:'phase-one',reason:'Changed payload'},'idempotency_conflict');
 const allNodes=(await db.get('SELECT COUNT(*) n FROM nodes')).n;assert.equal(allNodes,0,'Working state must not silently create semantic memory or transcript nodes');
 const peer=await call('memory_resume',{},'peer');assert.equal(peer.checkpoints.length,0);assert.equal(peer.tasks.length,0);
 await deny('memory_resume',{roleId:role.roleId},'invalid_input','peer');
 await deny('memory_continuity_task',{task,key:'human-spoof',reason:'No bound role'},'invalid_input','human');
 console.log('PASS exact role recovery, unbound human behavior, independent semantic memory, strict identity selectors, CAS and idempotent checkpoints');

 await deny('memory_continuity_checkpoint',{expectedRevision:1,summary:{...summary,progress:'Must roll back'},tasks:[{...task,expectedRevision:99}],key:'atomic-failure',reason:'Task conflict rolls back summary'},'stale_version');
 assert.equal((await call('memory_resume')).checkpoints[0].revision,1);
 const concurrent=await Promise.all(['a','b'].map(key=>raw('memory_action',{tool:'memory_continuity_task',arguments:{task:{...task,expectedRevision:1,progress:'Concurrent '+key},key:'concurrent-'+key,reason:'One version wins'}})));
 assert.equal(concurrent.filter((r:any)=>!r.isError).length,1);
 await deny('memory_continuity_archive',{tasks:[{id:task.id,expectedRevision:2}],key:'archive-active',reason:'Age is not completion'},'invalid_input');
 await action('memory_continuity_task',{task:{...task,expectedRevision:2,status:'done',progress:'Fixture review concluded; exact result retained'},key:'conclude',reason:'Recorded task result'});
 assert.equal((await call('memory_resume')).activeTasks,0);
 const completed=await action('memory_continuity_tasks',{state:'completed'});assert.equal(completed.records[0].status,'done');
 const archived=await action('memory_continuity_archive',{tasks:[{id:task.id,expectedRevision:3}],key:'archive-done',reason:'Keep the concluded phase out of current work'});assert(archived.tasks[0].archivedAt);
 assert.equal((await action('memory_continuity_tasks',{state:'archived'})).records[0].revision,4);
 await action('memory_continuity_task',{task:{...task,expectedRevision:4,progress:'Reopened after new evidence'},key:'reopen',reason:'New evidence requires follow-up'});assert.equal((await call('memory_resume')).activeTasks,1);
 const history=await action('memory_continuity_history',{limit:1});assert(history.nextBeforeSeq);assert((await action('memory_continuity_history',{beforeSeq:history.nextBeforeSeq})).records.some((h:any)=>h.kind==='archive'));
 console.log('PASS atomic snapshot/tasks rollback, concurrent writers, unfinished commitment protection, completed/archive history and explicit restore');

 // A bounded startup includes complete records and stable continuation only.
 for(let i=0;i<3;i++)await action('memory_continuity_task',{task:{...task,id:'large-'+i,progress:'完整条件与证据'.repeat(220)},key:'large-'+i,reason:'Page complete tasks'});
 const firstPage=await call('memory_resume',{contextBudgetBytes:6500});assert(firstPage.nextCursor);assert(Buffer.byteLength(JSON.stringify(firstPage))<=6500);
 const seen=new Set([...firstPage.tasks.map((t:any)=>t.id)]);let cursor=firstPage.nextCursor;
 while(cursor){const p=await call('memory_resume',{cursor,contextBudgetBytes:6500});for(const t of p.tasks){assert(!seen.has(t.id));seen.add(t.id);}cursor=p.nextCursor;}
 assert.equal(seen.size,4);
 await action('memory_continuity_task',{task:{...task,id:'changed-pagination'},key:'change-page',reason:'A new commitment invalidates the prior page snapshot'});
 const stalePage:any=await raw('memory_resume',{cursor:firstPage.nextCursor,contextBudgetBytes:6500});assert(stalePage.isError);assert.equal(JSON.parse(stalePage.content[0].text).error.code,'stale_version');
 const taskPage=await action('memory_continuity_tasks',{state:'all',contextBudgetBytes:6500});assert(taskPage.nextCursor);const taskPage2=await action('memory_continuity_tasks',{state:'all',contextBudgetBytes:6500,cursor:taskPage.nextCursor});assert(!taskPage2.records.some((t:any)=>taskPage.records.some((p:any)=>p.id===t.id)));
 console.log('PASS whole-response budgets, complete-record pagination and stale snapshot cursors');

 const officeSaved=await action('memory_continuity_checkpoint',{officeId:'room',expectedRevision:0,summary:{...summary,goal:'Office-scoped task'},tasks:[{...task,id:'office-task'}],key:'office-stage',reason:'Office work stays under office scope'});
 assert.equal(officeSaved.checkpoint.officeId,'room');
 const actor={v:1 as const,principal:'human',agentId:'codex',runtimeId:roleRuntimeId('human','codex','codex','worker'),transport:'http-mcp' as const,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
 const message=await graph.building.message({action:'send',recipient:role.roleId,officeId:'room',body:'A fictional new development after checkpoint',key:'new-development'},{...actor,runtimeId:roleRuntimeId('human','codex','codex','peer')});
 const withMail=await call('memory_resume');assert.equal(withMail.attention.pendingMessages,1);assert(withMail.checkpoints.find((p:any)=>p.officeId==='room').changesSinceRecordedAt.messages>=1);
 await graph.officeCollaboration.requestControl({roleId:role.roleId,action:'pause',reason:'Human pause fixture',key:'pause'},admin);
 assert((await call('memory_resume')).attention.controlRequests.some((c:any)=>c.action==='pause'));
 const synced=await call('role_sync',{},'worker',office);assert.equal(synced.resume.tool,'memory_resume');
 const targetRequest=(await call('role_sync',{},'new-chat',targetOffice,'opencode')).activation;
 const registered=(await graph.roles.registry(admin)).roles.find((r:any)=>r.id===role.roleId);
 // Hold a public checkpoint after its call identity is captured but before its
 // write transaction. A second SQLite connection switches the actual binding.
 const switcher=new GraphMemory('.',{dbPath:file});await switcher.init();
 const originalCheckpoint=graph.roleContinuity.checkpoint.bind(graph.roleContinuity);let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
 graph.roleContinuity.checkpoint=async(a,v)=>{enter();await gate;return originalCheckpoint(a,v);};
 const pendingWrite=raw('memory_action',{tool:'memory_continuity_checkpoint',arguments:{expectedRevision:1,summary:{...summary,progress:'Must not overwrite after role moves'},key:'during-switch',reason:'Race fixture'}});
 await entered;
 try{await switcher.roles.activate({requestId:targetRequest.id,roleId:role.roleId,expectedRevision:registered.revision},admin);}finally{release();graph.roleContinuity.checkpoint=originalCheckpoint;await switcher.close();}
 const fenced:any=await pendingWrite;assert(fenced.isError);assert.equal(JSON.parse(fenced.content[0].text).error.code,'scope_denied');
 assert.equal((await call('memory_resume')).mode,'human');
 await deny('memory_continuity_task',{task:{...task,expectedRevision:5},key:'old-chat',reason:'Must not overwrite after move'},'invalid_input');
 const moved=await call('memory_resume',{contextBudgetBytes:65536},'new-chat',target,'opencode');assert.equal(moved.role.id,role.roleId);assert(moved.tasks.some((t:any)=>t.id===task.id));assert(moved.checkpoints.some((p:any)=>p.officeId==='room'));
 assert.equal(moved.checkpoints.find((p:any)=>!p.officeId).progress,summary.progress);
 assert.equal(moved.attention.pendingMessages,1);assert(moved.attention.controlRequests.length);
 console.log('PASS cross-harness/new-session recovery preserves role, exact progress, tasks, message attention and human controls; original chat cannot write role state');

 await graph.roles.configureOffice({id:'room',title:'Fictional room',state:'active',expectedRevision:1,seats:[seats[1]]},admin);
 const restricted=await call('memory_resume',{},'new-chat',target,'opencode');assert(!restricted.checkpoints.some((p:any)=>p.officeId==='room'));assert(!restricted.tasks.some((t:any)=>t.id==='office-task'));assert.equal(restricted.attention.pendingMessages,0);
 await deny('memory_continuity_checkpoint',{officeId:'room',expectedRevision:0,summary:{...summary,goal:'Office-scoped task'},tasks:[{...task,id:'office-task'}],key:'office-stage',reason:'Office work stays under office scope'},'scope_denied','new-chat',target,'opencode');
 assert(!(await action('memory_continuity_history',{},'new-chat',target,'opencode')).records.some((r:any)=>r.payload.officeId==='room'));
 assert((await graph.roleContinuity.resume({roleId:role.roleId,human:true})).checkpoints.some((p:any)=>p.officeId==='room'),'Human retains management visibility');
 reopened=new GraphMemory('.',{dbPath:file});await reopened.init();const persistent=await reopened.roleContinuity.resume({roleId:role.roleId,human:true},{contextBudgetBytes:65536});assert.equal(persistent.recordedCheckpoints,2);assert(persistent.tasks.some((t:any)=>t.id===task.id));
 assert.equal((await db.get('PRAGMA quick_check')).quick_check,'ok');assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]);
 assert(message.messageId);
 console.log('PASS current-office revocation fences state, tasks, history and cached receipts; human visibility and SQLite restart/integrity retained');

 const refreshedSeats=seats.map(({agentId,...seat}:any)=>seat);
 await graph.roles.configureOffice({id:'room',title:'Fictional room',state:'active',expectedRevision:2,seats:refreshedSeats},admin);
 const officeDomain=await graph.memoryOwners.domain({kind:'office',id:'room'});
 const evidence=await graph.createNode({domain:officeDomain,dimension:'fact',content:'Fictional office-only evidence',embedding:[1,...Array(383).fill(0)]});
 const sourceSummary={...summary,sources:[{kind:'memory',id:evidence.id,revision:evidence.updatedAt}]};
 await deny('memory_continuity_checkpoint',{expectedRevision:1,summary:{...summary,sources:[{kind:'memory',id:'not-an-existing-memory'}]},key:'missing-source',reason:'A missing source is not a permission error'},'not_found','new-chat',target,'opencode');
 await deny('memory_continuity_checkpoint',{expectedRevision:1,summary:sourceSummary,key:'wrong-reference-scope',reason:'Office references cannot be hidden in private working state'},'scope_denied','new-chat',target,'opencode');
 await action('memory_continuity_checkpoint',{officeId:'room',expectedRevision:1,summary:sourceSummary,key:'actual-office-reference',reason:'Source is in the matching office'},'new-chat',target,'opencode');
 await graph.roles.configureOffice({id:'room',title:'Fictional room',state:'paused',expectedRevision:3,seats:refreshedSeats},admin);
 assert((await call('memory_resume',{contextBudgetBytes:65536},'new-chat',target,'opencode')).checkpoints.some((p:any)=>p.officeId==='room'));
 await deny('memory_continuity_task',{officeId:'room',task:{...task,id:'office-task',expectedRevision:1},key:'paused-office',reason:'Paused office state is read-only'},'scope_denied','new-chat',target,'opencode');
 await graph.roles.deleteOffice({id:'room',expectedRevision:4},admin);
 await assert.rejects(graph.roles.configureOffice({id:'room',title:'A new unrelated room',state:'active',expectedRevision:0,seats:[]},admin),(e:any)=>e.code==='invalid_input');
 assert((await graph.roleContinuity.resume({roleId:role.roleId,human:true},{contextBudgetBytes:65536})).checkpoints.some((p:any)=>p.officeId==='room'));
 const impact=await graph.officeCollaboration.impact({kind:'role',id:role.roleId},admin);assert(impact.counts.workingTasks>0&&impact.counts.workingHistory>0);
 const deleting=(await graph.roles.registry(admin)).roles.find((r:any)=>r.id===role.roleId);
 await graph.roles.deleteRole({roleId:role.roleId,expectedRevision:deleting.revision},admin);
 for(const table of ['role_continuity_checkpoints','role_continuity_tasks','role_continuity_history','role_continuity_receipts'])assert.equal((await db.get('SELECT COUNT(*) n FROM '+table+' WHERE role_id=?',[role.roleId])).n,0);
 assert(await graph.getNodeById(evidence.id),'Deleting working state must not delete independent canonical knowledge');
 assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]);
 console.log('PASS office source scoping, paused read-only state, deleted-office ID fences, human retained work, deletion preview and explicit role-deletion cascade');
}finally{for(const c of clients)await c.close();await network?.close();if(listener)await new Promise<void>(r=>listener.close(r));await reopened?.close();await graph.close();await fs.rm(dir,{recursive:true,force:true});}
