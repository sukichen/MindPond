#!/usr/bin/env node
import 'dotenv/config';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {GraphMemory} from './core/graph-memory.js';
import {defaultDatabasePath} from './core/runtime-paths.js';
import {normalizeDomain,type MemoryDomainRef} from './core/domain.js';
import type {TrustedCallContext} from './core/trust.js';
import {parseMcpToolProfile} from './core/mcp-tool-profile.js';
import {createMemoryMcpServer} from './mcp-service.js';
// stdio transports reserve stdout for JSON-RPC. Logger output must never be
// mixed with protocol frames, including startup before the first tool call.
process.env.MINDPOND_LOG_STDERR = '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.MEMORY_DB_PATH) {
  process.env.MEMORY_DB_PATH = defaultDatabasePath(path.resolve(__dirname, '..', 'data', 'graph.db'));
}

const graphMemory = new GraphMemory();

// ---- R03: bind the stdio caller's identity from startup configuration. The
// host owner sets these in the MCP launch env; the LLM can only narrow — it
// can never widen past the bound context. Without any binding the pre-R03
// behavior (tool parameters carry the context) is kept. ----
const TRUST_SESSION = process.env.MEMORY_TRUST_SESSION ?? '';
const TRUST_DOMAINS: MemoryDomainRef[] = (() => {
  const raw = process.env.MEMORY_TRUST_DOMAINS;
  if (!raw) return [];
  try { const value=JSON.parse(raw); if(!Array.isArray(value))throw new Error('not an array'); return value.map(d=>normalizeDomain(d,TRUST_SESSION||undefined)); } catch { throw new Error('MEMORY_TRUST_DOMAINS must be a JSON array of {kind,id}'); }
})();
const TRUST_OPERATOR = process.env.MEMORY_TRUST_OPERATOR === '1';
const trustBound = ['MEMORY_TRUST_PRINCIPAL','MEMORY_TRUST_SESSION','MEMORY_TRUST_DOMAINS','MEMORY_TRUST_OPERATOR'].some(key=>process.env[key]!==undefined);
const trusted: TrustedCallContext = {
  v: 1,
  principal: process.env.MEMORY_TRUST_PRINCIPAL ?? 'stdio-host',
  ...(TRUST_SESSION ? { sessionId: TRUST_SESSION } : {}),
  ...(TRUST_DOMAINS.length ? { domains: TRUST_DOMAINS } : {}),
  ...(TRUST_OPERATOR ? { operator: true as const } : {}),
  issuedAt: 0,
  expiresAt: Number.MAX_SAFE_INTEGER,
};
const service=createMemoryMcpServer(graphMemory,{...(trustBound?{trusted}:{}),toolProfile:parseMcpToolProfile(process.env.MINDPOND_TOOL_PROFILE)});
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
