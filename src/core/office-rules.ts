/** Human-managed reminders attached to MCP results, never collaborator message bodies. */
import {z} from 'zod';
import type {Database} from 'sqlite';
import type {GraphMemory} from './graph-memory.js';
import type {TrustedCallContext} from './trust.js';
import {MindPondError} from './errors.js';
export const DEFAULT_MEMORY_RULE='接任务先用独立 Memory MCP 的 memory_brief 查经验；阶段完成或交接前，保存或更新值得复用的已验证结论、步骤与坑点，注明条件和依据，先查重。个人经验存角色，共同知识指定 officeId。勿存流水账或密钥；身份不符先查 memory_identity，勿写入人类记忆。';
export const OFFICE_RULE_LEVELS=[
 {id:'off',label:'关闭',every:0},{id:'strong',label:'每次提醒',every:1},
 {id:'balanced',label:'均衡 · 每4次',every:4},{id:'light',label:'轻量 · 每8次',every:8},
 {id:'every16',label:'每16次',every:16},{id:'every32',label:'每32次',every:32},
 {id:'every64',label:'每64次',every:64},{id:'every128',label:'每128次',every:128}
] as const;
const frequency=z.enum(OFFICE_RULE_LEVELS.map(level=>level.id));
const rule=z.object({id:z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),title:z.string().trim().min(1).max(40),text:z.string().trim().min(1).max(1000),frequency}).strict();
export const officeRulesSchema=z.object({action:z.enum(['get','save']),officeId:z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),expectedRevision:z.number().int().nonnegative().optional(),rules:rule.array().max(8).refine(items=>new Set(items.map(r=>r.id)).size===items.length,'Rule IDs must be distinct').refine(items=>items.reduce((n,r)=>n+Buffer.byteLength(r.text),0)<=2048,'Combined rule text exceeds 2048 UTF-8 bytes').optional()}).strict();
type Row=Record<string,any>;
const defaults=()=>[{id:'memory',title:'使用 MindPond Memory',text:DEFAULT_MEMORY_RULE,frequency:'balanced' as const}];
export class OfficeRules{
 constructor(private db:Database,private graph:GraphMemory,private write:<T>(fn:()=>Promise<T>)=>Promise<T>,private clock=Date.now){}
 async init(){await this.write(()=>this.db.exec(`
 CREATE TABLE IF NOT EXISTS office_rule_policies(office_id TEXT PRIMARY KEY REFERENCES offices(id) ON DELETE CASCADE,revision INTEGER NOT NULL,rules TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS office_rule_delivery(office_id TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,role_id TEXT NOT NULL REFERENCES character_roles(id) ON DELETE CASCADE,binding_id TEXT NOT NULL,binding_epoch INTEGER NOT NULL,policy_revision INTEGER NOT NULL,opportunities INTEGER NOT NULL,last_order INTEGER NOT NULL,PRIMARY KEY(office_id,role_id));
 `));}
 private async policy(officeId:string){const row=await this.db.get<Row>('SELECT revision,rules FROM office_rule_policies WHERE office_id=?',[officeId]);return {revision:row?.revision??0,rules:row?JSON.parse(row.rules) as z.infer<typeof rule>[]:defaults()};}
 async manage(value:unknown,a?:TrustedCallContext){
  const i=officeRulesSchema.parse(value);
  if(!a?.operator||a.expiresAt<=this.clock())throw new MindPondError('scope_denied','Only the human workbench can configure office rules');
  return this.write(async()=>{
   const office=await this.db.get<Row>('SELECT id,title,state FROM offices WHERE id=?',[i.officeId]);if(!office)throw new MindPondError('not_found','Office not found');
   const old=await this.policy(i.officeId);
   if(i.action==='get'){if(i.rules!==undefined||i.expectedRevision!==undefined)throw new MindPondError('invalid_input','get accepts only officeId');return {officeId:i.officeId,...old,defaults:defaults(),levels:OFFICE_RULE_LEVELS,maxRules:8,maxTextBytes:2048};}
   if(i.expectedRevision===undefined||i.rules===undefined)throw new MindPondError('invalid_input','save requires rules and expectedRevision');
   if(!['active','paused'].includes(office.state))throw new MindPondError('invalid_input','Archived office rules are read-only');
   const encoded=JSON.stringify(i.rules);
   if(old.revision!==i.expectedRevision){if(old.revision===i.expectedRevision+1&&JSON.stringify(old.rules)===encoded)return {officeId:i.officeId,...old,replayed:true};throw new MindPondError('stale_version','Office rules changed; reload them before saving. Your draft was not applied.');}
   const revision=old.revision+1;
   await this.db.run('INSERT INTO office_rule_policies VALUES(?,?,?) ON CONFLICT(office_id) DO UPDATE SET revision=excluded.revision,rules=excluded.rules',[i.officeId,revision,encoded]);
   await this.db.run('DELETE FROM office_response_pages');
   await this.db.run("INSERT INTO office_events(office_id,seat_id,actor,kind,body,ts) VALUES(?,NULL,?,'rules_updated',?,?)",[i.officeId,JSON.stringify({operator:true}),JSON.stringify({revision,ruleCount:i.rules.length}),this.clock()]);
   return {officeId:i.officeId,revision,rules:i.rules};
  });
 }
 private eligible(name:string,i:Row,data:Row){
  if(name==='role_sync')return true;
  if(name==='office_message'||name==='office_broadcast')return true;
  if(name==='office_receive')return Boolean(data.messages?.length);
  if(name==='office_wait')return data.status==='matched'&&Boolean(data.message);
  if(name==='office_discussion')return ['create','join','post','finish','leave','close'].includes(i.action)||i.action==='get'&&Boolean(data.posts?.length)||i.action==='wait'&&data.status==='matched';
  return false;
 }
 /** Counters follow approved roles across transports and reset on rebind/policy revision. */
 async reminders(name:string,i:Row,data:Row,a:TrustedCallContext){
  if(a.operator||!this.eligible(name,i,data))return [];
  return this.write(async()=>{
   const b=await this.graph.roles.binding(a),actor={...a,roleId:b!.role_id,roleBindingId:b!.id,roleBindingEpoch:b!.epoch};
   const seats=await this.graph.offices.authorizedSeats(actor);if(!seats.length)return [];
   const visible=new Set(seats.map(s=>s.office_id));
   const wanted=new Set<string>();const add=(id:unknown)=>{if(typeof id==='string')wanted.add(id);};
   if(name==='role_sync')for(const id of visible)add(id);
   else{
    add(i.officeId);add(data.officeId);add(data.room?.office_id);add(data.message?.officeId);
    for(const message of data.messages??[])add(message.officeId);
    const messageId=data.messageId??i.messageId;
    if(typeof messageId==='string'&&name==='office_message'){const message=await this.db.get<Row>('SELECT office_id FROM role_messages WHERE id=? AND (sender=? OR recipient=?)',[messageId,b!.role_id,b!.role_id]);add(message?.office_id);}
    if(name==='office_discussion'){
     const id=data.discussionId??data.room?.id??data.id??i.id;
     if(typeof id==='string'){const room=await this.db.get<Row>('SELECT office_id FROM office_discussions WHERE id=?',[id]);add(room?.office_id);}
     if(data.departureId){const departure=await this.db.get<Row>('SELECT office_id FROM office_discussion_departures WHERE id=? AND role_id=?',[data.departureId,b!.role_id]);add(departure?.office_id);}
    }
    // Direct correspondence belongs to the role's current primary office, never the sender's private rules.
    if(!wanted.size){const primary=seats.find(s=>s.id===b!.primary_seat);if(primary)add(primary.office_id);}
   }
   const candidates=[];
   for(const id of wanted){if(!visible.has(id))continue;const office=await this.db.get<Row>("SELECT title FROM offices WHERE id=? AND state IN ('active','paused')",[id]);if(!office)continue;
    const policy=await this.policy(id),previous=await this.db.get<Row>('SELECT * FROM office_rule_delivery WHERE office_id=? AND role_id=?',[id,b!.role_id]);
    const unchanged=previous&&previous.binding_id===b!.id&&previous.binding_epoch===b!.epoch&&previous.policy_revision===policy.revision;
    if(name==='role_sync'&&unchanged)continue;
    const count=unchanged?previous.opportunities:0;
    const due=policy.rules.filter(r=>{const every=OFFICE_RULE_LEVELS.find(level=>level.id===r.frequency)!.every;return every>0&&count%every===0;});
    candidates.push({id,title:office.title,policy,count,due,order:previous?.last_order??0});
   }
   candidates.sort((x,y)=>x.order-y.order||x.id.localeCompare(y.id));
   const reminders:Row[]=[];let order=(await this.db.get<Row>('SELECT COALESCE(MAX(last_order),0) n FROM office_rule_delivery'))!.n;
   for(const c of candidates){
    const entry={officeId:c.id,officeTitle:c.title,revision:c.policy.revision,rules:c.due.map(({id,title,text})=>({id,title,text}))};
    if(c.due.length&&Buffer.byteLength(JSON.stringify([...reminders,entry]))>8192)continue; // Deferred offices remain due; oldest-delivered ordering prevents starvation.
    if(c.due.length){reminders.push(entry);order++;}
    if(c.policy.rules.some(r=>r.frequency!=='off'))await this.db.run('INSERT INTO office_rule_delivery VALUES(?,?,?,?,?,?,?) ON CONFLICT(office_id,role_id) DO UPDATE SET binding_id=excluded.binding_id,binding_epoch=excluded.binding_epoch,policy_revision=excluded.policy_revision,opportunities=excluded.opportunities,last_order=excluded.last_order',[c.id,b!.role_id,b!.id,b!.epoch,c.policy.revision,c.count+1,c.due.length?order:c.order]);
   }
   return reminders;
  });
 }
}
