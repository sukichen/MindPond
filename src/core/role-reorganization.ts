/** Human-directed ownership changes. No semantic inference or model execution. */
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database} from 'sqlite';
import type {GraphMemory} from './graph-memory.js';
import type {TrustedCallContext} from './trust.js';
import {MindPondError} from './errors.js';
import {digest,stableJSON} from './growth.js';
import {messageStateSql} from './office-message-state.js';
const id=z.string().min(1).max(160),ids=id.array().max(1000).default([]).refine(a=>new Set(a).size===a.length,'Selections must be distinct');
export const roleReorganizationSchema=z.discriminatedUnion('mode',[
 z.object({mode:z.literal('merge'),sourceId:z.string().uuid(),targetId:z.string().uuid(),name:z.string().trim().min(1).max(120),introduction:z.string().trim().min(1).max(4000),checkpointChoice:z.enum(['target','source']).default('target')}).strict(),
 z.object({mode:z.literal('split'),sourceId:z.string().uuid(),name:z.string().trim().min(1).max(120),introduction:z.string().trim().min(1).max(4000),memoryIds:ids,scriptIds:ids,taskIds:ids,artifactIds:ids,officeIds:ids,checkpointScopes:z.string().max(160).array().max(50).default([]).refine(a=>new Set(a).size===a.length,'Selections must be distinct')}).strict()
]);
export const roleReorganizationChoicesSchema=z.object({roleId:z.string().uuid(),kind:z.enum(['roles','memories','scripts','tasks','artifacts','offices','checkpoints']),after:z.string().max(160).optional(),query:z.string().trim().max(120).default('')}).strict();
type Input=z.infer<typeof roleReorganizationSchema>;
type Row=Record<string,any>;
const fail=(code:ConstructorParameters<typeof MindPondError>[0],message:string):never=>{throw new MindPondError(code,message);};
const inList='SELECT value FROM json_each(?)';
export class RoleReorganization{
 constructor(private db:Database,private graph:GraphMemory,private write:<T>(fn:()=>Promise<T>)=>Promise<T>,private clock=Date.now){}
 async init(){await this.db.exec(`
 CREATE TABLE IF NOT EXISTS role_reorganizations(id TEXT PRIMARY KEY,input TEXT NOT NULL,fingerprint TEXT NOT NULL,impact TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,result TEXT);
 CREATE INDEX IF NOT EXISTS role_reorganization_pending ON role_reorganizations(expires_at) WHERE result IS NULL;
 CREATE TABLE IF NOT EXISTS role_merge_origins(source_id TEXT PRIMARY KEY,target_id TEXT NOT NULL,operation_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS role_message_origins(message_id TEXT PRIMARY KEY REFERENCES role_messages(id) ON DELETE CASCADE,sender TEXT NOT NULL,recipient TEXT NOT NULL);
 `);}
 private admin(a?:TrustedCallContext){if(!a?.operator||a.expiresAt<=this.clock())fail('scope_denied','Only the human manager can merge or split roles');}
 private async role(id:string){const r=await this.db.get<Row>("SELECT * FROM character_roles WHERE id=? AND state IN ('active','disabled')",[id]);if(!r)fail('not_found','角色不存在或已合并，请刷新角色目录。');return r!;}
 async choices(value:unknown,a?:TrustedCallContext){this.admin(a);const i=roleReorganizationChoicesSchema.parse(value),r=await this.role(i.roleId);
  const ns=await this.db.get<Row>('SELECT domain_id FROM memory_role_namespaces WHERE role_id=?',[r.id]);
  let sql='',args:any[]=[];
  switch(i.kind){
   case 'roles':sql="SELECT id,name label,introduction detail FROM character_roles WHERE state='active' AND id<>? AND principal=?";args=[r.id,r.principal];break;
   case 'memories':sql="SELECT id,content label,dimension detail FROM nodes WHERE domain_kind='personal' AND domain_id=?";args=[ns?.domain_id??null];break;
   case 'scripts':sql='SELECT id,filename label,description detail FROM office_scripts WHERE role_id=?';args=[r.id];break;
   case 'tasks':sql="SELECT id,json_extract(payload,'$.title') label,status detail FROM role_continuity_tasks WHERE role_id=?";args=[r.id];break;
   case 'artifacts':sql="SELECT id,filename label,scope detail FROM office_artifacts WHERE owner_role=? AND scope<>'office' AND state='ready' AND expires_at>?";args=[r.id,this.clock()];break;
   case 'offices':sql='SELECT DISTINCT o.id,o.title label,s.role detail FROM role_seats rs JOIN office_seats s ON s.id=rs.seat_id JOIN offices o ON o.id=s.office_id WHERE rs.role_id=? AND s.enabled=1';args=[r.id];break;
   case 'checkpoints':sql="SELECT scope id,json_extract(payload,'$.goal') label,CASE WHEN scope='' THEN '角色进度' ELSE '办公室进度' END detail FROM role_continuity_checkpoints WHERE role_id=?";args=[r.id];break;
  }
  const rows=await this.db.all<Row[]>('SELECT * FROM ('+sql+") WHERE (? IS NULL OR id>?) AND instr(lower(label),lower(?))>0 ORDER BY id LIMIT 31",[...args,i.after??null,i.after??null,i.query]);
  return {records:rows.slice(0,30).map(r=>({...r,label:r.label.slice(0,i.kind==='memories'?150:200)})),hasMore:rows.length>30,nextAfter:rows.length>30?rows[29].id:null};
 }
 private async snapshot(i:Input){
  const source=await this.role(i.sourceId),target=i.mode==='merge'?await this.role(i.targetId):null;
  if(target&&(target.id===source.id||target.principal!==source.principal))fail('invalid_input','请选择同一账户下的两个不同角色。');
  if(target&&target.state!=='active')fail('invalid_input','请先启用主角色，再合并。');
  if(target)await this.graph.memoryOwners.domain({kind:'agent',id:target.id},false);
  const roles=[source.id,...(target?[target.id]:[])],rs=JSON.stringify(roles);
  const namespaces=await this.db.all<Row[]>(`SELECT * FROM memory_role_namespaces WHERE role_id IN (${inList}) ORDER BY role_id`,[rs]);
  const domains=JSON.stringify(namespaces.map(n=>n.domain_id));
  const nodes=await this.db.all<Row[]>(`SELECT id,domain_id,content,tags,dimension,dimensions,primary_dimension,importance,verified,superseded_by,updated_at FROM nodes WHERE domain_kind='personal' AND domain_id IN (${inList}) ORDER BY id`,[domains]);
  const sourceDomain=namespaces.find(n=>n.role_id===source.id)?.domain_id;
  const ownNodes=nodes.filter(n=>n.domain_id===sourceDomain);
  const scripts=await this.db.all<Row[]>(`SELECT id,role_id,revision FROM office_scripts WHERE role_id IN (${inList}) ORDER BY id`,[rs]);
  const tasks=await this.db.all<Row[]>(`SELECT * FROM role_continuity_tasks WHERE role_id IN (${inList}) ORDER BY role_id,id`,[rs]);
  const checkpoints=await this.db.all<Row[]>(`SELECT * FROM role_continuity_checkpoints WHERE role_id IN (${inList}) ORDER BY role_id,scope`,[rs]);
  const artifacts=await this.db.all<Row[]>(`SELECT id,owner_role,scope,office_id,state,expires_at,upload_expires_at,lease_id,lease_until FROM office_artifacts WHERE owner_role IN (${inList}) ORDER BY id`,[rs]);
  const seats=await this.db.all<Row[]>(`SELECT s.*,rs.role_id,o.revision office_revision FROM role_seats rs JOIN office_seats s ON s.id=rs.seat_id JOIN offices o ON o.id=s.office_id WHERE rs.role_id IN (${inList}) ORDER BY s.id`,[rs]);
  const chosen=(rows:Row[],keys:string[]|undefined,key='id')=>i.mode==='merge'?rows.filter(r=>(r.role_id??r.owner_role??source.id)===source.id):keys!.map(id=>{const r=rows.find(r=>r[key]===id&&(r.role_id??r.owner_role??source.id)===source.id);if(!r)fail('invalid_input','所选内容已删除或不属于来源角色，请刷新。');return r!;});
  const moved={nodes:chosen(ownNodes,i.mode==='split'?i.memoryIds:undefined),scripts:chosen(scripts,i.mode==='split'?i.scriptIds:undefined),tasks:chosen(tasks,i.mode==='split'?i.taskIds:undefined),artifacts:chosen(artifacts,i.mode==='split'?i.artifactIds:undefined),checkpoints:chosen(checkpoints,i.mode==='split'?i.checkpointScopes:undefined,'scope')};
  const movedIds=JSON.stringify(moved.nodes.map(n=>n.id)),allIds=JSON.stringify(nodes.map(n=>n.id));
  const associations=await this.db.all<Row[]>(`SELECT a.*,ma.memory_id a_node,mb.memory_id b_node FROM memory_associations a JOIN memory_memberships ma ON ma.id=a.member_a_id JOIN memory_memberships mb ON mb.id=a.member_b_id WHERE ma.memory_id IN (${inList}) OR mb.memory_id IN (${inList}) ORDER BY a.id`,[allIds,allIds]);
  const edges=await this.db.all<Row[]>(`SELECT * FROM edges WHERE from_id IN (${inList}) OR to_id IN (${inList}) ORDER BY id`,[allIds,allIds]);
  const supports=await this.db.all<Row[]>(`SELECT s.*,a.memory_id a_node,b.memory_id b_node FROM profile_supports s JOIN memory_memberships a ON a.id=s.profile_id JOIN memory_memberships b ON b.id=s.source_id WHERE a.memory_id IN (${inList}) OR b.memory_id IN (${inList}) ORDER BY s.profile_id,s.source_id`,[allIds,allIds]);
  const membership=await this.db.all<Row[]>(`SELECT * FROM memory_memberships WHERE memory_id IN (${inList}) ORDER BY id`,[allIds]);
  const signals=await this.db.all<Row[]>(`SELECT * FROM memory_improvement_signals WHERE memory_a_id IN (${inList}) OR memory_b_id IN (${inList}) ORDER BY id`,[allIds,allIds]);
  const bindings=await this.db.all<Row[]>(`SELECT id,role_id,epoch,state FROM role_bindings WHERE role_id IN (${inList}) ORDER BY id`,[rs]);
  const meetings=await this.db.all<Row[]>(`SELECT m.*,r.title FROM office_discussion_members m JOIN office_discussions r ON r.id=m.room_id WHERE m.role_id IN (${inList}) AND m.state IN ('joined','invited') ORDER BY m.room_id,m.role_id`,[rs]);
  const mail=await this.db.all<Row[]>(`SELECT m.id,m.sender,m.recipient,s.state FROM role_messages m JOIN role_message_states s ON s.message_id=m.id WHERE (m.sender IN (${inList}) OR m.recipient IN (${inList})) AND ${messageStateSql()}<>'archived' ORDER BY m.id`,[rs,rs]);
  const departures=await this.db.all<Row[]>(`SELECT id,role_id,pending_count FROM office_discussion_departures WHERE role_id IN (${inList}) AND pending_count>0 ORDER BY id`,[rs]);
  const jobs=await this.db.all<Row[]>(`SELECT id,status,updated_at,lease_expires_at,cancelled_at FROM organization_jobs WHERE domain_kind='personal' AND domain_id IN (${inList}) AND status='leased' AND cancelled_at IS NULL AND lease_expires_at>? ORDER BY id`,[domains,this.clock()]);
  const ownedSeats=JSON.stringify(seats.map(s=>s.id));
  const claimed=await this.db.all<Row[]>(`SELECT id,revision FROM office_items WHERE status NOT IN ('completed','cancelled') AND (owner IN (${inList}) OR reviewer IN (${inList}) OR transfer_to IN (${inList})) ORDER BY id`,[ownedSeats,ownedSeats,ownedSeats]);
  const blockers:string[]=[];
  if(meetings.some(m=>m.state==='joined'))blockers.push('请先总结并退出会议室，再调整角色。');
  if(departures.length)blockers.push('请先发送或丢弃会议结束后的待发消息。');
  if(mail.length)blockers.push(`相关角色还有 ${mail.length} 条未完成消息，请先处理归档，再预览。`);
  if(jobs.length||claimed.length)blockers.push('请先结束记忆整理，并完成或取消当前负责、审核的工作项，再预览。');
  if(artifacts.some(r=>r.state==='pending'&&r.expires_at>this.clock()&&r.upload_expires_at>this.clock()))blockers.push('请先完成或删除待上传附件。');
  const selected=new Set<string>(moved.nodes.map(n=>n.id)),cross=(a:string,b:string)=>selected.has(a)!==selected.has(b);
  if(i.mode==='split'){
   if(!Object.values(moved).some(a=>a.length)&&!i.officeIds.length)blockers.push('至少选择一项记忆、脚本、工作进度、附件或办公室。');
   if(supports.some(s=>cross(s.a_node,s.b_node)))blockers.push('综合记忆与它的依据必须一起迁移，请补选相关记忆。');
   if(nodes.some(n=>n.superseded_by&&cross(n.id,n.superseded_by)))blockers.push('同一记忆的替代版本必须一起迁移，请补选相关记忆。');
   for(const office of i.officeIds){const occupancy=await this.db.get<Row>('SELECT count(*) n FROM office_seats WHERE office_id=? AND enabled=1',[office]);if(occupancy!.n>=50)blockers.push('所选办公室已达 50 个成员，请先调整成员。');}
   for(const office of i.officeIds)if(!seats.some(s=>s.role_id===source.id&&s.office_id===office&&s.enabled))fail('invalid_input','所选办公室不属于来源角色。');
   if(moved.artifacts.some(r=>r.scope==='office'||r.state!=='ready'||r.expires_at<=this.clock()))fail('invalid_input','拆分只迁移仍有效的角色私有或指定接收者附件。');
   if([...moved.tasks,...moved.checkpoints].some(r=>r.scope&&!i.officeIds.includes(r.scope)))blockers.push('办公室工作进度需要同时选择对应办公室。');
   // Structured source references cannot silently become invisible after moving a task.
   for(const r of [...tasks.filter(t=>t.role_id===source.id),...checkpoints.filter(t=>t.role_id===source.id)]){
    const moving=(moved.tasks.includes(r)||moved.checkpoints.includes(r));
    for(const ref of JSON.parse(r.payload).sources??[]){
     if(ref.kind==='memory'&&ownNodes.some(n=>n.id===ref.id)&&selected.has(ref.id)!==moving)blockers.push('工作进度与引用的角色记忆必须一起迁移或一起保留。');
     if(moving&&ref.kind==='message')blockers.push('所选进度引用了来源角色的私信，请先改为可迁移的记忆来源。');
    }
   }
  }
  if((target?scripts.filter(s=>s.role_id===target.id).length:0)+moved.scripts.length>100)blockers.push('目标角色脚本将超过 100 份，请先整理脚本。');
  const active=(r:Row)=>!r.archived_at&&!['done','cancelled'].includes(r.status);
  if((target?tasks.filter(t=>t.role_id===target.id&&active(t)).length:0)+moved.tasks.filter(active).length>200)blockers.push('目标角色未完成任务将超过 200 项，请先整理任务。');
  const scopes=new Set([...(target?checkpoints.filter(c=>c.role_id===target.id).map(c=>c.scope):[]),...moved.checkpoints.map(c=>c.scope)]);
  if(scopes.size>50)blockers.push('目标角色工作进度范围将超过 50 个，请先整理。');
  if((target?artifacts.filter(r=>r.owner_role===target.id&&['ready','pending'].includes(r.state)).length:0)+moved.artifacts.filter(r=>['ready','pending'].includes(r.state)).length>1024)blockers.push('目标角色附件将超过 1024 份，请先清理。');
  const cutAssociations=i.mode==='split'?associations.filter(r=>cross(r.a_node,r.b_node)):[],cutEdges=i.mode==='split'?edges.filter(r=>cross(r.from_id,r.to_id)):[];
  const impact={mode:i.mode,source:{id:source.id,name:source.name},target:target?{id:target.id,name:target.name}:null,name:i.name,counts:{memories:moved.nodes.length,scripts:moved.scripts.length,tasks:moved.tasks.length,checkpoints:moved.checkpoints.length,artifacts:moved.artifacts.length,offices:i.mode==='split'?i.officeIds.length:new Set(seats.filter(s=>s.enabled).map(s=>s.office_id)).size,cutAssociations:cutAssociations.length,cutEdges:cutEdges.length,checkpointConflicts:target?moved.checkpoints.filter(c=>checkpoints.some(t=>t.role_id===target.id&&t.scope===c.scope)).length:0},blockers:[...new Set(blockers)],notice:i.mode==='merge'?'来源角色退出角色目录；历史消息保留当时姓名并交给主角色。两个角色均断开聊天连接，断开后聊天按人类身份访问记忆；请重新绑定后继续角色工作。办公室共享记忆保持原位。同名脚本保留各自编号，记忆不自动去重。':'选中内容迁到新角色，未选内容留在原角色；办公室为新角色增加成员资格。跨角色的关联边会断开，内部关联和权重保留。原角色断开连接后聊天按人类身份访问记忆；请为两个角色重新绑定聊天后继续角色工作。'};
  const fingerprint=digest({i,source,target,namespaces,nodes,scripts,tasks,checkpoints,artifacts,seats,associations,edges,supports,membership,signals,bindings,meetings,mail,departures,jobs,claimed,
   // Permission and receipt changes in another process also invalidate a preview.
   index:await this.db.get("SELECT value FROM memory_meta WHERE key='index_generation'"),
   grants:await this.db.all(`SELECT * FROM role_links WHERE sender IN (${inList}) OR recipient IN (${inList}) ORDER BY sender,recipient`,[rs,rs]),
   recipients:await this.db.all(`SELECT * FROM office_artifact_recipients WHERE role_id IN (${inList}) ORDER BY artifact_id,role_id`,[rs])});
  return {source,target,moved,seats,impact,fingerprint,cutAssociations,cutEdges,movedIds,signals};
 }
 async preview(value:unknown,a?:TrustedCallContext){this.admin(a);const i=roleReorganizationSchema.parse(value);return this.write(async()=>{
  await this.db.run('DELETE FROM role_reorganizations WHERE result IS NULL AND expires_at<?',[this.clock()]);
  const count=await this.db.get<Row>('SELECT count(*) n FROM role_reorganizations WHERE result IS NULL');if(count!.n>=100)fail('temporarily_unavailable','预览过多，请稍后重试。');
  const s=await this.snapshot(i),id=randomUUID(),expires=this.clock()+15*60000;
  await this.db.run('INSERT INTO role_reorganizations VALUES(?,?,?,?,?,?,NULL)',[id,stableJSON(i),s.fingerprint,stableJSON(s.impact),this.clock(),expires]);
  return {previewId:id,expiresAt:expires,...s.impact};
 });}
 async apply(previewId:string,a?:TrustedCallContext){this.admin(a);z.string().uuid().parse(previewId);return this.write(async()=>{
  const plan=await this.db.get<Row>('SELECT * FROM role_reorganizations WHERE id=?',[previewId]);if(!plan)fail('not_found','预览不存在，请重新预览。');
  if(plan!.result)return JSON.parse(plan!.result);
  if(plan!.expires_at<=this.clock())fail('stale_version','预览已过期，请重新预览。');
  const i=roleReorganizationSchema.parse(JSON.parse(plan!.input)),s=await this.snapshot(i);
  if(s.fingerprint!==plan!.fingerprint)fail('stale_version','角色或相关内容已变化，请重新预览。');
  if(s.impact.blockers.length)fail('invalid_input',s.impact.blockers.join(' '));
  const targetId=s.target?.id??randomUUID(),now=this.clock();
  if(!s.target)await this.db.run("INSERT INTO character_roles VALUES(?,?,?,?,'active',1,NULL,?)",[targetId,s.source.principal,i.name,i.introduction,now]);
  const domain=await this.graph.memoryOwners.domain({kind:'agent',id:targetId});
  await this.db.run("INSERT OR IGNORE INTO memory_domains(kind,id,status,created_at,updated_at) VALUES('personal',?,'active',?,?)",[domain.id,now,now]);
  for(const r of [s.source,...(s.target?[s.target]:[])]){
   await this.db.run("UPDATE role_bindings SET state='revoked',epoch=epoch+1 WHERE role_id=?",[r.id]);
   await this.db.run("UPDATE memory_role_credentials SET state='revoked' WHERE role_id=?",[r.id]);
   await this.db.run("UPDATE office_sessions SET state='closed' WHERE seat_id IN (SELECT seat_id FROM role_seats WHERE role_id=?)",[r.id]);
  }
  // Stable IDs, embeddings and internal topology survive the owner change.
  await this.db.run(`UPDATE nodes SET domain_id=?,updated_at=MAX(updated_at+1,?) WHERE id IN (${inList})`,[domain.id,now,s.movedIds]);
  const selected=new Set(s.moved.nodes.map(n=>n.id));
  for(const signal of s.signals){
   if(!selected.has(signal.memory_a_id)&&!selected.has(signal.memory_b_id))continue;
   // A suggestion about both sides of a split becomes human-only. Neither
   // role may receive the other role's private evidence through its queue.
   const cross=i.mode==='split'&&(!selected.has(signal.memory_a_id)||signal.memory_b_id&&!selected.has(signal.memory_b_id));
   await this.db.run('UPDATE memory_improvement_signals SET domain_kind=?,domain_id=?,updated_at=? WHERE id=?',['personal',cross?'default':domain.id,now,signal.id]);
  }
  // Invalidate snapshots without changing evidence versions or profile freshness.
  await this.db.run(`DELETE FROM organization_cooldowns WHERE membership_id IN (SELECT id FROM memory_memberships WHERE memory_id IN (${inList}))`,[s.movedIds]);
  for(const edge of s.cutAssociations)await this.db.run('DELETE FROM memory_associations WHERE id=?',[edge.id]);
  for(const edge of s.cutEdges)await this.db.run('DELETE FROM edges WHERE id=?',[edge.id]);
  for(const script of s.moved.scripts)await this.db.run('UPDATE office_scripts SET role_id=?,revision=revision+1,updated_at=? WHERE id=?',[targetId,now,script.id]);
  const taskMap=new Map<string,string>();
  await this.db.run("UPDATE role_continuity_receipts SET payload=json_set(payload,'$._roleReorganization',?) WHERE role_id=?",[previewId,s.source.id]);
  for(const task of s.moved.tasks){
   const collision=await this.db.get('SELECT 1 FROM role_continuity_tasks WHERE role_id=? AND id=?',[targetId,task.id]),newId=collision?randomUUID():task.id;taskMap.set(task.id,newId);
   const payload={...JSON.parse(task.payload),id:newId};
   await this.db.run('UPDATE role_continuity_tasks SET role_id=?,id=?,revision=revision+1,payload=?,updated_at=? WHERE role_id=? AND id=?',[targetId,newId,stableJSON(payload),now,s.source.id,task.id]);
  }
  for(const cp of s.moved.checkpoints){
   const prior=await this.db.get<Row>('SELECT * FROM role_continuity_checkpoints WHERE role_id=? AND scope=?',[targetId,cp.scope]);
   // Both exact summaries remain in target history; the human selects the current one.
   for(const record of [cp,...(prior?[prior]:[])])await this.db.run("INSERT INTO role_continuity_history(role_id,scope,kind,entity_id,revision,payload,reason,ts) VALUES(?,?,'checkpoint',NULL,?,?,?,?)",[targetId,cp.scope,record.revision,record.payload,'角色调整 '+previewId+'：'+(record.role_id===s.source.id?s.source.name:s.target?.name),now]);
   if(!prior||i.mode==='merge'&&i.checkpointChoice==='source')await this.db.run('INSERT INTO role_continuity_checkpoints VALUES(?,?,?,?,?,NULL,NULL) ON CONFLICT(role_id,scope) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at,binding_id=NULL,binding_epoch=NULL',[targetId,cp.scope,(prior?.revision??cp.revision)+1,cp.payload,now]);
   await this.db.run('DELETE FROM role_continuity_checkpoints WHERE role_id=? AND scope=?',[s.source.id,cp.scope]);
  }
  // Copy selected history with its original author recorded; never relabel evidence as newly verified.
  await this.db.run(`INSERT INTO role_continuity_history(role_id,scope,kind,entity_id,revision,payload,reason,binding_id,binding_epoch,ts)
   SELECT ?,h.scope,h.kind,COALESCE(json_extract(mapping.value,'$[1]'),h.entity_id),h.revision,
    CASE WHEN json_extract(h.payload,'$.id') IS NOT NULL AND mapping.value IS NOT NULL
     THEN json_set(h.payload,'$.id',json_extract(mapping.value,'$[1]')) ELSE h.payload END,
    ?||h.reason,h.binding_id,h.binding_epoch,h.ts
   FROM role_continuity_history h LEFT JOIN json_each(?) mapping ON json_extract(mapping.value,'$[0]')=h.entity_id
   WHERE h.role_id=? AND (?='merge' OR mapping.value IS NOT NULL OR
    (h.entity_id IS NULL AND h.scope IN (SELECT value FROM json_each(?))))`,
   [targetId,s.source.name+' · ',JSON.stringify([...taskMap]),s.source.id,i.mode,JSON.stringify(s.moved.checkpoints.map(c=>c.scope))]);
  for(const artifact of s.moved.artifacts)await this.db.run('UPDATE office_artifacts SET owner_role=? WHERE id=?',[targetId,artifact.id]);
  const affectedOffices=new Set<string>();
  if(i.mode==='merge'){
   for(const seat of s.seats.filter(r=>r.role_id===s.source.id)){
    affectedOffices.add(seat.office_id);
    if(await this.db.get('SELECT 1 FROM role_seats rs JOIN office_seats os ON os.id=rs.seat_id WHERE rs.role_id=? AND os.office_id=?',[targetId,seat.office_id])){
     const keeper=await this.db.get<Row>('SELECT rs.seat_id,os.enabled FROM role_seats rs JOIN office_seats os ON os.id=rs.seat_id WHERE rs.role_id=? AND os.office_id=? ORDER BY os.enabled DESC,os.id LIMIT 1',[targetId,seat.office_id]);
     if(seat.enabled&&!keeper!.enabled)await this.db.run('UPDATE office_seats SET enabled=1,revision=revision+1 WHERE id=?',[keeper!.seat_id]);
     await this.db.run('UPDATE office_messages SET sender=CASE WHEN sender=? THEN ? ELSE sender END,recipient=CASE WHEN recipient=? THEN ? ELSE recipient END WHERE office_id=? AND (sender=? OR recipient=?)',[seat.id,keeper!.seat_id,seat.id,keeper!.seat_id,seat.office_id,seat.id,seat.id]);
     await this.db.run('INSERT OR IGNORE INTO office_acks SELECT message_id,?,kind FROM office_acks WHERE seat_id=?',[keeper!.seat_id,seat.id]);await this.db.run('DELETE FROM office_acks WHERE seat_id=?',[seat.id]);
     await this.db.run('DELETE FROM role_seats WHERE seat_id=?',[seat.id]);await this.db.run('UPDATE office_seats SET enabled=0,revision=revision+1 WHERE id=?',[seat.id]);
    }else await this.db.run('UPDATE role_seats SET role_id=? WHERE seat_id=?',[targetId,seat.id]);
   }
   await this.db.run('INSERT OR IGNORE INTO role_message_origins SELECT id,sender,recipient FROM role_messages WHERE sender=? OR recipient=?',[s.source.id,s.source.id]);
   await this.db.run('UPDATE role_messages SET sender=CASE WHEN sender=? THEN ? ELSE sender END,recipient=CASE WHEN recipient=? THEN ? ELSE recipient END WHERE sender=? OR recipient=?',[s.source.id,targetId,s.source.id,targetId,s.source.id,s.source.id]);
   await this.db.run('INSERT OR IGNORE INTO role_links SELECT CASE WHEN sender=? THEN ? ELSE sender END,CASE WHEN recipient=? THEN ? ELSE recipient END FROM role_links WHERE sender=? OR recipient=?',[s.source.id,targetId,s.source.id,targetId,s.source.id,s.source.id]);
   await this.db.run('DELETE FROM role_links WHERE sender=? OR recipient=? OR sender=recipient',[s.source.id,s.source.id]);
   await this.db.run('INSERT OR IGNORE INTO office_artifact_recipients SELECT artifact_id,? FROM office_artifact_recipients WHERE role_id=?',[targetId,s.source.id]);
   await this.db.run('DELETE FROM office_artifact_recipients WHERE role_id=?',[s.source.id]);
   await this.db.run("UPDATE office_discussion_members SET state='declined' WHERE role_id=? AND state='invited'",[s.source.id]);
   await this.db.run("UPDATE character_roles SET state='merged',primary_seat=NULL,revision=revision+1 WHERE id=?",[s.source.id]);
   await this.db.run('UPDATE office_control_requests SET role_id=? WHERE role_id=?',[targetId,s.source.id]);
   await this.db.run('INSERT INTO role_merge_origins VALUES(?,?,?)',[s.source.id,targetId,previewId]);
  }else for(const officeId of i.officeIds){
   const original=s.seats.find(r=>r.role_id===s.source.id&&r.office_id===officeId&&r.enabled)!,seatId=randomUUID();
   await this.db.run('INSERT INTO office_seats(id,office_id,agent_id,label,role,enabled,revision) VALUES(?,?,?,?,?,1,1)',[seatId,officeId,original.agent_id,i.name,original.role]);
   await this.db.run('INSERT INTO role_seats VALUES(?,?)',[seatId,targetId]);affectedOffices.add(officeId);
  }
  for(const officeId of affectedOffices){await this.db.run('UPDATE offices SET revision=revision+1 WHERE id=?',[officeId]);await this.graph.officeCollaboration.layout(officeId,a);}
  await this.db.run('UPDATE character_roles SET name=?,introduction=?,revision=revision+1,primary_seat=(SELECT rs.seat_id FROM role_seats rs JOIN office_seats s ON s.id=rs.seat_id WHERE rs.role_id=? AND s.enabled=1 ORDER BY s.id LIMIT 1) WHERE id=?',[i.name,i.introduction,targetId,targetId]);
  if(i.mode==='split')await this.db.run('UPDATE character_roles SET revision=revision+1 WHERE id=?',[s.source.id]);
  await this.db.run("UPDATE memory_meta SET value=CAST(value AS INTEGER)+1 WHERE key='index_generation'");
  await this.db.run('DELETE FROM office_response_pages');
  const result={operationId:previewId,mode:i.mode,sourceId:s.source.id,targetId,name:i.name,counts:s.impact.counts,disconnected:true};
  await this.db.run('UPDATE role_reorganizations SET result=? WHERE id=?',[stableJSON(result),previewId]);
  await this.db.run("INSERT INTO role_events(role_id,kind,body,ts) VALUES(?,'role_reorganized',?,?)",[targetId,stableJSON(result),now]);
  await this.db.run("INSERT INTO memory_action_log(ts,action,reason) VALUES(?,'role_reorganized',?)",[now,stableJSON(result)]);
  return result;
 });}
}
