/**
 * Memory Consolidation — L2 aggregation, L3 distillation, nightly maintenance
 * (P3: inspired by TencentDB Agent Memory's sleep/consolidation cycle)
 *
 * L2: Aggregates recent L1 atoms into "scene blocks" (thematic clusters)
 * L3: Distills L2 scenes into a persistent Persona summary
 * Maintenance: decay stale nodes, archive cold L0, report stats
 */

import { GraphMemory, type MemoryNode, type MemoryLayer } from './graph-memory.js';
import { LLMClient } from './llm.js';
import { MindPondError } from './errors.js';
import { createModuleLogger } from '../infra/logger.js';
import crypto from 'node:crypto';

const logger = createModuleLogger('memory-consolidation');

// ─── Config ──────────────────────────────────────────────────────────────────

export interface ConsolidationConfig {
  /** Opt-in legacy scene/persona automation. General profiles use organization synthesize. */
  legacyProfiles: boolean;
  /** Min L1 nodes needed before triggering L2 aggregation */
  l2MinAtoms: number;
  /** Max L1 atoms to feed into one L2 aggregation call */
  l2MaxBatch: number;
  /** Min L2 scenes needed before triggering L3 distillation */
  l3MinScenes: number;
  /** Decay: nodes older than this (ms) get importance reduced */
  decayOlderThanMs: number;
  /** Decay factor per maintenance run */
  decayFactor: number;
  /** Archive L0 older than this (ms) with 0 access */
  archiveOlderThanMs: number;
  /** Safety: keep at least this many active L0 nodes */
  archiveMinKeep: number;
  /** Nightly edge weaving: relate today's nodes to each other + old knowledge */
  weaveEnabled: boolean;
  /** Weaving window: nodes created within this period are "today's material" */
  weaveWindowMs: number;
  /** Max recent nodes fed into one weave call */
  weaveMaxNodes: number;
  /** Throttle: skip weaving if last run was within this period (runFullCycle path) */
  weaveMinIntervalMs: number;
  /** L3 persona re-distillation: re-run at least this often (ms) even when no
   *  new L2 scenes triggered it. Checked by nightly maintenance. */
  l3RedistillIntervalMs: number;
  /** Nightly edge review: how many edges the LLM re-rates per run.
   *  A persisted cursor rotates through the whole edges table. */
  edgeReviewBatchSize: number;
  /**
   * Noise filter (host-supplied): nodes whose first 200 chars match this regex
   * are excluded from edge weaving (e.g. host's own test residue).
   * Default: undefined — no filtering.
   */
  testContentPattern?: string;
}

const DEFAULT_CONFIG: ConsolidationConfig = {
  legacyProfiles: false,
  l2MinAtoms: 8,
  l2MaxBatch: 30,
  l3MinScenes: 3,
  decayOlderThanMs: 30 * 24 * 3600 * 1000, // 30 days
  decayFactor: 0.9,
  archiveOlderThanMs: 90 * 24 * 3600 * 1000, // 90 days
  archiveMinKeep: 50,
  weaveEnabled: true,
  weaveWindowMs: 24 * 3600 * 1000,
  weaveMaxNodes: 20,
  weaveMinIntervalMs: 4 * 3600 * 1000, // 4h — daytime cycles throttle, nightly always runs
  l3RedistillIntervalMs: 7 * 24 * 3600 * 1000, // 7 days — persona refresh cadence
  edgeReviewBatchSize: 12, // ~300 edges ≈ fully re-rated every month
};

// ─── Consolidation Engine ─────────────────────────────────────────────────────

export class MemoryConsolidation {
  private graphMemory: GraphMemory;
  private llmClient?: LLMClient;
  private config: ConsolidationConfig;
  private running = false;
  private lastWeaveAt = 0;
  /** Two-phase mode: node ids already offered/committed this weave window. */
  private weaveProcessed = new Set<string>();
  /** Candidate ids are server-issued capability data. Never trust a client to
   * submit arbitrary memory ids in a weave commit. */
  private weaveOffers = new Map<string, { candidateIds: string[]; expiresAt: number }>();
  private l2Offers = new Map<string, { atoms: MemoryNode[]; expiresAt: number }>();
  private l3Offers = new Map<string, { scenes: MemoryNode[]; existing: MemoryNode | null; expiresAt: number }>();
  /** Serializes asynchronous offer selection so two HTTP/MCP clients cannot
   * receive the same nodes before either offer is recorded. */
  private offerLock: Promise<void> = Promise.resolve();
  /** Rolling anchor for weaveProcessed — the set resets each weave window so it stays bounded. */
  private weaveWindowStartedAt = Date.now();
  /** Lazily compiled from config.testContentPattern. */
  private noiseRegex?: RegExp;

