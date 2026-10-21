/** Real HTTP MCP + browser control plane, isolated DB, no model calls/secrets. */
import assert from 'node:assert/strict';
import { COLLABORATION_LEARNING } from '../src/core/collaboration-learning.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GraphMemory } from '../src/core/graph-memory.js';
import { getEmbeddingService } from '../src/core/embedding.js';
import { createNetworkMcpApp } from '../src/integrations/network-server.js';
import { officeWorkbench } from '../src/integrations/office-workbench.js';
import { issueNetworkGrant, readNetworkConfiguration } from '../src/integrations/network-config.js';
import { prepareRoleClientBundle, roleClientLaunch } from '../src/integrations/role-client-bundle.js';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-role-test-'));
const configFile = path.join(dir, 'accounts.json'), graph = new GraphMemory('.', { dbPath: path.join(dir, 'test.db') });
const emb = getEmbeddingService(), original = emb.generateEmbedding;
emb.generateEmbedding = async () => [1, ...Array(383).fill(0)];
const clients: Client[] = [], servers: import('node:http').Server[] = [];
let network: ReturnType<typeof createNetworkMcpApp> | undefined;
const decode = (r: any) => JSON.parse(r.content.find((x: any) => x.type === 'text').text);
const admin = { v: 1 as const, principal: 'operator', operator: true, issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
async function probeCodexSkill(binary:string,directory:string) {
  const host=spawn(binary,['app-server','--stdio'],{cwd:directory,stdio:['pipe','pipe','pipe']});
  const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  let seq=0,buffer='';
  host.stdout.setEncoding('utf8');host.stdout.on('data',(chunk:string)=>{
    buffer+=chunk;
    for(let end;(end=buffer.indexOf('\n'))>=0;) {
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      let message:any;try{message=JSON.parse(line);}catch{continue;}
      const p=pending.get(message.id);if(!p)continue;pending.delete(message.id);clearTimeout(p.timer);
      if(message.error)p.reject(new Error(message.error.message));else p.resolve(message.result);
    }
  });
  // Do not print user-wide diagnostics or skill inventories from the host.
  host.stderr.resume();
  const rejectAll=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Codex capability probe exited'));}pending.clear();};
  host.once('error',rejectAll);host.once('exit',rejectAll);
  const rpc=(method:string,params:unknown)=>new Promise<any>((resolve,reject)=>{
    const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Codex capability probe timed out'));},10000);
    pending.set(id,{resolve,reject,timer});host.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  try {
    await rpc('initialize',{clientInfo:{name:'mindpond_capability_probe',version:'1'}});
    host.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    const listed=await rpc('skills/list',{cwds:[directory],forceReload:true});
    const skill=listed.data.find((d:any)=>d.cwd===directory)?.skills.find((s:any)=>s.name==='mindpond-inbox');
    assert(skill?.enabled,'native Codex must discover the generated inbox skill in this directory');
    assert.equal(skill.path,path.join(directory,'.agents/skills/mindpond-inbox/SKILL.md'));
  } finally {host.kill('SIGTERM');rejectAll();}
}
try {
  await graph.init();
  const tokens: Record<string, string> = {};
  for (const [id, principal] of [['codex', 'owner'], ['opencode', 'other']]) {
    await graph.offices.configureAgent({ id, principal, name: id, host: id, state: 'active', expectedRevision: 0 }, admin);
    const tokenFile = path.join(dir, id + '.token');
    await issueNetworkGrant({ configFile, tokenFile, principal, agentId: id, toolProfile:'full' });
    tokens[id] = (await fs.readFile(tokenFile, 'utf8')).trim();
  }
  const allowedHosts: string[] = ['127.0.0.1'];
  network = createNetworkMcpApp(graph, { configuration: () => readNetworkConfiguration(configFile), allowedHosts, maxPerAccount: 12 });
  const server = network.app.listen(0, '127.0.0.1');servers.push(server);
  await new Promise<void>(r => server.once('listening', r));
  const port = (server.address() as any).port;allowedHosts.push(`127.0.0.1:${port}`);
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const connect = async (connector: string, session?: string) => {
    const c = new Client({ name: 'synthetic-' + connector, version: '1' });clients.push(c);
    await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer ' + tokens[connector], ...(session ? { 'X-MindPond-Session': session } : {}) } } }));return c;
  };
  const raw = (c: Client, name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) => c.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) => { const r = await raw(c, name, args, meta);assert(!r.isError, JSON.stringify(r));return decode(r); };
  const [a, b, other, noContext] = await Promise.all([connect('codex', 'chat-a'), connect('codex', 'chat-b'), connect('opencode', 'chat-c'), connect('codex')]);
  assert((await a.listTools()).tools.every(t=>!t.name.startsWith('memory_')),'Office has no memory catalog');
  assert((await noContext.listTools()).tools.some(t => t.name === 'role_application'));
  const unbound=await call(noContext,'role_sync');assert.equal(unbound.state,'unregistered');assert(unbound.activation?.id,'unbound transport requires user activation');
  const apply = (c: Client, name: string, key: string) => call(c, 'role_application', { action: 'submit', name, introduction: 'Maintains MindPond and checks observable evidence.', reason: 'User requested this character.', key });
  const appA = await apply(a, '小栗', 'apply-a'), appB = await apply(b, '小麦', 'apply-b'), appC = await apply(other, '小桃', 'apply-c');
  assert.equal((await apply(a, '小栗', 'apply-a')).applicationId, appA.applicationId);
  assert((await raw(a, 'role_application', { action: 'submit', name: 'changed', introduction: 'changed', reason: 'changed', key: 'apply-a' })).isError);
  assert.equal((await call(a, 'role_sync')).state, 'pending');
  assert((await raw(a,'office_receive',{action:'list'})).isError,'pending identity cannot read a mailbox; role_sync explains approval state');
  // Browser route is user-only; agents cannot approve their own applications.
  assert(!(await a.listTools()).tools.some(t => /review|approve/.test(t.name) && t.name.startsWith('role_')));
  const app = express();app.use(express.json());app.use('/api/office-admin', officeWorkbench(graph, { apiKey: '', operatorKey: 'fixture-operator', contextSecret: '', configFile }));
  const web = app.listen(0, '127.0.0.1');servers.push(web);await new Promise<void>(r => web.once('listening', r));
  const base = `http://127.0.0.1:${(web.address() as any).port}/api/office-admin/`;
  let cookie = '';
  const req = (route: string, data: unknown = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(data) });
  assert.equal((await req('role/state')).status, 401);
  const login = await req('login', { operatorKey: 'fixture-operator' });assert.equal(login.status, 200);cookie = login.headers.get('set-cookie')!.split(';')[0];
  const firstState=await (await req('role/state')).json();assert.equal(firstState.pending.length, 3);
  assert.equal((await (await req('role/state',{afterSeq:firstState.revision})).json()).unchanged,true,'idle page polling should not reload entire message bodies');
  assert.equal((await (await req('state',{roleAfterSeq:firstState.revision})).json()).characters.unchanged,true,'the single UI poll uses the role cursor');
  const approved: any[] = [];
  for (const p of [appA, appB, appC]) { const r = await req('role/review', { applicationId: p.applicationId, expectedRevision: 1, action: 'approve' });assert.equal(r.status, 200, await r.clone().text());approved.push(await r.json()); }
  assert.equal((await req('role/review', { applicationId: appA.applicationId, expectedRevision: 1, action: 'approve' })).status, 409);
  const [roleA, roleB, roleC] = approved.map(x => x.roleId);
  assert.equal((await call(a, 'role_sync')).identity.roleId, roleA);
  assert.equal((await call(b, 'role_sync')).identity.roleId, roleB);
  assert.notEqual(roleA, roleB);
  const reconnected = await connect('codex', 'chat-a');
  assert.equal((await call(reconnected, 'role_sync')).identity.roleId, roleA, 'transport reconnect preserves configured runtime');
  // Native metadata is request-local even when a transport is multiplexed.
  const metaA = { 'ai.opencode/sessionID': 'native-a' }, metaB = { 'ai.opencode/sessionID': 'native-b' };
  const nativeApp = await call(noContext, 'role_application', { action: 'submit', name: 'Native', introduction: 'Synthetic metadata fixture only.', reason: 'Test native metadata routing, not a real host claim.', key: 'native' }, metaA);
  await graph.roles.review({ applicationId: nativeApp.applicationId, expectedRevision: 1, action: 'approve' }, admin);
  assert.equal((await call(noContext, 'role_sync', {}, metaA)).state, 'active');
  assert.equal((await call(noContext, 'role_sync', {}, metaB)).state, 'unregistered');
  assert.equal((await call(a, 'role_sync', {}, metaB)).state, 'unregistered', 'real chat metadata wins over installation header');
  // Profile changes appear on ordinary calls without a model-maintained token/id.
  assert.equal((await req('role/configure', { roleId: roleA, expectedRevision: 1, name: '栗子', introduction: 'Maintainer. Reproduce a failure before reporting a fix.', state: 'active' })).status, 200);
  const ordinary = await raw(a, 'office_directory');
  const badge = ordinary.content.map((x: any) => x.type === 'text' ? JSON.parse(x.text) : {}).find((x: any) => x.mindpondIdentity);
  assert.equal(badge.mindpondIdentity.name, '栗子');assert.equal(badge.mindpondIdentity.profileRevision, 2);
  const repeated=await raw(a,'office_directory');
  const repeatedBadge=repeated.content.map((x:any)=>x.type==='text'?JSON.parse(x.text):{}).find((x:any)=>x.mindpondIdentity);
  assert.equal(repeatedBadge.profileChanged,false);assert.equal(repeatedBadge.mindpondIdentity.introduction,undefined,'routine calls do not repeat long introductions');
  assert.match((await call(a,'role_sync')).identity.introduction,/Reproduce/,'explicit sync always restores full profile');
  const messageInput={action:'send',recipient:roleB,body:'Verify the synthetic change.',key:'request-one'};
  const sent=await call(a,'office_message',messageInput);
  assert.equal((await call(a,'office_message',messageInput)).messageId,sent.messageId);
  const inbox=await call(b,'office_receive',{key:'take-one'});assert(inbox.messages.some((m:any)=>m.id===sent.messageId));
  assert((await raw(a,'office_message',{action:'finish',messageId:sent.messageId,result:'wrong receiver',key:'wrong'})).isError);
  await call(b,'office_message',{action:'finish',messageId:sent.messageId,result:'Verified with synthetic evidence.',key:'finish-one'});
  assert(!(await call(b,'office_receive',{action:'list'})).messages.some((m:any)=>m.id===sent.messageId));
  assert((await raw(a,'office_message',{...messageInput,recipient:roleC,key:'cross-denied'})).isError);
  assert.equal((await req('role/link',{sender:roleA,recipient:roleC,enabled:true})).status,200);
  const cross=await call(a,'office_message',{...messageInput,recipient:roleC,key:'cross'});
  await call(other,'office_message',{action:'send',replyTo:cross.messageId,body:'Confirmed by receiver.',key:'cross-reply'});
  assert((await raw(other,'office_message',{...messageInput,recipient:roleA,key:'reverse-denied'})).isError);
  // Real office controls accept characters and auto-resolve a bound context.
  const room = { id: 'role-room', title: 'Synthetic role validation', goal: 'Check a synthetic task.', acceptance: 'Report actual evidence.', expectedRevision: 0, state: 'active', deadline: Date.now() + 3600000, maxRounds: 3, seats: [{ id: 'role-worker', agentId: 'codex', roleId: roleA, label: 'Maintainer', role: 'worker' }, { id: 'role-reviewer', agentId: 'codex', roleId: roleB, label: 'Verifier', role: 'reviewer' }] };
  assert.equal((await req('office', room)).status, 200);
  assert((await a.listTools()).tools.every(t=>!t.name.startsWith('work_')),'registered Office connections expose one current tool catalog');
  const material=await call(a,'office_material',{action:'publish',officeId:'role-room',title:'Synthetic reproduction',version:'v1',content:'Only synthetic fixture evidence.',key:'material'});assert(material.materialId);
  const directory=await call(b,'office_directory',{action:'rooms',officeId:'role-room'});assert(directory.rooms.some((r:any)=>r.officeId==='role-room'));
  assert((await raw(b,'work_material',{action:'publish',key:'removed'})).isError);
  assert.equal((await req('role/configure',{roleId:roleA,expectedRevision:2,name:'栗子',introduction:'Disabled fixture role.',state:'disabled'})).status,200);
  assert((await raw(a,'role_sync')).isError);assert((await raw(a,'office_material',{action:'publish',officeId:'role-room',title:'Late',version:'v1',content:'Rejected',key:'late'})).isError);
  assert.equal((await req('role/configure',{roleId:roleA,expectedRevision:3,name:'栗子',introduction:'Restored fixture role.',state:'active'})).status,200);
  assert.equal((await call(a,'role_sync')).identity.bindingEpoch,3);
  assert((await call(a,'office_material',{action:'publish',officeId:'role-room',title:'After recovery',version:'v2',content:'Fresh context required by server.',key:'new-material'})).materialId);
  const database = (graph as any).db;
  assert((await database.get("SELECT COUNT(*) n FROM memory_action_log WHERE action LIKE 'collaboration_role_%' ")).n > 10);
  const logs = JSON.stringify(await database.all('SELECT * FROM role_events'));
  for (const secret of Object.values(tokens)) assert(!logs.includes(secret));
  // Generated clients are native HTTP, with distinct durable labels and no secrets.
  for (const client of ['codex', 'opencode'] as const) {
    const directory = path.join(dir, client + '-bundle');
    const bundle = await prepareRoleClientBundle({ directory, client, url: url.href, tokenEnv: 'FIXTURE_MINDPOND_AUTH' });
    assert(bundle.sessionLabel);
    await assert.rejects(prepareRoleClientBundle({ directory, client, url: url.href }));
    const launch = await roleClientLaunch(directory, [], { FIXTURE_MINDPOND_AUTH: tokens.codex });
    assert(!JSON.stringify({ args: launch.args }).includes(tokens.codex));
    if (client === 'codex') {
      assert(launch.args.includes('--no-daemon'));assert(launch.args.some(s=>s.includes('tool_timeout_sec = 360')),'Codex deadline must exceed the five-minute message wait');
      const skill = await fs.readFile(path.join(directory, '.agents/skills/mindpond-inbox/SKILL.md'), 'utf8');assert(skill.includes('office_receive'));assert(skill.includes(COLLABORATION_LEARNING));
      if(process.env.MINDPOND_TEST_CODEX_BIN) {
        const cli=await promisify(execFile)(process.env.MINDPOND_TEST_CODEX_BIN,[...launch.args,'mcp','get','mindpond_office','--json'],{cwd:launch.cwd,timeout:15000,maxBuffer:1000000,env:{...process.env,...launch.env}});
        const parsed=JSON.parse(cli.stdout);
        assert.equal(parsed.transport.url,url.href);
        assert.equal(parsed.transport.bearer_token_env_var,'FIXTURE_MINDPOND_AUTH');
        assert(!parsed.transport.http_headers?.['X-MindPond-Session']);
        assert(!cli.stdout.includes(tokens.codex));
        console.log('PASS installed Codex CLI parses generated native HTTP MCP/session/env-reference configuration (no model invocation).');
        await probeCodexSkill(process.env.MINDPOND_TEST_CODEX_BIN,directory);
        console.log('PASS installed Codex discovers the generated local inbox Skill (no thread/model created).');
      }
    } else {
      const c = JSON.parse(await fs.readFile(path.join(directory, 'opencode.json'), 'utf8'));
      assert(c.command.mindpond_office_get_message.template.includes(COLLABORATION_LEARNING));
      assert.equal(c.mcp.mindpond_office.type, 'remote');assert.equal(c.command.mindpond_office_get_message.subtask, false);
      if(process.env.MINDPOND_TEST_OPENCODE_BIN) {
        const cli=await promisify(execFile)(process.env.MINDPOND_TEST_OPENCODE_BIN,[...launch.args,'--pure','mcp','list'],{
          cwd:launch.cwd,timeout:45000,maxBuffer:1000000,
          env:{...process.env,...launch.env,XDG_CONFIG_HOME:path.join(dir,'opencode-config'),XDG_DATA_HOME:path.join(dir,'opencode-data'),XDG_CACHE_HOME:path.join(dir,'opencode-cache')}
        });
        assert.match(cli.stdout+'\n'+cli.stderr,/mindpond_office[\s\S]*connected/i);
        assert.doesNotMatch(cli.stdout+'\n'+cli.stderr,/disconnected|failed/i);
        console.log('PASS installed OpenCode CLI connects generated native HTTP MCP configuration (no model invocation).');
      }
    }
    await assert.rejects(roleClientLaunch(directory,[],{}),/outside the chat/);
    if(client==='opencode')await assert.rejects(roleClientLaunch(directory,[],{FIXTURE_MINDPOND_AUTH:tokens.codex,OPENCODE_CONFIG_CONTENT:'{}'}),/override/);
  }
  console.log('PASS role workflow: authenticated HTTP session labels, browser approval, distinct/reconnected/native contexts, implicit profile refresh, pending/processing/archived feedback semantics, directional contacts, role office binding/fencing, audited no-secret bundles. Native CLI model behavior NOT_RUN.');
} finally {
  await Promise.allSettled(clients.map(c => c.close()));
  if (network) await network.close();
  await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r()))));
  await graph.close();emb.generateEmbedding = original;
  await fs.rm(dir, { recursive: true, force: true });
}
