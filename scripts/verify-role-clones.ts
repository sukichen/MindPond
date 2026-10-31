/** Independent clone lifecycle: real Memory MCP and isolated SQLite fixtures, no host automation. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {GraphMemory} from '../src/core/graph-memory.js';
import {roleRuntimeId} from '../src/core/roles.js';
import {createOwnerMemoryServer} from '../src/role-memory-service.js';
import {officeWorkbench} from '../src/integrations/office-workbench.js';
import {createMemoryMcpServer} from '../src/mcp-service.js';
import {buildingOperations} from '../src/core/building-tools.js';
import {getEmbeddingService} from '../src/core/embedding.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-clones-')),file=path.join(dir,'test.db');
const graph=new GraphMemory('.',{dbPath:file}),peer=new GraphMemory('.',{dbPath:file});
const admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const actor=(chat:string,foreign=false)=>({v:1 as const,principal:foreign?'recipient':'human',agentId:foreign?'foreign':'host',runtimeId:roleRuntimeId(foreign?'recipient':'human',foreign?'foreign':'host','codex',chat),runtimeMode:'codex_metadata',nativeChatId:chat,transport:'http-mcp' as const,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER});
let embeddingCalls=0;const embedding=getEmbeddingService(),original=embedding.generateEmbedding;embedding.generateEmbedding=async()=>{embeddingCalls++;return [1,...Array(383).fill(0)];};
let client:Client|undefined,service:ReturnType<typeof createOwnerMemoryServer>|undefined,http:any;let passed=0;
const test=async(name:string,run:()=>Promise<void>)=>{await run();passed++;console.log('PASS '+name);};
const rejects=async(run:()=>Promise<unknown>,code:string)=>assert.rejects(run,(e:any)=>{assert.equal(e.code,code,e.message);assert(e.nextAction);return true;});
try{
 await graph.init();const db=(graph as any).db;
 for(const [id,principal] of [['host','human'],['foreign','recipient']])await graph.offices.configureAgent({id,principal,name:'Synthetic '+id,host:'generic',state:'active',expectedRevision:0},admin);
 const apply=await graph.roles.application({action:'submit',name:'Parent',introduction:'Synthetic tested skill',reason:'Clone regression',key:'apply'},actor('parent'));
 const parent=(await graph.roles.review({action:'approve',applicationId:apply.applicationId,expectedRevision:1},admin)).roleId;
 const pDomain=await graph.memoryOwners.domain({kind:'agent',id:parent});
 const first=await graph.saveMemory('Synthetic skill A with verified environmental conditions.',{domain:pDomain,dimensions:['practice'],anchors:[{text:'Which environment works?',basis:'verified environmental conditions',spaceId:'memory',memoryType:'practice'}],memberships:[{spaceId:'memory',memoryType:'practice'}],idempotencyKey:'a'});
 const second=await graph.saveMemory('Synthetic skill B has supporting use conditions.',{domain:pDomain,dimensions:['practice'],memberships:[{spaceId:'memory',memoryType:'practice'}],related:[{memoryId:first.id,score:.8,reason:'Both solve the synthetic environment',context:'Only this fixture environment'}],idempotencyKey:'b'});
 const human=await graph.saveMemory('Synthetic human-only secret fixture',{idempotencyKey:'human'});
 await graph.scripts.run({action:'save',roleId:parent,filename:'skill.sh',description:'Synthetic script',usage:'Read before running',language:'sh',content:'printf synthetic',expectedRevision:0,key:'script',locked:true},admin);
 const script=await db.get('SELECT id FROM office_scripts WHERE role_id=?',[parent]);
 await db.run("INSERT INTO memory_embedding_spaces VALUES('fixture-space','{}',?,0)",[Date.now()]);await db.run('INSERT INTO memory_profile_body_versions VALUES(?,4)',[first.id]);await db.run("INSERT INTO memory_profile_vectors VALUES('fixture-space','body',?,?,0,'4',?)",[first.id,first.id,Buffer.from(new Float32Array(384).fill(.1).buffer)]);
 const dispatch={action:'dispatch',roleId:parent,name:'Helper',mission:'Help recipient, record verified lessons and report back',principal:'recipient',memoryIds:[first.id,second.id],scriptIds:[script.id],key:'dispatch-1'};
 let child:any;
 await test('dispatch is human-only, atomic, immutable and idempotent; invalid ownership copies nothing',async()=>{
  await rejects(()=>graph.roleClones.manage(dispatch,actor('parent')),'scope_denied');
  const before=(await db.get('SELECT count(*) n FROM character_roles')).n;
  await rejects(()=>graph.roleClones.manage({...dispatch,key:'bad',memoryIds:[human.id]},admin),'not_found');assert.equal((await db.get('SELECT count(*) n FROM character_roles')).n,before);
  const callsBefore=embeddingCalls;child=await graph.roleClones.manage(dispatch,admin);assert.equal(embeddingCalls,callsBefore,'dispatch must not call an embedding model');assert.equal((await graph.roleClones.manage(dispatch,admin)).roleId,child.roleId);await rejects(()=>graph.roleClones.manage({...dispatch,mission:'Changed payload'},admin),'idempotency_conflict');assert.notEqual(child.roleId,parent);
  assert.equal((await db.get('SELECT count(*) n FROM role_bindings WHERE role_id=?',[child.roleId])).n,0);assert.equal((await db.get('SELECT count(*) n FROM role_seats WHERE role_id=?',[child.roleId])).n,0);
 });
 const childAssets=await db.all('SELECT * FROM role_clone_assets WHERE role_id=?',[child.roleId]),childFirst=childAssets.find((a:any)=>a.source_id===first.id).copy_id,childSecond=childAssets.find((a:any)=>a.source_id===second.id).copy_id,childScript=childAssets.find((a:any)=>a.kind==='script').copy_id;
 await test('private copies retain internal ripple graph, original score/evidence, anchors and script locks without cross-owner edges',async()=>{
  assert.notEqual(childFirst,first.id);assert.notEqual(childScript,script.id);
  const edge=(await graph.listAssociations(childFirst))[0];assert.equal(edge.weight,.8);assert.equal(edge.evidenceStatus,'supported','copied evidence must refer to copied membership IDs and versions');assert.equal(edge.memoryB?.id===childSecond||edge.memoryA?.id===childSecond,true);assert.equal(edge.evidence[0].reason,'Both solve the synthetic environment');
  const node=await graph.getNodeById(childFirst,{trackAccess:false});assert.equal(node!.anchors!.length,1);assert(node!.sourceRefs!.some(s=>s.uri==='mindpond:memory/'+first.id));assert.equal((await db.get('SELECT locked FROM office_scripts WHERE id=?',[childScript])).locked,1);assert.equal((await db.get("SELECT version FROM memory_profile_vectors WHERE space_key='fixture-space' AND memory_id=?",[childFirst])).version,'4');assert.equal((await db.get('SELECT version FROM memory_profile_body_versions WHERE memory_id=?',[childFirst])).version,4);
  const parentText=(await graph.getNodeById(first.id,{trackAccess:false}))!.content;await graph.updateNodeContent(first.id,'Parent changed after dispatch');assert.equal((await graph.getNodeById(childFirst,{trackAccess:false}))!.content,parentText);
  assert.equal((await graph.listAssociations(first.id)).length,1);assert.equal((await db.get('SELECT count(*) n FROM role_memory_permissions WHERE role_id=?',[child.roleId])).n,0);
 });
 await graph.roles.observeChat(actor('clone',true));await graph.roles.connect({roleId:child.roleId,targetRuntimeId:actor('clone',true).runtimeId,expectedRevision:1},admin);
 service=createOwnerMemoryServer(graph);client=new Client({name:'clone-fixture',version:'1'});const [s,c]=InMemoryTransport.createLinkedPair();await Promise.all([service.server.connect(s),client.connect(c)]);
 const raw=(name:string,args:any={},chat='parent')=>client!.callTool({name,arguments:args,_meta:{threadId:chat}});
 const call=async(name:string,args:any={},chat='parent')=>{const r:any=await raw(name,args,chat);assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
 const deny=async(name:string,args:any={},chat='parent',code='not_found')=>{const r:any=await raw(name,args,chat);assert(r.isError,JSON.stringify(r));assert.equal(JSON.parse(r.content[0].text).error.code,code);};
 await test('native chat binding yields clone memory identity across recipient accounts; parent cannot read live clone private knowledge',async()=>{
  const identity=await call('memory_identity',{},'clone');assert.equal(identity.owner.id,child.roleId);assert.equal(identity.clone.lineage.parentId,parent);assert.equal(identity.offices.length,0);
  await deny('memory_get',{nodeId:first.id},'clone','scope_denied');await deny('memory_get',{nodeId:childFirst},'parent','scope_denied');await deny('memory_get',{nodeId:human.id},'clone','scope_denied');
  assert.equal((await call('memory_identity',{},'unbound-human')).owner.kind,'user');assert.equal((await call('memory_get',{nodeId:childFirst},'unbound-human')).id,childFirst);
  const resumed=await call('memory_resume',{},'clone');assert.equal(resumed.clone.lineage.mission,dispatch.mission);
 });
 const lesson=await call('memory_save',{content:'Synthetic new verified lesson from recipient work',dimensions:['practice'],idempotencyKey:'clone-lesson'},'clone');
 await test('clone discovers new/changed candidates; meetings block external return submission',async()=>{
  const candidates=await graph.roleClones.office({action:'candidates'},actor('clone',true));assert(candidates.records.some((r:any)=>r.id===lesson.id&&r.change==='new'));assert(candidates.records.some((r:any)=>r.id===childFirst&&r.change==='inherited'));assert(!JSON.stringify(candidates).includes('Synthetic skill'),'Office returns references, not memory content');
  await graph.roles.configureOffice({id:'meeting-office',title:'Meeting',state:'active',expectedRevision:0,seats:[{id:'parent-seat',roleId:parent,label:'Parent',role:'member'},{id:'child-seat',roleId:child.roleId,label:'Child',role:'member'}]},admin);
  await graph.roles.link({sender:parent,recipient:child.roleId,allowed:true},admin);await graph.roles.link({sender:child.roleId,recipient:parent,allowed:true},admin);
  const room=await graph.discussions.run({action:'create',officeId:'meeting-office',title:'Focus',question:'Synthetic focused question',doneWhen:'Conclusion recorded',participants:[child.roleId],key:'room'},actor('parent'));await graph.discussions.run({action:'join',id:room.room.id},actor('clone',true));
  await deny('memory_clone',{action:'reports'},'parent','scope_denied');await rejects(()=>graph.roleClones.office({action:'reports'},actor('parent')),'scope_denied');
  await rejects(()=>graph.roleClones.office({action:'submit',summary:'Cannot yet publish outside room',key:'blocked'},actor('clone',true)),'scope_denied');
  const current=await graph.discussions.run({action:'get',id:room.room.id},admin);await graph.discussions.run({action:'close',id:room.room.id,expectedRevision:current.room.revision},admin);
 });
 await test('change detection includes graph evidence and anchors, excludes access counters and embeddings',async()=>{
  const before=await graph.roleClones.office({action:'candidates'},actor('clone',true));assert.equal(before.records.find((r:any)=>r.id===childFirst).change,'inherited');
  await db.run('UPDATE nodes SET access_count=access_count+1 WHERE id=?',[childFirst]);assert.equal((await graph.roleClones.office({action:'candidates'},actor('clone',true))).records.find((r:any)=>r.id===childFirst).change,'inherited');
  const anchor=await db.get('SELECT id,text FROM memory_anchors WHERE memory_id=?',[childFirst]);await db.run('UPDATE memory_anchors SET text=? WHERE id=?',['Different recall trigger',anchor.id]);assert.equal((await graph.roleClones.office({action:'candidates'},actor('clone',true))).records.find((r:any)=>r.id===childFirst).change,'changed');await db.run('UPDATE memory_anchors SET text=? WHERE id=?',[anchor.text,anchor.id]);
  const edge=await db.get('SELECT * FROM memory_associations WHERE member_a_id IN (SELECT id FROM memory_memberships WHERE memory_id=?) OR member_b_id IN (SELECT id FROM memory_memberships WHERE memory_id=?)',[childFirst,childFirst]);
  await db.run('UPDATE memory_associations SET weight=.6 WHERE id=?',[edge.id]);assert.equal((await graph.roleClones.office({action:'candidates'},actor('clone',true))).records.find((r:any)=>r.id===childFirst).change,'changed');await db.run('UPDATE memory_associations SET weight=? WHERE id=?',[edge.weight,edge.id]);
 });
 let report:any;
 await test('return packages are immutable and selected; unchanged inherited assets excluded; no automatic parent writes',async()=>{
  const before=(await db.get("SELECT count(*) n FROM nodes WHERE domain_id=?",[pDomain.id])).n;
  report=await graph.roleClones.office({action:'submit',summary:'Verified recipient experience, no auto-overwrite',key:'return'},actor('clone',true));assert.equal(report.memories,1);assert.equal(report.scripts,0);assert.equal((await db.get('SELECT count(*) n FROM nodes WHERE domain_id=?',[pDomain.id])).n,before);
  assert.equal((await graph.roleClones.office({action:'submit',summary:'Verified recipient experience, no auto-overwrite',key:'return'},actor('clone',true))).reportId,report.reportId);
  await graph.updateNodeContent(lesson.id,'Clone edited live knowledge after submitting');const frozen=await call('memory_clone',{action:'get'});assert.equal(frozen.sourceId,lesson.id);assert.equal(frozen.content,'Synthetic new verified lesson from recipient work');assert.equal((await graph.roles.sync(actor('parent'))).clone.returns.pendingItems,1);
  await deny('memory_get',{nodeId:lesson.id},'parent','scope_denied');await deny('memory_clone',{action:'review',reportId:report.reportId,sourceId:lesson.id,decision:'skipped',note:'Not parent'},'clone','scope_denied');
  await deny('memory_clone',{action:'get',reportId:report.reportId,sourceId:first.id},'parent','not_found');
 });
 let imported:any;
 await test('human import copies once with return provenance; role review validates target ownership/version and is idempotent',async()=>{
  const input={roleId:parent,action:'import',reportId:report.reportId,sourceId:lesson.id,kind:'memory',note:'Verified synthetic applicability'};
  imported=await graph.roleClones.manage(input,admin);assert.equal(imported.decision,'accepted');assert.notEqual(imported.targetId,lesson.id);assert.equal((await graph.roleClones.manage(input,admin)).targetId,imported.targetId);
  const copy=await call('memory_get',{nodeId:imported.targetId});assert.equal(copy.content,'Synthetic new verified lesson from recipient work');assert(copy.sourceRefs.some((s:any)=>s.context.includes(report.reportId)));
  const next=await graph.roleClones.office({action:'submit',memoryIds:[childFirst],scriptIds:[childScript],summary:'Second explicit return',key:'return-2'},actor('clone',true));
  await deny('memory_clone',{action:'review',reportId:next.reportId,sourceId:childFirst,decision:'accepted',targetId:lesson.id,expectedTargetVersion:1,note:'Wrong target'},'parent','not_found');
  await deny('memory_clone',{action:'review',reportId:next.reportId,sourceId:childFirst,decision:'accepted',targetId:imported.targetId,expectedTargetVersion:1,note:'Stale target'},'parent','stale_version');
  const args={action:'review',reportId:next.reportId,sourceId:childFirst,decision:'accepted',targetId:imported.targetId,expectedTargetVersion:copy.updatedAt,note:'Parent has reviewed synthesis'};
  await call('memory_clone',args);assert((await call('memory_clone',args)).replayed);await deny('memory_clone',{...args,note:'Different decision'},'parent','idempotency_conflict');
  const scriptItem=await graph.roleClones.office({action:'get_script',reportId:next.reportId},actor('parent'));assert.equal(scriptItem.sourceId,childScript);
  await graph.roleClones.office({action:'review_script',reportId:next.reportId,sourceId:childScript,decision:'skipped',note:'Already inherited, no additional value'},actor('parent'));
 });
 await test('summary-only return acknowledgement, Unicode pages, complete provenance and default next item',async()=>{
  const summary=await graph.roleClones.office({action:'submit',memoryIds:[],scriptIds:[],summary:'A stage completed without additional reusable knowledge',key:'summary-only'},actor('clone',true));
  assert((await graph.roleClones.describe(parent)).returns.pendingPackages>0);await call('memory_clone',{action:'acknowledge',reportId:summary.reportId});
  const text='🦆'.repeat(600)+'\nVerified Unicode lesson';const refs=Array.from({length:64},(_,n)=>({uri:'https://example.invalid/source/'+n,revision:'v1',context:'Fixture only'}));
  const long=await call('memory_save',{content:text,sourceRefs:refs,idempotencyKey:'unicode'},'clone');const sealed=await graph.roleClones.office({action:'submit',memoryIds:[long.id],scriptIds:[],summary:'Unicode and provenance',key:'unicode-return'},actor('clone',true));
  let page=await call('memory_clone',{action:'get',characters:257}),body='';assert.equal(page.reportId,sealed.reportId);do{body+=page.content;if(page.nextOffset===null)break;assert(!/[\uD800-\uDBFF]$/.test(page.content));page=await call('memory_clone',page.nextPage);}while(true);assert.equal(body,text);
  page=await call('memory_clone',{action:'get',reportId:sealed.reportId,sourceId:long.id,part:'metadata',characters:257});let metadata='';do{metadata+=page.content;if(page.nextOffset===null)break;page=await call('memory_clone',page.nextPage);}while(true);assert.equal(JSON.parse(metadata).sourceRefs.length,64);
  const copy=await graph.roleClones.manage({action:'import',roleId:parent,reportId:sealed.reportId,sourceId:long.id,note:'All provenance retained'},admin),read=await call('memory_get',{nodeId:copy.targetId});assert.equal(read.sourceRefs.length,64);assert.equal(read.copyOrigin.sourceId,long.id);assert.equal((await call('memory_clone',{action:'get'})).done,true);
 });
 await test('synthesized profiles require supports, graph copies are independent, and installation failures roll back the role',async()=>{
  const profile=await graph.saveMemory('Synthetic combined fixture knowledge',{domain:pDomain,dimensions:['practice'],memberships:[{spaceId:'memory',memoryType:'practice'}],idempotencyKey:'profile'});const member=profile.memberships[0].id;
  await db.run('INSERT INTO profile_records VALUES(?,1,1,?)',[member,JSON.stringify({title:'Synthetic profile',coverage:['Fixture only'],unknowns:[]})]);
  for(const m of [first.memberships[0],second.memberships[0]])await db.run('INSERT INTO profile_supports VALUES(?,?,1,?,?)',[member,m.id,'Synthetic support','Fixture']);
  const input={...dispatch,key:'profile-fork',memoryIds:[profile.id],scriptIds:[]};
  await rejects(()=>graph.roleClones.manage(input,admin),'invalid_input');
  const result=await graph.roleClones.manage({...input,memoryIds:[first.id,second.id,profile.id]},admin);const copied=await db.get("SELECT copy_id FROM role_clone_assets WHERE role_id=? AND source_id=?",[result.roleId,profile.id]);const supports=await db.all('SELECT s.source_id,m.memory_id FROM profile_supports s JOIN memory_memberships p ON p.id=s.profile_id JOIN memory_memberships m ON m.id=s.source_id WHERE p.memory_id=?',[copied.copy_id]);assert.equal(supports.length,2);assert(!supports.some((s:any)=>[first.id,second.id].includes(s.memory_id)));
  const before=(await db.get('SELECT count(*) n FROM character_roles')).n;await db.exec("CREATE TRIGGER fixture_fail_clone_script BEFORE INSERT ON office_scripts WHEN NEW.role_id<>'"+parent+"' BEGIN SELECT RAISE(ABORT,'synthetic failed install');END");
  try{await assert.rejects(()=>graph.roleClones.manage({...dispatch,key:'rollback'},admin));assert.equal((await db.get('SELECT count(*) n FROM character_roles')).n,before);assert(!await db.get("SELECT 1 FROM role_clone_receipts WHERE operation='dispatch' AND key='rollback'"));}finally{await db.exec('DROP TRIGGER fixture_fail_clone_script');}
  await graph.roleClones.manage({roleId:result.roleId,action:'revoke',expectedRevision:1},admin);await graph.roleClones.manage({roleId:result.roleId,action:'purge',expectedRevision:2},admin);
 });
 await test('return imports honor the parent registered memory namespace instead of creating human-owned orphan copies',async()=>{
  const report=await graph.roleClones.office({action:'submit',memoryIds:[childFirst],scriptIds:[],summary:'Namespace regression',key:'namespace-return'},actor('clone',true));const domain=await graph.memoryOwners.domain({kind:'agent',id:parent}),alias='retained:'+parent;
  await db.run('UPDATE memory_role_namespaces SET domain_id=? WHERE role_id=?',[alias,parent]);await db.run("UPDATE nodes SET domain_id=? WHERE domain_kind='personal' AND domain_id=?",[alias,domain.id]);
  try{const result=await graph.roleClones.manage({roleId:parent,action:'import',reportId:report.reportId,sourceId:childFirst,note:'Preserve registered parent namespace'},admin);const node=await db.get('SELECT domain_id FROM nodes WHERE id=?',[result.targetId]);assert.equal(node.domain_id,alias);assert.equal((await call('memory_get',{nodeId:result.targetId})).owner.id,parent);}finally{await db.run("UPDATE nodes SET domain_id=? WHERE domain_kind='personal' AND domain_id=?",[domain.id,alias]);await db.run('UPDATE memory_role_namespaces SET domain_id=? WHERE role_id=?',[domain.id,parent]);}
 });
 await test('registered Office MCP exposes dispatch metadata and script returns without memory reads or source-cache copies',async()=>{
  const office=createMemoryMcpServer(graph,{trusted:actor('parent')}),oc=new Client({name:'office-clone-fixture',version:'1'}),[s,c]=InMemoryTransport.createLinkedPair();
  try{await Promise.all([office.server.connect(s),oc.connect(c)]);const tools=(await oc.listTools()).tools;assert(tools.some(t=>t.name==='office_clone'));assert(!tools.some(t=>t.name==='memory_clone'));assert(!tools.some(t=>t.name==='memory_get'));
   const before=(await db.get('SELECT count(*) n FROM office_response_pages')).n;const result:any=await oc.callTool({name:'office_clone',arguments:{action:'candidates'},_meta:{threadId:'parent'}});assert(!result.isError,JSON.stringify(result));assert(!JSON.stringify(result).includes('Parent changed after dispatch'));assert.equal((await db.get('SELECT count(*) n FROM office_response_pages')).n,before);
  }finally{await oc.close();await office.close();}
 });
 await test('HTTP management endpoint uses existing human login boundary and returns connected clone identity',async()=>{
  const app=express();app.use(express.json());app.use('/api/office',officeWorkbench(graph,{apiKey:'',operatorKey:'fixture-control',contextSecret:''}));http=await new Promise<any>(resolve=>{const h=app.listen(0,'127.0.0.1',()=>resolve(h));});const base='http://127.0.0.1:'+http.address().port+'/api/office';
  let response=await fetch(base+'/role/clones',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roleId:parent,action:'status'})});assert.equal(response.status,401);
  const login=await fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operatorKey:'fixture-control'})});const cookie=login.headers.get('set-cookie')!.split(';')[0];response=await fetch(base+'/role/clones',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({roleId:parent,action:'status'})});assert.equal(response.status,200);const data=await response.json() as any;assert.equal(data.clones.find((r:any)=>r.roleId===child.roleId).host,'generic');
 });
 await test('reorganizations/deletion cannot silently break an independent dispatch',async()=>{
  await rejects(()=>graph.roleReorganization.preview({mode:'split',sourceId:parent,name:'No move',introduction:'Synthetic',memoryIds:[first.id]},admin),'invalid_input');
  const r=await db.get('SELECT revision FROM character_roles WHERE id=?',[child.roleId]);await rejects(()=>graph.roles.deleteRole({roleId:child.roleId,expectedRevision:r.revision},admin),'invalid_input');
 });
 await peer.init();
 await test('cross-process revocation denies role, Office and Memory access without human fallback, with retained frozen return data',async()=>{
  await peer.roleClones.manage({action:'revoke',roleId:child.roleId,expectedRevision:1},admin);
  await deny('memory_identity',{},'clone','scope_denied');await deny('memory_save',{content:'Must not become human',idempotencyKey:'forbidden'},'clone','scope_denied');
  await rejects(()=>graph.roles.identity(actor('clone',true)),'scope_denied');await rejects(()=>graph.roleClones.office({action:'status'},actor('clone',true)),'scope_denied');
  assert((await call('memory_clone',{action:'get',reportId:report.reportId,sourceId:lesson.id})).content.includes('Synthetic new verified'));
  const role=await db.get('SELECT * FROM character_roles WHERE id=?',[child.roleId]);await rejects(()=>graph.roles.configure({roleId:child.roleId,name:role.name,introduction:role.introduction,state:'active',expectedRevision:role.revision},admin),'scope_denied');
  await peer.roleClones.manage({action:'resume',roleId:child.roleId,expectedRevision:2},admin);assert.equal((await call('memory_identity',{},'clone')).owner.id,child.roleId);
 });
 await test('explicit cleanup removes package contents but retains independent private knowledge; terminal clone stays fenced',async()=>{
  await graph.roleClones.manage({action:'revoke',roleId:child.roleId,expectedRevision:3},admin);await graph.roleClones.manage({action:'purge',roleId:child.roleId,expectedRevision:4},admin);
  assert.equal((await db.get('SELECT snapshot FROM role_clones WHERE role_id=?',[child.roleId])).snapshot,null);assert.equal((await db.get('SELECT count(*) n FROM role_clone_reports WHERE role_id=?',[child.roleId])).n,0);assert(await db.get('SELECT 1 FROM nodes WHERE id=?',[lesson.id]));
  await deny('memory_identity',{},'clone','scope_denied');await rejects(()=>graph.roleClones.manage({action:'resume',roleId:child.roleId,expectedRevision:5},admin),'invalid_input');
  assert.equal((await db.all('PRAGMA foreign_key_check')).length,0);
 });
 await test('explicit human disconnect of a retired clone yields the same unbound identity on Office and Memory',async()=>{
  const role=await db.get('SELECT revision FROM character_roles WHERE id=?',[child.roleId]),binding=await db.get("SELECT id,epoch FROM role_bindings WHERE role_id=? AND state='active'",[child.roleId]);
  await graph.roles.disconnect({roleId:child.roleId,expectedRevision:role.revision,bindingId:binding.id},admin);
  assert.equal((await call('memory_identity',{},'clone')).owner.kind,'user');assert.equal(await graph.roles.identity(actor('clone',true)),null);
  await rejects(()=>graph.roles.binding({...actor('clone',true),roleId:child.roleId,roleBindingId:binding.id,roleBindingEpoch:binding.epoch}),'scope_denied');
 });
 const tools=buildingOperations(graph);assert(tools.some(t=>t.name==='office_clone'));assert(!tools.some(t=>t.name==='memory_clone'));assert((await client.listTools()).tools.some(t=>t.name==='memory_clone'));assert(!(await client.listTools()).tools.some(t=>t.name==='office_clone'));
 console.log('PASS '+passed+' clone lifecycle scenarios; Memory/Office separation, SQLite integrity and no new dependencies');
}finally{embedding.generateEmbedding=original;await client?.close();await service?.close();if(http)await new Promise<void>(r=>http.close(()=>r()));await peer.close();await graph.close();await fs.rm(dir,{recursive:true,force:true});}
