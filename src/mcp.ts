#!/usr/bin/env node
import 'dotenv/config';
import {createOwnerMemoryServer} from './role-memory-service.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {GraphMemory} from './core/graph-memory.js';
import {defaultDatabasePath} from './core/runtime-paths.js';
// stdio transports reserve stdout for JSON-RPC. Logger output must never be
// mixed with protocol frames, including startup before the first tool call.
process.env.MINDPOND_LOG_STDERR = '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.MEMORY_DB_PATH) {
  process.env.MEMORY_DB_PATH = defaultDatabasePath(path.resolve(__dirname, '..', 'data', 'graph.db'));
}

const graphMemory = new GraphMemory();

// Public stdio exposes only role-bound Memory. Startup personal/domain/profile
// settings cannot switch an agent to a human or administrative tool catalog.
const service=createOwnerMemoryServer(graphMemory);
let closing=false;
async function shutdown() {
  if(closing)return;closing=true;
  const deadline=setTimeout(()=>process.exit(1),30000);deadline.unref();
  try {await service.close();await graphMemory.close();clearTimeout(deadline);}
  catch {process.exitCode=1;}
}
process.once('SIGINT',()=>{void shutdown();});
process.once('SIGTERM',()=>{void shutdown();});

async function main() {
  await graphMemory.init();
  const transport = new StdioServerTransport();
  await service.server.connect(transport);
  console.error('[agent-memory-mcp] ready (stdio)');
}

main().catch((err) => {
  console.error('[agent-memory-mcp] fatal:', err);
  process.exit(1);
});
