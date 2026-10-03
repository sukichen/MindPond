import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { digest, stableJSON } from '../src/core/growth.js';
import { gradeOrganizationQuality, runOrganizationQuality, validateQualityDataset } from '../src/eval/organization-quality.js';
const dataset=validateQualityDataset(JSON.parse(await fs.readFile(fileURLToPath(new URL('../evals/datasets/organization-quality-seed.json',import.meta.url)),'utf8')));
assert.equal(dataset.cases.length,9);
assert.throws(()=>validateQualityDataset({...dataset,cases:[dataset.cases[0],{...dataset.cases[0],id:'another',split:'holdout'}]}),/leaks across/);
const sample={...dataset,cases:[dataset.cases[0],dataset.cases[4]]};
const adapter={id:'offline-fixture',modelId:'synthetic-no-change',kind:'synthetic' as const,parameters:{temperature:0},
  generate:async()=>({text:'{"operations":[]}',modelId:'synthetic-no-change',usage:{inputTokens:12,outputTokens:3}})};
const run=await runOrganizationQuality(sample,adapter,{budgetMs:30000,maxAttempts:1});
assert.equal(run.cases.length,2);
assert.equal(run.cost.modelCalls,2);
assert.equal(run.cost.inputTokens,24);
assert(run.cases.every(c=>c.engineeringPassed));
assert(run.cases.every(c=>c.calls.every((call:any)=>!call.prompt.includes(c.spec.forbidden[0]))),'hidden rubric must not be included in model prompt');
assert.equal(run.releasePassed,false);
assert.equal(dataset.cases.find(c=>c.id==='holdout-conditional')?.expectAssociation,false,'pre-existing context edge is not new-link recall');
assert.equal(dataset.cases.find(c=>c.id==='holdout-missing-link')?.expectAssociation,true);
const missingLinkCase=dataset.cases.find(c=>c.id==='holdout-missing-link')!;
const missingLinkRun=await runOrganizationQuality({...dataset,cases:[missingLinkCase]},adapter,{budgetMs:30000,maxAttempts:1});
const missingLink=missingLinkRun.cases[0];
assert.equal(missingLink.associations.length,0,'fixture must start without any relationship');
const missingLinkGrade=gradeOrganizationQuality(missingLinkRun,{
  runDigest:digest(stableJSON(missingLinkRun)),reviewerId:'independent-reviewer',independent:true,
  cases:[{caseId:missingLink.caseId,severeErrors:[],facts:missingLink.spec.facts.map((f:any)=>({id:f.id,preserved:true,direct:true,evidence:'Source retained.'})),
    forbidden:missingLink.spec.forbidden.map((claim:string)=>({claim,absent:true,evidence:'No false statement.'})),
    restraintCorrect:null,validOutcome:false,associations:[],requiredAssociationIds:[],notes:'Needed link was not formed.'}]
});
assert.equal(missingLinkGrade.metrics.associationRecall,0,'no-change cannot receive link recall credit');
assert(missingLinkGrade.blockers.includes('association_coverage'));

const judgment={runDigest:digest(stableJSON(run)),reviewerId:'independent-reviewer',independent:true as const,
  cases:run.cases.map(c=>({caseId:c.caseId,severeErrors:[],facts:c.spec.facts.map((f:any)=>({id:f.id,preserved:true,direct:true,evidence:'Seen in preserved active source.'})),
    forbidden:c.spec.forbidden.map((claim:string)=>({claim,absent:true,evidence:'No such conclusion in the output.'})),
    restraintCorrect:c.spec.expectRestraint?true:null,
    associations:(c.associations??[]).map((a:any)=>({id:a.id,valid:true,evidence:'Original context remains intact.'})),
    validOutcome:false,requiredAssociationIds:[],notes:'Synthetic no-change is structurally valid but not a correct outcome for the positive cases.'}))};
const grade=gradeOrganizationQuality(run,judgment);
assert.equal(grade.releasePassed,false);
assert(grade.blockers.includes('synthetic_model'));
assert(grade.blockers.includes('insufficient_independent_cases'));
assert(grade.blockers.includes('task_correctness'),'no-change must not pass positive organization cases');
assert.throws(()=>gradeOrganizationQuality(run,{...judgment,runDigest:'wrong'}),/another exact run/);
assert.throws(()=>gradeOrganizationQuality(run,{...judgment,cases:judgment.cases.slice(1)}),/exactly one/);
const bad=await runOrganizationQuality(sample,{...adapter,modelId:'expected-other'}, {budgetMs:30000,maxAttempts:1});
assert(bad.cases.every(c=>!c.engineeringPassed));
assert(bad.cases.every(c=>c.calls.some((call:any)=>String(call.error).includes('modelId'))));
console.log('PASS quality harness: group split, hidden labels, exact model ID, retry/cost receipts and independent gate');
