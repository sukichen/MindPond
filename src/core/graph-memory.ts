import { ConnectionCoordinator } from './connection-coordinator.js';
import { auditDatabase } from './database-maintenance.js';
import { ProfileRetrieval, type ProfileRetrievalDependencies } from './profile-retrieval.js';
import type { RetrievalConfigInput } from './embedding-profiles.js';
import {embeddingRuntimeSchema} from './embedding-profiles.js';
import {ProfileVectorIndex} from './profile-vector-index.js';
import { MemoryWorkflow } from './memory-workflow.js';
import { initializeTextIndex, trigramExpression } from './text-index.js';
import { PriorityQueue } from './priority-queue.js';
import { DEFAULT_DIMENSION_CONFIGURATION, LEGACY_DIMENSION_CONFIGURATION, validateDimensionConfiguration, dimensionPolicy, type DimensionConfiguration } from './dimension-config.js';
import { assembleRecall, recallEntry, validateContextBudget, type RecallBudget } from './context-assembly.js';
/**
 * Graph Memory — canonical bodies, independent space memberships, and ripple.
 *
 * `nodes` keep content/provenance and legacy dimension/layer metadata.  A node
 * can have many `memory_memberships`; `memory_associations` are unordered and
 * can join only two active memberships of the same space and type.  Search
 * starts every direct hit in parallel and multiplies only weights on a path.
 * Thus spaces are real boundaries rather than dimension-score penalties.
 *
 * Legacy `edges` remain structural provenance and compatibility storage.  Old
 * associative edges migrate only into their matching `legacy:<dimension>`
 * space, so migration never invents a cross-space relationship.
 */

import * as path from 'path';
import * as crypto from 'crypto';
import sqlite3 from 'sqlite3';
import { open, type Database } from 'sqlite';
import { getEmbeddingService,legacyEmbeddingIdentity,acceptsUnlabelledLegacyVectors } from './embedding.js';
import { VectorIndex, cosineSimilarity, type VectorItem } from './vector-index.js';
import { zhEnabled, zhDims, isChineseText, getZhEmbeddingService,legacyZhEmbeddingIdentity,acceptsUnlabelledZhVectors } from './embedding-zh.js';
import { createModuleLogger } from '../infra/logger.js';
import { getErrorMessage } from '../infra/errors.js';
import { debugTrace } from '../infra/debug-tracer.js';
import { MEMORY_SAVE_LIMITS } from './save-policy.js';
import { normalizeDimensions, legacyDimension, dimensionPlacements, type KnowledgeDimension } from './knowledge.js';
import { AnchorStore, normalizeAnchors, diagnoseAnchors, anchorIssueField, type MemoryAnchor, type StoredAnchor, type AnchorMatch } from './anchors.js';
export type { KnowledgeDimension, MemoryAnchor, StoredAnchor };
import { GrowthStore, normalizeSources, stableJSON, digest, textField, type SourceReference, type SynthesizeOperation, type SourceObservation, type CheckpointInput } from './growth.js';
import { normalizeDomain, resolveReadDomains, sameDomain, verifyTeamWriteGrant, domainKey, type DomainReadContext, type MemoryDomainRef, type TeamOperation } from './domain.js';
import { MindPondError } from './errors.js';
import { organizationMaterial } from './organization-material.js';
import { ORGANIZATION_POLICY_VERSION } from './organization-policy.js';
import { OrganizationRequestStore } from './organization-request.js';
import { MemoryRevisions } from './memory-revisions.js';
import { CollaborationStore } from './collaboration.js';

export interface MemoryEditPatch {
  dimensions?:KnowledgeDimension[]; replaceMembershipIds?:string[]; anchors?:MemoryAnchor[]; content?:string; importance?:number;
  tags?:string[]; verified?:boolean; expectedUpdatedAt?:number; expectedContent?:string;
  sourceRefs?:SourceReference[]; teamAuthorization?:string; context?:DomainReadContext; reason?:string; idempotencyKey?:string;
}

const logger = createModuleLogger('graph-memory');

// ============================================
// Types
// ============================================

export type Dimension = string;

/** @deprecated Legacy SQLite storage values only. Use getDimensionPolicy() for configured identities. */
export const VALID_DIMENSIONS: Dimension[] = ['fact', 'event', 'decision', 'lesson', 'skill'];

/** Memory layers (inspired by TencentDB Agent Memory L0-L3) */
export type MemoryLayer = 'L0' | 'L1' | 'L2' | 'L3';
export type { MemoryDomainRef, MemoryDomainKind, TeamOperation } from './domain.js';

/**
 * `dimension` and `layer` are legacy classification fields on the canonical
 * memory body.  They do not define graph distance or traversal decay.  The
 * actual retrieval topology lives in MemoryMembership/MemoryAssociation.
 */

export interface MemoryNode {
  dimensions?: KnowledgeDimension[];
  kind?: 'knowledge' | 'event';
  anchors?: StoredAnchor[];
  id: string;
  dimension: Dimension;
  layer: MemoryLayer;        // L0=raw, L1=atom, L2=scenario, L3=persona
  content: string;           // natural language, enough for LLM to understand
  embedding: number[];
  importance: number;        // 1-10
  tags: string[];
  verified?: boolean;        // lesson/decision only
  source?: string;           // URL / log / message ref
  sourceRefs?: SourceReference[];
  profiles?: Array<{ membershipId: string; revision: number; title: string; coverage: string[]; unknowns: string[] }>;
  /** Ownership/lifecycle boundary, independent from semantic space/type. */
  domain: MemoryDomainRef;
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  /** A newer memory supersedes this one. Superseded nodes remain auditable but
   * are excluded from normal retrieval. */
  supersededBy?: string;
  quarantined?: boolean;
}

export interface MemoryEdge {
  directed?:boolean;
  kind?:'semantic'|'provenance'|'support';
  id: string;
  fromId: string;
  toId: string;
  label: string;             // 'caused-by' | 'fixes' | 'similar-to' | 'related' | 'parent-of'
  weight: number;            // 0-1
  createdAt: number;
}

/** A memory body may participate in several independent spaces. */
export interface MemoryMembership {
  id: string;
  memoryId: string;
  spaceId: string;
  memoryType: string;
  active: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
  lastReviewedAt?: number;
}

/** An unordered, bidirectional association between two members in one space. */
export interface AssociationBasis { reason: string; context: string }
export interface AssociationEvidence extends AssociationBasis {
  id: string; createdAt: number;
  memberAId: string; memberBId: string; versionA: number; versionB: number;
  review?: { decision: 'confirm' | 'retire'; reason: string; at: number;
    memberAId: string; memberBId: string; versionA: number; versionB: number };
}
export interface RelatedMemory extends AssociationBasis {
  memoryId?: string; membershipId?: string; spaceId?: string; memoryType?: string;
  score: number;
}
export interface MemoryAssociation {
  id: string;
  spaceId: string;
  memoryType: string;
  memberAId: string;
  memberBId: string;
  weight: number;
  createdAt: number;
  updatedAt: number;
  memoryA?: { id: string; content: string };
  memoryB?: { id: string; content: string };
  evidence?: AssociationEvidence[];
  evidenceStatus?: 'supported' | 'needs_review' | 'missing' | 'retired';
}

export interface MemoryQuery {
  retrievalProfile?:string;
  vectorAlgorithm?:'exact'|'hnsw';
  reranker?:string;
  /** recall() only: complete wire results budget; byte-based, not an exact tokenizer count. */
  candidateLimit?:number;    // recall exploration budget, independent of returned records
  contextBudgetBytes?: number;
  useAnchors?: boolean;
  /** Evidence records are terminal, explicit opt-in retrieval results. */
  eventOnly?: boolean;       // explicit scene retrieval, independent of legacy layer
  includeEvents?: boolean;
  sourceContext?: string; // Evaluate source fingerprints in this checkout/ref; does not cross semantic spaces.
  queries?: string[];        // at most 4 alternate entrances, one shared ripple/receipt
  query?: string;            // text → auto-embed
  embedding?: number[];      // pre-computed embedding
  nodeId?: string;
  dimension?: Dimension | Dimension[];  // search bias filter
  /** Independent semantic spaces.  Ripple never crosses a space boundary. */
  spaceId?: string | string[];
  /** Type inside a space.  Associations only connect equal types. */
  memoryType?: string | string[];
  layer?: MemoryLayer | MemoryLayer[];  // layer filter
  includeL0?: boolean;       // default false — L0 raw records excluded from ripple
  includeSuperseded?: boolean; // explicit history/audit mode only
  tags?: string[];
  /** Explicit readable domains supplied by the host. Omit to read personal/default
   * plus the current `sessionId` when one is supplied. Closed sessions never read. */
  domains?: MemoryDomainRef[];
  sessionId?: string;
  maxDepth?: number;         // default 2
  minScore?: number;         // default 0.3
  limit?: number;            // default 20
}

export interface SearchResult {
  rerankScore?:number;
  matchedAnchors?: AnchorMatch[];
  dimensionBridges?: Array<{memoryId:string;spaceId:string;from:string;to:string}>;
  node: MemoryNode;
  score: number;
  depth: number;
  path: string[];
  /** Membership path makes a multi-space ripple explainable to its host. */
  membershipPath?: string[];
  associationPath?: MemoryAssociation[];
  freshness?: Awaited<ReturnType<GrowthStore['freshness']>>;
  spaceId?: string;
  memoryType?: string;
  /** Near-duplicate nodes (cosine ≥ 0.92) also present in this result set.
   *  Host may deleteNode / mergeDuplicates to clean up redundant memories. */
  nearDuplicates?: Array<{ id: string; similarity: number }>;
}

/** One host-visible retrieval event. `recallId` is the join key for later
 * adoption feedback; merely injecting a result into a prompt is not adoption. */
export interface RetrievalDiagnostics {
  profile?:{selected:string;fallbackReason?:string;algorithm?:unknown;runtime?:unknown};
  degraded:boolean;
  channels:Array<{channel:string;status:'available'|'unavailable'|'failed'|'disabled';code?:string}>;
}
export type SearchResults=SearchResult[] & {retrieval?:RetrievalDiagnostics};
export interface RecallResult {
  retrieval?:RetrievalDiagnostics;
  contextBudget?: RecallBudget;
  recallId: string;
  results: SearchResult[];
}

export type RecallDisposition = 'used' | 'rejected' | 'unassessed';
export interface RecallFeedbackInput {
  recallId: string;
  runId?: string;
  hostId?: string;
  decisions: Array<{ memoryId: string; disposition: RecallDisposition; reason?: string }>;
}

/** A task-local account of recalled evidence. It proposes review, never an
 * automatic semantic rewrite or association. */
export interface MemoryFinishInput {
  hostId: string; runId: string; stageId: string;
  sessionId?: string; domains?: MemoryDomainRef[];
  operations: Array<
    {id: string; kind: 'save'; input: {content: string} & Parameters<GraphMemory['saveMemory']>[1]} |
    {id: string; kind: 'update'; nodeId: string; input: MemoryEditPatch} |
    {id: string; kind: 'use_report'; input: Omit<MemoryUseReportInput, 'hostId'|'runId'|'reportId'>}
  >;
}
export interface MemoryUseReportInput {
  reportId: string;
  recallId: string;
  runId?: string;
  hostId?: string;
  task: string;
  outcome: 'completed' | 'partial' | 'failed' | 'unknown';
  observations: Array<{
    memoryId: string;
    disposition: RecallDisposition;
    reason: string;
    issue?: 'incorrect' | 'outdated' | 'incomplete' | 'missing_anchor';
    context?: string;
    sourceRefs?: SourceReference[];
  }>;
  coUses?: Array<{
    memoryIds: [string, string];
    spaceId: string;
    memoryType: string;
    reason: string;
    context: string;
  }>;
}

/** Observational aggregates only. Feedback never changes association weights
 * until an independently evaluated policy explicitly chooses to do so. */
export interface RecallFeedbackSummary {
  recalls: number;
  /** Number of result entries presented across all recall receipts. */
  returned: number;
  decisions: Record<RecallDisposition, number>;
  /** Returned entries for which the host has not supplied a decision yet. */
  unreported: number;
}

export interface OrganizationJob {
  id: string;
  domain: MemoryDomainRef;
  spaceId: string;
  memoryType: string;
  status: 'leased' | 'completed';
  attempts: number;
  createdAt: number;
  leaseExpiresAt?: number;
  /** Complete source material and read versions; never an implicit corpus. */
  members: Array<{ membership: MemoryMembership; memory: MemoryNode; profileDetails?: Awaited<ReturnType<GrowthStore['profileGet']>> }>;
  associations?: MemoryAssociation[];
  dimensionPolicy?:Awaited<ReturnType<GraphMemory['getDimensionPolicy']>>;
  growthRevision?: number;
}

export type WorkContextStatus = 'open' | 'completed' | 'cancelled';
export type WorkTaskStatus = 'open' | 'claimed' | 'blocked' | 'submitted' | 'completed' | 'cancelled';
export interface WorkContext {
  id: string; domain: MemoryDomainRef; goal: string; participants: string[]; sessionRefs: string[];
  status: WorkContextStatus; revision: number; createdAt: number; updatedAt: number;
}
export interface WorkTask {
  id: string; contextId: string; parentId?: string; title: string; acceptanceCriteria: string[];
  status: WorkTaskStatus; dependencies: string[]; assignee?: string; revision: number; attempt: number;
  leaseUntil?: number; resultRefs: string[]; blockers: string[]; createdAt: number; updatedAt: number;
}

export type OrganizationOperation =
  | {kind:'reanchor';membershipIds:[string];anchors:MemoryAnchor[];reason:string}
  | SynthesizeOperation
  | { kind: 'keep' | 'defer'; membershipIds: string[]; reason?: string }
  | { kind: 'associate'; membershipIds: [string, string]; weight: number; reason: string; context: string }
  | {
      kind: 'consolidate';
      dimensions?:KnowledgeDimension[];anchors?:MemoryAnchor[];
      membershipIds: string[];
      content: string;
      importance?: number;
      tags?: string[];
      reason?: string;
    };

export interface OrganizationPlan {
  operations: OrganizationOperation[];
}

/** Issued by the host capture API, never inferred from untrusted transcript text. */
export interface ExtractionCaptureContext {
  spaceId: string;
  observations: Array<{ id: string; sourceRefs: SourceReference[] }>;
}

export interface ExtractionJob {
  captureContext?: ExtractionCaptureContext;
  id: string;
  sessionId?: string;
  attempts: number;
  createdAt: number;
  l0Messages: Array<{ id: string; content: string }>;
}

/** Raw SQLite row shape for nodes table */
interface NodeRow {
  primary_dimension?:string|null;
  dimensions?: string | null;
  id: string;
  dimension: string;
  layer: string | null;      // L0/L1/L2/L3, defaults to 'L1'
  content: string | null;
  embedding: Buffer | null;
  importance: number | null;
  tags: string | null;
  verified: number | null;
  source: string | null;
  domain_kind: string | null;
  domain_id: string | null;
  session_id: string | null;
  created_at: number;
  updated_at: number;
  access_count: number | null;
  superseded_by: string | null;
}

/**
 * Node columns without the embedding BLOB.
 * Search/read paths (hybrid/ANN/ngram/BFS/connections) never consume the
 * 768-dim vector, so they select only these columns and skip the decode.
 * Paths that need the vector (loadIndex, backfill, createNode) read the
 * embedding column explicitly.
 */
const NODE_COLUMNS_NO_EMBEDDING =
  'id, dimension, primary_dimension, dimensions, layer, content, importance, tags, verified, source, domain_kind, domain_id, session_id, created_at, updated_at, access_count, superseded_by';

/** Same list prefixed for JOINs against the nodes table (alias n). */
const NODE_COLUMNS_NO_EMBEDDING_N = NODE_COLUMNS_NO_EMBEDDING.split(', ').map(c => `n.${c}`).join(', ');

/** Raw SQLite row shape for edges table */
interface EdgeRow {
  id: string;
  from_id: string;
  to_id: string;
  label: string;
  weight: number;
  created_at: number;
}

/** Row shape for JOIN queries (edges + nodes) */
type JoinedRow = EdgeRow & NodeRow;

// ============================================
// Database
// ============================================

export class GraphMemory {
  private textIndexReady=false;
  private auditWriteFailures=0;
  private db: Database | null = null;
  private dataPath: string;
  /** Indexes belong to one database instance. A process-wide singleton mixes
   * independent ponds and makes one pond's clear/delete affect another. */
  private vectorIndex = new VectorIndex();
  /** 中文旁路向量索引（bge-small-zh, 512d）——仅 EMBEDDING_ZH_ENABLED 时使用 */
  private zhVectorIndex: VectorIndex | null = null;

  private readonly DEFAULT_MIN_SCORE = 0.3;
  private readonly DEFAULT_MAX_DEPTH = 2;
  private readonly maxOutEdges: number;
  /** Version stored in SQLite so a reader notices writes from another process. */
  private indexGeneration = -1;
  /** sqlite has one connection per GraphMemory. Serialize BEGIN/COMMIT blocks
   * on that connection while SQLite's own write lock coordinates processes. */
  private coordinator = new ConnectionCoordinator();
  private closing = false;
  private closePromise?: Promise<void>;
  private backgroundTimers = new Set<ReturnType<typeof setTimeout>>();
  private backgroundWork = new Set<Promise<unknown>>();
  private readonly clock: () => number;
  private growth!: GrowthStore;
  /** O01: request service — one bounded organization pass over a fixed watermark. */
  organizationRequests!: OrganizationRequestStore;
  collaboration!: CollaborationStore;
  /** O03: material budget discipline — never truncate material, shrink the batch.
   * A packed organizationMaterial larger than this many chars shrinks 8→4→2… */
  private readonly materialBudgetChars = Math.max(1000, Number(process.env.ORGANIZATION_MATERIAL_BUDGET_CHARS ?? 48000));
  private anchors!: AnchorStore;
  private revisions!: MemoryRevisions;
  private profileRetrieval!:ProfileRetrieval;
  private retrievalConfig?:RetrievalConfigInput;
  private retrievalDependencies?:ProfileRetrievalDependencies;
  private approximateIndexes=new WeakMap<VectorIndex,{generation:number;index:Promise<ProfileVectorIndex>}>();

  constructor(workspacePath = '.', opts: { maxDegree?: number; clock?: () => number; dbPath?: string;retrieval?:RetrievalConfigInput;retrievalDependencies?:ProfileRetrievalDependencies } = {}) {
    const rootPath = path.resolve(workspacePath, '..');
    this.dataPath = opts.dbPath ?? process.env.MEMORY_DB_PATH ?? path.join(rootPath, 'data', 'graph.db');
    this.maxOutEdges = Math.max(1, Math.floor(opts.maxDegree ?? 6));
    /** R02: injectable clock for lease deadlines and timestamps — fault tests
     *  drive the whole pond on a controlled timeline. */
    this.clock = opts.clock ?? Date.now;
    this.retrievalConfig=opts.retrieval;this.retrievalDependencies=opts.retrievalDependencies;
  }

  /** R02 injected clock: lease deadlines and time-sensitive organization paths
   *  must all read the same timeline. */
  private now(): number { return this.clock(); }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.coordinator.exclusive(operation);
  }

  private later(work: () => Promise<unknown>, delay: number): void {
    if (this.closing) return;
    const timer = setTimeout(() => {
      this.backgroundTimers.delete(timer);
      if (this.closing) return;
      const task = this.coordinator.detached(work).catch(error => logger.debug('Background memory work failed', getErrorMessage(error)));
      this.backgroundWork.add(task);
      void task.finally(() => this.backgroundWork.delete(task));
    }, delay);
    timer.unref();
    this.backgroundTimers.add(timer);
  }

  private async ensureDomain(domain: MemoryDomainRef, status: 'active' | 'paused' | 'closed' = 'active'): Promise<void> {
    const now = Date.now();
    await this.db!.run(
      `INSERT INTO memory_domains(kind,id,status,created_at,updated_at,closed_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(kind,id) DO UPDATE SET status=CASE WHEN memory_domains.status='closed' THEN memory_domains.status ELSE excluded.status END, updated_at=excluded.updated_at`,
      [domain.kind, domain.id, status, now, now, status === 'closed' ? now : null],
    );
  }

  private async assertTeamWrite(domain: MemoryDomainRef, token: unknown, operation: TeamOperation): Promise<void> {
    if (domain.kind === 'team') verifyTeamWriteGrant(token, domain, operation);
  }

  private queryDomains(query: MemoryQuery): MemoryDomainRef[] {
    // M02.b: single shared derivation — session entries in query.domains are
    // validated against query.sessionId, so no caller can widen into another
    // session by listing it.
    return resolveReadDomains({ domains: query.domains, sessionId: query.sessionId });
  }

  /** M02.b: shared guard for bounded read/write entries that address a node by
   *  bare id.  When the entry supplies a context the node must sit inside the
   *  readable domains and its session (if any) must still be open.  Internal
   *  trusted callers (search traversal, host operators) omit the context. */
  private async assertNodeInReadableDomains(node: Pick<MemoryNode, 'id' | 'domain'>, context: DomainReadContext): Promise<void> {
    const readable = resolveReadDomains(context);
    if (!readable.some(d => sameDomain(d, node.domain))) {
      throw new Error(`node ${node.id} is outside the readable domains`);
    }
    if (node.domain.kind === 'session') {
      const state = await this.db!.get<any>("SELECT status FROM memory_domains WHERE kind='session' AND id=?", [node.domain.id]);
      if (state?.status !== 'active' && state?.status !== 'paused') {
        throw new Error(`session ${node.domain.id} is closed`);
      }
    }
  }

  /** M03.d: tombstone guard — a purged session id is retired for good; no
   *  write, ingest, checkpoint, reopen or work claim may run under it. */
  private async assertSessionNotPurged(sessionId: string): Promise<void> {
    const tomb = await this.db!.get<any>('SELECT session_id FROM session_tombstones WHERE session_id=?', [sessionId]);
    if (tomb) throw new Error(`session ${sessionId} was purged; the id is retired and cannot be reused`);
  }

  /** M03.a: session-domain writes must target a live session — closed
   *  sessions reject ordinary writes until explicitly reopened. */
  private async assertSessionWritable(sessionId: string): Promise<void> {
    await this.assertSessionNotPurged(sessionId);
    const state = await this.db!.get<any>("SELECT status FROM memory_domains WHERE kind='session' AND id=?", [sessionId]);
    if (state?.status === 'closed') throw new Error(`session ${sessionId} is closed`);
  }

  /** The host declares lifecycle transitions; a closed session cannot return
   * through normal query paths.  Purge is explicit and auditable. */
  async setSessionState(sessionId: string, status: 'active' | 'paused' | 'closed'): Promise<{ sessionId: string; status: string }> {
    textField(sessionId, 'sessionId', 256);
    return this.growthWrite(async()=>{
    await this.assertSessionNotPurged(sessionId);
    const domain: MemoryDomainRef = { kind: 'session', id: sessionId };
    const now = Date.now();
    await this.db!.run(
      `INSERT INTO memory_domains(kind,id,status,created_at,updated_at,closed_at) VALUES ('session',?,?,?,?,?)
       ON CONFLICT(kind,id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,closed_at=excluded.closed_at`,
      [sessionId, status, now, now, status === 'closed' ? now : null],
    );
    await this.logAction({ action: 'session_' + status, domain, reason: JSON.stringify({ sessionId }) });
    return { sessionId, status };
    });
  }

  async purgeClosedSession(sessionId: string): Promise<{ deletedNodes: number }> {
    textField(sessionId, 'sessionId', 256);
    return this.withWriteLock(async () => {
      const domain = await this.db!.get<any>("SELECT status FROM memory_domains WHERE kind='session' AND id=?", [sessionId]);
      if (domain?.status !== 'closed') throw new Error('Only closed sessions may be purged');
      await this.assertSessionNotPurged(sessionId);
      await this.db!.exec('BEGIN IMMEDIATE');
      try {
        const ids = (await this.db!.all<any>("SELECT id FROM nodes WHERE domain_kind='session' AND domain_id=?", [sessionId])).map((row: any) => row.id);
        for (const id of ids) await this.deleteNode(id, 'closed session purge');
        // M03.c: profile history of deleted session memories (revisions carry
        // synthesis bodies) plus any rows orphaned by the node deletions.
        await this.db!.run('DELETE FROM profile_revisions WHERE profile_id NOT IN (SELECT id FROM memory_memberships)');
        // M03.c: candidate jobs with their full-text snapshots/payloads.
        const orgJobIds = (await this.db!.all<any>(
          "SELECT id FROM organization_jobs WHERE domain_kind='session' AND domain_id=?", [sessionId])).map((r: any) => r.id);
        for (const jobId of orgJobIds) {
          await this.db!.run('DELETE FROM organization_payloads WHERE job_id=?', [jobId]);
          await this.db!.run('DELETE FROM organization_job_members WHERE job_id=?', [jobId]);
        }
        await this.db!.run("DELETE FROM organization_jobs WHERE domain_kind='session' AND domain_id=?", [sessionId]);
        // M03.c: host maintenance work items and collaboration contexts.
        await this.db!.run(
          'DELETE FROM work_tasks WHERE context_id IN (SELECT id FROM work_contexts WHERE domain_kind=? AND domain_id=?)',
          ['session', sessionId]);
        await this.db!.run("DELETE FROM work_contexts WHERE domain_kind='session' AND domain_id=?", [sessionId]);
        await this.db!.run("DELETE FROM host_work WHERE domain_kind='session' AND domain_id=?", [sessionId]);
        // M03.d: retire the id before dropping the domain row, so replayed
        // outbox writes and stale tokens can never revive content.
        await this.db!.run(
          'INSERT OR REPLACE INTO session_tombstones(session_id,purged_at,deleted_nodes) VALUES (?,?,?)',
          [sessionId, Date.now(), ids.length]);
        await this.db!.run("DELETE FROM memory_domains WHERE kind='session' AND id=?", [sessionId]);
        await this.logAction({ action: 'session_purged', reason: JSON.stringify({ sessionId, deletedNodes: ids.length }) });
        await this.db!.exec('COMMIT');
        return { deletedNodes: ids.length };
      } catch (error) { await this.db!.exec('ROLLBACK'); throw error; }
    });
  }

  /** M01 audit: rows in a session domain that look like authored standard
   * knowledge rather than pipeline artifacts.  The pre-v5 migration bug
   * rewrote explicit personal rows carrying a source session_id into session
   * domains; the exact original ownership is not mechanically decidable, so
   * this reports candidates for human review — it never restores anything.
   * Restore (after human confirmation per id):
   *   UPDATE nodes SET domain_kind='personal', domain_id='default', updated_at=<now> WHERE id IN (<confirmed ids>); */
  async auditSuspectedDomainDrift(): Promise<Array<{
    id: string; content: string; layer: string; verified: boolean;
    source: string | null; tags: string[]; sessionId: string; createdAt: number;
  }>> {
    const rows = await this.db!.all<any>(`
      SELECT id, content, layer, verified, source, tags, domain_id AS session_id, created_at
      FROM nodes
      WHERE domain_kind='session' AND domain_id=session_id
        AND layer != 'L0' AND superseded_by IS NULL
        AND (source IS NULL OR (source != 'pipeline' AND source != 'synthesis'))
        AND tags NOT LIKE '%"l1-atom"%'
      ORDER BY created_at DESC`);
    return rows.map((row: any) => ({
      id: row.id,
      content: row.content,
      layer: row.layer,
      verified: !!row.verified,
      source: row.source ?? null,
      tags: (() => { try { return JSON.parse(row.tags ?? '[]') as string[]; } catch { return [] as string[]; } })(),
      sessionId: row.session_id,
      createdAt: row.created_at,
    }));
  }

  async init(): Promise<void> {
    if(this.closing) {
      await this.closePromise;
      this.coordinator=new ConnectionCoordinator();
      this.closing=false;this.closePromise=undefined;this.embeddingScheduled=false;
    }
    return this.withWriteLock(async () => {
    const dir = path.dirname(this.dataPath);
    const fs = await import('fs');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = this.coordinator.connection(await open({
      filename: this.dataPath,
      driver: sqlite3.Database,
    }));

    // Multi-process safety (host agent + mindpond-server may share one DB file):
    // WAL lets readers proceed during writes; busy_timeout makes concurrent
    // writers queue instead of throwing SQLITE_BUSY.
    await this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;`);

    // Schema v3 — 4-dimension model + L0-L3 layers (TencentDB-inspired)
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        dimension TEXT NOT NULL CHECK(dimension IN ('fact','event','decision','lesson')),
        layer TEXT NOT NULL DEFAULT 'L1' CHECK(layer IN ('L0','L1','L2','L3')),
        content TEXT NOT NULL,
        embedding BLOB,
        importance INTEGER NOT NULL DEFAULT 5,
        tags TEXT NOT NULL DEFAULT '[]',
        verified INTEGER DEFAULT 0,
        source TEXT,
        domain_kind TEXT NOT NULL DEFAULT 'personal' CHECK(domain_kind IN ('session','personal','team')),
        domain_id TEXT NOT NULL DEFAULT 'default',
        session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        superseded_by TEXT REFERENCES nodes(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        label TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0.5 CHECK(weight BETWEEN 0 AND 1),
        created_at INTEGER NOT NULL,
        UNIQUE(from_id, to_id, label),
        FOREIGN KEY(from_id) REFERENCES nodes(id) ON DELETE CASCADE,
        FOREIGN KEY(to_id) REFERENCES nodes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS memory_action_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        action TEXT NOT NULL,
        node_id TEXT,
        edge_id TEXT,
        from_id TEXT,
        to_id TEXT,
        label TEXT,
        weight REAL,
        reason TEXT
      );

      -- G5: host adoption feedback. Results are deliberately stored as ids and
      -- scores, never copied bodies, so recall analytics does not create a
      -- second memory corpus or expose a result to another domain.
      CREATE TABLE IF NOT EXISTS memory_recalls (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        host_id TEXT,
        query_hash TEXT NOT NULL,
        result_ids TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_recall_feedback (
        recall_id TEXT NOT NULL REFERENCES memory_recalls(id) ON DELETE CASCADE,
        memory_id TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK(disposition IN ('used','rejected','unassessed')),
        reason TEXT,
        run_id TEXT,
        host_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(recall_id, memory_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_recall_feedback_disposition
        ON memory_recall_feedback(disposition, created_at);
      CREATE TABLE IF NOT EXISTS memory_use_reports (
        id TEXT PRIMARY KEY,
        recall_id TEXT NOT NULL REFERENCES memory_recalls(id) ON DELETE CASCADE,
        request_hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        receipt TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_improvement_signals (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL REFERENCES memory_use_reports(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('review_memory','review_association')),
        domain_kind TEXT NOT NULL,
        domain_id TEXT NOT NULL,
        space_id TEXT,
        memory_type TEXT,
        memory_a_id TEXT NOT NULL,
        memory_b_id TEXT,
        reason TEXT NOT NULL,
        context TEXT NOT NULL,
        source_refs TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reviewed','deferred','dismissed')),
        resolution TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_improvement_pending
        ON memory_improvement_signals(domain_kind,domain_id,status,created_at);

      -- Tiny KV store for scheduler state (last L3 distill time, edge-review cursor)
      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Durable host-driven extraction jobs.  The LLM is outside this process,
      -- so work cannot live only in a timer or JavaScript field.
      CREATE TABLE IF NOT EXISTS memory_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('extract_l1')),
        status TEXT NOT NULL CHECK(status IN ('queued','leased','completed')) DEFAULT 'queued',
        session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        lease_expires_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS memory_job_sources (
        job_id TEXT NOT NULL REFERENCES memory_jobs(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY(job_id, node_id)
      );
      CREATE TABLE IF NOT EXISTS memory_job_context (
        job_id TEXT PRIMARY KEY REFERENCES memory_jobs(id) ON DELETE CASCADE,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_jobs_claim ON memory_jobs(kind, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_job_sources_node ON memory_job_sources(node_id);

      -- v5: canonical memory bodies are separate from their participation in
      -- semantic spaces.  This is deliberately independent from nodes.dimension:
      -- one body may be a member of many spaces, and no association can span one.
      CREATE TABLE IF NOT EXISTS memory_memberships (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        space_id TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_reviewed_at INTEGER,
        UNIQUE(memory_id, space_id, memory_type)
      );
      CREATE TABLE IF NOT EXISTS memory_associations (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        member_a_id TEXT NOT NULL REFERENCES memory_memberships(id) ON DELETE CASCADE,
        member_b_id TEXT NOT NULL REFERENCES memory_memberships(id) ON DELETE CASCADE,
        weight REAL NOT NULL CHECK(weight BETWEEN 0 AND 1),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK(member_a_id < member_b_id),
        UNIQUE(space_id, memory_type, member_a_id, member_b_id)
      );
      CREATE TABLE IF NOT EXISTS organization_cooldowns (
        membership_id TEXT PRIMARY KEY REFERENCES memory_memberships(id) ON DELETE CASCADE,
        space_id TEXT NOT NULL, memory_type TEXT NOT NULL,
        member_version INTEGER NOT NULL, assoc_stamp TEXT NOT NULL, policy_version TEXT NOT NULL,
        cooled_until INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_org_cooldowns
        ON organization_cooldowns(space_id, memory_type, cooled_until);
      CREATE INDEX IF NOT EXISTS idx_memberships_scope
        ON memory_memberships(space_id, memory_type, active, updated_at);
      CREATE INDEX IF NOT EXISTS idx_memberships_memory ON memory_memberships(memory_id);
      CREATE INDEX IF NOT EXISTS idx_associations_a ON memory_associations(member_a_id);
      CREATE INDEX IF NOT EXISTS idx_associations_b ON memory_associations(member_b_id);
      CREATE TABLE IF NOT EXISTS association_evidence (
        association_id TEXT NOT NULL REFERENCES memory_associations(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY(association_id, id)
      );

      -- Organization work is durable and host-driven.  MindPond stores no key
      -- and invokes no model; the host leases a materialized snapshot, proposes
      -- a plan, and commits it only if the snapshot versions still match.
      CREATE TABLE IF NOT EXISTS organization_jobs (
        id TEXT PRIMARY KEY,
        domain_kind TEXT NOT NULL DEFAULT 'personal',
        domain_id TEXT NOT NULL DEFAULT 'default',
        space_id TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('leased','completed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        lease_expires_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 1,
        last_error TEXT,
        -- R02/T08: set atomically by cancelOrganizationJob; a cancelled job
        -- rejects every later plan while keeping earlier committed receipts.
        cancelled_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS organization_job_members (
        job_id TEXT NOT NULL REFERENCES organization_jobs(id) ON DELETE CASCADE,
        membership_id TEXT NOT NULL REFERENCES memory_memberships(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY(job_id, membership_id)
      );
      CREATE INDEX IF NOT EXISTS idx_organization_jobs_claim
        ON organization_jobs(status, lease_expires_at, created_at);

      -- Session lifecycle is explicit so closed session material cannot be
      -- recalled merely because a caller omitted a filter.
      CREATE TABLE IF NOT EXISTS memory_domains (
        kind TEXT NOT NULL CHECK(kind IN ('session','personal','team')),
        id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','paused','closed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER,
        PRIMARY KEY(kind,id)
      );
      CREATE INDEX IF NOT EXISTS idx_domains_status ON memory_domains(kind,status,updated_at);

      -- M03.d: a purged session id is permanently retired.  The tombstone
      -- survives the deleted memory_domains row so replayed outbox writes,
      -- stale work tokens and reopen attempts can never revive content under
      -- the same external session id.
      CREATE TABLE IF NOT EXISTS session_tombstones (
        session_id TEXT PRIMARY KEY,
        purged_at INTEGER NOT NULL,
        deleted_nodes INTEGER NOT NULL DEFAULT 0,
        reason TEXT
      );

      -- Coordination is structured operational state, intentionally separate
      -- from natural-language memory nodes and MindPond host maintenance work.
      CREATE TABLE IF NOT EXISTS work_contexts (
        id TEXT PRIMARY KEY,
        domain_kind TEXT NOT NULL CHECK(domain_kind IN ('session','personal','team')),
        domain_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        participants TEXT NOT NULL DEFAULT '[]',
        session_refs TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN ('open','completed','cancelled')) DEFAULT 'open',
        revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_tasks (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL REFERENCES work_contexts(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES work_tasks(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN ('open','claimed','blocked','submitted','completed','cancelled')) DEFAULT 'open',
        dependencies TEXT NOT NULL DEFAULT '[]',
        assignee TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        attempt INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER,
        claim_token TEXT,
        result_refs TEXT NOT NULL DEFAULT '[]',
        blockers TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_work_tasks_claim ON work_tasks(context_id,status,lease_until,updated_at);
      CREATE TABLE IF NOT EXISTS work_task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
        actor TEXT NOT NULL,
        event_id TEXT NOT NULL,
        expected_revision INTEGER NOT NULL,
        transition TEXT NOT NULL,
        reason TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        ts INTEGER NOT NULL,
        UNIQUE(task_id,event_id)
      );
    `);

    // Ensure memory_action_log exists for pre-existing databases (idempotent migration)
    try {
      await this.db.exec(`CREATE TABLE IF NOT EXISTS memory_action_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        action TEXT NOT NULL,
        node_id TEXT,
        edge_id TEXT,
        from_id TEXT,
        to_id TEXT,
        label TEXT,
        weight REAL,
        reason TEXT
      );`);
    } catch { /* table already exists */ }

    // O04/T17: action-log scope isolation — record which domain each entry
    // belongs to so bounded readers can never see other scopes' content or
    // reasons. Legacy rows (NULL domain) stay operator-only.
    try {
      const logCols = await this.db.all(`PRAGMA table_info(memory_action_log)`) as Array<{ name: string }>;
      if (!logCols.some(c => c.name === 'domain_kind')) await this.db.exec('ALTER TABLE memory_action_log ADD COLUMN domain_kind TEXT');
      if (!logCols.some(c => c.name === 'domain_id')) await this.db.exec('ALTER TABLE memory_action_log ADD COLUMN domain_id TEXT');
    } catch (e) {
      logger.warn('[GraphMemory] action-log domain migration failed', { error: getErrorMessage(e) });
    }
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_action_log_ts ON memory_action_log(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_action_log_node_id ON memory_action_log(node_id,id DESC);
      CREATE INDEX IF NOT EXISTS idx_action_log_action_id ON memory_action_log(action,id DESC);
      CREATE TRIGGER IF NOT EXISTS attribute_memory_action AFTER INSERT ON memory_action_log
      WHEN NEW.domain_kind IS NULL AND COALESCE(NEW.node_id,NEW.from_id,NEW.to_id) IS NOT NULL
      BEGIN
        UPDATE memory_action_log SET
          domain_kind=(SELECT domain_kind FROM nodes WHERE id=COALESCE(NEW.node_id,NEW.from_id,NEW.to_id)),
          domain_id=(SELECT domain_id FROM nodes WHERE id=COALESCE(NEW.node_id,NEW.from_id,NEW.to_id))
        WHERE id=NEW.id;
      END;
    `);

    // Migration: add layer column if missing (pre-v3 databases).
    // MUST run before the indexes below — idx_nodes_layer references the
    // layer column, and on pre-v3 databases CREATE INDEX would fail with
    // SQLITE_ERROR "no such column: layer" and kill init().
    let hasLayer = false;
    try {
      const cols = await this.db.all(`PRAGMA table_info(nodes)`);
      hasLayer = (cols as Array<{ name: string }>).some(c => c.name === 'layer');
      if (!hasLayer) {
        await this.db.exec(`ALTER TABLE nodes ADD COLUMN layer TEXT NOT NULL DEFAULT 'L1' CHECK(layer IN ('L0','L1','L2','L3'))`);
        hasLayer = true;
        logger.info('[GraphMemory] migrated: added layer column');
      }
    } catch (e) {
      logger.warn('[GraphMemory] layer migration check failed', { error: getErrorMessage(e) });
    }

    // Add supersession metadata to existing ponds without rewriting data.
    try {
      const cols = await this.db.all(`PRAGMA table_info(nodes)`);
      if (!(cols as Array<{ name: string }>).some(c => c.name === 'superseded_by')) {
        await this.db.exec(`ALTER TABLE nodes ADD COLUMN superseded_by TEXT`);
      }
    } catch (e) {
      logger.warn('[GraphMemory] superseded_by migration failed', { error: getErrorMessage(e) });
    }

    // Domain migration v5 — strictly one-time, transactional, and restorable
    // (roadmap M01; drift reproduced in B02.c).  The legacy backfill used to
    // re-run on every init() and rewrote explicit personal/default rows that
    // carry a source session_id into session domains.  PRAGMA user_version
    // marks the migration done so no code path can re-run it; DDL + backfill
    // + version bump share one transaction so a crash cannot leave a
    // half-migrated schema (the whole migration then safely re-runs).
    const DOMAIN_SCHEMA_VERSION = 5;
    const backupPath = `${this.dataPath}.pre-domain-v5.bak`;
    try {
      const versionRow = await this.db.get<{ user_version: number }>('PRAGMA user_version');
      if ((versionRow?.user_version ?? 0) < DOMAIN_SCHEMA_VERSION) {
        const preCols = await this.db.all(`PRAGMA table_info(nodes)`);
        const needsLegacyUpgrade = !(preCols as Array<{ name: string }>).some(c => c.name === 'domain_kind')
          || !(preCols as Array<{ name: string }>).some(c => c.name === 'domain_id');
        if (needsLegacyUpgrade) {
          // Restorable snapshot BEFORE any DDL.  Restore procedure: stop all
          // processes sharing the file, copy this backup over the database
          // (removing -wal/-shm siblings), restart.
          try { fs.unlinkSync(backupPath); } catch { /* no stale backup */ }
          await this.db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
          logger.info(`[GraphMemory] domain migration backup written: ${backupPath}`);
        }
        await this.db.exec('BEGIN IMMEDIATE');
        try {
          // Re-read inside the write lock: a concurrent first instance may
          // have committed the migration between our version check and here.
          const cols = await this.db.all(`PRAGMA table_info(nodes)`);
          const names = new Set((cols as Array<{ name: string }>).map(c => c.name));
          const addedDomainKind = !names.has('domain_kind');
          const addedDomainId = !names.has('domain_id');
          if (addedDomainKind) await this.db.exec("ALTER TABLE nodes ADD COLUMN domain_kind TEXT NOT NULL DEFAULT 'personal'");
          if (addedDomainId) await this.db.exec("ALTER TABLE nodes ADD COLUMN domain_id TEXT NOT NULL DEFAULT 'default'");
          // Backfill only when the columns are created here: a row that
          // already has explicit personal/default ownership and a session_id
          // carries SOURCE metadata, not a domain scope — rewriting it is
          // exactly the drift M01 forbids (source session ≠ ownership).
          if (addedDomainKind || addedDomainId) {
            await this.db.run("UPDATE nodes SET domain_kind='session', domain_id=session_id WHERE session_id IS NOT NULL AND domain_kind='personal' AND domain_id='default'");
          }
          const jobCols = await this.db.all(`PRAGMA table_info(organization_jobs)`);
          const jobNames = new Set((jobCols as Array<{ name: string }>).map(c => c.name));
          if (!jobNames.has('domain_kind')) await this.db.exec("ALTER TABLE organization_jobs ADD COLUMN domain_kind TEXT NOT NULL DEFAULT 'personal'");
          if (!jobNames.has('domain_id')) await this.db.exec("ALTER TABLE organization_jobs ADD COLUMN domain_id TEXT NOT NULL DEFAULT 'default'");
          if (!jobNames.has('cancelled_at')) await this.db.exec('ALTER TABLE organization_jobs ADD COLUMN cancelled_at INTEGER');
          await this.db.exec(`PRAGMA user_version=${DOMAIN_SCHEMA_VERSION}`);
          await this.db.exec('COMMIT');
          if (addedDomainKind || addedDomainId) logger.info('[GraphMemory] migrated: domain columns + one-time legacy backfill (schema v5)');
        } catch (txError) {
          try { await this.db.exec('ROLLBACK'); } catch { /* no active transaction */ }
          throw txError;
        }
      }
    } catch (e) {
      // M01: a failed domain migration must stop init() instead of continuing
      // with a half-migrated schema — warn-and-continue hid the failure class
      // this card exists to close.
      throw new Error(`[GraphMemory] domain schema migration failed (restore ${backupPath} by copying it over the database after stopping all processes, if needed): ${getErrorMessage(e)}`);
    }

    // Migration: remove legacy temporal columns (valid_at/invalid_at) from pre-v4
    // databases. Design rule (user mandate): deletion is deletion — no tombstones;
    // memory_action_log is the audit trail. Previously-invalidated edges are
    // physically deleted, then the columns are dropped (best-effort: old SQLite
    // versions keep the unused columns, which is harmless).
    try {
      const edgeCols = await this.db.all(`PRAGMA table_info(edges)`);
      const colNames = (edgeCols as Array<{ name: string }>).map(c => c.name);
      if (colNames.includes('invalid_at')) {
        const stale = await this.db.all<any>(`SELECT id, from_id, to_id, label, weight FROM edges WHERE invalid_at IS NOT NULL`);
        for (const e of stale as Array<{ id: string; from_id: string; to_id: string; label: string; weight: number }>) {
          await this.db.run(`DELETE FROM edges WHERE id = ?`, [e.id]);
          await this.logAction({
            action: 'edge_deleted', edgeId: e.id, fromId: e.from_id, toId: e.to_id,
            label: e.label, weight: e.weight, reason: 'temporal tombstone removal (migration v4)',
          });
        }
        if (stale.length > 0) logger.info(`[GraphMemory] migrated: hard-deleted ${stale.length} tombstoned edge(s)`);
        try {
          await this.db.exec(`ALTER TABLE edges DROP COLUMN valid_at`);
          await this.db.exec(`ALTER TABLE edges DROP COLUMN invalid_at`);
          logger.info('[GraphMemory] migrated: dropped edges.valid_at/invalid_at');
        } catch { /* SQLite < 3.35: unused columns stay, harmless */ }
      }
    } catch (e) {
      logger.warn('[GraphMemory] edge temporal cleanup failed', { error: getErrorMessage(e) });
    }

    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nodes_dimension ON nodes(dimension);
      CREATE INDEX IF NOT EXISTS idx_nodes_session ON nodes(session_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_domain ON nodes(domain_kind,domain_id);
      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
    `);

    // Existing node rows predate explicit lifecycle state.  Restore their
    // conservative ownership without granting access to an already closed ID.
    await this.db.run(
      "INSERT OR IGNORE INTO memory_domains(kind,id,status,created_at,updated_at) SELECT domain_kind,domain_id,CASE WHEN domain_kind='session' THEN 'paused' ELSE 'active' END,?,? FROM nodes",
      [Date.now(), Date.now()],
    );

    // Existing ponds get one legacy space member per node.  Old associative
    // edges are copied only when both endpoints share that legacy space; this
    // avoids inventing cross-dimension meaning during migration.
    const now = Date.now();
    await this.db.run(
      `INSERT OR IGNORE INTO memory_memberships
         (id, memory_id, space_id, memory_type, active, version, created_at, updated_at)
       SELECT 'legacy-member:' || id, id, 'legacy:' || dimension, dimension,
              CASE WHEN superseded_by IS NULL THEN 1 ELSE 0 END, 1, ?, ?
         FROM nodes WHERE NOT EXISTS (SELECT 1 FROM memory_memberships m WHERE m.memory_id = nodes.id)`,
      [now, now]
    );
    const oldAssociative = [...GraphMemory.ASSOCIATIVE_LABELS].map(() => '?').join(',');
    await this.db.run(
      `INSERT OR IGNORE INTO memory_associations
         (id, space_id, memory_type, member_a_id, member_b_id, weight, created_at, updated_at)
       SELECT 'legacy-assoc:' || e.id, 'legacy:' || a.dimension, a.dimension,
              CASE WHEN ma.id < mb.id THEN ma.id ELSE mb.id END,
              CASE WHEN ma.id < mb.id THEN mb.id ELSE ma.id END,
              e.weight, e.created_at, e.created_at
         FROM edges e
         JOIN nodes a ON a.id = e.from_id
         JOIN nodes b ON b.id = e.to_id
         JOIN memory_memberships ma ON ma.memory_id = a.id
             AND ma.space_id = 'legacy:' || a.dimension AND ma.memory_type = a.dimension
         JOIN memory_memberships mb ON mb.memory_id = b.id
             AND mb.space_id = 'legacy:' || b.dimension AND mb.memory_type = b.dimension
        WHERE e.label IN (${oldAssociative}) AND a.dimension = b.dimension
          AND a.domain_kind=b.domain_kind AND a.domain_id=b.domain_id`,
      [...GraphMemory.ASSOCIATIVE_LABELS]
    );
    if (hasLayer) {
      await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_layer ON nodes(layer)`);
    }

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS organization_payloads (
        job_id TEXT PRIMARY KEY REFERENCES organization_jobs(id) ON DELETE CASCADE,
        snapshot TEXT NOT NULL, plan TEXT, receipt TEXT
      );
      CREATE TRIGGER IF NOT EXISTS membership_body_revision
      AFTER UPDATE OF content, tags, importance, verified, session_id, superseded_by ON nodes
      BEGIN
        UPDATE memory_memberships SET version = version + 1, last_reviewed_at = NULL,
          updated_at = NEW.updated_at WHERE memory_id = NEW.id;
      END;
    `);

    await this.db.run('INSERT OR IGNORE INTO memory_meta(key,value) VALUES (?,?)',['pond_instance_id',crypto.randomUUID()]);
    this.growth = new GrowthStore(this.db, this.clock);
    await this.growth.init();
    // O01: request model over the fixed watermark — one request = one bounded
    // organization pass; batches are claimed only inside the watermark.
    this.organizationRequests = this.coordinator.service(new OrganizationRequestStore(this.db, {
      claimOrganizationJob: options => this.claimOrganizationJob(options),
      getOrganizationJob: jobId => this.getOrganizationJob(jobId),
    }, () => this.now(), async (action, payload) => { await this.logAction({ action, reason: stableJSON(payload) }); }), ['init','createRequest','listRequests','getRequest','nextBatch','reportBatch','finishRequest','cancelRequest','listEvents']);
    await this.organizationRequests.init();
    this.collaboration=this.coordinator.service(new CollaborationStore(this.db,work=>this.growthWrite(work),this.clock,work=>this.coordinator.exclusive(work)),['init','configure','workspaces','handoff','inbox','get','reply','ack','managedTask','taskList','taskMutation','submitIteration','verifyIteration','activity']);
    await this.collaboration.init();
    // Additive, transactional migration: never reclassify historical events or
    // infer additional identities from tags, existing edges or model guesses.
    await this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns=await this.db.all<any[]>('PRAGMA table_info(nodes)');
      if (!columns.some(c=>c.name==='dimensions')) await this.db.exec('ALTER TABLE nodes ADD COLUMN dimensions TEXT');
      if (!columns.some(c=>c.name==='primary_dimension')) await this.db.exec('ALTER TABLE nodes ADD COLUMN primary_dimension TEXT');
      await this.db.exec('COMMIT');
    } catch (error) { await this.db.exec('ROLLBACK'); throw error; }
    await this.db.exec(`CREATE TABLE IF NOT EXISTS memory_dimension_config (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,payload TEXT NOT NULL);`);
    await this.db.run('INSERT OR IGNORE INTO memory_dimension_config(id,revision,payload) VALUES (1,1,?)',[JSON.stringify(DEFAULT_DIMENSION_CONFIGURATION)]);
    this.anchors=new AnchorStore(this.db, work => this.growthWrite(work));await this.anchors.init();
    this.revisions=new MemoryRevisions(this.db);await this.revisions.init();
    this.profileRetrieval=new ProfileRetrieval(this.db,work=>this.growthWrite(work),this.retrievalConfig,this.retrievalDependencies);
    await this.profileRetrieval.init();
    await this.db.exec(`CREATE TABLE IF NOT EXISTS memory_team_references (
      id TEXT PRIMARY KEY,source_member_id TEXT NOT NULL REFERENCES memory_memberships(id) ON DELETE CASCADE,
      target_member_id TEXT NOT NULL REFERENCES memory_memberships(id) ON DELETE CASCADE,
      weight REAL NOT NULL CHECK(weight BETWEEN 0 AND 1),reason TEXT NOT NULL,context TEXT NOT NULL,
      created_at INTEGER NOT NULL,source_version INTEGER,target_version INTEGER,UNIQUE(source_member_id,target_member_id));
      CREATE INDEX IF NOT EXISTS memory_team_reference_source ON memory_team_references(source_member_id);`);
    const referenceColumns=await this.db.all<any[]>('PRAGMA table_info(memory_team_references)');
    for(const column of ['source_version','target_version'])if(!referenceColumns.some(c=>c.name===column))await this.db.exec(`ALTER TABLE memory_team_references ADD COLUMN ${column} INTEGER`);

    // Databases created by older releases had foreign_keys disabled at runtime.
    // Clean historical orphans once, then the connection-level pragma enforces
    // the schema's cascades for every subsequent mutation.
    await this.db.exec(`
      DELETE FROM edges
       WHERE from_id NOT IN (SELECT id FROM nodes)
          OR to_id NOT IN (SELECT id FROM nodes);
    `);
    await this.setMeta('index_generation', (await this.getMeta('index_generation')) ?? '0');

    // Load existing nodes into vector index
    const vectorColumns=await this.db.all<Array<{name:string}>>('PRAGMA table_info(nodes)');
    if(!vectorColumns.some(c=>c.name==='embedding_profile'))await this.db.exec('ALTER TABLE nodes ADD COLUMN embedding_profile TEXT');
    this.textIndexReady=await initializeTextIndex(this.db!);
    await this.loadIndex();

    // ZH side-channel (opt-in via EMBEDDING_ZH_ENABLED): table + index + backfill.
    // Purely additive — when the flag is off, none of this runs and behavior
    // is byte-identical to before.
    if (zhEnabled()) {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS nodes_zh (
          id TEXT PRIMARY KEY,
          embedding BLOB NOT NULL, embedding_profile TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_nodes_zh_created ON nodes(created_at DESC);
      `);
      const zhColumns=await this.db.all<Array<{name:string}>>('PRAGMA table_info(nodes_zh)');
      if(!zhColumns.some(c=>c.name==='embedding_profile'))await this.db.exec('ALTER TABLE nodes_zh ADD COLUMN embedding_profile TEXT');
      this.zhVectorIndex = new VectorIndex();
      await this.loadZhIndex();
      this.later(() => this.backfillZhEmbeddings(), 15000);
    }

    // Backfill embeddings for nodes that were created while embedding API was offline.
    // Runs in background — does not block startup.
    this.scheduleEmbeddingBackfill();
    for(const id of await this.profileRetrieval.startupProfiles())this.scheduleProfileBuild(id);

    logger.info('[GraphMemory] initialized', { dataPath: this.dataPath });
    });
  }

  private async loadIndex(): Promise<void> {
    if (!this.db) return;
    try {
      // Read the generation before loading rows. A concurrent writer must
      // remain visible as a mismatch on the next search.
      const generationAtStart = Number((await this.getMeta('index_generation')) ?? 0);
      const rebuilt = new VectorIndex();
      // Read every embedding in bounded pages. Old knowledge must not silently
      // disappear when a collection grows beyond 10k records.
      const indexColumns = `${NODE_COLUMNS_NO_EMBEDDING.replace('content,', 'substr(content,1,200) AS content,')}, embedding`;
      const expectedDims = getEmbeddingService()['dimensions'] ?? 384;
      let cursor = 0, loaded = 0, skippedDims = 0;
      for (;;) {
        const rows = await this.db.all<any[]>(`SELECT rowid AS index_rowid, ${indexColumns} FROM nodes WHERE rowid > ? AND (embedding_profile=? OR (?=1 AND embedding_profile IS NULL)) ORDER BY rowid LIMIT 512`, [cursor,legacyEmbeddingIdentity(),Number(acceptsUnlabelledLegacyVectors())]);
        if (!rows.length) break;
        const indexed: VectorItem[] = [];
        for (const row of rows) {
          cursor = row.index_rowid;
          if (!row.embedding) continue;
          try {
            const embedding = this.bufferToVector(row.embedding);
            if (!embedding.length) continue;
            if (embedding.length !== expectedDims) { skippedDims++; continue; }
            indexed.push({id: row.id, vector: embedding, metadata: this.indexMetadata(this.rowToNode(row))});
          } catch { /* malformed vectors remain available through text retrieval */ }
        }
        rebuilt.addBatch(indexed);
        loaded += indexed.length;
      }
      logger.info(`Loaded ${loaded} vectors without a collection-size cutoff; ${skippedDims} require re-embedding`);
      this.vectorIndex = rebuilt;
      this.indexGeneration = generationAtStart;
    } catch (err: unknown) {
      logger.warn('Failed to load vector index', getErrorMessage(err));
      this.indexGeneration=-1;
      throw new MindPondError('temporarily_unavailable','Vector index reload failed; previous coverage cannot be assumed',{retryable:true});
    }
  }

  private bufferToVector(value: Buffer | Uint8Array): number[] {
    const bytes = Buffer.isBuffer(value)?value:Buffer.from(value.buffer,value.byteOffset,value.byteLength);
    if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return [];
    const result=Array.from({length:bytes.byteLength/4},(_,i)=>bytes.readFloatLE(i*4));
    return result.every(Number.isFinite)?result:[];
  }

  /** Refresh a local ANN mirror after another process commits through GraphMemory.
   * SQLite remains the source of truth; the version avoids silently stale recall. */
  private async refreshIndexIfStale(): Promise<void> {
    const persisted = Number((await this.getMeta('index_generation')) ?? 0);
    if (persisted !== this.indexGeneration) {
      await this.loadIndex();
      if (this.zhVectorIndex) await this.loadZhIndex();
    }
  }

  private async bumpIndexGeneration(): Promise<void> {
    if (!this.db) return;
    // One SQL increment avoids lost updates from simultaneous processes.
    // Only acknowledge the change if this mirror was already current: legacy
    // create/update/backfill paths must not hide unseen external writes.
    const row = await this.db.get<{value:string}>(
      "INSERT INTO memory_meta(key,value) VALUES ('index_generation','1') " +
      "ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1 RETURNING value");
    const next = Number(row!.value);
    if (this.indexGeneration === next - 1) this.indexGeneration = next;
  }

  private indexMetadata(node: MemoryNode): VectorItem['metadata'] {
    return {
      dimensions:node.dimensions, kind:node.kind,
      dimension: node.dimension, layer: node.layer, domain: node.domain, sessionId: node.sessionId,
      tags: node.tags, supersededBy: node.supersededBy,
      content: node.content.slice(0, 200), importance: node.importance,
    };
  }

  private refreshIndexedNode(node: MemoryNode): void {
    const item = this.vectorIndex.get(node.id);
    if (item) this.vectorIndex.add({ ...item, metadata: this.indexMetadata(node) });
  }

  /**
   * Schedule background embedding backfill.
   * Waits for system to settle, then generates embeddings for nodes that lack them.
   * This ensures ANN search has full coverage when embedding API is available.
   */
  private embeddingScheduled = false;
  private embeddingBackfill?: Promise<void>;
  private scheduleEmbeddingBackfill(): void {
    if (this.closing || this.embeddingScheduled) return;
    this.embeddingScheduled = true;
    this.later(async () => {
      this.embeddingScheduled = false;
      await this.backfillEmbeddings();
    }, 5000);
  }

  private async backfillEmbeddings(): Promise<void> {
    if (this.embeddingBackfill) return this.embeddingBackfill;
    const work = this.fillEmbeddings();
    this.embeddingBackfill = work;
    try { await work; } finally { this.embeddingBackfill = undefined; }
  }

  private async fillEmbeddings(): Promise<void> {
    if (!this.db || this.closing) return;
    if (await this.anchors.backfill()) this.scheduleEmbeddingBackfill();
    const svc = getEmbeddingService();
    const byteLen = (svc['dimensions'] ?? 384) * 4;
    const missing = await this.db.all<NodeRow[]>(
      `SELECT ${NODE_COLUMNS_NO_EMBEDDING} FROM nodes WHERE layer!='L0' AND (embedding IS NULL OR LENGTH(embedding)!=? OR embedding_profile!=? OR (?=0 AND embedding_profile IS NULL)) ORDER BY rowid LIMIT 500`, [byteLen,legacyEmbeddingIdentity(),Number(acceptsUnlabelledLegacyVectors())]);
    if (!missing.length || !(await svc.testConnection())) return;
    let done = 0;
    for (let i = 0; i < missing.length && !this.closing; i += 20) {
      const chunk = missing.slice(i, i + 20);
      const embeddings = await svc.generateBatch(chunk.map(row => row.content ?? ''));
      if (this.closing) return;
      await this.growthWrite(async () => {
        let changedInBatch=0;
        for (let j = 0; j < chunk.length; j++) {
          const row = chunk[j], vec = embeddings[j];
          if (!vec?.length) continue;
          const changed = await this.db!.run(
            'UPDATE nodes SET embedding=?,embedding_profile=? WHERE id=? AND updated_at=? AND content=? AND (embedding IS NULL OR LENGTH(embedding)!=? OR embedding_profile!=? OR (?=0 AND embedding_profile IS NULL))',
            [Buffer.from(new Float32Array(vec).buffer),legacyEmbeddingIdentity(),row.id,row.updated_at,row.content,byteLen,legacyEmbeddingIdentity(),Number(acceptsUnlabelledLegacyVectors())]);
          if (!changed.changes) continue;
          done++;changedInBatch++;
        }
        if (changedInBatch) await this.db!.run("UPDATE memory_meta SET value=CAST(value AS INTEGER)+1 WHERE key='index_generation'");
      });
    }
    // Search reloads only committed vectors; an old metadata snapshot is never
    // added directly. Continue through large collections without a startup cap.
    if (missing.length === 500 && done) this.scheduleEmbeddingBackfill();
  }

  // ============================================
  // ZH side-channel (bge-small-zh-v1.5, 512d) — opt-in via EMBEDDING_ZH_ENABLED.
  // Vectors live in nodes_zh table + separate in-memory index; the main
  // nodes.embedding column and its 384d index are never touched.
  // ============================================

  private async loadZhIndex(): Promise<void> {
    if (!this.db || !this.zhVectorIndex) return;
    try {
      this.zhVectorIndex.clear();
      const rows = await this.db.all<any>(`SELECT id, embedding FROM nodes_zh WHERE embedding_profile=? OR (?=1 AND embedding_profile IS NULL)`,[legacyZhEmbeddingIdentity(),Number(acceptsUnlabelledZhVectors())]);
      let loaded = 0, skipped = 0;
      const dims = zhDims();
      for (const row of rows) {
        if (!row.embedding) continue;
        try {
          const vec = this.bufferToVector(row.embedding);
          if (vec.length !== dims) { skipped++; continue; }
          this.zhVectorIndex.add({ id: row.id, vector: vec });
          loaded++;
        } catch { skipped++; }
      }
      logger.info(`[GraphMemory] ZH vector index loaded: ${loaded} nodes${skipped ? `, skipped ${skipped}` : ''}`);
    } catch (err: unknown) {
      logger.warn(`[GraphMemory] ZH index load failed: ${getErrorMessage(err)}`);
      this.indexGeneration=-1;
      throw new MindPondError('temporarily_unavailable','Chinese vector index reload failed',{retryable:true});
    }
  }

  /**
   * Backfill ZH embeddings for Chinese-dominant nodes missing from nodes_zh.
   * Batched (50/batch, 200ms gap), capped per run — remaining nodes are
   * picked up on the next startup. Also repairs rows deleted from nodes
   * (orphan cleanup keeps nodes_zh in sync with the main table).
   */
  private async backfillZhEmbeddings(): Promise<void> {
    if (!this.db || !this.zhVectorIndex) return;
    const svc = getZhEmbeddingService();
    if (!(await svc.testConnection())) {
      logger.debug('[GraphMemory] ZH embedding model unavailable, skipping ZH backfill');
      return;
    }
    const missing = await this.db.all<any>(
      `SELECT n.id, n.content, n.updated_at FROM nodes n
       LEFT JOIN nodes_zh z ON z.id = n.id
       WHERE (z.id IS NULL OR z.embedding_profile!=? OR (?=0 AND z.embedding_profile IS NULL) OR LENGTH(z.embedding)!=?) AND n.layer != 'L0'
         AND n.content GLOB '*[一-龥]*'
       ORDER BY n.rowid LIMIT 500`,[legacyZhEmbeddingIdentity(),Number(acceptsUnlabelledZhVectors()),zhDims()*4]
    );
    if (missing.length === 0) { logger.info('[GraphMemory] ZH backfill: nothing to do'); return; }

    // Orphan cleanup: rows in nodes_zh whose main node is gone
    await this.db.run(`DELETE FROM nodes_zh WHERE id NOT IN (SELECT id FROM nodes)`);

    logger.info(`[GraphMemory] ZH backfill: processing ${missing.length} nodes...`);
    const BATCH = 50;
    let done = 0;
    for (let i = 0; i < missing.length; i += BATCH) {
      const chunk = missing.slice(i, i + BATCH);
      for (const row of chunk) {
        const content: string = row.content || '';
        if (!isChineseText(content)) continue; // non-Chinese → not indexed in ZH channel
        const vec = await svc.generateEmbedding(content);
        if (vec.length === 0) continue;
        if (this.closing) return;
        await this.growthWrite(async () => {
          const changed = await this.db!.run(`INSERT OR REPLACE INTO nodes_zh (id,embedding,embedding_profile)
            SELECT id,?,? FROM nodes WHERE id=? AND content=? AND updated_at=?`,
            [Buffer.from(new Float32Array(vec).buffer),legacyZhEmbeddingIdentity(),row.id,row.content,row.updated_at]);
          if (changed.changes) {
            done++;
            await this.db!.run("UPDATE memory_meta SET value=CAST(value AS INTEGER)+1 WHERE key='index_generation'");
          }
        });
      }
      if (i + BATCH < missing.length) await new Promise(r => setTimeout(r, 200));
    }
    logger.info(`[GraphMemory] ZH backfill complete: ${done}/${missing.length} nodes indexed (remaining on next startup)`);
    // Self-continuation: if this run hit the 500 cap, keep going (rescheduled)
    if (missing.length >= 500) {
      this.later(() => this.backfillZhEmbeddings(), 1000);
    }
  }

  // ============================================
  // CRUD
  // ============================================

  async createNode(params: {
    dimensions?: KnowledgeDimension[];
    dimension: Dimension;
    layer?: MemoryLayer;       // default 'L1'
    content: string;
    importance?: number;
    tags?: string[];
    verified?: boolean;
    source?: string;
    sessionId?: string;
    domain?: MemoryDomainRef;
    teamAuthorization?: string;
    embedding?: number[];
    /** Memberships are independent placements of this canonical content. */
    memberships?: Array<{ spaceId: string; memoryType?: string }>;
  }): Promise<MemoryNode> {
    if (!this.db) throw new Error('Database not initialized');

    const domain = normalizeDomain(params.domain, params.sessionId);
    const dimensions=normalizeDimensions(params.dimensions,params.dimension);
    await this.assertDimensions(dimensions);
    await this.assertTeamWrite(domain, params.teamAuthorization, 'save');
    await this.ensureDomain(domain);
    const now = Date.now();
    const id = crypto.randomUUID();

    // Generate embedding if not provided (skip for L0 — raw records don't need vectors)
    let embedding = params.embedding || [];
    const skipEmbedding = (params.layer || 'L1') === 'L0';
    if (!skipEmbedding && embedding.length === 0 && params.content) {
      try {
        embedding = await getEmbeddingService().generateEmbedding(params.content);
      } catch (err: unknown) {
        // Embedding API not available — use zero vector (ngram search still works)
        logger.debug('Embedding unavailable, using keyword-only search');
      }
    }

    const node: MemoryNode = {
      dimensions,kind:params.dimension==='event'?'event':'knowledge',
      id,
      dimension: params.dimension,
      layer: params.layer || 'L1',
      content: params.content,
      embedding,
      importance: params.importance ?? 5,
      tags: params.tags || [],
      verified: params.verified,
      source: params.source,
      domain,
      sessionId: params.sessionId,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    };

    await this.growthWrite(async()=>{
      await this.assertDimensions(dimensions);
      await this.assertTeamWrite(domain, params.teamAuthorization, 'save');
      if(domain.kind==='session')await this.assertSessionWritable(domain.id);
      await this.db!.run(
        `INSERT INTO nodes (id, dimension, layer, content, embedding, importance, tags, verified, source, domain_kind, domain_id, session_id, created_at, updated_at, access_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          node.id, legacyDimension(node.dimension), node.layer, node.content,
          embedding.length > 0 ? Buffer.from(new Float32Array(embedding).buffer) : null,
          node.importance, JSON.stringify(node.tags),
          node.verified ? 1 : 0, node.source || null, domain.kind, domain.id, node.sessionId || null,
          node.createdAt, node.updatedAt, 0,
        ]
      );

      // Keep a useful backwards-compatible default while allowing a caller to
      await this.db!.run('UPDATE nodes SET embedding_profile=? WHERE id=?',[legacyEmbeddingIdentity(),id]);
      // explicitly place the same body in any number of independent spaces.
      const memberships = dimensionPlacements(params.memberships?.length
        ? params.memberships
        : [{ spaceId: params.dimensions ? `${domain.kind}:${domain.id}` : `legacy:${node.dimension}`, memoryType: node.dimension }],dimensions,node.dimension);
      await this.db!.run('UPDATE nodes SET dimensions=?,primary_dimension=? WHERE id=?',[JSON.stringify(dimensions),node.dimension,id]);
      for (const placement of memberships) {
        await this.addMembershipLocked(
          node.id,
          placement.spaceId,
          placement.memoryType ?? node.dimension,
        );
      }
      await this.logAction({action:'node_created',nodeId:id,reason:`${node.layer}/${node.dimension} imp=${node.importance}`});
      await this.bumpIndexGeneration();
      if(embedding.length)this.vectorIndex.add({id:node.id,vector:embedding,metadata:this.indexMetadata(node)});
    });
    if(this.zhVectorIndex && !skipEmbedding && isChineseText(node.content))this.later(()=>this.backfillZhEmbeddings(),0);
    return node;
  }

  private rowToMembership(row: any): MemoryMembership {
    return {
      id: row.id, memoryId: row.memory_id, spaceId: row.space_id,
      memoryType: row.memory_type, active: Boolean(row.active), version: row.version,
      createdAt: row.created_at, updatedAt: row.updated_at,
      lastReviewedAt: row.last_reviewed_at ?? undefined,
    };
  }

  /** A02: placement resolution shared by saveMemory and validateMemorySave —
   * explicit memberships, or dimension expansion inside the owning domain's
   * space, or the legacy:<dimension> compatibility placement. */
  async getDimensionConfiguration():Promise<DimensionConfiguration> {
    const row=await this.db!.get<{revision:number;payload:string}>('SELECT revision,payload FROM memory_dimension_config WHERE id=1');
    if(!row)throw new Error('Dimension configuration not initialized');
    return {...JSON.parse(row.payload),revision:row.revision};
  }
  async getDimensionPolicy(){return dimensionPolicy(await this.getDimensionConfiguration());}
  async dimensionPolicyDelta(sinceRevision?:number){
    if(sinceRevision!==undefined&&(!Number.isInteger(sinceRevision)||sinceRevision<1))throw new Error('sinceDimensionRevision must be a positive integer');
    const config=await this.getDimensionConfiguration();
    return {dimensionPolicyRevision:config.revision,...(sinceRevision===config.revision?{}:{dimensionPolicy:dimensionPolicy(config)})};
  }
  async configureDimensions(input:Omit<DimensionConfiguration,'revision'> & {expectedRevision:number}) {
    validateDimensionConfiguration(input);
    return this.growthWrite(async()=>{
      const current=await this.getDimensionConfiguration();
      if(input.expectedRevision!==current.revision)throw new Error('Dimension configuration revision conflict; reload before editing');
      const referenced=await this.db!.all<Array<{id:string}>>(`SELECT DISTINCT d.value id FROM nodes n,json_each(COALESCE(n.dimensions,'[]')) d
        UNION SELECT DISTINCT dimension id FROM nodes WHERE dimension!='event' AND (dimensions IS NULL OR dimensions='[]')`);
      const missing=referenced.filter(d=>!input.definitions.some(def=>def.id===d.id));
      if(missing.length)throw new Error('Referenced dimension IDs cannot be removed; archive them with enabled=false: '+missing.map(d=>d.id).join(', '));
      const next={revision:current.revision+1,defaultDimension:input.defaultDimension,prompt:input.prompt,definitions:input.definitions};
      await this.db!.run('UPDATE memory_dimension_config SET revision=?,payload=? WHERE id=1',[next.revision,JSON.stringify(next)]);
      await this.db!.run("UPDATE memory_jobs SET status='queued',lease_expires_at=NULL,last_error='dimension policy changed; reclaim updated prompt',updated_at=? WHERE kind='extract_l1' AND status='leased'",[Date.now()]);
      await this.logAction({action:'dimension_configuration_updated',reason:stableJSON({revision:next.revision,ids:next.definitions.map(d=>d.id)})});
      return next;
    });
  }
  private async assertDimensions(dimensions:string[],retained:string[]=[]) {
    const config=await this.getDimensionConfiguration();
    for(const id of dimensions)if(!config.definitions.some(d=>d.id===id&&(d.enabled||retained.includes(id))))
      throw new Error('Unknown or archived dimension: '+id+'; read memory_dimension_policy and choose a configured identity');
  }

  private resolveSavePlacements(options: { memberships?: Array<{ spaceId: string; memoryType?: string }>; dimensions?: KnowledgeDimension[] },
    dimensions: KnowledgeDimension[], dimension: Dimension, domain: MemoryDomainRef) {
    const suppliedPlacements = options.memberships ?? (options.dimensions
      ? dimensions.map(memoryType=>({spaceId:`${domain.kind}:${domain.id}`,memoryType}))
      : [{ spaceId: `legacy:${dimension}`, memoryType: dimension }]);
    if (!Array.isArray(suppliedPlacements) || !suppliedPlacements.length || (options.memberships!==undefined && suppliedPlacements.length > MEMORY_SAVE_LIMITS.memberships) || suppliedPlacements.some(p =>
      !p || typeof p.spaceId !== 'string' || !p.spaceId.trim() || p.spaceId.length > MEMORY_SAVE_LIMITS.scopeLength ||
      (p.memoryType !== undefined && (typeof p.memoryType !== 'string' || !p.memoryType.trim() || p.memoryType.length > MEMORY_SAVE_LIMITS.scopeLength))))
      throw new Error('memberships requires 1–16 placements with nonempty scope names of at most 128 characters');
    const placements = dimensionPlacements([...new Map(suppliedPlacements.map(p => {
      const placement = { spaceId: p.spaceId.trim(), memoryType: (p.memoryType ?? dimension).trim() };
      return [JSON.stringify(placement), placement] as const;
    })).values()],dimensions,dimension);
    return placements;
  }

  private async resolveSaveRelated(rel: RelatedMemory, placements: Array<{spaceId:string;memoryType:string}>, domain: MemoryDomainRef): Promise<MemoryMembership> {
    this.validateAssociationBasis(rel);
    if (!Number.isFinite(rel.score) || rel.score < 0 || rel.score > 1) throw new Error('score must be 0–1');
    const candidates = await this.db!.all<any>(
      `SELECT m.* FROM memory_memberships m JOIN nodes n ON n.id=m.memory_id
       WHERE m.active=1 AND n.superseded_by IS NULL AND n.domain_kind=? AND n.domain_id=? AND ` +
      (rel.membershipId ? 'm.id=?' : 'm.memory_id=?'), [domain.kind, domain.id, rel.membershipId ?? rel.memoryId ?? '']);
    const matched = candidates.filter((m: any) => (!rel.memoryId || m.memory_id === rel.memoryId) &&
      (!rel.spaceId || m.space_id === rel.spaceId) && (!rel.memoryType || m.memory_type === rel.memoryType) &&
      placements.some(p => p.spaceId === m.space_id && p.memoryType === m.memory_type));
    if (matched.length !== 1) throw new Error('related target must resolve to one active shared domain/space/type; specify membershipId');
    return this.rowToMembership(matched[0]);
  }

  /** Shared agent save contract. Invalid links reject the whole write. */
  async saveMemory(content: string, options: {
    dimensions?: KnowledgeDimension[]; anchors?: MemoryAnchor[];
    dimension?: Dimension; source?: string; tags?: string[]; importance?: number; sessionId?: string;
    domain?: MemoryDomainRef; teamAuthorization?: string;
    memberships?: Array<{ spaceId: string; memoryType?: string }>; related?: RelatedMemory[];
    sourceRefs?: SourceReference[]; idempotencyKey?: string;
  } = {}) {
    if (typeof content !== 'string' || !content.trim() || content.length > MEMORY_SAVE_LIMITS.content)
      throw new Error('content must contain 1–100000 characters');
    content = content.trim();
    const dimension = options.dimension ?? options.dimensions?.[0] ?? (await this.getDimensionConfiguration()).defaultDimension;
    const dimensions=normalizeDimensions(options.dimensions,dimension);
    const domain = normalizeDomain(options.domain, options.sessionId);
    await this.assertTeamWrite(domain, options.teamAuthorization, 'save');
    if (domain.kind === 'session') await this.assertSessionWritable(domain.id);
    await this.ensureDomain(domain);
    const placements = this.resolveSavePlacements(options, dimensions, dimension, domain);
    if (options.related !== undefined && !Array.isArray(options.related)) throw new Error('related must be an array');
    if ((options.related?.length ?? 0) > MEMORY_SAVE_LIMITS.related) throw new Error('related supports at most 64 entries per save');
    for (const rel of options.related ?? []) {
      this.validateAssociationBasis(rel);
      if (!Number.isFinite(rel.score) || rel.score < 0 || rel.score > 1) throw new Error('score must be 0–1');
    }
    if (options.importance !== undefined && (!Number.isInteger(options.importance) || options.importance < 1 || options.importance > 10)) throw new Error('importance must be 1–10');
    if (options.tags !== undefined && (!Array.isArray(options.tags) || options.tags.length > MEMORY_SAVE_LIMITS.tags ||
        options.tags.some(t => typeof t !== 'string' || !t.trim() || t.length > MEMORY_SAVE_LIMITS.tagLength)))
      throw new Error('tags supports at most 16 nonempty strings of at most 64 characters');
    const tags = [...new Set((options.tags ?? []).map(t => t.trim()))];
    if (options.sessionId !== undefined && (typeof options.sessionId !== 'string' || !options.sessionId.trim())) throw new Error('sessionId must be nonempty text when supplied');
    if (options.source !== undefined && (typeof options.source !== 'string' || !options.source.trim())) throw new Error('source must be nonempty text when supplied');
    const sourceRefs = normalizeSources(options.sourceRefs);
    const anchorInputs=normalizeAnchors(options.anchors,content,placements);
    const preparedAnchors=await this.anchors.prepare(anchorInputs);
    const rawKey = options.idempotencyKey === undefined ? undefined : textField(options.idempotencyKey, "idempotencyKey", 256);
    // R01/T02: receipt keys are scoped by ownership domain — two identities
    // reusing the same idempotencyKey never collide or cross receipts.
    const receiptKey = rawKey === undefined ? undefined : `save:${domainKey(domain)}:${rawKey}`;
    const legacyReceiptKey = rawKey === undefined ? undefined : `save:${rawKey}`;
    const requestHash = digest({content, dimension, domain, source: options.source ?? 'conversation',
      importance: options.importance ?? 5, sessionId: options.sessionId, related: options.related ?? [],
      sourceRefs, memberships: placements, tags,
      ...(options.dimensions!==undefined?{dimensions}:{}),...(options.anchors!==undefined?{anchors:anchorInputs}:{})});
    // Accept an exact retry of receipts written before defaults were canonicalized.
    const legacyRequestHash = digest({content, ...options, idempotencyKey: undefined, sourceRefs, memberships: placements, tags});
    // Model work stays outside the SQLite transaction.
    const embedding = await getEmbeddingService().generateEmbedding(content).catch(() => []);
    const zhEmbedding = this.zhVectorIndex && isChineseText(content)
      ? await getZhEmbeddingService().generateEmbedding(content).catch(() => []) : [];
    return this.withWriteLock(async () => {
      await this.db!.exec('BEGIN IMMEDIATE');
      try {
        // An external writer may have committed since our last search. Do not
        // acknowledge its generation merely because this save also commits.
        await this.assertTeamWrite(domain, options.teamAuthorization, 'save');
        if (domain.kind === 'session') await this.assertSessionWritable(domain.id);
        const generationBeforeSave = Number((await this.db!.get<{value:string}>("SELECT value FROM memory_meta WHERE key='index_generation'"))?.value);
        const indexWasCurrent = generationBeforeSave === this.indexGeneration;
        if (receiptKey) {
          const prior = await this.db!.get<any>('SELECT * FROM memory_receipts WHERE key=?', [receiptKey]);
          if (prior) {
            if (prior.request_hash !== requestHash) {
              if (prior.request_hash !== legacyRequestHash) throw new MindPondError('idempotency_conflict', 'save idempotencyKey reuse with a different payload', { retryable: false, nextAction: '先按原 key 查回执；同 key 仅可重放相同载荷，修改必须用新 key 或显式修订' });
              await this.db!.run('UPDATE memory_receipts SET request_hash=? WHERE key=?',[requestHash,receiptKey]);
            }
            await this.db!.exec('COMMIT'); return JSON.parse(prior.payload) as {id:string;memberships:MemoryMembership[];edgesCreated:number;edgesRejected:number;edgesEvicted:number};
          }
          // Pre-upgrade rows live under the unscoped `save:<key>`. Same-domain
          // retries migrate to the scoped key; a collision from another domain
          // is an independent save (T02), never a cross-domain receipt.
          const legacyPrior = await this.db!.get<any>('SELECT * FROM memory_receipts WHERE key=?', [legacyReceiptKey!]);
          if (legacyPrior) {
            const legacyPayload = JSON.parse(legacyPrior.payload) as {id?:string};
            const priorNode = legacyPayload?.id ? await this.db!.get<any>('SELECT domain_kind,domain_id FROM nodes WHERE id=?',[legacyPayload.id]) : undefined;
            const otherDomain = priorNode && (priorNode.domain_kind !== domain.kind || priorNode.domain_id !== domain.id);
            if (otherDomain) {
              // fall through: independent save for this domain
            } else if (legacyPrior.request_hash === requestHash || legacyPrior.request_hash === legacyRequestHash) {
              await this.db!.run('INSERT OR REPLACE INTO memory_receipts(key,request_hash,payload) VALUES (?,?,?)',[receiptKey,requestHash,legacyPrior.payload]);
              await this.db!.exec('COMMIT'); return JSON.parse(legacyPrior.payload) as {id:string;memberships:MemoryMembership[];edgesCreated:number;edgesRejected:number;edgesEvicted:number};
            } else {
              throw new MindPondError('idempotency_conflict', 'save idempotencyKey reuse with a different payload', { retryable: false, nextAction: '先按原 key 查回执；同 key 仅可重放相同载荷，修改必须用新 key 或显式修订' });
            }
          }
        }
        const resolved: Array<{ target: MemoryMembership; rel: RelatedMemory }> = [];
        for (const rel of options.related ?? []) {
          resolved.push({ target: await this.resolveSaveRelated(rel, placements, domain), rel });
        }
        await this.assertDimensions(dimensions);
        const id = crypto.randomUUID(), now = Date.now();
        await this.db!.run('INSERT INTO nodes (id, dimension, layer, content, embedding, importance, tags, source, domain_kind, domain_id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, legacyDimension(dimension), 'L1', content.trim(), embedding.length ? Buffer.from(new Float32Array(embedding).buffer) : null,
            options.importance ?? 5, JSON.stringify(tags), options.source ?? 'conversation', domain.kind, domain.id, options.sessionId ?? null, now, now]);
        await this.db!.run('UPDATE nodes SET embedding_profile=? WHERE id=?',[legacyEmbeddingIdentity(),id]);
        if (zhEmbedding.length) await this.db!.run('INSERT INTO nodes_zh (id, embedding,embedding_profile) VALUES (?, ?,?)', [id,Buffer.from(new Float32Array(zhEmbedding).buffer),legacyZhEmbeddingIdentity()]);
        for (const p of placements) await this.addMembershipLocked(id, p.spaceId, p.memoryType ?? dimension);
        await this.db!.run('UPDATE nodes SET dimensions=?,primary_dimension=? WHERE id=?',[JSON.stringify(dimensions),dimension,id]);
        await this.anchors.replace(id,content,preparedAnchors);
        const memberships = await this.getMemberships(id, { activeOnly: true });
        for (const { target, rel } of resolved) {
          const own = memberships.find(m => m.spaceId === target.spaceId && m.memoryType === target.memoryType)!;
          await this.upsertAssociationLocked(own.id, target.id, target.spaceId, target.memoryType, rel.score, rel);
        }
        if (sourceRefs.length) await this.db!.run('INSERT INTO memory_sources(memory_id,payload) VALUES (?,?)', [id,stableJSON(sourceRefs)]);
        const receipt = { id, memberships, edgesCreated: resolved.length, edgesRejected: 0, edgesEvicted: 0 };
        if (receiptKey) await this.db!.run('INSERT INTO memory_receipts(key,request_hash,payload) VALUES (?,?,?)',[receiptKey,requestHash,stableJSON(receipt)]);
        await this.logAction({ action: 'node_created', nodeId: id, reason: JSON.stringify({ action: 'memory_save', domain, contextualAssociations: resolved.length }) });
        await this.db!.run("UPDATE memory_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'index_generation'");
        const generation = Number((await this.db!.get<{value:string}>("SELECT value FROM memory_meta WHERE key='index_generation'"))?.value);
        const indexNode = this.rowToNode((await this.db!.get<NodeRow>(`SELECT ${NODE_COLUMNS_NO_EMBEDDING} FROM nodes WHERE id=?`, [id]))!);
        await this.db!.exec('COMMIT');
        if (embedding.length) this.vectorIndex.add({id, vector: embedding, metadata: this.indexMetadata(indexNode)});
        if (zhEmbedding.length) this.zhVectorIndex?.add({id, vector: zhEmbedding, metadata: this.indexMetadata(indexNode)});
        // Keep the exact generation committed by this transaction. A write
        // from another process after COMMIT must still trigger a reload.
        if (indexWasCurrent) this.indexGeneration = generation;
        if (!embedding.length) this.scheduleEmbeddingBackfill();
        return JSON.parse(stableJSON(receipt)) as typeof receipt;
      } catch (e) { await this.db!.exec('ROLLBACK'); throw e; }
    });
  }

  /** A02: side-effect-free save validation preview. Mirrors saveMemory's
   * front-matter checks (same error strings), resolves the placements the
   * save would use, and reports anchor/association problems as INDEXED issues
   * {index, constraint, fix} so the host corrects exactly the invalid entries
   * and keeps the valid ones. Writes nothing and creates no task; correction
   * attempts are bounded by the save policy, not by extra state here. */
  async validateMemorySave(options: {
    content: string; dimensions?: KnowledgeDimension[]; dimension?: Dimension;
    anchors?: unknown; memberships?: Array<{ spaceId: string; memoryType?: string }>;
    related?: unknown; importance?: number; tags?: string[]; source?: string;
    sessionId?: string; domain?: MemoryDomainRef; teamAuthorization?: string;
    idempotencyKey?: string; sourceRefs?: SourceReference[];
  }) {
    let content = options.content;
    if (typeof content !== 'string' || !content.trim() || content.length > MEMORY_SAVE_LIMITS.content)
      throw new Error('content must contain 1–100000 characters');
    content = content.trim();
    const dimension = options.dimension ?? options.dimensions?.[0] ?? (await this.getDimensionConfiguration()).defaultDimension;
    const dimensions = normalizeDimensions(options.dimensions, dimension);
    const domain = normalizeDomain(options.domain, options.sessionId);
    await this.assertTeamWrite(domain, options.teamAuthorization, 'save');
    if (domain.kind === 'session') await this.assertSessionWritable(domain.id);
    await this.assertDimensions(dimensions);
    const placements = this.resolveSavePlacements(options, dimensions, dimension, domain);
    if (options.importance !== undefined && (!Number.isInteger(options.importance) || options.importance < 1 || options.importance > 10)) throw new Error('importance must be 1–10');
    if (options.tags !== undefined && (!Array.isArray(options.tags) || options.tags.length > MEMORY_SAVE_LIMITS.tags ||
        options.tags.some(t => typeof t !== 'string' || !t.trim() || t.length > MEMORY_SAVE_LIMITS.tagLength)))
      throw new Error('tags supports at most 16 nonempty strings of at most 64 characters');
    if (options.sessionId !== undefined && (typeof options.sessionId !== 'string' || !options.sessionId.trim())) throw new Error('sessionId must be nonempty text when supplied');
    if (options.source !== undefined && (typeof options.source !== 'string' || !options.source.trim())) throw new Error('source must be nonempty text when supplied');
    if (options.idempotencyKey !== undefined) textField(options.idempotencyKey, 'idempotencyKey', 256);
    const sourceRefs = normalizeSources(options.sourceRefs);
    const diagnosed = diagnoseAnchors(options.anchors, content, placements);
    if (options.related !== undefined && !Array.isArray(options.related)) throw new Error('related must be an array');
    if ((options.related?.length ?? 0) > MEMORY_SAVE_LIMITS.related) throw new Error('related supports at most 64 entries per save');
    const relatedIssues: Array<{ index: number; constraint: string; fix: string }> = [];
    let relatedAccepted = 0;
    for (const [index, rel] of ((options.related as RelatedMemory[] | undefined) ?? []).entries()) {
      try {
        this.validateAssociationBasis(rel);
        if (!Number.isFinite(rel.score) || rel.score < 0 || rel.score > 1) throw new Error('score must be 0–1');
        await this.resolveSaveRelated(rel, placements, domain);
        relatedAccepted += 1;
      } catch (err) {
        relatedIssues.push({ index, constraint: (err as Error).message,
          fix: 'association needs the actual-read target (membershipId), a concrete co-recall reason and the original conditions' });
      }
    }
    // Advisory only: a semantic candidate is neither a duplicate nor a valid
    // association. Keep full records within a small budget and expose omitted
    // IDs for explicit follow-up; never silently truncate a memory body.
    let possibleExisting: {status:'ready'|'unavailable';results:ReturnType<typeof recallEntry>[];omitted:string[];note:string};
    try {
      const candidates = (await this.search({query:content,domains:[domain],sessionId:domain.kind==='session'?domain.id:options.sessionId,
        spaceId:[...new Set(placements.map(p=>p.spaceId))],memoryType:[...new Set(placements.map(p=>p.memoryType))],
        maxDepth:0,limit:8})).filter(hit=>placements.some(p=>p.spaceId===hit.spaceId&&p.memoryType===hit.memoryType));
      const bounded=assembleRecall(candidates,6000);
      possibleExisting={status:'ready',results:bounded.results.map(recallEntry),omitted:bounded.contextBudget.omitted.map(o=>o.memoryId),
        note:'Review complete candidates before saving: update, reuse, or explicitly save a distinct claim. Similarity alone is not a duplicate judgment.'};
    } catch {
      possibleExisting={status:'unavailable',results:[],omitted:[],note:'Candidate lookup unavailable; validation still checks structural constraints. Search the intended scope before saving when possible.'};
    }
    return {
      valid: diagnosed.issues.length === 0 && relatedIssues.length === 0,
      placements, dimensions, domain, possibleExisting,
      sourceRefs,
      // Preview is a read of current state, never a reservation or a receipt.
      revalidateOnSave: true,
      anchors: { accepted: diagnosed.anchors.length, issues: diagnosed.issues.map(issue => ({ ...issue,
        code: 'invalid_input', field: anchorIssueField(issue), retryable: false, nextAction: issue.fix })) },
      related: { accepted: relatedAccepted, issues: relatedIssues.map(issue => ({ ...issue,
        code: 'invalid_input', field: `related[${issue.index}]`, retryable: false, nextAction: issue.fix })) },
    };
  }

  /** Durable raw ingestion: message and extraction job commit together. Hosts own extraction. */
  async ingestTranscript(transcript:string, sessionId?:string, idempotencyKey?:string, captureContext?:ExtractionCaptureContext) {
    textField(transcript,'transcript',1000000);
    if(sessionId!==undefined){textField(sessionId,'sessionId',256);await this.assertSessionWritable(sessionId);}
    const rawKey=idempotencyKey===undefined?undefined:textField(idempotencyKey,'idempotencyKey',256);
    // R01/T02: receipt keys are scoped by ownership domain, same as saveMemory.
    const domain=normalizeDomain(undefined,sessionId);
    const key=rawKey===undefined?undefined:`ingest:${domainKey(domain)}:${rawKey}`;
    const legacyKey=rawKey===undefined?undefined:`ingest:${rawKey}`;
    let capture: ExtractionCaptureContext | undefined;
    if (captureContext !== undefined) {
      if (!sessionId) throw new MindPondError('invalid_input','capture context requires a session');
      const spaceId=textField(captureContext.spaceId,'captureContext.spaceId',128);
      if (!Array.isArray(captureContext.observations) || !captureContext.observations.length || captureContext.observations.length>24)
        throw new MindPondError('invalid_input','capture context requires 1–24 observations');
      const observations=captureContext.observations.map(o=>({id:textField(o.id,'observation.id',256),sourceRefs:normalizeSources(o.sourceRefs)}));
      if(new Set(observations.map(o=>o.id)).size!==observations.length)throw new MindPondError('invalid_input','duplicate capture observation IDs');
      capture={spaceId,observations};
    }
    const hash=digest({transcript,sessionId,...(capture?{captureContext:capture}:{})});
    return this.growthWrite(() => this.ingestTranscriptLocked(transcript,sessionId,key,hash,undefined,legacyKey,capture));
  }

  private async ingestTranscriptLocked(transcript:string,sessionId:string|undefined,key:string|undefined,hash:string,legacyMessage?:{messageId:string;role:string},legacyKey?:string,captureContext?:ExtractionCaptureContext) {
      if(sessionId)await this.assertSessionWritable(sessionId);
      const conflict=()=>new MindPondError('idempotency_conflict','transcript ingest idempotencyKey reuse with different content',{retryable:false,nextAction:'先按原 key 查回执；同 key 仅可重放相同载荷，修改必须用新 key 或显式修订'});
      const old=key?await this.db!.get<any>('SELECT * FROM memory_receipts WHERE key=?',[key]):undefined;
      if(old){if(old.request_hash!==hash)throw conflict();return JSON.parse(old.payload) as {l0Id:string;extractionJobId:string};}
      if(key && legacyKey && legacyKey!==key) {
        // Pre-upgrade rows live under the unscoped `ingest:<key>`. Same-domain
        // retries migrate; a collision from another domain is independent (T02).
        const legacyRow=await this.db!.get<any>('SELECT * FROM memory_receipts WHERE key=?',[legacyKey]);
        if(legacyRow) {
          const legacyPayload=JSON.parse(legacyRow.payload) as {l0Id?:string};
          const priorNode=legacyPayload?.l0Id?await this.db!.get<any>('SELECT domain_kind,domain_id FROM nodes WHERE id=?',[legacyPayload.l0Id]):undefined;
          const otherDomain=priorNode&&(priorNode.domain_kind!==(sessionId?'session':'personal')||priorNode.domain_id!==(sessionId??'default'));
          if(!otherDomain) {
            if(legacyRow.request_hash!==hash)throw conflict();
            await this.db!.run('INSERT OR REPLACE INTO memory_receipts(key,request_hash,payload) VALUES (?,?,?)',[key,hash,legacyRow.payload]);
            return JSON.parse(legacyRow.payload) as {l0Id:string;extractionJobId:string};
          }
        }
      }
      if(legacyMessage) {
        // Migrate the earlier tag-based receipt, using exact JSON membership and
        // session identity. The writer transaction also fences concurrent saves.
        const existing=await this.db!.get<any>("SELECT n.id,n.content FROM nodes n WHERE n.layer='L0' AND n.session_id=? AND EXISTS (SELECT 1 FROM json_each(n.tags) t WHERE t.value=?) LIMIT 1",[sessionId,'msgid:'+legacyMessage.messageId]);
        if(existing) {
          if(existing.content!==transcript)throw new Error('idempotency_conflict');
          const job=await this.db!.get<any>('SELECT job_id FROM memory_job_sources WHERE node_id=? LIMIT 1',[existing.id]);
          const extractionJobId=job?.job_id ?? crypto.randomUUID();
          if(!job) {
            const now=Date.now();
            await this.db!.run("INSERT INTO memory_jobs(id,kind,status,session_id,created_at,updated_at) VALUES (?,'extract_l1','queued',?,?,?)",[extractionJobId,sessionId,now,now]);
            await this.db!.run('INSERT INTO memory_job_sources(job_id,node_id,position) VALUES (?,?,0)',[extractionJobId,existing.id]);
          }
          const receipt={l0Id:existing.id,extractionJobId};
          await this.db!.run('INSERT INTO memory_receipts(key,request_hash,payload) VALUES (?,?,?)',[key,hash,stableJSON(receipt)]);
          return receipt;
        }
      }
      const l0Id=crypto.randomUUID(),extractionJobId=crypto.randomUUID(),now=Date.now();
      const domain=normalizeDomain(undefined,sessionId);
      await this.ensureDomain(domain);
      const tags=legacyMessage?[legacyMessage.role,`session:${sessionId}`,`msgid:${legacyMessage.messageId}`]:[];
      await this.db!.run("INSERT INTO nodes(id,dimension,layer,content,importance,tags,source,domain_kind,domain_id,session_id,created_at,updated_at) VALUES (?,'event','L0',?,3,?,?,?,?,?,?,?)",[l0Id,transcript,JSON.stringify(tags),legacyMessage?'conversation':'transcript',domain.kind,domain.id,sessionId ?? null,now,now]);
      await this.addMembershipLocked(l0Id,'legacy:event','event');
      await this.db!.run("INSERT INTO memory_jobs(id,kind,status,session_id,created_at,updated_at) VALUES (?,'extract_l1','queued',?,?,?)",[extractionJobId,sessionId ?? null,now,now]);
      await this.db!.run('INSERT INTO memory_job_sources(job_id,node_id,position) VALUES (?,?,0)',[extractionJobId,l0Id]);
      if(captureContext)await this.db!.run('INSERT INTO memory_job_context(job_id,payload) VALUES (?,?)',[extractionJobId,stableJSON(captureContext)]);
      const receipt={l0Id,extractionJobId};
      if(key)await this.db!.run('INSERT INTO memory_receipts(key,request_hash,payload) VALUES (?,?,?)',[key,hash,stableJSON(receipt)]);
      await this.growth.audit('transcript_ingested',{extractionJobId,idempotencyKey:key ?? null},l0Id);
      await this.db!.run("UPDATE memory_meta SET value=CAST(value AS INTEGER)+1 WHERE key='index_generation'");
      return receipt;
  }

  private async growthWrite<T>(fn: () => Promise<T>): Promise<T> {
    try { return await this.coordinator.transaction(this.db!, fn); }
    catch (error) { this.indexGeneration = -1; throw error; }
  }

  async databaseReadiness() {
    return this.withWriteLock(async()=>{
      const audit=await auditDatabase(this.db!);
      return {ready:!this.closing&&audit.healthy,foreignKeyViolations:audit.foreignKeys.length,crossDomainAssociations:audit.foreignAssociations.length};
    });
  }

  /** Private host recovery checks durable state after a database restore. */
  async lifecycleCaptured(sessionId:string,hostId:string,runId:string,checkpointId:string) {
    const key=`ingest:${domainKey({kind:'session',id:sessionId})}:lifecycle:${digest([hostId,runId,checkpointId])}`;
    const receipt=await this.db!.get<{payload:string}>('SELECT payload FROM memory_receipts WHERE key=?',[key]);
    if(!receipt)return false;
    const id=JSON.parse(receipt.payload).l0Id;
    return !!await this.db!.get('SELECT 1 FROM nodes WHERE id=? AND domain_kind=\'session\' AND domain_id=?',[id,sessionId]);
  }
  async hostSessionStatus(sessionId:string) {return (await this.db!.get('SELECT status FROM memory_domains WHERE kind=\'session\' AND id=?',[sessionId]))?.status;}

  async renewHostWork(workId:string,leaseToken:string) {return this.growthWrite(() => this.growth.workRenew(workId,leaseToken));}
  async retryHostWork(workId:string,reason:string) {return this.growthWrite(() => this.growth.workRetry(workId,reason));}
  /** R02: cancel a pending/leased work item. Committed results are preserved
   *  and reported back; a cancel that loses the finish/cancel race reports the
   *  winner's terminal state instead of overwriting it. */
  async cancelHostWork(workId:string,reason:string) {return this.growthWrite(() => this.growth.workCancel(workId,reason));}
  async getProfile(membershipId:string, options:{offset?:number;limit?:number;sourceContext?:string;context?:DomainReadContext}={}) {
    if (options.context) await this.assertMembershipReadable(membershipId, options.context);
    return this.withWriteLock(() => this.growth.profileGet(membershipId, options));
  }
  /** M02.b: profile evidence is memory content — resolve the membership's node
   *  domain before expanding supports/history. Unknown ids fall through to the
   *  downstream not-found error. */
  private async assertMembershipReadable(membershipId: string, context: DomainReadContext): Promise<void> {
    const m = await this.db!.get<any>(
      'SELECT n.id AS node_id, n.domain_kind, n.domain_id FROM memory_memberships m JOIN nodes n ON n.id = m.memory_id WHERE m.id = ?',
      [membershipId]);
    if (!m) return;
    await this.assertNodeInReadableDomains({ id: m.node_id, domain: { kind: m.domain_kind, id: m.domain_id } }, context);
  }
  async getMemoryFreshness(membershipId:string, sourceContext?:string) {return this.withWriteLock(() => this.growth.freshness(membershipId,sourceContext));}
  async observeSource(input:SourceObservation) {return this.growthWrite(() => this.growth.observe(input));}
  async getSourceObservation(uri:string, context:string) {
    const row=await this.db!.get<any>('SELECT version,payload FROM source_observations WHERE uri=? AND context=?',[uri,context]);
    return row ? {version:row.version,...JSON.parse(row.payload)} : {version:0,observation:null};
  }
  async checkpoint(input:CheckpointInput) {
    if (input.domain?.kind === 'session') await this.assertSessionWritable(input.domain.id);
    return this.growthWrite(() => this.growth.checkpoint(input));
  }
  async claimHostWork(spaceId:string,memoryType:string,domain:MemoryDomainRef={kind:'personal',id:'default'}) {return this.growthWrite(() => this.growth.workClaim(spaceId,memoryType,domain));}
  async finishHostWork(input:Parameters<GrowthStore['workFinish']>[0]) {return this.growthWrite(() => this.growth.workFinish(input));}
  async listHostWork(spaceId:string,memoryType:string,domain:MemoryDomainRef={kind:'personal',id:'default'}) {
    const rows=await this.db!.all<any>('SELECT id,status,attempts,available_at,lease_until,payload,receipt FROM host_work WHERE domain_kind=? AND domain_id=? AND space_id=? AND memory_type=? ORDER BY available_at DESC LIMIT 100',[domain.kind,domain.id,spaceId,memoryType]);
    return rows.map((r:any)=>({...r,payload:JSON.parse(r.payload),receipt:r.receipt ? {...JSON.parse(r.receipt),leaseToken:undefined} : null}));
  }
  /** References belong to the private source. No mutation or backlink is made
   * in the team's knowledge, and a team search cannot traverse these backwards. */
  async linkTeamReference(sourceMemberId:string,targetMemberId:string,basis:AssociationBasis,weight:number,context:DomainReadContext) {
    this.validateAssociationBasis(basis);
    if(!Number.isFinite(weight)||weight<0||weight>1)throw new Error('weight must be 0–1');
    resolveReadDomains(context);
    return this.withWriteLock(async()=>{
      await this.db!.exec('BEGIN IMMEDIATE');
      try {
        await this.assertMembershipReadable(sourceMemberId,context);await this.assertMembershipReadable(targetMemberId,context);
        const members=await this.db!.all<any[]>('SELECT m.*,n.domain_kind,n.domain_id,n.dimension FROM memory_memberships m JOIN nodes n ON n.id=m.memory_id WHERE m.id IN (?,?)',[sourceMemberId,targetMemberId]);
        const a=members.find(m=>m.id===sourceMemberId),b=members.find(m=>m.id===targetMemberId);
        if(!a||!b||!a.active||!b.active||a.domain_kind==='team'||b.domain_kind!=='team'||a.dimension==='event'||b.dimension==='event')throw new Error('Team references require active private knowledge → team knowledge');
        if(a.space_id!==b.space_id||a.memory_type!==b.memory_type)throw new Error('Team references cannot cross spaces/types');
        const id='team-ref:'+digest([sourceMemberId,targetMemberId]);
        await this.db!.run('INSERT INTO memory_team_references(id,source_member_id,target_member_id,weight,reason,context,created_at,source_version,target_version) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source_member_id,target_member_id) DO UPDATE SET weight=excluded.weight,reason=excluded.reason,context=excluded.context,created_at=excluded.created_at,source_version=excluded.source_version,target_version=excluded.target_version',[id,sourceMemberId,targetMemberId,weight,basis.reason,basis.context,Date.now(),a.version,b.version]);
        await this.growth.audit('team_reference_updated',{id,sourceMemberId,targetMemberId},a.memory_id);
        await this.db!.exec('COMMIT');return {id};
      } catch(error){await this.db!.exec('ROLLBACK');throw error;}
    });
  }
  /** Maintenance discovery reads durable queues, including extraction work
   * created without a live host checkpoint. Team work remains user initiated. */
  async hostWorkDomain(workId:string):Promise<MemoryDomainRef|null> {
    const row=await this.db!.get<{domain_kind:MemoryDomainRef['kind'];domain_id:string}>('SELECT domain_kind,domain_id FROM host_work WHERE id=?',[workId]);
    return row?{kind:row.domain_kind,id:row.domain_id}:null;
  }

  async pendingOrganizationScopes(context?:DomainReadContext) {
    const domains=context?resolveReadDomains(context):undefined;
    const scope=domains?' AND ('+domains.map(()=>'(domain_kind=? AND domain_id=?)').join(' OR ')+')':'';
    const rows=await this.db!.all<any[]>(`SELECT domain_kind,domain_id,space_id,memory_type,MIN(available_at) next
      FROM host_work w WHERE status IN ('pending','leased') AND domain_kind!='team'
      AND (domain_kind!='session' OR EXISTS(SELECT 1 FROM memory_domains d WHERE d.kind='session' AND d.id=w.domain_id AND d.status='active'))
      ${scope} GROUP BY domain_kind,domain_id,space_id,memory_type ORDER BY next LIMIT 64`,domains?.flatMap(d=>[d.kind,d.id])??[]);
    return rows.map(r=>({domain:{kind:r.domain_kind,id:r.domain_id} as MemoryDomainRef,spaceId:r.space_id,memoryType:r.memory_type}));
  }
  async getProfileHistory(membershipId:string, context?:DomainReadContext) {
    if (context) await this.assertMembershipReadable(membershipId, context);
    const rows=await this.db!.all<any>('SELECT revision,payload FROM profile_revisions WHERE profile_id=? ORDER BY revision DESC LIMIT 100',[membershipId]);
    return rows.map((r:any)=>({revision:r.revision,...JSON.parse(r.payload)}));
  }

  // ─── Structured collaboration state (not knowledge graph memory) ─────────

  private workContextRow(row: any): WorkContext {
    return {id:row.id,domain:{kind:row.domain_kind,id:row.domain_id},goal:row.goal,
      participants:safeParse(row.participants,[]),sessionRefs:safeParse(row.session_refs,[]),status:row.status,
      revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at};
  }
  private workTaskRow(row: any): WorkTask {
    return {id:row.id,contextId:row.context_id,parentId:row.parent_id ?? undefined,title:row.title,
      acceptanceCriteria:safeParse(row.acceptance_criteria,[]),status:row.status,dependencies:safeParse(row.dependencies,[]),
      assignee:row.assignee ?? undefined,revision:row.revision,attempt:row.attempt,leaseUntil:row.lease_until ?? undefined,
      resultRefs:safeParse(row.result_refs,[]),blockers:safeParse(row.blockers,[]),createdAt:row.created_at,updatedAt:row.updated_at};
  }
  private stringList(value: unknown, name: string, max = 64): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 2000)) throw new Error(`${name} must contain at most ${max} nonempty strings`);
    return [...new Set(value.map(item => item.trim()))];
  }
  async createWorkContext(input: {domain?:MemoryDomainRef; goal:string; participants?:string[]; sessionRefs?:string[]; teamAuthorization?:string}): Promise<WorkContext> {
    const domain=normalizeDomain(input.domain,input.domain?.kind==='session'?input.domain.id:undefined);
    await this.assertTeamWrite(domain,input.teamAuthorization,'task_context');
    await this.ensureDomain(domain);
    if (domain.kind === 'session') {
      const state=await this.db!.get<any>("SELECT status FROM memory_domains WHERE kind='session' AND id=?",[domain.id]);
      if (state?.status === 'closed') throw new Error('Cannot create work in a closed session');
    }
    const goal=textField(input.goal,'goal',4000),participants=this.stringList(input.participants,'participants'),sessionRefs=this.stringList(input.sessionRefs,'sessionRefs');
    const now=Date.now(),id=crypto.randomUUID();
    await this.db!.run('INSERT INTO work_contexts(id,domain_kind,domain_id,goal,participants,session_refs,status,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,\'open\',1,?,?)',[id,domain.kind,domain.id,goal,JSON.stringify(participants),JSON.stringify(sessionRefs),now,now]);
    await this.logAction({action:'work_context_created',reason:stableJSON({id,domain,goal})});
    return {id,domain,goal,participants,sessionRefs,status:'open',revision:1,createdAt:now,updatedAt:now};
  }
  async listWorkContexts(domains?: MemoryDomainRef[]): Promise<WorkContext[]> {
    const readable=domains !== undefined ? domains.map(domain=>normalizeDomain(domain,domain.kind==='session'?domain.id:undefined)) : [{kind:'personal' as const,id:'default'}];
    if (!readable.length) return [];
    const where=readable.map(()=>'(domain_kind=? AND domain_id=?)').join(' OR ');
    const params=readable.flatMap(domain=>[domain.kind,domain.id]);
    const rows=await this.db!.all<any>(`SELECT * FROM work_contexts WHERE (${where}) AND NOT EXISTS(SELECT 1 FROM work_collaboration_workspaces w WHERE w.context_id=work_contexts.id) AND (domain_kind != 'session' OR EXISTS (SELECT 1 FROM memory_domains d WHERE d.kind='session' AND d.id=work_contexts.domain_id AND d.status IN ('active','paused'))) ORDER BY updated_at DESC LIMIT 200`,params);
    return rows.map((row:any)=>this.workContextRow(row));
  }
  private async readableWorkContext(contextId: string, domains?: MemoryDomainRef[]): Promise<any> {
    if(await this.db!.get('SELECT 1 FROM work_collaboration_workspaces WHERE context_id=?',[contextId]))throw new MindPondError('scope_denied','Account-managed collaboration requires the authenticated handoff/task interfaces');
    const context=await this.db!.get<any>('SELECT * FROM work_contexts WHERE id=?',[contextId]);
    if (!context) throw new Error('Work context is missing or closed');
    const readable=domains !== undefined ? domains.map(domain=>normalizeDomain(domain,domain.kind==='session'?domain.id:undefined)) : [{kind:'personal' as const,id:'default'}];
    if (!readable.some(domain=>domain.kind===context.domain_kind&&domain.id===context.domain_id)) throw new Error('Work context is outside readable domains');
    if (context.domain_kind === 'session') {
      const state=await this.db!.get<any>("SELECT status FROM memory_domains WHERE kind='session' AND id=?",[context.domain_id]);
      if (!state || !['active','paused'].includes(state.status)) throw new Error('Work context session is closed');
    }
    return context;
  }
  async createWorkTask(input:{contextId:string;title:string;acceptanceCriteria?:string[];dependencies?:string[];parentId?:string;expectedContextRevision?:number;domains?:MemoryDomainRef[]}): Promise<WorkTask> {
    return this.growthWrite(async () => {
      const context=await this.readableWorkContext(input.contextId,input.domains);
      if(context.status!=='open')throw new Error('Work context is missing or closed');
      if(input.expectedContextRevision!==undefined&&input.expectedContextRevision!==context.revision)throw new Error('stale_context_revision');
      const title=textField(input.title,'task title',1000),acceptanceCriteria=this.stringList(input.acceptanceCriteria,'acceptanceCriteria'),dependencies=this.stringList(input.dependencies,'dependencies');
      if(input.parentId){const parent=await this.db!.get<any>('SELECT context_id FROM work_tasks WHERE id=?',[input.parentId]);if(!parent||parent.context_id!==input.contextId)throw new Error('parent task is outside work context');}
      for(const dependency of dependencies){const task=await this.db!.get<any>('SELECT context_id FROM work_tasks WHERE id=?',[dependency]);if(!task||task.context_id!==input.contextId)throw new Error('dependency is outside work context');}
      const now=Date.now(),id=crypto.randomUUID();
      await this.db!.run('INSERT INTO work_tasks(id,context_id,parent_id,title,acceptance_criteria,status,dependencies,revision,attempt,result_refs,blockers,created_at,updated_at) VALUES (?,?,?,?,?,\'open\',?,1,0,\'[]\',\'[]\',?,?)',[id,input.contextId,input.parentId??null,title,JSON.stringify(acceptanceCriteria),JSON.stringify(dependencies),now,now]);
      await this.db!.run('UPDATE work_contexts SET revision=revision+1,updated_at=? WHERE id=?',[now,input.contextId]);
      await this.logAction({action:'work_task_created',reason:stableJSON({id,contextId:input.contextId,title})});
      return {id,contextId:input.contextId,parentId:input.parentId,title,acceptanceCriteria,status:'open',dependencies,revision:1,attempt:0,resultRefs:[],blockers:[],createdAt:now,updatedAt:now} as WorkTask;
    });
  }
  async listWorkTasks(contextId:string, domains?:MemoryDomainRef[]): Promise<WorkTask[]> {
    await this.readableWorkContext(contextId,domains);
    const rows=await this.db!.all<any>('SELECT * FROM work_tasks WHERE context_id=? ORDER BY created_at,id LIMIT 500',[contextId]);
    return rows.map((row:any)=>this.workTaskRow(row));
  }
  async claimWorkTask(input:{taskId:string;agentId:string;leaseMs?:number;expectedRevision?:number;domains?:MemoryDomainRef[]}): Promise<{task:WorkTask;leaseToken:string}> {
    textField(input.agentId,'agentId',256);const leaseMs=Math.max(10_000,Math.min(1_800_000,Math.floor(input.leaseMs??300_000)));
    return this.withWriteLock(async()=>{await this.db!.exec('BEGIN IMMEDIATE');try {
      const now=this.now();
      const row=await this.db!.get<any>('SELECT * FROM work_tasks WHERE id=?',[input.taskId]);if(!row)throw new Error('Task not found');
      await this.readableWorkContext(row.context_id,input.domains);
      if(input.expectedRevision!==undefined&&row.revision!==input.expectedRevision)throw new Error('stale_task_revision');
      if(!['open','claimed'].includes(row.status)||(row.status==='claimed'&&row.lease_until>=now))throw new Error('Task is not available for claim');
      const deps=safeParse(row.dependencies,[]) as string[];if(deps.length){const incomplete=await this.db!.get<any>(`SELECT 1 FROM work_tasks WHERE id IN (${deps.map(()=>'?').join(',')}) AND status!='completed' LIMIT 1`,deps);if(incomplete)throw new Error('Task dependencies are not completed');}
      const token=crypto.randomUUID(),until=now+leaseMs;await this.db!.run("UPDATE work_tasks SET status='claimed',assignee=?,attempt=attempt+1,lease_until=?,claim_token=?,revision=revision+1,updated_at=? WHERE id=?",[input.agentId,until,token,now,input.taskId]);
      const next=await this.db!.get<any>('SELECT * FROM work_tasks WHERE id=?',[input.taskId]);await this.db!.run('INSERT INTO work_task_events(id,task_id,actor,event_id,expected_revision,transition,reason,payload,ts) VALUES (?,?,?,?,?,?,?,\'{}\',?)',[crypto.randomUUID(),input.taskId,input.agentId,`claim:${token}`,row.revision,'claim','claimed',now]);await this.db!.exec('COMMIT');return {task:this.workTaskRow(next),leaseToken:token};
    }catch(error){await this.db!.exec('ROLLBACK');throw error;}});
  }
  async transitionWorkTask(input:{taskId:string;agentId:string;eventId:string;expectedRevision:number;leaseToken?:string;status:WorkTaskStatus;reason:string;resultRefs?:string[];blockers?:string[];domains?:MemoryDomainRef[]}): Promise<WorkTask> {
    textField(input.agentId,'agentId',256);textField(input.eventId,'eventId',256);textField(input.reason,'reason',2000);if(!Number.isInteger(input.expectedRevision))throw new Error('expectedRevision is required');
    if(!['open','blocked','submitted','completed','cancelled'].includes(input.status))throw new Error('Invalid task transition status');
    // M05.b：事件载荷指纹 —— 同 eventId 同载荷幂等返回原回执，不同载荷显式冲突
    const payloadHash=stableJSON({status:input.status,reason:input.reason,resultRefs:input.resultRefs,blockers:input.blockers});
    // M05.c：字段未提供表示保留；显式提供（含空数组）才改写
    const resultRefs=input.resultRefs===undefined?null:JSON.stringify(this.stringList(input.resultRefs,'resultRefs'));
    const blockers=input.blockers===undefined?null:JSON.stringify(this.stringList(input.blockers,'blockers'));

    return this.withWriteLock(async()=>{await this.db!.exec('BEGIN IMMEDIATE');try{
      const now=this.now();
      const row=await this.db!.get<any>('SELECT * FROM work_tasks WHERE id=?',[input.taskId]);
      if(!row)throw new Error('Task not found');
      // Replay must pass the same domain/session boundary as a new transition.
      await this.readableWorkContext(row.context_id,input.domains);
      const existing=await this.db!.get<any>('SELECT * FROM work_task_events WHERE task_id=? AND event_id=?',[input.taskId,input.eventId]);
      if(existing){
        if(existing.payload!==payloadHash || existing.actor!==input.agentId || existing.expected_revision!==input.expectedRevision)throw new Error('idempotency_conflict');
        await this.db!.exec('COMMIT');return this.workTaskRow(row);
      }
      if(row.revision!==input.expectedRevision)throw new Error('stale_task_revision');
      if(row.status==='claimed'&&(!input.leaseToken||row.claim_token!==input.leaseToken||row.lease_until<now))throw new Error('stale_task_lease');
      if(input.status==='completed'&&row.status!=='submitted')throw new Error('Only submitted work may be accepted as completed');
      if(input.status==='submitted'&&row.status!=='claimed')throw new Error('Only claimed work may be submitted');
      await this.db!.run('UPDATE work_tasks SET status=?,revision=revision+1,updated_at=?,lease_until=NULL,claim_token=NULL,result_refs=COALESCE(?,result_refs),blockers=COALESCE(?,blockers) WHERE id=?',[input.status,now,resultRefs,blockers,input.taskId]);
      await this.db!.run('INSERT INTO work_task_events(id,task_id,actor,event_id,expected_revision,transition,reason,payload,ts) VALUES (?,?,?,?,?,?,?,?,?)',[crypto.randomUUID(),input.taskId,input.agentId,input.eventId,input.expectedRevision,input.status,input.reason,payloadHash,now]);
      const next=await this.db!.get<any>('SELECT * FROM work_tasks WHERE id=?',[input.taskId]);await this.logAction({action:'work_task_'+input.status,reason:stableJSON({taskId:input.taskId,agentId:input.agentId,reason:input.reason})});await this.db!.exec('COMMIT');return this.workTaskRow(next);
    }catch(error){await this.db!.exec('ROLLBACK');throw error;}});
  }
  /** M05.b：续租必须在租约有效期内发起（过期资格失效），只延长租约不改 revision/状态。 */
  async renewWorkTaskLease(input:{taskId:string;agentId:string;leaseToken:string;leaseMs?:number;domains?:MemoryDomainRef[]}): Promise<WorkTask> {
    textField(input.agentId,'agentId',256);textField(input.leaseToken,'leaseToken',256);
    const leaseMs=Math.max(10_000,Math.min(1_800_000,Math.floor(input.leaseMs??300_000)));
    return this.withWriteLock(async()=>{await this.db!.exec('BEGIN IMMEDIATE');try{
      const now=this.now();
      const row=await this.db!.get<any>('SELECT * FROM work_tasks WHERE id=?',[input.taskId]);if(!row)throw new Error('Task not found');
      await this.readableWorkContext(row.context_id,input.domains);
      if(row.status!=='claimed'||row.claim_token!==input.leaseToken||row.lease_until<now)throw new Error('stale_task_lease');
      await this.db!.run('UPDATE work_tasks SET lease_until=?,updated_at=? WHERE id=?',[now+leaseMs,now,input.taskId]);
      await this.db!.run('INSERT INTO work_task_events(id,task_id,actor,event_id,expected_revision,transition,reason,payload,ts) VALUES (?,?,?,?,?,?,?,?,?)',[crypto.randomUUID(),input.taskId,input.agentId,`renew:${input.leaseToken}:${now}`,row.revision,'renew','lease renewed',stableJSON({leaseUntil:now+leaseMs}),now]);
      const next=await this.db!.get<any>('SELECT * FROM work_tasks WHERE id=?',[input.taskId]);await this.db!.exec('COMMIT');return this.workTaskRow(next);
    }catch(error){await this.db!.exec('ROLLBACK');throw error;}});
  }

  /** Add one independent placement without cloning the memory body. */
  async addMembership(memoryId: string, spaceId: string, memoryType: string, teamAuthorization?: string, context?: DomainReadContext): Promise<MemoryMembership> {
    const node = await this.getNodeById(memoryId, { trackAccess: false, context });
    if (!node) throw new Error('Memory not found');
    await this.assertTeamWrite(node.domain, teamAuthorization, 'membership');
    return this.withWriteLock(() => this.addMembershipLocked(memoryId, spaceId, memoryType));
  }

  private async addMembershipLocked(memoryId: string, spaceId: string, memoryType: string): Promise<MemoryMembership> {
    if (!this.db) throw new Error('Database not initialized');
    if (!spaceId.trim() || !memoryType.trim()) throw new Error('spaceId and memoryType are required');
    const existing = await this.db.get<any>(
      `SELECT * FROM memory_memberships WHERE memory_id = ? AND space_id = ? AND memory_type = ?`,
      [memoryId, spaceId, memoryType]
    );
    if (existing) return this.rowToMembership(existing);
    const now = Date.now();
    const membership: MemoryMembership = {
      id: crypto.randomUUID(), memoryId, spaceId, memoryType, active: true,
      version: 1, createdAt: now, updatedAt: now,
    };
    await this.db.run(
      `INSERT INTO memory_memberships
       (id, memory_id, space_id, memory_type, active, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
      [membership.id, memoryId, spaceId, memoryType, now, now]
    );
    await this.logAction({ action: 'membership_created', nodeId: memoryId, reason: `${spaceId}/${memoryType}` });
    return membership;
  }

  async getMemberships(memoryId: string, options: { activeOnly?: boolean } = {}): Promise<MemoryMembership[]> {
    if (!this.db) return [];
    const rows = await this.db.all<any>(
      `SELECT * FROM memory_memberships WHERE memory_id = ? ${options.activeOnly ? 'AND active = 1' : ''}
       ORDER BY created_at ASC`,
      [memoryId]
    );
    return rows.map((row: any) => this.rowToMembership(row));
  }

  /** Create/reweight an undirected association.  Both membership ids must be
   * active members of exactly the supplied space and type. */
  async upsertAssociation(
    memberAId: string, memberBId: string, spaceId: string, memoryType: string, weight = 0.5,
    basis?: AssociationBasis, teamAuthorization?: string, context?: DomainReadContext,
  ): Promise<MemoryAssociation> {
    return this.withWriteLock(async () => {
      await this.db!.exec('BEGIN IMMEDIATE');
      try {
        if (context) { await this.assertMembershipReadable(memberAId, context); await this.assertMembershipReadable(memberBId, context); }
        const domains = await this.db!.all<any>('SELECT n.domain_kind,n.domain_id FROM memory_memberships m JOIN nodes n ON n.id=m.memory_id WHERE m.id IN (?,?)',[memberAId,memberBId]);
        if (domains.length !== 2 || domains[0].domain_kind !== domains[1].domain_kind || domains[0].domain_id !== domains[1].domain_id) throw new Error('Associations cannot cross memory domains');
        await this.assertTeamWrite({kind:domains[0].domain_kind, id:domains[0].domain_id}, teamAuthorization, 'association');
        const result = await this.upsertAssociationLocked(memberAId, memberBId, spaceId, memoryType, weight, basis);
        await this.db!.exec('COMMIT'); return result;
      } catch (e) { await this.db!.exec('ROLLBACK'); throw e; }
    });
  }

  validateAssociationBasis(basis: AssociationBasis): void {
    if (!basis || typeof basis.reason !== 'string' || !basis.reason.trim() || basis.reason.length > 2000 ||
        typeof basis.context !== 'string' || !basis.context.trim() || basis.context.length > 2000)
      throw new Error('Association reason and context are required (1–2000 characters each)');
  }

  private async associationEvidence(id: string, a: string, b: string): Promise<Pick<MemoryAssociation, 'evidence' | 'evidenceStatus'>> {
    const rows = await this.db!.all<any>('SELECT payload FROM association_evidence WHERE association_id = ? ORDER BY id', [id]);
    const evidence: AssociationEvidence[] = rows.map((r: any) => JSON.parse(r.payload));
    const versions = await this.db!.all<any>('SELECT id, version FROM memory_memberships WHERE id IN (?, ?)', [a, b]);
    const current = new Map(versions.map((r: any) => [r.id, r.version]));
    return this.describeEvidence(evidence, current);
  }

  private describeEvidence(evidence: AssociationEvidence[], current: Map<unknown, unknown>): Pick<MemoryAssociation, 'evidence' | 'evidenceStatus'> {
    const active = evidence.filter(e => e.review?.decision !== 'retire');
    return { evidence, evidenceStatus: !evidence.length ? 'missing' : !active.length ? 'retired' : active.every(e => {
      const basis = e.review?.decision === 'confirm' ? e.review : e;
      return current.get(basis.memberAId) === basis.versionA && current.get(basis.memberBId) === basis.versionB;
    }) ? 'supported' : 'needs_review' };
  }

  /** Explicit host/human review; original observations remain immutable. */
  async reviewAssociationEvidence(id: string, evidenceId: string, decision: 'confirm' | 'retire', reason: string, expectedUpdatedAt?: number, teamAuthorization?: string, context?: DomainReadContext) {
    if (!['confirm', 'retire'].includes(decision) || typeof reason !== 'string' || !reason.trim() || reason.length > 2000)
      throw new Error('Review requires confirm/retire and a concrete reason (1–2000 characters)');
    return this.withWriteLock(async () => {
      await this.db!.exec('BEGIN IMMEDIATE');
      try {
        const edge = await this.db!.get<any>('SELECT * FROM memory_associations WHERE id = ?', [id]);
        const row = await this.db!.get<any>('SELECT payload FROM association_evidence WHERE association_id = ? AND id = ?', [id, evidenceId]);
        if (!edge || !row) throw new Error('Association evidence not found');
        if (context) { await this.assertMembershipReadable(edge.member_a_id, context); await this.assertMembershipReadable(edge.member_b_id, context); }
        const endpoint = await this.db!.get<any>('SELECT n.domain_kind,n.domain_id FROM memory_memberships m JOIN nodes n ON n.id=m.memory_id WHERE m.id=?',[edge.member_a_id]);
        if (!endpoint) throw new Error('Association endpoint is missing');
        await this.assertTeamWrite({kind:endpoint.domain_kind,id:endpoint.domain_id}, teamAuthorization, 'association');
        if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== edge.updated_at) throw new Error('stale_snapshot: association changed');
        const members = await this.db!.all<any>('SELECT id, version FROM memory_memberships WHERE id IN (?, ?) AND active = 1', [edge.member_a_id, edge.member_b_id]);
        if (members.length !== 2) throw new Error('Association endpoints are inactive');
        const versions = new Map(members.map((m: any) => [m.id, m.version]));
        const evidence: AssociationEvidence = JSON.parse(row.payload);
        const now = Math.max(Date.now(), edge.updated_at + 1);
        evidence.review = { decision, reason: reason.trim(), at: now, memberAId: edge.member_a_id, memberBId: edge.member_b_id,
          versionA: versions.get(edge.member_a_id) as number, versionB: versions.get(edge.member_b_id) as number };
        await this.db!.run('UPDATE association_evidence SET payload = ? WHERE association_id = ? AND id = ?', [JSON.stringify(evidence), id, evidenceId]);
        await this.db!.run('UPDATE memory_associations SET updated_at = ? WHERE id = ?', [now, id]);
        await this.logAction({ action: 'association_evidence_reviewed', edgeId: id, reason: JSON.stringify({ evidenceId, previous: JSON.parse(row.payload), review: evidence.review }) });
        const result = { reviewed: true, ...await this.associationEvidence(id, edge.member_a_id, edge.member_b_id) };
        await this.db!.exec('COMMIT');
        return result;
      } catch (e) { await this.db!.exec('ROLLBACK'); throw e; }
    });
  }

  private async upsertAssociationLocked(
    memberAId: string, memberBId: string, spaceId: string, memoryType: string, weight = 0.5,
    basis?: AssociationBasis,
  ): Promise<MemoryAssociation> {
    if (!this.db) throw new Error('Database not initialized');
    if (basis) this.validateAssociationBasis(basis);
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error('weight must be 0–1');
    if (memberAId === memberBId) throw new Error('Self association is not allowed');
    const [a, b] = await Promise.all([
      this.db.get<any>(`SELECT * FROM memory_memberships WHERE id = ? AND active = 1`, [memberAId]),
      this.db.get<any>(`SELECT * FROM memory_memberships WHERE id = ? AND active = 1`, [memberBId]),
    ]);
    if (!a || !b || a.space_id !== spaceId || b.space_id !== spaceId ||
      a.memory_type !== memoryType || b.memory_type !== memoryType) {
      throw new Error('Associations require two active members in the same space and memory type');
    }
    const domains = await this.db.all<any>('SELECT n.domain_kind,n.domain_id FROM memory_memberships m JOIN nodes n ON n.id=m.memory_id WHERE m.id IN (?,?)',[memberAId,memberBId]);
    if (domains.length !== 2 || domains[0].domain_kind !== domains[1].domain_kind || domains[0].domain_id !== domains[1].domain_id)
      throw new Error('Associations cannot cross memory domains');
    const [memberA, memberB] = memberAId < memberBId ? [memberAId, memberBId] : [memberBId, memberAId];
    const clamped = Math.max(0, Math.min(1, weight));
    const existing = await this.db.get<any>(
      `SELECT * FROM memory_associations WHERE space_id = ? AND memory_type = ? AND member_a_id = ? AND member_b_id = ?`,
      [spaceId, memoryType, memberA, memberB]
    );
    const now = Math.max(Date.now(), (existing?.updated_at ?? 0) + 1);
    const id = existing?.id ?? crypto.randomUUID();
    if (existing) {
      await this.db.run(`UPDATE memory_associations SET weight = ?, updated_at = ? WHERE id = ?`, [clamped, now, existing.id]);
    } else await this.db.run(
      `INSERT INTO memory_associations (id, space_id, memory_type, member_a_id, member_b_id, weight, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, spaceId, memoryType, memberA, memberB, clamped, now, now]
    );
    if (basis) {
      const source = { reason: basis.reason.trim(), context: basis.context.trim(), memberAId: memberA, memberBId: memberB,
        versionA: memberA === a.id ? a.version : b.version, versionB: memberB === b.id ? b.version : a.version };
      const evidence: AssociationEvidence = { ...source, id: crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex'), createdAt: now };
      await this.db.run('INSERT OR IGNORE INTO association_evidence (association_id, id, payload) VALUES (?, ?, ?)', [id, evidence.id, JSON.stringify(evidence)]);
    }
    await this.logAction({ action: existing ? 'association_reweighted' : 'association_created', edgeId: id,
      fromId: a.memory_id, toId: b.memory_id, weight: clamped, reason: JSON.stringify({ spaceId, memoryType, basis }) });
    return { id, spaceId, memoryType, memberAId: memberA, memberBId: memberB, weight: clamped,
      createdAt: existing?.created_at ?? now, updatedAt: now, ...await this.associationEvidence(id, memberA, memberB) };
  }

  async listSpaces(context?: DomainReadContext): Promise<any[]> {
    const readable = context ? resolveReadDomains(context) : undefined;
    if (readable && !readable.length) return [];
    const scopeWhere = readable?.map(() => '(n.domain_kind = ? AND n.domain_id = ?)').join(' OR ');
    const where = readable
      ? `WHERE (${scopeWhere}) AND (n.domain_kind != 'session' OR EXISTS (
          SELECT 1 FROM memory_domains d WHERE d.kind = 'session' AND d.id = n.domain_id AND d.status IN ('active','paused')))`
      : '';
    return this.db!.all('SELECT m.space_id AS spaceId, m.memory_type AS memoryType, SUM(m.active) AS active, COUNT(*) AS total FROM memory_memberships m JOIN nodes n ON n.id = m.memory_id ' + where + ' GROUP BY m.space_id, m.memory_type ORDER BY m.space_id, m.memory_type',
      readable?.flatMap(d => [d.kind, d.id]) ?? []);
  }

  async actionLogPage(opts: { before?: number; action?: string; nodeId?: string; limit?: number; context?: DomainReadContext }) {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.before) { where.push('id < ?'); params.push(opts.before); }
    if (opts.action) { where.push('action = ?'); params.push(opts.action); }
    if (opts.nodeId) { where.push('(node_id = ? OR from_id = ? OR to_id = ? OR reason LIKE ?)'); params.push(opts.nodeId, opts.nodeId, opts.nodeId, '%' + opts.nodeId + '%'); }
    if (opts.context) {
      // O04/T17: bounded readers see only entries inside their readable
      // domains — other scopes' content/reasons and unattributed legacy rows
      // are never surfaced. Operators (no context) keep the full audit trail.
      const readable = resolveReadDomains(opts.context);
      // Workspace ACLs are independent of memory-domain grants. Ordinary
      // memory history cannot disclose other collaboration workspaces;
      // their participants read the authenticated thread event stream.
      where.push("action NOT LIKE 'collaboration_%'");
      where.push(readable.length ? '(' + readable.map(() => '(domain_kind = ? AND domain_id = ?)').join(' OR ') + ')' : '0');
      for (const d of readable) params.push(d.kind, d.id);
    }
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const rows = await this.db!.all<any>('SELECT * FROM memory_action_log ' + (where.length ? 'WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ?', [...params, limit + 1]);
    const hasMore = rows.length > limit;
    const log = rows.slice(0, limit).map((r: any) => ({ id: r.id, ts: r.ts, action: r.action, nodeId: r.node_id, edgeId: r.edge_id, fromId: r.from_id, toId: r.to_id, weight: r.weight, reason: r.reason }));
    const actions = opts.context ? [...new Set(log.map((r:any)=>r.action))].map(action=>({action})) : await this.db!.all<any>('SELECT DISTINCT action FROM memory_action_log ORDER BY action');
    return { log, nextCursor: hasMore ? log.at(-1)?.id : null, actions: actions.map((r: any) => r.action) };
  }

  /** Forward-only cursor for the operator activity stream. Rows are never replayed
   * after a reconnect that supplies the last delivered id. */
  async actionLogAfter(afterId: number, limit = 100) {
    if (!Number.isSafeInteger(afterId) || afterId < 0) throw new Error('Invalid action cursor');
    const rows = await this.db!.all<any[]>(
      'SELECT id,ts,action,node_id AS nodeId,edge_id AS edgeId,from_id AS fromId,to_id AS toId,weight,reason FROM memory_action_log WHERE id > ? ORDER BY id ASC LIMIT ?',
      [afterId, Math.min(200, Math.max(1, limit))]);
    return rows;
  }

  async memoryEditHistory(nodeId:string,context?:DomainReadContext,limit=50) {
    if(!await this.getNodeById(nodeId,{trackAccess:false,context}))throw new MindPondError('invalid_input','Memory not found');
    return this.revisions.history(nodeId,limit);
  }

  async restoreMemoryEdit(nodeId:string,options:{revisionId:string;expectedUpdatedAt:number;reason:string;teamAuthorization?:string;context?:DomainReadContext}) {
    textField(options.reason,'reason',2000);
    if(!Number.isInteger(options.expectedUpdatedAt))throw new MindPondError('invalid_input','expectedUpdatedAt is required');
    if(!await this.getNodeById(nodeId,{trackAccess:false,context:options.context}))throw new MindPondError('invalid_input','Memory not found');
    const revision=await this.revisions.get(nodeId,options.revisionId),before=revision.before.node;
    return this.editMemoryImpl(nodeId,{content:before.content,importance:before.importance,tags:JSON.parse(before.tags??'[]'),verified:!!before.verified,
      expectedUpdatedAt:options.expectedUpdatedAt,reason:options.reason,teamAuthorization:options.teamAuthorization,context:options.context},options.revisionId);
  }

  async editMemory(nodeId: string, patch: MemoryEditPatch) { return this.editMemoryImpl(nodeId,patch); }

  private async editMemoryImpl(nodeId:string,patch:MemoryEditPatch,restoreRevisionId?:string) {
    const editKey=patch.idempotencyKey ? 'edit:'+nodeId+':'+textField(patch.idempotencyKey,'idempotencyKey',256) : undefined;
    const editHash=editKey ? digest({nodeId,...patch,idempotencyKey:undefined}) : undefined;
    if(editKey) {
      // A completed edit is replayed before re-preparing anchors against a
      // potentially newer body. Authorization is still checked today.
      const current=await this.getNodeById(nodeId,{trackAccess:false,context:patch.context});
      if(!current)throw new MindPondError('scope_denied','Memory unavailable for edit receipt');
      if(current.domain.kind==='session')await this.assertSessionWritable(current.domain.id);
      await this.assertTeamWrite(current.domain,patch.teamAuthorization,'edit');
      const prior=await this.db!.get<{request_hash:string;payload:string}>('SELECT request_hash,payload FROM memory_receipts WHERE key=?',[editKey]);
      if(prior){
        if(prior.request_hash!==editHash)throw new MindPondError('idempotency_conflict','edit key reused with different payload');
        return JSON.parse(prior.payload);
      }
    }
    let prepared:Awaited<ReturnType<AnchorStore['prepare']>>|undefined;
    if(patch.anchors!==undefined || patch.dimensions!==undefined) {
      if(patch.expectedUpdatedAt===undefined)throw new Error('Anchor/dimension edits require expectedUpdatedAt');
      const current=await this.getNodeById(nodeId,{trackAccess:false,context:patch.context});
      if(!current)throw new Error('Memory not found');
      const dims=patch.dimensions===undefined?(current.dimensions??[]):normalizeDimensions(patch.dimensions,current.dimension);
      await this.assertDimensions(dims,current.dimensions);
      const placements=dimensionPlacements(await this.getMemberships(nodeId,{activeOnly:true}),dims,current.dimension,current.dimensions);
      for(const m of await this.getMemberships(nodeId,{activeOnly:true}))if(patch.replaceMembershipIds?.includes(m.id))for(const memoryType of dims)placements.push({spaceId:m.spaceId,memoryType});
      if(patch.anchors!==undefined)prepared=await this.anchors.prepare(normalizeAnchors(patch.anchors,patch.content ?? current.content,placements));
    }
    if(patch.replaceMembershipIds!==undefined && (patch.dimensions===undefined||patch.expectedUpdatedAt===undefined||!patch.reason?.trim()||!Array.isArray(patch.replaceMembershipIds)||new Set(patch.replaceMembershipIds).size!==patch.replaceMembershipIds.length||patch.replaceMembershipIds.some(id=>typeof id!=='string'||!id)))throw new Error('Explicit membership reclassification requires dimensions, version, reason and distinct membership IDs');
    if(patch.reason!==undefined)textField(patch.reason,'reason',2000);
    const newSources=patch.sourceRefs === undefined ? undefined : normalizeSources(patch.sourceRefs);
    if(newSources && patch.expectedUpdatedAt === undefined) throw new Error('Source edits require expectedUpdatedAt');
    if (patch.content !== undefined && (typeof patch.content !== 'string' || !patch.content.trim())) throw new Error('Content cannot be empty');
    if (patch.importance !== undefined && (!Number.isInteger(patch.importance) || patch.importance < 1 || patch.importance > 10)) throw new Error('Importance must be 1–10');
    const embedding = patch.content ? await getEmbeddingService().generateEmbedding(patch.content).catch(() => []) : undefined;
    const zhEmbedding = patch.content && this.zhVectorIndex && isChineseText(patch.content)
      ? await getZhEmbeddingService().generateEmbedding(patch.content).catch(() => []) : [];
    return this.withWriteLock(async () => {
      await this.db!.exec('BEGIN IMMEDIATE');
      try {
        const before = await this.getNodeById(nodeId, { trackAccess: false });
        if (!before) throw new Error('Memory not found');
        if (patch.context) await this.assertNodeInReadableDomains(before, patch.context);
        if(before.domain.kind==='session')await this.assertSessionWritable(before.domain.id);
        await this.assertTeamWrite(before.domain, patch.teamAuthorization, 'edit');
        if(editKey) {
          const prior=await this.db!.get<any>('SELECT request_hash,payload FROM memory_receipts WHERE key=?',[editKey]);
          if(prior) {
            if(prior.request_hash!==editHash)throw new MindPondError('idempotency_conflict','edit key reused with different payload');
            await this.db!.exec('COMMIT');
            return JSON.parse(prior.payload);
          }
        }
        if ((patch.expectedUpdatedAt !== undefined && patch.expectedUpdatedAt !== before.updatedAt) ||
          (patch.expectedContent !== undefined && patch.expectedContent !== before.content)) throw new Error('stale_snapshot: memory was edited; reload before saving');
        const restoring=restoreRevisionId?await this.revisions.assertRestorable(nodeId,restoreRevisionId):undefined;
        const beforeSnapshot=await this.revisions.snapshot(nodeId);
        const after = { ...before, content: patch.content ?? before.content, importance: patch.importance ?? before.importance,
          tags: patch.tags ?? before.tags, verified: patch.verified ?? before.verified, updatedAt: Math.max(Date.now(), before.updatedAt + 1) };
        await this.db!.run('UPDATE nodes SET content = ?, importance = ?, tags = ?, verified = ?, updated_at = ? WHERE id = ?',
          [after.content, after.importance, JSON.stringify(after.tags), after.verified ? 1 : 0, after.updatedAt, nodeId]);
        if(patch.dimensions!==undefined) {
          after.dimensions=normalizeDimensions(patch.dimensions,before.dimension);
          await this.assertDimensions(after.dimensions,before.dimensions);
          after.dimension=after.dimensions.includes(before.dimension as KnowledgeDimension)?before.dimension:after.dimensions[0];
          await this.db!.run('UPDATE nodes SET dimension=?,dimensions=?,primary_dimension=? WHERE id=?',[legacyDimension(after.dimension),JSON.stringify(after.dimensions),after.dimension,nodeId]);
          let placements=dimensionPlacements(await this.getMemberships(nodeId,{activeOnly:true}),after.dimensions,before.dimension,before.dimensions);
          const replacementMembers=(await this.getMemberships(nodeId,{activeOnly:true})).filter(m=>patch.replaceMembershipIds?.includes(m.id));
          if(patch.replaceMembershipIds && replacementMembers.length!==patch.replaceMembershipIds.length)throw new Error('Membership reclassification includes inactive or foreign members');
          const nextDimensions=after.dimensions;
          placements=placements.filter(p=>nextDimensions.includes(p.memoryType)||!replacementMembers.some(m=>m.spaceId===p.spaceId&&m.memoryType===p.memoryType));
          for(const m of replacementMembers){
            const profile=await this.db!.get('SELECT 1 FROM profile_records WHERE membership_id=? UNION SELECT 1 FROM profile_supports WHERE source_id=? LIMIT 1',[m.id,m.id]);
            if(profile)throw new Error('Profile memberships require organization, not direct reclassification');
            for(const memoryType of after.dimensions)placements.push({spaceId:m.spaceId,memoryType});
            if(!after.dimensions.includes(m.memoryType))await this.db!.run('UPDATE memory_memberships SET active=0,version=version+1,updated_at=? WHERE id=?',[after.updatedAt,m.id]);
          }
          for(const m of await this.getMemberships(nodeId,{activeOnly:true})) {
            if(before.dimensions?.includes(m.memoryType as KnowledgeDimension) && !after.dimensions.includes(m.memoryType as KnowledgeDimension))
              await this.db!.run('UPDATE memory_memberships SET active=0,version=version+1,updated_at=? WHERE id=?',[after.updatedAt,m.id]);
          }
          for(const p of placements) {
            const member=await this.addMembershipLocked(nodeId,p.spaceId,p.memoryType);
            if(!member.active)await this.db!.run('UPDATE memory_memberships SET active=1,version=version+1,updated_at=? WHERE id=?',[after.updatedAt,member.id]);
          }
          await this.growth.bump();
        }
        if(prepared!==undefined) {
          normalizeAnchors(prepared,after.content,await this.getMemberships(nodeId,{activeOnly:true}));
          await this.anchors.replace(nodeId,after.content,prepared);
          await this.growth.audit('anchors_updated',{count:prepared.length},nodeId);
        }
        if(newSources) {
          await this.db!.run('DELETE FROM memory_sources WHERE memory_id=?',[nodeId]);
          if(newSources.length)await this.db!.run('INSERT INTO memory_sources(memory_id,payload) VALUES (?,?)',[nodeId,stableJSON(newSources)]);
          await this.growth.audit('memory_sources_updated',{before:before.sourceRefs,after:newSources},nodeId);
          await this.growth.bump();
        }
        if(restoring) {
          await this.revisions.restoreDetails(nodeId,restoring.before,after.updatedAt);
          const previousDims:string[]=JSON.parse(restoring.before.node.dimensions??'[]');
          after.dimension=restoring.before.node.primary_dimension??(previousDims.includes(restoring.before.node.dimension)?restoring.before.node.dimension:previousDims[0]??restoring.before.node.dimension);
          after.dimensions=JSON.parse(restoring.before.node.dimensions??JSON.stringify(after.dimension==='event'?[]:[after.dimension]));
          await this.growth.bump();
        }
        if (embedding) {
          await this.db!.run('UPDATE nodes SET embedding = ?,embedding_profile=? WHERE id = ?', [embedding.length ? Buffer.from(new Float32Array(embedding).buffer) : null,legacyEmbeddingIdentity(),nodeId]);
          if (this.zhVectorIndex) {
            await this.db!.run('DELETE FROM nodes_zh WHERE id = ?', [nodeId]);
            if(zhEmbedding.length)await this.db!.run('INSERT INTO nodes_zh(id,embedding,embedding_profile) VALUES (?,?,?)',[nodeId,Buffer.from(new Float32Array(zhEmbedding).buffer),legacyZhEmbeddingIdentity()]);
          }
        }
        await this.db!.run('INSERT INTO memory_action_log (ts, action, node_id, reason) VALUES (?, ?, ?, ?)',
          [after.updatedAt, 'node_updated', nodeId, JSON.stringify({ before: { content: before.content, tags: before.tags, importance: before.importance }, after: { content: after.content, tags: after.tags, importance: after.importance },reason:patch.reason??'memory edit' })]);
        await this.db!.run("UPDATE memory_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'index_generation'");
        const revisionId=await this.revisions.record(nodeId,beforeSnapshot,patch.reason??'memory edit',restoreRevisionId);
        if(editKey)await this.db!.run('INSERT INTO memory_receipts(key,request_hash,payload) VALUES (?,?,?)',[editKey,editHash,stableJSON({updated:true,revisionId})]);
        if(restoreRevisionId)await this.db!.run('INSERT INTO memory_action_log(ts,action,node_id,reason) VALUES (?,?,?,?)',
          [after.updatedAt,'memory_edit_restored',nodeId,stableJSON({revisionId,restoresRevisionId:restoreRevisionId,reason:patch.reason})]);
        await this.db!.exec('COMMIT');
        if (embedding) {
          this.vectorIndex.remove(nodeId);
          if(embedding.length)this.vectorIndex.add({id:nodeId,vector:embedding,metadata:this.indexMetadata(after)});
          this.zhVectorIndex?.remove(nodeId);
          if(zhEmbedding.length)this.zhVectorIndex?.add({id:nodeId,vector:zhEmbedding});
          if(!embedding.length)this.scheduleEmbeddingBackfill();
          if(this.zhVectorIndex && patch.content && isChineseText(patch.content) && !zhEmbedding.length)
            this.later(() => this.backfillZhEmbeddings(), 5000);
        } else this.refreshIndexedNode(after);
        return { updated: true,revisionId };
      } catch (error) { await this.db!.exec('ROLLBACK'); throw error; }
    });
  }

  async listAssociations(memoryId?: string, options: { context?: DomainReadContext; membershipIds?: string[] } = {}): Promise<MemoryAssociation[]> {
    const readable = options.context ? resolveReadDomains(options.context) : undefined;
    if ((readable && !readable.length) || (options.membershipIds && !options.membershipIds.length)) return [];
    const where = ['x.active = 1', 'y.active = 1', 'nx.domain_kind = ny.domain_kind', 'nx.domain_id = ny.domain_id'];
    const params: unknown[] = [];
    if (memoryId) { where.push('(x.memory_id = ? OR y.memory_id = ?)'); params.push(memoryId, memoryId); }
    if (options.membershipIds) {
      const slots = options.membershipIds.map(() => '?').join(',');
      where.push(`(a.member_a_id IN (${slots}) OR a.member_b_id IN (${slots}))`);
      params.push(...options.membershipIds, ...options.membershipIds);
    }
    if (readable) for (const alias of ['nx', 'ny']) {
      where.push('(' + readable.map(() => `(${alias}.domain_kind = ? AND ${alias}.domain_id = ?)`).join(' OR ') + ')');
      where.push(`(${alias}.domain_kind != 'session' OR EXISTS (SELECT 1 FROM memory_domains d WHERE d.kind = 'session' AND d.id = ${alias}.domain_id AND d.status IN ('active','paused')))`);
      for (const domain of readable) params.push(domain.kind, domain.id);
    }
    const rows = await this.db!.all<any>(
      'SELECT a.*, x.version AS version_a, y.version AS version_b, (SELECT json_group_array(json(e.payload)) FROM association_evidence e WHERE e.association_id = a.id) AS evidence_json, nx.id AS memory_a_id, nx.content AS content_a, ny.id AS memory_b_id, ny.content AS content_b FROM memory_associations a JOIN memory_memberships x ON x.id = a.member_a_id JOIN memory_memberships y ON y.id = a.member_b_id JOIN nodes nx ON nx.id = x.memory_id JOIN nodes ny ON ny.id = y.memory_id WHERE ' + where.join(' AND '), params);
    return rows.map((r: any) => ({ id: r.id, spaceId: r.space_id, memoryType: r.memory_type,
      memberAId: r.member_a_id, memberBId: r.member_b_id, weight: r.weight, createdAt: r.created_at, updatedAt: r.updated_at,
      memoryA: { id: r.memory_a_id, content: r.content_a }, memoryB: { id: r.memory_b_id, content: r.content_b },
      ...this.describeEvidence(JSON.parse(r.evidence_json), new Map([[r.member_a_id, r.version_a], [r.member_b_id, r.version_b]])) }));
  }

  async deleteAssociation(id: string, reason = 'host-requested removal', teamAuthorization?: string, context?: DomainReadContext): Promise<boolean> {
    return this.withWriteLock(async () => {
      const row = await this.db!.get<any>('SELECT * FROM memory_associations WHERE id = ?', [id]);
      if (!row) return false;
      if (context) { await this.assertMembershipReadable(row.member_a_id, context); await this.assertMembershipReadable(row.member_b_id, context); }
      const endpoint = await this.db!.get<any>('SELECT n.domain_kind,n.domain_id FROM memory_memberships m JOIN nodes n ON n.id=m.memory_id WHERE m.id=?',[row.member_a_id]);
      if (!endpoint) throw new Error('Association endpoint is missing');
      await this.assertTeamWrite({kind:endpoint.domain_kind,id:endpoint.domain_id}, teamAuthorization, 'association');
      await this.db!.run('DELETE FROM memory_associations WHERE id = ?', [id]);
      if (id.startsWith('legacy-assoc:')) await this.db!.run('DELETE FROM edges WHERE id = ?', [id.slice(13)]);
      await this.logAction({ action: 'association_deleted', edgeId: id, weight: row.weight, reason });
      return true;
    });
  }

  /** Claim and snapshot selection happen under SQLite's writer lock. */
  async organizationCandidates(options:{domain?:MemoryDomainRef;spaceId:string;memoryType:string;query?:string;limit?:number}) {
    textField(options.spaceId,'spaceId',128);textField(options.memoryType,'memoryType',128);
    const domain=normalizeDomain(options.domain);
    const limit=options.limit ?? 8;
    if(!Number.isInteger(limit)||limit<2||limit>24)throw new Error('candidate limit must be 2–24');
    const hits=options.query ? await this.search({query:options.query,domains:[domain],spaceId:options.spaceId,memoryType:options.memoryType,limit:Math.ceil(limit/2)}) : [];
    const rows=await this.db!.all<any>("SELECT m.* FROM memory_memberships m JOIN nodes n ON n.id=m.memory_id WHERE m.space_id=? AND m.memory_type=? AND n.domain_kind=? AND n.domain_id=? AND m.active=1 AND n.layer!='L0' AND n.superseded_by IS NULL " +
      // O03/T16: cooled members are not re-surfaced while unchanged (claim filter parity).
      "AND NOT EXISTS (SELECT 1 FROM organization_cooldowns c WHERE c.membership_id = m.id AND c.cooled_until > ? AND c.policy_version = ? AND c.member_version = m.version " +
      "AND c.assoc_stamp = (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), 0) FROM memory_associations WHERE member_a_id = m.id OR member_b_id = m.id)) " +
      "ORDER BY COALESCE(m.last_reviewed_at,0),m.updated_at,m.id LIMIT ?",[options.spaceId,options.memoryType,domain.kind,domain.id,this.now(),ORGANIZATION_POLICY_VERSION,limit]);
    const ids=[...new Set([...hits.map(h=>h.membershipPath?.at(-1)).filter((id):id is string=>!!id),...rows.map((r:any)=>r.id)])].slice(0,limit);
    const candidates=[];
    for(const id of ids){const m=await this.db!.get<any>('SELECT * FROM memory_memberships WHERE id=?',[id]);if(m)candidates.push({membership:this.rowToMembership(m),memory:await this.getNodeById(m.memory_id,{trackAccess:false}),freshness:await this.growth.freshness(id),classes:[] as string[]});}
    // O03: cheap pre-LLM eligibility labels — why each candidate surfaced.
    const assocCount=new Map<string,number>();
    for(const a of await this.listAssociations(undefined,{membershipIds:ids})){assocCount.set(a.memberAId,(assocCount.get(a.memberAId)??0)+1);assocCount.set(a.memberBId,(assocCount.get(a.memberBId)??0)+1);}
    const terms=(body:string)=>new Set((String(body).normalize('NFKC').toLowerCase().match(/[a-z0-9_]{3,}|[\p{Script=Han}]{2}/gu)??[]));
    const candTerms=new Map<string,Set<string>>();
    for(const c of candidates){
      if(!assocCount.get(c.membership.id))c.classes.push('association-gap');
      if(c.freshness.status==='needs_review')c.classes.push('stale-anchor');
      if(c.memory)candTerms.set(c.membership.id,terms(c.memory.content));
    }
    for(const a of candidates)for(const b of candidates){
      if(a===b||!candTerms.has(a.membership.id)||!candTerms.has(b.membership.id))continue;
      const ta=candTerms.get(a.membership.id)!,tb=candTerms.get(b.membership.id)!;
      let overlap=0;for(const w of ta)if(tb.has(w))overlap++;
      const j=overlap/Math.max(1,Math.sqrt(ta.size*tb.size));
      if(j>=0.6){if(!a.classes.includes('duplicate'))a.classes.push('duplicate');}
      else if(j>=0.2){if(!a.classes.includes('complementary'))a.classes.push('complementary');}
    }
    return {candidates,leased:false};
  }

  async claimOrganizationJob(options: {
    domain?: MemoryDomainRef; teamAuthorization?: string; spaceId: string; memoryType: string; maxMembers?: number; leaseMs?: number; membershipIds?: string[];
  }): Promise<OrganizationJob | null> {
    return this.withWriteLock(async () => {
      if (!options.spaceId?.trim() || !options.memoryType?.trim()) throw new Error('spaceId and memoryType required');
      // A session domain must resolve against its own session id; without the
      // hint normalizeDomain rejects every session-domain claim outright.
      const domain = normalizeDomain(options.domain, options.domain?.kind === 'session' ? options.domain.id : undefined);
      // M03.b: an expired (closed or purged) session invalidates its pending
      // organization work — no new leases may be taken out against it.
      if (domain.kind === 'session') {
        const state = await this.db!.get<any>("SELECT status FROM memory_domains WHERE kind='session' AND id=?", [domain.id]);
        const tomb = await this.db!.get<any>('SELECT session_id FROM session_tombstones WHERE session_id=?', [domain.id]);
        if (tomb || (state?.status && state.status !== 'active')) return null;
      }
      const requested = options.membershipIds;
      if (requested && (requested.length < 1 || requested.length > 24 || new Set(requested).size !== requested.length ||
        requested.some(id => typeof id !== 'string'))) throw new Error('Choose 1–24 distinct memberships');
      const max = requested?.length ?? Math.min(24, Math.max(2, Math.floor(options.maxMembers ?? 8)));
      if (!Number.isFinite(max)) throw new Error('Invalid maxMembers');
      const now = this.now();
      await this.db!.exec('BEGIN IMMEDIATE');
      try {
        let rows = await this.db!.all<any>(
          "SELECT m.*, n.content AS candidate_content FROM memory_memberships m JOIN nodes n ON n.id = m.memory_id WHERE m.space_id = ? AND m.memory_type = ? AND n.domain_kind=? AND n.domain_id=? AND m.active = 1 AND n.superseded_by IS NULL AND n.layer != 'L0' " +
          (requested ? 'AND m.id IN (' + requested.map(() => '?').join(',') + ') ' : '') +
          "AND NOT EXISTS (SELECT 1 FROM organization_job_members jm JOIN organization_jobs j ON j.id = jm.job_id WHERE jm.membership_id = m.id AND j.status = 'leased' AND j.lease_expires_at >= ?) " +
          // O03/T16: no_change-cooled members whose content, associations and
          // policy versions are all unchanged stay out of rotation until the
          // cooldown expires or any version moves.
          "AND NOT EXISTS (SELECT 1 FROM organization_cooldowns c WHERE c.membership_id = m.id AND c.cooled_until > ? AND c.policy_version = ? AND c.member_version = m.version " +
          "AND c.assoc_stamp = (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), 0) FROM memory_associations WHERE member_a_id = m.id OR member_b_id = m.id)) " +
          "ORDER BY COALESCE(m.last_reviewed_at, 0), m.updated_at, m.id LIMIT ?",
          [options.spaceId, options.memoryType, domain.kind, domain.id, ...(requested ?? []), now, now, ORGANIZATION_POLICY_VERSION, requested ? max : Math.min(192, max * 12)]);
        if (!requested && rows.length > max) {
          // Keep the oldest due item to avoid starvation. Similarity only orders
          // candidates; the host still decides whether to merge or associate.
          const terms = (body:string) => new Set((body.normalize('NFKC').toLowerCase().match(/[a-z0-9_]{3,}|[\p{Script=Han}]{2}/gu) ?? []));
          const first=rows[0], seed=terms(first.candidate_content);
          const rank=(row:any) => { const words=terms(row.candidate_content); let overlap=0; for(const w of words)if(seed.has(w))overlap++; return overlap/Math.max(1,Math.sqrt(seed.size*words.size)); };
          rows=[first,...rows.slice(1).map((row:any,index:number)=>({row,index,score:rank(row)})).sort((a:any,b:any)=>b.score-a.score || a.index-b.index).slice(0,max-1).map((x:any)=>x.row)];
        }
        if (requested && rows.length !== requested.length) throw new Error('Selected members are unavailable, leased, or outside this space/type');
        if (rows.length < (requested?.length===1?1:2)) { await this.db!.exec('COMMIT'); return null; }
        const members: OrganizationJob['members'] = [];
        for (const row of rows) {
          const memory = await this.getNodeById(row.memory_id, { trackAccess: false });
          if (!memory) throw new Error('Memory disappeared');
          const profileDetails = memory.profiles?.some(p => p.membershipId === row.id)
            ? await this.growth.profileGet(row.id, { limit: 100 }) : undefined;
          members.push({ membership: this.rowToMembership(row), memory: { ...memory, embedding: [] }, ...(profileDetails ? { profileDetails } : {}) });
        }
        const allAssociations = await this.listAssociations(undefined, { membershipIds: members.map(m => m.membership.id) });
        // O03/T15: material budget discipline — never truncate material to fit;
        // shrink the batch instead (8→4→2). A member whose material alone
        // exceeds the budget is skipped (segmented read required); if nothing
        // claimable fits, the claim fails explicitly as material_over_budget.
        const packChars = (ms: OrganizationJob['members'], assoc: typeof allAssociations) =>
          JSON.stringify(organizationMaterial({ members: ms, associations: assoc } as unknown as OrganizationJob)).length;
        const kept: OrganizationJob['members'] = [];
        for (const member of members) {
          const assoc = allAssociations.filter(a => [...kept, member].some(c => c.membership.id === a.memberAId || c.membership.id === a.memberBId));
          if (packChars([...kept, member], assoc) > this.materialBudgetChars) {
            if (kept.length === 0) continue; // oversized single member: leave for an explicit segmented read
            break; // would exceed: shrink here — unclaimed members stay for the next pass
          }
          kept.push(member);
        }
        if (!kept.length) throw new MindPondError('material_over_budget', 'every selected member exceeds the organization material budget', { retryable: false, nextAction: '分段读取超大成员的完整材料（memory expand），或调低 maxMembers / 调高 ORGANIZATION_MATERIAL_BUDGET_CHARS' });
        const ids = new Set(kept.map(m => m.membership.id));
        const associations = allAssociations.filter(a => ids.has(a.memberAId) || ids.has(a.memberBId));
        const job: OrganizationJob = {
          id: crypto.randomUUID(), domain, spaceId: options.spaceId, memoryType: options.memoryType,
          status: 'leased', attempts: 1, createdAt: now,
          leaseExpiresAt: now + Math.max(10_000, Math.min(1_800_000, options.leaseMs ?? 300_000)), members: kept, associations, dimensionPolicy:await this.getDimensionPolicy(), growthRevision: await this.growth.revision() };
        await this.db!.run(
          "INSERT INTO organization_jobs (id, domain_kind, domain_id, space_id, memory_type, status, created_at, updated_at, lease_expires_at, attempts) VALUES (?, ?, ?, ?, ?, 'leased', ?, ?, ?, 1)",
          [job.id, domain.kind, domain.id, job.spaceId, job.memoryType, now, now, job.leaseExpiresAt]);
        for (let i = 0; i < kept.length; i++) await this.db!.run(
          'INSERT INTO organization_job_members (job_id, membership_id, version, position) VALUES (?, ?, ?, ?)',
          [job.id, kept[i].membership.id, kept[i].membership.version, i]);
        await this.db!.run('INSERT INTO organization_payloads (job_id, snapshot) VALUES (?, ?)', [job.id, JSON.stringify(job)]);
        await this.db!.run('INSERT INTO memory_action_log (ts, action, reason) VALUES (?, ?, ?)',
          [now, 'organization_job_claimed', JSON.stringify({ jobId: job.id, domain, spaceId: job.spaceId, memoryType: job.memoryType, members: [...ids] })]);
        await this.db!.exec('COMMIT');
        return job;
      } catch (error) { await this.db!.exec('ROLLBACK'); throw error; }
    });
  }

  async getOrganizationJob(jobId: string): Promise<OrganizationJob | null> {
    const row = await this.db!.get<any>(
      'SELECT p.snapshot, j.status, j.lease_expires_at FROM organization_payloads p JOIN organization_jobs j ON j.id = p.job_id WHERE j.id = ?', [jobId]);
    return row ? { ...JSON.parse(row.snapshot), dimensionPolicy:JSON.parse(row.snapshot).dimensionPolicy??dimensionPolicy(LEGACY_DIMENSION_CONFIGURATION), domain: JSON.parse(row.snapshot).domain ?? {kind:'personal',id:'default'}, status: row.status, leaseExpiresAt: row.lease_expires_at } : null;
  }

  async releaseOrganizationJob(jobId: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this.db!.run("UPDATE organization_jobs SET lease_expires_at = 0 WHERE id = ? AND status = 'leased'", [jobId]);
      await this.logAction({ action: 'organization_job_released', reason: 'job=' + jobId });
    });
  }

  async renewOrganizationJob(jobId: string): Promise<number> {
    return this.withWriteLock(async () => {
      const expiry = this.now() + 300_000;
      // Renewal extends the lease window only — execution budgets tracked by
      // the driver are never reset by it (R02).
      const r = await this.db!.run("UPDATE organization_jobs SET lease_expires_at = ? WHERE id = ? AND status = 'leased' AND cancelled_at IS NULL AND lease_expires_at >= ?",
        [expiry, jobId, this.now()]);
      if (!r.changes) throw new Error('Job is expired or completed; claim fresh material');
      return expiry;
    });
  }

  /** R02: cancel an uncommitted organization job. Cancellation is a terminal,
   *  atomic state: after it wins the race, no plan can commit against the job;
   *  if a commit already won, the completed job and its receipt are preserved. */
  async cancelOrganizationJob(jobId: string): Promise<{ status: 'cancelled' | 'completed'; receipt?: unknown }> {
    return this.withWriteLock(async () => {
      await this.db!.exec('BEGIN IMMEDIATE');
      try {
        const row = await this.db!.get<any>('SELECT status, cancelled_at FROM organization_jobs WHERE id = ?', [jobId]);
        if (!row) throw new Error('Organization job not found');
        if (row.status === 'completed') {
          const payload = await this.db!.get<any>('SELECT receipt FROM organization_payloads WHERE job_id = ?', [jobId]);
          await this.db!.exec('COMMIT');
          return { status: 'completed' as const, ...(payload?.receipt ? { receipt: JSON.parse(payload.receipt) } : {}) };
        }
        if (!row.cancelled_at) {
          await this.db!.run("UPDATE organization_jobs SET cancelled_at = ?, updated_at = ? WHERE id = ? AND status = 'leased' AND cancelled_at IS NULL",
            [this.now(), this.now(), jobId]);
          await this.logAction({ action: 'organization_job_cancelled', reason: 'job=' + jobId });
        }
        await this.db!.exec('COMMIT');
        return { status: 'cancelled' as const };
      } catch (error) { await this.db!.exec('ROLLBACK'); throw error; }
    });
  }

  private async checkOrganizationPlan(jobId: string, plan: OrganizationPlan) {
    const job = await this.getOrganizationJob(jobId);
    if (!job || job.status !== 'leased' || !job.leaseExpiresAt || job.leaseExpiresAt < this.now())
      throw new Error('Organization job is missing, expired, or completed');
    const cancelState = await this.db!.get<any>('SELECT cancelled_at FROM organization_jobs WHERE id = ?', [jobId]);
    if (cancelState?.cancelled_at)
      throw new Error('stale_work_lease: organization job was cancelled after lease; pending plans cannot be committed');
    // T14: a legal `operations: []` is a checked no_change conclusion — the
    // batch was read and deliberately left unchanged. Only oversized plans are invalid.
    if (!plan || !Array.isArray(plan.operations) || plan.operations.length > 48)
      throw new Error('plan.operations must contain 0–48 operations (empty array = checked no_change)');
    if (job.growthRevision !== undefined && job.growthRevision !== await this.growth.revision()) throw new Error('stale_snapshot: sources or profiles changed; claim fresh material');
    if(job.dimensionPolicy?.revision!==(await this.getDimensionConfiguration()).revision)throw new Error('stale_snapshot: dimension policy changed; claim fresh material');
    const byId = new Map(job.members.map(m => [m.membership.id, m]));
    for (const { membership, memory } of job.members) {
      const current = await this.db!.get<any>('SELECT * FROM memory_memberships WHERE id = ?', [membership.id]);
      const body = await this.getNodeById(memory.id, { trackAccess: false });
      if (!current || !current.active || current.version !== membership.version || !body ||
        body.content !== memory.content || body.updatedAt!==memory.updatedAt || body.supersededBy || !sameDomain(body.domain,job.domain) ||
        current.space_id !== job.spaceId || current.memory_type !== job.memoryType)
        throw new Error('stale_snapshot: memory changed; claim fresh material');
    }
    const replaced = new Set<string>();
    for (const op of plan.operations) {
      if (!op || !['keep', 'defer', 'associate', 'consolidate', 'synthesize','reanchor'].includes(op.kind) ||
        !Array.isArray(op.membershipIds) || !op.membershipIds.length ||
        new Set(op.membershipIds).size !== op.membershipIds.length ||
        op.membershipIds.some(id => typeof id !== 'string' || !byId.has(id)))
        throw new Error('Invalid operation or membership outside issued snapshot');
      if (op.reason !== undefined && typeof op.reason !== 'string') throw new Error('reason must be text');
      if(op.kind==='reanchor' || op.kind==='consolidate' || op.kind==='synthesize') {
        if(op.kind==='reanchor' && (op.membershipIds.length!==1 || !op.reason?.trim() || !Array.isArray(op.anchors)))throw new Error('reanchor requires one member, anchors and a reason');
        const memory=byId.get(op.membershipIds[0])!.memory;
        normalizeAnchors(op.anchors,op.kind==='reanchor'?memory.content:op.content,[{spaceId:job.spaceId,memoryType:job.memoryType}]);
        if(op.kind!=='reanchor' && op.dimensions!==undefined) {
          const dimensions=normalizeDimensions(op.dimensions,memory.dimension);
          await this.assertDimensions(dimensions,memory.dimensions);
          if ((await this.getDimensionConfiguration()).definitions.some(d=>d.id===job.memoryType) && !dimensions.includes(job.memoryType as KnowledgeDimension))throw new Error('Output dimensions must retain the issued dimension');
          if(op.kind==='synthesize' && op.targetMembershipId) {
            const target=byId.get(op.targetMembershipId);
            if(target && JSON.stringify([...dimensions].sort())!==JSON.stringify([...(target.memory.dimensions??[])].sort()))throw new Error('Edit profile dimensions separately before claiming organization');
          }
        }
        const target=op.kind==='reanchor'?op.membershipIds[0]:op.kind==='synthesize'?op.targetMembershipId:undefined;
        if(op.anchors!==undefined && target && (byId.get(target)!.memory.anchors??[]).filter(a=>a.spaceId!==job.spaceId || a.memoryType!==job.memoryType).length+op.anchors.length>6)throw new Error('anchors exceed the memory-wide limit of 6');
        if(op.kind==='reanchor' && plan.operations.filter(o=>o.membershipIds.includes(op.membershipIds[0])).length!==1)throw new Error('A reanchored membership cannot appear in another operation');
      }
      if (op.kind === 'associate' && (op.membershipIds.length !== 2 || !Number.isFinite(op.weight) || op.weight < 0 || op.weight > 1))
        throw new Error('associate requires two distinct members and weight 0–1');
      if (op.kind === 'associate') this.validateAssociationBasis(op);
      if (op.kind === 'synthesize') {
        await this.growth.validateSynthesis(op, byId);
        if (op.importance !== undefined && (!Number.isInteger(op.importance) || op.importance < 1 || op.importance > 10)) throw new Error('importance must be 1–10');
        if (op.tags !== undefined && (!Array.isArray(op.tags) || op.tags.length > 16 || op.tags.some(t => typeof t !== 'string' || !t.trim() || t.length > 64))) throw new Error('Invalid profile tags');
      }
      if (op.kind === 'consolidate') {
        if (op.membershipIds.length < 2 || typeof op.content !== 'string' || !op.content.trim() || op.content.length > 100_000)
          throw new Error('consolidate requires two sources and complete content (1–100000 characters)');
        if (op.importance !== undefined && (!Number.isInteger(op.importance) || op.importance < 1 || op.importance > 10))
          throw new Error('importance must be an integer 1–10');
        if (op.tags !== undefined && (!Array.isArray(op.tags) || op.tags.some(t => typeof t !== 'string')))
          throw new Error('tags must be strings');
        if (op.membershipIds.some(id => !sameDomain(byId.get(id)!.memory.domain, job.domain)))
          throw new Error('Cannot consolidate memories from another domain');
        for (const id of op.membershipIds) {
          if (replaced.has(id)) throw new Error('A membership cannot be replaced twice');
          replaced.add(id);
        }
      }
    }
    for (const op of plan.operations) if (op.kind !== 'consolidate' && op.membershipIds.some(id => replaced.has(id)))
      throw new Error('A replaced member cannot also be kept, deferred, or associated');
    const targets = plan.operations.filter((op): op is SynthesizeOperation => op.kind === 'synthesize' && !!op.targetMembershipId).map(op => op.targetMembershipId!);
    if (new Set(targets).size !== targets.length || targets.some(id => plan.operations.some(op => op.membershipIds.includes(id)))) throw new Error('A revised profile cannot also be a source or another operation target in this plan');
    const currentAssociations = await this.listAssociations(undefined, { membershipIds: [...byId.keys()] });
    const dropped = currentAssociations.filter(a => replaced.has(a.memberAId) || replaced.has(a.memberBId));
    const before = job.associations ?? [];
    const signature = (edges: MemoryAssociation[]) => JSON.stringify(edges.map(e => [e.id, e.weight, e.updatedAt]).sort());
    if (signature(before) !== signature(currentAssociations)) throw new Error('stale_snapshot: associations changed; claim fresh material');
    return { job, replaced, dropped };
  }

  async validateOrganizationPlan(jobId: string, plan: OrganizationPlan) {
    return this.withWriteLock(async () => {
      const { job, replaced, dropped } = await this.checkOrganizationPlan(jobId, plan);
      return { valid: true, spaceId: job.spaceId, memoryType: job.memoryType,
        operations: plan.operations, replacedMembershipIds: [...replaced], removedAssociations: dropped,
        warnings: dropped.length ? ['外部关联及原始依据会迁移到新记忆并标为待复核；合并后指向自身的关联归入来源记录。权重取最大值，不累加。'] : [] };
    });
  }

  async commitOrganizationPlan(jobId: string, plan: OrganizationPlan, teamAuthorization?: string, execution?: { deadlineAt: number; signal?: AbortSignal }): Promise<{ createdMemoryIds: string[]; updatedMemoryIds?: string[] }> {
    const prepared=new Map<OrganizationOperation,Awaited<ReturnType<AnchorStore['prepare']>>>();
    const snapshot=await this.getOrganizationJob(jobId);
    if(snapshot && Array.isArray(plan?.operations))for(const op of plan.operations) {
      if((op.kind==='reanchor' || op.kind==='consolidate' || op.kind==='synthesize') && op.anchors!==undefined) {
        const content=op.kind==='reanchor'?snapshot.members.find(m=>m.membership.id===op.membershipIds[0])?.memory.content:op.content;
        if(typeof content!=='string')throw new Error('Missing anchor source content');
        prepared.set(op,await this.anchors.prepare(normalizeAnchors(op.anchors,content,[{spaceId:snapshot.spaceId,memoryType:snapshot.memoryType}])));
      }
    }
    return this.withWriteLock(async () => {
      await this.db!.exec('BEGIN IMMEDIATE');
      try {
        // M03.a: a closed or purged session invalidates outstanding
        // organization leases — commits must fail even if a lease/payload
        // technically still exists.
        const jobDomain = await this.db!.get<any>('SELECT domain_kind, domain_id, cancelled_at FROM organization_jobs WHERE id = ?', [jobId]);
        if (jobDomain?.domain_kind === 'session') await this.assertSessionWritable(jobDomain.domain_id);
        // R02/T08: a cancel that won the race before this transaction rejects
        // the commit — the cancelled job never accepts a late plan.
        if (jobDomain?.cancelled_at)
          throw new Error('stale_work_lease: organization job was cancelled; the late commit is rejected');
        const payload = await this.db!.get<any>('SELECT * FROM organization_payloads WHERE job_id = ?', [jobId]);
        if (payload?.receipt) {
          if (payload.plan !== JSON.stringify(plan)) throw new Error('Completed job cannot accept a different plan');
          await this.db!.exec('COMMIT');
          return JSON.parse(payload.receipt);
        }
        if (execution && (execution.signal?.aborted || this.now() >= execution.deadlineAt))
          throw new MindPondError('stale_lease', 'execution cancelled or deadline expired before commit', { nextAction: '释放未提交批次；查看请求进度，不重投迟到结果' });
        const { job, dropped } = await this.checkOrganizationPlan(jobId, plan);
        await this.assertTeamWrite(job.domain, teamAuthorization, 'organization');
        if(job.dimensionPolicy?.revision!==(await this.getDimensionConfiguration()).revision)throw new Error('stale_snapshot: dimension policy changed; claim fresh material');
    const byId = new Map(job.members.map(m => [m.membership.id, m]));
        const now = this.now();
        const createdMemoryIds: string[] = [];
        const updatedMemoryIds: string[] = [];
        const replacements = new Map<string, string>();
        for (const op of plan.operations) {
          if (op.kind === 'consolidate') {
            const sources = op.membershipIds.map(id => byId.get(id)!.memory);
            const memoryId = crypto.randomUUID();
            await this.db!.run(
              "INSERT INTO nodes (id, dimension, layer, content, importance, tags, domain_kind, domain_id, session_id, created_at, updated_at) VALUES (?, ?, 'L1', ?, ?, ?, ?, ?, ?, ?, ?)",
              [memoryId, legacyDimension(sources[0].dimension), op.content.trim(), op.importance ?? Math.max(...sources.map(s => s.importance)),
                JSON.stringify(op.tags ?? [...new Set(sources.flatMap(s => s.tags))]), job.domain.kind, job.domain.id, sources[0].sessionId ?? null, now, now]);
            const replacementMemberId = crypto.randomUUID();
            await this.db!.run(
              'INSERT INTO memory_memberships (id, memory_id, space_id, memory_type, active, version, created_at, updated_at, last_reviewed_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)',
              [replacementMemberId, memoryId, job.spaceId, job.memoryType, now, now, now]);
            for (const memberId of op.membershipIds) {
              replacements.set(memberId, replacementMemberId);
              await this.db!.run('UPDATE memory_memberships SET active = 0, version = version + 1, updated_at = ?, last_reviewed_at = ? WHERE id = ?', [now, now, memberId]);
              await this.db!.run("INSERT INTO edges (id, from_id, to_id, label, weight, created_at) VALUES (?, ?, ?, 'derived_from', 1, ?)",
                [crypto.randomUUID(), memoryId, byId.get(memberId)!.memory.id, now]);
            }
            const sourceRefs = normalizeSources([...new Map(sources.flatMap(source => source.sourceRefs ?? []).map(ref => [stableJSON(ref), ref])).values()]);
            if(sourceRefs.length)await this.db!.run('INSERT INTO memory_sources(memory_id,payload) VALUES (?,?)',[memoryId,stableJSON(sourceRefs)]);
            createdMemoryIds.push(memoryId);
            const dimensions=op.dimensions??sources[0].dimensions??normalizeDimensions(undefined,sources[0].dimension);
            await this.db!.run('UPDATE nodes SET dimensions=?,primary_dimension=? WHERE id=?',[JSON.stringify(dimensions),dimensions[0],memoryId]);
            for(const placement of dimensionPlacements([{spaceId:job.spaceId,memoryType:job.memoryType}],dimensions,job.memoryType))await this.addMembershipLocked(memoryId,placement.spaceId,placement.memoryType);
            if(prepared.has(op))await this.anchors.replace(memoryId,op.content.trim(),prepared.get(op)!);
          } else if (op.kind === 'synthesize') {
            const first = byId.get(op.membershipIds[0])!.memory;
            const target = op.targetMembershipId ? byId.get(op.targetMembershipId)! : undefined;
            const memoryId = target?.memory.id ?? crypto.randomUUID();
            const memberId = op.targetMembershipId ?? crypto.randomUUID();
            if (target) {
              await this.db!.run('UPDATE nodes SET content=?,embedding=NULL,tags=?,importance=?,updated_at=? WHERE id=?',
                [op.content.trim(),JSON.stringify(op.tags ?? target.memory.tags),op.importance ?? target.memory.importance,Math.max(now,target.memory.updatedAt+1),memoryId]);
              if (this.zhVectorIndex) await this.db!.run('DELETE FROM nodes_zh WHERE id=?',[memoryId]);
              updatedMemoryIds.push(memoryId);
            } else {
              await this.db!.run("INSERT INTO nodes(id,dimension,layer,content,importance,tags,source,domain_kind,domain_id,session_id,created_at,updated_at) VALUES (?,?,'L1',?,?,?,'synthesis',?,?,?,?,?)",
                [memoryId,legacyDimension(first.dimension),op.content.trim(),op.importance ?? 5,JSON.stringify(op.tags ?? []),job.domain.kind,job.domain.id,first.sessionId ?? null,now,now]);
              await this.db!.run('INSERT INTO memory_memberships(id,memory_id,space_id,memory_type,active,version,created_at,updated_at,last_reviewed_at) VALUES (?,?,?,?,1,1,?,?,?)',
                [memberId,memoryId,job.spaceId,job.memoryType,now,now,now]);
              createdMemoryIds.push(memoryId);
            }
            await this.growth.recordProfile(memberId,op,byId);
            const dimensions=op.dimensions??target?.memory.dimensions??first.dimensions??normalizeDimensions(undefined,first.dimension);
            await this.db!.run('UPDATE nodes SET dimensions=?,primary_dimension=? WHERE id=?',[JSON.stringify(dimensions),dimensions[0],memoryId]);
            if(!target)for(const placement of dimensionPlacements([{spaceId:job.spaceId,memoryType:job.memoryType}],dimensions,job.memoryType))await this.addMembershipLocked(memoryId,placement.spaceId,placement.memoryType);
            if(prepared.has(op))await this.anchors.replace(memoryId,op.content.trim(),prepared.get(op)!,{spaceId:job.spaceId,memoryType:job.memoryType});
          } else if(op.kind==='reanchor') {
            const memory=byId.get(op.membershipIds[0])!.memory;
            await this.anchors.replace(memory.id,memory.content,prepared.get(op)!,{spaceId:job.spaceId,memoryType:job.memoryType});
            await this.db!.run('UPDATE nodes SET updated_at=? WHERE id=?',[Math.max(now,memory.updatedAt+1),memory.id]);updatedMemoryIds.push(memory.id);
          } else if (op.kind === 'associate') {
            await this.upsertAssociationLocked(op.membershipIds[0], op.membershipIds[1], job.spaceId, job.memoryType, op.weight, op);
          }
          for (const id of op.membershipIds) await this.db!.run('UPDATE memory_memberships SET last_reviewed_at = ? WHERE id = ?', [now, id]);
          // M03.c: audit rows must not carry full bodies — content/profile
          // payloads are stripped so the log API can never re-serve purged text.
          const opMeta: Record<string, unknown> = { jobId, spaceId: job.spaceId, memoryType: job.memoryType };
          for (const [key, value] of Object.entries(op)) {
            if (key !== 'content' && key !== 'profile' && key!=='anchors') opMeta[key] = value;
          }
          await this.db!.run('INSERT INTO memory_action_log (ts, action, node_id, reason) VALUES (?, ?, ?, ?)',
            [now, 'organization_' + op.kind, op.kind === 'consolidate' ? createdMemoryIds.at(-1) : byId.get(op.membershipIds[0])!.memory.id,
              JSON.stringify(opMeta)]);
        }
        for (const edge of dropped) {
          const a = replacements.get(edge.memberAId) ?? edge.memberAId;
          const b = replacements.get(edge.memberBId) ?? edge.memberBId;
          if (a !== b) {
            const [left, right] = [a, b].sort();
            const existing = await this.db!.get<any>('SELECT weight FROM memory_associations WHERE member_a_id = ? AND member_b_id = ?', [left, right]);
            const carried = await this.upsertAssociationLocked(a, b, edge.spaceId, edge.memoryType, Math.max(edge.weight, existing?.weight ?? 0));
            for (const evidence of edge.evidence ?? []) await this.db!.run(
              'INSERT OR IGNORE INTO association_evidence (association_id, id, payload) VALUES (?, ?, ?)', [carried.id, evidence.id, JSON.stringify(evidence)]);
            await this.logAction({ action: 'association_carried', edgeId: carried.id,
              reason: JSON.stringify({ jobId, previousAssociation: edge, status: 'needs_review' }) });
          }
          await this.db!.run('DELETE FROM memory_associations WHERE id = ?', [edge.id]);
          if (edge.id.startsWith('legacy-assoc:')) await this.db!.run('DELETE FROM edges WHERE id = ?', [edge.id.slice(13)]);
          await this.db!.run('INSERT INTO memory_action_log (ts, action, edge_id, reason) VALUES (?, ?, ?, ?)',
            [now, 'association_deleted', edge.id, JSON.stringify({ jobId, reason: 'endpoint consolidated', ...edge })]);
        }
        const receipt = { createdMemoryIds, ...(updatedMemoryIds.length ? {updatedMemoryIds} : {}) };
        await this.db!.run("UPDATE organization_jobs SET status = 'completed', updated_at = ?, lease_expires_at = NULL WHERE id = ?", [now, jobId]);
        await this.db!.run('UPDATE organization_payloads SET plan = ?, receipt = ? WHERE job_id = ?', [JSON.stringify(plan), JSON.stringify(receipt), jobId]);
        await this.db!.run("UPDATE memory_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'index_generation'");
        await this.db!.exec('COMMIT');
        if (createdMemoryIds.length || updatedMemoryIds.length) this.scheduleEmbeddingBackfill();
        return receipt;
      } catch (error) { await this.db!.exec('ROLLBACK'); throw error; }
    });
  }

  async createEdge(fromId: string, toId: string, label: string, weight = 0.5): Promise<MemoryEdge> {
    return this.growthWrite(async () => {
    if (!this.db) throw new Error('Database not initialized');
    if (fromId === toId) throw new Error('Self-referential edges not allowed');
    if (!GraphMemory.VALID_EDGE_LABELS.has(label)) throw new Error(`Unsupported edge label: ${label}`);

    const clamped = Math.max(0, Math.min(1, weight));
    const existing = await this.db.get<any>(
      `SELECT id, created_at FROM edges WHERE from_id = ? AND to_id = ? AND label = ?`, [fromId, toId, label]
    );
    if (existing) {
      await this.db.run(`UPDATE edges SET weight = ? WHERE id = ?`, [clamped, existing.id]);
      await this.logAction({ action: 'edge_reweighted', edgeId: existing.id, fromId, toId, label, weight: clamped, reason: 'structural edge update' });
      return { id: existing.id, fromId, toId, label, weight: clamped, createdAt: existing.created_at };
    }
    const edge: MemoryEdge = { id: crypto.randomUUID(), fromId, toId, label, weight: clamped, createdAt: Date.now() };
    await this.db.run(
      `INSERT INTO edges (id, from_id, to_id, label, weight, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [edge.id, edge.fromId, edge.toId, edge.label, edge.weight, edge.createdAt]
    );
    await this.logAction({ action: 'edge_created', edgeId: edge.id, fromId, toId, label, weight: clamped });
    return edge;
    });
  }

  /**
   * Append-only audit log for ALL memory mutations (user requirement 2026-09-03:
   * "记录所有的memory操作，以后可以debug"). Never throws — logging must not
   * break the operation it records.
   */
  async logAction(entry: {
    action: string; nodeId?: string; edgeId?: string; fromId?: string; toId?: string;
    label?: string; weight?: number; reason?: string; domain?:MemoryDomainRef;
  }): Promise<void> {
    if (!this.db) return;
    try {
      // O04/T17: attribute the entry to the affected node's domain so
      // scope-filtered actionLogPage readers can trust the isolation.
      let domainKind: string | null = entry.domain?.kind ?? null;
      let domainId: string | null = entry.domain?.id ?? null;
      const refNode = entry.nodeId ?? entry.fromId ?? entry.toId;
      if (refNode) {
        const n = await this.db.get<any>('SELECT domain_kind, domain_id FROM nodes WHERE id = ?', [refNode]);
        domainKind = n?.domain_kind ?? domainKind;
        domainId = n?.domain_id ?? domainId;
      }
      await this.db.run(
        `INSERT INTO memory_action_log (ts, action, node_id, edge_id, from_id, to_id, label, weight, reason, domain_kind, domain_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [Date.now(), entry.action, entry.nodeId ?? null, entry.edgeId ?? null,
         entry.fromId ?? null, entry.toId ?? null, entry.label ?? null,
         entry.weight ?? null, entry.reason ?? null, domainKind, domainId]
      );
    } catch (err: unknown) {
      this.auditWriteFailures++;
      logger.warn(`memory_action_log write failed (audit incomplete): ${getErrorMessage(err)}`);
    }
  }

  /** Read the audit log (frontend timeline & debugging). Newest first. */
  async getActionLog(limit = 100): Promise<Array<{
    ts: number; action: string; nodeId?: string; edgeId?: string;
    fromId?: string; toId?: string; label?: string; weight?: number; reason?: string;
  }>> {
    if (!this.db) return [];
    try {
      const rows = await this.db.all(
        `SELECT ts, action, node_id, edge_id, from_id, to_id, label, weight, reason
         FROM memory_action_log ORDER BY ts DESC LIMIT ?`,
        [limit]
      );
      return rows.map((r: any) => ({
        ts: r.ts, action: r.action, nodeId: r.node_id ?? undefined,
        edgeId: r.edge_id ?? undefined, fromId: r.from_id ?? undefined,
        toId: r.to_id ?? undefined, label: r.label ?? undefined,
        weight: r.weight ?? undefined, reason: r.reason ?? undefined,
      }));
    } catch (err: unknown) {
      logger.debug(`memory_action_log read failed: ${getErrorMessage(err)}`);
      return [];
    }
  }

  // ─── Scheduler state (memory_meta KV) ─────────────────────────────────────

  async getMeta(key: string): Promise<string | null> {
    if (!this.db) return null;
    try {
      const row = await this.db.get<any>(`SELECT value FROM memory_meta WHERE key = ?`, [key]);
      return row?.value ?? null;
    } catch {
      return null; // pre-migration DB without memory_meta
    }
  }

  async setMeta(key: string, value: string): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.run(
        `INSERT INTO memory_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, value]
      );
    } catch (err: unknown) {
      logger.debug(`memory_meta write failed: ${getErrorMessage(err)}`);
    }
  }

  // ─── Durable host-driven extraction jobs ─────────────────────────────────

  /** Queue one same-scope L0 batch exactly once. Completed empty extractions
   * are deliberate outcomes, so their source rows are retained as the record
   * that this raw input has already been judged. */
  async enqueueExtractionJob(sourceIds: string[], sessionId?: string): Promise<string | null> {
    return this.withWriteLock(() => this.enqueueExtractionJobLocked(sourceIds, sessionId));
  }

  private async enqueueExtractionJobLocked(sourceIds: string[], sessionId?: string): Promise<string | null> {
    if (!this.db) throw new Error('Database not initialized');
    const ids = [...new Set(sourceIds)];
    if (ids.length === 0) return null;
    const placeholders = ids.map(() => '?').join(',');
    await this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = await this.db.all<any>(
        `SELECT id FROM nodes n
          WHERE n.id IN (${placeholders}) AND n.layer = 'L0'
            AND ((? IS NULL AND n.session_id IS NULL) OR n.session_id = ?)
            AND NOT EXISTS (SELECT 1 FROM memory_job_sources s WHERE s.node_id = n.id)
          ORDER BY n.created_at ASC`,
        [...ids, sessionId ?? null, sessionId ?? null]
      );
      if (rows.length === 0) {
        await this.db.exec('COMMIT');
        return null;
      }
      const now = Date.now();
      const id = crypto.randomUUID();
      await this.db.run(
        `INSERT INTO memory_jobs (id, kind, status, session_id, created_at, updated_at)
         VALUES (?, 'extract_l1', 'queued', ?, ?, ?)`,
        [id, sessionId ?? null, now, now]
      );
      for (let position = 0; position < rows.length; position++) {
        await this.db.run(
          `INSERT INTO memory_job_sources (job_id, node_id, position) VALUES (?, ?, ?)`,
          [id, rows[position].id, position]
        );
      }
      await this.logAction({ action: 'extraction_job_queued', reason: `job=${id} sources=${rows.length}` });
      await this.db.exec('COMMIT');
      return id;
    } catch (err) {
      await this.db.exec('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  /** Return L0 records that have never belonged to an extraction job. Used on
   * startup/recovery so a process restart cannot strand raw memory. */
  async getUnprocessedL0(limit = 20): Promise<MemoryNode[]> {
    if (!this.db) return [];
    const rows = await this.db.all<any>(
      `SELECT ${NODE_COLUMNS_NO_EMBEDDING} FROM nodes n
        WHERE n.layer = 'L0'
          AND NOT EXISTS (SELECT 1 FROM memory_job_sources s WHERE s.node_id = n.id)
        ORDER BY n.created_at ASC LIMIT ?`,
      [Math.max(1, Math.min(200, limit))]
    );
    return rows.map((row: NodeRow) => this.rowToNode(row, false));
  }

  /** Lease the oldest ready job. A lease expiry returns abandoned work to a
   * future host after crashes without allowing simultaneous commits. */
  async claimExtractionJob(leaseMs = 5 * 60_000, context?: DomainReadContext): Promise<ExtractionJob | null> {
    return this.withWriteLock(() => this.claimExtractionJobLocked(leaseMs, context));
  }

  private async claimExtractionJobLocked(leaseMs = 5 * 60_000, context?: DomainReadContext): Promise<ExtractionJob | null> {
    if (!this.db) return null;
    const now = Date.now();
    const readable = context ? (context.domains?.length === 0 ? [] : resolveReadDomains(context)) : undefined;
    const sessions = readable?.filter(d => d.kind === 'session').map(d => d.id) ?? [];
    const personal = readable?.some(d => d.kind === 'personal' && d.id === 'default') ?? false;
    const scope = readable ? ` AND (${personal ? 'session_id IS NULL' : '0'}${sessions.length ? ' OR session_id IN (' + sessions.map(() => '?').join(',') + ')' : ''})` : '';

    await this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = await this.db.get<any>(
        `SELECT id, session_id, attempts, created_at FROM memory_jobs
          WHERE kind = 'extract_l1'
            AND (status = 'queued' OR (status = 'leased' AND lease_expires_at < ?))
            AND EXISTS (SELECT 1 FROM memory_job_sources s WHERE s.job_id = memory_jobs.id)
            AND NOT EXISTS (SELECT 1 FROM memory_domains d WHERE d.kind='session' AND d.id=memory_jobs.session_id AND d.status='closed')
            ${scope}
          ORDER BY created_at ASC LIMIT 1`,
        [now, ...sessions]
      );
      if (!row) {
        await this.db.exec('COMMIT');
        return null;
      }
      await this.db.run(
        `UPDATE memory_jobs
            SET status = 'leased', lease_expires_at = ?, updated_at = ?, attempts = attempts + 1, last_error = NULL
          WHERE id = ?`,
        [now + Math.max(1_000, leaseMs), now, row.id]
      );
      const sources = await this.db.all<any>(
        `SELECT n.id, n.content FROM memory_job_sources s
          JOIN nodes n ON n.id = s.node_id
          WHERE s.job_id = ? ORDER BY s.position ASC`,
        [row.id]
      );
      await this.db.exec('COMMIT');
      return {
        id: row.id, sessionId: row.session_id ?? undefined, attempts: (row.attempts ?? 0) + 1,
        createdAt: row.created_at,
        captureContext: await this.extractionCaptureContext(row.id),
        l0Messages: sources.map((s: any) => ({ id: s.id, content: s.content })),
      };
    } catch (err) {
      await this.db.exec('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  async assertExtractionJobContext(jobId: string, context: DomainReadContext): Promise<void> {
    const row = await this.db!.get<any>('SELECT session_id FROM memory_jobs WHERE id=?', [jobId]);
    const readable = context.domains?.length === 0 ? [] : resolveReadDomains(context);
    const domain: MemoryDomainRef = row?.session_id ? {kind:'session',id:row.session_id} : {kind:'personal',id:'default'};
    if (!row || !readable.some(d => sameDomain(d, domain))) throw new MindPondError('scope_denied', 'extraction job is outside the trusted context');
    if (domain.kind === 'session') await this.assertSessionWritable(domain.id);
  }

  private async extractionCaptureContext(jobId: string): Promise<ExtractionCaptureContext | undefined> {
    const row=await this.db!.get<{payload:string}>('SELECT payload FROM memory_job_context WHERE job_id=?',[jobId]);
    return row ? JSON.parse(row.payload) : undefined;
  }

  async getLeasedExtractionJob(jobId: string): Promise<ExtractionJob | null> {
    if (!this.db) return null;
    const row = await this.db.get<any>(
      `SELECT id, session_id, attempts, created_at FROM memory_jobs
        WHERE id = ? AND kind = 'extract_l1' AND status = 'leased' AND lease_expires_at >= ?`,
      [jobId, Date.now()]
    );
    if (!row) return null;
    const sources = await this.db.all<any>(
      `SELECT n.id, n.content FROM memory_job_sources s JOIN nodes n ON n.id = s.node_id
        WHERE s.job_id = ? ORDER BY s.position ASC`, [jobId]
    );
    return {
      id: row.id, sessionId: row.session_id ?? undefined, attempts: row.attempts ?? 0,
      captureContext: await this.extractionCaptureContext(row.id),
      createdAt: row.created_at, l0Messages: sources.map((s: any) => ({ id: s.id, content: s.content })),
    };
  }

  /** Commit all extracted knowledge, provenance and the receipt together.
   * Attempt fencing rejects a late response after another worker reclaims a job. */
  async commitExtractedMemories(jobId:string, atoms:Array<{content:string;type:string;priority:number;sourceMessageIds:string[];sourceObservationIds?:string[];dimensions?:KnowledgeDimension[];anchors?:MemoryAnchor[]}>, expectedAttempt=1) {
    if(!Array.isArray(atoms)||atoms.length>64)throw new Error('Extraction supports at most 64 memories');
    for(const atom of atoms) {
      textField(atom.content,'extracted content',100000);
      if(typeof atom.type!=='string'||!atom.type.trim()||!Number.isInteger(atom.priority)||atom.priority<1||atom.priority>10)throw new Error('Invalid extraction type/priority');
      if(!Array.isArray(atom.sourceMessageIds)||!atom.sourceMessageIds.length||atom.sourceMessageIds.length>64||atom.sourceMessageIds.some(id=>!/^msg-\d+$/.test(id)))throw new Error('Each extracted memory requires actual source_message_ids');
    }
    const hash=digest(atoms),key='extraction:'+jobId;
    const prior=await this.db!.get<any>('SELECT * FROM memory_receipts WHERE key=?',[key]);
    if(prior){if(prior.request_hash!==hash)throw new Error('idempotency_conflict');return JSON.parse(prior.payload) as {atomsFound:number;atomsCreated:number;completed:boolean};}
    const captureContext=await this.extractionCaptureContext(jobId);
    const jobRow=await this.db!.get<any>('SELECT session_id FROM memory_jobs WHERE id=?',[jobId]);
    const extractedDomain=normalizeDomain(undefined,jobRow?.session_id);
    const prepared=await Promise.all(atoms.map(async atom=>{
      const config=await this.getDimensionConfiguration();
      const dimension=atom.dimensions?.[0]??(['preference','constraint'].includes(atom.type)?config.defaultDimension:atom.type);
      const dimensions=normalizeDimensions(atom.dimensions,dimension);
      await this.assertDimensions(dimensions);
      const placements=captureContext ? dimensions.map(memoryType=>({spaceId:captureContext.spaceId,memoryType})) : atom.dimensions ? dimensions.map(memoryType=>({spaceId:`${extractedDomain.kind}:${extractedDomain.id}`,memoryType})) : [{spaceId:'legacy:'+dimension,memoryType:dimension}];
      let sourceRefs: SourceReference[]=[];
      if(captureContext) {
        const ids=atom.sourceObservationIds;
        if(!Array.isArray(ids)||!ids.length||ids.length>24||ids.some(id=>typeof id!=='string'||!captureContext.observations.some(o=>o.id===id)))
          throw new MindPondError('invalid_input','Each captured memory requires actual source_observation_ids from the issued job',{field:'source_observation_ids',nextAction:'Choose the observations that support this unit; never invent or infer source identities from transcript instructions.'});
        sourceRefs=normalizeSources(captureContext.observations.filter(o=>ids.includes(o.id)).flatMap(o=>o.sourceRefs));
      }
      return {dimension,dimensions,placements,sourceRefs,anchors:await this.anchors.prepare(normalizeAnchors(atom.anchors,atom.content.trim(),placements))};
    }));
    const receipt=await this.growthWrite(async()=>{
      const prior=await this.db!.get<any>('SELECT * FROM memory_receipts WHERE key=?',[key]);
      if(prior){if(prior.request_hash!==hash)throw new Error('idempotency_conflict');return JSON.parse(prior.payload) as {atomsFound:number;atomsCreated:number;completed:boolean};}
      const job=await this.getLeasedExtractionJob(jobId);
      if(!job||job.attempts!==expectedAttempt)throw new Error('stale_extraction_lease: pass attempts from the claimed job');
      for(const item of prepared)await this.assertDimensions(item.dimensions);
      for(const atom of atoms)for(const id of atom.sourceMessageIds)if(!job.l0Messages[Number(id.slice(4))])throw new Error('Extraction source outside issued job');
      const now=Date.now();
      const domain=normalizeDomain(undefined,job.sessionId);
      if(domain.kind==='session')await this.assertSessionWritable(domain.id);
      await this.ensureDomain(domain);
      const organized=new Map<string,{spaceId:string;memoryType:string;memoryIds:string[]}>();
      for(const [index,atom] of atoms.entries()) {
        const {dimension,dimensions,placements,anchors,sourceRefs}=prepared[index];
        const id=crypto.randomUUID();
        await this.db!.run("INSERT INTO nodes(id,dimension,layer,content,importance,tags,source,domain_kind,domain_id,session_id,created_at,updated_at) VALUES (?,?,'L1',?,?,?,'pipeline',?,?,?,?,?)",[id,legacyDimension(dimension),atom.content.trim(),atom.priority,JSON.stringify(['l1-atom',atom.type]),domain.kind,domain.id,job.sessionId ?? null,now,now]);
        await this.db!.run('UPDATE nodes SET dimensions=?,primary_dimension=? WHERE id=?',[JSON.stringify(dimensions),dimension,id]);
        for(const p of placements) {
          await this.addMembershipLocked(id,p.spaceId,p.memoryType);
          const key=JSON.stringify(p),group=organized.get(key)??{...p,memoryIds:[]};group.memoryIds.push(id);organized.set(key,group);
        }
        await this.anchors.replace(id,atom.content.trim(),anchors);
        if(sourceRefs.length)await this.db!.run('INSERT INTO memory_sources(memory_id,payload) VALUES (?,?)',[id,stableJSON(sourceRefs)]);
        for(const source of new Set(atom.sourceMessageIds))await this.db!.run("INSERT INTO edges(id,from_id,to_id,label,weight,created_at) VALUES (?,?,?,'derived_from',0.8,?)",[crypto.randomUUID(),id,job.l0Messages[Number(source.slice(4))].id,now]);
        await this.growth.audit('node_created',{source:'pipeline',jobId,attempt:expectedAttempt},id);
      }
      await this.db!.run("UPDATE memory_jobs SET status='completed',lease_expires_at=NULL,updated_at=? WHERE id=?",[now,jobId]);
      for(const group of organized.values())await this.growth.checkpoint({hostId:'mindpond/extraction',runId:jobId,checkpointId:JSON.stringify([group.spaceId,group.memoryType]),domain,...group,outcome:'saved',reason:'Complete extracted knowledge awaits host organization.',requestOrganization:true});
      const result={atomsFound:atoms.length,atomsCreated:atoms.length,completed:true};
      await this.db!.run('INSERT INTO memory_receipts(key,request_hash,payload) VALUES (?,?,?)',[key,hash,stableJSON(result)]);
      await this.growth.audit('extraction_job_completed',{jobId,attempt:expectedAttempt,...result});
      await this.db!.run("UPDATE memory_meta SET value=CAST(value AS INTEGER)+1 WHERE key='index_generation'");
      return result;
    });
    if(receipt.atomsCreated)this.scheduleEmbeddingBackfill();
    return receipt;
  }

  async releaseExtractionJob(jobId: string, error: string, expectedAttempt=1): Promise<void> {
    return this.withWriteLock(() => this.releaseExtractionJobLocked(jobId, error, expectedAttempt));
  }

  private async releaseExtractionJobLocked(jobId: string, error: string, expectedAttempt:number): Promise<void> {
    if (!this.db) return;
    await this.db.run(
      `UPDATE memory_jobs SET status = 'queued', lease_expires_at = NULL, updated_at = ?, last_error = ?
        WHERE id = ? AND status = 'leased' AND attempts=? AND lease_expires_at>=?`,
      [Date.now(), error.slice(0, 500), jobId,expectedAttempt,Date.now()]
    );
    await this.logAction({ action: 'extraction_job_released', reason: `job=${jobId}: ${error.slice(0, 160)}` });
  }

  async completeExtractionJob(jobId: string): Promise<boolean> {
    return this.withWriteLock(() => this.completeExtractionJobLocked(jobId));
  }

  private async completeExtractionJobLocked(jobId: string): Promise<boolean> {
    if (!this.db) return false;
    const result = await this.db.run(
      `UPDATE memory_jobs SET status = 'completed', lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'leased'`,
      [Date.now(), jobId]
    );
    const changed = (result.changes ?? 0) > 0;
    if (changed) await this.logAction({ action: 'extraction_job_completed', reason: `job=${jobId}` });
    return changed;
  }

  /** Fetch one edge by id (edge review reads the CURRENT weight, not a batch snapshot). */
  async getEdgeById(edgeId: string): Promise<MemoryEdge | null> {
    if (!this.db) return null;
    const row = await this.db.get<any>(`SELECT * FROM edges WHERE id = ?`, [edgeId]);
    return row ? this.rowToEdge(row) : null;
  }

  /**
   * Nudge one edge's weight (nightly edge review). Audited as edge_reweighted
   * with the actual applied value.
   */
  async updateEdgeWeight(edgeId: string, weight: number, reason: string): Promise<boolean> {
    if (!this.db) return false;
    const clamped = Math.max(0, Math.min(1, weight));
    const res = await this.db.run(`UPDATE edges SET weight = ? WHERE id = ?`, [clamped, edgeId]);
    const changed = (res.changes ?? 0) > 0;
    if (changed) {
      await this.logAction({ action: 'edge_reweighted', edgeId, weight: clamped, reason });
    }
    return changed;
  }

  /**
   * Cursor-scan all edges with both endpoint contents (nightly edge review).
   * Ordered by rowid; pass the last returned rid as afterRid to continue.
   * NOTE: edge columns explicitly aliased — bare e.* would let a.id clobber e.id.
   */
  async listEdgesWithEndpoints(afterRid = 0, limit = 12): Promise<Array<{
    rid: number; edge: MemoryEdge; fromContent: string; toContent: string;
  }>> {
    if (!this.db) return [];
    const rows = await this.db.all<any>(
      `SELECT e.rowid AS rid, e.id AS edge_id, e.from_id, e.to_id, e.label, e.weight,
              e.created_at AS edge_created_at, a.content AS from_content, b.content AS to_content
         FROM edges e
         JOIN nodes a ON e.from_id = a.id
         JOIN nodes b ON e.to_id = b.id
        WHERE e.rowid > ?
        ORDER BY e.rowid ASC
        LIMIT ?`,
      [afterRid, limit]
    );
    return rows.map((r: any) => ({
      rid: r.rid,
      edge: { id: r.edge_id, fromId: r.from_id, toId: r.to_id, label: r.label, weight: r.weight, createdAt: r.edge_created_at },
      fromContent: r.from_content,
      toContent: r.to_content,
    }));
  }

  /**
   * Degree guard (user design 2026-09-03): each node holds at most
   * MAX_OUT_EDGES *associative* edges (related/similar-to/caused-by/fixes/supports).
   * Structural edges (derived_from/aggregates/distills/mentions) are exempt —
   * they are the layer skeleton and must never be evicted.
   * When full and the new edge's weight beats the weakest existing one,
   * the weakest edge is HARD-DELETED (user: "踢掉的边就是踢掉了，不用留invalid_at")
   * — the deletion is recorded in memory_action_log for audit.
   */
  private static readonly ASSOCIATIVE_LABELS = new Set(['related', 'similar-to', 'caused-by', 'fixes', 'supports']);
  private static readonly STRUCTURAL_LABELS = new Set(['derived_from', 'aggregates', 'distills', 'mentions', 'parent-of']);
  private static readonly VALID_EDGE_LABELS = new Set([
    ...GraphMemory.ASSOCIATIVE_LABELS, ...GraphMemory.STRUCTURAL_LABELS, 'contradicts',
  ]);

  private async enforceDegreeCap(fromId: string, label: string, newWeight: number): Promise<boolean> {
    if (!this.db) return true; // no DB → no guard (shouldn't happen in prod)
    if (!GraphMemory.ASSOCIATIVE_LABELS.has(label)) return true; // structural and contradiction edges bypass the cap

    const rows = await this.db.all<any>(
      `SELECT id, to_id, label, weight FROM edges
       WHERE from_id = ? AND label IN ('related','similar-to','caused-by','fixes','supports')
       ORDER BY weight ASC`,
      [fromId]
    );
    if (rows.length < this.maxOutEdges) return true;

    const weakest = rows[0];
    if (newWeight <= weakest.weight) {
      await this.logAction({
        action: 'edge_rejected', fromId, edgeId: weakest.id, toId: weakest.to_id,
        label, weight: newWeight,
        reason: `degree cap ${this.maxOutEdges} full; new weight <= weakest ${weakest.weight}`,
      });
      return false; // newcomer is weaker than everything in seat — reject
    }

    // Hard-delete the weakest edge (user rule: evicted = gone; action log is the audit trail)
    await this.db.run(`DELETE FROM edges WHERE id = ?`, [weakest.id]);
    await this.db.run(`DELETE FROM memory_associations WHERE id = ?`, [`legacy-assoc:${weakest.id}`]);
    await this.logAction({
      action: 'edge_evicted', edgeId: weakest.id, fromId, toId: weakest.to_id,
      label: weakest.label, weight: weakest.weight,
      reason: `degree cap ${this.maxOutEdges}; replaced by weight ${newWeight}`,
    });
    return true;
  }

  /**
   * Create or strengthen an edge. If the same (from, to, label) edge exists,
   * bump its weight toward 1.0 instead of replacing it (keeps stable edge id,
   * rewards repeatedly-confirmed associations — used by nightly edge weaving).
   */
  async upsertEdge(fromId: string, toId: string, label: string, weight = 0.5): Promise<MemoryEdge | null> {
    return this.growthWrite(() => this.upsertEdgeLocked(fromId, toId, label, weight));
  }

  private async upsertEdgeLocked(fromId: string, toId: string, label: string, weight = 0.5): Promise<MemoryEdge | null> {
    if (!this.db) throw new Error('Database not initialized');
    if (fromId === toId) throw new Error('Self-referential edges not allowed');
    if (!GraphMemory.VALID_EDGE_LABELS.has(label)) throw new Error(`Unsupported edge label: ${label}`);
    const clamped = Math.max(0, Math.min(1, weight));

    // Capacity check and write form one transaction. Without this, concurrent
    // hosts each observe a free slot and all insert past the degree cap.
    {
      const existing = await this.db.get<any>(
        `SELECT id, weight, created_at FROM edges WHERE from_id = ? AND to_id = ? AND label = ?`,
        [fromId, toId, label]
      );
      if (existing) {
        const next = Math.min(0.95, existing.weight + (1 - existing.weight) * clamped);
        await this.db.run(`UPDATE edges SET weight = ? WHERE id = ?`, [next, existing.id]);
        await this.syncLegacyAssociationLocked({ id: existing.id, fromId, toId, label, weight: next, createdAt: existing.created_at });
        await this.logAction({ action: 'edge_reinforced', edgeId: existing.id, fromId, toId, label, weight: next });
        return { id: existing.id, fromId, toId, label, weight: next, createdAt: existing.created_at };
      }

      if (!(await this.enforceDegreeCap(fromId, label, clamped))) {
        return null;
      }
      const edge: MemoryEdge = { id: crypto.randomUUID(), fromId, toId, label, weight: clamped, createdAt: Date.now() };
      await this.db.run(
        `INSERT INTO edges (id, from_id, to_id, label, weight, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [edge.id, edge.fromId, edge.toId, edge.label, edge.weight, edge.createdAt]
      );
      await this.syncLegacyAssociationLocked(edge);
      await this.logAction({ action: 'edge_created', edgeId: edge.id, fromId, toId, label, weight: clamped });
      return edge;
    }
  }

  /** Compatibility bridge for the pre-space upsertEdge API.  It only mirrors
   * an associative edge when both bodies share their single legacy space;
   * callers that use real spaces must use upsertAssociation explicitly. */
  private async syncLegacyAssociationLocked(edge: MemoryEdge): Promise<void> {
    if (!this.db || !GraphMemory.ASSOCIATIVE_LABELS.has(edge.label)) return;
    const ends=await this.db.all<Array<{domain_kind:string;domain_id:string}>>('SELECT domain_kind,domain_id FROM nodes WHERE id IN (?,?)',[edge.fromId,edge.toId]);
    if(ends.length!==2 || ends[0].domain_kind!==ends[1].domain_kind || ends[0].domain_id!==ends[1].domain_id)return;
    const rows = await this.db.all<any>(
      `SELECT m.id, m.space_id, m.memory_type
         FROM memory_memberships m
        WHERE m.memory_id IN (?, ?) AND m.active = 1
          AND m.space_id LIKE 'legacy:%'`,
      [edge.fromId, edge.toId]
    );
    const byScope = new Map<string, string[]>();
    for (const row of rows) {
      const key = `${row.space_id}\u0000${row.memory_type}`;
      const ids = byScope.get(key) ?? [];
      ids.push(row.id);
      byScope.set(key, ids);
    }
    for (const [key, ids] of byScope) {
      if (ids.length !== 2) continue;
      const [spaceId, memoryType] = key.split('\u0000');
      const [memberA, memberB] = ids[0] < ids[1] ? [ids[0], ids[1]] : [ids[1], ids[0]];
      await this.db.run(
        `INSERT INTO memory_associations (id, space_id, memory_type, member_a_id, member_b_id, weight, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET weight = excluded.weight, updated_at = excluded.updated_at`,
        [`legacy-assoc:${edge.id}`, spaceId, memoryType, memberA, memberB, edge.weight, edge.createdAt, Date.now()]
      );
    }
  }

  /**
   * Delete an edge (user mandate: 删除就是删除 — no tombstones).
   * The deletion lands in memory_action_log with full edge payload for audit.
   */
  async deleteEdge(edgeId: string, reason?: string, teamAuthorization?: string, context?: DomainReadContext): Promise<boolean> {
    return this.growthWrite(async () => {
    if (!this.db) throw new Error('Database not initialized');
    const row = await this.db.get<any>(`SELECT from_id, to_id, label, weight FROM edges WHERE id = ?`, [edgeId]);
    if (!row) return false;
    const source = await this.getNodeById(row.from_id, { trackAccess: false, context });
    if (!source) return false;
    if (context) await this.getNodeById(row.to_id, { trackAccess: false, context });
    await this.assertTeamWrite(source.domain, teamAuthorization, 'association');
    await this.db.run(`DELETE FROM edges WHERE id = ?`, [edgeId]);
    await this.db.run(`DELETE FROM memory_associations WHERE id = ?`, [`legacy-assoc:${edgeId}`]);
    await this.logAction({
      action: 'edge_deleted', edgeId, fromId: row.from_id, toId: row.to_id,
      label: row.label, weight: row.weight, reason,
    });
    return true;
    });
  }

  /**
   * Delete all edges with the given labels flowing out of a node — used when a
   * new fact contradicts old associations. Returns the deleted edge ids.
   */
  async deleteEdgesFrom(nodeId: string, labels: string[], reason?: string): Promise<string[]> {
    return this.growthWrite(async () => {
    if (!this.db) throw new Error('Database not initialized');
    if (labels.length === 0) return [];
    const placeholders = labels.map(() => '?').join(',');
    const rows = await this.db.all<any>(
      `SELECT id FROM edges WHERE from_id = ? AND label IN (${placeholders})`,
      [nodeId, ...labels]
    );
    for (const r of rows as Array<{ id: string }>) {
      await this.deleteEdge(r.id, reason ?? 'contradiction supersession');
    }
    return (rows as Array<{ id: string }>).map(r => r.id);
    });
  }

  /** Preserve a contradicted fact for audit while removing it from ordinary
   * recall. The caller has already obtained an LLM judgement for the relation. */
  async supersedeNode(oldNodeId: string, replacementNodeId: string): Promise<boolean> {
    return this.growthWrite(async () => {
    if (!this.db) return false;
    if (oldNodeId === replacementNodeId) return false;
    const old=await this.getNodeById(oldNodeId,{trackAccess:false}),replacement=await this.getNodeById(replacementNodeId,{trackAccess:false});
    if(!old || !replacement)return false;
    if(!sameDomain(old.domain,replacement.domain))throw new MindPondError('scope_denied','Supersession cannot cross memory domains');
    if(replacement.supersededBy)throw new MindPondError('invalid_input','Replacement must be current; supersession cycles are forbidden');
    const result = await this.db.run(
      `UPDATE nodes SET superseded_by = ?, updated_at = ? WHERE id = ?`,
      [replacementNodeId, Date.now(), oldNodeId]
    );
    const changed = (result.changes ?? 0) > 0;
    if (changed) {
      await this.db.run('UPDATE memory_memberships SET active=0,version=version+1,updated_at=? WHERE memory_id=? AND active=1',[Date.now(),oldNodeId]);
      await this.logAction({ action: 'node_superseded', nodeId: oldNodeId, toId: replacementNodeId });
      await this.bumpIndexGeneration();
    }
    return changed;
    });
  }

  /**
   * Recent nodes (L1/L2 only, L0 excluded) created after sinceMs, newest first.
   * Feeds nightly edge weaving with "what happened today" material.
   */
  async getRecentNodes(sinceMs: number, limit = 100): Promise<MemoryNode[]> {
    if (!this.db) throw new Error('Database not initialized');
    const rows = await this.db.all<any>(
      `SELECT ${NODE_COLUMNS_NO_EMBEDDING} FROM nodes
       WHERE created_at > ? AND layer IN ('L1','L2') AND superseded_by IS NULL
       ORDER BY created_at DESC LIMIT ?`,
      [sinceMs, limit]
    );
    return rows.map((r: any) => this.rowToNode(r, false));
  }

  async getNodeById(nodeId: string, opts: { trackAccess?: boolean; context?: DomainReadContext } = {}): Promise<MemoryNode | null> {
    if (!this.db) throw new Error('Database not initialized');
    const row = await this.db.get<any>(`SELECT * FROM nodes WHERE id = ?`, [nodeId]);
    if (!row) return null;

    const node:MemoryNode = { ...this.rowToNode(row, true), ...(this.growth ? await this.growth.metadata(nodeId) : {}) };
    // M02.b: bounded entries enforcing a host context reject before any
    // side effect (access tracking included).
    if (opts.context) await this.assertNodeInReadableDomains(node, opts.context);
    node.anchors=await this.anchors.list(nodeId);

    // Access tracking defaults ON for direct lookups (preserves historical
    // behavior); hot read paths (search seeds/BFS) explicitly opt out.
    // The bump intentionally leaves updated_at alone — updated_at marks
    // content changes, not reads.
    if (opts.trackAccess ?? true) {
      await this.db.run(`UPDATE nodes SET access_count = access_count + 1 WHERE id = ?`, [nodeId]);
      // Explicit expand/direct agent reads are visible too. Internal graph and
      // operator inspection paths pass trackAccess:false and stay silent.
      await this.logAction({ action: 'memory_read', nodeId, reason: stableJSON({ mode: 'expand' }) });
    }
    return node;
  }

  async deleteNode(nodeId: string, reason?: string, teamAuthorization?: string, context?: DomainReadContext): Promise<void> {
    return this.growthWrite(async () => {
    if (!this.db) throw new Error('Database not initialized');
    const node = await this.getNodeById(nodeId, { trackAccess: false });
    if (node && context) await this.assertNodeInReadableDomains(node, context);
    if (node) await this.assertTeamWrite(node.domain, teamAuthorization, 'delete');
    // ON DELETE SET NULL alone would resurrect obsolete facts. Preserve their
    // excluded state without inventing a replacement or retaining deleted text.
    const dependents=await this.db.all<Array<{id:string;domain_kind:string;domain_id:string}>>('SELECT id,domain_kind,domain_id FROM nodes WHERE superseded_by=? AND id!=?',[nodeId,nodeId]);
    for(const dependent of dependents) {
      await this.db.run('UPDATE nodes SET superseded_by=id,updated_at=? WHERE id=?',[Date.now(),dependent.id]);
      await this.db.run('UPDATE memory_memberships SET active=0,version=version+1,updated_at=? WHERE memory_id=? AND active=1',[Date.now(),dependent.id]);
      await this.logAction({action:'memory_repair_quarantined',nodeId:dependent.id,domain:{kind:dependent.domain_kind as MemoryDomainRef['kind'],id:dependent.domain_id},reason:stableJSON({reason:'replacement_deleted',previousTarget:nodeId,requiresSemanticReview:true})});
    }
    // FK CASCADE removes incident edges; log them explicitly so the audit
    // trail shows the full blast radius of the deletion.
    const edges = await this.db.all<any>(
      `SELECT id, from_id, to_id, label, weight FROM edges WHERE from_id = ? OR to_id = ?`, [nodeId, nodeId]
    );
    for (const e of edges as Array<{ id: string; from_id: string; to_id: string; label: string; weight: number }>) {
      await this.logAction({
        action: 'edge_deleted', edgeId: e.id, fromId: e.from_id, toId: e.to_id,
        label: e.label, weight: e.weight, reason: `cascade: node ${nodeId.slice(0, 8)} deleted`,
      });
    }
    await this.db.run(`DELETE FROM nodes WHERE id = ?`, [nodeId]);
    this.vectorIndex.remove(nodeId);
    if (this.zhVectorIndex) {
      this.zhVectorIndex.remove(nodeId);
      await this.db.run(`DELETE FROM nodes_zh WHERE id = ?`, [nodeId]);
    }
    await this.logAction({ action: 'node_deleted', nodeId, domain:node?.domain, reason });
    await this.bumpIndexGeneration();
    });
  }

  /** Update metadata (importance/tags/verified) in-place. No embedding regeneration. */
  async updateNodeMeta(nodeId: string, patch: { importance?: number; tags?: string[]; verified?: boolean }): Promise<boolean> {
    return this.growthWrite(async () => {
    if (!this.db) throw new Error('Database not initialized');
    const current=await this.db.get<{updated_at:number}>('SELECT updated_at FROM nodes WHERE id=?',[nodeId]);
    if(!current)return false;
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [Math.max(Date.now(),current.updated_at+1)];
    const applied: string[] = []; // audit trail records what ACTUALLY landed
    if (patch.importance !== undefined) {
      const clamped = Math.min(10, Math.max(1, Math.round(patch.importance)));
      sets.push('importance = ?');
      params.push(clamped);
      applied.push(`importance=${clamped}`);
    }
    if (patch.tags !== undefined) {
      sets.push('tags = ?');
      params.push(JSON.stringify(patch.tags));
      applied.push(`tags=[${patch.tags.join(',')}]`);
    }
    if (patch.verified !== undefined) {
      sets.push('verified = ?');
      params.push(patch.verified ? 1 : 0);
      applied.push(`verified=${patch.verified}`);
    }
    if (sets.length === 1) return false; // nothing to patch
    params.push(nodeId);
    const result = await this.db.run(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`, params as any[]);
    const changed = (result.changes ?? 0) > 0;
    if (changed) {
      await this.logAction({
        action: 'node_updated', nodeId,
        reason: `meta: ${applied.join(' ')}`,
      });
      const node = await this.getNodeById(nodeId, { trackAccess: false });
      if (node) this.refreshIndexedNode(node);
      await this.bumpIndexGeneration();
    }
    return changed;
    });
  }

  /** Update a node's content in-place. Regenerates embedding and refreshes vector index. */
  async updateNodeContent(nodeId: string, content: string, teamAuthorization?:string): Promise<void> {
    const before=await this.getNodeById(nodeId,{trackAccess:false});
    if(!before)throw new MindPondError('invalid_input','Memory not found');
    await this.editMemory(nodeId,{content,expectedUpdatedAt:before.updatedAt,reason:'legacy content rewrite',teamAuthorization});
  }

  // ============================================
  // P3: Layer queries + maintenance (consolidation support)
  // ============================================

  /** Get nodes by layer, ordered by created_at desc. Embeddings excluded. */
  async getNodesByLayer(layer: MemoryLayer, limit = 100): Promise<MemoryNode[]> {
    if (!this.db) throw new Error('Database not initialized');
    const rows = await this.db.all<any>(
      `SELECT ${NODE_COLUMNS_NO_EMBEDDING} FROM nodes WHERE layer = ? ORDER BY created_at DESC LIMIT ?`,
      [layer, limit]
    );
    return rows.map((r: any) => this.rowToNode(r, false));
  }

  /** Global nodes only. Scoped memories must not silently become one shared
   * persona merely because a background job has no session argument. */
  async getUnscopedNodesByLayer(layer: MemoryLayer, limit = 100): Promise<MemoryNode[]> {
    if (!this.db) throw new Error('Database not initialized');
    const rows = await this.db.all<any>(
      `SELECT ${NODE_COLUMNS_NO_EMBEDDING} FROM nodes
        WHERE layer = ? AND session_id IS NULL AND superseded_by IS NULL
        ORDER BY created_at DESC LIMIT ?`,
      [layer, limit]
    );
    return rows.map((row: NodeRow) => this.rowToNode(row, false));
  }

  /** Get L1 nodes created since timestamp (for L2 aggregation). */
  async getL1NodesSince(sinceMs: number, limit = 200): Promise<MemoryNode[]> {
    if (!this.db) throw new Error('Database not initialized');
    const rows = await this.db.all<any>(
      `SELECT ${NODE_COLUMNS_NO_EMBEDDING} FROM nodes WHERE layer = 'L1' AND created_at >= ? ORDER BY created_at ASC LIMIT ?`,
      [sinceMs, limit]
    );
    return rows.map((r: any) => this.rowToNode(r, false));
  }

  /** Generic paged listing with optional filters. Embeddings excluded. */
  async listNodes(opts: { layer?: MemoryLayer; dimension?: Dimension; sessionId?: string; domains?: MemoryDomainRef[]; operatorAll?: boolean; spaceId?: string; memoryType?: string; activeOnly?: boolean; limit?: number; offset?: number } = {}): Promise<{ nodes: MemoryNode[]; total: number }> {
    if (!this.db) throw new Error('Database not initialized');
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.layer) { where.push('layer = ?'); params.push(opts.layer); }
    if (opts.dimension === 'event') { where.push("dimension='event'"); }
    else if (opts.dimension) { where.push('(EXISTS (SELECT 1 FROM json_each(nodes.dimensions) WHERE value=?) OR (nodes.dimensions IS NULL AND dimension=?))'); params.push(opts.dimension,opts.dimension); }
    // M02.b: shared read-domain derivation — session entries require the
    // matching sessionId (normalizeDomain), default is personal + current
    // session. operatorAll is the human workbench whole-graph view.
    if (!opts.operatorAll) {
      const domains = resolveReadDomains({ domains: opts.domains, sessionId: opts.sessionId });
      where.push('(' + domains.map(() => "(domain_kind=? AND domain_id=? AND (domain_kind!='session' OR EXISTS (SELECT 1 FROM memory_domains d WHERE d.kind=nodes.domain_kind AND d.id=nodes.domain_id AND d.status IN ('active','paused'))))").join(' OR ') + ')');
      for (const domain of domains) params.push(domain.kind, domain.id);
    }
    if (opts.spaceId || opts.memoryType || opts.activeOnly) {
      const scope = ['m.memory_id = nodes.id'];
      if (opts.spaceId) { scope.push('m.space_id = ?'); params.push(opts.spaceId); }
      if (opts.memoryType) { scope.push('m.memory_type = ?'); params.push(opts.memoryType); }
      if (opts.activeOnly) scope.push('m.active = 1');
      where.push('EXISTS (SELECT 1 FROM memory_memberships m WHERE ' + scope.join(' AND ') + ')');
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, opts.limit ?? 50));
    const offset = Math.max(0, opts.offset ?? 0);
    const total = (await this.db.get<any>(`SELECT COUNT(*) as c FROM nodes ${whereSql}`, params as any[]))?.c ?? 0;
    const rows = await this.db.all<any>(
      `SELECT ${NODE_COLUMNS_NO_EMBEDDING} FROM nodes ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset] as any[]
    );
    const descriptors=await this.growth.metadataMany(rows.map((r:any)=>r.id));
    return { nodes: rows.map((r: any) => ({...this.rowToNode(r, false),...descriptors.get(r.id)})), total };
  }

  /**
   * Near-duplicate detection: cosine similarity over the in-memory vector index.
   * Groups of nodes with similarity >= threshold are returned; each group picks
   * a "keep" candidate (highest importance, then access count, then newest).
   * O(n·k) via index search — cheap at MindPond scale (hundreds~thousands).
   */
  async findDuplicates(threshold = 0.92): Promise<Array<{ keep: MemoryNode; duplicates: Array<{ node: MemoryNode; similarity: number }> }>> {
    if (!this.db) throw new Error('Database not initialized');
    await this.refreshIndexIfStale();
    const items = this.vectorIndex.getAll().filter(item=>!item.metadata?.supersededBy&&item.metadata?.layer!=='L0');
    const currentIds=new Set(items.map(item=>item.id));
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(x, r);
      return r;
    };
    const union = (a: string, b: string) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    };

    for (const item of items) {
      parent.set(item.id, item.id);
    }
    for (const item of items) {
      const hits = this.vectorIndex.search(item.vector, { topK: 6, minScore: threshold,
        filter:other=>currentIds.has(other.id)&&sameDomain(item.metadata!.domain,other.metadata!.domain) });
      for (const hit of hits) {
        if (hit.id !== item.id && hit.score >= threshold) union(item.id, hit.id);
      }
    }
    const byRoot = new Map<string, string[]>();
    for (const item of items) {
      const root = find(item.id);
      const arr = byRoot.get(root) ?? [];
      arr.push(item.id);
      byRoot.set(root, arr);
    }

    const out: Array<{ keep: MemoryNode; duplicates: Array<{ node: MemoryNode; similarity: number }> }> = [];
    for (const ids of byRoot.values()) {
      if (ids.length < 2) continue;
      const nodes = (await Promise.all(ids.map(id => this.getNodeById(id, { trackAccess: false })))).filter((n): n is MemoryNode => n !== null);
      if (nodes.length < 2) continue;
      nodes.sort((a, b) => (b.importance - a.importance) || (b.accessCount - a.accessCount) || (b.createdAt - a.createdAt));
      const keep = nodes[0];
      const keepVec = items.find(i => i.id === keep.id)?.vector;
      // Similarity is not transitive. A≈B and B≈C does not justify merging A
      // and C, so only return candidates that individually clear the keeper
      // threshold for an explicit caller-approved merge.
      const duplicates = nodes.slice(1).map(node => {
        const vec = items.find(i => i.id === node.id)?.vector;
        const similarity = keepVec && vec ? cosineSimilarity(keepVec, vec) : 0;
        return { node, similarity };
      }).filter(candidate => candidate.similarity >= threshold);
      if (duplicates.length > 0) out.push({ keep, duplicates });
    }
    return out;
  }

  /** Compatibility dedupe retains source bodies and evidence. Rich profile
   * integration requires a leased organization plan, never a destructive merge. */
  async mergeDuplicates(keepId: string, deleteIds: string[], reason = 'dedupe merge'): Promise<{ merged: number; edgesMoved: number }> {
    if (!this.db) throw new Error('Database not initialized');
    return this.growthWrite(async()=>{
      const keep=await this.getNodeById(keepId,{trackAccess:false});
      if(!keep || keep.supersededBy)throw new MindPondError('invalid_input','Keeper must be a current memory');
      const sources:MemoryNode[]=[];
      for(const id of [...new Set(deleteIds)].filter(id=>id!==keepId)) {
        const node=await this.getNodeById(id,{trackAccess:false});
        if(!node)continue;
        if(!sameDomain(keep.domain,node.domain))throw new MindPondError('scope_denied','dedupe merge cannot cross memory domains');
        if(node.supersededBy===keepId)continue;
        if(node.supersededBy)throw new MindPondError('invalid_input','Source is already superseded by another memory');
        sources.push(node);
      }
      // Preflight the entire input before any mutation. The legacy endpoint
      // has no team authorization argument and cannot rewrite team knowledge.
      if(keep.domain.kind==='team')throw new MindPondError('scope_denied','Team dedupe requires an authorized organization plan');
      if(keep.domain.kind==='session')await this.assertSessionWritable(keep.domain.id);
      if(!sources.length)return {merged:0,edgesMoved:0};
      if([keep,...sources].some(node=>node.profiles?.length))throw new MindPondError('invalid_input','Profile integration requires an organization synthesize plan');
      const refs=normalizeSources([...new Map([keep,...sources].flatMap(n=>n.sourceRefs??[]).map(ref=>[stableJSON(ref),ref])).values()]);
      const anchors=await this.db!.all<any[]>('SELECT * FROM memory_anchors WHERE memory_id IN ('+[keep,...sources].map(()=>'?').join(',')+')',[keepId,...sources.map(n=>n.id)]);
      const distinctAnchors=new Map<string,any>();
      for(const anchor of anchors)distinctAnchors.set(stableJSON([anchor.space_id,anchor.memory_type,anchor.text]),anchor);
      if(distinctAnchors.size>6)throw new MindPondError('invalid_input','Combined anchors exceed six; use an organization plan to select anchors');
      const memberMap=new Map<string,string>();
      for(const node of sources)for(const member of await this.getMemberships(node.id,{activeOnly:true})) {
        const target=await this.addMembershipLocked(keepId,member.spaceId,member.memoryType);
        if(!target.active)throw new MindPondError('invalid_input','Keeper has an archived placement; organize this scope explicitly');
        memberMap.set(member.id,target.id);
      }
      const associations=await this.listAssociations(undefined,{membershipIds:[...memberMap.keys()]});
      for(const edge of associations) {
        const a=memberMap.get(edge.memberAId)??edge.memberAId,b=memberMap.get(edge.memberBId)??edge.memberBId;
        if(a!==b) {
          const [left,right]=[a,b].sort();
          const previous=await this.db!.get<any>('SELECT weight FROM memory_associations WHERE member_a_id=? AND member_b_id=?',[left,right]);
          const carried=await this.upsertAssociationLocked(a,b,edge.spaceId,edge.memoryType,Math.max(edge.weight,previous?.weight??0));
          for(const evidence of edge.evidence??[])await this.db!.run('INSERT OR IGNORE INTO association_evidence(association_id,id,payload) VALUES (?,?,?)',[carried.id,evidence.id,stableJSON(evidence)]);
          await this.logAction({action:'association_carried',edgeId:carried.id,reason:stableJSON({previousAssociation:edge,status:'needs_review',reason})});
        }
        // Original endpoint/evidence rows remain attached to archived members
        // for trace and audit. Ordinary recall uses active members only.
      }
      await this.db!.run('DELETE FROM memory_sources WHERE memory_id=?',[keepId]);
      if(refs.length)await this.db!.run('INSERT INTO memory_sources(memory_id,payload) VALUES (?,?)',[keepId,stableJSON(refs)]);
      for(const anchor of distinctAnchors.values())if(anchor.memory_id!==keepId) {
        const existing=await this.db!.get('SELECT 1 FROM memory_anchors WHERE memory_id=? AND space_id=? AND memory_type=? AND text=?',[keepId,anchor.space_id,anchor.memory_type,anchor.text]);
        if(!existing)await this.db!.run(`INSERT INTO memory_anchors(id,memory_id,text,basis,space_id,memory_type,content_hash,status,embedding,embedding_model,zh_embedding,zh_model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [crypto.randomUUID(),keepId,anchor.text,anchor.basis,anchor.space_id,anchor.memory_type,crypto.createHash('sha256').update(keep.content).digest('hex'),keep.content.includes(anchor.basis)&&anchor.status==='active'?'active':'needs_review',anchor.embedding,anchor.embedding_model,anchor.zh_embedding,anchor.zh_model]);
      }
      let edgesMoved=0;
      for(const source of sources) {
        const incident=await this.db!.all<any[]>('SELECT * FROM edges WHERE from_id=? OR to_id=?',[source.id,source.id]);
        for(const edge of incident) {
          const from=edge.from_id===source.id?keepId:edge.from_id,to=edge.to_id===source.id?keepId:edge.to_id;
          if(from===to || sources.some(n=>n.id===from || n.id===to))continue;
          const previous=await this.db!.get<any>('SELECT * FROM edges WHERE from_id=? AND to_id=? AND label=?',[from,to,edge.label]);
          if(previous)await this.db!.run('UPDATE edges SET weight=MAX(weight,?) WHERE id=?',[edge.weight,previous.id]);
          else {
            if(!(await this.enforceDegreeCap(from,edge.label,edge.weight)))continue;
            await this.db!.run('INSERT INTO edges(id,from_id,to_id,label,weight,created_at) VALUES (?,?,?,?,?,?)',[crypto.randomUUID(),from,to,edge.label,edge.weight,Date.now()]);
          }
          edgesMoved++;
        }
        await this.db!.run('UPDATE memory_memberships SET active=0,version=version+1,updated_at=? WHERE memory_id=? AND active=1',[Date.now(),source.id]);
        await this.db!.run('UPDATE nodes SET superseded_by=?,updated_at=? WHERE id=?',[keepId,Date.now(),source.id]);
        await this.db!.run("INSERT INTO edges(id,from_id,to_id,label,weight,created_at) VALUES (?,?,?,'derived_from',1,?)",[crypto.randomUUID(),keepId,source.id,Date.now()]);
        await this.logAction({action:'node_deduplicated',nodeId:source.id,toId:keepId,reason});
      }
      await this.db!.run('UPDATE nodes SET dimensions=?,updated_at=? WHERE id=?',[stableJSON([...new Set([keep,...sources].flatMap(n=>n.dimensions??[]))]),Date.now(),keepId]);
      await this.bumpIndexGeneration();
      this.indexGeneration=-1;
      return {merged:sources.length,edgesMoved};
    });
  }

  /** Get node IDs already targeted by edges with given label from a source set (dedup helper). */
  async getEdgeTargets(fromIds: string[], label: string): Promise<Set<string>> {
    if (!this.db) return new Set();
    if (fromIds.length === 0) return new Set();
    const placeholders = fromIds.map(() => '?').join(',');
    const rows = await this.db.all<any>(
      `SELECT to_id FROM edges WHERE from_id IN (${placeholders}) AND label = ?`,
      [...fromIds, label]
    );
    return new Set(rows.map((r: any) => r.to_id));
  }

  /** Inverse of getEdgeTargets: structural aggregation is L1 → L2, so callers
   * asking whether an L1 atom is already grouped need edge sources. */
  async getEdgeSources(toIds: string[], label: string): Promise<Set<string>> {
    if (!this.db || toIds.length === 0) return new Set();
    const placeholders = toIds.map(() => '?').join(',');
    const rows = await this.db.all<any>(
      `SELECT from_id FROM edges WHERE to_id IN (${placeholders}) AND label = ?`,
      [...toIds, label]
    );
    return new Set(rows.map((row: any) => row.from_id));
  }

  /** Decay importance for stale nodes. Returns count of affected nodes. */
  async decayStaleNodes(olderThanMs: number, factor = 0.9, floor = 1): Promise<number> {
    return this.growthWrite(async()=>{
    if (!this.db) throw new Error('Database not initialized');
    const cutoff = Date.now() - olderThanMs;
    // Never decay L3 (persona) or high-access nodes. With an integer scale,
    // ROUND(importance * 0.9) leaves values 1–5 unchanged forever; guarantee
    // at least one-step decay whenever a stale node is eligible.
    const result = await this.db.run(
      `UPDATE nodes
          SET importance = MAX(MIN(ROUND(importance * ?), importance - 1), ?)
       WHERE created_at < ? AND layer IN ('L0','L1') AND access_count < 3 AND importance > ?`,
      [factor, floor, cutoff, floor]
    );
    const changed = result.changes || 0;
    if (changed) await this.logAction({ action: 'nodes_decayed', reason: `count=${changed} factor=${factor} floor=${floor}` });
    return changed;
    });
  }

  /** Count nodes by layer (stats for maintenance reporting). */
  async countByLayer(): Promise<Record<string, number>> {
    if (!this.db) return {};
    const rows = await this.db.all<any>(`SELECT layer, COUNT(*) as cnt FROM nodes GROUP BY layer`);
    const out: Record<string, number> = {};
    for (const r of rows) out[r.layer] = r.cnt;
    return out;
  }

  /** Archive near-forgotten L0 nodes: mark importance=0 (cold storage, no delete). */
  async archiveColdL0(olderThanMs: number, minCount = 50): Promise<number> {
    return this.growthWrite(async()=>{
    if (!this.db) throw new Error('Database not initialized');
    // Safety threshold: keep at least minCount L0 nodes active
    const { cnt } = await this.db.get<any>(`SELECT COUNT(*) as cnt FROM nodes WHERE layer = 'L0' AND importance > 0`) || { cnt: 0 };
    if (cnt <= minCount) return 0;
    const cutoff = Date.now() - olderThanMs;
    const allowance = cnt - minCount;
    const result = await this.db.run(
      `UPDATE nodes SET importance = 0
        WHERE id IN (
          SELECT id FROM nodes
           WHERE layer = 'L0' AND created_at < ? AND importance > 0 AND access_count = 0
           ORDER BY created_at ASC LIMIT ?
        )`,
      [cutoff, allowance]
    );
    const changed = result.changes || 0;
    if (changed) await this.logAction({ action: 'l0_archived', reason: `count=${changed} retain=${minCount}` });
    return changed;
    });
  }

  async clearAll(sessionId?: string): Promise<number> {
    return this.growthWrite(async()=>{
    if (!this.db) throw new Error('Database not initialized');
    if (sessionId) {
      const nodes = await this.db.all<any>(`SELECT id FROM nodes WHERE session_id = ?`, [sessionId]);
      for (const n of nodes) this.vectorIndex.remove(n.id);
      if (this.zhVectorIndex) {
        for (const n of nodes) this.zhVectorIndex.remove(n.id);
        await this.db.run(`DELETE FROM nodes_zh WHERE id IN (SELECT id FROM nodes WHERE session_id = ?)`, [sessionId]);
      }
      const result = await this.db.run(`DELETE FROM nodes WHERE session_id = ?`, [sessionId]);
      await this.bumpIndexGeneration();
      return result.changes || 0;
    }
    this.vectorIndex.clear();
    if (this.zhVectorIndex) {
      this.zhVectorIndex.clear();
      await this.db.exec(`DELETE FROM nodes_zh;`);
    }
    const result = await this.db.exec(`DELETE FROM nodes; DELETE FROM edges;`);
    await this.bumpIndexGeneration();
    return 0; // exec doesn't return changes easily
    });
  }

  // ============================================
  // Search — Hybrid: ANN + Ngram text search (always combined)
  // ============================================

  async search(query: MemoryQuery): Promise<SearchResults> {
    if (!this.db) throw new Error('Database not initialized');

    // M02.b: validate the read context up front. A session entry that does not
    // match the declared sessionId is a widening attempt and must be rejected
    // explicitly before any channel is eligible to return scoped candidates.
    this.queryDomains(query);
    this.profileRetrieval.validateSelection(query);

    await this.refreshIndexIfStale();
    const limit = Math.min(500, Math.max(1, Math.floor(query.limit || 20)));
    const minScore = query.minScore ?? this.DEFAULT_MIN_SCORE;
    const maxDepth = Math.min(5, Math.max(0, Math.floor(query.maxDepth ?? this.DEFAULT_MAX_DEPTH)));

    const retrieval:RetrievalDiagnostics={degraded:false,channels:[]};
    const delivered=(hits:SearchResult[]):SearchResults=>Object.assign(hits,{retrieval});
    // Step 1: Get seeds via hybrid search (ANN + text) or ID lookup
    let seeds: Array<{node:MemoryNode;score:number;spaceId?:string;memoryType?:string;matchedAnchors?:AnchorMatch[]}> = [];

    if (query.nodeId) {
      const node = await this.getNodeById(query.nodeId, { trackAccess: false });
      if (node && await this.isNodeReadable(node, query)) seeds.push({ node, score: 1.0 });
    } else if (query.query || query.queries?.length) {
      if (query.queries && (!Array.isArray(query.queries) || query.queries.length > 4 || query.queries.some(text => typeof text !== 'string' || !text.trim() || text.length > 10000)))
        throw new MindPondError('invalid_input', 'queries must contain at most four nonempty alternate entrances');
      const entrances = [...new Set([query.query, ...(query.queries ?? [])].filter((text): text is string => !!text))];
      const selection=await this.profileRetrieval.select(query.retrievalProfile);
      for (const entrance of entrances) seeds.push(...await this.hybridSearch(entrance, {...query, embedding: entrance === query.query ? query.embedding : undefined}, limit * 2, retrieval,selection));
    }

    seeds = seeds.filter(seed => seed.score >= minScore);
    if (seeds.length === 0) return delivered([]);

    // Step 2: each direct hit becomes an independent entry point in every
    // eligible space where it exists.  There is no implicit layer/dimension
    // multiplier: a path score is exactly the direct-hit score multiplied by
    // the association weights on that path.  Associations are unordered, so
    // retrieval naturally has the "pull one root, bring its soil" behavior.
    type RippleState = {
      node: MemoryNode; membership: MemoryMembership; score: number; depth: number;
      path: string[]; membershipPath: string[];
      dimensionBridges:NonNullable<SearchResult['dimensionBridges']>;matchedAnchors?:AnchorMatch[];
    };
    const queue = new PriorityQueue<RippleState>();
    const bestByMembership = new Map<string, number>();
    const stateKey = (memberId:string, depth:number) => `${memberId}:${depth}`;

    for (const seed of seeds) {
      const memberships = await this.getMemberships(seed.node.id, { activeOnly: true });
      for (const membership of memberships) {
        if (!this.matchesMembershipScope(membership, query)) continue;
        if(seed.spaceId!==undefined && (seed.spaceId!==membership.spaceId || seed.memoryType!==membership.memoryType))continue;
        const previous = bestByMembership.get(stateKey(membership.id, 0)) ?? -1;
        if (seed.score <= previous) continue;
        bestByMembership.set(stateKey(membership.id, 0), seed.score);
        queue.push({ node: seed.node, membership, score: seed.score, depth: 0,
          path: [seed.node.id], membershipPath: [membership.id],dimensionBridges:[],matchedAnchors:seed.matchedAnchors });
      }
    }

    // A body may have multiple independent memberships.  Collapse them only
    // for presentation, after traversal; they never allow a path to teleport
    // from one space to another.
    const bestByNode = new Map<string, SearchResult>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.score !== bestByMembership.get(stateKey(current.membership.id, current.depth))) continue;
      const rendered: SearchResult = {
        dimensionBridges:current.dimensionBridges,matchedAnchors:current.matchedAnchors,
        node: current.node, score: current.score, depth: current.depth, path: current.path,
        membershipPath: current.membershipPath, spaceId: current.membership.spaceId,
        memoryType: current.membership.memoryType,
      };
      const previous = bestByNode.get(current.node.id);
      if (!previous || rendered.score > previous.score ||
          (rendered.score === previous.score && rendered.depth < previous.depth)) {
        bestByNode.set(current.node.id, rendered);
      }
      if (current.depth >= maxDepth) continue;
      // Events are terminal evidence. Being mentioned in the same log is not
      // grounds to propagate from one piece of knowledge to another.
      if(current.node.kind==='event')continue;
      const dimensions=current.node.dimensions ?? [];
      if(dimensions.length>1 && dimensions.includes(current.membership.memoryType as KnowledgeDimension)) {
        for(const bridge of await this.getMemberships(current.node.id,{activeOnly:true})) {
          if(bridge.spaceId!==current.membership.spaceId || !dimensions.includes(bridge.memoryType as KnowledgeDimension) || !this.matchesMembershipScope(bridge,query))continue;
          if(current.score<=(bestByMembership.get(stateKey(bridge.id,current.depth)) ?? -1))continue;
          bestByMembership.set(stateKey(bridge.id,current.depth),current.score);
          queue.push({...current,membership:bridge,membershipPath:[...current.membershipPath,bridge.id],
            dimensionBridges:[...current.dimensionBridges,{memoryId:current.node.id,spaceId:bridge.spaceId,from:current.membership.memoryType,to:bridge.memoryType}]});
        }
      }

      const associations = await this.db.all<any>(
        `SELECT a.*, m.id AS neighbor_membership_id, m.memory_id AS neighbor_memory_id,
                m.space_id AS neighbor_space_id, m.memory_type AS neighbor_memory_type,
                m.active AS neighbor_active, m.version AS neighbor_version,
                m.created_at AS neighbor_membership_created_at, m.updated_at AS neighbor_membership_updated_at,
                m.last_reviewed_at AS neighbor_last_reviewed_at,
                ${NODE_COLUMNS_NO_EMBEDDING_N}
           FROM memory_associations a
           JOIN memory_memberships m ON m.id = CASE WHEN a.member_a_id = ? THEN a.member_b_id ELSE a.member_a_id END
           JOIN nodes n ON n.id = m.memory_id
          WHERE (a.member_a_id = ? OR a.member_b_id = ?) AND m.active = 1
            AND (NOT EXISTS (SELECT 1 FROM association_evidence e WHERE e.association_id = a.id)
              OR EXISTS (SELECT 1 FROM association_evidence e WHERE e.association_id = a.id AND COALESCE(json_extract(e.payload, '$.review.decision'), '') != 'retire'))
          ORDER BY a.weight DESC`,
        [current.membership.id, current.membership.id, current.membership.id]
      );
      // Private → team references are one-way and owned by the private side.
      // Readability still checks the host's explicit team set on every hop.
      if(current.node.domain.kind!=='team')associations.push(...await this.db.all<any[]>(
        `SELECT r.*,m.id AS neighbor_membership_id,m.memory_id AS neighbor_memory_id,
          m.space_id AS neighbor_space_id,m.memory_type AS neighbor_memory_type,
          m.active AS neighbor_active,m.version AS neighbor_version,m.created_at AS neighbor_membership_created_at,
          m.updated_at AS neighbor_membership_updated_at,m.last_reviewed_at AS neighbor_last_reviewed_at,
          ${NODE_COLUMNS_NO_EMBEDDING_N}
         FROM memory_team_references r JOIN memory_memberships m ON m.id=r.target_member_id JOIN nodes n ON n.id=m.memory_id
         WHERE r.source_member_id=? AND m.active=1 AND n.domain_kind='team'`,[current.membership.id]));
      for (const row of associations) {
        const neighbor = this.rowToNode(row);
        const membership = this.rowToMembership({
          id: row.neighbor_membership_id, memory_id: row.neighbor_memory_id,
          space_id: row.neighbor_space_id, memory_type: row.neighbor_memory_type,
          active: row.neighbor_active, version: row.neighbor_version,
          created_at: row.neighbor_membership_created_at, updated_at: row.neighbor_membership_updated_at,
          last_reviewed_at: row.neighbor_last_reviewed_at,
        });
        if (!await this.isNodeReadable(neighbor, query, false) || !this.matchesMembershipScope(membership, query)) continue;
        if(current.node.domain.kind==='team' && neighbor.domain.kind!=='team')continue;
        // Ordinary historical associations must obey the same domain rule as new writes.
        // Only an explicit one-way team reference may cross that boundary.
        if(!sameDomain(current.node.domain,neighbor.domain) && !row.source_member_id)continue;
        // The DB constraints and this guard make crossing dimensions/types
        // impossible even if a future migration writes a malformed row.
        if (membership.spaceId !== current.membership.spaceId || membership.memoryType !== current.membership.memoryType) continue;
        const neighborScore = current.score * row.weight;
        if (neighborScore < minScore) continue;
        const prior = bestByMembership.get(stateKey(membership.id,current.depth+1)) ?? -1;
        if (neighborScore <= prior) continue;
        bestByMembership.set(stateKey(membership.id,current.depth+1), neighborScore);
        queue.push({ node: neighbor, membership, score: neighborScore, depth: current.depth + 1,
          path: [...current.path, neighbor.id], membershipPath: [...current.membershipPath, membership.id],
          dimensionBridges:current.dimensionBridges,matchedAnchors:current.matchedAnchors });
      }
    }

    let results = [...bestByNode.values()];
    results.sort((a, b) => b.score - a.score);
    if(query.reranker&&query.query){
      const ranked=await this.profileRetrieval.rerank(query.reranker,query.query,results);
      results=ranked.items;
      retrieval.channels.push({channel:'reranker',status:ranked.status,...(ranked.status==='failed'?{code:'reranker_unavailable'}:{})});
      retrieval.degraded ||= ranked.status==='failed';
    }
    const top = results.slice(0, limit);
    const descriptors=await this.growth.metadataMany(top.map(hit=>hit.node.id));
    // Carry the original situational basis to the host, not just a score.
    for (const hit of top) {
      Object.assign(hit.node, descriptors.get(hit.node.id));
      const memberId = hit.membershipPath?.at(-1);
      if (memberId) hit.freshness = !hit.node.sourceRefs?.length && !hit.node.profiles?.some(p=>p.membershipId===memberId) ? {status:'unknown',reasons:['no_source_evidence']} : await this.growth.freshness(memberId,query.sourceContext);
      hit.associationPath = [];
      for (let i = 1; i < (hit.membershipPath?.length ?? 0); i++) {
        const [a, b] = [hit.membershipPath![i - 1], hit.membershipPath![i]].sort();
        const r = await this.db.get<any>('SELECT * FROM memory_associations WHERE member_a_id = ? AND member_b_id = ?', [a, b]);
        if (r) hit.associationPath.push({ id: r.id, spaceId: r.space_id, memoryType: r.memory_type,
          memberAId: a, memberBId: b, weight: r.weight, createdAt: r.created_at, updatedAt: r.updated_at,
          ...await this.associationEvidence(r.id, a, b) });
        else {
          const reference=await this.db.get<any>('SELECT r.*,m.space_id,m.memory_type,m.version current_source_version,t.version current_target_version FROM memory_team_references r JOIN memory_memberships m ON m.id=r.source_member_id JOIN memory_memberships t ON t.id=r.target_member_id WHERE r.source_member_id=? AND r.target_member_id=?',[hit.membershipPath![i-1],hit.membershipPath![i]]);
          if(reference)hit.associationPath.push({id:reference.id,spaceId:reference.space_id,memoryType:reference.memory_type,memberAId:reference.source_member_id,memberBId:reference.target_member_id,weight:reference.weight,createdAt:reference.created_at,updatedAt:reference.created_at,evidenceStatus:reference.source_version===reference.current_source_version && reference.target_version===reference.current_target_version?'supported':'needs_review',evidence:[{id:reference.id,reason:reference.reason,context:reference.context,createdAt:reference.created_at,memberAId:reference.source_member_id,memberBId:reference.target_member_id,versionA:reference.source_version??0,versionB:reference.target_version??0}]});
        }
      }
    }
    this.markDuplicatesWithin(top);
    return delivered(top);
  }

  retrievalCoverage(){return {indexedVectors:this.vectorIndex.getStats().totalItems,collectionCutoff:null,auditProcessWriteFailures:this.auditWriteFailures,text:this.textIndexReady?'fts5-trigram-with-complete-short-query-fallback':'paged-like',outputBounded:true};}
  async retrievalProfiles(){return this.profileRetrieval.catalog();}
  async retrievalDevices(){return this.profileRetrieval.devices();}
  async buildRetrievalProfile(profileId:string,maxItems=64){
    const result=await this.profileRetrieval.build(profileId,maxItems);
    await this.logAction({action:'embedding_profile_build',reason:JSON.stringify(result)});return result;
  }
  async activateRetrievalProfile(profileId:string){
    const result=await this.profileRetrieval.activate(profileId);
    await this.logAction({action:'embedding_profile_activated',reason:JSON.stringify(result)});
    if(profileId!=='legacy')this.scheduleProfileBuild(profileId);
    return result;
  }
  private profileBuildScheduled=new Set<string>();
  private scheduleProfileBuild(id:string){
    if(this.closing||this.profileBuildScheduled.has(id))return;
    this.profileBuildScheduled.add(id);
    this.later(async()=>{
      let maintain=true;
      try{
        maintain=(await this.profileRetrieval.startupProfiles()).includes(id);
        if(!maintain)return;
        const result=await this.profileRetrieval.build(id,64) as {completed:number;skipped:number;failures:unknown[]};
        if(result.completed||result.skipped||result.failures.length)await this.logAction({action:'embedding_profile_build',reason:JSON.stringify(result)});
      }catch{/* Discovery reports unavailable models; never block the host task. */}
      finally{this.profileBuildScheduled.delete(id);if(maintain&&!this.closing)this.scheduleProfileBuild(id);}
    },5000);
  }

  /** Workflow receipt replay still checks the current host grant and lifecycle.
   * Semantic writes recheck these inside their own transaction as well. */
  async assertMemoryWriteDomain(domain:MemoryDomainRef,context:DomainReadContext,authorization?:string,operation:'save'|'edit'='save') {
    if(!resolveReadDomains(context).some(d=>sameDomain(d,domain)))throw new MindPondError('scope_denied','Write outside current readable domains');
    if(domain.kind==='session')await this.assertSessionWritable(domain.id);
    await this.assertTeamWrite(domain,authorization,operation);
  }
  private workflow() {return new MemoryWorkflow(this,this.db!,work=>this.withWriteLock(work));}
  exportMemory(context:DomainReadContext,options?:Parameters<MemoryWorkflow['exportMarkdown']>[1]) {return this.workflow().exportMarkdown(context,options);}
  memoryDirectory(context:DomainReadContext={},limit=24) {return this.workflow().memoryDirectory(context,limit);}
  memoryHistory(nodeId:string,context:DomainReadContext={},before?:number,limit=30,includeContent=false) {return this.workflow().memoryHistory(nodeId,context,before,limit,includeContent);}
  eventRecall(query:MemoryQuery & {runId?:string;hostId?:string}) {return this.workflow().eventRecall(query);}
  finishMemoryStage(input:MemoryFinishInput) {return this.workflow().finishMemoryStage(input);}
  async taskBrief(task:string, options:Omit<MemoryQuery,'query'> & {query?:string;runId?:string;hostId?:string;sinceDimensionRevision?:number;includeDirectory?:boolean}={}) {
    textField(task,'task',1000);
    const {sinceDimensionRevision,...queryOptions}=options;
    const result=await this.recall({...queryOptions,query:options.query??task,limit:options.limit??8,
      maxDepth:options.maxDepth??2,contextBudgetBytes:options.contextBudgetBytes??12000});
    return {directory:options.includeDirectory ? await this.memoryDirectory(options,12) : undefined,recallId:result.recallId,results:result.results.map(recallEntry),contextBudget:result.contextBudget,retrieval:result.retrieval,...await this.dimensionPolicyDelta(sinceDimensionRevision)};
  }

  /** Search plus a durable, privacy-preserving recall receipt for host feedback. */
  async recall(query: MemoryQuery & { runId?: string; hostId?: string }): Promise<RecallResult> {
    validateContextBudget(query.contextBudgetBytes);
    if(query.candidateLimit!==undefined && (!Number.isInteger(query.candidateLimit)||query.candidateLimit<1||query.candidateLimit>500))throw new MindPondError('invalid_input','candidateLimit requires 1–500');
    const resultLimit=Math.min(500,Math.max(1,Math.floor(query.limit??20)));
    const exploration=query.candidateLimit??(query.contextBudgetBytes===undefined?resultLimit:Math.max(resultLimit,40));
    const candidates = await this.search({...query,limit:exploration});
    const assembled = query.contextBudgetBytes === undefined ? undefined : assembleRecall(candidates,query.contextBudgetBytes,resultLimit);
    const results = assembled?.results ?? candidates.slice(0,resultLimit);
    const recallId = crypto.randomUUID();
    const resultIds = results.map(result => ({ id: result.node.id, score: result.score, depth: result.depth,
      updatedAt:result.node.updatedAt,contentHash:digest(result.node.content) }));
    const queryHash = crypto.createHash('sha256').update(stableJSON({
      query: query.query ?? null, queries: query.queries ?? null, nodeId: query.nodeId ?? null, domains: query.domains ?? null,
      sessionId: query.sessionId ?? null, spaceId: query.spaceId ?? null, memoryType: query.memoryType ?? null,
      maxDepth: query.maxDepth ?? null, minScore: query.minScore ?? null,
    })).digest('hex');
    await this.withWriteLock(async () => {
      await this.db!.run(
        'INSERT INTO memory_recalls(id,run_id,host_id,query_hash,result_ids,created_at) VALUES (?,?,?,?,?,?)',
        [recallId, query.runId ?? null, query.hostId ?? null, queryHash, stableJSON(resultIds), Date.now()]
      );
      await this.logAction({ action: 'memory_recalled', reason: stableJSON({ recallId, runId: query.runId ?? null, resultCount: resultIds.length }) });
      // Log only delivered records, after the context budget has been applied.
      // The action log records ids and ranking metadata, never a second copy of
      // private memory text. The operator UI fetches the current node on demand.
      for (const result of results) {
        await this.logAction({ action: 'memory_read', nodeId: result.node.id, reason: stableJSON({
          recallId, runId: query.runId ?? null, depth: result.depth, score: result.score,
          path: result.path, spaceId: result.spaceId ?? null, memoryType: result.memoryType ?? null,
        }) });
      }
    });
    return { recallId, results, retrieval:candidates.retrieval, ...(assembled?{contextBudget:assembled.contextBudget}:{}) };
  }

  /** Idempotent host feedback. A conflicting re-write is rejected so an agent
   * cannot rewrite a prior adoption decision after the fact. */
  async reportRecallFeedback(input: RecallFeedbackInput, context?:DomainReadContext): Promise<{ recallId: string; recorded: number; replayed: number }> {
    return this.growthWrite(async () => { await this.authorizeRecall(input.recallId,context); return this.recordRecallFeedbackLocked(input); });
  }

  private async recordRecallFeedbackLocked(input: RecallFeedbackInput): Promise<{ recallId: string; recorded: number; replayed: number }> {
    if (!input.recallId || !Array.isArray(input.decisions) || input.decisions.length === 0 || input.decisions.length > 500) {
      throw new Error('recallId and 1..500 feedback decisions are required');
    }
    const seen = new Set<string>();
    for (const decision of input.decisions) {
      if (!decision.memoryId || seen.has(decision.memoryId) || !['used', 'rejected', 'unassessed'].includes(decision.disposition)) throw new Error('Invalid recall feedback decision');
      seen.add(decision.memoryId);
      if (decision.reason !== undefined && (typeof decision.reason !== 'string' || decision.reason.length > 2_000)) throw new Error('Invalid recall feedback reason');
    }
    const recall = await this.db!.get<any>('SELECT run_id,host_id,result_ids FROM memory_recalls WHERE id=?', [input.recallId]);
    if (!recall) throw new Error('Recall not found');
    if ((recall.run_id ?? null) !== (input.runId ?? null)) throw new Error('Recall run identity mismatch');
    if ((recall.host_id ?? null) !== (input.hostId ?? null)) throw new Error('Recall host identity mismatch');
    const returned = new Set((JSON.parse(recall.result_ids) as Array<{ id: string }>).map(entry => entry.id));
    let recorded = 0, replayed = 0;
    for (const decision of input.decisions) {
      if (!returned.has(decision.memoryId)) throw new Error('Feedback may only address a memory returned by this recall');
      const existing = await this.db!.get<any>('SELECT disposition,reason FROM memory_recall_feedback WHERE recall_id=? AND memory_id=?', [input.recallId, decision.memoryId]);
      if (existing) {
        if (existing.disposition !== decision.disposition || (existing.reason ?? null) !== (decision.reason ?? null)) throw new Error('Recall feedback conflict');
        replayed += 1;
        continue;
      }
      await this.db!.run('INSERT INTO memory_recall_feedback(recall_id,memory_id,disposition,reason,run_id,host_id,created_at) VALUES (?,?,?,?,?,?,?)',
        [input.recallId, decision.memoryId, decision.disposition, decision.reason ?? null, recall.run_id, recall.host_id, Date.now()]);
      recorded += 1;
    }
    await this.logAction({ action: 'recall_feedback_recorded', reason: stableJSON({ recallId: input.recallId, recorded, replayed }) });
    return { recallId: input.recallId, recorded, replayed };
  }

  /** One task-time call records actual use and preserves the circumstances
   * needed by a later organizer. Signals only request review: semantic edits,
   * association weights and importance never change here. */
  async reportMemoryUse(input: MemoryUseReportInput, context?:DomainReadContext) {
    textField(input.reportId, 'reportId', 256);
    textField(input.recallId, 'recallId', 256);
    textField(input.task, 'task', 1000);
    if (!['completed','partial','failed','unknown'].includes(input.outcome)) throw new Error('Invalid task outcome');
    if (!Array.isArray(input.observations) || input.observations.length > 64 ||
        !Array.isArray(input.coUses ?? []) || (input.coUses?.length ?? 0) > 24 ||
        input.observations.length + (input.coUses?.length ?? 0) === 0) throw new Error('Report requires 1..64 observations or 1..24 coUses');
    const observedIds = new Set<string>(), usedIds = new Set<string>();
    const observations = input.observations.map(item => {
      textField(item.memoryId, 'memoryId', 256);
      textField(item.reason, 'observation reason');
      if (observedIds.has(item.memoryId)) throw new Error('Duplicate memory in report');
      observedIds.add(item.memoryId);
      if (!['used','rejected','unassessed'].includes(item.disposition)) throw new Error('Invalid disposition');
      if (item.disposition === 'used') usedIds.add(item.memoryId);
      if (item.issue !== undefined && !['incorrect','outdated','incomplete','missing_anchor'].includes(item.issue)) throw new Error('Invalid issue');
      if (item.issue && !item.context) throw new Error('Issue review requires the original task context');
      if (item.context !== undefined) textField(item.context, 'observation context');
      return { ...item, sourceRefs: normalizeSources(item.sourceRefs) };
    });
    const coUses = (input.coUses ?? []).map(pair => {
      if (!Array.isArray(pair.memoryIds) || pair.memoryIds.length !== 2 || pair.memoryIds[0] === pair.memoryIds[1] ||
          pair.memoryIds.some(id => !usedIds.has(id))) throw new Error('Co-use needs two distinct memories reported used in this task');
      textField(pair.spaceId, 'coUse.spaceId', 128); textField(pair.memoryType, 'coUse.memoryType', 128);
      textField(pair.reason, 'coUse.reason'); textField(pair.context, 'coUse.context');
      return { ...pair, memoryIds: [...pair.memoryIds].sort() as [string,string] };
    });
    if (new Set(coUses.map(pair => JSON.stringify([pair.memoryIds,pair.spaceId,pair.memoryType]))).size !== coUses.length)
      throw new Error('Duplicate co-use pair');
    const normalized = { ...input, observations, coUses };
    const requestHash = digest(normalized);
    return this.growthWrite(async () => {
      await this.authorizeRecall(input.recallId,context);
      const prior = await this.db!.get<any>('SELECT request_hash,receipt FROM memory_use_reports WHERE id=?',[input.reportId]);
      if (prior) {
        if (prior.request_hash !== requestHash) throw new Error('idempotency_conflict');
        return JSON.parse(prior.receipt);
      }
      const recall = await this.db!.get<any>('SELECT run_id,host_id,result_ids FROM memory_recalls WHERE id=?',[input.recallId]);
      if (!recall) throw new Error('Recall not found');
      if ((recall.run_id ?? null) !== (input.runId ?? null) || (recall.host_id ?? null) !== (input.hostId ?? null))
        throw new Error('Recall identity mismatch');
      const returned = new Set((JSON.parse(recall.result_ids) as Array<{id:string}>).map(r=>r.id));
      for (const id of observedIds) if (!returned.has(id)) throw new Error('Report may only address returned memories');
      const signalRows: Array<{id:string;kind:'review_memory'|'review_association';domain:MemoryDomainRef;spaceId:string|null;memoryType:string|null;memoryAId:string;memoryBId:string|null;reason:string;context:string;sourceRefs:SourceReference[]}> = [];
      for (const item of observations) {
        if (!item.issue) continue;
        const node = await this.db!.get<any>('SELECT domain_kind,domain_id FROM nodes WHERE id=?',[item.memoryId]);
        if (!node) throw new Error('Memory to review no longer exists');
        signalRows.push({id:crypto.randomUUID(),kind:'review_memory',domain:{kind:node.domain_kind,id:node.domain_id},spaceId:null,memoryType:null,
          memoryAId:item.memoryId,memoryBId:null,reason:`${item.issue}: ${item.reason}`,context:item.context!,sourceRefs:item.sourceRefs});
      }
      for (const pair of coUses) {
        const rows = await this.db!.all<any>(`SELECT DISTINCT n.id,n.domain_kind,n.domain_id FROM nodes n JOIN memory_memberships m ON m.memory_id=n.id
          WHERE n.id IN (?,?) AND n.superseded_by IS NULL AND m.active=1 AND m.space_id=? AND m.memory_type=?`,
          [...pair.memoryIds,pair.spaceId,pair.memoryType]);
        if (rows.length !== 2 || rows[0].domain_kind !== rows[1].domain_kind || rows[0].domain_id !== rows[1].domain_id)
          throw new Error('Co-use pair needs one active domain/space/type; no cross-scope suggestion is recorded');
        signalRows.push({id:crypto.randomUUID(),kind:'review_association',domain:{kind:rows[0].domain_kind,id:rows[0].domain_id},
          spaceId:pair.spaceId,memoryType:pair.memoryType,memoryAId:pair.memoryIds[0],memoryBId:pair.memoryIds[1],
          reason:pair.reason,context:pair.context,sourceRefs:[]});
      }
      const feedback = observations.length ? await this.recordRecallFeedbackLocked({recallId:input.recallId,runId:input.runId,hostId:input.hostId,
        decisions:observations.map(({memoryId,disposition,reason})=>({memoryId,disposition,reason}))}) : {recallId:input.recallId,recorded:0,replayed:0};
      const now=Date.now();
      const receipt={reportId:input.reportId,recallId:input.recallId,feedback,signals:signalRows.map(({id,kind})=>({id,kind})),
        next:signalRows.length?'memory_improvement_list: review suggestions in their original domain; verify evidence before changing memory':'no memory maintenance required'};
      await this.db!.run('INSERT INTO memory_use_reports(id,recall_id,request_hash,payload,receipt,created_at) VALUES (?,?,?,?,?,?)',
        [input.reportId,input.recallId,requestHash,stableJSON(normalized),stableJSON(receipt),now]);
      for (const row of signalRows) await this.db!.run(`INSERT INTO memory_improvement_signals
        (id,report_id,kind,domain_kind,domain_id,space_id,memory_type,memory_a_id,memory_b_id,reason,context,source_refs,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,
        [row.id,input.reportId,row.kind,row.domain.kind,row.domain.id,row.spaceId,row.memoryType,row.memoryAId,row.memoryBId,
          row.reason,row.context,stableJSON(row.sourceRefs),now,now]);
      await this.logAction({action:'memory_use_reported',reason:stableJSON({reportId:input.reportId,recallId:input.recallId,signals:signalRows.length})});
      return receipt;
    });
  }

  /** Pending suggestions are domain-scoped and carry no authority to edit. */
  async listImprovementSignals(context: DomainReadContext, limit=10) {
    if (!Number.isInteger(limit) || limit<1 || limit>50) throw new Error('limit must be 1..50');
    const domains=context.domains?.length===0?[]:resolveReadDomains(context);
    if (!domains.length) return [];
    const where=domains.map(()=>'(s.domain_kind=? AND s.domain_id=?)').join(' OR ');
    const rows=await this.db!.all<any>(`SELECT s.* FROM memory_improvement_signals s WHERE s.status='pending' AND (${where})
      AND (s.domain_kind!='session' OR EXISTS(SELECT 1 FROM memory_domains d WHERE d.kind='session' AND d.id=s.domain_id AND d.status IN ('active','paused')))
      ORDER BY CASE s.kind WHEN 'review_memory' THEN 0 ELSE 1 END,s.created_at,s.id LIMIT ?`,
      [...domains.flatMap(d=>[d.kind,d.id]),limit]);
    return rows.map((row:any)=>({id:row.id,kind:row.kind,domain:{kind:row.domain_kind,id:row.domain_id},
      spaceId:row.space_id??undefined,memoryType:row.memory_type??undefined,memoryIds:[row.memory_a_id,...(row.memory_b_id?[row.memory_b_id]:[])],
      reason:row.reason,context:row.context,sourceRefs:JSON.parse(row.source_refs),createdAt:row.created_at,
      next:row.kind==='review_memory'?'Read current memory and actual evidence; use memory_update with expectedUpdatedAt only if a full correction is supported.':'Read both full memories and original context; use memory_association_upsert only if co-recall is still justified.'}));
  }

  async resolveImprovementSignal(input:{signalId:string;status:'reviewed'|'deferred'|'dismissed';reason:string;context:DomainReadContext}) {
    textField(input.signalId,'signalId',256);textField(input.reason,'resolution reason');
    return this.growthWrite(async()=>{
      const row=await this.db!.get<any>('SELECT * FROM memory_improvement_signals WHERE id=?',[input.signalId]);
      if(!row)throw new Error('Improvement signal not found');
      const domains=input.context.domains?.length===0?[]:resolveReadDomains(input.context);
      if(!domains.some(d=>d.kind===row.domain_kind&&d.id===row.domain_id))throw new Error('Improvement signal outside readable domains');
      if(row.domain_kind==='session'){
        const session=await this.db!.get<any>("SELECT status FROM memory_domains WHERE kind='session' AND id=?",[row.domain_id]);
        if(!session||!['active','paused'].includes(session.status))throw new Error('Session is closed');
      }
      if(row.status!=='pending'){
        if(row.status===input.status&&row.resolution===input.reason)return{id:input.signalId,status:input.status,replayed:true};
        throw new Error('Improvement signal already resolved differently');
      }
      await this.db!.run('UPDATE memory_improvement_signals SET status=?,resolution=?,updated_at=? WHERE id=?',
        [input.status,input.reason,Date.now(),input.signalId]);
      await this.logAction({action:'memory_improvement_resolved',reason:stableJSON({signalId:input.signalId,status:input.status})});
      return{id:input.signalId,status:input.status,replayed:false};
    });
  }

  async recallFeedbackSummary(): Promise<RecallFeedbackSummary> {
    const recalls = await this.db!.get<{ count: number }>('SELECT COUNT(*) AS count FROM memory_recalls');
    const receipts = await this.db!.all<Array<{ result_ids: string }>>('SELECT result_ids FROM memory_recalls');
    const rows = await this.db!.all<Array<{ disposition: RecallDisposition; count: number }>>('SELECT disposition, COUNT(*) AS count FROM memory_recall_feedback GROUP BY disposition');
    const decisions: Record<RecallDisposition, number> = { used: 0, rejected: 0, unassessed: 0 };
    for (const row of rows) decisions[row.disposition] = row.count;
    const returned = receipts.reduce((total, receipt) => {
      try { return total + (JSON.parse(receipt.result_ids) as unknown[]).length; }
      catch { throw new Error('Invalid persisted recall result ids'); }
    }, 0);
    const reported = decisions.used + decisions.rejected + decisions.unassessed;
    return { recalls: recalls?.count ?? 0, returned, decisions, unreported: Math.max(0, returned - reported) };
  }

  /** Apply the same privacy/state eligibility to every retrieval channel.
   * A scoped search may read its own session and explicitly-global memories,
   * but never another session via ANN, ngram, or graph traversal. */
  private matchesNodeScope(node: MemoryNode, query: MemoryQuery, enforceDimension = true): boolean {
    if(query.eventOnly && node.kind!=='event' && node.layer!=='L0')return false;
    if (!query.includeSuperseded && node.supersededBy) return false;
    // Uncertainty travels with the body/tags; it is not a reason to suppress
    // useful candidates. Hosts must distinguish hypotheses from conclusions.
    if (node.layer === 'L0' && !query.includeL0) return false;
    if(node.kind==='event' && !query.includeEvents && !query.includeL0 && !(Array.isArray(query.dimension)?query.dimension.includes('event'):query.dimension==='event'))return false;
    if (query.layer) {
      const layers = Array.isArray(query.layer) ? query.layer : [query.layer];
      if (!layers.includes(node.layer)) return false;
    }
    if (enforceDimension && query.dimension) {
      const dimensions = Array.isArray(query.dimension) ? query.dimension : [query.dimension];
      if (!dimensions.some(d=>d===node.dimension || node.dimensions?.includes(d as KnowledgeDimension))) return false;
    }
    const readable = this.queryDomains(query);
    if (!readable.some(domain => sameDomain(domain, node.domain))) return false;
    if (query.tags?.length && !query.tags.some(tag => node.tags.includes(tag))) return false;
    return true;
  }

  private async isNodeReadable(node: MemoryNode, query: MemoryQuery, enforceDimension = true): Promise<boolean> {
    if (!this.matchesNodeScope(node, query, enforceDimension)) return false;
    if (node.domain.kind !== 'session') return true;
    const status = await this.db!.get<any>("SELECT status FROM memory_domains WHERE kind='session' AND id=?", [node.domain.id]);
    return status?.status === 'active' || status?.status === 'paused';
  }

  private matchesMembershipScope(membership: MemoryMembership, query: MemoryQuery): boolean {
    if (!membership.active) return false;
    if (query.spaceId) {
      const spaces = Array.isArray(query.spaceId) ? query.spaceId : [query.spaceId];
      if (!spaces.includes(membership.spaceId)) return false;
    }
    if (query.memoryType) {
      const types = Array.isArray(query.memoryType) ? query.memoryType : [query.memoryType];
      if (!types.includes(membership.memoryType)) return false;
    }
    return true;
  }

  /** Scope-aware seed filtering.  The vector index is keyed by canonical
   * bodies, so membership predicates are resolved in SQLite before candidates
   * become entry points. */
  private async eligibleNodeIds(nodeIds: string[], query: MemoryQuery): Promise<Set<string>> {
    if (!this.db || nodeIds.length === 0) return new Set();
    if(nodeIds.length>500){const all=new Set<string>();for(let i=0;i<nodeIds.length;i+=500)for(const id of await this.eligibleNodeIds(nodeIds.slice(i,i+500),query))all.add(id);return all;}
    const clauses = ['active = 1', `memory_id IN (${nodeIds.map(() => '?').join(',')})`];
    const params: unknown[] = [...nodeIds];
    const domains = this.queryDomains(query);
    clauses.push('EXISTS (SELECT 1 FROM nodes dn LEFT JOIN memory_domains dd ON dd.kind=dn.domain_kind AND dd.id=dn.domain_id WHERE dn.id=memory_memberships.memory_id AND (' +
      domains.map(() => '(dn.domain_kind=? AND dn.domain_id=? AND (dn.domain_kind != \'session\' OR dd.status IN (\'active\',\'paused\')))').join(' OR ') + '))');
    for (const domain of domains) params.push(domain.kind, domain.id);
    if (query.spaceId) {
      const spaces = Array.isArray(query.spaceId) ? query.spaceId : [query.spaceId];
      clauses.push(`space_id IN (${spaces.map(() => '?').join(',')})`);
      params.push(...spaces);
    }
    if (query.memoryType) {
      const types = Array.isArray(query.memoryType) ? query.memoryType : [query.memoryType];
      clauses.push(`memory_type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
    const rows = await this.db.all<any>(`SELECT DISTINCT memory_id FROM memory_memberships WHERE ${clauses.join(' AND ')}`, params);
    return new Set(rows.map((row: any) => row.memory_id));
  }

  /**
   * Annotate a result set with in-set near-duplicates (cosine ≥ 0.92 on the
   * vector index). Hosts can then call deleteNode / mergeDuplicates to clean
   * up redundant memories. Result sets are tiny (≤ limit), so pairwise is cheap.
   */
  private markDuplicatesWithin(results: SearchResult[]): void {
    if (results.length < 2) return;
    const DUP_THRESHOLD = 0.92;
    for (let i = 0; i < results.length; i++) {
      const a = this.vectorIndex.get(results[i].node.id)?.vector;
      if (!a) continue;
      for (let j = i + 1; j < results.length; j++) {
        const b = this.vectorIndex.get(results[j].node.id)?.vector;
        if (!b) continue;
        const sim = cosineSimilarity(a, b);
        if (sim >= DUP_THRESHOLD) {
          (results[i].nearDuplicates ??= []).push({ id: results[j].node.id, similarity: sim });
          (results[j].nearDuplicates ??= []).push({ id: results[i].node.id, similarity: sim });
        }
      }
    }
  }

  /**
   * Hybrid search: combines ANN vector search + ngram text search.
   * Always runs both paths and merges results using reciprocal-rank fusion.
   * This ensures memories are findable even without embeddings.
   */
  private async hybridSearch(queryText:string, query:MemoryQuery, limit:number, diagnostic:RetrievalDiagnostics,selection:Awaited<ReturnType<ProfileRetrieval['select']>>):Promise<Array<{node:MemoryNode;score:number;spaceId:string;memoryType:string;matchedAnchors:AnchorMatch[]}>> {
    diagnostic.profile={selected:selection.id,...(selection.fallback?{fallbackReason:selection.reason}: {})};
    diagnostic.degraded ||= selection.fallback;
    let profileHits:Awaited<ReturnType<GraphMemory['profileSearch']>>|undefined;
    const states:RetrievalDiagnostics['channels']=[];
    const run=async<T>(channel:string, enabled:boolean, effective:()=>boolean, work:()=>Promise<T[]>):Promise<T[]>=>{
      if(!enabled){states.push({channel,status:'disabled'});return [];}
      try {const hits=await work();states.push({channel,status:effective()||hits.length?'available':'unavailable'});return hits;}
      catch(error){states.push({channel,status:'failed',code:'retrieval_channel_failed'});logger.debug(`Retrieval channel ${channel} failed`,getErrorMessage(error));return [];}
    };
    const [main,text,zh]=await Promise.all([
      run('body-vector',true,()=>selection.id!=='legacy'||!!query.embedding?.length || getEmbeddingService().status().state==='ready',async()=>{
        if(selection.id==='legacy'){
          const hits=await this.annSearch(queryText,query,limit);
          if(query.vectorAlgorithm==='hnsw'){
            const index=await this.approximateIndexes.get(this.vectorIndex)?.index;
            diagnostic.profile!.algorithm=index?.status();if(index?.status().fallbackReason)diagnostic.degraded=true;
          }
          return hits;
        }
        if(query.embedding?.length)throw new MindPondError('invalid_input','Precomputed vectors require a matching profile identity; use a text query');
        profileHits=await this.profileSearch(selection.id,queryText,query,limit);
        diagnostic.profile!.algorithm=profileHits.algorithm;diagnostic.profile!.runtime=profileHits.runtime;
        if(profileHits.algorithm.fallbackReason)diagnostic.degraded=true;
        return profileHits.body;
      }),
      run('body-text',true,()=>true,()=>this.ngramSearch(queryText,query,limit)),
      run('body-zh',selection.id==='legacy'&&!!this.zhVectorIndex,()=>getZhEmbeddingService().status().state==='ready',()=>this.zhAnnSearch(queryText,query,limit)),
    ]);
    const hits=await run('anchors',query.useAnchors!==false,()=>false,async()=>{
      const rows=await this.anchors.candidates();
      const eligible=await this.eligibleNodeIds([...new Set(rows.map(r=>r.memory_id))],query);
      const scoped=rows.filter(r=>eligible.has(r.memory_id) && this.matchesMembershipScope({active:true,spaceId:r.space_id,memoryType:r.memory_type} as MemoryMembership,query));
      return [...await this.anchors.search(queryText,scoped,0.3,selection.id==='legacy'),...(profileHits?.anchors??[])];
    });
    diagnostic.channels.push(...states);
    diagnostic.degraded ||= states.some(s=>s.status==='failed' || (s.status==='unavailable' && s.channel!=='anchors'));
    if(states.some(s=>s.status==='failed') && !states.some(s=>s.status==='available'))
      throw new MindPondError('temporarily_unavailable','All effective retrieval channels failed; retry after checking service health',{retryable:true,details:{retrieval:diagnostic}});
    type Hit={node:MemoryNode;score:number;spaceId?:string;memoryType?:string;match?:AnchorMatch};
    const channels=new Map<string,Hit[]>([['body-vector',main],['body-text',text],['body-zh',zh]]);
    const nodes=new Map([...main,...text,...zh].map(h=>[h.node.id,h.node]));
    const grouped=new Map<string,typeof hits>();
    for(const h of hits){const list=grouped.get(h.match.channel)??[];list.push(h);grouped.set(h.match.channel,list);}
    for(const [channel,list] of grouped) {
      const best=new Map<string,number>();for(const h of list)best.set(h.memoryId,Math.max(best.get(h.memoryId)??-1,h.match.similarity));
      const ids=new Set([...best].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,limit).map(([id])=>id));
      const candidates:Hit[]=[];
      for(const h of list) {
        if(!ids.has(h.memoryId))continue;
        if(!nodes.has(h.memoryId)) {
          const row=await this.db!.get<any>(`SELECT ${NODE_COLUMNS_NO_EMBEDDING} FROM nodes WHERE id=?`,[h.memoryId]);
          if(row)nodes.set(h.memoryId,this.rowToNode(row));
        }
        const node=nodes.get(h.memoryId);
        if(node && this.matchesNodeScope(node,query))candidates.push({node,score:h.match.similarity,spaceId:h.spaceId,memoryType:h.memoryType,match:h.match});
      }
      channels.set(channel,candidates);
    }
    const merged=new Map<string,{node:MemoryNode;spaceId:string;memoryType:string;strengths:Map<string,number>;matches:Map<string,AnchorMatch>}>();
    const placements=new Map<string,MemoryMembership[]>();
    for(const [channel,list] of channels) {
      const best=new Map<string,number>();for(const h of list)best.set(h.node.id,Math.max(best.get(h.node.id)??-1,h.score));
      const ranked=[...best].sort((a,b)=>b[1]-a[1]);
      const ranks=new Map<string,number>();
      let rank=0, previousScore=Number.POSITIVE_INFINITY;
      for(let i=0;i<ranked.length;i++){const [id,score]=ranked[i];if(score<previousScore){rank=i+1;previousScore=score;}ranks.set(id,rank);}
      for(const h of list) {
        const rank=ranks.get(h.node.id)!;
        if(!placements.has(h.node.id))placements.set(h.node.id,await this.getMemberships(h.node.id,{activeOnly:true}));
        for(const m of placements.get(h.node.id)!) {
          if(!this.matchesMembershipScope(m,query) || (h.spaceId!==undefined && (h.spaceId!==m.spaceId || h.memoryType!==m.memoryType)))continue;
          const entry=merged.get(m.id)??{node:h.node,spaceId:m.spaceId,memoryType:m.memoryType,strengths:new Map(),matches:new Map()};
          entry.strengths.set(channel,Math.max(entry.strengths.get(channel)??0,20/(19+rank)));
          if(h.match && h.match.similarity>(entry.matches.get(h.match.id)?.similarity??-1))entry.matches.set(h.match.id,h.match);
          merged.set(m.id,entry);
        }
      }
    }
    const results=[...merged.values()].map(e=>{
      const strongest=Math.max(...e.strengths.values());
      const body=['body-vector','body-text','body-zh'].reduce((s,k)=>s+(e.strengths.get(k)??0),0);
      const anchor=Math.max(0,...[...e.strengths].filter(([k])=>k.startsWith('anchor-')).map(([,s])=>s));
      return {node:e.node,spaceId:e.spaceId,memoryType:e.memoryType,score:.7*strongest+.3*(body+anchor)/4,matchedAnchors:[...e.matches.values()]};
    }).sort((a,b)=>b.score-a.score || a.node.content.localeCompare(b.node.content) || a.node.id.localeCompare(b.node.id));
    const ids=new Set([...new Set(results.map(h=>h.node.id))].slice(0,limit));
    return results.filter(h=>ids.has(h.node.id));
  }

  private async profileSearch(profileId:string,text:string,query:MemoryQuery,limit:number){
    const eligible=await this.eligibleNodeIds(await this.profileRetrieval.ownerIds(profileId),query);
    const rows=await this.anchors.candidates();
    const scoped=rows.filter(row=>eligible.has(row.memory_id)&&this.matchesMembershipScope({active:true,spaceId:row.space_id,memoryType:row.memory_type} as MemoryMembership,query));
    const hits=await this.profileRetrieval.search(profileId,text,eligible,new Set(query.useAnchors===false?[]:scoped.map(row=>row.id)),limit,query.vectorAlgorithm);
    const best=new Map<string,{score:number;version:string|undefined}>();
    for(const hit of hits.body)if(hit.score>(best.get(hit.ownerId)?.score??-1))best.set(hit.ownerId,{score:hit.score,version:hit.version});
    const ids=[...best].sort((a,b)=>b[1].score-a[1].score).slice(0,limit).map(([id])=>id);
    const body:Array<{node:MemoryNode;score:number}>=[];
    if(ids.length){
      const nodes=await this.db!.all<Array<NodeRow & {profile_version:number}>>(`SELECT ${NODE_COLUMNS_NO_EMBEDDING},COALESCE((SELECT version FROM memory_profile_body_versions v WHERE v.memory_id=n.id),0) profile_version FROM nodes n WHERE n.id IN (${ids.map(()=>'?').join(',')})`,ids);
      for(const node of nodes){const memory=this.rowToNode(node);if(best.get(memory.id)?.version===String(node.profile_version)&&eligible.has(memory.id)&&this.matchesNodeScope(memory,query))body.push({node:memory,score:best.get(memory.id)!.score});}
      body.sort((a,b)=>b.score-a.score);
    }
    const anchors:Array<{memoryId:string;spaceId:string;memoryType:string;match:AnchorMatch}>=[];
    const latest=await this.anchors.candidates();
    const byId=new Map(latest.filter(row=>eligible.has(row.memory_id)&&this.matchesMembershipScope({active:true,spaceId:row.space_id,memoryType:row.memory_type} as MemoryMembership,query)).map(row=>[row.id,row]));
    for(const hit of hits.anchors){const row=byId.get(hit.ownerId);if(row&&row.content_hash===hit.version)anchors.push({memoryId:row.memory_id,spaceId:row.space_id,memoryType:row.memory_type,match:{id:row.id,text:row.text,channel:'anchor-profile',similarity:hit.score}});}
    return {body,anchors,algorithm:hits.algorithm,runtime:hits.runtime};
  }

  /**
   * ZH-side ANN search (bge-small-zh, 512d). Returns [] unless the side
   * channel is enabled, its index is loaded, and the query is Chinese-dominant.
   * Score semantics identical to annSearch (cosine similarity).
   */
  private async zhAnnSearch(
    queryText: string,
    query: MemoryQuery,
    limit: number
  ): Promise<{ node: MemoryNode; score: number }[]> {
    if (!this.db || !this.zhVectorIndex || this.zhVectorIndex.getAll().length === 0) return [];
    if (!isChineseText(queryText)) return [];

    const embedding = await getZhEmbeddingService().generateEmbedding(queryText);
    if (embedding.length === 0) return [];

    const eligible = await this.eligibleNodeIds(this.zhVectorIndex.getAll().map(item => item.id), query);

    const results = query.vectorAlgorithm==='hnsw'?await this.approximateSearch(this.zhVectorIndex,embedding,eligible,limit):this.zhVectorIndex.search(embedding, {
      topK: limit,
      minScore: this.DEFAULT_MIN_SCORE,
      filterKey: this.queryScopeCacheKey(query) + crypto.createHash('sha1').update([...eligible].sort().join(',')).digest('hex'),
      filter: item => eligible.has(item.id),
    });
    if (results.length === 0) return [];

    const placeholders = results.map(() => '?').join(',');
    const rows = await this.db.all<any>(
      `SELECT ${NODE_COLUMNS_NO_EMBEDDING} FROM nodes WHERE id IN (${placeholders})`,
      results.map(r => r.id)
    );
    const nodesById = new Map<string, MemoryNode>(rows.map((r: NodeRow) => [r.id, this.rowToNode(r)]));

    const nodes: { node: MemoryNode; score: number }[] = [];
    for (const r of results) {
      const node = nodesById.get(r.id);
      if (!node) continue;
      if (!eligible.has(node.id)) continue;
      if (!this.matchesNodeScope(node, query)) continue;
      nodes.push({ node, score: r.score });
    }
    return nodes;
  }

  private async approximateSearch(index:VectorIndex,query:number[],eligible:Set<string>,limit:number){
    let cached=this.approximateIndexes.get(index);
    if(!cached||cached.generation!==this.indexGeneration){
      const promise=(async()=>{
        const accelerated=new ProfileVectorIndex();
        await accelerated.load(index.getAll().map(item=>({id:item.id,ownerId:item.id,vector:Array.from(item.vector)})),embeddingRuntimeSchema.parse({algorithm:'hnsw'}));
        return accelerated;
      })();
      cached={generation:this.indexGeneration,index:promise};this.approximateIndexes.set(index,cached);
    }
    return (await cached.index).search(query,eligible,limit,this.DEFAULT_MIN_SCORE);
  }

  /**
   * ANN search with optional dimension filter.
   */
  private async annSearch(
    queryText: string,
    query: MemoryQuery,
    limit: number
  ): Promise<{ node: MemoryNode; score: number }[]> {
    if (!this.db) return [];

    let embedding = query.embedding;
    if (!embedding || embedding.length === 0) {
      embedding = await getEmbeddingService().generateEmbedding(queryText);
    }

    const eligible = await this.eligibleNodeIds(this.vectorIndex.getAll().map(item => item.id), query);
    const results = query.vectorAlgorithm==='hnsw'?await this.approximateSearch(this.vectorIndex,embedding,new Set([...eligible].filter(id=>this.indexMetadataMatchesQuery(this.vectorIndex.get(id)?.metadata,query))),limit):this.vectorIndex.search(embedding, {
      topK: limit,
      minScore: this.DEFAULT_MIN_SCORE,
      filterKey: this.queryScopeCacheKey(query) + crypto.createHash('sha1').update([...eligible].sort().join(',')).digest('hex'),
      filter: (item) => eligible.has(item.id) && this.indexMetadataMatchesQuery(item.metadata, query),
    });
    if (results.length === 0) return [];

    // Batch-fetch all candidates in one query instead of one getNodeById
    // round-trip per candidate (which also bumped access_count on every
    // search). ANN distance order is preserved by iterating `results`.
    const placeholders = results.map(() => '?').join(',');
    const rows = await this.db.all<any>(
      `SELECT ${NODE_COLUMNS_NO_EMBEDDING} FROM nodes WHERE id IN (${placeholders})`,
      results.map(r => r.id)
    );
    const nodesById = new Map<string, MemoryNode>(rows.map((r: NodeRow) => [r.id, this.rowToNode(r)]));

    const nodes: { node: MemoryNode; score: number }[] = [];
    for (const r of results) {
      const node = nodesById.get(r.id);
      if (!node) continue;
      if (!eligible.has(node.id)) continue;

      if (!this.matchesNodeScope(node, query)) continue;

      nodes.push({ node, score: r.score });
    }

    return nodes;
  }

  /**
   * Ngram-based text search — works for Chinese, English, and mixed text.
   * Uses character bigrams/trigrams for CJK + whitespace tokens for Latin.
   *
   * FTS5/trigram narrows eligible candidates when available; short queries
   * use escaped multi-token LIKE. Keyset pages score the complete matching
   * set and retain the best bounded candidates, without a collection cutoff.
   */
  private async ngramSearch(
    queryText: string,
    query: MemoryQuery,
    limit: number
  ): Promise<{ node: MemoryNode; score: number }[]> {
    if (!this.db) return [];

    const queryTokens = this.tokenize(queryText);
    if (queryTokens.length === 0) return [];

    // Build a multi-token OR pre-filter using the top discriminative tokens
    // (bigrams/trigrams, max 6) to reduce scan scope while staying inclusive.
    const discriminative = queryTokens
      .filter(t => t.length >= 2)
      .sort((a, b) => b.length - a.length)
      .slice(0, 6);

    // Keyset pages bound working memory, not recall coverage. Rank the whole
    // eligible match set rather than an arbitrary first 5000 SQL rows.
    const conditions = discriminative.map(() => "content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'").join(' OR ');
    const escapeLike = (text: string) => text.replace(/[\\%_]/g, c => '\\' + c);
    const params = discriminative.flatMap(t => [`%${escapeLike(t)}%`, `%${escapeLike(t)}%`]);
    const expression=this.textIndexReady?trigramExpression(discriminative):undefined;
    const scored: { node: MemoryNode; score: number }[] = [];
    let cursor = 0;
    for (;;) {
      const allRows = await this.db.all<any[]>(`SELECT rowid AS search_rowid, ${NODE_COLUMNS_NO_EMBEDDING} FROM nodes WHERE rowid > ? ${expression ? 'AND rowid IN (SELECT rowid FROM memory_text WHERE memory_text MATCH ?)' : conditions ? `AND (${conditions})` : ''} ORDER BY rowid LIMIT 256`, [cursor, ...(expression?[expression]:params)]);
      if (!allRows.length) break;
      cursor = allRows.at(-1)!.search_rowid;
      const eligible = await this.eligibleNodeIds(allRows.map(row => row.id), query);
      for (const row of allRows) {
      if (!eligible.has(row.id)) continue;
      const content = (row.content || '').toLowerCase();
      const tags = (row.tags || '[]').toLowerCase();
      const searchable = content + ' ' + tags;

      let hitScore = 0;
      for (const token of queryTokens) {
        if (searchable.includes(token)) {
          // Longer tokens are more discriminative;
          // unigrams (single CJK chars) are very common and add little signal
          hitScore += token.length >= 3 ? 1.0 : token.length === 2 ? 0.8 : 0.2;
        }
      }

      if (hitScore > 0) {
        const node = this.rowToNode(row);
        if (!this.matchesNodeScope(node, query)) continue;

        // Normalize score: hits / max possible
        const maxScore = queryTokens.reduce((sum, t) => sum + (t.length >= 3 ? 1.0 : t.length === 2 ? 0.8 : 0.2), 0);
        const normalizedScore = hitScore / maxScore;

        // Boost by importance (1-10 → 0.9-1.1 multiplier)
        const importanceBoost = 0.9 + (node.importance / 10) * 0.2;

        // Length, punctuation and author role do not establish knowledge value.
        // Rich procedures and useful open questions deserve the same entrances.
        const score = normalizedScore * importanceBoost;
        if (score >= (query.minScore ?? this.DEFAULT_MIN_SCORE)) scored.push({ node, score });
      }
    }

      // Keep only the best candidates between pages; no complete bodies are
      // retained for discarded hits, regardless of the collection's size.
      scored.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
      scored.splice(limit);
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  private queryScopeCacheKey(query: MemoryQuery): string {
    return JSON.stringify({
      dimension: query.dimension, layer: query.layer, includeL0: !!query.includeL0,includeEvents:!!query.includeEvents,eventOnly:!!query.eventOnly,
      includeSuperseded: !!query.includeSuperseded, tags: query.tags?.slice().sort(), sessionId: query.sessionId,
      domains: this.queryDomains(query),
      spaceId: query.spaceId, memoryType: query.memoryType,
    });
  }

  private indexMetadataMatchesQuery(metadata: VectorItem['metadata'] | undefined, query: MemoryQuery): boolean {
    if (!metadata) return false;
    const node = {
      dimensions:metadata.dimensions as KnowledgeDimension[]|undefined,kind:metadata.kind as MemoryNode['kind'],
      id: '', dimension: metadata.dimension as Dimension, layer: metadata.layer as MemoryLayer,
      content: '', embedding: [], importance: 0, tags: Array.isArray(metadata.tags) ? metadata.tags : [],
      domain: metadata.domain ?? {kind:'personal',id:'default'},
      sessionId: typeof metadata.sessionId === 'string' ? metadata.sessionId : undefined,
      createdAt: 0, updatedAt: 0, accessCount: 0,
      supersededBy: typeof metadata.supersededBy === 'string' ? metadata.supersededBy : undefined,
    } satisfies MemoryNode;
    return this.matchesNodeScope(node, query);
  }

  /**
   * Tokenize text for search: Chinese ngrams + English words.
   * - CJK characters → bigrams + trigrams (sliding window)
   * - Latin/numbers → split by whitespace/punctuation, keep tokens ≥ 2 chars
   * - Single CJK chars also kept as unigrams for short queries
   */
  private tokenize(text: string): string[] {
    const lower = text.toLowerCase();
    const tokens: Set<string> = new Set();

    // Extract CJK segments and generate ngrams
    const cjkRegex = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g;
    let match: RegExpExecArray | null;
    while ((match = cjkRegex.exec(lower)) !== null) {
      const segment = match[0];
      // Unigrams (for single-char matching like "吃" "瓜")
      for (const ch of segment) {
        tokens.add(ch);
      }
      // Bigrams
      for (let i = 0; i < segment.length - 1; i++) {
        tokens.add(segment.slice(i, i + 2));
      }
      // Trigrams
      for (let i = 0; i < segment.length - 2; i++) {
        tokens.add(segment.slice(i, i + 3));
      }
    }

    // Extract Latin/number tokens
    const latinRegex = /[a-z0-9_]+/g;
    while ((match = latinRegex.exec(lower)) !== null) {
      if (match[0].length >= 2) {
        tokens.add(match[0]);
      }
    }

    return Array.from(tokens);
  }

  /**
   * Save a raw chat message as an L0 node (append-only, no embedding, no truncation).
   * L0 = raw conversation record. Structured L1 atoms are extracted later by the pipeline.
   *
   * Idempotency: when `messageId` is provided, a durable receipt scoped by session and message
   * is committed atomically with the node and extraction job. This survives restarts
   * and the 5s window below — a host saving the same logical message from multiple
   * call sites (fast-path + task-end capture, retry after interruption) yields one
   * L0 record, not duplicates.
   */
  /** Dedup window: same message within 5s from multiple call sites → skip duplicate */
  private recentSaves = new Map<string, { nodeId: string; ts: number }>();

  async saveMessage(sessionId: string, content: string, role: string, messageId?: string): Promise<string> {
    if (messageId !== undefined) {
      textField(messageId,'messageId',256);textField(sessionId,'sessionId',256);
      textField(role,'role',64);textField(content,'message content',1000000);
      const transcript=`[${role}] ${content}`;
      const key='message:'+digest([sessionId,messageId]);
      const hash=digest({transcript,sessionId});
      return (await this.growthWrite(() => this.ingestTranscriptLocked(transcript,sessionId,key,hash,{messageId,role}))).l0Id;
    }

    // Legacy heuristic: same session+role+content within 5s → return existing node
    const key = digest([sessionId,role,content]);
    const existing = this.recentSaves.get(key);
    if (existing && Date.now() - existing.ts < 5000) {
      return existing.nodeId;
    }

    const node = await this.createNode({
      dimension: 'event',
      layer: 'L0',
      content: `[${role}] ${content}`,
      tags: [role, `session:${sessionId}`],
      sessionId,
      importance: 3,
      source: 'conversation',
    });

    // Track for dedup, prune old entries
    this.recentSaves.set(key, { nodeId: node.id, ts: Date.now() });
    if (this.recentSaves.size > 50) {
      const cutoff = Date.now() - 10000;
      for (const [k, v] of this.recentSaves) {
        if (v.ts < cutoff) this.recentSaves.delete(k);
      }
    }

    return node.id;
  }

  /**
   * Save a decision case — includes root cause and outcome.
   */
  async saveDecision(params: {
    context: string;
    decision: string;
    outcome: string;
    rootCause?: string;
    sessionId?: string;
  }): Promise<MemoryNode> {
    const content = [
      `Context: ${params.context}`,
      `Decision: ${params.decision}`,
      `Outcome: ${params.outcome}`,
      params.rootCause ? `Root Cause: ${params.rootCause}` : null,
    ].filter(Boolean).join('\n');

    return this.createNode({
      dimension: (await this.getDimensionConfiguration()).definitions.some(d=>d.id==='decision'&&d.enabled)?'decision':(await this.getDimensionConfiguration()).defaultDimension,
      content,
      importance: 8,
      tags: ['decision', 'diagnosis'],
      sessionId: params.sessionId,
    });
  }


  // ============================================
  // Connections
  // ============================================

  /**
   * All connections of a node — BOTH outgoing and incoming edges.
   * `direction` is from the queried node's perspective: 'out' = node → neighbor,
   * 'in' = neighbor → node. Results sorted by edge weight desc.
   */
  async getConnections(nodeId: string, context?: DomainReadContext): Promise<{ node: MemoryNode; edge: MemoryEdge; direction: 'out' | 'in' }[]> {
    if (!this.db) throw new Error('Database not initialized');
    if (context) {
      const target = await this.getNodeById(nodeId, { trackAccess: false, context });
      if (!target) throw new Error(`node not found: ${nodeId}`);
    }
    // NOTE: edge columns are explicitly aliased — bare `e.*, n.*` would let
    // n.id clobber e.id in the row object (duplicate column names).
    const rows = await this.db.all<any>(
      `SELECT e.id AS edge_id, e.from_id, e.to_id, e.label, e.weight, e.created_at AS edge_created_at, n.*, 'out' AS direction
         FROM edges e JOIN nodes n ON e.to_id = n.id WHERE e.from_id = ?
       UNION ALL
       SELECT e.id AS edge_id, e.from_id, e.to_id, e.label, e.weight, e.created_at AS edge_created_at, n.*, 'in' AS direction
         FROM edges e JOIN nodes n ON e.from_id = n.id WHERE e.to_id = ?`,
      [nodeId, nodeId]
    );
    const readable = context ? resolveReadDomains(context) : null;
    const mapped: { node: MemoryNode; edge: MemoryEdge; direction: 'out' | 'in' }[] = rows.map((r: any) => ({
      node: this.rowToNode(r),
      edge: {
        id: r.edge_id,
        fromId: r.from_id,
        toId: r.to_id,
        label: r.label,
        weight: r.weight,
        createdAt: r.edge_created_at,
      },
      direction: r.direction as 'out' | 'in',
    }));
    // M02.b: bounded entries never expose neighbors outside the readable set
    // (associations are same-domain by construction; legacy dimension edges are not).
    const filtered = readable ? mapped.filter(c => readable.some(d => sameDomain(d, c.node.domain))) : mapped;
    filtered.sort((a, b) => b.edge.weight - a.edge.weight);
    return filtered;
  }

  /** Get all nodes and edges for graph visualization (excludes embeddings).
   *  Optional layer filter keeps edges whose BOTH endpoints survive the filter —
   *  otherwise L0 raw records drown the structured graph (43% of rpbot's nodes). */
  /** Operator visualization uses the SAME semantic edges as ripple. Provenance
   * is available separately/on demand and never masquerades as co-recall. */
  async getFullGraph(limit=200,layer?:MemoryLayer,options:{spaceId?:string;memoryType?:string;includeEvents?:boolean;context?:DomainReadContext}={}) {
    const where=["n.superseded_by IS NULL","EXISTS(SELECT 1 FROM memory_memberships m WHERE m.memory_id=n.id AND m.active=1"+(options.spaceId?' AND m.space_id=?':'')+(options.memoryType?' AND m.memory_type=?':'')+")"];
    const args:unknown[]=[...(options.spaceId?[options.spaceId]:[]),...(options.memoryType?[options.memoryType]:[])];
    if(options.context) {
      const domains=resolveReadDomains(options.context);
      where.push('('+domains.map(()=>'(n.domain_kind=? AND n.domain_id=?)').join(' OR ')+')');
      where.push("(n.domain_kind!='session' OR EXISTS(SELECT 1 FROM memory_domains d WHERE d.kind='session' AND d.id=n.domain_id AND d.status IN ('active','paused')))");
      args.push(...domains.flatMap(d=>[d.kind,d.id]));
    }
    if(!options.includeEvents)where.push("n.dimension!='event' AND n.layer!='L0'");
    if(layer){where.push('n.layer=?');args.push(layer);}
    let rows=await this.db!.all<any[]>(`SELECT ${NODE_COLUMNS_NO_EMBEDDING_N} FROM nodes n WHERE ${where.join(' AND ')} ORDER BY n.created_at DESC LIMIT ?`,[...args,limit]);
    // A recent-only slice can erase an entire rare dimension from the graph.
    // Reserve one readable representative of every identity present in scope;
    // a multi-dimension memory counts for each identity it actually carries.
    if(limit>=1) {
      const hasDimension=(row:any,dimension:string)=>{
        const parsed=safeParse(row.dimensions,[]);
        return Array.isArray(parsed)&&parsed.length?parsed.includes(dimension):row.dimension===dimension;
      };
      const reserved=new Map<string,any>();
      for(const {id:dimension} of (await this.getDimensionConfiguration()).definitions) {
        let representative=rows.find(row=>hasDimension(row,dimension));
        if(!representative) representative=await this.db!.get<any>(
          `SELECT ${NODE_COLUMNS_NO_EMBEDDING_N} FROM nodes n WHERE ${where.join(' AND ')}
           AND ((COALESCE(json_array_length(n.dimensions),0)=0 AND n.dimension=?) OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(n.dimensions) THEN n.dimensions ELSE '[]' END) d WHERE d.value=?))
           ORDER BY n.created_at DESC LIMIT 1`,[...args,dimension,dimension]);
        if(representative)reserved.set(representative.id,representative);
      }
      if(reserved.size) rows=[...reserved.values(),...rows.filter(row=>!reserved.has(row.id))]
        .slice(0,limit).sort((a,b)=>b.created_at-a.created_at);
    }
    const ids=JSON.stringify(rows.map(r=>r.id));
    const edges=await this.db!.all<any[]>(`SELECT a.*,m.memory_id from_id,t.memory_id to_id FROM memory_associations a
      JOIN memory_memberships m ON m.id=a.member_a_id JOIN memory_memberships t ON t.id=a.member_b_id
      JOIN nodes ax ON ax.id=m.memory_id JOIN nodes bx ON bx.id=t.memory_id
      WHERE ax.domain_kind=bx.domain_kind AND ax.domain_id=bx.domain_id AND m.active=1 AND t.active=1 AND m.memory_id IN (SELECT value FROM json_each(?)) AND t.memory_id IN (SELECT value FROM json_each(?))
      ${options.spaceId?' AND a.space_id=?':''} ${options.memoryType?' AND a.memory_type=?':''}
      AND (NOT EXISTS(SELECT 1 FROM association_evidence e WHERE e.association_id=a.id) OR EXISTS(SELECT 1 FROM association_evidence e WHERE e.association_id=a.id AND COALESCE(json_extract(e.payload,'$.review.decision'),'')!='retire'))
      ORDER BY a.weight DESC LIMIT ?`,[ids,ids,...(options.spaceId?[options.spaceId]:[]),...(options.memoryType?[options.memoryType]:[]),limit*4]);
    const references=await this.db!.all<any[]>(`SELECT r.*,m.memory_id from_id,t.memory_id to_id,m.space_id FROM memory_team_references r
      JOIN memory_memberships m ON m.id=r.source_member_id JOIN memory_memberships t ON t.id=r.target_member_id
      WHERE m.active=1 AND t.active=1 AND m.memory_id IN (SELECT value FROM json_each(?)) AND t.memory_id IN (SELECT value FROM json_each(?))
      ${options.spaceId?' AND m.space_id=?':''} ${options.memoryType?' AND m.memory_type=?':''} LIMIT ?`,[ids,ids,...(options.spaceId?[options.spaceId]:[]),...(options.memoryType?[options.memoryType]:[]),limit]);
    return {nodes:rows.map(r=>this.rowToNode(r)),edges:[...edges.map(r=>({...this.rowToEdge({...r,label:r.memory_type}),kind:'semantic' as const,spaceId:r.space_id})),...references.map(r=>({...this.rowToEdge({...r,label:'team-reference'}),kind:'semantic' as const,directed:true,spaceId:r.space_id}))],
      edgeSource:'memory_associations',window:{limit,returned:rows.length,neighborsOnDemand:true}};
  }

  async graphNeighborhood(nodeId:string,context?:DomainReadContext,limit=60,scope:{spaceId?:string;memoryType?:string}={}) {
    const own=await this.getNodeById(nodeId,{trackAccess:false,context});if(!own)throw new Error('Memory not found');
    const neighbors=new Map<string,MemoryNode>([[own.id,own]]);const edges:MemoryEdge[]=[];
    const associations=own.kind==='event'?[]:await this.listAssociations(nodeId);
    let total=0;
    for(const a of associations) {
      if(a.evidenceStatus==='retired' || (scope.spaceId && a.spaceId!==scope.spaceId) || (scope.memoryType && a.memoryType!==scope.memoryType))continue;
      const id=a.memoryA?.id===nodeId?a.memoryB?.id:a.memoryA?.id;if(!id)continue;
      const node=await this.getNodeById(id,{trackAccess:false});if(!node)continue;
      if(context && !await this.isNodeReadable(node,{...context,includeEvents:true,includeL0:true},false))continue;
      total++;if(neighbors.size>limit)continue;
      neighbors.set(id,node);edges.push({id:a.id,fromId:nodeId,toId:id,label:a.memoryType,weight:a.weight,createdAt:a.createdAt,kind:'semantic'});
    }
    const references=await this.db!.all<any[]>(`SELECT r.*,t.memory_id FROM memory_team_references r JOIN memory_memberships m ON m.id=r.source_member_id JOIN memory_memberships t ON t.id=r.target_member_id WHERE m.memory_id=? AND m.active=1 AND t.active=1 ${scope.spaceId?' AND m.space_id=?':''} ${scope.memoryType?' AND m.memory_type=?':''}`,[nodeId,...(scope.spaceId?[scope.spaceId]:[]),...(scope.memoryType?[scope.memoryType]:[])]);
    for(const reference of references) {
      const node=await this.getNodeById(reference.memory_id,{trackAccess:false});if(!node)continue;
      if(context && !await this.isNodeReadable(node,{...context,includeEvents:true,includeL0:true},false))continue;
      total++;if(neighbors.size>limit)continue;
      neighbors.set(node.id,node);edges.push({id:reference.id,fromId:nodeId,toId:node.id,label:'team-reference',kind:'semantic',directed:true,weight:reference.weight,createdAt:reference.created_at});
    }
    for(const c of await this.getConnections(nodeId,context)) {
      if(!['derived_from','distills','aggregates'].includes(c.edge.label))continue;
      total++;if(neighbors.size>limit)continue;
      neighbors.set(c.node.id,c.node);edges.push({...c.edge,kind:'provenance'});
    }
    return {nodes:[...neighbors.values()].map(({embedding,...n})=>n),edges,total,truncated:total>edges.length};
  }

  /** Explicit evidence traversal; not called by ordinary ripple. */
  async traceMemory(nodeId:string,context?:DomainReadContext,maxDepth=3,limit=50) {
    const first=await this.getNodeById(nodeId,{trackAccess:false,context});if(!first)throw new Error('Memory not found');
    const nodes=new Map<string,MemoryNode>([[nodeId,first]]),edges:MemoryEdge[]=[];
    const queue=[{id:nodeId,depth:0}];let truncated=false;
    while(queue.length) {
      const current=queue.shift()!;
      const links=(await this.getConnections(current.id,context)).filter(c=>c.direction==='out' && ['derived_from','distills','aggregates'].includes(c.edge.label));
      if(current.depth>=maxDepth){if(links.length)truncated=true;continue;}
      for(const link of links) {
        if(!nodes.has(link.node.id)) {
          if(nodes.size>=limit){truncated=true;continue;}
          nodes.set(link.node.id,link.node);queue.push({id:link.node.id,depth:current.depth+1});
        }
        edges.push({...link.edge,kind:'provenance'});
      }
    }
    return {nodes:[...nodes.values()].map(({embedding,...n})=>n),edges,truncated};
  }

  /** Historical edge view for diagnostics; not the knowledge/ripple graph. */
  async getLegacyGraph(limit = 200, layer?: MemoryLayer): Promise<{ nodes: MemoryNode[]; edges: MemoryEdge[] }> {
    if (!this.db) throw new Error('Database not initialized');
    const layerSql = layer ? `WHERE layer = ?` : ``;
    const nodeRows = await this.db.all<any>(
      `SELECT ${NODE_COLUMNS_NO_EMBEDDING} FROM nodes ${layerSql} ORDER BY created_at DESC LIMIT ?`,
      layer ? [layer, limit] : [limit]
    );
    if (nodeRows.length === 0) return { nodes: [], edges: [] };
    // 知识网络补全（2026-09-18）：窗口=最新 N 节点，但新知识节点的知识-知识边多连向窗外老知识，
    // 边查询要求两端都在窗口内 → 全被裁掉，画布 0 边。把窗外知识对端拉进窗口（上限 limit/3）。
    const ids = nodeRows.map((r: any) => r.id);
    const ph = ids.map(() => '?').join(',');
    const partnerRows = await this.db.all<any>(
      `SELECT DISTINCT ${NODE_COLUMNS_NO_EMBEDDING_N}
       FROM nodes n
       WHERE n.id IN (
         SELECT CASE WHEN e.from_id IN (${ph}) THEN e.to_id ELSE e.from_id END
         FROM edges e WHERE e.from_id IN (${ph}) OR e.to_id IN (${ph})
       )
       AND n.id NOT IN (${ph})
       AND n.dimension != 'event' AND COALESCE(n.layer, 'L1') != 'L0'
       ORDER BY n.created_at DESC LIMIT ?`,
      [...ids, ...ids, ...ids, ...ids, Math.floor(limit / 3)]
    );
    const allRows = [...nodeRows, ...partnerRows];
    const allIds = allRows.map((r: any) => r.id);
    const ph2 = allIds.map(() => '?').join(',');
    const edgeRows = await this.db.all<any>(
      `SELECT id, from_id, to_id, label, weight, created_at FROM edges
       WHERE from_id IN (${ph2}) AND to_id IN (${ph2})
       ORDER BY created_at DESC LIMIT ?`,
      [...allIds, ...allIds, limit * 2]
    );
    return {
      nodes: allRows.map((r: any) => this.rowToNode(r)),
      edges: edgeRows.map((r: any) => this.rowToEdge(r)),
    };
  }

  async getStats(context?:DomainReadContext): Promise<{ total: number; byDimension: Record<Dimension, number>; byLayer: Record<string, number>; bySession: Record<string, number> }> {
    if (!this.db) throw new Error('Database not initialized');
    const domains=context?resolveReadDomains(context):undefined;
    const where=domains?' WHERE ('+domains.map(()=>'(n.domain_kind=? AND n.domain_id=?)').join(' OR ')+") AND (n.domain_kind!='session' OR EXISTS(SELECT 1 FROM memory_domains d WHERE d.kind='session' AND d.id=n.domain_id AND d.status IN ('active','paused')))":'';
    const parameters=domains?.flatMap(d=>[d.kind,d.id])??[];
    const total = await this.db.get<{ c: number }>(`SELECT COUNT(*) as c FROM nodes n${where}`,parameters);
    const dims = await this.db.all<any>(`SELECT j.value AS dimension, COUNT(*) AS c FROM nodes n, json_each(CASE WHEN n.dimensions IS NULL OR n.dimension='event' THEN json_array(n.dimension) ELSE n.dimensions END) j${where} GROUP BY j.value`,parameters);
    const layers = await this.db.all<any>(`SELECT layer, COUNT(*) as c FROM nodes n${where} GROUP BY layer`,parameters);
    const byDim: Record<string, number> = {};
    for (const d of dims) byDim[d.dimension] = d.c;
    const byLayer: Record<string, number> = {};
    for (const l of layers) byLayer[l.layer || 'L1'] = l.c;
    return {
      total: total?.c || 0,
      byDimension: byDim as Record<Dimension, number>,
      byLayer,
      bySession: {},
    };
  }

  async pondIdentity(): Promise<string> {
    return (await this.getMeta('pond_instance_id'))!;
  }

  private async authorizeRecall(recallId:string, context?:DomainReadContext): Promise<void> {
    if(!context)return;
    const row=await this.db!.get<{result_ids:string}>('SELECT result_ids FROM memory_recalls WHERE id=?',[recallId]);
    if(!row)throw new MindPondError('scope_denied','Recall unavailable in current scope');
    for(const entry of JSON.parse(row.result_ids) as Array<{id:string}>) {
      const node=await this.getNodeById(entry.id,{trackAccess:false});
      if(!node)throw new MindPondError('scope_denied','Recall target no longer available in current scope');
      await this.assertNodeInReadableDomains(node,context);
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const timer of this.backgroundTimers) clearTimeout(timer);
    this.backgroundTimers.clear();
    this.closePromise = (async () => {
      await this.collaboration?.closeWaits();
      await this.profileRetrieval?.close();
      this.profileBuildScheduled.clear();
      await this.coordinator.shutdown(async () => {
        await Promise.allSettled([...this.backgroundWork]);
        if (this.db) { await this.db.close(); this.db = null; }
      });
    })();
    return this.closePromise;
  }

  // ============================================
  // Internal
  // ============================================

  /**
   * Row → MemoryNode.
   * `includeEmbedding` decodes the 768-dim BLOB into a JS array — only used
   * by single-node reads (getNodeById). Search/BFS rows don't even SELECT
   * the embedding column, so the vector stays [] on those paths.
   */
  private rowToNode(row: NodeRow, includeEmbedding = false): MemoryNode {
    const dimensions:KnowledgeDimension[]=row.dimensions ? safeParse(row.dimensions,[]) : normalizeDimensions(undefined,row.dimension);
    return {
      dimensions,kind:row.dimension==='event'?'event':'knowledge',
      id: row.id,
      dimension: (row.dimension==='event' ? 'event' : row.primary_dimension&&dimensions.includes(row.primary_dimension)?row.primary_dimension: dimensions.includes(row.dimension as KnowledgeDimension) ? row.dimension : dimensions[0] ?? row.dimension) as Dimension,
      layer: (row.layer || 'L1') as MemoryLayer,
      content: row.content || '',
      embedding: includeEmbedding && row.embedding
        ? this.bufferToVector(row.embedding)
        : [],
      importance: row.importance ?? 5,
      tags: safeParse(row.tags, []),
      verified: row.verified === 1,
      source: row.source || undefined,
      domain: { kind: (row.domain_kind || (row.session_id ? 'session' : 'personal')) as MemoryDomainRef['kind'], id: row.domain_id || row.session_id || 'default' },
      sessionId: row.session_id || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      accessCount: row.access_count ?? 0,
      supersededBy: row.superseded_by ?? undefined,
      ...(row.superseded_by===row.id?{quarantined:true}:{}),
    };
  }

  private rowToEdge(row: any): MemoryEdge {
    return {
      id: row.id,
      fromId: row.from_id,
      toId: row.to_id,
      label: row.label,
      weight: row.weight,
      createdAt: row.created_at,
    };
  }
}

function safeParse(str: string | null, fallback: any): any {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

// Singleton
export const graphMemory = new GraphMemory();
