import { z } from 'zod';
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
export const agentConfigurationSchema = z.object({
  id,
  principal: text(128),
  name: text(120),
  host: text(64),
  state: z.enum(['pending', 'active', 'disabled']),
  expectedRevision: z.number().int().min(0)
});
export const projectConfigurationSchema = z.object({
  id,
  title: text(200),
  members: z.array(id).min(1).max(128),
  enabled: z.boolean(),
  expectedRevision: z.number().int().min(0)
});
export const officeConfigurationSchema = z.object({
  id,
  projectId: id.optional(),
  title: text(200),
  goal: z.string().trim().max(4000).optional(),
  acceptance: z.string().trim().max(4000).optional(),
  state: z.enum(['active', 'paused', 'completed', 'cancelled']),
  expectedRevision: z.number().int().min(0),
  deadline: z.number().int().positive().nullable().optional(),
  maxRounds: z.number().int().min(1).max(100).optional(),
  seats: z
    .array(
      z.object({
        id,
        agentId: id,
        roleId: id.optional(),
        label: text(120),
        role: z.string().trim().min(1).max(120).optional()
      })
    )
    .min(0)
    .max(50)
    .optional()
});
