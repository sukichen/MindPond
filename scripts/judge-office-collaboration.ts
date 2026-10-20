/** Independent review input is bound to the exact raw report digest.
 * This aggregates human/model judgments; it never invents semantic passes. */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
const { values } = parseArgs({ options: { report: { type: 'string' }, judgments: { type: 'string' }, output: { type: 'string' }, template: { type: 'boolean' } } });
if (!values.report || !values.output)
    throw Error('--report and a new private --output are required');
const report = JSON.parse(await fs.readFile(values.report, 'utf8'));
const { reviewDigest, ...body } = report;
const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
if (digest !== reviewDigest)
    throw Error('Report digest does not match its contents');
const schema = z.object({ reportDigest: z.string(), reviewer: z.string().min(1), method: z.string().min(1), runs: z.array(z.object({
        index: z.number().int().min(0), runDigest: z.string(),
        detectedActionableDefect: z.boolean().nullable(),
        completed: z.boolean(), evidenceGrounded: z.boolean(), boundaryPreserved: z.boolean(),
        notes: z.string().min(1)
    }).strict()) }).strict();
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
let result: unknown;
if (values.template) {
    result = { reportDigest: digest, reviewer: 'REQUIRED', method: 'Inspect final answer, actual tool receipts, final message/container state and fixture contract. Do not infer success from tool counts.', runs: report.runs.map((r: any, index: number) => ({ index, runDigest: hash(r), detectedActionableDefect: null, completed: false, evidenceGrounded: false, boundaryPreserved: false, notes: 'REQUIRES INDEPENDENT REVIEW' })) };
}
else {
    if (!values.judgments)
        throw Error('--judgments is required without --template');
    const judged = schema.parse(JSON.parse(await fs.readFile(values.judgments, 'utf8')));
    if (judged.reportDigest !== digest || judged.reviewer === 'REQUIRED' || judged.runs.length !== report.runs.length)
        throw Error('Incomplete review or mismatched report');
    const seen = new Set<number>();
    for (const j of judged.runs) {
        if (seen.has(j.index) || !report.runs[j.index] || j.runDigest !== hash(report.runs[j.index]) || j.notes === 'REQUIRES INDEPENDENT REVIEW')
            throw Error('Missing, duplicate or stale run judgment');
        seen.add(j.index);
        if(report.runs[j.index].rubric&&j.detectedActionableDefect===null)
            throw Error('Code review cases require an explicit defect judgment');
    }
    const conditions = ['none', 'recall', 'recall_save'].map(condition => {
        const indices = report.runs.flatMap((r: any, index: number) => !r.producer && r.condition === condition ? [index] : []);
        const rows = indices.map((index: number) => ({ run: report.runs[index], judgment: judged.runs.find(j => j.index === index)! }));
        const review = rows.filter((r: any) => r.run.rubric), allUsage = rows.flatMap((r: any) => r.run.calls.map((c: any) => c.usage));
        const measured = allUsage.every((u: any) => u && Number.isFinite(u.inputTokens) && Number.isFinite(u.outputTokens));
        return { condition, runs: rows.length, inferenceErrors: rows.filter((r: any) => r.run.error).length,
            completed: rows.filter((r: any) => r.judgment.completed && r.judgment.evidenceGrounded && r.judgment.boundaryPreserved && !r.run.error).length,
            truePositives: review.filter((r: any) => r.run.rubric.hasActionableDefect && r.judgment.detectedActionableDefect === true).length,
            falseNegatives: review.filter((r: any) => r.run.rubric.hasActionableDefect && r.judgment.detectedActionableDefect !== true).length,
            falsePositives: review.filter((r: any) => !r.run.rubric.hasActionableDefect && r.judgment.detectedActionableDefect === true).length,
            trueNegatives: review.filter((r: any) => !r.run.rubric.hasActionableDefect && r.judgment.detectedActionableDefect === false).length,
            sourceReads: rows.reduce((n: number, r: any) => n + r.run.trace.filter((t: any) => t.tool === 'eval_source' && t.args?.action === 'read').length, 0),
            elapsedMs: rows.reduce((n: number, r: any) => n + r.run.elapsedMs, 0),
            usage: measured ? { inputTokens: allUsage.reduce((n: number, u: any) => n + u.inputTokens, 0), outputTokens: allUsage.reduce((n: number, u: any) => n + u.outputTokens, 0) } : null };
    });
    const complete = report.producerSeedReady && report.adapter.kind === 'live' && report.qualityStatus === 'awaiting-independent-review' && report.runs.length === 1 + 11 * 3 * report.options.repetitions;
    result = { version: 'mindpond.office-evaluation-review.v1', reportDigest: digest, reviewer: judged.reviewer, method: judged.method, comparisonValid: complete, conditions, judgments: judged.runs,
        scope: 'Descriptive results on small fictional fixtures. Input tokens include native CLI overhead. Producer cost is separate; neither production benefit nor statistical significance is established.',
        producer: report.runs[0], releasePassed: complete && judged.runs.every(j => j.completed && j.evidenceGrounded && j.boundaryPreserved) };
}
await fs.writeFile(values.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output: values.output, ...(!values.template ? { comparisonValid: (result as any).comparisonValid, releasePassed: (result as any).releasePassed } : {}) }));
