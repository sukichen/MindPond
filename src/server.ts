#!/usr/bin/env node
import { recallEntry } from './core/context-assembly.js';
import { authorizeOrganizationAccess } from './core/organization-access.js';
import { normalizeDomain } from './core/domain.js';
import { hostOperations, capabilities } from './core/host-contract.js';
import { protocolRulesResponse } from './core/protocol.js';
/**
 * MindPond — standalone HTTP server (service mode).
 *
 * MindPond NEVER owns an LLM API key. All LLM judgment is done by the HOST
 * AGENT via two-phase endpoints: MindPond proposes (GET job/batch + prompt),
 * the host's own LLM answers, the host commits (POST commit).
 *
 * Endpoints (all JSON):
 *   GET  /health
 *   GET  /api/memory/stats
 *   GET  /api/memory/actionlog?limit=   — append-only audit log (frontend/debug)
 *   POST /api/memory/search  {query, limit?, sessionId?, spaceId?, memoryType?, runId?, hostId?}
 *        → recallId + results; host later reports used/rejected/unassessed feedback
 *   POST /api/memory/recall-feedback {recallId, decisions:[{memoryId,disposition,reason?}]}
 *   POST /api/memory/save    {content, memberships?, related?:[{membershipId,score}]}
 *   POST /api/memory/save/validate {content, ...same save options} — side-effect-free preview with indexed anchor/association issues
 *   POST /api/memory/membership {memoryId,spaceId,memoryType}
 *   POST /api/memory/association {memberAId,memberBId,spaceId,memoryType,weight}
 *   POST /api/memory/expand  {nodeId, maxChars?, sessionId?|domains?|scope?}
 *                             — bounded entries carry a read context (M02.b):
 *                               sessionId and/or domains, or scope=operator
 *                               (loopback human workbench). Missing context → 400.
 *   GET  /api/memory/node/:id?trackAccess=1&sessionId=|domains=|scope=operator
 *   GET  /api/memory/node/:id/connections?sessionId=|domains=|scope=operator
 *   POST /api/memory/update  {nodeId, content?, importance?, tags?, verified?, sessionId?|domains?|scope?}
 *   POST /api/memory/delete  {nodeId, reason?, sessionId?|domains?|scope?}   — hard delete (audited, cascade edges logged)
 *   POST /api/memory/edge/delete {edgeId, reason?}
 *   GET  /api/memory/list?layer&dimension&sessionId&domains&limit&offset&scope=operator
 *                              — default reads personal/default + declared session only
 *   GET  /api/memory/graph?limit&layer          — nodes+edges for visualization
 *   POST /api/memory/dedupe/scan {threshold?}    — near-duplicate groups (cosine)
 *   POST /api/memory/dedupe/resolve {keepId, deleteIds, reason?} — atomic metadata merge, archive originals for trace
 *   POST /api/memory/ingest  {transcript, sessionId?}  — L0 raw record ingest
 *   GET  /api/extract/job               — staged extraction job (prompt + L0 batch), null if none
 *   POST /api/extract/commit {jobId,reply} — host LLM's extraction answer → L1 atoms
 *   GET  /api/consolidate/l2/batch      — one single-session L1 scene batch + prompt
 *   POST /api/consolidate/l2/commit {batchId,reply} — host LLM's L2 scenes → L2 nodes
 *   GET  /api/consolidate/l3/batch      — global L2 persona batch + prompt
 *   POST /api/consolidate/l3/commit {batchId,reply} — host LLM's persona → L3 node
 *   GET  /api/weave/batch               — one weave batch (node + candidates + prompt)
 *   POST /api/weave/commit {nodeId, links:[{idx,label,weight,reason,context,spaceId?,memoryType?}], candidateIds}
 *        (R04: verdict errors keep the batch held for corrected resubmission; the
 *         response reports per-link applied placement / skipped reasons)
 *   GET  /api/edges/review/batch        — one edge-review batch (edges + prompt)
 *   POST /api/edges/review/commit {items, verdicts:[{idx,score}]}
 *   GET  /api/organization/job?spaceId=&memoryType=&maxMembers=
 *   POST /api/organization/commit {jobId,plan}
 *   POST /api/organization/request {spaceId,memoryType,domain?,batchSize?,limit?}
 *   GET  /api/organization/request/:id            — progress + final receipt
 *   POST /api/organization/request/:id/next       — claim next watermark-bounded batch (organizationTask payload)
 *   POST /api/organization/request/:id/report {jobId,result,mutations?,reason?}
 *   POST /api/organization/request/:id/finish {reason}  — budget exhausted → partial + uncovered
 *   POST /api/organization/request/:id/cancel {reason}
 *   POST /api/maintenance/run           — decay + archive (no LLM needed)
 *
 * Host loop: discover memory_protocol_rules; create a bounded organization
 * request, claim complete material, validate/commit, report and read progress.
 * The host supplies model execution; no legacy weave/L2 loop is required.
 *
 * Auth: if MEMORY_API_KEY is set, all /api/* routes require header x-api-key.
 *
 * R03 trusted context: with MEMORY_CONTEXT_SECRET set, every /api request is
 * bound to a signed context token (x-mindpond-context header) carrying
 * principal / current session / readable domains / operator flag. Request
 * parameters may only NARROW that context — a model-authored sessionId,
 * domains list or scope=operator can never widen access. Operator capability
 * additionally requires MEMORY_OPERATOR_KEY (x-operator-key header) or a
 * signed operator token. Without MEMORY_CONTEXT_SECRET the pre-R03 behavior
 * (parameter-supplied context, loopback operator) is kept unchanged for
 * single-user deployments.
 *
 * Memory rules:
 *   - No server-side auto edge creation. Edges only via: related[] on save,
 *     weave commit (host LLM), or the extraction pipeline. Never embedding autolink.
 *   - Degree cap: max 6 associative out-edges per node; weakest edge is hard-deleted
 *     when a stronger one arrives; every action logged to memory_action_log.
 */

