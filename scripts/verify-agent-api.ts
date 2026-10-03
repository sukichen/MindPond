/** Real HTTP + MCP parity test with a disposable pond. Requires npm run build. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-api-check-'));
const env = { ...process.env, MEMORY_DB_PATH: path.join(dir, 'pond.db'), MEMORY_PORT: '0',
  MEMORY_HOST: '127.0.0.1', MEMORY_API_KEY: 'workbench-test-key', EMBEDDING_ZH_ENABLED: 'false' };
const http = spawn(process.execPath, ['dist/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; http.stderr.on('data', () => {});
const client = new Client({ name: 'api-parity-test', version: '1' });
try {
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP startup timeout: ' + output)), 20_000);
    http.stdout.on('data', data => { output += data; const match = output.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); } });
    http.on('exit', code => { clearTimeout(timer); reject(new Error('Server exited: ' + code)); });
  });
  const base = 'http://127.0.0.1:' + port;
  const api = async (url: string, body?: unknown) => {
    const r = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.MEMORY_API_KEY }, body: body === undefined ? undefined : JSON.stringify(body) });
    const d = await r.json() as any; assert(r.ok, JSON.stringify(d)); return d;
  };
  assert.equal((await fetch(base + '/api/memory/spaces')).status, 401);
  assert((await fetch(base).then(r => r.text())).includes('记忆工作台'));
  assert.equal((await fetch(base + '/assets/app.js')).status, 200);
  const notices=await fetch(base+'/licenses/third-party.txt');
  assert.equal(notices.status,200);
  assert.match(notices.headers.get('content-type')??'',/text\/plain/);
  const licenseText=await notices.text();
  assert.match(licenseText,/vis-network@/);
  assert.match(licenseText,/Permission is hereby granted, free of charge/);
  const a = await api('/api/memory/save', { content: '本地调试服务使用 7903 端口。', memberships: [{ spaceId: 'P', memoryType: 'config' }] });
  const b = await api('/api/memory/save', { content: '本地服务仅绑定 127.0.0.1，远程访问须经代理。', memberships: [{ spaceId: 'P', memoryType: 'config' }] });
  await api('/api/memory/association', { memberAId: a.memberships[0].id, memberBId: b.memberships[0].id, spaceId: 'P', memoryType: 'config', weight: .9, reason: '端口与代理目标需一起核对', context: '项目 P 本地调试，不包含生产环境' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/mcp.js'], env, stderr: 'pipe' }));
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result: any = await client.callTool({ name, arguments: args });
    assert(!result.isError, JSON.stringify(result)); return JSON.parse(result.content[0].text);
  };
  const hp=await api('/api/memory/retrieval/profiles'),mp=await tool('memory_retrieval_profiles',{});const {ok:_httpEnvelope,...portableProfiles}=hp;assert.deepEqual(mp,portableProfiles);
  const profiled=await tool('memory_search',{query:'7903',retrievalProfile:'legacy',vectorAlgorithm:'hnsw',spaceId:'P'});assert.equal(profiled.retrieval.profile.selected,'legacy');assert(profiled.retrieval.profile.algorithm.actual==='hnsw'||profiled.retrieval.profile.algorithm.actual==='exact');
  const request = { query: '7903', spaceId: 'P', memoryType: 'config', maxDepth: 2, minScore: .3, limit: 10 };
  const httpPolicy = await api('/api/memory/save-policy'), mcpPolicy = await tool('memory_save_policy', {});
  assert.deepEqual(mcpPolicy.policy, httpPolicy.policy);
  assert.equal(httpPolicy.policy.version, 'memory-save.v3.1');
  const catalog = await client.listTools();
  assert(!catalog.tools.some(t=>t.name==='memory_retrieval_build'||t.name==='memory_retrieval_activate'));
  assert.ok(catalog.tools.find(t => t.name === 'memory_save')!.description.includes('memory_dimension_policy'));
  assert.ok(httpPolicy.policy.dimensionPolicy.definitions.some((d:any)=>d.id==='skill'));
  const web = await api('/api/memory/search', request), mcp = await tool('memory_search', request);
  assert(typeof web.recallId === 'string' && typeof mcp.recallId === 'string');
  assert.deepEqual(mcp.results.map((h: any) => [h.id, h.depth, h.path, h.membershipPath]), web.results.map((h: any) => [h.id, h.depth, h.path, h.membershipPath]));
  assert(mcp.results.every((h: any, i: number) => Math.abs(h.score - web.results[i].score) < 1e-5));
  assert.deepEqual(mcp.results.map((h: any) => h.associationPath), web.results.map((h: any) => h.associationPath));
  assert(web.results.some((h: any) => h.id === b.id && h.depth === 1));
  const broken = await client.callTool({ name: 'memory_save', arguments: { content: '不应落库', related: [{ memoryId: a.id, score: .9 }] } });
  assert(broken.isError);
  const saved = await tool('memory_save', { content: '配置完成后验证代理健康检查。', memberships: [{ spaceId: 'P', memoryType: 'config' }],
    related: [{ membershipId: b.memberships[0].id, score: .7, reason: '代理访问条件影响健康检查', context: '项目 P 本地服务经代理访问的验证阶段' }] });
  // M02.b: bounded entries carry an explicit read context; these fixtures are personal-domain.
  const PD = [{ kind: 'personal' as const, id: 'default' }];
  const pdParam = 'domains=' + encodeURIComponent(JSON.stringify(PD));
  const savedDetail = await api('/api/memory/node/' + saved.id + '?' + pdParam);
  assert.equal(savedDetail.associations[0].evidence[0].context, '项目 P 本地服务经代理访问的验证阶段');
  const rejected = await fetch(base + '/api/memory/save', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': env.MEMORY_API_KEY },
    body: JSON.stringify({ content: 'HTTP 缺少理由也不得落库', related: [{ memoryId: a.id, score: .9 }] }) });
  assert.equal(rejected.status, 400);
  const task = await tool('memory_organization_claim', { spaceId: 'P', memoryType: 'config', membershipIds: [a.memberships[0].id, b.memberships[0].id] });
  assert(task.prompt.includes('membership.id')); assert.equal(task.policy.version, 'organization.v2');
  const plan = { operations: [{ kind: 'consolidate', membershipIds: task.job.members.map((m: any) => m.membership.id),
    content: '本地调试服务使用 7903 端口，仅绑定 127.0.0.1；远程访问须经代理。', reason: '保留端口、绑定地址与代理条件。' }] };
  const preview = await tool('memory_organization_validate', { jobId: task.job.id, plan }); assert(preview.valid);
  const committed = await api('/api/organization/commit', { jobId: task.job.id, plan });
  const retry = await tool('memory_organization_commit', { jobId: task.job.id, plan }); assert.deepEqual(retry.createdMemoryIds, committed.createdMemoryIds);
  const records = await api('/api/memory/list?activeOnly=true&spaceId=P&memoryType=config&' + pdParam); assert.equal(records.total, 2);
  const logs = await api('/api/memory/actionlog?action=organization_consolidate'); assert.equal(logs.log.length, 1);
  const caps=await tool('memory_capabilities',{});assert(caps.features.includes('non-destructive-profiles'));
  const {mcpConnection,...portableCaps}=caps;
  assert.equal(mcpConnection.toolProfile,'full');
  assert(mcpConnection.availableTools.includes('memory_save_policy'));
  assert.deepEqual(portableCaps,await api('/api/host/capabilities'));
  const placement={spaceId:'sample-project/api-test',memoryType:'knowledge'};
  const reference={uri:'repo:sample-project/api-test.ts',context:'main',revision:'r1',fingerprint:'test-r1'};
  const input={content:'API source behavior with explicit constraints and evidence.',memberships:[placement],sourceRefs:[reference],idempotencyKey:'api-source-1'};
  const ga=await tool('memory_save',input),gaRetry=await api('/api/memory/save',input);assert.equal(ga.id,gaRetry.id);
  const gb=await api('/api/memory/save',{...input,content:'A complementary persistence invariant used in the same workflow.',idempotencyKey:'api-source-2'});
  await tool('memory_source_observe',{...reference,status:'present',expectedVersion:0});
  assert.equal((await api('/api/memory/source/get',{uri:reference.uri,context:reference.context})).version,1);
  const gj=await tool('memory_organization_claim',{...placement,membershipIds:[ga.memberships[0].id,gb.memberships[0].id]});
  const gp={operations:[{kind:'synthesize',membershipIds:[ga.memberships[0].id,gb.memberships[0].id],content:'A scoped workflow portrait retaining independent source constraints.',reason:'Combines complementary evidence.',profile:{title:'API workflow portrait',coverage:['Two reviewed behaviors'],unknowns:['Other modules']},supports:[ga,gb].map(m=>({membershipId:m.memberships[0].id,claim:'Supports the stated workflow',context:'Reviewed main r1 only'}))}]};
  await tool('memory_organization_validate',{jobId:gj.job.id,plan:gp});
  const gr=await api('/api/organization/commit',{jobId:gj.job.id,plan:gp});
  const gd=await tool('memory_get',{nodeId:gr.createdMemoryIds[0],domains:PD}),profileId=gd.profiles[0].membershipId;
  assert.deepEqual(await tool('memory_profile_get',{membershipId:profileId,domains:PD}),await api('/api/memory/profile/get',{membershipId:profileId,domains:PD}));
  const gs={query:'workflow',...placement};
  const gh=await api('/api/memory/search',gs),gm=await tool('memory_search',gs);
  assert(typeof gh.recallId==='string'&&typeof gm.recallId==='string');
  assert.deepEqual(gm.results.map((r:any)=>[r.id,r.profiles,r.freshness]),gh.results.map((r:any)=>[r.id,r.profiles,r.freshness]));
  const checkpoint={hostId:'parity',runId:'run',checkpointId:'end',...placement,outcome:'saved',reason:'Sources saved',memoryIds:[ga.id,gb.id]};
  const cr=await tool('memory_checkpoint',checkpoint);assert.equal(cr.workId,(await api('/api/host/checkpoint',checkpoint)).workId);
  const hw=await api('/api/host/work/claim',placement);assert(hw.leaseToken);
  await tool('memory_work_renew',{workId:hw.id,leaseToken:hw.leaseToken});
  await tool('memory_work_finish',{workId:hw.id,leaseToken:hw.leaseToken,outcome:'completed',organizationJobId:gj.job.id,reason:'Profile committed'});
  assert.equal((await api('/api/host/work/list',placement))[0].status,'completed');
  const raw={transcript:'Raw fixture observation',sessionId:'test-raw',idempotencyKey:'raw-parity'};
  const rawMcp=await tool('memory_ingest',raw),rawHttp=await api('/api/memory/ingest',raw);assert.equal(rawMcp.l0Id,rawHttp.l0Id);assert.equal(rawMcp.extractionJobId,rawHttp.extractionJobId);
  const extraction=await api('/api/extract/job');
  const extractionRequest={jobId:extraction.job.id,expectedAttempt:extraction.job.attempts,reply:JSON.stringify({memories:[{content:'A rich raw fixture observation with its stated conditions.',type:'fact',priority:5,source_message_ids:['msg-0']}]})};
  const extracted=await tool('memory_extraction_commit',extractionRequest);
  const extractedRetry=await api('/api/extract/commit',extractionRequest);assert.equal(extractedRetry.atomsCreated,extracted.atomsCreated);
  const sourceEdit=await api('/api/memory/node/'+ga.id+'?'+pdParam);
  await tool('memory_update',{nodeId:ga.id,domains:PD,sourceRefs:[{...reference,revision:'r2',fingerprint:'test-r2'}],expectedUpdatedAt:sourceEdit.node.updatedAt});
  assert.equal((await api('/api/memory/profile/get',{membershipId:profileId,domains:PD})).freshness.status,'needs_review');
  assert((await api('/api/memory/actionlog?action=profile_needs_review')).log.length>0);
  const multi=await tool('memory_save',{content:'保存补丁后恢复已验证版本，数据库迁移须人工确认。',sessionId:'bridge-api',dimensions:['lesson','skill'],anchors:[{text:'恢复失败怎么办',basis:'数据库迁移须人工确认',spaceId:'session:bridge-api',memoryType:'skill'}]});
  const multiRequest={query:'恢复失败怎么办',sessionId:'bridge-api',spaceId:'session:bridge-api',memoryType:'skill',maxDepth:0,minScore:0};
  const mh=await api('/api/memory/search',multiRequest),mm=await tool('memory_search',multiRequest);
  assert.deepEqual(mh.results.map((r:any)=>[r.id,r.dimensions,r.matchedAnchors]),mm.results.map((r:any)=>[r.id,r.dimensions,r.matchedAnchors]));
  assert(mh.results.some((r:any)=>r.id===multi.id && r.matchedAnchors?.length));
  const detail=await api('/api/memory/node/'+multi.id+'?sessionId=bridge-api');
  assert.deepEqual(detail.node.dimensions,['lesson','skill']);assert.equal(detail.node.anchors.length,1);
  const single=await tool('memory_organization_claim',{spaceId:'session:bridge-api',memoryType:'skill',domain:{kind:'session',id:'bridge-api'},membershipIds:[multi.memberships.find((m:any)=>m.memoryType==='skill').id]});
  const anchorPlan={operations:[{kind:'reanchor',membershipIds:[single.job.members[0].membership.id],anchors:[],reason:'Explicit review removes an unnecessary entry.'}]};
  await api('/api/organization/commit',{jobId:single.job.id,plan:anchorPlan});
  for(const [name,url] of [['memory_trace','/api/memory/trace'],['memory_neighborhood','/api/memory/neighborhood']]) {
    const req={nodeId:multi.id,sessionId:'bridge-api'};
    assert.deepEqual(await api(url,req),await tool(name,req));
  }
  const migration=await tool('memory_save',{content:'A complete legacy placement migration fixture.',domains:PD,dimensions:['fact'],memberships:[{spaceId:'taxonomy:original',memoryType:'legacy-topic'},{spaceId:'taxonomy:custom',memoryType:'code-arch'}]});
  const migrationBefore=await tool('memory_get',{nodeId:migration.id,domains:PD});
  const legacyPlacement=migrationBefore.memberships.find((m:any)=>m.active&&m.memoryType==='legacy-topic');
  const migrationEdit=await tool('memory_update',{nodeId:migration.id,domains:PD,dimensions:['lesson'],replaceMembershipIds:[legacyPlacement.id],expectedUpdatedAt:migrationBefore.updatedAt,expectedContent:migrationBefore.content,reason:'Explicit legacy classification migration through MCP.'});
  const migrated=await tool('memory_get',{nodeId:migration.id,domains:PD});
  assert(migrated.memberships.some((m:any)=>m.active&&m.spaceId==='taxonomy:original'&&m.memoryType==='lesson'));
  assert(migrated.memberships.some((m:any)=>m.active&&m.spaceId==='taxonomy:custom'&&m.memoryType==='code-arch'));
  assert(!migrated.memberships.some((m:any)=>m.active&&m.id===legacyPlacement.id));
  await tool('memory_edit_restore',{nodeId:migration.id,domains:PD,revisionId:migrationEdit.revisionId,expectedUpdatedAt:migrated.updatedAt,reason:'Restore the unchanged classification migration.'});
  const migrationRestored=await tool('memory_get',{nodeId:migration.id,domains:PD});
  assert(migrationRestored.memberships.some((m:any)=>m.active&&m.id===legacyPlacement.id));
  assert.deepEqual(migrationRestored.dimensions,['fact']);
  console.log('PASS MCP explicit scoped classification migration, custom placement preservation and revision restore');
  console.log('PASS HTTP/MCP multi-identity, anchor recall, scoped reanchor and evidence endpoints');
  console.log('PASS real HTTP/MCP growth, source, profile, checkpoint, lease and raw ingestion parity');
  console.log('PASS required contextual basis through HTTP/MCP saves; explicit-space associations preserved');
  console.log('PASS real HTTP/MCP search parity, waves, scores and paths');
  console.log('PASS cross-agent claim → validate → commit → idempotent retry, active listing and audit');
  console.log('PASS authenticated APIs and frontend assets');
} finally {
  await client.close().catch(() => {});
  const stopped = once(http, 'exit').catch(() => {});
  if (http.exitCode === null) { http.kill('SIGTERM'); await stopped; }
  await fs.rm(dir, { recursive: true, force: true });
}
