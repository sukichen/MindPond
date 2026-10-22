/** Approval must be delivered as an external event after real fixture mutation.
 * Scripted inference verifies the harness contract, never model effectiveness. */
import assert from 'node:assert/strict';
import { runOfficeEvaluation, evaluationMemoryActions, type OfficeEvalAdapter } from '../src/eval/office-collaboration.js';
assert(!evaluationMemoryActions('none').size);
assert(evaluationMemoryActions('recall').has('memory_search'));
assert(!evaluationMemoryActions('recall').has('memory_finish'),'Progressive actions cannot bypass a read-only condition');
assert(evaluationMemoryActions('recall_save').has('memory_finish'));
const adapter: OfficeEvalAdapter={
  id:'scripted-approval-contract',kind:'synthetic',parameters:{},
  async chat(messages){
    const call=(name:string,args:unknown)=>({message:{role:'assistant',content:null,tool_calls:[{id:'step-'+messages.length,type:'function',function:{name,arguments:JSON.stringify(args)}}]},modelId:'scripted-contract'});
    if(messages[1].content.startsWith('Investigate'))return {message:{role:'assistant',content:'No producer seed in this contract test.'},modelId:'scripted-contract'};
    const replies=messages.filter((m:any)=>m.role==='tool');
    if(!replies.length)return call('role_application',{action:'submit',name:'Fixture worker',introduction:'Synthetic contract participant',reason:'Authorized fictional approval check',key:'apply'});
    assert(messages.some((m:any)=>m.role==='user'&&m.content.includes('has approved this application')),'host must deliver the committed approval, not leave only a pending receipt');
    const taken=replies.map((m:any)=>JSON.parse(m.content)).find((r:any)=>r.content?.some((c:any)=>c.type==='text'&&c.text.includes('"messages":')));
    if(!taken)return call('office_receive',{action:'take',key:'take',officeId:'fixture-room'});
    const receipt=JSON.parse(taken.content[0].text);
    assert.equal(receipt.messages[0].state,'processing');
    if(!replies.some((m:any)=>JSON.parse(m.content).content?.some((c:any)=>c.type==='text'&&c.text.includes('"feedbackMessageId"'))))return call('office_message',{action:'finish',messageId:receipt.messages[0].id,result:'Synthetic approval-delivery contract checked; not a model quality result.',key:'finish'});
    return {message:{role:'assistant',content:'Synthetic contract completed.'},modelId:'scripted-contract'};
  }
};
const report=await runOfficeEvaluation(adapter,{repetitions:1,maxTurns:5,budgetMs:30000,caseIds:['onboarding']});
assert.equal(report.runs.length,4);
assert.equal(report.producerSeedReady,false);
assert.equal(report.releasePassed,false);
for(const run of report.runs.slice(1)){
  assert(!('error' in run),JSON.stringify(run));
  assert.equal(run.fixtureEvents.length,1);
  assert.equal(run.fixtureEvents[0].kind,'user_approval');
  assert.equal(run.assignedMessage.state,'archived');
  assert.equal(run.output,'Synthetic contract completed.');
}
console.log('PASS evaluation harness: committed approval delivered in every condition, actual message cycle completes, synthetic inference never establishes quality benefit');
