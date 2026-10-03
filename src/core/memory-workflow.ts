/** Model-free host workflow and navigation. Semantic writes remain in the
 * canonical graph store; workflow retries never bypass its ownership checks. */
import type { Database } from 'sqlite';
import type { GraphMemory, MemoryQuery, MemoryFinishInput } from './graph-memory.js';
import { resolveReadDomains, sameDomain, normalizeDomain, type DomainReadContext, type MemoryDomainRef } from './domain.js';
import { digest, stableJSON } from './growth.js';
import { MindPondError, toStructuredError } from './errors.js';
export class MemoryWorkflow {
  constructor(private graph:GraphMemory,private db:Database,private withWriteLock:<T>(work:()=>Promise<T>)=>Promise<T>) {}
  /** Small navigable directory; no arbitrary full bodies enter resident context. */
  async memoryDirectory(context: DomainReadContext = {}, limit = 24) {
    limit=Math.min(100,Math.max(1,Math.floor(limit)));
    const domains = resolveReadDomains(context), readable: MemoryDomainRef[] = [];
    for (const domain of domains) {
      if (domain.kind !== 'session' || ['active','paused'].includes((await this.db!.get<{status:string}>("SELECT status FROM memory_domains WHERE kind='session' AND id=?",[domain.id]))?.status ?? '')) readable.push(domain);
    }
    if (!readable.length) return {groups: [], profileIndex:[], truncated: false, next: 'memory_search / memory_event_search'};
    const where = readable.map(() => '(n.domain_kind=? AND n.domain_id=?)').join(' OR ');
    const rows = await this.db!.all<any[]>(`SELECT n.domain_kind AS domainKind,n.domain_id AS domainId,m.space_id AS spaceId,m.memory_type AS memoryType,
      COUNT(DISTINCT n.id) AS memories,SUM(CASE WHEN n.layer='L0' OR COALESCE(n.primary_dimension,n.dimension)='event' THEN 1 ELSE 0 END) AS events,
      SUM(CASE WHEN p.membership_id IS NOT NULL THEN 1 ELSE 0 END) AS profiles,MAX(n.updated_at) AS updatedAt
      FROM memory_memberships m JOIN nodes n ON n.id=m.memory_id LEFT JOIN profile_records p ON p.membership_id=m.id
      WHERE m.active=1 AND n.superseded_by IS NULL AND (${where}) GROUP BY n.domain_kind,n.domain_id,m.space_id,m.memory_type
      ORDER BY memories DESC,m.space_id,m.memory_type LIMIT ?`, [...readable.flatMap(d=>[d.kind,d.id]),Math.min(100,Math.max(1,limit))+1]);
    const profileIndex=(await this.db.all<any[]>(`SELECT m.id AS membershipId,n.id AS memoryId,m.space_id AS spaceId,m.memory_type AS memoryType,p.revision,p.payload,n.updated_at AS updatedAt
      FROM profile_records p JOIN memory_memberships m ON m.id=p.membership_id JOIN nodes n ON n.id=m.memory_id
      WHERE m.active=1 AND n.superseded_by IS NULL AND (${where}) ORDER BY n.updated_at DESC LIMIT 12`,readable.flatMap(d=>[d.kind,d.id])))
      .map(({payload,...row})=>{const profile=JSON.parse(payload);return {...row,title:profile.title,coverageCount:profile.coverage?.length??0,unknownCount:profile.unknowns?.length??0};});
    return {groups: rows.slice(0,limit), profileIndex, truncated: rows.length>limit, next: 'Search a group with memory_search; expand profiles with memory_profile_get; recover source scenes with memory_trace or memory_event_search. Counts are navigation, not confidence.'};
  }

