import { z } from 'zod';
export const domainSchema=z.object({kind:z.enum(['session','personal','team']),id:z.string().min(1).max(256)});
export const sourceReferenceSchema=z.object({uri:z.string().min(1).max(2000),context:z.string().min(1).max(256),revision:z.string().min(1).max(256),fingerprint:z.string().min(1).max(256).optional(),locator:z.string().min(1).max(2000).optional()});
export const dimensionIdSchema=z.string().min(1).max(128).regex(/^[\p{L}\p{N}][\p{L}\p{N}_.:-]*$/u).refine(id=>id!=='event','event is reserved evidence');
export const dimensionsSchema=z.array(dimensionIdSchema).min(1);
export const anchorSchema=z.object({text:z.string().trim().min(1).max(240),basis:z.string().trim().min(1).max(1000),spaceId:z.string().trim().min(1).max(128),memoryType:z.string().trim().min(1).max(128)});
