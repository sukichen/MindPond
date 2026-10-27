import {conditionalProjection} from '../core/conditional-projection.js';
import {releaseInfo} from '../core/release-info.js';
import {discussionSchema} from '../core/office-discussions.js';
import {managedScriptSchema} from '../core/office-scripts.js';
/** Browser-only operator control plane. This router is never mounted on /mcp. */
import express from 'express';
import { officeConnection, credentialConnectionDownload, OFFICE_CAPABILITIES } from './office-connection.js';
import { officeAdminServices } from './office-admin-services.js';
import { z } from 'zod';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GraphMemory } from '../core/graph-memory.js';
import type { TrustedCallContext } from '../core/trust.js';
import { verifyContextToken } from '../core/trust.js';
import {
  agentConfigurationSchema,
  officeConfigurationSchema,
  projectConfigurationSchema
} from '../core/office-tools.js';
import { issueNetworkGrant, readNetworkConfiguration, revokeNetworkAgent, singleAgentGrant } from './network-config.js';
import { MindPondError, httpStatus, toStructuredError, httpError } from '../core/errors.js';
import { parseContainerInput } from '../core/building-tools.js';
import { roleReviewSchema, roleConfigureSchema, roleLinkSchema } from '../core/role-tools.js';
import {continuityReadSchema,continuityCheckpointSchema,continuityTaskWriteSchema,continuityTasksSchema,continuityHistorySchema,continuityArchiveSchema} from '../core/role-continuity.js';

