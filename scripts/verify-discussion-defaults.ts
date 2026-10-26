/** Real HTTP MCP: server-owned progress and ready-to-use continuations. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {GraphMemory} from '../src/core/graph-memory.js';
import {createNetworkMcpApp} from '../src/integrations/network-server.js';
import {tokenDigest} from '../src/integrations/network-config.js';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-discussion-defaults-'));
const priorMode=process.env.MINDPOND_EMBEDDING_MODE;process.env.MINDPOND_EMBEDDING_MODE='text';
const graph=new GraphMemory('.',{dbPath:path.join(temp,'fixture.db')}),admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const token=randomBytes(32).toString('base64url');let listener:any,network:ReturnType<typeof createNetworkMcpApp>|undefined,client:Client|undefined;
try{
 await graph.init();
 await graph.offices.configureAgent({id:'fixture',principal:'human',name:'Synthetic harness',host:'codex',state:'active',expectedRevision:0},admin);
 const hosts=['127.0.0.1'];network=createNetworkMcpApp(graph,{allowedHosts:hosts,configuration:async()=>({version:2,grants:[{principal:'human',agentId:'fixture',credentialId:'fixture',tokenHash:tokenDigest(token),domains:[],toolProfile:'office' as const}]})});
 listener=network.app.listen(0,'127.0.0.1');await new Promise<void>(r=>listener.once('listening',r));
 const base='http://127.0.0.1:'+listener.address().port;hosts.push(new URL(base).host);
 client=new Client({name:'synthetic-defaults',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
 let author='b';
 const raw=(name:string,args:any={},chat=author)=>client!.callTool({name,arguments:args,_meta:{threadId:chat}});
 let responseSnapshots=0;
 const call=async(name:string,args:any={},chat=author)=>{
  const result:any=await raw(name,args,chat);assert(!result.isError,JSON.stringify(result));let data=JSON.parse(result.content[0].text);
  if(data.paged){
   responseSnapshots++;assert(data.characters<=1024,'suggested page size must satisfy the public schema');
   let command=data.nextCall,text='';
   while(command){const result:any=await raw(command.tool,command.arguments,chat);assert(!result.isError,JSON.stringify(result));const page=JSON.parse(result.content[0].text);assert(!page.paged,'continuations must not recursively page themselves');text+=page.text;command=page.nextPage?{tool:'office_context',arguments:page.nextPage}:null;}
   data=JSON.parse(JSON.parse(text).content[0].text);
  }
  return data;
 };
 const denied=async(name:string,args:any,code:string,chat=author)=>{const result:any=await raw(name,args,chat);assert(result.isError,JSON.stringify(result));const e=JSON.parse(result.content[0].text).error;assert.equal(e.code,code);assert(e.nextAction);return e;};
 const roles:any[]=[];
 for(const chat of ['a','b','c']){const app=await call('role_application',{action:'submit',name:'Synthetic '+chat,introduction:'Regression role',reason:'Verify progress',key:'apply'},chat);roles.push(await graph.roles.review({applicationId:app.applicationId,expectedRevision:1,action:'approve'},admin));}
 const seats=roles.map((r,i)=>({id:'seat-'+i,roleId:r.roleId,label:'Seat '+i,role:'member'}));
 await graph.roles.configureOffice({id:'office',title:'Progress regression',state:'active',expectedRevision:0,seats},admin);
 assert.equal((await denied('office_discussion',{action:'get'},'invalid_input')).field,'id');
 await denied('office_discussion',{action:'wait',waitMs:100},'invalid_input');
 await assert.rejects(graph.discussions.run({action:'get'},admin),/No active discussion/);
 const created=await call('office_discussion',{action:'create',officeId:'office',title:'Question',question:'What remains?',doneWhen:'Verified answer',participants:[roles[1].roleId],key:'meeting'},'a'),id=created.room.id;
 const post=async(body:string,key:string,chat='a',room=id)=>call('office_discussion',{action:'post',id:room,body,key},chat);
 const first=await post('First pending decision','first');
 assert.equal((await call('office_discussion',{action:'get'},'a')).posts.length,0,'own messages are not incoming work');
 assert.equal((await call('office_discussion',{action:'wait',waitMs:100},'a')).status,'timeout','own posts cannot immediately satisfy a default wait');
 await denied('office_discussion',{action:'get'},'invalid_input');
 assert.deepEqual((await call('office_discussion',{action:'get',id})).posts,[],'invitation is not joined access');
 const joined=await call('office_discussion',{action:'join',id});assert.equal(joined.posts[0].seq,first.seq);
 const second=await post('Second pending decision','second'),third=await post('Third pending decision','third');
 const history=await call('office_discussion',{action:'get',id,afterSeq:second.seq});assert.deepEqual(history.posts.map((p:any)=>p.seq),[third.seq]);
 await call('office_discussion',history.finish);
 const oldest=await call('office_discussion',{action:'get',limit:1});assert.equal(oldest.selection,'unprocessed');assert.equal(oldest.posts[0].seq,first.seq);assert(oldest.hasMore);
 assert.equal(oldest.nextGet.afterSeq,undefined,'default continuation cannot silently skip unfinished work');
 assert.equal((await call('office_discussion',oldest.nextGet)).posts[0].seq,first.seq,'reading again restores the oldest still-unprocessed post');
 const other=(await graph.discussions.run({action:'get',id},admin)).members.find((m:any)=>m.roleId===roles[1].roleId);
 assert.equal(other.unprocessedPosts,2,'retrieving posts does not acknowledge processing');
 await call('office_discussion',oldest.finish);
 const next=await call('office_discussion',{action:'get',limit:1});assert.equal(next.posts[0].seq,second.seq);
 const own=await post('A reply from B','reply','b');
 const noUnseen=await call('office_discussion',{action:'wait',waitMs:100});assert.equal(noUnseen.status,'timeout');assert.equal(noUnseen.resume.afterSeq,undefined);
 assert.equal((await call('office_discussion',{...noUnseen.resume,waitMs:100})).status,'timeout','default resume does not re-read already fetched posts');
 let finished=false;const waiting=call('office_discussion',{action:'wait',waitMs:3000}).then(v=>{finished=true;return v;});
 await new Promise(r=>setTimeout(r,100));assert(!finished);
 const fourth=await post('New peer update','fourth');const delivery=await waiting;
 assert.equal(delivery.post.seq,fourth.seq);assert.equal(delivery.selection,'unread');assert.deepEqual(delivery.finish.postSeqs,[fourth.seq]);
 await call('office_discussion',delivery.finish);
 assert.equal((await call('office_discussion',{action:'get'})).posts[0].seq,second.seq,'a later wait result never hides older unfinished work');
 await call('office_discussion',next.finish);assert.deepEqual((await call('office_discussion',{action:'get'})).posts,[]);
 const full=await call('office_discussion',{action:'get',afterSeq:0,limit:1});assert.equal(full.selection,'history');assert.equal(full.posts[0].seq,first.seq);
 assert(full.nextGet.afterSeq>0);const more=await call('office_discussion',full.nextGet);assert.equal(more.posts[0].seq,second.seq);
 const ownHistory=await call('office_discussion',{action:'get',afterSeq:third.seq});assert(ownHistory.posts.some((p:any)=>p.seq===own.seq&&p.processingState==='own'));
 const allHuman=await graph.discussions.run({action:'get',id},admin);assert.equal(allHuman.selection,'history');assert.equal(allHuman.posts.length,5);
 await denied('office_discussion',{action:'get',officeId:'other-office'},'not_found');
 await denied('office_discussion',{action:'get',id},'not_found','c');
 await denied('office_discussion',{action:'finish',id,postSeqs:[own.seq]},'invalid_input');
 const peer=await call('office_discussion',{action:'create',officeId:'office',title:'Other question',question:'Separate scope',doneWhen:'Answer',participants:[roles[0].roleId],key:'other-meeting'},'c');
 const foreign=await post('Not for B','foreign','c',peer.room.id);
 await denied('office_discussion',{action:'finish',id,postSeqs:[foreign.seq]},'invalid_input');
 assert.deepEqual((await call('office_discussion',{action:'get'})).posts,[],'posts from another room cannot enter the default queue');
 await call('role_sync',{},'replacement');const directory=await graph.roles.registry(admin),role=directory.roles.find((r:any)=>r.id===roles[1].roleId)!,target=directory.chats.find((c:any)=>c.native_chat_id==='replacement')!;
 const fifth=await post('Continue after changing chat','fifth');
 await graph.roles.connect({roleId:role.id,expectedRevision:role.revision,targetRuntimeId:target.runtime_id},admin);author='replacement';
 const restored=await call('office_discussion',{action:'get'});assert.deepEqual(restored.posts.map((p:any)=>p.seq),[fifth.seq]);
 await denied('office_discussion',{action:'get'},'scope_denied','b');await call('office_discussion',restored.finish);
 const long=await post('A budgeted post. '.repeat(140),'long');
 const bounded=await call('office_discussion',{action:'get',contextBudgetBytes:8192});assert.equal(bounded.posts[0].seq,long.seq);assert(Buffer.byteLength(JSON.stringify(bounded))<=8192);await call('office_discussion',bounded.finish);
 const budgetPosts=[];
 for(const key of ['budget-a','budget-b','budget-c'])budgetPosts.push(await post((key+' ').repeat(320),key));
 const observationBefore=await (graph as any).db.get('SELECT provided_seqs FROM office_discussion_observations WHERE room_id=? AND role_id=?',[id,roles[1].roleId]);
 await denied('office_discussion',{action:'get',contextBudgetBytes:2048},'material_over_budget');
 assert.deepEqual(await (graph as any).db.get('SELECT provided_seqs FROM office_discussion_observations WHERE room_id=? AND role_id=?',[id,roles[1].roleId]),observationBefore,'a failed response must not mark unreturned content fetched');
 let pendingPage=await call('office_discussion',{action:'get',contextBudgetBytes:8192});assert(pendingPage.hasMore,'budget must shorten the page without dropping the remaining work');
 const seen=[];
 while(pendingPage.posts.length){assert(Buffer.byteLength(JSON.stringify(pendingPage))<=8192);seen.push(...pendingPage.posts.map((p:any)=>p.seq));await call('office_discussion',pendingPage.finish);pendingPage=await call('office_discussion',pendingPage.nextGet);}
 assert.deepEqual(seen,budgetPosts.map(p=>p.seq),'default budget pages must return each unfinished post once after confirmation');
 console.log('PASS discussion defaults: oldest unfinished work, own-post exclusion, exact history, safe gaps, explicit handling, no-cursor waits/resume, current-room permissions and role-portable progress');
 const content='// Verified source\n'+('console.log("🙂");\n'.repeat(180));
 const script=await call('office_script',{action:'save',filename:'progress.mjs',description:'Synthetic source',usage:'Review only',language:'JavaScript',content,expectedRevision:0,key:'script'});
 let page=await call('office_script',{action:'get',id:script.id,characters:256}),download=page.content;
 while(page.nextPage){assert.equal(page.nextPage.expectedRevision,script.revision);page=await call('office_script',page.nextPage);download+=page.content;}
 assert.equal(download,content);assert.equal(createHash('sha256').update(download).digest('hex'),page.script.sha256);
 let initial=await call('office_script',{action:'get',id:script.id,characters:256});
 await call('office_script',{action:'save',id:script.id,filename:'progress.mjs',description:'Updated source',usage:'Review only',language:'JavaScript',content:'Changed',expectedRevision:script.revision,key:'edit-script'});
 await denied('office_script',initial.nextPage,'stale_version');
 // Ordinary messages are deferred during a meeting, but already authorized read pages remain usable.
 await call('office_discussion',{action:'leave',id:peer.room.id,summary:'Scope checks completed; return to ordinary correspondence.',key:'leave-peer'},'c');
 const text='A long attributed message. '.repeat(400),mail=await call('office_message',{action:'send',recipient:roles[1].roleId,body:text,key:'long-mail'},'c');
 page=await call('office_message',{action:'get',messageId:mail.messageId});download=page.message.body;
 while(page.nextPage){assert.equal(page.nextPage.messageId,mail.messageId);page=await call('office_message',page.nextPage);download+=page.message.body;}
 assert.equal(download,text.trim());
 const material=await call('office_material',{action:'publish',officeId:'office',title:'Large fixture',content:'Material content. '.repeat(4000),key:'long-material'},'c');
 page=await call('office_material',{action:'get',officeId:'office',materialId:material.materialId});let chunks=1,materialText=page.chunk.content;
 while(page.nextPage){assert.equal(page.nextPage.materialId,material.materialId);page=await call('office_material',page.nextPage);materialText+=page.chunk.content;chunks++;}
 assert.equal(chunks,page.manifest.chunks);assert(chunks>1);assert(responseSnapshots>0,'exercise generic oversized response recovery too');assert.equal(createHash('sha256').update(materialText).digest('hex'),page.manifest.sha256);
 console.log('PASS pagination commands: complete script/message/material reads without cursor arithmetic, Unicode-safe source, pinned revisions and stale-version rejection');
}finally{
 await client?.close();await network?.close();if(listener)await new Promise<void>(r=>listener.close(()=>r()));await graph.close();
 if(priorMode===undefined)delete process.env.MINDPOND_EMBEDDING_MODE;else process.env.MINDPOND_EMBEDDING_MODE=priorMode;
 await fs.rm(temp,{recursive:true,force:true});
}
