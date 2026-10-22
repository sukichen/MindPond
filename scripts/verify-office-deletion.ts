/** Real browser admin HTTP routes and FK-enforced temporary SQLite database. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';
import { GraphMemory } from '../src/core/graph-memory.js';
import { getEmbeddingService } from '../src/core/embedding.js';
import { officeWorkbench } from '../src/integrations/office-workbench.js';
import { roleOperations } from '../src/core/role-tools.js';
import type { TrustedCallContext } from '../src/core/trust.js';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-office-delete-'));
const graph=new GraphMemory('.',{dbPath:path.join(dir,'test.db')});
const embedding=getEmbeddingService(),originalEmbedding=embedding.generateEmbedding;
embedding.generateEmbedding=async()=>[1,...Array(383).fill(0)];
const admin:TrustedCallContext={v:1,principal:'operator',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
let server:ReturnType<ReturnType<typeof express>['listen']>|undefined;
let management:ReturnType<typeof officeWorkbench>|undefined;
try {
  await graph.init();const db=(graph as any).db;
  await graph.offices.configureAgent({id:'connector',principal:'owner',name:'我的 Codex',host:'codex',state:'active',expectedRevision:0},admin);
  const makeRole=async(name:string)=>{
    const actor:TrustedCallContext={v:1,principal:'owner',agentId:'connector',runtimeId:'chat-'+name,transport:'http-mcp',issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
    const introduction=name==='小栗'?'擅长整理交通选择与预算':name==='小麦'?'擅长安排景点与每日路线':'擅长记录讨论结果与待确认事项';
    const application=await graph.roles.application({action:'submit',name,introduction,reason:'一起整理两天一夜的出游计划',key:'apply-'+name},actor);
    const approved=await graph.roles.review({applicationId:application.applicationId,expectedRevision:1,action:'approve'},admin);
    return {...actor,roleId:approved.roleId,roleBindingId:approved.bindingId,roleBindingEpoch:1};
  };
  const a=await makeRole('小栗'),b=await makeRole('小麦'),c=await makeRole('小桃');
  const createOffice=(id:string)=>graph.roles.configureOffice({id,title:id==='delete-room'?'临时讨论室':'周末出游',goal:'共同整理两天一夜的出游计划，日期和价格待确认。',state:'active',expectedRevision:0,seats:[
    {id:id+'-a',agentId:'connector',roleId:a.roleId,label:'小栗',role:'worker'},
    {id:id+'-b',agentId:'connector',roleId:b.roleId,label:'小麦',role:'reviewer'},
    {id:id+'-c',agentId:'connector',roleId:c.roleId,label:'小桃',role:'observer'},
  ]},admin);
  await createOffice('delete-room');await createOffice('keep-room');
  await graph.saveMemory('Independent personal knowledge must survive office deletion.',{dimensions:['work']});
  const fill=async(officeId:string)=>{
    const session=(await graph.offices.open({assignmentId:officeId+'-a'},a)).context!;
    const legacy=await graph.offices.exchange({action:'send',workSessionId:session.workSessionId,recipient:officeId+'-b',kind:'inform',body:'办公室准备好了，完整草案会放在文本材料里。',key:'legacy-'+officeId},a);
    await graph.offices.exchange({action:'ack',workSessionId:((await graph.offices.open({assignmentId:officeId+'-b'},b)).context!).workSessionId,messageId:legacy.messageId,kind:'read',key:'ack-'+officeId},b);
    const materialRequest={action:'publish',officeId,title:'交通与预算草案',version:'草案 v1',content:'两位成年人，从杭州出发，两天一夜。预算上限约 2000 元，出发日期、交通时刻与住宿价格待确认。请结合景点顺序继续调整。',key:'material-'+officeId};
    const material=await graph.building.material(materialRequest,a);
    await graph.building.container({action:'put',officeId,id:officeId+'-note',title:'待确认清单',content:{date:'待确认'},expectedRevision:0,key:'note-'+officeId},a);
    const message=await graph.building.message({action:'send',officeId,recipient:b.roleId,body:process.argv.includes('--preview')?'## 路线 Review\n\n**结论：草案可继续完善。** 出发日期与价格待确认。\n\n- [x] 核对景点顺序\n- [ ] 确认交通时刻与预算\n\n| 检查项 | 当前结果 |\n| --- | --- |\n| 路线 | 两天一夜，避免折返 |\n| 预算 | 上限约 2000 元，待核价 |\n\n> 收到回复后，再更新交通方案。\n\n`review` 记录请保留待确认项。':'小麦，请先安排景点顺序，我会结合路线整理交通与预算。完整草案已放到文本材料，日期和价格暂时待确认。',key:'message-'+officeId},a);
    const task=await graph.offices.item({action:'create',workSessionId:session.workSessionId,title:'Fixture task',acceptance:'Evidence required',owner:officeId+'-a',reviewer:officeId+'-b',key:'task-'+officeId},a);
    const claim=await graph.offices.item({action:'claim',workSessionId:session.workSessionId,itemId:task.item.id,expectedRevision:task.item.revision,key:'claim-'+officeId},a);
    await graph.offices.item({action:'submit',workSessionId:session.workSessionId,itemId:task.item.id,expectedRevision:claim.item.revision,leaseToken:claim.leaseToken,codeVersion:'fixture-v1',materialId:material.materialId,key:'submit-'+officeId},a);
    return {session,message,material,materialRequest,task};
  };
  const removed=await fill('delete-room'),kept=await fill('keep-room');
  const privateMessage=await graph.building.message({action:'send',recipient:c.roleId,body:'Private B to C survives office and A deletion',key:'private-b-c'},b);
  await graph.roles.link({sender:a.roleId,recipient:b.roleId,enabled:true},admin);
  const app=express();app.use(express.json());
  const web=path.resolve(new URL('../web',import.meta.url).pathname);
  app.get('/collaboration',(_req,res)=>res.sendFile(path.join(web,'collaboration.html')));
  app.get('/collaboration/guide',(_req,res)=>res.sendFile(path.join(web,'office-guide.html')));
  app.get('/assets/marked.js',(_req,res)=>res.sendFile(fileURLToPath(new URL('./marked.umd.js',import.meta.resolve('marked')))));
  app.use('/assets',express.static(web));
  management=officeWorkbench(graph,{apiKey:'',operatorKey:process.argv.includes('--preview')?'':'fixture-operator',contextSecret:process.argv.includes('--preview')?'':'fixture-secret',...(process.argv.includes('--preview')?{configFile:path.join(dir,'accounts.json')}:{})});app.use('/api/office-admin',management);
  const previewPort=process.argv.includes('--preview')?Number(process.argv.find(a=>a.startsWith('--preview-port='))?.split('=')[1]??0):0;
  assert(Number.isSafeInteger(previewPort)&&previewPort>=0&&previewPort<=65535);
  server=app.listen(previewPort,'127.0.0.1');await new Promise<void>(resolve=>server!.once('listening',resolve));
  const url=`http://127.0.0.1:${(server.address() as any).port}`;
  let cookie='';
  const request=(route:string,body:unknown={},origin?:string)=>fetch(url+'/api/office-admin/'+route,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
  if(process.argv.includes('--preview')) {
    await graph.roles.configureOffice({id:'archived-example',title:'已归档的演示办公室',state:'cancelled',expectedRevision:0},admin);
    await graph.offices.settings(admin,'https://memory.example/mcp');
    await graph.roles.application({action:'submit',name:'小橘',introduction:'擅长整理旅行资料和待确认清单',reason:'希望一起完成两天一夜的出游计划',key:'guide-application'},
      {v:1,principal:'owner',agentId:'connector',runtimeId:'guide-pending',transport:'http-mcp',issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER});
    await graph.offices.configureAgent({id:'unused-example',principal:'demo-unused',name:'不再使用的测试连接',host:'codex',state:'pending',expectedRevision:0},admin);
    const processing=await graph.building.message({action:'send',officeId:'keep-room',recipient:b.roleId,body:'请核对两天一夜的景点安排，避免绕路。',key:'cycle-processing'},a);
    await graph.building.message({action:'take',messageId:processing.messageId,key:'cycle-take'},b);
    const completed=await graph.building.message({action:'send',officeId:'keep-room',recipient:b.roleId,body:'请整理交通方案需要进一步确认的事项。',key:'cycle-completed'},a);
    await graph.building.message({action:'take',messageId:completed.messageId,key:'cycle-completed-take'},b);
    await graph.building.message({action:'finish',messageId:completed.messageId,result:'已整理待确认事项：出发日期、车次和住宿价格。没有把未核验价格当成事实。',key:'cycle-completed-finish'},b);
    const demoActor=b;
    const lesson=await graph.saveMemory('隔离旅行演示：先固定出发日期，再核对交通与住宿报价；没有核验的价格必须明确标成待确认。该经验来自虚构演示，不能当成真实行程资料。',{domain:await graph.memoryOwners.domain({kind:'agent',id:b.roleId!}),memberships:[{spaceId:'demo-travel',memoryType:'work'}],sourceRefs:[{uri:'fixture:travel-review',context:'Fictional demonstration',revision:'demo-v1'}]});
    await graph.officeCollaboration.publish({kind:'learning',officeId:'keep-room',title:'先确认日期，再核查价格',memoryId:lesson.id,messageId:processing.messageId,outcome:'used',evidence:'对照讨论，发现日期尚未确定，因此保留交通与住宿报价为待确认。',key:'guide-learning'},demoActor);
    await graph.officeCollaboration.publish({kind:'handoff',officeId:'keep-room',title:'两天一夜路线交接',summary:'已整理景点顺序与交通核验入口，出发日期和报价仍需确认。',materialIds:[kept.material.materialId],checks:['已检查景点动线，减少折返','报价未核验，明确保留不确定性'],unresolved:['出发日期','最终车次与住宿价格'],nextSteps:['用户确认日期后核对官方交通与住宿信息'],key:'guide-handoff'},b);
    await graph.officeCollaboration.publish({kind:'marker',officeId:'keep-room',title:'先确认日期，再确定交通',summary:'演示决定：不把未核验价格写成事实。',key:'guide-marker'},b);
    await graph.officeCollaboration.publish({kind:'presence',officeId:'keep-room',title:'整理路线经验',phase:'learning',area:'library',key:'guide-presence'},b);
    const probe=await graph.officeCollaboration.host({action:'probe',waitMs:100,client:'虚构演示宿主',toolTimeoutMs:360000},b);await graph.officeCollaboration.host({action:'confirm',probeId:probe.probeId,clientRoundTripMs:probe.measuredWaitMs},b);
    let demoCount=0;
    app.post('/fixture/message-cycle',async(req,res,next)=>{try{
      if(req.body.action==='send'){res.json(await graph.building.message({action:'send',officeId:'keep-room',recipient:b.roleId,body:'隔离演示新增消息：验证数量和筛选自动同步。',key:'live-count-'+(++demoCount)},a));return;}
      if(req.body.action==='take'){res.json(await graph.building.message({action:'take',messageId:req.body.messageId,key:'live-count-take-'+req.body.messageId},b));return;}
      if(req.body.action==='finish')res.json(await graph.building.message({action:'finish',messageId:processing.messageId,result:'路线核对完成，已保留日期与价格的不确定性。',key:'cycle-finish'},b));
      else res.status(400).json({error:'Disposable fixture accepts finish only'});
    }catch(error){next(error);}});
    if(process.argv.includes('--animate')){
      let n=0,busy=false;
      const timer=setInterval(async()=>{if(busy||n>=18)return;busy=true;try{n++;const sent=await graph.building.message({action:'send',officeId:'keep-room',recipient:b.roleId,body:`隔离演示消息 ${n}：请核对交通与路线。`,key:'live-demo-'+n},a);await graph.building.material({action:'get',officeId:'keep-room',materialId:kept.material.materialId,number:0},b);if(n%2===0){await graph.building.message({action:'take',messageId:sent.messageId,key:'live-demo-take-'+n},b);await graph.building.message({action:'finish',messageId:sent.messageId,result:'演示核对完成',key:'live-demo-archive-'+n},b);}}finally{busy=false;if(n>=18)clearInterval(timer);}},8000);
      server!.once('close',()=>clearInterval(timer));
    }
    console.log(JSON.stringify({preview:url+'/collaboration',guide:url+'/collaboration/guide'}));
    await new Promise<void>(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
  } else {
    const roleRequest={id:a.roleId,expectedRevision:1},roomRequest={id:'delete-room',expectedRevision:1};
    assert.equal((await request('role/delete',roleRequest)).status,401);
    assert.equal((await request('office/delete',roomRequest)).status,401);
    const login=await request('login',{operatorKey:'fixture-operator'});assert.equal(login.status,200);cookie=login.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await request('office/delete',roomRequest,'https://wrong.example')).status,403);
    assert.equal((await request('role/delete',{...roleRequest,expectedRevision:99})).status,409);
    assert.equal((await request('office/delete',{...roomRequest,expectedRevision:99})).status,409);
    assert.equal((await request('office/delete',{...roomRequest,expectedRevision:0})).status,400);
    await assert.rejects(graph.roles.deleteRole({roleId:a.roleId!,expectedRevision:1},a));
    await assert.rejects(graph.roles.deleteOffice(roomRequest,a));
    assert(!roleOperations(graph).some(op=>op.name.includes('delete')),'agents cannot discover admin deletion tools');
    console.log('PASS deletion requires current user management, same origin and an exact revision');

    // Closed rooms remain readable and deletable without reopening them or enabling agent writes.
    for(const state of ['cancelled','completed']) {
      const id='closed-'+state;
      await createOffice(id);
      await graph.roles.configureOffice({id,title:'已结束示例',state,expectedRevision:1},admin);
      const registry=await (await request('state')).json() as any;
      assert(registry.offices.some((o:any)=>o.id===id&&o.state===state));
      assert.equal((await request('view',{officeId:id})).status,200);
      assert.equal((await request('office/delete',{id,expectedRevision:1})).status,409);
      assert.equal((await request('office/delete',{id,expectedRevision:2})).status,200);
      assert.equal(await db.get('SELECT id FROM offices WHERE id=?',[id]),undefined);
    }
    console.log('PASS archived/completed rooms can be read and permanently deleted at the current revision');

    const counts=async()=>Promise.all(['offices','office_sessions','office_messages','role_messages','office_materials','office_chunks','office_containers','office_items','office_rounds'].map(async table=>[table,(await db.get(`SELECT COUNT(*) n FROM ${table}`)).n]));
    const before=await counts();
    const run=db.run.bind(db);db.run=async(sql:string,...args:unknown[])=>{
      if(sql==='DELETE FROM offices WHERE id=?')throw Error('Injected deletion failure');
      return run(sql,...args);
    };
    try {assert.equal((await request('office/delete',roomRequest)).status,500);}finally{db.run=run;}
    assert.deepEqual(await counts(),before,'a mid-deletion failure rolls back every dependency');
    console.log('PASS deletion is atomic even after dependent messages, materials and bindings were removed');

    assert.equal((await request('office/delete',roomRequest)).status,200);
    for(const table of ['offices','office_seats','office_sessions','office_events','office_messages','office_materials','office_containers','office_items','office_rounds']) {
      if(table==='offices')assert.equal(await db.get('SELECT id FROM offices WHERE id=?',['delete-room']),undefined);
      else if(table==='office_sessions')assert.equal(await db.get('SELECT id FROM office_sessions WHERE id=?',[removed.session.workSessionId]),undefined);
      else if(table==='office_rounds')assert.equal(await db.get('SELECT id FROM office_rounds WHERE item_id=?',[removed.task.item.id]),undefined);
      else assert.equal((await db.get(`SELECT COUNT(*) n FROM ${table} WHERE office_id=?`,['delete-room'])).n,0,table);
    }
    assert.equal((await db.get('SELECT COUNT(*) n FROM office_chunks WHERE material_id=?',[removed.material.materialId])).n,0);
    assert.equal(await db.get('SELECT id FROM role_messages WHERE id=?',[removed.message.messageId]),undefined);
    assert.equal(await db.get("SELECT key FROM building_receipts WHERE key='message-delete-room'"),undefined);
    assert.equal(await db.get("SELECT key FROM building_receipts WHERE key='material-delete-room'"),undefined,'deleted material publication receipts must be removed');
    assert(await db.get("SELECT key FROM building_receipts WHERE key='material-keep-room'"),'other rooms retain material idempotency');
    assert.equal((await graph.roles.sync(a)).identity?.primaryAssignmentId,'keep-room-a');
    assert.equal((await graph.roles.registry(admin)).roles.length,3);
    assert.equal((await graph.building.container({action:'get',officeId:'keep-room',id:'keep-room-note'},b)).title,'待确认清单');
    await assert.rejects(graph.offices.resolveContext(removed.session.workSessionId,a));
    assert.equal((await request('office/delete',roomRequest)).status,409);
    // Reusing a user-chosen office ID must not replay a result referencing deleted material.
    await createOffice('delete-room');
    const republished=await graph.building.material(removed.materialRequest,a);
    assert.notEqual(republished.materialId,removed.material.materialId);
    assert(await db.get('SELECT id FROM office_materials WHERE id=?',[republished.materialId]));
    assert.equal((await request('office/delete',roomRequest)).status,200);
    console.log('PASS office hard deletion purges all office content and replay receipts, preserving roles and other offices');

    await graph.roles.configureOffice({id:'transfer-room',title:'Transfer fixture',state:'active',expectedRevision:0,seats:[
      {id:'transfer-a',agentId:'connector',roleId:a.roleId,label:'A',role:'worker'},
      {id:'transfer-b',agentId:'connector',roleId:b.roleId,label:'B',role:'worker'},
      {id:'transfer-c',agentId:'connector',roleId:c.roleId,label:'C',role:'reviewer'},
    ]},admin);
    const transferContext=(await graph.offices.open({assignmentId:'transfer-b'},b)).context!;
    const otherTask=await graph.offices.item({action:'create',workSessionId:transferContext.workSessionId,title:'Other owner task',acceptance:'Evidence',owner:'transfer-b',reviewer:'transfer-c',key:'other-task'},b);
    await graph.offices.item({action:'transfer',workSessionId:transferContext.workSessionId,itemId:otherTask.item.id,expectedRevision:otherTask.item.revision,target:'transfer-a',key:'propose-transfer'},b);

    let started!:()=>void;
    const waitStarted=new Promise<void>(resolve=>started=resolve);
    const nextRole=(await db.get('SELECT COALESCE(MAX(seq),0) n FROM role_events')).n;
    db.run=async(sql:string,...args:unknown[])=>{const result=await run(sql,...args);if(sql.startsWith('INSERT INTO role_message_waits'))started();return result;};
    const waiting=graph.building.wait({afterSeq:nextRole,waitMs:3000},a).then(()=>false,()=>true);
    try{await waitStarted;}finally{db.run=run;}
    assert.equal((await request('role/delete',roleRequest)).status,200);
    assert(await waiting,'an in-flight role waiter must lose authorization');
    for(const table of ['character_roles','role_bindings','role_seats','role_links','role_messages']) {
      const where=table==='character_roles'?'id=?':table==='role_links'||table==='role_messages'?'sender=? OR recipient=?':'role_id=?';
      const values=table==='role_links'||table==='role_messages'?[a.roleId,a.roleId]:[a.roleId];
      assert.equal((await db.get(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`,values)).n,0,table);
    }
    assert.equal((await db.get('SELECT state FROM office_sessions WHERE id=?',[kept.session.workSessionId])).state,'closed');
    assert.equal((await db.get('SELECT status FROM office_items WHERE id=?',[kept.task.item.id])).status,'cancelled');
    assert.equal((await db.get('SELECT state FROM office_rounds WHERE item_id=?',[kept.task.item.id])).state,'superseded');
    assert.equal((await db.get('SELECT enabled FROM office_seats WHERE id=?',['keep-room-a'])).enabled,0);
    const remaining=await db.get('SELECT owner,status,transfer_to,transfer_epoch FROM office_items WHERE id=?',[otherTask.item.id]);
    assert.equal(remaining.owner,'transfer-b');assert.equal(remaining.status,'open');
    assert.equal(remaining.transfer_to,null);assert.equal(remaining.transfer_epoch,null);
    assert(await db.get('SELECT id FROM office_materials WHERE id=?',[kept.material.materialId]));
    assert(await db.get('SELECT id FROM role_messages WHERE id=?',[privateMessage.messageId]));
    await assert.rejects(graph.roles.binding(a));
    await assert.rejects(graph.offices.resolveContext(kept.session.workSessionId,a));
    assert.equal((await graph.roles.sync({...a,roleId:undefined,roleBindingId:undefined,roleBindingEpoch:undefined})).state,'unregistered');
    assert.equal((await graph.getStats()).total,1,'private memory is not an office record');
    assert.equal((await db.all('PRAGMA foreign_key_check')).length,0);
    assert.equal((await request('role/delete',roleRequest)).status,409);
    console.log('PASS role hard deletion fences waits/sessions, cancels pending work and preserves other people, materials and independent memory');

    // Archived rooms remain eligible for permanent deletion.
    const registry=await graph.offices.registry(admin),room=registry.offices.find((r:any)=>r.id==='keep-room')!;
    await graph.roles.configureOffice({id:room.id,title:room.title,state:'cancelled',expectedRevision:room.revision},admin);
    const revision=(await db.get('SELECT revision FROM offices WHERE id=?',[room.id])).revision;
    assert.equal((await request('office/delete',{id:room.id,expectedRevision:revision})).status,200);
    assert.equal((await db.all('PRAGMA foreign_key_check')).length,0);
    const guide=await fetch(url+'/collaboration/guide');assert.equal(guide.status,200);
    const text=await guide.text();for(const marker of ['五步','复制给小栗','复制给小麦','永久删除角色','永久删除办公室','常见问题'])assert(text.includes(marker));
    assert.equal((text.match(/data-zoom /g)??[]).length,27,'screenshot walkthrough includes role switching, layered memory and working continuity');
    assert(text.includes('26-role-continuity.jpg')&&text.includes('memory_resume'),'continuity instructions must include the actual page screenshot and resume entry');
    assert(text.includes('shotDialog'));
    for(const asset of ['office-guide.css','office-guide.js','guide/01-login.jpg','guide/09-office-delete.jpg','guide/11-replay.jpg','guide/12-message-cycle.jpg','guide/13-connection-delete.jpg','guide/14-experience.jpg','guide/15-controls.jpg','guide/16-replay-filters.jpg','guide/17-live-counts.jpg','guide/18-memory-search.jpg','guide/19-memory-assign.jpg','guide/20-role-activation.jpg','guide/21-role-connection.jpg'])assert.equal((await fetch(url+'/assets/'+asset)).status,200);
    for(const asset of ['22-role-switch','23-office-memory','24-office-memory-policy','25-role-memory-copy'])assert.equal((await fetch(url+'/assets/guide/'+asset+'.jpg')).status,200);
    console.log('PASS archived offices can be deleted; independent beginner guide and assets are publicly readable');
  }
} finally {
  management?.closeObservers();
  if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
  await graph.close();embedding.generateEmbedding=originalEmbedding;await fs.rm(dir,{recursive:true,force:true});
}
