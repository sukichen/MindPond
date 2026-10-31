import type {Database} from 'sqlite';
/** A wakeup is delivery of a human request, never evidence the host obeyed it. */
export async function roleControlAttention(db:Database,roleId:string){
 const requests=await db.all<Array<{id:string;action:string;requested_at:number}>>("SELECT id,action,requested_at FROM office_control_requests WHERE role_id=? AND state='requested' ORDER BY requested_at,id LIMIT 20",[roleId]);
 if(!requests.length)return undefined;
 return {status:'control' as const,wakeReason:'user_control_requested',controlRequests:requests,
  nextCall:{tool:'office_host',arguments:{action:'status'}},
  nextAction:'The human has pending control requests. Read their full reasons with nextCall; honor pause/stop before further side effects, then acknowledge the action actually taken using office_host action=ack with requestId,outcome,evidence. This response did not stop a host, claim mail, handle posts or acknowledge any request.'};
}
