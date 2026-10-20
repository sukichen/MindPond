/** Installed OpenCode plugin loader + real noReply session events. No model call.
 * The hook is exercised with native chat IDs; tool execution itself is covered
 * separately by verify-role-memory's generated-plugin / real HTTP MCP test. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GraphMemory } from '../src/core/graph-memory.js';
import { createNetworkMcpApp } from '../src/integrations/network-server.js';
import { tokenDigest } from '../src/integrations/network-config.js';
import { renderOpenCodeSessionPlugin, verifyHostSession } from '../src/integrations/host-correlation.js';
if (!process.env.MINDPOND_TEST_OPENCODE_BIN)
    throw Error('Set MINDPOND_TEST_OPENCODE_BIN to an installed OpenCode executable');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-native-role-'));
await fs.chmod(dir, 0o700);
const graph = new GraphMemory('.', { dbPath: path.join(dir, 'fixture.db') }), token = 'fixture-host-'.repeat(5).slice(0, 43);
const admin = { v: 1 as const, principal: 'human', operator: true, issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
let logs = '';
let network: any, listener: any, child: ReturnType<typeof spawn> | undefined;
const clients: Client[] = [];
try {
    await graph.init();
    await graph.offices.configureAgent({ id: 'fixture', principal: 'human', name: 'Native fixture', host: 'opencode', state: 'active', expectedRevision: 0 }, admin);
    const hosts = ['127.0.0.1'];
    network = createNetworkMcpApp(graph, { allowedHosts: hosts, maxPerAccount: 32, configuration: async () => ({ version: 2, grants: [{ principal: 'human', agentId: 'fixture', credentialId: 'fixture', tokenHash: tokenDigest(token), domains: [{ kind: 'personal', id: 'default' }], toolProfile: 'work' }] }) });
    listener = network.app.listen(0, '127.0.0.1');
    await new Promise<void>(r => listener.once('listening', r));
    const port = listener.address().port;
    hosts.push('127.0.0.1:' + port);
    const pluginDir = path.join(dir, '.opencode/plugins');
    await fs.mkdir(pluginDir, { recursive: true });
    const helper = path.join(dir, 'host-session.mjs');
    await fs.writeFile(helper, renderOpenCodeSessionPlugin());
    const plugin = `import createHooks from '../../host-session.mjs';import fs from 'node:fs/promises';export default async host=>{const hooks=await createHooks(host);return {...hooks,'chat.message':async(input)=>{const record={sessionID:input.sessionID};for(const [tool,key] of [['mindpond_office_role_sync','office'],['mindpond_memory_memory_identity','memory']]){const output={args:{}};await hooks['tool.execute.before']({tool,sessionID:input.sessionID},output);record[key]=output.args;}await fs.writeFile(${JSON.stringify(dir)}+'/'+input.sessionID+'.json',JSON.stringify(record),{mode:0o600});}};};`;
    await fs.writeFile(path.join(pluginDir, 'verify-session.js'), plugin);
    const cfg = { mcp: { mindpond_office: { type: 'remote', url: `http://127.0.0.1:${port}/mcp`, oauth: false, headers: { Authorization: 'Bearer ' + token } }, mindpond_memory: { type: 'remote', url: `http://127.0.0.1:${port}/memory/mcp`, oauth: false, headers: { Authorization: 'Bearer ' + token } } } };
    const configFile = path.join(dir, 'opencode.json');
    await fs.writeFile(configFile, JSON.stringify(cfg), { mode: 0o600 });
    const reserve = net.createServer();
    await new Promise<void>(r => reserve.listen(0, '127.0.0.1', r));
    const hostPort = (reserve.address() as net.AddressInfo).port;
    await new Promise<void>(r => reserve.close(() => r()));
    child = spawn(process.env.MINDPOND_TEST_OPENCODE_BIN!, ['--print-logs', 'serve', '--hostname', '127.0.0.1', '--port', String(hostPort)], { cwd: dir, env: { ...process.env, OPENCODE_CONFIG: configFile, OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg), XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_DATA_HOME: path.join(dir, 'data'), XDG_CACHE_HOME: path.join(dir, 'cache'), OPENCODE_SERVER_PASSWORD: '', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', d => logs = (logs + d).slice(-5000));
    child.stderr?.on('data', d => logs = (logs + d).slice(-5000));
    const api = async (url: string, body?: unknown) => { const r = await fetch(`http://127.0.0.1:${hostPort}` + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) }); if (!r.ok)
        throw Error('Native fixture API ' + r.status); return r.json(); };
    let ready = false;
    for (let n = 0; n < 100; n++) {
        try {
            await api('/global/health');
            ready = true;
            break;
        }
        catch {
            if (child.exitCode !== null)
                break;
            await new Promise(r => setTimeout(r, 300));
        }
    }
    assert(ready, 'Installed OpenCode fixture startup failed: ' + logs);
    const office = new Client({ name: 'verification', version: '1' }), memory = new Client({ name: 'verification', version: '1' });
    clients.push(office, memory);
    for (const [c, endpoint] of [[office, '/mcp'], [memory, '/memory/mcp']] as const)
        await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${endpoint}`), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    const seen = [];
    for (const name of ['native-a', 'native-b']) {
        const session = await api('/session', {});
        await api('/session/' + session.id + '/message', { noReply: true, parts: [{ type: 'text', text: 'Verify host session correlation without model inference' }] });
        let record: any;
        for (let n = 0; n < 40; n++) {
            try {
                record = JSON.parse(await fs.readFile(path.join(dir, session.id + '.json'), 'utf8'));
                break;
            }
            catch {
                await new Promise(r => setTimeout(r, 100));
            }
        }
        assert(record, 'Actual chat.message did not load the host adapter');
        assert.equal(verifyHostSession(record.office.hostContext, 'role_sync', record.office, token), session.id);
        const response: any = await office.callTool({ name: 'role_sync', arguments: record.office });
        assert(!response.isError, JSON.stringify(response));
        const state = JSON.parse(response.content[0].text);
        const actor = { v: 1 as const, principal: 'human', agentId: 'fixture', runtimeId: 'seed-' + name, transport: 'http-mcp' as const, issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
        const app = await graph.roles.application({ action: 'submit', name, introduction: 'Fictional native test', reason: 'No model inference', key: name }, actor);
        const role = await graph.roles.review({ action: 'approve', applicationId: app.applicationId, expectedRevision: 1 }, admin);
        await graph.roles.activate({ requestId: state.activation.id, roleId: role.roleId, expectedRevision: 1 }, admin);
        const r: any = await memory.callTool({ name: 'memory_identity', arguments: record.memory });
        assert(!r.isError, JSON.stringify(r));
        const owner = JSON.parse(r.content[0].text).owner;
        assert.equal(owner.id, role.roleId);
        seen.push(owner.id);
    }
    assert.notEqual(seen[0], seen[1]);
    console.log('PASS installed OpenCode: real plugin loading, host config credentials and two native noReply chat IDs produce distinct role memory identities over shared MCP; no model inference');
}
catch (error) {
    console.error('Native fixture diagnostics:', logs.replaceAll(token, '[fixture-credential]'));
    throw error;
}
finally {
    child?.kill('SIGTERM');
    if (child && child.exitCode === null)
        await new Promise<void>(r => { const timer = setTimeout(() => { child?.kill('SIGKILL'); r(); }, 4000); child!.once('exit', () => { clearTimeout(timer); r(); }); });
    for (const c of clients)
        await c.close().catch(() => { });
    await network?.close();
    if (listener)
        await new Promise<void>(r => listener.close(r));
    await graph.close();
    await fs.rm(dir, { recursive: true, force: true });
}
