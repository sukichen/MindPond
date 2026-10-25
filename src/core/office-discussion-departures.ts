/** Explicitly selected post-meeting correspondence. Unlike the temporary
 * transcript, these drafts follow the author role until sent or discarded. */
import {randomUUID} from 'node:crypto';
import type {Database} from 'sqlite';
import type {GraphMemory} from './graph-memory.js';
import type {TrustedCallContext} from './trust.js';
import {digest} from './growth.js';
import {MindPondError,toStructuredError} from './errors.js';
import {previewText} from './office-context.js';
type Row=Record<string,any>;
export type DepartureInput={action:string;id?:string;officeId?:string;summary?:string;key?:string;expectedRevision?:number;messages?:{recipient:string;body:string;replyTo?:string;officeId?:string|null}[]};
export class DiscussionDepartures{
 constructor(private db:Database,private graph:GraphMemory,private write:<T>(fn:()=>Promise<T>)=>Promise<T>,private clock:()=>number){}
 async init(){await this.db.exec(`CREATE TABLE IF NOT EXISTS office_discussion_departures(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,office_id TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,role_id TEXT NOT NULL REFERENCES character_roles(id) ON DELETE CASCADE,key TEXT NOT NULL,hash TEXT NOT NULL,messages TEXT NOT NULL,pending_count INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(role_id,room_id,key)); CREATE INDEX IF NOT EXISTS discussion_departure_role ON office_discussion_departures(role_id,pending_count,created_at,id);`);}
 private hash(i:DepartureInput){return digest({action:i.action,id:i.id,summary:i.summary,key:i.key,expectedRevision:i.expectedRevision,messages:i.messages??[]});}
 async replay(i:DepartureInput,roleId:string){
  if(!i.id||!i.key)return;
  const row=await this.db.get<Row>('SELECT * FROM office_discussion_departures WHERE role_id=? AND room_id=? AND key=?',[roleId,i.id,i.key]);
  if(row)this.scope(row,i.officeId);
  if(row&&row.hash!==this.hash(i))throw new MindPondError('idempotency_conflict','Departure key has different summary, messages or revision. Retry the original exit payload.');
  return row;
 }
 async prepare(i:DepartureInput,roleId:string,officeId:string){
  if(!i.summary||!i.key)throw new MindPondError('invalid_input','Before leaving, supply summary and a stable key; optionally messages=[{recipient,body,replyTo?}].',{nextAction:'Summarize decisions, unresolved issues and next steps. Save reusable knowledge through Memory MCP. Call leave with summary,key and optional selected messages; those messages are sent only after leaving.'});
  const messages=i.messages??[];
  if(Buffer.byteLength(i.summary)>8000||Buffer.byteLength(JSON.stringify(messages))>24000)throw new MindPondError('material_over_budget','Keep summary within 8000 UTF-8 bytes and selected exit messages within 24000 bytes total.');
  const pending=await this.pending(roleId);
  if(messages.length&&pending.total>=20)throw new MindPondError('material_over_budget','This role has 20 pending departure batches. Send or discard obsolete drafts before adding more.');
  const departureId=randomUUID();
  await this.db.run('INSERT INTO office_discussion_departures VALUES(?,?,?,?,?,?,?,?,?)',[departureId,i.id,officeId,roleId,i.key,this.hash(i),JSON.stringify(messages.map(payload=>({payload}))),messages.length,this.clock()]);
  return departureId;
 }
 private scope(row:Row,officeId?:string){if(officeId!==undefined&&officeId!==row.office_id)throw new MindPondError('not_found','Departure not found in the specified source office. Check its departureId and officeId; no draft was changed or sent.');}
 private async own(id:string,a?:TrustedCallContext,officeId?:string){const binding=await this.graph.roles.binding(a);if(!binding)throw new MindPondError('invalid_input','Exit notifications require the authenticated author role; human management cannot impersonate it.');const row=await this.db.get<Row>('SELECT * FROM office_discussion_departures WHERE id=? AND role_id=?',[id,binding!.role_id]);if(!row)throw new MindPondError('not_found','Departure not found among this role’s saved exit notifications.');this.scope(row,officeId);return row;}
 async pending(roleId:string,officeId?:string){
  const rows=await this.db.all<Row[]>(`SELECT id,room_id discussionId,office_id officeId,created_at createdAt,pending_count pending FROM office_discussion_departures WHERE role_id=? AND pending_count>0 AND (? IS NULL OR office_id=?) ORDER BY created_at,id LIMIT 21`,[roleId,officeId??null,officeId??null]);
  return {batches:rows.slice(0,20),total:rows.length,nextAction:'After leaving the active discussion, call send_departure with departureId to retry selected notifications; departure_get inspects them, discard_departure permanently cancels unsent drafts. Delivery means queued, not read or handled.'};
 }
 async get(id:string,a?:TrustedCallContext,messageIndex?:number,officeId?:string){return this.write(async()=>{
  const row=await this.own(id,a,officeId),messages:Row[]=JSON.parse(row.messages);
  if(messageIndex!==undefined){const message=messages[messageIndex];if(!message)throw new MindPondError('invalid_input','messageIndex must identify a message in this departure.');return {departureId:id,index:messageIndex,...message,...(message.result?{nextAction:'The draft body was removed after enqueue. office_message get with result.messageId reads the delivered content.'}:message.discarded?{nextAction:'This unsent draft was discarded; its body was removed.'}:{})};}
  return {departureId:id,discussionId:row.room_id,officeId:row.office_id,createdAt:row.created_at,messages:messages.map((m,index)=>({index,recipient:m.payload.recipient,body:previewText(m.payload.body??'',240),bodyTruncated:Buffer.byteLength(m.payload.body??'')>240,replyTo:m.payload.replyTo??null,state:m.result?'sent':m.discarded?'discarded':'pending',result:m.result??null,error:m.error??null})),pending:messages.filter(m=>!m.result&&!m.discarded).length,nextAction:'Use departure_get with messageIndex for a complete selected message. send_departure retries pending drafts under current permissions, never resends successful ones. Drafts are immutable: correct invalid recipients/content with a new office_message key, then discard_departure cancels unsent drafts.'};
 });}
 async discard(id:string,a?:TrustedCallContext,officeId?:string){await this.write(async()=>{const row=await this.own(id,a,officeId),messages:Row[]=JSON.parse(row.messages);for(const m of messages)if(!m.result){m.discarded=true;delete m.error;delete m.payload.body;}await this.db.run('UPDATE office_discussion_departures SET messages=?,pending_count=0 WHERE id=?',[JSON.stringify(messages),id]);});return this.get(id,a,undefined,officeId);}
 async send(id:string,a?:TrustedCallContext,officeId?:string){
  // Each enqueue and draft receipt share a transaction. Concurrent flushes,
  // reconnects and response loss therefore cannot duplicate successful mail.
  const count=await this.write(async()=>JSON.parse((await this.own(id,a,officeId)).messages).length);
  for(let index=0;index<count;index++){
   try{await this.write(async()=>{
    const row=await this.own(id,a,officeId),messages:Row[]=JSON.parse(row.messages),message=messages[index];if(message.result||message.discarded)return;
    message.result=await this.graph.building.message({action:'send',officeId:row.office_id,...message.payload,key:'discussion-exit:'+id+':'+index},a);delete message.error;delete message.payload.body;
    await this.db.run('UPDATE office_discussion_departures SET messages=?,pending_count=? WHERE id=?',[JSON.stringify(messages),messages.filter(m=>!m.result&&!m.discarded).length,id]);
   });}catch(error){await this.write(async()=>{const row=await this.own(id,a,officeId),messages:Row[]=JSON.parse(row.messages),message=messages[index];if(!message.result&&!message.discarded){message.error=toStructuredError(error);await this.db.run('UPDATE office_discussion_departures SET messages=? WHERE id=?',[JSON.stringify(messages),id]);}});}
  }
  return this.get(id,a,undefined,officeId);
 }
}