import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import path from 'path';
import { createRequire } from 'node:module';
import { defaultDatabasePath } from './core/runtime-paths.js';
import { fileURLToPath } from 'url';
import { timingSafeEqual } from 'node:crypto';
import { GraphMemory } from './core/graph-memory.js';
import { MemoryPipelineManager } from './core/memory-pipeline.js';
import { MemoryConsolidation } from './core/memory-consolidation.js';
import { memorySavePolicyPayload } from './core/save-policy.js';
import { organizationPolicyPayload, organizationTask } from './core/organization-policy.js';
import { httpStatus, MindPondError, toStructuredError } from './core/errors.js';
import type { DomainReadContext, MemoryDomainRef } from './core/domain.js';
import { narrowTrustedContext, narrowTrustedSaveContext, narrowTrustedDomains, narrowTrustedDomain, narrowTrustedSession, verifyContextToken, type TrustedCallContext } from './core/trust.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Keep an existing legacy DB, otherwise use the user data directory.
const DEFAULT_DB = defaultDatabasePath(path.resolve(__dirname, '..', 'data', 'mindpond.db'));
if (!process.env.MEMORY_DB_PATH) process.env.MEMORY_DB_PATH = DEFAULT_DB;

const PORT = Number(process.env.MEMORY_PORT ?? 7903);
const HOST = process.env.MEMORY_HOST ?? '127.0.0.1';
const API_KEY = process.env.MEMORY_API_KEY ?? '';
// R03: strict trusted-context mode activates only when a signing secret is configured.
const CONTEXT_SECRET = process.env.MEMORY_CONTEXT_SECRET ?? '';
const OPERATOR_KEY = process.env.MEMORY_OPERATOR_KEY ?? '';
if(!['127.0.0.1','::1','localhost'].includes(HOST) && !API_KEY && process.env.MEMORY_ALLOW_UNAUTHENTICATED_NETWORK!=='1')
  throw new Error('Network listening requires MEMORY_API_KEY; unauthenticated network access is development-only');
function keyMatches(supplied: string | undefined, expected: string): boolean {
  if (!supplied || !expected) return false;
  const left = Buffer.from(supplied), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

declare global {
  namespace Express { interface Request { trusted?: TrustedCallContext } }
}
/** Requests without a context token read personal/default only — never a
 * session, never global (T10: unknown sessions return nothing by default). */
const ANONYMOUS_CONTEXT: TrustedCallContext = { v: 1, principal: 'anonymous', domains: [{ kind: 'personal', id: 'default' }], issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
const CORS_ORIGINS = new Set((process.env.MEMORY_CORS_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean));
const EDGE_LABELS = new Set(['related', 'similar-to', 'caused-by', 'fixes', 'supports']);

const WEB_DIR = path.resolve(__dirname, '..', 'web');
const VIS_UMD = createRequire(import.meta.url).resolve('vis-network/standalone/umd/vis-network.min.js');

const graphMemory = new GraphMemory();
// Service mode: NO LLM client at all. Host agent brings its own.
const pipeline = new MemoryPipelineManager(graphMemory, undefined);
const consolidation = new MemoryConsolidation(graphMemory, undefined);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  next();
});

// ---- CORS is opt-in. Same-origin UI needs no CORS; a public wildcard would
// otherwise make an unauthenticated local service writable from any webpage. ----
app.use((req, res, next) => {
  const origin = req.header('origin');
  if (origin && CORS_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-api-key, x-mindpond-context, x-operator-key');
  }
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
});

