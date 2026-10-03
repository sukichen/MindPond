/**
 * M02 verify: domain semantics are enforced at the REAL HTTP and MCP entries,
 * not only inside core methods (handbook M02.d — "不能仅测核心方法后声称 API
 * 全覆盖").  Spawns src/server.ts (HTTP) and src/mcp.ts (stdio JSON-RPC)
 * against a temp database and walks an interface × domain matrix.
 *
 * M02.a interface list — how each entry obtains its domain context:
 *
 *   entry                        domain acquisition                        status
 *   ---------------------------  ----------------------------------------  ------
 *   save / ingest                explicit domain (+sessionId, team grant)  ok
 *   search                       sessionId/domains; default personal/def   ok
 *                                +current session (never all sessions)
 *   list                         same as search (shared resolveReadDomains) ok
 *   get  node/:id                REQUIRED context: sessionId|domains,      gated
 *                                or scope=operator (human workbench)
 *   expand                       REQUIRED context (same rule)              gated
 *   connections node/:id         REQUIRED context (same rule)              gated
 *   update / delete              REQUIRED context + team grant for team    gated
 *   profile get / history        REQUIRED context (shared hostOperations)  gated
 *   listAssociations?memoryId    REQUIRED context when memoryId supplied   gated
 *   source get / observe         uri+context keyed registry, no memory     n/a
 *   organization / checkpoint /  explicit domain param (host-supplied)     ok
 *   work contexts/tasks
 *   graph / stats / dedupe-scan  operator-only views (human workbench,
 *                                127.0.0.1 + optional API key)
 *
 * Matrix (each case must hold on HTTP and, where the tool exists, MCP):
 *   1. bare node id WITHOUT context        → explicit reject (was: content leak)
 *   2. own current session                 → readable
 *   3. wrong session id (by id or domains) → reject (no widening into sessions)
 *   4. closed session                      → reject
 *   5. personal via explicit domains       → readable
 *   6. list/search default                 → personal only (no session scan)
 *   7. list/search domains widening        → reject or narrowed
 *   8. team write via legacy update API    → still requires host-signed grant
 *   9. cross-domain dedupe merge           → reject
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { signTeamWriteGrant } from '../src/core/domain.js';

const SECRET = 'verify-domain-entries-secret';
let failures = 0;
let checks = 0;

function ok(condition: unknown, message: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.log(`  FAIL  ${message}`);
  }
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-entries-'));
  return dir;
}

function childEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MEMORY_DB_PATH: path.join(dir, 'pond.db'),
    EMBEDDING_MODEL_DIR: path.join(dir, 'no-models'),
    MEMORY_HOST: '127.0.0.1',
    MEMORY_TEAM_AUTH_SECRET: SECRET,
  };
}

interface HttpResult { status: number; body: any }

async function http(port: number, method: string, urlPath: string, body?: unknown): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: any = null;
  try { parsed = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body: parsed };
}

async function waitUntil(fn: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function startHttpServer(dir: string): Promise<{ port: number; proc: ChildProcess }> {
  const proc = spawn(process.execPath, ['--import', 'tsx', path.resolve('src/server.ts')], {
    cwd: process.cwd(),
    env: { ...childEnv(dir), MEMORY_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stdout!.on('data', (d: Buffer) => { stderr += d.toString(); });
  proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`http server did not listen; output:\n${stderr}`)), 30_000);
    const watch = (d: Buffer) => {
      const m = d.toString().match(/listening on (\S+):(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[2])); }
    };
    proc.stdout!.on('data', watch);
    proc.stderr!.on('data', watch);
    proc.on('exit', code => { clearTimeout(timer); reject(new Error(`http server exited ${code}; stderr:\n${stderr}`)); });
  });
  await waitUntil(async () => {
    try { return (await http(port, 'GET', '/health')).status === 200; } catch { return false; }
  }, 15_000, 'http /health');
  return { port, proc };
}

/** Minimal MCP stdio JSON-RPC client (newline-delimited, like the SDK transport). */
class McpClient {
  private buffer = '';
  private pending = new Map<number, (value: any) => void>();
  private nextId = 1;
  constructor(private proc: ChildProcess) {
    proc.stdout!.on('data', (d: Buffer) => {
      this.buffer += d.toString();
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
            this.pending.get(msg.id)!(msg);
            this.pending.delete(msg.id);
          }
        } catch { /* ignore partial */ }
      }
    });
  }
  static async start(dir: string): Promise<McpClient> {
    const proc = spawn(process.execPath, ['--import', 'tsx', path.resolve('src/mcp.ts')], {
      cwd: process.cwd(),
      env: { ...childEnv(dir), MINDPOND_LOG_STDERR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    await waitUntil(() => Promise.resolve(stderr.includes('ready')), 30_000, 'mcp stdio ready');
    const client = new McpClient(proc);
    const init = await client.rpc('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-domain-entries', version: '0.0.0' },
    });
    if (!init.result) throw new Error(`mcp initialize failed: ${JSON.stringify(init)}`);
    client.notify('notifications/initialized', {});
    return client;
  }
  notify(method: string, params: unknown): void {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  rpc(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`mcp ${method} timeout`)), 20_000);
      this.pending.set(id, value => { clearTimeout(timer); resolve(value); });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; json: any; raw: any }> {
    const res = await this.rpc('tools/call', { name, arguments: args });
    if (res.error) return { isError: true, json: null, raw: res.error };
    const text = res.result?.content?.[0]?.text ?? '';
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-json */ }
    return { isError: res.result?.isError === true || json?.error !== undefined, json, raw: res.result };
  }
  stop(): void {
    this.proc.kill('SIGTERM');
  }
}

