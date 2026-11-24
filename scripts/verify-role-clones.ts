/** Independent clone lifecycle: real Memory MCP and isolated SQLite fixtures, no host automation. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {createHash,randomBytes} from 'node:crypto';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createNetworkMcpApp} from '../src/integrations/network-server.js';
import {officeConnection} from '../src/integrations/office-connection.js';
import {signHostSession} from '../src/integrations/host-correlation.js';
import {tokenDigest} from '../src/integrations/network-config.js';
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
 for(const [id,principal] of [['host','human'],['foreign','recipient']])await graph.offices.configureAgent({id,principal,name:'Synthetic '+id,host:'generic',state:'active',expectedRevision:0,accountAccess:id==='foreign'?'collaborator':'personal'},admin);
 const apply=await graph.roles.application({action:'submit',name:'Parent',introduction:'Synthetic tested skill',reason:'Clone regression',key:'apply'},actor('parent'));
 const parent=(await graph.roles.review({action:'approve',applicationId:apply.applicationId,expectedRevision:1},admin)).roleId;
 const pDomain=await graph.memoryOwners.domain({kind:'agent',id:parent});
 const first=await graph.saveMemory('Synthetic skill A with verified environmental conditions.',{domain:pDomain,dimensions:['practice'],anchors:[{text:'Which environment works?',basis:'verified environmental conditions',spaceId:'memory',memoryType:'practice'}],memberships:[{spaceId:'memory',memoryType:'practice'}],idempotencyKey:'a'});
 const second=await graph.saveMemory('Synthetic skill B has supporting use conditions.',{domain:pDomain,dimensions:['practice'],memberships:[{spaceId:'memory',memoryType:'practice'}],related:[{memoryId:first.id,score:.8,reason:'Both solve the synthetic environment',context:'Only this fixture environment'}],idempotencyKey:'b'});
 const human=await graph.saveMemory('Synthetic human-only secret fixture',{idempotencyKey:'human'});
 await graph.scripts.run({action:'save',roleId:parent,filename:'skill.sh',description:'Synthetic script',usage:'Read before running',language:'sh',content:'printf synthetic',expectedRevision:0,key:'script',locked:true},admin);
 const script=await db.get('SELECT id FROM office_scripts WHERE role_id=?',[parent]);
 await db.run("INSERT INTO memory_embedding_spaces VALUES('fixture-space','{}',?,0)",[Date.now()]);await db.run('INSERT INTO memory_profile_body_versions VALUES(?,4)',[first.id]);await db.run("INSERT INTO memory_profile_vectors VALUES('fixture-space','body',?,?,0,'4',?)",[first.id,first.id,Buffer.from(new Float32Array(384).fill(.1).buffer)]);
 const dispatch={action:'dispatch',roleId:parent,name:'Helper',mission:'Help recipient, record verified lessons and report back',principal:'recipient',key:'dispatch-1'};
 let child:any;
 await test('default dispatch inherits all private assets; dispatch is human-only, atomic and idempotent',async()=>{
  await rejects(()=>graph.roleClones.manage(dispatch,actor('parent')),'scope_denied');
  const before=(await db.get('SELECT count(*) n FROM character_roles')).n;
  await rejects(()=>graph.roleClones.manage({...dispatch,key:'bad',memoryIds:[human.id]},admin),'not_found');assert.equal((await db.get('SELECT count(*) n FROM character_roles')).n,before);
  const callsBefore=embeddingCalls;child=await graph.roleClones.manage(dispatch,admin);assert.equal(embeddingCalls,callsBefore,'dispatch must not call an embedding model');assert.equal((await graph.roleClones.manage(dispatch,admin)).roleId,child.roleId);await rejects(()=>graph.roleClones.manage({...dispatch,mission:'Changed payload'},admin),'idempotency_conflict');assert.notEqual(child.roleId,parent);
  assert.equal((await db.get('SELECT count(*) n FROM role_bindings WHERE role_id=?',[child.roleId])).n,0);assert.equal((await db.get('SELECT count(*) n FROM role_seats WHERE role_id=?',[child.roleId])).n,0);
 });
 const childAssets=await db.all('SELECT * FROM role_clone_assets WHERE role_id=?',[child.roleId]);
 assert.deepEqual(new Set(childAssets.filter((a:any)=>a.kind==='memory').map((a:any)=>a.source_id)),new Set([first.id,second.id]));
 assert.deepEqual(childAssets.filter((a:any)=>a.kind==='script').map((a:any)=>a.source_id),[script.id]);
 await test('explicit selections and empty lists override inheritance; oversized defaults create no partial clone',async()=>{
  const selected=await graph.roleClones.manage({...dispatch,memoryIds:[first.id],scriptIds:[],key:'custom-inheritance'},admin);
  assert.deepEqual(await db.all('SELECT kind,source_id FROM role_clone_assets WHERE role_id=?',[selected.roleId]),[{kind:'memory',source_id:first.id}]);
  const empty=await graph.roleClones.manage({...dispatch,memoryIds:[],scriptIds:[],key:'empty-inheritance'},admin);
  assert.equal(empty.memories+empty.scripts,0);
  await db.run(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<100)
    INSERT INTO office_scripts(id,role_id,office_id,filename,description,usage,language,content,sha256,revision,locked,updated_by,updated_at)
    SELECT 'capacity-'||n,s.role_id,NULL,'capacity-'||n||'.sh',s.description,s.usage,s.language,s.content,s.sha256,1,0,s.updated_by,s.updated_at
    FROM seq JOIN office_scripts s ON s.id=?`,[script.id]);
  try{
   const before=(await db.get('SELECT count(*) n FROM character_roles')).n;
   await rejects(()=>graph.roleClones.manage({...dispatch,key:'over-capacity'},admin),'material_over_budget');
   assert.equal((await db.get('SELECT count(*) n FROM character_roles')).n,before);
   assert(!await db.get("SELECT 1 FROM role_clone_receipts WHERE operation='dispatch' AND key='over-capacity'"));
   assert.equal((await graph.roleClones.manage(dispatch,admin)).snapshotHash,child.snapshotHash,'retry returns the frozen snapshot despite changes to the parent library');
  }finally{await db.run("DELETE FROM office_scripts WHERE role_id=? AND id LIKE 'capacity-%'",[parent]);}
 });
 const childFirst=childAssets.find((a:any)=>a.source_id===first.id).copy_id,childSecond=childAssets.find((a:any)=>a.source_id===second.id).copy_id,childScript=childAssets.find((a:any)=>a.kind==='script').copy_id;
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
 await test('inherited memory remains readable and cannot be edited, deleted, reorganized or returned',async()=>{
  const record=await call('memory_get',{nodeId:childFirst},'clone');
  assert.equal(record.inheritedReadOnly,true);
  assert.equal((await call('memory_get',{nodeId:lesson.id},'clone')).inheritedReadOnly,undefined);
  await deny('memory_update',{nodeId:childFirst,content:'Forbidden edit',expectedUpdatedAt:record.updatedAt,reason:'Synthetic check',idempotencyKey:'cannot-edit'},'clone','scope_denied');
  await deny('memory_delete',{nodeId:childFirst,reason:'Synthetic check'},'clone','scope_denied');
  await deny('memory_action',{tool:'memory_membership_add',arguments:{nodeId:childFirst,spaceId:'memory',memoryType:'concept'}},'clone','scope_denied');
  const edge=(await call('memory_connections',{nodeId:childFirst},'clone')).connections[0];
  await deny('memory_association_delete',{id:edge.id,reason:'Synthetic check'},'clone','scope_denied');
  await rejects(()=>graph.roleClones.office({action:'submit',summary:'Should not return inherited content',memoryIds:[childFirst],key:'exclude-inherited'},actor('clone',true)),'invalid_input');
  assert.equal((await call('memory_get',{nodeId:childFirst},'clone')).content,record.content);
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
  const next=await graph.roleClones.office({action:'submit',memoryIds:[lesson.id],scriptIds:[childScript],summary:'Second explicit return',key:'return-2'},actor('clone',true));
  await deny('memory_clone',{action:'review',reportId:next.reportId,sourceId:lesson.id,decision:'accepted',targetId:lesson.id,expectedTargetVersion:1,note:'Wrong target'},'parent','not_found');
  await deny('memory_clone',{action:'review',reportId:next.reportId,sourceId:lesson.id,decision:'accepted',targetId:imported.targetId,expectedTargetVersion:1,note:'Stale target'},'parent','stale_version');
  const args={action:'review',reportId:next.reportId,sourceId:lesson.id,decision:'accepted',targetId:imported.targetId,expectedTargetVersion:copy.updatedAt,note:'Parent has reviewed synthesis'};
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
 await test('recall keeps a new profile and references inherited support without returning the inherited memory',async()=>{
  const result=await graph.roleClones.manage({...dispatch,memoryIds:[first.id],scriptIds:[],key:'supported-return'},admin);
  const domain=await graph.memoryOwners.domain({kind:'agent',id:result.roleId});
  const profile=await graph.saveMemory('New synthesized private finding',{domain,dimensions:['practice'],
   memberships:[{spaceId:'memory',memoryType:'practice'}],idempotencyKey:'new-profile'});
  const inherited=await db.get(`SELECT c.source_version,c.source_hash,m.id membershipId,m.version FROM role_clone_assets a
    JOIN role_knowledge_copies c ON c.copy_id=a.copy_id JOIN memory_memberships m ON m.memory_id=a.copy_id WHERE a.role_id=? AND a.kind='memory'`,[result.roleId]);
  await db.run('INSERT INTO profile_records VALUES(?,1,1,?)',[profile.memberships[0].id,JSON.stringify({title:'Returned profile',coverage:['Fixture only'],unknowns:[]})]);
  await db.run('INSERT INTO profile_supports VALUES(?,?,?,?,?)',[profile.memberships[0].id,inherited.membershipId,inherited.version,'Inherited support','Fixture']);
  const recalled=await graph.roleClones.manage({action:'recall',roleId:result.roleId,expectedRevision:1},admin);
  assert.equal(recalled.memories,1);
  const report=await call('memory_clone',{action:'get',cloneId:result.roleId,part:'metadata'});
  assert.deepEqual(report.items.map((entry:any)=>entry.sourceId),[profile.id]);
  assert.deepEqual(JSON.parse(report.content).supports[0].inheritedSource,{
   membershipId:inherited.membershipId,sourceMemoryId:first.id,sourceVersion:inherited.source_version,sourceHash:inherited.source_hash
  });
  await call('memory_clone',{action:'review',reportId:recalled.reportId,sourceId:profile.id,decision:'skipped',note:'Reviewed synthetic support'});
  await graph.roleClones.office({action:'archive',cloneId:result.roleId},actor('parent'));
 });
 await test('return imports honor the parent registered memory namespace instead of creating human-owned orphan copies',async()=>{
  const report=await graph.roleClones.office({action:'submit',memoryIds:[lesson.id],scriptIds:[],summary:'Namespace regression',key:'namespace-return'},actor('clone',true));const domain=await graph.memoryOwners.domain({kind:'agent',id:parent}),alias='retained:'+parent;
  await db.run('UPDATE memory_role_namespaces SET domain_id=? WHERE role_id=?',[alias,parent]);await db.run("UPDATE nodes SET domain_id=? WHERE domain_kind='personal' AND domain_id=?",[alias,domain.id]);
  try{const result=await graph.roleClones.manage({roleId:parent,action:'import',reportId:report.reportId,sourceId:lesson.id,note:'Preserve registered parent namespace'},admin);const node=await db.get('SELECT domain_id FROM nodes WHERE id=?',[result.targetId]);assert.equal(node.domain_id,alias);assert.equal((await call('memory_get',{nodeId:result.targetId})).owner.id,parent);}finally{await db.run("UPDATE nodes SET domain_id=? WHERE domain_kind='personal' AND domain_id=?",[domain.id,alias]);await db.run('UPDATE memory_role_namespaces SET domain_id=? WHERE role_id=?',[domain.id,parent]);}
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
 await test('colleagues use per-chat Office and Memory on the same credential through final return and archive',async()=>{
  const recipientToken=randomBytes(32).toString('base64url'), oldToken=randomBytes(32).toString('base64url');
  const allowedHosts=['127.0.0.1'];
  for(const id of ['old-peer','old-peer-2'])await graph.offices.configureAgent({
   id,principal:'old-recipient',name:id,host:'generic',state:'active',expectedRevision:0
  },admin);
  const gateway=createNetworkMcpApp(graph,{allowedHosts,configuration:async()=>({version:2,grants:[{
    principal:'recipient',agentId:'foreign',credentialId:'fixture-colleague',domains:[],tokenHash:tokenDigest(recipientToken),toolProfile:'office'
  },{
    principal:'old-recipient',agentId:'old-peer-2',credentialId:'fixture-older-colleague',domains:[],tokenHash:tokenDigest(oldToken),toolProfile:'office'
  }]})});
  const listener=gateway.app.listen(0,'127.0.0.1');
  await new Promise<void>(r=>listener.once('listening',r));const address=listener.address() as {port:number};
  const host='127.0.0.1:'+address.port;allowedHosts.push(host);
  const transports:StreamableHTTPClientTransport[]=[];
  const connections:Client[]=[];
  async function connect(endpoint:string,token=recipientToken,fixed=false){
   const transport=new StreamableHTTPClientTransport(new URL('http://'+host+endpoint),{requestInit:{headers:{
     Authorization:'Bearer '+token,...(fixed?{'X-MindPond-Identity':'connection'}:{})}}});
   const mcp=new Client({name:'colleague-fixture',version:'1'});transports.push(transport);connections.push(mcp);
   await mcp.connect(transport);return mcp;
  }
  async function invoke(mcp:Client,name:string,args:Record<string,unknown>,threadId?:string){
   const result:any=await mcp.callTool({name,arguments:args,...(threadId?{_meta:{threadId}}:{})});
   return {error:result.isError,data:JSON.parse(result.content[0].text)};
  }
  try{
   await rejects(()=>graph.offices.configureAgent({id:'account-collision',principal:'human',name:'Colleague',host:'generic',
    state:'active',expectedRevision:0,accountAccess:'collaborator'},admin),'invalid_input');
   const nativeTemplate=officeConnection({host:'opencode',id:'colleague',url:'http://127.0.0.1:7904/mcp',accountAccess:'collaborator'});
   assert.equal(nativeTemplate.identityMode,'native');
   assert.equal(Object.keys(nativeTemplate.files??{}).length,1);
   assert(!nativeTemplate.text.includes('X-MindPond-Identity'));
   assert.throws(()=>officeConnection({host:'opencode',id:'colleague',url:'http://127.0.0.1:7904/mcp',accountAccess:'collaborator',identityMode:'connection'}),{code:'invalid_input'});
   const oldMemory=await connect('/memory/mcp',oldToken,true),oldOffice=await connect('/mcp',oldToken,true);
   assert.equal((await invoke(oldMemory,'memory_identity',{})).data.owner.kind,'user');
   const shared=(await invoke(oldOffice,'role_application',{action:'submit',name:'Former shared role',introduction:'Synthetic identity',reason:'Account change regression',key:'shared'})).data;
   const migrated=await graph.roles.review({action:'approve',applicationId:shared.applicationId,expectedRevision:1},admin);
   assert.equal((await invoke(oldMemory,'memory_identity',{})).data.owner.id,migrated.roleId);
   const formerShared=await graph.roleClones.manage({...dispatch,principal:'old-recipient',memoryIds:[],scriptIds:[],key:'shared-clone'},admin);
   const sharedChat={...actor('parent'),principal:'old-recipient',agentId:'old-peer',credentialId:'fixture-shared-clone',
    runtimeMode:'credential' as const,runtimeId:roleRuntimeId('old-recipient','old-peer','credential','fixture-shared-clone')};
   await graph.roles.observeChat(sharedChat);
   await graph.roles.connect({roleId:formerShared.roleId,targetRuntimeId:sharedChat.runtimeId,expectedRevision:1},admin);
   const sharedCredential=await graph.memoryOwners.issue(formerShared.roleId);
   await graph.offices.configureAgent({id:'old-peer',principal:'old-recipient',name:'old-peer',host:'generic',
    state:'active',expectedRevision:1,accountAccess:'collaborator'},admin);
   const parentDispatches=await graph.roleClones.manage({action:'status',roleId:parent},admin);
   assert.equal(parentDispatches.clones.find((entry:any)=>entry.roleId===formerShared.roleId).connectorId,null);
   await graph.roleClones.manage({action:'assign_account',roleId:formerShared.roleId,expectedRevision:1,principal:'recipient'},admin);
   assert.equal((await db.get('SELECT state FROM role_bindings WHERE role_id=?',[formerShared.roleId])).state,'revoked');
   assert.equal((await db.get('SELECT state FROM memory_role_credentials WHERE id=?',[sharedCredential.id])).state,'revoked');
   assert.equal((await invoke(oldMemory,'memory_identity',{})).data.error.code,'identity_required',
    'an already-open connection on a second host inherits the account restriction immediately');
   assert.equal((await invoke(oldOffice,'role_sync',{})).data.error.code,'identity_required');
   assert.equal((await graph.roles.registry(admin)).roles.find((entry:any)=>entry.id===migrated.roleId).connection,null);
   const nativeOffice=await connect('/mcp',oldToken),nativeMemory=await connect('/memory/mcp',oldToken);
   const reopened=(await invoke(nativeOffice,'role_sync',{},'recovered-chat')).data;
   await graph.roles.activate({requestId:reopened.activation.id,roleId:migrated.roleId,expectedRevision:1},admin);
   assert.equal((await invoke(nativeMemory,'memory_identity',{},'recovered-chat')).data.owner.id,migrated.roleId);
   assert.equal((await invoke(nativeMemory,'memory_identity',{},'another-chat')).data.error.code,'identity_required');
   await rejects(()=>graph.offices.configureAgent({id:'old-peer',principal:'old-recipient',name:'old-peer',host:'generic',
    state:'active',expectedRevision:2,accountAccess:'personal'},admin),'invalid_input');
   const fixedMemory=await connect('/memory/mcp',recipientToken,true),memo=await connect('/memory/mcp'),office=await connect('/mcp');
   assert.equal((await invoke(fixedMemory,'memory_directory',{})).data.error.code,'identity_required');
   assert.equal((await invoke(memo,'memory_get',{nodeId:human.id},'colleague-chat')).data.error.code,'identity_required');
   assert.equal((await invoke(memo,'memory_action',{tool:'memory_save',arguments:{content:'No fallback',idempotencyKey:'deny'}},'colleague-chat')).data.error.code,'identity_required');
   const sync=(await invoke(office,'role_sync',{},'colleague-chat')).data;
   assert.equal(sync.memoryAccess,'role_required');
   const transferable=await graph.roleClones.manage({...dispatch,principal:'human',memoryIds:[],scriptIds:[],key:'transferable'},admin);
   const priorChat=actor('personal-clone-before-transfer');
   await graph.roles.observeChat(priorChat);
   await graph.roles.connect({roleId:transferable.roleId,targetRuntimeId:priorChat.runtimeId,expectedRevision:1},admin);
   await graph.roleMemoryPermissions.manage({action:'set',roleId:transferable.roleId,readOthers:true,organizeOthers:true,expectedRevision:0},admin);
   const oldRoleCredential=await graph.memoryOwners.issue(transferable.roleId);
   const targetRuntimeId=actor('colleague-chat',true).runtimeId;
   const switchClone={roleId:transferable.roleId,targetRuntimeId,expectedRevision:2};
   await rejects(()=>graph.roles.connect(switchClone,admin),'invalid_input');
   await rejects(()=>graph.roles.connect({...switchClone,recipientPrincipal:'wrong-account'},admin),'invalid_input');
   const parentRevision=(await db.get('SELECT revision FROM character_roles WHERE id=?',[parent])).revision;
   await rejects(()=>graph.roles.connect({roleId:parent,targetRuntimeId,expectedRevision:parentRevision,recipientPrincipal:'recipient'},admin),'invalid_input');
   assert.equal((await graph.roles.identity(priorChat))?.roleId,transferable.roleId,'failed transfers leave the old connection intact');
   const base='http://127.0.0.1:'+http.address().port+'/api/office';
   const login=await fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operatorKey:'fixture-control'})});
   const cookie=login.headers.get('set-cookie')!.split(';')[0];
   const moved=await fetch(base+'/role/connect',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},
     body:JSON.stringify({...switchClone,recipientPrincipal:'recipient'})});
   assert.equal(moved.status,200,await moved.text());
   assert.equal((await db.get('SELECT principal FROM character_roles WHERE id=?',[transferable.roleId])).principal,'recipient');
   assert.equal(await graph.roles.identity(priorChat),null);
   assert.equal(await graph.memoryOwners.credential(oldRoleCredential.token),null);
   assert.equal((await graph.roleMemoryPermissions.get(transferable.roleId)).readOthers,false);
   assert.equal((await invoke(memo,'memory_identity',{},'colleague-chat')).data.owner.id,transferable.roleId);
   assert.equal((await invoke(memo,'memory_identity',{},'parallel-chat')).data.error.code,'identity_required');
   assert.equal((await invoke(memo,'memory_get',{nodeId:human.id},'colleague-chat')).data.error.code,'scope_denied');
   assert.equal((await invoke(memo,'memory_get',{nodeId:first.id},'colleague-chat')).data.error.code,'scope_denied');
   const saved=await invoke(memo,'memory_action',{tool:'memory_save',arguments:{content:'Synthetic collaborator final instruction',idempotencyKey:'final'}},'colleague-chat');
   assert(!saved.error,JSON.stringify(saved));
   const creds=await graph.memoryOwners.issue(transferable.roleId),dedicated=await connect('/mcp',creds.token);
   assert.equal((await invoke(dedicated,'role_sync',{})).data.error.code,'identity_required');
   const siblingArgs={action:'submit',name:'Second colleague role',introduction:'Synthetic second chat',reason:'Concurrent chat test',key:'second-chat'};
   async function signed(mcp:Client,name:string,args:Record<string,unknown>){
    const result:any=await mcp.callTool({name,arguments:{...args,hostContext:signHostSession('second-colleague-chat',name,args,recipientToken)}});
    return {error:result.isError,data:JSON.parse(result.content[0].text)};
   }
   const sibling=await signed(office,'role_application',siblingArgs);
   assert(!sibling.error,JSON.stringify(sibling));
   const approved=await graph.roles.review({action:'approve',applicationId:sibling.data.applicationId,expectedRevision:1},admin);
   assert.equal((await signed(memo,'memory_identity',{})).data.owner.id,approved.roleId);
   assert.equal((await signed(memo,'memory_get',{nodeId:saved.data.id})).data.error.code,'scope_denied');
   await graph.roleMemoryPermissions.manage({action:'set',roleId:approved.roleId,readOthers:true,organizeOthers:true,expectedRevision:0},admin);
   const delegated=await signed(memo,'memory_role_action',{targetRoleId:child.roleId,tool:'memory_get',arguments:{nodeId:childFirst}});
   assert.equal(delegated.data.result.inheritedReadOnly,true);
   const delegatedEdit=await signed(memo,'memory_role_action',{targetRoleId:child.roleId,tool:'memory_update',
     arguments:{nodeId:childFirst,content:'Forbidden delegated edit',reason:'Synthetic check',expectedUpdatedAt:delegated.data.result.updatedAt}});
   assert.equal(delegatedEdit.data.error.code,'scope_denied');
   assert.equal((await invoke(memo,'memory_identity',{},'colleague-chat')).data.owner.id,transferable.roleId);
   const file=Buffer.from('Synthetic private transfer');
   const reservation=await invoke(office,'office_artifact',{action:'prepare',filename:'fixture.txt',mime:'text/plain',
    size:file.length,sha256:createHash('sha256').update(file).digest('hex'),key:'private-transfer'},'colleague-chat');
   assert(!reservation.error,JSON.stringify(reservation));
   const contentUrl='http://'+host+reservation.data.transfer.path;
   const counterpart={'X-MindPond-Host-Context':signHostSession('second-colleague-chat','office_artifact_transfer',
    {method:'GET',artifactId:reservation.data.artifact.artifactId},creds.token)};
   const rawDownload=(token:string,headers:Record<string,string>={})=>fetch(contentUrl,{headers:{Authorization:'Bearer '+token,...headers}});
   const noChat=await rawDownload(creds.token);assert.equal((await noChat.json()).code,'identity_required');
   const correctChat={'X-MindPond-Meta':JSON.stringify({threadId:'colleague-chat'})};
   const sharedHeader=await rawDownload(creds.token,{...correctChat,'X-MindPond-Identity':'connection'});
   assert.equal((await sharedHeader.json()).code,'identity_required');
   const wrongChat=await rawDownload(creds.token,counterpart);assert.equal((await wrongChat.json()).code,'scope_denied');
   const upload=await fetch(contentUrl,{method:'PUT',headers:{Authorization:'Bearer '+creds.token,...correctChat},body:file});
   assert.equal(upload.status,201,await upload.text());
   const downloaded=await rawDownload(creds.token,correctChat);assert.equal(downloaded.status,200);
   assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),file);
   const released=await invoke(dedicated,'office_clone',{action:'release',summary:'Final collaborator experience',key:'release'},'colleague-chat');
   assert.equal(released.data.state,'returned',JSON.stringify(released));assert.equal(released.data.memories,1);
   assert((await invoke(memo,'memory_identity',{},'colleague-chat')).error);
   await deny('memory_identity',{},'colleague-chat','scope_denied');
   const syncAfterRelease=(await invoke(office,'role_sync',{},'colleague-chat')).data;
   assert(syncAfterRelease.activation?.id,'colleague can request new role activation after returning');
   assert.equal(syncAfterRelease.lastReturn.reportId,released.data.reportId,'sync can confirm a lost release reply');
   assert.equal((await graph.roles.registry(admin)).roles.find((r:any)=>r.id===transferable.roleId).cloneState,'returned');
   await rejects(()=>graph.roleClones.office({action:'archive',cloneId:transferable.roleId},actor('parent')),'invalid_input');
   const next=await call('memory_clone',{action:'get',reportId:released.data.reportId});
   assert.equal(next.content,'Synthetic collaborator final instruction');
   assert.equal((await call('memory_clone',{action:'get',cloneId:transferable.roleId})).reportId,released.data.reportId);
   await deny('memory_clone',{action:'get',cloneId:child.roleId,reportId:released.data.reportId},'parent','not_found');
   assert((await call('memory_clone',{action:'reports',cloneId:transferable.roleId})).reports.every((report:any)=>report.roleId===transferable.roleId));
   const improved=await call('memory_save',{content:'Parent verified collaborator instruction',idempotencyKey:'parent-summary'});
   await call('memory_clone',{action:'review',reportId:next.reportId,sourceId:next.sourceId,decision:'accepted',
    targetId:improved.id,expectedTargetVersion:(await call('memory_get',{nodeId:improved.id})).updatedAt,note:'Verified and summarized in parent memory'});
   assert.equal((await graph.roleClones.office({action:'archive',cloneId:transferable.roleId},actor('parent'))).state,'archived');
   assert(!(await graph.roles.registry(admin)).roles.some((r:any)=>r.id===transferable.roleId));
   assert(!(await graph.offices.choices(admin)).roles.some((r:any)=>r.id===transferable.roleId));
   assert((await call('memory_clone',{action:'get',reportId:next.reportId,sourceId:next.sourceId})).decision);
   assert.equal((await call('memory_get',{nodeId:improved.id})).owner.id,parent);
   const recalled=await graph.roleClones.manage({...dispatch,principal:'human',memoryIds:[],scriptIds:[],key:'human-recall'},admin);
   await graph.roleClones.manage({roleId:recalled.roleId,action:'assign_account',principal:'recipient',expectedRevision:1},admin);
   const reset=(await db.get('SELECT revision FROM character_roles WHERE id=?',[recalled.roleId])).revision;
   const activate=(await invoke(office,'role_sync',{},'colleague-chat')).data.activation;
   await graph.roles.activate({roleId:recalled.roleId,requestId:activate.id,expectedRevision:reset},admin);
   await graph.roles.configureOffice({id:'recall-office',title:'Recall room',state:'active',expectedRevision:0,seats:[
    {id:'recall-parent',roleId:parent,label:'Parent'},{id:'recall-clone',roleId:recalled.roleId,label:'Clone'}
   ]},admin);
   const focus=await graph.discussions.run({action:'create',officeId:'recall-office',title:'Recall during discussion',
    question:'What happened?',doneWhen:'Conclusions',participants:[recalled.roleId],key:'recall-room'},actor('parent'));
   await graph.discussions.run({action:'join',id:focus.room.id},actor('colleague-chat',true));
   await rejects(()=>graph.roleClones.office({action:'release',summary:'Still in discussion',key:'early-release'},actor('colleague-chat',true)),'scope_denied');
   const rec=await graph.roleClones.manage({roleId:recalled.roleId,action:'recall',expectedRevision:2},admin);
   assert.equal((await db.get('SELECT state FROM office_discussion_members WHERE room_id=? AND role_id=?',[focus.room.id,recalled.roleId])).state,'left');
   assert(await db.get('SELECT id FROM office_discussions WHERE id=?',[focus.room.id]));
   assert.equal((await db.get("SELECT enabled FROM office_seats WHERE id='recall-clone'")).enabled,0);
   const visible=await graph.discussions.run({action:'get',id:focus.room.id},actor('parent'));
   await graph.discussions.run({action:'close',id:focus.room.id,expectedRevision:visible.room.revision,
    summary:'Discussion closed after recall',key:'end-qa-discussion'},actor('parent'));
   assert.equal(rec.state,'returned');
   await call('memory_clone',{action:'acknowledge',reportId:rec.reportId});
   assert.equal((await graph.roleClones.manage({roleId:recalled.roleId,action:'archive',expectedRevision:3},admin)).state,'archived');
  }finally{
   for(const transport of transports)await transport.terminateSession().catch(()=>{});
   for(const mcp of connections)await mcp.close();
   await gateway.close(listener);
  }
 });
 const tools=buildingOperations(graph);assert(tools.some(t=>t.name==='office_clone'));assert(!tools.some(t=>t.name==='memory_clone'));assert((await client.listTools()).tools.some(t=>t.name==='memory_clone'));assert(!(await client.listTools()).tools.some(t=>t.name==='office_clone'));
 console.log('PASS '+passed+' clone lifecycle scenarios; Memory/Office separation, SQLite integrity and no new dependencies');
}finally{embedding.generateEmbedding=original;await client?.close();await service?.close();if(http)await new Promise<void>(r=>http.close(()=>r()));await peer.close();await graph.close();await fs.rm(dir,{recursive:true,force:true});}
