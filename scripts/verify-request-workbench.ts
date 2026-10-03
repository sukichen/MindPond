/** Real HTTP request recovery and context-budget parity; --preview leaves a temporary UI running. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GraphMemory } from '../src/core/graph-memory.js';
const root=fileURLToPath(new URL('..',import.meta.url)), temp=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-request-ui-'));
const dbPath=path.join(temp,'memory.db'),env={...process.env,MEMORY_DB_PATH:dbPath,MEMORY_PORT:'0',MEMORY_HOST:'127.0.0.1',MEMORY_API_KEY:'',MEMORY_OPERATOR_KEY:'',MEMORY_CONTEXT_SECRET:'',EMBEDDING_ZH_ENABLED:'false',EMBEDDING_MODEL_DIR:path.join(temp,'missing-model')};
const g=new GraphMemory('.',{dbPath});let child:ChildProcess|undefined;
async function stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise<void>(resolve=>child!.once('exit',()=>resolve()));}}
async function start(){
  child=spawn(process.execPath,[path.join(root,'dist/server.js')],{env,stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout!.on('data',d=>{logs+=d;});child.stderr!.on('data',d=>{logs+=d;});
  const deadline=Date.now()+15000;while(!/listening on .*:(\d+)/.test(logs)&&Date.now()<deadline&&child.exitCode===null)await new Promise(r=>setTimeout(r,50));
  const port=/listening on .*:(\d+)/.exec(logs)?.[1];assert(port,logs);return 'http://127.0.0.1:'+port;
}
try {
  process.env.EMBEDDING_ZH_ENABLED='false';await g.init();
  for(const content of ['Local proxy is bound to loopback. Production is unverified.','Changing the local proxy port requires updating the launcher.','Proxy deployment documentation covers development only.'])
    await g.createNode({dimension:'fact',layer:'L1',content,memberships:[{spaceId:'demo/project',memoryType:'fact'}],embedding:[1,...Array(383).fill(0)]});
  await g.close();let base=await start();
  const api=async(route:string,body?:unknown)=>{const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const json=await r.json() as any;assert(r.ok,JSON.stringify(json));return json;};
  const scope={spaceId:'demo/project',memoryType:'fact',domain:{kind:'personal',id:'default'}};
  const created=await api('/api/host/organization/request/start',{...scope,batchSize:2,idempotencyKey:'ui-request'});
  assert.equal((await api('/api/host/organization/request/start',{...scope,batchSize:2,idempotencyKey:'ui-request'})).requestId,created.requestId);
  const listed=await api('/api/host/organization/requests',{domains:[scope.domain]});assert(listed.requests.some((r:any)=>r.requestId===created.requestId));
  const first=await api('/api/host/organization/request/next',{requestId:created.requestId});assert(first.job);
  await api('/api/host/organization/request/report',{requestId:created.requestId,jobId:first.job.id,result:'released',reason:'manual release'});
  const next=await api('/api/host/organization/request/next',{requestId:created.requestId});assert.notEqual(next.job.id,first.job.id);
  await api('/api/organization/validate',{jobId:next.job.id,plan:{operations:[]}});
  await api('/api/organization/commit',{jobId:next.job.id,plan:{operations:[]}});
  // No report: server restart must recover commit and the request from durable state.
  await stop();base=await start();
  const recovered=await api('/api/host/organization/request/next',{requestId:created.requestId});
  assert.equal(recovered.progress.concluded.no_change,2);
  if(recovered.job)await api('/api/host/organization/request/report',{requestId:created.requestId,jobId:recovered.job.id,result:'released',reason:'leave for UI'});
  const page=await api('/api/organization/request/'+created.requestId+'/events?afterSeq=0&limit=2');
  const later=await api('/api/organization/request/'+created.requestId+'/events?afterSeq='+page.events.at(-1).seq+'&limit=100');assert(later.events.every((e:any)=>e.seq>page.events.at(-1).seq));
  await api('/api/host/organization/request/cancel',{requestId:created.requestId,reason:'cancel unsubmitted only'});
  const final=await api('/api/organization/request/'+created.requestId);assert.equal(final.status,'cancelled');assert.equal(final.concluded.no_change,2);
  const hits=await api('/api/memory/search',{query:'proxy',contextBudgetBytes:2000,minScore:0});
  assert.equal(Buffer.byteLength(JSON.stringify({results:hits.results})),hits.contextBudget.used);assert(hits.contextBudget.used<=2000);
  const html=await (await fetch(base)).text();assert(html.includes('requestProgress'));assert(html.includes('operatorKey'));
  console.log('PASS HTTP workbench request index/start/release/reclaim/restart receipt recovery/cancel/events and exact context wire budget');
  if(process.argv.includes('--preview')){
    console.log('PREVIEW_URL='+base);
    await new Promise<void>(resolve=>{process.once('SIGTERM',()=>resolve());process.once('SIGINT',()=>resolve());});
  }
} finally {await stop();await g.close();await fs.rm(temp,{recursive:true,force:true});}
