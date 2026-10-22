import {z} from 'zod';
import {sourceReferenceSchema} from './host-schemas.js';

/** One outcome/feedback contract for direct calls, milestones and adapters. */
export const memoryUseShape={
  recallId:z.string().min(1).max(256),task:z.string().min(1).max(1000),
  outcome:z.enum(['completed','partial','failed','unknown']),
  observations:z.array(z.object({memoryId:z.string().min(1).max(160),disposition:z.enum(['used','rejected','unassessed']),
    reason:z.string().min(1).max(2000),issue:z.enum(['incorrect','outdated','incomplete','missing_anchor']).optional(),
    context:z.string().min(1).max(2000).optional(),sourceRefs:z.array(sourceReferenceSchema).max(64).optional()}).strict()).min(1).max(64),
  coUses:z.array(z.object({memoryIds:z.tuple([z.string().min(1),z.string().min(1)]),spaceId:z.string().min(1).max(128),
    memoryType:z.string().min(1).max(128),reason:z.string().min(1).max(2000),context:z.string().min(1).max(2000)}).strict()).max(24).optional()
};
