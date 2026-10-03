/** Public local samples: a repeatable smoke comparison, not a quality leaderboard. */
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { EMBEDDING_PRESETS,embeddingProfileSchema,embeddingRuntimeSchema,embeddingSpaceKey } from '../src/core/embedding-profiles.js';
import { LocalProfileEncoder,profileArtifactDigest } from '../src/core/profile-embedding.js';
import { cosineSimilarity } from '../src/core/vector-index.js';
const samples=[
 {query:'本地服务怎样才能用手机访问？',body:'开发服务监听 0.0.0.0 才能从局域网手机访问，监听 127.0.0.1 只接受本机请求。正式部署需要认证。'},
 {query:'修改代码后为什么仍显示旧行为？',body:'源码修改后要重新构建并重启实际运行的进程。已加载的模块不会因为磁盘文件改变自动更新。'},
 {query:'用户是否希望把每个任务过程长期保存？',body:'任务过程先放 session 记忆。仅将有证据、可复用且脱离当前上下文仍完整的结论升级到 personal。'},
 {query:'关联记忆为什么需要记录场景？',body:'两个记忆可能只在特定环境、版本和条件下相关。保存关联时必须保留当时的理由、场景和例外。'},
 {query:'换一个同样维数的 embedding 模型可直接用旧向量吗？',body:'不同 embedding 模型即使输出维数相同，也不能混用向量。模型版本、池化、前缀和量化方式共同定义向量空间。'},
 {query:'How does a failed SQLite transaction affect concurrent work?',body:'Requests sharing one SQLite connection must serialize transaction ownership so an unrelated successful write is not rolled back by another request.'},
 {query:'What happens when a memory source version changes?',body:'Changed source fingerprints make dependent memory need review; a previously used statement must not automatically remain trusted.'},
 {query:'Should graph links cross different projects?',body:'Semantic associations stay inside the same space and memory type. Multi-dimension identity bridges dimensions only inside the same project boundary.'},
];
const minilm=EMBEDDING_PRESETS.find(p=>p.id==='minilm')!,cls=EMBEDDING_PRESETS.find(p=>p.id==='bge-small-zh-cls')!;
const plans=[
 {profile:minilm,device:'cpu' as const},
 {profile:embeddingProfileSchema.parse({...cls,id:'bge-legacy-mean',pooling:'mean',queryPrefix:''}),device:'cpu' as const},
 {profile:cls,device:'cpu' as const},
 {profile:cls,device:'auto' as const},
];
const results=[];
for(const {profile,device} of plans){
 const encoder=new LocalProfileEncoder(profile,embeddingRuntimeSchema.parse({device,timeoutMs:60000}));
 try{
  const artifact=await profileArtifactDigest(profile),start=performance.now();
  const documents=[];
  for(const sample of samples)documents.push((await encoder.encode(sample.body,'document')).vectors[0]);
  const buildMs=performance.now()-start,latencies=[],ranks=[];
  for(let expected=0;expected<samples.length;expected++){
   const started=performance.now(),query=(await encoder.encode(samples[expected].query,'query')).vectors[0];latencies.push(performance.now()-started);
   const ranked=documents.map((vector,id)=>({id,score:cosineSimilarity(query,vector)})).sort((a,b)=>b.score-a.score);
   ranks.push(ranked.findIndex(hit=>hit.id===expected)+1);
  }
  results.push({id:profile.id,spaceKey:embeddingSpaceKey(profile,artifact),model:profile.model,pooling:profile.pooling,requestedDevice:device,runtime:encoder.status(),
   sampleCount:samples.length,top1:ranks.filter(rank=>rank===1).length/samples.length,top3:ranks.filter(rank=>rank<=3).length/samples.length,mrr:ranks.reduce((n,rank)=>n+1/rank,0)/ranks.length,
   buildMs:Number(buildMs.toFixed(2)),warmQueryMs:latencies.map(ms=>Number(ms.toFixed(2)))});
 }catch(error){results.push({id:profile.id,requestedDevice:device,status:'unavailable',code:error instanceof Error?error.message:'model_unavailable',runtime:encoder.status()});}
 finally{await encoder.close();}
}
const report={at:new Date().toISOString(),kind:'public-local-smoke-only',limitations:'Eight hand-written samples do not establish generalized retrieval quality or production latency. No private memory or remote model service was used.',results};
const target=process.env.MINDPOND_PROFILE_EVAL_REPORT??'evals/results/embedding-profiles-local.json';
await fs.writeFile(target,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
