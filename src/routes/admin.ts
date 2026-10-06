import querystring from 'node:querystring';
import fs from 'node:fs';
import path from 'node:path';
import { FastifyPluginAsync } from 'fastify';
import {
  clearFailedLogins,
  createAdminSessionToken,
  isDashboardEnabled,
  isLoginRateLimited,
  recordFailedLogin,
  verifyAdminPassword,
} from '../auth/admin-auth.js';
import { requireAdminAuth, requireAdminSession } from '../auth/middleware.js';
import { mintTenantToken } from '../auth/tenant-token.js';
import { CONFIG, loadLogicalModelConfigs, loadRawLogicalModelConfigs } from '../config.js';
import {
  getAllCatalogs,
  getCatalogModel,
  refreshAllCatalogs,
  refreshCatalog,
  resetModelManual,
  setModelManual,
} from '../core/catalog.js';
import { getBudgetStatus } from '../core/budget.js';
import { getClientMetadataStatus } from '../core/client-meta.js';
import { getCooldownStatus, isCoolingDown, resetCooldowns } from '../core/cooldown.js';
import { getRecentRouterEvents } from '../core/events.js';
import { getRequestStats } from '../core/forwarder.js';
import { effectiveLoopLimits, getLoopGuardStatus, unblockLoopSessions } from '../core/loop-guard.js';
import {
  getNotificationStatus,
  getRecentNotifications,
  sendTestNotification,
} from '../core/notify.js';
import { getAllProbeMetrics, getProbeMetrics, runProbeCycle } from '../core/prober.js';
import {
  aggregate,
  getClientStats,
  extractClientIp,
  queryRequests,
  RequestLogFilter,
} from '../core/request-log.js';
import { getRetirementAlerts } from '../core/retirement.js';
import { getPreselectedCandidate, updateAllPreselections } from '../core/selector.js';
import { getAllActiveRateTenantIds, getTenantRateUsage } from '../core/tenant-rate.js';
import {
  deleteTenant,
  getTenant,
  listTenants,
  resolveLoopLimits,
  resolveMinimaxLimits,
  resolveRateLimits,
  sanitizeTenantForApi,
  TenantRecord,
  UpstreamKeyProvider,
  upsertTenant,
  validateTenantRecord,
} from '../core/tenants.js';
import { dropDecryptedKeyCache, keyFingerprint } from '../core/keys.js';
import { getProviderAdapter } from '../core/providers/index.js';
import { encryptSecret, isSecretsConfigured } from '../core/secrets.js';
import { getTenantRouteConfig } from '../core/byok-defaults.js';
import { runWatchCheck } from '../core/watch.js';
import { AdminStatusResponse, LogicalModelId, LOGICAL_MODEL_IDS } from '../types.js';
import {
  render429Page,
  renderDashboardHtml,
  renderLoginPage,
} from './admin-ui.js';

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  // Register form-urlencoded body parser for /admin/login without extra npm dependencies
  if (!fastify.hasContentTypeParser('application/x-www-form-urlencoded')) {
    fastify.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body: string, done) => {
        try {
          done(null, querystring.parse(body));
        } catch (err: any) {
          done(err, undefined);
        }
      }
    );
  }

  // GET /admin/login
  fastify.get<{ Querystring: { e?: string } }>('/admin/login', async (req, reply) => {
    if (!isDashboardEnabled()) {
      return reply
        .status(503)
        .type('text/plain; charset=utf-8')
        .send('Dashboard disabled: set ROUTER_ADMIN_PASSWORD');
    }
    const hasError = req.query.e === '1';
    return reply.status(200).type('text/html; charset=utf-8').send(renderLoginPage(hasError));
  });

  // POST /admin/login
  fastify.post<{ Body: Record<string, any> }>('/admin/login', async (req, reply) => {
    if (!isDashboardEnabled()) {
      return reply
        .status(503)
        .type('text/plain; charset=utf-8')
        .send('Dashboard disabled: set ROUTER_ADMIN_PASSWORD');
    }

    const ip = extractClientIp(req);
    if (isLoginRateLimited(ip)) {
      return reply.status(429).type('text/html; charset=utf-8').send(render429Page());
    }

    const body = (req.body || {}) as Record<string, any>;
    const username = body.username;
    const password = typeof body.password === 'string' ? body.password : '';

    if (username === 'admin' && verifyAdminPassword(password)) {
      clearFailedLogins(ip);
      const sessionToken = createAdminSessionToken();
      const isTest = process.env.NODE_ENV === 'test';
      const secureFlag = isTest ? '' : '; Secure';

      reply.header(
        'Set-Cookie',
        `rr_admin=${sessionToken}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=604800${secureFlag}`
      );
      return reply.redirect(303, '/admin/ui');
    }

    recordFailedLogin(ip);
    return reply.redirect(303, '/admin/login?e=1');
  });

  // POST /admin/logout
  fastify.post('/admin/logout', async (_req, reply) => {
    reply.header(
      'Set-Cookie',
      'rr_admin=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0'
    );
    return reply.redirect(303, '/admin/login');
  });

  // GET /admin/ui
  fastify.get('/admin/ui', { preHandler: requireAdminSession }, async (_req, reply) => {
    return reply.status(200).type('text/html; charset=utf-8').send(renderDashboardHtml());
  });

  // GET /admin/api/summary
  fastify.get<{
    Querystring: {
      from?: string;
      to?: string;
      bucket?: 'hour' | 'day';
      tenant?: string;
      app?: string;
      agent?: string;
      session?: string;
      tier?: string;
      backend?: string;
      status?: string;
      errorCode?: string;
    };
  }>('/admin/api/summary', { preHandler: requireAdminSession }, async (req, reply) => {
    const q = req.query;
    const now = Date.now();
    const from = q.from || new Date(now - 24 * 3600 * 1000).toISOString();
    const to = q.to || new Date(now).toISOString();

    let bucket = q.bucket;
    if (!bucket || (bucket !== 'hour' && bucket !== 'day')) {
      const fromMs = new Date(from).getTime();
      const toMs = new Date(to).getTime();
      const diffDays = (toMs - fromMs) / (24 * 3600 * 1000);
      bucket = diffDays > 3 ? 'day' : 'hour';
    }

    const filter: RequestLogFilter = {
      from,
      to,
      tenant: q.tenant,
      app: q.app,
      agent: q.agent,
      session: q.session,
      tier: q.tier,
      backend: q.backend,
      status: q.status,
      errorCode: q.errorCode,
    };

    const result = aggregate(filter, bucket);
    return reply.status(200).send(result);
  });

  // GET /admin/api/requests
  fastify.get<{
    Querystring: {
      from?: string;
      to?: string;
      limit?: string;
      before?: string;
      tenant?: string;
      app?: string;
      agent?: string;
      session?: string;
      tier?: string;
      backend?: string;
      status?: string;
      errorCode?: string;
    };
  }>('/admin/api/requests', { preHandler: requireAdminSession }, async (req, reply) => {
    const q = req.query;
    const limit = q.limit ? Number(q.limit) : 100;
    const before = q.before;

    const filter: RequestLogFilter = {
      from: q.from,
      to: q.to,
      tenant: q.tenant,
      app: q.app,
      agent: q.agent,
      session: q.session,
      tier: q.tier,
      backend: q.backend,
      status: q.status,
      errorCode: q.errorCode,
    };

    const result = queryRequests(filter, { limit, before });
    return reply.status(200).send(result);
  });

  // GET /admin/api/clients
  fastify.get('/admin/api/clients', { preHandler: requireAdminSession }, async (_req, reply) => {
    const clients = getClientStats();
    return reply.status(200).send(clients);
  });

  // GET /admin/api/budget
  fastify.get('/admin/api/budget', { preHandler: requireAdminSession }, async (_req, reply) => {
    const budget = getBudgetStatus();
    return reply.status(200).send(budget);
  });

  // GET /admin/api/tenants
  fastify.get('/admin/api/tenants', { preHandler: requireAdminSession }, async (_req, reply) => {
    const allTenantIds = new Set<string>();
    for (const t of listTenants()) {
      allTenantIds.add(t.id);
    }
    for (const id of getAllActiveRateTenantIds()) {
      allTenantIds.add(id);
    }
    const budget = getBudgetStatus();
    for (const id of Object.keys(budget.tenants)) {
      allTenantIds.add(id);
    }
    const clients = getClientStats();
    for (const c of clients) {
      if (c.tenant && c.tenant !== '(unauthenticated)') {
        allTenantIds.add(c.tenant);
      }
    }

    const tenantsList = [];
    for (const tid of allTenantIds) {
      const record = getTenant(tid);
      const safeRecord = record ? sanitizeTenantForApi(record) : null;
      const effective = {
        rate: resolveRateLimits(tid),
        loop: effectiveLoopLimits(resolveLoopLimits(tid)),
        minimax: resolveMinimaxLimits(tid),
      };
      const rateUsage = getTenantRateUsage(tid);
      const tenantBudget = budget.tenants[tid];
      const usage = {
        rpmWindow: rateUsage.rpmWindow,
        inFlight: rateUsage.inFlight,
        dayRequests: rateUsage.dayRequests,
        minimax: {
          dayUsed: tenantBudget?.dayUsed ?? 0,
          hourUsed: tenantBudget?.hourUsed ?? 0,
        },
      };

      tenantsList.push({
        id: tid,
        record: safeRecord,
        effective,
        usage,
        known: record !== null,
      });
    }

    return reply.status(200).send({ tenants: tenantsList });
  });

  // GET /admin/api/tenants/:id
  fastify.get<{ Params: { id: string } }>(
    '/admin/api/tenants/:id',
    { preHandler: requireAdminSession },
    async (req, reply) => {
      const id = req.params.id;
      const record = getTenant(id);
      const safeRecord = record ? sanitizeTenantForApi(record) : null;
      const rateUsage = getTenantRateUsage(id);
      const budget = getBudgetStatus();
      const tenantBudget = budget.tenants[id];

      const hasUsage =
        rateUsage.rpmWindow > 0 ||
        rateUsage.inFlight > 0 ||
        rateUsage.dayRequests > 0 ||
        (tenantBudget && (tenantBudget.dayUsed > 0 || tenantBudget.hourUsed > 0));

      if (!record && !hasUsage) {
        return reply.status(404).send({
          error: {
            message: `Tenant "${id}" not found`,
            type: 'invalid_request_error',
            code: 'tenant_not_found',
          },
        });
      }

      const effective = {
        rate: resolveRateLimits(id),
        loop: effectiveLoopLimits(resolveLoopLimits(id)),
        minimax: resolveMinimaxLimits(id),
      };
      const usage = {
        rpmWindow: rateUsage.rpmWindow,
        inFlight: rateUsage.inFlight,
        dayRequests: rateUsage.dayRequests,
        minimax: {
          dayUsed: tenantBudget?.dayUsed ?? 0,
          hourUsed: tenantBudget?.hourUsed ?? 0,
        },
      };

      return reply.status(200).send({
        id,
        record: safeRecord,
        effective,
        usage,
        known: record !== null,
      });
    }
  );

  // PUT /admin/api/tenants/:id
  fastify.put<{ Params: { id: string }; Body: Record<string, any> }>(
    '/admin/api/tenants/:id',
    { preHandler: requireAdminSession },
    async (req, reply) => {
      const id = req.params.id;
      const body = (req.body || {}) as Record<string, any>;

      if (body.id !== undefined && body.id !== id) {
        return reply.status(400).send({
          error: {
            message: 'Tenant id in body does not match route parameter',
            type: 'invalid_request_error',
            code: 'id_mismatch',
            errors: ['Tenant id in body does not match route parameter'],
          },
        });
      }

      const existing = getTenant(id);
      const payload: Record<string, any> = { ...body, id };

      if (existing?.upstreamKeys && payload.upstreamKeys) {
        for (const [prov, existingKey] of Object.entries(existing.upstreamKeys)) {
          if (payload.upstreamKeys[prov] && !payload.upstreamKeys[prov].enc && existingKey?.enc) {
            payload.upstreamKeys[prov].enc = existingKey.enc;
          }
        }
      } else if (existing?.upstreamKeys && payload.upstreamKeys === undefined) {
        payload.upstreamKeys = existing.upstreamKeys;
      }

      const validation = validateTenantRecord(payload);
      if (!validation.ok) {
        return reply.status(400).send({
          error: {
            message: 'Validation failed',
            type: 'invalid_request_error',
            code: 'validation_error',
            errors: validation.errors,
          },
        });
      }

      const now = new Date().toISOString();
      const toSave: TenantRecord = {
        ...payload,
        id,
        status: payload.status || existing?.status || 'active',
        createdAt: existing?.createdAt || payload.createdAt || now,
        updatedAt: now,
      };

      const saved = upsertTenant(toSave);
      return reply.status(200).send({ ok: true, tenant: sanitizeTenantForApi(saved) });
    }
  );

  // DELETE /admin/api/tenants/:id
  fastify.delete<{ Params: { id: string }; Querystring: { force?: string } }>(
    '/admin/api/tenants/:id',
    { preHandler: requireAdminSession },
    async (req, reply) => {
      const id = req.params.id;
      const record = getTenant(id);
      if (!record) {
        return reply.status(404).send({
          error: {
            message: `Tenant "${id}" not found`,
            type: 'invalid_request_error',
            code: 'tenant_not_found',
          },
        });
      }

      const force = req.query.force === '1' || req.query.force === 'true';
      if (record.tokenVersion && record.tokenVersion > 0 && !force) {
        return reply.status(409).send({
          error: {
            message: 'Tenant has tokenVersion > 0. Pass ?force=1 to confirm deletion.',
            type: 'invalid_request_error',
            code: 'token_version_conflict',
          },
        });
      }

      if (record.upstreamKeys) {
        for (const k of Object.values(record.upstreamKeys)) {
          if (k?.fp) dropDecryptedKeyCache(k.fp);
        }
      }

      deleteTenant(id);
      return reply.status(200).send({ ok: true, message: `Tenant "${id}" deleted` });
    }
  );

  // PUT /admin/api/tenants/:id/keys/:provider
  fastify.put<{ Params: { id: string; provider: string }; Body: { key?: string } }>(
    '/admin/api/tenants/:id/keys/:provider',
    { preHandler: requireAdminSession },
    async (req, reply) => {
      const { id, provider } = req.params;
      const key = req.body?.key;

      if (!isSecretsConfigured()) {
        return reply.status(400).send({
          error: {
            message: 'Secrets encryption is not configured (ROUTER_SECRETS_KEY missing)',
            type: 'invalid_request_error',
            code: 'secrets_not_configured',
          },
        });
      }

      if (typeof key !== 'string' || key.trim().length === 0) {
        return reply.status(400).send({
          error: {
            message: 'Missing or empty "key" in request body',
            type: 'invalid_request_error',
            code: 'invalid_key',
          },
        });
      }

      if (provider !== 'ollama-cloud' && provider !== 'openai') {
        return reply.status(400).send({
          error: {
            message: `Unsupported provider "${provider}"`,
            type: 'invalid_request_error',
            code: 'invalid_provider',
          },
        });
      }

      const adapter = getProviderAdapter(provider);
      if (!adapter) {
        return reply.status(400).send({
          error: {
            message: `No adapter found for provider "${provider}"`,
            type: 'invalid_request_error',
            code: 'invalid_provider',
          },
        });
      }

      const baseUrl = provider === 'ollama-cloud' ? CONFIG.cloudBaseUrl : CONFIG.openaiBaseUrl;

      let plan: string | undefined;
      try {
        ({ plan } = await adapter.validateKey(baseUrl, key.trim()));
      } catch (err: any) {
        return reply.status(400).send({
          error: {
            message: `Invalid key: failed to validate with upstream provider (${err?.message || err})`,
            type: 'invalid_request_error',
            code: 'invalid_key',
          },
        });
      }

      const tenant = getTenant(id);
      if (!tenant) {
        return reply.status(404).send({
          error: {
            message: `Tenant "${id}" not found`,
            type: 'invalid_request_error',
            code: 'tenant_not_found',
          },
        });
      }

      const trimmedKey = key.trim();
      const enc = encryptSecret(trimmedKey);
      const hint = `…${trimmedKey.slice(-4)}`;
      const fp = keyFingerprint(trimmedKey);
      const nowStr = new Date().toISOString();

      dropDecryptedKeyCache(fp);

      tenant.upstreamKeys = tenant.upstreamKeys || {};
      tenant.upstreamKeys[provider as UpstreamKeyProvider] = {
        enc,
        hint,
        fp,
        addedAt: nowStr,
        status: 'ok',
        statusAt: nowStr,
        ...(plan ? { plan } : {}),
      };

      upsertTenant(tenant);

      const cat = await refreshCatalog(provider, baseUrl, trimmedKey);
      const modelCount = cat?.models ? Object.keys(cat.models).length : 0;

      return reply.status(200).send({
        hint,
        fp,
        status: 'ok',
        plan,
        models: modelCount,
      });
    }
  );

  // DELETE /admin/api/tenants/:id/keys/:provider
  fastify.delete<{ Params: { id: string; provider: string }; Querystring: { force?: string } }>(
    '/admin/api/tenants/:id/keys/:provider',
    { preHandler: requireAdminSession },
    async (req, reply) => {
      const { id, provider } = req.params;
      const tenant = getTenant(id);
      if (!tenant) {
        return reply.status(404).send({
          error: {
            message: `Tenant "${id}" not found`,
            type: 'invalid_request_error',
            code: 'tenant_not_found',
          },
        });
      }

      if (!tenant.upstreamKeys || !tenant.upstreamKeys[provider as UpstreamKeyProvider]) {
        return reply.status(404).send({
          error: {
            message: `No upstream key configured for provider "${provider}" on tenant "${id}"`,
            type: 'invalid_request_error',
            code: 'key_not_found',
          },
        });
      }

      const force = req.query.force === '1' || req.query.force === 'true';
      const existingKeys = Object.keys(tenant.upstreamKeys || {});

      if (tenant.mode === 'byok' && existingKeys.length <= 1) {
        if (!force) {
          return reply.status(409).send({
            error: {
              message:
                'Cannot delete the last key of a BYOK tenant. Pass ?force=1 to disable the tenant and remove the key.',
              type: 'invalid_request_error',
              code: 'last_byok_key',
            },
          });
        }
        tenant.status = 'disabled';
      }

      const oldKey = tenant.upstreamKeys[provider as UpstreamKeyProvider];
      if (oldKey?.fp) {
        dropDecryptedKeyCache(oldKey.fp);
      }
      delete tenant.upstreamKeys[provider as UpstreamKeyProvider];

      upsertTenant(tenant);
      return reply.status(200).send({ ok: true, message: `Key for "${provider}" deleted` });
    }
  );

  // GET /admin/api/tenants/:id/pools
  fastify.get<{ Params: { id: string } }>(
    '/admin/api/tenants/:id/pools',
    { preHandler: requireAdminSession },
    async (req, reply) => {
      const { id } = req.params;
      const tenant = getTenant(id);
      if (!tenant) {
        return reply.status(404).send({
          error: {
            message: `Tenant "${id}" not found`,
            type: 'invalid_request_error',
            code: 'tenant_not_found',
          },
        });
      }

      const rawRoutes = loadRawLogicalModelConfigs();
      const expandedConfigs = loadLogicalModelConfigs();
      const routesResult: Array<{
        route: string;
        description: string;
        entries: Array<{
          id: string;
          model: string;
          provider: string;
          fromRule?: string;
          priority: number;
          cooling: boolean;
          cooldownRemainingSec: number;
          admission?: string;
        }>;
      }> = [];

      for (const logicalId of LOGICAL_MODEL_IDS) {
        const baseCfg = rawRoutes[logicalId];
        if (!baseCfg) continue;
        const routeConfig =
          tenant.mode === 'byok'
            ? getTenantRouteConfig(id, logicalId, baseCfg)
            : expandedConfigs[logicalId] || baseCfg;

        const entries = (routeConfig.pool || []).map((entry) => {
          const cool = isCoolingDown(logicalId, entry.id);
          let admission: string | undefined;
          if (entry.keyRef) {
            const keyInfo = tenant.upstreamKeys?.[entry.keyRef.provider];
            if (keyInfo && entry.provider) {
              const catModel = getCatalogModel(entry.provider, keyInfo.fp, entry.model);
              admission = catModel?.admission?.status;
            }
          }
          return {
            id: entry.id,
            model: entry.model,
            provider: entry.provider,
            fromRule: entry.fromRule,
            priority: entry.priority,
            cooling: cool.cooling,
            cooldownRemainingSec: cool.remainingSec,
            admission: admission || (entry.fromRule ? 'admitted' : undefined),
          };
        });

        routesResult.push({
          route: logicalId,
          description: baseCfg.description,
          entries,
        });
      }

      return reply.status(200).send({ pools: routesResult });
    }
  );

  // POST /admin/api/tenants/:id/token
  fastify.post<{ Params: { id: string }; Body: { rotate?: boolean } }>(
    '/admin/api/tenants/:id/token',
    { preHandler: requireAdminSession },
    async (req, reply) => {
      const id = req.params.id;
      const rotate = Boolean(req.body?.rotate);

      let tokenVersion: number;
      if (rotate) {
        const record = getTenant(id);
        const newVersion = (record?.tokenVersion ?? 0) + 1;
        const now = new Date().toISOString();
        const toSave: TenantRecord = {
          id,
          name: record?.name,
          status: record?.status || 'active',
          tokenVersion: newVersion,
          limits: record?.limits,
          notify: record?.notify,
          notes: record?.notes,
          createdAt: record?.createdAt || now,
          updatedAt: now,
        };
        upsertTenant(toSave);
        tokenVersion = newVersion;
      } else {
        const record = getTenant(id);
        tokenVersion = record?.tokenVersion || 0;
      }

      const token = mintTenantToken(id, undefined, tokenVersion);
      return reply.status(200).send({ token });
    }
  );

  // POST /admin/api/tenants/:id/unblock
  fastify.post<{ Params: { id: string } }>(
    '/admin/api/tenants/:id/unblock',
    { preHandler: requireAdminSession },
    async (req, reply) => {
      const id = req.params.id;
      const cleared = unblockLoopSessions(`${id}|`);
      return reply.status(200).send({ cleared });
    }
  );

  // GET /admin/api/events
  fastify.get<{ Querystring: { limit?: string } }>(
    '/admin/api/events',
    { preHandler: requireAdminSession },
    async (req, reply) => {
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const events = getRecentRouterEvents(limit);
      return reply.status(200).send({ events });
    }
  );

  // GET /admin/api/notifications
  fastify.get<{ Querystring: { limit?: string } }>(
    '/admin/api/notifications',
    { preHandler: requireAdminSession },
    async (req, reply) => {
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const status = getNotificationStatus();
      const deliveries = getRecentNotifications(limit);
      return reply.status(200).send({
        transports: status.transports,
        admin: status.admin,
        deliveries,
        notifications: deliveries,
      });
    }
  );

  // POST /admin/api/notify-test
  fastify.post(
    '/admin/api/notify-test',
    { preHandler: requireAdminSession },
    async (_req, reply) => {
      const res = await sendTestNotification();
      if (!res.ok && res.count === 0) {
        return reply.status(400).send({
          ok: false,
          error: 'No notification transports or admin contacts configured',
        });
      }
      return reply.status(200).send(res);
    }
  );

  // Existing admin endpoints
  fastify.get('/admin/status', { preHandler: requireAdminAuth }, async (_req, reply) => {
    const configs = loadLogicalModelConfigs();
    const probeMetrics = getAllProbeMetrics();
    const cooldowns = getCooldownStatus();
    const retirementAlerts = getRetirementAlerts();
    const requestStats = getRequestStats();

    const logicalModels: AdminStatusResponse['logicalModels'] = {};

    for (const id of LOGICAL_MODEL_IDS) {
      const cfg = configs[id];
      if (!cfg) continue;

      const selected = getPreselectedCandidate(id as LogicalModelId, cfg);
      const selectedMetrics = selected ? getProbeMetrics(selected.id) : undefined;

      const candidateList = (cfg.pool || []).map((entry) => {
        const cool = isCoolingDown(id, entry.id);
        const metrics = getProbeMetrics(entry.id);
        return {
          id: entry.id,
          model: entry.model,
          provider: entry.provider,
          baseUrl: entry.baseUrl,
          priority: entry.priority,
          enabled: entry.enabled,
          cooling: cool.cooling,
          cooldownRemainingSec: cool.remainingSec,
          healthy: metrics ? metrics.healthy : true,
          ttfbMs: metrics ? metrics.ttfbMs : 0,
          lastError: metrics?.lastError,
        };
      });

      logicalModels[id] = {
        selectedCandidate: selected
          ? {
              id: selected.id,
              model: selected.model,
              provider: selected.provider,
              baseUrl: selected.baseUrl,
              tier: selected.tier,
              ttfbMs: selectedMetrics?.ttfbMs || 0,
            }
          : null,
        candidates: candidateList,
      };
    }

    const response: AdminStatusResponse = {
      uptimeSeconds: Math.floor(process.uptime()),
      serverTime: new Date().toISOString(),
      logicalModels,
      retirementAlerts,
      cooldowns,
      probeMetrics,
      requestStats,
      budget: getBudgetStatus(),
      loopGuard: getLoopGuardStatus(),
      clientMetadata: getClientMetadataStatus(),
    };

    return reply.status(200).send(response);
  });

  fastify.post('/admin/probe', { preHandler: requireAdminAuth }, async (_req, reply) => {
    const configs = loadLogicalModelConfigs();
    const results = await runProbeCycle(configs);
    updateAllPreselections(configs);
    return reply.status(200).send({
      ok: true,
      message: 'Probe cycle completed',
      metrics: results,
    });
  });

  fastify.post(
    '/admin/reset-cooldowns',
    { preHandler: requireAdminAuth },
    async (_req, reply) => {
      resetCooldowns();
      const configs = loadLogicalModelConfigs();
      updateAllPreselections(configs);
      return reply.status(200).send({
        ok: true,
        message: 'All cooldowns cleared',
      });
    }
  );

  // GET /admin/api/catalog
  fastify.get('/admin/api/catalog', { preHandler: requireAdminSession }, async (_req, reply) => {
    const catalogs = getAllCatalogs().map((c) => ({
      id: `${c.provider}-${c.fp}`,
      provider: c.provider,
      baseUrl: c.baseUrl,
      fp: c.fp,
      fetchedAt: c.fetchedAt,
      models: c.models,
    }));

    const rawDefaults = loadRawLogicalModelConfigs();
    const expandedConfigs = loadLogicalModelConfigs();
    const rules: Array<{
      route: string;
      ruleId: string;
      need?: string[];
      minContext?: number;
      prefer: string[];
      exclude?: string[];
      take: number;
      resolved: string[];
    }> = [];

    for (const [routeId, rawCfg] of Object.entries(rawDefaults)) {
      if (rawCfg.censored !== true) continue;
      const expandedPool = expandedConfigs[routeId as LogicalModelId]?.pool || [];

      for (const entry of rawCfg.pool) {
        if (!entry.select) continue;
        const resolvedModels = expandedPool
          .filter((e) => e.fromRule === entry.id)
          .map((e) => e.model);

        rules.push({
          route: routeId,
          ruleId: entry.id,
          need: entry.select.need,
          minContext: entry.select.minContext,
          prefer: entry.select.prefer,
          exclude: entry.select.exclude,
          take: entry.select.take ?? 1,
          resolved: resolvedModels,
        });
      }
    }

    return reply.status(200).send({ catalogs, rules });
  });

  // POST /admin/api/catalog/refresh
  fastify.post('/admin/api/catalog/refresh', { preHandler: requireAdminSession }, async (_req, reply) => {
    const summary = await refreshAllCatalogs();
    return reply.status(200).send({ ok: true, ...summary });
  });

  // POST /admin/api/catalog/:catalogId/models/:model/admit
  fastify.post<{ Params: { catalogId: string; model: string } }>(
    '/admin/api/catalog/:catalogId/models/:model/admit',
    { preHandler: requireAdminSession },
    async (req, reply) => {
      const ok = setModelManual(req.params.catalogId, req.params.model, 'admit');
      if (!ok) {
        return reply.status(404).send({ error: { message: 'Catalog or model not found' } });
      }
      return reply.status(200).send({ ok: true });
    }
  );

  // POST /admin/api/catalog/:catalogId/models/:model/block
  fastify.post<{ Params: { catalogId: string; model: string } }>(
    '/admin/api/catalog/:catalogId/models/:model/block',
    { preHandler: requireAdminSession },
    async (req, reply) => {
      const ok = setModelManual(req.params.catalogId, req.params.model, 'block');
      if (!ok) {
        return reply.status(404).send({ error: { message: 'Catalog or model not found' } });
      }
      return reply.status(200).send({ ok: true });
    }
  );

  // POST /admin/api/catalog/:catalogId/models/:model/reset
  fastify.post<{ Params: { catalogId: string; model: string } }>(
    '/admin/api/catalog/:catalogId/models/:model/reset',
    { preHandler: requireAdminSession },
    async (req, reply) => {
      const ok = resetModelManual(req.params.catalogId, req.params.model);
      if (!ok) {
        return reply.status(404).send({ error: { message: 'Catalog or model not found' } });
      }
      return reply.status(200).send({ ok: true });
    }
  );

  // GET /admin/api/watch
  fastify.get('/admin/api/watch', { preHandler: requireAdminSession }, async (_req, reply) => {
    const dir = path.join(process.env.ROUTER_STATE_DIR || './data', 'watch');
    if (!fs.existsSync(dir)) {
      return reply.status(200).send({ reports: [] });
    }

    const files = fs.readdirSync(dir);
    const reports: Array<{
      name: string;
      date: string;
      level: 'ok' | 'warn' | 'crit';
      signalsCount: number;
      generatedAt: string;
    }> = [];

    const safeNameRegex = /^(?:\d{4}-\d{2}-\d{2}|manual-[\w:.-]+)\.json$/;

    for (const f of files) {
      if (f === 'state.json' || !safeNameRegex.test(f)) continue;
      try {
        const fullPath = path.join(dir, f);
        const content = fs.readFileSync(fullPath, 'utf8');
        const parsed = JSON.parse(content);
        reports.push({
          name: f,
          date: parsed.window?.to ? parsed.window.to.slice(0, 10) : f.replace('.json', ''),
          level: parsed.level || 'ok',
          signalsCount: Array.isArray(parsed.signals) ? parsed.signals.length : 0,
          generatedAt: parsed.generatedAt || '',
        });
      } catch {}
    }

    reports.sort((a, b) => (b.generatedAt < a.generatedAt ? -1 : 1));
    return reply.status(200).send({ reports });
  });

  // GET /admin/api/watch/:name
  fastify.get<{ Params: { name: string } }>(
    '/admin/api/watch/:name',
    { preHandler: requireAdminSession },
    async (req, reply) => {
      const name = req.params.name;
      const safeNameRegex = /^(?:\d{4}-\d{2}-\d{2}|manual-[\w:.-]+)\.json$/;
      if (!safeNameRegex.test(name)) {
        return reply.status(404).send({
          error: { message: 'Watch report not found', code: 'not_found' },
        });
      }

      const dir = path.join(process.env.ROUTER_STATE_DIR || './data', 'watch');
      if (!fs.existsSync(dir)) {
        return reply.status(404).send({
          error: { message: 'Watch report not found', code: 'not_found' },
        });
      }

      const files = fs.readdirSync(dir);
      if (!files.includes(name)) {
        return reply.status(404).send({
          error: { message: 'Watch report not found', code: 'not_found' },
        });
      }

      const fullPath = path.join(dir, name);
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const parsed = JSON.parse(content);
        return reply.status(200).send(parsed);
      } catch (err: any) {
        return reply.status(500).send({
          error: { message: `Failed to read report: ${err.message}`, code: 'internal_error' },
        });
      }
    }
  );

  // POST /admin/api/watch/run
  fastify.post<{ Body: { notify?: boolean } }>(
    '/admin/api/watch/run',
    { preHandler: requireAdminSession },
    async (req, reply) => {
      const notify = Boolean(req.body?.notify);
      const result = await runWatchCheck({
        isManual: true,
        notify,
        now: Date.now(),
      });
      if (!result) {
        return reply.status(500).send({ error: { message: 'Watch check returned null unexpectedly', code: 'internal_error' } });
      }
      return reply.status(200).send(result.report);
    }
  );
};
