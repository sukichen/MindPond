/** R02 generic work driver: owns budget, deadline and lease discipline around a
 * host-injected model adapter. The driver never touches memory business state —
 * it claims core work, drives turns, renews the lease and settles through the
 * core's transactional guards.
 *
 * Separation of concerns (roadmap R02):
 *  - request total budget: one absolute deadline fixed at start; rate-limit
 *    waits, backoff, model time and response reads all count against it and it
 *    is NEVER reset per turn (T05: 120s stays 120s across retries);
 *  - per-turn deadline + AbortSignal handed to the adapter, which must not run
 *    its own hidden SDK-level retry/timeouts;
 *  - lease duration: renewed on its own cadence (leaseMs/3); renewal never
 *    touches the execution budget or attempts;
 *  - late results (the adapter ignored the signal, or finished after cancel /
 *    budget exhaustion / lease loss) are discarded and never submitted (T09);
 *    a host that cannot abort calls is reported as degraded;
 *  - finish and cancel are arbitrated by the core's conditional writes, so
 *    exactly one persistent outcome survives a cancel/commit race (T08).
 *
 * `now` and `delay` are injectable so fault tests run on a controlled clock. */
import type { MemoryDomainRef } from './domain.js';

/** Context handed to every model call. */
export interface ModelCallContext {
  /** Absolute epoch ms when the whole request budget expires. Fixed at start. */
  deadlineAt: number;
  /** Milliseconds of request budget left at dispatch time. */
  remainingBudgetMs: number;
  /** Absolute epoch ms of this turn's deadline (min(turn cap, budget)). */
  turnDeadlineAt: number;
  turn: number;
  /** Fires on turn deadline, budget exhaustion, lease loss or host cancel. */
  signal: AbortSignal;
}

export interface ModelAdapter {
  readonly name: string;
  /** false → the host cannot abort this call. The driver still rejects any
   *  late result and reports the run as degraded. */
  readonly supportsCancel: boolean;
  call(input: { prompt: string; context: ModelCallContext }): Promise<string>;
}

export type WorkOutcome = 'completed' | 'no_change' | 'deferred' | 'failed';

export interface WorkFinishInput {
  workId: string; leaseToken: string;
  outcome: WorkOutcome;
  reason: string; organizationJobId?: string;
}

/** Structural subset of GraphMemory — keeps the driver rpbot-free and testable
 *  against any host implementing the same lease protocol. */
export interface WorkPond {
  claimHostWork(spaceId: string, memoryType: string, domain?: MemoryDomainRef):
    Promise<{ id: string; leaseToken: string; leaseUntil: number; attempts: number; checkpoint: unknown } | null>;
  renewHostWork(workId: string, leaseToken: string): Promise<unknown>;
  finishHostWork(input: WorkFinishInput): Promise<{ status: string }>;
  cancelHostWork(workId: string, reason: string): Promise<{ status: string; receipt?: unknown }>;
}

export interface WorkTurnContext {
  workId: string; leaseToken: string; turn: number;
  checkpoint: unknown;
  context: ModelCallContext;
  /** Invoke the injected model under the driver's budget/cancel discipline.
   *  Throws TransientModelError when the turn deadline passed. */
  callModel: (prompt: string) => Promise<string>;
}

export interface WorkTurnResult {
  outcome: WorkOutcome;
  reason: string;
  organizationJobId?: string;
}

export interface WorkDriverOptions {
  /** Request total budget (ms) — covers every wait, retry and model call. */
  totalBudgetMs: number;
  /** Per-turn cap (ms). Defaults to the full remaining budget. */
  turnDeadlineMs?: number;
  /** Lease window (ms); renewal cadence is leaseMs/3. Default 300000. */
  leaseMs?: number;
  /** Backoff after a transient failure; counted against the total budget. */
  retryBackoffMs?: number;
  /** Maximum model turns for one claimed work item. Default 8. */
  maxTurns?: number;
  now?: () => number;
  /** Injectable sleep. Default real setTimeout; tests advance a fake clock. */
  delay?: (ms: number) => Promise<void>;
  /** Sleep used by the lease-renewal loop only. Defaults to `delay`. Fault
   *  harnesses pass a passive variant here so background renewals never drive
   *  the fake clock past the budget on their own. */
  renewDelay?: (ms: number) => Promise<void>;
}

export interface WorkDriverResult {
  workId: string | null;
  /** 'none' = nothing claimable; 'lost' = lease lost / finish rejected. */
  finalStatus: WorkOutcome | 'cancelled' | 'none' | 'lost';
  turns: number;
  elapsedMs: number;
  budgetExhausted: boolean;
  cancelled: boolean;
  /** True when a model call could not be stopped after an abort request (T09). */
  degraded: boolean;
  error?: string;
}

