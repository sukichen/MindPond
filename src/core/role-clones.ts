/** Human-approved independent role dispatch, immutable return packages and explicit absorption. */
import {previewText} from './office-context.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database} from 'sqlite';
import type {GraphMemory} from './graph-memory.js';
import type {TrustedCallContext} from './trust.js';
import type {MemoryOwner} from './memory-owners.js';
import {MindPondError} from './errors.js';
import {digest,stableJSON} from './growth.js';
import {contentHash,knowledgeFingerprint,assetHash,captureKnowledge,decodeKnowledge,encodeKnowledge,installKnowledge,CLONE_LIMITS,type CloneKnowledge} from './role-clone-knowledge.js';
const id=z.string().uuid(),assetId=z.string().min(1).max(160),text=(n:number)=>z.string().trim().min(1).max(n),ids=z.array(assetId).max(100).refine(v=>new Set(v).size===v.length,'IDs must be distinct');
const scriptIdsSchema=ids;
const common={part:z.enum(['content','metadata']).default('content'),reportId:id.optional(),sourceId:assetId.optional(),offset:z.number().int().min(0).default(0),characters:z.number().int().min(256).max(8000).default(4000),afterId:z.string().max(180).optional(),decision:z.enum(['accepted','skipped']).optional(),targetId:assetId.optional(),expectedTargetVersion:z.number().int().positive().optional(),note:text(2000).optional()};
export const cloneOfficeSchema=z.object({...common,action:z.enum(['status','candidates','submit','reports','get_script','review_script','acknowledge']),summary:text(4000).optional(),memoryIds:ids.optional(),scriptIds:scriptIdsSchema.optional(),key:text(256).optional()}).strict();
export const cloneMemoryShape={...common,action:z.enum(['reports','get','review','acknowledge'])};
const manageSchema=z.object({...common,action:z.enum(['status','candidates','dispatch','submit','reports','get','review','import','acknowledge','revoke','resume','purge']),roleId:id,name:text(120).optional(),mission:text(4000).optional(),principal:text(160).optional(),memoryIds:ids.optional(),scriptIds:scriptIdsSchema.optional(),summary:text(4000).optional(),key:text(256).optional(),kind:z.enum(['memory','script']).optional(),expectedRevision:z.number().int().positive().optional()}).strict();
type Row=Record<string,any>;type Actor=Extract<MemoryOwner,{kind:'user'|'agent'}>;
const fail=(code:ConstructorParameters<typeof MindPondError>[0],message:string):never=>{throw new MindPondError(code,message);};
const required=(i:Row,...fields:string[])=>{if(fields.some(k=>i[k]===undefined))fail('invalid_input','Required fields: '+fields.join(', '));};
export class RoleClones{
 constructor(private db:Database,private graph:GraphMemory,private write:<T>(fn:()=>Promise<T>)=>Promise<T>,private clock=Date.now){}
 async init(){await this.db.exec(`
 CREATE TABLE IF NOT EXISTS role_clones(role_id TEXT PRIMARY KEY,parent_id TEXT NOT NULL,parent_name TEXT NOT NULL,mission TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','revoked','purged')),revision INTEGER NOT NULL,snapshot TEXT,snapshot_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS role_clones_parent ON role_clones(parent_id,role_id);
 CREATE TABLE IF NOT EXISTS role_knowledge_copies(copy_id TEXT PRIMARY KEY,kind TEXT NOT NULL,source_id TEXT NOT NULL,source_version INTEGER NOT NULL,source_hash TEXT NOT NULL,origin TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS role_clone_assets(role_id TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,copy_id TEXT NOT NULL,source_revision INTEGER NOT NULL,source_hash TEXT NOT NULL,copy_fingerprint TEXT NOT NULL,PRIMARY KEY(role_id,kind,source_id));
 CREATE INDEX IF NOT EXISTS role_clone_asset_copy ON role_clone_assets(role_id,kind,copy_id);
 CREATE TABLE IF NOT EXISTS role_clone_reports(id TEXT PRIMARY KEY,role_id TEXT NOT NULL,parent_id TEXT NOT NULL,summary TEXT NOT NULL,payload TEXT NOT NULL,sha256 TEXT NOT NULL,created_at INTEGER NOT NULL,memory_count INTEGER NOT NULL,script_count INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS role_clone_report_parent ON role_clone_reports(parent_id,id);
 CREATE TABLE IF NOT EXISTS role_clone_report_ack(report_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS role_clone_reviews(report_id TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,decision TEXT NOT NULL,target_id TEXT,target_version INTEGER,target_hash TEXT,note TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(report_id,kind,source_id));
 CREATE TABLE IF NOT EXISTS role_clone_receipts(actor TEXT NOT NULL,operation TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(actor,operation,key));
 `);}
 private admin(a?:TrustedCallContext){if(!a?.operator||a.expiresAt<=this.clock())fail('scope_denied','Only the human manager can dispatch, revoke, resume or clean up role clones.');}
 private async role(roleId:string){const r=await this.db.get<Row>("SELECT id,name,introduction,principal,state,revision FROM character_roles WHERE id=? AND state IN ('active','disabled')",[roleId]);if(!r)fail('not_found','Role is unavailable or merged. Refresh the role directory.');return r!;}
 async assertUsable(roleId:string){const r=await this.db.get<Row>("SELECT state FROM role_clones WHERE role_id=? AND state<>'active'",[roleId]);if(r)fail('scope_denied','This clone was '+r.state+'. It cannot access role or human resources through this binding. Ask the human to resume it, or explicitly change the chat binding.');}
 async assertReorganizable(roleId:string){if(await this.db.get("SELECT 1 FROM role_clones WHERE (role_id=? OR parent_id=?) AND state<>'purged'",[roleId,roleId]))fail('invalid_input','This role has an independent clone dispatch or pending return history. Revoke and clean up the relevant dispatches before merging, splitting or deleting the role. Private memories/scripts are retained separately.');}
 async describe(roleId:string){
  const own=await this.db.get<Row>('SELECT role_id roleId,parent_id parentId,parent_name parentName,mission,state,revision,snapshot_hash snapshotHash,created_at createdAt FROM role_clones WHERE role_id=?',[roleId]);
  const counts=await this.db.get<Row>(`SELECT count(*) packages,COALESCE(sum(CASE WHEN NOT EXISTS(SELECT 1 FROM role_clone_report_ack ack WHERE ack.report_id=r.id) THEN 1 ELSE 0 END),0) pendingPackages,COALESCE(sum(r.memory_count+r.script_count-(SELECT count(*) FROM role_clone_reviews v WHERE v.report_id=r.id)),0) pendingItems FROM role_clone_reports r WHERE r.parent_id=?`,[roleId]);
  return {lineage:own??null,returns:{packages:counts!.packages,pendingItems:counts!.pendingItems,pendingPackages:counts!.pendingPackages},next:own?'Use office_clone(status) for mission and changed-asset candidates. Submit selected lessons/scripts with summary when ready. Submission freezes an independent return package, does not stop or unbind this session.':counts!.pendingPackages?'Review returned memory with memory_clone and scripts with office_clone. Keep sources/uncertainty, save selected improvements using your own normal tools, then register accepted/skipped decisions.':null};
 }
 private async event(roleId:string,kind:string,data:unknown){await this.db.run('INSERT INTO role_events(role_id,kind,body,ts) VALUES(?,?,?,?)',[roleId,kind,stableJSON(data),this.clock()]);await this.db.run('DELETE FROM office_response_pages');}
 private async receipt(actor:string,op:string,key:string,input:unknown,run:()=>Promise<Row>){const hash=digest(input),prior=await this.db.get<Row>('SELECT * FROM role_clone_receipts WHERE actor=? AND operation=? AND key=?',[actor,op,key]);if(prior){if(prior.hash!==hash)fail('idempotency_conflict','This clone operation key has another payload. Retry the exact request or use a new key.');return {...JSON.parse(prior.result),replayed:true};}const result=await run();await this.db.run('INSERT INTO role_clone_receipts VALUES(?,?,?,?,?)',[actor,op,key,hash,stableJSON(result)]);return result;}
 private async candidates(roleId:string,afterId='',kind?:'memory'|'script',previews=false){
  const ns=await this.db.get<Row>('SELECT domain_id FROM memory_role_namespaces WHERE role_id=?',[roleId]);
  const rows=await this.db.all<Row[]>(`SELECT 'memory' kind,n.id,substr(n.content,1,160) label,n.updated_at version,length(CAST(n.content AS BLOB)) bytes,COALESCE(a.copy_fingerprint,'') baselineHash,a.source_id sourceId FROM nodes n LEFT JOIN role_clone_assets a ON a.role_id=? AND a.kind='memory' AND a.copy_id=n.id WHERE n.domain_kind='personal' AND n.domain_id=? AND n.dimension<>'event' AND ('memory:'||n.id)>? AND (? IS NULL OR ?='memory')
  UNION ALL SELECT 'script',s.id,s.filename,s.revision,length(CAST(s.content AS BLOB)),COALESCE(a.copy_fingerprint,''),a.source_id FROM office_scripts s LEFT JOIN role_clone_assets a ON a.role_id=? AND a.kind='script' AND a.copy_id=s.id WHERE s.role_id=? AND ('script:'||s.id)>? AND (? IS NULL OR ?='script') ORDER BY kind,id LIMIT 21`,[roleId,ns?.domain_id??null,afterId,kind??null,kind??null,roleId,roleId,afterId,kind??null,kind??null]);
  const records:Row[]=[];for(const row of rows.slice(0,20)){records.push({...row,...(!previews&&row.kind==='memory'?{label:'Private memory reference '+row.id}:{}),baselineHash:undefined,change:!row.sourceId?'new':await knowledgeFingerprint(this.db,row.id,row.kind)===row.baselineHash?'inherited':'changed'});}
  return {records,hasMore:rows.length>20,nextAfterId:rows.length>20?rows[19].kind+':'+rows[19].id:null,notice:'Only this role’s private knowledge/scripts. Inherited unchanged assets need not be returned. Snapshotting requires any synthesized memory’s supporting memories too.'};
 }
 private async report(roleId:string,reportId?:string,kind?:'memory'|'script'){
  const r=reportId?await this.db.get<Row>('SELECT * FROM role_clone_reports WHERE id=? AND (parent_id=? OR role_id=?)',[reportId,roleId,roleId]):await this.db.get<Row>(`SELECT * FROM role_clone_reports r WHERE r.parent_id=? AND (CASE WHEN ?='memory' THEN r.memory_count WHEN ?='script' THEN r.script_count ELSE r.memory_count+r.script_count END)>(SELECT count(*) FROM role_clone_reviews v WHERE v.report_id=r.id AND (? IS NULL OR v.kind=?)) ORDER BY r.created_at,r.id LIMIT 1`,[roleId,kind??null,kind??null,kind??null,kind??null]);
  if(!r)fail('not_found','No matching returned package is available. List reports first; omitted reportId selects the oldest package with undecided items for its parent.');return r!;
 }
 private async reports(roleId:string,afterId=''){
  const rows=await this.db.all<Row[]>(`SELECT id,role_id roleId,parent_id parentId,summary,sha256,created_at createdAt,r.memory_count memories,r.script_count scripts,EXISTS(SELECT 1 FROM role_clone_report_ack ack WHERE ack.report_id=r.id) acknowledged,(SELECT count(*) FROM role_clone_reviews v WHERE v.report_id=r.id) reviewed FROM role_clone_reports r WHERE (r.parent_id=? OR r.role_id=?) AND r.id>? ORDER BY r.id LIMIT 11`,[roleId,roleId,afterId]);
  const records:Row[]=[];for(const row of rows.slice(0,10)){if(records.length&&Buffer.byteLength(JSON.stringify([...records,row]))>24000)break;records.push(row);}
  return {reports:records,hasMore:rows.length>records.length,nextAfterId:rows.length>records.length?records.at(-1)!.id:null};
 }
 private async assertOutsideDiscussion(roleId:string){
  if(await this.db.get("SELECT 1 FROM office_discussion_members m JOIN office_discussions d ON d.id=m.room_id WHERE m.role_id=? AND m.state='joined'",[roleId]))fail('scope_denied','Return packages are correspondence with the parent role. Finish and leave the discussion with a summary before submitting, reading or reviewing outside returns. No outside return was processed.');
 }
 private async submit(roleId:string,i:Row){
  required(i,'summary','key');await this.assertUsable(roleId);const c=await this.db.get<Row>('SELECT role_id,parent_id,parent_name,state,revision FROM role_clones WHERE role_id=?',[roleId]);if(!c)fail('invalid_input','Only a dispatched clone can submit a return package.');
  await this.assertOutsideDiscussion(roleId);
  return this.receipt(roleId,'submit',i.key,i,async()=>{
   if((await this.db.get<Row>('SELECT count(*) n FROM role_clone_reports WHERE role_id=?',[roleId]))!.n>=CLONE_LIMITS.reports)fail('material_over_budget','At most 32 retained return packages per clone. Ask the human to review and clean up the completed dispatch.');
   let memoryIds=i.memoryIds,scriptIds=i.scriptIds;
   if(memoryIds===undefined||scriptIds===undefined){const changed:{memory:string[];script:string[]}={memory:[],script:[]};let after='';do{const page=await this.candidates(roleId,after);for(const r of page.records)if(r.change!=='inherited')changed[r.kind as 'memory'|'script'].push(r.id);if(changed.memory.length>100||changed.script.length>100)fail('material_over_budget','More than 100 changed assets. Submit an explicitly selected smaller package.');if(!page.hasMore)break;after=page.nextAfterId!;}while(true);memoryIds??=changed.memory;scriptIds??=changed.script;}
   const b=await captureKnowledge(this.db,roleId,memoryIds,scriptIds),payload=encodeKnowledge(b),reportId=randomUUID(),sha256=contentHash(payload);
   await this.db.run('INSERT INTO role_clone_reports VALUES(?,?,?,?,?,?,?,?,?)',[reportId,roleId,c!.parent_id,i.summary,payload,sha256,this.clock(),b.nodes.length,b.scripts.length]);
   await this.event(c!.parent_id,'clone_returned',{roleId,reportId,memories:b.nodes.length,scripts:b.scripts.length});
   return {reportId,sha256,memories:b.nodes.length,scripts:b.scripts.length,immutable:true,notice:'Selected experience is now available to the parent for review. Your live private knowledge stays independent. Submission does not stop the host, unbind the role, or automatically change parent knowledge.'};
  });
 }
 private async get(roleId:string,i:Row,kind:'memory'|'script'){
  let r:Row;try{r=await this.report(roleId,i.reportId,kind);}catch(e){if(!i.reportId&&e instanceof MindPondError&&e.code==='not_found')return {done:true,remaining:0,next:'No returned '+kind+' items await review. List reports to inspect history.'};throw e;}
  const b=decodeKnowledge(r.payload),reviews=await this.db.all<Row[]>('SELECT kind,source_id sourceId,decision,target_id targetId,target_version targetVersion,note FROM role_clone_reviews WHERE report_id=?',[r.id]);
  const rows=kind==='memory'?b.nodes:b.scripts;
  const source=i.sourceId?rows.find(n=>n.id===i.sourceId):rows.find(n=>!reviews.some(v=>v.kind===kind&&v.sourceId===n.id));
  if(!source){if(i.sourceId)fail('not_found','This asset is not part of the selected immutable return package.');return {reportId:r.id,summary:r.summary,done:true,remaining:0,next:'All '+kind+' items in this package have decisions. List reports for other packages.'};}
  const metadata=kind==='memory'?{dimensions:JSON.parse(source.dimensions??'[]'),dimension:source.primary_dimension??source.dimension,tags:JSON.parse(source.tags),importance:source.importance,sourceRefs:JSON.parse(b.sources.find(s=>s.memory_id===source.id)?.payload??'[]'),memberships:b.members.filter(m=>m.memory_id===source.id),anchors:b.anchors.filter(a=>a.memory_id===source.id).map(({embedding,zh_embedding,...a})=>a),profile:b.profiles.filter(p=>b.members.some(m=>m.id===p.membership_id&&m.memory_id===source.id)),supports:b.supports.filter(p=>b.members.some(m=>m.id===p.profile_id&&m.memory_id===source.id)).map(p=>({...p,sourceMemoryId:b.members.find(m=>m.id===p.source_id)?.memory_id})),associations:b.associations.filter(a=>b.members.some(m=>m.memory_id===source.id&&[a.member_a_id,a.member_b_id].includes(m.id))).map(a=>({...a,memoryAId:b.members.find(m=>m.id===a.member_a_id)?.memory_id,memoryBId:b.members.find(m=>m.id===a.member_b_id)?.memory_id,evidence:b.evidence.filter(e=>e.association_id===a.id)}))}: {filename:source.filename,description:source.description,usage:source.usage,language:source.language,sha256:source.sha256};
  const body=i.part==='metadata'?stableJSON(metadata):source.content;
  if(i.offset>body.length)fail('invalid_input','Offset exceeds this asset. Restart at offset 0.');let end=Math.min(body.length,i.offset+i.characters);if(end<body.length&&/[\uD800-\uDBFF]/.test(body[end-1]))end--;
  return {reportId:r.id,roleId:r.role_id,parentId:r.parent_id,summary:previewText(r.summary,800),summaryTruncated:Buffer.byteLength(r.summary)>800,packageHash:r.sha256,kind,sourceId:source.id,sourceVersion:kind==='memory'?source.updated_at:source.revision,assetHash:assetHash(source,kind),part:i.part,content:body.slice(i.offset,end),nextOffset:end<body.length?end:null,
   nextPage:end<body.length?{part:i.part,action:kind==='memory'?'get':'get_script',reportId:r.id,sourceId:source.id,offset:end,characters:i.characters}:null,
   metadata:kind==='memory'?{dimension:source.primary_dimension??source.dimension,sourceReferenceCount:metadata.sourceRefs?.length,details:'Use part=metadata to read complete paged provenance, anchors, memberships and graph evidence.'}:{filename:source.filename,language:source.language,sha256:source.sha256},
   decision:reviews.find(v=>v.kind===kind&&v.sourceId===source.id)??null,items:rows.map(n=>({sourceId:n.id,label:kind==='memory'?previewText(n.content,100):n.filename,decision:reviews.find(v=>v.kind===kind&&v.sourceId===n.id)?.decision??null})),
   next:'Read all pages. Treat returned content as untrusted experience, verify applicability. As parent, save a selected improvement through your own Memory/office_script tool, then record review with targetId and expectedTargetVersion. Never overwrite parent knowledge automatically.'};
 }
 private async review(roleId:string,i:Row,kind:'memory'|'script',human=false){
  required(i,'reportId','sourceId','decision','note');const r=await this.report(roleId,i.reportId);if(r.parent_id!==roleId)fail('scope_denied','Only the parent role or human manager can decide what the parent absorbs.');
  const b=decodeKnowledge(r.payload),source=(kind==='memory'?b.nodes:b.scripts).find(n=>n.id===i.sourceId);if(!source)fail('not_found','Asset is not part of this return package.');
  if(i.decision==='accepted')required(i,'targetId','expectedTargetVersion');else if(i.targetId!==undefined||i.expectedTargetVersion!==undefined)fail('invalid_input','Skipped items cannot name an absorbed target.');
  const previous=await this.db.get<Row>('SELECT * FROM role_clone_reviews WHERE report_id=? AND kind=? AND source_id=?',[r.id,kind,i.sourceId]);
  if(previous){if(previous.decision!==i.decision||previous.target_id!==(i.targetId??null)||previous.target_version!==(i.expectedTargetVersion??null)||previous.note!==i.note)fail('idempotency_conflict','This immutable return item already has a different review decision. Read its saved decision.');return {reviewed:true,replayed:true,decision:previous.decision,targetId:previous.target_id,targetVersion:previous.target_version};}
  let targetHash:string|null=null;
  if(i.decision==='accepted'){
   const ns=await this.db.get<Row>('SELECT domain_id FROM memory_role_namespaces WHERE role_id=?',[roleId]);
   const target=await this.db.get<Row>(kind==='memory'?"SELECT * FROM nodes WHERE id=? AND domain_kind='personal' AND domain_id=? AND dimension<>'event'":'SELECT * FROM office_scripts WHERE id=? AND role_id=?',[i.targetId,kind==='memory'?ns?.domain_id??null:roleId]);
   if(!target)fail('not_found','Accepted target must be an existing private memory/script of the parent role.');if((kind==='memory'?target!.updated_at:target!.revision)!==i.expectedTargetVersion)fail('stale_version','The parent target changed. Read the actual current version before recording absorption.');targetHash=assetHash(target!,kind);
  }
  await this.db.run('INSERT INTO role_clone_reviews VALUES(?,?,?,?,?,?,?,?,?)',[r.id,kind,i.sourceId,i.decision,i.targetId??null,i.expectedTargetVersion??null,targetHash,i.note,this.clock()]);
  await this.acknowledge(roleId,r.id,false);
  await this.event(roleId,'clone_reviewed',{reportId:r.id,kind,sourceId:i.sourceId,decision:i.decision,targetId:i.targetId??null,human});return {reviewed:true,decision:i.decision,targetId:i.targetId??null,targetVersion:i.expectedTargetVersion??null,notice:'This receipt records the reviewer’s attributed decision and exact target version; it is not independent proof that the experience is correct.'};
 }
 private async acknowledge(roleId:string,reportId:string,explicit=true){
  const r=await this.report(roleId,reportId);if(r.parent_id!==roleId)fail('scope_denied','Only the parent can complete review of this package.');
  const count=await this.db.get<Row>('SELECT count(*) n FROM role_clone_reviews WHERE report_id=?',[r.id]);
  if(count!.n<r.memory_count+r.script_count){if(explicit)fail('invalid_input','Review every selected item before acknowledging this return package.');return;}
  const saved=await this.db.run('INSERT OR IGNORE INTO role_clone_report_ack VALUES(?,?)',[r.id,this.clock()]);if(saved.changes)await this.event(roleId,'clone_return_reviewed',{reportId:r.id});return {reportId:r.id,acknowledged:true};
 }
 async office(value:unknown,a?:TrustedCallContext){const i=cloneOfficeSchema.parse(value);return this.write(async()=>{
  const b=await this.graph.roles.binding(a),roleId=b!.role_id;
  if(!['status','candidates'].includes(i.action))await this.assertOutsideDiscussion(roleId);
  if(i.action==='acknowledge'){required(i,'reportId');return this.acknowledge(roleId,i.reportId!);}if(i.action==='status')return this.describe(roleId);if(i.action==='candidates')return this.candidates(roleId,i.afterId);
  if(i.action==='submit')return this.submit(roleId,i);if(i.action==='reports')return this.reports(roleId,i.afterId);
  if(i.action==='get_script')return this.get(roleId,i,'script');return this.review(roleId,i,'script');
 });}
 async memory(value:unknown,owner:Actor,guard:()=>Promise<void>){const i=z.object(cloneMemoryShape).strict().parse(value);return this.write(async()=>{
  await guard();if(owner.kind!=='agent')fail('invalid_input','Use the human role-management page to inspect dispatches; memory_clone requires a bound parent or clone role.');await this.graph.memoryOwners.role(owner.id);await this.assertUsable(owner.id);await this.assertOutsideDiscussion(owner.id);
  if(i.action==='acknowledge'){required(i,'reportId');return this.acknowledge(owner.id,i.reportId!);}if(i.action==='reports')return this.reports(owner.id,i.afterId);if(i.action==='get')return this.get(owner.id,i,'memory');return this.review(owner.id,i,'memory');
 });}
 async manage(value:unknown,a?:TrustedCallContext){this.admin(a);const i=manageSchema.parse(value);return this.write(async()=>{
  this.admin(a);const role=await this.role(i.roleId);
  if(i.action==='status'){
   const clones=await this.db.all<Row[]>('SELECT c.role_id roleId,c.parent_id parentId,r.name,r.state roleState,c.mission,c.state,c.revision,c.snapshot_hash snapshotHash,c.created_at createdAt,b.connector_id connectorId,b.runtime_id runtimeId,h.name hostName,h.host,c.parent_name parentName,chat.source chatSource,chat.native_chat_id nativeChatId FROM role_clones c LEFT JOIN character_roles r ON r.id=c.role_id LEFT JOIN role_bindings b ON b.role_id=c.role_id AND b.state=\'active\' LEFT JOIN office_agents h ON h.id=b.connector_id LEFT JOIN role_chat_sessions chat ON chat.runtime_id=b.runtime_id AND chat.principal=b.principal AND chat.connector_id=b.connector_id WHERE c.parent_id=? AND c.role_id>? ORDER BY c.role_id LIMIT 21',[role.id,i.afterId??'']);
   const principals=await this.db.all<Row[]>("SELECT DISTINCT principal FROM office_agents WHERE state='active' ORDER BY principal LIMIT 101");if(!principals.slice(0,100).some(p=>p.principal===role.principal))principals.unshift({principal:role.principal});return {...await this.describe(role.id),clones:clones.slice(0,20),clonesHasMore:clones.length>20,nextAfterId:clones.length>20?clones[19].roleId:null,principals:principals.slice(0,100),principalsHasMore:principals.length>100,limits:CLONE_LIMITS};
  }
  if(i.action==='candidates')return this.candidates(role.id,i.afterId,i.kind,true);
  if(i.action==='acknowledge'){required(i,'reportId');return this.acknowledge(role.id,i.reportId!);}if(i.action==='reports')return this.reports(role.id,i.afterId);
  if(i.action==='get')return this.get(role.id,i,i.kind??'memory');
  if(i.action==='review')return this.review(role.id,i,i.kind??'memory',true);
  if(i.action==='submit')return this.submit(role.id,i);
  if(i.action==='dispatch'){
   required(i,'name','mission','key','memoryIds','scriptIds');if(role.state!=='active')fail('invalid_input','Enable the parent role before dispatching.');await this.assertUsable(role.id);
   const principal=i.principal??role.principal;
   if(!await this.db.get("SELECT 1 FROM office_agents WHERE principal=? AND state='active'",[principal]))fail('invalid_input','Choose an account with a registered active host connection before dispatching.');
   return this.receipt('human:'+role.id,'dispatch',i.key!,i,async()=>{
    if((await this.db.get<Row>("SELECT count(*) n FROM role_clones WHERE parent_id=? AND state<>'purged'",[role.id]))!.n>=CLONE_LIMITS.children)fail('material_over_budget','At most 64 retained dispatches per parent. Revoke and clean up completed dispatches first.');
    const b=await captureKnowledge(this.db,role.id,i.memoryIds!,i.scriptIds!),snapshot=encodeKnowledge(b),childId=randomUUID(),now=this.clock();
    await this.db.run("INSERT INTO character_roles VALUES(?,?,?,?,'active',1,NULL,?)",[childId,principal,i.name,role.introduction,now]);
    await this.db.run("INSERT INTO role_clones VALUES(?,?,?,?,'active',1,?,?,?)",[childId,role.id,role.name,i.mission,snapshot,contentHash(snapshot),now]);
    const copies=await installKnowledge(this.db,b,childId,'Clone dispatch '+childId,now);
    for(const kind of ['memory','script'] as const)for(const source of kind==='memory'?b.nodes:b.scripts)await this.db.run('INSERT INTO role_clone_assets VALUES(?,?,?,?,?,?,?)',[childId,kind,source.id,(kind==='memory'?copies.memories:copies.scripts).get(source.id),kind==='memory'?source.updated_at:source.revision,assetHash(source,kind),await knowledgeFingerprint(this.db,(kind==='memory'?copies.memories:copies.scripts).get(source.id)!,kind)]);
    await this.event(childId,'clone_dispatched',{parentId:role.id,name:i.name,mission:i.mission,snapshotHash:contentHash(snapshot)});
    return {roleId:childId,parentId:role.id,name:i.name,principal,snapshotHash:contentHash(snapshot),memories:b.nodes.length,scripts:b.scripts.length,notice:'Dispatch created an independent unbound role. Open this clone in the role directory and connect an observed chat from its account. No offices, contacts, messages, continuity, credentials or cross-role grants were inherited. Explicitly invite the clone to offices it needs.'};
   });
  }
  if(i.action==='import'){
   required(i,'reportId','sourceId','note');const kind=i.kind??'memory',r=await this.report(role.id,i.reportId);if(r.parent_id!==role.id)fail('scope_denied','Import into the parent role only.');
   const existing=await this.db.get<Row>('SELECT * FROM role_clone_reviews WHERE report_id=? AND kind=? AND source_id=?',[r.id,kind,i.sourceId]);if(existing){if(existing.decision!=='accepted'||existing.note!==i.note)fail('idempotency_conflict','This return item already has another review decision. Refresh before importing; no copy was created.');return {reviewed:true,replayed:true,decision:existing.decision,targetId:existing.target_id,targetVersion:existing.target_version};}
   const b=decodeKnowledge(r.payload),source=(kind==='memory'?b.nodes:b.scripts).find(n=>n.id===i.sourceId);if(!source)fail('not_found','Asset is not part of the returned package.');
   if(kind==='script'&&(await this.db.get<Row>('SELECT count(*) n FROM office_scripts WHERE role_id=?',[role.id]))!.n>=100)fail('material_over_budget','Parent script library has reached 100 items. Organize it before import.');
   // A single synthesized item cannot be imported with inaccessible evidence. The reviewer can instead synthesize and save its own lesson.
   const one:CloneKnowledge={nodes:kind==='memory'?[source!]:[],members:b.members.filter(m=>kind==='memory'&&m.memory_id===source!.id),anchors:b.anchors.filter(m=>kind==='memory'&&m.memory_id===source!.id),sources:b.sources.filter(m=>kind==='memory'&&m.memory_id===source!.id),profiles:[],supports:[],associations:[],evidence:[],edges:[],zhVectors:kind==='memory'?(b.zhVectors??[]).filter(v=>v.id===source!.id):[],bodyVersions:kind==='memory'?(b.bodyVersions??[]).filter(v=>v.memory_id===source!.id):[],profileVectors:kind==='memory'?(b.profileVectors??[]).filter(v=>v.memory_id===source!.id):[],scripts:kind==='script'?[source!]:[]};
   if(b.profiles.some(p=>one.members.some(m=>m.id===p.membership_id)))fail('invalid_input','This is a synthesized profile with supporting memories. Have the parent read the returned package and write a source-linked lesson with its normal Memory tools; a one-item import cannot preserve its evidence graph.');
   const maps=await installKnowledge(this.db,one,role.id,'Human-approved return '+r.id,this.clock()),targetId=(kind==='memory'?maps.memories:maps.scripts).get(source!.id)!,target=await this.db.get<Row>(kind==='memory'?'SELECT updated_at version FROM nodes WHERE id=?':'SELECT revision version FROM office_scripts WHERE id=?',[targetId]);
   return this.review(role.id,{...i,decision:'accepted',targetId,expectedTargetVersion:target!.version},kind,true);
  }
  required(i,'expectedRevision');const c=await this.db.get<Row>('SELECT role_id,parent_id,parent_name,state,revision FROM role_clones WHERE role_id=?',[role.id]);if(!c)fail('invalid_input','Select the dispatched clone, not its parent, for lifecycle operations.');
  if(c!.revision!==i.expectedRevision)fail('stale_version','Clone lifecycle changed. Refresh before retrying.');
  if(i.action==='resume'&&c!.state!=='revoked'||i.action==='revoke'&&c!.state!=='active'||i.action==='purge'&&c!.state!=='revoked')fail('invalid_input','Revoke requires an active clone; resume/cleanup require a revoked clone. Cleaned-up dispatches cannot resume.');
  if(i.action==='revoke'&&await this.db.get("SELECT 1 FROM office_discussion_members WHERE role_id=? AND state='joined'",[role.id]))fail('invalid_input','Remove the clone from its discussion through the meeting controls first; preserve its summary and pending messages before revoking.');
  if(i.action==='purge'){
   if(await this.db.get("SELECT 1 FROM role_clones WHERE parent_id=? AND state<>'purged'",[role.id]))fail('invalid_input','Clean up this clone’s own dispatched children first.');
   await this.db.run('DELETE FROM role_clone_report_ack WHERE report_id IN (SELECT id FROM role_clone_reports WHERE role_id=?)',[role.id]);await this.db.run('DELETE FROM role_clone_reviews WHERE report_id IN (SELECT id FROM role_clone_reports WHERE role_id=?)',[role.id]);await this.db.run('DELETE FROM role_clone_reports WHERE role_id=?',[role.id]);await this.db.run('DELETE FROM role_clone_assets WHERE role_id=?',[role.id]);await this.db.run("UPDATE role_clones SET state='purged',snapshot=NULL,mission='',revision=revision+1 WHERE role_id=?",[role.id]);
  }else{
   const enabled=i.action==='resume';await this.db.run('UPDATE role_clones SET state=?,revision=revision+1 WHERE role_id=?',[enabled?'active':'revoked',role.id]);
   await this.db.run('UPDATE character_roles SET state=?,revision=revision+1 WHERE id=?',[enabled?'active':'disabled',role.id]);
   await this.db.run('UPDATE role_bindings SET epoch=epoch+1 WHERE role_id=?',[role.id]);
   await this.db.run("UPDATE memory_role_credentials SET state='revoked' WHERE role_id=?",[role.id]);
   // Keep the binding as a deny fence, never silently turn the chat into a human connection.
   await this.db.run("UPDATE office_items SET status='open',revision=revision+1,epoch=epoch+1,lease_hash=NULL,lease_until=NULL,session_id=NULL WHERE status='claimed' AND session_id IN (SELECT id FROM office_sessions WHERE seat_id IN (SELECT seat_id FROM role_seats WHERE role_id=?))",[role.id]);
   await this.db.run("UPDATE office_sessions SET state='closed' WHERE seat_id IN (SELECT seat_id FROM role_seats WHERE role_id=?)",[role.id]);
  }
  await this.event(role.id,'clone_'+i.action,{parentId:c!.parent_id});return {roleId:role.id,state:i.action==='purge'?'purged':i.action==='resume'?'active':'revoked',revision:c!.revision+1,notice:i.action==='purge'?'Snapshot and returned packages/reviews removed; live private memories/scripts and minimal lineage/audit remain. Delete the role separately if desired.':'This changes MindPond access only; it does not start or stop any host process. Revoked bindings deny access, including human fallback.'};
 });}
}
