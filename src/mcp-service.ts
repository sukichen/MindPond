import { recallEntry } from './core/context-assembly.js';
import { MEMORY_BOOTSTRAP } from './core/bootstrap.js';
import { parseMcpToolProfile, exposesMcpTool } from './core/mcp-tool-profile.js';
import { authorizeOrganizationAccess } from './core/organization-access.js';
import { normalizeDomain } from './core/domain.js';
import { anchorSchema, dimensionsSchema, hostOperations, sourceReferenceSchema, domainSchema, organizationPlanSchema } from './core/host-contract.js';
/**
 * agent-memory — MCP stdio server.
 *
 * Exposes tools over the Model Context Protocol so any MCP-capable
 * agent (Claude Code, OpenClaw/dsh, etc.) can use the memory graph:
 *   memory_search {query, limit?}          → results carry node ids + nearDuplicates
 *   memory_save  {content, related?[]}     → related = relevance scores for
 *                                            memories ACTUALLY read this turn
 *   memory_expand {nodeId, maxChars?}      → full record of one node
 *   memory_get / memory_update / memory_delete / memory_list / memory_connections
 *   memory_edge_delete                     → hard delete (audited)
 *   memory_dedupe_scan / memory_dedupe_resolve → find & merge near-duplicates
 *
 * Storage goes straight to the same GraphMemory core (no HTTP hop needed).
 * Env: MEMORY_DB_PATH, MEMORY_TRUST_*, EMBEDDING_MODEL_DIR. No model keys.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GraphMemory } from './core/graph-memory.js';
import { MemoryConsolidation } from './core/memory-consolidation.js';
import { MEMORY_SAVE_TOOL_DESCRIPTION, memorySavePolicyPayload } from './core/save-policy.js';
import { organizationPolicyPayload, organizationTask } from './core/organization-policy.js';
import { protocolRulesResponse } from './core/protocol.js';
import { MindPondError, toStructuredError } from './core/errors.js';
import { narrowTrustedContext, narrowTrustedSaveContext, narrowTrustedDomain, narrowTrustedDomains, narrowTrustedSession, type TrustedCallContext } from './core/trust.js';
import type { DomainReadContext, MemoryDomainRef } from './core/domain.js';

import { MemoryPipelineManager } from './core/memory-pipeline.js';
import type { McpToolProfile } from './core/mcp-tool-profile.js';

/** Same catalog and scope checks for stdio and each authenticated HTTP connection. */
export function createMemoryMcpServer(graphMemory:GraphMemory, options:{trusted?:TrustedCallContext;toolProfile?:McpToolProfile}={}) {
const trustBound=options.trusted!==undefined;
const trusted=options.trusted??{v:1 as const,principal:'stdio-host',issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const TRUST_SESSION=trusted.sessionId??'';
const TRUST_DOMAINS=trusted.domains??[];
/** Narrow tool arguments to the bound trusted context before they reach core. */
function callerContext(): DomainReadContext | undefined {
  return trustBound && !trusted.operator ? narrowTrustedContext(trusted, {}) as DomainReadContext : undefined;
}
function bound<T extends { sessionId?: unknown; domains?: unknown; domain?: unknown; scope?: unknown }>(args: T): T {
  if (!trustBound) return args;
  const next: any = { ...args };
  if ('sessionId' in args) {
    const session = narrowTrustedSession(trusted, next.sessionId);
    next.sessionId = next.sessionId === undefined && next.domain && next.domain.kind !== 'session' ? undefined : session;
  }
  if ('domains' in args) next.domains = narrowTrustedDomains(trusted, next.domains, next.sessionId);
  if ('domain' in args) next.domain = narrowTrustedDomain(trusted, normalizeDomain(next.domain, next.sessionId), next.sessionId);
  if (next.scope !== undefined) narrowTrustedContext(trusted, { scope: next.scope });
  return next;
}

const pipeline = new MemoryPipelineManager(graphMemory, undefined);
// MindPond never creates an LLM client.  The calling agent owns judgement and
// uses the durable two-phase tools below.
const hostConsolidation = new MemoryConsolidation(graphMemory, undefined);

const server = new McpServer({
  name: 'agent-memory',
  version: '0.1.0',
}, { instructions: MEMORY_BOOTSTRAP });

const toolProfile = parseMcpToolProfile(options.toolProfile);
const exposedTools: string[] = [];
let closing=false;
const activeCalls=new Set<Promise<unknown>>();

/** R01: every tool failure returns isError with the structured error shape
 * (code/retryable/nextAction) so MCP clients react to data, not prose. */
function tool(name: string, description: string, shape: any, handler: (args: any) => Promise<any>) {
  if (!exposesMcpTool(toolProfile, name)) return;
  exposedTools.push(name);
  server.tool(name, description, shape, async (args: any) => {
    if(closing)return {content:[{type:'text' as const,text:'Memory server is closing; retry the same operation key'}],isError:true};
    let release!:()=>void;const active=new Promise<void>(r=>release=r);activeCalls.add(active);
    try {
      // Zod omits absent optional keys. Preserve declared context slots for
      // handwritten tools too, so bound() applies the host's default scope.
      args = { ...args };
      for (const key of ['sessionId', 'domain', 'domains']) if (key in shape && !(key in args)) args[key] = undefined;
      if (trustBound) {
        if(name.startsWith('memory_work_') && typeof args.workId==='string' && !trusted.operator) {
          const domain=await graphMemory.hostWorkDomain(args.workId);
          if(!domain)throw new MindPondError('scope_denied','host work target is unavailable in the trusted context');
          narrowTrustedDomain(trusted,domain,trusted.sessionId);
        }
        if (!trusted.operator && (name === 'memory_dedupe_scan' || name === 'memory_dedupe_resolve' || /^memory_l[23]_/.test(name)))
          throw new MindPondError('scope_denied', 'global deduplication and legacy aggregation require operator capability');
        if (name.startsWith('memory_organization_')) await authorizeOrganizationAccess(graphMemory, args, trusted);
        if (name === 'memory_save' || name === 'memory_save_validate') {
          Object.assign(args, narrowTrustedSaveContext(trusted, args));
        }
      }
      const result = await handler(args);
      await graphMemory.logAction({action:result.isError?'host_tool_failed':'host_tool_completed',nodeId:typeof args.nodeId==='string'?args.nodeId:undefined,domain:trustBound&&!trusted.operator?(TRUST_SESSION?{kind:'session',id:TRUST_SESSION}:TRUST_DOMAINS[0]):undefined,reason:JSON.stringify({tool:name,...(trustBound?{principal:trusted.principal}:{})})});
      if (name === 'memory_capabilities') {
        const entry = result.content?.find((c: any) => c.type === 'text');
        if (entry) {
          const payload = JSON.parse(entry.text);
          entry.text = JSON.stringify({ ...payload, mcpConnection: { toolProfile, availableTools: exposedTools,
            sessionId: TRUST_SESSION || null, domains: TRUST_DOMAINS,
            maintenance: toolProfile === 'work' ? 'Bulk requests, worker draining, legacy and destructive administration need a separate full-profile connection (MINDPOND_TOOL_PROFILE=full). The work profile supports scoped saves, edits, small organization jobs and collaboration tasks.' : 'All tools are exposed.' } });
        }
      }
      return result;
    } catch (err) {
      const e = toStructuredError(err);
      await graphMemory.logAction({action:'host_tool_failed',domain:trustBound&&!trusted.operator?(TRUST_SESSION?{kind:'session',id:TRUST_SESSION}:TRUST_DOMAINS[0]):undefined,reason:JSON.stringify({tool:name,code:e.code,...(trustBound?{principal:trusted.principal}:{})})});
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e }) }], isError: true };
    } finally {release();activeCalls.delete(active);}
  });
}