// ---- web UI (self-contained static page, no build step) ----
app.get('/', (_req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')));
app.get('/graph', (_req, res) => res.sendFile(path.join(WEB_DIR, 'graph.html')));
app.get('/collaboration', (_req, res) => res.sendFile(path.join(WEB_DIR, 'collaboration.html')));
app.use('/assets', express.static(WEB_DIR));
app.get('/vendor/vis-network.min.js', (_req, res) => res.type('application/javascript').sendFile(VIS_UMD));
app.get('/licenses/third-party.txt', (_req, res) =>
  res.type('text/plain').sendFile(path.resolve(__dirname, '..', 'licenses', 'dependencies.txt')));

// ---- auth middleware ----
app.use('/api', (req, res, next) => {
  if (!API_KEY) return next();
  if (keyMatches(req.header('x-api-key'), API_KEY)) return next();
  res.status(401).json({ error: 'unauthorized: missing/invalid x-api-key' });
});

// ---- R03: bind the trusted call context (strict mode when configured) ----
app.use('/api', (req, res, next) => {
  if (!CONTEXT_SECRET) return next(); // legacy: request parameters carry the context
  const header = req.header('x-mindpond-context');
  if (!header) {
    if(process.env.MEMORY_ALLOW_ANONYMOUS!=='1' && !keyMatches(req.header('x-operator-key'),OPERATOR_KEY)) {
      failErr(res,new MindPondError('scope_denied','A trusted context token is required'),403);return;
    }
    req.trusted = { ...ANONYMOUS_CONTEXT };
  } else {
    try {
      req.trusted = verifyContextToken(header, CONTEXT_SECRET);
    } catch (err) {
      failErr(res, err, 403);
      return;
    }
  }
  if (keyMatches(req.header('x-operator-key'), OPERATOR_KEY)) req.trusted.operator = true;
  next();
});

// Check persisted ownership for both shared operations and REST aliases.
app.use(async (req, res, next) => {
  if (!CONTEXT_SECRET || !req.trusted || !/^\/api\/(?:host\/)?organization(?:\/|$)/.test(req.path)) return next();
  try {
    const args = { ...req.query, ...req.body };
    const pathId = /^\/api\/organization\/request\/([^/]+)/.exec(req.path)?.[1];
    if (pathId) await authorizeOrganizationAccess(graphMemory, { requestId: decodeURIComponent(pathId) }, req.trusted);
    await authorizeOrganizationAccess(graphMemory, args, req.trusted);
    next();
  } catch (error) { failErr(res, error); }
});

// ---- helpers ----
function ok(res: express.Response, data: unknown) {
  res.json({ ok: true, ...((data as object) ?? {}) });
}
function fail(res: express.Response, status: number, msg: string) {
  res.status(status).json({ ok: false, error: msg });
}
/** R01: every caught failure keeps its stable code/retryability/nextAction so
 * HTTP clients react to structure; `fallbackStatus` only covers unclassified
 * internal errors. */
function failErr(res: express.Response, err: unknown, fallbackStatus = 500) {
  const shape = toStructuredError(err);
  const status = shape.code === 'internal' ? fallbackStatus : httpStatus(shape.code);
  res.status(status).json({
    ok: false, error: shape.message, code: shape.code, retryable: shape.retryable,
    ...(shape.field !== undefined ? { field: shape.field } : {}),
    ...(shape.nextAction !== undefined ? { nextAction: shape.nextAction } : {}),
    ...(shape.retryAfterMs !== undefined ? { retryAfterMs: shape.retryAfterMs } : {}),
  });
}

// ---- routes ----
app.get('/health', (_req, res) => ok(res, { service: 'mindpond', port: PORT, mode: 'service (no LLM inside)' }));
app.get('/api/memory/retrieval/profiles',async(_req,res)=>{try{ok(res,await graphMemory.retrievalProfiles());}catch(error){failErr(res,error);}});
app.get('/api/memory/retrieval/devices',async(_req,res)=>{try{ok(res,await graphMemory.retrievalDevices());}catch(error){failErr(res,error);}});
app.post('/api/memory/retrieval/build',async(req,res)=>{
  if(!requireOperator(req,res))return;
  try{
    const args=z.object({profileId:z.string().min(1).max(64),maxItems:z.number().int().min(1).max(256).optional()}).parse(req.body);
    ok(res,await graphMemory.buildRetrievalProfile(args.profileId,args.maxItems));
  }catch(error){failErr(res,error);}
});
app.post('/api/memory/retrieval/activate',async(req,res)=>{
  if(!requireOperator(req,res))return;
  try{const args=z.object({profileId:z.string().min(1).max(64)}).parse(req.body);ok(res,await graphMemory.activateRetrievalProfile(args.profileId));}
  catch(error){failErr(res,error);}
});
let readinessCache:{at:number;result:Awaited<ReturnType<GraphMemory['databaseReadiness']>>}|undefined;
app.get('/ready',async(_req,res)=>{
  try {
    if(!readinessCache || Date.now()-readinessCache.at>30000)readinessCache={at:Date.now(),result:await graphMemory.databaseReadiness()};
    res.status(readinessCache.result.ready?200:503).json(readinessCache.result);
  }catch{res.status(503).json({ready:false,reason:'database_unavailable'});}
});

app.get('/api/memory/stats', async (_req, res) => {
  try {
    const stats = await graphMemory.getStats();
    ok(res, { stats });
  } catch (err) {
    failErr(res, err);
  }
});

app.get('/api/memory/actionlog', async (req, res) => {
  if (!requireOperator(req, res)) return;
  try {
    ok(res, await graphMemory.actionLogPage({ limit: Number(req.query.limit) || 50,
      before: Number(req.query.before) || undefined,
      action: typeof req.query.action === 'string' ? req.query.action : undefined,
      nodeId: typeof req.query.nodeId === 'string' ? req.query.nodeId : undefined }));
  } catch (err) {
    failErr(res, err);
  }
});

// A bounded, resumable operator stream. Authentication happens before this
// route; do not put keys in the URL as EventSource would require.
const actionStreams = new Set<express.Response>();
app.get('/api/memory/actionstream', async (req, res) => {
  if (!requireOperator(req, res)) return;
  if (actionStreams.size >= 32) return fail(res, 503, 'too many action streams');
  const requested = Number(req.query.after ?? 0);
  if (!Number.isSafeInteger(requested) || requested < 0) return fail(res, 400, 'invalid after cursor');
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  actionStreams.add(res);
  let cursor = requested, busy = false, closed = false;
  const poll = async () => {
    if (busy || closed || res.writableLength > 262144) return;
    busy = true;
    try {
      const rows = await graphMemory.actionLogAfter(cursor, 100);
      for (const row of rows) {
        if (closed) break;
        cursor = row.id;
        res.write(`id: ${row.id}\nevent: action\ndata: ${JSON.stringify(row)}\n\n`);
      }
      if (!rows.length) res.write(': keepalive\n\n');
    } catch (error) {
      if (!closed) res.write(`event: stream_error\ndata: ${JSON.stringify({error:toStructuredError(error).message})}\n\n`);
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void poll(); }, 850);
  req.on('close', () => { closed = true; clearInterval(timer); actionStreams.delete(res); });
  await poll();
});

app.post('/api/memory/search', async (req, res) => {
  try {
    const { query, retrievalProfile, vectorAlgorithm, reranker, queries, candidateLimit, limit, sessionId, domains, dimension, layer, spaceId, memoryType, minScore, maxDepth, includeL0, includeEvents, useAnchors, sourceContext, runId, hostId, contextBudgetBytes } = req.body ?? {};
    if (!query || typeof query !== 'string') return fail(res, 400, 'query (string) required');
    // R03: request parameters may only narrow the trusted read context.
    let readCtx: { sessionId?: string; domains?: MemoryDomainRef[] };
    if (req.trusted && CONTEXT_SECRET) {
      const narrowed = narrowTrustedContext(req.trusted, { sessionId, domains });
      readCtx = narrowed === 'operator' ? { sessionId, domains } : narrowed;
    } else {
      readCtx = { sessionId, domains };
    }
    const recall = await graphMemory.recall({
      query, retrievalProfile, vectorAlgorithm, reranker,
      limit: typeof limit === 'number' ? limit : 10,
      sessionId: readCtx.sessionId,
      domains: readCtx.domains,
      dimension,
      layer,
      spaceId,
      memoryType,
      minScore,
      maxDepth,
      candidateLimit, queries, includeL0, includeEvents, useAnchors, sourceContext, runId, hostId, contextBudgetBytes,
    });
    // Results carry node.id — caller uses them to fill related[] on subsequent save.
    // nearDuplicates flags in-set redundancy (cosine ≥ 0.92) — caller may clean
    // up via POST /api/memory/delete or /api/memory/dedupe/resolve.
    ok(res, {
      recallId: recall.recallId,
      retrieval:recall.retrieval,
      results: recall.results.map(recallEntry),
      ...(recall.contextBudget?{contextBudget:recall.contextBudget}:{}),
    });
  } catch (err) {
    failErr(res, err);
  }
});

app.post('/api/memory/recall-feedback', async (req, res) => {
  try { ok(res, await graphMemory.reportRecallFeedback(req.body ?? {},callerContext(req,req.body))); }
  catch (err) { failErr(res, err, 400); }
});

app.get('/api/memory/recall-feedback/summary', async (_req, res) => {
  try { ok(res, await graphMemory.recallFeedbackSummary()); }
  catch (err) { failErr(res, err); }
});

app.post('/api/memory/save', async (req, res) => {
  try {
    const { content, ...options } = req.body ?? {};
    // R03: write ownership may only narrow to the trusted session/domain.
    if (req.trusted && CONTEXT_SECRET) {
      Object.assign(options, narrowTrustedSaveContext(req.trusted, options));
    }
    ok(res, await graphMemory.saveMemory(content, options));
  } catch (err) {
    failErr(res, err, 400);
  }
});

app.post('/api/memory/membership', async (req, res) => {
  try {
    const { memoryId, spaceId, memoryType, teamAuthorization } = req.body ?? {};
    if (![memoryId, spaceId, memoryType].every(value => typeof value === 'string' && value.trim())) return fail(res, 400, 'memoryId, spaceId, memoryType (strings) required');
    const membership = await graphMemory.addMembership(memoryId, spaceId, memoryType, teamAuthorization, callerContext(req, req.body));
    ok(res, { membership });
  } catch (err) { failErr(res, err, 400); }
});

app.post('/api/memory/association', async (req, res) => {
  try {
    const { memberAId, memberBId, spaceId, memoryType, weight, reason, context, teamAuthorization } = req.body ?? {};
    if (![memberAId, memberBId, spaceId, memoryType].every(value => typeof value === 'string' && value.trim())) return fail(res, 400, 'memberAId, memberBId, spaceId, memoryType (strings) required');
    graphMemory.validateAssociationBasis({ reason, context });
    const association = await graphMemory.upsertAssociation(memberAId, memberBId, spaceId, memoryType, weight, { reason, context }, teamAuthorization, callerContext(req, req.body));
    ok(res, { association });
  } catch (err) { failErr(res, err, 400); }
});

app.post('/api/memory/association/review', async (req, res) => {
  try {
    const { id, evidenceId, decision, reason, expectedUpdatedAt, teamAuthorization } = req.body ?? {};
    ok(res, await graphMemory.reviewAssociationEvidence(id, evidenceId, decision, reason, expectedUpdatedAt, teamAuthorization, callerContext(req, req.body)));
  } catch (err) { failErr(res, err, 400); }
});

app.post('/api/memory/expand', async (req, res) => {
  try {
    const { nodeId, maxChars, sessionId, domains, scope } = req.body ?? {};
    if (!nodeId || typeof nodeId !== 'string') return fail(res, 400, 'nodeId (string) required');
    const ctx = resolveContext(req, { sessionId, domains, scope }, res);
    if (ctx === null) return;
    const node = await graphMemory.getNodeById(nodeId, { trackAccess: true, context: coreContext(ctx) });
    if (!node) return fail(res, 404, `node not found: ${nodeId}`);
    const max = typeof maxChars === 'number' ? maxChars : 800;
    ok(res, {
      node: {
        id: node.id,
        dimension: node.dimension,
        layer: node.layer,
        content: node.content.slice(0, max),
        importance: node.importance,
        tags: node.tags,
        createdAt: node.createdAt,
      },
    });
  } catch (err) {
    failErr(res, err);
  }
});

// ---- M02.b: bounded entries that address a node by bare id must carry an
// explicit read context (sessionId and/or domains). `scope=operator` is the
// loopback human workbench escape hatch (HOST defaults to 127.0.0.1); entries
// without any context are explicitly rejected — never defaulted to a scan of
// all sessions. Returns null (after sending 400) when the context is missing.
type EntryContext = ReturnType<typeof requireContext>;
function requireContext(src: { sessionId?: unknown; domains?: unknown; scope?: unknown }): DomainReadContext | 'operator' {
  if (src.scope === 'operator') return 'operator';
  // GET query params carry domains as a JSON string; JSON bodies pass arrays.
  const rawDomains = typeof src.domains === 'string'
    ? (() => { try { return JSON.parse(src.domains); } catch { return src.domains; } })()
    : src.domains;
  const sessionId = typeof src.sessionId === 'string' && src.sessionId.trim() ? src.sessionId : undefined;
  const domains = Array.isArray(rawDomains) ? (rawDomains as MemoryDomainRef[]) : undefined;
  if (!sessionId && !(domains && domains.length)) throw new Error('domain context required: sessionId, domains, or scope=operator');
  return { sessionId, domains };
}
/** R03: resolve the read context for bounded entries. Legacy mode (no
 * MEMORY_CONTEXT_SECRET): request parameters carry the context as before.
 * Strict mode: narrow against the trusted call context; any widening attempt
 * (another session, ungranted domain, scope=operator) is denied with 403. */
function resolveContext(req: express.Request, src: unknown, res: express.Response): EntryContext | null {
  try {
    const source = (src ?? {}) as { sessionId?: unknown; domains?: unknown; scope?: unknown };
    if (!CONTEXT_SECRET || !req.trusted) return requireContext(source);
    return narrowTrustedContext(req.trusted, source);
  } catch (err) {
    failErr(res, err, 403);
    return null;
  }
}
/** Operator-only surfaces (audit log, global graph, dedupe, maintenance,
 * pipeline jobs) require the operator capability in strict mode. */
function requireOperator(req: express.Request, res: express.Response): boolean {
  if (!CONTEXT_SECRET) return true; // legacy single-user mode
  if (req.trusted?.operator) return true;
  failErr(res, new MindPondError('scope_denied', 'operator capability requires a trusted operator context'), 403);
  return false;
}
function coreContext(ctx: EntryContext): DomainReadContext | undefined {
  return ctx === 'operator' ? undefined : ctx;
}
/** Strict-mode direct routes inherit the signed scope; legacy and operator routes keep their existing behavior. */
function callerContext(req: express.Request, src: { sessionId?: unknown; domains?: unknown; scope?: unknown } = {}): DomainReadContext | undefined {
  if (!CONTEXT_SECRET || !req.trusted || req.trusted.operator) return undefined;
  return narrowTrustedContext(req.trusted, src) as DomainReadContext;
}

// ---- Node management (get / update / delete / list / connections / graph) ----
app.get('/api/memory/node/:id', async (req, res) => {
  const ctx = resolveContext(req, req.query, res);
  if (ctx === null) return;
  try {
    const node = await graphMemory.getNodeById(req.params.id, { trackAccess: req.query.trackAccess === '1', context: coreContext(ctx) });
    if (!node) return fail(res, 404, `node not found: ${req.params.id}`);
    ok(res, { node: { ...node, embedding: undefined }, memberships: await graphMemory.getMemberships(node.id), associations: await graphMemory.listAssociations(node.id, { context: coreContext(ctx) }) });
  } catch (err) {
    failErr(res, err);
  }
});

app.get('/api/memory/node/:id/connections', async (req, res) => {
  const ctx = resolveContext(req, req.query, res);
  if (ctx === null) return;
  try {
    const connections = await graphMemory.getConnections(req.params.id, coreContext(ctx));
    ok(res, {
      connections: connections.map(({ node, edge, direction }) => ({
        edgeId: edge.id, label: edge.label, weight: edge.weight, direction,
        node: { id: node.id, dimension: node.dimension, layer: node.layer, content: node.content, importance: node.importance },
      })),
    });
  } catch (err) {
    failErr(res, err);
  }
});

app.post('/api/memory/update', async (req, res) => {
  try {
    const { nodeId, content, dimensions, replaceMembershipIds, anchors, importance, tags, verified, expectedUpdatedAt, expectedContent, sourceRefs, reason, teamAuthorization, sessionId, domains, scope } = req.body ?? {};
    if (!nodeId || typeof nodeId !== 'string') return fail(res, 400, 'nodeId (string) required');
    const ctx = resolveContext(req, { sessionId, domains, scope }, res);
    if (ctx === null) return;
    const existing = await graphMemory.getNodeById(nodeId, { trackAccess: false });
    if (!existing) return fail(res, 404, `node not found: ${nodeId}`);
    ok(res, await graphMemory.editMemory(nodeId, { content, dimensions, replaceMembershipIds, anchors, importance, tags, verified, expectedUpdatedAt, expectedContent, sourceRefs, reason, teamAuthorization, context: coreContext(ctx) }));
  } catch (err) {
    failErr(res, err, 409);
  }
});

app.post('/api/memory/delete', async (req, res) => {
  try {
    const { nodeId, reason, teamAuthorization, sessionId, domains, scope } = req.body ?? {};
    if (!nodeId || typeof nodeId !== 'string') return fail(res, 400, 'nodeId (string) required');
    const ctx = resolveContext(req, { sessionId, domains, scope }, res);
    if (ctx === null) return;
    const existing = await graphMemory.getNodeById(nodeId, { trackAccess: false });
    if (!existing) return fail(res, 404, `node not found: ${nodeId}`);
    await graphMemory.deleteNode(nodeId, typeof reason === 'string' ? reason : 'host-requested delete', teamAuthorization, coreContext(ctx));
    ok(res, { deleted: true });
  } catch (err) {
    failErr(res, err);
  }
});

app.post('/api/memory/edge/delete', async (req, res) => {
  try {
    const { edgeId, reason, teamAuthorization } = req.body ?? {};
    if (!edgeId || typeof edgeId !== 'string') return fail(res, 400, 'edgeId (string) required');
    const deleted = await graphMemory.deleteEdge(edgeId, typeof reason === 'string' ? reason : 'host-requested delete', teamAuthorization, callerContext(req, req.body));
    if (!deleted) return fail(res, 404, `edge not found: ${edgeId}`);
    ok(res, { deleted: true });
  } catch (err) {
    failErr(res, err);
  }
});

app.get('/api/memory/list', async (req, res) => {
  try {
    const wantsOperator = req.query.scope === 'operator';
    const operator = CONTEXT_SECRET ? (wantsOperator ? (req.trusted?.operator ?? false) : false) : wantsOperator;
    if (CONTEXT_SECRET && wantsOperator && !operator) {
      failErr(res, new MindPondError('scope_denied', 'operator capability requires a trusted operator context'), 403);
      return;
    }
    let sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    let domains: MemoryDomainRef[] | undefined = typeof req.query.domains === 'string' ? JSON.parse(req.query.domains) : undefined;
    if (!operator) {
      const ctx = resolveContext(req, { sessionId, domains }, res);
      if (ctx === null) return;
      if (ctx !== 'operator') { sessionId = ctx.sessionId; domains = ctx.domains; }
    }
    const { nodes, total } = await graphMemory.listNodes({
      layer: typeof req.query.layer === 'string' ? req.query.layer as never : undefined,
      dimension: typeof req.query.dimension === 'string' ? req.query.dimension as never : undefined,
      sessionId,
      domains,
      operatorAll: operator,
      spaceId: typeof req.query.spaceId === 'string' ? req.query.spaceId : undefined,
      memoryType: typeof req.query.memoryType === 'string' ? req.query.memoryType : undefined,
      activeOnly: req.query.activeOnly === 'true',
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0,
    });
    ok(res, {
      total,
      nodes: await Promise.all(nodes.map(async n => ({
        id: n.id, dimension: n.dimension, dimensions:n.dimensions, layer: n.layer, content: n.content,
        importance: n.importance, tags: n.tags, domain:n.domain, sessionId: n.sessionId,
        createdAt: n.createdAt, updatedAt: n.updatedAt, accessCount: n.accessCount,
        sourceRefs:n.sourceRefs, profiles:n.profiles,
        memberships: await graphMemory.getMemberships(n.id),
      }))),
    });
  } catch (err) {
    failErr(res, err);
  }
});

app.get('/api/memory/graph', async (req, res) => {
  if (!requireOperator(req, res)) return;
  try {
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 200));
    const layerQ = typeof req.query.layer === 'string' ? req.query.layer : '';
    const layer = ['L0', 'L1', 'L2', 'L3'].includes(layerQ) ? layerQ as 'L0' | 'L1' | 'L2' | 'L3' : undefined;
    const graph = await graphMemory.getFullGraph(limit, layer,{spaceId:typeof req.query.spaceId==='string'?req.query.spaceId:undefined,memoryType:typeof req.query.memoryType==='string'?req.query.memoryType:undefined,includeEvents:req.query.includeEvents==='true'});
    ok(res, graph);
  } catch (err) {
    failErr(res, err);
  }
});