/** Transient failure inside a turn — retried with backoff within the budget. */
export class TransientModelError extends Error {
  constructor(message: string) { super(message); this.name = 'TransientModelError'; }
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

interface ClaimShape { id: string; leaseToken: string; leaseUntil: number; attempts: number; checkpoint: unknown }

export class WorkDriver {
  private readonly totalBudgetMs: number;
  private readonly turnCap: number;
  private readonly leaseMs: number;
  private readonly backoffMs: number;
  private readonly maxTurns: number;
  private readonly clock: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly renewDelay: (ms: number) => Promise<void>;
  private cancelRequested = false;
  private cancelReason = 'cancelled';
  private readonly externalAbort = new AbortController();
  private degraded = false;
  private renewActive = false;
  private lastError: string | undefined;

  constructor(private pond: WorkPond, private adapter: ModelAdapter, options: WorkDriverOptions) {
    this.totalBudgetMs = Math.max(1, Math.floor(options.totalBudgetMs));
    this.turnCap = Math.max(1, Math.floor(options.turnDeadlineMs ?? options.totalBudgetMs));
    this.leaseMs = Math.max(1_000, Math.floor(options.leaseMs ?? 300_000));
    this.backoffMs = Math.max(0, Math.floor(options.retryBackoffMs ?? 5_000));
    this.maxTurns = Math.max(1, Math.floor(options.maxTurns ?? 8));
    this.clock = options.now ?? Date.now;
    this.delay = options.delay ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    this.renewDelay = options.renewDelay ?? this.delay;
  }

  /** Ask the driver to stop: aborts in-flight model calls; after the current
   *  turn settles, leased work is cancelled through the core (receipts of
   *  already-committed results are preserved there). */
  cancel(reason = 'cancelled by host'): void {
    if (this.cancelRequested) return;
    this.cancelRequested = true;
    this.cancelReason = reason;
    this.externalAbort.abort();
  }

  /** Claim and process at most one work item. Returns null when nothing is
   *  claimable right now. */
  async runOne(params: { spaceId: string; memoryType: string; domain?: MemoryDomainRef },
    handler: (ctx: WorkTurnContext) => Promise<WorkTurnResult>): Promise<WorkDriverResult | null> {
    const start = this.clock();
    // T05: one absolute deadline for the whole request — never reset per turn.
    const deadlineAt = start + this.totalBudgetMs;
    const claim = await this.pond.claimHostWork(params.spaceId, params.memoryType, params.domain) as ClaimShape | null;
    if (!claim) return null;
    return this.process(claim, handler, deadlineAt, start);
  }

  /** Process work until the queue is empty or the budget/cancel says stop. */
  async run(params: { spaceId: string; memoryType: string; domain?: MemoryDomainRef },
    handler: (ctx: WorkTurnContext) => Promise<WorkTurnResult>,
    limits: { maxItems?: number } = {}): Promise<WorkDriverResult[]> {
    const results: WorkDriverResult[] = [];
    const maxItems = limits.maxItems ?? Number.POSITIVE_INFINITY;
    while (results.length < maxItems) {
      const one = await this.runOne(params, handler);
      if (!one) break;
      results.push(one);
      if (one.finalStatus === 'lost') break;
    }
    return results;
  }

