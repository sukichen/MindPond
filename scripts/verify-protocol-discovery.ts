/** A01/A02 gate: progressive protocol rule discovery. Covers acceptance
 * "无先验工具发现、规则版本、合法示例和纠错" (A02 later extends the 纠错 half)
 * through three real service boundaries:
 *   HTTP   — a fresh host with zero prior knowledge finds the rules tool in
 *            capabilities, then negotiates: full payload → sinceVersion
 *            upToDate → cacheDigests delta → incompatible major rejected.
 *   MCP    — tools/list discovers memory_protocol_rules, resources/list finds
 *            the optional equivalent channel, both return the same payload.
 *   in-proc — docs/protocol-rules.json is drift-free and every policy example
 *            passes the REAL schemas (organizationPlanSchema) and validators
 *            (save endpoint, organization commit) with real issued ids.
 * Fails non-zero on any violation. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'url';
import { PROTOCOL_VERSION, protocolRulesPayload } from '../src/core/protocol.js';
import { organizationPlanSchema } from '../src/core/host-contract.js';
import { organizationPolicyPayload } from '../src/core/organization-policy.js';
import { memorySavePolicyPayload } from '../src/core/save-policy.js';
import { GraphMemory as InProcessGraph } from '../src/core/graph-memory.js';
import { MEMORY_BOOTSTRAP } from '../src/core/bootstrap.js';
import { prepareClientBundle, clientLaunch } from '../src/integrations/client-bundle.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-proto-'));
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 7928;
const child = spawn(process.execPath, [path.join(root, 'dist', 'server.js')], {
  env: { ...process.env, MEMORY_DB_PATH: path.join(dir, 'pond.db'), MEMORY_PORT: String(port), EMBEDDING_ZH_ENABLED: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 30000;
while (!output.includes('listening') && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
assert(output.includes('listening'), `server did not start: ${output.slice(-500)}`);

let passed = 0;
const ok = (label: string) => { passed += 1; console.log(`PASS ${label}`); };
const post = async (url: string, body: unknown) => {
  const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
};
const get = async (url: string) => {
  const res = await fetch(base + url);
  return { status: res.status, body: await res.json() as any };
};
const save = async (content: string, spaceId: string) => {
  const r = await post('/api/memory/save', { content, memberships: [{ spaceId, memoryType: 'fact' }] });
  assert.equal(r.status, 200, `save failed: ${JSON.stringify(r.body)}`);
  return r.body as { id: string; memberships: Array<{ id: string }> };
};

/** Minimal MCP stdio client: initialize → notifications/initialized, then
 * newline-delimited JSON-RPC. Rejects on error responses and timeouts. */
