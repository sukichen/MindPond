/** Human-owned availability and minimum duration for send-and-wait. */
import {z} from 'zod';
import type {Database} from 'sqlite';
import type {TrustedCallContext} from './trust.js';
import {MindPondError} from './errors.js';
import {OFFICE_REPLY_WAIT_MAX_MS,OFFICE_TOOL_TIMEOUT_SECONDS} from './office-wait-policy.js';
export const MAX_REPLY_WAIT_SECONDS=OFFICE_REPLY_WAIT_MAX_MS/1000;
export const DEFAULT_REPLY_WAIT_SECONDS=300;
const storedPolicySchema=z.object({minimumSeconds:z.number().int().min(0).max(MAX_REPLY_WAIT_SECONDS),revision:z.number().int().min(1)}).strict();
const storedSwitchSchema=z.object({
 enabled:z.boolean(),
 disabledRevision:z.number().int().nonnegative()
}).strict();

export async function readReplyWaitPolicy(db:Database){
 const rows=await db.all<Array<{key:string;value:string}>>(
  "SELECT key,value FROM office_meta WHERE key IN ('sendReplyWaitPolicy','sendReplyWaitSwitch')"
 );
 const policy=rows.find(row=>row.key==='sendReplyWaitPolicy');
 const control=rows.find(row=>row.key==='sendReplyWaitSwitch');
 const limits=policy?storedPolicySchema.parse(JSON.parse(policy.value)):{minimumSeconds:0,revision:0};
 const mode=control?storedSwitchSchema.parse(JSON.parse(control.value)):{enabled:true,disabledRevision:0};
 return {...limits,...mode,maximumSeconds:MAX_REPLY_WAIT_SECONDS,defaultSeconds:DEFAULT_REPLY_WAIT_SECONDS,toolTimeoutSeconds:OFFICE_TOOL_TIMEOUT_SECONDS};
}

const identifier=z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
const roleMode=z.enum(['inherit','require_choice','off']);

export async function readRoleReplyWaitPolicy(db:Database,officeId:string|null,roleId:string){
 const policy=await readReplyWaitPolicy(db);
 const rule=officeId?await db.get<{mode:z.infer<typeof roleMode>;disabledRevision:number}>(
  'SELECT mode,disabled_revision disabledRevision FROM office_role_reply_wait WHERE office_id=? AND role_id=?',
  [officeId,roleId]):undefined;
 return {...policy,mode:rule?.mode??'inherit',enabled:policy.enabled&&rule?.mode!=='off',
  disabledRevision:Math.max(policy.disabledRevision,rule?.disabledRevision??0)};
}