  private async process(claim: ClaimShape, handler: (ctx: WorkTurnContext) => Promise<WorkTurnResult>,
    deadlineAt: number, start: number): Promise<WorkDriverResult> {
    const remain = () => deadlineAt - this.clock();
    const sleep = async (ms: number) => { const wait = Math.min(ms, Math.max(0, remain())); if (wait > 0) await this.delay(wait); };
    const result = (over: Partial<WorkDriverResult>): WorkDriverResult => ({
      workId: claim.id, finalStatus: 'deferred', turns, elapsedMs: this.clock() - start,
      budgetExhausted: false, cancelled: false, degraded: this.degraded,
      ...(this.lastError ? { error: this.lastError } : {}), ...over,
    });
    let turns = 0;
    let renewLost: string | undefined;
    // Lease renewal runs on its own cadence; it never resets the budget.
    this.renewActive = true;
    const renewLoop = (async () => {
      while (this.renewActive) {
        await this.renewDelay(Math.max(1_000, Math.floor(this.leaseMs / 3)));
        if (!this.renewActive) return;
        try { await this.pond.renewHostWork(claim.id, claim.leaseToken); }
        catch (error) {
          renewLost = messageOf(error);
          this.externalAbort.abort();
          return;
        }
      }
    })();
    void renewLoop;
    try {
      while (turns < this.maxTurns) {
        if (this.cancelRequested || renewLost) break;
        if (remain() <= 0) return result({ finalStatus: 'deferred', turns, budgetExhausted: true });
        turns += 1;
        try {
          const turnResult = await handler({
            workId: claim.id, leaseToken: claim.leaseToken, turn: turns, checkpoint: claim.checkpoint,
            context: {
              deadlineAt,
              remainingBudgetMs: Math.max(0, remain()),
              turnDeadlineAt: Math.min(this.clock() + this.turnCap, deadlineAt),
              turn: turns,
              signal: this.externalAbort.signal,
            },
            callModel: prompt => this.callModel(prompt, deadlineAt, turns),
          });
          // The handler finished, but a cancel/lease loss/budget expiry that
          // arrived meanwhile makes its result late — never submit (T05/T09).
          if (this.cancelRequested || renewLost) break;
          if (remain() <= 0) return result({ finalStatus: 'deferred', turns, budgetExhausted: true });
          const status = await this.tryFinish(claim, turnResult);
          if (status) return result({ finalStatus: status === 'pending' ? 'deferred' : status as WorkDriverResult['finalStatus'], turns });
          return result({ finalStatus: 'lost', turns });
        } catch (error) {
          if (this.cancelRequested || renewLost) break;
          const transient = error instanceof TransientModelError
            || (error instanceof Error && /temporarily_unavailable|SQLITE_BUSY|database is locked/i.test(error.message));
          if (!transient) {
            const status = await this.tryFinish(claim, { outcome: 'failed', reason: `model_failed: ${messageOf(error)}` });
            return status
              ? result({ finalStatus: status === 'pending' ? 'deferred' : status as WorkDriverResult['finalStatus'], turns, error: messageOf(error) })
              : result({ finalStatus: 'lost', turns });
          }
          if (remain() <= 0) return result({ finalStatus: 'deferred', turns, budgetExhausted: true, error: messageOf(error) });
          // Transient: bounded backoff inside the same request budget (T05).
          await sleep(this.backoffMs);
        }
      }
      if (this.cancelRequested) {
        await this.tryCancel(claim);
        return result({ finalStatus: 'cancelled', turns, cancelled: true });
      }
      return result({ finalStatus: 'lost', turns, error: renewLost ?? 'max_turns_exceeded' });
    } finally {
      this.renewActive = false;
    }
  }

  /** All adapter calls flow through here: turn deadline race, cancel
   *  propagation and late-result accounting live in one place. */
  private async callModel(prompt: string, deadlineAt: number, turn: number): Promise<string> {
    const turnDeadlineAt = Math.min(this.clock() + this.turnCap, deadlineAt);
    const turnAbort = new AbortController();
    const propagate = () => turnAbort.abort();
    if (this.externalAbort.signal.aborted) turnAbort.abort();
    else this.externalAbort.signal.addEventListener('abort', propagate, { once: true });
    const context: ModelCallContext = {
      deadlineAt,
      remainingBudgetMs: Math.max(0, deadlineAt - this.clock()),
      turnDeadlineAt,
      turn,
      signal: turnAbort.signal,
    };
    const call = this.adapter.call({ prompt, context });
    let settled = false;
    void call.then(() => { settled = true; }, () => { settled = true; });
    const timeoutWatch = (async () => {
      const wait = turnDeadlineAt - this.clock();
      if (wait > 0) await this.delay(wait);
      turnAbort.abort();
    })();
    try {
      return await Promise.race([
        call,
        timeoutWatch.then(() => { throw new TransientModelError('turn_deadline_exceeded'); }),
      ]);
    } catch (error) {
      // The call may still settle later; that result is late and is never
      // submitted. A host that cannot abort is marked degraded (T09).
      if (!settled && !this.adapter.supportsCancel) {
        void call.then(() => { this.degraded = true; }, () => { this.degraded = true; });
      }
      throw error;
    } finally {
      if (this.cancelRequested && !this.adapter.supportsCancel) this.degraded = true;
      this.externalAbort.signal.removeEventListener('abort', propagate);
    }
  }

  /** Finish through the core's transactional guard. Returns the persisted
   *  status, or null when the guard rejected a late submission. */
  private async tryFinish(claim: ClaimShape, turnResult: WorkTurnResult): Promise<string | null> {
    try {
      const { status } = await this.pond.finishHostWork({
        workId: claim.id, leaseToken: claim.leaseToken, outcome: turnResult.outcome,
        reason: turnResult.reason, ...(turnResult.organizationJobId ? { organizationJobId: turnResult.organizationJobId } : {}),
      });
      return status;
    } catch (error) {
      this.lastError = `finish rejected: ${messageOf(error)}`;
      return null;
    }
  }

  private async tryCancel(claim: ClaimShape): Promise<void> {
    try { await this.pond.cancelHostWork(claim.id, this.cancelReason); }
    catch { /* the core arbitrates the race; nothing further to do */ }
  }
}
