/**
 * Active Memory Retriever — single GraphMemory backend
 *
 * No more EnhancedMemoryManager. All memory lives in GraphMemory.
 * Four layers map to dimensions:
 *   short-term → session history (passed by caller, not stored here)
 *   long-term  → fact + event dimensions
 *   skills     → nodes tagged 'skill'
 *   lessons    → lesson dimension
 */

import { GraphMemory, type Dimension, type SearchResult } from './graph-memory.js';
import { createModuleLogger } from '../infra/logger.js';
import { getErrorMessage } from '../infra/errors.js';
import { debugTrace } from '../infra/debug-tracer.js';
import { LLMClient } from './llm.js';
import { getEmbeddingService } from './embedding.js';

const logger = createModuleLogger('active-retriever');

// ============================================
// Types
// ============================================

export interface RetrievalContext {
  sessionId: string;
  userQuery: string;
  conversationHistory?: string[];
  maxResults?: number;
}

export interface RetrievalResult {
  byDimension?:Record<string,SearchResult[]>;
  facts: SearchResult[];       // fact/event nodes
  decisions: SearchResult[];   // decision nodes (from graph traversal)
  lessons: SearchResult[];     // lesson nodes
  graphNodes: SearchResult[];  // all results with scores (for debug/display)
  keywords: string[];
}

// ============================================
// Retriever
// ============================================

export class ActiveMemoryRetriever {
  private graphMemory: GraphMemory;
  private llmClient?: LLMClient;

  /**
   * Cross-turn injection dedup (user requirement 2026-09-03: "重复memory不进上下文").
   * Tracks which node ids were injected into context in recent turns, per session.
   * A node already injected within DEDUP_TURNS turns is filtered out — UNLESS its
   * score rose significantly (>= REINJECT_SCORE_BOOST), which means it became much
   * more relevant and deserves the budget again.
   */
  private static readonly DEDUP_TURNS = 5;
  private static readonly REINJECT_SCORE_BOOST = 0.2;
  private injectedHistory = new Map<string, Map<string, { turn: number; score: number }>>();
  private turnCounter = new Map<string, number>();

  constructor(graphMemory: GraphMemory, llmClient?: LLMClient) {
    this.graphMemory = graphMemory;
    this.llmClient = llmClient;
    logger.info('ActiveMemoryRetriever initialized');
  }

  async retrieve(ctx: RetrievalContext): Promise<RetrievalResult> {
    const limit = ctx.maxResults || 10;

    try {
      const turn = (this.turnCounter.get(ctx.sessionId) ?? 0) + 1;
      this.turnCounter.set(ctx.sessionId, turn);
      const history = this.injectedHistory.get(ctx.sessionId) ?? new Map<string, { turn: number; score: number }>();

      // Embed once for a search across all configured identities.
      // On failure, omit it: searches then fall back to text-only matching.
      let embedding: number[] | undefined;
      try {
        embedding = await getEmbeddingService().generateEmbedding(ctx.userQuery);
      } catch { /* embedding service unavailable — continue text-only */ }

      // Search across identities; preserve legacy result fields for older callers.
      const candidates=await this.graphMemory.search({query:ctx.userQuery,embedding,limit,sessionId:ctx.sessionId});
      const facts=candidates.filter(r=>r.node.dimensions?.includes('fact')||r.node.dimension==='event');
      const decisions=candidates.filter(r=>r.node.dimensions?.includes('decision'));
      const lessons=candidates.filter(r=>r.node.dimensions?.includes('lesson'));

      // Cross-turn dedup: drop nodes injected in the last DEDUP_TURNS turns,
      // unless their score rose by >= REINJECT_SCORE_BOOST (much more relevant now).
      const dedup = (results: SearchResult[]): SearchResult[] => results.filter(r => {
        const prev = history.get(r.node.id);
        if (!prev) return true;
        if (turn - prev.turn > ActiveMemoryRetriever.DEDUP_TURNS) return true;
        return r.score >= prev.score + ActiveMemoryRetriever.REINJECT_SCORE_BOOST;
      });

      const dedupedFacts = dedup(facts);
      const dedupedDecisions = dedup(decisions);
      const dedupedLessons = dedup(lessons);
      const dropped = (facts.length + decisions.length + lessons.length)
        - (dedupedFacts.length + dedupedDecisions.length + dedupedLessons.length);
      if (dropped > 0) {
        debugTrace('INJECTION_DEDUP', '🔁', `dropped ${dropped} recently-injected nodes (turn ${turn}, session ${ctx.sessionId})`);
      }

      // Record what actually gets consumed downstream (graphNodes) so the
      // dedup window reflects real injection, not raw search hits.
      const graphNodes = dedup(candidates)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      for (const r of graphNodes) {
        history.set(r.node.id, { turn, score: r.score });
      }
      this.injectedHistory.set(ctx.sessionId, history);

      // `keywords` stays in the result shape for API compatibility, but the
      // LLM keyword extraction was removed — the search pipeline never
      // consumed the keywords.
      return { facts: dedupedFacts, decisions: dedupedDecisions, lessons: dedupedLessons, graphNodes, byDimension:Object.fromEntries([...new Set(graphNodes.flatMap(r=>r.node.dimensions??[]))].map(d=>[d,graphNodes.filter(r=>r.node.dimensions?.includes(d))])), keywords: [] };
    } catch (err: unknown) {
      logger.warn('Retrieval failed, returning empty', getErrorMessage(err));
      return { facts: [], decisions: [], lessons: [], graphNodes: [], keywords: [] };
    }
  }
}

// ============================================
// Factory
// ============================================

let instance: ActiveMemoryRetriever | undefined;
let instanceGraphMemory: GraphMemory | undefined;

export function getActiveMemoryRetriever(
  graphMemory: GraphMemory,
  llmClient?: LLMClient
): ActiveMemoryRetriever {
  // Recreate if a different GraphMemory backend is passed
  if (!instance || instanceGraphMemory !== graphMemory) {
    instance = new ActiveMemoryRetriever(graphMemory, llmClient);
    instanceGraphMemory = graphMemory;
  }
  return instance;
}
