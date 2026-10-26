/** Ephemeral delivery evidence and explicit per-role handling receipts.
 * Neither proves that a model is running or understood a post. Human inspection never advances a participant's cursor. */
import type {Database} from 'sqlite';
import {MindPondError} from './errors.js';
type Row=Record<string,any>;
export class DiscussionObservations{
 constructor(private db:Database,private clock:()=>number){}
 async init(){await this.db.exec(`
  CREATE TABLE IF NOT EXISTS office_discussion_observations(room_id TEXT NOT NULL REFERENCES office_discussions(id) ON DELETE CASCADE,role_id TEXT NOT NULL REFERENCES character_roles(id) ON DELETE CASCADE,read_seq INTEGER NOT NULL DEFAULT 0,last_seen INTEGER NOT NULL,provided_seqs TEXT NOT NULL DEFAULT '[]',PRIMARY KEY(room_id,role_id));
  CREATE TABLE IF NOT EXISTS office_discussion_handled(room_id TEXT NOT NULL REFERENCES office_discussions(id) ON DELETE CASCADE,role_id TEXT NOT NULL REFERENCES character_roles(id) ON DELETE CASCADE,post_seq INTEGER NOT NULL REFERENCES office_discussion_posts(seq) ON DELETE CASCADE,handled_at INTEGER NOT NULL,PRIMARY KEY(room_id,role_id,post_seq));
  CREATE INDEX IF NOT EXISTS discussion_handled_post ON office_discussion_handled(post_seq);
  CREATE TABLE IF NOT EXISTS office_discussion_waits(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES office_discussions(id) ON DELETE CASCADE,role_id TEXT NOT NULL REFERENCES character_roles(id) ON DELETE CASCADE,binding_id TEXT NOT NULL,binding_epoch INTEGER NOT NULL,expires_at INTEGER NOT NULL,observed_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS discussion_wait_room ON office_discussion_waits(room_id,role_id);
 `);}
 async delivered(roomId:string,roleId:string,afterSeq?:number,nextSeq?:number,provided:number[]=[]){
  const old=await this.db.get<Row>('SELECT read_seq,provided_seqs FROM office_discussion_observations WHERE room_id=? AND role_id=?',[roomId,roleId]);
  // A caller jumping past unseen posts is not evidence those posts were fetched.
  const readSeq=afterSeq!==undefined&&afterSeq<=(old?.read_seq??0)?Math.max(old?.read_seq??0,nextSeq??afterSeq):old?.read_seq??0;
  const sequences=[...new Set<number>([...JSON.parse(old?.provided_seqs??'[]'),...provided])].sort((a,b)=>a-b);
  await this.db.run('INSERT INTO office_discussion_observations VALUES(?,?,?,?,?) ON CONFLICT(room_id,role_id) DO UPDATE SET read_seq=excluded.read_seq,last_seen=excluded.last_seen,provided_seqs=excluded.provided_seqs',[roomId,roleId,readSeq,this.clock(),JSON.stringify(sequences)]);
  return !old||readSeq>old.read_seq||sequences.length>JSON.parse(old.provided_seqs).length;
 }
 async finish(roomId:string,roleId:string,seqs:number[]){
  const unique=[...new Set(seqs)];
  // Validate the whole batch before acknowledging any post. Cursor gaps never count as delivery.
  const valid=await this.db.get<Row>(`SELECT COUNT(*) n FROM office_discussion_posts p JOIN office_discussion_observations o ON o.room_id=p.room_id AND o.role_id=? WHERE p.room_id=? AND p.author<>? AND p.seq IN (SELECT value FROM json_each(?)) AND p.seq IN (SELECT value FROM json_each(o.provided_seqs))`,[roleId,roomId,roleId,JSON.stringify(unique)]);
  if(valid!.n!==unique.length)throw new MindPondError('invalid_input','Every postSeq must name another participant’s post in this room already returned to your role. Read get/wait first; cursor gaps, your own posts and posts from other rooms cannot be marked handled.',{nextAction:'Use office_discussion action=get (no cursor needed in your active room), then submit its finish command only for returned posts you have actually handled. Explicit afterSeq is for historical reads.'});
  for(const seq of unique)await this.db.run('INSERT OR IGNORE INTO office_discussion_handled VALUES(?,?,?,?)',[roomId,roleId,seq,this.clock()]);
  await this.db.run('UPDATE office_discussion_observations SET last_seen=? WHERE room_id=? AND role_id=?',[this.clock(),roomId,roleId]);
 }
 async handled(roomId:string,roleId:string){return new Set((await this.db.all<Row[]>('SELECT post_seq FROM office_discussion_handled WHERE room_id=? AND role_id=?',[roomId,roleId])).map(r=>r.post_seq as number));}
 async waiting(roomId:string,roleId:string){await this.db.run('UPDATE office_discussion_waits SET observed_at=? WHERE room_id=? AND role_id=? AND expires_at>?',[this.clock(),roomId,roleId,this.clock()]);}
 async members(roomId:string):Promise<Row[]>{const people=await this.db.all<Row[]>(`SELECT m.role_id roleId,r.name,m.state,
  o.read_seq fetchedThroughSeq,o.last_seen lastContactAt,
  (SELECT COUNT(*) FROM office_discussion_posts p WHERE p.room_id=m.room_id AND p.author<>m.role_id AND p.seq NOT IN (SELECT value FROM json_each(COALESCE(o.provided_seqs,'[]')))) pendingPosts,
  (SELECT COUNT(*) FROM office_discussion_posts p WHERE p.room_id=m.room_id AND p.author<>m.role_id AND NOT EXISTS(SELECT 1 FROM office_discussion_handled h WHERE h.room_id=p.room_id AND h.role_id=m.role_id AND h.post_seq=p.seq)) unprocessedPosts,
  (SELECT MAX(w.expires_at) FROM office_discussion_waits w JOIN role_bindings b ON b.id=w.binding_id AND b.role_id=w.role_id AND b.epoch=w.binding_epoch AND b.state='active' JOIN office_agents a ON a.id=b.connector_id AND a.state='active' WHERE w.room_id=m.room_id AND w.role_id=m.role_id AND w.expires_at>? AND w.observed_at>?) waitingUntil,
  EXISTS(SELECT 1 FROM role_bindings b JOIN office_agents a ON a.id=b.connector_id WHERE b.role_id=m.role_id AND b.state='active' AND a.state='active') hasBinding
  FROM office_discussion_members m JOIN character_roles r ON r.id=m.role_id LEFT JOIN office_discussion_observations o ON o.room_id=m.room_id AND o.role_id=m.role_id WHERE m.room_id=? ORDER BY r.name,m.role_id`,[this.clock(),this.clock()-3000,roomId]);return people.map(m=>({...m,unreadPosts:m.pendingPosts,processingPosts:m.unprocessedPosts-m.pendingPosts,hasBinding:Boolean(m.hasBinding),isWaiting:Boolean(m.waitingUntil&&m.waitingUntil>this.clock())}));}
 async status(roomId:string,members?:Row[]){
  const people=members??await this.members(roomId),joined=people.filter(m=>m.state==='joined'),invited=people.filter(m=>m.state==='invited');
  const posts=await this.db.get<Row>('SELECT COUNT(*) count,MAX(created_at) lastPostAt FROM office_discussion_posts WHERE room_id=?',[roomId]);
  const pendingRequests=(await this.db.get<Row>("SELECT COUNT(*) n FROM office_discussion_requests WHERE room_id=? AND state='pending'",[roomId]))!.n;
  const waiting=joined.filter(m=>m.waitingUntil>this.clock()).length,pending=joined.reduce((n,m)=>n+m.pendingPosts,0),unprocessed=joined.reduce((n,m)=>n+m.unprocessedPosts,0);
  return {phase:pendingRequests?'needs_approval':invited.length?'waiting_join':pending?'pending_posts':unprocessed?'processing_posts':waiting?'waiting_posts':'no_wait_observed',joined:joined.length,invited:invited.length,pendingRequests,pendingPosts:pending,unreadPosts:pending,unprocessedPosts:unprocessed,processingPosts:unprocessed-pending,waiting,postCount:posts!.count,lastPostAt:posts!.lastPostAt??null,lastContactAt:people.reduce((at,m)=>Math.max(at,m.lastContactAt??0),0)||null,
   evidence:'Fetched means included in a service response, not read/understood/completed by the model or proof of transport delivery. Unprocessed includes unread posts and posts not explicitly acknowledged with finish; posting or leaving is not acknowledgement. Waiting was observed by the server in the last 3 seconds;  binding is not proof the harness is running.'};
 }
}
