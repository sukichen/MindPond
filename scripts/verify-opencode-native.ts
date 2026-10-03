/** Real Node worker/SQLite plus official OpenCode lifecycle hook contract.
 * Optional installed CLI acceptance uses noReply, so no remote model is used. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createOpenCodeMemoryPlugin } from '../src/integrations/opencode-plugin.js';
import { prepareClientBundle,clientLaunch } from '../dist/integrations/client-bundle.js';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-native-'));
const dbPath=path.join(temp,'memory.db');
const workerPath=fileURLToPath(new URL('../dist/integrations/host-worker.js',import.meta.url));
process.env.EMBEDDING_MODEL_DIR=path.join(temp,'missing-model');process.env.EMBEDDING_ZH_ENABLED='false';
const messages=new Map<string,any[]>([
 ['a',[{info:{id:'msg-a',role:'user'},parts:[{id:'part-a',type:'text',text:'Original scene: local proxy ECONNREFUSED; API_KEY=fixture-secret-1234567890'}]},
       {info:{id:'reason-a',role:'assistant'},parts:[{type:'reasoning',text:'PRIVATE REASONING MUST NEVER CAPTURE'}]},
       {info:{id:'summary-a',role:'assistant',summary:true},parts:[{type:'text',text:'COMPACTION SUMMARY MUST NEVER RECAPTURE'}]}]],
 ['b',[{info:{id:'msg-b',role:'user'},parts:[{type:'text',text:'Private scene B, never shared with A'}]}]],
]);
const host={directory:temp,worktree:temp,client:{session:{messages:async({path:{id}}:any)=>({data:messages.get(id)??[]})},app:{log:async()=>({})}}};
let plugin:Awaited<ReturnType<typeof createOpenCodeMemoryPlugin>>|undefined;
try {
  plugin=await createOpenCodeMemoryPlugin(host,{dbPath,workerPath,nodePath:path.join(temp,'no-worker'),timeoutMs:3000});
  await plugin.event({event:{type:'session.idle',properties:{sessionID:'a'}}});
  const outbox=path.join(temp,'.mindpond-opencode-outbox',createHash('sha256').update(path.resolve(dbPath)+'\0'+'default'+'\0'+createHash('sha256').update(temp).digest('hex').slice(0,20)).digest('hex').slice(0,32));
  assert((await fs.readdir(outbox)).some(n=>n.endsWith('.json')),'unavailable worker must leave durable public scene in outbox');
  await plugin.dispose();
  plugin=await createOpenCodeMemoryPlugin(host,{dbPath,workerPath,nodePath:process.execPath,timeoutMs:20000});
  await plugin['chat.message']({sessionID:'a'},{parts:[{type:'text',text:'Debug local proxy ECONNREFUSED'}]});
  const system={system:[] as string[]};await plugin['experimental.chat.system.transform']({sessionID:'a'},system);
  assert(system.system.some(text=>text.includes('memory_finish')));
  const compact={context:[] as string[]};await plugin['experimental.session.compacting']({sessionID:'a'},compact);
  assert(compact.context.some(text=>text.includes('captured')));
  await plugin.event({event:{type:'session.idle',properties:{sessionID:'b'}}});
  const scenes=JSON.parse(await plugin.tool.memory_event_search.execute({query:'local proxy ECONNREFUSED'},{sessionID:'a'}));
  assert(scenes.results.length>0);
  const text=JSON.stringify(scenes);
  assert(!text.includes('fixture-secret'));assert(text.includes('[redacted]'));
  assert(!text.includes('PRIVATE REASONING'));assert(!text.includes('COMPACTION SUMMARY'));assert(!text.includes('Private scene B'));
  const before=await open({filename:dbPath,driver:sqlite3.Database});
  const count=await before.get('SELECT COUNT(*) n FROM nodes WHERE layer=\'L0\'');assert.equal(count.n,2,'idle+compaction+resume must not duplicate the same scene');
  await before.close();
  const taskSchema=JSON.parse(await plugin.tool.memory_action.execute({tool:'work_task_create',describe:true},{sessionID:'a'}));
  assert(taskSchema.inputSchema.required.includes('contextId'));assert(taskSchema.inputSchema.properties.acceptanceCriteria);
  const organizationSchema=JSON.parse(await plugin.tool.memory_action.execute({tool:'memory_organization_claim',describe:true},{sessionID:'a'}));
  assert(organizationSchema.inputSchema.required.includes('spaceId'));assert.equal(organizationSchema.inputSchema.properties.maxMembers.maximum,24);
  await assert.rejects(plugin.tool.memory_action.execute({tool:'memory_dedupe_resolve',describe:true},{sessionID:'a'}),/scope_denied/);
  const capabilities=JSON.parse(await plugin.tool.memory_action.execute({tool:'memory_capabilities'},{sessionID:'a'}));
  assert(capabilities.hostConnection.availableOperations.includes('work_task_claim'));
  const stage={stageId:'native-milestone',operations:[{id:'save',kind:'save',input:{content:'Proxy diagnosis is provisional: ECONNREFUSED was observed; binding and production configuration still need verification.',domain:{kind:'personal',id:'default'}}}]};
  const saved=JSON.parse(await plugin.tool.memory_finish.execute(stage,{sessionID:'a'}));assert.equal(saved.status,'completed');
  assert.deepEqual(JSON.parse(await plugin.tool.memory_finish.execute(stage,{sessionID:'a'})),saved);
  await assert.rejects(plugin.tool.memory_action.execute({tool:'memory_event_search',arguments:{query:'proxy',sessionId:'foreign'}},{sessionID:'a'}),/scope_denied/);
  await plugin.event({event:{type:'session.deleted',properties:{sessionID:'a'}}});
  const closed=JSON.parse(await plugin.tool.memory_event_search.execute({query:'proxy'},{sessionID:'a'}));assert.equal(closed.results.length,0);
  await assert.rejects(plugin['chat.message']({sessionID:'a'},{parts:[]}),/Closed/);
  await plugin.dispose();
  plugin=await createOpenCodeMemoryPlugin(host,{dbPath,workerPath,nodePath:process.execPath});
  await assert.rejects(plugin['chat.message']({sessionID:'a'},{parts:[]}),/Closed/,'session closure marker must survive plugin restart');
  assert.equal(JSON.parse(await plugin.tool.memory_event_search.execute({query:'proxy'},{sessionID:'a'})).results.length,0);
  await plugin.dispose();plugin=undefined;
  console.log('PASS native hooks: real worker, automatic brief, scoped scenes, compaction, durable retries, redaction, no reasoning/summary capture, idempotent stage and session closure');
  if(process.env.MINDPOND_TEST_OPENCODE_BIN) {
    const server=net.createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(r=>server.close(()=>r()));
    const bundle=await prepareClientBundle({client:'opencode',directory:path.join(temp,'bundle'),dbPath:path.join(temp,'real.db'),nativeAdapter:true});
    const pluginRuntime=process.env.MINDPOND_TEST_OPENCODE_PLUGIN_DIR;
    if(pluginRuntime){await fs.mkdir(path.join(temp,'cfg/opencode'),{recursive:true});await fs.cp(path.join(pluginRuntime,'node_modules'),path.join(temp,'cfg/opencode/node_modules'),{recursive:true});await fs.copyFile(path.join(pluginRuntime,'package.json'),path.join(temp,'cfg/opencode/package.json'));}
    const launch=await clientLaunch(bundle.directory,['serve','--print-logs','--log-level','DEBUG','--hostname','127.0.0.1','--port',String(port)]);
    const child=spawn(process.env.MINDPOND_TEST_OPENCODE_BIN,launch.args,{cwd:temp,env:{...launch.env,XDG_CONFIG_HOME:path.join(temp,'cfg'),XDG_DATA_HOME:path.join(temp,'data'),XDG_CACHE_HOME:path.join(temp,'cache'),OPENCODE_DISABLE_DEFAULT_PLUGINS:'true',OPENCODE_DISABLE_MODELS_FETCH:'true'},stdio:['ignore','pipe','pipe']});
    let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
    const url='http://127.0.0.1:'+port;
    const request=async(route:string,body?:unknown,method=body===undefined?'GET':'POST')=>{console.log('OpenCode acceptance request',method,route);const r=await fetch(url+route,{signal:AbortSignal.timeout(route==='/session'?60000:15000),method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok)throw new Error(route+' HTTP '+r.status+' '+await r.text());return r.json();};
    try {
      let ready=false;for(let i=0;i<120;i++){try{await request('/global/health');ready=true;break;}catch{await new Promise(r=>setTimeout(r,250));}}
      assert(ready,'OpenCode server failed to start: '+logs.slice(-3000));
      const schema=await request('/doc');assert(schema.paths['/session/{sessionID}/message'],'installed CLI must publish the expected session API');
      const session=await request('/session',{});
      await request('/session/'+session.id+'/message',{noReply:true,parts:[{type:'text',text:'Inspect native memory session binding without invoking a model'}]});
      // Hook completion happens before noReply acknowledges the user message.
      const real=await open({filename:path.join(temp,'real.db'),driver:sqlite3.Database});
      try {const recall=await real.get('SELECT COUNT(*) n FROM memory_recalls');assert(recall.n>=1,'actual OpenCode chat.message hook must invoke automatic memory brief');}finally{await real.close();}
      await request('/session/'+session.id,undefined,'DELETE');
      const stateDb=await open({filename:path.join(temp,'real.db'),driver:sqlite3.Database});
      try{let closed=false;for(let i=0;i<40;i++){const row=await stateDb.get("SELECT status FROM memory_domains WHERE kind='session' AND id LIKE ?",['%:'+session.id]);if(row?.status==='closed'){closed=true;break;}await new Promise(r=>setTimeout(r,50));}assert(closed,'actual asynchronous OpenCode delete event must close the bound MindPond session');}finally{await stateDb.close();}
      console.log('PASS actual installed OpenCode: generated file plugin loads, native noReply session triggers a real MindPond recall, delete event closes session; no LLM/network inference');
    } catch(error){console.error('OpenCode acceptance server diagnostics:',logs.slice(-5000));throw error;} finally {child.kill('SIGTERM');await new Promise<void>(resolve=>{if(child.exitCode!==null)resolve();else{child.once('exit',()=>resolve());setTimeout(()=>{child.kill('SIGKILL');resolve();},3000).unref();}});}
  } else console.log('NOT_RUN actual OpenCode CLI; set MINDPOND_TEST_OPENCODE_BIN to enable. Native real-worker hook tests passed.');
} finally {await plugin?.dispose();await fs.rm(temp,{recursive:true,force:true});}