export function officeWorkbench(
  graph: GraphMemory,
  options: { apiKey: string; operatorKey: string; contextSecret: string; configFile?: string }
) {
  const router = express.Router(),
    attempts = new Map<string, { n: number; until: number }>();
  const operator: TrustedCallContext = {
    v: 1,
    principal: 'workbench-user',
    operator: true,
    issuedAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER
  };
  const sessionHash = (key: string) => createHash('sha256').update(key).digest('hex');
  const authorityHash = sessionHash(JSON.stringify([options.apiKey,options.operatorKey,options.contextSecret]));
  const equal = (a: unknown, b: string) =>
    typeof a === 'string' &&
    !!b &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const sameOrigin = (req: express.Request) =>
    !req.header('origin') || req.header('origin') === `${req.protocol}://${req.header('host')}`;
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.post('/login', async (req, res, next) => {
    try {
    if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)){res.status(400).json(httpError('invalid_input','Login requires a JSON object with the configured management credentials.'));return;}
    if (!sameOrigin(req)) {
      res.status(403).json(httpError('scope_denied','Open the workbench on its own origin'));
      return;
    }
    // A reverse proxy may mount this UI under /mindpond (or another prefix).
    // Keep the HttpOnly cookie scoped to the browser-visible admin API path.
    const cookiePath = z.string().max(512)
      .regex(/^\/(?:[A-Za-z0-9._~-]+\/)*api\/office-admin$/)
      .refine(value => !value.split('/').some(part => part === '.' || part === '..'))
      .safeParse(req.body.cookiePath ?? '/api/office-admin');
    if (!cookiePath.success) {
      res.status(400).json(httpError('invalid_input','Invalid management cookie path'));
      return;
    }
    const address = req.ip ?? 'unknown',
      now = Date.now(),
      attempt = attempts.get(address);
    if (attempt && attempt.until > now && attempt.n >= 10) {
      res.status(429).json(httpError('temporarily_unavailable','Too many login attempts; try again in one minute'));
      return;
    }
    if (attempts.size > 256)
      for (const [key, v] of attempts) if (v.until <= now) attempts.delete(key);
    if (attempts.size >= 1024 && !attempts.has(address)) {
      res.status(429).json(httpError('temporarily_unavailable','Login capacity reached'));
      return;
    }
    attempts.set(address, {
      n: attempt && attempt.until > now ? attempt.n + 1 : 1,
      until: attempt && attempt.until > now ? attempt.until : now + 60000
    });
    let authorized = equal(req.body.operatorKey, options.operatorKey);
    if (!authorized && options.contextSecret && typeof req.body.contextToken === 'string') {
      try {
        authorized = !!verifyContextToken(req.body.contextToken, options.contextSecret).operator;
      } catch {}
    }
    if (!options.contextSecret && !options.operatorKey) {
      authorized = options.apiKey
        ? equal(req.body.apiKey, options.apiKey)
        : ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) &&
          /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.header('host') ?? '');
    }
    if (options.apiKey && !equal(req.body.apiKey, options.apiKey)) authorized = false;
    if (!authorized) {
      res.status(403).json(httpError('scope_denied','请填写用户管理凭据；agent 的 MCP token 不能登录管理页面。'));
      return;
    }
    const key = randomBytes(32).toString('base64url');
    if (!await graph.offices.managementSession('create',sessionHash(key),authorityHash,operator)) {
      res.status(429).json(httpError('temporarily_unavailable','Too many management sessions'));
      return;
    }
    res.cookie('mindpond_office_admin', key, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure,
      path: cookiePath.data,
      maxAge: 12 * 3600000
    });
    res.json({ ok: true });
    } catch(error) { next(error); }
  });
  router.use(async (req, res, next) => {
    try {
    const key = (req.headers.cookie ?? '')
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('mindpond_office_admin='))
      ?.slice('mindpond_office_admin='.length);
    if (!key || key.length > 128 || !await graph.offices.managementSession('get',sessionHash(key),authorityHash,operator)) {
      res.status(401).json(httpError('scope_denied','请先登录协作管理。'));
      return;
    }
    if (req.method !== 'GET' && !sameOrigin(req)) {
      res.status(403).json(httpError('scope_denied','Cross-origin management write rejected'));
      return;
    }
    next();
    } catch(error) { next(error); }
  });
  const route = (name: string, fn: (req: express.Request) => Promise<unknown>) =>
    router.post(name, async (req, res) => {
      try {
        res.json(await fn(req));
      } catch (error) {
        const e = toStructuredError(error);
        res
          .status(httpStatus(e.code))
          .json({error:e.message,...e});
      }
    });
  // Notifications carry only a revision. All content still passes authenticated
  // POST projections, and one bounded clock serves every observer in this router.
  const observers=new Map<express.Response,{key:string;revision:number;heartbeat:number}>();
  let observerTimer:ReturnType<typeof setInterval>|undefined,observing=false,observersClosed=false;
  router.get('/events',async(req,res,next)=>{
    try{
      if(observersClosed){res.status(503).json(httpError('temporarily_unavailable','Observation service is closing'));return;}
      if(observers.size>=32){res.status(429).json(httpError('temporarily_unavailable','Observation capacity reached'));return;}
      const raw=(req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('mindpond_office_admin='))!.slice('mindpond_office_admin='.length);
      const revision=await graph.building.observationRevision(operator);
      if(observersClosed){res.status(503).json(httpError('temporarily_unavailable','Observation service is closing'));return;}
      if(observers.size>=32){res.status(429).json(httpError('temporarily_unavailable','Observation capacity reached'));return;}
      res.set({'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});res.flushHeaders();
      res.write(`event: ready\ndata: ${revision}\n\n`);
      observers.set(res,{key:sessionHash(raw),revision,heartbeat:Date.now()});
      res.on('close',()=>{observers.delete(res);if(!observers.size){clearInterval(observerTimer);observerTimer=undefined;}});
      if(!observerTimer)observerTimer=setInterval(()=>{if(observing)return;observing=true;void(async()=>{
        const current=await graph.building.observationRevision(operator);
        for(const [stream,entry] of observers){
          if(stream.writableEnded||stream.destroyed)continue;
          if(!await graph.offices.managementSession('get',entry.key,authorityHash,operator)){stream.end();continue;}
          if(current!==entry.revision){entry.revision=current;if(!stream.write(`event: change\ndata: ${current}\n\n`))stream.end();}
          else if(Date.now()-entry.heartbeat>=15000){entry.heartbeat=Date.now();if(!stream.write(': heartbeat\n\n'))stream.end();}
        }
      })().catch(()=>{for(const stream of observers.keys())stream.end();}).finally(()=>{observing=false;});},1000);
    }catch(error){next(error);}
  });
  route('/logout', async (req) => {
    const raw = (req.headers.cookie ?? '')
      .split(';')
      .find((s) => s.trim().startsWith('mindpond_office_admin='));
    if (raw) await graph.offices.managementSession('delete',sessionHash(raw.trim().slice('mindpond_office_admin='.length)),authorityHash,operator);
    return { ok: true };
  });
  const directoryWindows=z.object(Object.fromEntries(['agents','projects','offices','roles','pending','chats','connections'].map(k=>[k,z.string().min(1).max(512).optional()]))).strict();
  route('/state', async (req) => {
    const windows=directoryWindows.parse(req.body.directoryThrough??{});
    const known=z.object({choicesRevision:z.string().regex(/^[a-f0-9]{64}$/).optional(),connectionTemplatesRevision:z.string().regex(/^[a-f0-9]{64}$/).optional()}).parse(req.body);
    let credentialPolicyError = false;
    const credentialPolicies: Record<string, unknown> = {};
    if (options.configFile) {
      try {
        const config = await readNetworkConfiguration(options.configFile);
        for(const grant of config.grants)if(grant.agentId){
          const count=((credentialPolicies[grant.agentId] as any)?.credentialCount??0)+1;
          credentialPolicies[grant.agentId]=count>1?{credentialCount:count,ambiguous:true}:{credentialCount:1,domains:grant.domains,assignmentIds:grant.assignmentIds??null};
        }
      } catch (error) {
        credentialPolicyError = (error as NodeJS.ErrnoException).code !== 'ENOENT';
      }
    }
    const registry = await graph.offices.registry(operator,windows), settings = await graph.offices.settings(operator);
    const choices=conditionalProjection(await graph.offices.choices(operator),known.choicesRevision);
    const templates=conditionalProjection(settings.mcpUrl?Object.fromEntries(registry.agents.map((a:any)=>[a.id,officeConnection({host:a.host,id:a.id,url:settings.mcpUrl})])):{},known.connectionTemplatesRevision);
    return {
      ...registry, choices:choices.value,choicesRevision:choices.revision, selectedOffice:req.body.selectedOfficeId?{id:z.string().min(1).max(160).parse(req.body.selectedOfficeId),exists:await graph.offices.officeExists(req.body.selectedOfficeId,operator)}:null, settings, release:releaseInfo(),capabilities: OFFICE_CAPABILITIES,hostReports:await graph.officeCollaboration.observations(operator),
      connectionTemplates:templates.value,connectionTemplatesRevision:templates.revision,
      characters: await graph.roles.state(operator, req.body.roleAfterSeq,windows,req.body.roleDirectoryRevision),
      credentialIssuance: !!options.configFile, credentialPolicies, credentialPolicyError, oauth: false
    };
  });
  route('/connection-template',async req=>{const i=z.object({agentId:z.string().min(1).max(128),identityMode:z.enum(['connection','native'])}).strict().parse(req.body);const agent=await graph.offices.agent(i.agentId,operator);if(!agent)throw new MindPondError('not_found','Connection not found');const settings=await graph.offices.settings(operator);if(!settings.mcpUrl)throw new MindPondError('invalid_input','Save the public MCP address first');return officeConnection({host:agent.host,id:agent.id,url:settings.mcpUrl,identityMode:i.identityMode});});
  route('/settings', (req) => graph.offices.settings(operator, req.body.mcpUrl));
  officeAdminServices(graph,route,operator);
  route('/agent', (req) =>
    graph.offices.configureAgent(agentConfigurationSchema.parse(req.body), operator)
  );
  route('/project', (req) =>
    graph.offices.configureProject(projectConfigurationSchema.parse(req.body), operator)
  );
  route('/office', async (req) => {
    const input=officeConfigurationSchema.extend({seats:officeConfigurationSchema.shape.seats.unwrap().element.extend({roleId:z.string().uuid(),agentId:officeConfigurationSchema.shape.seats.unwrap().element.shape.agentId.optional()}).strict().array().max(50).optional()}).strict().parse(req.body);
    const result=await graph.roles.configureOffice(input,operator);
    await graph.officeCollaboration.layout(input.id,operator);
    return result;
  });
  route('/role/review', req => graph.roles.review(roleReviewSchema.parse(req.body), operator));
  route('/role/state', req => graph.roles.state(operator,req.body.afterSeq,directoryWindows.parse(req.body.directoryThrough??{}),req.body.directoryRevision));
  route('/role/message',req=>graph.roles.messagePreview(messageReference.parse(req.body),operator));
  route('/role/configure', req => graph.roles.configure(roleConfigureSchema.parse(req.body), operator));
  route('/role/continuity',req=>{const {roleId,...input}=continuityReadSchema.extend({roleId:z.string().uuid()}).parse(req.body);return graph.roleContinuity.resume({roleId,human:true},input);});
  route('/role/continuity/checkpoint',req=>{const {roleId,...input}=continuityCheckpointSchema.extend({roleId:z.string().uuid()}).parse(req.body);return graph.roleContinuity.checkpoint({roleId,human:true},input);});
  route('/role/continuity/task',req=>{const {roleId,...input}=continuityTaskWriteSchema.extend({roleId:z.string().uuid()}).parse(req.body);return graph.roleContinuity.updateTask({roleId,human:true},input);});
  route('/role/continuity/tasks',req=>{const {roleId,...input}=continuityTasksSchema.extend({roleId:z.string().uuid()}).parse(req.body);return graph.roleContinuity.tasks({roleId,human:true},input);});
  route('/role/continuity/history',req=>{const {roleId,...input}=continuityHistorySchema.extend({roleId:z.string().uuid()}).parse(req.body);return graph.roleContinuity.history({roleId,human:true},input);});
  route('/role/continuity/archive',req=>{const {roleId,...input}=continuityArchiveSchema.extend({roleId:z.string().uuid()}).parse(req.body);return graph.roleContinuity.archive({roleId,human:true},input);});
  const deletionSchema = z.object({id:officeConfigurationSchema.shape.id,expectedRevision:z.number().int().min(1)}).strict();
  route('/agent/delete',async req=>{
    const i=deletionSchema.parse(req.body),result=await graph.offices.deleteAgent(i,operator);
    // Database revocation comes first and remains authoritative even if the
    // private configuration is temporarily locked/unavailable.
    if(options.configFile)try{await revokeNetworkAgent(options.configFile,i.id);}catch{return {...result,credentialCleanupPending:true};}
    return result;
  });
  route('/role/delete', req => {
    const i=deletionSchema.parse(req.body);
    return graph.roles.deleteRole({roleId:i.id,expectedRevision:i.expectedRevision},operator);
  });
  route('/office/delete', req => graph.roles.deleteOffice(deletionSchema.parse(req.body),operator));
  route('/role/link', req => graph.roles.link(roleLinkSchema.parse(req.body), operator));
  route('/role/activation/resolve',req=>graph.roles.resolveConnection(z.object({requestId:z.string().uuid(),expectedRevision:z.number().int().positive(),action:z.enum(['reject','delete'])}).strict().parse(req.body),operator));
  route('/role/application/delete',req=>graph.roles.deleteApplication(z.object({applicationId:z.string().uuid(),expectedRevision:z.number().int().positive()}).strict().parse(req.body),operator));
  route('/role/disconnect',req=>graph.roles.disconnect(z.object({roleId:z.string().uuid(),expectedRevision:z.number().int().positive(),bindingId:z.string().uuid()}).strict().parse(req.body),operator));
  route('/role/connect',req=>graph.roles.connect(z.object({roleId:z.string().uuid(),expectedRevision:z.number().int().positive(),targetRuntimeId:z.string().min(1).max(256)}).strict().parse(req.body),operator));
  route('/role/activate',req=>graph.roles.activate(z.object({requestId:z.string().uuid(),roleId:z.string().uuid(),expectedRevision:z.number().int().positive()}).strict().parse(req.body),operator));
  route('/discussions',req=>graph.discussions.run(discussionSchema.parse(req.body),operator));
  route('/rules',req=>graph.officeRules.manage(req.body,operator));
  route('/scripts',req=>graph.scripts.run(managedScriptSchema.parse(req.body),operator));
  route('/discussion-memory',async req=>{
    const i=z.object({id:z.string().uuid(),expectedRevision:z.number().int().positive(),content:z.string().trim().min(1).max(10000),key:z.string().min(1).max(256)}).strict().parse(req.body);
    return graph.discussions.saveConclusion(i,operator);
  });
  route('/containers', req => graph.building.container(parseContainerInput(req.body),operator));
  const mailSchema=z.object({officeId:officeConfigurationSchema.shape.id,knownIds:officeConfigurationSchema.shape.id.array().max(200).optional(),beforeSeq:z.number().int().min(1).optional(),state:z.enum(['pending','processing','archived','all']).optional(),query:z.string().trim().min(1).max(200).optional(),correspondent:officeConfigurationSchema.shape.id.optional(),threadId:officeConfigurationSchema.shape.id.optional(),since:z.number().int().min(0).optional(),until:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(50).optional(),contextBudgetBytes:z.number().int().min(2048).max(65536).optional()}).strict();
  route('/messages', req=>graph.building.history(mailSchema.parse(req.body),operator));
  const messageReference=z.object({messageId:officeConfigurationSchema.shape.id.optional(),seq:z.number().int().positive().optional()}).strict().refine(i=>(i.messageId===undefined)!==(i.seq===undefined),'Choose exactly one messageId or seq');
  route('/message/recover',req=>graph.building.recoverMessage(z.object({officeId:z.string().min(1).max(160).optional(),messageId:z.string().min(1).max(160),action:z.enum(['cancel','retry']),expectedTakenAt:z.number().int().nonnegative().nullable(),reason:z.string().trim().min(1).max(1000),recipient:z.string().min(1).max(160).optional(),key:z.string().min(1).max(256)}).strict().refine(i=>i.action==='retry'||i.recipient===undefined,'Only retry accepts a recipient').parse(req.body),operator));
  route('/message',req=>{const input=z.object({officeId:officeConfigurationSchema.shape.id,messageId:officeConfigurationSchema.shape.id.optional(),seq:z.number().int().positive().optional()}).strict().refine(i=>(i.messageId===undefined)!==(i.seq===undefined),'Choose exactly one messageId or seq').parse(req.body);return graph.building.messagePreview(input,operator);});
  route('/view', async (req) => ({
    ...(await graph.offices.get(
      {
        officeId: officeConfigurationSchema.shape.id.parse(req.body.officeId),
        ...Object.fromEntries(
          ['itemId', 'roundId', 'itemsAfterId', 'materialsAfterId']
            .filter((k) => req.body[k] !== undefined)
            .map((k) => [k, officeConfigurationSchema.shape.id.parse(req.body[k])])
        ),
        offset: Math.max(0, Number(req.body.offset) || 0),
        ...Object.fromEntries(['itemIds', 'materialIds'].filter(k => req.body[k] !== undefined)
          .map(k => [k, officeConfigurationSchema.shape.id.array().max(500).parse(req.body[k])])),
        ...(req.body.eventSeq
          ? {
              eventSeq: Number(req.body.eventSeq)
            }
          : {}),
        afterSeq: Math.max(0, Number(req.body.afterSeq) || 0),
        limit: 100
      },
      operator
    )),
    facilities: await graph.building.snapshot(officeConfigurationSchema.shape.id.parse(req.body.officeId),operator,req.body.facilityRevision)
  }));
  const replaySchema=z.object({action:z.enum(['index','page']),officeId:officeConfigurationSchema.shape.id,threadId:officeConfigurationSchema.shape.id.optional(),roleId:officeConfigurationSchema.shape.id.optional(),topic:z.string().trim().min(1).max(200).optional(),keyOnly:z.boolean().optional(),fromSeq:z.number().int().min(1).optional(),toSeq:z.number().int().min(0).optional(),afterSeq:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(100).optional()}).strict();
  route('/replay',req=>graph.building.replay(replaySchema.parse(req.body),operator));
  route('/item/cancel', (req) => {
    const itemId = officeConfigurationSchema.shape.id.parse(req.body.itemId),
      expectedRevision = agentConfigurationSchema.shape.expectedRevision.parse(
        req.body.expectedRevision
      ),
      reason = officeConfigurationSchema.shape.goal.unwrap().min(1).parse(req.body.reason);
    return graph.offices.cancelItem({ itemId, expectedRevision, reason }, operator);
  });
  route('/material', (req) =>
    graph.offices.materialPreview(
      {
        materialId: officeConfigurationSchema.shape.id.parse(req.body.materialId),
        number: Number(req.body.number ?? 0)
      },
      operator
    )
  );
  route('/credential', async (req) => {
    if (!options.configFile)
      throw new MindPondError('temporarily_unavailable',
        '请先为 Web 服务配置 MINDPOND_MCP_ACCOUNTS，且与 HTTP MCP 网关使用同一个私有配置文件。'
      );
    const input = agentConfigurationSchema
      .pick({ id: true, expectedRevision: true })
      .extend({
        personalId: agentConfigurationSchema.shape.principal.optional(),
        identityMode:z.enum(['connection','native']).optional(),
        assignmentIds: officeConfigurationSchema.shape.seats
          .unwrap()
          .element.shape.id.array()
          .min(1).max(50).nullable()
          .optional()
      })
      .parse(req.body);
    const agent = await graph.offices.agent(input.id,operator);
    if (!agent || agent.revision !== input.expectedRevision)
      throw new MindPondError('stale_version','Agent 设置已变更，请刷新。');
    if (input.assignmentIds?.length) {
      const owned = new Set((await graph.offices.agentSeats(agent.id,operator)).map(s=>s.id));
      if (input.assignmentIds.some((id) => !owned.has(id)))
        throw new MindPondError('invalid_input','只能限制到此 agent 已获授权的分工。');
    }
    const currentConfig=await readNetworkConfiguration(options.configFile).catch(()=>null);
    if(currentConfig)singleAgentGrant(currentConfig,agent.id); // Before changing this host's availability.
    const settings=await graph.offices.settings(operator);
    if(input.identityMode){if(!settings.mcpUrl)throw new MindPondError('invalid_input','Save the public MCP address before generating a configuration');officeConnection({host:agent.host,id:agent.id,url:settings.mcpUrl,identityMode:input.identityMode});}
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-issue-'));
    // DB pending/disabled is authoritative in the gateway: a file write alone cannot activate access.
    await graph.offices.configureAgent(
      { ...agent, expectedRevision: agent.revision, state: 'pending' },
      operator
    );
    try {
      const file = path.join(directory, 'credential');
      const config = await readNetworkConfiguration(options.configFile).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return { grants: [] };
      });
      await issueNetworkGrant({
        configFile: options.configFile,
        tokenFile: file,
        principal: agent.principal,
        agentId: agent.id,
        personalId: input.personalId,
        rotate: config.grants.some((g) => g.agentId === agent.id),
        assignmentIds: input.assignmentIds
      });
      await graph.offices.configureAgent(
        { ...agent, expectedRevision: agent.revision + 1, state: 'active' },
        operator
      );
      const token=(await fs.readFile(file,'utf8')).trim();
      return {
        token,...(settings.mcpUrl&&input.identityMode?{download:credentialConnectionDownload({host:agent.host,id:agent.id,url:settings.mcpUrl,token,identityMode:input.identityMode})}:{}),
        agentId: agent.id,
        notice: '仅这次响应含凭据。请保存到宿主秘密设置，不发送给 agent。重新签发会替换当前凭据。'
      };
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  return Object.assign(router,{closeObservers(){
    observersClosed=true;clearInterval(observerTimer);observerTimer=undefined;
    for(const stream of observers.keys())stream.end();observers.clear();
  }});
}
