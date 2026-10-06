import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { FastifyInstance } from 'fastify';
import {
  budgetTokensFromUsage,
  getBudgetStatus,
  getCacheFactor,
  isOverBudget,
  recordBudgetUsage,
  reloadBudgetFromDisk,
  resetBudgetForTests,
  saveBudgetSync,
  warnBudgetOnce,
} from '../src/core/budget.js';
import { parseClientMeta } from '../src/core/client-meta.js';
import { buildApp } from '../src/index.js';
import { CONFIG } from '../src/config.js';
import { mintTenantToken } from '../src/auth/tenant-token.js';
import { queryRequests } from '../src/core/request-log.js';

describe('MiniMax Budget & Per-User Accounting', () => {
  beforeEach(() => {
    resetBudgetForTests();
    delete process.env.ROUTER_MINIMAX_CACHE_FACTOR;
    delete process.env.ROUTER_MINIMAX_USER_LIMITS;
    delete process.env.ROUTER_MINIMAX_TENANT_LIMITS;
  });

  describe('1) Cache-weighted accounting & CACHE_FACTOR', () => {
    it('calculates weighted tokens with default CACHE_FACTOR = 0.1', () => {
      // prompt: 1000, cached: 400, completion: 200
      // raw = 1000 + 200 = 1200
      // weighted = ceil((1000 - 400) + 400 * 0.1 + 200) = ceil(600 + 40 + 200) = 840
      const usage = {
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 400 },
      };
      const res = budgetTokensFromUsage(usage, 50);
      assert.equal(res.raw, 1200);
      assert.equal(res.weighted, 840);
      assert.equal(res.cached, 400);
    });

    it('clamps cached tokens to [0, prompt_tokens]', () => {
      // cached > prompt: cached 1500 > prompt 1000 -> clamped to 1000
      const usageOver = {
        prompt_tokens: 1000,
        completion_tokens: 100,
        prompt_tokens_details: { cached_tokens: 1500 },
      };
      const resOver = budgetTokensFromUsage(usageOver, 10);
      assert.equal(resOver.cached, 1000);
      assert.equal(resOver.raw, 1100);
      // weighted = ceil(0 + 1000*0.1 + 100) = 200
      assert.equal(resOver.weighted, 200);

      // cached < 0: cached -50 -> clamped to 0
      const usageNeg = {
        prompt_tokens: 500,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: -50 },
      };
      const resNeg = budgetTokensFromUsage(usageNeg, 10);
      assert.equal(resNeg.cached, 0);
      assert.equal(resNeg.raw, 550);
      assert.equal(resNeg.weighted, 550);
    });

    it('reads cache hits from alternative usage fields', () => {
      // cache_read_input_tokens (e.g. Anthropic/OpenRouter style)
      const usageAlt1 = {
        prompt_tokens: 800,
        completion_tokens: 100,
        cache_read_input_tokens: 300,
      };
      const resAlt1 = budgetTokensFromUsage(usageAlt1, 0);
      assert.equal(resAlt1.cached, 300);
      assert.equal(resAlt1.raw, 900);
      assert.equal(resAlt1.weighted, Math.ceil(500 + 30 + 100)); // 630

      // prompt_cache_hit_tokens (e.g. Qwen/DeepSeek style)
      const usageAlt2 = {
        prompt_tokens: 800,
        completion_tokens: 100,
        prompt_cache_hit_tokens: 200,
      };
      const resAlt2 = budgetTokensFromUsage(usageAlt2, 0);
      assert.equal(resAlt2.cached, 200);
      assert.equal(resAlt2.raw, 900);
      assert.equal(resAlt2.weighted, Math.ceil(600 + 20 + 100)); // 720
    });

    it('falls back to estimate when usage has no token numbers', () => {
      assert.deepEqual(budgetTokensFromUsage(null, 150), { raw: 150, weighted: 150, cached: 0 });
      assert.deepEqual(budgetTokensFromUsage({}, 250), { raw: 250, weighted: 250, cached: 0 });
      assert.deepEqual(budgetTokensFromUsage({ prompt_tokens: 'foo' as any }, 350), {
        raw: 350,
        weighted: 350,
        cached: 0,
      });
    });

    it('parses ROUTER_MINIMAX_CACHE_FACTOR with clamping and invalid fallback', () => {
      assert.equal(getCacheFactor(), 0.1);

      process.env.ROUTER_MINIMAX_CACHE_FACTOR = '0.25';
      assert.equal(getCacheFactor(), 0.25);

      process.env.ROUTER_MINIMAX_CACHE_FACTOR = 'invalid';
      assert.equal(getCacheFactor(), 0.1);

      process.env.ROUTER_MINIMAX_CACHE_FACTOR = '1.8';
      assert.equal(getCacheFactor(), 1.0);

      process.env.ROUTER_MINIMAX_CACHE_FACTOR = '-0.4';
      assert.equal(getCacheFactor(), 0.0);
    });

    it('tracks raw and weighted counters separately in state and budget status', () => {
      const now = Date.parse('2026-09-24T12:00:00.000Z');
      recordBudgetUsage('tenant-weighted', { raw: 1000, weighted: 400 }, now);

      const status = getBudgetStatus(now);
      assert.equal(status.usedCycle, 400);
      assert.equal(status.usedCycleRaw, 1000);
      assert.equal(status.usedToday, 400);
      assert.equal(status.usedTodayRaw, 1000);
      assert.equal(status.cacheFactor, 0.1);
    });
  });

  describe('2) User ID derivation in client-meta', () => {
    it('prefers x-router-user header when present', () => {
      const meta = parseClientMeta({
        'x-router-user': 'alice',
        'x-router-session': 'bob:task-1',
      });
      assert.equal(meta.user, 'alice');
    });

    it('derives user from x-router-session prefix before first colon', () => {
      const meta = parseClientMeta({
        'x-router-session': '164393c9-uuid:chat:thread-99',
      });
      assert.equal(meta.user, '164393c9-uuid');
    });

    it('returns undefined when session has no colon and x-router-user is absent', () => {
      const meta = parseClientMeta({
        'x-router-session': 'plain-session-without-colon',
      });
      assert.equal(meta.user, undefined);
    });

    it('returns undefined when session starts with a colon', () => {
      const meta = parseClientMeta({
        'x-router-session': ':starts-with-colon',
      });
      assert.equal(meta.user, undefined);
    });

    it('sanitizes user header value according to client-meta rules', () => {
      const meta = parseClientMeta({
        'x-router-user': '  user@domain-123!#$  ',
      });
      // Allowed: [A-Za-z0-9._:@/-]
      assert.equal(meta.user, 'user@domain-123');
    });
  });

  describe('3) Per-user limit isolation & enforcement', () => {
    beforeEach(() => {
      process.env.ROUTER_MINIMAX_USER_LIMITS = JSON.stringify({
        'proj-04': { day: 5_000_000, hour: 1_500_000 },
        '*': { day: 2_000_000, hour: 500_000 },
      });
      // Set tenant limit to 0 (uncapped) so per-user limits govern proj-04
      process.env.ROUTER_MINIMAX_TENANT_LIMITS = JSON.stringify({
        'proj-04': { day: 0, hour: 0 },
      });
    });

    it('records the user when called as chat.ts does: (tenant, tokens, undefined, user)', () => {
      process.env.ROUTER_MINIMAX_USER_LIMITS = JSON.stringify({ 'proj-04': { day: 1000, hour: 1000 } });
      recordBudgetUsage('proj-04', { raw: 5000, weighted: 1500 }, undefined, 'alice');
      const users = getBudgetStatus().tenants['proj-04'].users ?? [];
      assert.equal(users.length, 1);
      assert.equal(users[0].user, 'alice');
      assert.equal(users[0].dayUsed, 1500);
      assert.deepEqual(isOverBudget('proj-04', undefined, 'alice'), { reason: 'user-hour' });
      assert.equal(isOverBudget('proj-04', undefined, 'bob'), null);
      delete process.env.ROUTER_MINIMAX_USER_LIMITS;
    });

    it('isolates users: user A over hour limit does not block user B in same tenant', () => {
      const now = Date.parse('2026-09-24T10:00:00.000Z');

      // User A consumes 1.5M weighted tokens
      recordBudgetUsage('proj-04', { raw: 2_000_000, weighted: 1_500_000 }, now, 'userA');

      // User A is over budget (user-hour)
      const resA = isOverBudget('proj-04', now, 'userA');
      assert.notEqual(resA, null);
      assert.equal(resA?.reason, 'user-hour');

      // User B in proj-04 is NOT over budget
      const resB = isOverBudget('proj-04', now, 'userB');
      assert.equal(resB, null);

      // Request without user ID is NOT blocked by user limit
      const resNoUser = isOverBudget('proj-04', now);
      assert.equal(resNoUser, null);
    });

    it('detects user-day limit exceeded across hours', () => {
      const h1 = Date.parse('2026-09-24T08:00:00.000Z');
      const h2 = Date.parse('2026-09-24T09:00:00.000Z');
      const h3 = Date.parse('2026-09-24T10:00:00.000Z');
      const h4 = Date.parse('2026-09-24T11:00:00.000Z');
      const h5 = Date.parse('2026-09-24T12:00:00.000Z');

      // User A consumes 1M in each of 5 hours -> 5M total day (limit 5M)
      recordBudgetUsage('proj-04', 1_000_000, h1, 'userA');
      recordBudgetUsage('proj-04', 1_000_000, h2, 'userA');
      recordBudgetUsage('proj-04', 1_000_000, h3, 'userA');
      recordBudgetUsage('proj-04', 1_000_000, h4, 'userA');
      recordBudgetUsage('proj-04', 1_000_000, h5, 'userA');

      const h6 = Date.parse('2026-09-24T13:00:00.000Z');
      // In h6, userA has 0 hour usage, but 5M day usage
      const resA = isOverBudget('proj-04', h6, 'userA');
      assert.notEqual(resA, null);
      assert.equal(resA?.reason, 'user-day');

      // User B is still within budget
      assert.equal(isOverBudget('proj-04', h6, 'userB'), null);
    });

    it('falls back to wildcard * user limits for unlisted tenants', () => {
      const now = Date.parse('2026-09-24T10:00:00.000Z');
      // unlisted tenant uses wildcard limit: hour: 500_000
      recordBudgetUsage('unlisted-tenant', 500_000, now, 'alice');

      const res = isOverBudget('unlisted-tenant', now, 'alice');
      assert.notEqual(res, null);
      assert.equal(res?.reason, 'user-hour');
    });

    it('enforces check order: user-hour -> user-day -> tenant-hour -> tenant-day -> global-day -> cycle', () => {
      process.env.ROUTER_MINIMAX_TENANT_LIMITS = JSON.stringify({
        'order-test': { day: 2_000_000, hour: 1_000_000 },
      });
      process.env.ROUTER_MINIMAX_USER_LIMITS = JSON.stringify({
        'order-test': { day: 1_500_000, hour: 500_000 },
      });

      const now = Date.parse('2026-09-24T10:00:00.000Z');
      // Record 1.5M for userA: triggers user-hour (500k), user-day (1.5M), tenant-hour (1M)
      recordBudgetUsage('order-test', 1_500_000, now, 'userA');

      const res = isOverBudget('order-test', now, 'userA');
      assert.equal(res?.reason, 'user-hour');
    });

    it('keys warnBudgetOnce by tenant+user so users do not hide each other', () => {
      const now = Date.parse('2026-09-24T10:00:00.000Z');
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(' '));

      try {
        warnBudgetOnce('proj-04', 'user-hour', 'userA', now);
        assert.equal(warnings.length, 1);
        assert.ok(warnings[0].includes('[budget] proj-04 user=userA over (user-hour) → MiniMax skipped'));

        // userA again in the same hour is throttled
        warnBudgetOnce('proj-04', 'user-hour', 'userA', now + 60_000);
        assert.equal(warnings.length, 1);

        // userB in proj-04 is NOT throttled
        warnBudgetOnce('proj-04', 'user-hour', 'userB', now + 60_000);
        assert.equal(warnings.length, 2);
        assert.ok(warnings[1].includes('[budget] proj-04 user=userB over (user-hour) → MiniMax skipped'));

        // no user -> user=-
        warnBudgetOnce('master-service', 'tenant-hour', undefined, now);
        assert.equal(warnings.length, 3);
        assert.ok(warnings[2].includes('[budget] master-service user=- over (tenant-hour) → MiniMax skipped'));
      } finally {
        console.warn = origWarn;
      }
    });

    it('populates users list in getBudgetStatus() sorted by dayUsed desc', () => {
      const now = Date.parse('2026-09-24T10:00:00.000Z');
      recordBudgetUsage('proj-04', 100_000, now, 'userSmall');
      recordBudgetUsage('proj-04', 900_000, now, 'userBig');
      recordBudgetUsage('proj-04', 500_000, now, 'userMed');

      const status = getBudgetStatus(now);
      const tenantStatus = status.tenants['proj-04'];
      assert.ok(tenantStatus);
      assert.ok(tenantStatus.users);
      assert.equal(tenantStatus.users.length, 3);

      // Verify sorted by dayUsed desc
      assert.equal(tenantStatus.users[0].user, 'userBig');
      assert.equal(tenantStatus.users[0].dayUsed, 900_000);
      assert.equal(tenantStatus.users[1].user, 'userMed');
      assert.equal(tenantStatus.users[2].user, 'userSmall');
    });
  });

  describe('4) Tenant limit 0 = uncapped', () => {
    it('tenant limit of 0 disables hourly and daily tenant caps', () => {
      process.env.ROUTER_MINIMAX_TENANT_LIMITS = JSON.stringify({
        'proj-uncapped': { day: 0, hour: 0 },
      });

      const now = Date.parse('2026-09-24T10:00:00.000Z');
      // Record 10M tokens in an hour
      recordBudgetUsage('proj-uncapped', 10_000_000, now);

      const res = isOverBudget('proj-uncapped', now);
      // Not blocked by tenant-hour or tenant-day
      assert.notEqual(res?.reason, 'tenant-hour');
      assert.notEqual(res?.reason, 'tenant-day');
    });
  });

  describe('5) Old state file compatibility', () => {
    let tmpDir: string;
    const oldDir = process.env.ROUTER_STATE_DIR;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-compat-test-'));
      process.env.ROUTER_STATE_DIR = tmpDir;
    });

    after(() => {
      if (oldDir) {
        process.env.ROUTER_STATE_DIR = oldDir;
      } else {
        delete process.env.ROUTER_STATE_DIR;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('loads old budget.json without usedCycleRaw or __raw__ or user buckets seamlessly', () => {
      const oldState = {
        currentCycleStart: '2026-09-24',
        usedCycle: 750000,
        daily: {
          '2026-09-24': {
            'old-tenant': 750000,
            __total__: 750000,
          },
        },
        hourly: {
          '2026-09-24T10': {
            'old-tenant': 750000,
          },
        },
      };

      fs.writeFileSync(path.join(tmpDir, 'budget.json'), JSON.stringify(oldState), 'utf-8');

      // Re-initialize budget module state from file
      reloadBudgetFromDisk();
      const now = Date.parse('2026-09-24T10:30:00.000Z');
      const status = getBudgetStatus(now);

      assert.equal(status.usedCycle, 750000);
      assert.equal(status.usedCycleRaw, 750000); // starts from usedCycle
      assert.equal(status.usedToday, 750000);
      assert.equal(status.usedTodayRaw, 750000); // starts from __total__

      // New record increments correctly
      recordBudgetUsage('old-tenant', { raw: 1000, weighted: 200 }, now, 'alice');
      saveBudgetSync();

      const updated = getBudgetStatus(now);
      assert.equal(updated.usedCycle, 750200);
      assert.equal(updated.usedCycleRaw, 751000);
      assert.equal(updated.usedToday, 750200);
      assert.equal(updated.usedTodayRaw, 751000);
    });
  });

  describe('6) text-high over-budget excludes local 7B and returns 503 budget_exceeded on failure', () => {
    let app: FastifyInstance;
    let mockBackend: http.Server;
    let backendPort: number;
    const requestedModels: string[] = [];
    const testSecret = 'secret-test-key-999';
    const tenantToken = mintTenantToken('test-budget-tenant', testSecret);

    before(async () => {
      CONFIG.serviceApiKey = testSecret;
      CONFIG.tenantTokenSecret = testSecret;
      process.env.PF_MODELS_TOKEN = 'mock-backend2-token';

      mockBackend = http.createServer((req, res) => {
        let rawBody = '';
        req.on('data', (chunk) => (rawBody += chunk));
        req.on('end', () => {
          try {
            const p = JSON.parse(rawBody || '{}');
            if (p.model) requestedModels.push(p.model);
          } catch {}
          // Return 500 on all endpoints to simulate backend failure
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'upstream boom' } }));
        });
      });

      await new Promise<void>((resolve) => {
        mockBackend.listen(0, '127.0.0.1', () => {
          backendPort = (mockBackend.address() as { port: number }).port;
          resolve();
        });
      });

      CONFIG.backend2BaseUrl = `http://127.0.0.1:${backendPort}`;
      CONFIG.cloudBaseUrl = `http://127.0.0.1:${backendPort}`;
      CONFIG.localOllamaBaseUrl = `http://127.0.0.1:${backendPort}`;

      app = buildApp();
      await app.ready();
    });

    after(async () => {
      delete process.env.PF_MODELS_TOKEN;
      await app.close();
      await new Promise<void>((resolve) => mockBackend.close(() => resolve()));
    });

    it('returns 503 budget_exceeded with rate_limit_error and budget header when over budget', async () => {
      requestedModels.length = 0;
      const now = Date.now();
      // Push test-budget-tenant over tenant-hour limit (default limit is 1,000,000)
      recordBudgetUsage('test-budget-tenant', 1_500_000, now);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${tenantToken}`,
          'x-router-app': 'test-app',
          'x-router-agent': 'test-agent',
          'x-router-session': 'user-123:sess-456',
        },
        payload: {
          model: 'text-high',
          messages: [{ role: 'user', content: 'hello text-high' }],
        },
      });

      assert.equal(res.statusCode, 503);
      assert.equal(res.headers['x-router-budget'], 'exceeded; reason=tenant-hour');

      const body = JSON.parse(res.body);
      assert.equal(body.error?.code, 'budget_exceeded');
      assert.equal(body.error?.type, 'rate_limit_error');
      assert.ok(body.error?.message.includes('tenant-hour'));
      assert.ok(body.error?.message.includes('fallback backends were unavailable'));

      // Verify that local ollama 7B (qwen2.5:7b-64k) was NOT attempted
      assert.equal(requestedModels.includes('qwen2.5:7b-64k'), false);
      // But backend2 models were attempted
      assert.ok(requestedModels.includes('gemini-3.1-pro-low') || requestedModels.includes('claude-sonnet-4-6'));

      // Check request log
      const logs = queryRequests({ tenant: 'test-budget-tenant' }, { limit: 1 });
      assert.equal(logs.items.length, 1);
      assert.equal(logs.items[0].errorCode, 'budget_exceeded');
      assert.equal(logs.items[0].user, 'user-123');
    });
  });
});
