import {mountArtifactTransfers} from './artifact-http.js';
import type {TrustedCallContext} from '../core/trust.js';
import {RuntimeStatus} from '../core/runtime-status.js';
import {releaseInfo} from '../core/release-info.js';
import express from 'express';
import {createOwnerMemoryServer} from '../role-memory-service.js';
import {hostChatIdentity,verifyHostSession} from './host-correlation.js';
import type { Server as HttpServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { GraphMemory } from '../core/graph-memory.js';
import { MindPondError, httpStatus, httpError } from '../core/errors.js';
import { roleRuntimeId } from '../core/roles.js';
import { createMemoryMcpServer } from '../mcp-service.js';
import {
  authenticateNetworkAccount,
  networkHostId,
  type NetworkConfiguration,
  type NetworkGrant
} from './network-config.js';
interface Connection {
  trusted:TrustedCallContext;
  transport: StreamableHTTPServerTransport;
  service: ReturnType<typeof createMemoryMcpServer>;
  grant: NetworkGrant;
  logicalSession: string;
  connectionIdentity: boolean;
  memory: boolean;
  lastUsed: number;
  active: number;
  waitSignals: Map<string | number, AbortController>;
}
export function createNetworkMcpApp(
  graph: GraphMemory,
  options: {
    configuration: () => Promise<NetworkConfiguration>;
    allowedHosts: string[];
    allowedOrigins?: string[];
    maxConnections?: number;
    maxPerAccount?: number;
    idleMs?: number;
  }
) {
  if (!options.allowedHosts.length) throw new Error('Explicit allowedHosts are required');
  const app = express(),runtime=new RuntimeStatus();
  app.use(runtime.middleware());
  app.disable('x-powered-by');
  const connections = new Map<string, Connection>();
  let pending = 0,
    closing = false;
  const requests = new Set<Promise<void>>(),
    retired = new Set<Promise<void>>();
  const retire = (c: Connection) => {
    const work = c.service.close();
    retired.add(work);
    void work.catch(() => {}).finally(() => retired.delete(work));
    return work;
  };
  const pendingOwners = new Map<string, number>();
  const max = options.maxConnections ?? Number(process.env.MINDPOND_MCP_MAX_CONNECTIONS??128),
    perAccount = options.maxPerAccount ?? Number(process.env.MINDPOND_MCP_MAX_PER_ACCOUNT??64),
    idleMs = options.idleMs ?? 1800000;
  if(![max,perAccount].every(value=>Number.isInteger(value)&&value>=1&&value<=4096))throw new Error('MCP connection limits must be integers from 1 to 4096');
  const remove = async (id: string) => {
    const c = connections.get(id);
    if (!c) return;
    connections.delete(id);
    await retire(c);
  };
  const timer = setInterval(
    () => {
      const now = Date.now();
      for (const [id, c] of connections)
        if (!c.active && now - c.lastUsed > idleMs) void remove(id).catch(() => {});
    },
    Math.min(idleMs, 30000)
  );
  timer.unref();
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!options.allowedHosts.includes(req.headers.host ?? '')) {
      res.status(403).json(httpError('scope_denied','Host is not allowed'));
      return;
    }
    const origin = req.header('origin');
    if (origin && !(options.allowedOrigins ?? []).includes(origin)) {
      res.status(403).json(httpError('scope_denied','Origin is not allowed'));
      return;
    }
    next();
  });
  app.all(['/mcp','/memory/mcp','/artifacts/:artifactId/content'], async (req, res, next) => {
    try {
      if (closing) {
        res.status(503).json(httpError('temporarily_unavailable','Server is closing'));
        return;
      }
      const token=req.header('authorization')?.replace(/^Bearer /,'')??'';
      const pinned=token.startsWith('mpr_')?await graph.memoryOwners.credential(token):null;
      res.locals.memoryRole=pinned;
      const role=pinned?await graph.memoryOwners.role(pinned.role_id):null;
      const grant:NetworkGrant|undefined = pinned ? {principal:role.principal,agentId:role.connector_id,tokenHash:createHash('sha256').update(token).digest('hex'),domains:[{kind:'personal' as const,id:'agent:'+pinned.role_id}],toolProfile:'office' as const,credentialId:pinned.id} : authenticateNetworkAccount(await options.configuration(),req.header('authorization'));
      if (
        !grant ||
        !(await graph.offices.agentAuthority({
          v: 1,
          principal: grant.principal,
          agentId: networkHostId(grant),
          issuedAt: 0,
          expiresAt: Number.MAX_SAFE_INTEGER
        }))
      ) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="MindPond"');
        res.status(401).json(httpError('scope_denied','Invalid account credential'));
        return;
      }
      if(!networkHostId(grant)){
        res.status(403).json({...httpError('identity_required','This account credential is not a registered Office host. Generate a host connection in the workbench.'),humanFallback:false});return;
      }
      // Rotating a credential must free its obsolete connections immediately,
      // otherwise the valid replacement could be blocked by the account cap.
      await Promise.all(
        [...connections]
          .filter(
            ([, c]) =>
              (c.grant.credentialId ?? c.grant.principal) ===
                (grant.credentialId ?? grant.principal) &&
              JSON.stringify(c.grant) !== JSON.stringify(grant)
          )
          .map(([id]) => remove(id))
      );
      res.locals.grant = grant;
      next();
    } catch {
      res.status(503).json(httpError('temporarily_unavailable','Account configuration unavailable'));
    }
  });
  const artifactTransfers=mountArtifactTransfers(app,graph,async(req,res)=>{
    const grant=res.locals.grant as NetworkGrant,pinned=res.locals.memoryRole;
    const token=req.header('authorization')?.replace(/^Bearer /,'')??'';
    const connection=req.header('mcp-session-id')?connections.get(req.header('mcp-session-id')!):undefined;
    if(req.header('mcp-session-id')&&(!connection||JSON.stringify(connection.grant)!==JSON.stringify(grant)))throw new MindPondError('not_found','MCP session not found for this account');
    let actor:TrustedCallContext={v:1,transport:'http-mcp',principal:grant.principal,agentId:networkHostId(grant),credentialId:grant.credentialId,assignmentIds:grant.assignmentIds,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
    const identity=req.header('x-mindpond-identity');if(identity!==undefined&&identity!=='connection')throw new MindPondError('invalid_input','X-MindPond-Identity must be connection');
    if(pinned){const binding=await graph.memoryOwners.roleBinding(pinned.role_id);if(!binding)throw new MindPondError('scope_denied','Role is not connected');actor={...actor,runtimeId:binding.runtime_id,roleId:pinned.role_id,roleBindingId:binding.id,roleBindingEpoch:binding.epoch,runtimeMode:'credential'};}
    else if(identity==='connection'||connection?.connectionIdentity){
      actor={...actor,runtimeId:roleRuntimeId(grant.principal,actor.agentId!,'credential',grant.credentialId??actor.agentId!),runtimeMode:'credential'};
    }else{
      // The host mirrors its per-call MCP metadata. Never infer the last chat on a multiplexed connection.
      const header=req.header('x-mindpond-meta');let meta:Record<string,unknown>={};
      if(header){if(Buffer.byteLength(header)>2048)throw new MindPondError('invalid_input','Host identity metadata exceeds 2KB');try{meta=JSON.parse(header);}catch{throw new MindPondError('invalid_input','X-MindPond-Meta must be a JSON object');}if(!meta||Array.isArray(meta)||typeof meta!=='object')throw new MindPondError('invalid_input','Host identity metadata must be an object');delete meta['mindpond/verifiedSessionID'];}
      const proof=req.header('x-mindpond-host-context');if(proof)meta['mindpond/verifiedSessionID']=verifyHostSession(proof,'office_artifact_transfer',{method:req.method,artifactId:req.params.artifactId},token);
      const chat=hostChatIdentity(meta);
      if(chat)actor={...actor,runtimeId:roleRuntimeId(grant.principal,actor.agentId!,chat.source,chat.id),runtimeMode:chat.mode,nativeChatId:chat.id};
      else if(connection)actor={...connection.trusted};
      else throw new MindPondError('identity_required','Supply the host-configured connection identity, native chat metadata, or the matching MCP session; never choose another role');
    }
    const binding=await graph.roles.binding(actor);actor={...actor,roleId:binding!.role_id,roleBindingId:binding!.id,roleBindingEpoch:binding!.epoch};
    const recheck=async()=>{
      if(pinned){const current=await graph.memoryOwners.credential(token);if(current?.id!==pinned.id)throw new MindPondError('scope_denied','Role credential was revoked');}
      else{const current=authenticateNetworkAccount(await options.configuration(),req.header('authorization'));if(JSON.stringify(current)!==JSON.stringify(grant))throw new MindPondError('scope_denied','Account permission changed during transfer');}
      await graph.roles.binding(actor);
    };
    return {actor,recheck};
  });
  app.use(['/mcp','/memory/mcp'], express.json({ limit: '1mb' }));
  app.all(['/mcp','/memory/mcp'], async (req, res) => {
    let c: Connection | undefined,
      newConnection = false,
      id: string | undefined;
    const grant = res.locals.grant as NetworkGrant;
    const memory=req.path==='/memory/mcp',pinnedMemoryRole=res.locals.memoryRole;
    const waitControllers: Array<[string | number, AbortController]> = [];
    let finished!: () => void;
    const activeRequest = new Promise<void>((r) => (finished = r));
    requests.add(activeRequest);
    let owned = false,
      ended = false;
    const finishRequest = () => {
      if (ended) return;
      ended = true;
      if (!res.writableEnded) for (const [, controller] of waitControllers) controller.abort();
      if (owned && c) {
        c.active--;
        c.lastUsed = Date.now();
        owned = false;
      }
      finished();
      requests.delete(activeRequest);
    };
    // MCP cancellation may intentionally produce no JSON-RPC response. The
    // disconnected HTTP request must still leave the drain/idle accounting.
    res.once('close', finishRequest);
    try {
      if (closing) {
        res.status(503).json(httpError('temporarily_unavailable','Server is closing'));
        return;
      }
      const identityHeader=req.header('x-mindpond-identity');
      if(identityHeader!==undefined&&identityHeader!=='connection'){res.status(400).json(httpError('invalid_input','X-MindPond-Identity must be connection when supplied'));return;}
      const connectionIdentity=identityHeader==='connection';
      const logicalSession = req.header('x-mindpond-session') ?? '';
      if (logicalSession && !/^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,127}$/u.test(logicalSession)) {
        res.status(400).json(httpError('invalid_input','Invalid host session label'));
        return;
      }
      const header = req.header('mcp-session-id');
      if (header) {
        c = connections.get(header);
        id = header;
        // The bearer is checked on EVERY request; a session ID grants nothing.
        if (
          !c || c.memory!==memory ||
          c.grant.tokenHash !== grant.tokenHash ||
          JSON.stringify(c.grant) !== JSON.stringify(grant) ||
          c.logicalSession !== logicalSession || c.connectionIdentity !== connectionIdentity
        ) {
          res.status(404).json(httpError('not_found','MCP session not found for this account'));
          return;
        }
      } else {
        if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
          res.status(400).json(httpError('invalid_input','Initialize before making MCP requests'));
          return;
        }
        const own =
          [...connections.values()].filter((v) => v.grant.principal === grant.principal).length +
          (pendingOwners.get(grant.principal) ?? 0);
        if (connections.size + pending >= max || own >= perAccount) {
          res.status(429).json(httpError('temporarily_unavailable','Connection limit reached'));
          return;
        }
        pending++;
        pendingOwners.set(grant.principal, (pendingOwners.get(grant.principal) ?? 0) + 1);
        newConnection = true;
        id = randomUUID();
        // Migrated v1 credentials retain their account tools and exact session namespace.
        const agentId = networkHostId(grant);
        const sessionId =
          'net:' +
          createHash('sha256')
            .update(agentId ? grant.principal + '\0' + agentId : grant.principal)
            .digest('hex')
            .slice(0, 40) +
          ':' +
          (logicalSession
            ? createHash('sha256').update(logicalSession).digest('hex').slice(0, 40)
            : randomUUID());
        const pinnedBinding=pinnedMemoryRole?await graph.memoryOwners.roleBinding(pinnedMemoryRole.role_id):null;
        if(pinnedMemoryRole&&!memory&&!pinnedBinding)throw new MindPondError('scope_denied','Activate an office chat for this role before connecting');
        const waitSignals = new Map<string | number, AbortController>();
        const serviceOptions = {
          toolProfile: 'office' as const,enableTasks:!!pinnedMemoryRole,pinnedRoleId:pinnedMemoryRole?.role_id,
          waitSignal: (requestId:string|number) => waitSignals.get(requestId)?.signal,
          trusted: {
            v: 1 as const,
            transport: 'http-mcp' as const,
            principal: grant.principal,
            agentId,
            credentialId: grant.credentialId,
            assignmentIds: grant.assignmentIds,
            connectionId: id,
            ...(pinnedBinding?{runtimeId:pinnedBinding.runtime_id,runtimeMode:connectionIdentity?'credential' as const:'host_header' as const}:connectionIdentity?{runtimeId:roleRuntimeId(grant.principal,agentId!,'credential',grant.credentialId??agentId!),runtimeMode:'credential' as const}:logicalSession ? {
              runtimeId: roleRuntimeId(grant.principal, agentId ?? grant.credentialId ?? 'legacy', 'header', logicalSession),
              runtimeMode: 'host_header' as const
            } : agentId ? {runtimeId:roleRuntimeId(grant.principal,agentId,'connection',id!),runtimeMode:'connection' as const} : {}),
            sessionId,
            domains: grant.domains,
            issuedAt: Date.now(),
            expiresAt: Number.MAX_SAFE_INTEGER
          },
          authorizeWait: async () => {
            if(pinnedMemoryRole){const current=await graph.memoryOwners.credential(req.header('authorization')?.replace(/^Bearer /,'')??'');if(current?.id!==pinnedMemoryRole.id)throw new MindPondError('scope_denied','Role memory credential was revoked');return;}
            const current = (await options.configuration()).grants.find(
              (g) => g.principal === grant.principal && g.tokenHash === grant.tokenHash
            );
            if (
              !current ||
              JSON.stringify(current) !== JSON.stringify(grant) ||
              !(await graph.offices.agentAuthority({
                v: 1,
                principal: grant.principal,
                agentId: networkHostId(grant),
                issuedAt: 0,
                expiresAt: Number.MAX_SAFE_INTEGER
              }))
            )
              throw new MindPondError(
                'scope_denied',
                'Account permission changed while waiting; reconnect with the current grant'
              );
          }
        };
        const service = memory ? createOwnerMemoryServer(graph,{trusted:serviceOptions.trusted,roleId:pinnedMemoryRole?.role_id,authorize:serviceOptions.authorizeWait}) : createMemoryMcpServer(graph,serviceOptions);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => id!,
          enableJsonResponse: true
        });
        c = {
          service,trusted:serviceOptions.trusted,
          transport,
          grant,
          logicalSession,memory,connectionIdentity,
          lastUsed: Date.now(),
          active: 0,
          waitSignals
        };
        const connectionId = id;
        const created = c;
        transport.onclose = () => {
          connections.delete(connectionId);
          void retire(created).catch(() => {});
        };
        await service.server.connect(transport);
        connections.set(id, c);
        if (networkHostId(grant))
          await graph.offices.seen({
            v: 1,
            principal: grant.principal,
            agentId: networkHostId(grant),
            issuedAt: 0,
            expiresAt: Number.MAX_SAFE_INTEGER
          });
      }
      if (ended || res.destroyed) {
        if (newConnection && id) await remove(id);
        return;
      }
      for (const message of Array.isArray(req.body) ? req.body : [req.body]) {
        if (
          message?.method === 'tools/call' &&
          (typeof message.id === 'string' || typeof message.id === 'number')
        ) {
          // Every tool receives disconnect cancellation, including discussion
          // waits and host probes added after the original mailbox waits.
          const controller = new AbortController();
          c.waitSignals.set(message.id, controller);
          waitControllers.push([message.id, controller]);
        }
      }
      c.active++;
      owned = true;
      c.lastUsed = Date.now();
      try {
        for(const message of Array.isArray(req.body)?req.body:[req.body]){
          if(message?.method!=='tools/call')continue;
          const params=message.params,args=params?.arguments??{};
          if(params?._meta)delete params._meta['mindpond/verifiedSessionID'];
          if(args.hostContext!==undefined){const session=verifyHostSession(args.hostContext,params.name,args,req.header('authorization')?.replace(/^Bearer /,'')??'');delete args.hostContext;params._meta={...params._meta,'mindpond/verifiedSessionID':session};}
          // Explicit connection scope is selected in host configuration, never tool arguments.
          // Both MCP endpoints derive one stable identity from the authenticated credential.
          if(c.connectionIdentity)continue; // Preserve progress/task metadata for standard MCP clients.
          const session=hostChatIdentity(params?._meta);
          if(pinnedMemoryRole&&session){const r=await graph.memoryOwners.role(pinnedMemoryRole.role_id);const b=await graph.roles.identity({v:1,principal:r.principal,agentId:r.connector_id,transport:'http-mcp',runtimeId:roleRuntimeId(r.principal,r.connector_id,session.source,session.id),issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER});if((b&&b.roleId!==r.id)||(!b&&params.name!=='role_sync'))throw new MindPondError('scope_denied','This chat is not bound to the credential’s role; call Office role_sync to request user activation');}
        }
        await c.transport.handleRequest(req, res, req.body);
      } finally {
        if (owned) {
          c.active--;
          owned = false;
          c.lastUsed = Date.now();
        }
      }
      // The SDK intentionally suppresses a cancelled tool's response. In JSON
      // response mode that otherwise leaves its original HTTP POST unresolved.
      // Settle it through the public transport API, keeping cancellation scoped
      // to this authenticated MCP connection and releasing SDK correlations.
      for (const message of Array.isArray(req.body) ? req.body : [req.body]) {
        const requestId = message?.params?.requestId;
        if (
          message?.method === 'notifications/cancelled' &&
          (typeof requestId === 'string' || typeof requestId === 'number')
        )
          await c.transport
            .send({
              jsonrpc: '2.0',
              id: requestId,
              error: { code: -32800, message: 'Request cancelled' }
            })
            .catch(() => {});
      }
      if (newConnection && !c.transport.sessionId) await remove(id!);
    } catch (error) {
      if (newConnection && id) await remove(id).catch(() => {});
      if (!res.headersSent) res.status(error instanceof MindPondError?httpStatus(error.code):500).json(error instanceof MindPondError?{error:error.message,...error.toJSON()}:httpError('internal','MCP request failed'));
    } finally {
      finishRequest();
      res.removeListener('close', finishRequest);
      for (const [requestId, controller] of waitControllers)
        if (c?.waitSignals.get(requestId) === controller) c.waitSignals.delete(requestId);
      if (newConnection) {
        pending--;
        pendingOwners.set(
          grant.principal,
          Math.max(0, (pendingOwners.get(grant.principal) ?? 1) - 1)
        );
      }
    }
  });
  app.use((_req, res) => {
    res.status(404).json(httpError('not_found','Not found'));
  });
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if(res.headersSent)return;
      const type=(error as {type?:string})?.type;
      if(type==='entity.too.large')res.status(413).json(httpError('invalid_input','Request body exceeds 1MB','Reduce the request body or split the work into smaller batches.'));
      else if(type==='entity.parse.failed')res.status(400).json(httpError('invalid_input','Malformed JSON request','Send a valid JSON request.'));
      else res.status(500).json(httpError('internal','MCP request failed'));
    }
  );
  const reportId=randomUUID();let reporting:Promise<unknown>|undefined;
  const report=()=>{if(closing||reporting)return;reporting=graph.officeCollaboration.runtimeReport(reportId,{release:releaseInfo(),runtime:runtime.snapshot(),connections:connections.size,pending,maxConnections:max,maxPerAccount:perAccount}).catch(()=>{}).finally(()=>{reporting=undefined;});};
  const reportTimer=setInterval(report,30000);reportTimer.unref();report();
  return {
    app,
    async close(listener?: HttpServer) {
      closing = true;
      clearInterval(timer);clearInterval(reportTimer);
      await reporting;await graph.officeCollaboration.runtimeReport(reportId,null).catch(()=>{});
      // Abort outstanding long polls before waiting for HTTP requests to drain.
      for (const connection of connections.values()) {
        connection.service.beginShutdown();
        // GET subscriptions are deliberately long-lived; drain them before
        // waiting for POST replies, without closing their response transports.
        connection.transport.closeStandaloneSSEStream();
      }
      const stopped = listener
        ? new Promise<void>((resolve) => listener.close(() => resolve()))
        : Promise.resolve();
      await artifactTransfers.close();
      await Promise.allSettled([...requests]);
      await Promise.allSettled([...connections.keys()].map(remove));
      await Promise.allSettled([...retired]);
      listener?.closeIdleConnections();
      // All owned MCP/file operations have drained. Also release sockets with
      // rejected/unconsumed request bodies; they are not idle to Node's HTTP server.
      listener?.closeAllConnections();
      await stopped;
    }
  };
}
