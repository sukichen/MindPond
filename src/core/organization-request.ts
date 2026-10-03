/** O01: organization request model — one request is one bounded organization
 * pass over a FIXED watermark of candidates.
 *
 * Frozen state machine (roadmap §3.2):
 *   queued → running → completed | partial | failed | cancelled
 *   running/waiting → waiting (non-terminal, with reason) → running (retry)
 * Terminal states never accept late batches or reports; a request created
 * over an empty watermark completes immediately (nothing to organize).
 *
 * Fixed watermark (T12): the candidate membership list is captured once at
 * creation. Memories saved while the request runs stay out of scope — they
 * are left for the next request instead of extending this one forever.
 * Partial semantics (T13): one successful batch never completes the request;
 * a host that runs out of budget finishes the request as `partial` with an
 * explicit uncovered list — never as a full-library completion.
 *
 * Receipts differ by outcome: budget exhaustion → partial + uncovered,
 * no claimable executor → waiting (non-terminal), nothing actionable →
 * completed with zero mutations, per-member failure → failed/partial. */
import type { Database } from 'sqlite';
import { randomUUID } from 'node:crypto';
import { MindPondError } from './errors.js';
import { stableJSON, textField, digest } from './growth.js';
import { normalizeDomain, domainKey, resolveReadDomains, type DomainReadContext } from './domain.js';
import { ORGANIZATION_POLICY_VERSION } from './organization-policy.js';
import type { MemoryDomainRef } from './domain.js';
import type { OrganizationJob } from './graph-memory.js';

export type OrganizationRequestStatus =
  | 'queued' | 'running' | 'waiting'
  | 'completed' | 'partial' | 'failed' | 'cancelled';

/** Per-candidate conclusion: every watermarked member ends reviewed/no_change/
 * deferred (checked), failed (attempted, errored) or uncovered (never checked,
 * with reason). `pending`/`in_flight` are non-terminal member states. */
export type MemberOutcome =
  | 'pending' | 'in_flight' | 'reviewed' | 'no_change' | 'deferred' | 'failed' | 'uncovered';

export interface OrganizationRequestReceipt {
  status: Exclude<OrganizationRequestStatus, 'queued' | 'running' | 'waiting'>;
  total: number;
  concluded: { reviewed: number; no_change: number; deferred: number; failed: number };
  mutations: number;
  uncovered: Array<{ membershipId: string; reason: string }>;
  /** O04: named per-category counters derived from actual commit receipts. */
  stats?: OrganizationRequestStats;
  reason?: string;
}

/** O04: statistics are named per category instead of one opaque number —
 * `mutations` (the headline) counts only what actually landed:
 * createdContents + modifiedItems. Proposals never count. */
export interface OrganizationRequestStats {
  /** New unique memory bodies created by consolidate/synthesize. */
  createdContents: number;
  /** Memberships replaced as consolidate inputs. */
  replacedMembers: number;
  /** Consolidate groups (one candidate group per consolidate op). */
  candidateGroups: number;
  /** Synthesized profiles. */
  profiles: number;
  /** Existing memories updated in place (reanchor / synthesize targets). */
  modifiedItems: number;
  /** createdContents + modifiedItems — server-derived, host reports ignored. */
  mutations: number;
}

export interface OrganizationRequestProgress {
  requestId: string;
  status: OrganizationRequestStatus;
  waitReason?: string;
  domain: MemoryDomainRef;
  spaceId: string;
  memoryType: string;
  total: number;
  pending: number;
  inFlight: number | null;
  concluded: { reviewed: number; no_change: number; deferred: number; failed: number; uncovered: number };
  stats?: OrganizationRequestStats;
  receipt?: OrganizationRequestReceipt;
  next?: string;
}

export interface RequestBatch {
  batch: OrganizationJob;
  requestId: string;
  progress: Pick<OrganizationRequestProgress, 'total' | 'pending' | 'inFlight' | 'concluded'>;
}

export interface RequestWait { batch: null; progress: OrganizationRequestProgress }

export interface BatchReport {
  result: 'committed' | 'no_change' | 'deferred' | 'failed' | 'released';
  mutations?: number;
  reason?: string;
}

/** The persisted plan, not a host's label, determines a completed batch's outcome. */
export function organizationPlanOutcome(plan: { operations: Array<{ kind: string }> }): 'committed' | 'no_change' | 'deferred' {
  if (!plan.operations.length || plan.operations.every(op => op.kind === 'keep')) return 'no_change';
  if (plan.operations.every(op => op.kind === 'defer')) return 'deferred';
  return 'committed';
}

export interface RequestGraph {
  claimOrganizationJob(options: {
    domain?: MemoryDomainRef; spaceId: string; memoryType: string;
    maxMembers?: number; leaseMs?: number; membershipIds?: string[];
  }): Promise<OrganizationJob | null>;
  getOrganizationJob(jobId: string): Promise<OrganizationJob | null>;
}

