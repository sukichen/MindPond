/** One Node worker shares one DB/index. Host-supplied native sessions are
 * authority; agent-authored arguments may only narrow that binding. No LLM. */
import { z } from 'zod';
import { nativeOperationSchema, nativeOperationNames } from './native-operation-schemas.js';
import { GraphMemory } from '../core/graph-memory.js';
import { MemoryPipelineManager } from '../core/memory-pipeline.js';
import { hostOperations, organizationPlanSchema } from '../core/host-contract.js';
import { memorySavePolicyPayload } from '../core/save-policy.js';
import { organizationTask, organizationPolicyPayload } from '../core/organization-policy.js';
import { recallEntry } from '../core/context-assembly.js';
import { exposesMcpTool } from '../core/mcp-tool-profile.js';
import { narrowTrustedContext, narrowTrustedSaveContext, narrowTrustedDomain, narrowTrustedDomains, narrowTrustedSession, type TrustedCallContext } from '../core/trust.js';
import { authorizeOrganizationAccess } from '../core/organization-access.js';
import { normalizeDomain, type MemoryDomainRef } from '../core/domain.js';
import { MindPondError } from '../core/errors.js';

export class HostSessionService {
  private pipeline:MemoryPipelineManager;
  private operations:ReturnType<typeof hostOperations>;
  constructor(private graph:GraphMemory,private domains:MemoryDomainRef[],private principal:string) {
    this.pipeline=new MemoryPipelineManager(graph);this.operations=hostOperations(graph);
  }
  async call(sessionId:string,tool:string,args:Record<string,unknown>={}) {
    try {const result=await this.execute(sessionId,tool,args);await this.graph.logAction({action:'host_tool_completed',domain:{kind:'session',id:sessionId},reason:JSON.stringify({tool})});return result;}
    catch(error){await this.graph.logAction({action:'host_tool_failed',domain:{kind:'session',id:sessionId},reason:JSON.stringify({tool})});throw error;}
  }
  private async execute(sessionId:string,tool:string,args:Record<string,unknown>) {
    if(!sessionId || sessionId.length>256)throw new MindPondError('invalid_input','Native session is required');
    if(tool==='memory_native_schema') {
      const name=z.string().min(1).max(128).parse(args.name);
      if(!exposesMcpTool('work',name))throw new MindPondError('scope_denied','Operator/maintenance operations are not available');
      const schema=nativeOperationSchema(name,this.operations);
      if(!schema)throw new MindPondError('invalid_input','No native schema for this operation');
      return {name,description:this.operations.find(op=>op.name===name)?.description,inputSchema:z.toJSONSchema(schema,{unrepresentable:'any'}),runtimeBoundFields:['hostId','runId','sessionId'],note:'Identity is supplied by the native runtime; supplied domain/context fields can only narrow the host grant. Describe does not execute the operation.'};
    }
    if(!exposesMcpTool('work',tool))throw new MindPondError('scope_denied','Native work adapter does not grant operator/maintenance authority');
    const trusted:TrustedCallContext={v:1,principal:this.principal,domains:this.domains,sessionId,operator:false,issuedAt:Date.now(),expiresAt:Date.now()+60000};
    const context=narrowTrustedContext(trusted,args);
    if(context==='operator')throw new MindPondError('scope_denied','No operator capability');
    const a={...args};
    if(['memory_brief','memory_search','memory_event_search','memory_use_report','memory_finish'].includes(tool))Object.assign(a,{hostId:this.principal,runId:sessionId});
    const op=this.operations.find(op=>op.name===tool);
    if(tool.startsWith('memory_organization_'))await authorizeOrganizationAccess(this.graph,a,trusted);
    if(op && tool==='memory_capabilities')return {
      ...await op.run(op.schema.parse({})),
      hostConnection:{
        kind:'opencode-native',sessionId,domains:this.domains,toolProfile:'work',identitySuppliedBy:'runtime',
        availableOperations:nativeOperationNames(this.operations).filter(name=>exposesMcpTool('work',name)&&name!=='memory_session_state'),
        schemaDiscovery:'Call memory_action with tool:<name>, describe:true to read one input schema before execution.',
      },
    };
    if(op) {
      const shape=op.schema.shape as Record<string,unknown>;
      if('sessionId' in shape)a.sessionId=narrowTrustedSession(trusted,a.sessionId);
      if('domains' in shape)a.domains=narrowTrustedDomains(trusted,a.domains,a.sessionId as string|undefined);
      if('domain' in shape)a.domain=narrowTrustedDomain(trusted,normalizeDomain(a.domain,context.sessionId),context.sessionId);
      if(tool==='memory_save_validate')Object.assign(a,narrowTrustedSaveContext(trusted,args));
      return op.run(op.schema.parse(a),context);
    }
    if(['memory_organization_claim','memory_organization_validate','memory_organization_commit','memory_organization_release','memory_organization_renew','memory_association_upsert','memory_association_review','memory_extraction_commit'].includes(tool))Object.assign(a,nativeOperationSchema(tool,this.operations)!.parse(a));
    switch(tool) {
      case 'memory_search': {
        if(typeof a.query!=='string'||!a.query.trim()||a.query.length>10000)throw new MindPondError('invalid_input','query requires 1–10000 characters');
        const recall=await this.graph.recall({...a,...context,query:a.query,contextBudgetBytes:typeof a.contextBudgetBytes==='number'?a.contextBudgetBytes:12000});
        return {...recall,results:recall.results.map(recallEntry)};
      }
      case 'memory_get': case 'memory_expand': {
        if(typeof a.nodeId!=='string')throw new MindPondError('invalid_input','nodeId required');
        const node=await this.graph.getNodeById(a.nodeId,{trackAccess:true,context});
        if(!node)throw new MindPondError('scope_denied','Memory unavailable in current readable scope');
        return {...node,embedding:undefined};
      }
      case 'memory_connections': {
        if(typeof a.nodeId!=='string')throw new MindPondError('invalid_input','nodeId required');
        return (await this.graph.getConnections(a.nodeId,context)).map(link=>({...link,node:{...link.node,embedding:undefined}}));
      }
      case 'memory_association_upsert': {
        if(typeof a.memberAId!=='string'||typeof a.memberBId!=='string'||typeof a.spaceId!=='string'||typeof a.memoryType!=='string'||typeof a.weight!=='number'||typeof a.reason!=='string'||typeof a.context!=='string')throw new MindPondError('invalid_input','Association requires both members, space/type, weight, reason and applicability context');
        return {association:await this.graph.upsertAssociation(a.memberAId,a.memberBId,a.spaceId,a.memoryType,a.weight,{reason:a.reason,context:a.context},a.teamAuthorization as string|undefined,context)};
      }
      case 'memory_association_review': {
        if(typeof a.id!=='string'||typeof a.evidenceId!=='string'||!['confirm','retire'].includes(a.decision as string)||typeof a.reason!=='string')throw new MindPondError('invalid_input','Evidence review requires IDs, confirm/retire and reason');
        return this.graph.reviewAssociationEvidence(a.id,a.evidenceId,a.decision as 'confirm'|'retire',a.reason,a.expectedUpdatedAt as number|undefined,a.teamAuthorization as string|undefined,context);
      }
      case 'memory_spaces':return this.graph.listSpaces(context);
      case 'memory_save_policy':return memorySavePolicyPayload(await this.graph.getDimensionPolicy());
      case 'memory_organization_policy':return {policy:organizationPolicyPayload(),dimensionPolicy:await this.graph.getDimensionPolicy()};
      case 'memory_save': {
        const {content,...input}=a;
        const schema=this.operations.find(op=>op.name==='memory_save_validate')!.schema;
        const parsed=schema.parse({...input,content,...narrowTrustedSaveContext(trusted,input)}) as any;
        return this.graph.saveMemory(parsed.content,parsed);
      }
      case 'memory_update': {
        const schema=(await import('../core/finish-schema.js')).memoryFinishSchema();
        // Reuse the exact optimistic update contract, without nested identity.
        const parsed=schema.parse({hostId:this.principal,runId:sessionId,stageId:'direct-update',operations:[{id:'update',kind:'update',nodeId:a.nodeId,input:Object.fromEntries(Object.entries(a).filter(([k])=>!['nodeId','sessionId','domains','scope'].includes(k)))}]});
        const operation=parsed.operations[0];
        if(operation.kind!=='update')throw new Error('Invalid update');
        return this.graph.editMemory(operation.nodeId,{...operation.input,context} as import('../core/graph-memory.js').MemoryEditPatch);
      }
      case 'memory_extraction_job':return this.pipeline.getExtractionJob(context);
      case 'memory_extraction_commit': {
        if(typeof a.jobId!=='string'||typeof a.reply!=='string')throw new MindPondError('invalid_input','jobId and reply required');
        return this.pipeline.commitExtraction(a.jobId,a.reply,typeof a.expectedAttempt==='number'?a.expectedAttempt:1,context);
      }
      case 'memory_organization_claim':return organizationTask(await this.graph.claimOrganizationJob({...a,...narrowTrustedSaveContext(trusted,a)} as any));
      case 'memory_organization_validate':return this.graph.validateOrganizationPlan(String(a.jobId),organizationPlanSchema.parse(a.plan));
      case 'memory_organization_commit':return this.graph.commitOrganizationPlan(String(a.jobId),organizationPlanSchema.parse(a.plan),a.teamAuthorization as string|undefined);
      case 'memory_organization_release':await this.graph.releaseOrganizationJob(String(a.jobId));return {released:true};
      case 'memory_organization_renew':return {leaseExpiresAt:await this.graph.renewOrganizationJob(String(a.jobId))};
      default:throw new MindPondError('invalid_input','Tool not exposed by the native adapter; use the standard MCP connection for this operation');
    }
  }
}
