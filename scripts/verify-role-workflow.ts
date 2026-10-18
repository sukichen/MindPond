/** Real HTTP MCP + browser control plane, isolated DB, no model calls/secrets. */
import assert from 'node:assert/strict';
import { COLLABORATION_LEARNING } from '../src/core/collaboration-learning.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
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
  const existingNamespace='net:'+createHash('sha256').update('owner\0codex').digest('hex').slice(0,40)+':'+createHash('sha256').update('chat-a').digest('hex').slice(0,40);
  assert.equal((await call(a,'memory_capabilities')).mcpConnection.sessionId,existingNamespace,'preserve pre-role header session namespace');
  assert((await noContext.listTools()).tools.some(t => t.name === 'role_application'));
  assert((await raw(noContext, 'role_sync')).isError, 'missing context must not infer latest character');
  const apply = (c: Client, name: string, key: string) => call(c, 'role_application', { action: 'submit', name, introduction: 'Maintains MindPond and checks observable evidence.', reason: 'User requested this character.', key });
  const appA = await apply(a, '小栗', 'apply-a'), appB = await apply(b, '小麦', 'apply-b'), appC = await apply(other, '小桃', 'apply-c');
  assert.equal((await apply(a, '小栗', 'apply-a')).applicationId, appA.applicationId);
  assert((await raw(a, 'role_application', { action: 'submit', name: 'changed', introduction: 'changed', reason: 'changed', key: 'apply-a' })).isError);
  assert.equal((await call(a, 'role_sync')).state, 'pending');
  const pendingInbox=await call(a,'role_receive');assert.equal(pendingInbox.state,'pending');assert.equal(pendingInbox.messages.length,0,'pending identity is explained in one call, without granting mailbox access');
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
  assert.equal((await call(a,'memory_capabilities')).mcpConnection.sessionId,existingNamespace,'approval does not hide existing session memories');
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
  const nativeMemory=await call(noContext,'memory_save',{content:'Synthetic native session private observation.',dimensions:['work']},metaA);
  assert((await raw(noContext,'memory_get',{nodeId:nativeMemory.id},metaB)).isError,'native metadata must isolate session memories on a multiplexed transport');
  assert.equal((await call(a, 'role_sync', {}, metaB)).identity.roleId, roleA, 'explicit header wins over metadata');
  // Profile changes appear on ordinary calls without a model-maintained token/id.
  assert.equal((await req('role/configure', { roleId: roleA, expectedRevision: 1, name: '栗子', introduction: 'Maintainer. Reproduce a failure before reporting a fix.', state: 'active' })).status, 200);
  const ordinary = await raw(a, 'memory_capabilities');
  const badge = ordinary.content.map((x: any) => x.type === 'text' ? JSON.parse(x.text) : {}).find((x: any) => x.mindpondIdentity);
  assert.equal(badge.mindpondIdentity.name, '栗子');assert.equal(badge.mindpondIdentity.profileRevision, 2);
  const repeated=await raw(a,'memory_capabilities');
  const repeatedBadge=repeated.content.map((x:any)=>x.type==='text'?JSON.parse(x.text):{}).find((x:any)=>x.mindpondIdentity);
  assert.equal(repeatedBadge.profileChanged,false);assert.equal(repeatedBadge.mindpondIdentity.introduction,undefined,'routine calls do not repeat long introductions');
  assert.match((await call(a,'role_sync')).identity.introduction,/Reproduce/,'explicit sync always restores full profile');
  const messageInput = { action: 'send', recipient: roleB, kind: 'request', body: 'Please verify the synthetic change. No filesystem sharing is assumed.', key: 'request-one' };
  const sent = await call(a, 'role_exchange', messageInput);
  assert.equal((await call(a, 'role_exchange', messageInput)).messageId, sent.messageId);
  const inbox = await call(b, 'role_receive');assert.equal(inbox.messages.length, 1);assert.equal(inbox.messages[0].sender_name, '栗子');
  await call(b, 'role_exchange', { action: 'ack', messageId: sent.messageId, state: 'read', key: 'read-one' });
  assert.equal((await call(b, 'role_receive')).messages[0].state, 'read', 'read keeps the pending file');
  assert((await raw(b, 'role_exchange', { action: 'ack', messageId: sent.messageId, state: 'resolved', key: 'bad-resolve' })).isError);
  assert((await raw(a, 'role_exchange', { action: 'ack', messageId: sent.messageId, state: 'read', key: 'other-read' })).isError);
  await call(b, 'role_exchange', { action: 'send', recipient: roleA, kind: 'reply', requestId: sent.requestId, final: true, body: 'The synthetic validation passed with stated evidence.', key: 'final-reply' });
  assert.equal((await call(b, 'role_receive')).messages.length, 0);
  assert.equal((await call(a, 'role_receive')).messages[0].request_id, sent.requestId);
  // Cross-account new messages are explicitly authorized; exact request replies
  // have a return channel without blanket reverse contact permission.
  assert((await raw(a, 'role_exchange', { ...messageInput, recipient: roleC, key: 'cross-denied' })).isError);
  assert.equal((await req('role/link', { sender: roleA, recipient: roleC, enabled: true })).status, 200);
  const cross = await call(a, 'role_exchange', { ...messageInput, recipient: roleC, key: 'cross' });
  await call(other, 'role_exchange', { action: 'send', recipient: roleA, kind: 'reply', requestId: cross.requestId, final: true, body: 'Confirmed by the intended receiver.', key: 'cross-reply' });
  assert((await raw(other, 'role_exchange', { ...messageInput, recipient: roleA, key: 'reverse-denied' })).isError);
  // Real office controls accept characters and auto-resolve a bound context.
  const room = { id: 'role-room', title: 'Synthetic role validation', goal: 'Check a synthetic task.', acceptance: 'Report actual evidence.', expectedRevision: 0, state: 'active', deadline: Date.now() + 3600000, maxRounds: 3, seats: [{ id: 'role-worker', agentId: 'codex', roleId: roleA, label: 'Maintainer', role: 'worker' }, { id: 'role-reviewer', agentId: 'codex', roleId: roleB, label: 'Verifier', role: 'reviewer' }] };
  assert.equal((await req('office', room)).status, 200);
  const material = await call(a, 'work_material', { action: 'publish', label: 'Synthetic reproduction', version: 'v1', content: 'Only synthetic fixture evidence.', key: 'material' });assert(material.materialId);
  const aOffice = await call(a, 'work_bootstrap');
  const aSession = aOffice.sessions.find((s: any) => s.seat_id === 'role-worker').id;
  assert((await raw(b, 'work_material', { action: 'publish', workSessionId: aSession, label: 'Invalid', version: 'v1', content: 'Wrong role', key: 'bad-material' })).isError);
  assert.equal((await call(b, 'work_office_get', { officeId: 'role-room' })).office.id, 'role-room');
  const officeRequest=await call(b,'work_office_exchange',{action:'send',officeId:'role-room',recipient:'role-worker',kind:'request',body:'Verify the synthetic office inbox path.',key:'office-request'});
  const officeInbox=await call(a,'role_receive');
  assert(officeInbox.officePending.some((x:any)=>x.messageId===officeRequest.messageId&&x.officeId==='role-room'),'the CLI inbox must expose legacy office messages over HTTP MCP');
  await call(a,'work_office_exchange',{action:'send',officeId:'role-room',recipient:'role-reviewer',kind:'reply',requestId:officeRequest.messageId,final:true,body:'Synthetic office path checked.',key:'office-final'});
  assert(!(await call(a,'role_receive')).officePending.some((x:any)=>x.messageId===officeRequest.messageId),'completed office requests leave the unified inbox');
  // Disable fences contexts and memory calls carrying an obsolete role.
  assert.equal((await req('role/configure', { roleId: roleA, expectedRevision: 2, name: '栗子', introduction: 'Disabled fixture role.', state: 'disabled' })).status, 200);
  assert((await raw(a, 'role_sync')).isError);assert((await raw(a, 'work_material', { action: 'publish', workSessionId: aSession, label: 'Late', version: 'v1', content: 'Rejected', key: 'late' })).isError);
  assert.equal((await req('role/configure', { roleId: roleA, expectedRevision: 3, name: '栗子', introduction: 'Restored fixture role.', state: 'active' })).status, 200);
  assert.equal((await call(a, 'role_sync')).identity.bindingEpoch, 3);
  assert((await call(a, 'work_material', { action: 'publish', label: 'After recovery', version: 'v2', content: 'Fresh context required by server.', key: 'new-material' })).materialId);
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
        assert.equal(parsed.transport.http_headers['X-MindPond-Session'],bundle.sessionLabel);
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
  console.log('PASS role workflow: authenticated HTTP session labels, browser approval, distinct/reconnected/native contexts, implicit profile refresh, pending/read/final reply semantics, directional contacts, role office binding/fencing, audited no-secret bundles. Native CLI model behavior NOT_RUN.');
} finally {
  await Promise.allSettled(clients.map(c => c.close()));
  if (network) await network.close();
  await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r()))));
  await graph.close();emb.generateEmbedding = original;
  await fs.rm(dir, { recursive: true, force: true });
}
