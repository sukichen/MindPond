/** Advanced operations share the exact identity/authorization boundary of the
 * small direct catalog. Schemas are fetched on demand, not repeated in prompts. */
import {z} from 'zod';
import type {GraphMemory,MemoryNode,MemoryWriteHooks} from './core/graph-memory.js';
import type {MemoryOwner} from './core/memory-owners.js';
import type {DomainReadContext} from './core/domain.js';
import {sameDomain} from './core/domain.js';
import {MindPondError} from './core/errors.js';
import {memoryUseShape} from './core/memory-use-schema.js';
import {sourceReferenceSchema} from './core/host-schemas.js';
import {organizationPlanSchema} from './core/host-contract.js';
import {organizationTask,ORGANIZATION_POLICY,ORGANIZATION_POLICY_VERSION} from './core/organization-policy.js';
import {retrievalStatus} from './core/retrieval-status.js';
import {MEMORY_CAPABILITY_CONTRACT} from './core/memory-capability-contract.js';
type Actor=Extract<MemoryOwner,{kind:'agent'|'user'}>;
type Guard=()=>Promise<void>;
type Run=(a:any,o:Actor,g:Guard)=>Promise<unknown>;
interface Options {
  graph:GraphMemory;tool:(name:string,description:string,shape:any,fn:Run,advanced?:boolean)=>void;
  operations:Map<string,{description:string;schema:z.ZodObject<any>;fn:Run;direct:boolean}>;
  execute:(name:string,args:unknown,o:Actor,g:Guard)=>Promise<unknown>;
  context:(o:Actor,officeId?:string)=>Promise<DomainReadContext|undefined>;
  get:(id:string,o:Actor)=>Promise<MemoryNode>;
  associationHooks:(o:Actor,g:Guard)=>MemoryWriteHooks;
  authorizeIncidentAssociations:(id:string,o:Actor,g:Guard)=>Promise<void>;
  write:any;related:z.ZodType;recallOptions:any;search:(a:any,o:Actor)=>Promise<any>;instructions:string;
}
export function registerOwnerMemoryActions(api:Options){
  const {graph,tool,operations,execute,context,get,associationHooks,authorizeIncidentAssociations}=api;
  const action=(name:string,description:string,shape:any,run:Run)=>tool(name,description,shape,run,true);
  const id=z.string().min(1).max(160),key=z.string().min(1).max(256),reason=z.string().min(1).max(2000);
  const page={offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(50).optional()};
  const scope={officeId:id.optional()};
  const nodeContext=async(nodeId:string,o:Actor)=>{
    const node=await get(nodeId,o);
    return {domains:[node.domain],...(node.domain.kind==='session'?{sessionId:node.domain.id}:{})};
  };
  const writable=async(nodeId:string,o:Actor,g:Guard,topology=false)=>{
    await g();await graph.memoryOwners.assertWritable(o,await graph.memoryOwners.owner(await get(nodeId,o)),nodeId);
    if(topology)await authorizeIncidentAssociations(nodeId,o,g);
  };
  tool('memory_capabilities','Discover the actual direct tools and advanced actions. Fetch one advanced schema with memory_action(describe:true).',{},async()=>({
    protocol:'mindpond.layered-memory.v2',instructions:api.instructions,
    directTools:[...operations].filter(([,v])=>v.direct).map(([name])=>name),
    actions:[...operations].filter(([,v])=>!v.direct).map(([name,v])=>({name,description:v.description})),
    capabilities:MEMORY_CAPABILITY_CONTRACT.map(({family,public:routes,note})=>({family,routes,note})),
    administrativeOnly:['model installation/build/activation','global dimensions and retention settings','account-wide raw transcript capture and extraction queues'],
    removedIdentitySelectors:['workspace','domain','personalId','roleId','sessionId'],
    note:'Advanced actions use the same current chat permissions. No host hooks, model calls, raw capture or background organization are installed automatically.'
  }));
  tool('memory_action','Use an advanced Memory action discovered with memory_capabilities. describe:true returns its exact schema. Execution uses this chat’s current identity.',{
    tool:z.string().min(1).max(100),describe:z.boolean().optional(),arguments:z.record(z.string(),z.unknown()).optional()
  },async(a,o,g)=>{
    const entry=operations.get(a.tool);
    if(!entry||a.tool==='memory_action')throw new MindPondError('invalid_input','Unknown Memory tool or recursive action');
    if(a.describe)return {name:a.tool,description:entry.description,inputSchema:z.toJSONSchema(entry.schema)};
    return execute(a.tool,a.arguments??{},o,g);
  });
  action('memory_dimension_policy','Read configured dimensions, meanings and current classification instructions.',{},async()=>graph.getDimensionPolicy());
  action('memory_retrieval_status','Read actual vector readiness and text fallback status; installs or downloads nothing.',{},async()=>({...retrievalStatus(),coverage:graph.retrievalCoverage()}));
  action('memory_retrieval_profiles','Discover configured retrieval and reranking profiles and coverage before choosing a profile.',{},async()=>graph.retrievalProfiles());
  action('memory_retrieval_devices','Inspect inference backend and device availability without installing anything.',{},async()=>graph.retrievalDevices());
  action('memory_spaces','Discover authorized semantic spaces/types. These organize knowledge and cannot select an identity.',{},async(_a,o)=>graph.listSpaces(await context(o)));
  action('memory_membership_add','Place an authorized canonical body in an independent semantic space/type; no copy, identity change or cross-owner access.',{nodeId:id,spaceId:z.string().min(1).max(128),memoryType:z.string().min(1).max(128)},async(a,o,g)=>{
    const authorize=()=>writable(a.nodeId,o,g);await authorize();
    return {membership:await graph.addMembership(a.nodeId,a.spaceId,a.memoryType,undefined,await context(o),authorize)};
  });
  action('memory_host_snapshot','Read authorized graph statistics or a bounded semantic graph window.',{view:z.enum(['stats','graph']),limit:z.number().int().min(1).max(200).optional(),includeEvents:z.boolean().optional()},async(a,o)=>a.view==='stats'?graph.getStats(await context(o)):graph.getFullGraph(a.limit??100,undefined,{context:await context(o),includeEvents:a.includeEvents}));
  action('memory_expand','Read one complete authorized memory and record actual recall access; never truncate a knowledge unit.',{nodeId:id},async(a,o)=>{
    await get(a.nodeId,o);return graph.memoryOwners.present((await graph.getNodeById(a.nodeId,{trackAccess:true,context:await context(o)}))!);
  });
  action('memory_neighborhood','Inspect authorized semantic neighbours and provenance separately from query scoring.',{nodeId:id,limit:page.limit},async(a,o)=>{
    await get(a.nodeId,o);return graph.graphNeighborhood(a.nodeId,await context(o),a.limit);
  });
  action('memory_trace','Trace authorized source scenes without turning provenance edges into ripple associations.',{nodeId:id,maxDepth:z.number().int().min(0).max(5).optional(),limit:page.limit},async(a,o)=>{
    await get(a.nodeId,o);return graph.traceMemory(a.nodeId,await context(o),a.maxDepth,a.limit);
  });
  action('memory_event_search','Search preserved authorized source scenes; does not capture transcripts and does not propagate from events.',{...scope,...api.recallOptions,query:z.string().min(1).max(10000)},async(a,o)=>api.search({...a,eventOnly:true,includeEvents:true,includeL0:true,maxDepth:0},o));
  action('memory_history','Read authorized action history and revision summaries. Full snapshots require includeContent:true.',{nodeId:id,before:z.number().int().min(1).optional(),limit:page.limit,includeContent:z.boolean().optional()},async(a,o)=>graph.memoryHistory(a.nodeId,await nodeContext(a.nodeId,o),a.before,a.limit,a.includeContent));
  action('memory_edit_history','Read immutable before/after snapshots of authorized manual edits.',{nodeId:id,limit:page.limit},async(a,o)=>graph.memoryEditHistory(a.nodeId,await nodeContext(a.nodeId,o),a.limit));
  action('memory_edit_restore','Undo an unchanged authorized edit as a new revision. Current locks, memberships and topology are rechecked.',{nodeId:id,revisionId:id,expectedUpdatedAt:z.number().int(),reason},async(a,o,g)=>{
    const authorize=()=>writable(a.nodeId,o,g,true);await authorize();
    return graph.restoreMemoryEdit(a.nodeId,{...a,context:await context(o)},authorize);
  });
  action('memory_profile_get','Expand a knowledge profile’s evidence, parents, coverage and freshness without adding ripple hops.',{membershipId:id,...page,sourceContext:key.optional()},async(a,o)=>{
    const m=await graph.getMembershipById(a.membershipId,await context(o));await get(m.memoryId,o);
    return graph.getProfile(a.membershipId,{...a,context:await context(o)});
  });
  action('memory_profile_history','Read immutable authorized profile revisions.',{membershipId:id},async(a,o)=>{
    const m=await graph.getMembershipById(a.membershipId,await context(o));await get(m.memoryId,o);
    return graph.getProfileHistory(a.membershipId,await context(o));
  });
  action('memory_export','Export authorized complete Markdown records with versions and sources. Stable cursor; not a database backup.',{...scope,afterId:id.optional(),limit:page.limit,maxBytes:z.number().int().min(1024).max(2000000).optional(),includeEvents:z.boolean().optional()},async(a,o)=>graph.exportMemory(await context(o,a.officeId)??{}, {...a,operatorAll:o.kind==='user'&&!a.officeId}));
  action('memory_save_validate','Preview saving, anchors and scored links without creating memories/tasks. Reports indexed issues and possible duplicates; saving rechecks current state.',{...api.write,anchors:z.unknown().optional(),related:api.related,...scope,idempotencyKey:key.optional()},async(a,o,g)=>{
    const target:MemoryOwner=a.officeId?{kind:'office',id:a.officeId}:o;await g();await graph.memoryOwners.assertWritable(o,target);
    const dimensions=a.dimensions??[(await graph.getDimensionPolicy()).defaultDimension];
    const {officeId,...input}=a;
    const {domain,...preview}=await graph.validateMemorySave({...input,dimensions,domain:await graph.memoryOwners.domain(target,false),memberships:dimensions.map((memoryType:string)=>({spaceId:'memory',memoryType}))});
    return {...preview,owner:target};
  });
  action('memory_improvement_list','Read pending correction/co-use suggestions in authorized knowledge; suggestions are not automatic edits.',{limit:page.limit},async(a,o)=>({signals:await graph.listImprovementSignals(await context(o),a.limit)}));
  action('memory_improvement_resolve','Record a reviewed/deferred/dismissed suggestion after checking its evidence. Does not edit knowledge.',{signalId:id,status:z.enum(['reviewed','deferred','dismissed']),reason},async(a,o,g)=>graph.resolveImprovementSignal({...a,context:await context(o)},g));
  const saveInput=z.object({...api.write,...scope,related:api.related}).strict();
  const updateInput=z.object({...api.write,content:api.write.content.optional(),expectedUpdatedAt:z.number().int(),reason}).strict();
  action('memory_finish','Finish a milestone with at most 16 independent saves, versioned edits and use reports. Stable stageId/item IDs yield durable per-item receipts; partial success is explicit.',{
    stageId:key,operations:z.array(z.discriminatedUnion('kind',[
      z.object({id:key,kind:z.literal('save'),input:saveInput}).strict(),
      z.object({id:key,kind:z.literal('update'),nodeId:id,input:updateInput}).strict(),
      z.object({id:key,kind:z.literal('use_report'),input:z.object(memoryUseShape).strict()}).strict()
    ])).max(16)
  },async(a,o,g)=>{
    const hostId=o.kind+':'+o.id,domain=await graph.memoryOwners.domain(o);
    return graph.finishMemoryStage({...a,hostId,runId:'layered',domains:[domain]},async(op,operationKey)=>{
      await g();const original=a.operations.find((r:any)=>r.id===op.id);
      const name=op.kind==='save'?'memory_save':op.kind==='update'?'memory_update':'memory_use_report';
      // Invoke the same authorized handlers, even for a replay. Core writes
      // have durable idempotency and recheck current office/lock permissions.
      const entry=operations.get(name)!;
      return entry.fn({...original.input,...(op.kind==='update'?{nodeId:original.nodeId}:{}),...(op.kind==='use_report'?{reportId:operationKey}:{idempotencyKey:operationKey})},o,g);
    });
  });
  action('memory_organization_policy','Read current evidence-preserving organization rules. Consolidate duplicates; synthesize supported profiles without deleting useful children.',{},async()=>({version:ORGANIZATION_POLICY_VERSION,instructions:ORGANIZATION_POLICY}));
  const members=async(ids:string[],o:Actor)=>{
    const rows=await Promise.all(ids.map(id=>graph.getMembershipById(id)));
    const nodes=await Promise.all(rows.map(m=>get(m.memoryId,o)));
    if(rows.some(m=>m.spaceId!==rows[0].spaceId||m.memoryType!==rows[0].memoryType)||nodes.some(n=>!sameDomain(n.domain,nodes[0].domain)))throw new MindPondError('invalid_input','Organization requires one owner, space and memory type');
    return {rows,nodes};
  };
  action('memory_organization_candidates','Find same-owner/type organization candidates from an authorized membership; no workspace or identity selection.',{membershipId:id,query:z.string().min(1).max(10000).optional(),limit:z.number().int().min(2).max(24).optional()},async(a,o)=>{
    const {rows,nodes}=await members([a.membershipId],o);
    return graph.organizationCandidates({domain:nodes[0].domain,spaceId:rows[0].spaceId,memoryType:rows[0].memoryType,query:a.query,limit:a.limit});
  });
  action('memory_organization_claim','Claim bounded complete material from 1–24 actual-read memberships of one owner/type. Returns the organization policy and snapshot.',{membershipIds:z.array(id).min(1).max(24)},async(a,o,g)=>{
    const selected=await members(a.membershipIds,o);
    const authorize=async()=>{await g();await members(a.membershipIds,o);};
    const job=await graph.claimOrganizationJob({domain:selected.nodes[0].domain,spaceId:selected.rows[0].spaceId,memoryType:selected.rows[0].memoryType,membershipIds:a.membershipIds},authorize);
    return organizationTask(job);
  });
  const jobAccess=async(jobId:string,o:Actor,g:Guard,plan?:any)=>{
    await g();const job=await graph.getOrganizationJob(jobId);
    if(!job)throw new MindPondError('not_found','Organization job not found');
    for(const m of job.members)await get(m.memory.id,o);
    if(plan)for(const op of plan.operations){
      if(['keep','defer'].includes(op.kind))continue;
      const ids=[...op.membershipIds,...(op.targetMembershipId?[op.targetMembershipId]:[])];
      for(const memberId of ids){
        const m=job.members.find(m=>m.membership.id===memberId);
        if(!m)throw new MindPondError('invalid_input','Plan references a member outside the claimed snapshot');
        await writable(m.memory.id,o,g,op.kind==='consolidate');
      }
    }
    return job;
  };
  action('memory_organization_validate','Preview a claimed plan and any removed associations; rejects changed snapshots and unauthorized targets.',{jobId:id,plan:organizationPlanSchema},async(a,o,g)=>graph.validateOrganizationPlan(a.jobId,a.plan,()=>jobAccess(a.jobId,o,g,a.plan).then(()=>{})));
  action('memory_organization_commit','Atomically commit evidence-preserving associate/reanchor/consolidate/synthesize operations. Current identity, office locks and evictions are rechecked.',{jobId:id,plan:organizationPlanSchema},async(a,o,g)=>{
    await jobAccess(a.jobId,o,g,a.plan);
    return graph.commitOrganizationPlan(a.jobId,a.plan,undefined,undefined,{...associationHooks(o,g),authorize:()=>jobAccess(a.jobId,o,g,a.plan).then(()=>{})});
  });
  action('memory_organization_renew','Renew a currently authorized, unexpired organization lease.',{jobId:id},async(a,o,g)=>({leaseExpiresAt:await graph.renewOrganizationJob(a.jobId,()=>jobAccess(a.jobId,o,g).then(()=>{}))}));
  action('memory_organization_release','Release authorized unused organization material.',{jobId:id},async(a,o,g)=>{await graph.releaseOrganizationJob(a.jobId,()=>jobAccess(a.jobId,o,g).then(()=>{}));return {released:true};});
  const requestAccess=async(requestId:string,o:Actor,g:Guard)=>{
    await g();const request=await graph.organizationRequests.getRequest(requestId);
    if(!request)throw new MindPondError('not_found','Organization request not found');
    const ctx=await context(o);
    if(ctx&&!ctx.domains?.some(d=>sameDomain(d,request.domain)))throw new MindPondError('scope_denied','Organization request is outside current knowledge');
    return request;
  };
  action('memory_organization_requests','List authorized durable organization requests and their honest coverage receipts.',{limit:page.limit},async(a,o)=>graph.organizationRequests.listRequests(await context(o),a.limit));
  action('memory_organization_request_start','Start a bounded organization pass over the fixed candidate watermark of one authorized membership’s owner/space/type.',{membershipId:id,batchSize:z.number().int().min(1).max(24).optional(),limit:z.number().int().min(1).max(500).optional(),idempotencyKey:key},async(a,o,g)=>{
    const {rows,nodes}=await members([a.membershipId],o);
    const authorize=async()=>{await g();await members([a.membershipId],o);};
    return graph.organizationRequests.createRequest({domain:nodes[0].domain,spaceId:rows[0].spaceId,memoryType:rows[0].memoryType,batchSize:a.batchSize,limit:a.limit,idempotencyKey:a.idempotencyKey},authorize);
  });
  action('memory_organization_request_next','Resume an authorized request and claim its next bounded snapshot. Waiting and partial are explicit, never reported as completed.',{requestId:id},async(a,o,g)=>{
    const authorize=()=>requestAccess(a.requestId,o,g).then(()=>{});await authorize();
    const r=await graph.organizationRequests.nextBatch(a.requestId,{},authorize);
    return {...r,...('batch' in r&&r.batch?{task:organizationTask(r.batch)}:{})};
  });
  action('memory_organization_request_status','Read an authorized request’s coverage, progress and terminal receipt.',{requestId:id},async(a,o,g)=>requestAccess(a.requestId,o,g));
  action('memory_organization_request_events','Read a stable sequence page of authorized organization request events.',{requestId:id,afterSeq:z.number().int().min(0).optional(),limit:page.limit},async(a,o,g)=>{await requestAccess(a.requestId,o,g);return graph.organizationRequests.listEvents(a.requestId,a);});
  action('memory_organization_request_report','Conclude an actual batch of an authorized request. Mutation counts derive from committed results, not a host claim.',{requestId:id,jobId:id,result:z.enum(['committed','no_change','deferred','failed','released']),reason:reason.optional()},async(a,o,g)=>{
    const authorize=async()=>{await requestAccess(a.requestId,o,g);await jobAccess(a.jobId,o,g);};await authorize();
    return graph.organizationRequests.reportBatch(a.requestId,a.jobId,a,authorize);
  });
  action('memory_organization_request_finish','Finish an authorized request with explicit uncovered members after its budget ends. In-flight batches must be concluded first.',{requestId:id,reason:key,detail:reason.optional()},async(a,o,g)=>graph.organizationRequests.finishRequest(a.requestId,a,()=>requestAccess(a.requestId,o,g).then(()=>{})));
  action('memory_organization_request_cancel','Cancel an authorized request; committed knowledge and terminal receipts are retained.',{requestId:id,reason:key},async(a,o,g)=>graph.organizationRequests.cancelRequest(a.requestId,a.reason,()=>requestAccess(a.requestId,o,g).then(()=>{})));
  action('memory_source_get','Read the source observation for an actual reference in an authorized memory; observations are isolated by memory owner.',{nodeId:id,uri:sourceReferenceSchema.shape.uri,context:sourceReferenceSchema.shape.context},async(a,o)=>{
    const n=await referenced(a,o);return graph.getSourceObservation(a.uri,a.context,n.domain);
  });
  async function referenced(a:any,o:Actor){const n=await get(a.nodeId,o);if(!n.sourceRefs?.some(r=>r.uri===a.uri&&r.context===a.context))throw new MindPondError('invalid_input','Read and select a source reference recorded in this memory');return n;}
  action('memory_source_observe','Record an actually checked source revision for permitted knowledge. CAS prevents blind overwrite; only this owner’s freshness is affected.',{nodeId:id,...sourceReferenceSchema.shape,status:z.enum(['present','missing']),expectedVersion:z.number().int().min(0)},async(a,o,g)=>{
    const n=await referenced(a,o),authorize=async()=>{await g();await referenced(a,o);};await authorize();
    return graph.observeSource(a,n.domain,authorize);
  });
}
