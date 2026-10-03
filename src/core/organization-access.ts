import type { GraphMemory } from './graph-memory.js';
import { normalizeDomain } from './domain.js';
import { narrowTrustedDomain, type TrustedCallContext } from './trust.js';
import { MindPondError } from './errors.js';

/** IDs are not capabilities. Resolve persisted ownership before serving
 * request material/events or accepting a job transition on any transport. */
export async function authorizeOrganizationAccess(graph: GraphMemory, args: Record<string, unknown>, trusted: TrustedCallContext) {
  if (trusted.operator) return;
  const hidden = () => new MindPondError('scope_denied', 'organization target is unavailable in the trusted context');
  if (typeof args.requestId === 'string') {
    const request = await graph.organizationRequests.getRequest(args.requestId);
    if (!request) throw hidden();
    try { narrowTrustedDomain(trusted, request.domain, trusted.sessionId); } catch { throw hidden(); }
  }
  if (typeof args.jobId === 'string') {
    const job = await graph.getOrganizationJob(args.jobId);
    if (!job) throw hidden();
    try { narrowTrustedDomain(trusted, job.domain, trusted.sessionId); } catch { throw hidden(); }
  }
  if (args.spaceId !== undefined || args.domain !== undefined) {
    const domain = typeof args.domain === 'string' ? JSON.parse(args.domain) : args.domain;
    narrowTrustedDomain(trusted, normalizeDomain(domain, typeof args.sessionId === 'string' ? args.sessionId : (domain as {kind?:string})?.kind === 'session' ? trusted.sessionId : undefined), trusted.sessionId);
  }
}