const MEMBER_STATES: MemberOutcome[] = ['pending', 'in_flight', 'reviewed', 'no_change', 'deferred', 'failed', 'uncovered'];
const BATCH_RESULTS: BatchReport['result'][] = ['committed', 'no_change', 'deferred', 'failed', 'released'];
/** Batch conclusions that mark a member checked (the receipt counts them apart). */
const CHECKED: Record<string, MemberOutcome> = { committed: 'reviewed', no_change: 'no_change', deferred: 'deferred' };

export class OrganizationRequestStore {
  /** O03/T16: how long a no_change conclusion keeps a member out of rotation. */
  private readonly cooldownMs = Math.max(0, Number(process.env.ORGANIZATION_NO_CHANGE_COOLDOWN_MS ?? 3 * 24 * 3600 * 1000));

  constructor(
    private readonly db: Database,
    private readonly graph: RequestGraph,
    private readonly clock: () => number = Date.now,
    private readonly audit?: (action: string, payload: unknown) => Promise<void>,
  ) {}

  async init() {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS organization_requests (
        id TEXT PRIMARY KEY, domain_kind TEXT NOT NULL, domain_id TEXT NOT NULL,
        space_id TEXT NOT NULL, memory_type TEXT NOT NULL,
        status TEXT NOT NULL, wait_reason TEXT, batch_size INTEGER NOT NULL,
        mutations INTEGER NOT NULL DEFAULT 0, stats TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, receipt TEXT);
      CREATE TABLE IF NOT EXISTS organization_request_members (
        request_id TEXT NOT NULL REFERENCES organization_requests(id) ON DELETE CASCADE,
        membership_id TEXT NOT NULL, position INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', reason TEXT, job_id TEXT,
        updated_at INTEGER NOT NULL, PRIMARY KEY(request_id, membership_id));
      CREATE INDEX IF NOT EXISTS idx_org_request_members
        ON organization_request_members(request_id, status, position);
    `);
    // O04: additive migration — databases created before the stats column.
    const cols = await this.db.all<any[]>('PRAGMA table_info(organization_requests)');
    if (!cols.some(c => c.name === 'stats')) await this.db.exec('ALTER TABLE organization_requests ADD COLUMN stats TEXT');
    // O04/T17: append-only event stream. One row per transition, written in the
    // SAME transaction as the state change; hosts resume by monotonic seq.
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS organization_request_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL REFERENCES organization_requests(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        ts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_org_request_events ON organization_request_events(request_id, seq);
    `);
  }

  /** Append one event row. Callers run this inside the transaction that also
   * writes the state change, so an event never exists without its transition. */
  private appendEvent(requestId: string, type: string, payload: Record<string, unknown>, ts = this.clock()) {
    return this.db.run(
      'INSERT INTO organization_request_events (request_id, event_id, type, payload, ts) VALUES (?, ?, ?, ?, ?)',
      [requestId, randomUUID(), type, stableJSON(payload), ts]);
  }

  /** Capture the fixed watermark: every active, non-superseded, non-L0
   * membership in the scope at creation time, oldest-reviewed first. */
  async createRequest(options: {
    domain?: MemoryDomainRef; spaceId: string; memoryType: string; batchSize?: number; limit?: number; idempotencyKey?: string;
  }): Promise<OrganizationRequestProgress> {
    textField(options.spaceId, 'spaceId', 128);
    textField(options.memoryType, 'memoryType', 128);
    const domain = normalizeDomain(options.domain, options.domain?.kind === 'session' ? options.domain.id : undefined);
    const batchSize = options.batchSize ?? 8;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 24) throw new MindPondError('invalid_input', 'batchSize must be 1–24', { field: 'batchSize', retryable: false, nextAction: '每批领取 1–24 个成员；默认 8' });
    const limit = options.limit ?? 192;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new MindPondError('invalid_input', 'limit must be 1–500', { field: 'limit', retryable: false, nextAction: '一次请求最多固定 500 个候选；更大范围请分多次请求' });
    const now = this.clock();
    const rows = await this.db.all<any>(
      "SELECT m.id FROM memory_memberships m JOIN nodes n ON n.id = m.memory_id WHERE m.space_id = ? AND m.memory_type = ? AND n.domain_kind = ? AND n.domain_id = ? AND m.active = 1 AND n.superseded_by IS NULL AND n.layer != 'L0' " +
      "AND NOT EXISTS (SELECT 1 FROM memory_domains d WHERE d.kind = 'session' AND d.kind = n.domain_kind AND d.id = n.domain_id AND d.status != 'active') " +
      "AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.session_id = n.domain_id AND n.domain_kind = 'session') " +
      'ORDER BY COALESCE(m.last_reviewed_at, 0), m.updated_at, m.id LIMIT ?', [options.spaceId, options.memoryType, domain.kind, domain.id, limit]);
    const requestId = randomUUID();
    const key = options.idempotencyKey === undefined ? undefined :
      `organization-request:${domainKey(domain)}:${textField(options.idempotencyKey, 'idempotencyKey', 256)}`;
    const hash = digest({ domain, spaceId: options.spaceId, memoryType: options.memoryType, batchSize, limit });
    await this.db.exec('BEGIN IMMEDIATE');
    try {
      if (key) {
        const prior = await this.db.get<any>('SELECT request_hash,payload FROM memory_receipts WHERE key=?', [key]);
        if (prior) {
          if (prior.request_hash !== hash) throw new MindPondError('idempotency_conflict', 'organization request key reused with different scope or options');
          const id = JSON.parse(prior.payload).requestId;
          await this.db.exec('COMMIT');
          return (await this.getRequest(id))!;
        }
      }
      await this.db.run(
        'INSERT INTO organization_requests (id, domain_kind, domain_id, space_id, memory_type, status, batch_size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [requestId, domain.kind, domain.id, options.spaceId, options.memoryType, rows.length ? 'queued' : 'completed', batchSize, now, now]);
      for (const [position, row] of rows.entries()) await this.db.run(
        'INSERT INTO organization_request_members (request_id, membership_id, position, status, updated_at) VALUES (?, ?, ?, ?, ?)',
        [requestId, row.id, position, 'pending', now]);
      if (!rows.length) await this.db.run('UPDATE organization_requests SET receipt = ? WHERE id = ?',
        [stableJSON({ status: 'completed', total: 0, concluded: { reviewed: 0, no_change: 0, deferred: 0, failed: 0 }, mutations: 0, uncovered: [] }), requestId]);
      if (key) await this.db.run('INSERT INTO memory_receipts(key,request_hash,payload) VALUES (?,?,?)', [key, hash, stableJSON({requestId})]);
      await this.appendEvent(requestId, 'created', { total: rows.length, spaceId: options.spaceId, memoryType: options.memoryType, batchSize }, now);
      await this.db.exec('COMMIT');
    } catch (error) { await this.db.exec('ROLLBACK'); throw error; }
    await this.audit?.('organization_request_created', { requestId, domain, spaceId: options.spaceId, memoryType: options.memoryType, total: rows.length });
    const progress = await this.getRequest(requestId);
    return progress!;
  }

  /** A scoped, bounded index for host/workbench recovery; undefined is operator-only. */
  async listRequests(context: DomainReadContext | undefined, limit=50): Promise<OrganizationRequestProgress[]> {
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new MindPondError('invalid_input','request list limit must be 1–100');
    const domains=context ? (context.domains?.length===0?[]:resolveReadDomains(context)) : undefined;
    if(domains?.length===0)return [];
    const where=domains ? domains.map(()=>'(r.domain_kind=? AND r.domain_id=?)').join(' OR ') : '1';
    const rows=await this.db.all<{id:string}[]>(`SELECT r.id FROM organization_requests r WHERE (${where})
      ${context ? "AND (r.domain_kind!='session' OR EXISTS(SELECT 1 FROM memory_domains d WHERE d.kind='session' AND d.id=r.domain_id AND d.status IN ('active','paused')))" : ''}
      ORDER BY r.updated_at DESC, r.id DESC LIMIT ?`,[...(domains?.flatMap(d=>[d.kind,d.id])??[]),limit]);
    const values=await Promise.all(rows.map(r=>this.getRequest(r.id)));
    return values.filter((v):v is OrganizationRequestProgress=>v!==null);
  }

  async getRequest(requestId: string): Promise<OrganizationRequestProgress | null> {
    const row = await this.db.get<any>('SELECT * FROM organization_requests WHERE id = ?', [requestId]);
    if (!row) return null;
    const counts: Record<string, number> = {};
    for (const state of MEMBER_STATES) counts[state] = 0;
    for (const r of await this.db.all<any>('SELECT status, COUNT(*) AS n FROM organization_request_members WHERE request_id = ? GROUP BY status', [requestId])) counts[r.status] = (counts[r.status] ?? 0) + r.n;
    const domain = { kind: row.domain_kind as MemoryDomainRef['kind'], id: row.domain_id };
    const progress: OrganizationRequestProgress = {
      requestId, status: row.status, domain, spaceId: row.space_id, memoryType: row.memory_type,
      ...(row.wait_reason ? { waitReason: row.wait_reason } : {}),
      total: counts.pending + counts.in_flight + counts.reviewed + counts.no_change + counts.deferred + counts.failed + counts.uncovered,
      pending: counts.pending, inFlight: counts.in_flight,
      concluded: { reviewed: counts.reviewed, no_change: counts.no_change, deferred: counts.deferred, failed: counts.failed, uncovered: counts.uncovered },
      ...(row.stats ? { stats: JSON.parse(row.stats) } : {}),
      ...(row.receipt ? { receipt: JSON.parse(row.receipt) } : {}),
      next: ['queued', 'running', 'waiting'].includes(row.status) ? 'POST /api/organization/request/' + requestId + '/next' : undefined,
    };
    return progress;
  }

  /** Claim the next batch strictly inside the watermark. Returns a null batch
   * when the request drained (terminal transition applied) or must wait. */
  async nextBatch(requestId: string, options: { leaseMs?: number } = {}): Promise<RequestBatch | RequestWait> {
    const row = await this.db.get<any>('SELECT * FROM organization_requests WHERE id = ?', [requestId]);
    if (!row) throw new MindPondError('invalid_input', 'organization request not found', { field: 'requestId', retryable: false, nextAction: '先 POST /api/organization/request 创建请求' });
    if (!['queued', 'running', 'waiting'].includes(row.status)) {
      throw new MindPondError('stale_lease', `organization request is already ${row.status}`, {
        retryable: false, nextAction: '用 GET /api/organization/request/:id 查询最终回执；继续整理请创建新请求',
      });
    }
    // Recover a lost report acknowledgement or a crashed/expired executor from
    // durable job state. Never ask the model to regenerate an already committed plan.
    const outstanding = await this.db.all<any>(
      "SELECT DISTINCT job_id FROM organization_request_members WHERE request_id=? AND status='in_flight'", [requestId]);
    for (const held of outstanding) {
      const job = await this.graph.getOrganizationJob(held.job_id);
      if (job?.status === 'completed') {
        const payload = await this.db.get<any>('SELECT plan FROM organization_payloads WHERE job_id=?', [held.job_id]);
        await this.reportBatch(requestId, held.job_id, { result: organizationPlanOutcome(JSON.parse(payload.plan)) });
      } else if (!job || !job.leaseExpiresAt || job.leaseExpiresAt < this.clock()) {
        await this.reportBatch(requestId, held.job_id, { result: 'released' });
      } else {
        await this.db.run("UPDATE organization_requests SET status='waiting', wait_reason=? WHERE id=? AND status IN ('queued','running','waiting')",
          ['earlier batch is still executing; wait for its lease or report', requestId]);
        return { batch: null, progress: (await this.getRequest(requestId))! };
      }
    }
    const now = this.clock();
    await this.db.run("UPDATE organization_requests SET status = 'running', wait_reason = NULL, updated_at = ? WHERE id = ? AND status IN ('queued','running','waiting')", [now, requestId]);
    // Vanished watermark members (deleted/superseded/inactive since creation)
    // become explicit uncovered entries — never silently skipped.
    const vanished = await this.db.all<any>(
      "SELECT rm.membership_id FROM organization_request_members rm LEFT JOIN memory_memberships m ON m.id = rm.membership_id AND m.active = 1 LEFT JOIN nodes n ON n.id = m.memory_id AND n.superseded_by IS NULL WHERE rm.request_id = ? AND rm.status = 'pending' AND (m.id IS NULL OR n.id IS NULL)", [requestId]);
    for (const v of vanished) await this.db.run(
      "UPDATE organization_request_members SET status = 'uncovered', reason = 'vanished', updated_at = ? WHERE request_id = ? AND membership_id = ? AND status = 'pending'", [now, requestId, v.membership_id]);
    // Pending members currently held by an active organization job elsewhere
    // are claimable again only after that lease ends — the request waits.
    const available = await this.db.all<any>(
      "SELECT rm.membership_id FROM organization_request_members rm JOIN memory_memberships m ON m.id = rm.membership_id AND m.active = 1 JOIN nodes n ON n.id = m.memory_id AND n.superseded_by IS NULL WHERE rm.request_id = ? AND rm.status = 'pending' " +
      'AND NOT EXISTS (SELECT 1 FROM organization_job_members jm JOIN organization_jobs j ON j.id = jm.job_id WHERE jm.membership_id = m.id AND j.status = ? AND j.lease_expires_at >= ?) ' +
      // O03/T16: claim-filter parity — no_change-cooled members are not claimable.
      'AND NOT EXISTS (SELECT 1 FROM organization_cooldowns c WHERE c.membership_id = m.id AND c.cooled_until > ? AND c.policy_version = ? AND c.member_version = m.version ' +
      "AND c.assoc_stamp = (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), 0) FROM memory_associations WHERE member_a_id = m.id OR member_b_id = m.id)) " +
      'ORDER BY rm.position LIMIT ?', [requestId, 'leased', now, now, ORGANIZATION_POLICY_VERSION, row.batch_size]);
    const pendingLeft = await this.db.get<any>(
      "SELECT COUNT(*) AS n FROM organization_request_members WHERE request_id = ? AND status = 'pending'", [requestId]);
    if (!available.length) {
      if (!pendingLeft.n) return { batch: null, progress: (await this.settle(requestId))! };
      const waitReason = 'watermark candidates are leased by other organization jobs';
      await this.db.run("UPDATE organization_requests SET status = 'waiting', wait_reason = ?, updated_at = ? WHERE id = ? AND status IN ('queued','running','waiting')", [waitReason, now, requestId]);
      await this.appendEvent(requestId, 'waiting', { reason: waitReason }, now);
      return { batch: null, progress: (await this.getRequest(requestId))! };
    }
    const membershipIds = available.map((a: any) => a.membership_id);
    let claimWaitReason = 'claim raced with another organization job';
    const job = await this.graph.claimOrganizationJob({
      domain: { kind: row.domain_kind, id: row.domain_id }, spaceId: row.space_id, memoryType: row.memory_type,
      membershipIds, leaseMs: options.leaseMs,
    }).catch(async error => {
      // Raced away between the availability check and the claim, or every
      // remaining candidate is over the material budget: wait either way.
      if ((error as any)?.code === 'material_over_budget') claimWaitReason = 'material over budget: oversized candidates need segmented reads or a smaller batch';
      await this.audit?.('organization_request_claim_raced', { requestId, error: String(error) });
      return null;
    });
    if (!job) {
      await this.db.run("UPDATE organization_requests SET status = 'waiting', wait_reason = ?, updated_at = ? WHERE id = ? AND status IN ('queued','running','waiting')", [claimWaitReason, now, requestId]);
      await this.appendEvent(requestId, 'waiting', { reason: claimWaitReason }, now);
      return { batch: null, progress: (await this.getRequest(requestId))! };
    }
    const claimed = job.members.map(m => m.membership.id).filter(id => membershipIds.includes(id));
    await this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of claimed) await this.db.run(
        "UPDATE organization_request_members SET status = 'in_flight', job_id = ?, reason = NULL, updated_at = ? WHERE request_id = ? AND membership_id = ?", [job.id, now, requestId, id]);
      await this.appendEvent(requestId, 'batch_claimed', { jobId: job.id, members: claimed }, now);
      await this.db.exec('COMMIT');
    } catch (error) { await this.db.exec('ROLLBACK'); throw error; }
    await this.audit?.('organization_request_batch_claimed', { requestId, jobId: job.id, members: claimed });
    const progress = await this.getRequest(requestId);
    return { batch: job, requestId, progress: { total: progress!.total, pending: progress!.pending, inFlight: progress!.inFlight, concluded: progress!.concluded } };
  }

  /** Record one batch outcome. Verified against the organization job itself:
   * checked results require the job to be completed; released returns members
   * to pending; failed records the per-member failure. Reports for members
   * that are no longer in flight under this job are ignored (idempotent). */
  async reportBatch(requestId: string, jobId: string, report: BatchReport): Promise<OrganizationRequestProgress> {
    if (!BATCH_RESULTS.includes(report.result)) throw new MindPondError('invalid_input', 'result must be one of ' + BATCH_RESULTS.join('|'), { field: 'result', retryable: false, nextAction: '按批次真实结论报告：已提交/无变化/搁置/失败/释放' });
    const row = await this.db.get<any>('SELECT * FROM organization_requests WHERE id = ?', [requestId]);
    if (!row) throw new MindPondError('invalid_input', 'organization request not found', { field: 'requestId', retryable: false });
    // O04/T17: terminal requests reject EVERY late batch conclusion — including
    // released — so a stale running/released event can never rewind frozen state.
    if (!['queued', 'running', 'waiting'].includes(row.status)) {
      throw new MindPondError('stale_lease', `organization request is already ${row.status}`, { retryable: false, nextAction: '终态请求不接受迟到批次报告（T17）；用 status 查询冻结回执' });
    }
    const inFlight = await this.db.all<any>(
      "SELECT membership_id FROM organization_request_members WHERE request_id = ? AND job_id = ? AND status = 'in_flight'", [requestId, jobId]);
    if (!inFlight.length) throw new MindPondError('stale_lease', 'no outstanding batch of this request belongs to the job', { field: 'jobId', retryable: false, nextAction: '同一批次只接受一次结论；用 GET /api/organization/request/:id 查看进度' });
    const now = this.clock();
    const actualJob = await this.graph.getOrganizationJob(jobId);
    if (actualJob?.status === 'completed') {
      const saved = await this.db.get<any>('SELECT plan FROM organization_payloads WHERE job_id=?', [jobId]);
      report = { ...report, result: organizationPlanOutcome(JSON.parse(saved.plan)) };
    }
    if (report.result === 'released') {
      await this.db.exec('BEGIN IMMEDIATE');
      try {
        await this.db.run("UPDATE organization_jobs SET lease_expires_at=0 WHERE id=? AND status='leased'", [jobId]);
        for (const m of inFlight) await this.db.run(
          "UPDATE organization_request_members SET status = 'pending', job_id = NULL, reason = NULL, updated_at = ? WHERE request_id = ? AND membership_id = ? AND status = 'in_flight'", [now, requestId, m.membership_id]);
        await this.appendEvent(requestId, 'batch_released', { jobId, members: inFlight.length }, now);
        await this.db.exec('COMMIT');
      } catch (error) { await this.db.exec('ROLLBACK'); throw error; }
      await this.audit?.('organization_request_batch_released', { requestId, jobId });
      return (await this.getRequest(requestId))!;
    }
    if (report.result !== 'failed') {
      const job = await this.graph.getOrganizationJob(jobId);
      if (!job || job.status !== 'completed') throw new MindPondError('invalid_input', 'checked results require the organization job to be completed first', { field: 'jobId', retryable: false, nextAction: '先 POST /api/organization/commit 提交该批次的计划，或报告 released/failed' });
      const saved = await this.db.get<any>('SELECT plan FROM organization_payloads WHERE job_id=?', [jobId]);
      report = { ...report, result: organizationPlanOutcome(JSON.parse(saved.plan)) };
    }
    // O04: mutation accounting is owned by the service, not the host's report.
    // The counters derive from the job's actual commit receipt and plan, so a
    // plan that proposes 10 operations but lands 2 reports exactly 2.
    let statsDelta: OrganizationRequestStats | null = null;
    if (report.result === 'committed') {
      const payload = await this.db.get<any>('SELECT plan, receipt FROM organization_payloads WHERE job_id = ?', [jobId]);
      const receipt = payload?.receipt ? JSON.parse(payload.receipt) : {};
      const created = Array.isArray(receipt.createdMemoryIds) ? receipt.createdMemoryIds.length : 0;
      const updated = Array.isArray(receipt.updatedMemoryIds) ? receipt.updatedMemoryIds.length : 0;
      const planOps = payload?.plan ? (JSON.parse(payload.plan).operations ?? []) : [];
      let groups = 0, replaced = 0, profiles = 0;
      for (const op of planOps) {
        if (op?.kind === 'consolidate') { groups += 1; replaced += Array.isArray(op.membershipIds) ? op.membershipIds.length : 0; }
        if (op?.kind === 'synthesize') profiles += 1;
      }
      statsDelta = { createdContents: created, replacedMembers: replaced, candidateGroups: groups, profiles, modifiedItems: updated, mutations: created + updated };
    }
    const target = CHECKED[report.result] ?? 'failed';
    await this.db.exec('BEGIN IMMEDIATE');
    try {
      if (report.result === 'failed') await this.db.run("UPDATE organization_jobs SET lease_expires_at=0 WHERE id=? AND status='leased'", [jobId]);
      for (const m of inFlight) await this.db.run(
        'UPDATE organization_request_members SET status = ?, reason = ?, updated_at = ? WHERE request_id = ? AND membership_id = ? AND status = ?',
        [target, report.reason ?? null, now, requestId, m.membership_id, 'in_flight']);
      // Only server-derived mutations count — the host-passed number is ignored.
      if (statsDelta && statsDelta.mutations > 0) await this.db.run(
        'UPDATE organization_requests SET mutations = mutations + ? WHERE id = ?', [statsDelta.mutations, requestId]);
      // O03/T16: a no_change conclusion cools the member down — later claims skip
      // it until the cooldown expires or any version (content/association/policy)
      // changes, so unchanged pairs cannot consume the maintenance budget forever.
      let cooledUntil: number | undefined;
      if (report.result === 'no_change') {
        cooledUntil = this.clock() + this.cooldownMs;
        for (const m of inFlight) {
          const version = (await this.db.get<any>('SELECT version FROM memory_memberships WHERE id = ?', [m.membership_id]))?.version ?? 0;
          await this.db.run(
            `INSERT INTO organization_cooldowns (membership_id, space_id, memory_type, member_version, assoc_stamp, policy_version, cooled_until, updated_at)
             VALUES (?, ?, ?, ?, (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), 0) FROM memory_associations WHERE member_a_id = ? OR member_b_id = ?), ?, ?, ?)
             ON CONFLICT(membership_id) DO UPDATE SET member_version = excluded.member_version, assoc_stamp = excluded.assoc_stamp,
               policy_version = excluded.policy_version, cooled_until = excluded.cooled_until, updated_at = excluded.updated_at`,
            [m.membership_id, row.space_id, row.memory_type, version, m.membership_id, m.membership_id, ORGANIZATION_POLICY_VERSION, cooledUntil, this.clock()]);
        }
      }
      if (statsDelta) {
        const prior: OrganizationRequestStats = row.stats ? { mutations: 0, ...JSON.parse(row.stats) } : { createdContents: 0, replacedMembers: 0, candidateGroups: 0, profiles: 0, modifiedItems: 0, mutations: 0 };
        const merged = {
          createdContents: prior.createdContents + statsDelta.createdContents,
          replacedMembers: prior.replacedMembers + statsDelta.replacedMembers,
          candidateGroups: prior.candidateGroups + statsDelta.candidateGroups,
          profiles: prior.profiles + statsDelta.profiles,
          modifiedItems: prior.modifiedItems + statsDelta.modifiedItems,
          mutations: prior.mutations + statsDelta.mutations,
        };
        await this.db.run('UPDATE organization_requests SET stats = ? WHERE id = ?', [stableJSON(merged), requestId]);
      }
      await this.appendEvent(requestId, 'batch_reported', {
        jobId, result: report.result, members: inFlight.length,
        ...(statsDelta ? { mutations: statsDelta.mutations, stats: statsDelta } : {}),
        ...(cooledUntil !== undefined ? { cooldownUntil: cooledUntil } : {}),
        ...(report.reason ? { reason: report.reason } : {}),
      }, now);
      await this.db.exec('COMMIT');
    } catch (error) { await this.db.exec('ROLLBACK'); throw error; }
    if (report.result === 'no_change') await this.audit?.('organization_request_no_change_cooldown', { requestId, members: inFlight.length });
    await this.audit?.('organization_request_batch_reported', { requestId, jobId, result: report.result, members: inFlight.length });
    return (await this.getRequest(requestId))!;
  }

  /** Host-driven terminal transition for budget exhaustion (T13): every still
   * pending member becomes explicitly uncovered; the final status is derived
   * (partial when anything is uncovered or failed, completed otherwise). */
  async finishRequest(requestId: string, input: { reason: 'budget_exhausted' | 'cancelled_by_host' | string; detail?: string }): Promise<OrganizationRequestProgress> {
    textField(input.reason, 'reason', 256);
    const row = await this.db.get<any>('SELECT * FROM organization_requests WHERE id = ?', [requestId]);
    if (!row) throw new MindPondError('invalid_input', 'organization request not found', { field: 'requestId', retryable: false });
    const now = this.clock();
    const outstanding = await this.db.get<any>("SELECT COUNT(*) AS n FROM organization_request_members WHERE request_id = ? AND status = 'in_flight'", [requestId]);
    if (outstanding.n) throw new MindPondError('invalid_input', 'report or release the outstanding batch before finishing the request', { field: 'jobId', retryable: false, nextAction: '每个批次先有结论，才能得到可解释的 partial 回执' });
    await this.db.exec('BEGIN IMMEDIATE');
    try {
      const updated = await this.db.run(
        "UPDATE organization_request_members SET status = 'uncovered', reason = ?, updated_at = ? WHERE request_id = ? AND status = 'pending'", [`uncovered:${input.reason}${input.detail ? ':' + input.detail : ''}`, now, requestId]);
      await this.appendEvent(requestId, 'finished', { reason: input.reason, uncovered: updated.changes }, now);
      await this.db.exec('COMMIT');
    } catch (error) { await this.db.exec('ROLLBACK'); throw error; }
    await this.audit?.('organization_request_finished', { requestId, reason: input.reason });
    return (await this.settle(requestId))!;
  }

  async cancelRequest(requestId: string, reason: string): Promise<OrganizationRequestProgress> {
    textField(reason, 'reason', 256);
    const row = await this.db.get<any>('SELECT status FROM organization_requests WHERE id = ?', [requestId]);
    if (!row) throw new MindPondError('invalid_input', 'organization request not found', { field: 'requestId', retryable: false });
    if (!['queued', 'running', 'waiting'].includes(row.status)) return (await this.getRequest(requestId))!; // terminal keeps its receipt (T08 parity)
    const now = this.clock();
    // Abandoned members become explicit uncovered entries; the terminal write
    // itself belongs to settle so the receipt and the status freeze together.
    await this.db.exec('BEGIN IMMEDIATE');
    try {
      // Revoke the actual jobs in the same transaction as request cancellation.
      // A client holding a jobId must not bypass the cancelled request via commit.
      await this.db.run(`UPDATE organization_jobs SET cancelled_at=?, lease_expires_at=0, updated_at=?
        WHERE status='leased' AND id IN (SELECT job_id FROM organization_request_members
        WHERE request_id=? AND status='in_flight')`, [now, now, requestId]);
      await this.db.run("UPDATE organization_request_members SET status = 'uncovered', reason = 'cancelled', updated_at = ? WHERE request_id = ? AND status IN ('pending','in_flight')", [now, requestId]);
      await this.appendEvent(requestId, 'cancelled', { reason }, now);
      await this.db.exec('COMMIT');
    } catch (error) { await this.db.exec('ROLLBACK'); throw error; }
    await this.audit?.('organization_request_cancelled', { requestId, reason });
    return (await this.settle(requestId, { force: true, asCancelled: true }))!;
  }

  /** Derive the terminal status and receipt. Frozen rule: partial when any
   * member is uncovered or failed; failed when nothing succeeded; completed
   * otherwise. Terminal writes are conditional — late transitions lose. */
  private async settle(requestId: string, opts: { force?: boolean; asCancelled?: boolean } = {}): Promise<OrganizationRequestProgress | null> {
    const row = await this.db.get<any>('SELECT * FROM organization_requests WHERE id = ?', [requestId]);
    if (!row) return null;
    if (['completed', 'partial', 'failed', 'cancelled'].includes(row.status)) return this.getRequest(requestId);
    const counts: Record<string, number> = { pending: 0, in_flight: 0, reviewed: 0, no_change: 0, deferred: 0, failed: 0, uncovered: 0 };
    for (const r of await this.db.all<any>('SELECT status, COUNT(*) AS n FROM organization_request_members WHERE request_id = ? GROUP BY status', [requestId])) counts[r.status] = r.n;
    const uncoveredRows = await this.db.all<any>(
      "SELECT membership_id, reason FROM organization_request_members WHERE request_id = ? AND status IN ('uncovered','failed') ORDER BY position", [requestId]);
    const total = counts.pending + counts.in_flight + counts.reviewed + counts.no_change + counts.deferred + counts.failed + counts.uncovered;
    let status: OrganizationRequestReceipt['status'];
    if (row.status === 'cancelled' || opts.asCancelled) status = 'cancelled';
    else if (counts.pending + counts.in_flight > 0 && !opts.force) {
      // Non-terminal: members remain to be claimed; nothing to freeze yet.
      return this.getRequest(requestId);
    }
    else if (counts.failed > 0 && counts.reviewed + counts.no_change === 0) status = 'failed';
    else if (counts.uncovered > 0 || counts.failed > 0) status = 'partial';
    else status = 'completed';
    if (!['completed', 'partial', 'failed', 'cancelled'].includes(status)) return this.getRequest(requestId);
    const receipt: OrganizationRequestReceipt = {
      status, total,
      concluded: { reviewed: counts.reviewed, no_change: counts.no_change, deferred: counts.deferred, failed: counts.failed },
      mutations: row.mutations ?? 0,
      uncovered: uncoveredRows.map((r: any) => ({ membershipId: r.membership_id, reason: r.reason ?? 'uncovered' })),
      ...(row.stats ? { stats: JSON.parse(row.stats) } : {}),
      ...(row.wait_reason && status !== 'completed' ? { reason: row.wait_reason } : {}),
    };
    // O04/T17: the terminal write and its `settled` event commit atomically —
    // a frozen receipt never exists without its event, and the conditional
    // UPDATE means a racing late transition loses instead of overwriting.
    await this.db.exec('BEGIN IMMEDIATE');
    try {
      const written = await this.db.run(
        "UPDATE organization_requests SET status = ?, receipt = ?, updated_at = ? WHERE id = ? AND status IN ('queued','running','waiting')",
        [status, stableJSON(receipt), this.clock(), requestId]);
      if (!written.changes) { await this.db.exec('ROLLBACK'); return this.getRequest(requestId); }
      await this.appendEvent(requestId, 'settled', { status, total, mutations: receipt.mutations, uncovered: receipt.uncovered.length });
      await this.db.exec('COMMIT');
    } catch (error) { await this.db.exec('ROLLBACK'); throw error; }
    await this.audit?.('organization_request_settled', { requestId, status, total, uncovered: receipt.uncovered.length });
    return this.getRequest(requestId);
  }

  /** O04/T17: reconnect-resumable event page. Reads are positional by seq — a
   * client that reconnects passes afterSeq = the last seq it saw and receives
   * only strictly newer events, so pages never overlap and counters derived
   * from progress/receipt can never double count from re-reading. */
  async listEvents(requestId: string, opts: { afterSeq?: number; limit?: number } = {}) {
    const row = await this.db.get<any>('SELECT id FROM organization_requests WHERE id = ?', [requestId]);
    if (!row) throw new MindPondError('invalid_input', 'organization request not found', { field: 'requestId', retryable: false, nextAction: '用 memory_organization_request_start 创建新请求' });
    const afterSeq = Number.isInteger(opts.afterSeq) && opts.afterSeq! >= 0 ? opts.afterSeq! : 0;
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    const events = await this.db.all<any>(
      'SELECT seq, event_id, type, payload, ts FROM organization_request_events WHERE request_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      [requestId, afterSeq, limit]);
    const latest = await this.db.get<any>('SELECT COALESCE(MAX(seq), 0) AS seq FROM organization_request_events WHERE request_id = ?', [requestId]);
    return {
      requestId, latestSeq: latest?.seq ?? 0,
      events: events.map((e: any) => ({ seq: e.seq, eventId: e.event_id, type: e.type, payload: JSON.parse(e.payload), ts: e.ts })),
    };
  }
}
