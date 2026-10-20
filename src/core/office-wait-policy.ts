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
