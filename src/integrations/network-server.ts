import express from 'express';
import {createOwnerMemoryServer} from '../role-memory-service.js';
import {verifyHostSession} from './host-correlation.js';
import type { Server as HttpServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { GraphMemory } from '../core/graph-memory.js';
import { MindPondError, httpStatus } from '../core/errors.js';
import { roleRuntimeId } from '../core/roles.js';
import { createMemoryMcpServer } from '../mcp-service.js';
import {
  authenticateNetworkAccount,
  type NetworkConfiguration,
  type NetworkGrant
} from './network-config.js';
interface Connection {
  transport: StreamableHTTPServerTransport;
  service: ReturnType<typeof createMemoryMcpServer>;
  grant: NetworkGrant;
  logicalSession: string;
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
  const app = express();
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
  const max = options.maxConnections ?? 128,
    perAccount = options.maxPerAccount ?? 8,
    idleMs = options.idleMs ?? 1800000;
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
      res.status(403).json({ error: 'Host is not allowed' });
      return;
    }
    const origin = req.header('origin');
    if (origin && !(options.allowedOrigins ?? []).includes(origin)) {
      res.status(403).json({ error: 'Origin is not allowed' });
      return;
    }
    next();
  });
  app.all(['/mcp','/memory/mcp'], async (req, res, next) => {
    try {
      if (closing) {
        res.status(503).json({ error: 'Server is closing' });
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
          agentId: grant.agentId,
          issuedAt: 0,
          expiresAt: Number.MAX_SAFE_INTEGER
        }))
      ) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="MindPond"');
        res.status(401).json({ error: 'Invalid account credential' });
        return;
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
      res.status(503).json({ error: 'Account configuration unavailable' });
    }
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
        res.status(503).json({ error: 'Server is closing' });
        return;
      }
      const logicalSession = req.header('x-mindpond-session') ?? '';
      if (logicalSession && !/^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,127}$/u.test(logicalSession)) {
        res.status(400).json({ error: 'Invalid host session label' });
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
          c.logicalSession !== logicalSession
        ) {
          res.status(404).json({ error: 'MCP session not found for this account' });
          return;
        }
      } else {
        if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
          res.status(400).json({ error: 'Initialize before making MCP requests' });
          return;
        }
        const own =
          [...connections.values()].filter((v) => v.grant.principal === grant.principal).length +
          (pendingOwners.get(grant.principal) ?? 0);
        if (connections.size + pending >= max || own >= perAccount) {
          res.status(429).json({ error: 'Connection limit reached' });
          return;
        }
        pending++;
        pendingOwners.set(grant.principal, (pendingOwners.get(grant.principal) ?? 0) + 1);
        newConnection = true;
        id = randomUUID();
        // Migrated v1 credentials retain their account tools and exact session namespace.
        const agentId = grant.agentId?.startsWith('legacy:') ? undefined : grant.agentId;
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
          toolProfile: agentId?'office' as const:grant.toolProfile,legacyOfficeWork:grant.toolProfile==='full',enableTasks:!!pinnedMemoryRole,pinnedRoleId:pinnedMemoryRole?.role_id,
          waitSignal: (requestId:string|number) => waitSignals.get(requestId)?.signal,
          trusted: {
            v: 1 as const,
            transport: 'http-mcp' as const,
            principal: grant.principal,
            agentId,
            credentialId: grant.credentialId,
            assignmentIds: grant.assignmentIds,
            connectionId: id,
            ...(pinnedBinding?{runtimeId:pinnedBinding.runtime_id,runtimeMode:'host_header' as const}:logicalSession ? {
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
                agentId: grant.agentId,
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
          service,
          transport,
          grant,
          logicalSession,memory,
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
        if (grant.agentId)
          await graph.offices.seen({
            v: 1,
            principal: grant.principal,
            agentId: grant.agentId,
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
          ['work_wait', 'work_office_wait', 'office_wait'].includes(message.params?.name) &&
          (typeof message.id === 'string' || typeof message.id === 'number')
        ) {
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
          const session=params?._meta?.['mindpond/verifiedSessionID']??params?._meta?.['ai.opencode/sessionID'];
          if(pinnedMemoryRole&&session){const r=await graph.memoryOwners.role(pinnedMemoryRole.role_id);const b=await graph.roles.identity({v:1,principal:r.principal,agentId:r.connector_id,transport:'http-mcp',runtimeId:roleRuntimeId(r.principal,r.connector_id,'opencode',session),issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER});if(!b||b.roleId!==r.id)throw new MindPondError('scope_denied','This chat is not bound to the credential’s role');}
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
      if (!res.headersSent) res.status(error instanceof MindPondError?httpStatus(error.code):500).json({ error: error instanceof MindPondError?error.message:'MCP request failed' });
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
    res.status(404).json({ error: 'Not found' });
  });
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (!res.headersSent) res.status(400).json({ error: 'Malformed or oversized request' });
    }
  );
  return {
    app,
    async close(listener?: HttpServer) {
      closing = true;
      clearInterval(timer);
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
      await Promise.allSettled([...requests]);
      await Promise.allSettled([...connections.keys()].map(remove));
      await Promise.allSettled([...retired]);
      await stopped;
    }
  };
}
