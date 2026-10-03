/**
 * MindPond — standalone layered graph memory system
 *
 * A memory "pond": scoped knowledge with independent memberships, contextual
 * ripple associations, optional support profiles, and an action audit log.
 *
 * Design rule (user mandate): MindPond NEVER owns an LLM API key.
 * All LLM judgment (extraction, clustering, distillation, edge weaving) is
 * supplied by the HOST AGENT in one of two ways:
 *
 *   ① Programmatic: inject your own LLM function at construction.
 *        const pond = new MindPond({ llm: myLLMFn, dbPath });
 *        await pond.init();
 *      myLLMFn(prompt, system?) => Promise<string> returns raw text;
 *      MindPond parses JSON defensively from the reply.
 *
 *   ② Service mode: `mindpond-server` exposes two-phase endpoints —
 *      MindPond proposes (GET pending/candidates + prompt), the host agent's
 *      LLM judges, the host commits (POST commit). Zero LLM inside the pond.
 *
 * Associations are explicit, scoped and contextual. Model budgets are chosen
 * by the host for its actual model; the request driver bounds total execution.
 */

import { GraphMemory, MemoryNode, MemoryEdge, Dimension, MemoryLayer, SearchResult, RecallFeedbackInput, MemoryUseReportInput } from './core/graph-memory.js';
import { MemoryPipelineManager } from './core/memory-pipeline.js';
import { MemoryConsolidation } from './core/memory-consolidation.js';
import { LLMClient } from './core/llm.js';
import type { MemoryDomainRef, DomainReadContext } from './core/domain.js';
import { defaultDatabasePath } from './core/runtime-paths.js';
export { normalizeDomain, signTeamWriteGrant, verifyTeamWriteGrant } from './core/domain.js';
export type { MemoryDomainRef, MemoryDomainKind, TeamOperation, TeamWriteGrant } from './core/domain.js';
export { EMBEDDING_PRESETS,embeddingProfileSchema,embeddingRuntimeSchema,rerankerProfileSchema,retrievalConfigSchema } from './core/embedding-profiles.js';
export type { EmbeddingProfile,EmbeddingRuntime,RetrievalConfig,RetrievalConfigInput,RerankerProfile } from './core/embedding-profiles.js';
export type { ProfileEncoder,ProfileEmbeddingResult,EmbeddingRole } from './core/profile-embedding.js';
export type { ProfileRetrievalDependencies } from './core/profile-retrieval.js';

// ─── The one capability the host may supply ─────────────────────────────────

/**
 * Minimal chat contract: prompt (+ optional system) → raw text.
 * MindPond parses JSON defensively from the reply.
 * Legacy extraction callback; prefer the bounded organization driver for new integrations.
 */
export type LLMFn = (prompt: string, system?: string) => Promise<string>;
const ASSOCIATIVE_EDGE_LABELS = new Set(['related', 'similar-to', 'caused-by', 'fixes', 'supports']);

/** Adapter: lets MindPond call the host's LLMFn through the internal interface. */
function llmFnToClient(fn: LLMFn): LLMClient {
  return {
    chat: async (messages, _options) => {
      const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n') || undefined;
      const prompt = messages.filter(message => message.role !== 'system')
        .map(message => `${message.role}: ${message.content}`).join('\n\n');
      const content = await fn(prompt, system);
      return { choices: [{ message: { content } }] };
    },
  };
}

export interface MindPondOptions {
  retrieval?:import('./core/embedding-profiles.js').RetrievalConfigInput;
  retrievalDependencies?:import('./core/profile-retrieval.js').ProfileRetrievalDependencies;
  /** SQLite database file path (default: ./data/mindpond.db) */
  dbPath?: string;
  /**
   * Host-supplied LLM function. Omit it in pure service mode (two-phase HTTP
   * endpoints) — MindPond itself never holds a key.
   */
  llm?: LLMFn;
  /** Max associative out-edges per node (default 6) */
  maxDegree?: number;
}

