/** Read-only, bounded office history projection for the browser replay player. */
import type { Database } from 'sqlite';
import { MindPondError } from './errors.js';
type Row=Record<string,any>;
const invalid=(message:string):never=>{throw new MindPondError('invalid_input',message);};
export async function officeReplay(db:Database,i:Row){
  const stats=await db.get<Row>('SELECT MIN(seq) firstSeq,MAX(seq) lastSeq,COUNT(*) totalEvents FROM office_events WHERE office_id=?',[i.officeId]);
  const from=i.fromSeq??stats!.firstSeq??1,to=Math.min(i.toSeq??stats!.lastSeq??0,stats!.lastSeq??0);
  if(i.fromSeq!==undefined&&i.toSeq!==undefined&&i.fromSeq>i.toSeq)invalid('起始事件不能晚于结束事件');
  const seats=await db.all<Row[]>('SELECT s.id,s.label,s.enabled,rs.role_id roleId,r.name FROM office_seats s LEFT JOIN role_seats rs ON rs.seat_id=s.id LEFT JOIN character_roles r ON r.id=rs.role_id WHERE s.office_id=? ORDER BY s.id',[i.officeId]);
  const seatMap=new Map(seats.map(s=>[s.id,s]));
  const roleRows=await db.all<Row[]>('SELECT DISTINCT r.id,r.name FROM character_roles r JOIN role_seats rs ON rs.role_id=r.id JOIN office_seats s ON s.id=rs.seat_id WHERE s.office_id=?',[i.officeId]);
  const names=new Map(roleRows.map(r=>[r.id,r.name]));
  const identify=(id?:string|null)=>!id?'system':seatMap.has(id)?(seatMap.get(id)!.roleId?'role:'+seatMap.get(id)!.roleId:'seat:'+id):'role:'+id;
  const project=(e:Row)=>{const actor=JSON.parse(e.actor),body=JSON.parse(e.body),raw=JSON.stringify(body);const large=raw.length>2400;
    const summary=large?Object.fromEntries(['messageId','requestId','recipient','sender','senderName','recipientName','itemId','materialId','action','why','verdict','title','summary','body','containerId','state'].filter(k=>body[k]!==undefined).map(k=>[k,typeof body[k]==='string'?body[k].slice(0,k==='body'?1200:300):['string','number','boolean'].includes(typeof body[k])?body[k]:undefined])):body;
    return {seq:e.seq,ts:e.ts,kind:e.kind,seat_id:e.seat_id,actor,body:summary,detailAvailable:large,actorKey:identify(actor.roleId??e.seat_id??body.sender),recipientKey:body.recipient?identify(body.recipient):null};};
  if(i.action==='index'){
    const selected=await db.get<Row>('SELECT COUNT(*) n FROM office_events WHERE office_id=? AND seq>=? AND seq<=?',[i.officeId,from,to]);
    // Cap only the directory; pages remain cursor-based. The UI asks for a smaller range if too large.
    const historical=await db.all<Row[]>(`SELECT DISTINCT seat_id,roleId,sender,recipient,senderName,recipientName FROM (
      SELECT seat_id,json_extract(actor,'$.roleId') roleId,json_extract(body,'$.sender') sender,json_extract(body,'$.recipient') recipient,json_extract(body,'$.senderName') senderName,json_extract(body,'$.recipientName') recipientName FROM office_events WHERE office_id=? AND seq>=? AND seq<=?) LIMIT 1001`,[i.officeId,from,to]);
    const participants=new Map<string,Row>();
    const add=(id?:string|null,name?:string|null)=>{const key=identify(id);if(key==='system')return;const seat=seatMap.get(id!);const roleId=key.startsWith('role:')?key.slice(5):null;const current=roleId?names.get(roleId):seat?.label;const old=participants.get(key);participants.set(key,{key,roleId,seatId:seat?.id??old?.seatId??null,name:current??name??old?.name??(roleId?'历史角色 · ':'历史工位 · ')+(id??'').slice(0,8),historical:!current});};
    for(const e of historical){add(e.roleId??e.seat_id??e.sender,e.senderName);add(e.recipient,e.recipientName);}
    return {officeId:i.officeId,...stats,fromSeq:from,toSeq:to,count:selected!.n,participants:[...participants.values()],participantsLimited:historical.length>1000,layoutSource:'current_seats_with_historical_participants'};
  }
  const after=Math.max(from-1,i.afterSeq??from-1),limit=i.limit??100;
  const rows=await db.all<Row[]>('SELECT seq,seat_id,actor,kind,body,ts FROM office_events WHERE office_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?',[i.officeId,after,to,limit+1]);
  const events:Row[]=[];let bytes=0;
  for(const row of rows.slice(0,limit)){const event=project(row),size=Buffer.byteLength(JSON.stringify(event));if(events.length&&bytes+size>64000)break;events.push(event);bytes+=size;}
  return {officeId:i.officeId,fromSeq:from,toSeq:to,events,nextCursor:events.at(-1)?.seq??after,hasMore:rows.length>events.length};
}