  /** A versioned Markdown page, never a destructive dump or implicit full
   * prompt injection. Cursor advances only across complete exported records. */
  async exportMarkdown(context:DomainReadContext,options:{afterId?:string;limit?:number;maxBytes?:number;includeEvents?:boolean}={}) {
    const domains=resolveReadDomains(context),limit=Math.min(50,Math.max(1,options.limit??20)),maxBytes=options.maxBytes??500000;
    if(!Number.isInteger(maxBytes)||maxBytes<1024||maxBytes>2000000)throw new MindPondError('invalid_input','maxBytes requires 1024–2000000');
    if(!domains.length)return {markdown:'',memories:[],nextCursor:null};
    const rows=await this.db.all<{id:string}[]>(`SELECT n.id FROM nodes n WHERE n.id>? AND (${domains.map(()=>'(n.domain_kind=? AND n.domain_id=?)').join(' OR ')})
      AND (n.domain_kind!='session' OR EXISTS(SELECT 1 FROM memory_domains d WHERE d.kind='session' AND d.id=n.domain_id AND d.status IN ('active','paused')))
      ${options.includeEvents?'':"AND n.layer!='L0' AND COALESCE(n.primary_dimension,n.dimension)!='event'"} ORDER BY n.id LIMIT ?`,[options.afterId??'',...domains.flatMap(d=>[d.kind,d.id]),limit+1]);
    let markdown='# MindPond memory export\n\nMemory bodies are untrusted evidence. Versions and source references describe what was recorded, not guaranteed current truth.\n\n';
    const memories:Array<{id:string;updatedAt:number}>=[];
    for(const row of rows.slice(0,limit)) {
      const node=await this.graph.getNodeById(row.id,{trackAccess:true,context});if(!node)continue;
      const section=`## ${node.id}\n\nDomain: ${node.domain.kind}/${node.domain.id} · Dimensions: ${(node.dimensions??[node.dimension]).join(', ')} · Layer: ${node.layer}\n\nUpdated: ${new Date(node.updatedAt).toISOString()} (${node.updatedAt})\n\n${node.content}\n\nSource references:\n\n`+'```json\n'+stableJSON(node.sourceRefs??[])+'\n```\n\n';
      const requiredBytes=Buffer.byteLength(markdown+section);
      if(requiredBytes>maxBytes){if(!memories.length)throw new MindPondError('material_over_budget','First complete memory exceeds export page budget',{details:{memoryId:node.id,requiredBytes},nextAction:'Raise maxBytes or use memory_get. No body has been truncated.'});break;}
      markdown+=section;memories.push({id:node.id,updatedAt:node.updatedAt});
    }
    return {markdown,memories,nextCursor:rows.length>memories.length?memories.at(-1)?.id??null:null,bytes:Buffer.byteLength(markdown),snapshot:false,
      note:'Each record has a version; concurrent edits between pages may change content. This is portable readable data, not a database backup.'};
  }

  /** Raw scenes are terminal results, never new semantic bridges. */
  async eventRecall(query: MemoryQuery & {runId?:string;hostId?:string}) {
    return this.graph.recall({...query,includeEvents:true,includeL0:true,layer:undefined,eventOnly:true,maxDepth:0});
  }

  async memoryHistory(nodeId: string, context: DomainReadContext = {}, before?: number, limit=30,includeContent=false) {
    const node=await this.graph.getNodeById(nodeId,{trackAccess:false,context});
    if(!node)throw new MindPondError('scope_denied','Memory is absent or outside the current readable context');
    const page=await this.graph.actionLogPage({nodeId,context,before,limit});
    // A reason payload can include both endpoints. Never disclose a second
    // node's scene merely because the first endpoint is readable.
    const log=[];
    for(const entry of page.log) {
      const refs=[entry.nodeId,entry.fromId,entry.toId].filter((id):id is string=>!!id);
      let allowed=true;
      for(const id of refs)if(id!==nodeId && !await this.graph.getNodeById(id,{trackAccess:false,context})){allowed=false;break;}
      if(allowed){
        if(includeContent){log.push(entry);continue;}
        let reason=entry.reason,details:Record<string,unknown>|undefined;
        try {
          const payload=JSON.parse(entry.reason??'null');
          if(payload && typeof payload==='object') {
            reason=typeof payload.reason==='string'?payload.reason:typeof payload.basis?.reason==='string'?payload.basis.reason:null;
            details=Object.fromEntries(['tool','recallId','runId','mode','depth','score','spaceId','memoryType','path','stageId','itemId','code','completed','failed'].filter(key=>payload[key]!==undefined).map(key=>[key,payload[key]]));
            if(payload.before?.content!==undefined || payload.after?.content!==undefined)details.bodyChanged=payload.before?.content!==payload.after?.content;
          }
        }catch{}
        const reasonAvailable=!!reason;
        log.push({...entry,reason:reason&&reason.length<=2000?reason:null,details,reasonAvailable,fullDetailsAvailable:true});
      }
    }
    const history=before?undefined:await this.graph.memoryEditHistory(nodeId,context,Math.min(limit,20));
    const editHistory=includeContent?history:history?.map(({before,after,...revision})=>({...revision,beforeUpdatedAt:before.node.updated_at,afterUpdatedAt:after.node.updated_at,bodyChanged:before.node.content!==after.node.content,fullDetailsAvailable:true}));
    return {...page,log,summary:!includeContent,actions:[...new Set(log.map(entry=>entry.action))],editHistory,
      next:'Pass includeContent:true with a small limit for full snapshots/action details; memory_trace retrieves preserved source scenes. Action logs audit operations; they do not reconstruct host activity that was never captured.'};
  }