for (const op of hostOperations(graphMemory)) {
  tool(op.name, op.description, op.schema.shape, async (args: any) => {
    const shape = op.schema.shape as Record<string, unknown>;
    const scoped = { ...args };
    for (const key of ['sessionId', 'domain', 'domains']) if (key in shape && !(key in scoped)) scoped[key] = undefined;
    return {content:[{type:'text' as const,text:JSON.stringify(await op.run(op.schema.parse(bound(scoped)),callerContext()))}]};
  });
}

// A01: optional equivalent discovery channel for MCP-capable hosts. Same
// payload as the memory_protocol_rules tool / GET /api/protocol/rules, but
// without negotiation args (full rules, no caching) — hosts that can read
// resources use this instead of spending a tool call.
server.registerResource('protocol-rules', 'mindpond://protocol/rules', {
  title: 'MindPond protocol rules',
  description: 'Host protocol version, section digests and short rules — equivalent to the memory_protocol_rules tool without arguments.',
  mimeType: 'application/json',
}, async () => ({
  contents: [{ uri: 'mindpond://protocol/rules', mimeType: 'application/json', text: JSON.stringify({...protocolRulesResponse(),...await graphMemory.dimensionPolicyDelta()}) }],
}));

tool(
  'memory_search',
  'Search the layered memory graph (ripple retrieval across L0-L3). Response includes recallId; after the task report used/rejected/unassessed decisions with memory_recall_feedback. Results include node ids — use them to fill related[] when saving. nearDuplicates flags redundant memories (cosine ≥ 0.92) you may merge with memory_dedupe_resolve.',
  {
    sourceContext: z.string().optional().describe('Source checkout/ref context for freshness evaluation'),
    query: z.string().describe('Search query text'),
    retrievalProfile:z.string().min(1).max(64).optional().describe('Configured complete model profile from memory_retrieval_profiles; legacy selects the compatibility index'),
    vectorAlgorithm:z.enum(['exact','hnsw']).optional().describe('Exact by default; optional HNSW preserves domain filters and reports unavailable accelerator fallback'),
    reranker:z.string().min(1).max(64).optional().describe('Optional configured local cross-encoder; reorders candidates without changing ripple weights'),
    queries:z.array(z.string().min(1).max(10000)).max(4).optional().describe('Alternate entrances; all seed one shared ripple and one recall receipt.'),
    candidateLimit:z.number().int().min(1).max(500).optional().describe('Exploration candidates before output count/byte budgets; default 40 when budgeted.'),
    contextBudgetBytes:z.number().int().min(32).max(2000000).optional().describe('Budget for complete JSON result records in UTF-8 bytes, not token count; skipped records are reported, never truncated.'),
    limit: z.number().optional().describe('Max results (default 10)'),
    sessionId: z.string().optional().describe('Session filter'),
    domains: z.array(domainSchema).min(1).max(32).optional().describe('Host-supplied readable domains; default personal/default plus current session'),
    spaceId: z.union([z.string(), z.array(z.string())]).optional().describe('Restrict ripple to independent space(s)'),
    memoryType: z.union([z.string(), z.array(z.string())]).optional().describe('Restrict ripple to type(s) within a space'),
    maxDepth: z.number().int().min(0).max(5).optional(),
    minScore: z.number().min(0).optional(),
    includeL0: z.boolean().optional(),includeEvents:z.boolean().optional(),useAnchors:z.boolean().optional(),
    layer: z.enum(['L0', 'L1', 'L2', 'L3']).optional(),
    runId: z.string().optional().describe('Host run identity for later adoption feedback'),
    hostId: z.string().optional().describe('Stable host identity for later adoption feedback'),
  },
  async (params) => {
    const a = bound(params);
    const recall = await graphMemory.recall({ ...a, limit: a.limit ?? 10 });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { recallId: recall.recallId,retrieval:recall.retrieval, results: recall.results.map(recallEntry), ...(recall.contextBudget?{contextBudget:recall.contextBudget}:{}) },
          ),
        },
      ],
    };
  },
);

