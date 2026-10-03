/** On-demand native operation discovery: shared host schemas are reused;
 * handwritten MCP-compatible operations keep their input contract here. */
import { z } from 'zod';
import { domainSchema } from '../core/host-schemas.js';
import { memoryFinishSchema } from '../core/finish-schema.js';
import { organizationPlanSchema, type hostOperations } from '../core/host-contract.js';
const id=z.string().min(1),job=z.object({jobId:id});
const node=z.object({nodeId:id});
const empty=z.object({});
const manual:Record<string,z.ZodObject<any>>={
  memory_search:z.object({retrievalProfile:z.string().min(1).max(64).optional(),vectorAlgorithm:z.enum(['exact','hnsw']).optional(),reranker:z.string().min(1).max(64).optional(),query:z.string().min(1).max(10000),queries:z.array(z.string().min(1).max(10000)).max(4).optional(),limit:z.number().int().min(1).max(50).optional(),candidateLimit:z.number().int().min(1).max(500).optional(),contextBudgetBytes:z.number().int().min(32).max(2000000).optional(),spaceId:z.string().optional(),memoryType:z.string().optional()}),
  memory_get:node,memory_expand:node,memory_connections:node,memory_spaces:empty,
  memory_save_policy:empty,memory_organization_policy:empty,memory_extraction_job:empty,
  memory_update:memoryFinishSchema().shape.operations.element.options[1].shape.input.extend({nodeId:id}),
  memory_extraction_commit:z.object({jobId:id,reply:z.string(),expectedAttempt:z.number().int().min(1).optional()}),
  memory_organization_claim:z.object({domain:domainSchema.optional(),spaceId:z.string(),memoryType:z.string(),maxMembers:z.number().min(2).max(24).optional(),membershipIds:z.array(z.string()).min(1).max(24).optional()}),
  memory_organization_validate:job.extend({plan:organizationPlanSchema}),
  memory_organization_commit:job.extend({plan:organizationPlanSchema,teamAuthorization:z.string().optional()}),
  memory_organization_release:job,memory_organization_renew:job,
  memory_association_upsert:z.object({memberAId:id,memberBId:id,spaceId:id,memoryType:id,weight:z.number().min(0).max(1),reason:z.string().trim().min(1).max(2000),context:z.string().trim().min(1).max(2000),teamAuthorization:z.string().optional()}),
  memory_association_review:z.object({id,evidenceId:id,decision:z.enum(['confirm','retire']),reason:z.string().trim().min(1).max(2000),expectedUpdatedAt:z.number().optional(),teamAuthorization:z.string().optional()}),
};
export function nativeOperationSchema(name:string,operations:ReturnType<typeof hostOperations>) {
  const op=operations.find(op=>op.name===name || (name==='memory_save' && op.name==='memory_save_validate'));
  return op?.schema??manual[name];
}

export function nativeOperationNames(operations:ReturnType<typeof hostOperations>):string[] {
  return [...new Set([...operations.map(op=>op.name),...Object.keys(manual),'memory_save'])];
}
