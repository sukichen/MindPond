import {roleControlAttention} from './role-control-attention.js';
import {DiscussionDepartures} from './office-discussion-departures.js';
import {DiscussionObservations} from './office-discussion-observations.js';
import {memoryAccess} from './memory-access.js';
import {CollaborationWaiter,type WorkCallRuntime,type WorkWaitInput} from './collaboration-wait.js';
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
import {previewText} from './office-context.js';
const id=z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),text=(n:number)=>z.string().trim().min(1).max(n);
export const discussionSchema=z.object({action:z.enum(['list','create','get','join','decline','leave','post','finish','export','close','wait','request_participants','review_participants','cancel_request','request_get','departures','departure_get','send_departure','discard_departure']),postSeqs:z.array(z.number().int().positive()).min(1).max(128).optional(),summary:text(4000).optional(),messages:z.array(z.object({recipient:id,body:text(4000),replyTo:id.optional(),officeId:id.nullable().optional()}).strict()).max(7).optional(),departureId:id.optional(),messageIndex:z.number().int().min(0).max(6).optional(),requestId:id.optional(),reason:text(800).optional(),decision:z.enum(['approve','reject']).optional(),note:text(800).optional(),afterRevision:z.number().int().positive().optional(),waitMs:z.number().int().min(100).max(300000).optional(),officeId:id.optional(),id:id.optional(),afterId:id.optional(),title:text(200).optional(),question:text(2000).optional(),doneWhen:text(1000).optional(),participants:id.array().min(1).max(7).optional(),body:text(4000).optional(),memoryId:id.optional(),key:text(256).optional(),expectedRevision:z.number().int().positive().optional(),afterSeq:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(20).default(10),contextBudgetBytes:z.number().int().min(2048).max(65536).default(16384),ttlHours:z.number().int().min(1).max(72).default(24)}).strict();
type Row=Record<string,any>;
export const discussionLockSchema=z.object({id,locked:z.boolean(),expectedLockRevision:z.number().int().positive()}).strict();
const DISCUSSION_NOTICE='Human-locked rooms block join/leave/close and pause expiry; only the human can unlock. Existing members continue discussing. Only a currently joined participant or human manager may close; creators outside cannot. Decline never closes. get: oldest unprocessed posts from others. wait: unseen posts from others. Omit id for your active room; omit afterSeq for normal work (explicit afterSeq reads history, 0 from the start). After handling posts, submit returned finish or a handled subset; reading is not completion. Unprocessed includes unread. While joined, ordinary sends/replies/broadcasts/handoffs and outside completion feedback are blocked. Helpers: request_participants(id,participants,reason,key), human approval, explicit join; no memory grants. Before leave: summary,key,optional selected messages sent after exit. Failed notifications: departures → departure_get/send_departure/discard_departure. Save reusable knowledge via separate Memory MCP. Fetched/waiting does not prove understanding, completion or a running host.';
function fail(code:'invalid_input'|'not_found'|'scope_denied'|'stale_version'|'idempotency_conflict'|'material_over_budget',message:string):never{throw new MindPondError(code,message);}
export class OfficeDiscussions{
 private observations:DiscussionObservations;
 private departures:DiscussionDepartures;
 private waiter=new CollaborationWaiter({inspect:(i,a)=>this.inspectWait(i,a),start:(id,i,a,ms)=>this.startWait(id,i,a,ms),finish:id=>this.finishWait(id)},'office_discussion',{defaultMs:300000,maxMs:300000});
 /** Defaults are scoped to the authenticated role; explicit cursors are history reads. */
 private async currentId(a?:TrustedCallContext){
  const actor=await this.actor(a),active=actor.human?null:await this.focus(actor.roleId!);
  if(!active)throw new MindPondError('invalid_input','No active discussion can be selected for this identity.',{field:'id',nextAction:'Use role_sync to inspect your discussion invitations and explicitly join one, or supply an authorized discussion id. Human inspection requires an explicit id.'});
  await this.room(active.id,a);return active.id as string;
 }
 private async posts(roomId:string,roleId:string|undefined,afterSeq:number|undefined,limit:number,selection:'unprocessed'|'unread'){
  const columns='SELECT p.seq,p.author,r.name authorName,p.body,p.created_at FROM office_discussion_posts p LEFT JOIN character_roles r ON r.id=p.author WHERE p.room_id=?';
  if(afterSeq!==undefined||!roleId)return this.db.all<Row[]>(columns+' AND p.seq>? ORDER BY p.seq LIMIT ?',[roomId,afterSeq??0,limit]);
  const filter=selection==='unprocessed'
   ?'NOT EXISTS(SELECT 1 FROM office_discussion_handled h WHERE h.room_id=p.room_id AND h.role_id=? AND h.post_seq=p.seq)'
   :"p.seq NOT IN (SELECT value FROM office_discussion_observations o,json_each(o.provided_seqs) WHERE o.room_id=p.room_id AND o.role_id=?)";
  return this.db.all<Row[]>(columns+' AND p.author<>? AND '+filter+' ORDER BY p.seq LIMIT ?',[roomId,roleId,roleId,limit]);
 }
 private finishCommand(roomId:string,posts:Row[]){const seqs=posts.filter(p=>p.processingState==='unprocessed').map(p=>p.seq);return seqs.length?{finish:{action:'finish',id:roomId,postSeqs:seqs}}:{};}
 private async waitView(i:WorkWaitInput&{officeId?:string;unreadOnly?:boolean},a?:TrustedCallContext){return this.write(async()=>{
  await this.cleanup();await this.actor(a);const {row,actor,state}=await this.room(i.taskId!,a);
  if(i.officeId!==undefined&&i.officeId!==row.office_id)fail('not_found','Discussion not found in the specified office');
  if(actor.human||state!=='joined')fail('scope_denied','Join before waiting for discussion posts');
  await this.observations.waiting(row.id,actor.roleId!);
  return {room:row,control:await roleControlAttention(this.db,actor.roleId!),posts:await this.posts(row.id,actor.roleId!,i.unreadOnly?undefined:i.afterSeq,1,'unread')};
 });}
 private async inspectWait(i:WorkWaitInput&{officeId?:string;afterRevision?:number;unreadOnly?:boolean},a?:TrustedCallContext){
  try{
   const view=await this.waitView(i,a),post=view.posts[0];
   if(view.control)return {...view.control,discussionId:i.taskId,nextCursor:i.afterSeq??0};
   if(post)return {status:'matched' as const,discussionId:i.taskId,post,nextCursor:post.seq,revision:view.room.revision,locked:!!view.room.locked};
   if(i.afterRevision!==undefined&&view.room.revision>i.afterRevision){const detail=await this.write(()=>this.view(i.taskId!,discussionSchema.parse({action:'get',id:i.taskId,contextBudgetBytes:65536}),a,false));return {status:'matched' as const,discussionId:i.taskId,kind:'discussion_updated',nextCursor:i.afterSeq??0,revision:view.room.revision,locked:!!detail.room.locked,members:detail.members,participantRequests:detail.participantRequests,nextAction:'Read get to inspect the updated participants and human decisions. '+DISCUSSION_NOTICE};}
   return undefined;
  }catch(error){
   if((error as any).code==='not_found'&&!await this.write(()=>this.db.get('SELECT 1 FROM office_discussions WHERE id=?',[i.taskId])))return {status:'terminal' as const,discussionId:i.taskId,closed:true,nextCursor:i.afterSeq??0,nextAction:'The temporary discussion is absent (ended or its ID is incorrect). Check role_sync/invitations and the discussion ID before ordinary work; this does not prove task completion. Independent memories remain.'};
   throw error;
  }
 }
 async wait(value:unknown,a?:TrustedCallContext,r?:WorkCallRuntime){
  const i=discussionSchema.parse(value);if(!i.id)i.id=await this.write(async()=>{await this.cleanup();return this.currentId(a);});
  let baseline=i.afterRevision;
  if(baseline===undefined){try{baseline=(await this.waitView({taskId:i.id,officeId:i.officeId,afterSeq:i.afterSeq,unreadOnly:i.afterSeq===undefined},a)).room.revision;}catch(error){if((error as any).code!=='not_found')throw error;}}
  const input={taskId:i.id,afterSeq:i.afterSeq,unreadOnly:i.afterSeq===undefined,waitMs:i.waitMs,afterRevision:baseline,...(i.officeId?{officeId:i.officeId}:{})};const result:Row=await this.waiter.wait(input,a,r);
  if(result.status==='matched'&&(result as Row).post)await this.write(async()=>{const actor=await this.actor(a);const {row,state}=await this.room(i.id!,a);if(state!=='joined')fail('scope_denied','You left this discussion before the wait result was delivered');const advanced=await this.observations.delivered(row.id,actor.roleId!,i.afterSeq??0,(result as Row).post.seq,[(result as Row).post.seq]);if(advanced)await this.log('discussion_fetched',row.id,row.office_id);(result as Row).post.processingState=(result as Row).post.author===actor.roleId?'own':(await this.observations.handled(row.id,actor.roleId!)).has((result as Row).post.seq)?'handled':'unprocessed';});
  return {...result,selection:i.afterSeq===undefined?'unread':'history',...(result.post?this.finishCommand(i.id,[result.post]):{}),...(['matched','timeout'].includes(result.status)?{resume:{action:'wait',id:i.id,...(i.officeId?{officeId:i.officeId}:{}),...(i.afterSeq!==undefined?{afterSeq:result.nextCursor}:{}),afterRevision:(result as Row).revision??baseline,waitMs:i.waitMs??300000}}:{})};
 }
 async close(){await this.waiter.close();}
 constructor(private db:Database,private graph:GraphMemory,private write:<T>(fn:()=>Promise<T>)=>Promise<T>,private clock=Date.now){this.observations=new DiscussionObservations(db,clock);this.departures=new DiscussionDepartures(db,graph,write,clock);}
 async init(){await this.db.exec(`
 CREATE TABLE IF NOT EXISTS office_discussions(id TEXT PRIMARY KEY,office_id TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,creator TEXT NOT NULL,title TEXT NOT NULL,question TEXT NOT NULL,done_when TEXT NOT NULL,revision INTEGER NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS office_discussion_members(room_id TEXT NOT NULL REFERENCES office_discussions(id) ON DELETE CASCADE,role_id TEXT NOT NULL REFERENCES character_roles(id) ON DELETE CASCADE,state TEXT NOT NULL,PRIMARY KEY(room_id,role_id));
 CREATE UNIQUE INDEX IF NOT EXISTS office_discussion_focus ON office_discussion_members(role_id) WHERE state='joined';
 CREATE TABLE IF NOT EXISTS office_discussion_posts(seq INTEGER PRIMARY KEY AUTOINCREMENT,room_id TEXT NOT NULL REFERENCES office_discussions(id) ON DELETE CASCADE,author TEXT NOT NULL,key TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(room_id,author,key));
 CREATE INDEX IF NOT EXISTS office_discussion_post_page ON office_discussion_posts(room_id,seq);
 CREATE TABLE IF NOT EXISTS office_discussion_exports(room_id TEXT NOT NULL REFERENCES office_discussions(id) ON DELETE CASCADE,memory_id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(room_id,memory_id));
 CREATE TABLE IF NOT EXISTS office_discussion_creations(role_id TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,room_id TEXT NOT NULL,PRIMARY KEY(role_id,key));
 CREATE TABLE IF NOT EXISTS office_discussion_conclusions(room_id TEXT NOT NULL REFERENCES office_discussions(id) ON DELETE CASCADE,key TEXT NOT NULL,hash TEXT NOT NULL,memory_id TEXT NOT NULL,PRIMARY KEY(room_id,key));
 CREATE TABLE IF NOT EXISTS office_discussion_requests(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES office_discussions(id) ON DELETE CASCADE,requester TEXT NOT NULL REFERENCES character_roles(id) ON DELETE CASCADE,participants TEXT NOT NULL,reason TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,created_at INTEGER NOT NULL,reviewed_at INTEGER,review_note TEXT,UNIQUE(room_id,requester,key));
 `);await this.write(async()=>{const columns=await this.db.all<Row[]>('PRAGMA table_info(office_discussions)');
  if(!columns.some(c=>c.name==='locked'))await this.db.exec('ALTER TABLE office_discussions ADD COLUMN locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0,1))');
  if(!columns.some(c=>c.name==='locked_at'))await this.db.exec('ALTER TABLE office_discussions ADD COLUMN locked_at INTEGER');
  if(!columns.some(c=>c.name==='lock_revision'))await this.db.exec('ALTER TABLE office_discussions ADD COLUMN lock_revision INTEGER NOT NULL DEFAULT 1');
 });await this.observations.init();await this.departures.init();}
 private assertUnlocked(row:Row){if(row.locked)throw new MindPondError('scope_denied','This discussion is locked by the human user; roles cannot join, leave or close it.',{details:{discussionId:row.id,locked:true},nextAction:'Ask the human to unlock this room in the discussion panel. Existing members may continue get/post/finish/wait and save knowledge. No attendance, summary or outgoing messages were changed.'});}
 private assertJoinedCloser(row:Row,state:string){if(state!=='joined')throw new MindPondError('scope_denied','Only a currently joined participant or the human manager can close this discussion; creating it or receiving an invitation does not grant closing permission.',{details:{discussionId:row.id,membership:state},nextAction:'Continue your current work. To close this discussion, ask a current participant or the human manager; alternatively explicitly join it first if authorized and unlocked. Closing as a participant requires the latest expectedRevision, summary and key. No discussion content or attendance was changed.'});}
 async setLock(value:unknown,a?:TrustedCallContext){
  if(!a?.operator||a.expiresAt<=this.clock())fail('scope_denied','Only the human manager can lock or unlock a discussion');
  const i=discussionLockSchema.parse(value);return this.write(async()=>{
   await this.cleanup();const {row}=await this.room(i.id,a);
   if(!!row.locked===i.locked)return {id:row.id,locked:i.locked,revision:row.revision,lockRevision:row.lock_revision,expiresAt:row.expires_at,changed:false};
   // Ordinary posts must not prevent the human from locking an active room.
   if(row.lock_revision!==i.expectedLockRevision)fail('stale_version','会议室锁已被调整，请刷新后再操作。');
   const at=this.clock(),expires=row.expires_at+(row.locked?Math.max(0,at-row.locked_at):0);
   await this.db.run('UPDATE office_discussions SET locked=?,locked_at=?,expires_at=?,lock_revision=lock_revision+1 WHERE id=?',[i.locked?1:0,i.locked?at:null,expires,row.id]);
   await this.changed(row);return {id:row.id,locked:i.locked,revision:row.revision+1,lockRevision:row.lock_revision+1,expiresAt:expires,changed:true};
  });
 }
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
 private async purge(id:string){const row=await this.db.get<Row>('SELECT office_id FROM office_discussions WHERE id=?',[id]);if(!row)return;await this.db.run('DELETE FROM office_discussions WHERE id=?',[id]);await this.log('discussion_closed',id,row.office_id);this.waiter.notify();}
 async sweep(){return this.write(()=>this.cleanup());}
 private async cleanup(){for(const r of await this.db.all<Row[]>('SELECT id FROM office_discussions WHERE locked=0 AND expires_at<=?',[this.clock()]))await this.purge(r.id);}
 private async room(id:string,a?:TrustedCallContext,writing=false){const row=await this.db.get<Row>('SELECT * FROM office_discussions WHERE id=?',[id]);if(!row)fail('not_found','Discussion ended or does not exist; its temporary content has been deleted');const actor=await this.office(row.office_id,a,writing);const m=actor.human?null:await this.db.get<Row>('SELECT state FROM office_discussion_members WHERE room_id=? AND role_id=?',[id,actor.roleId]);if(!actor.human&&!m)fail('not_found','Discussion not found among your invitations');return {row,actor,state:m?.state};}
 private async focus(roleId:string){return this.db.get<Row>(`SELECT r.id,r.office_id,r.title,r.revision,r.locked FROM office_discussion_members m JOIN office_discussions r ON r.id=m.room_id WHERE m.role_id=? AND m.state='joined'`,[roleId]);}
 private async requests(roomId:string){
  const rows=await this.db.all<Row[]>('SELECT q.*,r.name requesterName FROM office_discussion_requests q JOIN character_roles r ON r.id=q.requester WHERE room_id=? ORDER BY (q.state=\'pending\') DESC,created_at DESC,id LIMIT 12',[roomId]);
  const ids=[...new Set<string>(rows.flatMap(q=>JSON.parse(q.participants)))];
  const names=new Map((await this.db.all<Row[]>('SELECT id,name,state FROM character_roles WHERE id IN (SELECT value FROM json_each(?))',[JSON.stringify(ids)])).map(r=>[r.id,r]));
  const members=new Set((await this.db.all<Row[]>('SELECT rs.role_id FROM role_seats rs JOIN office_seats s ON s.id=rs.seat_id WHERE s.office_id=(SELECT office_id FROM office_discussions WHERE id=?) AND s.enabled=1',[roomId])).map(r=>r.role_id));
  return rows.map(q=>{return {id:q.id,requester:q.requester,requesterName:previewText(q.requesterName,80),participants:(JSON.parse(q.participants) as string[]).map(id=>({roleId:id,name:previewText(names.get(id)?.name??id,80),available:names.get(id)?.state==='active',officeMember:members.has(id)})),reason:previewText(q.reason,240),reasonTruncated:Buffer.byteLength(q.reason)>240,state:q.state,revision:q.revision,createdAt:q.created_at,reviewedAt:q.reviewed_at,note:previewText(q.review_note??'',240),noteTruncated:Buffer.byteLength(q.review_note??'')>240};});
 }
 private async participantRequest(i:z.infer<typeof discussionSchema>,room:Row,actor:{human:boolean;roleId:string|null},state:string|undefined,a?:TrustedCallContext){
  if(i.action==='request_participants'){
   if(actor.human||state!=='joined')fail('scope_denied','Only a joined participant can request additional helpers');
   if(!i.participants||!i.reason||!i.key)fail('invalid_input','request_participants requires id,participants,reason,key');
   const people=[...new Set(i.participants)].sort(),hash=digest({participants:people,reason:i.reason});
   const old=await this.db.get<Row>('SELECT * FROM office_discussion_requests WHERE room_id=? AND requester=? AND key=?',[room.id,actor.roleId,i.key]);
   if(old){if(old.hash!==hash)fail('idempotency_conflict','This request key has a different helper list or reason');return {requestId:old.id,state:old.state,revision:old.revision,note:old.review_note,notice:'Read request_get for the human decision; do not send ordinary messages while joined.'};}
   if((await this.db.get<Row>('SELECT COUNT(*) n FROM office_discussion_requests WHERE room_id=?',[room.id]))!.n>=32)fail('invalid_input','This temporary room already has 32 helper requests; review existing requests before creating another room');
   if((await this.db.get<Row>("SELECT COUNT(*) n FROM office_discussion_requests WHERE room_id=? AND state='pending'",[room.id]))!.n>=8)fail('invalid_input','There are already 8 pending requests; wait for human review or cancel your obsolete request');
   for(const roleId of people){await this.graph.roles.contact(roleId,a);if(await this.db.get("SELECT 1 FROM office_discussion_members WHERE room_id=? AND role_id=? AND state IN ('joined','invited')",[room.id,roleId]))fail('invalid_input','A requested helper is already joined or invited; inspect get members before requesting');}
   const requestId=randomUUID();await this.db.run("INSERT INTO office_discussion_requests VALUES(?,?,?,?,?,'pending',1,?,?,?,NULL,NULL)",[requestId,room.id,actor.roleId,JSON.stringify(people),i.reason,i.key,hash,this.clock()]);await this.changed(room);
   return {requestId,state:'pending',revision:1,notice:'Human approval is required. No invitation or external message has been sent. Continue this discussion or wait with afterSeq/afterRevision; request_get reads the decision.'};
  }
  if(!i.requestId)fail('invalid_input','This action requires requestId in addition to discussion id');
  const request=await this.db.get<Row>('SELECT * FROM office_discussion_requests WHERE id=? AND room_id=?',[i.requestId,room.id]);if(!request)fail('not_found','Helper request not found in this discussion');
  if(i.action==='request_get'){
   if(!actor.human&&state!=='joined'&&request.requester!==actor.roleId)fail('scope_denied','Join this room before reading helper requests');
   return {request:{id:request.id,requester:request.requester,participants:JSON.parse(request.participants),reason:request.reason,state:request.state,revision:request.revision,note:request.review_note,reviewedAt:request.reviewed_at},notice:DISCUSSION_NOTICE};
  }
  const decision=i.action==='cancel_request'?'cancelled':i.decision==='approve'?'approved':i.decision==='reject'?'rejected':null;
  if(!decision)fail('invalid_input','review_participants requires decision=approve or reject');
  if(i.action==='review_participants'&&!actor.human)fail('scope_denied','Only the human user can approve or reject helper requests. Ask them to review the front-end discussion card.');
  if(i.action==='cancel_request'&&!actor.human&&request.requester!==actor.roleId)fail('scope_denied','Only the requester or human may cancel this helper request');
  const note=i.note??(decision==='approved'?'用户已批准邀请。':decision==='rejected'?'用户已拒绝申请。':'申请已取消。');
  if(request.state!=='pending'){
   if(request.state===decision&&request.revision===Number(i.expectedRevision)+1&&request.review_note===note)return {requestId:request.id,state:request.state,revision:request.revision,note};
   fail('stale_version','Request already decided; use request_get and preserve the actual decision');
  }
  if(i.expectedRevision!==request.revision)fail('stale_version','Read request_get and send its current expectedRevision');
  const people:string[]=JSON.parse(request.participants);
  if(decision==='approved'){
   await this.office(room.office_id,a,true);
   const existing=await this.db.all<Row[]>('SELECT role_id FROM office_discussion_members WHERE room_id=?',[room.id]);
   if(new Set([...existing.map(r=>r.role_id),...people]).size>8)fail('invalid_input','Approval would exceed the 8 distinct participant seats reserved for this temporary room (including departed/declined members). Continue in another discussion or choose existing participants');
   for(const roleId of people)if(!await this.member(room.office_id,roleId))fail('scope_denied','A helper is not an active member of this office. The human must explicitly add office membership first; approval never grants memory access.');
   for(const roleId of people)await this.db.run("INSERT INTO office_discussion_members VALUES(?,?,'invited') ON CONFLICT(room_id,role_id) DO UPDATE SET state=CASE WHEN state='joined' THEN state ELSE 'invited' END",[room.id,roleId]);
  }
  await this.db.run('UPDATE office_discussion_requests SET state=?,revision=revision+1,reviewed_at=?,review_note=? WHERE id=?',[decision,this.clock(),note,request.id]);await this.changed(room);
  return {requestId:request.id,state:decision,revision:request.revision+1,note,notice:decision==='approved'?'Approved helpers are invited; they must join explicitly. No office membership or memory permission was added.':'The request is resolved; no invitation was added.'};
 }
 async assertCommunication(a?:TrustedCallContext,recipient?:string,feedback=false){
  if(a?.operator)return;const priority=await this.attention(a);if(!priority.active&&!priority.activeUnavailable)return;
  if(feedback&&priority.active&&recipient&&await this.db.get("SELECT 1 FROM office_discussion_members WHERE room_id=? AND role_id=? AND state='joined'",[priority.active.id,recipient]))return;
  throw new MindPondError('scope_denied',feedback?'Completion would send feedback outside your active discussion; finish it after leaving. The message remains processing.':'Ordinary messages, broadcasts and handoffs are blocked while your role is in a discussion.',{details:priority.active?{discussionId:priority.active.id}:undefined,nextAction:priority.activeUnavailable?priority.next:priority.active?.locked?'The human locked your discussion. Ask the human to unlock before leaving or contacting outside roles; continue get/post/finish/wait inside. Request helpers with request_participants, then await human approval and unlocking. No message was sent.':'Use office_discussion post inside the room. For outside help use request_participants with id,participants,reason,key, then wait for human approval. Or leave with summary,key before ordinary communication. No message was sent.'});
 }
 private async startWait(id:string,i:WorkWaitInput,a:TrustedCallContext,ms:number){return this.write(async()=>{
  const {row,actor,state}=await this.room(i.taskId!,a);if(actor.human||state!=='joined')fail('scope_denied','Only joined roles can wait for discussion posts');
  const binding=await this.graph.roles.binding(a);await this.db.run('INSERT INTO office_discussion_waits VALUES(?,?,?,?,?,?,?)',[id,row.id,actor.roleId,binding!.id,binding!.epoch,this.clock()+ms,this.clock()]);await this.log('discussion_wait_started',row.id,row.office_id);
 });}
 private async finishWait(id:string){return this.write(async()=>{const room=await this.db.get<Row>('SELECT r.id,r.office_id FROM office_discussion_waits w JOIN office_discussions r ON r.id=w.room_id WHERE w.id=?',[id]);await this.db.run('DELETE FROM office_discussion_waits WHERE id=?',[id]);if(room)await this.log('discussion_wait_finished',room.id,room.office_id);});}
 async attention(a?:TrustedCallContext){return this.write(async()=>{const actor=await this.actor(a);if(actor.human)return {};await this.cleanup();
  // Membership and host grants are rechecked, including after an office move.
  // Focus is a safety condition, so it must precede the bounded invitation list.
  const allowed=new Set((await this.graph.offices.authorizedSeats(a!)).map(s=>s.office_id));
  // Filter invitations before LIMIT. Otherwise inaccessible older invitations
  // can fill the whole window and permanently hide a permitted invitation.
  // Keep focus even outside this grant so it can be reported without content.
  const rows=await this.db.all<Row[]>(`SELECT r.id,r.office_id,r.title,r.revision,r.locked,m.state FROM office_discussion_members m JOIN office_discussions r ON r.id=m.room_id WHERE m.role_id=? AND m.state IN ('joined','invited')
   AND (m.state='joined' OR (r.office_id IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM role_seats rs JOIN office_seats s ON s.id=rs.seat_id WHERE rs.role_id=m.role_id AND s.office_id=r.office_id AND s.enabled=1)))
   ORDER BY (m.state='joined') DESC,r.created_at,r.id LIMIT 66`,[actor.roleId,JSON.stringify([...allowed])]);
  const visible:Row[]=[];let activeUnavailable=false;
  for(const r of rows){
   if(!await this.member(r.office_id,actor.roleId!)){
    await this.db.run("UPDATE office_discussion_members SET state='left' WHERE room_id=? AND role_id=?",[r.id,actor.roleId]);await this.changed(r);
   }else if(!allowed.has(r.office_id)){
    // Credential scope narrows this view; it cannot alter the role's actual
    // membership or release another connection's valid discussion focus.
    if(r.state==='joined')activeUnavailable=true;
   }else visible.push({...r,locked:!!r.locked});
  }
  const invitations=visible.filter(r=>r.state==='invited'),active=visible.find(r=>r.state==='joined');if(active){active.status=await this.observations.status(active.id);active.recentRequests=await this.db.all('SELECT id,state,revision,review_note note FROM office_discussion_requests WHERE room_id=? AND requester=? ORDER BY created_at DESC,id LIMIT 4',[active.id,actor.roleId]);}return {departures:await this.departures.pending(actor.roleId!),active:active??null,activeUnavailable,invitations:invitations.slice(0,64),hasMoreInvitations:invitations.length>64,next:activeUnavailable?'Your role has an active discussion outside this credential’s office access. Use its authorized connection or ask the human to adjust access. This call did not leave the room; ordinary messages remain pending.':DISCUSSION_NOTICE+' Use office_discussion list per office for all invitations; get/join/post/wait/leave for a room. get/wait need no cursor; use the provided finish after handling, or explicit afterSeq for history only. While joined, prioritize this bounded discussion; other inbox messages remain pending. Save reusable conclusions with the separate Memory MCP before closing. Closing/expiry permanently deletes temporary discussion content; it never wakes a stopped host.'};
 });}
 async saveConclusion(i:{id:string;expectedRevision:number;content:string;key:string},a?:TrustedCallContext){
  // Leave embedding outside the connection owner; the save hooks atomically
  // recheck the room and commit its receipt with the independent graph memory.
  if(!(await this.actor(a)).human)fail('scope_denied','Only human management can save a selected conclusion here');
  const hash=digest(i);
  const read=()=>this.write(async()=>{
   await this.cleanup();const {row}=await this.room(i.id,a);
   const prior=await this.db.get<Row>('SELECT * FROM office_discussion_conclusions WHERE room_id=? AND key=?',[i.id,i.key]);
   if(prior){if(prior.hash!==hash)fail('idempotency_conflict','Conclusion key has another payload');if(!await this.graph.getNodeById(prior.memory_id,{trackAccess:false}))fail('not_found','The saved conclusion was deleted');}
   else if(row.revision!==i.expectedRevision)fail('stale_version','讨论已有变化，请核对最新内容后再保存结论');
   return {row,prior};
  });
  const {row,prior}=await read();if(prior)return {memoryId:prior.memory_id,officeId:row.office_id,saved:true};
  const domain=await this.graph.memoryOwners.domain({kind:'office',id:row.office_id});
  const memory=await this.graph.saveMemory(i.content,{domain,idempotencyKey:'discussion:'+i.id+':'+digest(i.key),sourceRefs:[{uri:'mindpond:discussion:'+i.id,revision:String(i.expectedRevision),context:'Human-reviewed independent conclusion. Temporary discussion content is deleted on close; this memory preserves only the selected conclusion.',fingerprint:createHash('sha256').update(i.content).digest('hex')}]},{authorize:async()=>{await read();},saved:async memoryId=>{
   await this.run({action:'export',id:i.id,memoryId},a);
   await this.db.run('INSERT OR IGNORE INTO office_discussion_conclusions VALUES(?,?,?,?)',[i.id,i.key,hash,memoryId]);
  }});
  return {memoryId:memory.id,officeId:row.office_id,saved:true};
 }
 async assertMailbox(a?:TrustedCallContext){const priority=await this.attention(a);if(priority.active||priority.activeUnavailable)throw new MindPondError('invalid_input','Finish or leave your active discussion before taking ordinary mailbox work',{details:priority.active?{discussionId:priority.active.id}:undefined,nextAction:priority.activeUnavailable?priority.next:priority.active?.locked?'Your discussion is human-locked; continue get/post/finish/wait. Ask the human to unlock before leaving to take ordinary work. Inbox messages remain pending.':'Use office_discussion get/post; leave requires summary,key and optional selected messages. Ordinary messages remain pending.'});}
 async run(value:unknown,a?:TrustedCallContext):Promise<Row>{const i=discussionSchema.parse(value);
  if(['departure_get','send_departure','discard_departure'].includes(i.action)){
   if(!i.departureId)fail('invalid_input','This action requires departureId from leave or departures; it does not use discussion id');
   return i.action==='send_departure'?this.departures.send(i.departureId,a,i.officeId):i.action==='discard_departure'?this.departures.discard(i.departureId,a,i.officeId):this.departures.get(i.departureId,a,i.messageIndex,i.officeId);
  }
  const result:Row=await this.write(async()=>{await this.cleanup();const actor=await this.actor(a);
  if(i.action==='departures'){if(actor.human)fail('invalid_input','Pending exit notifications belong to an authenticated role');return this.departures.pending(actor.roleId!,i.officeId);}
  if(!actor.human&&['leave','close'].includes(i.action)){
   // Current human policy wins over an earlier successful exit receipt when a
   // role has rejoined. A retry must never flush mail from inside a locked room.
   if(i.id&&await this.db.get('SELECT 1 FROM office_discussions WHERE id=?',[i.id])){const current=await this.room(i.id,a);if(i.officeId!==undefined&&i.officeId!==current.row.office_id)fail('not_found','Discussion not found in the specified office');if(i.action==='close')this.assertJoinedCloser(current.row,current.state);if(i.action==='close'||current.state==='joined')this.assertUnlocked(current.row);}
   const prior=await this.departures.replay(i,actor.roleId!);if(prior){return {id:prior.room_id,exitRecorded:true,left:!(await this.db.get("SELECT 1 FROM office_discussion_members WHERE room_id=? AND role_id=? AND state='joined'",[prior.room_id,actor.roleId])),closed:!await this.db.get('SELECT 1 FROM office_discussions WHERE id=?',[prior.room_id]),departureId:prior.id};}}

  if(i.action==='create'){
   if(!i.officeId||!i.title||!i.question||!i.doneWhen||!i.participants||!i.key)fail('invalid_input','Create requires officeId,title,question,doneWhen,participants,key');
   await this.office(i.officeId,a,true);if(actor.human)fail('invalid_input','Create a discussion from an approved role; human management can inspect and close discussions');
   const old=await this.db.get<Row>('SELECT * FROM office_discussion_creations WHERE role_id=? AND key=?',[actor.roleId,i.key]);const hash=digest(i);
   if(old){if(old.hash!==hash)fail('idempotency_conflict','Discussion creation key has another payload');const exists=await this.db.get('SELECT 1 FROM office_discussions WHERE id=?',[old.room_id]);return exists?this.view(old.room_id,i,a):{id:old.room_id,closed:true};}
   await this.attention(a);
   const focus=await this.focus(actor.roleId!);if(focus){this.assertUnlocked(focus);fail('invalid_input','Leave your current discussion before opening another');}
   const members=[...new Set([actor.roleId!,...i.participants])];if(members.length<2||members.length>8)fail('invalid_input','Choose 2–8 distinct office roles including yourself');
   for(const role of members)if(!await this.member(i.officeId,role))fail('scope_denied','Every participant must be an active member of this office');
   if((await this.db.get<Row>('SELECT COUNT(*) n FROM office_discussions WHERE office_id=?',[i.officeId]))!.n>=16)fail('invalid_input','At most 16 discussions may be open per office');
   const roomId=randomUUID();await this.db.run('INSERT INTO office_discussions(id,office_id,creator,title,question,done_when,revision,expires_at,created_at) VALUES(?,?,?,?,?,?,1,?,?)',[roomId,i.officeId,actor.roleId,i.title,i.question,i.doneWhen,this.clock()+i.ttlHours*3600000,this.clock()]);
   for(const role of members)await this.db.run('INSERT INTO office_discussion_members VALUES(?,?,?)',[roomId,role,role===actor.roleId?'joined':'invited']);
   await this.db.run('INSERT INTO office_discussion_creations VALUES(?,?,?,?)',[actor.roleId,i.key,hash,roomId]);await this.log('discussion_created',roomId,i.officeId);return this.view(roomId,i,a);
  }
  if(i.action==='list'){
   if(!i.officeId)fail('invalid_input','List requires officeId');await this.office(i.officeId,a);
   const records=await this.db.all<Row[]>(`SELECT r.id,r.title,r.creator,r.revision,r.expires_at,r.locked,r.lock_revision lockRevision,m.state FROM office_discussions r LEFT JOIN office_discussion_members m ON m.room_id=r.id AND m.role_id=? WHERE r.office_id=? AND r.id>? ${actor.human?'':"AND m.state IS NOT NULL"} ORDER BY r.id LIMIT ?`,[actor.roleId,i.officeId,i.afterId??'',i.limit+1]);const rooms:Row[]=[];
   for(const record of records.slice(0,i.limit)){const item={...record,locked:!!record.locked,status:await this.observations.status(record.id)};if(Buffer.byteLength(JSON.stringify(rooms))+Buffer.byteLength(JSON.stringify(item))+256>i.contextBudgetBytes)break;rooms.push(item);}return {rooms,hasMore:records.length>rooms.length,nextAfterId:rooms.at(-1)?.id??i.afterId??''};
  }
  if(i.action==='get'&&!i.id)i.id=await this.currentId(a);
  if(!i.id)fail('invalid_input','Discussion id is required');const {row,state}=await this.room(i.id,a,!['get','finish','leave','decline','close','request_get','cancel_request','review_participants'].includes(i.action));
  if(i.officeId!==undefined&&i.officeId!==row.office_id)fail('not_found','Discussion not found in the specified office');
  if(i.action==='get')return this.view(i.id,i,a);
  if(['request_participants','review_participants','cancel_request','request_get'].includes(i.action))return this.participantRequest(i,row,actor,state,a);
  if(i.action==='join'){
   if(actor.human)fail('invalid_input','A human cannot impersonate a participant');if(!['invited','joined','left','declined'].includes(state))fail('invalid_input','This role is not invited');await this.attention(a);const active=await this.focus(actor.roleId!);if(active&&active.id!==i.id){this.assertUnlocked(active);fail('invalid_input','Leave your current discussion before joining another');}if(state!=='joined'){this.assertUnlocked(row);await this.db.run("UPDATE office_discussion_members SET state='joined' WHERE room_id=? AND role_id=?",[i.id,actor.roleId]);await this.changed(row);}return this.view(i.id,i,a);
  }
  if(i.action==='decline'||i.action==='leave'){
   if(actor.human)fail('invalid_input','Use close to end a discussion as human manager');if(i.action==='decline'&&state!=='invited'&&state!=='declined')fail('invalid_input','Decline applies to an invitation; joined participants use leave');
   if(i.action==='decline'&&state==='declined')return {id:i.id,left:true,closed:false};
   let departureId:string|undefined;
   if(i.action==='leave'){
    if(state!=='joined')fail('invalid_input','Only a joined participant may leave; use decline for an invitation or departures to recover an earlier exit');
    departureId=await this.departures.prepare(i,actor.roleId!,row.office_id);
    await this.exitSummary(i.id,actor.roleId!,i.summary!,departureId);
   }
   await this.db.run('UPDATE office_discussion_members SET state=? WHERE room_id=? AND role_id=?',[i.action==='decline'?'declined':'left',i.id,actor.roleId]);await this.changed(row);
   // Rejecting an invitation is an outside action, never permission to delete a room.
   // Only the final joined participant's exit may automatically close an empty room.
   const remaining=await this.db.get<Row>("SELECT COUNT(*) n FROM office_discussion_members WHERE room_id=? AND state IN ('joined','invited')",[i.id]);const closed=i.action==='leave'&&!remaining!.n;if(closed)await this.purge(i.id);return {id:i.id,left:true,closed,...(departureId?{departureId}: {})};
  }
  if(i.action==='close'){
   if(!actor.human)this.assertJoinedCloser(row,state);if(i.expectedRevision!==row.revision)fail('stale_version','Discussion changed; read the latest posts and exports before closing');
   let departureId:string|undefined;
   if(!actor.human){departureId=await this.departures.prepare(i,actor.roleId!,row.office_id);await this.exitSummary(i.id,actor.roleId!,i.summary!,departureId);await this.db.run("UPDATE office_discussion_members SET state='left' WHERE room_id=? AND role_id=?",[i.id,actor.roleId]);}
   await this.purge(i.id);return {id:i.id,closed:true,contentDeleted:true,...(departureId?{departureId,left:true}: {})};
  }
  if(!actor.human&&state!=='joined')fail('scope_denied','Join the discussion before reading or contributing content');
  if(i.action==='finish'){
   if(actor.human)fail('scope_denied','Only a joined role can acknowledge its own discussion work; human inspection cannot mark a participant finished');
   if(!i.postSeqs)fail('invalid_input','finish requires id and postSeqs: the exact sequence numbers of retrieved posts you have handled');
   await this.observations.finish(i.id,actor.roleId!,i.postSeqs);await this.log('discussion_handled',row.id,row.office_id);
   const members=await this.observations.members(i.id);return {id:i.id,postSeqs:[...new Set(i.postSeqs)],member:members.find(m=>m.roleId===actor.roleId),notice:'Only these posts are confirmed handled by your role. This does not finish other participants’ work or ordinary office messages.'};
  }
  if(i.action==='post'){
   if(actor.human)fail('invalid_input','Discussion posts must retain an authenticated role author');if(!i.body||!i.key)fail('invalid_input','Post requires body and stable key');if(i.key.toLowerCase().startsWith('exit-summary:'))fail('invalid_input','Post keys beginning exit-summary: are reserved for exit records created by leave/close; choose another stable key.');if(Buffer.byteLength(i.body)>8000)fail('material_over_budget','Split posts into messages of at most 8000 UTF-8 bytes');
   const old=await this.db.get<Row>('SELECT seq,body FROM office_discussion_posts WHERE room_id=? AND author=? AND key=?',[i.id,actor.roleId,i.key]);if(old){if(old.body!==i.body)fail('idempotency_conflict','Post key has another body');return {id:i.id,seq:old.seq};}
   const size=await this.db.get<Row>('SELECT COUNT(*) n,COALESCE(SUM(length(CAST(body AS BLOB))),0) bytes FROM office_discussion_posts WHERE room_id=? AND key NOT LIKE \'exit-summary:%\'',[i.id]);if(size!.n>=256||size!.bytes+Buffer.byteLength(i.body)>524288)fail('material_over_budget','Discussion limit reached; summarize, save useful memory and close the room');
   await this.observations.delivered(i.id,actor.roleId!);
   const result=await this.db.run('INSERT INTO office_discussion_posts(room_id,author,key,body,created_at) VALUES(?,?,?,?,?)',[i.id,actor.roleId,i.key,i.body,this.clock()]);await this.changed(row);return {id:i.id,seq:result.lastID,revision:row.revision+1};
  }
  if(i.action==='export'){
   if(!i.memoryId)fail('invalid_input','Save knowledge with the separate Memory MCP first, then supply memoryId');
   const context=actor.human?undefined:await memoryAccess(this.graph,{kind:'agent',id:actor.roleId!},a).context();const memory=await this.graph.getNodeById(i.memoryId,{trackAccess:false,context});if(!memory)fail('not_found','Exported memory does not exist');
   if((await this.db.get<Row>('SELECT COUNT(*) n FROM office_discussion_exports WHERE room_id=?',[i.id]))!.n>=16&&!await this.db.get('SELECT 1 FROM office_discussion_exports WHERE room_id=? AND memory_id=?',[i.id,i.memoryId]))fail('invalid_input','Keep at most 16 selected memory exports per discussion');
   const fingerprint=createHash('sha256').update(memory.content).digest('hex');const saved=await this.db.run('INSERT INTO office_discussion_exports VALUES(?,?,?) ON CONFLICT(room_id,memory_id) DO UPDATE SET fingerprint=excluded.fingerprint WHERE fingerprint<>excluded.fingerprint',[i.id,i.memoryId,fingerprint]);if(saved.changes)await this.changed(row);return {memoryId:i.memoryId,fingerprint,notice:'Independent memory survives discussion deletion. This action neither copies a transcript nor grants other roles access.'};
  }
  fail('invalid_input','Unsupported discussion action');
 });
  if(result.departureId)return {...result,notifications:await this.departures.send(result.departureId,a),notice:(result.exitRecorded?'This replays an earlier exit, without changing new attendance; role_sync checks current focus. ':'')+'The summary was submitted before exit. Notifications send after exit; pending drafts retain corrective reasons for send_departure. Sending a note does not archive original work: after exit use office_message finish for blocked processing mail. Queued is not read or completed. Close/expiry deletes temporary discussion content.'};
  return result;
 }
 private async exitSummary(roomId:string,roleId:string,summary:string,departureId:string){
  // A departure must remain possible even if the ordinary post quota is full.
  // Bound these special summaries separately (at most 128 per room).
  const count=await this.db.get<Row>("SELECT COUNT(*) n FROM office_discussion_posts WHERE room_id=? AND key LIKE 'exit-summary:%'",[roomId]);
  if(count!.n>=128)fail('material_over_budget','This room has reached its exit-summary capacity. Ask the human to close it after preserving useful conclusions.');
  await this.db.run('INSERT INTO office_discussion_posts(room_id,author,key,body,created_at) VALUES(?,?,?,?,?)',[roomId,roleId,'exit-summary:'+departureId,'## Exit summary\n\n'+summary,this.clock()]);
 }

