/** Browser-only operator control plane. This router is never mounted on /mcp. */
import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
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
import { issueNetworkGrant, readNetworkConfiguration } from './network-config.js';
import { toStructuredError } from '../core/errors.js';
import { parseContainerInput } from '../core/building-tools.js';
import { roleReviewSchema, roleConfigureSchema, roleLinkSchema } from '../core/role-tools.js';

export function officeWorkbench(
  graph: GraphMemory,
  options: { apiKey: string; operatorKey: string; contextSecret: string; configFile?: string }
) {
  const router = express.Router(),
    sessions = new Map<string, number>(),
    attempts = new Map<string, { n: number; until: number }>();
  const operator: TrustedCallContext = {
    v: 1,
    principal: 'workbench-user',
    operator: true,
    issuedAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER
  };
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
  router.post('/login', (req, res) => {
    if (!sameOrigin(req)) {
      res.status(403).json({ error: 'Open the workbench on its own origin' });
      return;
    }
    const address = req.ip ?? 'unknown',
      now = Date.now(),
      attempt = attempts.get(address);
    if (attempt && attempt.until > now && attempt.n >= 10) {
      res.status(429).json({ error: 'Too many login attempts; try again in one minute' });
      return;
    }
    if (attempts.size > 256)
      for (const [key, v] of attempts) if (v.until <= now) attempts.delete(key);
    if (attempts.size >= 1024 && !attempts.has(address)) {
      res.status(429).json({ error: 'Login capacity reached' });
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
      res.status(403).json({ error: '请填写用户管理凭据；agent 的 MCP token 不能登录管理页面。' });
      return;
    }
    for (const [key, until] of sessions) if (until <= now) sessions.delete(key);
    if (sessions.size >= 128) {
      res.status(429).json({ error: 'Too many management sessions' });
      return;
    }
    const key = randomBytes(32).toString('base64url');
    sessions.set(key, now + 12 * 3600000);
    res.cookie('mindpond_office_admin', key, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure,
      path: '/api/office-admin',
      maxAge: 12 * 3600000
    });
    res.json({ ok: true });
  });
  router.use((req, res, next) => {
    const key = (req.headers.cookie ?? '')
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('mindpond_office_admin='))
      ?.slice('mindpond_office_admin='.length);
    if (!key || (sessions.get(key) ?? 0) <= Date.now()) {
      res.status(401).json({ error: '请先登录协作管理。' });
      return;
    }
    if (req.method !== 'GET' && !sameOrigin(req)) {
      res.status(403).json({ error: 'Cross-origin management write rejected' });
      return;
    }
    next();
  });
  const route = (name: string, fn: (req: express.Request) => Promise<unknown>) =>
    router.post(name, async (req, res) => {
      try {
        res.json(await fn(req));
      } catch (error) {
        const e = toStructuredError(error);
        res
          .status(e.code === 'scope_denied' ? 403 : e.code === 'stale_version' ? 409 : 400)
          .json({ error: e.message, code: e.code, nextAction: e.nextAction });
      }
    });
  route('/logout', async (req) => {
    const raw = (req.headers.cookie ?? '')
      .split(';')
      .find((s) => s.trim().startsWith('mindpond_office_admin='));
    if (raw) sessions.delete(raw.trim().slice('mindpond_office_admin='.length));
    return { ok: true };
  });
  route('/state', async (req) => {
    let credentialPolicyError = false;
    const credentialPolicies: Record<string, unknown> = {};
    if (options.configFile) {
      try {
        const config = await readNetworkConfiguration(options.configFile);
        for (const grant of config.grants) if (grant.agentId)
          credentialPolicies[grant.agentId] = {
            domains: grant.domains, assignmentIds: grant.assignmentIds ?? null
          };
      } catch (error) {
        credentialPolicyError = (error as NodeJS.ErrnoException).code !== 'ENOENT';
      }
    }
    return {
      ...(await graph.offices.registry(operator)), settings: await graph.offices.settings(operator),
      characters: await graph.roles.state(operator, req.body.roleAfterSeq),
      credentialIssuance: !!options.configFile, credentialPolicies, credentialPolicyError, oauth: false
    };
  });
  route('/settings', (req) => graph.offices.settings(operator, req.body.mcpUrl));
  route('/agent', (req) =>
    graph.offices.configureAgent(agentConfigurationSchema.parse(req.body), operator)
  );
  route('/project', (req) =>
    graph.offices.configureProject(projectConfigurationSchema.parse(req.body), operator)
  );
  route('/office', (req) =>
    graph.roles.configureOffice(officeConfigurationSchema.parse(req.body), operator)
  );
  route('/role/review', req => graph.roles.review(roleReviewSchema.parse(req.body), operator));
  route('/role/state', req => graph.roles.state(operator,req.body.afterSeq));
  route('/role/configure', req => graph.roles.configure(roleConfigureSchema.parse(req.body), operator));
  route('/role/link', req => graph.roles.link(roleLinkSchema.parse(req.body), operator));
  route('/containers', req => graph.building.container(parseContainerInput(req.body),operator));
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
      throw new Error(
        '请先为 Web 服务配置 MINDPOND_MCP_ACCOUNTS，且与 HTTP MCP 网关使用同一个私有配置文件。'
      );
    const input = agentConfigurationSchema
      .pick({ id: true, expectedRevision: true })
      .extend({
        personalId: agentConfigurationSchema.shape.principal.optional(),
        assignmentIds: officeConfigurationSchema.shape.seats
          .unwrap()
          .element.shape.id.array()
          .min(1).max(50).nullable()
          .optional()
      })
      .parse(req.body);
    const registry = await graph.offices.registry(operator),
      agent = registry.agents.find((v: any) => v.id === input.id);
    if (!agent || agent.revision !== input.expectedRevision)
      throw new Error('Agent 设置已变更，请刷新。');
    if (input.assignmentIds?.length) {
      const all = await Promise.all(
        registry.offices.map((o: any) => graph.offices.get({ officeId: o.id, limit: 1 }, operator))
      );
      const owned = new Set(
        all.flatMap((o) =>
          o.seats.filter((s: any) => s.agent_id === agent.id && s.enabled).map((s: any) => s.id)
        )
      );
      if (input.assignmentIds.some((id) => !owned.has(id)))
        throw new Error('只能限制到此 agent 已获授权的分工。');
    }
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
      return {
        token: (await fs.readFile(file, 'utf8')).trim(),
        agentId: agent.id,
        notice: '仅这次响应含凭据。请保存到宿主秘密设置，不发送给 agent。重新签发会替换旧凭据。'
      };
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  return router;
}