// ---- Dedup: scan for near-duplicates, resolve by merging into a keeper ----
app.post('/api/memory/dedupe/scan', async (req, res) => {
  if (!requireOperator(req, res)) return;
  try {
    const { threshold } = req.body ?? {};
    const t = typeof threshold === 'number' ? Math.min(0.99, Math.max(0.5, threshold)) : 0.92;
    const groups = await graphMemory.findDuplicates(t);
    ok(res, {
      threshold: t,
      groups: groups.map(g => ({
        keep: { id: g.keep.id, content: g.keep.content, importance: g.keep.importance, accessCount: g.keep.accessCount },
        duplicates: g.duplicates.map(d => ({
          id: d.node.id, content: d.node.content, importance: d.node.importance, similarity: d.similarity,
        })),
      })),
    });
  } catch (err) {
    failErr(res, err);
  }
});

app.post('/api/memory/dedupe/resolve', async (req, res) => {
  if (!requireOperator(req, res)) return;
  try {
    const { keepId, deleteIds, reason } = req.body ?? {};
    if (!keepId || typeof keepId !== 'string') return fail(res, 400, 'keepId (string) required');
    if (!Array.isArray(deleteIds) || deleteIds.length === 0) return fail(res, 400, 'deleteIds (non-empty array) required');
    const result = await graphMemory.mergeDuplicates(keepId, deleteIds, typeof reason === 'string' ? reason : 'dedupe merge');
    ok(res, result);
  } catch (err) {
    failErr(res, err);
  }
});

