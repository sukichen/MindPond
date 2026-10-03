/** Real local embeddings; isolated DB. Fixtures are diagnostic, not a blinded benchmark. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GraphMemory } from '../src/core/graph-memory.js';
import { getEmbeddingService } from '../src/core/embedding.js';
import { getZhEmbeddingService } from '../src/core/embedding-zh.js';
import type { MemoryAnchor } from '../src/core/anchors.js';

const fixture=JSON.parse(await fs.readFile(process.argv[2] ?? 'evals/anchors/diagnostic.json','utf8')) as {
  memories:Array<{key:string;content:string;anchors:MemoryAnchor[]}>;
  queries:Array<{query:string;relevant:string[];spaceId:string;memoryType:string}>;
  associations?:Array<{a:string;b:string;weight:number}>;
};
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-anchor-eval-'));
process.env.MEMORY_DB_PATH=path.join(dir,'pond.db');
process.env.EMBEDDING_ZH_ENABLED='true';
const g=new GraphMemory();
try {
  await g.init();
  const mainAvailable=(await getEmbeddingService().generateEmbedding('local evaluation probe')).length>0;
  const zhAvailable=(await getZhEmbeddingService().generateEmbedding('中文检索评估')).length>0;
  const ids=new Map<string,string>(),keys=new Map<string,string>(),members=new Map<string,string>();
  for (const m of fixture.memories) {
    const placements=[...new Map(m.anchors.map(a=>[JSON.stringify([a.spaceId,a.memoryType]),{spaceId:a.spaceId,memoryType:a.memoryType}])).values()];
    const r=await g.saveMemory(m.content,{memberships:placements,anchors:m.anchors});
    ids.set(m.key,r.id);keys.set(r.id,m.key);members.set(m.key,r.memberships[0].id);
  }
  for (const a of fixture.associations ?? []) {
    const m=fixture.memories.find(m=>m.key===a.a)!.anchors[0];
    await g.upsertAssociation(members.get(a.a)!,members.get(a.b)!,m.spaceId,m.memoryType,a.weight);
  }
  const modes=[{name:'body-direct',useAnchors:false,maxDepth:0},{name:'anchors-direct',useAnchors:true,maxDepth:0},
    {name:'body-ripple',useAnchors:false,maxDepth:2},{name:'anchors-ripple',useAnchors:true,maxDepth:2}];
  const measurements:any[]=[];
  for (const mode of modes) {
    for (const q of fixture.queries) {
      const started=performance.now();
      const hits=await g.search({...q,...mode,limit:3});
      const returned=hits.map(h=>keys.get(h.node.id)!);
      const correct=returned.filter(id=>q.relevant.includes(id)).length;
      const dcg=returned.reduce((sum,id,i)=>sum+(q.relevant.includes(id)?1/Math.log2(i+2):0),0);
      const ideal=Array.from({length:Math.min(3,q.relevant.length)},(_,i)=>1/Math.log2(i+2)).reduce((a,b)=>a+b,0);
      measurements.push({mode:mode.name,query:q.query,returned,relevant:q.relevant,recall:correct/(q.relevant.length||1),
        precision:correct/(returned.length||1),ndcg:ideal?dcg/ideal:0,latencyMs:performance.now()-started,
        returnedCharacters:hits.reduce((n,h)=>n+h.node.content.length,0)});
    }
  }
  const summary=modes.map(mode=>{
    const rows=measurements.filter(r=>r.mode===mode.name),mean=(field:string)=>rows.reduce((n,r)=>n+r[field],0)/rows.length;
    const latency=rows.map(r=>r.latencyMs).sort((a,b)=>a-b);
    return {mode:mode.name,recallAt3:mean('recall'),precisionAt3:mean('precision'),ndcgAt3:mean('ndcg'),
      meanCharacters:mean('returnedCharacters'),p95Ms:latency[Math.max(0,Math.ceil(latency.length*.95)-1)]};
  });
  const report={fixture:process.argv[2] ?? 'evals/anchors/diagnostic.json',mainAvailable,zhAvailable,
    limitation:'Hand-authored diagnostic fixtures; queries and anchors are not independently authored. Not proof of production improvement. All modes use the corrected ranking.',summary,measurements};
  const destination=process.argv[3] ?? '/tmp/mindpond-anchor-evaluation.json';
  await fs.writeFile(destination,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({mainAvailable,zhAvailable,summary,report:destination},null,2));
} finally {await g.close();await fs.rm(dir,{recursive:true,force:true});}
