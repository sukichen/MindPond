/** End-to-end Office send + wait through the shipped stdio bridge and JSON-mode HTTP gateway. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { GraphMemory } from '../src/core/graph-memory.js';
import { roleRuntimeId } from '../src/core/roles.js';
import { OFFICE_TOOL_TIMEOUT_MS } from '../src/core/office-wait-policy.js';
import { createNetworkMcpApp } from '../src/integrations/network-server.js';
import { tokenDigest } from '../src/integrations/network-config.js';

const long = process.argv.includes('--long');
const replyDelay = long ? 305_000 : 200;
const waitSeconds = long ? 310 : 2;
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-remote-wait-'));
const graph = new GraphMemory('.', { dbPath: path.join(directory, 'fixture.db') });
const token = randomBytes(32).toString('base64url');
const admin = { v: 1 as const, principal: 'human', operator: true, issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
const actor = (chat: string) => ({
    ...admin, operator: false, agentId: 'host', runtimeId: roleRuntimeId('human', 'host', 'codex', chat),
    nativeChatId: chat, runtimeMode: 'codex_metadata' as const, transport: 'http-mcp' as const,
});
const configuration = {
    version: 2 as const, grants: [{ principal: 'human', agentId: 'host', credentialId: 'host',
        tokenHash: tokenDigest(token), domains: [], toolProfile: 'office' as const }],
};
let network: ReturnType<typeof createNetworkMcpApp> | undefined;
let listener: ReturnType<NonNullable<typeof network>['app']['listen']> | undefined;
const client = new Client({ name: 'remote-wait-fixture', version: '1' });
try {
    await graph.init();
    await graph.offices.configureAgent({ id: 'host', principal: 'human', name: 'Fixture', host: 'generic-http-mcp', state: 'active', expectedRevision: 0 }, admin);
    const roles = [];
    for (const name of ['sender', 'receiver']) {
        const application = await graph.roles.application({ action: 'submit', name, introduction: 'Synthetic long wait', reason: 'Fixture', key: 'apply' }, actor(name));
        roles.push(await graph.roles.review({ action: 'approve', applicationId: application.applicationId, expectedRevision: 1 }, admin));
    }
    const allowedHosts = ['127.0.0.1'];
    network = createNetworkMcpApp(graph, { allowedHosts, configuration: async () => configuration });
    listener = network.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => listener!.once('listening', resolve));
    const url = 'http://127.0.0.1:' + (listener.address() as AddressInfo).port + '/mcp';
    allowedHosts.push(new URL(url).host);
    await client.connect(new StdioClientTransport({
        command: process.execPath, args: ['dist/mcp-remote.js', '--url', url, '--token-env', 'MINDPOND_FIXTURE_TOKEN'],
        env: { MINDPOND_FIXTURE_TOKEN: token }, stderr: 'inherit',
    }));
    assert((await client.listTools()).tools.some(tool => tool.name === 'office_message'));
    const send = async (key: string) => {
        const started = performance.now();
        const response = await client.callTool({
            name: 'office_message', _meta: { threadId: 'sender' },
            arguments: { action: 'send', recipient: roles[1].roleId, body: key, key, waitForReply: true, waitSeconds },
        }, undefined, { timeout: OFFICE_TOOL_TIMEOUT_MS + 1000 });
        assert(!response.isError, JSON.stringify(response));
        const content = response.content as Array<{ text: string }>;
        return { data: JSON.parse(content[0].text), elapsed: performance.now() - started };
    };
    // Exercise both the late response and a silent window on the same bridge.
    await Promise.all([
        (async () => {
            const { data, elapsed } = await send('silent');
            assert.equal(data.replyWait.status, 'timeout');
            assert(elapsed >= waitSeconds * 1000 - 100);
        })(),
        (async () => {
            const result = send('late');
            const deliver = (async () => {
                await sleep(replyDelay, undefined, { ref: false });
                const page = await graph.building.receive({ action: 'list', state: 'pending' }, actor('receiver'));
                const original = page.messages.find((message: { body: string }) => message.body === 'late');
                assert(original);
                return graph.building.message({ action: 'send', replyTo: original.id, body: 'Actual reply', key: 'late-answer' }, actor('receiver'));
            })();
            const [{ data, elapsed }, reply] = await Promise.all([result, deliver]);
            assert(elapsed >= replyDelay - 100);
            assert.equal(data.replyWait.status, 'matched');
            assert.equal(data.replyWait.message.body, 'Actual reply');
            assert.equal(data.replyWait.message.state, 'processing');
            assert.equal(data.receivedMessageId, reply.messageId);
        })(),
    ]);
    console.log('PASS real stdio to HTTP send-and-wait: linked reply at ' + replyDelay + 'ms and silent timeout at ' + waitSeconds + 's');
} finally {
    await client.close();
    await network?.close();
    listener?.closeAllConnections();
    await new Promise<void>(resolve => listener ? listener.close(() => resolve()) : resolve());
    await graph.close();
    await fs.rm(directory, { recursive: true, force: true });
}