async function withMcp(fn: (rpc: (method: string, params?: any) => Promise<any>, notify: (method: string, params?: any) => void) => Promise<void>) {
  const mcp = spawn(process.execPath, [path.join(root, 'dist', 'mcp.js')], {
    env: { ...process.env, MEMORY_DB_PATH: path.join(dir, 'mcp.db'), EMBEDDING_ZH_ENABLED: 'false' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rl = readline.createInterface({ input: mcp.stdout! });
  const pending = new Map<number, (msg: any) => void>();
  let errOut = '';
  mcp.stderr!.on('data', (d: Buffer) => { errOut += d.toString(); });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    } catch { /* tolerate non-protocol noise */ }
  });
  let nextId = 1;
  const rpc = (method: string, params?: any) => new Promise<any>((resolve, reject) => {
    const id = nextId += 1;
    const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out; stderr: ${errOut.slice(-300)}`)), 30000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      msg.error ? reject(new Error(`MCP ${method} error: ${JSON.stringify(msg.error)}`)) : resolve(msg.result);
    });
    mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }) + '\n');
  });
  const notify = (method: string, params?: any) => {
    mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }) + '\n');
  };
  try { await fn(rpc, notify); } finally { mcp.kill(); rl.close(); }
}

try {
  // ---- A01: zero-prior discovery — a fresh host learns everything from the
  // capability list alone, no documentation or prior session required. ----
  const caps = await get('/api/host/capabilities');
  assert.equal(caps.status, 200);
  assert.ok(caps.body.features.includes('protocol-rules'), 'capabilities must advertise the protocol-rules feature');
  assert.equal(caps.body.version, 'mindpond.host.v1');
  const full = await get('/api/protocol/rules');
  assert.equal(full.status, 200);
  assert.equal(full.body.version, PROTOCOL_VERSION);
  assert.ok(typeof full.body.full === 'string' && full.body.full.includes('MindPond host protocol'), 'full short-rule text travels with the payload');
  assert.ok(full.body.defaults && Object.keys(full.body.defaults).length >= 5, 'budgets/defaults come from the same source');
  assert.ok(Array.isArray(full.body.sections) && full.body.sections.length >= 10, 'short rules are grouped into stable sections');
  for (const s of full.body.sections) {
    assert.ok(s.id && s.title && /^[0-9a-f]{12}$/.test(s.digest) && typeof s.text === 'string' && s.text.length > 20,
      `section shape invalid: ${JSON.stringify(s).slice(0, 120)}`);
  }
  ok('A01 zero-prior discovery: capabilities → GET /api/protocol/rules returns version + sections + defaults');

  // ---- A01: version negotiation — upToDate probe, stale clients re-sync full. ----
  const upto = await get(`/api/protocol/rules?sinceVersion=${PROTOCOL_VERSION}&sinceDimensionRevision=${full.body.dimensionPolicyRevision}`);
  assert.deepEqual(upto.body, { version: PROTOCOL_VERSION, upToDate: true,dimensionPolicyRevision:full.body.dimensionPolicyRevision }, 'unchanged version must answer upToDate without resending rules');
  const stale = await get('/api/protocol/rules?sinceVersion=0.9.0');
  assert.equal(stale.status, 200);
  assert.ok(stale.body.sections?.length >= 10, 'an out-of-date client is re-served the FULL rules, never a delta against an unknown base');
  ok('A01 version negotiation: sinceVersion upToDate probe; unknown base re-fetches full');

  // ---- A01: cacheDigests — only genuinely changed sections travel. ----
  const digests = Object.fromEntries(full.body.sections.map((s: any) => [s.id, s.digest]));
  const tampered = { ...digests, safety: '000000000000' };
  const delta = await get(`/api/protocol/rules?cacheDigests=${encodeURIComponent(JSON.stringify(tampered))}`);
  assert.equal(delta.status, 200);
  assert.equal(delta.body.upToDate, false);
  assert.deepEqual(delta.body.sections.map((s: any) => s.id), ['safety'], 'exactly the tampered section is re-sent');
  assert.equal(delta.body.sections[0].digest, digests.safety);
  const fresh = await get(`/api/protocol/rules?cacheDigests=${encodeURIComponent(JSON.stringify(digests))}`);
  assert.equal(fresh.body.upToDate, true);
  assert.ok(!('sections' in fresh.body), 'an all-fresh cache receives no sections at all');
  ok('A01 cacheDigests delta: tampered section only; all-fresh answers upToDate');

  // ---- A01: incompatible major version is rejected explicitly — old rules
  // are never silently served to a client that cannot handle them. ----
  const old = await get('/api/protocol/rules?clientVersion=0.9.0');
  assert.equal(old.status, 400, `incompatible major must fail, got ${old.status}: ${JSON.stringify(old.body)}`);
  assert.equal(old.body.code, 'invalid_input');
  assert.match(String(old.body.error), /incompatible/);
  assert.ok(old.body.nextAction, 'the rejection must name the next step (reject session / negotiate downgrade / re-fetch)');
  ok('A01 incompatible clientVersion 0.9.0 explicitly rejected with nextAction');

  // ---- A01: zero-prior domain + organization entry. A fresh agent reads the
  // task policy from /next and drives the discovered entry to completion using
  // the policy's own example shapes with REAL issued ids. ----
  const S5 = 'verify/proto-a01';
  for (let i = 1; i <= 4; i += 1) await save(`PROTO-A01 item ${i}: deployment procedure step ${i}`, S5);
  const created = await post('/api/organization/request', { spaceId: S5, memoryType: 'fact', batchSize: 2 });
  assert.equal(created.status, 200, `request start failed: ${JSON.stringify(created.body)}`);
  const requestId = created.body.requestId as string;

  const claimBatch = async () => {
    const r = await post(`/api/organization/request/${requestId}/next`, {});
    assert.equal(r.status, 200, `next failed: ${JSON.stringify(r.body)}`);
    return r.body as { job: { id: string; members: Array<{ membership: { id: string } }> } | null; progress?: any; policy?: any };
  };
  const b1 = await claimBatch();
  assert.ok(b1.job, 'first batch expected');
  assert.ok(Array.isArray(b1.policy?.constraints) && b1.policy.constraints.some((c: string) => c.includes('0–48')),
    'the /next task payload must carry the policy constraints a fresh agent needs');
  const consolidateExample = organizationPolicyPayload().operations.consolidate as any;
  const commit1 = await post('/api/organization/commit', {
    jobId: b1.job!.id,
    plan: { operations: [{ kind: 'consolidate', membershipIds: b1.job!.members.map(m => m.membership.id), content: consolidateExample.content, importance: consolidateExample.importance, tags: consolidateExample.tags, reason: consolidateExample.reason }] },
  });
  assert.equal(commit1.status, 200, `consolidate example failed the real validator: ${JSON.stringify(commit1.body)}`);
  await post(`/api/organization/request/${requestId}/report`, { jobId: b1.job!.id, result: 'committed' });

  const b2 = await claimBatch();
  assert.ok(b2.job, 'second batch expected');
  const keepExample = organizationPolicyPayload().operations.keep as any;
  const commit2 = await post('/api/organization/commit', {
    jobId: b2.job!.id,
    plan: { operations: [{ kind: 'keep', membershipIds: b2.job!.members.map(m => m.membership.id), reason: keepExample.reason }] },
  });
  assert.equal(commit2.status, 200, `keep example failed the real validator: ${JSON.stringify(commit2.body)}`);
  await post(`/api/organization/request/${requestId}/report`, { jobId: b2.job!.id, result: 'committed' });

  const drained = await claimBatch();
  assert.equal(drained.job, null, 'the request must drain inside its watermark');
  assert.equal(drained.progress!.status, 'completed');
  assert.equal(drained.progress!.receipt.total, 4);
  assert.equal(drained.progress!.receipt.mutations, 1, 'one consolidate landed; keeps derive zero mutations');
  ok('A01 zero-prior organization entry: task policy → example shapes with real ids → completed receipt');

  // ---- A01: the save-policy example passes the REAL save validator once the
  // placeholder association target is replaced with a real issued membership
  // id (exactly what the policy itself teaches: never submit placeholders).
  // The anchor must live in the example's own placement (项目 P/配置) because
  // related targets resolve to one active shared space/type. ----
  const anchor = await post('/api/memory/save', {
    content: 'PROTO-A01 association anchor memory in the example placement.',
    memberships: [{ spaceId: '项目 P', memoryType: '配置' }],
  });
  assert.equal(anchor.status, 200, `anchor save failed: ${JSON.stringify(anchor.body)}`);
  const ex = memorySavePolicyPayload().example;
  const savedExample = await post('/api/memory/save', {
    ...ex,
    related: [{ ...ex.related[0], membershipId: anchor.body.memberships[0].id }],
  });
  assert.equal(savedExample.status, 200, `save-policy example failed the real validator: ${JSON.stringify(savedExample.body)}`);
  assert.equal(savedExample.body.ok, true);
  assert.equal(savedExample.body.memberships?.length, 1);
  ok('A01 save-policy example accepted by the real save validator with a real association target');

  // ---- A02: side-effect-free validate with indexed anchor errors — a bad
  // basis is reported at its array index with the constraint and fix, the
  // valid sibling anchor survives, and the targeted fix validates clean. ----
  const validateContent = 'PROTO-A02 target: 服务监听 127.0.0.1:7903；修改端口后需同步更新启动脚本与代理目标。依据：2026-09-20 观察到一次端口修改后代理仍指向旧地址。限制：仅本地开发，不涉及生产部署。';
  const validateArgs = {
    content: validateContent,
    memberships: [{ spaceId: '项目 P', memoryType: '配置' }],
    anchors: [
      { text: '代理目标端口配置', basis: '服务监听 127.0.0.1:7903', spaceId: '项目 P', memoryType: '配置' },
      { text: '服务监听端口', basis: '监听 0.0.0.0:7903', spaceId: '项目 P', memoryType: '配置' },
    ],
  };
  const bad = await post('/api/memory/save/validate', validateArgs);
  assert.equal(bad.status, 200, `validate endpoint failed: ${JSON.stringify(bad.body)}`);
  assert.equal(bad.body.valid, false);
  assert.equal(bad.body.anchors.accepted, 1, 'the valid anchor must survive diagnosis');
  assert.equal(bad.body.anchors.issues.length, 1);
  assert.equal(bad.body.anchors.issues[0].index, 1, 'the invalid anchor is reported at its array index');
  assert.match(bad.body.anchors.issues[0].constraint, /exact excerpt/);
  assert.ok(bad.body.anchors.issues[0].fix, 'each issue names how to fix it');
  const fixed = await post('/api/memory/save/validate', { ...validateArgs,
    anchors: [validateArgs.anchors[0], { ...validateArgs.anchors[1], basis: '修改端口后需同步更新启动脚本与代理目标' }] });
  assert.equal(fixed.body.valid, true, `targeted fix must validate clean: ${JSON.stringify(fixed.body.anchors)}`);
  assert.equal(fixed.body.anchors.accepted, 2);
  assert.equal(fixed.body.anchors.issues.length, 0);
  assert.deepEqual(fixed.body.placements, [{ spaceId: '项目 P', memoryType: '配置' }], 'the preview names the placements the save would use');
  ok('A02 invalid anchor fixed by index without dropping the valid sibling; placements previewed');

  // A02: the validate tool is discoverable from capabilities alone.
  assert.ok((await get('/api/host/capabilities')).body.features.includes('save-validate'),
    'capabilities must advertise the save-validate feature');
  ok('A02 save-validate discoverable from capabilities');

  // ---- A01: MCP channel — tools/list discovers the rules tool with zero
  // prior knowledge; the optional resource is an equivalent channel. ----
  await withMcp(async (rpc, notify) => {
    const init = await rpc('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'verify-protocol-discovery', version: '0.0.0' },
    });
    assert.ok(init.serverInfo?.name, 'MCP server answers initialize');
    assert.equal(init.instructions, MEMORY_BOOTSTRAP, 'MCP initialize must deliver the current onboarding instructions');
    assert.ok(Buffer.byteLength(init.instructions, 'utf8') <= 512, 'the entire first-use prompt must fit within 512 UTF-8 bytes');
    const firstWindow = init.instructions.slice(0, 512);
    for (const required of ['memory_protocol_rules', 'memory_save_policy', 'memory_brief', 'multi-round',
      'user intent', 'memory_save', 'memory_use_report', 'untrusted', 'domains']) {
      assert.ok(firstWindow.includes(required), `the first 512 instruction characters must include ${required}`);
    }
    ok('A01 fresh MCP host receives the review-and-save workflow in its first instruction window');
    notify('notifications/initialized');
    const tools = await rpc('tools/list');
    const names: string[] = tools.tools.map((t: any) => t.name);
    const saveTool = tools.tools.find((t: any) => t.name === 'memory_save');
    assert(Buffer.byteLength(saveTool.description, 'utf8') <= 800, 'save tool metadata must stay short');
    assert(saveTool.description.includes('memory_save_policy'), 'full save rules remain discoverable');
    assert(!saveTool.description.includes('FINAL CHECK'), 'full policy must not be resident in tools/list');
    assert.ok(names.includes('memory_protocol_rules'), 'a fresh MCP host discovers the rules tool from tools/list alone');
    const viaTool = await rpc('tools/call', { name: 'memory_protocol_rules', arguments: {} });
    assert.ok(!viaTool.isError, `tools/call must succeed: ${JSON.stringify(viaTool).slice(0, 200)}`);
    const toolPayload = JSON.parse(viaTool.content[0].text);
    assert.equal(toolPayload.version, PROTOCOL_VERSION);
    assert.ok(toolPayload.sections.length >= 10);
    const resList = await rpc('resources/list');
    assert.ok(resList.resources.some((r: any) => r.uri === 'mindpond://protocol/rules'), 'the optional equivalent resource is discoverable');
    const resRead = await rpc('resources/read', { uri: 'mindpond://protocol/rules' });
    const resPayload = JSON.parse(resRead.contents[0].text);
    assert.equal(resPayload.version, PROTOCOL_VERSION);
    assert.deepEqual(resPayload.sections.map((s: any) => s.id), toolPayload.sections.map((s: any) => s.id),
      'resource and tool must serve identical rules');
  });
  ok('A01 MCP channel: tools/list discovery + tools/call + equivalent resource all consistent');

  // The same first-use instructions must reach each generated client bundle.
  for (const client of ['codex', 'claude', 'opencode'] as const) {
    const directory = path.join(dir, `bundle-${client}`);
    await prepareClientBundle({ client, directory, dbPath: path.join(dir, 'shared-client.db'),
      mcpPath: path.join(root, 'dist', 'mcp.js') });
    assert.equal(await fs.readFile(path.join(directory, 'instructions.md'), 'utf8'), MEMORY_BOOTSTRAP + '\n');
    const launch = await clientLaunch(directory);
    if (client === 'claude') {
      const index = launch.args.indexOf('--append-system-prompt');
      assert.ok(index >= 0 && launch.args[index + 1] === MEMORY_BOOTSTRAP,
        'Claude must receive the onboarding prompt as a launch argument');
    }
    if (client === 'opencode') {
      const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!);
      assert.ok(config.instructions.includes(path.join(directory, 'instructions.md')),
        'OpenCode must load the generated onboarding instructions');
    }
  }
  ok('A01 Codex, Claude and OpenCode bundles carry the same onboarding prompt');

  // ---- A01: the generated export is drift-free — regenerated payload equals
  // the committed docs/protocol-rules.json byte-for-byte (modulo header). ----
  child.kill();
  const exported = JSON.parse((await fs.readFile(path.join(root, 'docs', 'protocol-rules.json'), 'utf8')).replace(/^<!--[\s\S]*?-->\s*/, ''));
  assert.deepEqual(exported, protocolRulesPayload(), 'docs/protocol-rules.json drifted from src/core/protocol.ts — run npm run docs:prompts');
  ok('A01 generated docs/protocol-rules.json is drift-free against the single source');

  // ---- A02: validate writes nothing and creates no task — proven on a fresh
  // in-process graph by counting rows before/after a full valid preview. ----
  process.env.MEMORY_DB_PATH = path.join(dir, 'validate.db');
  const vg = new InProcessGraph();
  await vg.init();
  const vgAnchor = await vg.saveMemory('A02 no-write anchor memory.', { memberships: [{ spaceId: '项目 P', memoryType: '配置' }] });
  const countRows = async () => ({
    nodes: (await (vg as any).db.get('SELECT COUNT(*) AS n FROM nodes')).n,
    memberships: (await (vg as any).db.get('SELECT COUNT(*) AS n FROM memory_memberships')).n,
    work: (await (vg as any).db.get(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='host_work'`)).n
      ? (await (vg as any).db.get('SELECT COUNT(*) AS n FROM host_work')).n : 0,
    requests: (await (vg as any).db.get('SELECT COUNT(*) AS n FROM organization_requests')).n,
  });
  const before = await countRows();
  const preview = await vg.validateMemorySave({
    content: 'A02 no-write preview body: full valid payload with anchors and an association.',
    memberships: [{ spaceId: '项目 P', memoryType: '配置' }],
    anchors: [{ text: 'no-write preview trigger', basis: 'full valid payload with anchors and an association', spaceId: '项目 P', memoryType: '配置' }],
    related: [{ membershipId: vgAnchor.memberships[0].id, score: 0.7,
      reason: 'association preview target actually read in this verify', context: 'verify-only association within the same placement' }],
  });
  assert.equal(preview.valid, true, `valid preview expected: ${JSON.stringify(preview)}`);
  assert.equal(preview.related.accepted, 1);
  const after = await countRows();
  assert.deepEqual(after, before, `validate must not write anything: ${JSON.stringify({ before, after })}`);
  await vg.close();
  ok('A02 validate is side-effect-free: zero node/membership/work/request rows created');

  // ---- A01: every policy operation example passes the REAL schema union;
  // the empty plan is legal (= checked no_change), matching the runtime. ----
  const policy = organizationPolicyPayload();
  for (const [kind, example] of Object.entries(policy.operations as Record<string, any>)) {
    // the payload keys each example by its operation kind; the wire form adds kind
    organizationPlanSchema.parse({ operations: [{ kind, ...example }] });
    ok(`A01 policy example '${kind}' passes organizationPlanSchema`);
  }
  organizationPlanSchema.parse({ operations: [] });
  ok('A01 empty operations array parses as a checked no_change plan (schema matches runtime)');

  console.log(`\n${passed} checks passed (verify-protocol-discovery)`);
  process.exit(0);
} catch (err) {
  console.error(`FAIL verify-protocol-discovery: ${(err as Error).message}`);
  if (output) console.error(`--- server tail ---\n${output.slice(-800)}`);
  child.kill();
  process.exit(1);
}
