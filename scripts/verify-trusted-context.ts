/** R03 gate: trusted call context across every entry (acceptance T10/T11).
 * Runs a real strict-mode server (MEMORY_CONTEXT_SECRET + MEMORY_OPERATOR_KEY
 * + MEMORY_TEAM_AUTH_SECRET) and proves: model-authored sessionId/domains/
 * scope can never widen a signed context; unknown sessions return nothing and
 * default reads never go global; operator capability is isolated from agent
 * tools; a recovered agent on the same lawful session keeps working; private
 * → team references never leak content or rationale backwards; team writes
 * need a host-signed grant. A second legacy-mode server proves single-user
 * deployments (sample-agent) keep the pre-R03 parameter-supplied behavior. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'url';
import { signContextToken } from '../src/core/trust.js';
import { signTeamWriteGrant } from '../src/core/domain.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-trust-'));
const distServer = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.js');
await fs.access(distServer);

const CONTEXT_SECRET = 'verify-context-secret';
const OPERATOR_KEY = 'verify-operator-key';
const TEAM_SECRET = 'verify-team-secret';
const STRICT_PORT = 7924;
const LEGACY_PORT = 7925;

const fixtureChildren:ReturnType<typeof spawn>[]=[];
function startServer(port: number, extraEnv: Record<string, string>) {
  const child = spawn(process.execPath, [distServer], {
    env: { ...process.env, MEMORY_DB_PATH: path.join(dir, `pond-${port}.db`), MEMORY_PORT: String(port), EMBEDDING_ZH_ENABLED: 'false', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fixtureChildren.push(child);
  let output = '';
  child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
  return {
    child,
    ready: async () => {
      const deadline = Date.now() + 30000;
      while (!output.includes('listening') && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
      assert(output.includes('listening'), `server ${port} did not start: ${output}`);
    },
  };
}

let passed = 0;
const ok = (label: string) => { passed += 1; console.log(`PASS ${label}`); };

type Ctx = { token?: string; operatorKey?: boolean };
const strictBase = `http://127.0.0.1:${STRICT_PORT}`;
const headers = (ctx: Ctx) => ({
  'Content-Type': 'application/json',
  ...(ctx.token ? { 'x-mindpond-context': ctx.token } : {}),
  ...(ctx.operatorKey ? { 'x-operator-key': OPERATOR_KEY } : {}),
});
const post = async (url: string, body: unknown, ctx: Ctx = {}) =>
  fetch(strictBase + url, { method: 'POST', headers: headers(ctx), body: JSON.stringify(body) });
const get = async (url: string, ctx: Ctx = {}) => fetch(strictBase + url, { headers: headers(ctx) });
const deny = async (label: string, res: Response) => {
  const body = await res.json() as any;
  assert.equal(res.status, 403, `${label}: expected 403, got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.code, 'scope_denied', `${label}: expected code scope_denied, got ${body.code}`);
  ok(label);
};
const markerCount = async (body: any, marker: string) =>
  (body.results as Array<{ content: string }>).filter(r => r.content.includes(marker)).length;

try {
  const strict = startServer(STRICT_PORT, { MEMORY_CONTEXT_SECRET: CONTEXT_SECRET, MEMORY_OPERATOR_KEY: OPERATOR_KEY, MEMORY_TEAM_AUTH_SECRET: TEAM_SECRET });
  const legacy = startServer(LEGACY_PORT, { MEMORY_TEAM_AUTH_SECRET: TEAM_SECRET });
  await Promise.all([strict.ready(), legacy.ready()]);

  // ---- seed through the operator capability (x-operator-key) ----
  const OP: Ctx = { operatorKey: true };
  const scope = { spaceId: 'verify/trust', memoryType: 'fact' };
  const grant = signTeamWriteGrant({ v: 1, authorizationId: 'auth-seed', teamId: 'team-1', requestId: 'req-seed', operations: ['save', 'membership', 'association'], issuedAt: Date.now(), expiresAt: Date.now() + 3600_000 }, TEAM_SECRET);
  const save = async (body: any, ctx: Ctx = OP) => {
    const res = await post('/api/memory/save', body, ctx);
    const receipt = await res.json() as any;
    assert.equal(res.status, 200, `seed save failed: ${JSON.stringify(receipt)}`);
    return receipt;
  };
  const personal = await save({ content: 'PERSONAL-MARKER the capital of Portugal is Lisbon', memberships: [scope] });
  const alpha = await save({ content: 'ALPHA-SESSION-MARKER quartz oscillator drift lesson', sessionId: 's-alpha', memberships: [scope] });
  const alphaRef = await save({ content: 'ALPHA-PRIVATE-MARKER team bridge source fact', sessionId: 's-alpha', memberships: [scope] });
  const beta = await save({ content: 'BETA-SESSION-MARKER topaz refinery decision', sessionId: 's-beta', memberships: [scope] });
  const team = await save({ content: 'TEAM-MARKER oncall rotation policy', domain: { kind: 'team', id: 'team-1' }, teamAuthorization: grant, memberships: [scope] });
  const alphaMemId = alphaRef.memberships[0].id as string;
  const teamMemId = team.memberships[0].id as string;

  const tok = (payload: any) => signContextToken(payload, CONTEXT_SECRET);
  const tokAlpha = tok({ principal: 'agent-a', sessionId: 's-alpha', domains: [{ kind: 'personal', id: 'default' }] });
  await deny('agent token cannot alter user dimension definitions',await post('/api/memory/dimensions',{expectedRevision:1,definitions:[]},{token:tokAlpha}));
  await deny('agent token cannot build model indexes',await post('/api/memory/retrieval/build',{profileId:'model-from-agent',maxItems:1},{token:tokAlpha}));
  await deny('agent token cannot activate model spaces',await post('/api/memory/retrieval/activate',{profileId:'legacy'},{token:tokAlpha}));
  assert.equal((await get('/api/memory/retrieval/profiles',{token:tokAlpha})).status,200);
  assert.equal((await post('/api/memory/retrieval/activate',{profileId:'legacy'},OP)).status,200);ok('operator model activation remains separate from agent discovery');
  const dimPolicy=await get('/api/memory/dimensions',{token:tokAlpha});assert.equal(dimPolicy.status,200);ok('agent can read dimension policy without configuration authority');
  const tokAlphaAgain = tok({ principal: 'agent-a-recovered', sessionId: 's-alpha', domains: [{ kind: 'personal', id: 'default' }] });
  const tokAlphaTeam = tok({ principal: 'agent-a', sessionId: 's-alpha', domains: [{ kind: 'personal', id: 'default' }, { kind: 'team', id: 'team-1' }] });
  const tokBeta = tok({ principal: 'agent-b', sessionId: 's-beta', domains: [{ kind: 'personal', id: 'default' }] });
  const tokTeam = tok({ principal: 'team-user', domains: [{ kind: 'team', id: 'team-1' }] });
  const tokOp = tok({ principal: 'workbench', operator: true });
  const ALPHA: Ctx = { token: tokAlpha };
  const logicalSave={content:'A durable checked environment observation, independent of source session.',domain:{kind:'personal',id:'default'},memberships:[{spaceId:'verify/shared-observation',memoryType:'fact'}],idempotencyKey:'cross-session-http'};
  const sharedA=await post('/api/memory/save',logicalSave,ALPHA);
  const sharedB=await post('/api/memory/save',logicalSave,{token:tokBeta});
  assert.equal(sharedA.status,200);assert.equal(sharedB.status,200);
  assert.equal(((await sharedA.json()) as any).id,((await sharedB.json()) as any).id);
  ok('same explicit personal save remains idempotent across trusted HTTP sessions');

  // Regression: direct association, membership and space endpoints cannot
  // address a foreign session even when the caller knows its issued IDs.
  const foreignScope = { spaceId: 'verify/foreign-only', memoryType: 'fact' };
  const foreignA = await save({ content: 'FOREIGN-ASSOC-MARKER A', sessionId: 's-beta', memberships: [foreignScope] });
  const foreignB = await save({ content: 'FOREIGN-ASSOC-MARKER B', sessionId: 's-beta', memberships: [foreignScope] });
  const foreignEdgeResponse = await post('/api/memory/association', {
    memberAId: foreignA.memberships[0].id, memberBId: foreignB.memberships[0].id,
    ...foreignScope, weight: 0.6, reason: 'operator fixture', context: 's-beta fixture',
  }, OP);
  assert.equal(foreignEdgeResponse.status, 200);
  const foreignEdge = (await foreignEdgeResponse.json() as any).association;
  const scopedSpaces = await (await get('/api/memory/spaces', ALPHA)).json() as any;
  assert(!JSON.stringify(scopedSpaces).includes(foreignScope.spaceId), 'foreign-only space must stay hidden');
  const scopedAssociations = await (await get('/api/memory/associations', ALPHA)).json() as any;
  assert(!JSON.stringify(scopedAssociations).includes('FOREIGN-ASSOC-MARKER'), 'foreign association content must stay hidden');
  const directForeign = await (await get('/api/memory/associations?memoryId=' + foreignA.id, ALPHA)).json() as any;
  assert.equal(directForeign.associations.length, 0, 'guessing a foreign memory ID must not reveal associations');
  const ownMembership = await post('/api/memory/membership',
    { memoryId: alpha.id, spaceId: 'verify/own-only', memoryType: 'fact' }, ALPHA);
  assert.equal(ownMembership.status, 200, 'the bound caller can still add an own-session membership');
  const ownEdge = await post('/api/memory/association',
    { memberAId: alpha.memberships[0].id, memberBId: alphaRef.memberships[0].id,
      ...scope, weight: 0.6, reason: 'own fixture', context: 's-alpha fixture' }, ALPHA);
  assert.equal(ownEdge.status, 200, 'the bound caller can still associate own-session memories');
  await deny('direct membership mutation of foreign node denied', await post('/api/memory/membership',
    { memoryId: foreignA.id, spaceId: 'verify/forged', memoryType: 'fact' }, ALPHA));
  await deny('direct association reweight of foreign nodes denied', await post('/api/memory/association',
    { memberAId: foreignA.memberships[0].id, memberBId: foreignB.memberships[0].id,
      ...foreignScope, weight: 0.9, reason: 'forged', context: 'foreign fixture' }, ALPHA));
  await deny('direct association review of foreign evidence denied', await post('/api/memory/association/review',
    { id: foreignEdge.id, evidenceId: foreignEdge.evidence[0].id, decision: 'retire', reason: 'forged' }, ALPHA));
  await deny('direct association deletion of foreign edge denied', await post('/api/memory/association/delete',
    { id: foreignEdge.id, reason: 'forged' }, ALPHA));
  assert.equal((await (await get('/api/memory/associations', OP)).json() as any).associations
    .filter((a: any) => a.id === foreignEdge.id).length, 1, 'denied mutations must not change the foreign association');
  ok('HTTP direct spaces and associations stay inside the caller scope');

  const mcpClient = new Client({ name: 'verify-bound-mcp', version: '1' });
  await mcpClient.connect(new StdioClientTransport({ command: process.execPath,
    args: [path.join(path.dirname(distServer), 'mcp.js')],
    env: { ...process.env, MEMORY_DB_PATH: path.join(dir, `pond-${STRICT_PORT}.db`),
      MEMORY_TRUST_PRINCIPAL: 'verify/mcp', MEMORY_TRUST_DOMAINS: JSON.stringify([{ kind: 'personal', id: 'default' }]),
      MEMORY_TRUST_SESSION: '', MEMORY_TRUST_OPERATOR: '0', EMBEDDING_ZH_ENABLED: 'false' } as Record<string, string>, stderr: 'pipe' }));
  try {
    const mcpCall = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await mcpClient.callTool({ name, arguments: args });
      return { result, body: JSON.parse((result.content as any[])[0].text) };
    };
    const spaces = await mcpCall('memory_spaces');
    assert(!JSON.stringify(spaces.body).includes(foreignScope.spaceId), 'MCP foreign-only space must stay hidden');
    for (const [name, args] of [
      ['memory_membership_add', { memoryId: foreignA.id, spaceId: 'verify/forged-mcp', memoryType: 'fact' }],
      ['memory_association_upsert', { memberAId: foreignA.memberships[0].id, memberBId: foreignB.memberships[0].id,
        ...foreignScope, weight: 0.9, reason: 'forged', context: 'foreign fixture' }],
      ['memory_association_review', { id: foreignEdge.id, evidenceId: foreignEdge.evidence[0].id,
        decision: 'retire', reason: 'forged' }],
      ['memory_dedupe_scan', {}],
      ['memory_dedupe_resolve', { keepId: personal.id, deleteIds: [foreignA.id] }],
    ] as const) {
      const response = await mcpCall(name, args);
      assert.equal(response.result.isError, true, `${name} must reject a personal-only caller`);
      assert.equal(response.body.error?.code, 'scope_denied', `${name} must report scope_denied`);
    }
    ok('MCP bound client cannot discover or mutate foreign-session memory');
  } finally { await mcpClient.close(); }

  const search = async (query: string, ctx: Ctx, extra: any = {}) => {
    const res = await post('/api/memory/search', { query, limit: 20, ...extra }, ctx);
    const body = await res.json() as any;
    assert.equal(res.status, 200, `search '${query}' failed: ${JSON.stringify(body)}`);
    return body;
  };

  // Strict context authentication fails closed; compatibility is opt-in.
  await deny('T10 anonymous search denied',await post('/api/memory/search',{query:'PERSONAL-MARKER'}));
  await deny('T10 anonymous save denied',await post('/api/memory/save',{content:'Unauthenticated write must fail'}));
  await deny('T10 anonymous list of s-alpha denied', await get('/api/memory/list?sessionId=s-alpha'));
  await deny('T10 anonymous node get denied', await get(`/api/memory/node/${alpha.id}`));
  await deny('T10 anonymous expand denied', await post('/api/memory/expand', { nodeId: alpha.id }));
  await deny('T10 anonymous actionlog denied', await get('/api/memory/actionlog'));
  await deny('T10 anonymous graph denied', await get('/api/memory/graph'));
  await deny('T10 anonymous dedupe denied', await post('/api/memory/dedupe/scan', {}));
  await deny('T10 anonymous maintenance denied', await post('/api/maintenance/run', {}));
  await deny('T10 anonymous extraction denied',await get('/api/extract/job'));

  // ---- T10.b agent bound to s-alpha: own session + personal, nothing else ----
  assert.equal(await markerCount(await search('ALPHA-SESSION-MARKER', ALPHA), 'ALPHA-SESSION-MARKER'), 1);
  assert.equal(await markerCount(await search('PERSONAL-MARKER', ALPHA), 'PERSONAL-MARKER'), 1);
  assert.equal(await markerCount(await search('BETA-SESSION-MARKER', ALPHA), 'BETA-SESSION-MARKER'), 0, 'bound agent must not read s-beta');
  assert.equal(await markerCount(await search('TEAM-MARKER', ALPHA), 'TEAM-MARKER'), 0, 'bound agent without team domain must not read team');
  ok('T10 session-bound agent reads exactly own session + granted domains');
  const listOwn = await (await get('/api/memory/list?sessionId=s-alpha', ALPHA)).json() as any;
  assert(listOwn.nodes.some((n: any) => n.id === alpha.id), 'own session list works');
  await deny('T10 list of another session denied', await get('/api/memory/list?sessionId=s-beta', ALPHA));
  await deny('T10 node get of another session denied', await get(`/api/memory/node/${beta.id}`, ALPHA));
  await deny('T10 expand of another session denied', await post('/api/memory/expand', { nodeId: beta.id }, ALPHA));
  await deny('T10 connections of another session denied', await get(`/api/memory/node/${beta.id}/connections`, ALPHA));
  await deny('T10 update of another session denied', await post('/api/memory/update', { nodeId: beta.id, content: 'hacked' }, ALPHA));
  await deny('T10 delete of another session denied', await post('/api/memory/delete', { nodeId: beta.id }, ALPHA));
  await deny('T10 save into another session denied', await post('/api/memory/save', { content: 'smuggled write', sessionId: 's-beta', memberships: [scope] }, ALPHA));

  // Lifecycle capture inherits the launch/request binding even when the model omits sessionId.
  const captureArgs={kind:'before_compact',hostId:'host',runId:'review',checkpointId:'before-compact',...scope,
    observations:[{id:'finding-1',content:'Reviewed local module only; production behavior is unverified.'}]};
  await deny('T10 lifecycle cannot target a foreign session',await post('/api/host/lifecycle/prepare',{...captureArgs,sessionId:'s-beta'},ALPHA));
  const capturedRes=await post('/api/host/lifecycle/prepare',captureArgs,ALPHA);
  assert.equal(capturedRes.status,200);const captured=await capturedRes.json() as any;
  assert.equal(captured.sessionId,'s-alpha');
  assert.equal((await (await get('/api/extract/job',{token:tokBeta})).json() as any).job,null,'foreign claim sees no job');
  await deny('T10 anonymous claim cannot access session evidence',await get('/api/extract/job'));
  const extraction=(await (await get('/api/extract/job',ALPHA)).json() as any).job;
  assert.equal(extraction.id,captured.extractionJobId);
  await deny('T10 extraction commit cannot address a foreign job',await post('/api/extract/commit',{jobId:extraction.id,reply:'{"memories":[]}',expectedAttempt:extraction.attempts},{token:tokBeta}));
  const extractionReply=JSON.stringify({memories:[{content:captureArgs.observations[0].content,type:'fact',priority:5,dimensions:['fact'],source_message_ids:['msg-0'],source_observation_ids:['finding-1']}]});
  assert.equal((await post('/api/extract/commit',{jobId:extraction.id,reply:extractionReply,expectedAttempt:extraction.attempts},ALPHA)).status,200);
  await deny('T10 completed extraction receipt stays scoped',await post('/api/extract/commit',{jobId:extraction.id,reply:extractionReply,expectedAttempt:extraction.attempts},{token:tokBeta}));
  ok('T10 HTTP lifecycle capture and extraction use trusted current session without parameter claims');

  // ---- T10.c operator scope cannot be claimed by a model parameter ----
  await deny('T10 scope=operator param denied for agent token', await post('/api/memory/expand', { nodeId: personal.id, scope: 'operator' }, ALPHA));
  await deny('T10 list operatorAll denied for agent token', await get('/api/memory/list?scope=operator', ALPHA));
  await deny('T10 actionlog denied for agent token', await get('/api/memory/actionlog', ALPHA));
  await deny('T10 operator param denied on host operations', await post('/api/memory/trace', { nodeId: personal.id, scope: 'operator' }, ALPHA));
  ok('T10 operator capability stays isolated from agent tools');

  // ---- T10.d parameters may narrow but never widen ----
  const narrowed = await search('ALPHA-SESSION-MARKER', ALPHA, { domains: [{ kind: 'personal', id: 'default' }] });
  assert.equal(await markerCount(narrowed, 'ALPHA-SESSION-MARKER'), 0, 'narrowing away own session hides it');
  assert.equal(await markerCount(await search('PERSONAL-MARKER', ALPHA, { domains: [{ kind: 'personal', id: 'default' }] }), 'PERSONAL-MARKER'), 1);
  const sessionOnly = await search('ALPHA-SESSION-MARKER', ALPHA, { domains: [{ kind: 'session', id: 's-alpha' }] });
  assert.equal(await markerCount(sessionOnly, 'ALPHA-SESSION-MARKER'), 1);
  assert.equal(await markerCount(sessionOnly, 'PERSONAL-MARKER'), 0, 'narrowed domains exclude personal');
  ok('T10 request parameters narrow the trusted context');
  await deny('T10 forged session domain in domains denied', await post('/api/memory/search', { query: 'x', domains: [{ kind: 'session', id: 's-beta' }] }, ALPHA));
  await deny('T10 forged team domain in domains denied', await post('/api/memory/search', { query: 'x', domains: [{ kind: 'team', id: 'team-1' }] }, ALPHA));
  const noSession = { token: tok({ principal: 'agent-a-narrow', domains: [{ kind: 'personal', id: 'default' }] }) };
  assert.equal(await markerCount(await search('ALPHA-SESSION-MARKER', noSession), 'ALPHA-SESSION-MARKER'), 0, 'token without session reads no session');
  await deny('T10 sessionless token cannot claim a session by parameter', await post('/api/memory/save', { content: 'smuggled', sessionId: 's-alpha', memberships: [scope] }, noSession));
  ok('T10 tokens without a session binding never gain one through parameters');

  const NONE: Ctx = {token:tok({principal:'no-grants',domains:[]})};
  await deny('T10 empty trusted grants cannot fall back to personal search',await post('/api/memory/search',{query:'PERSONAL-MARKER'},NONE));
  await deny('T10 empty trusted grants cannot claim personal extraction',await get('/api/extract/job',NONE));
  await deny('T10 empty trusted grants cannot list personal collaboration',await post('/api/work/context/list',{},NONE));

  // ---- T10.e token integrity ----
  await deny('T10 expired token rejected', await post('/api/memory/search', { query: 'PERSONAL-MARKER' }, { token: tok({ principal: 'agent-x', sessionId: 's-alpha', expiresAt: Date.now() - 1000 }) }));
  await deny('T10 tampered token rejected', await post('/api/memory/search', { query: 'PERSONAL-MARKER' }, { token: tokAlpha.slice(0, -4) + (tokAlpha.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA') }));
  await deny('T10 garbage token rejected', await post('/api/memory/search', { query: 'PERSONAL-MARKER' }, { token: 'garbage.token' }));
  ok('T10 expired/tampered/garbage context tokens are rejected with 403');

  // ---- T10.f cross-agent recovery on the same lawful session ----
  const recovered: Ctx = { token: tokAlphaAgain };
  assert.equal(await markerCount(await search('ALPHA-SESSION-MARKER', recovered), 'ALPHA-SESSION-MARKER'), 1);
  const listRecovered = await (await get('/api/memory/list?sessionId=s-alpha', recovered)).json() as any;
  assert(listRecovered.nodes.some((n: any) => n.id === alpha.id), 'recovered agent lists the same session');
  ok('T10 a different principal re-bound to the same lawful session keeps working');

  // ---- T10.g operator capability via signed token or x-operator-key ----
  assert.equal((await get('/api/memory/actionlog', { token: tokOp })).status, 200);
  assert.equal((await get('/api/memory/graph', { token: tokOp })).status, 200);
  assert.equal((await get('/api/memory/list?scope=operator', { token: tokOp })).status, 200);
  assert.equal((await post('/api/memory/expand', { nodeId: beta.id, scope: 'operator' }, { token: tokOp })).status, 200);
  assert.equal((await get('/api/extract/job', { token: tokOp })).status, 200);
  assert.equal((await get('/api/memory/actionlog', { operatorKey: true })).status, 200);
  assert.equal((await post('/api/memory/expand', { nodeId: beta.id, scope: 'operator' }, { operatorKey: true })).status, 200);
  ok('T10 operator reaches audit log, global graph, listAll and pipeline via token or x-operator-key');

  // ---- T10.h feedback cannot be forged against another run identity ----
  const recall = await search('ALPHA-SESSION-MARKER', ALPHA, { runId: 'run-1', hostId: 'host-1' });
  const forged = await post('/api/memory/recall-feedback', { recallId: recall.recallId, runId: 'run-2', hostId: 'host-1', decisions: [{ memoryId: alpha.id, disposition: 'used' }] }, ALPHA);
  const forgedBody = await forged.json() as any;
  assert(forged.status >= 400 && /Recall run identity mismatch/i.test(forgedBody.error ?? ''), `feedback forgery must be rejected: ${JSON.stringify(forgedBody)}`);
  ok('T10 recall feedback stays bound to its run identity');

  // ---- T11 team isolation ----
  await deny('T11 agent token cannot target a team domain at all', await post('/api/memory/save', { content: 'rogue team write', domain: { kind: 'team', id: 'team-1' }, memberships: [scope] }, ALPHA));
  const noGrant = await post('/api/memory/save', { content: 'rogue team write', domain: { kind: 'team', id: 'team-1' }, memberships: [scope] }, OP);
  const noGrantBody = await noGrant.json() as any;
  assert(noGrant.status === 403 && /team_write_unauthorized/.test(noGrantBody.error ?? ''), `team write without grant must be denied: ${JSON.stringify(noGrantBody)}`);
  ok('T11 team writes need both a trusted team domain and a host-signed grant');

  const refRes = await post('/api/memory/team-reference', {
    sourceMemberId: alphaMemId, targetMemberId: teamMemId,
    reason: 'REF-REASON-QX7 unique private bridge rationale', context: 'verify trust isolation', weight: 0.5,
    sessionId: 's-alpha',
    domains: [{ kind: 'session', id: 's-alpha' }, { kind: 'personal', id: 'default' }, { kind: 'team', id: 'team-1' }],
  }, { token: tokAlphaTeam });
  assert.equal(refRes.status, 200, `team reference failed: ${JSON.stringify(await refRes.json())}`);
  ok('T11 private→team one-way reference created from an explicitly granted context');

  const teamSearch = async (query: string) => search(query, { token: tokTeam });
  assert.equal(await markerCount(await teamSearch('TEAM-MARKER'), 'TEAM-MARKER'), 1);
  assert.equal(await markerCount(await teamSearch('ALPHA-PRIVATE-MARKER'), 'ALPHA-PRIVATE-MARKER'), 0, 'team must not see private content through the reference');
  assert.equal(await markerCount(await teamSearch('ALPHA-SESSION-MARKER'), 'ALPHA-SESSION-MARKER'), 0);
  assert.equal(await markerCount(await teamSearch('REF-REASON-QX7'), 'REF-REASON-QX7'), 0, 'reference reason must not leak backwards');
  await deny('T11 team-side node get of the private source denied', await get(`/api/memory/node/${alphaRef.id}`, { token: tokTeam }));
  const teamConns = await (await get(`/api/memory/node/${team.id}/connections?domains=${encodeURIComponent(JSON.stringify([{ kind: 'team', id: 'team-1' }]))}`, { token: tokTeam })).json() as any;
  assert(!JSON.stringify(teamConns).includes(alphaRef.id), 'team connections must not include the private source');
  ok('T11 team side sees no private content, relation or rationale (one-way)');
  assert.equal(await markerCount(await search('TEAM-MARKER', ALPHA), 'TEAM-MARKER'), 0, 'agent without team domain cannot read team');
  assert.equal(await markerCount(await search('TEAM-MARKER', { token: tokAlphaTeam }), 'TEAM-MARKER'), 1);
  assert.equal(await markerCount(await search('TEAM-MARKER', { token: tokBeta }), 'TEAM-MARKER'), 0);
  ok('T11 team knowledge is readable only through an explicitly granted team domain');

  // New request/job IDs must not bypass the trusted context established in R03.
  const org = await post('/api/organization/request', { ...scope, domain: { kind: 'session', id: 's-alpha' }, batchSize: 1 }, ALPHA);
  assert.equal(org.status, 200, org.status !== 200 ? await org.clone().text() : '');
  const orgId = (await org.json() as any).requestId;
  const ownRequests = await post('/api/host/organization/requests', {}, ALPHA);
  assert.equal(ownRequests.status, 200);
  assert.ok(JSON.stringify(await ownRequests.json()).includes(orgId), 'omitted filters use the caller binding');
  const otherRequests = await post('/api/host/organization/requests', {}, { token: tokBeta });
  assert.equal(otherRequests.status, 200);
  assert.ok(!JSON.stringify(await otherRequests.json()).includes(orgId), 'request index cannot leak another session');
  await deny('request index cannot widen its domains', await post('/api/host/organization/requests', { domains: [{ kind:'session', id:'s-alpha' }] }, { token:tokBeta }));
  await deny('request index cannot self-assign operator', await post('/api/host/organization/requests', { scope:'operator' }, ALPHA));
  ok('request index inherits trusted session and domains');
  const editable=await (await post('/api/memory/save',{content:'Private edit history evidence.',sessionId:'s-alpha',memberships:[scope]},ALPHA)).json() as any;
  const prior=await (await get('/api/memory/node/'+editable.id,ALPHA)).json() as any;
  const edited=await post('/api/memory/update',{nodeId:editable.id,content:'Updated private edit history evidence.',expectedUpdatedAt:prior.node.updatedAt},ALPHA);
  assert.equal(edited.status,200);const editReceipt=await edited.json() as any;
  const ownHistory=await post('/api/memory/edit/history',{nodeId:editable.id},ALPHA);assert.equal(ownHistory.status,200);assert.equal((await ownHistory.json() as any[]).length,1);
  await deny('edit history cannot expose another session snapshots',await post('/api/memory/edit/history',{nodeId:editable.id},{token:tokBeta}));
  const current=await (await get('/api/memory/node/'+editable.id,ALPHA)).json() as any;
  const restoreArgs={nodeId:editable.id,revisionId:editReceipt.revisionId,expectedUpdatedAt:current.node.updatedAt,reason:'correct mistaken edit'};
  await deny('edit restore cannot use a foreign revision id',await post('/api/memory/edit/restore',restoreArgs,{token:tokBeta}));
  assert.equal((await post('/api/memory/edit/restore',restoreArgs,ALPHA)).status,200);
  assert.equal((await (await get('/api/memory/node/'+editable.id,ALPHA)).json() as any).node.content,'Private edit history evidence.');
  ok('HTTP edit history and restore use the caller binding and immutable revision');
  await deny('request ID cannot reveal another session status', await get(`/api/organization/request/${orgId}`, { token: tokBeta }));
  await deny('request events preserve persisted ownership', await get(`/api/organization/request/${orgId}/events`, { token: tokBeta }));
  await deny('shared request next cannot bypass REST scope guard', await post('/api/host/organization/request/next', { requestId: orgId }, { token: tokBeta }));
  await deny('foreign request cancellation denied', await post(`/api/organization/request/${orgId}/cancel`, { reason: 'foreign cancellation' }, { token: tokBeta }));
  const ownBatch = await post(`/api/organization/request/${orgId}/next`, {}, ALPHA);
  assert.equal(ownBatch.status, 200);
  const ownJob = (await ownBatch.json() as any).job;
  assert.ok(ownJob);
  await deny('foreign direct job validation denied', await post('/api/organization/validate', { jobId: ownJob.id, plan: { operations: [] } }, { token: tokBeta }));
  await deny('foreign direct job commit denied', await post('/api/organization/commit', { jobId: ownJob.id, plan: { operations: [] } }, { token: tokBeta }));
  await deny('omitted save domain cannot fall back to an ungranted personal domain', await post('/api/memory/save', { content: 'implicit personal write' }, { token: tokTeam }));
  await deny('save preview uses the same effective-domain guard', await post('/api/memory/save/validate', { content: 'implicit personal write' }, { token: tokTeam }));

  // ---- legacy mode (no MEMORY_CONTEXT_SECRET): sample-agent keeps working ----
  const legacyBase = `http://127.0.0.1:${LEGACY_PORT}`;
  const lpost = async (url: string, body: unknown) => fetch(legacyBase + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const lget = async (url: string) => fetch(legacyBase + url);
  const legacySave = await lpost('/api/memory/save', { content: 'LEGACY-MARKER parameter-supplied context still works', sessionId: 's-legacy', memberships: [scope] });
  assert.equal(legacySave.status, 200, 'legacy save without any token must work');
  const legacyNode = (await legacySave.json() as any).id;
  const legacySearch = await lpost('/api/memory/search', { query: 'LEGACY-MARKER', sessionId: 's-legacy' });
  assert.equal((await legacySearch.json() as any).results.length >= 1, true, 'legacy search with parameter session works');
  assert.equal((await lget('/api/memory/actionlog')).status, 200, 'legacy actionlog stays open');
  assert.equal((await lget('/api/memory/list?scope=operator')).status, 200, 'legacy scope=operator stays open');
  assert.equal((await lpost('/api/memory/expand', { nodeId: legacyNode })).status, 400, 'legacy bounded entries still require a parameter context');
  ok('legacy mode (no secret) keeps the pre-R03 parameter-supplied behavior for sample-agent');

  strict.child.kill('SIGTERM');
  legacy.child.kill('SIGTERM');
  console.log(`\nverify:trusted-context PASS (${passed} sections)`);

} catch (err) {
  console.error('verify:trusted-context FAIL', err);
  process.exitCode=1;
}

finally {
  for(const child of fixtureChildren){if(child.exitCode!==null)continue;child.kill('SIGTERM');await new Promise<void>(r=>{child.once('exit',()=>r());setTimeout(()=>{child.kill('SIGKILL');r();},5000).unref();});}
}