tool(
  'memory_save',
  MEMORY_SAVE_TOOL_DESCRIPTION,
  {
    dimension:z.string().min(1).max(128).optional().describe('Legacy host classification; prefer configured dimensions'),    dimensions:dimensionsSchema.optional(),anchors:z.array(anchorSchema).max(6).optional(),
    sourceRefs: z.array(sourceReferenceSchema).max(64).optional(),
    idempotencyKey: z.string().min(1).max(256).optional(),
    content: z.string().trim().min(1).max(100000).describe('One self-contained useful unit: object/scope, facts or procedure, conditions, observed basis, exceptions. Omit unsupported sections; no empty headings.'),
    source: z.enum(['conversation', 'skill', 'reflection', 'external']).optional().default('conversation'),
    tags: z.array(z.string()).optional(),
    sessionId: z.string().optional(),
    domain: domainSchema.optional().describe('Ownership/lifecycle domain; session requires matching sessionId'),
    teamAuthorization: z.string().optional().describe('Host-signed user-initiated grant required for team writes'),
    importance: z.number().int().min(1).max(10).optional().describe('Reusable value, not confidence: 1–3 low, 4–6 normal (default 5), 7–8 high, 9–10 rare foundational constraints'),
    memberships: z.array(z.object({ spaceId: z.string().trim().min(1).max(128), memoryType: z.string().trim().min(1).max(128) })).min(1).max(16).optional()
      .describe('Independent placements for this one canonical memory body'),
    related: z
      .array(
        z.object({
          memoryId: z.string().optional().describe('Actual-read canonical memory ID'),
          membershipId: z.string().optional().describe('Exact target membership from actual-read memory'),
          spaceId: z.string().optional(), memoryType: z.string().optional(),
          reason: z.string().trim().min(1).max(2000).describe('Concrete co-recall benefit and observed basis'),
          context: z.string().trim().min(1).max(2000).describe('Self-contained applicability conditions and exceptions'),
          score: z.number().min(0).max(1).describe('Relevance score 0-1'),
          label: z.enum(['related', 'similar-to', 'caused-by', 'fixes', 'supports']).optional(),
        }),
      ).max(64)
      .optional(),
  },
  async ({ content, dimension, dimensions, anchors, source, tags, sessionId, domain, teamAuthorization, importance, memberships, related, sourceRefs, idempotencyKey }) => {
    const result = await graphMemory.saveMemory(content, bound({ dimension, dimensions, anchors, source, tags, sessionId, domain, teamAuthorization, importance, memberships, related, sourceRefs, idempotencyKey }));
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

tool('memory_save_policy', 'Get standardized memory-save rules, content template, field limits, complete example, and counterexamples for any host agent.', {},
  async () => ({ content: [{ type: 'text', text: JSON.stringify({ policy: memorySavePolicyPayload(await graphMemory.getDimensionPolicy()) }) }] }));

tool(
  'memory_membership_add',
  'Place an existing canonical memory body into an independent semantic space. This does not copy its content and does not create an association.',
  { memoryId: z.string(), spaceId: z.string(), memoryType: z.string(), teamAuthorization:z.string().optional() },
  async ({ memoryId, spaceId, memoryType, teamAuthorization }) => ({
    content: [{ type: 'text', text: JSON.stringify({ membership: await graphMemory.addMembership(memoryId, spaceId, memoryType, teamAuthorization, callerContext()) }) }],
  }),
);

tool(
  'memory_association_upsert',
  'Create or reweight one bidirectional ripple association. Both membership ids must already be active in the exact same space and memory type; cross-space links are rejected. Provide a concrete reason and self-contained applicability context; preserve earlier situational bases.',
  { memberAId: z.string(), memberBId: z.string(), spaceId: z.string(), memoryType: z.string(), weight: z.number().min(0).max(1), reason: z.string().trim().min(1).max(2000), context: z.string().trim().min(1).max(2000), teamAuthorization:z.string().optional() },
  async ({ memberAId, memberBId, spaceId, memoryType, weight, reason, context, teamAuthorization }) => ({
    content: [{ type: 'text', text: JSON.stringify({ association: await graphMemory.upsertAssociation(memberAId, memberBId, spaceId, memoryType, weight, { reason, context }, teamAuthorization, callerContext()) }) }],
  }),
);

tool(
  'memory_association_review',
  'Review ONE recorded situational basis after reading both full endpoints and all evidence. confirm only if its original conditions still apply; retire only with concrete evidence it no longer holds, never merely because the current task differs. Uncertainty: do not change it. Original observations and review history remain. When all bases are retired the edge stops ripple propagation. Confirm can restore a retired basis.',
  { id: z.string(), evidenceId: z.string(), decision: z.enum(['confirm', 'retire']), reason: z.string().trim().min(1).max(2000), expectedUpdatedAt: z.number().optional(), teamAuthorization:z.string().optional() },
  async ({ id, evidenceId, decision, reason, expectedUpdatedAt, teamAuthorization }) => ({ content: [{ type: 'text', text: JSON.stringify(
    await graphMemory.reviewAssociationEvidence(id, evidenceId, decision, reason, expectedUpdatedAt, teamAuthorization, callerContext())) }] }),
);

tool(
  'memory_organization_policy',
  'Return the versioned organization.v2 rules that the host must give its LLM together with an organization snapshot.',
  {},
  async () => ({ content: [{ type: 'text', text: JSON.stringify({ policy: organizationPolicyPayload(), savePolicy: memorySavePolicyPayload(await graphMemory.getDimensionPolicy()) }) }] }),
);

tool(
  'memory_organization_claim',
  'Lease a bounded organization snapshot for a host LLM. It contains all content and membership versions the model may act on. The host must later commit only an explicit plan.',
  { domain:domainSchema.optional(), spaceId: z.string(), memoryType: z.string(), maxMembers: z.number().min(2).max(24).optional(), membershipIds: z.array(z.string()).min(1).max(24).optional() },
  async (params) => {
    const job = await graphMemory.claimOrganizationJob(bound(params));
    return { content: [{ type: 'text', text: JSON.stringify(organizationTask(job)) }] };
  },
);

tool('memory_organization_validate', 'Preview an organization plan without writing; re-checks snapshot and reports removed associations.',
  { jobId: z.string(), plan: organizationPlanSchema },
  async ({ jobId, plan }) => ({ content: [{ type: 'text', text: JSON.stringify(await graphMemory.validateOrganizationPlan(jobId, plan)) }] }));
tool('memory_organization_release', 'Release unused organization material so another host may claim it.',
  { jobId: z.string() }, async ({ jobId }) => { await graphMemory.releaseOrganizationJob(jobId); return { content: [{ type: 'text', text: 'Released' }] }; });
tool('memory_organization_renew', 'Renew an unexpired organization lease for five minutes.',
  { jobId: z.string() }, async ({ jobId }) => ({ content: [{ type: 'text', text: JSON.stringify({ leaseExpiresAt: await graphMemory.renewOrganizationJob(jobId) }) }] }));
tool('memory_spaces', 'List available space/type pairs to scope retrieval and organization.', {},
  async () => ({ content: [{ type: 'text', text: JSON.stringify(await graphMemory.listSpaces(callerContext())) }] }));

tool(
  'memory_organization_commit',
  'Atomically apply a host-generated organization plan to the claimed snapshot. Operations are keep/defer, associate, consolidate, or non-destructive synthesize. Stale snapshots and out-of-batch ids are rejected.',
  {
    jobId: z.string(),
    plan: organizationPlanSchema,
    teamAuthorization:z.string().optional(),
  },
  async ({ jobId, plan, teamAuthorization }) => ({
    content: [{ type: 'text', text: JSON.stringify(await graphMemory.commitOrganizationPlan(jobId, plan as any, teamAuthorization)) }],
  }),
);

tool(
  'memory_expand',
  'Expand one memory node to its full raw record (L0原文). Use when a search summary is not enough. Requires the read context: sessionId and/or domains.',
  {
    nodeId: z.string(),
    sessionId: z.string().optional(),
    domains: z.array(domainSchema).optional(),
    maxChars: z.number().optional().default(800),
  },
  async ({ nodeId, sessionId, domains, maxChars }) => {
    const a = bound({ sessionId, domains });
    if (!a.sessionId && !a.domains?.length) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'domain context required: sessionId, domains' }) }] };
    }
    const node = await graphMemory.getNodeById(nodeId, { trackAccess: true, context: { sessionId: a.sessionId, domains: a.domains } });
    if (!node) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `node not found: ${nodeId}` }) }] };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            id: node.id,
            dimension: node.dimension,
            layer: node.layer,
            content: node.content.slice(0, maxChars ?? 800),
            importance: node.importance,
            tags: node.tags,
            createdAt: node.createdAt,
          }),
        },
      ],
    };
  },
);

