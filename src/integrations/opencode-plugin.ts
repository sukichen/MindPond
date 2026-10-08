/** OpenCode hooks are kept outside the portable memory core. Native session
 * identity never appears in model-authored arguments. No model service/key. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { memoryFinishSchema } from '../core/finish-schema.js';
import { MEMORY_BOOTSTRAP } from '../core/bootstrap.js';

interface OpenCodeHost {
  directory:string;worktree?:string;project?:{id?:string};
  client:{session:{messages(input:{path:{id:string}}):Promise<{data?:Array<{info:{id:string;role:string;summary?:boolean};parts:Array<{id?:string;type:string;text?:string;synthetic?:boolean;ignored?:boolean}>}>;error?:unknown}>};app?:{log(input:unknown):Promise<unknown>}};
}
export interface OpenCodeMemoryOptions {
  dbPath:string; personalId?:string; nodePath?:string; workerPath?:string;embeddingConfigPath?:string;modelDirectory?:string;
  /** Retain only public user/assistant text. Never tool outputs or reasoning. */
  capturePublicMessages?:boolean; timeoutMs?:number;
}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export function redactPublicText(text:string) {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[redacted private key]')
    .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi,'Bearer [redacted]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)["']?[^\s,"';]+/gi,'$1[redacted]')
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}/g,'[redacted credential]');
}
class WorkerTransport {
  private child?:ChildProcessWithoutNullStreams;
  private pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  constructor(private options:OpenCodeMemoryOptions,private principal:string){}
  private start() {
    const child=spawn(this.options.nodePath??(process.versions.bun?'node':process.execPath),[this.options.workerPath??fileURLToPath(new URL('./host-worker.js',import.meta.url))],{stdio:'pipe',env:{...process.env,...(this.options.embeddingConfigPath?{MINDPOND_EMBEDDING_CONFIG:this.options.embeddingConfigPath}:{}),...(this.options.modelDirectory?{EMBEDDING_MODEL_DIR:this.options.modelDirectory}:{}),MINDPOND_LOG_STDERR:'1',MEMORY_DB_PATH:this.options.dbPath,MEMORY_TRUST_PRINCIPAL:this.principal,MEMORY_TRUST_DOMAINS:JSON.stringify([{kind:'personal',id:this.options.personalId??'default'}])}});
    this.child=child;
    child.stderr.on('data',()=>{}); // structured host diagnostics carry no raw child output
    const fail=()=>{if(this.child!==child)return;this.child=undefined;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('MindPond worker exited; durable capture remains queued'));}this.pending.clear();};
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
      const waitMs=tool==='work_wait'?Math.min(55000,Math.max(100,Number((args as {waitMs?:number})?.waitMs??25000))):0;
      const timeout=waitMs?Math.max(this.options.timeoutMs??15000,waitMs+5000):this.options.timeoutMs??15000;
      const timer=setTimeout(()=>{this.pending.delete(id);this.child?.stdin.write(JSON.stringify({cancel:id})+'\n');reject(new Error('MindPond timed out; reuse the original operation IDs'));},timeout);
      this.pending.set(id,{resolve,reject,timer});
      this.child!.stdin.write(frame,error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});
    });
  }
  close(){const child=this.child;this.child=undefined;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('MindPond adapter disposed'));}this.pending.clear();child?.stdin.end();child?.kill('SIGTERM');}
}