export type {KnowledgeDimension,MemoryAnchor,StoredAnchor} from './core/graph-memory.js';
export interface SaveOptions {
  dimensions?:import('./core/knowledge.js').KnowledgeDimension[];
  anchors?:import('./core/anchors.js').MemoryAnchor[];
  sourceRefs?: import('./core/growth.js').SourceReference[];
  idempotencyKey?: string;
  dimension?: Dimension;
  source?: string;
  tags?: string[];
  sessionId?: string;
  /** Ownership/lifecycle boundary. Defaults to sessionId's session, otherwise personal/default. */
  domain?: MemoryDomainRef;
  /** Host-issued HMAC grant required for semantic writes to a team domain. */
  teamAuthorization?: string;
  importance?: number;
  /** [{memoryId, score 0-1, label?}] — only ids ACTUALLY READ this turn via search() */
  memberships?: Array<{ spaceId: string; memoryType?: string }>;
  related?: import('./core/graph-memory.js').RelatedMemory[];
}

export interface SaveResult {
  id: string;
  edgesCreated: number;
  edgesRejected: number;
}

/**
 * The public interface any agent installs. Three integration modes:
 *   1. In-process:   `const pond = new MindPond({ llm }); await pond.init();`
 *   2. HTTP service: `mindpond-server` (two-phase endpoints for remote agents)
 *   3. MCP:          `mindpond-mcp` (stdio, for MCP-capable agents)
 */
export class MindPond {
  readonly graph: GraphMemory;
  private pipeline: MemoryPipelineManager;
  private consolidation: MemoryConsolidation;
  private llm?: LLMFn;

  constructor(opts: MindPondOptions = {}) {
    this.llm = opts.llm;
    this.graph = new GraphMemory('.', { maxDegree: opts.maxDegree, dbPath: opts.dbPath ?? defaultDatabasePath(),retrieval:opts.retrieval,retrievalDependencies:opts.retrievalDependencies });
    const client = this.llm ? llmFnToClient(this.llm) : undefined;
    this.pipeline = new MemoryPipelineManager(this.graph, client as LLMClient);
    this.consolidation = new MemoryConsolidation(this.graph, client as LLMClient);
  }

  /** Open DB, warm embedding model. Call once before anything else. */
  async init(): Promise<void> {
    await this.graph.init();
  }
  async retrievalProfiles(){return this.graph.retrievalProfiles();}
  async retrievalDevices(){return this.graph.retrievalDevices();}
  async buildRetrievalProfile(id:string,maxItems=64){return this.graph.buildRetrievalProfile(id,maxItems);}
  async activateRetrievalProfile(id:string){return this.graph.activateRetrievalProfile(id);}

  async close(): Promise<void> {
    this.pipeline.stop();
    await this.pipeline.drain();
    await this.graph.close();
  }

  // ─── Core daily loop: search / save / expand ──────────────────────────────

  /**
   * Search: keyword + vector + graph traversal with scoring.
   * Results carry node.id — the host LLM uses them to fill related[] on save.
   */
  async search(query: string, opts?: {
    retrievalProfile?:string;vectorAlgorithm?:'exact'|'hnsw';reranker?:string;
    candidateLimit?:number; queries?:string[]; useAnchors?:boolean; includeEvents?:boolean;
    limit?: number;
    sessionId?: string;
    domains?: MemoryDomainRef[];
    spaceId?: string | string[];
    memoryType?: string | string[];
    sourceContext?: string;
    dimension?: Dimension;
    layer?: MemoryLayer;
    minScore?: number;
    maxDepth?: number;
  }): Promise<SearchResult[]> {
    return this.graph.search({reranker:opts?.reranker,retrievalProfile:opts?.retrievalProfile,vectorAlgorithm:opts?.vectorAlgorithm,queries:opts?.queries,useAnchors:opts?.useAnchors,includeEvents:opts?.includeEvents,
      query,candidateLimit:opts?.candidateLimit,
      spaceId: opts?.spaceId, memoryType: opts?.memoryType,
      sourceContext: opts?.sourceContext,
      limit: opts?.limit ?? 10,
      sessionId: opts?.sessionId,
      domains: opts?.domains,
      dimension: opts?.dimension,
      layer: opts?.layer,
      minScore: opts?.minScore,
      maxDepth: opts?.maxDepth,
    });
  }