tool(
  'memory_ingest',
  'Store a raw L0 transcript for durable extraction. Follow with memory_extraction_job and memory_extraction_commit using the host agent\'s LLM.',
  { transcript: z.string().min(1).max(1000000), sessionId: z.string().optional(), idempotencyKey: z.string().min(1).max(256).optional() },
  async ({transcript,sessionId,idempotencyKey}) => ({content:[{type:'text',text:JSON.stringify({...await graphMemory.ingestTranscript(transcript,bound({sessionId}).sessionId,idempotencyKey),hostDriven:true})}]}),
);

tool('memory_message_save','Host ingestion of one raw message with durable session/message identity. Saves SESSION evidence and extraction work, never personal knowledge.',
  {sessionId:z.string().min(1).max(256),content:z.string().min(1).max(1000000),role:z.string().min(1).max(64),messageId:z.string().min(1).max(256)},
  async ({sessionId,content,role,messageId})=>({content:[{type:'text',text:JSON.stringify({id:await graphMemory.saveMessage(bound({sessionId}).sessionId,content,role,messageId)})}]}));

tool(
  'memory_extraction_job',
  'Claim the next durable L1 extraction job when MindPond has no LLM API key. Send prompt to your own LLM, then commit the reply with the returned job id.',
  {},
  async () => {
    const job = await pipeline.getExtractionJob(trustBound && !trusted.operator ? narrowTrustedContext(trusted, {}) as import('./core/domain.js').DomainReadContext : undefined);
    return { content: [{ type: 'text', text: JSON.stringify({ job }) }] };
  },
);

