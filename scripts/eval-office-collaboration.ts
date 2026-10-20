import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runOfficeEvaluation } from '../src/eval/office-collaboration.js';
const { values } = parseArgs({ options: { adapter: { type: 'string' }, output: { type: 'string' }, repetitions: { type: 'string', default: '2' }, turns: { type: 'string', default: '12' }, 'budget-ms': { type: 'string', default: '180000' }, cases: { type: 'string' } } });
if (!values.output || !path.isAbsolute(values.output))
    throw Error('--output must be an absolute new private report path');
const repetitions = Number(values.repetitions), maxTurns = Number(values.turns), budgetMs = Number(values['budget-ms']);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10 || !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 30 || !Number.isInteger(budgetMs) || budgetMs < 1000 || budgetMs > 600000)
    throw Error('Invalid evaluation budget');
await fs.mkdir(path.dirname(values.output), { recursive: true, mode: 0o700 });
const file = await fs.open(values.output, 'wx', 0o600);
try {
    if (!values.adapter) {
        await file.writeFile(JSON.stringify({ status: 'not_run', reason: 'No host adapter supplied', releasePassed: false }) + '\n');
        process.exitCode = 2;
    }
    else {
        if (!path.isAbsolute(values.adapter))
            throw Error('--adapter must be an absolute host module path');
        const module = await import(pathToFileURL(values.adapter).href);
        const checkpoint = await fs.open(values.output + '.runs.jsonl', 'wx', 0o600);
        let report;
        try {
            report = await runOfficeEvaluation(module.default ?? module.adapter, { repetitions, maxTurns, budgetMs, caseIds: values.cases?.split(','), onProgress: message => console.log(message), onRun: async (run) => { await checkpoint.write(JSON.stringify(run) + '\n'); await checkpoint.sync(); } });
        }
        finally {
            await checkpoint.close();
        }
        await file.writeFile(JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify({ report: values.output, kind: report.adapter.kind, runs: report.runs.length, producerSeedReady: report.producerSeedReady, qualityStatus: report.qualityStatus }));
    }
}
finally {
    await file.close();
}
