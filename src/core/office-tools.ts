import { z } from 'zod';
import { MindPondError } from './errors.js';
import type { GraphMemory } from './graph-memory.js';
import type { TrustedCallContext } from './trust.js';
import type { WorkCallRuntime } from './collaboration-wait.js';
import { OFFICE_GUIDES } from './office.js';
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
// Approved role runtimes can resolve the current user-assigned office on the
// server. Legacy clients still receive context_required without an explicit id.
const context = { workSessionId: id.optional(), officeId: id.optional() };
const mutation = { ...context, key: text(256) };
const fileAccess = z.object({
  mode: z.enum(['shared_worktree', 'separate_clone', 'text_only', 'unknown']),
  group: text(128).optional(),
  version: text(256).optional(),
  permission: z.enum(['read', 'write', 'unknown']),
  detail: text(2000)
});
export const agentConfigurationSchema = z.object({
  id,
  principal: text(128),
  name: text(120),
  host: text(64),
  state: z.enum(['pending', 'active', 'disabled']),
  expectedRevision: z.number().int().min(0)
});
export const projectConfigurationSchema = z.object({
  id,
  title: text(200),
  members: z.array(id).min(1).max(128),
  enabled: z.boolean(),
  expectedRevision: z.number().int().min(0)
});
export const officeConfigurationSchema = z.object({
  id,
  projectId: id.optional(),
  title: text(200),
  goal: text(4000),
  acceptance: text(4000),
  state: z.enum(['active', 'paused', 'completed', 'cancelled']),
  expectedRevision: z.number().int().min(0),
  deadline: z.number().int().positive(),
  maxRounds: z.number().int().min(1).max(100),
  seats: z
    .array(
      z.object({
        id,
        agentId: id,
        roleId: id.optional(),
        label: text(120),
        role: z.enum(['reporter', 'worker', 'reviewer', 'coordinator', 'observer'])
      })
    )
    .min(1)
    .max(50)
    .optional()
});
const exchangeSchema = z.object({
  ...mutation,
  action: z.enum(['send', 'ack', 'inbox']),
  afterSeq: z.number().int().min(0).optional(),
  recipient: id.optional(),
  kind: z.enum(['inform', 'request', 'reply', 'read', 'accepted']).optional(),
  body: text(20000).optional(),
  requestId: id.optional(),
  final: z.boolean().optional(),
  messageId: id.optional()
});
const materialSchema = z.object({
  ...mutation,
  action: z.enum(['publish', 'begin', 'chunk', 'finalize', 'get']),
  materialId: id.optional(),
  label: text(200).optional(),
  version: text(256).optional(),
  bytes: z.number().int().min(1).max(512000).optional(),
  chunks: z.number().int().min(1).max(64).optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  number: z.number().int().min(0).max(63).optional(),
  content: z.string().min(1).max(128000).optional()
});
const itemSchema = z.object({
  ...mutation,
  action: z.enum([
    'create',
    'claim',
    'renew',
    'submit',
    'verify',
    'transfer',
    'transfer_accept',
    'transfer_reject',
    'cancel'
  ]),
  itemId: id.optional(),
  expectedRevision: z.number().int().min(1).optional(),
  title: text(200).optional(),
  acceptance: text(4000).optional(),
  owner: id.optional(),
  reviewer: id.optional(),
  parentId: id.optional(),
  leaseToken: text(256).optional(),
  codeVersion: text(256).optional(),
  materialId: id.optional(),
  roundId: id.optional(),
  verdict: z.enum(['passed', 'changes_requested', 'blocked']).optional(),
  summary: text(4000).optional(),
  evidence: text(20000).optional(),
  target: id.optional()
});
function requireFields(args: Record<string, unknown>, keys: string[]) {
  for (const key of keys)
    if (args[key] === undefined) throw new MindPondError('invalid_input', `Required field: ${key}`);
}
export function officeOperations(graph: GraphMemory) {
  const op = (
    name: string,
    path: string,
    description: string,
    schema: z.ZodObject<any>,
    run: (a: any, t?: TrustedCallContext, r?: WorkCallRuntime) => Promise<unknown>
  ) => ({ name, path: '/api/work/office/' + path, description, schema, run });
  return [
    op(
      'work_bootstrap',
      'bootstrap',
      'At task start/reconnect discover server-authenticated agent, authorized seats and explicit work sessions. Multiple sessions require a user-selected context; never guess last active role. No tokens/local files needed.',
      z.object({ workSessionId: id.optional() }),
      (a, t) => graph.offices.bootstrap(a, t)
    ),
    op(
      'work_guide_get',
      'guide',
      'Read complete versioned collaboration instructions through MCP, without local docs or resources. Choose identity/workflow/materials/waiting.',
      z.object({ section: z.enum(['identity', 'workflow', 'materials', 'waiting']) }),
      async (a) => ({ protocolVersion: 2, section: a.section, guide: OFFICE_GUIDES[a.section] })
    ),
    op(
      'work_session_open',
      'session/open',
      'Bind THIS chat to a user-authorized assignmentId; retain returned workSessionId. Resume requires explicit existing id, never switch global role. Host owns authentication; no token arguments.',
      z.object({ assignmentId: id, workSessionId: id.optional(), end: z.boolean().optional() }),
      (a, t) => graph.offices.open(a, t)
    ),
    op(
      'work_office_get',
      'get',
      'Read authorized office seats, work items, material manifests and event pages. Follow nextCursor while hasMore. Connection/agent reports are observations, not verified local execution. Large events advertise detailAvailable: retrieve eventSeq/offset chunks; itemId returns full acceptance, roundId exact evidence. Follow nextItemsAfterId/nextMaterialsAfterId. No lease secrets returned.',
      z.object({
        officeId: id,
        itemId: id.optional(),
        roundId: id.optional(),
        eventSeq: z.number().int().positive().optional(),
        offset: z.number().int().min(0).optional(),
        itemsAfterId: id.optional(),
        materialsAfterId: id.optional(),
        itemIds: z.array(id).max(500).optional(),
        materialIds: z.array(id).max(500).optional(),
        afterSeq: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).optional()
      }),
      (a, t) => graph.offices.get(a, t)
    ),
    op(
      'work_office_exchange',
      'exchange',
      'Send inform/request/reply, read seat inbox or explicitly ack read/accepted. Requests unlock only by designated final reply with requestId; immutable key retries. queued/read is not completion. Approved character sessions can omit workSessionId and use their primary assigned office; legacy clients supply their explicit context.',
      exchangeSchema,
      async (a, t) => {
        if (a.action === 'send') {
          requireFields(a, ['recipient', 'kind', 'body']);
          if (!['inform', 'request', 'reply'].includes(a.kind))
            throw new MindPondError('invalid_input', 'Invalid message kind');
          if (a.kind === 'reply') requireFields(a, ['requestId', 'final']);
        }
        if (a.action === 'ack') {
          requireFields(a, ['messageId', 'kind']);
          if (!['read', 'accepted'].includes(a.kind))
            throw new MindPondError('invalid_input', 'Invalid acknowledgement kind');
        }
        return graph.offices.exchange(a, t);
      }
    ),
    op(
      'work_material',
      'material',
      'Text-only delivery: prefer publish {label,version,content,key}; the server computes UTF-8 bytes/SHA256 and chunks atomically, no shell/hash tool needed. For precomputed large transfers use begin → chunk → finalize. get reads a finalized chunk. Max 128000 characters for publish, 512KB/material, 16KB/chunk, 16MB/office. Stable key for writes.',
      materialSchema,
      async (a, t) => {
        requireFields(
          a,
          a.action === 'publish'
            ? ['label', 'version', 'content']
            : a.action === 'begin'
            ? ['label', 'version', 'bytes', 'chunks', 'sha256']
            : a.action === 'chunk'
              ? ['materialId', 'number', 'content']
              : ['materialId']
        );
        return graph.offices.material(a, t);
      }
    ),
    op(
      'work_office_item',
      'item',
      'Bounded delegated work with distinct worker/reviewer seats: create, claim/renew lease, submit exact material/version, verify matching round with actual evidence, propose/accept/reject transfer, cancel. Use revisions and stable keys. Transfer only changes owner on explicit target acceptance.',
      itemSchema,
      async (a, t) => {
        requireFields(
          a,
          a.action === 'create'
            ? ['title', 'acceptance', 'owner', 'reviewer']
            : ['itemId', 'expectedRevision']
        );
        if (['renew', 'submit'].includes(a.action)) requireFields(a, ['leaseToken']);
        if (a.action === 'submit') requireFields(a, ['codeVersion', 'materialId', 'summary']);
        if (a.action === 'verify')
          requireFields(a, ['roundId', 'codeVersion', 'verdict', 'summary', 'evidence']);
        if (a.action === 'transfer') requireFields(a, ['target']);
        return graph.offices.item(a, t);
      }
    ),
    op(
      'work_office_progress',
      'progress',
      'Report brief public action and why, or file access conditions for THIS work session. These are agent reports, never server-confirmed filesystem access or private chain of thought.',
      z.object({
        ...mutation,
        kind: z.enum(['progress', 'access_report']),
        action: text(500),
        why: text(1000),
        fileAccess: fileAccess.optional()
      }),
      (a, t) => graph.offices.progress(a, t)
    ),
    op(
      'work_office_wait',
      'wait',
      'Bounded HTTP-MCP wait: inbox, final reply requestId, or work item round result. Approved characters may omit workSessionId for their primary office; legacy callers keep it. default25s/max55s. Timeout is pending; resume only while user-authorized. No agent wakeup or autoack. Cancel/revoke/office termination stop waiting.',
      z.object({
        ...context,
        afterSeq: z.number().int().min(0).optional(),
        requestId: id.optional(),
        itemId: id.optional(),
        roundId: id.optional(),
        codeVersion: text(256).optional(),
        waitMs: z.number().int().min(100).max(55000).optional()
      }),
      async (a, t, r) => {
        if (a.requestId && a.itemId)
          throw new MindPondError('invalid_input', 'Choose one wait condition');
        if (a.roundId) requireFields(a, ['itemId', 'codeVersion']);
        return graph.offices.wait(a, t, r);
      }
    )
  ];
}
