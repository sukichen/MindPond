import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createReadStream,existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { defaultModelDirectory } from './runtime-paths.js';
import { fileURLToPath } from 'node:url';
import type { EmbeddingProfile,EmbeddingRuntime } from './embedding-profiles.js';
export type EmbeddingRole='query'|'document'|'anchor';
export interface ProfileEmbeddingResult {vectors:number[][];device?:string;attempts?:Array<{device:string;code:string}>}
export interface ProfileEncoder {encode(text:string,role:EmbeddingRole):Promise<ProfileEmbeddingResult>;close():Promise<void>;status():unknown}
const modelsDir=()=>defaultModelDirectory(fileURLToPath(new URL('../../models',import.meta.url)));
/** Actual model/tokenizer bytes, not just a same-width model name, identify a space. */
export async function profileArtifactDigest(profile:EmbeddingProfile):Promise<string>{
  const root=path.join(modelsDir(),profile.model);
  const suffix=profile.dtype==='fp32'?'':profile.dtype==='q8'?'_quantized':`_${profile.dtype}`;
  const graph=`onnx/model${suffix}.onnx`;
  if(!existsSync(path.join(root,graph)))throw new Error('model_files_missing');
  const files=(await readdir(root)).filter(name=>/\.(json|txt|model)$/.test(name)).sort();
  files.push(graph);
  const onnxFiles=(await readdir(path.join(root,'onnx'))).filter(name=>name.startsWith(`model${suffix}.onnx`)&&name!==path.basename(graph)).sort();
  files.push(...onnxFiles.map(name=>'onnx/'+name));
  const hash=createHash('sha256');
  for(const file of files){hash.update(file+'\0');for await(const chunk of createReadStream(path.join(root,file)))hash.update(chunk);}
  return hash.digest('hex');
}
export class LocalProfileEncoder implements ProfileEncoder {
  private worker?:Worker;private seq=0;private device?:string;private failure?:string;
  private attempts:unknown[]=[];
  private pending=new Map<number,{resolve:(result:ProfileEmbeddingResult)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(private profile:EmbeddingProfile,private runtime:EmbeddingRuntime,private task:'embedding'|'rerank'='embedding',private expectedArtifactDigest?:string){}
  private stop(error:Error){
    this.failure=error.message;
    for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(error);}this.pending.clear();
    const worker=this.worker;this.worker=undefined;return worker?.terminate();
  }
  async encode(text:string,role:EmbeddingRole):Promise<ProfileEmbeddingResult>{
    return this.request(text,role);
  }
  async rerank(query:string,documents:string[]):Promise<ProfileEmbeddingResult>{return this.request(query,'rerank',documents);}
  private async request(text:string,role:EmbeddingRole|'rerank',documents?:string[]):Promise<ProfileEmbeddingResult>{
    if(this.pending.size>=32)throw new Error('embedding_queue_full');
    if(!this.worker){
      let url=new URL('./embedding-profile-worker.js',import.meta.url);
      if(!existsSync(url))url=new URL('../../dist/core/embedding-profile-worker.js',import.meta.url);
      const worker=this.worker=new Worker(url,{workerData:{profile:this.profile,runtime:this.runtime,modelsDir:modelsDir(),task:this.task,expectedArtifactDigest:this.expectedArtifactDigest},execArgv:[]});
      worker.on('message',({id,result,error,attempts})=>{
        const request=this.pending.get(id);if(!request)return;
        clearTimeout(request.timer);this.pending.delete(id);
        if(error){this.failure=error;this.attempts=attempts??[];request.reject(new Error(error));}
        else {this.device=result.device;this.attempts=result.attempts??[];this.failure=undefined;request.resolve(result);}
      });
      worker.on('error',()=>{if(this.worker===worker)this.stop(new Error('embedding_worker_failed'));});
      worker.on('exit',()=>{if(this.worker===worker)this.stop(new Error('embedding_worker_exited'));});
    }
    const id=++this.seq;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{void this.stop(new Error('embedding_timeout'));},this.runtime.timeoutMs);
      this.pending.set(id,{resolve,reject,timer});this.worker!.postMessage({id,text,role,documents});
    });
  }
  status(){return {requestedDevice:this.runtime.device,actualDevice:this.device??'uninitialized',failure:this.failure,attempts:this.attempts};}
  async close(){await this.stop(new Error('embedding_worker_closed'));}
}
