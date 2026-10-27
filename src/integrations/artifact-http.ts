/** Authenticated byte plane; no Base64, JSON file payloads, or business logic. */
import type express from 'express';
import type {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {GraphMemory} from '../core/graph-memory.js';
import type {TrustedCallContext} from '../core/trust.js';
import {MindPondError,httpStatus,toStructuredError} from '../core/errors.js';
export function mountArtifactTransfers(app:express.Express,graph:GraphMemory,authorize:(req:express.Request,res:express.Response)=>Promise<{actor:TrustedCallContext;recheck:()=>Promise<void>}>) {
 const active=new Map<AbortController,Promise<void>>();let closing=false;
 app.all('/artifacts/:artifactId/content',async(req,res)=>{
  let complete!:()=>void,controller:AbortController|undefined,stream:Readable|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const disconnected=()=>{if(!res.writableEnded)controller?.abort();};
  try{
   if(closing)throw new MindPondError('temporarily_unavailable','Server is closing');
   if(!['PUT','GET','HEAD'].includes(req.method)){res.setHeader('Allow','GET, HEAD, PUT');res.status(405).json(new MindPondError('invalid_input','Use GET, HEAD or PUT for artifact bytes').toJSON());return;}
   if(active.size>=8)throw new MindPondError('temporarily_unavailable','File transfer limit reached; retry with the same artifactId');
   controller=new AbortController();active.set(controller,new Promise<void>(r=>complete=r));
   res.once('close',disconnected);timer=setTimeout(()=>controller?.abort(),300000);timer.unref();
   const id=String(req.params.artifactId);
   if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))throw new MindPondError('invalid_input','artifactId must be an immutable artifact UUID',{field:'artifactId'});
   const {actor,recheck}=await authorize(req,res);
   if(req.method==='PUT'){
    if(req.header('content-encoding')&&req.header('content-encoding')!=='identity')throw new MindPondError('invalid_input','Send unencoded original file bytes; compression changes the SHA-256');
    const metadata=await graph.artifacts.run({action:'get',artifactId:id},actor),length=req.header('content-length');
    if(length!==undefined&&Number(length)!==metadata.artifact.size)throw new MindPondError('invalid_input','Content-Length must match the reserved byte size',{field:'size'});
    const result=await graph.artifacts.upload(id,req,actor,controller.signal,recheck);
    res.status(result.replayed?200:201).json(result);return;
   }
   await recheck();
   const download=await graph.artifacts.download(id,actor);stream=download.stream;
   const meta=download.artifact;
   res.setHeader('Content-Type',meta.mime);res.setHeader('Content-Length',String(meta.size));
   res.setHeader('Content-Disposition',"attachment; filename=\"download\"; filename*=UTF-8''"+encodeURIComponent(meta.filename).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase()));
   res.setHeader('ETag','"sha256-'+meta.sha256+'"');res.setHeader('X-Artifact-SHA256',meta.sha256);
   res.setHeader('Accept-Ranges','none');res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
   if(req.method==='HEAD'){stream.destroy();res.end();return;}
   // Node pipeline applies backpressure, so memory does not scale with file size.
   await pipeline(stream,res,{signal:controller.signal});
  }catch(error){
   if(!res.headersSent&&!res.destroyed){const e=toStructuredError(error);if(req.method==='PUT')res.setHeader('Connection','close');res.status(httpStatus(e.code)).json({error:e.message,...e});}
   else if(!res.writableEnded)res.destroy();
  }finally{stream?.destroy();clearTimeout(timer);res.removeListener('close',disconnected);if(controller){active.delete(controller);complete();}}
 });
 return {async close(){closing=true;for(const controller of active.keys())controller.abort();await Promise.allSettled([...active.values()]);}};
}