// ---- L0 ingest ----
app.post('/api/memory/ingest', async(req,res)=>{
  try{const {transcript,sessionId,idempotencyKey}=req.body ?? {};
    const boundSession = req.trusted && CONTEXT_SECRET ? narrowTrustedSession(req.trusted, sessionId) : sessionId;
    ok(res,{...await graphMemory.ingestTranscript(transcript,boundSession,idempotencyKey),next:'GET /api/extract/job → host LLM → POST /api/extract/commit'});}
  catch(error){fail(res,400,error instanceof Error?error.message:String(error));}
});

// ---- L1 extraction: scoped hosts claim/commit only their readable jobs ----
app.get('/api/extract/job', async (_req, res) => {
  try {
    const context = _req.trusted && CONTEXT_SECRET ? narrowTrustedContext(_req.trusted, {}) : 'operator';
    const job = await pipeline.getExtractionJob(context === 'operator' ? undefined : context);
    ok(res, { job });
  } catch (err) {
    failErr(res, err);
  }
});

app.post('/api/extract/commit', async (req, res) => {
  try {
    const { jobId, reply, expectedAttempt } = req.body ?? {};
    if (!jobId || typeof jobId !== 'string') return fail(res, 400, 'jobId (string, from /api/extract/job) required');
    if (!reply || typeof reply !== 'string') return fail(res, 400, 'reply (string) required');
    const context = req.trusted && CONTEXT_SECRET ? narrowTrustedContext(req.trusted, {}) : 'operator';
    const result = await pipeline.commitExtraction(jobId, reply, expectedAttempt, context === 'operator' ? undefined : context);
    if (!result.completed) return fail(res, 409, 'job is not leased, expired, or reply JSON was invalid; retrieve a job and retry');
    ok(res, result);
  } catch (err) {
    failErr(res, err);
  }
});