tool(
  'memory_extraction_commit',
  'Atomically commit extraction with expectedAttempt from job.attempts. Invalid JSON releases only that attempt. An exact committed reply can be retried.',
  { jobId: z.string(), reply: z.string(), expectedAttempt: z.number().int().min(1).optional().describe('Required for a reclaimed job; omission supports only the first attempt') },
  async ({ jobId, reply, expectedAttempt }) => {
    const result = await pipeline.commitExtraction(jobId, reply, expectedAttempt, trustBound && !trusted.operator ? narrowTrustedContext(trusted, {}) as import('./core/domain.js').DomainReadContext : undefined);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);

tool(
  'memory_l2_batch',
  'Claim a single-session L1 scene-aggregation batch in host-driven mode. Send prompt to your own LLM, then use memory_l2_commit. Returns null when no scope has enough ungrouped atoms.',
  {},
  async () => {
    return { content: [{ type: 'text', text: JSON.stringify({ batch: await hostConsolidation.buildL2Batch() }) }] };
  },
);

tool(
  'memory_l2_commit',
  'Commit the host LLM JSON response for an issued memory_l2_batch. A batch id cannot be reused or replaced with arbitrary memory ids.',
  { batchId: z.string(), reply: z.string() },
  async ({ batchId, reply }) => {
    return { content: [{ type: 'text', text: JSON.stringify(await hostConsolidation.commitL2Batch(batchId, reply)) }] };
  },
);

tool(
  'memory_l3_batch',
  'Claim global L2 scenes for a host-driven persona distillation. Session-scoped scenes are excluded from the global persona.',
  {},
  async () => {
    return { content: [{ type: 'text', text: JSON.stringify({ batch: await hostConsolidation.buildL3Batch() }) }] };
  },
);

tool(
  'memory_l3_commit',
  'Commit the host LLM persona text for an issued memory_l3_batch.',
  { batchId: z.string(), reply: z.string() },
  async ({ batchId, reply }) => {
    return { content: [{ type: 'text', text: JSON.stringify(await hostConsolidation.commitL3Batch(batchId, reply)) }] };
  },
);

tool(
  'memory_get',
  'Fetch one memory node by id (no access tracking — use memory_expand to count a recall). Requires the read context: sessionId and/or domains.',
  { nodeId: z.string(), sessionId: z.string().optional(), domains: z.array(domainSchema).optional() },
  async ({ nodeId, sessionId, domains }) => {
    const a = bound({ sessionId, domains });
    if (!a.sessionId && !a.domains?.length) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'domain context required: sessionId, domains' }) }] };
    }
    const node = await graphMemory.getNodeById(nodeId, { trackAccess: false, context: { sessionId: a.sessionId, domains: a.domains } });
    if (!node) return { content: [{ type: 'text', text: JSON.stringify({ error: `node not found: ${nodeId}` }) }] };
    return { content: [{ type: 'text', text: JSON.stringify({ ...node, embedding: undefined,
      memberships: await graphMemory.getMemberships(nodeId), associations: await graphMemory.listAssociations(nodeId, { context: callerContext() }) }) }] };
  },
);

