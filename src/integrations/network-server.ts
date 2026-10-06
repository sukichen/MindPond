import express from 'express';
import type {Server as HttpServer} from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {isInitializeRequest} from '@modelcontextprotocol/sdk/types.js';
import type {GraphMemory} from '../core/graph-memory.js';
import {createMemoryMcpServer} from '../mcp-service.js';
import {authenticateNetworkAccount,type NetworkConfiguration,type NetworkGrant} from './network-config.js';
interface Connection {transport:StreamableHTTPServerTransport;service:ReturnType<typeof createMemoryMcpServer>;grant:NetworkGrant;logicalSession:string;lastUsed:number;active:number;}
export function createNetworkMcpApp(graph:GraphMemory,options:{configuration:()=>Promise<NetworkConfiguration>;allowedHosts:string[];allowedOrigins?:string[];maxConnections?:number;maxPerAccount?:number;idleMs?:number}) {
  if(!options.allowedHosts.length)throw new Error('Explicit allowedHosts are required');
  const app=express();app.disable('x-powered-by');
  const connections=new Map<string,Connection>();let pending=0,closing=false;
  const requests=new Set<Promise<void>>(),retired=new Set<Promise<void>>();
  const retire=(c:Connection)=>{const work=c.service.close();retired.add(work);void work.catch(()=>{}).finally(()=>retired.delete(work));return work;};
  const pendingOwners=new Map<string,number>();
  const max=options.maxConnections??128,perAccount=options.maxPerAccount??8,idleMs=options.idleMs??1800000;
  const remove=async(id:string)=>{const c=connections.get(id);if(!c)return;connections.delete(id);await retire(c);};
  const timer=setInterval(()=>{const now=Date.now();for(const [id,c] of connections)if(!c.active&&now-c.lastUsed>idleMs)void remove(id).catch(()=>{});},Math.min(idleMs,30000));timer.unref();
  app.use((req,res,next)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    if(!options.allowedHosts.includes(req.headers.host??'')){res.status(403).json({error:'Host is not allowed'});return;}
    const origin=req.header('origin');
    if(origin&&!(options.allowedOrigins??[]).includes(origin)){res.status(403).json({error:'Origin is not allowed'});return;}
    next();
  });
  app.all('/mcp',async(req,res,next)=>{
    try {
      if(closing){res.status(503).json({error:'Server is closing'});return;}
      const grant=authenticateNetworkAccount(await options.configuration(),req.header('authorization'));
      if(!grant){res.setHeader('WWW-Authenticate','Bearer realm="MindPond"');res.status(401).json({error:'Invalid account credential'});return;}
      // Rotating a credential must free its obsolete connections immediately,
      // otherwise the valid replacement could be blocked by the account cap.
      await Promise.all([...connections].filter(([,c])=>c.grant.principal===grant.principal&&JSON.stringify(c.grant)!==JSON.stringify(grant)).map(([id])=>remove(id)));
      res.locals.grant=grant;next();
    }catch{res.status(503).json({error:'Account configuration unavailable'});}
  });
  app.use('/mcp',express.json({limit:'1mb'}));
  app.all('/mcp',async(req,res)=>{
    let c:Connection|undefined,newConnection=false,id:string|undefined;
    const grant=res.locals.grant as NetworkGrant;
    let finished!:()=>void;const activeRequest=new Promise<void>(r=>finished=r);requests.add(activeRequest);
    try {
      if(closing){res.status(503).json({error:'Server is closing'});return;}
      const logicalSession=req.header('x-mindpond-session')??'';
      if(logicalSession&&!/^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,127}$/u.test(logicalSession)){res.status(400).json({error:'Invalid host session label'});return;}
      const header=req.header('mcp-session-id');
      if(header){
        c=connections.get(header);id=header;
        // The bearer is checked on EVERY request; a session ID grants nothing.
        if(!c||c.grant.tokenHash!==grant.tokenHash||JSON.stringify(c.grant)!==JSON.stringify(grant)||c.logicalSession!==logicalSession){
          res.status(404).json({error:'MCP session not found for this account'});return;
        }
      } else {
        if(req.method!=='POST'||!isInitializeRequest(req.body)){res.status(400).json({error:'Initialize before making MCP requests'});return;}
        const own=[...connections.values()].filter(v=>v.grant.principal===grant.principal).length+(pendingOwners.get(grant.principal)??0);
        if(connections.size+pending>=max||own>=perAccount){res.status(429).json({error:'Connection limit reached'});return;}
        pending++;pendingOwners.set(grant.principal,(pendingOwners.get(grant.principal)??0)+1);newConnection=true;
        id=randomUUID();
        const sessionId='net:'+createHash('sha256').update(grant.principal).digest('hex').slice(0,40)+':'+(logicalSession?createHash('sha256').update(logicalSession).digest('hex').slice(0,40):randomUUID());
        const service=createMemoryMcpServer(graph,{toolProfile:grant.toolProfile,trusted:{v:1,principal:grant.principal,sessionId,domains:grant.domains,issuedAt:Date.now(),expiresAt:Number.MAX_SAFE_INTEGER}});
        const transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>id!,enableJsonResponse:true});
        c={service,transport,grant,logicalSession,lastUsed:Date.now(),active:0};
        const connectionId=id;
        const created=c;
        transport.onclose=()=>{connections.delete(connectionId);void retire(created).catch(()=>{});};
        await service.server.connect(transport);connections.set(id,c);
      }
      c.active++;c.lastUsed=Date.now();
      try {await c.transport.handleRequest(req,res,req.body);}
      finally {c.active--;c.lastUsed=Date.now();}
      if(newConnection&&!c.transport.sessionId)await remove(id!);
    }catch{
      if(newConnection&&id)await remove(id).catch(()=>{});
      if(!res.headersSent)res.status(500).json({error:'MCP request failed'});
    }finally {
      finished();requests.delete(activeRequest);
      if(newConnection){pending--;pendingOwners.set(grant.principal,Math.max(0,(pendingOwners.get(grant.principal)??1)-1));}
    }
  });
  app.use((_req,res)=>{res.status(404).json({error:'Not found'});});
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{if(!res.headersSent)res.status(400).json({error:'Malformed or oversized request'});});
  return {app,async close(listener?:HttpServer){
    closing=true;clearInterval(timer);
    const stopped=listener?new Promise<void>(resolve=>listener.close(()=>resolve())):Promise.resolve();
    await Promise.allSettled([...requests]);
    await Promise.allSettled([...connections.keys()].map(remove));
    await Promise.allSettled([...retired]);await stopped;
  }};
}