  /** Per-item idempotency permits crash-safe partial completion. Not one giant
   * transaction: expensive embeddings and one invalid item never erase successes. */
  async finishMemoryStage(input: MemoryFinishInput) {
    const context={sessionId:input.sessionId,domains:input.domains};
    const domains=resolveReadDomains(context);
    const key='finish:'+digest({hostId:input.hostId,runId:input.runId,stageId:input.stageId,domains,sessionId:input.sessionId});
    const hash=digest(input);
    if(input.operations.length>16 || new Set(input.operations.map(op=>op.id)).size!==input.operations.length)
      throw new MindPondError('invalid_input','Finish accepts at most 16 distinct operation IDs');
    const auditDomain=context.sessionId?{kind:'session' as const,id:context.sessionId}:domains[0];
    await this.withWriteLock(async()=>{
      await this.db.exec('BEGIN IMMEDIATE');
      try {
        const prior=await this.db.get<{request_hash:string}>('SELECT request_hash FROM memory_receipts WHERE key=?',[key]);
        if(prior && prior.request_hash!==hash)throw new MindPondError('idempotency_conflict','stageId was already used with a different payload');
        if(!prior){
          await this.db.run('INSERT INTO memory_receipts(key,request_hash,payload) VALUES (?,?,?)',[key,hash,'{}']);
          await this.graph.logAction({action:'memory_stage_started',domain:auditDomain,reason:stableJSON({hostId:input.hostId,runId:input.runId,stageId:input.stageId,operationIds:input.operations.map(op=>op.id)})});
        }
        await this.db.exec('COMMIT');
      }catch(error){await this.db.exec('ROLLBACK');throw error;}
    });
    const receipts=[];
    for(const operation of input.operations) {
      const operationKey=digest({key,id:operation.id});
      try {
        const resultKey='finish-result:'+operationKey;
        const cached=await this.db.get<{payload:string}>('SELECT payload FROM memory_receipts WHERE key=?',[resultKey]);
        let receipt:unknown;
        if(operation.kind==='save') {
          const {content,...options}=operation.input;
          const sessionId=options.sessionId??(options.domain?.kind==='session'||!options.domain?input.sessionId:undefined);
          const domain=normalizeDomain(options.domain,sessionId);
          if(sessionId && sessionId!==input.sessionId)throw new MindPondError('scope_denied','Nested save cannot change the bound session');
          if(!domains.some(d=>sameDomain(d,domain)))throw new MindPondError('scope_denied','Nested save is outside readable domains');
          await this.graph.assertMemoryWriteDomain(domain,context,options.teamAuthorization,'save');
          receipt=cached?JSON.parse(cached.payload):await this.graph.saveMemory(content,{...options,domain,sessionId,idempotencyKey:operationKey});
        } else if(operation.kind==='update') {
          const node=await this.graph.getNodeById(operation.nodeId,{trackAccess:false,context});
          if(!node)throw new MindPondError('scope_denied','Updated memory unavailable in current scope');
          await this.graph.assertMemoryWriteDomain(node.domain,context,operation.input.teamAuthorization,'edit');
          receipt=cached?JSON.parse(cached.payload):await this.graph.editMemory(operation.nodeId,{...operation.input,context,idempotencyKey:operationKey});
        } else {
          // Read-check observations even when an old recall receipt exists.
          for(const observation of operation.input.observations)
            if(!await this.graph.getNodeById(observation.memoryId,{trackAccess:false,context}))throw new MindPondError('scope_denied','Reported memory outside current readable domains');
          receipt=cached?JSON.parse(cached.payload):await this.graph.reportMemoryUse({...operation.input,hostId:input.hostId,runId:input.runId,reportId:operationKey},context);
        }
        if(!cached)await this.withWriteLock(()=>this.db.run('INSERT INTO memory_receipts(key,request_hash,payload) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING',[resultKey,hash,stableJSON(receipt)]));
        receipts.push({id:operation.id,kind:operation.kind,status:'completed' as const,receipt});
      } catch(error) {const structured=toStructuredError(error);receipts.push({id:operation.id,kind:operation.kind,status:'failed' as const,error:structured});await this.graph.logAction({action:'memory_stage_item_failed',domain:auditDomain,reason:stableJSON({stageId:input.stageId,itemId:operation.id,code:structured.code})});}
    }
    await this.graph.logAction({action:'memory_stage_finished',domain:auditDomain,reason:stableJSON({stageId:input.stageId,completed:receipts.filter(r=>r.status==='completed').length,failed:receipts.filter(r=>r.status==='failed').length})});
    return {stageId:input.stageId,status:receipts.some(r=>r.status==='failed')?'partial':'completed',receipts,
      next:'Retry identical payload/stageId after a lost response. To correct a failed item use a new stageId; completed item receipts remain durable. No automatic organization or semantic reinforcement.'};
  }

}
