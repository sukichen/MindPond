/** Message waits stay open until arrival, cancellation, or this five-minute deadline. */
export const OFFICE_WAIT_MS = 300_000;
/** Allow transport and response overhead beyond the server deadline. */
export const OFFICE_TOOL_TIMEOUT_MS = 360_000;
/** Codex configuration uses seconds; derive it from the shared transport deadline. */
export const OFFICE_TOOL_TIMEOUT_SECONDS = OFFICE_TOOL_TIMEOUT_MS / 1000;
/** Initial database-wide admission defaults. A saved administrator policy takes precedence across processes. */
export function officeWaitCapacity(env:NodeJS.ProcessEnv=process.env){
  const read=(key:string,fallback:number,max:number)=>{const value=env[key]===undefined?fallback:Number(env[key]);if(!Number.isSafeInteger(value)||value<1||value>max)throw new Error(`${key} must be 1–${max}`);return value;};
  const maxPerPrincipal=read('MINDPOND_OFFICE_WAIT_PER_ACCOUNT',8,128),maxGlobal=read('MINDPOND_OFFICE_WAIT_GLOBAL',64,1024);
  if(maxPerPrincipal>maxGlobal)throw new Error('MINDPOND_OFFICE_WAIT_GLOBAL must cover the per-account limit');
  return {maxPerPrincipal,maxGlobal};
}

/** Shared public result semantics for a live wait and negotiated MCP Tasks. */
export function officeWaitResult(result:Record<string,any>,input:{afterSeq?:number;replyTo?:string;waitMs?:number},elapsedMs:number){
 const timing={requestedWaitMs:input.waitMs??OFFICE_WAIT_MS,elapsedMs:Math.round(elapsedMs)};
 if(result.status==='discussion'){
  const discussion=result.discussions;
  if(discussion.activeUnavailable)return {...result,...timing,wakeReason:'discussion_access_changed',nextAction:discussion.next};
  if(discussion.active)return {...result,...timing,wakeReason:'active_discussion',nextCall:{tool:'office_discussion',arguments:{action:'get',id:discussion.active.id}},nextAction:'Active discussion takes priority. Use nextCall for unprocessed posts; when none remain, use office_discussion action=wait with the remaining authorized budget. Repeating office_wait returns the same focus. This is not a timeout or task completion.'};
  return {...result,...timing,wakeReason:'discussion_invitation',nextAction:'Inspect pending invitations, then explicitly join or decline. This call did not join or claim mail. Repeating office_wait returns the same outstanding invitation; this is not a timeout.'};
 }
 if(result.status==='matched')return {...result,...timing,wakeReason:'message_available',nextAction:'A matching pending message is available, possibly already present before this call. Waiting does not claim or finish it. Use office_message action=take with its message id and a stable key, then finish after actual handling.'};
 if(result.status!=='timeout')return {...result,...timing,wakeReason:result.wakeReason??(result.status==='cancelled'?'request_cancelled':result.status)};
 return {...result,...timing,wakeReason:'deadline_reached',pending:true,resume:{afterSeq:result.nextCursor,...(input.replyTo?{replyTo:input.replyTo}:{}),waitMs:input.waitMs??OFFICE_WAIT_MS},nextAction:'No matching message yet; this wait window ended, not the collaboration. While the user-authorized waiting budget remains, call office_wait again with resume. Preserve replyTo when present. Do not infer success, failure or completion; a stopped host is not woken by later messages.'};
}
