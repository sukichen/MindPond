/** R01 unified error contract. Core failures carry a stable code, retryability
 * and a next action so hosts react to structure instead of parsing prose
 * (roadmap §3.3). MindPondError messages keep the `code:` prefix — legacy
 * regex assertions on message text keep matching. Errors are data: no host
 * credentials, stack traces or internal paths are exposed through them. */

export type MindPondErrorCode =
  | 'invalid_input'            // correctable input problem; fix the named field and retry
  | 'idempotency_conflict'     // same scoped key, different normalized payload
  | 'source_revision_conflict' // same source locator, different revision/fingerprint
  | 'stale_lease'              // expired/superseded lease; re-claim before resubmitting
  | 'stale_version'            // optimistic version check failed; reload and retry
  | 'material_over_budget'     // material exceeds the organization budget; shrink the batch or read in segments — never truncate
  | 'scope_denied'             // outside trusted context/authorization; never auto-expand
  | 'temporarily_unavailable'  // transient (locks, index); bounded backoff within budget
  | 'internal';                // unexpected; report with diagnostics, do not blind-retry

export interface ErrorShape {
  code: MindPondErrorCode;
  message: string;
  field?: string;
  retryable: boolean;
  nextAction?: string;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
}

export class MindPondError extends Error {
  readonly code: MindPondErrorCode;
  readonly field?: string;
  readonly retryable: boolean;
  readonly nextAction?: string;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(code: MindPondErrorCode, detail: string, opts: Partial<Omit<ErrorShape, 'code' | 'message'>> = {}) {
    super(`${code}: ${detail}`);
    this.name = 'MindPondError';
    this.code = code;
    this.field = opts.field;
    this.retryable = opts.retryable ?? false;
    this.nextAction = opts.nextAction;
    this.retryAfterMs = opts.retryAfterMs;
    this.details = opts.details;
  }

  toJSON(): ErrorShape {
    return {
      code: this.code, message: this.message, retryable: this.retryable,
      ...(this.field !== undefined ? { field: this.field } : {}),
      ...(this.nextAction !== undefined ? { nextAction: this.nextAction } : {}),
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

/** Legacy bare `Error` messages are classified by pattern so every boundary
 * (HTTP/MCP/SDK) can map the same failure consistently. Specific patterns
 * precede the generic invalid_input fallback. */
const LEGACY_PATTERNS: Array<{ match: RegExp; shape: Omit<ErrorShape, 'message'> }> = [
  { match: /^stale_observation/, shape: { code: 'stale_version', retryable: true, nextAction: '先用 memory_source_get 读取最新 version，再携带 expectedVersion 重试' } },
  { match: /^stale_/, shape: { code: 'stale_lease', retryable: true, nextAction: '重新领取任务后携带当前租约与 attempts 重试' } },
  { match: /^idempotency_conflict/, shape: { code: 'idempotency_conflict', retryable: false, nextAction: '先查原回执；同 key 仅可重放相同载荷，修改必须用新 key 或显式修订' } },
  { match: /^Duplicate source reference/, shape: { code: 'invalid_input', retryable: false, nextAction: '去除完全重复的来源引用，或为不同版本使用不同 locator' } },
  { match: /^Cannot synthesize across memory domains|outside active domain scope|outside the readable domains|cannot cross memory domains/, shape: { code: 'scope_denied', retryable: false, nextAction: '在可信上下文与可见域内重试；不得自行扩大范围' } },
  { match: /^team_write_unauthorized/, shape: { code: 'scope_denied', retryable: false, nextAction: '团队写入需要真实用户请求并由宿主签发 teamAuthorization；LLM 文本不能产生该授权' } },
  { match: /SQLITE_BUSY|database is locked/, shape: { code: 'temporarily_unavailable', retryable: true, retryAfterMs: 250, nextAction: '在同一逻辑工作与剩余预算内退避后重试' } },
  { match: /Only failed work may be explicitly retried/, shape: { code: 'invalid_input', retryable: false, nextAction: '仅 failed 状态的工作可显式重试；先用 work/list 确认状态' } },
  { match: /requires |must |Invalid |invalid |not found|required/i, shape: { code: 'invalid_input', retryable: false } },
];

export function toStructuredError(err: unknown): ErrorShape {
  if (err instanceof MindPondError) return err.toJSON();
  const message = err instanceof Error ? err.message : String(err);
  for (const { match, shape } of LEGACY_PATTERNS) {
    if (match.test(message)) return { ...shape, message };
  }
  return { code: 'internal', message, retryable: false, nextAction: '保留诊断信息并报告；不要将其当作瞬时故障无限重试' };
}

export function httpStatus(code: MindPondErrorCode): number {
  switch (code) {
    case 'invalid_input': return 400;
    case 'scope_denied': return 403;
    case 'idempotency_conflict':
    case 'source_revision_conflict':
    case 'stale_lease':
    case 'stale_version': return 409;
    case 'temporarily_unavailable': return 503;
    default: return 500;
  }
}
