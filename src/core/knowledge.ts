/** Classification is independent of ownership and project/session boundaries. */
/** Compatibility default template; the configured registry is authoritative. */
export const KNOWLEDGE_DIMENSIONS = ['fact', 'decision', 'lesson', 'skill'] as const;
export type KnowledgeDimension = string;
import { validDimensionId } from './dimension-config.js';
export function normalizeDimensions(input: unknown, legacy: string): KnowledgeDimension[] {
  if(input===undefined)return legacy==='event'?[]:[legacy];
  if(!Array.isArray(input)||!input.length||input.some(d=>!validDimensionId(d))||new Set(input).size!==input.length)
    throw new Error('dimensions requires distinct configured knowledge identities; event is reserved evidence');
  if(legacy==='event')throw new Error('event is evidence, not a knowledge dimension');
  return [...input].sort();
}
/** Keep the historical SQLite scalar CHECK compatible; dimensions is authoritative. */
export const legacyDimension = (dimension:string) => ['fact','event','decision','lesson'].includes(dimension)?dimension:'fact';
export function dimensionPlacements<T extends {spaceId:string;memoryType?:string}>(placements:T[], dimensions:KnowledgeDimension[], fallback:string, replacedDimensions?:KnowledgeDimension[]):Array<{spaceId:string;memoryType:string}> {
  return [...new Map(placements.flatMap(p=>{
    const type=p.memoryType ?? fallback;
    return (replacedDimensions?.includes(type as KnowledgeDimension) || (dimensions.length>1 && dimensions.includes(type as KnowledgeDimension)) ? dimensions : [type])
      .map(memoryType=>({spaceId:p.spaceId,memoryType}));
  }).map(p=>[JSON.stringify(p),p])).values()];
}
