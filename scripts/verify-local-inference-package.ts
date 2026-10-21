/** Explicit optional-runtime install with its own pins; no model or user data. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {LocalProfileEncoder} from '../src/core/profile-embedding.js';
import {embeddingProfileSchema,embeddingRuntimeSchema} from '../src/core/embedding-profiles.js';
const exec=promisify(execFile),dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-local-runtime-'));
const previousRoot=process.env.MINDPOND_LOCAL_INFERENCE_ROOT,previousMode=process.env.MINDPOND_EMBEDDING_MODE,previousModels=process.env.EMBEDDING_MODEL_DIR;
try{
 for(const name of ['package.json','npm-shrinkwrap.json'])await fs.copyFile('examples/local-inference/'+name,path.join(dir,name));
 await exec('npm',['ci','--offline','--no-audit','--no-fund'],{cwd:dir,env:{...process.env,ONNXRUNTIME_NODE_INSTALL:'skip'},timeout:180000,maxBuffer:4_000_000});
 process.env.MINDPOND_LOCAL_INFERENCE_ROOT=dir;process.env.MINDPOND_EMBEDDING_MODE='auto';
 const {localInferenceStatus,loadOnnxRuntime,loadLocalTransformers}=await import('../src/core/local-inference.js');
 assert(localInferenceStatus().installed);assert(localInferenceStatus().enabled);
 const transformers=await loadLocalTransformers();assert.equal(typeof transformers.pipeline,'function');
 const ort=await loadOnnxRuntime();assert(ort.listSupportedBackends().some((b:any)=>b.name==='cpu'&&b.bundled));
 process.env.EMBEDDING_MODEL_DIR=path.join(dir,'missing-models');
 const worker=new LocalProfileEncoder(embeddingProfileSchema.parse({id:'missing',label:'Fictional missing model',model:'fixture/not-installed',dimensions:3}),embeddingRuntimeSchema.parse({device:'cuda',fallbackToCpu:true,timeoutMs:15000}));
 try{
  await assert.rejects(worker.encode('Public optional runtime fixture','query'),/model_unavailable/);
  const attempts=worker.status().attempts as Array<{device:string}>;assert(attempts.some(a=>a.device==='cuda'));assert(attempts.some(a=>a.device==='cpu'));
 }finally{await worker.close();}
 const pkg=JSON.parse(await fs.readFile(path.join(dir,'node_modules/@huggingface/transformers/package.json'),'utf8'));assert.equal(pkg.version,'4.3.0');
 async function bytes(directory:string):Promise<number>{let sum=0;for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())sum+=await bytes(file);else if(entry.isFile())sum+=(await fs.stat(file)).size;}return sum;}
 console.log(JSON.stringify({optionalRuntime:'@huggingface/transformers@4.3.0',nodeModulesBytes:await bytes(path.join(dir,'node_modules')),scope:'separate locked offline install, real Transformers and CPU backend loading; no model inference or production acceptance'}));
}finally{if(previousRoot===undefined)delete process.env.MINDPOND_LOCAL_INFERENCE_ROOT;else process.env.MINDPOND_LOCAL_INFERENCE_ROOT=previousRoot;if(previousMode===undefined)delete process.env.MINDPOND_EMBEDDING_MODE;else process.env.MINDPOND_EMBEDDING_MODE=previousMode;if(previousModels===undefined)delete process.env.EMBEDDING_MODEL_DIR;else process.env.EMBEDDING_MODEL_DIR=previousModels;await fs.rm(dir,{recursive:true,force:true});}
