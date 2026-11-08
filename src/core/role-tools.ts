import { z } from 'zod';
import type { GraphMemory } from './graph-memory.js';
import type { TrustedCallContext } from './trust.js';
import { MindPondError } from './errors.js';
import {MAX_ROLE_GUIDANCE_BYTES} from './roles.js';
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const text = (n: number) => z.string().trim().min(1).max(n);
export const roleReviewSchema = z.object({ applicationId: id, expectedRevision: z.number().int().min(1), action: z.enum(['approve', 'reject']), name: text(120).optional(), introduction: text(4000).optional() });
export const roleConfigureSchema = z.object({ roleId: id, expectedRevision: z.number().int().min(1), name: text(120), introduction: text(4000), state: z.enum(['active', 'disabled']),
  workingGuidance:z.string().trim().max(MAX_ROLE_GUIDANCE_BYTES).refine(v=>Buffer.byteLength(v)<=MAX_ROLE_GUIDANCE_BYTES,
    'Role guidance exceeds 2048 UTF-8 bytes').optional() });
export const roleLinkSchema = z.object({ sender: id, recipient: id, enabled: z.boolean() });
export function roleOperations(graph: GraphMemory) {
  const op = (name: string, description: string, schema: z.ZodObject<any>, run: (i: any, a?: TrustedCallContext, runtime?: import('./collaboration-wait.js').WorkCallRuntime) => Promise<unknown>) => ({ name, description, schema, run });
  return [
    op('role_application', 'Apply for a character when the user asks, e.g. choose your name and describe your programming ability. action=submit requires name,introduction,reason,key; status reads approval; cancel requires applicationId,key. User approves in MindPond frontend. Session identity comes from HTTP MCP host configuration, never pass/read tokens. Do not loop while pending.', z.object({ action: z.enum(['submit', 'status', 'cancel']), name: text(120).optional(), introduction: text(4000).optional(), reason: text(2000).optional(), key: text(256).optional(), applicationId: id.optional() }), async (i, a) => {
      const required = i.action === 'submit' ? ['name', 'introduction', 'reason', 'key'] : i.action === 'cancel' ? ['applicationId', 'key'] : [];
      if (required.some(k => i[k] === undefined)) throw new MindPondError('invalid_input', 'Missing application fields: ' + required.join(', '));
      return graph.roles.application(i, a);
    }),
    op('role_sync', 'Restore your approved role, user-managed role guidance, current office rules, controls and pending work. After context loss, call with no arguments and follow guidanceNextCall or response pages; then use the separate Memory MCP memory_resume. Routine sync can send knownGuidanceRevision if the full guidance is still in context, or includeGuidance=false for task polling. Pass afterTaskChange to advance a handled task change. Identity comes from the host.', z.object({
      afterTaskChange:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      includeGuidance:z.boolean().optional(),knownGuidanceRevision:z.string().regex(/^[a-f0-9]{64}$/).optional(),
      guidanceCursor:z.string().regex(/^[a-f0-9]{64}:[1-9][0-9]{0,8}$/).optional()
    }), (_, a) => graph.roles.sync(a)),
  ];
}