async function main(): Promise<void> {
  const dir = await makeTempDir();
  console.log(`verify-domain-entries: temp dir ${dir}`);
  const httpServer = await startHttpServer(dir);
  const port = httpServer.port;
  let mcp: McpClient | null = null;
  try {
    // ---- seed through the real HTTP entries ----
    const save = async (content: string, options: Record<string, unknown>) =>
      (await http(port, 'POST', '/api/memory/save', { content, ...options })).body;
    const personal = await save('personal fact: the launch code is ALPHA-1', { domain: { kind: 'personal', id: 'default' } });
    const s1 = await save('session S1 note: hotel wifi password is BETA-2', { domain: { kind: 'session', id: 'S1' }, sessionId: 'S1' });
    const s2 = await save('session S2 note: garage pin is GAMMA-3', { domain: { kind: 'session', id: 'S2' }, sessionId: 'S2' });
    assert.ok(personal.id && s1.id && s2.id, 'seed saves must return ids');
    const grant = signTeamWriteGrant({
      v: 1, authorizationId: 'auth-1', teamId: 't1', requestId: 'req-1',
      operations: ['save', 'edit', 'delete'], issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000,
    }, SECRET);
    const team = await save('team fact: deploy key rotation is on Fridays', { domain: { kind: 'team', id: 't1' }, teamAuthorization: grant });
    assert.ok(team.id, 'team save with grant must succeed');
    // One-shot nodes for destructive negative cases (pre-fix they really get
    // mutated/deleted — that is the leak — but must not disturb later cases).
    const disposable = await save('session S1 disposable note ZETA-4', { domain: { kind: 'session', id: 'S1' }, sessionId: 'S1' });
    assert.ok(disposable.id, 'disposable save must return an id');

    const closed = await http(port, 'POST', '/api/session/state', { sessionId: 'S2', status: 'closed' });
    ok(closed.status === 200, `session S2 closed via /api/session/state (got ${closed.status})`);

    const nodeCtx = (ctx: Record<string, unknown>) => new URLSearchParams(
      Object.entries(ctx).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
    ).toString();

    // ================= HTTP matrix =================
    console.log('--- HTTP: bare node id without context must be explicitly rejected ---');
    for (const [label, id] of [['personal', personal.id], ['session S1', s1.id]] as const) {
      const r = await http(port, 'GET', `/api/memory/node/${id}`);
      ok(r.status === 400, `GET node/${label} without context → 400 (got ${r.status} ${JSON.stringify(r.body)})`);
    }
    const bareConn = await http(port, 'GET', `/api/memory/node/${s1.id}/connections`);
    ok(bareConn.status === 400, `connections without context → 400 (got ${bareConn.status})`);
    const bareExpand = await http(port, 'POST', '/api/memory/expand', { nodeId: s1.id });
    ok(bareExpand.status === 400, `expand without context → 400 (got ${bareExpand.status})`);

    console.log('--- HTTP: own current session readable; wrong session rejected ---');
    const own = await http(port, 'GET', `/api/memory/node/${s1.id}?sessionId=S1`);
    ok(own.status === 200 && own.body?.node?.content?.includes('BETA-2'), `GET node S1 with sessionId=S1 → 200 (got ${own.status})`);
    const wrong = await http(port, 'GET', `/api/memory/node/${s1.id}?sessionId=S2`);
    ok(wrong.status !== 200, `GET node S1 with sessionId=S2 → reject (got ${wrong.status} ${JSON.stringify(wrong.body)})`);
    const widen = await http(port, 'GET', `/api/memory/node/${s1.id}?${nodeCtx({ domains: [{ kind: 'session', id: 'S2' }] })}`);
    ok(widen.status !== 200, `GET node S1 with domains=[session S2] (no sessionId) → reject (got ${widen.status})`);

    console.log('--- HTTP: closed session rejected ---');
    const closedRead = await http(port, 'GET', `/api/memory/node/${s2.id}?sessionId=S2`);
    ok(closedRead.status !== 200, `GET node of closed S2 with sessionId=S2 → reject (got ${closedRead.status})`);

    console.log('--- HTTP: personal via explicit domains and operator scope ---');
    const viaDomains = await http(port, 'GET', `/api/memory/node/${personal.id}?${nodeCtx({ domains: [{ kind: 'personal', id: 'default' }] })}`);
    ok(viaDomains.status === 200, `GET personal node with domains=[personal] → 200 (got ${viaDomains.status})`);
    const viaOperator = await http(port, 'GET', `/api/memory/node/${s1.id}?scope=operator`);
    ok(viaOperator.status === 200, `GET session node with scope=operator (human workbench) → 200 (got ${viaOperator.status})`);

    console.log('--- HTTP: connections/expand respect the context ---');
    const connWrong = await http(port, 'GET', `/api/memory/node/${s1.id}/connections?sessionId=S2`);
    ok(connWrong.status !== 200, `connections S1 with sessionId=S2 → reject (got ${connWrong.status})`);
    const expandWrong = await http(port, 'POST', '/api/memory/expand', { nodeId: s1.id, sessionId: 'S2' });
    ok(expandWrong.status !== 200, `expand S1 with sessionId=S2 → reject (got ${expandWrong.status})`);
    const expandOwn = await http(port, 'POST', '/api/memory/expand', { nodeId: s1.id, sessionId: 'S1' });
    ok(expandOwn.status === 200 && expandOwn.body?.node?.content?.includes('BETA-2'), `expand S1 with sessionId=S1 → 200 (got ${expandOwn.status})`);

    console.log('--- HTTP: update/delete require context; team still requires the grant ---');
    const updNoCtx = await http(port, 'POST', '/api/memory/update', { nodeId: s1.id, tags: ['x'] });
    ok(updNoCtx.status !== 200, `update without context → reject (got ${updNoCtx.status})`);
    const updWrong = await http(port, 'POST', '/api/memory/update', { nodeId: s1.id, tags: ['x'], sessionId: 'S2' });
    ok(updWrong.status !== 200, `update S1 with sessionId=S2 → reject (got ${updWrong.status})`);
    const updOwn = await http(port, 'POST', '/api/memory/update', { nodeId: s1.id, tags: ['entry-matrix'], sessionId: 'S1' });
    ok(updOwn.status === 200, `update S1 with sessionId=S1 → 200 (got ${updOwn.status} ${JSON.stringify(updOwn.body)})`);
    const teamNoGrant = await http(port, 'POST', '/api/memory/update', { nodeId: team.id, importance: 9, domains: [{ kind: 'team', id: 't1' }] });
    ok(teamNoGrant.status !== 200 && /team_write_unauthorized|authorization/i.test(String(teamNoGrant.body?.error)),
      `legacy team update without grant → rejected (got ${teamNoGrant.status} ${JSON.stringify(teamNoGrant.body)})`);
    const teamGrant = await http(port, 'POST', '/api/memory/update', { nodeId: team.id, importance: 9, domains: [{ kind: 'team', id: 't1' }], teamAuthorization: grant });
    ok(teamGrant.status === 200, `team update with host-signed grant → 200 (got ${teamGrant.status} ${JSON.stringify(teamGrant.body)})`);
    const delNoCtx = await http(port, 'POST', '/api/memory/delete', { nodeId: disposable.id });
    ok(delNoCtx.status !== 200, `delete without context → reject (got ${delNoCtx.status})`);
    const delOwn = await http(port, 'POST', '/api/memory/delete', { nodeId: disposable.id, sessionId: 'S1' });
    ok(delOwn.status === 200, `delete disposable with sessionId=S1 → 200 (got ${delOwn.status})`);

    console.log('--- HTTP: profile entries require context ---');
    const profNoCtx = await http(port, 'POST', '/api/memory/profile/get', { membershipId: 'missing-membership' });
    ok(profNoCtx.status === 400 && /domain context/i.test(String(profNoCtx.body?.error)),
      `profile/get without context → 400 domain context (got ${profNoCtx.status} ${JSON.stringify(profNoCtx.body)})`);

    console.log('--- HTTP: list/search defaults never read sessions; widening rejected ---');
    const listDefault = await http(port, 'GET', '/api/memory/list');
    const defaultIds: string[] = (listDefault.body?.nodes ?? []).map((n: any) => n.id);
    ok(!defaultIds.includes(s1.id) && !defaultIds.includes(s2.id), `list default excludes session nodes`);
    const listWiden = await http(port, 'GET', `/api/memory/list?${nodeCtx({ domains: [{ kind: 'session', id: 'S1' }] })}`);
    ok(listWiden.status !== 200, `list with domains=[session S1] and no sessionId → reject (got ${listWiden.status})`);
    const listOwn = await http(port, 'GET', `/api/memory/list?${nodeCtx({ sessionId: 'S1', domains: [{ kind: 'session', id: 'S1' }] })}`);
    const ownIds: string[] = (listOwn.body?.nodes ?? []).map((n: any) => n.id);
    ok(listOwn.status === 200 && ownIds.includes(s1.id) && !ownIds.includes(s2.id),
      `list with sessionId=S1 narrows to S1 only (got ${listOwn.status} ${JSON.stringify(ownIds)})`);
    const searchWiden = await http(port, 'POST', '/api/memory/search', { query: 'wifi password', sessionId: 'S2', domains: [{ kind: 'session', id: 'S1' }] });
    ok(searchWiden.status !== 200, `search widening S1 while declaring S2 → reject (got ${searchWiden.status})`);
    const searchDefault = await http(port, 'POST', '/api/memory/search', { query: 'wifi password' });
    const hitIds: string[] = (searchDefault.body?.results ?? []).map((r: any) => r.id);
    ok(!hitIds.includes(s1.id), `search default must not return session S1 content (got ${JSON.stringify(hitIds)})`);
    const searchOwn = await http(port, 'POST', '/api/memory/search', { query: 'wifi password', sessionId: 'S1' });
    ok((searchOwn.body?.results ?? []).some((r: any) => r.id === s1.id), `search with sessionId=S1 finds the S1 note`);

    console.log('--- HTTP: cross-domain dedupe merge rejected ---');
    const dupSource = await save('personal fact: the launch code is ALPHA-1', { domain: { kind: 'personal', id: 'default' } });
    const dedupeVictim = await save('session S1 dedupe victim OMEGA-9', { domain: { kind: 'session', id: 'S1' }, sessionId: 'S1' });
    const merge = await http(port, 'POST', '/api/memory/dedupe/resolve', { keepId: personal.id, deleteIds: [dupSource.id, dedupeVictim.id], reason: 'matrix' });
    ok(merge.status !== 200 || merge.body?.ok === false || /domain/i.test(String(merge.body?.error ?? '')),
      `dedupe merge spanning personal+session → reject (got ${merge.status} ${JSON.stringify(merge.body)})`);

    // ================= MCP matrix =================
    console.log('--- MCP: memory_get / expand / connections / update require context ---');
    mcp = await McpClient.start(dir);
    const mcpNoCtx = await mcp.call('memory_get', { nodeId: s1.id });
    ok(mcpNoCtx.isError, `memory_get without context → error (got ${JSON.stringify(mcpNoCtx.raw).slice(0, 200)})`);
    const mcpWrong = await mcp.call('memory_get', { nodeId: s1.id, sessionId: 'S2' });
    ok(mcpWrong.isError, `memory_get with wrong sessionId=S2 → error (got ${JSON.stringify(mcpWrong.raw).slice(0, 200)})`);
    const mcpOwn = await mcp.call('memory_get', { nodeId: s1.id, sessionId: 'S1' });
    ok(!mcpOwn.isError && mcpOwn.json?.content?.includes('BETA-2'), `memory_get with sessionId=S1 → content (got ${JSON.stringify(mcpOwn.raw).slice(0, 200)})`);
    const mcpClosed = await mcp.call('memory_get', { nodeId: s2.id, sessionId: 'S2' });
    ok(mcpClosed.isError, `memory_get of closed session → error (got ${JSON.stringify(mcpClosed.raw).slice(0, 200)})`);
    const mcpExpand = await mcp.call('memory_expand', { nodeId: s1.id });
    ok(mcpExpand.isError, `memory_expand without context → error (got ${JSON.stringify(mcpExpand.raw).slice(0, 200)})`);
    const mcpConn = await mcp.call('memory_connections', { nodeId: s1.id });
    ok(mcpConn.isError, `memory_connections without context → error (got ${JSON.stringify(mcpConn.raw).slice(0, 200)})`);
    const mcpUpd = await mcp.call('memory_update', { nodeId: s1.id, sessionId: 'S1', tags: ['entry-matrix'] });
    ok(!mcpUpd.isError, `memory_update with sessionId=S1 → ok (got ${JSON.stringify(mcpUpd.raw).slice(0, 200)})`);
    const mcpListWiden = await mcp.call('memory_list', { domains: [{ kind: 'session', id: 'S1' }] });
    ok(mcpListWiden.isError, `memory_list widening session without sessionId → error (got ${JSON.stringify(mcpListWiden.raw).slice(0, 200)})`);
    const mcpProf = await mcp.call('memory_profile_get', { membershipId: 'missing-membership' });
    ok(mcpProf.isError, `memory_profile_get without context → error (got ${JSON.stringify(mcpProf.raw).slice(0, 200)})`);

    console.log(`\nverify-domain-entries: ${checks - failures}/${checks} checks passed`);
    if (failures > 0) {
      console.log(`verify-domain-entries: FAILED — ${failures} check(s) violated the domain matrix`);
      process.exitCode = 1;
    }
  } finally {
    mcp?.stop();
    httpServer.proc.kill('SIGTERM');
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(err => {
  console.error('verify-domain-entries: fatal:', err);
  process.exit(1);
});
