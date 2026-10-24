import {memoryAccess} from '../src/core/memory-access.js';
/** Real HTTP disconnects and restricted credentials, using synthetic text-only data. */
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

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-network-lifecycle-'));
const oldMode=process.env.MINDPOND_EMBEDDING_MODE;process.env.MINDPOND_EMBEDDING_MODE='text';
const graph=new GraphMemory('.',{dbPath:path.join(directory,'fixture.db')});
const admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const tokens=[randomBytes(32).toString('base64url'),randomBytes(32).toString('base64url')];
const clients:Client[]=[];let network:ReturnType<typeof createNetworkMcpApp>|undefined,listener:any;
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
try{
 await graph.init();await graph.offices.configureAgent({id:'host',principal:'human',name:'Synthetic host',host:'generic-http-mcp',state:'active',expectedRevision:0},admin);
 const hosts=['127.0.0.1'];network=createNetworkMcpApp(graph,{allowedHosts:hosts,configuration:async()=>({version:2,grants:tokens.map((token,i)=>({principal:'human',agentId:'host',credentialId:'credential-'+i,tokenHash:tokenDigest(token),domains:[],toolProfile:'office' as const,...(i?{assignmentIds:['seat-a']}:{})}))})});
 listener=network.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>listener.once('listening',resolve));const base='http://127.0.0.1:'+listener.address().port;hosts.push(new URL(base).host);
 async function connect(endpoint:string,index=0){const client=new Client({name:'synthetic-client',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(base+endpoint),{requestInit:{headers:{Authorization:'Bearer '+tokens[index]}}});clients.push(client);await client.connect(transport);return {client,transport};}
 async function call(client:Client,name:string,args:any={},chat='worker'){const result:any=await client.callTool({name,arguments:args,_meta:{threadId:chat}});assert(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);}
 async function denied(client:Client,name:string,args:any={}){const result:any=await client.callTool({name,arguments:args,_meta:{threadId:'worker'}});assert(result.isError,'Expected restricted credential denial: '+name);const data=JSON.parse(result.content[0].text);assert(['scope_denied','not_found'].includes(data.error?.code),'Must deny access rather than fail schema validation: '+JSON.stringify(data));return data;}
 const office=await connect('/mcp'),restrictedOffice=await connect('/mcp',1),memory=await connect('/memory/mcp'),restricted=await connect('/memory/mcp',1);
 const roles=[];
 for(const chat of ['worker','peer']){const application=await call(office.client,'role_application',{action:'submit',name:'Synthetic '+chat,introduction:'Fixture',reason:'User authorized regression',key:'apply'},chat);roles.push(await graph.roles.review({applicationId:application.applicationId,expectedRevision:1,action:'approve'},admin));}
 await graph.roles.configureOffice({id:'allowed',title:'Allowed office',state:'active',expectedRevision:0,seats:[{id:'seat-a',roleId:roles[0].roleId,label:'Worker',role:'member'},{id:'seat-peer',roleId:roles[1].roleId,label:'Peer',role:'member'}]},admin);
 await graph.roles.configureOffice({id:'restricted',title:'Restricted office',state:'active',expectedRevision:0,seats:[{id:'seat-b',roleId:roles[0].roleId,label:'Worker',role:'member'}]},admin);
 const own=await call(memory.client,'memory_save',{content:'Private reusable synthetic technique',idempotencyKey:'own'});
 const hidden=await call(memory.client,'memory_save',{officeId:'restricted',content:'Restricted office synthetic sentinel',idempotencyKey:'hidden'});
 await call(office.client,'office_record',{officeId:'allowed',kind:'learning',title:'Synthetic source reference',memoryId:hidden.id,outcome:'used',evidence:'Synthetic unrestricted verification',key:'learning'});
 await call(memory.client,'memory_action',{tool:'memory_continuity_task',arguments:{officeId:'restricted',key:'task',reason:'Synthetic progress',task:{id:'hidden-task',expectedRevision:0,title:'Restricted task',status:'doing',progress:'Synthetic progress',nextSteps:[],blockers:[],sources:[]}}});
 {
  const identity=await call(restricted.client,'memory_identity');assert.deepEqual(identity.offices.map((o:any)=>o.id),['allowed'],'Memory must preserve the same assignment restrictions as Office');
  assert.equal((await call(restricted.client,'memory_get',{nodeId:own.id})).owner.id,roles[0].roleId,'private role knowledge remains accessible');
  await denied(restricted.client,'memory_get',{nodeId:hidden.id});await denied(restricted.client,'memory_directory',{officeId:'restricted'});
  assert(!(await call(restricted.client,'memory_search',{query:'Restricted office synthetic sentinel'})).results.some((r:any)=>r.id===hidden.id));
  await denied(restricted.client,'memory_save',{officeId:'restricted',content:'Must not publish',idempotencyKey:'blocked'});
  await denied(restricted.client,'memory_action',{tool:'memory_save_validate',arguments:{officeId:'restricted',content:'Must not preview'}});
  const learning=await call(restrictedOffice.client,'office_context',{action:'records',officeId:'allowed',kind:'learning'});assert(!learning.records.some((r:any)=>r.payload.memoryId===hidden.id),'Office learning previews cannot bypass Memory restrictions');
  const resume=await call(restricted.client,'memory_resume');assert(!JSON.stringify(resume).includes('hidden-task'),'startup must not leak restricted working state');
  await denied(restricted.client,'memory_action',{tool:'memory_continuity_tasks',arguments:{officeId:'restricted'}});
  await denied(restricted.client,'memory_action',{tool:'memory_continuity_task',arguments:{officeId:'restricted',key:'blocked-task',reason:'Must deny',task:{id:'blocked-task',expectedRevision:0,title:'Forbidden task',status:'todo',progress:'Not started',nextSteps:[],blockers:[],sources:[]}}});
  console.log('PASS restricted HTTP credentials: role knowledge, office discovery, search/read/write/preview and continuity use the same seat boundary');
 }
 // A narrow credential must not move a role out of a valid room elsewhere.
 await graph.roles.configureOffice({id:'restricted',title:'Restricted office',state:'active',expectedRevision:1,seats:[{id:'seat-b',roleId:roles[0].roleId,label:'Worker',role:'member'},{id:'seat-b-peer',roleId:roles[1].roleId,label:'Peer',role:'member'}]},admin);
 const protectedMeeting=await call(office.client,'office_discussion',{action:'create',officeId:'restricted',title:'Restricted meeting sentinel',question:'Keep this focus',doneWhen:'Explicit leave',participants:[roles[1].roleId],key:'protected-meeting'});
 const narrowSync=await call(restrictedOffice.client,'role_sync',{responseBudgetBytes:65536});
 assert.equal((await (graph as any).db.get('SELECT state FROM office_discussion_members WHERE room_id=? AND role_id=?',[protectedMeeting.room.id,roles[0].roleId])).state,'joined','narrow grants must never eject the role from a valid active discussion');
 assert.equal(narrowSync.discussions.activeUnavailable,true);assert(!JSON.stringify(narrowSync.discussions).includes('Restricted meeting sentinel'));
 assert.equal((await call(restrictedOffice.client,'office_wait',{waitMs:100})).status,'discussion');
 const blockedTake:any=await restrictedOffice.client.callTool({name:'office_receive',arguments:{action:'take',key:'narrow-focus'},_meta:{threadId:'worker'}});assert(blockedTake.isError);assert.equal(JSON.parse(blockedTake.content[0].text).error.code,'invalid_input');
 await call(office.client,'office_discussion',{action:'leave',summary:'Regression summary: checked the current state; no additional notification.',key:randomUUID(),id:protectedMeeting.room.id});
 const authority={assignmentIds:['seat-a']},requestAccess=memoryAccess(graph,{kind:'agent',id:roles[0].roleId},authority);authority.assignmentIds.push('seat-b');assert.deepEqual((await requestAccess.offices()).map(o=>o.id),['allowed'],'request authority must be copied, not widened by later mutation');
 const meeting=await call(office.client,'office_discussion',{action:'create',officeId:'allowed',title:'Synthetic discussion',question:'Check cancellation',doneWhen:'Disconnect frees the wait',participants:[roles[1].roleId],key:'meeting'});
 await denied(restrictedOffice.client,'office_discussion',{action:'export',id:meeting.room.id,memoryId:hidden.id});
 async function disconnected(name:string,args:any,observe:(onStart:(runtime:any)=>void,onFinish:()=>void)=>()=>void,id:number){
  let started!:()=>void,finished!:()=>void,signal:AbortSignal|undefined;
  const entered=new Promise<void>(resolve=>started=resolve),settled=new Promise<void>(resolve=>finished=resolve);
  const restore=observe(runtime=>{signal=runtime.signal;started();},finished),controller=new AbortController();
  try{
   const request=fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+tokens[0],'Content-Type':'application/json',Accept:'application/json, text/event-stream','mcp-session-id':office.transport.sessionId!},body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args,_meta:{threadId:'worker'}}}),signal:controller.signal}).then(response=>response.text()).catch(error=>{if(error.name!=='AbortError')throw error;});
   await Promise.race([entered,pause(2000).then(()=>{throw Error('Tool did not enter');})]);controller.abort();await request;
   const stopped=await Promise.race([settled.then(()=>true),pause(1500).then(()=>false)]);assert(stopped,'An HTTP disconnect must promptly finish '+name);assert(signal?.aborted,'An HTTP disconnect must cancel '+name+' in the original server process');
   await settled;
  }finally{controller.abort();restore();}
 }
 await disconnected('office_discussion',{action:'wait',id:meeting.room.id,afterSeq:0,waitMs:4000},(start,finish)=>{const original=graph.discussions.wait;graph.discussions.wait=async function(i,a,r){start(r);try{return await original.call(graph.discussions,i,a,r);}finally{finish();}};return()=>{graph.discussions.wait=original;};},7001);
 await disconnected('office_host',{action:'probe',waitMs:4000},(start,finish)=>{const original=graph.officeCollaboration.host;graph.officeCollaboration.host=async function(i,a){start(i);try{return await original.call(graph.officeCollaboration,i,a);}finally{finish();}};return()=>{graph.officeCollaboration.host=original;};},7002);
 assert.equal((await (graph as any).db.get('SELECT COUNT(*) n FROM office_discussion_waits')).n,0,'disconnected discussion waits release observable status');
 assert.equal((await (graph as any).db.get('SELECT COUNT(*) n FROM office_probe_leases')).n,0,'disconnected probes release admission capacity');
 console.log('PASS real HTTP disconnect: discussion waits and host probes cancel and release their resources promptly');
 await graph.roles.configureOffice({id:'allowed',title:'Allowed office',state:'active',expectedRevision:1,seats:[{id:'seat-peer',roleId:roles[1].roleId,label:'Peer',role:'member'}]},admin);
 assert.deepEqual((await requestAccess.offices()).map(o=>o.id),[],'cached request access must recheck current office membership');
 assert.deepEqual((await call(restricted.client,'memory_identity')).offices,[]);assert.equal((await call(restricted.client,'memory_get',{nodeId:own.id})).owner.id,roles[0].roleId);
 const registry=await graph.roles.registry(admin),role=registry.roles.find((r:any)=>r.id===roles[0].roleId);
 await graph.roles.disconnect({roleId:role.id,expectedRevision:role.revision,bindingId:role.binding_id},admin);
 assert.equal((await call(restricted.client,'memory_identity')).owner.kind,'user','an explicitly disconnected chat retains ordinary human access as designed');
 assert.equal((await call(restricted.client,'memory_get',{nodeId:hidden.id})).owner.kind,'office');
}finally{await Promise.allSettled(clients.map(client=>client.close()));await network?.close(listener);await graph.close();await fs.rm(directory,{recursive:true,force:true});if(oldMode===undefined)delete process.env.MINDPOND_EMBEDDING_MODE;else process.env.MINDPOND_EMBEDDING_MODE=oldMode;}
