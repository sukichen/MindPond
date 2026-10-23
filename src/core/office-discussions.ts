import {CollaborationWaiter,type WorkCallRuntime} from './collaboration-wait.js';
/** Ephemeral, participant-only meetings. No transcript is copied into office mail,
 * event bodies or durable tool receipts; callers explicitly save useful knowledge
 * through the separate Memory MCP before closing the room. */
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import type {Database} from 'sqlite';
import type {GraphMemory} from './graph-memory.js';
import type {TrustedCallContext} from './trust.js';
import {MindPondError} from './errors.js';
import {digest} from './growth.js';
const id=z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),text=(n:number)=>z.string().trim().min(1).max(n);
export const discussionSchema=z.object({action:z.enum(['list','create','get','join','decline','leave','post','export','close','wait']),waitMs:z.number().int().min(100).max(300000).optional(),officeId:id.optional(),id:id.optional(),afterId:id.optional(),title:text(200).optional(),question:text(2000).optional(),doneWhen:text(1000).optional(),participants:id.array().min(1).max(7).optional(),body:text(4000).optional(),memoryId:id.optional(),key:text(256).optional(),expectedRevision:z.number().int().positive().optional(),afterSeq:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(20).default(10),contextBudgetBytes:z.number().int().min(2048).max(65536).default(16384),ttlHours:z.number().int().min(1).max(72).default(24)}).strict();
type Row=Record<string,any>;
function fail(code:'invalid_input'|'not_found'|'scope_denied'|'stale_version'|'idempotency_conflict'|'material_over_budget',message:string):never{throw new MindPondError(code,message);}
export class OfficeDiscussions{
 private waiter=new CollaborationWaiter({inspect:async(i,a)=>{try{const v=await this.run({action:'get',id:i.taskId,afterSeq:i.afterSeq,limit:1,contextBudgetBytes:65536},a);if(v.invitation)fail('scope_denied','Join before waiting for discussion posts');const post=v.posts[0];return post?{status:'matched',discussionId:i.taskId,post,nextCursor:post.seq}:undefined;}catch(error){if((error as any).code==='not_found')return {status:'terminal',discussionId:i.taskId,closed:true,nextCursor:i.afterSeq??0};throw error;}},start:async()=>{},finish:async()=>{}},'office_discussion',{defaultMs:300000,maxMs:300000});
 async wait(value:unknown,a?:TrustedCallContext,r?:WorkCallRuntime){const i=discussionSchema.parse(value);if(!i.id)fail('invalid_input','Wait requires discussion id');const result=await this.waiter.wait({taskId:i.id,afterSeq:i.afterSeq,waitMs:i.waitMs},a,r);return {...result,...((result as Row).status==='timeout'?{resume:{action:'wait',id:i.id,afterSeq:i.afterSeq??0,waitMs:i.waitMs??300000}}:{})};}
 async close(){await this.waiter.close();}
 constructor(private db:Database,private graph:GraphMemory,private write:<T>(fn:()=>Promise<T>)=>Promise<T>,private clock=Date.now){}
 async init(){await this.db.exec(`
 CREATE TABLE IF NOT EXISTS office_discussions(id TEXT PRIMARY KEY,office_id TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,creator TEXT NOT NULL,title TEXT NOT NULL,question TEXT NOT NULL,done_when TEXT NOT NULL,revision INTEGER NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS office_discussion_members(room_id TEXT NOT NULL REFERENCES office_discussions(id) ON DELETE CASCADE,role_id TEXT NOT NULL REFERENCES character_roles(id) ON DELETE CASCADE,state TEXT NOT NULL,PRIMARY KEY(room_id,role_id));
 CREATE UNIQUE INDEX IF NOT EXISTS office_discussion_focus ON office_discussion_members(role_id) WHERE state='joined';
 CREATE TABLE IF NOT EXISTS office_discussion_posts(seq INTEGER PRIMARY KEY AUTOINCREMENT,room_id TEXT NOT NULL REFERENCES office_discussions(id) ON DELETE CASCADE,author TEXT NOT NULL,key TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(room_id,author,key));
 CREATE INDEX IF NOT EXISTS office_discussion_post_page ON office_discussion_posts(room_id,seq);
 CREATE TABLE IF NOT EXISTS office_discussion_exports(room_id TEXT NOT NULL REFERENCES office_discussions(id) ON DELETE CASCADE,memory_id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(room_id,memory_id));
 CREATE TABLE IF NOT EXISTS office_discussion_creations(role_id TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,room_id TEXT NOT NULL,PRIMARY KEY(role_id,key));
 `);}
 private async actor(a?:TrustedCallContext){if(a?.operator&&a.expiresAt>this.clock())return {human:true,roleId:null as string|null};const b=await this.graph.roles.binding(a);return {human:false,roleId:b!.role_id as string};}
 private async member(officeId:string,roleId:string){return !!await this.db.get(`SELECT 1 FROM role_seats rs JOIN office_seats s ON s.id=rs.seat_id JOIN character_roles r ON r.id=rs.role_id WHERE s.office_id=? AND rs.role_id=? AND s.enabled=1 AND r.state='active'`,[officeId,roleId]);}
 private async office(officeId:string,a?:TrustedCallContext,writing=false){
  const actor=await this.actor(a),room=await this.db.get<Row>('SELECT * FROM offices WHERE id=?',[officeId]);
  if(!room)fail('not_found','Office not found');
  if(!actor.human&&(!(await this.member(officeId,actor.roleId!))||!(await this.graph.offices.authorizedSeats(a!)).some(s=>s.office_id===officeId)))fail('scope_denied','This role is not currently authorized for this office');
  if(writing&&(room.state!=='active'||room.deadline&&room.deadline<=this.clock()))fail('invalid_input','Office is not open for new discussion work');
  return actor;
 }
 private async log(kind:string,id:string,officeId:string){await this.db.run('INSERT INTO role_events(role_id,kind,body,ts) VALUES(NULL,?,?,?)',[kind,JSON.stringify({discussionId:id,officeId}),this.clock()]);}
 private async purge(id:string){const row=await this.db.get<Row>('SELECT office_id FROM office_discussions WHERE id=?',[id]);if(!row)return;await this.db.run('DELETE FROM office_discussions WHERE id=?',[id]);await this.db.run('DELETE FROM office_response_pages');await this.log('discussion_closed',id,row.office_id);}
 async sweep(){return this.write(()=>this.cleanup());}
 private async cleanup(){for(const r of await this.db.all<Row[]>('SELECT id FROM office_discussions WHERE expires_at<=?',[this.clock()]))await this.purge(r.id);}
 private async room(id:string,a?:TrustedCallContext,writing=false){const row=await this.db.get<Row>('SELECT * FROM office_discussions WHERE id=?',[id]);if(!row)fail('not_found','Discussion ended or does not exist; its temporary content has been deleted');const actor=await this.office(row.office_id,a,writing);const m=actor.human?null:await this.db.get<Row>('SELECT state FROM office_discussion_members WHERE room_id=? AND role_id=?',[id,actor.roleId]);if(!actor.human&&!m)fail('not_found','Discussion not found among your invitations');return {row,actor,state:m?.state};}
 private async focus(roleId:string){return this.db.get<Row>(`SELECT r.id,r.office_id,r.title,r.revision FROM office_discussion_members m JOIN office_discussions r ON r.id=m.room_id WHERE m.role_id=? AND m.state='joined'`,[roleId]);}
 async attention(a?:TrustedCallContext){return this.write(async()=>{const actor=await this.actor(a);if(actor.human)return {};await this.cleanup();
  // Membership and host grants are rechecked, including after an office move.
  const rows=await this.db.all<Row[]>(`SELECT r.id,r.office_id,r.title,r.revision,m.state FROM office_discussion_members m JOIN office_discussions r ON r.id=m.room_id WHERE m.role_id=? AND m.state IN ('joined','invited') ORDER BY r.created_at,r.id LIMIT 64`,[actor.roleId]);
  const allowed=new Set((await this.graph.offices.authorizedSeats(a!)).map(s=>s.office_id));
  for(const r of rows)if(!allowed.has(r.office_id)||!await this.member(r.office_id,actor.roleId!))await this.db.run("UPDATE office_discussion_members SET state='left' WHERE room_id=? AND role_id=?",[r.id,actor.roleId]);
  const visible=rows.filter(r=>allowed.has(r.office_id));return {active:visible.find(r=>r.state==='joined')??null,invitations:visible.filter(r=>r.state==='invited'),next:'Use office_discussion get/join/post/wait/leave; wait afterSeq uses the discussion cursor, not the mailbox cursor. While joined, prioritize this bounded discussion; other inbox messages remain pending. Save reusable conclusions with the separate Memory MCP before closing. Closing/expiry permanently deletes temporary discussion content; it never wakes a stopped host.'};
 });}
 async assertMailbox(a?:TrustedCallContext){const priority=await this.attention(a);if(priority.active)throw new MindPondError('invalid_input','Finish or leave your active discussion before taking ordinary mailbox work',{details:{discussionId:priority.active.id},nextAction:'Use office_discussion get/post/leave. Ordinary messages remain pending.'});}
 async run(value:unknown,a?:TrustedCallContext):Promise<Row>{const i=discussionSchema.parse(value);return this.write(async()=>{await this.cleanup();const actor=await this.actor(a);
  if(i.action==='create'){
   if(!i.officeId||!i.title||!i.question||!i.doneWhen||!i.participants||!i.key)fail('invalid_input','Create requires officeId,title,question,doneWhen,participants,key');
   await this.office(i.officeId,a,true);if(actor.human)fail('invalid_input','Create a discussion from an approved role; human management can inspect and close discussions');
   const old=await this.db.get<Row>('SELECT * FROM office_discussion_creations WHERE role_id=? AND key=?',[actor.roleId,i.key]);const hash=digest(i);
   if(old){if(old.hash!==hash)fail('idempotency_conflict','Discussion creation key has another payload');const exists=await this.db.get('SELECT 1 FROM office_discussions WHERE id=?',[old.room_id]);return exists?this.view(old.room_id,i,a):{id:old.room_id,closed:true};}
   await this.attention(a);
   if(await this.focus(actor.roleId!))fail('invalid_input','Leave your current discussion before opening another');
   const members=[...new Set([actor.roleId!,...i.participants])];if(members.length<2||members.length>8)fail('invalid_input','Choose 2–8 distinct office roles including yourself');
   for(const role of members)if(!await this.member(i.officeId,role))fail('scope_denied','Every participant must be an active member of this office');
   if((await this.db.get<Row>('SELECT COUNT(*) n FROM office_discussions WHERE office_id=?',[i.officeId]))!.n>=16)fail('invalid_input','At most 16 discussions may be open per office');
   const roomId=randomUUID();await this.db.run('INSERT INTO office_discussions VALUES(?,?,?,?,?,?,1,?,?)',[roomId,i.officeId,actor.roleId,i.title,i.question,i.doneWhen,this.clock()+i.ttlHours*3600000,this.clock()]);
   for(const role of members)await this.db.run('INSERT INTO office_discussion_members VALUES(?,?,?)',[roomId,role,role===actor.roleId?'joined':'invited']);
   await this.db.run('INSERT INTO office_discussion_creations VALUES(?,?,?,?)',[actor.roleId,i.key,hash,roomId]);await this.log('discussion_created',roomId,i.officeId);return this.view(roomId,i,a);
  }
  if(i.action==='list'){
   if(!i.officeId)fail('invalid_input','List requires officeId');await this.office(i.officeId,a);
   const records=await this.db.all<Row[]>(`SELECT r.id,r.title,r.creator,r.revision,r.expires_at,m.state FROM office_discussions r LEFT JOIN office_discussion_members m ON m.room_id=r.id AND m.role_id=? WHERE r.office_id=? AND r.id>? ${actor.human?'':"AND m.state IS NOT NULL"} ORDER BY r.id LIMIT ?`,[actor.roleId,i.officeId,i.afterId??'',i.limit+1]);const rooms:Row[]=[];
   for(const record of records.slice(0,i.limit)){if(Buffer.byteLength(JSON.stringify(rooms))+Buffer.byteLength(JSON.stringify(record))+256>i.contextBudgetBytes)break;rooms.push(record);}return {rooms,hasMore:records.length>rooms.length,nextAfterId:rooms.at(-1)?.id??i.afterId??''};
  }
  if(!i.id)fail('invalid_input','Discussion id is required');const {row,state}=await this.room(i.id,a,!['get','leave','decline','close'].includes(i.action));
  if(i.action==='get')return this.view(i.id,i,a);
  if(i.action==='join'){
   if(actor.human)fail('invalid_input','A human cannot impersonate a participant');if(!['invited','joined','left','declined'].includes(state))fail('invalid_input','This role is not invited');await this.attention(a);const active=await this.focus(actor.roleId!);if(active&&active.id!==i.id)fail('invalid_input','Leave your current discussion before joining another');if(state!=='joined'){await this.db.run("UPDATE office_discussion_members SET state='joined' WHERE room_id=? AND role_id=?",[i.id,actor.roleId]);await this.changed(row);}return this.view(i.id,i,a);
  }
  if(i.action==='decline'||i.action==='leave'){
   if(actor.human)fail('invalid_input','Use close to end a discussion as human manager');if(i.action==='decline'&&state!=='invited'&&state!=='declined')fail('invalid_input','Decline applies to an invitation; joined participants use leave');
   await this.db.run('UPDATE office_discussion_members SET state=? WHERE room_id=? AND role_id=?',[i.action==='decline'?'declined':'left',i.id,actor.roleId]);await this.changed(row);
   const remaining=await this.db.get<Row>("SELECT COUNT(*) n FROM office_discussion_members WHERE room_id=? AND state IN ('joined','invited')",[i.id]);if(!remaining!.n)await this.purge(i.id);return {id:i.id,left:true,closed:!remaining!.n};
  }
  if(i.action==='close'){
   if(!actor.human&&row.creator!==actor.roleId)fail('scope_denied','Only the discussion creator or human manager can close the room');if(i.expectedRevision!==row.revision)fail('stale_version','Discussion changed; read the latest posts and exports before closing');await this.purge(i.id);return {id:i.id,closed:true,contentDeleted:true};
  }
  if(!actor.human&&state!=='joined')fail('scope_denied','Join the discussion before reading or contributing content');
  if(i.action==='post'){
   if(actor.human)fail('invalid_input','Discussion posts must retain an authenticated role author');if(!i.body||!i.key)fail('invalid_input','Post requires body and stable key');if(Buffer.byteLength(i.body)>8000)fail('material_over_budget','Split posts into messages of at most 8000 UTF-8 bytes');
   const old=await this.db.get<Row>('SELECT seq,body FROM office_discussion_posts WHERE room_id=? AND author=? AND key=?',[i.id,actor.roleId,i.key]);if(old){if(old.body!==i.body)fail('idempotency_conflict','Post key has another body');return {id:i.id,seq:old.seq};}
   const size=await this.db.get<Row>('SELECT COUNT(*) n,COALESCE(SUM(length(CAST(body AS BLOB))),0) bytes FROM office_discussion_posts WHERE room_id=?',[i.id]);if(size!.n>=256||size!.bytes+Buffer.byteLength(i.body)>524288)fail('material_over_budget','Discussion limit reached; summarize, save useful memory and close the room');
   const result=await this.db.run('INSERT INTO office_discussion_posts(room_id,author,key,body,created_at) VALUES(?,?,?,?,?)',[i.id,actor.roleId,i.key,i.body,this.clock()]);await this.changed(row);return {id:i.id,seq:result.lastID,revision:row.revision+1};
  }
  if(i.action==='export'){
   if(!i.memoryId)fail('invalid_input','Save knowledge with the separate Memory MCP first, then supply memoryId');
   const context=actor.human?undefined:await this.graph.memoryOwners.context({kind:'agent',id:actor.roleId!});const memory=await this.graph.getNodeById(i.memoryId,{trackAccess:false,context});if(!memory)fail('not_found','Exported memory does not exist');
   if((await this.db.get<Row>('SELECT COUNT(*) n FROM office_discussion_exports WHERE room_id=?',[i.id]))!.n>=16&&!await this.db.get('SELECT 1 FROM office_discussion_exports WHERE room_id=? AND memory_id=?',[i.id,i.memoryId]))fail('invalid_input','Keep at most 16 selected memory exports per discussion');
   const fingerprint=createHash('sha256').update(memory.content).digest('hex');const saved=await this.db.run('INSERT INTO office_discussion_exports VALUES(?,?,?) ON CONFLICT(room_id,memory_id) DO UPDATE SET fingerprint=excluded.fingerprint WHERE fingerprint<>excluded.fingerprint',[i.id,i.memoryId,fingerprint]);if(saved.changes)await this.changed(row);return {memoryId:i.memoryId,fingerprint,notice:'Independent memory survives discussion deletion. This action neither copies a transcript nor grants other roles access.'};
  }
  fail('invalid_input','Unsupported discussion action');
 });}
 private async changed(row:Row){await this.db.run('UPDATE office_discussions SET revision=revision+1 WHERE id=?',[row.id]);await this.log('discussion_updated',row.id,row.office_id);}
 private async view(roomId:string,i:z.infer<typeof discussionSchema>,a?:TrustedCallContext){const {row,actor,state}=await this.room(roomId,a);const members=await this.db.all('SELECT m.role_id roleId,r.name,m.state FROM office_discussion_members m JOIN character_roles r ON r.id=m.role_id WHERE m.room_id=? ORDER BY r.name,m.role_id',[roomId]);
  if(!actor.human&&state!=='joined')return {room:row,members,posts:[],invitation:state,notice:'Join to read discussion posts. Leaving removes access to temporary content.'};
  const rows=await this.db.all<Row[]>('SELECT p.seq,p.author,r.name authorName,p.body,p.created_at FROM office_discussion_posts p LEFT JOIN character_roles r ON r.id=p.author WHERE p.room_id=? AND p.seq>? ORDER BY p.seq LIMIT ?',[roomId,i.afterSeq??0,i.limit+1]);
  const exports=await this.db.all('SELECT memory_id memoryId,fingerprint FROM office_discussion_exports WHERE room_id=?',[roomId]);const lastSeq=(await this.db.get<Row>('SELECT COALESCE(MAX(seq),0) n FROM office_discussion_posts WHERE room_id=?',[roomId]))!.n;const base={room:row,members,exports,lastSeq,posts:[] as Row[],nextAfterSeq:i.afterSeq??0,hasMore:false};
  for(const post of rows.slice(0,i.limit)){if(Buffer.byteLength(JSON.stringify({...base,posts:[...base.posts,post]}))+128>i.contextBudgetBytes){if(!base.posts.length)fail('material_over_budget','Raise contextBudgetBytes to read the next complete post');break;}base.posts.push(post);base.nextAfterSeq=post.seq;}base.hasMore=rows.length>base.posts.length;if(Buffer.byteLength(JSON.stringify(base))>i.contextBudgetBytes)fail('material_over_budget','Raise contextBudgetBytes to read the full discussion metadata');return base;
 }
}
