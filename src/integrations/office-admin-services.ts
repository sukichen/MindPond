import { z } from 'zod';
import { MindPondError } from '../core/errors.js';
import type { GraphMemory } from '../core/graph-memory.js';
import type { TrustedCallContext } from '../core/trust.js';
import type { Request } from 'express';
import { readNetworkConfiguration } from './network-config.js';
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
export function officeAdminServices(graph: GraphMemory, route: (name: string, fn: (req: Request) => Promise<unknown>) => void, operator: TrustedCallContext, configFile?: string) {
    const office = z.object({ officeId: id });
    const coordinate = z.number().finite().min(0).max(50000);
    route('/layout', req => graph.officeCollaboration.captureLayout(office.extend({ width: coordinate, height: coordinate, seats: z.object({ id, roleId: id.nullable(), x: coordinate, y: coordinate, width: coordinate.optional(), height: coordinate.optional() }).array().max(200) }).strict().parse(req.body), operator));
    route('/relations', req => graph.officeCollaboration.relations(office.strict().parse(req.body), operator));
    route('/records', req => graph.officeCollaboration.records(office.extend({ kind: z.enum(['handoff', 'learning', 'marker', 'presence']).optional(), id: id.optional(), messageId: id.optional(), afterId: id.optional(), limit: z.number().int().min(1).max(50).optional() }).strict().parse(req.body), operator));
    route('/learning-memory', async (req) => {
        const input = office.extend({ recordId: id }).strict().parse(req.body), records = await graph.officeCollaboration.records({ officeId: input.officeId, kind: 'learning', id: input.recordId }, operator);
        const record = records.records[0];
        if (!record)
            throw new MindPondError('not_found','Learning record unavailable');
        const node = await graph.getNodeById(record.payload.memoryId, { trackAccess: false });
        return { record, memory: node ? { id: node.id, content: node.content, domain: node.domain, updatedAt: node.updatedAt, sourceRefs: node.sourceRefs } : null };
    });
    route('/handoff-context', req => graph.officeCollaboration.handoffContext(office.strict().parse(req.body), operator));
    route('/control', req => graph.officeCollaboration.requestControl(z.object({ roleId: id, action: z.enum(['pause', 'stop', 'resume']), reason: z.string().trim().min(1).max(1000) }).strict().parse(req.body), operator));
    route('/permissions', async (req) => {
        const input = z.object({ roleId: id }).strict().parse(req.body), result = await graph.officeCollaboration.permissions(input, operator);
        let memoryGrants: unknown = 'No private account configuration available in this Web process';
        if (configFile) {
            try {
                const config = await readNetworkConfiguration(configFile);
                memoryGrants = config.grants.filter(g => g.agentId === result.role!.connector_id && g.principal === result.role!.principal).map(g => ({ principal: g.principal, domains: g.domains, assignmentIds: g.assignmentIds ?? null }));
            } catch {
                memoryGrants = 'Private host grant configuration is unavailable; actual memory permissions remain unknown';
            }
        }
        return { ...result, memoryGrants };
    });
    route('/delete-impact', req => graph.officeCollaboration.impact(z.object({ kind: z.enum(['office', 'role', 'agent']), id }).strict().parse(req.body), operator));
    route('/export', req => graph.officeCollaboration.exportPage(office.extend({ section: z.enum(['office', 'seats', 'messages', 'materials', 'events', 'containers', 'handoffs', 'layouts']), snapshotId: id.optional(), offset: z.number().int().min(0).optional() }).strict().parse(req.body), operator));
    route('/operations', req => { const input = z.object({ action: z.enum(['status', 'capacity', 'backup', 'checkBackup', 'retentionPreview', 'retentionApply']), maxPerPrincipal: z.number().int().min(1).max(128).optional(), maxGlobal: z.number().int().min(1).max(1024).optional(), id: id.optional(), days: z.number().int().min(1).max(3650).optional() }).strict().parse(req.body); if (input.action === 'capacity' && (input.maxPerPrincipal === undefined || input.maxGlobal === undefined))
        throw new MindPondError('invalid_input','Choose both capacity limits'); if (input.action === 'checkBackup' && !input.id)
        throw new MindPondError('invalid_input','Choose a backup'); return graph.officeCollaboration.operations(input, operator); });
}
