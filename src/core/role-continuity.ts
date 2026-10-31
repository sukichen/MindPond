import {memoryAccess,type MemoryAuthority} from './memory-access.js';
/** Role-owned working state. Exact recovery, not similarity retrieval or a
 * transcript dump. Semantic lessons remain in the canonical memory graph. */
import {z} from 'zod';
import type {Database} from 'sqlite';
import type {GraphMemory} from './graph-memory.js';
import {MindPondError} from './errors.js';
import {digest,stableJSON} from './growth.js';
import {messageStateSql} from './office-message-state.js';

const id=z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,160}$/),text=(n:number)=>z.string().trim().min(1).max(n);
const lines=z.array(text(500)).max(8).default([]);
const refs=z.array(z.discriminatedUnion('kind',[
 z.object({kind:z.literal('memory'),id,revision:z.number().int().optional()}).strict(),
 z.object({kind:z.literal('message'),id}).strict(),
 z.object({kind:z.literal('material'),id}).strict(),
 z.object({kind:z.literal('external'),uri:text(1000),revision:text(256),fingerprint:text(256).optional()}).strict()
])).max(16).default([]);
export const continuitySummarySchema=z.object({goal:text(1000),progress:text(3000),nextSteps:lines,blockers:lines,constraints:lines,sources:refs}).strict();
export const continuityTaskSchema=z.object({id,expectedRevision:z.number().int().min(0),title:text(200),status:z.enum(['todo','doing','blocked','waiting','done','cancelled']),priority:z.number().int().min(0).max(3).default(1),progress:text(3000),nextSteps:lines,blockers:lines,sources:refs}).strict();
const writeBase={officeId:id.optional(),key:text(256),reason:text(1000)};
export const continuityCheckpointSchema=z.object({...writeBase,expectedRevision:z.number().int().min(0),summary:continuitySummarySchema,tasks:z.array(continuityTaskSchema).max(8).default([])}).strict();
export const continuityTaskWriteSchema=z.object({...writeBase,task:continuityTaskSchema}).strict();
export const continuityReadSchema=z.object({cursor:text(2048).optional(),contextBudgetBytes:z.number().int().min(2048).max(65536).default(16384)}).strict();
export const continuityTasksSchema=z.object({officeId:id.optional(),state:z.enum(['active','completed','archived','all']).default('active'),taskId:id.optional(),cursor:text(2048).optional(),contextBudgetBytes:z.number().int().min(2048).max(65536).default(16384)}).strict();
export const continuityHistorySchema=z.object({officeId:id.optional(),taskId:id.optional(),beforeSeq:z.number().int().positive().optional(),limit:z.number().int().min(1).max(20).default(5),contextBudgetBytes:z.number().int().min(2048).max(65536).default(32768)}).strict();
export const continuityArchiveSchema=z.object({tasks:z.array(z.object({id,expectedRevision:z.number().int().positive()}).strict()).min(1).max(20),key:text(256),reason:text(1000)}).strict();
type Row=Record<string,any>;
export interface ContinuityAccess {roleId:string;human?:boolean;authorize?:()=>Promise<void>;authority?:MemoryAuthority}
const terminal=(status:string)=>['done','cancelled'].includes(status);
const denied=()=>new MindPondError('scope_denied','Working state is outside this role’s current office access');
const version=()=>new MindPondError('stale_version','Working state changed. Read memory_resume or the task/history before retrying.');
function bounded(value:unknown,max=12000){const bytes=Buffer.byteLength(stableJSON(value));if(bytes>max)throw new MindPondError('material_over_budget','Working record is too large; split detailed work into tasks or linked memories',{details:{requiredBytes:bytes,maxBytes:max}});}
export class RoleContinuityStore{
 constructor(private db:Database,private graph:GraphMemory,private write:<T>(fn:()=>Promise<T>)=>Promise<T>,private clock:()=>number=Date.now){}
 async init(){await this.db.exec(`
 CREATE TABLE IF NOT EXISTS role_continuity_checkpoints(role_id TEXT NOT NULL REFERENCES character_roles(id) ON DELETE CASCADE,scope TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,updated_at INTEGER NOT NULL,binding_id TEXT,binding_epoch INTEGER,PRIMARY KEY(role_id,scope));
 CREATE TABLE IF NOT EXISTS role_continuity_tasks(role_id TEXT NOT NULL REFERENCES character_roles(id) ON DELETE CASCADE,id TEXT NOT NULL,scope TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,priority INTEGER NOT NULL,payload TEXT NOT NULL,archived_at INTEGER,updated_at INTEGER NOT NULL,PRIMARY KEY(role_id,id));
 CREATE INDEX IF NOT EXISTS role_continuity_task_page ON role_continuity_tasks(role_id,archived_at,status,priority,id);
 CREATE INDEX IF NOT EXISTS role_continuity_task_scope ON role_continuity_tasks(role_id,scope,updated_at);
 CREATE INDEX IF NOT EXISTS role_message_sender_page ON role_messages(sender,seq);
 CREATE TABLE IF NOT EXISTS role_continuity_history(seq INTEGER PRIMARY KEY AUTOINCREMENT,role_id TEXT NOT NULL REFERENCES character_roles(id) ON DELETE CASCADE,scope TEXT NOT NULL,kind TEXT NOT NULL,entity_id TEXT,revision INTEGER NOT NULL,payload TEXT NOT NULL,reason TEXT NOT NULL,binding_id TEXT,binding_epoch INTEGER,ts INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS role_continuity_history_page ON role_continuity_history(role_id,seq);
 CREATE TABLE IF NOT EXISTS role_continuity_receipts(role_id TEXT NOT NULL REFERENCES character_roles(id) ON DELETE CASCADE,operation TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(role_id,operation,key));
 `);}
 private async access(a:ContinuityAccess){
  await a.authorize?.();
  const role=await this.db.get<Row>('SELECT id,name,introduction,state,revision FROM character_roles WHERE id=?',[a.roleId]);
  if(!role)throw new MindPondError('not_found','Role no longer exists');
  if(!a.human)await this.graph.memoryOwners.role(a.roleId);
  const memory=memoryAccess(this.graph,a.human?{kind:'user',id:'default'}:{kind:'agent',id:a.roleId},a.authority);
  const offices=await memory.offices(),ctx=await memory.context();
  const checks=new Map<string,boolean>();
  const allowed=(scope:string)=>a.human||!scope||offices.some(o=>o.id===scope);
  const references=async(payload:Row,scope:string):Promise<boolean>=>{
   if(!allowed(scope))return false;
   if(a.human)return true;
   for(const ref of payload.sources??[]){
    const key=stableJSON([scope,ref]);if(checks.has(key)){if(!checks.get(key))return false;continue;}
    let valid=true;
    if(ref.kind==='memory'){
     try{const node=await this.graph.getNodeById(ref.id,{trackAccess:false,context:ctx});valid=!!node;
      if(node){const owner=await this.graph.memoryOwners.owner(node);if(owner.kind==='office'&&owner.id!==scope)valid=false;}
     }catch(error){if((error as any)?.code!=='scope_denied')throw error;valid=false;}
    }else if(ref.kind==='message'){
     const message=await this.db.get<Row>('SELECT office_id FROM role_messages WHERE id=? AND (sender=? OR recipient=?)',[ref.id,a.roleId,a.roleId]);
     valid=!!message&&(!message.office_id||message.office_id===scope&&allowed(scope));
    }else if(ref.kind==='material'){
     const material=await this.db.get<Row>('SELECT office_id FROM office_materials WHERE id=?',[ref.id]);valid=!!material&&material.office_id===scope&&allowed(scope);
    }
    checks.set(key,valid);if(!valid)return false;
   }return true;
  };
  return {role,offices,allowed,references};
 }
 private async writable(a:ContinuityAccess,scope:string){
  const access=await this.access(a);if(!access.allowed(scope))throw denied();
  if(access.role.state==='merged')throw new MindPondError('invalid_input','This role has been merged. Select the surviving role before writing working state.');
  if(scope&&!a.human&&!access.offices.some(o=>o.id===scope&&o.state==='active'))throw new MindPondError('scope_denied','Office working state is read-only while the office is paused or archived');
  // Retained office work must not become visible to a newly created room
  // reusing the same ID. Reuse the existing office namespace tombstone rule.
  if(scope&&!await this.db.get('SELECT 1 FROM memory_office_namespaces WHERE office_id=?',[scope]))await this.graph.memoryOwners.domain({kind:'office',id:scope});
  return access;
 }
 private async validateRefs(access:Awaited<ReturnType<RoleContinuityStore['access']>>,payload:Row,scope:string){
  for(const ref of payload.sources??[]){
   const table=ref.kind==='memory'?'nodes':ref.kind==='message'?'role_messages':ref.kind==='material'?'office_materials':null;
   if(table&&!await this.db.get('SELECT 1 FROM '+table+' WHERE id=?',[ref.id]))throw new MindPondError('not_found','Referenced '+ref.kind+' no longer exists',{field:'sources',nextAction:'Read the actual source ID. Mailbox seq and task ID are not memory/material IDs.'});
  }
  if(!await access.references(payload,scope))throw new MindPondError('scope_denied','A source is missing or outside this working scope. Put office work in its matching officeId scope.');
 }
 private async receipt<T>(a:ContinuityAccess,op:string,input:Row,run:()=>Promise<T>):Promise<T>{
  const prior=await this.db.get<Row>('SELECT hash,payload FROM role_continuity_receipts WHERE role_id=? AND operation=? AND key=?',[a.roleId,op,input.key]);
  const hash=digest(input);if(prior){if(prior.hash!==hash)throw new MindPondError('idempotency_conflict','This working-state key already has a different payload');const payload=JSON.parse(prior.payload);if(payload._roleReorganization)throw new MindPondError('stale_version','Role ownership changed after this working-state write. Read memory_resume and use a new key for a new write; the previous receipt cannot restore moved work.');return payload;}
  const result=await run();await this.db.run('INSERT INTO role_continuity_receipts VALUES(?,?,?,?,?)',[a.roleId,op,input.key,hash,stableJSON(result)]);return result;
 }
 private present(row:Row,kind='task'){return {kind,id:row.id??null,officeId:row.scope||null,revision:row.revision,updatedAt:row.updated_at,...(kind==='task'?{archivedAt:row.archived_at??null}:{}),...JSON.parse(row.payload)};}
 private async event(a:ContinuityAccess,scope:string,kind:string,entity:string|null,revision:number,payload:unknown,reason:string){
  const binding=a.human?null:await this.graph.memoryOwners.roleBinding(a.roleId);
  const result=await this.db.run('INSERT INTO role_continuity_history(role_id,scope,kind,entity_id,revision,payload,reason,binding_id,binding_epoch,ts) VALUES(?,?,?,?,?,?,?,?,?,?)',[a.roleId,scope,kind,entity,revision,stableJSON(payload),reason,binding?.id??null,binding?.epoch??null,this.clock()]);
  await this.db.run('INSERT INTO memory_action_log(ts,action,reason) VALUES(?,?,?)',[this.clock(),'role_continuity_'+kind,stableJSON({roleId:a.roleId,officeId:scope||null,seq:result.lastID,revision})]);
 }
 private async saveTask(a:ContinuityAccess,scope:string,input:z.infer<typeof continuityTaskSchema>,reason:string){
  const {expectedRevision,...payload}=input;bounded(payload);
  const old=await this.db.get<Row>('SELECT * FROM role_continuity_tasks WHERE role_id=? AND id=?',[a.roleId,input.id]);
  if(old&&old.scope!==scope)throw new MindPondError('invalid_input','A task cannot change its office scope; create a new task with explicit source references');
  if((old?.revision??0)!==expectedRevision)throw version();
  if(!terminal(payload.status)&&(!old||old.archived_at||terminal(old.status))){const active=await this.db.get<Row>("SELECT COUNT(*) n FROM role_continuity_tasks WHERE role_id=? AND archived_at IS NULL AND status NOT IN ('done','cancelled')",[a.roleId]);if(active!.n>=200)throw new MindPondError('invalid_input','At most 200 unfinished tasks may be active for one role. Review commitments before adding more.');}
  const revision=expectedRevision+1,at=this.clock();
  await this.db.run('INSERT INTO role_continuity_tasks VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(role_id,id) DO UPDATE SET revision=excluded.revision,status=excluded.status,priority=excluded.priority,payload=excluded.payload,archived_at=NULL,updated_at=excluded.updated_at',[a.roleId,input.id,scope,revision,payload.status,payload.priority,stableJSON(payload),null,at]);
  const row=this.present({id:input.id,scope,revision,payload:stableJSON(payload),updated_at:at});
  await this.event(a,scope,'task',input.id,revision,row,reason);return row;
 }
 async checkpoint(a:ContinuityAccess,value:unknown){
  const input=continuityCheckpointSchema.parse(value),scope=input.officeId??'';bounded(input,32000);bounded(input.summary);
  if(new Set(input.tasks.map(t=>t.id)).size!==input.tasks.length)throw new MindPondError('invalid_input','Checkpoint task IDs must be distinct');
  return this.write(async()=>{
   const access=await this.writable(a,scope);await this.validateRefs(access,input.summary,scope);for(const t of input.tasks)await this.validateRefs(access,t,scope);
   return this.receipt(a,'checkpoint',input,async()=>{
    const old=await this.db.get<Row>('SELECT revision FROM role_continuity_checkpoints WHERE role_id=? AND scope=?',[a.roleId,scope]);if((old?.revision??0)!==input.expectedRevision)throw version();
    const revision=input.expectedRevision+1,at=this.clock(),binding=a.human?null:await this.graph.memoryOwners.roleBinding(a.roleId);
    const count=await this.db.get<Row>('SELECT COUNT(*) n FROM role_continuity_checkpoints WHERE role_id=?',[a.roleId]);if(!old&&count!.n>=50)throw new MindPondError('invalid_input','Role checkpoint scope limit reached; human review is required');
    const summary={...input.summary,recordedAt:at};
    await this.db.run('INSERT INTO role_continuity_checkpoints VALUES(?,?,?,?,?,?,?) ON CONFLICT(role_id,scope) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at,binding_id=excluded.binding_id,binding_epoch=excluded.binding_epoch',[a.roleId,scope,revision,stableJSON(summary),at,binding?.id??null,binding?.epoch??null]);
    const tasks=[];for(const task of input.tasks)tasks.push(await this.saveTask(a,scope,task,input.reason));
    const checkpoint={kind:'checkpoint',officeId:scope||null,revision,updatedAt:at,...summary};
    await this.event(a,scope,'checkpoint',null,revision,checkpoint,input.reason);return {checkpoint,tasks};
   });
  });
 }
 async updateTask(a:ContinuityAccess,value:unknown){const input=continuityTaskWriteSchema.parse(value),scope=input.officeId??'';return this.write(async()=>{
  const access=await this.writable(a,scope);await this.validateRefs(access,input.task,scope);
  // Check the stored target even on receipt replay: a key is not authority.
  const old=await this.db.get<Row>('SELECT scope FROM role_continuity_tasks WHERE role_id=? AND id=?',[a.roleId,input.task.id]);if(old&&old.scope!==scope)throw denied();
  return this.receipt(a,'task',input,()=>this.saveTask(a,scope,input.task,input.reason));
 });}
 async archive(a:ContinuityAccess,value:unknown){const input=continuityArchiveSchema.parse(value);if(new Set(input.tasks.map(t=>t.id)).size!==input.tasks.length)throw new MindPondError('invalid_input','Task IDs must be distinct');return this.write(async()=>{
  const rows:Row[]=[];for(const target of input.tasks){const row=await this.db.get<Row>('SELECT * FROM role_continuity_tasks WHERE role_id=? AND id=?',[a.roleId,target.id]);if(!row)throw new MindPondError('not_found','Task not found');const access=await this.writable(a,row.scope);await this.validateRefs(access,JSON.parse(row.payload),row.scope);rows.push(row);}
  return this.receipt(a,'archive',input,async()=>{
   const tasks=[];for(let i=0;i<rows.length;i++){const row=rows[i];if(row.revision!==input.tasks[i].expectedRevision)throw version();if(!terminal(row.status))throw new MindPondError('invalid_input','Unfinished commitments cannot be archived; explicitly complete or cancel the task first');
    const revision=row.revision+1,at=this.clock();await this.db.run('UPDATE role_continuity_tasks SET revision=?,archived_at=?,updated_at=? WHERE role_id=? AND id=?',[revision,at,at,a.roleId,row.id]);
    const task=this.present({...row,revision,archived_at:at,updated_at:at});tasks.push(task);await this.event(a,row.scope,'archive',row.id,revision,task,input.reason);
   }return {tasks};
  });
 });}
 private async visible(a:ContinuityAccess,state='active',officeId?:string,taskId?:string){
  const access=await this.access(a);if(officeId&&!access.allowed(officeId))throw denied();
  const rows=await this.db.all<Row[]>('SELECT * FROM role_continuity_tasks WHERE role_id=?'+(state==='active'?" AND archived_at IS NULL AND status NOT IN ('done','cancelled')":'')+(officeId?' AND scope=?':'')+(taskId?' AND id=?':'')+' ORDER BY priority DESC,updated_at DESC,id',[a.roleId,...(officeId?[officeId]:[]),...(taskId?[taskId]:[])]);
  const tasks=[];for(const row of rows){if(!access.allowed(row.scope))continue;
   if(state==='active'&&(row.archived_at||terminal(row.status))||state==='completed'&&(row.archived_at||!terminal(row.status))||state==='archived'&&!row.archived_at)continue;
   const task=this.present(row);if(await access.references(task,row.scope))tasks.push(task);
  }return {access,tasks};
 }
 private page(records:Row[],scope:unknown,input:{cursor?:string;contextBudgetBytes:number},reserved=1024){
  const signature=digest({scope,records:records.map(r=>[r.kind,r.officeId,r.id,r.revision])});let offset=0;
  if(input.cursor){try{const c=JSON.parse(Buffer.from(input.cursor,'base64url').toString());if(c.signature!==signature||!Number.isInteger(c.offset)||c.offset<0||c.offset>records.length)throw version();offset=c.offset;}catch(error){if(error instanceof MindPondError)throw error;throw new MindPondError('invalid_input','Invalid continuity cursor');}}
  const page:Row[]=[];let bytes=reserved;
  for(const record of records.slice(offset)){const size=Buffer.byteLength(stableJSON(record))+1;if(bytes+size>input.contextBudgetBytes){if(!page.length)throw new MindPondError('material_over_budget','First complete working record exceeds the page budget',{details:{requiredBytes:bytes+size},nextAction:'Raise contextBudgetBytes. Working records are never truncated.'});break;}page.push(record);bytes+=size;}
  return {records:page,total:records.length,nextCursor:offset+page.length<records.length?Buffer.from(JSON.stringify({signature,offset:offset+page.length})).toString('base64url'):null,contextBudget:{unit:'utf8_bytes',limit:input.contextBudgetBytes,used:bytes,appliesTo:'complete working records plus reserved envelope'}};
 }
 private envelope(data:Row,budget:number){
  const result={...data,contextBudget:{unit:'utf8_bytes',limit:budget,used:0,appliesTo:'whole response'}};
  for(let i=0;i<4;i++)result.contextBudget.used=Buffer.byteLength(JSON.stringify(result));
  if(result.contextBudget.used>budget)throw new MindPondError('material_over_budget','Complete working-state response exceeds the budget',{details:{requiredBytes:result.contextBudget.used},nextAction:'Raise contextBudgetBytes. No record is truncated.'});
  return result;
 }
 async resume(a:ContinuityAccess,value:unknown={}){
  const input=continuityReadSchema.parse(value),{access,tasks}=await this.visible(a),checkpoints=[];
  const rows=await this.db.all<Row[]>('SELECT * FROM role_continuity_checkpoints WHERE role_id=? ORDER BY CASE WHEN scope=\'\' THEN 0 ELSE 1 END,scope',[a.roleId]);
  for(const row of rows)if(access.allowed(row.scope)&&await access.references(JSON.parse(row.payload),row.scope)){
   const messages=await this.db.get<Row>('SELECT COUNT(*) n FROM role_messages m JOIN role_message_states s ON s.message_id=m.id WHERE (m.sender=? OR m.recipient=?) AND COALESCE(m.office_id,\'\')=? AND (m.created_at>=? OR s.updated_at>=?)',[a.roleId,a.roleId,row.scope,row.updated_at,row.updated_at]);
   const records=row.scope?await this.db.get<Row>('SELECT COUNT(*) n FROM office_collaboration_records WHERE office_id=? AND created_at>=?',[row.scope,row.updated_at]):null;
   const changedTasks=await this.db.get<Row>('SELECT COUNT(*) n FROM role_continuity_tasks WHERE role_id=? AND scope=? AND updated_at>=?',[a.roleId,row.scope,row.updated_at]);
   checkpoints.push({...this.present(row,'checkpoint'),recordedBy:{kind:row.binding_id?'role':'human',bindingId:row.binding_id,bindingEpoch:row.binding_epoch},changesSinceRecordedAt:{messages:messages!.n,tasks:changedTasks!.n,officeRecords:records?.n??0,meaning:'Activity at/after the recorded time; not a read receipt. Check current messages and office_context.'}});
  }
  // Addressed correspondence remains role-owned after an office move, as in office_receive.
  // Shared knowledge and office-scoped working records still follow current membership.
  const inbox=await this.db.all<Row[]>(`SELECT ${messageStateSql()} state,COUNT(*) n FROM role_messages m JOIN role_message_states s ON s.message_id=m.id WHERE m.recipient=? AND ${messageStateSql()} IN ('pending','processing') GROUP BY ${messageStateSql()}`,[a.roleId]);
  const controls=await this.db.all('SELECT id,action,requested_at FROM office_control_requests WHERE role_id=? AND state=\'requested\' ORDER BY requested_at LIMIT 21',[a.roleId]);
  const clone=await this.graph.roleClones.describe(a.roleId);
  const base={protocol:'mindpond.role-continuity.v1',...(clone.lineage||clone.returns.packages?{clone}:{}),role:{id:access.role.id,name:access.role.name,introduction:access.role.introduction},
   recordedCheckpoints:checkpoints.length,activeTasks:tasks.length,observedAt:this.clock(),
   attention:{pendingMessages:inbox.find(m=>m.state==='pending')?.n??0,processingMessages:inbox.find(m=>m.state==='processing')?.n??0,controlRequests:controls.slice(0,20),controlsHasMore:controls.length>20,controlDetails:'Read full reasons via role_sync and acknowledge through office_host before further side effects.'},
   next:'Honor pending pause/stop and call role_sync. Read every resume page, then list processing mail from afterSeq=0 and check new messages/office_context. Checkpoint time is recorded progress, not proof all earlier events were reviewed. Verify linked material versions before continuing. If no checkpoint exists, reconstruct from authorized messages/materials; never invent missing work. At milestones/before handoff or context loss update continuity; save reusable skills separately. A stopped host is not started by this tool.'};
  const page=this.page([...checkpoints,...tasks],{roleId:a.roleId,mode:'resume',offices:access.offices.map(o=>[o.id,o.state,o.revision])},input,Buffer.byteLength(JSON.stringify(base))+512);
  return this.envelope({...base,...page,checkpoints:page.records.filter(r=>r.kind==='checkpoint'),tasks:page.records.filter(r=>r.kind==='task'),records:undefined},input.contextBudgetBytes);
 }
 async tasks(a:ContinuityAccess,value:unknown={}){
  const input=continuityTasksSchema.parse(value),access=await this.access(a);if(input.officeId&&!access.allowed(input.officeId))throw denied();
  const latest=(await this.db.get<Row>('SELECT MAX(seq) seq FROM role_continuity_history WHERE role_id=?',[a.roleId]))?.seq??0;
  const signature=digest({role:a.roleId,state:input.state,officeId:input.officeId,taskId:input.taskId,latest,offices:access.offices.map(o=>[o.id,o.state,o.revision])});
  let after:Row|undefined;if(input.cursor){try{const c=JSON.parse(Buffer.from(input.cursor,'base64url').toString());if(c.signature!==signature)throw version();if(!Number.isInteger(c.after?.priority)||!Number.isInteger(c.after?.updated_at)||!id.safeParse(c.after?.id).success)throw new Error();after=c.after;}catch(error){if(error instanceof MindPondError)throw error;throw new MindPondError('invalid_input','Invalid task cursor');}}
  const where=['role_id=?'],params:any[]=[a.roleId];
  if(!a.human){where.push('scope IN (SELECT value FROM json_each(?))');params.push(JSON.stringify(['',...access.offices.map(o=>o.id)]));}
  if(input.officeId){where.push('scope=?');params.push(input.officeId);}if(input.taskId){where.push('id=?');params.push(input.taskId);}
  if(input.state==='active')where.push("archived_at IS NULL AND status NOT IN ('done','cancelled')");if(input.state==='completed')where.push("archived_at IS NULL AND status IN ('done','cancelled')");if(input.state==='archived')where.push('archived_at IS NOT NULL');
  if(after){where.push('(priority<? OR (priority=? AND updated_at<?) OR (priority=? AND updated_at=? AND id>?))');params.push(after.priority,after.priority,after.updated_at,after.priority,after.updated_at,after.id);}
  const rows=await this.db.all<Row[]>('SELECT * FROM role_continuity_tasks WHERE '+where.join(' AND ')+' ORDER BY priority DESC,updated_at DESC,id LIMIT 101',params);
  const records:Row[]=[];let used=512,last:Row|undefined,more=rows.length>100;
  for(const row of rows.slice(0,100)){
   const record=this.present(row);if(!await access.references(record,row.scope)){last=row;continue;}
   const bytes=Buffer.byteLength(JSON.stringify(record))+1;if(used+bytes>input.contextBudgetBytes){if(!records.length)throw new MindPondError('material_over_budget','First complete task exceeds budget',{details:{requiredBytes:used+bytes}});more=true;break;}
   records.push(record);last=row;used+=bytes;
  }
  return this.envelope({records,nextCursor:more&&last?Buffer.from(JSON.stringify({signature,after:{priority:last.priority,updated_at:last.updated_at,id:last.id}})).toString('base64url'):null},input.contextBudgetBytes);
 }
 async history(a:ContinuityAccess,value:unknown={}){
  const input=continuityHistorySchema.parse(value),access=await this.access(a);if(input.officeId&&!access.allowed(input.officeId))throw denied();
  const rows=await this.db.all<Row[]>('SELECT * FROM role_continuity_history WHERE role_id=? AND seq<?'+(input.officeId?' AND scope=?':'')+(input.taskId?' AND entity_id=?':'')+' ORDER BY seq DESC LIMIT 101',[a.roleId,input.beforeSeq??Number.MAX_SAFE_INTEGER,...(input.officeId?[input.officeId]:[]),...(input.taskId?[input.taskId]:[])]);
  const records=[];let used=512,last:number|undefined,stopped=false;
  for(const row of rows.slice(0,100)){
   const payload=JSON.parse(row.payload);if(!access.allowed(row.scope)||!await access.references(payload,row.scope)){last=row.seq;continue;}
   const record={seq:row.seq,kind:row.kind,reason:row.reason,recordedAt:row.ts,recordedBy:{kind:row.binding_id?'role':'human',bindingId:row.binding_id,bindingEpoch:row.binding_epoch},payload},bytes=Buffer.byteLength(stableJSON(record))+1;
   if(records.length>=input.limit||used+bytes>input.contextBudgetBytes){if(!records.length)throw new MindPondError('material_over_budget','First full history record exceeds budget',{details:{requiredBytes:used+bytes}});stopped=true;break;}
   records.push(record);last=row.seq;used+=bytes;
  }
  return this.envelope({records,nextBeforeSeq:(stopped||rows.length>100)?last??null:null,note:'History is retained evidence, excluded from default startup. Current office access is checked on every read. Task status is an attributed report, not external verification.'},input.contextBudgetBytes);
 }
}