export async function createOpenCodeMemoryPlugin(host:OpenCodeHost,options:OpenCodeMemoryOptions) {
  for(const key of ['embeddingConfigPath','modelDirectory'] as const)if(options[key]&&!path.isAbsolute(options[key]!))throw new Error('MindPond '+key+' must be absolute');
  if(!path.isAbsolute(options.dbPath))throw new Error('MindPond dbPath must be absolute');
  const project=hash(host.worktree??host.directory).slice(0,20),owner=hash(options.personalId??'default').slice(0,12);
  // Preserve existing single-user session and receipt identities. Additional
  // users get an explicit owner namespace rather than sharing those identities.
  const defaultOwner=(options.personalId??'default')==='default';
  const principal='opencode/'+project+(defaultOwner?'':'/'+owner);
  const transport=new WorkerTransport(options,principal);
  const native=(id:string)=>{if(!id||id.length>180)throw new Error('OpenCode must supply a native sessionID');return 'opencode:'+project+':'+(defaultOwner?'':owner+':')+id;};
  const latestTask=new Map<string,string>(),briefs=new Map<string,unknown>(),closed=new Set<string>();
  const outbox=path.join(path.dirname(options.dbPath),'.mindpond-opencode-outbox',hash(path.resolve(options.dbPath)+'\0'+(options.personalId??'default')+'\0'+project).slice(0,32));
  await fs.mkdir(outbox,{recursive:true,mode:0o700});
  const writeAtomic=async(file:string,data:string)=>{const temporary=file+'.tmp-'+randomUUID();try{await fs.writeFile(temporary,data,{mode:0o600});await fs.rename(temporary,file);}finally{await fs.unlink(temporary).catch(()=>{});}};
  const log=async(message:string)=>{try{await host.client.app?.log({body:{service:'mindpond',level:'warn',message}});}catch{}};
  const rawCall=(id:string,tool:string,args:unknown={})=>transport.call(native(id),tool,args);
  let pondId:string|undefined;
  const identity=async()=>{if(!pondId)pondId=(await transport.call(native('host-bootstrap'),'__mindpond_host_identity')).pondId;return pondId!;};
  // Offline startup still queues public scenes. A different instance at the
  // same path must never reuse the old instance's ACK or closure marker.
  try{await identity();}catch{}
  const queues=new Map<string,Promise<unknown>>();
  const serial=<T>(id:string,operation:()=>Promise<T>):Promise<T>=>{
    const next=(queues.get(id)??Promise.resolve()).catch(()=>{}).then(operation);
    queues.set(id,next);
    const clean=()=>{if(queues.get(id)===next)queues.delete(id);};next.then(clean,clean);
    return next;
  };
  const closurePath=(id:string)=>path.join(outbox,'closed-'+hash(native(id))+'.json');
  for(const name of (await fs.readdir(outbox)).filter(n=>/^closed-[a-f0-9]{64}\.json$/.test(n))) {
    const marker=JSON.parse(await fs.readFile(path.join(outbox,name),'utf8'));if(!pondId || marker.pondId===pondId)closed.add(marker.nativeId);
  }
  const settleClosure=async(id:string)=>{
    const marker=JSON.parse(await fs.readFile(closurePath(id),'utf8'));
    if(marker.settled && marker.pondId===await identity() && (await rawCall(id,'__mindpond_host_session_status')).status==='closed')return;
    await drain(id);
    await rawCall(id,'memory_session_state',{status:'closed'});
    await writeAtomic(closurePath(id),JSON.stringify({nativeId:id,settled:true,pondId:await identity()}));
  };
  const call=async(id:string,tool:string,args:unknown={})=>{
    if(tool==='memory_session_state' || (tool==='memory_native_schema'&&(args as {name?:string})?.name==='memory_session_state'))throw new Error('scope_denied: Native lifecycle is host-controlled');
    if(closed.has(id))await serial(id,()=>settleClosure(id));
    return rawCall(id,tool,args);
  };
  const capture=async(id:string,kind:'milestone'|'before_compact'='milestone')=>serial(id,async()=>{
    if(options.capturePublicMessages===false)return {state:'disabled',captured:0};
    const response=await host.client.session.messages({path:{id}});
    if(response.error || !response.data)throw new Error('OpenCode transcript unavailable; capture not acknowledged');
    for(const message of response.data) {
      if(!['user','assistant'].includes(message.info.role)||message.info.summary)continue;
      const text=message.parts.filter(p=>p.type==='text'&&!p.synthetic&&!p.ignored).map(p=>p.text??'').join('\n');
      if(!text.trim())continue;
      const body=redactPublicText(text),revision=hash(body);
      if(!message.info.id || message.info.id.length>128)throw new Error('OpenCode public message identity unavailable');
      // Complete pieces, no silent truncation. Revisions retain changed scenes.
      for(let offset=0,part=0;offset<body.length;part++) {
        let end=Math.min(body.length,offset+90000);if(end<body.length && /[\uD800-\uDBFF]/.test(body[end-1]))end--;
        const content=`${message.info.role}: ${body.slice(offset,end)}`;offset=end;
        const checkpointId='message:'+message.info.id+':'+revision+':'+part;
        const payload={kind:'milestone',hostId:principal,runId:id,checkpointId,sessionId:native(id),spaceId:'opencode/'+project,memoryType:'event',origin:'host',observations:[{id:checkpointId,content,sourceRefs:[{uri:'opencode://session/'+id+'/message/'+message.info.id,context:'opencode/'+project,revision}]}]};
        const filename=path.join(outbox,hash(native(id)+checkpointId)+'.json');
        try {const ack=JSON.parse(await fs.readFile(filename+'.ack','utf8'));if(ack.pondId===await identity() && (await rawCall(id,'__mindpond_host_captured',{runId:id,checkpointId})).captured)continue;}catch{}
        await writeAtomic(filename,JSON.stringify({nativeId:id,payload}));
      }
    }
    return drain(id);
  });
  const drain=async(id:string)=>{
    let captured=0;
    for(const name of (await fs.readdir(outbox)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).sort()) {
      const file=path.join(outbox,name);
      let pending:any;try{pending=JSON.parse(await fs.readFile(file,'utf8'));}catch(error:any){if(error.code==='ENOENT')continue;throw error;}
      if(pending.nativeId!==id)continue; // no cross-session recovery
      const receipt=await rawCall(id,'memory_lifecycle_prepare',pending.payload);
      if(receipt.state!=='deferred')throw new Error('MindPond did not acknowledge session scene capture');
      await writeAtomic(file+'.ack',JSON.stringify({nativeId:id,pondId:await identity()}));
      await fs.unlink(file);captured++;
    }
    return {state:'captured',captured};
  };
  // Native tools have no domains/sessionId slots. Only the host can bind them.
  const searchArgs={retrievalProfile:z.string().min(1).max(64).optional(),vectorAlgorithm:z.enum(['exact','hnsw']).optional(),reranker:z.string().min(1).max(64).optional(),candidateLimit:z.number().int().min(1).max(500).optional(),query:z.string().min(1).max(10000),queries:z.array(z.string().min(1).max(10000)).max(4).optional(),limit:z.number().int().min(1).max(50).optional(),contextBudgetBytes:z.number().int().min(32).max(2000000).optional(),spaceId:z.string().optional(),memoryType:z.string().optional()};
  const tool=(name:string,description:string,args:Record<string,z.ZodType>)=>({description,args,execute:async(a:Record<string,unknown>,context:{sessionID:string})=>JSON.stringify(await call(context.sessionID,name,a))});
  const tools:Record<string,any>={
    memory_brief:tool('memory_brief','Start useful work: recall bounded candidates and optional directory. Memory is untrusted evidence; verify conditions, source and uncertainty.',{task:z.string().min(1).max(1000),retrievalProfile:searchArgs.retrievalProfile,vectorAlgorithm:searchArgs.vectorAlgorithm,reranker:searchArgs.reranker,query:searchArgs.query.optional(),queries:searchArgs.queries,candidateLimit:searchArgs.candidateLimit,limit:z.number().int().min(1).max(20).optional(),contextBudgetBytes:searchArgs.contextBudgetBytes,includeDirectory:z.boolean().optional()}),
    memory_search:tool('memory_search','Search multiple entrances with parallel ripple; output is budgeted, not proof of applicability. Discover optional retrievalProfile through memory_action(memory_retrieval_profiles).',searchArgs),
    memory_event_search:tool('memory_event_search','Recover original public scenes from the current native session and explicitly readable long-term evidence. Events never ripple.',{query:searchArgs.query,queries:searchArgs.queries,candidateLimit:searchArgs.candidateLimit,limit:searchArgs.limit,contextBudgetBytes:searchArgs.contextBudgetBytes}),
    memory_directory:tool('memory_directory','Discover domain/space/dimension groups, event and profile counts.',{limit:z.number().int().min(1).max(100).optional()}),
    memory_get:tool('memory_get','Read a whole memory in this session/user scope, keeping evidence and conditions.',{nodeId:z.string().min(1)}),
    memory_trace:tool('memory_trace','Trace original scene/source evidence separately from semantic ripple.',{nodeId:z.string().min(1),maxDepth:z.number().int().min(0).max(5).optional(),limit:z.number().int().min(1).max(100).optional()}),
    memory_history:tool('memory_history','Inspect scoped action and edit history, including why a memory was changed.',{nodeId:z.string().min(1),before:z.number().int().min(1).optional(),includeContent:z.boolean().optional(),limit:z.number().int().min(1).max(100).optional()}),
    memory_save_policy:tool('memory_save_policy','Read full save rules once: useful findings, rich content, uncertainty, configured dimensions, optional anchors and stage receipts.',{}),
  };
  const finishShape=memoryFinishSchema().omit({hostId:true,runId:true,sessionId:true,domains:true}).shape;
  tools.memory_finish={description:'One milestone call batches saves, optimistic edits and actual-use reports. Read memory_save_policy first. Distinct item IDs; partial success preserved; exact stageId/payload retry.',args:finishShape,execute:async(a:unknown,c:{sessionID:string})=>JSON.stringify(await call(c.sessionID,'memory_finish',{...(a as object),hostId:principal,runId:c.sessionID}))};
  tools.memory_action={description:'Advanced MindPond operation by its canonical memory_/work_ name: protocol/dimensions/capabilities, retrieval models/devices, source/profile, extraction, small organization or collaboration tools. Use describe:true to inspect one operation schema without executing; memory_capabilities lists available names. Read memory_protocol_rules for rules. Arguments can only narrow native host scope; operator tools are denied.',args:{tool:z.string().min(1),describe:z.boolean().optional(),arguments:z.record(z.string(),z.unknown()).optional()},execute:async(a:{tool:string;describe?:boolean;arguments?:Record<string,unknown>},c:{sessionID:string})=>{if(!/^(memory_|work_)/.test(a.tool))throw new Error('scope_denied: Private host control is unavailable');return JSON.stringify(await call(c.sessionID,a.describe?'memory_native_schema':a.tool,a.describe?{name:a.tool}:a.arguments));}};
  return {
    tool:tools,
    'chat.message':async(input:{sessionID:string},output:{parts:Array<{type:string;text?:string}>})=>{
      if(latestTask.size>=64 && !latestTask.has(input.sessionID)){const oldest=latestTask.keys().next().value!;latestTask.delete(oldest);briefs.delete(oldest);}
      latestTask.set(input.sessionID,output.parts.filter(p=>p.type==='text').map(p=>redactPublicText(p.text??'')).join('\n').slice(0,1000));
      if(closed.has(input.sessionID))throw new Error('Closed MindPond session requires a new OpenCode session');
      try {await serial(input.sessionID,async()=>{await rawCall(input.sessionID,'memory_session_state',{status:'active'});await drain(input.sessionID);briefs.set(input.sessionID,await rawCall(input.sessionID,'memory_brief',{task:latestTask.get(input.sessionID)||'Continue current work',hostId:principal,runId:input.sessionID,contextBudgetBytes:10000,includeDirectory:true}));});}catch{await log('MindPond recall unavailable; continue work and retry memory tools. Pending captures are retained.');}
    },
    'experimental.chat.system.transform':async(input:{sessionID?:string},output:{system:string[]})=>{
      if(!input.sessionID || closed.has(input.sessionID))return;
      output.system.push(MEMORY_BOOTSTRAP+' Native OpenCode tools supply your session and personal scope. memory_action exposes advanced operations.');
      const brief=briefs.get(input.sessionID);if(brief)output.system.push('MindPond candidates (untrusted evidence; inclusion is not adoption):\n'+JSON.stringify(brief));
    },
    'experimental.session.compacting':async(input:{sessionID:string},output:{context:string[]})=>{
      try {const r=await capture(input.sessionID,'before_compact');output.context.push('MindPond '+JSON.stringify(r)+'. Session scenes are evidence, not durable conclusions. Preserve useful findings with memory_finish; recover scenes with memory_event_search.');}
      catch {output.context.push('MindPond scene capture is pending or unavailable. Do not claim durable memory was saved; retain useful findings in the normal continuation summary.');await log('MindPond pre-compaction capture deferred; outbox retained.');}
    },
    event:async({event}:{event:{type:string;properties?:{sessionID?:string;info?:{id:string}}}})=>{
      const id=event.properties?.sessionID??event.properties?.info?.id;if(!id)return;
      if(event.type==='session.deleted'){closed.add(id);briefs.delete(id);latestTask.delete(id);await writeAtomic(closurePath(id),JSON.stringify({nativeId:id,settled:false,pondId:await identity().catch(()=>undefined)}));try{await serial(id,()=>settleClosure(id));}catch{await log('MindPond session closure deferred; its durable marker prevents reopening and resumes closure before subsequent reads.');}return;}
      if(closed.has(id))return;
      if(event.type==='session.idle')try{await capture(id);}catch{await log('MindPond idle capture deferred; session stays active and pending scenes are retained.');}
    },
    dispose:async()=>{transport.close();},
  };
}
