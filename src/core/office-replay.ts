/** Read-only, bounded office history projection for the browser replay player. */
import type { Database } from 'sqlite';
import { MindPondError } from './errors.js';
type Row=Record<string,any>;
const invalid=(message:string):never=>{throw new MindPondError('invalid_input',message);};
export async function officeReplay(db:Database,i:Row){
  let scope=i.threadId?`office_id=? AND json_extract(body,'$.messageId') IN (WITH RECURSIVE thread(id) AS (SELECT id FROM role_messages WHERE id=? AND office_id=? UNION SELECT r.id FROM role_messages r JOIN thread t ON COALESCE(r.reply_to,r.request_id)=t.id WHERE r.office_id=?) SELECT id FROM thread)`:'office_id=?';
  const scopeArgs:any[]=i.threadId?[i.officeId,i.threadId,i.officeId,i.officeId]:[i.officeId];
  if(i.roleId){scope+=" AND (json_extract(actor,'$.roleId')=? OR json_extract(body,'$.sender')=? OR json_extract(body,'$.recipient')=? OR seat_id IN (SELECT seat_id FROM role_seats WHERE role_id=?))";scopeArgs.push(i.roleId,i.roleId,i.roleId,i.roleId);}
  if(i.topic){scope+=" AND (json_extract(body,'$.topic')=? OR json_extract(body,'$.messageId') IN (SELECT id FROM role_messages WHERE office_id=? AND json_extract(metadata,'$.topic')=?))";scopeArgs.push(i.topic,i.officeId,i.topic);}
  if(i.keyOnly)scope+=" AND (kind IN ('marker','handoff','material_published','item_verify','message_finish','layout_saved') OR kind LIKE 'experience_%')";
  const stats=await db.get<Row>(`SELECT MIN(seq) firstSeq,MAX(seq) lastSeq,COUNT(*) totalEvents FROM office_events WHERE ${scope}`,scopeArgs);
  const from=i.fromSeq??stats!.firstSeq??1,to=Math.min(i.toSeq??stats!.lastSeq??0,stats!.lastSeq??0);
  if(i.fromSeq!==undefined&&i.toSeq!==undefined&&i.fromSeq>i.toSeq)invalid('起始事件不能晚于结束事件');
  // Event sequence is the capture boundary even when multiple events share a millisecond.
  // Include the last frame before the selection plus captures inside it.
  const layouts=await db.all<Row[]>(`SELECT r.id,r.payload,r.created_at,e.seq FROM office_collaboration_records r
    JOIN office_events e ON e.office_id=r.office_id AND e.kind='layout_saved' AND json_extract(e.body,'$.recordId')=r.id
    WHERE r.office_id=? AND r.kind='layout' AND e.seq<=? AND (e.seq>=? OR e.seq=(SELECT MAX(p.seq) FROM office_events p WHERE p.office_id=? AND p.kind='layout_saved' AND p.seq<?))
    ORDER BY e.seq LIMIT 251`,[i.officeId,to,from,i.officeId,from]);
  const seats=await db.all<Row[]>('SELECT s.id,s.label,s.enabled,rs.role_id roleId,r.name FROM office_seats s LEFT JOIN role_seats rs ON rs.seat_id=s.id LEFT JOIN character_roles r ON r.id=rs.role_id WHERE s.office_id=? ORDER BY s.id',[i.officeId]);
  const seatMap=new Map(seats.map(s=>[s.id,s]));
  const roleRows=await db.all<Row[]>('SELECT DISTINCT r.id,r.name FROM character_roles r JOIN role_seats rs ON rs.role_id=r.id JOIN office_seats s ON s.id=rs.seat_id WHERE s.office_id=?',[i.officeId]);
  const names=new Map(roleRows.map(r=>[r.id,r.name]));
  const identify=(id?:string|null)=>(!id||id==='user')?'system':seatMap.has(id)?(seatMap.get(id)!.roleId?'role:'+seatMap.get(id)!.roleId:'seat:'+id):'role:'+id;
  const project=(e:Row)=>{const actor=JSON.parse(e.actor),body=JSON.parse(e.body),raw=JSON.stringify(body);const large=raw.length>2400;
    const summary=large?Object.fromEntries(['messageId','requestId','recipient','sender','senderName','recipientName','itemId','materialId','action','why','verdict','title','summary','body','containerId','state','result'].filter(k=>body[k]!==undefined).map(k=>[k,typeof body[k]==='string'?body[k].slice(0,k==='body'?1200:300):['string','number','boolean'].includes(typeof body[k])?body[k]:undefined])):body;
    return {seq:e.seq,ts:e.ts,kind:e.kind,seat_id:e.seat_id,actor,body:summary,detailAvailable:large,layoutId:layouts.filter(l=>l.seq<=e.seq).at(-1)?.id??null,actorKey:identify(actor.roleId??e.seat_id??body.sender),recipientKey:body.recipient?identify(body.recipient):null};};
  if(i.action==='index'){
    const selected=await db.get<Row>(`SELECT COUNT(*) n FROM office_events WHERE ${scope} AND seq>=? AND seq<=?`,[...scopeArgs,from,to]);
    // Cap only the directory; pages remain cursor-based. The UI asks for a smaller range if too large.
    const historical=await db.all<Row[]>(`SELECT DISTINCT seat_id,roleId,sender,recipient,senderName,recipientName FROM (
      SELECT seat_id,json_extract(actor,'$.roleId') roleId,json_extract(body,'$.sender') sender,json_extract(body,'$.recipient') recipient,json_extract(body,'$.senderName') senderName,json_extract(body,'$.recipientName') recipientName FROM office_events WHERE ${scope} AND seq>=? AND seq<=?) LIMIT 1001`,[...scopeArgs,from,to]);
    const participants=new Map<string,Row>();
    const add=(id?:string|null,name?:string|null)=>{const key=identify(id);if(key==='system')return;const seat=seatMap.get(id!);const roleId=key.startsWith('role:')?key.slice(5):null;const current=roleId?names.get(roleId):seat?.label;const old=participants.get(key);participants.set(key,{key,roleId,seatId:seat?.id??old?.seatId??null,name:current??name??old?.name??(roleId?'历史角色 · ':'历史工位 · ')+(id??'').slice(0,8),historical:!current});};
    for(const e of historical){add(e.roleId??e.seat_id??e.sender,e.senderName);add(e.recipient,e.recipientName);}
    return {officeId:i.officeId,...stats,fromSeq:from,toSeq:to,count:selected!.n,participants:[...participants.values()],participantsLimited:historical.length>1000,threadId:i.threadId??null,layouts:layouts.slice(0,250).map(l=>({id:l.id,at:l.created_at,fromSeq:l.seq,...JSON.parse(l.payload)})),layoutsLimited:layouts.length>250,roleId:i.roleId??null,topic:i.topic??null,keyOnly:Boolean(i.keyOnly),layoutSource:layouts.length?'recorded_snapshots_with_explicit_current_fallback':'current_seats_with_historical_participants'};
  }
  const after=Math.max(from-1,i.afterSeq??from-1),limit=i.limit??100;
  const rows=await db.all<Row[]>(`SELECT seq,seat_id,actor,kind,body,ts FROM office_events WHERE ${scope} AND seq>? AND seq<=? ORDER BY seq LIMIT ?`,[...scopeArgs,after,to,limit+1]);
  const events:Row[]=[];let bytes=0;
  for(const row of rows.slice(0,limit)){const event=project(row),size=Buffer.byteLength(JSON.stringify(event));if(events.length&&bytes+size>64000)break;events.push(event);bytes+=size;}
  return {officeId:i.officeId,fromSeq:from,toSeq:to,events,nextCursor:events.at(-1)?.seq??after,hasMore:rows.length>events.length};
}