tool(
  'memory_update',
  'Update memory content, dimensions, anchors or metadata, creating an auditable revision. For explicit legacy classification migration, replaceMembershipIds replaces only named active placements in their original spaces; dimensions, expectedUpdatedAt and reason are required. Other custom placements remain independent. Profile inputs require organization.',
  {
    nodeId: z.string(),
    dimensions:dimensionsSchema.optional(),anchors:z.array(anchorSchema).max(6).optional(),
    sourceRefs: z.array(sourceReferenceSchema).max(64).optional(),
    expectedUpdatedAt: z.number().optional(),
    expectedContent:z.string().optional(),
    reason:z.string().min(1).max(2000).optional(),
    replaceMembershipIds:z.array(z.string().min(1)).min(1).optional(),
    content: z.string().optional().describe('New content (rewrites embedding)'),
    importance: z.number().min(1).max(10).optional(),
    tags: z.array(z.string()).optional(),
    verified: z.boolean().optional(),
    sessionId: z.string().optional(),
    domains: z.array(domainSchema).optional(),
    teamAuthorization:z.string().optional(),
  },
  async ({ nodeId, content, dimensions, anchors, importance, tags, verified, sessionId, domains, sourceRefs, expectedUpdatedAt, expectedContent, reason, replaceMembershipIds, teamAuthorization }) => {
    const a = bound({ sessionId, domains });
    if (!a.sessionId && !a.domains?.length) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'domain context required: sessionId, domains' }) }] };
    }
    const result=await graphMemory.editMemory(nodeId,{content,dimensions,anchors,importance,tags,verified,sourceRefs,expectedUpdatedAt,expectedContent,reason,replaceMembershipIds,teamAuthorization,context:{sessionId:a.sessionId,domains:a.domains}});
    return {content:[{type:'text',text:JSON.stringify(result)}]};
  },
);

