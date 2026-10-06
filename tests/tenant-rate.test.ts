import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { CONFIG } from '../src/config.js';
import { mintTenantToken } from '../src/auth/tenant-token.js';
import {
  checkTenantRate,
  getTenantRateUsage,
  saveTenantUsageSync,
  resetTenantRateForTests,
  setTenantRateClock,
} from '../src/core/tenant-rate.js';
import {
  upsertTenant,
  resetTenantsForTests,
} from '../src/core/tenants.js';
import {
  onRouterEvent,
  getRecentRouterEvents,
  resetRouterEventsForTests,
} from '../src/core/events.js';
import { queryRequests } from '../src/core/request-log.js';

describe('Per-Tenant Rate Limits (tests/tenant-rate.test.ts)', () => {
  let app: FastifyInstance;
  let tmpDir: string;
  const originalStateDir = process.env.ROUTER_STATE_DIR;
  const masterKey = 'test-rate-master-key-1111';
  const tenantSecret = 'test-rate-tenant-secret-2222';

  before(async () => {
    CONFIG.serviceApiKey = masterKey;
    CONFIG.tenantTokenSecret = tenantSecret;
    CONFIG.cloudBaseUrl = 'http://127.0.0.1:1';
    CONFIG.localOllamaBaseUrl = 'http://127.0.0.1:1';
    CONFIG.backend2BaseUrl = 'http://127.0.0.1:1';
  });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-rate-test-'));
    process.env.ROUTER_STATE_DIR = tmpDir;
    resetTenantsForTests();
    resetTenantRateForTests();
    resetRouterEventsForTests();

    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    resetTenantsForTests();
    resetTenantRateForTests();
    resetRouterEventsForTests();
    setTenantRateClock(null);
    if (originalStateDir !== undefined) {
      process.env.ROUTER_STATE_DIR = originalStateDir;
    } else {
      delete process.env.ROUTER_STATE_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('RPM Sliding Window', () => {
    it('enforces rpm limit and sets retry-after and x-router-limit headers', () => {
      upsertTenant({
        id: 'tenant-rpm',
        status: 'active',
        limits: {
          rate: { rpm: 2 },
        },
        createdAt: '',
        updatedAt: '',
      });

      let now = 100_000;
      setTenantRateClock(() => now);

      // Request 1 passes
      const r1 = checkTenantRate('tenant-rpm', undefined, now);
      assert.equal(r1.ok, true);
      if (r1.ok) r1.release();

      // Request 2 passes
      now += 10_000;
      const r2 = checkTenantRate('tenant-rpm', undefined, now);
      assert.equal(r2.ok, true);
      if (r2.ok) r2.release();

      // Request 3 is rejected: 2 requests already in 60s window
      now += 10_000; // now is 120_000. Oldest request was at 100_000 (expires at 160_000 -> 40s left)
      const r3 = checkTenantRate('tenant-rpm', undefined, now);
      assert.equal(r3.ok, false);
      if (!r3.ok) {
        assert.equal(r3.errorCode, 'rate_limited');
        assert.equal(r3.limit, 'rpm');
        assert.equal(r3.retryAfterSec, 40);
      }

      // Advance clock past the first request's expiry (100_000 + 60_000 = 160_000)
      now = 161_000;
      const r4 = checkTenantRate('tenant-rpm', undefined, now);
      assert.equal(r4.ok, true);
      if (r4.ok) r4.release();
    });

    it('agent-specific rpm overrides tenant rpm', () => {
      upsertTenant({
        id: 'tenant-agent-rpm',
        status: 'active',
        limits: {
          rate: { rpm: 10 },
          agents: {
            'burst-agent': {
              rate: { rpm: 1 },
            },
          },
        },
        createdAt: '',
        updatedAt: '',
      });

      let now = 200_000;
      setTenantRateClock(() => now);

      // Normal tenant call (without agent) has rpm: 10
      const r1 = checkTenantRate('tenant-agent-rpm', undefined, now);
      assert.equal(r1.ok, true);
      if (r1.ok) r1.release();

      // Burst agent has rpm: 1
      const a1 = checkTenantRate('tenant-agent-rpm', 'burst-agent', now);
      assert.equal(a1.ok, true);
      if (a1.ok) a1.release();

      // Second call from burst agent trips rpm: 1
      const a2 = checkTenantRate('tenant-agent-rpm', 'burst-agent', now);
      assert.equal(a2.ok, false);
      if (!a2.ok) {
        assert.equal(a2.errorCode, 'rate_limited');
      }
    });
  });

  describe('Concurrent In-Flight Limit & Release', () => {
    it('enforces concurrent slot limit and returns too_many_concurrent', () => {
      upsertTenant({
        id: 'tenant-conc',
        status: 'active',
        limits: {
          rate: { concurrent: 1 },
        },
        createdAt: '',
        updatedAt: '',
      });

      const r1 = checkTenantRate('tenant-conc');
      assert.equal(r1.ok, true);

      // Second concurrent request blocked
      const r2 = checkTenantRate('tenant-conc');
      assert.equal(r2.ok, false);
      if (!r2.ok) {
        assert.equal(r2.errorCode, 'too_many_concurrent');
        assert.equal(r2.limit, 'concurrent');
        assert.equal(r2.retryAfterSec, 1);
      }

      // Release r1 slot idempotently
      if (r1.ok) {
        r1.release();
        r1.release(); // Calling again does not cause negative count
      }

      // Now next request is allowed
      const r3 = checkTenantRate('tenant-conc');
      assert.equal(r3.ok, true);
      if (r3.ok) r3.release();
    });
  });

  describe('Daily Request Limit & Persistence', () => {
    it('enforces dayRequests limit and persists counts to tenant-usage.json', () => {
      upsertTenant({
        id: 'tenant-day',
        status: 'active',
        limits: {
          rate: { dayRequests: 2 },
        },
        createdAt: '',
        updatedAt: '',
      });

      let now = 300_000;
      setTenantRateClock(() => now);

      const r1 = checkTenantRate('tenant-day', undefined, now);
      assert.equal(r1.ok, true);
      if (r1.ok) r1.release();

      const r2 = checkTenantRate('tenant-day', undefined, now);
      assert.equal(r2.ok, true);
      if (r2.ok) r2.release();

      // 3rd request trips daily limit
      const r3 = checkTenantRate('tenant-day', undefined, now);
      assert.equal(r3.ok, false);
      if (!r3.ok) {
        assert.equal(r3.errorCode, 'daily_request_limit');
        assert.equal(r3.limit, 'day');
        assert.ok(r3.retryAfterSec > 0);
      }

      // Persist usage to disk
      saveTenantUsageSync();

      const usageFile = path.join(tmpDir, 'tenant-usage.json');
      assert.ok(fs.existsSync(usageFile), 'tenant-usage.json must be written');
      const data = JSON.parse(fs.readFileSync(usageFile, 'utf-8'));
      assert.equal(data.version, 1);
      const today = new Date(now).toISOString().slice(0, 10);
      assert.equal(data.daily[today]['tenant-day'], 2);
    });

    it('emits limit.warning when dayRequests reaches 80%', () => {
      upsertTenant({
        id: 'tenant-warning',
        status: 'active',
        limits: {
          rate: { dayRequests: 5 }, // 80% of 5 is 4
        },
        createdAt: '',
        updatedAt: '',
      });

      let now = 400_000;
      setTenantRateClock(() => now);

      const warnings: any[] = [];
      const unsubscribe = onRouterEvent((ev) => {
        if (ev.type === 'limit.warning') {
          warnings.push(ev);
        }
      });

      for (let i = 1; i <= 3; i++) {
        const res = checkTenantRate('tenant-warning', undefined, now);
        if (res.ok) res.release();
      }
      // 3 requests = 60%, no warning yet
      assert.equal(warnings.length, 0);

      // 4th request reaches 80% (4 / 5 >= 0.8)
      const res4 = checkTenantRate('tenant-warning', undefined, now);
      if (res4.ok) res4.release();
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].type, 'limit.warning');
      assert.equal(warnings[0].tenantId, 'tenant-warning');
      assert.equal(warnings[0].limit, 'day');
      assert.equal(warnings[0].percent, 80);

      // 5th request does not re-emit warning (deduped once per day)
      const res5 = checkTenantRate('tenant-warning', undefined, now);
      if (res5.ok) res5.release();
      assert.equal(warnings.length, 1);

      unsubscribe();
    });
  });

  describe('Fastify HTTP Integration with /v1/chat/completions and /v1/embeddings', () => {
    it('returns 429 with retry-after and x-router-limit on chat completions', async () => {
      upsertTenant({
        id: 'tenant-http-rate',
        status: 'active',
        limits: {
          rate: { rpm: 1 },
        },
        createdAt: '',
        updatedAt: '',
      });

      const token = mintTenantToken('tenant-http-rate', tenantSecret);

      // Request 1: passes rate check (fails model forwarding/pool check, but rate slot was consumed)
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'text-low',
          messages: [{ role: 'user', content: 'hello' }],
        },
      });
      assert.notEqual(res1.statusCode, 429);

      // Request 2: trips rpm limit
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'text-low',
          messages: [{ role: 'user', content: 'hello' }],
        },
      });

      assert.equal(res2.statusCode, 429);
      assert.equal(res2.headers['x-router-limit'], 'rpm');
      assert.ok(res2.headers['retry-after']);
      const body = JSON.parse(res2.body);
      assert.equal(body.error.code, 'rate_limited');

      // Check request log
      const logs = queryRequests({ tenant: 'tenant-http-rate' });
      const rateLog = logs.items.find(l => l.status === 429 && l.errorCode === 'rate_limited');
      assert.ok(rateLog, 'Must record 429 in request log');
    });

    it('returns 429 with x-router-limit on embeddings', async () => {
      upsertTenant({
        id: 'tenant-emb-rate',
        status: 'active',
        limits: {
          rate: { rpm: 1 },
        },
        createdAt: '',
        updatedAt: '',
      });

      const token = mintTenantToken('tenant-emb-rate', tenantSecret);

      await app.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'text-embed',
          input: 'test text',
        },
      });

      // Second request trips rpm
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'text-embed',
          input: 'test text 2',
        },
      });

      assert.equal(res2.statusCode, 429);
      assert.equal(res2.headers['x-router-limit'], 'rpm');
    });

    it('emits limit.reached router event on rate limit rejection', async () => {
      upsertTenant({
        id: 'tenant-ev-rate',
        status: 'active',
        limits: {
          rate: { rpm: 1 },
        },
        createdAt: '',
        updatedAt: '',
      });

      const token = mintTenantToken('tenant-ev-rate', tenantSecret);

      let eventCaptured: any = null;
      const unsubscribe = onRouterEvent((ev) => {
        if (ev.type === 'limit.reached') {
          eventCaptured = ev;
        }
      });

      // First request
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { model: 'text-low', messages: [{ role: 'user', content: 'test' }] },
      });

      // Second request triggers 429 and event
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { model: 'text-low', messages: [{ role: 'user', content: 'test' }] },
      });

      unsubscribe();

      assert.ok(eventCaptured, 'limit.reached event must be emitted');
      assert.equal(eventCaptured.type, 'limit.reached');
      assert.equal(eventCaptured.tenantId, 'tenant-ev-rate');
      assert.equal(eventCaptured.limit, 'rpm');
    });
  });

  describe('getTenantRateUsage', () => {
    it('returns current rpm window count, in-flight count, and today requests count', () => {
      const now = 500_000;
      setTenantRateClock(() => now);

      const r1 = checkTenantRate('tenant-stat', undefined, now);
      const status1 = getTenantRateUsage('tenant-stat', now);
      assert.equal(status1.inFlight, 1);
      assert.equal(status1.rpmWindow, 1);
      assert.equal(status1.dayRequests, 1);

      if (r1.ok) r1.release();
      const status2 = getTenantRateUsage('tenant-stat', now);
      assert.equal(status2.inFlight, 0);
      assert.equal(status2.rpmWindow, 1);
      assert.equal(status2.dayRequests, 1);
    });
  });
});
