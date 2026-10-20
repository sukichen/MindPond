/** Opt-in real native-client long-call test. No production data or auth is changed. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { GraphMemory } from '../src/core/graph-memory.js';
import { roleRuntimeId } from '../src/core/roles.js';
import { createNetworkMcpApp } from '../src/integrations/network-server.js';
import { issueNetworkGrant, readNetworkConfiguration } from '../src/integrations/network-config.js';
import { officeConnection } from '../src/integrations/office-connection.js';
const { values } = parseArgs({ options: { client: { type: 'string', default: 'doctor' }, 'wait-ms': { type: 'string', default: '100' }, report: { type: 'string' } } });
const waitMs = Number(values['wait-ms']);
if (!['doctor', 'codex', 'claude', 'opencode'].includes(values.client!) || ![100, 300000].includes(waitMs))
    throw Error('Choose client doctor|codex|claude|opencode and wait-ms 100|300000');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-native-host-')), graph = new GraphMemory('.', { dbPath: path.join(dir, 'fixture.db') });
const admin = { v: 1 as const, principal: 'fixture-human', operator: true, issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
let network: ReturnType<typeof createNetworkMcpApp> | undefined, server: ReturnType<ReturnType<typeof createNetworkMcpApp>['app']['listen']> | undefined;
try {
    await graph.init();
    await graph.offices.configureAgent({ id: 'fixture', principal: 'owner', name: 'Disposable transport test', host: values.client === 'doctor' ? 'generic-http-mcp' : values.client, state: 'active', expectedRevision: 0 }, admin);
    const configFile = path.join(dir, 'accounts.json'), tokenFile = path.join(dir, 'token');
    await issueNetworkGrant({ configFile, tokenFile, principal: 'owner', agentId: 'fixture' });
    const label = 'native-' + values.client, actor = { v: 1 as const, principal: 'owner', agentId: 'fixture', transport: 'http-mcp' as const, runtimeId: roleRuntimeId('owner', 'fixture', 'header', label), issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
    const application: any = await graph.roles.application({ action: 'submit', name: 'Native transport fixture', introduction: 'Disposable test only', reason: 'Explicit long-call verification', key: 'apply' }, actor), approved = await graph.roles.review({ applicationId: application.applicationId, expectedRevision: 1, action: 'approve' }, admin);
    const allowedHosts = ['127.0.0.1'];
    network = createNetworkMcpApp(graph, { configuration: () => readNetworkConfiguration(configFile), allowedHosts });
    server = network.app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server!.once('listening', r));
    const port = (server.address() as any).port;
    allowedHosts.push('127.0.0.1:' + port);
    const url = `http://127.0.0.1:${port}/mcp`, env = { ...process.env, MINDPOND_FIXTURE_TOKEN: (await fs.readFile(tokenFile, 'utf8')).trim() };
    const prompt = `This is a user-authorized native MCP transport test in a disposable fictional database. Use only mindpond_fixture office_host. Your role is already approved and bound to this host session. Do not process inbox mail or save routine memories. Call office_host action=probe,waitMs=${waitMs},client=${values.client},toolTimeoutMs=360000. Wait for this exact call to return; then call office_host action=confirm with its probeId and clientRoundTripMs equal to the measuredWaitMs returned. Only after confirm succeeds reply VERIFIED. Do not end while the probe is pending.`;
    let command = values.client!, args: string[] = [];
    if (command === 'doctor') {
        command = process.execPath;
        args = [path.resolve('dist/office-doctor.js'), '--url', url, '--token-env', 'MINDPOND_FIXTURE_TOKEN', '--session', label, ...(waitMs === 300000 ? ['--long-wait'] : [])];
    }
    if (command === 'codex')
        args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '-c', 'features.shell_tool=false', '-c', 'features.multi_agent=false', '-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', `mcp_servers.mindpond_fixture.url=${JSON.stringify(url)}`, '-c', 'mcp_servers.mindpond_fixture.bearer_token_env_var="MINDPOND_FIXTURE_TOKEN"', '-c', `mcp_servers.mindpond_fixture.http_headers={"X-MindPond-Session"=${JSON.stringify(label)}}`, '-c', 'mcp_servers.mindpond_fixture.tool_timeout_sec=360', '-c', 'mcp_servers.mindpond_fixture.tools.office_host.approval_mode="approve"', '-c', 'mcp_servers.mindpond_fixture.enabled_tools=["office_host"]', prompt];
    if (command === 'claude') {
        const config = officeConnection({ host: 'claude', id: 'fixture', name: 'mindpond_fixture', url, sessionLabel: label, tokenEnv: 'MINDPOND_FIXTURE_TOKEN' });
        const filename = path.join(dir, 'mcp.json');
        await fs.writeFile(filename, config.text, { mode: 0o600 });
        args = ['-p', '--strict-mcp-config', '--mcp-config', filename, '--tools', '', '--allowedTools', 'mcp__mindpond_fixture__office_host', '--max-turns', '5', prompt];
        Object.assign(env, { MCP_TOOL_TIMEOUT: '360000' });
    }
    if (command === 'opencode') {
        const config = officeConnection({ host: 'opencode', id: 'fixture', name: 'mindpond_fixture', url, sessionLabel: label, tokenEnv: 'MINDPOND_FIXTURE_TOKEN' });
        Object.assign(env, { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config.config, permission: { '*': 'deny', 'mindpond_fixture_*': 'allow' } }) });
        args = ['run', '--format', 'json', prompt];
    }
    const started = Date.now(), child = spawn(command, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; if (stdout.length > 1000000)
        stdout = stdout.slice(-1000000); });
    child.stderr.on('data', d => { stderr += d; if (stderr.length > 100000)
        stderr = stderr.slice(-100000); });
    const timer = setTimeout(() => child.kill('SIGTERM'), waitMs + 180000), code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    clearTimeout(timer);
    const report = (await graph.officeCollaboration.observations(admin)).find(r => r.role_id === approved.roleId), probe = report ? JSON.parse(report.payload) : null;
    const result = { version: 'mindpond.native-host-test.v1', client: values.client, waitMs, elapsedMs: Date.now() - started, exitCode: code, verified: code === 0 && probe?.clientReceived === true && probe.measuredWaitMs >= waitMs - 100, probe: probe ?? null, scope: 'Actual installed native client, isolated fixture only; no claim about other versions or stopped-host wakeup.' };
    if (values.report) {
        if (!path.isAbsolute(values.report))
            throw Error('Report path must be absolute');
        await fs.writeFile(values.report, JSON.stringify({ ...result, stdout, stderr }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    console.log(JSON.stringify(result));
    if (!result.verified)
        process.exitCode = 2;
}
finally {
    await network?.close();
    if (server)
        await new Promise<void>(r => server!.close(() => r()));
    await graph.close();
    await fs.rm(dir, { recursive: true, force: true });
}
