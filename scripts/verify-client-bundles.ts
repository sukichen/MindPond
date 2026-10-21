/** Generated configurations cannot select human domains or administrative catalogs. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {GraphMemory} from '../src/core/graph-memory.js';
import {roleRuntimeId} from '../src/core/roles.js';
import {prepareClientBundle,readClientBundle,removeClientBundle,clientLaunch} from '../src/integrations/client-bundle.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-role-bundles-')),dbPath=path.join(dir,'shared.db');
const graph=new GraphMemory('.',{dbPath}),clients:Client[]=[];
const admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
try{
 await fs.writeFile(path.join(dir,'embedding.json'),'{}');
 await graph.init();await graph.offices.configureAgent({id:'host',principal:'human',name:'Fixture',host:'codex',state:'active',expectedRevision:0},admin);
 const bundles=[],roles=[];
 for(const client of ['codex','claude','opencode'] as const){
  const options={client,directory:path.join(dir,client),dbPath,mcpPath:path.resolve('dist/mcp.js'),embeddingConfigPath:path.join(dir,'embedding.json'),modelDirectory:path.join(dir,'models')};
  const bundle=await prepareClientBundle(options);bundles.push(bundle);assert((await prepareClientBundle(options)).replayed);
  await assert.rejects(prepareClientBundle({...options,personalId:'default'}),/identity selectors/);
  await assert.rejects(prepareClientBundle({...options,toolProfile:'full'}),/identity selectors/);
  await assert.rejects(prepareClientBundle({...options,sessionId:'fixed-label'}),/identity selectors/);
  const actor={...admin,operator:false,agentId:'host',transport:'http-mcp' as const,runtimeId:roleRuntimeId('human','host','codex',client)};
  const app=await graph.roles.application({action:'submit',name:client,introduction:'Fictional',reason:'Bundle test',key:'apply'},actor);
  roles.push(await graph.roles.review({action:'approve',applicationId:app.applicationId,expectedRevision:1},admin));
 }
 const launch=await clientLaunch(bundles[0].directory,['mcp','get','mindpond','--json']);
 const parsed=JSON.parse((await promisify(execFile)(launch.command,launch.args,{cwd:dir,env:{...launch.env,CODEX_HOME:dir,HOME:dir},timeout:20000})).stdout);
 assert.equal(parsed.transport.env.MEMORY_DB_PATH,dbPath);
 assert.equal(parsed.transport.env.MINDPOND_EMBEDDING_CONFIG,path.join(dir,'embedding.json'));
 assert(!('MEMORY_TRUST_DOMAINS' in parsed.transport.env));
 const claude=JSON.parse(await fs.readFile(path.join(bundles[1].directory,'mcp.json'),'utf8'));
 assert.equal(claude.mcpServers.mindpond.env.MEMORY_DB_PATH,dbPath);
 const open=JSON.parse(await fs.readFile(path.join(bundles[2].directory,'opencode.json'),'utf8'));
 assert.equal(open.mcp.mindpond.enabled,false);assert.equal(open.plugin.length,1,'OpenCode native adapter supplies the real chat identity');
 const merged=await clientLaunch(bundles[2].directory,[],{OPENCODE_CONFIG_CONTENT:JSON.stringify({mcp:{other:{type:'local',command:['other']}},instructions:['existing.md']})});
 assert(JSON.parse(merged.env.OPENCODE_CONFIG_CONTENT!).mcp.other);
 await assert.rejects(clientLaunch(bundles[2].directory,[],{OPENCODE_CONFIG_CONTENT:JSON.stringify({mcp:{mindpond:{}}})}),/already declares/);
 const call=async(c:Client,name:string,args:any={},threadId?:string)=>{const r:any=await c.callTool({name,arguments:args,...(threadId?{_meta:{threadId}}:{})});return {r,data:JSON.parse(r.content[0].text)};};
 for(let i=0;i<3;i++){
  const env=i===0?parsed.transport.env:i===1?claude.mcpServers.mindpond.env:open.mcp.mindpond.environment;
  const client=new Client({name:'bundle-test',version:'1'});clients.push(client);
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/mcp.js')],env:{...process.env,...env,MINDPOND_TOOL_PROFILE:'full',MEMORY_TRUST_OPERATOR:'1',MEMORY_TRUST_DOMAINS:'[{"kind":"personal","id":"default"}]'} as Record<string,string>,stderr:'pipe'}));
  assert(!(await client.listTools()).tools.some(t=>t.name==='memory_message_save'||t.name==='memory_dedupe_scan'||t.name==='work_task_create'));
  assert.equal((await call(client,'memory_identity')).data.error.code,'identity_required','startup operator/domain settings cannot choose human identity');
  const identity=(await call(client,'memory_identity',{},['codex','claude','opencode'][i])).data;assert.equal(identity.owner.id,roles[i].roleId);assert.equal(identity.identity.humanFallback,false);
 }
 const saved=await call(clients[0],'memory_save',{content:'Role A private technique',idempotencyKey:'save'},'codex');assert(!saved.r.isError);
 assert((await call(clients[1],'memory_get',{nodeId:saved.data.id},'claude')).r.isError);
 const original=await fs.readFile(path.join(bundles[0].directory,'instructions.md'),'utf8');
 await fs.appendFile(path.join(bundles[0].directory,'instructions.md'),'edited');await assert.rejects(removeClientBundle(bundles[0].directory),/changed/);
 await fs.writeFile(path.join(bundles[0].directory,'instructions.md'),original);await fs.writeFile(path.join(bundles[0].directory,'unrelated.txt'),'keep');
 assert.equal((await readClientBundle(bundles[0].directory)).client,'codex');await removeClientBundle(bundles[0].directory);
 assert.equal(await fs.readFile(path.join(bundles[0].directory,'unrelated.txt'),'utf8'),'keep');assert(await fs.stat(dbPath));
 console.log('PASS three role-only bundles: installed Codex parser, model paths, OpenCode native metadata, additive merge, operator/profile override rejection, role isolation and safe removal');
}finally{await Promise.allSettled(clients.map(c=>c.close()));await graph.close();await fs.rm(dir,{recursive:true,force:true});}
