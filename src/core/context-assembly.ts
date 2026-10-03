/** Deterministic, model-free assembly. A budget never truncates a knowledge unit. */
import type { SearchResult } from './graph-memory.js';
import { MindPondError } from './errors.js';

/** Shared wire shape makes the budget identical for HTTP and MCP. */
export function recallEntry(r:SearchResult) {
  return {id:r.node.id,domain:r.node.domain,dimension:r.node.dimension,dimensions:r.node.dimensions,kind:r.node.kind,
    matchedAnchors:r.matchedAnchors,dimensionBridges:r.dimensionBridges,layer:r.node.layer,content:r.node.content,
    importance:r.node.importance,tags:r.node.tags,score:r.score,...(r.rerankScore===undefined?{}:{rerankScore:r.rerankScore}),depth:r.depth,path:r.path,membershipPath:r.membershipPath,
    associationPath:r.associationPath,spaceId:r.spaceId,memoryType:r.memoryType,sourceRefs:r.node.sourceRefs,
    profiles:r.node.profiles,freshness:r.freshness,nearDuplicates:r.nearDuplicates};
}
export interface RecallBudget {
  unit:'utf8_bytes'; limit:number; used:number; candidates:number; selected:number;
  omitted:Array<{memoryId:string;reason:'over_budget'|'result_limit'}>;
  appliesTo:'JSON.stringify({results})';
}
export function validateContextBudget(budget:unknown): asserts budget is number|undefined {
  if(budget!==undefined&&(!Number.isInteger(budget)||Number(budget)<32||Number(budget)>2000000))
    throw new MindPondError('invalid_input','contextBudgetBytes must be an integer from 32 to 2000000',{field:'contextBudgetBytes',nextAction:'Choose a byte budget for complete result records; this is not an exact tokenizer count.'});
}
export function assembleRecall(results:SearchResult[],limit:number,maxRecords=500) {
  validateContextBudget(limit);
  const unique=new Map<string,SearchResult>();
  for(const r of results) {const old=unique.get(r.node.id);if(!old||r.score>old.score)unique.set(r.node.id,r);}
  const ordered=[...unique.values()].sort((a,b)=>a.rerankScore!==undefined&&b.rerankScore!==undefined?b.rerankScore-a.rerankScore||b.score-a.score:
    a.rerankScore!==undefined?-1:b.rerankScore!==undefined?1:b.score-a.score||a.depth-b.depth||a.node.id.localeCompare(b.node.id));
  const selected:SearchResult[]=[],omitted:RecallBudget['omitted']=[];
  let used=Buffer.byteLength(JSON.stringify({results:[]}),'utf8');
  for(const r of ordered) {
    const added=Buffer.byteLength(JSON.stringify(recallEntry(r)),'utf8')+(selected.length?1:0);
    if(selected.length>=maxRecords)omitted.push({memoryId:r.node.id,reason:'result_limit'});
    else if(used+added>limit)omitted.push({memoryId:r.node.id,reason:'over_budget'});
    else {selected.push(r);used+=added;}
  }
  return {results:selected,contextBudget:{unit:'utf8_bytes',limit,used,candidates:unique.size,selected:selected.length,omitted,appliesTo:'JSON.stringify({results})'} as RecallBudget};
}
