import { z } from 'zod';
import {memoryUseShape} from './memory-use-schema.js';
import { domainSchema, dimensionsSchema, sourceReferenceSchema } from './host-schemas.js';
/** Nested operations cannot carry a second trusted context. Ownership remains
 * explicitly checked by the core; HTTP and MCP narrow only the outer binding. */
export function memoryFinishSchema() {
  const save=z.object({content:z.string().min(1).max(100000),dimensions:dimensionsSchema.optional(),dimension:z.string().optional(),
    anchors:z.unknown().optional(),memberships:z.array(z.object({spaceId:z.string().min(1).max(128),memoryType:z.string().max(128).optional()})).max(16).optional(),
    related:z.array(z.object({membershipId:z.string().optional(),memoryId:z.string().optional(),spaceId:z.string().optional(),memoryType:z.string().optional(),score:z.number().min(0).max(1),reason:z.string().min(1).max(2000),context:z.string().min(1).max(2000)})).max(64).optional(),
    importance:z.number().int().min(1).max(10).optional(),tags:z.array(z.string()).max(16).optional(),source:z.string().max(64).optional(),sessionId:z.string().max(256).optional(),domain:domainSchema.optional(),sourceRefs:z.array(sourceReferenceSchema).max(64).optional(),teamAuthorization:z.string().optional()}).strict();
  const update=z.object({content:z.string().min(1).max(100000).optional(),dimensions:dimensionsSchema.optional(),anchors:z.unknown().optional(),importance:z.number().int().min(1).max(10).optional(),tags:z.array(z.string()).max(16).optional(),verified:z.boolean().optional(),expectedUpdatedAt:z.number().int(),sourceRefs:z.array(sourceReferenceSchema).max(64).optional(),reason:z.string().min(1).max(2000),teamAuthorization:z.string().optional()}).strict();
  const report=z.object(memoryUseShape).strict();
  return z.object({hostId:z.string().min(1).max(256),runId:z.string().min(1).max(256),stageId:z.string().min(1).max(256),sessionId:z.string().optional(),domains:z.array(domainSchema).optional(),
    operations:z.array(z.discriminatedUnion('kind',[
      z.object({id:z.string().min(1).max(128),kind:z.literal('save'),input:save}).strict(),
      z.object({id:z.string().min(1).max(128),kind:z.literal('update'),nodeId:z.string().min(1),input:update}).strict(),
      z.object({id:z.string().min(1).max(128),kind:z.literal('use_report'),input:report}).strict(),
    ])).max(16)});
}
