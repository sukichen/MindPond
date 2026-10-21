/** Optional local inference. Base installations never install a model runtime. */
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
let cachedEntry:{root:string;entry?:string}|undefined;
function runtimeEntry(){
  const root=process.env.MINDPOND_LOCAL_INFERENCE_ROOT??'';
  if(cachedEntry?.root===root){if(!cachedEntry.entry)throw Error('local_runtime_not_installed');return cachedEntry.entry;}
  try{
    // An explicitly selected directory must contain its own installation. Node's
    // parent-directory lookup must not silently select another runtime.
    if(root&&(!existsSync(path.join(root,'package.json'))||!existsSync(path.join(root,'node_modules/@huggingface/transformers/package.json'))))throw Error('local_runtime_not_installed');
    const entry=root?createRequire(path.join(root,'package.json')).resolve('@huggingface/transformers'):import.meta.resolve('@huggingface/transformers');cachedEntry={root,entry};return entry;
  }
  catch(error){cachedEntry={root};throw error;}
}
export function localInferenceStatus(){
  const mode=process.env.MINDPOND_EMBEDDING_MODE??'auto';
  if(!['auto','text'].includes(mode))throw new Error('MINDPOND_EMBEDDING_MODE must be auto or text');
  if(process.env.MINDPOND_LOCAL_INFERENCE_ROOT&&!path.isAbsolute(process.env.MINDPOND_LOCAL_INFERENCE_ROOT))throw Error('MINDPOND_LOCAL_INFERENCE_ROOT must be absolute');
  let installed=false;
  try{runtimeEntry();installed=true;}catch{/* Optional peer is absent in the base installation. */}
  return {mode,installed,enabled:mode!=='text'&&installed,reason:mode==='text'?'text_mode':installed?undefined:'local_runtime_not_installed'};
}
export async function loadLocalTransformers(){
  const state=localInferenceStatus();
  if(!state.enabled)throw new Error(state.reason);
  const entry=runtimeEntry(),runtime=await import(entry.startsWith('file:')?entry:pathToFileURL(entry).href);
  runtime.env.allowRemoteModels=false;runtime.env.allowLocalModels=true;return runtime;
}
/** Resolve the runtime supplied by the explicitly installed inference package,
 * including a nested dependency layout. Do not rely on accidental hoisting. */
export async function loadOnnxRuntime():Promise<any>{
  const state=localInferenceStatus();if(!state.enabled)throw new Error(state.reason);
  const fromTransformers=createRequire(runtimeEntry());
  const module=await import(pathToFileURL(fromTransformers.resolve('onnxruntime-node')).href);
  return module.listSupportedBackends?module:module.default;
}
