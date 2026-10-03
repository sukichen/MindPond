import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runOrganizationQuality,gradeOrganizationQuality,validateQualityDataset,type QualityAdapter } from '../src/eval/organization-quality.js';
import { digest, stableJSON } from '../src/core/growth.js';
const {values}=parseArgs({options:{dataset:{type:'string'},adapter:{type:'string'},output:{type:'string'},run:{type:'string'},judgments:{type:'string'},'budget-ms':{type:'string',default:'120000'},attempts:{type:'string',default:'2'}}});
const read=async(file:string)=>JSON.parse(await fs.readFile(file,'utf8'));
try {
  if(!values.output||!path.isAbsolute(values.output))throw new Error('--output /absolute/new-report.json is required');
  // Reserve the destination before running any model; never overwrite evidence.
  await fs.mkdir(path.dirname(values.output),{recursive:true});
  const file=await fs.open(values.output,'wx',0o600);
  try {
    let report:unknown;
    if(values.run&&values.judgments){
      const result=gradeOrganizationQuality(await read(values.run),await read(values.judgments));report=result;process.exitCode=result.releasePassed?0:1;
    } else if(!values.adapter){
      report={status:'not_run',reason:'No host model adapter supplied. MindPond does not read sample-agent or store model keys.',releasePassed:false};process.exitCode=2;
    } else {
      if(!values.dataset||!path.isAbsolute(values.adapter))throw new Error('--dataset and --adapter /absolute/host-module.mjs are required');
      const budgetMs=Number(values['budget-ms']),maxAttempts=Number(values.attempts);
      if(!Number.isInteger(budgetMs)||budgetMs<100||budgetMs>1800000||!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>5)throw new Error('Budget must be 100–1800000 ms and attempts 1–5');
      const data=validateQualityDataset(await read(values.dataset));
      const module=await import(pathToFileURL(values.adapter).href),adapter:QualityAdapter=module.default??module.adapter;
      const run=await runOrganizationQuality(data,adapter,{budgetMs,maxAttempts});
      report={...run,reviewDigest:digest(stableJSON(run))};
      // A successful run awaits independent judgments; it is not a quality pass.
      process.exitCode=2;
    }
    await file.writeFile(JSON.stringify(report,null,2)+'\n');console.log(values.output);
  } catch(error){await file.writeFile(JSON.stringify({status:'failed',error:String(error),releasePassed:false},null,2)+'\n');throw error;}
  finally {await file.close();}
} catch(error){console.error(String(error));process.exitCode=1;}