  constructor(graphMemory: GraphMemory, llmClient?: LLMClient, config?: Partial<ConsolidationConfig>) {
    this.graphMemory = graphMemory;
    this.llmClient = llmClient;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Host-configurable noise filter for weave candidates (default: no filtering). */
  private isNoise(content: string): boolean {
    if (!this.config.testContentPattern) return false;
    if (!this.noiseRegex) this.noiseRegex = new RegExp(this.config.testContentPattern, 'i');
    return this.noiseRegex.test(content.slice(0, 200));
  }

  private async withOfferLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.offerLock;
    let release!: () => void;
    this.offerLock = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  // ─── L2: Scene Aggregation ─────────────────────────────────────────────────

  /**
   * Aggregate ungrouped L1 atoms into L2 scene blocks.
   * Uses LLM to cluster atoms by theme/topic.
   */
  async aggregateL2(): Promise<number> {
    if (!this.llmClient) return 0; // service mode: L2 aggregation runs via host-driven flow
    if (this.running) return 0;
    this.running = true;

    try {
      const batch = await this.buildL2Batch();
      if (!batch) return 0;
      // 思考模型（glm-5.3 系强制思考）：预算须容纳 reasoning + JSON 正文
      const response = await this.llmClient!.chat(
        [{ role: 'user', content: batch.prompt }],
        { temperature: 0.1, maxTokens: 131072, maxThinkingTokens: 2000 }
      );
      return (await this.commitL2Batch(batch.batchId, response.choices?.[0]?.message?.content ?? '')).scenes;
    } catch (err) {
      logger.error(`L2 aggregation failed: ${err}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  // ─── L3: Persona Distillation ──────────────────────────────────────────────

  /**
   * Distill L2 scenes into a single L3 Persona node (long-term user profile).
   * Updates existing L3 node if present, creates new one otherwise.
   */
  async distillL3(): Promise<boolean> {
    if (!this.llmClient) return false; // service mode: L3 distillation runs via host-driven flow
    if (this.running) return false;
    this.running = true;

    try {
      const batch = await this.buildL3Batch();
      if (!batch) return false;

      const response = await this.llmClient!.chat(
        [{ role: 'user', content: batch.prompt }],
        { temperature: 0.2, maxTokens: 131072, maxThinkingTokens: 3000 }
      );
      return (await this.commitL3Batch(batch.batchId, response.choices?.[0]?.message?.content ?? '')).completed;
    } catch (err) {
      logger.error(`L3 distillation failed: ${err}`);
      return false;
    } finally {
      this.running = false;
    }
  }

  // ─── Two-phase L2/L3 API (service mode: MindPond proposes, host LLM judges) ─

  /** Claim a bounded, single-session L1 batch for L2 aggregation. */
  async buildL2Batch(): Promise<{
    batchId: string;
    atoms: Array<{ idx: number; id: string; content: string }>;
    prompt: string;
  } | null> {
    return this.withOfferLock(() => this.buildL2BatchUnlocked());
  }

  private async buildL2BatchUnlocked(): Promise<{
    batchId: string;
    atoms: Array<{ idx: number; id: string; content: string }>;
    prompt: string;
  } | null> {
    this.clearExpiredConsolidationOffers();
    const offered = new Set([...this.l2Offers.values()].flatMap(offer => offer.atoms.map(node => node.id)));
    const allL1 = await this.graphMemory.getL1NodesSince(0, 2000);
    // `aggregates` is directed L1 → L2, so inspect edge sources, not targets.
    const grouped = await this.graphMemory.getEdgeSources(
      (await this.graphMemory.getNodesByLayer('L2', 2000)).map(node => node.id),
      'aggregates'
    );
    const bySession = new Map<string, MemoryNode[]>();
    for (const node of allL1) {
      if (grouped.has(node.id) || node.supersededBy || offered.has(node.id)) continue;
      const key = node.sessionId ?? '__global__';
      const group = bySession.get(key) ?? [];
      group.push(node);
      bySession.set(key, group);
    }
    const atoms = [...bySession.values()]
      .filter(group => group.length >= this.config.l2MinAtoms)
      .sort((a, b) => a[0].createdAt - b[0].createdAt)[0]
      ?.slice(0, this.config.l2MaxBatch);
    if (!atoms || atoms.length < this.config.l2MinAtoms) return null;

    const batchId = crypto.randomUUID();
    this.l2Offers.set(batchId, { atoms, expiresAt: Date.now() + 10 * 60_000 });
    return {
      batchId,
      atoms: atoms.map((node, idx) => ({ idx, id: node.id, content: node.content })),
      prompt: this.buildL2Prompt(atoms.map((node, idx) => `[${idx}] ${node.content}`).join('\n')),
    };
  }

  /** Apply a response only to the exact L1 atoms issued in buildL2Batch().
   * R04: the commit never consumes the offer before its own preconditions
   * hold — an invalid reply keeps the batch held (correctable retry on the
   * same batchId), and a source atom edited/superseded since build time is
   * rejected as stale instead of weaving scenes into a moved foundation. */
  async commitL2Batch(batchId: string, reply: string): Promise<{ scenes: number; completed: boolean }> {
    this.clearExpiredConsolidationOffers();
    const offer = this.l2Offers.get(batchId);
    if (!offer) {
      throw new MindPondError('stale_lease', 'L2 batch is missing or expired; retrieve a new L2 batch', {
        retryable: true, nextAction: '重新 GET /api/consolidate/l2/batch 领取新批次；不要复用旧 batchId',
      });
    }
    for (const atom of offer.atoms) {
      const current = await this.graphMemory.getNodeById(atom.id, { trackAccess: false });
      if (!current || current.supersededBy || current.content !== atom.content) {
        this.l2Offers.delete(batchId);
        throw new MindPondError('stale_version', `L2 source atom ${atom.id} changed since the batch was issued`, {
          retryable: true, nextAction: '重新领取 L2 批次后按最新源内容重做；旧 batchId 已作废',
        });
      }
    }
    const parsed = this.parseL2Response(reply);
    if (parsed === null) {
      throw new MindPondError('invalid_input', 'L2 reply is not a valid scenes JSON object', {
        field: 'reply', nextAction: '按批次提示词的输出契约修正回复后，向同一 batchId 重新提交；批次仍被保留',
      });
    }
    const used = new Set<number>();
    let created = 0;
    for (const scene of parsed) {
      const indices = [...new Set(scene.atomIndices)]
        .filter(idx => Number.isInteger(idx) && idx >= 0 && idx < offer.atoms.length && !used.has(idx));
      if (indices.length === 0 || !scene.summary.trim() || scene.summary.length > 8_000) continue;
      indices.forEach(idx => used.add(idx));
      const l2Node = await this.graphMemory.createNode({
        dimension: 'event', layer: 'L2', content: scene.summary.trim(), importance: 7,
        tags: ['scene', scene.theme.trim().slice(0, 120) || 'untitled'], sessionId: offer.atoms[0].sessionId,
      });
      for (const idx of indices) await this.graphMemory.createEdge(offer.atoms[idx].id, l2Node.id, 'aggregates', 0.7);
      created++;
    }
    this.l2Offers.delete(batchId);
    if (created > 0) logger.info(`L2 aggregation: created ${created} scene(s) from ${offer.atoms.length} L1 atoms`);
    return { scenes: created, completed: true };
  }

  /** Claim global L2 scenes for persona distillation. Scoped scenes never enter a global persona. */
  async buildL3Batch(): Promise<{
    batchId: string;
    scenes: Array<{ idx: number; id: string; content: string }>;
    existing: { id: string; content: string } | null;
    prompt: string;
  } | null> {
    return this.withOfferLock(() => this.buildL3BatchUnlocked());
  }

  private async buildL3BatchUnlocked(): Promise<{
    batchId: string;
    scenes: Array<{ idx: number; id: string; content: string }>;
    existing: { id: string; content: string } | null;
    prompt: string;
  } | null> {
    this.clearExpiredConsolidationOffers();
    if (this.l3Offers.size > 0) return null;
    const scenes = await this.graphMemory.getUnscopedNodesByLayer('L2', 50);
    if (scenes.length < this.config.l3MinScenes) return null;
    const existing = (await this.graphMemory.getUnscopedNodesByLayer('L3', 1))[0] ?? null;
    const batchId = crypto.randomUUID();
    this.l3Offers.set(batchId, { scenes, existing, expiresAt: Date.now() + 10 * 60_000 });
    return {
      batchId,
      scenes: scenes.map((scene, idx) => ({ idx, id: scene.id, content: scene.content })),
      existing: existing ? { id: existing.id, content: existing.content } : null,
      prompt: this.buildL3Prompt(scenes.map((scene, idx) => `[scene-${idx}] ${scene.content}`).join('\n'), existing?.content ?? ''),
    };
  }

  /** Persist an issued L3 persona response. R04: same offer discipline as L2 —
   * stale scene/persona sources are rejected as stale_version (offer voided),
   * an invalid persona reply keeps the offer held for a corrected retry. */
  async commitL3Batch(batchId: string, reply: string): Promise<{ completed: boolean }> {
    this.clearExpiredConsolidationOffers();
    const offer = this.l3Offers.get(batchId);
    if (!offer) {
      throw new MindPondError('stale_lease', 'L3 batch is missing or expired; retrieve a new L3 batch', {
        retryable: true, nextAction: '重新 GET /api/consolidate/l3/batch 领取新批次；不要复用旧 batchId',
      });
    }
    for (const scene of offer.scenes) {
      const current = await this.graphMemory.getNodeById(scene.id, { trackAccess: false });
      if (!current || current.supersededBy || current.content !== scene.content) {
        this.l3Offers.delete(batchId);
        throw new MindPondError('stale_version', `L3 source scene ${scene.id} changed since the batch was issued`, {
          retryable: true, nextAction: '重新领取 L3 批次后按最新场景重做；旧 batchId 已作废',
        });
      }
    }
    if (offer.existing) {
      const current = await this.graphMemory.getNodeById(offer.existing.id, { trackAccess: false });
      if (!current || current.supersededBy || current.content !== offer.existing.content) {
        this.l3Offers.delete(batchId);
        throw new MindPondError('stale_version', 'existing persona changed since the batch was issued', {
          retryable: true, nextAction: '重新领取 L3 批次，基于最新画像修订；旧 batchId 已作废',
        });
      }
    }
    const persona = reply.trim();
    if (persona.length < 20 || persona.length > 16_000) {
      throw new MindPondError('invalid_input', `persona text must be 20–16000 characters (got ${persona.length})`, {
        field: 'reply', nextAction: '修正画像正文后向同一 batchId 重新提交；批次仍被保留',
      });
    }
    if (offer.existing) {
      await this.graphMemory.updateNodeContent(offer.existing.id, persona);
      logger.info(`L3 persona updated (${persona.length} chars)`);
    } else {
      const l3Node = await this.graphMemory.createNode({ dimension: (await this.graphMemory.getDimensionConfiguration()).defaultDimension, layer: 'L3', content: persona, importance: 10, tags: ['persona'] });
      for (const scene of offer.scenes) await this.graphMemory.createEdge(scene.id, l3Node.id, 'distills', 0.8);
      logger.info(`L3 persona created (${persona.length} chars)`);
    }
    this.l3Offers.delete(batchId);
    await this.graphMemory.setMeta('l3_last_distill_at', String(Date.now()));
    return { completed: true };
  }

  private clearExpiredConsolidationOffers(): void {
    const now = Date.now();
    for (const [id, offer] of this.l2Offers) if (offer.expiresAt < now) this.l2Offers.delete(id);
    for (const [id, offer] of this.l3Offers) if (offer.expiresAt < now) this.l3Offers.delete(id);
  }

  /** True when the L3 persona hasn't been distilled within l3RedistillIntervalMs. */
  private async l3Due(): Promise<boolean> {
    const last = Number((await this.graphMemory.getMeta('l3_last_distill_at')) ?? 0);
    return Date.now() - last >= this.config.l3RedistillIntervalMs;
  }

  // ─── Nightly Edge Weaving (Graph Integration) ─────────────────────────────

  /**
   * Weave semantic edges between recent nodes and existing knowledge.
   * This is what makes the graph "learn from experience": today's problems,
   * solutions, and facts get connected to older related memories, so future
   * ripple retrieval can walk from a symptom straight to its fix.
   *
   * Two passes per recent node:
   *   1. Candidate recall: graph search (hybrid ANN+ngram) for related old nodes
   *   2. LLM judgment: which candidates are genuinely related, and how
   *
   * Edge direction: from NEW node → OLD node (BFS ripples follow from→to,
   * so hitting today's memory pulls in the historical answer it needs).
   */
  async weaveEdges(force = false): Promise<{ candidates: number; woven: number }> {
    if (!this.llmClient) return { candidates: 0, woven: 0 }; // service mode: weaving runs via /api/weave/batch+commit
    if (!this.config.weaveEnabled) return { candidates: 0, woven: 0 };
    if (this.running) return { candidates: 0, woven: 0 };
    // Throttle: daytime full-cycles skip if woven recently; nightly maintenance forces
    if (!force && Date.now() - this.lastWeaveAt < this.config.weaveMinIntervalMs) {
      logger.debug('Weave throttled: last run too recent');
      return { candidates: 0, woven: 0 };
    }
    this.running = true;

    try {
      const since = Date.now() - this.config.weaveWindowMs;
      const recent = await this.graphMemory.getRecentNodes(since, this.config.weaveMaxNodes);
      if (recent.length < 2) {
        logger.info(`Weave skip: only ${recent.length} recent node(s)`);
        return { candidates: 0, woven: 0 };
      }

      // 过滤噪声节点（host 通过 config.testContentPattern 配置；默认不过滤）
      const meaningful = recent.filter(n => !this.isNoise(n.content));
      if (meaningful.length < 2) {
        logger.info(`Weave skip: only ${meaningful.length} meaningful node(s) after noise filter (${recent.length - meaningful.length} filtered)`);
        return { candidates: 0, woven: 0 };
      }

      let candidates = 0;
      let woven = 0;

      for (const node of meaningful) {
        // Recall candidates via hybrid search (degrades to ngram if embeddings empty).
        // R04: candidates are recalled inside the node's lawful read scope — a
        // session-scoped node recalls its own session plus personal, a personal
        // node recalls personal. The default (no context) search reads personal
        // only and would silently never see session material.
        let related: { id: string; content: string }[] = [];
        try {
          const hits = await this.graphMemory.search({
            query: node.content,
            limit: 8,
            minScore: 0.15, // low bar — let the LLM filter
            ...(node.sessionId ? { sessionId: node.sessionId } : {}),
          });
          related = hits
            .filter(h => h.node.id !== node.id)
            .map(h => ({ id: h.node.id, content: h.node.content }));
        } catch {
          logger.warn(`Weave: search failed for node ${node.id.slice(0, 8)}, skipping recall`);
        }

        if (related.length === 0) continue;
        candidates += related.length;

        // LLM judges which candidates deserve an edge, and what kind
        const prompt = this.buildWeavePrompt(node, related);
        let response: any;
        try {
          response = await this.llmClient!.chat(
            [{ role: 'user', content: prompt }],
            { temperature: 0.1, maxTokens: 131072, maxThinkingTokens: 2000 }
          );
        } catch (err) {
          logger.warn(`Weave: LLM call failed for node ${node.id.slice(0, 8)}: ${err}`);
          continue;
        }

        const raw = response.choices?.[0]?.message?.content ?? '';
        const links = this.parseWeaveResponse(raw, node.id, related.map(r => r.id));
        for (const link of links) {
          try {
            if (await this.applyContextualWeave(link.from, link.to, link)) woven++;
          } catch (err) {
            logger.warn(`Weave: edge create failed: ${err}`);
          }
        }
      }

      logger.info(`🕸️ Edge weaving: ${meaningful.length} meaningful nodes (${recent.length - meaningful.length} test noise filtered), ${candidates} candidates, ${woven} edges woven`);
      this.lastWeaveAt = Date.now();
      return { candidates, woven };
    } finally {
      this.running = false;
    }
  }

  /**
   * R04/T21: apply one judged link at an explicit location. A relation between
   * two nodes sharing several (space, memoryType) memberships is legal — it is
   * placed at the location the caller names, or deterministically at the oldest
   * shared membership when no placement is supplied. It is never silently
   * dropped as "ambiguous" and never judged invalid for being multi-dimensional.
   */
  private async applyWeaveLink(
    fromId: string, toId: string,
    link: { label: string; weight: number; reason?: string; context?: string; spaceId?: string; memoryType?: string },
  ): Promise<{ status: 'applied'; spaceId: string; memoryType: string } | { status: 'skipped'; reason: string }> {
    // The compatibility route cannot infer supersession from an apparent
    // contradiction: differences may be conditional. Use the scoped organizer.
    if (link.label === 'contradicts') {
      return { status: 'skipped', reason: 'legacy weave route does not apply contradicts; use the organization flow for conditional supersession' };
    }
    this.graphMemory.validateAssociationBasis({ reason: link.reason!, context: link.context! });
    const [a, b] = await Promise.all([
      this.graphMemory.getMemberships(fromId, { activeOnly: true }),
      this.graphMemory.getMemberships(toId, { activeOnly: true }),
    ]);
    const common = a.flatMap(x => b.filter(y => x.spaceId === y.spaceId && x.memoryType === y.memoryType).map(y => ({ x, y })));
    if (common.length === 0) {
      return { status: 'skipped', reason: 'no shared active membership in the same space and memory type' };
    }
    // getMemberships orders by created_at ASC — common[0] is the oldest, stable choice.
    let chosen = common[0];
    if (link.spaceId !== undefined || link.memoryType !== undefined) {
      const match = common.find(c => c.x.spaceId === link.spaceId && c.x.memoryType === link.memoryType);
      if (!match) {
        throw new MindPondError('invalid_input',
          `requested weave placement ${link.spaceId}/${link.memoryType} is not a shared membership of both nodes`, {
          field: 'links.spaceId', nextAction: '从两个节点共同拥有的 space/memoryType 中选择位置，或省略位置字段由服务选择最旧的共同成员身份；批次仍被保留',
        });
      }
      chosen = match;
    }
    await this.graphMemory.upsertAssociation(chosen.x.id, chosen.y.id, chosen.x.spaceId, chosen.x.memoryType, link.weight, { reason: link.reason!, context: link.context! });
    return { status: 'applied', spaceId: chosen.x.spaceId, memoryType: chosen.x.memoryType };
  }

  /** In-process weaveEdges shim: boolean view of applyWeaveLink. */
  private async applyContextualWeave(fromId: string, toId: string, link: { label: string; weight: number; reason?: string; context?: string; spaceId?: string; memoryType?: string }): Promise<boolean> {
    const outcome = await this.applyWeaveLink(fromId, toId, link);
    if (outcome.status === 'skipped') logger.info(`Weave skip: ${outcome.reason}`);
    return outcome.status === 'applied';
  }

  private buildWeavePrompt(node: { content: string }, related: { id: string; content: string }[]): string {
    const relatedText = related.map((r, i) => `[${i}] ${r.content}`).join('\n');
    return `你是记忆图谱的管理员。判断下面哪些旧记忆与新记忆有真实关联。

新记忆: ${node.content}

候选旧记忆:
${relatedText}

规则:
- 只连接在具体任务中共同回想有实际价值的记忆；同项目、同主题本身不构成依据
- 每条关联必须写 reason（共同回想的具体价值与观察依据）和 context（可脱离对话理解的适用场景、对象、条件与例外），禁止编造缺失背景
- 原场景缺失或只有表面矛盾时暂缓，不以当前任务不同为由否定历史关联
- label 从这些里选: related, similar-to, caused-by, fixes, supports, contradicts
- 本兼容接口不处理 contradicts；请交给有完整范围和来源的 organization 流程确认条件，不自动覆盖旧事实
- weight: 0.3-0.9, 关联越强越高
- 没有真实关联就返回空数组

必须只输出 JSON，不要任何解释文字；无关联时输出 {"links":[]}
输出格式:
{"links":[{"idx":0,"label":"related","weight":0.5,"reason":"一起回想的具体价值","context":"完整适用条件及例外"}]}`;
  }

  private parseWeaveResponse(raw: string, fromNodeId: string, candidateIds: string[]): { from: string; to: string; label: string; weight: number; reason: string; context: string }[] {
    try {
      // 容错提取：思考模型可能输出解释文字+JSON 混合体，从中挖出第一个 {..} 块
      let cleaned = raw.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim();
      if (!cleaned.startsWith('{')) {
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start >= 0 && end > start) {
          cleaned = cleaned.slice(start, end + 1);
        }
      }
      const parsed = JSON.parse(cleaned);
      const links = parsed.links;
      if (!Array.isArray(links)) return [];
      return links
        .filter((l: any) => typeof l.idx === 'number' && l.idx >= 0 && l.idx < candidateIds.length)
        .filter((l: any) => typeof l.label === 'string' && Number.isFinite(l.weight) && typeof l.reason === 'string' && !!l.reason.trim() && typeof l.context === 'string' && !!l.context.trim())
        .map((l: any) => ({
          from: fromNodeId,
          to: candidateIds[l.idx],
          label: l.label,
          weight: Math.max(0.1, Math.min(0.95, l.weight)), reason: l.reason, context: l.context,
        }));
    } catch {
      logger.warn(`Weave response parse failed (raw head: ${raw.slice(0, 120)})`);
      return [];
    }
  }

  // ─── Two-phase weave API (service mode: MindPond proposes, host LLM judges) ──

  /**
   * Build one weave batch: a meaningful recent node + its nearest candidates +
   * the judgment prompt. The host LLM answers; commitWeaveVerdicts() applies.
   * Returns null when there is nothing to weave right now.
   */
  async buildWeaveBatch(): Promise<{
    nodeId: string; nodeContent: string;
    candidates: Array<{ idx: number; id: string; content: string }>;
    prompt: string;
  } | null> {
    return this.withOfferLock(() => this.buildWeaveBatchUnlocked());
  }

  private async buildWeaveBatchUnlocked(): Promise<{
    nodeId: string; nodeContent: string;
    candidates: Array<{ idx: number; id: string; content: string }>;
    prompt: string;
  } | null> {
    const now = Date.now();
    for (const [id, offer] of this.weaveOffers) if (offer.expiresAt < now) this.weaveOffers.delete(id);
    // Roll the processed-set with the weave window: keeps it bounded and lets
    // nodes become eligible again in the next window.
    if (Date.now() - this.weaveWindowStartedAt >= this.config.weaveWindowMs) {
      this.weaveProcessed.clear();
      this.weaveWindowStartedAt = Date.now();
    }
    const since = Date.now() - this.config.weaveWindowMs;
    const recent = await this.graphMemory.getRecentNodes(since, this.config.weaveMaxNodes);
    const meaningful = recent.filter(n => !this.isNoise(n.content));

    for (const node of meaningful) {
      // Skip nodes already processed by the two-phase flow this window
      if (this.weaveProcessed.has(node.id) || this.weaveOffers.has(node.id)) continue;
      let related: { id: string; content: string }[] = [];
      try {
        const hits = await this.graphMemory.search({
          query: node.content, limit: 8, minScore: 0.15, // low bar — let the LLM filter
          // R04: recall within the node's own domain context — session nodes
          // must see their session siblings, not just personal defaults.
          ...(node.sessionId ? { sessionId: node.sessionId } : {}),
        });
        related = hits.filter(h => h.node.id !== node.id).map(h => ({ id: h.node.id, content: h.node.content }));
      } catch {
        continue;
      }
      if (related.length === 0) { this.weaveProcessed.add(node.id); continue; }
      const prompt = this.buildWeavePrompt(node, related);
      this.weaveOffers.set(node.id, { candidateIds: related.map(item => item.id), expiresAt: Date.now() + 10 * 60_000 });
      return {
        nodeId: node.id,
        nodeContent: node.content,
        candidates: related.map((r, idx) => ({ idx, id: r.id, content: r.content })),
        prompt,
      };
    }
    return null;
  }

  /**
   * Commit the host LLM's weave verdicts for one node. R04: the offer is a
   * server-issued capability and is consumed exactly once — after every link
   * has been validated and resolved. Shape/basis/placement errors throw before
   * any mutation and keep the offer held so the host can correct and resubmit
   * to the same nodeId; an accepted verdict (including an empty one or one
   * whose links are all skipped with reasons) consumes it. upsertAssociation
   * is idempotent, so a retry after a mid-apply failure never duplicates edges.
   */
  async commitWeaveVerdicts(
    nodeId: string,
    links: Array<{ idx: number; label: string; weight: number; reason?: string; context?: string; spaceId?: string; memoryType?: string }>,
    candidateIds: string[],
  ): Promise<{ woven: number; applied: Array<{ idx: number; spaceId: string; memoryType: string }>; skipped: Array<{ idx: number; reason: string }> }> {
    const offer = this.weaveOffers.get(nodeId);
    if (!offer || offer.expiresAt < Date.now()) {
      this.weaveOffers.delete(nodeId);
      throw new MindPondError('stale_lease', 'weave batch is missing, expired, or does not match its issued candidates', {
        retryable: true, nextAction: '重新 GET /api/weave/batch 领取新批次；不要复用旧 nodeId',
      });
    }
    if (offer.candidateIds.length !== candidateIds.length ||
      offer.candidateIds.some((id, index) => id !== candidateIds[index])) {
      throw new MindPondError('invalid_input', 'candidateIds do not match the issued weave batch', {
        field: 'candidateIds', nextAction: '原样回传批次签发的 candidateIds 后向同一 nodeId 重新提交；批次仍被保留',
      });
    }
    // Pass 1 — validate every link before touching the graph.
    const validated = links.map((link, position) => {
      const field = `links[${position}]`;
      if (typeof link?.idx !== 'number' || !Number.isInteger(link.idx) || link.idx < 0 || link.idx >= candidateIds.length) {
        throw new MindPondError('invalid_input', `link idx must be an integer within 0..${candidateIds.length - 1}`, {
          field: `${field}.idx`, nextAction: '按签发的 candidateIds 修正 idx 后向同一 nodeId 重新提交；批次仍被保留',
        });
      }
      if (typeof link.label !== 'string' || !link.label.trim()) {
        throw new MindPondError('invalid_input', 'label (non-empty string) required', { field: `${field}.label`, nextAction: '补充 label 后向同一 nodeId 重新提交；批次仍被保留' });
      }
      if (typeof link.weight !== 'number' || !Number.isFinite(link.weight)) {
        throw new MindPondError('invalid_input', 'weight (finite number) required', { field: `${field}.weight`, nextAction: '补充 weight 后向同一 nodeId 重新提交；批次仍被保留' });
      }
      if (typeof link.reason !== 'string' || !link.reason.trim() || typeof link.context !== 'string' || !link.context.trim()) {
        throw new MindPondError('invalid_input', 'association reason and context are required (1–2000 characters each)', {
          field: `${field}.reason`, nextAction: '按共同回想价值补全 reason 与适用条件 context 后向同一 nodeId 重新提交；批次仍被保留',
        });
      }
      if ((link.spaceId !== undefined) !== (link.memoryType !== undefined)) {
        throw new MindPondError('invalid_input', 'placement requires spaceId and memoryType together', {
          field: `${field}.spaceId`, nextAction: '同时提供 spaceId 与 memoryType，或两者都省略；批次仍被保留',
        });
      }
      return {
        idx: link.idx,
        to: candidateIds[link.idx],
        label: link.label,
        weight: Math.max(0.1, Math.min(0.95, link.weight)),
        reason: link.reason,
        context: link.context,
        spaceId: link.spaceId,
        memoryType: link.memoryType,
      };
    });
    // Pass 2 — resolve placements read-only, so a bad placement rejects the
    // verdict before any association is written.
    const resolved: Array<{
      v: typeof validated[number];
      placement: { spaceId: string; memoryType: string; memberA: string; memberB: string } | null;
      skipReason?: string;
    }> = [];
    for (const v of validated) {
      if (v.label === 'contradicts') {
        resolved.push({ v, placement: null, skipReason: 'legacy weave route does not apply contradicts; use the organization flow for conditional supersession' });
        continue;
      }
      const [a, b] = await Promise.all([
        this.graphMemory.getMemberships(nodeId, { activeOnly: true }),
        this.graphMemory.getMemberships(v.to, { activeOnly: true }),
      ]);
      const common = a.flatMap(x => b.filter(y => x.spaceId === y.spaceId && x.memoryType === y.memoryType).map(y => ({ x, y })));
      if (common.length === 0) {
        resolved.push({ v, placement: null, skipReason: 'no shared active membership in the same space and memory type' });
        continue;
      }
      let chosen = common[0]; // oldest shared membership — deterministic default
      if (v.spaceId !== undefined && v.memoryType !== undefined) {
        const match = common.find(c => c.x.spaceId === v.spaceId && c.x.memoryType === v.memoryType);
        if (!match) {
          throw new MindPondError('invalid_input',
            `requested weave placement ${v.spaceId}/${v.memoryType} is not a shared membership of both nodes`, {
            field: 'links.spaceId', nextAction: '从两个节点共同拥有的 space/memoryType 中选择位置，或省略位置字段由服务选择最旧的共同成员身份；批次仍被保留',
          });
        }
        chosen = match;
      }
      resolved.push({
        v,
        placement: { spaceId: chosen.x.spaceId, memoryType: chosen.x.memoryType, memberA: chosen.x.id, memberB: chosen.y.id },
      });
    }
    // Pass 3 — apply. Only now may the offer be consumed.
    const applied: Array<{ idx: number; spaceId: string; memoryType: string }> = [];
    const skipped: Array<{ idx: number; reason: string }> = [];
    for (const entry of resolved) {
      if (!entry.placement) {
        skipped.push({ idx: entry.v.idx, reason: entry.skipReason! });
        continue;
      }
      const { memberA, memberB, ...placement } = entry.placement;
      await this.graphMemory.upsertAssociation(memberA, memberB, placement.spaceId, placement.memoryType, entry.v.weight, { reason: entry.v.reason, context: entry.v.context });
      applied.push({ idx: entry.v.idx, spaceId: placement.spaceId, memoryType: placement.memoryType });
    }
    this.weaveOffers.delete(nodeId);
    this.weaveProcessed.add(nodeId);
    this.lastWeaveAt = Date.now();
    if (applied.length > 0) logger.info(`Weave commit: ${applied.length} applied, ${skipped.length} skipped for node ${nodeId.slice(0, 8)}`);
    return { woven: applied.length, applied, skipped };
  }

  // ─── Nightly Edge Review (attention hygiene) ──────────────────────────────
  // User design 2026-09-05: edge weights are NOT reinforced by traversal —
  // they're fixed relevance scores. But the LLM can periodically re-rate a
  // rotating batch during nightly maintenance and nudge weights with smoothing
  // (new = 0.7*old + 0.3*llm), so a single review never swings an edge wildly.

  /**
   * In-process edge review: LLM re-rates one rotating batch, weights nudged.
   * Service mode (no llmClient): no-op — the host drives the two-phase
   * buildEdgeReviewBatch / commitEdgeReviewVerdicts flow instead.
   */
  async reviewEdgeWeights(): Promise<number> {
    if (!this.llmClient) {
      logger.debug('Edge review skipped — no LLM client (service mode: use /api/edges/review/*)');
      return 0;
    }
    const batch = await this.buildEdgeReviewBatch();
    if (!batch) return 0;
    let response: any;
    try {
      response = await this.llmClient.chat(
        [{ role: 'user', content: batch.prompt }],
        { temperature: 0.1, maxTokens: 131072, maxThinkingTokens: 2000 }
      );
    } catch (err) {
      logger.warn(`Edge review: LLM call failed: ${err}`);
      return 0;
    }
    const raw = response.choices?.[0]?.message?.content ?? '';
    const verdicts = this.parseEdgeReviewResponse(raw, batch.items.length);
    return this.commitEdgeReviewVerdicts(batch.items, verdicts);
  }

  /**
   * Two-phase, step 1: pick the next batch of edges (cursor persisted in
   * memory_meta rotates through the whole table) + build the re-rating prompt.
   */
  async buildEdgeReviewBatch(): Promise<{
    items: Array<{ idx: number; edgeId: string; label: string; weight: number; fromContent: string; toContent: string }>;
    prompt: string;
  } | null> {
    const size = this.config.edgeReviewBatchSize;
    let cursor = Number((await this.graphMemory.getMeta('edge_review_cursor')) ?? 0);
    let rows = await this.graphMemory.listEdgesWithEndpoints(cursor, size);
    if (rows.length === 0 && cursor > 0) {
      // Wrapped past the last row — restart from the top.
      rows = await this.graphMemory.listEdgesWithEndpoints(0, size);
    }
    if (rows.length === 0) return null;
    // Short page means we hit the end: next run wraps to 0.
    const nextCursor = rows.length < size ? 0 : rows[rows.length - 1].rid;
    await this.graphMemory.setMeta('edge_review_cursor', String(nextCursor));

    const items = rows.map((r, idx) => ({
      idx,
      edgeId: r.edge.id,
      label: r.edge.label,
      weight: r.edge.weight,
      fromContent: r.fromContent,
      toContent: r.toContent,
    }));
    return { items, prompt: this.buildEdgeReviewPrompt(items) };
  }

  /**
   * Two-phase, step 2: apply the LLM's relevance scores with smoothing.
   * The smoothing base is the edge's CURRENT weight in the DB — the batch
   * snapshot may be stale (weave could have reinforced the edge in between).
   * Deltas < 0.03 are ignored as noise. Returns how many edges changed.
   * Every change is audited as edge_reweighted in memory_action_log.
   */
  async commitEdgeReviewVerdicts(
    items: Array<{ idx: number; edgeId: string; label: string; weight: number }>,
    verdicts: Array<{ idx: number; score: number }>
  ): Promise<number> {
    if (verdicts.length) logger.debug('Legacy score-only review deferred: use memory_association_review or organization with full contextual evidence');
    return 0;
  }

  private buildEdgeReviewPrompt(items: Array<{ idx: number; label: string; weight: number; fromContent: string; toContent: string }>): string {
    const edgesText = items.map(i =>
      `[${i}] (${i.label}, current weight ${i.weight})\n  A: ${i.fromContent.slice(0, 300)}\n  B: ${i.toContent.slice(0, 300)}`
    ).join('\n');
    return `这是旧版缺少关联依据的边列表，仅供查找需要补充背景的记忆。不要基于正文相似度重新评分；原始场景缺失不代表无关。请使用 organization 接口读取完整场景依据后再判断。

${edgesText}

规则:
- score: 0-1。0=毫无关联, 1=强相关(同一问题/因果关系/直接支撑)
- 只是话题沾边不算强相关，给低分
- 不具备原始情境时不评分，返回空 scores；旧 score-only 提交不会改动权重

必须只输出 JSON，不要任何解释文字
输出格式:
{"scores":[{"idx":0,"score":0.5}]}`;
  }

  private parseEdgeReviewResponse(raw: string, batchSize: number): Array<{ idx: number; score: number }> {
    try {
      // 容错提取：思考模型可能输出解释文字+JSON 混合体，从中挖出第一个 {..} 块
      let cleaned = raw.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim();
      if (!cleaned.startsWith('{')) {
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
      }
      const parsed = JSON.parse(cleaned);
      const scores = parsed.scores;
      if (!Array.isArray(scores)) return [];
      return scores.filter((s: any) =>
        typeof s.idx === 'number' && s.idx >= 0 && s.idx < batchSize && typeof s.score === 'number'
      );
    } catch {
      logger.warn(`Edge review parse failed (raw head: ${raw.slice(0, 120)})`);
      return [];
    }
  }

  /**
   * Community detection via label propagation (no LLM, no embedding — pure graph topology).
   * Finds clusters of tightly-connected memories (e.g. "K10 debugging cluster", "ai-teacher cluster").
   * Communities become L2 scene candidates and get tagged on member nodes.
   */
  async detectCommunities(): Promise<{ communities: number; tagged: number }> {
    if (!this.graphMemory) return { communities: 0, tagged: 0 };
    const db = (this.graphMemory as any).db;
    if (!db) return { communities: 0, tagged: 0 };

    // Load associative edges for topology (deleted edges are gone for good)
    const edges = await db.all(`SELECT from_id, to_id, label FROM edges WHERE label IN ('related','similar-to','caused-by','fixes','supports')`);
    if (edges.length < 10) return { communities: 0, tagged: 0 };

    // Build adjacency
    const adj = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!adj.has(e.from_id)) adj.set(e.from_id, new Set());
      if (!adj.has(e.to_id)) adj.set(e.to_id, new Set());
      adj.get(e.from_id)!.add(e.to_id);
      adj.get(e.to_id)!.add(e.from_id);
    }

    // Label propagation: each node adopts the most common label among neighbors
    const labels = new Map<string, string>();
    const ids = [...adj.keys()];
    for (const id of ids) labels.set(id, id);
    for (let iter = 0; iter < 10; iter++) {
      let changed = 0;
      // Asynchronous update in random-ish order
      for (const id of ids) {
        const neighbors = adj.get(id)!;
        if (neighbors.size === 0) continue;
        const counts = new Map<string, number>();
        for (const n of neighbors) {
          const l = labels.get(n);
          if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
        }
        let best = labels.get(id)!;
        let bestCount = 0;
        for (const [l, c] of counts) if (c > bestCount) { best = l; bestCount = c; }
        if (best !== labels.get(id)) { labels.set(id, best); changed++; }
      }
      if (changed === 0) break;
    }

    // Group into communities (min size 3)
    const groups = new Map<string, string[]>();
    for (const [id, label] of labels) {
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(id);
    }
    const communities = [...groups.entries()].filter(([, members]) => members.length >= 3);

    // Tag member nodes with community id (merge into existing tags)
    let tagged = 0;
    for (const [label, members] of communities) {
      const communityTag = `community:${label.slice(0, 8)}`;
      for (const nodeId of members) {
        try {
          const node = await this.graphMemory.getNodeById(nodeId, { trackAccess: false });
          if (!node) continue;
          const tags = Array.isArray(node.tags) ? [...node.tags] : [];
          if (!tags.includes(communityTag)) {
            tags.push(communityTag);
            await db.run(`UPDATE nodes SET tags = ? WHERE id = ?`, [JSON.stringify(tags), nodeId]);
            tagged++;
          }
        } catch { /* skip individual failures */ }
      }
    }

    logger.info(`🏘️ Community detection: ${communities.length} communities (≥3 members), ${tagged} nodes tagged`);
    return { communities: communities.length, tagged };
  }

  // ─── Nightly Maintenance ("Deep Sleep") ────────────────────────────────────

  /**
   * Run full maintenance cycle: decay + archive + stats.
   * Designed to run once per 24h (via schedule_wake or cron).
   */
  async runMaintenance(): Promise<{ decayed: number; archived: number; woven: number; reweighted: number; stats: Record<string, number> }> {
    logger.info('🌙 Nightly maintenance started');

    const decayed = await this.graphMemory.decayStaleNodes(
      this.config.decayOlderThanMs,
      this.config.decayFactor
    );

    const archived = await this.graphMemory.archiveColdL0(
      this.config.archiveOlderThanMs,
      this.config.archiveMinKeep
    );

    // Edge weaving — turn today's experience into graph structure (nightly = forced)
    const { woven } = await this.weaveEdges(true);

    // L3 persona: periodic re-distillation even without new L2 scenes —
    // a stale persona should still absorb recent scene drift (cadence: l3RedistillIntervalMs)
    if (this.config.legacyProfiles && await this.l3Due()) {
      await this.distillL3();
    }

    // Edge review — LLM re-rates a rotating batch, weights nudged smoothly
    const reweighted = await this.reviewEdgeWeights();

    // Community detection — cluster tightly-connected memories (no LLM, pure topology)
    const community = await this.detectCommunities();

    const stats = await this.graphMemory.countByLayer();

    logger.info(`🌙 Maintenance done: decayed=${decayed}, archived=${archived}, woven=${woven}, reweighted=${reweighted}, communities=${community.communities}, stats=${JSON.stringify(stats)}`);
    return { decayed, archived, woven, reweighted, stats };
  }

  // ─── Full consolidation cycle (L2 → L3 → maintenance) ─────────────────────

  /**
   * Run the full consolidation pipeline.
   * Called after L1 extraction completes, or on schedule.
   */
  async runFullCycle(): Promise<void> {
    logger.info('🧠 Consolidation cycle started');
    const l2Count = this.config.legacyProfiles ? await this.aggregateL2() : 0;
    if (l2Count > 0) {
      await this.distillL3();
    }
    // Weave edges so today's fresh atoms connect to the existing graph
    await this.weaveEdges();
    logger.info('🧠 Consolidation cycle complete');
  }

  // ─── Prompt Builders ───────────────────────────────────────────────────────

  private buildL2Prompt(atomsText: string): string {
    return `You are a memory consolidation engine. Group the following atomic memories into thematic "scenes".

Rules:
- Each scene should have a clear theme/topic name
- Each scene summary should be 1-3 sentences capturing the essence
- An atom can belong to at most one scene
- Atoms that don't fit any theme can be left ungrouped

Input atoms:
${atomsText}

Respond in JSON:
{
  "scenes": [
    {
      "theme": "short theme name",
      "summary": "1-3 sentence summary of this scene",
      "atomIndices": [0, 2, 5]
    }
  ]
}

Only output valid JSON, no explanation.`;
  }

  private buildL3Prompt(scenesText: string, existingPersona: string): string {
    const existingSection = existingPersona
      ? `\nExisting persona (update/refine this):\n${existingPersona}\n`
      : '';

    return `You are a memory distillation engine. Synthesize the following scene summaries into a coherent long-term user persona.

The persona should capture:
- Key preferences and habits
- Important constraints and rules
- Recurring themes and interests
- Communication style preferences
${existingSection}
Scene summaries:
${scenesText}

Write the persona as a concise paragraph (100-300 words). No JSON, just plain text.`;
  }

  // ─── Response Parsers ──────────────────────────────────────────────────────

  /** R04: null = malformed reply (caller keeps the batch held for a corrected
   * resubmission); [] = a valid "no scenes" verdict. A scenes array containing
   * shape-violating entries is also malformed, not silently filtered. */
  private parseL2Response(raw: string): { theme: string; summary: string; atomIndices: number[] }[] | null {
    try {
      // Strip markdown code fences if present
      const cleaned = raw.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const scenes = parsed.scenes;
      if (!Array.isArray(scenes)) return null;
      const out: { theme: string; summary: string; atomIndices: number[] }[] = [];
      for (const s of scenes) {
        if (!s || typeof s.theme !== 'string' || typeof s.summary !== 'string' || !Array.isArray(s.atomIndices)) return null;
        const indices = s.atomIndices.filter((i: any) => typeof i === 'number');
        if (indices.length !== s.atomIndices.length) return null;
        out.push({ theme: s.theme, summary: s.summary, atomIndices: indices });
      }
      return out;
    } catch {
      logger.warn('L2 response parse failed');
      return null;
    }
  }
}
