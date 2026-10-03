/** Optional HNSW is an accelerator. Exact filtered search is always available. */
import { VectorIndex } from './vector-index.js';
import type { EmbeddingRuntime } from './embedding-profiles.js';
export interface ProfileVector {id:string;vector:number[];ownerId:string;version?:string}
interface NativeIndex {
  initIndex(size:number,m?:number,efConstruction?:number,seed?:number):void;
  addPoint(vector:number[],label:number):void; setEf(value:number):void;
  searchKnn(vector:number[],k:number,filter?:(label:number)=>boolean):{neighbors:number[];distances:number[]};
}
export class ProfileVectorIndex {
  private exact=new VectorIndex();
  private native?:NativeIndex;
  private rows:Array<Omit<ProfileVector,'vector'>>=[];
  private requested:'exact'|'hnsw'='exact';
  fallbackReason?:string;
  async load(rows:ProfileVector[],runtime:EmbeddingRuntime){
    this.requested=runtime.algorithm;this.native=undefined;this.fallbackReason=undefined;this.exact.clear();
    this.rows=rows.map(({id,ownerId,version})=>({id,ownerId,version}));this.exact.addBatch(rows.map(row=>({id:row.id,vector:row.vector,metadata:{ownerId:row.ownerId,version:row.version}})));
    if(runtime.algorithm!=='hnsw' || !rows.length)return;
    try{
      const moduleName='hnswlib-node';const module=await import(moduleName);
      const addon=module.HierarchicalNSW?module:module.default;
      this.native=new addon.HierarchicalNSW('cosine',rows[0].vector.length);
      this.native!.initIndex(rows.length,16,200,100);
      rows.forEach((row,label)=>this.native!.addPoint(row.vector,label));this.native!.setEf(runtime.efSearch);
    }catch{this.native=undefined;this.fallbackReason='hnsw_unavailable';}
  }
  private unique(hits:Array<{id:string;score:number;ownerId:string;version?:string}>,topK:number){
    const best=new Map<string,(typeof hits)[number]>();
    for(const hit of hits)if(hit.score>(best.get(hit.ownerId)?.score??Number.NEGATIVE_INFINITY))best.set(hit.ownerId,hit);
    return [...best.values()].sort((a,b)=>b.score-a.score).slice(0,topK);
  }
  search(query:number[],eligible:Set<string>,topK:number,minScore:number){
    const scoped=this.rows.filter(row=>eligible.has(row.ownerId)),count=scoped.length;
    const target=Math.min(topK,new Set(scoped.map(row=>row.ownerId)).size);
    if(!target)return [];
    if(this.native){
      try{
        // Long memories have multiple chunks. Increase the candidate window
        // until enough distinct owners are found, rather than letting one
        // long body occupy the whole recall budget.
        let k=Math.min(count,Math.max(target*2,target));
        for(;;){
          const r=this.native.searchKnn(query,k,label=>eligible.has(this.rows[label].ownerId));
          if(!r.neighbors.length||r.distances.some(value=>!Number.isFinite(value)))throw new Error('invalid_hnsw_result');
          const thresholdExhausted=1-r.distances[r.distances.length-1]<minScore;
          const hits=r.neighbors.map((label,i)=>({id:this.rows[label].id,score:1-r.distances[i],ownerId:this.rows[label].ownerId,version:this.rows[label].version})).filter(r=>Number.isFinite(r.score)&&r.score>=minScore);
          const unique=this.unique(hits,target);
          if(unique.length>=target||k===count||thresholdExhausted){this.fallbackReason=undefined;return unique;}
          k=Math.min(count,k*2);
        }
      }catch{this.fallbackReason='hnsw_search_failed';}
    }
    const hits=this.exact.search(query,{topK:count,minScore,filter:item=>eligible.has(String(item.metadata?.ownerId))}).map(r=>({id:r.id,score:r.score,ownerId:String(r.metadata.ownerId),version:r.metadata.version as string|undefined}));
    return this.unique(hits,target);
  }
  status(){return {requested:this.requested,actual:this.native&&!this.fallbackReason?'hnsw':'exact',fallbackReason:this.fallbackReason};}
}