  /** Search plus a durable recallId for host adoption feedback. */
  async recall(query: string, opts?: {
    retrievalProfile?:string;vectorAlgorithm?:'exact'|'hnsw';reranker?:string;
    contextBudgetBytes?:number;
    candidateLimit?:number; queries?:string[]; useAnchors?:boolean; includeEvents?:boolean;
    limit?: number; sessionId?: string; domains?: MemoryDomainRef[]; spaceId?: string | string[];
    memoryType?: string | string[]; sourceContext?: string; dimension?: Dimension; layer?: MemoryLayer;
    minScore?: number; maxDepth?: number; runId?: string; hostId?: string;
  }) {
    return this.graph.recall({ query,retrievalProfile:opts?.retrievalProfile,vectorAlgorithm:opts?.vectorAlgorithm,reranker:opts?.reranker,candidateLimit:opts?.candidateLimit,queries:opts?.queries,contextBudgetBytes:opts?.contextBudgetBytes,useAnchors:opts?.useAnchors,includeEvents:opts?.includeEvents, spaceId: opts?.spaceId, memoryType: opts?.memoryType,
      sourceContext: opts?.sourceContext, limit: opts?.limit ?? 10, sessionId: opts?.sessionId,
      domains: opts?.domains, dimension: opts?.dimension, layer: opts?.layer,
      minScore: opts?.minScore, maxDepth: opts?.maxDepth, runId: opts?.runId, hostId: opts?.hostId });
  }

  /** A bounded task recall for host agents; full records are never truncated. */
  async directory(context?:import('./core/domain.js').DomainReadContext,limit?:number) {return this.graph.memoryDirectory(context,limit);}
  async history(nodeId:string,context?:import('./core/domain.js').DomainReadContext,before?:number,limit?:number,includeContent=false) {return this.graph.memoryHistory(nodeId,context,before,limit,includeContent);}
  async events(query:import('./core/graph-memory.js').MemoryQuery) {return this.graph.eventRecall(query);}
  async finish(input:import('./core/graph-memory.js').MemoryFinishInput) {return this.graph.finishMemoryStage(input);}
  async brief(task:string, opts?:{retrievalProfile?:string;vectorAlgorithm?:'exact'|'hnsw';reranker?:string;candidateLimit?:number;includeDirectory?:boolean;queries?:string[];sinceDimensionRevision?:number;query?:string;contextBudgetBytes?:number;limit?:number;sessionId?:string;domains?:MemoryDomainRef[];
    spaceId?:string|string[];memoryType?:string|string[];sourceContext?:string;runId?:string;hostId?:string}) {
    return this.graph.taskBrief(task,opts);
  }

  async getDimensionConfiguration(){return this.graph.getDimensionConfiguration();}
  async getDimensionPolicy(){return this.graph.getDimensionPolicy();}
  async configureDimensions(input:Parameters<GraphMemory['configureDimensions']>[0]){return this.graph.configureDimensions(input);}

  async reportMemoryUse(input:MemoryUseReportInput) { return this.graph.reportMemoryUse(input); }
  async listImprovementSignals(context:DomainReadContext,limit?:number) { return this.graph.listImprovementSignals(context,limit); }
  async resolveImprovementSignal(input:{signalId:string;status:'reviewed'|'deferred'|'dismissed';reason:string;context:DomainReadContext}) {
    return this.graph.resolveImprovementSignal(input);
  }

  /** Explicit evidence traversal is separate from ordinary ripple. */
  async trace(nodeId:string,context:import('./core/domain.js').DomainReadContext,maxDepth=3,limit=50) { return this.graph.traceMemory(nodeId,context,maxDepth,limit); }

  async reportRecallFeedback(input: RecallFeedbackInput) { return this.graph.reportRecallFeedback(input); }
  async recallFeedbackSummary() { return this.graph.recallFeedbackSummary(); }

  /**
   * Save a memory. If the host LLM read memories via search() this turn, it
   * MUST pass related[] scoring each read memory's relevance to this one
   * (real-time edge building — the user's design). No search this turn →
   * no related[] → no edges. NEVER search just to build edges.
   */
  async save(content: string, opts: SaveOptions = {}): Promise<SaveResult> {
    return this.graph.saveMemory(content, opts);
  }

  /** Read-only save diagnosis. Final save rechecks mutable state and idempotency. */
  async validateSave(content: string, opts: SaveOptions = {}) {
    return this.graph.validateMemorySave({ ...opts, content });
  }

  /** Expand a node (on-demand deep dive, capped at maxChars). */
  async expand(nodeId: string, maxChars = 800): Promise<MemoryNode | null> {
    const node = await this.graph.getNodeById(nodeId, { trackAccess: true });
    if (!node) return null;
    return { ...node, content: node.content.slice(0, maxChars) };
  }