// ---- Phase 1/2: L2 scenes and L3 persona (host LLM judges) — operator pipeline ----
app.get('/api/consolidate/l2/batch', async (_req, res) => {
  if (!requireOperator(_req, res)) return;
  try {
    ok(res, { batch: await consolidation.buildL2Batch() });
  } catch (err) {
    failErr(res, err);
  }
});

app.post('/api/consolidate/l2/commit', async (req, res) => {
  if (!requireOperator(req, res)) return;
  try {
    const { batchId, reply } = req.body ?? {};
    if (!batchId || typeof batchId !== 'string') return fail(res, 400, 'batchId (string, from /api/consolidate/l2/batch) required');
    if (!reply || typeof reply !== 'string') return fail(res, 400, 'reply (string) required');
    const result = await consolidation.commitL2Batch(batchId, reply);
    if (!result.completed) return fail(res, 409, 'batch is missing or expired; retrieve a new L2 batch and retry');
    ok(res, result);
  } catch (err) {
    failErr(res, err);
  }
});

app.get('/api/consolidate/l3/batch', async (_req, res) => {
  if (!requireOperator(_req, res)) return;
  try {
    ok(res, { batch: await consolidation.buildL3Batch() });
  } catch (err) {
    failErr(res, err);
  }
});

app.post('/api/consolidate/l3/commit', async (req, res) => {
  if (!requireOperator(req, res)) return;
  try {
    const { batchId, reply } = req.body ?? {};
    if (!batchId || typeof batchId !== 'string') return fail(res, 400, 'batchId (string, from /api/consolidate/l3/batch) required');
    if (!reply || typeof reply !== 'string') return fail(res, 400, 'reply (string) required');
    const result = await consolidation.commitL3Batch(batchId, reply);
    if (!result.completed) return fail(res, 409, 'batch is missing, expired, or persona text was invalid; retrieve a new L3 batch and retry');
    ok(res, result);
  } catch (err) {
    failErr(res, err);
  }
});

// ---- Phase 1/2: edge weaving (host LLM judges) — operator pipeline ----
app.get('/api/weave/batch', async (_req, res) => {
  if (!requireOperator(_req, res)) return;
  try {
    const batch = await consolidation.buildWeaveBatch();
    ok(res, { batch });
  } catch (err) {
    failErr(res, err);
  }
});

app.post('/api/weave/commit', async (req, res) => {
  if (!requireOperator(req, res)) return;
  try {
    const { nodeId, links, candidateIds } = req.body ?? {};
    if (!nodeId || typeof nodeId !== 'string') return fail(res, 400, 'nodeId (string) required');
    if (!Array.isArray(links)) return fail(res, 400, 'links (array) required');
    if (!Array.isArray(candidateIds)) return fail(res, 400, 'candidateIds (array, from the batch) required');
    const result = await consolidation.commitWeaveVerdicts(nodeId, links, candidateIds);
    ok(res, { ...result, next: 'GET /api/weave/batch for the next batch (null = done)' });
  } catch (err) {
    failErr(res, err);
  }
});

// ---- Phase 1/2: edge review (host LLM re-rates a rotating batch) — operator pipeline ----
app.get('/api/edges/review/batch', async (_req, res) => {
  if (!requireOperator(_req, res)) return;
  try {
    const batch = await consolidation.buildEdgeReviewBatch();
    ok(res, { batch });
  } catch (err) {
    failErr(res, err);
  }
});

