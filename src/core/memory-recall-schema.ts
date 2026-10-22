import {z} from 'zod';
const id=z.string().min(1).max(160);
/** Shared by HTTP/stdio MCP and the native OpenCode adapter. No identity or
 * workspace selector may enter this retrieval-only parameter set. */
export const layeredRecallShape={
  queries:z.array(z.string().min(1).max(10000)).max(4).optional(),
  dimension:z.union([id,z.array(id).min(1).max(10)]).optional(),memoryType:z.union([id,z.array(id).min(1).max(10)]).optional(),tags:z.array(id).max(16).optional(),
  maxDepth:z.number().int().min(0).max(5).optional(),minScore:z.number().min(0).max(1).optional(),useAnchors:z.boolean().optional(),sourceContext:z.string().min(1).max(256).optional(),
  retrievalProfile:id.optional(),vectorAlgorithm:z.enum(['exact','hnsw']).optional(),reranker:id.optional(),candidateLimit:z.number().int().min(1).max(500).optional(),
  limit:z.number().int().min(1).max(30).optional(),contextBudgetBytes:z.number().int().min(2048).max(65536).optional()
};
