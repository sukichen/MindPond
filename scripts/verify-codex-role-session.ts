/** Installed Codex App Server emits real _meta.threadId through HTTP MCP.
 * Isolated CODEX_HOME/database; no turn/start, model inference or user secrets. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {GraphMemory} from '../src/core/graph-memory.js';
import {createNetworkMcpApp} from '../src/integrations/network-server.js';
import {tokenDigest} from '../src/integrations/network-config.js';
const binary=process.env.MINDPOND_TEST_CODEX_BIN;
if(!binary)throw Error('Set MINDPOND_TEST_CODEX_BIN to an installed Codex executable');
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-codex-roles-'));
const graph=new GraphMemory('.',{dbPath:path.join(dir,'fixture.db')});
const token='fixture-codex-host-'.repeat(3).slice(0,43),admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
let network:any,listener:any,child:ChildProcessWithoutNullStreams|undefined,logs='',sequence=0;
const pending=new Map<number,{resolve:(v:any)=>void,reject:(e:Error)=>void,timer:ReturnType<typeof setTimeout>}>();
async function stop(){
  if(!child)return;const old=child;child=undefined;
  if(old.exitCode===null){old.stdin.end();await new Promise<void>(resolve=>{const timer=setTimeout(()=>{old.kill('SIGKILL');},5000);old.once('exit',()=>{clearTimeout(timer);resolve();});});}
}
async function rpc(method:string,params:any){
  assert(child&&child.exitCode===null,'Codex fixture is not running');const id=++sequence;
  return new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('Codex fixture timeout: '+method));},40000);
    pending.set(id,{resolve,reject,timer});child!.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
}
async function start(){
  child=spawn(binary!,['--no-daemon','app-server','--stdio'],{cwd:dir,env:{PATH:process.env.PATH,HOME:dir,CODEX_HOME:dir,RUST_LOG:'error',MINDPOND_FIXTURE_CODEX_TOKEN:token},stdio:['pipe','pipe','pipe']});
  child.stderr.on('data',v=>logs=(logs+v).slice(-6000));
  const lines=createInterface({input:child.stdout});lines.on('line',line=>{
    let r:any;try{r=JSON.parse(line);}catch{return;}
    const request=pending.get(r.id);if(!request||(!('result'in r)&&!r.error))return;
    clearTimeout(request.timer);pending.delete(r.id);if(r.error)request.reject(Error(JSON.stringify(r.error)));else request.resolve(r.result);
  });
  child.on('exit',()=>{lines.close();for(const [id,p] of pending){clearTimeout(p.timer);p.reject(Error('Codex fixture exited'));pending.delete(id);}});
  await rpc('initialize',{clientInfo:{name:'mindpond-codex-role-verification',version:'1'},capabilities:{experimentalApi:true}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized'})+'\n');
}
async function tool(threadId:string,server:string,name:string,args:any={}){
  // No supplied _meta: the installed Codex itself must inject its threadId.
  const r=await rpc('mcpServer/tool/call',{threadId,server,tool:name,arguments:args});
  assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content.find((c:any)=>c.type==='text').text);
}
try{
  await graph.init();await graph.offices.configureAgent({id:'codex-fixture',principal:'human',name:'Codex fixture',host:'codex',state:'active',expectedRevision:0},admin);
  const hosts=['127.0.0.1'];network=createNetworkMcpApp(graph,{allowedHosts:hosts,maxPerAccount:32,configuration:async()=>({version:2,grants:[{principal:'human',agentId:'codex-fixture',credentialId:'fixture',tokenHash:tokenDigest(token),domains:[{kind:'personal',id:'default'}],toolProfile:'office'}]})});
  listener=network.app.listen(0,'127.0.0.1');await new Promise<void>(r=>listener.once('listening',r));const port=listener.address().port;hosts.push('127.0.0.1:'+port);
  const config=['mindpond_office','mindpond_memory'].map((name,i)=>`[mcp_servers.${name}]\nurl = "http://127.0.0.1:${port}/${i?'memory/mcp':'mcp'}"\nbearer_token_env_var = "MINDPOND_FIXTURE_CODEX_TOKEN"\nhttp_headers = { "X-MindPond-Session" = "old-shared-installation" }\ntool_timeout_sec = 60\n`).join('\n')+`\n[mcp_servers.mindpond_local]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(path.resolve('dist/mcp.js'))}]\ntool_timeout_sec = 90\n[mcp_servers.mindpond_local.env]\nMEMORY_DB_PATH = ${JSON.stringify(path.join(dir,'fixture.db'))}\n`;
  const isolatedProvider=`model = "fixture-no-inference"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Disabled inference fixture"\nbase_url = "http://127.0.0.1:${port}/disabled-model"\nwire_api = "responses"\nrequires_openai_auth = false\n`;
  await fs.writeFile(path.join(dir,'config.toml'),isolatedProvider+'\n'+config,{mode:0o600});await start();
  const threads:string[]=[],roles:string[]=[];
  for(const label of ['A','B']){
    const t=await rpc('thread/start',{cwd:dir,approvalPolicy:'never',sandbox:'read-only',ephemeral:true});const id=t.thread.id;threads.push(id);
    assert.equal((await tool(id,'mindpond_office','role_sync')).state,'unregistered');
    const before=await rpc('mcpServer/tool/call',{threadId:id,server:'mindpond_local',tool:'memory_identity',arguments:{}});assert(before.isError,'unbound local stdio chat must not become human');
    const app=await tool(id,'mindpond_office','role_application',{action:'submit',name:'Fictional Codex '+label,introduction:'Installed harness isolation regression',reason:'No model inference',key:'apply'});
    const role=await graph.roles.review({action:'approve',applicationId:app.applicationId,expectedRevision:1},admin);roles.push(role.roleId);
    const sync=await tool(id,'mindpond_office','role_sync');assert.equal(sync.identity.roleId,role.roleId);assert.equal(sync.identity.bindingMode,'codex_metadata');
    assert.equal((await tool(id,'mindpond_memory','memory_identity')).owner.id,role.roleId);assert.equal((await tool(id,'mindpond_local','memory_identity')).owner.id,role.roleId);
  }
  assert.notEqual(threads[0],threads[1]);assert.notEqual(roles[0],roles[1]);
  const saved=await tool(threads[0],'mindpond_local','memory_save',{content:'Fictional Codex A private knowledge',idempotencyKey:'save'});
  const foreign=await rpc('mcpServer/tool/call',{threadId:threads[1],server:'mindpond_memory',tool:'memory_get',arguments:{nodeId:saved.id}});assert(foreign.isError,'B cannot read A knowledge');
  await rpc('config/mcpServer/reload',{});
  assert.equal((await tool(threads[0],'mindpond_office','role_sync')).identity.roleId,roles[0]);
  assert.equal((await tool(threads[0],'mindpond_memory','memory_get',{nodeId:saved.id})).content,'Fictional Codex A private knowledge');
  console.log('PASS installed Codex: two real threads over one configuration, native per-call threadId beats old header, separate Office/Memory and local stdio identities, local-save attribution, private knowledge fencing and real MCP reload; no model inference');
}catch(error){console.error('Codex fixture diagnostics:',logs.replaceAll(token,'[fixture credential]'));throw error;}
finally{await stop();await network?.close();if(listener)await new Promise<void>(r=>listener.close(r));await graph.close();await fs.rm(dir,{recursive:true,force:true});}