app.post('/api/edges/review/commit', async (req, res) => {
  if (!requireOperator(req, res)) return;
  try {
    const { items, verdicts } = req.body ?? {};
    if (!Array.isArray(items)) return fail(res, 400, 'items (array, from the batch) required');
    if (!Array.isArray(verdicts)) return fail(res, 400, 'verdicts (array of {idx, score}) required');
    const changed = await consolidation.commitEdgeReviewVerdicts(items, verdicts);
    ok(res, { changed, deferred: true, reason: 'Score-only review lacks original context; use /api/memory/association/review or the organization workflow.' });
  } catch (err) {
    failErr(res, err);
  }
});

// ---- Organization v2: the host owns LLM judgment; MindPond owns the
// snapshot, scope boundary, version check, and atomic mutation. ----
// Portable operations return their exact MCP JSON shape, including arrays/null.
// Dimension configuration is user/operator owned; MCP exposes read-only policy.
app.get('/api/memory/dimensions', async (_req,res)=>{try{ok(res,{configuration:await graphMemory.getDimensionConfiguration()});}catch(e){failErr(res,e);}});
app.post('/api/memory/dimensions',async(req,res)=>{
  if(!requireOperator(req,res))return;
  try{ok(res,{configuration:await graphMemory.configureDimensions(req.body)});}catch(e){failErr(res,e,400);}
});
app.get('/api/host/capabilities', (_req,res)=>res.json(capabilities()));
// A01: progressive rule discovery — full payload, upToDate probe or cache-digest delta.
app.get('/api/protocol/rules', async (req, res) => {
  try {
    const cacheDigests = typeof req.query.cacheDigests === 'string'
      ? (() => { try { return JSON.parse(req.query.cacheDigests); } catch { return req.query.cacheDigests; } })()
      : undefined;
    res.json({...protocolRulesResponse({
      clientVersion: typeof req.query.clientVersion === 'string' ? req.query.clientVersion : undefined,
      sinceVersion: typeof req.query.sinceVersion === 'string' ? req.query.sinceVersion : undefined,
      ...(cacheDigests !== undefined ? { cacheDigests } : {}),
    }),...await graphMemory.dimensionPolicyDelta(req.query.sinceDimensionRevision===undefined?undefined:Number(req.query.sinceDimensionRevision))});
  } catch (err) { failErr(res, err); }
});
for(const op of hostOperations(graphMemory)) app.post(op.path, async(req,res)=>{
  const abort=new AbortController();
  const disconnected=()=>{if(!res.writableEnded)abort.abort();};
  res.once('close',disconnected);
  try {
    const body: any = { ...(req.body ?? {}) };
    // R03: host operations inherit the trusted context — model-authored
    // sessionId/domains/scope may only narrow what the token already allows.
    if (req.trusted && CONTEXT_SECRET) {
      const shape = op.schema.shape as Record<string, unknown>;
      if (op.name === 'memory_save_validate') Object.assign(body, narrowTrustedSaveContext(req.trusted, body));
      else if ('sessionId' in shape) body.sessionId = narrowTrustedSession(req.trusted, body.sessionId);
      if ('domains' in shape) body.domains = narrowTrustedDomains(req.trusted, body.domains, body.sessionId);
      if ('domain' in shape) body.domain = narrowTrustedDomain(req.trusted, normalizeDomain(body.domain, body.sessionId), body.sessionId);
      if (body.scope === 'operator' && !req.trusted.operator) throw new MindPondError('scope_denied', 'operator capability requires a trusted operator context');
    }
    const result=await op.run(op.schema.parse(body),callerContext(req,body),req.trusted??(!CONTEXT_SECRET?{v:1,principal:'local-operator',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER}:undefined),{signal:abort.signal});
    await graphMemory.logAction({action:'host_tool_completed',nodeId:typeof body.nodeId==='string'?body.nodeId:undefined,domain:req.trusted&&!req.trusted.operator?(req.trusted.sessionId?{kind:'session',id:req.trusted.sessionId}:req.trusted.domains?.[0]):undefined,reason:JSON.stringify({tool:op.name})});
    res.json(result);
  }
  catch(error){failErr(res,error,400);}
  finally{res.removeListener('close',disconnected);}
});

app.get('/api/memory/save-policy', async (_req, res) => {try{ok(res,{policy:memorySavePolicyPayload(await graphMemory.getDimensionPolicy())});}catch(e){failErr(res,e);}});
app.get('/api/organization/policy', async (_req, res) => {try{ok(res, { policy: organizationPolicyPayload(), dimensionPolicy:await graphMemory.getDimensionPolicy(), savePolicy: memorySavePolicyPayload(await graphMemory.getDimensionPolicy()) });}catch(e){failErr(res,e);}});

app.get('/api/memory/spaces', async (req, res) => {
  try { ok(res, { spaces: await graphMemory.listSpaces(callerContext(req, req.query)) }); }
  catch (err) { failErr(res, err); }
});

app.get('/api/memory/associations', async (req, res) => {
  try { ok(res, { associations: await graphMemory.listAssociations(typeof req.query.memoryId === 'string' ? req.query.memoryId : undefined, { context: callerContext(req, req.query) }) }); }
  catch (err) { failErr(res, err); }
});

app.post('/api/memory/association/delete', async (req, res) => {
  try {
    if (typeof req.body?.id !== 'string') return fail(res, 400, 'id required');
    ok(res, { deleted: await graphMemory.deleteAssociation(req.body.id, req.body.reason, req.body.teamAuthorization, callerContext(req, req.body)) });
  } catch (err) { failErr(res, err, 409); }
});

app.post('/api/organization/claim', async (req, res) => {
  try {
    const claim: any = { ...(req.body ?? {}) };
    if (req.trusted && CONTEXT_SECRET && claim.domain !== undefined) claim.domain = narrowTrustedDomain(req.trusted, claim.domain);
    ok(res, organizationTask(await graphMemory.claimOrganizationJob(claim)));
  }
  catch (err) { failErr(res, err, 409); }
});

app.post('/api/organization/validate', async (req, res) => {
  try { ok(res, await graphMemory.validateOrganizationPlan(req.body?.jobId, req.body?.plan)); }
  catch (err) { failErr(res, err, 409); }
});

app.post('/api/organization/release', async (req, res) => {
  try { await graphMemory.releaseOrganizationJob(req.body?.jobId); ok(res, { released: true }); }
  catch (err) { fail(res, 409, String(err)); }
});

