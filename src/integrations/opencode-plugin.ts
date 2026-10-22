/** OpenCode hooks are kept outside the portable memory core. Native session
 * identity never appears in model-authored arguments. No model service/key. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {layeredRecallShape} from '../core/memory-recall-schema.js';

interface OpenCodeHost {
  directory:string;worktree?:string;project?:{id?:string};
  client:{app?:{log(input:unknown):Promise<unknown>}};
}
export interface OpenCodeMemoryOptions {
  dbPath:string; nodePath?:string; workerPath?:string;embeddingConfigPath?:string;modelDirectory?:string;
  timeoutMs?:number;
}
class WorkerTransport {
  private child?:ChildProcessWithoutNullStreams;
  private pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  constructor(private options:OpenCodeMemoryOptions){}
  private start() {
    const child=spawn(this.options.nodePath??(process.versions.bun?'node':process.execPath),[this.options.workerPath??fileURLToPath(new URL('./host-worker.js',import.meta.url))],{stdio:'pipe',env:{...process.env,...(this.options.embeddingConfigPath?{MINDPOND_EMBEDDING_CONFIG:this.options.embeddingConfigPath}:{}),...(this.options.modelDirectory?{EMBEDDING_MODEL_DIR:this.options.modelDirectory}:{}),MINDPOND_LOG_STDERR:'1',MEMORY_DB_PATH:this.options.dbPath}});
    this.child=child;
    child.stderr.on('data',()=>{}); // structured host diagnostics carry no raw child output
    const fail=()=>{if(this.child!==child)return;this.child=undefined;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('MindPond worker exited; reconnect and retry with the original operation ID'));}this.pending.clear();};
    child.once('error',fail);child.once('exit',fail);child.stdin.on('error',fail);child.stdout.on('error',fail);
    const lines=readline.createInterface({input:child.stdout});
    lines.on('line',line=>{try{const response=JSON.parse(line),p=this.pending.get(response.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(response.id);if(response.error)p.reject(new Error(JSON.stringify(response.error)));else p.resolve(response.result);}catch{ /* stdout reserves complete RPC frames */ }});
  }
  call(sessionId:string,tool:string,args:unknown={}) {
    if(this.pending.size>=64)return Promise.reject(new Error('MindPond queue busy; retry at next milestone'));
    if(!this.child)this.start();
    const id=randomUUID(),frame=JSON.stringify({id,sessionId,tool,args})+'\n';
    if(Buffer.byteLength(frame)>2000000)return Promise.reject(new Error(JSON.stringify({code:'material_over_budget',message:'Native call exceeds 2 MB; split complete operations into smaller stages before submitting',retryable:false})));
    return new Promise<any>((resolve,reject)=>{
      const timeout=this.options.timeoutMs??15000;
      const timer=setTimeout(()=>{this.pending.delete(id);this.child?.stdin.write(JSON.stringify({cancel:id})+'\n');reject(new Error('MindPond timed out; reuse the original operation IDs'));},timeout);
      this.pending.set(id,{resolve,reject,timer});
      this.child!.stdin.write(frame,error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});
    });
  }
  close(){const child=this.child;this.child=undefined;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('MindPond adapter disposed'));}this.pending.clear();child?.stdin.end();child?.kill('SIGTERM');}
}

export async function createOpenCodeMemoryPlugin(host:OpenCodeHost,options:OpenCodeMemoryOptions) {
  if(!path.isAbsolute(options.dbPath))throw new Error('MindPond dbPath must be absolute');
  if('personalId' in options)throw new Error('Personal identity selectors are no longer supported. Bind this chat to an Office role.');
  for(const key of ['embeddingConfigPath','modelDirectory'] as const)if(options[key]&&!path.isAbsolute(options[key]!))throw new Error('MindPond '+key+' must be absolute');
  const transport=new WorkerTransport(options);
  const call=(id:string,name:string,args:unknown={})=>{
    if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(id))throw new Error('A native OpenCode sessionID is required');
    return transport.call(id,name,args);
  };
  const tool=(name:string,description:string,args:Record<string,z.ZodType>)=>({description,args,execute:async(a:Record<string,unknown>,context:{sessionID:string})=>JSON.stringify(await call(context.sessionID,name,a))});
  const scope={officeId:z.string().min(1).max(160).optional()};
  return {
    tool:{
      memory_resume:tool('memory_resume','Restore this approved role’s current working summary and unfinished tasks after reconnect/context loss; follow pages and check role_sync controls.',{cursor:z.string().max(2048).optional(),contextBudgetBytes:z.number().int().min(2048).max(65536).optional()}),
      memory_identity:tool('memory_identity','Verify the chat identity: unbound human or approved Office role. Missing chat metadata is an error.',{}),
      memory_capabilities:tool('memory_capabilities','Discover available Memory tools and advanced actions before requesting a schema.',{}),
      memory_brief:tool('memory_brief','Recall knowledge allowed to the current human or role; verify sources.',{...scope,...layeredRecallShape,task:z.string().min(1).max(10000)}),
      memory_search:tool('memory_search','Search knowledge allowed to the current human or role.',{...scope,...layeredRecallShape,query:z.string().min(1).max(10000)}),
      memory_get:tool('memory_get','Read an authorized memory.',{nodeId:z.string().min(1).max(160)}),
      memory_directory:tool('memory_directory','List knowledge allowed to the current human or role.',{...scope,offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(50).optional()}),
      memory_save_policy:tool('memory_save_policy','Read current saving guidance and dimensions.',{}),
      memory_action:{description:'Use a layered Memory tool: memory_save (scored related[], anchors), memory_update/delete, memory_connections, memory_association_get/upsert/review/delete or memory_use_report. describe:true returns its schema; identity cannot be selected.',args:{tool:z.string().min(1).max(100),describe:z.boolean().optional(),arguments:z.record(z.string(),z.unknown()).optional()},execute:async(a:{tool:string;describe?:boolean;arguments?:unknown},c:{sessionID:string})=>{
        return JSON.stringify(await call(c.sessionID,'memory_action',a));
      }}
    },
    'chat.message':async(input:{sessionID:string},_output:unknown)=>{
      try{await call(input.sessionID,'memory_identity');}
      catch{await host.client.app?.log({body:{service:'mindpond',level:'warn',message:'MindPond chat identity unavailable. Reconnect the native session integration and verify memory_identity.'}});}
    },
    'experimental.chat.system.transform':async(_input:unknown,output:{system:string[]})=>{output.system.push('MindPond Memory follows this chat: an unbound chat is human and can access all knowledge; a bound chat accesses only its role and current offices. Verify memory_identity after role_sync or reconnect. When bound, call memory_resume after activation/reconnect/context loss; check controls and new mail. At milestones and before handoff update memory_continuity_checkpoint/task through memory_action; archive only explicitly ended tasks. Missing chat metadata is an error. Save verified reusable lessons through memory_action(memory_save); never select an identity in arguments.');},
    dispose:async()=>{transport.close();}
  };
}
