/** Bounded, cancellable long polling. No SQLite owner is held while asleep. */
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {MindPondError} from './errors.js';
import type {TrustedCallContext} from './trust.js';

export interface WorkWaitInput {
  taskId?:string;
  afterSeq?:number;
  until?:'inbox_update'|'iteration_submitted'|'verification_result';
  roundId?:string;
  codeVersion?:string;
  waitMs?:number;
}
export interface WorkCallRuntime {
  signal?:AbortSignal;
  /** Gateways recheck revocable credentials during an outstanding request. */
  authorize?:()=>Promise<void>;
}
export interface WaitMatch {status:'matched'|'terminal'|'superseded';nextCursor:number;[key:string]:unknown}
interface WaitHooks {
  inspect:(input:WorkWaitInput,actor?:TrustedCallContext)=>Promise<WaitMatch|undefined>;
  start:(id:string,input:WorkWaitInput,actor:TrustedCallContext,waitMs:number)=>Promise<void>;
  finish:(id:string,actor:TrustedCallContext,result:unknown,status:string)=>Promise<void>;
}

export class CollaborationWaiter {
  private stopping=new AbortController();
  private listeners=new Set<()=>void>();
  private active=new Map<string,number>();
  private pending=new Set<Promise<unknown>>();
  private generation=0;
  constructor(private hooks:WaitHooks){}
  notify(){this.generation++;for(const listener of [...this.listeners])listener();}
  async close(){this.stopping.abort();this.notify();await Promise.allSettled([...this.pending]);}
  private pause(ms:number,generation:number,signal:AbortSignal){
    return new Promise<void>(resolve=>{
      let timer:ReturnType<typeof setTimeout>;
      const done=()=>{clearTimeout(timer);this.listeners.delete(done);signal.removeEventListener('abort',done);resolve();};
      timer=setTimeout(done,ms);this.listeners.add(done);signal.addEventListener('abort',done,{once:true});
      // A commit may have arrived between inspecting state and subscribing.
      if(signal.aborted||generation!==this.generation)done();
    });
  }
  wait(input:WorkWaitInput,actor:TrustedCallContext|undefined,runtime:WorkCallRuntime={}){
    const promise=this.run(input,actor,runtime);this.pending.add(promise);
    void promise.finally(()=>this.pending.delete(promise)).catch(()=>{});
    return promise;
  }
  private async run(input:WorkWaitInput,actor:TrustedCallContext|undefined,runtime:WorkCallRuntime={}){
    const waitMs=input.waitMs??25000;
    if(!Number.isInteger(waitMs)||waitMs<100||waitMs>55000)
      throw new MindPondError('invalid_input','waitMs must be 100–55000 milliseconds');
    // Validate authorization and filters before consuming a waiter slot.
    await runtime.authorize?.();
    await this.hooks.inspect(input,actor);
    const principal=actor!.principal;
    if((this.active.get(principal)??0)>=8||[...this.active.values()].reduce((a,b)=>a+b,0)>=64)
      throw new MindPondError('temporarily_unavailable','Too many concurrent collaboration waits',{retryable:true,retryAfterMs:1000});
    this.active.set(principal,(this.active.get(principal)??0)+1);
    const id=randomUUID(),started=performance.now();
    const signal=AbortSignal.any([this.stopping.signal,...(runtime.signal?[runtime.signal]:[])]);
    let recorded=false;
    const resume={...input,afterSeq:input.afterSeq??0,waitMs};
    try{
      await this.hooks.start(id,resume,actor!,waitMs);recorded=true;
      while(true){
        let result:Record<string,unknown>;
        if(signal.aborted){result={status:'cancelled',nextCursor:resume.afterSeq,nextAction:'Waiting was cancelled. Do not treat this as verification or resume work automatically.'};}
        else{
          await runtime.authorize?.();
          const generation=this.generation;
          const match=await this.hooks.inspect(resume,actor);
          if(match)result=match;
          else if(performance.now()-started>=waitMs){result={status:'timeout',nextCursor:resume.afterSeq,resume,nextAction:'No matching result yet. While the user-authorized loop remains active, call work_wait again with resume. Timeout is not verification failure and must not trigger another edit.'};}
          else{await this.pause(Math.min(750,waitMs-(performance.now()-started)),generation,signal);continue;}
        }
        const receipt={...result,waitId:id,elapsedMs:Math.round(performance.now()-started)};
        await this.hooks.finish(id,actor!,receipt,String(result.status));
        return receipt;
      }
    }catch(error){
      // Cleanup only this wait record even if its workspace access was revoked.
      if(recorded)await this.hooks.finish(id,actor!,{status:'failed'},'failed').catch(()=>{});
      throw error;
    }finally{
      const count=(this.active.get(principal)??1)-1;
      if(count)this.active.set(principal,count);else this.active.delete(principal);
    }
  }
}
