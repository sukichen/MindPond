/** Host-injected model execution, bounded across attempts. No model credentials. */
import type { GraphMemory, OrganizationPlan } from './graph-memory.js';
import { organizationTask } from './organization-policy.js';
import { organizationPlanOutcome, type OrganizationRequestProgress } from './organization-request.js';
import type { ModelCallContext } from './work-driver.js';
import { MindPondError, toStructuredError } from './errors.js';

export interface OrganizationDriverLLM {
  /** Omit/false when cancellation is unavailable or unverified. */
  supportsCancel?: boolean;
  generate(prompt: string, context: ModelCallContext): Promise<string>;
}
const terminal = (p: OrganizationRequestProgress) => !['queued', 'running', 'waiting'].includes(p.status);
class ExecutionStopped extends Error {}

/** An ignored abort must never let a late reply reach commit. */
async function callModel(llm: OrganizationDriverLLM, prompt: string, context: ModelCallContext): Promise<string> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    stop = () => { abort.abort(); reject(new ExecutionStopped('execution cancelled or deadline exhausted')); };
    context.signal.addEventListener('abort', stop, { once: true });
    timer = setTimeout(stop, Math.max(0, context.turnDeadlineAt - Date.now()));
  });
  try {
    if (context.signal.aborted || Date.now() >= context.turnDeadlineAt) throw new ExecutionStopped('execution stopped before model call');
    return await Promise.race([Promise.resolve().then(() => llm.generate(prompt, { ...context, signal: abort.signal })), interrupted]);
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener('abort', stop);
  }
}

export async function driveOrganizationRequest(graph: GraphMemory, options: {
  requestId: string; llm: OrganizationDriverLLM; budgetMs?: number; leaseMs?: number;
  maxAttempts?: number; signal?: AbortSignal; teamAuthorization?: string;
}): Promise<OrganizationRequestProgress> {
  const budget = options.budgetMs ?? 120_000;
  const attempts = options.maxAttempts ?? 2;
  if (!Number.isFinite(budget) || budget <= 0 || !Number.isInteger(attempts) || attempts < 1 || attempts > 5)
    throw new MindPondError('invalid_input', 'budgetMs must be finite and positive; maxAttempts must be 1–5');
  const deadlineAt = Date.now() + budget;
  const signal = options.signal ?? new AbortController().signal;
  const status = async () => {
    const p = await graph.organizationRequests.getRequest(options.requestId);
    if (!p) throw new MindPondError('invalid_input', 'organization request not found');
    return p;
  };
  for (;;) {
    const current = await status();
    if (terminal(current)) return current;
    if (signal.aborted) return graph.organizationRequests.cancelRequest(options.requestId, 'host cancelled execution');
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return graph.organizationRequests.finishRequest(options.requestId, { reason: 'budget_exhausted' });
    // Core caps the lease. A shorter explicit lease also limits model execution.
    const claimed = await graph.organizationRequests.nextBatch(options.requestId, {
      leaseMs: options.leaseMs ?? Math.min(1_800_000, Math.max(10_000, remaining + 1000)),
    });
    if (!claimed.batch) return claimed.progress;
    const job = claimed.batch;
    const turnDeadlineAt = Math.min(deadlineAt, job.leaseExpiresAt ?? deadlineAt);
    let correction = '';
    let committed = false;
    try {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const task = organizationTask(job)!;
          const reply = await callModel(options.llm, task.prompt + correction, {
            deadlineAt, turnDeadlineAt, remainingBudgetMs: Math.max(0, deadlineAt - Date.now()), turn: attempt, signal,
          });
          if (signal.aborted || Date.now() >= turnDeadlineAt) throw new ExecutionStopped('late model result');
          const latest = await status();
          if (terminal(latest)) return latest;
          let plan: OrganizationPlan;
          try { plan = JSON.parse(reply); } catch {
            throw new MindPondError('invalid_input', 'reply must be a JSON object with operations', { field: 'operations', nextAction: 'Return only {"operations":[...]}; [] means an explicitly checked no_change.' });
          }
          await graph.validateOrganizationPlan(job.id, plan);
          await graph.commitOrganizationPlan(job.id, plan, options.teamAuthorization, { deadlineAt: turnDeadlineAt, signal });
          committed = true;
          const result = organizationPlanOutcome(plan);
          await graph.organizationRequests.reportBatch(options.requestId, job.id, { result });
          break;
        } catch (error) {
          if (committed) throw error; // A committed proposal is never regenerated after a lost report acknowledgement.
          const latest = await status();
          if (terminal(latest)) return latest;
          if (error instanceof ExecutionStopped || signal.aborted || Date.now() >= turnDeadlineAt) {
            if (signal.aborted) return graph.organizationRequests.cancelRequest(options.requestId, 'host cancelled execution');
            await graph.releaseOrganizationJob(job.id);
            await graph.organizationRequests.reportBatch(options.requestId, job.id, { result: 'released' });
            return graph.organizationRequests.finishRequest(options.requestId, {
              reason: 'budget_exhausted', detail: options.llm.supportsCancel ? 'model deadline exhausted' : 'late results rejected; host model cancellation is unavailable or unverified',
            });
          }
          const problem = toStructuredError(error);
          if (problem.code !== 'invalid_input' || attempt === attempts) {
            await graph.organizationRequests.reportBatch(options.requestId, job.id, { result: 'failed', reason: problem.message });
            break;
          }
          correction = '\n\nThe previous proposal was rejected. Correct the named error against the same complete material; do not invent IDs.\n' + JSON.stringify(problem);
        }
      }
    } finally {
      if (!committed) await graph.releaseOrganizationJob(job.id);
    }
  }
}
