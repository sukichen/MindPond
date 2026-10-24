/** Opt-in synthetic capacity evidence. No host/model/production credentials. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {performance} from 'node:perf_hooks';
import {GraphMemory} from '../src/core/graph-memory.js';
import {releaseInfo} from '../src/core/release-info.js';
const {values}=parseArgs({options:{memories:{type:'string',default:'200'},queries:{type:'string',default:'20'},concurrency:{type:'string',default:'4'},output:{type:'string'}}});
function integer(value:string,max:number){const n=Number(value);if(!Number.isSafeInteger(n)||n<1||n>max)throw Error('Choose positive bounded counts');return n;}
const count=integer(values.memories!,100000),queries=integer(values.queries!,10000),concurrency=integer(values.concurrency!,64);
process.env.MINDPOND_EMBEDDING_MODE='text';process.env.EMBEDDING_ZH_ENABLED='false';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-capacity-')),filename=path.join(directory,'synthetic.db');
let graph=new GraphMemory('.',{dbPath:filename});
const times:number[]=[],rssBefore=process.memoryUsage().rss;
try{
 const init=performance.now();await graph.init();const initMs=performance.now()-init,seed=performance.now();
 for(let i=0;i<count;i++)await graph.saveMemory(`Synthetic capacity record ${i}. Topic${i%20}: verify deployment configuration for sample component ${i}. No real user data.`,{idempotencyKey:'synthetic-'+i});
 const seedMs=performance.now()-seed;await graph.close();const restart=performance.now();graph=new GraphMemory('.',{dbPath:filename});await graph.init();const restartMs=performance.now()-restart;
 let next=0;const started=performance.now();await Promise.all(Array.from({length:concurrency},async()=>{while(next<queries){const index=next++,before=performance.now();await graph.recall({query:'Topic'+index%20,limit:8,candidateLimit:50,contextBudgetBytes:12000});times.push(performance.now()-before);}}));
 const elapsedMs=performance.now()-started,sorted=[...times].sort((a,b)=>a-b),report={kind:'synthetic-text-capacity',release:releaseInfo(),hardware:{cpus:os.cpus().length,cpu:os.cpus()[0]?.model,totalMemory:os.totalmem()},dataset:{memories:count,queries,concurrency},initMs,restartMs,seedMs,elapsedMs,queriesPerSecond:queries/elapsedMs*1000,p50Ms:sorted[Math.ceil(sorted.length*.5)-1],p95Ms:sorted[Math.ceil(sorted.length*.95)-1],rssBefore,rssAfter:process.memoryUsage().rss,databaseBytes:(await fs.stat(filename)).size,retrieval:graph.retrievalCoverage(),limitations:'Single local process, synthetic text-only data, no embeddings/models/HTTP/real hosts. Not a production capacity guarantee or memory-quality evaluation.'};
 const output=JSON.stringify(report,null,2)+'\n';if(values.output)await fs.writeFile(path.resolve(values.output),output,{flag:'wx',mode:0o600});console.log(output);
}finally{await graph.close();await fs.rm(directory,{recursive:true,force:true});}