tool(
  'memory_delete',
  'Hard-delete a memory node (incident edges cascade). Deletion is final — every mutation is recorded in the audit log, which is the history.',
  {
    nodeId: z.string(),
    reason: z.string().optional().describe('Why this memory is being deleted (audit trail)'),
    sessionId: z.string().optional(),
    domains: z.array(domainSchema).optional(),
    teamAuthorization:z.string().optional(),
  },
  async ({ nodeId, reason, sessionId, domains, teamAuthorization }) => {
    const a = bound({ sessionId, domains });
    if (!a.sessionId && !a.domains?.length) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'domain context required: sessionId, domains' }) }] };
    }
    const existing = await graphMemory.getNodeById(nodeId, { trackAccess: false, context: { sessionId: a.sessionId, domains: a.domains } });
    if (!existing) return { content: [{ type: 'text', text: JSON.stringify({ error: `node not found: ${nodeId}` }) }] };
    await graphMemory.deleteNode(nodeId, reason ?? 'host-requested delete', teamAuthorization, { sessionId: a.sessionId, domains: a.domains });
    return { content: [{ type: 'text', text: JSON.stringify({ deleted: true }) }] };
  },
);

tool(
  'memory_edge_delete',
  'Hard-delete one edge by id (audited). Get edge ids from memory_connections.',
  {
    edgeId: z.string(),
    reason: z.string().optional(),
    teamAuthorization:z.string().optional(),
  },
  async ({ edgeId, reason, teamAuthorization }) => {
    const deleted = await graphMemory.deleteEdge(edgeId, reason ?? 'host-requested delete', teamAuthorization, callerContext());
    return { content: [{ type: 'text', text: JSON.stringify(deleted ? { deleted: true } : { error: `edge not found: ${edgeId}` }) }] };
  },
);

