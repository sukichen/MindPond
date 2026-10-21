#!/usr/bin/env node
/** Central network MCP process; does not expose the operator workbench/REST API. */
import 'dotenv/config';
import {checkNetworkCredential} from './integrations/network-auth-check.js';
import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { GraphMemory } from './core/graph-memory.js';
import { defaultDatabasePath } from './core/runtime-paths.js';
import { createNetworkMcpApp } from './integrations/network-server.js';
import { readNetworkConfiguration, issueNetworkGrant } from './integrations/network-config.js';
import { workspaceSchema } from './core/collaboration-tools.js';
process.env.MINDPOND_LOG_STDERR = '1';
let startupGraph: GraphMemory | undefined;
try {
  const args = process.argv.slice(2),
    command = args.shift() ?? 'serve';
  const { values } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      principal: { type: 'string' },
      agent: { type: 'string' },
      assignments: { type: 'string' },
      'unrestricted-assignments': { type: 'boolean' },
      personal: { type: 'string' },
      profile: { type: 'string' },
      'token-file': { type: 'string' },
      rotate: { type: 'boolean' },
      'workspace-file': { type: 'string' },
      db: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      'allowed-host': { type: 'string', multiple: true },
      'tls-cert': { type: 'string' },
      'tls-key': { type: 'string' }
    }
  });
  const config = values.config ?? process.env.MINDPOND_MCP_ACCOUNTS;
  if (!config) throw new Error('--config or MINDPOND_MCP_ACCOUNTS is required');
  if(command==='check-auth'){
    if(!values['token-file']||!values.db)throw Error('check-auth requires --token-file and --db');
    const report=await checkNetworkCredential({configFile:config,tokenFile:values['token-file'],dbPath:values.db});
    console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=2;
  } else if (command === 'grant') {
    if (!values.principal || !values['token-file'])
      throw new Error('grant requires --principal and --token-file');
    if (values.assignments && values['unrestricted-assignments'])
      throw new Error('Choose --assignments or --unrestricted-assignments, not both');
    const grantOptions = {
      configFile: config,
      tokenFile: values['token-file'],
      principal: values.principal,
      personalId: values.personal,
      rotate: values.rotate,
      toolProfile: values.profile as 'work' | 'full' | undefined,
      agentId: values.agent,
      assignmentIds: values['unrestricted-assignments'] ? null : values.assignments?.split(',')
    };
    let issued;
    if (values.agent) {
      const previousConfig = await readNetworkConfiguration(config).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return { grants: [] };
      });
      if (!values.rotate && previousConfig.grants.some((g) => g.agentId === values.agent))
        throw new Error('Agent credential exists; use --rotate with a new token file');
      const graph = new GraphMemory('.', { dbPath: values.db ?? defaultDatabasePath() });
      startupGraph = graph;
      await graph.init();
      const operator = {
        v: 1 as const,
        principal: 'local-operator',
        operator: true,
        issuedAt: 0,
        expiresAt: Number.MAX_SAFE_INTEGER
      };
      const registry = await graph.offices.registry(operator),
        old = registry.agents.find((a: any) => a.id === values.agent);
      const registration = {
        id: values.agent,
        principal: values.principal,
        name: old?.name ?? values.agent,
        host: old?.host ?? 'other',
        expectedRevision: old?.revision ?? 0
      };
      await graph.offices.configureAgent({ ...registration, state: 'pending' }, operator);
      issued = await issueNetworkGrant(grantOptions);
      await graph.offices.configureAgent(
        { ...registration, state: 'active', expectedRevision: registration.expectedRevision + 1 },
        operator
      );
      await graph.close();
      startupGraph = undefined;
    } else issued = await issueNetworkGrant(grantOptions);
    console.log(JSON.stringify(issued, null, 2));
  } else if (command === 'workspace') {
    if (!values['workspace-file']) throw new Error('workspace requires --workspace-file');
    const accounts = await readNetworkConfiguration(config),
      stat = await fs.stat(values['workspace-file']);
    if (!stat.isFile() || stat.size > 131072)
      throw new Error('Workspace definition must be a small file');
    const workspace = workspaceSchema.parse(
      JSON.parse(await fs.readFile(values['workspace-file'], 'utf8'))
    );
    if (workspace.members.some((m) => !accounts.grants.some((g) => g.principal === m.principal)))
      throw new Error('Every member must be a registered account');
    const graph = new GraphMemory('.', { dbPath: values.db ?? defaultDatabasePath() });
    startupGraph = graph;
    await graph.init();
    console.log(
      JSON.stringify(
        await graph.collaboration.configure(workspace, {
          v: 1,
          principal: 'local-operator',
          operator: true,
          issuedAt: Date.now(),
          expiresAt: Number.MAX_SAFE_INTEGER
        }),
        null,
        2
      )
    );
    await graph.close();
    startupGraph = undefined;
  } else if (command === 'serve') {
    await readNetworkConfiguration(config);
    const host = values.host ?? '127.0.0.1',
      port = Number(values.port ?? 7904);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
    const allowedHosts =
      values['allowed-host'] ??
      (['127.0.0.1', 'localhost', '::1'].includes(host)
        ? [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
        : []);
    const graph = new GraphMemory('.', { dbPath: values.db ?? defaultDatabasePath() });
    startupGraph = graph;
    await graph.init();
    const network = createNetworkMcpApp(graph, {
      configuration: () => readNetworkConfiguration(config),
      allowedHosts
    });
    const cert = values['tls-cert'],
      key = values['tls-key'];
    if (!!cert !== !!key) throw new Error('Supply both --tls-cert and --tls-key');
    const listener =
      cert && key
        ? createHttpsServer(
            { cert: await fs.readFile(cert), key: await fs.readFile(key) },
            network.app
          )
        : undefined;
    const server = listener ? listener.listen(port, host) : network.app.listen(port, host);
    server.once('error', () => {
      console.error('Network MCP listener failed');
      process.exit(1);
    });
    server.once('listening', () => {
      const address = server.address();
      console.error(
        `[mindpond-mcp-http] listening on ${cert ? 'https' : 'http'}://${host}:${typeof address === 'object' && address ? address.port : port}/mcp`
      );
    });
    let closing = false;
    const stop = async () => {
      if (closing) return;
      closing = true;
      const timeout = setTimeout(() => process.exit(1), 30000);
      timeout.unref();
      try {
        await network.close(server);
        await graph.close();
        clearTimeout(timeout);
      } catch {
        process.exitCode = 1;
      }
    };
    process.once('SIGTERM', () => {
      void stop();
    });
    process.once('SIGINT', () => {
      void stop();
    });
  } else throw new Error('Use serve, grant, check-auth or workspace');
} catch {
  await startupGraph?.close().catch(() => {});
  console.error(
    'Network MCP startup failed. Check command options, private grant configuration and database path.'
  );
  process.exitCode = 1;
}
