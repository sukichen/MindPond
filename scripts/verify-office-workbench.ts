import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GraphMemory } from '../src/core/graph-memory.js';
import { officeWorkbench } from '../src/integrations/office-workbench.js';
import { readNetworkConfiguration } from '../src/integrations/network-config.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-office-web-')),
  config = path.join(dir, 'accounts.json'),
  graph = new GraphMemory('.', { dbPath: path.join(dir, 'db') });
let server: import('node:http').Server | undefined;
try {
  await graph.init();
  const app = express();
  app.use(express.json());
  const workbench=officeWorkbench(graph, {
    apiKey: 'fixture-api', operatorKey: 'fixture-operator', contextSecret: 'fixture-secret', configFile: config
  });
  app.use('/api/office-admin',workbench);
  app.use('/mindpond/api/office-admin',workbench);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server!.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/office-admin/`;
  let cookie = '';
  const req = async (route: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers },
      body: JSON.stringify(body)
    });
  assert.equal((await req('state')).status, 401);
  assert.equal(
    (await req('login', { apiKey: 'fixture-api', operatorKey: 'not-the-operator' })).status,
    403
  );
  assert.equal(
    (
      await req(
        'login',
        { apiKey: 'fixture-api', operatorKey: 'fixture-operator' },
        { Origin: 'https://untrusted.example' }
      )
    ).status,
    403
  );
  const login = await req('login', { apiKey: 'fixture-api', operatorKey: 'fixture-operator' });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert(login.headers.get('set-cookie')!.includes('HttpOnly'));
  assert(login.headers.get('set-cookie')!.includes('SameSite=Strict'));
  assert(login.headers.get('set-cookie')!.includes('Path=/api/office-admin;'));
  const proxyBase=base.replace('/api/office-admin/','/mindpond/api/office-admin/');
  const proxyRequest=(route:string,body:unknown={},cookieHeader='')=>fetch(proxyBase+route,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookieHeader,Origin:new URL(proxyBase).origin},body:JSON.stringify(body)});
  const proxied=await proxyRequest('login',{apiKey:'fixture-api',operatorKey:'fixture-operator',cookiePath:'/mindpond/api/office-admin'});
  assert.equal(proxied.status,200);
  const proxySetCookie=proxied.headers.get('set-cookie')!;
  assert(proxySetCookie.includes('HttpOnly')&&proxySetCookie.includes('SameSite=Strict'));
  const cookiePath=/; Path=([^;]+)/i.exec(proxySetCookie)![1];
  const browserCookie=new URL(proxyBase+'state').pathname.startsWith(cookiePath+'/')?proxySetCookie.split(';')[0]:'';
  assert.equal((await proxyRequest('state',{},browserCookie)).status,200,'browser must send the login cookie to the prefixed state request');
  assert.equal((await proxyRequest('logout',{},browserCookie)).status,200);
  assert.equal((await proxyRequest('state',{},browserCookie)).status,401,'prefixed logout invalidates the session');
  for(const cookiePath of ['/','//evil.example/api/office-admin','/mindpond/../api/office-admin','/mindpond/api/office-admin?scope=all']){
    assert.equal((await proxyRequest('login',{apiKey:'fixture-api',operatorKey:'fixture-operator',cookiePath})).status,400);
  }
  assert.equal((await proxyRequest('login',{cookiePath:'/mindpond/api/office-admin'})).status,403,'mount paths cannot bypass authentication');
  console.log('PASS prefixed management login: browser cookie path matching, HttpOnly/SameSite, logout and invalid path/auth rejection');

  assert.equal(
    (await req('settings', { mcpUrl: 'https://user:secret@example.com/mcp' })).status,
    400
  );
  assert.equal(
    (
      await req(
        'settings',
        { mcpUrl: 'https://memory.example/mcp' },
        { Origin: 'https://untrusted.example' }
      )
    ).status,
    403
  );
  assert.equal((await req('settings', { mcpUrl: 'https://memory.example/mcp' })).status, 200);
  assert.equal(
    (
      await req('agent', {
        id: 'agent',
        name: 'Codex fixture',
        host: 'codex',
        principal: 'account',
        state: 'pending',
        expectedRevision: 0
      })
    ).status,
    200
  );
  const issued = await req('credential', {
    id: 'agent',
    expectedRevision: 1,
    personalId: 'account'
  });
  assert.equal(issued.status, 200, await issued.clone().text());
  const secret = (await issued.json()).token;
  assert.equal(secret.length, 43);
  const state = await (await req('state')).json();
  assert(!JSON.stringify(state).includes(secret));
  assert.equal(state.agents[0].state, 'active');
  assert.equal(state.agents[0].revision, 3);
  assert.equal(state.settings.mcpUrl, 'https://memory.example/mcp');
  assert.match(state.connectionTemplates.agent.text,/tool_timeout_sec = 360/,'actual browser API uses shared six-minute timeout');
  assert.equal(state.capabilities.wait.maxMs,300000);
  assert.equal(state.capabilities.wait.toolTimeoutMs,360000);
  assert(!JSON.stringify(state.connectionTemplates).includes(secret));
  const grants = await readNetworkConfiguration(config);
  assert.equal(grants.version, 2);
  assert.equal(grants.grants[0].agentId, 'agent');
  assert(!(await fs.readFile(config, 'utf8')).includes(secret));
  assert.equal(
    (await req('credential', { id: 'agent', expectedRevision: 1, personalId: 'account' })).status,
    400,
    'stale issuance cannot rotate another update'
  );
  await fs.chmod(config, 0o644);
  assert.equal(
    (await req('credential', { id: 'agent', expectedRevision: 3, personalId: 'account' })).status,
    400
  );
  const failed = await (await req('state')).json();
  assert.equal(failed.agents[0].state, 'pending', 'failed provisioning never leaves active orphan');
  await fs.chmod(config, 0o600);
  assert.equal(
    (await req('credential', { id: 'agent', expectedRevision: 4, personalId: 'account' })).status,
    200,
    'pending provisioning can be retried explicitly'
  );
  const cli=await promisify(execFile)(process.execPath,['dist/mcp-http.js','grant','--config',config,'--db',path.join(dir,'db'),'--principal','cli-account','--agent','cli-agent','--token-file',path.join(dir,'cli.token')],{env:{...process.env,EMBEDDING_ZH_ENABLED:'false'}});
  assert.equal(JSON.parse(cli.stdout).agentId,'cli-agent');
  const cliState=await (await req('state')).json();assert.equal(cliState.agents.find((a:any)=>a.id==='cli-agent').state,'active');
  const operator={v:1 as const,principal:'operator',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
  assert.equal((await req('agent',{id:'unused',principal:'unused-owner',name:'Unused fixture',host:'codex',state:'pending',expectedRevision:0})).status,200);
  const unusedIssue=await (await req('credential',{id:'unused',expectedRevision:1})).json();
  const applicant={v:1 as const,principal:'unused-owner',agentId:'unused',runtimeId:'pending-unused',transport:'http-mcp' as const,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
  await graph.roles.application({action:'submit',name:'Pending',introduction:'Fixture',reason:'Fixture',key:'pending-unused'},applicant);
  const deletion={id:'unused',expectedRevision:3};
  assert.equal((await req('agent/delete',deletion,{Origin:'https://untrusted.example'})).status,403);
  assert.equal((await req('agent/delete',{...deletion,expectedRevision:4})).status,409);
  await assert.rejects(graph.offices.deleteAgent(deletion,applicant),/operator/);
  assert.equal((await req('agent/delete',deletion)).status,200);
  assert.equal((await req('agent/delete',deletion)).status,200,'a retry can finish private grant cleanup safely');
  const afterDeletion=await (await req('state')).json();
  assert(!afterDeletion.agents.some((a:any)=>a.id==='unused'));
  assert(!afterDeletion.characters.pending.some((a:any)=>a.connector_id==='unused'));
  assert(!(await readNetworkConfiguration(config)).grants.some(g=>g.agentId==='unused'));
  assert.equal(await graph.offices.agentAuthority(applicant),false,'deletion fences already issued calls');
  assert.equal((await req('agent',{id:'unused',principal:'unused-owner',name:'Resurrection attempt',host:'codex',state:'active',expectedRevision:0})).status,400);
  assert(!JSON.stringify(afterDeletion).includes(unusedIssue.token));
  const bound={...applicant,principal:'cli-account',agentId:'cli-agent',runtimeId:'bound-fixture'};
  const application=await graph.roles.application({action:'submit',name:'Bound role',introduction:'Fixture',reason:'Fixture',key:'bound-role'},bound);
  await graph.roles.review({action:'approve',applicationId:application.applicationId,expectedRevision:1},operator);
  assert.equal((await req('agent/delete',{id:'cli-agent',expectedRevision:cliState.agents.find((a:any)=>a.id==='cli-agent').revision})).status,400,'associated roles require explicit removal');
  const historicalAgentRevision=(await graph.offices.registry(operator)).agents.find((a:any)=>a.id==='agent')!.revision;
  await graph.roles.configureOffice({id:'connector-history',title:'History',state:'active',expectedRevision:0,seats:[{id:'historical-seat',agentId:'agent',label:'Legacy participant'}]},operator);
  assert.equal((await req('agent/delete',{id:'agent',expectedRevision:historicalAgentRevision})).status,400,'active seats cannot silently disappear');
  await graph.roles.configureOffice({id:'connector-history',title:'History',state:'active',expectedRevision:1,seats:[]},operator);
  assert.equal((await req('agent/delete',{id:'agent',expectedRevision:historicalAgentRevision})).status,200);
  assert.equal((await (graph as any).db.get('SELECT state FROM office_agents WHERE id=?',['agent'])).state,'deleted','only a minimal historical FK target is retained');
  assert.equal((await (graph as any).db.all('PRAGMA foreign_key_check')).length,0);
  assert((await readNetworkConfiguration(config)).grants.some(g=>g.agentId==='cli-agent'),'other connection grants are unchanged');
  console.log('PASS unused connection deletion: operator/CSRF/CAS, grant revocation, pending cancellation, no resurrection, role/active-seat guards and historical FK preservation');

  // Recreate the router to model a Web process restart against the same DB.
  app.use('/restarted-admin',officeWorkbench(graph,{apiKey:'fixture-api',operatorKey:'fixture-operator',contextSecret:'fixture-secret',configFile:config}));
  app.use('/rotated-admin',officeWorkbench(graph,{apiKey:'fixture-api',operatorKey:'changed-operator',contextSecret:'fixture-secret',configFile:config}));
  const restartBase=new URL(base).origin;
  const persistent=(mount:string)=>fetch(restartBase+mount+'/state',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:'{}'});
  assert.equal((await persistent('/restarted-admin')).status,200,'private hashed login survives router/process recreation');
  assert.equal((await persistent('/rotated-admin')).status,401,'authority rotation fences persisted sessions');
  const stored=JSON.stringify(await (graph as any).db.all('SELECT * FROM office_admin_sessions'));
  assert(!stored.includes(cookie.split('=')[1])&&!stored.includes('fixture-operator'),'no raw cookie or credential is persisted');
  const stream=await fetch(base+'events',{headers:{Cookie:cookie},signal:AbortSignal.timeout(6000)});
  assert.match(stream.headers.get('content-type')??'',/^text\/event-stream/);
  const reader=stream.body!.getReader(),decoder=new TextDecoder();
  assert.match(decoder.decode((await reader.read()).value),/event: ready/);
  await req('settings',{mcpUrl:'https://memory.example/mcp'});
  const event=decoder.decode((await reader.read()).value);assert.match(event,/event: change/);assert(!event.includes('memory.example')&&!event.includes(secret),'SSE carries a revision only');
  const originalRevision=graph.building.observationRevision;
  let entered!:()=>void,release!:()=>void;
  const entering=new Promise<void>(resolve=>{entered=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
  graph.building.observationRevision=async function(...args){entered();await blocked;return originalRevision.apply(this,args);};
  const starting=fetch(base+'events',{headers:{Cookie:cookie},signal:AbortSignal.timeout(6000)});
  await entering;
  workbench.closeObservers();
  release();
  assert.equal((await starting).status,503,'an in-flight admission cannot reopen observers after shutdown');
  graph.building.observationRevision=originalRevision;
  assert.equal((await reader.read()).done,true,'shutdown closes office SSE immediately');
  assert.equal((await fetch(base+'events',{headers:{Cookie:cookie}})).status,503,'no new observer starts during shutdown');
  await req('logout');
  assert.equal((await req('state')).status, 401);
  console.log(
    'PASS office browser control plane: operator-only HttpOnly login, CSRF, safe endpoint, one-time issuance/hash-only grants, stale fencing, provisioning failure/recovery and logout'
  );
} finally {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await graph.close();
  await fs.rm(dir, { recursive: true, force: true });
}
