#!/usr/bin/env node
/** Run inside the actual host environment. Credentials never appear in output. */
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const { values } = parseArgs({ options: { url: { type: 'string' }, 'token-env': { type: 'string', default: 'MINDPOND_TOKEN' }, session: { type: 'string' }, 'timeout-ms': { type: 'string', default: '360000' }, 'long-wait': { type: 'boolean', default: false } } });
const url = new URL(values.url ?? 'http://127.0.0.1:7904/mcp');
if (url.username || url.password || url.search || url.hash)
    throw Error('Use a public MCP URL without credentials, query or fragment');
const token = process.env[values['token-env']!];
if (!token)
    throw Error('The named secret environment variable is missing');
const timeout = Number(values['timeout-ms']);
if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600000)
    throw Error('timeout-ms must be 1000–600000');
const headers: Record<string, string> = { Authorization: 'Bearer ' + token };
if (values.session)
    headers['X-MindPond-Session'] = values.session;
const client = new Client({ name: 'mindpond-office-doctor', version: '1' }), transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
const checks: Record<string, unknown> = { version: 'mindpond.office-doctor.v1', caller: 'This doctor process; native chat timeout must be tested inside that chat.' };
const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout, resetTimeoutOnProgress: false });
    const data = JSON.parse((result.content as any[]).find(c => c.type === 'text').text);
    if (result.isError)
        throw Error(data.error?.message ?? 'Host call rejected');
    return data;
};
try {
    const started = Date.now();
    await client.connect(transport);
    checks.reachable = true;
    checks.authenticated = true;
    checks.handshakeMs = Date.now() - started;
    const tools = (await client.listTools()).tools;
    checks.tools = ['role_sync', 'office_receive', 'office_message', 'office_wait', 'office_host'].map(name => ({ name, available: tools.some(t => t.name === name) }));
    checks.protocolTasks = client.getServerCapabilities()?.tasks ?? null;
    const identity = await call('role_sync', {});
    checks.identity = identity.identity ?? null;
    if (!identity.identity) {
        checks.probe = 'not_run: approve and correlate this exact host chat first';
        process.exitCode = 2;
    }
    else {
        const before = Date.now();
        const report = await call('office_host', { action: 'probe', client: 'mindpond-office-doctor', toolTimeoutMs: timeout, waitMs: values['long-wait'] ? 300000 : 100 });
        checks.probe = await call('office_host', { action: 'confirm', probeId: report.probeId, clientRoundTripMs: Date.now() - before });
        checks.longWait = values['long-wait'] ? 'verified_for_this_doctor_process' : 'not_run';
    }
}
catch {
    checks.error = 'Connection, authorization, identity or long-call check failed; inspect host configuration locally. Credentials and server error details are omitted.';
    process.exitCode = 1;
}
finally {
    await client.close().catch(() => { });
    console.log(JSON.stringify(checks, null, 2));
}
