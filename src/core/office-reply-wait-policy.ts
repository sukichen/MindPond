/** Human-owned availability and minimum duration for send-and-wait. */
import {z} from 'zod';
import type {Database} from 'sqlite';
import type {TrustedCallContext} from './trust.js';
import {MindPondError} from './errors.js';
import {OFFICE_WAIT_MS,OFFICE_TOOL_TIMEOUT_SECONDS} from './office-wait-policy.js';
export const MAX_REPLY_WAIT_SECONDS=OFFICE_WAIT_MS/1000;
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
 return {...limits,...mode,maximumSeconds:MAX_REPLY_WAIT_SECONDS,defaultSeconds:MAX_REPLY_WAIT_SECONDS,toolTimeoutSeconds:OFFICE_TOOL_TIMEOUT_SECONDS};
}

export const replyWaitPolicySchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('get')}).strict(),
 z.object({action:z.literal('set'),enabled:z.boolean().optional(),minimumSeconds:z.number().int().min(0).max(MAX_REPLY_WAIT_SECONDS),expectedRevision:z.number().int().min(0)}).strict()
]);
export function replyWaitRequest(i:{action?:string;waitForReply?:unknown;waitSeconds?:unknown}){
 if(i.waitForReply!==undefined&&typeof i.waitForReply!=='boolean')throw new MindPondError('invalid_input','waitForReply must be true or false.');
 if((i.waitForReply!==undefined||i.waitSeconds!==undefined)&&i.action!=='send')throw new MindPondError('invalid_input','waitForReply and waitSeconds are supported only by office_message action=send.');
 if(i.waitSeconds!==undefined&&i.waitForReply!==true)throw new MindPondError('invalid_input','waitSeconds requires waitForReply=true; nothing was sent.');
 const seconds=i.waitSeconds??MAX_REPLY_WAIT_SECONDS;
 if(i.waitForReply===true&&(!Number.isInteger(seconds)||(seconds as number)<1||(seconds as number)>MAX_REPLY_WAIT_SECONDS))throw new MindPondError('invalid_input',`waitSeconds must be an integer from 1 to ${MAX_REPLY_WAIT_SECONDS}; nothing was sent.`);
 return {enabled:i.waitForReply===true,requestedSeconds:seconds as number};
}
export class OfficeReplyWaitPolicy{
 constructor(private db:Database,private write:<T>(fn:()=>Promise<T>)=>Promise<T>,private clock=Date.now){}
 get(){return readReplyWaitPolicy(this.db);}
 async manage(value:unknown,a?:TrustedCallContext){
  if(!a?.operator||a.expiresAt<=this.clock())throw new MindPondError('scope_denied','Only the human manager can change the send-and-wait policy.');
  const i=replyWaitPolicySchema.parse(value);if(i.action==='get')return this.get();
  return this.write(async()=>{
   if(a.expiresAt<=this.clock())throw new MindPondError('scope_denied','Management login expired. Log in again before saving this policy.');
   const old=await this.get();
   const enabled=i.enabled??old.enabled;
   const unchanged=old.enabled===enabled&&old.minimumSeconds===i.minimumSeconds;
   if(old.revision!==i.expectedRevision){
    if(old.revision===i.expectedRevision+1&&unchanged)return {...old,replayed:true};
    throw new MindPondError('stale_version','The wait policy changed. Reload it before saving; your draft was not applied.');
   }
   if(unchanged)return {...old,changed:false};
   const revision=old.revision+1;
   const limits=JSON.stringify({minimumSeconds:i.minimumSeconds,revision});
   // Keep the duration record readable by the prior release during rollback.
   await this.db.run("INSERT INTO office_meta VALUES('sendReplyWaitPolicy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[limits]);
   if(enabled!==old.enabled){
    const control=JSON.stringify({enabled,disabledRevision:enabled?old.disabledRevision:revision});
    await this.db.run("INSERT INTO office_meta VALUES('sendReplyWaitSwitch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[control]);
   }
   await this.db.run("INSERT INTO role_events(role_id,kind,body,ts) VALUES(NULL,'reply_wait_policy_changed',?,?)",[JSON.stringify({enabled,minimumSeconds:i.minimumSeconds,revision}),this.clock()]);
   return {...await this.get(),changed:true};
  });
 }
}