  // ─── Node & edge management (all mutations audited in memory_action_log) ──

  /** Fetch one node by id. Pass trackAccess=true to count a recall. */
  async get(nodeId: string, trackAccess = false): Promise<MemoryNode | null> {
    return this.graph.getNodeById(nodeId, { trackAccess });
  }

  /** Atomic edit; source changes require expectedUpdatedAt from a fresh read. */
  async update(nodeId: string, patch: Parameters<GraphMemory['editMemory']>[1]): Promise<boolean> {
    const existing = await this.graph.getNodeById(nodeId, { trackAccess: false });
    if (!existing) return false;
    await this.graph.editMemory(nodeId, patch);
    return true;
  }

  /** Hard-delete a node (cascade edges, fully audited). 删除就是删除 — the action log is the history. */
  async remove(nodeId: string, reason = 'host-requested delete'): Promise<boolean> {
    const existing = await this.graph.getNodeById(nodeId, { trackAccess: false });
    if (!existing) return false;
    await this.graph.deleteNode(nodeId, reason);
    return true;
  }

  /** Hard-delete one edge by id (audited). */
  async removeEdge(edgeId: string, reason = 'host-requested delete'): Promise<boolean> {
    return this.graph.deleteEdge(edgeId, reason);
  }

  /** Paged node listing with optional filters. */
  async list(opts: { layer?: MemoryLayer; dimension?: Dimension; sessionId?: string; domains?: MemoryDomainRef[]; limit?: number; offset?: number } = {}) {
    return this.graph.listNodes(opts);
  }

  /** One node's connections — both directions (neighbor + edge + direction). */
  async connections(nodeId: string) {
    return this.graph.getConnections(nodeId);
  }

  /** Nodes+edges snapshot for graph visualization. */
  async graphSnapshot(limit = 200) {
    return this.graph.getFullGraph(limit);
  }

  // ─── Redundancy management ────────────────────────────────────────────────

  /**
   * Scan the whole pond for near-duplicate memories (cosine ≥ threshold).
   * Each group names a suggested keeper (importance → access → recency).
   * Search results also carry per-result nearDuplicates flags.
   */
  async findDuplicates(threshold = 0.92) {
    return this.graph.findDuplicates(threshold);
  }

  /**
   * Merge duplicates into the keeper: incident edges are re-pointed to keepId
   * (self-loops and exact clashes dropped), then the doomed nodes are deleted.
   */
  async mergeDuplicates(keepId: string, deleteIds: string[], reason = 'dedupe merge') {
    return this.graph.mergeDuplicates(keepId, deleteIds, reason);
  }

  // ─── Host-driven LLM phases (MindPond proposes, host LLM judges) ──────────

  /**
   * Ingest a raw conversation transcript as an L0 record.
   * Both modes queue extraction atomically; an injected host LLM can call extract().
   */
  async ingestTranscript(transcript: string, sessionId?: string): Promise<string> {
    return (await this.graph.ingestTranscript(transcript, sessionId)).l0Id;
  }

  /** One-shot programmatic L1 extraction (requires injected llm). */
  async extract(): Promise<void> {
    this.requireLLM();
    await this.pipeline.extractL1();
  }

  /**
   * One-shot programmatic weaving (requires injected llm).
   * Service-mode hosts use GET /api/weave/candidates → POST /api/weave/commit.
   */
  async weave(force = false): Promise<{ candidates: number; woven: number }> {
    this.requireLLM();
    return this.consolidation.weaveEdges(force);
  }

  /** @deprecated Legacy scene/persona recipe. Use organization synthesize for generic profiles. */
  async consolidate(): Promise<{ scenes: number; persona: boolean }> {
    this.requireLLM();
    const scenes = await this.consolidation.aggregateL2();
    const persona = await this.consolidation.distillL3();
    return { scenes, persona };
  }

  /** Full maintenance cycle: decay + archive + weave (requires injected llm). */
  async maintenance(): Promise<{ decayed: number; archived: number; woven: number }> {
    this.requireLLM();
    const r = await this.consolidation.runMaintenance();
    return { decayed: r.decayed, archived: r.archived, woven: r.woven };
  }