app.post('/api/organization/renew', async (req, res) => {
  try { ok(res, { leaseExpiresAt: await graphMemory.renewOrganizationJob(req.body?.jobId) }); }
  catch (err) { fail(res, 409, String(err)); }
});

app.get('/api/organization/job', async (req, res) => {
  try {
    const spaceId = typeof req.query.spaceId === 'string' ? req.query.spaceId : '';
    const memoryType = typeof req.query.memoryType === 'string' ? req.query.memoryType : '';
    if (!spaceId || !memoryType) return fail(res, 400, 'spaceId and memoryType are required');
    const job = await graphMemory.claimOrganizationJob({
      domain: await (async () => {
        const rawDomain = typeof req.query.domain === 'string' ? JSON.parse(req.query.domain) : undefined;
        return req.trusted && CONTEXT_SECRET && rawDomain !== undefined ? narrowTrustedDomain(req.trusted, rawDomain) : rawDomain;
      })(),
      spaceId, memoryType,
      maxMembers: typeof req.query.maxMembers === 'string' ? Number(req.query.maxMembers) : undefined,
    });
    ok(res, organizationTask(job));
  } catch (err) { failErr(res, err); }
});

app.post('/api/organization/commit', async (req, res) => {
  try {
    const { jobId, plan, teamAuthorization } = req.body ?? {};
    if (typeof jobId !== 'string' || !plan || !Array.isArray(plan.operations)) return fail(res, 400, 'jobId and plan.operations are required');
    ok(res, await graphMemory.commitOrganizationPlan(jobId, plan, teamAuthorization));
  } catch (err) { failErr(res, err, 409); }
});

// ---- O01: organization requests — one bounded pass over a fixed watermark ----
// create → next (claim a watermark-bounded batch, drive the normal job flow)
// → report (batch conclusion) → repeat until batch:null, or finish (budget
// exhausted → partial + uncovered) / cancel. Request creation never promises a
// background executor: a host drives the batches itself.
app.post('/api/organization/request', async (req, res) => {
  try {
    const body = req.body ?? {};
    const domain = req.trusted && CONTEXT_SECRET && body.domain !== undefined ? narrowTrustedDomain(req.trusted, body.domain) : body.domain;
    ok(res, await graphMemory.organizationRequests.createRequest({ ...body, domain }));
  } catch (err) { failErr(res, err); }
});
app.get('/api/organization/request/:id', async (req, res) => {
  try {
    const progress = await graphMemory.organizationRequests.getRequest(req.params.id);
    if (!progress) return fail(res, 404, 'organization request not found');
    ok(res, progress);
  } catch (err) {
    failErr(res, err);
  }
});
// O04/T17: reconnect-resumable event page — positional by seq, pages never overlap.
app.get('/api/organization/request/:id/events', async (req, res) => {
  try {
    ok(res, await graphMemory.organizationRequests.listEvents(req.params.id, {
      afterSeq: req.query.afterSeq !== undefined ? Number(req.query.afterSeq) : undefined,
      limit: req.query.limit !== undefined ? Number(req.query.limit) : undefined,
    }));
  } catch (err) {
    failErr(res, err);
  }
});
app.post('/api/organization/request/:id/next', async (req, res) => {
  try {
    const result = await graphMemory.organizationRequests.nextBatch(req.params.id, { leaseMs: req.body?.leaseMs });
    if (result.batch === null) return ok(res, { job: null, progress: result.progress });
    ok(res, { ...organizationTask(result.batch), requestId: result.requestId, progress: result.progress,
      report: `POST /api/organization/request/${req.params.id}/report {jobId, result: committed|no_change|deferred|failed|released, mutations?, reason?}` });
  } catch (err) { failErr(res, err); }
});
app.post('/api/organization/request/:id/report', async (req, res) => {
  try {
    const { jobId, result, mutations, reason } = req.body ?? {};
    if (typeof jobId !== 'string' || typeof result !== 'string') return fail(res, 400, 'jobId and result are required');
    ok(res, await graphMemory.organizationRequests.reportBatch(req.params.id, jobId, { result: result as 'committed' | 'no_change' | 'deferred' | 'failed' | 'released', mutations, reason }));
  } catch (err) { failErr(res, err); }
});
app.post('/api/organization/request/:id/finish', async (req, res) => {
  try { ok(res, await graphMemory.organizationRequests.finishRequest(req.params.id, req.body ?? {})); }
  catch (err) { failErr(res, err); }
});
app.post('/api/organization/request/:id/cancel', async (req, res) => {
  try { ok(res, await graphMemory.organizationRequests.cancelRequest(req.params.id, String(req.body?.reason ?? 'cancelled'))); }
  catch (err) { failErr(res, err); }
});

// ---- Maintenance (no LLM needed: decay + archive + community detection) ----
app.post('/api/maintenance/run', async (_req, res) => {
  if (!requireOperator(_req, res)) return;
  try {
    const result = await consolidation.runMaintenance();
    ok(res, result);
  } catch (err) {
    failErr(res, err);
  }
});

// ---- bootstrap ----
async function main() {
  await graphMemory.init();
  // NOTE: nightly 03:00 timer is NOT armed in service mode — the HOST agent
  // schedules maintenance/weave by calling the endpoints (MindPond has no
  // timers of its own; the host decides when to run periodic work).
  if (!API_KEY && !['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
    console.warn('[mindpond] WARNING: HTTP API is listening outside loopback without MEMORY_API_KEY');
  }
  const listener = app.listen(PORT, HOST, () => {
    const address = listener.address();
    const port = address && typeof address === 'object' ? address.port : PORT;
    console.log(`[mindpond] listening on ${HOST}:${port} (db=${process.env.MEMORY_DB_PATH}, llm=host-provided)`);
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await graphMemory.collaboration.closeWaits();
    for (const stream of actionStreams) stream.end();
    const deadline = setTimeout(() => listener.closeAllConnections(), 30_000);
    deadline.unref();
    try {
      await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
      await graphMemory.close();
    } catch (error) {
      console.error('[mindpond] shutdown failed:', error);
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
      // Native inference runtimes may retain handles after their model workers
      // and SQLite have drained. A service shutdown must still terminate.
      process.exit(process.exitCode ?? 0);
    }
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

main().catch((err) => {
  console.error('[mindpond] fatal:', err);
  process.exit(1);
});