export const replyWaitPolicySchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('get')}).strict(),
 z.object({action:z.literal('roles'),officeId:identifier}).strict(),
 z.object({action:z.literal('set_role'),officeId:identifier,roleId:identifier,mode:roleMode,
  expectedRevision:z.number().int().min(0)}).strict(),
 z.object({action:z.literal('set'),enabled:z.boolean().optional(),minimumSeconds:z.number().int().min(0).max(MAX_REPLY_WAIT_SECONDS),expectedRevision:z.number().int().min(0)}).strict()
]);
export function replyWaitRequest(i:{action?:string;waitForReply?:unknown;waitSeconds?:unknown}){
 if(i.waitForReply!==undefined&&typeof i.waitForReply!=='boolean')throw new MindPondError('invalid_input','waitForReply must be true or false.');
 if((i.waitForReply!==undefined||i.waitSeconds!==undefined)&&i.action!=='send')throw new MindPondError('invalid_input','waitForReply and waitSeconds are supported only by office_message action=send.');
 if(i.waitSeconds!==undefined&&i.waitForReply!==true)throw new MindPondError('invalid_input','waitSeconds requires waitForReply=true; nothing was sent.');
 const seconds=i.waitSeconds??DEFAULT_REPLY_WAIT_SECONDS;
 if(i.waitForReply===true&&(!Number.isInteger(seconds)||(seconds as number)<1||(seconds as number)>MAX_REPLY_WAIT_SECONDS))throw new MindPondError('invalid_input',`waitSeconds must be an integer from 1 to ${MAX_REPLY_WAIT_SECONDS}; nothing was sent.`);
 return {enabled:i.waitForReply===true,requestedSeconds:seconds as number};
}
export class OfficeReplyWaitPolicy{
 constructor(private db:Database,private write:<T>(fn:()=>Promise<T>)=>Promise<T>,private clock=Date.now){}
 get(){return readReplyWaitPolicy(this.db);}
 forRole(officeId:string|null,roleId:string){return readRoleReplyWaitPolicy(this.db,officeId,roleId);}
 private async members(officeId:string){
  if(!await this.db.get('SELECT 1 FROM offices WHERE id=?',[officeId]))
   throw new MindPondError('not_found','Office not found.');
  return this.db.all<Array<{roleId:string;name:string;mode:z.infer<typeof roleMode>}>>(`
   SELECT DISTINCT r.id roleId,r.name,COALESCE(p.mode,'inherit') mode
   FROM role_seats rs JOIN office_seats s ON s.id=rs.seat_id
   JOIN character_roles r ON r.id=rs.role_id
   LEFT JOIN office_role_reply_wait p ON p.office_id=s.office_id AND p.role_id=r.id
   WHERE s.office_id=? AND s.enabled=1 AND r.state='active' ORDER BY r.name,r.id`,[officeId]);
 }
 private writeRevision(minimumSeconds:number,revision:number){
  return this.db.run("INSERT INTO office_meta VALUES('sendReplyWaitPolicy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
   [JSON.stringify({minimumSeconds,revision})]);
 }
 async manage(value:unknown,a?:TrustedCallContext){
  if(!a?.operator||a.expiresAt<=this.clock())throw new MindPondError('scope_denied','Only the human manager can change the send-and-wait policy.');
  const i=replyWaitPolicySchema.parse(value);if(i.action==='get')return this.get();
  return this.write(async()=>{
   if(a.expiresAt<=this.clock())throw new MindPondError('scope_denied','Management login expired. Log in again before saving this policy.');
   const old=await this.get();
   if(i.action==='roles')return {...old,roles:await this.members(i.officeId)};
   if(i.action==='set_role'){
    const members=await this.members(i.officeId);
    const role=members.find(member=>member.roleId===i.roleId);
    if(!role)throw new MindPondError('invalid_input','Choose a current active member of this office.');
    if(old.revision!==i.expectedRevision&&(old.revision!==i.expectedRevision+1||role.mode!==i.mode))
     throw new MindPondError('stale_version','The wait settings changed. Reload them before saving.');
    if(role.mode===i.mode)return {...old,roles:members};
    const revision=old.revision+1;
    await this.writeRevision(old.minimumSeconds,revision);
    await this.db.run(`INSERT INTO office_role_reply_wait VALUES(?,?,?,?)
      ON CONFLICT(office_id,role_id) DO UPDATE SET mode=excluded.mode,
      disabled_revision=CASE WHEN excluded.mode='off' THEN excluded.disabled_revision ELSE office_role_reply_wait.disabled_revision END`,
      [i.officeId,i.roleId,i.mode,i.mode==='off'?revision:0]);
    return {...await this.get(),roles:await this.members(i.officeId)};
   }
   const enabled=i.enabled??old.enabled;
   const unchanged=old.enabled===enabled&&old.minimumSeconds===i.minimumSeconds;
   if(old.revision!==i.expectedRevision){
    if(old.revision===i.expectedRevision+1&&unchanged)return {...old,replayed:true};
    throw new MindPondError('stale_version','The wait policy changed. Reload it before saving; your draft was not applied.');
   }
   if(unchanged)return {...old,changed:false};
   const revision=old.revision+1;
   await this.writeRevision(i.minimumSeconds,revision);
   if(enabled!==old.enabled){
    const control=JSON.stringify({enabled,disabledRevision:enabled?old.disabledRevision:revision});
    await this.db.run("INSERT INTO office_meta VALUES('sendReplyWaitSwitch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[control]);
   }
   await this.db.run("INSERT INTO role_events(role_id,kind,body,ts) VALUES(NULL,'reply_wait_policy_changed',?,?)",[JSON.stringify({enabled,minimumSeconds:i.minimumSeconds,revision}),this.clock()]);
   return {...await this.get(),changed:true};
  });
 }
}