 private async changed(row:Row){await this.db.run('UPDATE office_discussions SET revision=revision+1 WHERE id=?',[row.id]);await this.log('discussion_updated',row.id,row.office_id);this.waiter.notify();}
 private async view(roomId:string,i:z.infer<typeof discussionSchema>,a?:TrustedCallContext,observe=true):Promise<Row>{
  const {row,actor,state}=await this.room(roomId,a),members=await this.observations.members(roomId);
  row.locked=!!row.locked;row.lockRevision=row.lock_revision;
  if(!actor.human&&state!=='joined')return {room:row,members,posts:[],invitation:state,notice:row.locked?'This discussion is locked by the human. Ask the human to unlock it before joining.':'Join to read discussion posts. Leaving removes access to discussion posts.'};
  const history=i.afterSeq!==undefined||actor.human;
  const rows=await this.posts(roomId,actor.human?undefined:actor.roleId!,i.afterSeq,i.limit+1,'unprocessed');
  if(!actor.human){
   const handled=await this.observations.handled(roomId,actor.roleId!);
   for(const post of rows)post.processingState=post.author===actor.roleId?'own':handled.has(post.seq)?'handled':'unprocessed';
  }
  const exports=await this.db.all('SELECT memory_id memoryId,fingerprint FROM office_discussion_exports WHERE room_id=?',[roomId]);
  const lastSeq=(await this.db.get<Row>('SELECT COALESCE(MAX(seq),0) n FROM office_discussion_posts WHERE room_id=?',[roomId]))!.n;
  const participantRequests=await this.requests(roomId),status=await this.observations.status(roomId,members);
  const base={room:row,members,exports,lastSeq,status,participantRequests,selection:history?'history':'unprocessed',notice:DISCUSSION_NOTICE,posts:[] as Row[],nextAfterSeq:i.afterSeq??0,hasMore:false};
  const commands=(posts:Row[],cursor:number)=>({...this.finishCommand(roomId,posts),nextGet:{action:'get',id:roomId,...(history?{afterSeq:cursor}:{}),limit:i.limit,contextBudgetBytes:i.contextBudgetBytes}});
  for(const post of rows.slice(0,i.limit)){
   const candidate=[...base.posts,post];
   // Reserve space for both updated observation metadata and usable follow-ups.
   if(Buffer.byteLength(JSON.stringify({...base,posts:candidate,...commands(candidate,post.seq)}))+128>i.contextBudgetBytes){
    if(!base.posts.length)fail('material_over_budget','Raise contextBudgetBytes to read the next complete post');
    break;
   }
   base.posts.push(post);base.nextAfterSeq=post.seq;
  }
  base.hasMore=rows.length>base.posts.length;
  const result={...base,...commands(base.posts,base.nextAfterSeq)};
  if(Buffer.byteLength(JSON.stringify(result))>i.contextBudgetBytes)fail('material_over_budget','Raise contextBudgetBytes to read the full discussion metadata');
  if(observe&&!actor.human){
   const advanced=await this.observations.delivered(roomId,actor.roleId!,i.afterSeq??0,result.nextAfterSeq,result.posts.map(p=>p.seq));
   if(advanced)await this.log('discussion_fetched',roomId,row.office_id);
   result.members=await this.observations.members(roomId);result.status=await this.observations.status(roomId,result.members);
   if(Buffer.byteLength(JSON.stringify(result))>i.contextBudgetBytes)fail('material_over_budget','Raise contextBudgetBytes to include the updated complete discussion metadata');
  }
  return result;
 }
}
