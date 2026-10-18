import { z } from 'zod';
import type { GraphMemory } from './graph-memory.js';
import type { TrustedCallContext } from './trust.js';
import type { WorkCallRuntime } from './collaboration-wait.js';
import { MindPondError } from './errors.js';
import { OFFICE_WAIT_MS } from './office-wait-policy.js';
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
export const containerSchema = z.object({ action: z.enum(['list', 'get', 'save', 'archive']), officeId: id, id: id.optional(), title: text(200).optional(), content: z.unknown().optional(), expectedRevision: z.number().int().min(0).optional(), key: text(256).optional(), afterId: id.optional() });
function required(i: Record<string, unknown>, names: string[]) { if (names.some(k => i[k] === undefined))
    throw new MindPondError('invalid_input', 'Required fields: ' + names.join(', ')); }
export function parseContainerInput(input:unknown) {
    const i=containerSchema.parse(input);
    required(i,i.action==='list'?[]:i.action==='get'?['id']:i.action==='save'?['id','title','content','expectedRevision','key']:['id','expectedRevision','key']);
    return i;
}
export function buildingOperations(graph: GraphMemory) {
    const op = (name: string, description: string, schema: z.ZodObject<any>, run: (i: any, a?: TrustedCallContext, r?: WorkCallRuntime) => Promise<unknown>) => ({ name, description, schema, run });
    return [
        op('office_material', 'Optional text shelf in an authorized office. publish requires officeId,title,content,key; version is an optional user label. get reads materialId and chunk number (default0). Content is immutable; server computes byte count and digest. No task or review required.', z.object({ action: z.enum(['publish', 'get']), officeId: id, materialId: id.optional(), number: z.number().int().min(0).max(63).optional(), title: text(200).optional(), content: z.string().min(1).max(128000).optional(), version: text(256).optional(), key: text(256).optional() }), (i, a) => { required(i, i.action === 'publish' ? ['title', 'content', 'key'] : ['materialId']); return graph.building.material(i, a); }),
        op('office_directory', 'List this approved role’s permitted offices and contacts; officeId reads room description and members. Rooms have no prescribed workflow.', z.object({ officeId: id.optional() }), (i, a) => graph.building.directory(i, a)),
        op('office_receive', 'Read messages only, without acknowledging, prioritizing work or interpreting content. Default10/max20. Pass nextCursor as afterSeq for the next page. includeArchived reads archived mail; direction=inbox(default)/sent/all; replyTo filters replies to an accessible message. Empty means no matching messages.', z.object({ afterSeq: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(20).optional(), includeArchived: z.boolean().optional(), direction: z.enum(['inbox', 'sent', 'all']).optional(), officeId: id.optional(), replyTo: id.optional() }), (i, a) => graph.building.receive(i, a)),
        op('office_message', 'Send plain text to a permitted roleId, optionally tagged with officeId. replyTo alone routes to the original correspondent; recipient optional for replies. No required request/final/verification workflow. get reads your message; read/archive only change recipient mailbox state. Stable key for mutations; arbitrary metadata is stored as data, not interpreted. Authentication stays in the host.', z.object({ action: z.enum(['send', 'get', 'read', 'archive']), key: text(256).optional(), recipient: id.optional(), body: text(20000).optional(), replyTo: id.optional(), officeId: id.nullable().optional(), messageId: id.optional(), metadata: z.record(z.string(), z.unknown()).optional() }), (i, a) => { required(i, i.action === 'get' ? ['messageId'] : i.action === 'send' ? ['key', 'body', ...(i.replyTo ? [] : ['recipient'])] : ['key', 'messageId']); if (Buffer.byteLength(JSON.stringify(i.metadata ?? {})) > 8000)
            throw new MindPondError('invalid_input', 'Metadata exceeds 8KB'); return graph.building.message(i, a); }),
        op('office_wait', 'Long-poll incoming messages or replies to replyTo. waitMs is milliseconds: default300000/max300000 (5 minutes); stays open until arrival, cancellation or deadline. On timeout/pending, call again with returned resume while user-authorized waiting budget remains; do not end an ongoing wait after one window. afterSeq is the consumed-message cursor. matched means arrival only; timeout is no work result. Does not wake a stopped host.', z.object({ afterSeq: z.number().int().min(0).optional(), replyTo: id.optional(), waitMs: z.number().int().min(100).max(OFFICE_WAIT_MS).optional() }), (i, a, r) => graph.building.wait(i, a, r)),
        op('office_container', 'Optional user-defined JSON/text container in an authorized office. No predefined fields, statuses or business rules. list/get read; save requires id,title,content,expectedRevision (0=new),key; archive requires id,current revision,key. At most64KB per container. Current revision prevents lost updates.', containerSchema, (i, a) => graph.building.container(parseContainerInput(i), a))
    ];
}
