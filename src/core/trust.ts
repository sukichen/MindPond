/** R03: trusted call context — the connection layer (HTTP header token or
 * stdio startup env) binds the principal, the allowed domains and the current
 * session. Request parameters may only NARROW what the trusted context
 * already allows; they can never widen it. The signing secret lives in host
 * configuration and is never exposed to the LLM, so a model cannot mint a
 * token, claim scope=operator, or point sessionId/domains at another tenant.
 *
 * Compatibility: with no MEMORY_CONTEXT_SECRET configured the server keeps
 * the pre-R03 behavior (request parameters carry the context) so existing
 * single-user deployments (rpbot, local workbench) keep working unchanged. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { MindPondError } from './errors.js';
import {
  domainKey, normalizeDomain,
  type DomainReadContext, type MemoryDomainRef,
} from './domain.js';

export interface TrustedCallContext {
  v: 1;
  principal: string;
  /** The only session this caller may touch; absent = no session access. */
  sessionId?: string;
  /** Host-configured readable personal/team domains (session rides on sessionId). */
  domains?: MemoryDomainRef[];
  /** Operator capabilities: audit log, global graph, maintenance, pipeline,
   * scope=operator reads. Granted by a signed operator token or x-operator-key. */
  operator?: boolean;
  issuedAt: number;
  expiresAt: number;
}

export type TrustedTokenInput = Omit<TrustedCallContext, 'v' | 'issuedAt' | 'expiresAt'> & {
  issuedAt?: number; expiresAt?: number;
};

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** Mint a context token for one caller. ttlMs default 12h. */
export function signContextToken(context: TrustedTokenInput, secret: string, ttlMs = 12 * 3600 * 1000): string {
  const issuedAt = context.issuedAt ?? Date.now();
  const payload = base64url(JSON.stringify({
    ...context, v: 1 as const, issuedAt, expiresAt: context.expiresAt ?? issuedAt + ttlMs,
  }));
  return `${payload}.${base64url(createHmac('sha256', secret).update(payload).digest())}`;
}

export function verifyContextToken(token: unknown, secret: string, now = Date.now()): TrustedCallContext {
  const bad = (detail: string) => new MindPondError('scope_denied', `trust context rejected: ${detail}`, { nextAction: '向宿主请求新的可信上下文令牌；不要自行构造' });
  if (typeof token !== 'string' || !token.includes('.')) throw bad('malformed context token');
  const [payload, signature, ...extra] = token.split('.');
  if (!payload || !signature || extra.length) throw bad('malformed context token');
  const expected = createHmac('sha256', secret).update(payload).digest();
  let received: Buffer;
  try { received = Buffer.from(signature, 'base64url'); } catch { throw bad('malformed signature'); }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw bad('signature mismatch');
  let parsed: any;
  try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw bad('malformed payload'); }
  if (parsed?.v !== 1 || typeof parsed.principal !== 'string' || !parsed.principal) throw bad('unsupported payload');
  if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= now) throw bad('context token expired');
  const context: TrustedCallContext = { v: 1, principal: parsed.principal, issuedAt: parsed.issuedAt ?? 0, expiresAt: parsed.expiresAt };
  if (typeof parsed.sessionId === 'string' && parsed.sessionId) context.sessionId = parsed.sessionId;
  if (Array.isArray(parsed.domains)) context.domains = parsed.domains.map((d: unknown) => normalizeDomain(d, context.sessionId));
  if (parsed.operator === true) context.operator = true;
  return context;
}

const denied = (detail: string) => new MindPondError('scope_denied', detail, { nextAction: '请求参数只能缩小可信上下文范围；需要更宽的访问请让用户/宿主签发新的上下文' });

/** The full allowed set: configured domains plus the bound session domain. */
export function trustedDomainSet(trusted: TrustedCallContext): Map<string, MemoryDomainRef> {
  const allowed = new Map<string, MemoryDomainRef>();
  for (const d of trusted.domains ?? []) {
    const n = normalizeDomain(d, trusted.sessionId);
    allowed.set(domainKey(n), n);
  }
  if (trusted.sessionId) {
    const session = { kind: 'session' as const, id: trusted.sessionId };
    allowed.set(domainKey(session), session);
  }
  return allowed;
}

/** Narrow a requested sessionId to the trusted binding. Absent → the trusted
 * session (multi-session hosts pick the session through the trusted context,
 * not through model-authored parameters). Any other id is denied. Operators
 * pass through: the human workbench may address any session. */
