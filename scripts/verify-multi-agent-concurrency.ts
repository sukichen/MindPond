/** Real simultaneous MCP processes; protocol/concurrency evidence, not autonomous LLM behavior. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(import.meta.dirname, '..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-parallel-'));
const clients: Client[] = [];
const personal = {kind:'personal',id:'work-test'};
const scope = {spaceId:'project:parallel',memoryType:'fact'};
const decode = (r:any) => JSON.parse(r.content.find((c:any)=>c.type==='text').text);
async function call(c:Client,name:string,args:Record<string,unknown>={}) {
  const r=await c.callTool({name,arguments:args});
  assert(!r.isError,JSON.stringify(r));return decode(r);
}
async function connect(i:number,profile:'work'|'full'='work') {
  const c=new Client({name:'parallel-'+i,version:'1'});clients.push(c);
  await c.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/mcp.js')],
    env:{...process.env,MEMORY_DB_PATH:path.join(dir,'pond.db'),MINDPOND_TOOL_PROFILE:profile,
      MEMORY_TRUST_PRINCIPAL:'agent-'+i,MEMORY_TRUST_SESSION:'session-'+i,
      MEMORY_TRUST_DOMAINS:JSON.stringify([personal]),MEMORY_TRUST_OPERATOR:'0',
      EMBEDDING_ZH_ENABLED:'false',EMBEDDING_MODEL_DIR:path.join(dir,'missing-model')},stderr:'pipe'}));
  return c;
}
try {
  // Fresh DB startup is concurrent too: tests migration/PRAGMA contention.
  const [a,b,c]=await Promise.all([connect(0),connect(1),connect(2)]);
  const workTools=(await a.listTools()).tools;
  const names=workTools.map(t=>t.name);
  for(const name of ['memory_save','memory_save_policy','memory_brief','memory_update','memory_use_report',
    'memory_organization_commit','work_task_claim','work_task_transition'])assert(names.includes(name),name);
  for(const name of ['memory_l3_commit','memory_dedupe_resolve','memory_organization_request_start'])
    assert(!names.includes(name),'work catalog must omit '+name);
  const cap=await call(a,'memory_capabilities');
  assert.equal(cap.mcpConnection.toolProfile,'work');
  assert.deepEqual(cap.mcpConnection.availableTools,names);
  const policy=(await call(a,'memory_save_policy')).policy;
  assert.equal(policy.version,'memory-save.v3.1');
  for(const marker of ['multi-round','Environment:','Code:','User intent:','Effort is a trigger','expectedUpdatedAt'])
    assert(policy.milestoneGuidance.includes(marker),marker);
  const saveTool=workTools.find(t=>t.name==='memory_save')!;
  assert(Buffer.byteLength(saveTool.description!)<=800);
  assert(Buffer.byteLength(a.getInstructions()!)<=512);
  const full=await connect(3,'full');
  const fullTools=(await full.listTools()).tools;
  const bytes=(tools:typeof fullTools)=>Buffer.byteLength(JSON.stringify(tools));
  assert(bytes(workTools)<bytes(fullTools)*.8,'work profile must materially reduce the resident catalog');
  console.log(JSON.stringify({work:{tools:names.length,catalogBytes:bytes(workTools)},
    full:{tools:fullTools.length,catalogBytes:bytes(fullTools)},saveDescriptionBytes:Buffer.byteLength(saveTool.description!)}));

  const input={content:'Local integration uses a checked loopback proxy. Production behavior is unknown.',
    domain:personal,memberships:[scope],idempotencyKey:'one-observation'};
  const saved=await Promise.all([a,b,c].map(x=>call(x,'memory_save',input)));
  assert.equal(new Set(saved.map(s=>s.id)).size,1,'concurrent exact retries must create one logical memory');
  const id=saved[0].id;
  const conflict=await c.callTool({name:'memory_save',arguments:{...input,content:'Different claim'}});
  assert(conflict.isError);
  assert.equal(decode(conflict).error.code,'idempotency_conflict');
  console.log('PASS parallel saves: one receipt and conflicting key explicitly refused');

  const before=await call(a,'memory_get',{nodeId:id});
  const edits=await Promise.all([a,b].map((x,i)=>x.callTool({name:'memory_update',arguments:{
    nodeId:id,expectedUpdatedAt:before.updatedAt,content:'Checked loopback proxy, revision '+i+'. Production is unverified.',reason:'fresh evidence'}})));
  assert.equal(edits.filter(r=>!r.isError).length,1,'optimistic edits must not overwrite each other');
  assert.equal(decode(edits.find(r=>r.isError)).error.code,'stale_lease');
  assert.match(decode(edits.find(r=>r.isError)).error.message,/stale_snapshot/);
  console.log('PASS parallel edits: one update wins; stale update cannot overwrite');

  await call(a,'memory_save',{content:'PRIVATE PROCESS SESSION ZERO',memberships:[scope]});
  const other=await call(b,'memory_search',{query:'PRIVATE PROCESS SESSION ZERO',...scope,minScore:0});
  assert(!JSON.stringify(other).includes('PRIVATE PROCESS SESSION ZERO'));
  const denied=await b.callTool({name:'memory_search',arguments:{query:'private',sessionId:'session-0'}});
  assert(denied.isError);
  console.log('PASS host-bound sessions stay isolated while personal work memory is shared');

  const context=await call(a,'work_context_create',{domain:personal,goal:'Verify concurrent integration',
    participants:['agent-0','agent-1','reviewer']});
  const creations=await Promise.all([a,b].map(x=>x.callTool({name:'work_task_create',arguments:{
    contextId:context.id,title:'Review local proxy',expectedContextRevision:context.revision,
    acceptanceCriteria:['Provide checked source evidence']}})));
  assert.equal(creations.filter(r=>!r.isError).length,1,'context revision must atomically fence concurrent task creation');
  assert.match(decode(creations.find(r=>r.isError)).error.message,/stale_context_revision/);
  const task=decode(creations.find(r=>!r.isError));
  const claims=await Promise.all([a,b,c].map((x,i)=>x.callTool({name:'work_task_claim',arguments:{
    taskId:task.id,agentId:'agent-'+i,expectedRevision:task.revision}})));
  assert.equal(claims.filter(r=>!r.isError).length,1,'only one claimant can hold the task');
  const winner=claims.findIndex(r=>!r.isError),claim=decode(claims[winner]);
  const submit={taskId:task.id,agentId:'agent-'+winner,eventId:'submit-one',
    expectedRevision:claim.task.revision,leaseToken:claim.leaseToken,status:'submitted',
    reason:'Reviewed the source',resultRefs:['source://proxy@checked']};
  const submitted=await call([a,b,c][winner],'work_task_transition',submit);
  assert.equal(submitted.status,'submitted');
  assert.deepEqual(await call([a,b,c][winner],'work_task_transition',submit),submitted,'submission retry is idempotent');
  const accepted=await call(c,'work_task_transition',{taskId:task.id,agentId:'reviewer',eventId:'accept-one',
    expectedRevision:submitted.revision,status:'completed',reason:'Checked result evidence'});
  assert.equal(accepted.status,'completed');assert.deepEqual(accepted.resultRefs,['source://proxy@checked']);
  console.log('PASS task claim, evidence-bearing submission, replay and explicit acceptance');

  await Promise.all([a,b,c].map((x,i)=>call(x,'memory_save',{content:'Checked related proxy detail '+i,
    domain:personal,memberships:[scope]})));
  const jobs=await Promise.all([a,b,c].map(x=>call(x,'memory_organization_claim',{domain:personal,...scope,maxMembers:2})));
  const members=jobs.flatMap(j=>j.job?.members.map((m:any)=>m.membership.id)??[]);
  assert.equal(new Set(members).size,members.length,'concurrent organization leases cannot overlap');
  assert(members.length>=2,'organization concurrency test must actually lease material');
  for(let i=0;i<jobs.length;i++)if(jobs[i].job) {
    const released=await [a,b,c][i].callTool({name:'memory_organization_release',arguments:{jobId:jobs[i].job.id}});
    assert(!released.isError);
  }
  console.log('PASS concurrent organization snapshots lease disjoint members');
} finally {
  await Promise.allSettled(clients.map(c=>c.close()));
  await fs.rm(dir,{recursive:true,force:true});
}
