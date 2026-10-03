/** Model semantics are separate from hardware and index implementation. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export const embeddingProfileSchema = z.object({
  id:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).refine(id=>id!=='legacy'),
  label:z.string().min(1).max(128), model:z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  revision:z.string().min(1).max(128).default('local'),
  dimensions:z.number().int().min(1).max(4096),
  pooling:z.enum(['mean','cls']).default('mean'), normalize:z.literal(true).default(true),
  dtype:z.enum(['q8','q4','fp32','fp16']).default('q8'),
  queryPrefix:z.string().max(512).default(''), documentPrefix:z.string().max(512).default(''),
  anchorInput:z.enum(['query','document']).default('query'),
  maxLength:z.number().int().min(32).max(8192).default(512),
  maxChunks:z.number().int().min(1).max(128).default(64),
  chunkOverlap:z.number().int().min(0).max(128).default(32),
}).strict().refine(p=>p.chunkOverlap<p.maxLength/2,{message:'chunkOverlap must be less than half maxLength'});
export type EmbeddingProfile = z.infer<typeof embeddingProfileSchema>;
export const embeddingRuntimeSchema=z.object({
  device:z.enum(['cpu','auto','cuda','webgpu']).default('cpu'),
  fallbackToCpu:z.boolean().default(true), timeoutMs:z.number().int().min(1000).max(300000).default(60000),
  algorithm:z.enum(['exact','hnsw']).default('exact'),
  efSearch:z.number().int().min(10).max(4096).default(128),
}).strict();
export type EmbeddingRuntime = z.infer<typeof embeddingRuntimeSchema>;
export const rerankerProfileSchema=z.object({
  id:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),label:z.string().min(1).max(128),
  model:z.string().regex(/^[\w.-]+\/[\w.-]+$/),revision:z.string().min(1).max(128).default('local'),
  dtype:z.enum(['q8','q4','fp32','fp16']).default('q8'),
  maxLength:z.number().int().min(32).max(8192).default(512),
  maxCandidates:z.number().int().min(2).max(100).default(32),
}).strict();
export type RerankerProfile=z.infer<typeof rerankerProfileSchema>;
export const retrievalConfigSchema=z.object({
  profiles:z.array(z.object({profile:embeddingProfileSchema,runtime:embeddingRuntimeSchema.default(()=>embeddingRuntimeSchema.parse({}))}).strict()).max(8).default([]),
  buildOnStartup:z.boolean().default(false),
  defaultProfile:z.string().default('legacy'),
  rerankers:z.array(z.object({profile:rerankerProfileSchema,runtime:embeddingRuntimeSchema.default(()=>embeddingRuntimeSchema.parse({}))}).strict()).max(2).default([]),
}).strict().superRefine((c,ctx)=>{
  if(new Set(c.profiles.map(p=>p.profile.id)).size!==c.profiles.length)ctx.addIssue({code:'custom',message:'Duplicate profile IDs'});
  if(new Set(c.rerankers.map(p=>p.profile.id)).size!==c.rerankers.length)ctx.addIssue({code:'custom',message:'Duplicate reranker IDs'});
  if(c.defaultProfile!=='legacy' && !c.profiles.some(p=>p.profile.id===c.defaultProfile))ctx.addIssue({code:'custom',message:'defaultProfile must name a configured profile or legacy'});
});
export type RetrievalConfig = z.infer<typeof retrievalConfigSchema>;
export type RetrievalConfigInput = z.input<typeof retrievalConfigSchema>;
export async function loadRetrievalConfig(input?:RetrievalConfigInput):Promise<RetrievalConfig>{
  const value=input ?? (process.env.MINDPOND_EMBEDDING_CONFIG?JSON.parse(await readFile(process.env.MINDPOND_EMBEDDING_CONFIG,'utf8')):{});
  return retrievalConfigSchema.parse(value);
}
export function embeddingSpaceKey(profile:EmbeddingProfile,artifactDigest:string):string{
  // Index, device and UI label do not change the embedding space.
  const {id,label,...semantics}=profile;
  return createHash('sha256').update(JSON.stringify({semantics,artifactDigest})).digest('hex');
}
const preset=(id:string,model:string,dimensions:number,pooling:'mean'|'cls',prefix='')=>embeddingProfileSchema.parse({id,label:id,model,dimensions,pooling,queryPrefix:prefix});
export const EMBEDDING_PRESETS:EmbeddingProfile[]=[
  preset('minilm','Xenova/all-MiniLM-L6-v2',384,'mean'),
  preset('bge-small-zh-cls','Xenova/bge-small-zh-v1.5',512,'cls','为这个句子生成表示以用于检索相关文章：'),
  preset('bge-base-zh','Xenova/bge-base-zh-v1.5',768,'cls','为这个句子生成表示以用于检索相关文章：'),
  ...['small','base'].map(size=>embeddingProfileSchema.parse({id:`multilingual-e5-${size}`,label:`multilingual-e5-${size}`,model:`Xenova/multilingual-e5-${size}`,dimensions:size==='small'?384:768,pooling:'mean',queryPrefix:'query: ',documentPrefix:'passage: '})),
  preset('bge-m3','Xenova/bge-m3',1024,'cls'),
];