  // ─── Introspection / frontend support ─────────────────────────────────────

  /** Graph stats for the MindPond frontend. */
  async stats() {
    return this.graph.getStats();
  }

  /** Action audit log (append-only) — frontend timeline & debugging. */
  async actionLog(limit = 100) {
    return this.graph.getActionLog(limit);
  }

  private requireLLM(): void {
    if (!this.llm) {
      throw new Error(
        'MindPond has no LLM (by design — it never holds an API key). ' +
        'Either inject { llm } at construction, or drive the two-phase ' +
        'service endpoints with your agent\'s own LLM.'
      );
    }
  }
}

export { GraphMemory, VALID_DIMENSIONS } from './core/graph-memory.js';
export type { MemoryNode, MemoryEdge, Dimension, MemoryLayer, SearchResult, RecallResult, RecallFeedbackInput, MemoryUseReportInput, RecallFeedbackSummary, RecallDisposition, MemoryQuery, ExtractionJob, ExtractionCaptureContext,
  MemoryMembership, MemoryAssociation, AssociationBasis, AssociationEvidence, RelatedMemory, OrganizationJob, OrganizationPlan } from './core/graph-memory.js';
export { MemoryPipelineManager } from './core/memory-pipeline.js';
export type { PipelineConfig } from './core/memory-pipeline.js';
export { MemoryConsolidation } from './core/memory-consolidation.js';
export type { ConsolidationConfig } from './core/memory-consolidation.js';
export type { LLMClient, ChatMessage, ChatOptions, ChatResponse } from './core/llm.js';
export { MindPondError, toStructuredError, httpStatus } from './core/errors.js';
export type { MindPondErrorCode, ErrorShape } from './core/errors.js';
export { WorkDriver, TransientModelError } from './core/work-driver.js';
export type { ModelAdapter, ModelCallContext, WorkPond, WorkTurnContext, WorkTurnResult, WorkDriverOptions, WorkDriverResult, WorkFinishInput, WorkOutcome } from './core/work-driver.js';

export { MEMORY_SAVE_POLICY, MEMORY_SAVE_TOOL_DESCRIPTION, MEMORY_RESIDENT_SAVE_POLICY, MEMORY_SAVE_POLICY_VERSION, MEMORY_SAVE_LIMITS, memorySavePolicyPayload } from './core/save-policy.js';

export type {SourceReference, SourceObservation, CheckpointInput, SynthesizeOperation, ProfileSpec, Freshness} from "./core/growth.js";
export {capabilities, HOST_POLICY, hostOperations} from "./core/host-contract.js";
export {organizationTask, organizationPolicyPayload, ORGANIZATION_POLICY, ORGANIZATION_POLICY_VERSION} from './core/organization-policy.js';
export {driveOrganizationRequest} from './core/organization-driver.js';
export type {OrganizationDriverLLM} from './core/organization-driver.js';
export type {OrganizationRequestProgress, OrganizationRequestReceipt, BatchReport} from './core/organization-request.js';

export { protocolRulesResponse, protocolRulesPayload, PROTOCOL_VERSION } from './core/protocol.js';
export { signContextToken, verifyContextToken } from './core/trust.js';
export type { TrustedCallContext, TrustedTokenInput } from './core/trust.js';
export { retrievalStatus } from './core/retrieval-status.js';
export { prepareLifecycleEvent, LIFECYCLE_POLICY, LIFECYCLE_POLICY_VERSION } from './core/lifecycle.js';
export type { LifecycleEvent, LifecycleObservation } from './core/lifecycle.js';

export { MEMORY_BOOTSTRAP } from './core/bootstrap.js';
export { prepareClientBundle, readClientBundle, removeClientBundle, clientLaunch } from './integrations/client-bundle.js';
export type { MemoryClient, ClientBundleOptions } from './integrations/client-bundle.js';

export { assembleRecall, recallEntry } from './core/context-assembly.js';
export type { RecallBudget } from './core/context-assembly.js';

export type {DimensionConfiguration,DimensionDefinition} from './core/dimension-config.js';

export { createOpenCodeMemoryPlugin } from './integrations/opencode-plugin.js';
export type { OpenCodeMemoryOptions } from './integrations/opencode-plugin.js';
export type { MemoryFinishInput, MemoryEditPatch } from './core/graph-memory.js';