tool(
  'memory_list',
  'Paged listing of memory nodes with optional filters (newest first).',
  {
    layer: z.enum(['L0', 'L1', 'L2', 'L3']).optional(),
    dimension: z.string().min(1).max(128).optional(),
    domains:z.array(domainSchema).min(1).max(32).optional(),
    sessionId: z.string().optional(),
    limit: z.number().optional().describe('Default 50, max 500'),
    offset: z.number().optional(),
  },
  async ({ layer, dimension, domains, sessionId, limit, offset }) => {
    const a = bound({ layer, dimension, domains, sessionId, limit, offset }) as { layer?: 'L0'|'L1'|'L2'|'L3'; dimension?: string; domains?: MemoryDomainRef[]; sessionId?: string; limit?: number; offset?: number };
    const { nodes, total } = await graphMemory.listNodes({ layer: a.layer, dimension: a.dimension, domains: a.domains, sessionId: a.sessionId, limit: a.limit, offset: a.offset });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          total,
          nodes: nodes.map(n => ({
            id: n.id, dimension: n.dimension, layer: n.layer, content: n.content,
            importance: n.importance, tags: n.tags, domain:n.domain, createdAt: n.createdAt, accessCount: n.accessCount,
          })),
        }),
      }],
    };
  },
);

tool(
  'memory_connections',
  'List one node\'s connections, BOTH outgoing and incoming (neighbor + edge id/label/weight + direction). Requires the read context: sessionId and/or domains.',
  { nodeId: z.string(), sessionId: z.string().optional(), domains: z.array(domainSchema).optional() },
  async ({ nodeId, sessionId, domains }) => {
    const a = bound({ sessionId, domains });
    if (!a.sessionId && !a.domains?.length) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'domain context required: sessionId, domains' }) }] };
    }
    const connections = await graphMemory.getConnections(nodeId, { sessionId: a.sessionId, domains: a.domains });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(connections.map(({ node, edge, direction }) => ({
          edgeId: edge.id, label: edge.label, weight: edge.weight, direction,
          node: { id: node.id, dimension: node.dimension, layer: node.layer, content: node.content, importance: node.importance },
        }))),
      }],
    };
  },
);

tool(
  'memory_dedupe_scan',
  'Scan the whole memory graph for near-duplicate nodes (cosine ≥ threshold). Returns groups with a suggested keeper. Resolve with memory_dedupe_resolve.',
  { threshold: z.number().min(0.5).max(0.99).optional().describe('Cosine threshold, default 0.92') },
  async ({ threshold }) => {
    const groups = await graphMemory.findDuplicates(threshold ?? 0.92);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(groups.map(g => ({
          keep: { id: g.keep.id, content: g.keep.content, importance: g.keep.importance, accessCount: g.keep.accessCount },
          duplicates: g.duplicates.map(d => ({ id: d.node.id, content: d.node.content, importance: d.node.importance, similarity: d.similarity })),
        }))),
      }],
    };
  },
);

tool(
  'memory_dedupe_resolve',
  'Merge duplicate memories: re-point incident edges to keepId (self-loops/clashes dropped), then delete the duplicates. Audited in memory_action_log.',
  {
    keepId: z.string().describe('Node id to keep'),
    deleteIds: z.array(z.string()).min(1).describe('Duplicate node ids to merge into keepId and delete'),
    reason: z.string().optional(),
  },
  async ({ keepId, deleteIds, reason }) => {
    const result = await graphMemory.mergeDuplicates(keepId, deleteIds, reason ?? 'dedupe merge');
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
);


return {server, async close(){
  if(closing)return;closing=true;
  await Promise.allSettled([...activeCalls]);
  await server.close();
}};
}
