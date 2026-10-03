/** Optional model inference is isolated from HTTP/MCP's event loop. No remote downloads. */
import { parentPort,workerData } from 'node:worker_threads';
import type { EmbeddingProfile,EmbeddingRuntime } from './embedding-profiles.js';
import {profileArtifactDigest} from './profile-embedding.js';
const {profile,runtime,modelsDir,task}=workerData as {profile:EmbeddingProfile;runtime:EmbeddingRuntime;modelsDir:string;task?:'embedding'|'rerank'};
let pipe:any,actualDevice:string|undefined;
const attempts:Array<{device:string;code:string}>=[];
async function load(){
  if(pipe)return pipe;
  if(workerData.expectedArtifactDigest&&await profileArtifactDigest(profile)!==workerData.expectedArtifactDigest)throw new Error('model_artifact_changed');
  const {pipeline,env}=await import('@huggingface/transformers');
  env.localModelPath=modelsDir;env.allowLocalModels=true;env.allowRemoteModels=false;
  const ort=await import('onnxruntime-node');
  const bundled=ort.listSupportedBackends().filter(b=>b.bundled).map(b=>b.name);
  const devices=runtime.device==='auto'?['cuda','webgpu','cpu'].filter(d=>bundled.includes(d)):[runtime.device];
  if(runtime.fallbackToCpu&&!devices.includes('cpu'))devices.push('cpu');
  for(const device of devices){
    try{
      pipe=await pipeline(task==='rerank'?'text-classification':'feature-extraction',profile.model,{dtype:profile.dtype,device:device as any,local_files_only:true});
      if(task==='rerank')await pipe.model(pipe.tokenizer('warmup',{text_pair:'warmup',truncation:true,max_length:profile.maxLength}));
      else await pipe('warmup',{pooling:profile.pooling,normalize:true,max_length:profile.maxLength,truncation:true});
      actualDevice=device;return pipe;
    }catch{
      attempts.push({device,code:'device_or_model_unavailable'});
      if(pipe)await pipe.dispose().catch(()=>{});pipe=undefined;
    }
  }
  throw new Error('model_unavailable');
}
async function encode(text:string,role:'query'|'document'|'anchor'){
  const model=await load();
  const prefix=role==='query'||role==='anchor'&&profile.anchorInput==='query'?profile.queryPrefix:profile.documentPrefix;
  const tokens=Array.from(model.tokenizer(text,{truncation:false,add_special_tokens:false}).input_ids.data,(x:any)=>Number(x));
  const prefixTokens=model.tokenizer(prefix,{add_special_tokens:false}).input_ids.data.length;
  const window=profile.maxLength-prefixTokens-4;
  if(window<=profile.chunkOverlap)throw new Error('prefix_exceeds_token_budget');
  const texts:string[]=[];
  if(role==='query'){
    if(tokens.length>window)throw new Error('query_exceeds_token_budget');
    texts.push(prefix+text);
  }else if(tokens.length<=window){texts.push(prefix+text);}else{
    for(let start=0;start<tokens.length||start===0;start+=window-profile.chunkOverlap){
      if(texts.length>=profile.maxChunks)throw new Error('document_exceeds_chunk_budget');
      texts.push(prefix+model.tokenizer.decode(tokens.slice(start,start+window),{skip_special_tokens:false}));
      if(start+window>=tokens.length)break;
    }
  }
  const vectors:number[][]=[];
  for(const input of texts){
    const output=await model(input,{pooling:profile.pooling,normalize:true,max_length:profile.maxLength,truncation:true});
    const vector=Array.from(output.data as Float32Array);
    if(vector.length!==profile.dimensions || vector.some(v=>!Number.isFinite(v))||!vector.some(v=>v!==0))throw new Error('invalid_model_vector');
    vectors.push(vector);
  }
  return {vectors,device:actualDevice,attempts};
}
async function rerank(query:string,documents:string[]){
  const model=await load();const vectors:number[][]=[];
  for(const document of documents){
    const inputs=model.tokenizer(query,{text_pair:document,truncation:true,max_length:profile.maxLength});
    const output=await model.model(inputs);const logits=Array.from(output.logits.data as Float32Array);
    const score=logits.length===1?logits[0]:logits.length===2?logits[1]-logits[0]:NaN;
    if(!Number.isFinite(score))throw new Error('invalid_reranker_score');vectors.push([score]);
  }
  return {vectors,device:actualDevice,attempts};
}
let tail=Promise.resolve();
parentPort!.on('message',(message:{id:number;text:string;role:'query'|'document'|'anchor'|'rerank';documents?:string[]})=>{
  tail=tail.then(async()=>{
    try{parentPort!.postMessage({id:message.id,result:message.role==='rerank'?await rerank(message.text,message.documents??[]):await encode(message.text,message.role)});}
    catch(error){parentPort!.postMessage({id:message.id,error:error instanceof Error?error.message:'embedding_failed',attempts});}
  });
});
