/** Domain ownership and team-write authorization.  Domains are orthogonal to
 * semantic spaces: domain answers who/for-how-long; space/type answer what may
 * ripple together.  MindPond trusts the host to supply current identities. */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const DOMAIN_KINDS = ['session', 'personal', 'team'] as const;
export type MemoryDomainKind = typeof DOMAIN_KINDS[number];
export interface MemoryDomainRef { kind: MemoryDomainKind; id: string }
export type TeamOperation = 'save' | 'edit' | 'delete' | 'membership' | 'association' | 'organization' | 'task_context';
export interface TeamWriteGrant {
  v: 1;
  authorizationId: string;
  teamId: string;
  requestId: string;
  operations: TeamOperation[];
  issuedAt: number;
  expiresAt: number;
}

const text = (value: unknown, label: string, max = 256): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} requires 1–${max} characters`);
  return value.trim();
};
const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');
const decode = (value: string) => Buffer.from(value, 'base64url').toString('utf8');

export function normalizeDomain(input: unknown, sessionId?: string): MemoryDomainRef {
  const raw = input ?? (sessionId ? { kind: 'session', id: sessionId } : { kind: 'personal', id: 'default' });
  if (!raw || typeof raw !== 'object') throw new Error('domain requires {kind,id}');
  const kind = (raw as { kind?: unknown }).kind;
  if (!DOMAIN_KINDS.includes(kind as MemoryDomainKind)) throw new Error('domain.kind must be session, personal, or team');
  const id = text((raw as { id?: unknown }).id, 'domain.id');
  if (kind === 'session') {
    if (!sessionId) throw new Error('session domain requires sessionId');
    if (id !== sessionId) throw new Error('session domain.id must equal sessionId');
  }
  return { kind: kind as MemoryDomainKind, id };
}

export function domainKey(domain: MemoryDomainRef): string { return `${domain.kind}\u0000${domain.id}`; }
export function sameDomain(a: MemoryDomainRef, b: MemoryDomainRef): boolean { return a.kind === b.kind && a.id === b.id; }

/** M02.b: the single place that derives a readable-domain set from a trusted
 * host context.  personal/team = the user-configured readable set; session =
 * ONLY the current logical session declared alongside it.  Supplied session
 * entries are validated against that sessionId (normalizeDomain), so a caller
 * cannot widen into another session by listing it under `domains`.  With no
 * supplied set the default is personal/default plus the current session —
 * never a scan across all sessions. */
export interface DomainReadContext {
  /** Host-configured readable personal/team domains (plus the current session). */
  domains?: MemoryDomainRef[];
  /** The current logical session — the only session domain that may be read. */
  sessionId?: string;
}

export function resolveReadDomains(context: DomainReadContext): MemoryDomainRef[] {
  // An explicit empty grant set is different from an omitted context.
  // In particular, it must not fall back to personal/default.
  if (context.domains !== undefined) return context.domains.map(d => normalizeDomain(d, context.sessionId));
  return [
    { kind: 'personal', id: 'default' },
    ...(context.sessionId ? [{ kind: 'session' as const, id: context.sessionId }] : []),
  ];
}

/** The host creates this only from a real user event. Keep the secret in the
 * host/service configuration, never in an agent prompt or MCP tool. */
export function signTeamWriteGrant(grant: TeamWriteGrant, secret: string): string {
  validateGrant(grant);
  const payload = base64url(JSON.stringify(grant));
  return `${payload}.${base64url(createHmac('sha256', secret).update(payload).digest())}`;
}

export function verifyTeamWriteGrant(token: unknown, domain: MemoryDomainRef, operation: TeamOperation, secret = process.env.MEMORY_TEAM_AUTH_SECRET): TeamWriteGrant {
  if (domain.kind !== 'team') throw new Error('Team authorization is only valid for team domain');
  if (!secret) throw new Error('team_write_unauthorized: MEMORY_TEAM_AUTH_SECRET is not configured');
  if (typeof token !== 'string' || !token.includes('.')) throw new Error('team_write_unauthorized: a host-signed teamAuthorization is required');
  const [payload, signature, ...extra] = token.split('.');
  if (!payload || !signature || extra.length) throw new Error('team_write_unauthorized: malformed authorization');
  const expected = createHmac('sha256', secret).update(payload).digest();
  let received: Buffer;
  let grant: TeamWriteGrant;
  try { received = Buffer.from(signature, 'base64url'); grant = JSON.parse(decode(payload)); }
  catch { throw new Error('team_write_unauthorized: malformed authorization'); }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error('team_write_unauthorized: invalid signature');
  validateGrant(grant);
  if (grant.teamId !== domain.id || !grant.operations.includes(operation) || grant.expiresAt < Date.now())
    throw new Error('team_write_unauthorized: authorization does not cover this team, operation, or time');
  return grant;
}

function validateGrant(grant: TeamWriteGrant): void {
  if (!grant || grant.v !== 1) throw new Error('invalid team authorization version');
  text(grant.authorizationId, 'authorizationId'); text(grant.teamId, 'teamId'); text(grant.requestId, 'requestId');
  if (!Array.isArray(grant.operations) || !grant.operations.length || grant.operations.some(op => !['save','edit','delete','membership','association','organization','task_context'].includes(op)))
    throw new Error('invalid team authorization operations');
  if (!Number.isInteger(grant.issuedAt) || !Number.isInteger(grant.expiresAt) || grant.expiresAt <= grant.issuedAt)
    throw new Error('invalid team authorization expiry');
}