export function narrowTrustedSession(trusted: TrustedCallContext, sessionId: unknown): string | undefined {
  if (trusted.operator) return typeof sessionId === 'string' && sessionId.trim() ? sessionId : undefined;
  if (typeof sessionId !== 'string' || !sessionId.trim()) return trusted.sessionId;
  if (sessionId !== trusted.sessionId) throw denied(`session '${sessionId}' is outside the trusted context`);
  return sessionId;
}

/** Narrow a requested domain list to the trusted set. Absent/empty → the full
 * trusted set (never a global scan). Operators pass through. */
export function narrowTrustedDomains(trusted: TrustedCallContext, domains: unknown, sessionId?: string): MemoryDomainRef[] {
  const requested = typeof domains === 'string'
    ? (() => { try { return JSON.parse(domains); } catch { return domains; } })()
    : domains;
  if (trusted.operator) {
    return Array.isArray(requested) && requested.length
      ? requested.map((d: unknown) => normalizeDomain(d, sessionId))
      : [];
  }
  if (!Array.isArray(requested) || !requested.length) {
    // Absent → the FULL trusted set, including the session entry (downstream
    // resolveReadDomains does not append the session when domains are given).
    const allowed = [...trustedDomainSet(trusted).values()];
    // Downstream legacy SDK calls interpret an empty list as their defaults.
    // A signed caller with no grants must never fall back to personal/default.
    if (!allowed.length) throw denied('the trusted context grants no readable domains');
    return allowed;
  }
  const allowed = trustedDomainSet(trusted);
  return requested.map((d: unknown) => {
    // A session entry for any other session is a widening attempt — classify
    // it as scope_denied, not as a plain validation error.
    const ref = d as { kind?: unknown; id?: unknown } | null;
    if (ref && typeof ref === 'object' && ref.kind === 'session' && ref.id !== trusted.sessionId) {
      throw denied(`session '${String(ref.id)}' is outside the trusted context`);
    }
    const n = normalizeDomain(d, sessionId);
    if (!allowed.has(domainKey(n))) throw denied(`domain ${n.kind}:${n.id} is outside the trusted context`);
    return n;
  });
}

/** Narrow a single ownership domain (write target). */
export function narrowTrustedDomain(trusted: TrustedCallContext, domain: unknown, sessionId?: string): MemoryDomainRef | undefined {
  if (domain === undefined || domain === null) return undefined;
  if (trusted.operator) return normalizeDomain(domain, sessionId ?? (domain as {kind?:string;id?:string})?.id);
  const ref = domain as { kind?: unknown; id?: unknown } | null;
  if (ref && typeof ref === 'object' && ref.kind === 'session' && ref.id !== trusted.sessionId) {
    throw denied(`session '${String(ref.id)}' is outside the trusted context`);
  }
  const n = normalizeDomain(domain, sessionId ?? trusted.sessionId);
  if (!trustedDomainSet(trusted).has(domainKey(n))) throw denied(`domain ${n.kind}:${n.id} is outside the trusted context`);
  return n;
}

/** A durable write must not acquire hidden session provenance. Exact personal
 * retries may move between hosts; explicit source sessions remain significant. */
export function narrowTrustedSaveContext(
  trusted: TrustedCallContext, args: { sessionId?: unknown; domain?: unknown },
): { sessionId?: string; domain?: MemoryDomainRef } {
  const sessionId = narrowTrustedSession(trusted, args.sessionId);
  const domain = narrowTrustedDomain(trusted, normalizeDomain(args.domain, sessionId), sessionId);
  return { domain, sessionId: domain?.kind === 'session' || args.sessionId !== undefined ? sessionId : undefined };
}

/** Narrow requested read parameters ({sessionId, domains, scope}) against the
 * trusted context for bounded-entry routes. Returns 'operator' when the caller
 * holds operator capability (routes then keep legacy unrestricted semantics);
 * otherwise returns the narrowed downstream read context. Throws scope_denied
 * on any widening attempt. Absent parameters default to the trusted set. */
export function narrowTrustedContext(
  trusted: TrustedCallContext,
  src: { sessionId?: unknown; domains?: unknown; scope?: unknown },
): DomainReadContext | 'operator' {
  if (trusted.operator) return 'operator';
  if (src.scope === 'operator') throw denied('operator capability requires a trusted operator context');
  const sessionId = narrowTrustedSession(trusted, src.sessionId);
  const domains = narrowTrustedDomains(trusted, src.domains, sessionId);
  return { sessionId, domains };
}
