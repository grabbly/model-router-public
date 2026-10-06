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
  getBudgetStatus,
  getDailyGlobalAllowance,
  getQuotaStatus,
  isOverBudget,
  recordBudgetUsage,
  reloadBudgetFromDisk,
  resetBudgetForTests,
  setBudgetClock,
} from '../src/core/budget.js';

describe('Dynamic MiniMax Budget Quota API (/v1/budget/quota)', () => {
  let app: FastifyInstance;
  const testSecret = 'quota-test-secret-key-12345';
  const tokenProj1 = mintTenantToken('proj-01', testSecret);
  const tokenProj2 = mintTenantToken('proj-02', testSecret);
  const tokenOther = mintTenantToken('proj-unlisted', testSecret);

  before(async () => {
    CONFIG.serviceApiKey = testSecret;
    CONFIG.tenantTokenSecret = testSecret;
    app = buildApp();
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetBudgetForTests();
    delete process.env.ROUTER_MINIMAX_QUOTA_MAX;
    delete process.env.ROUTER_MINIMAX_QUOTA_RESERVE_SHARE;
    delete process.env.ROUTER_MINIMAX_TENANT_LIMITS;
    delete process.env.ROUTER_MINIMAX_USER_LIMITS;
  });

  describe('1) Authentication', () => {
    it('requires auth for PUT, GET, and DELETE (returns 401 without token)', async () => {
      const putRes = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        payload: { day: 10_000_000 },
      });
      assert.equal(putRes.statusCode, 401);
      assert.equal(putRes.json().error?.code, 'unauthorized');

      const getRes = await app.inject({
        method: 'GET',
        url: '/v1/budget/quota',
      });
      assert.equal(getRes.statusCode, 401);
      assert.equal(getRes.json().error?.code, 'unauthorized');

      const delRes = await app.inject({
        method: 'DELETE',
        url: '/v1/budget/quota',
      });
      assert.equal(delRes.statusCode, 401);
      assert.equal(delRes.json().error?.code, 'unauthorized');
    });

    it('rejects invalid bearer token with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/budget/quota',
        headers: { authorization: 'Bearer invalid.token.garbage' },
      });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error?.code, 'unauthorized');
    });
  });

  describe('2) Tenant permission check (ROUTER_MINIMAX_QUOTA_MAX)', () => {
    it('returns 403 quota_not_allowed when tenant is not listed and no wildcard', async () => {
      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({
        'proj-01': { dayShare: 0.5, hourShare: 0.15 },
      });

      const res = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenOther}` },
        payload: { day: 10_000_000 },
      });
      assert.equal(res.statusCode, 403);
      const json = res.json();
      assert.equal(json.error?.code, 'quota_not_allowed');
    });

    it('allows tenant explicitly listed in ROUTER_MINIMAX_QUOTA_MAX', async () => {
      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({
        'proj-01': { dayShare: 0.5, hourShare: 0.15 },
      });

      const res = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: { day: 10_000_000 },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().tenant, 'proj-01');
    });

    it('allows any tenant when wildcard * is configured', async () => {
      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({
        '*': { dayShare: 0.4, hourShare: 0.1 },
      });

      const res = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenOther}` },
        payload: { day: 5_000_000 },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().tenant, 'proj-unlisted');
    });
  });

  describe('3) Input validation (400 invalid_request_error)', () => {
    beforeEach(() => {
      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({
        '*': { dayShare: 0.5, hourShare: 0.2 },
      });
    });

    it('rejects empty payload or payload with only ttlSec', async () => {
      const resEmpty = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: {},
      });
      assert.equal(resEmpty.statusCode, 400);
      assert.equal(resEmpty.json().error?.type, 'invalid_request_error');

      const resTtlOnly = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: { ttlSec: 3600 },
      });
      assert.equal(resTtlOnly.statusCode, 400);
      assert.equal(resTtlOnly.json().error?.type, 'invalid_request_error');
    });

    it('rejects negative, zero, float, or non-number values for day and hour', async () => {
      for (const badVal of [-1, 0, 1.5, '1000', null]) {
        const resDay = await app.inject({
          method: 'PUT',
          url: '/v1/budget/quota',
          headers: { authorization: `Bearer ${tokenProj1}` },
          payload: { day: badVal as any },
        });
        assert.equal(resDay.statusCode, 400, `Expected 400 for day=${badVal}`);

        const resHour = await app.inject({
          method: 'PUT',
          url: '/v1/budget/quota',
          headers: { authorization: `Bearer ${tokenProj1}` },
          payload: { hour: badVal as any },
        });
        assert.equal(resHour.statusCode, 400, `Expected 400 for hour=${badVal}`);
      }
    });

    it('rejects invalid user limits object', async () => {
      const resBadUser = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: { user: {} },
      });
      assert.equal(resBadUser.statusCode, 400);

      const resNegativeUser = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: { user: { day: -50 } },
      });
      assert.equal(resNegativeUser.statusCode, 400);
    });

    it('rejects invalid ttlSec values', async () => {
      const resBadTtl = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: { day: 10_000_000, ttlSec: -10 },
      });
      assert.equal(resBadTtl.statusCode, 400);
    });
  });

  describe('4) Rate limiting (429 quota_rate_limited)', () => {
    beforeEach(() => {
      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({
        '*': { dayShare: 0.5, hourShare: 0.2 },
      });
    });

    it('allows at most one successful PUT per tenant per 60s', async () => {
      const now = Date.parse('2026-09-24T12:00:00.000Z');
      setBudgetClock(() => now);

      // First PUT succeeds
      const res1 = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: { day: 10_000_000 },
      });
      assert.equal(res1.statusCode, 200);

      // Immediate second PUT from same tenant is rate-limited
      const res2 = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: { day: 12_000_000 },
      });
      assert.equal(res2.statusCode, 429);
      assert.equal(res2.json().error?.code, 'quota_rate_limited');
      assert.ok(res2.headers['retry-after']);
      assert.equal(Number(res2.headers['retry-after']), 60);

      // GET is not limited
      const resGet = await app.inject({
        method: 'GET',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
      });
      assert.equal(resGet.statusCode, 200);

      // Different tenant is not limited
      const resTenant2 = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj2}` },
        payload: { day: 5_000_000 },
      });
      assert.equal(resTenant2.statusCode, 200);

      // After 60s, first tenant can PUT again
      setBudgetClock(() => now + 61_000);
      const res3 = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: { day: 15_000_000 },
      });
      assert.equal(res3.statusCode, 200);
    });
  });

  describe('5) Grant clamping: owner-max, capacity with two tenants, reserve', () => {
    it('clamps by owner-max and sets limitedBy = owner-max', async () => {
      // 2026-09-24T12:00:00Z -> day 1 of 30 -> todayAllowance = floor(1.7B / 30) = 56,666,666
      const now = Date.parse('2026-09-24T12:00:00.000Z');
      setBudgetClock(() => now);

      // proj-01 dayShare: 0.2 -> ownerMaxDay = floor(0.2 * 56,666,666) = 11,333,333
      // hourShare: 0.05 -> ownerMaxHour = floor(0.05 * 56,666,666) = 2,833,333
      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({
        'proj-01': { dayShare: 0.2, hourShare: 0.05 },
      });

      const res = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: { day: 20_000_000, hour: 5_000_000 },
      });
      assert.equal(res.statusCode, 200);
      const data = res.json();
      assert.equal(data.granted.day, 11_333_333);
      assert.equal(data.granted.hour, 2_833_333);
      assert.equal(data.limitedBy, 'owner-max');
    });

    it('clamps by capacity across two tenants respecting reserve share', async () => {
      const now = Date.parse('2026-09-24T12:00:00.000Z');
      setBudgetClock(() => now);

      // Allowance today = 56,666,666
      // Reserve share = 0.2 -> (1 - 0.2) * 56,666,666 = 45,333,332 max for all active day grants
      process.env.ROUTER_MINIMAX_QUOTA_RESERVE_SHARE = '0.2';
      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({
        '*': { dayShare: 0.8, hourShare: 0.3 },
      });

      // Tenant 1 requests 30,000,000 day
      // Capacity = 45,333,332 - 0 = 45,333,332 -> gets full 30,000,000
      const res1 = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: { day: 30_000_000 },
      });
      assert.equal(res1.statusCode, 200);
      const data1 = res1.json();
      assert.equal(data1.granted.day, 30_000_000);
      assert.equal(data1.limitedBy, null);

      // Tenant 2 requests 25,000,000 day
      // Remaining capacity = 45,333,332 - 30,000,000 = 15,333,332
      // Owner max day for tenant 2 = floor(0.8 * 56,666,666) = 45,333,332
      // Capacity (15,333,332) < ownerMax (45,333,332) -> clamped by capacity!
      const res2 = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj2}` },
        payload: { day: 25_000_000 },
      });
      assert.equal(res2.statusCode, 200);
      const data2 = res2.json();
      assert.equal(data2.granted.day, 15_333_332);
      assert.equal(data2.limitedBy, 'capacity');

      // Verify active sum <= (1 - reserve) * allowance
      assert.ok(data1.granted.day + data2.granted.day <= 45_333_333);
    });

    it('a zero grant (capacity exhausted) blocks MiniMax instead of meaning no cap', async () => {
      const now = Date.parse('2026-09-24T12:00:00.000Z');
      setBudgetClock(() => now);
      process.env.ROUTER_MINIMAX_QUOTA_RESERVE_SHARE = '0.2';
      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({ '*': { dayShare: 0.8 } });

      const res1 = await app.inject({
        method: 'PUT', url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: { day: 45_333_332 },
      });
      assert.equal(res1.json().granted.day, 45_333_332);

      const res2 = await app.inject({
        method: 'PUT', url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj2}` },
        payload: { day: 10_000_000 },
      });
      const data2 = res2.json();
      assert.equal(data2.granted.day, 0);
      assert.equal(data2.limitedBy, 'capacity');
      // hourShare defaults to dayShare, so the hour grant is finite too
      assert.ok(data2.granted.hour > 0);
      assert.deepEqual(isOverBudget('proj-02', now), { reason: 'tenant-day' });
    });

    it('a user-only request still clamps the day window when config day is 0 (no cap)', async () => {
      const now = Date.parse('2026-09-24T12:00:00.000Z');
      setBudgetClock(() => now);
      process.env.ROUTER_MINIMAX_TENANT_LIMITS = JSON.stringify({ 'proj-01': { day: 0, hour: 0 } });
      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({ 'proj-01': { dayShare: 0.5, hourShare: 0.1 } });

      const res = await app.inject({
        method: 'PUT', url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: { user: { day: 1_000_000 } },
      });
      const data = res.json();
      assert.equal(data.granted.day, Math.floor(0.5 * 56_666_666));
      assert.equal(data.granted.hour, Math.floor(0.1 * 56_666_666));
      assert.equal(data.granted.user.day, 1_000_000);
    });

    it('clamps user limits to granted tenant limits', async () => {
      const now = Date.parse('2026-09-24T12:00:00.000Z');
      setBudgetClock(() => now);

      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({
        '*': { dayShare: 0.5, hourShare: 0.2 },
      });

      const res = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: {
          day: 10_000_000,
          hour: 2_000_000,
          user: { day: 15_000_000, hour: 3_000_000 },
        },
      });
      assert.equal(res.statusCode, 200);
      const data = res.json();
      assert.equal(data.granted.day, 10_000_000);
      assert.equal(data.granted.hour, 2_000_000);
      assert.equal(data.granted.user.day, 10_000_000);
      assert.equal(data.granted.user.hour, 2_000_000);
    });
  });

  describe('6) TTL expiry & reverts to config', () => {
    beforeEach(() => {
      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({
        '*': { dayShare: 0.5, hourShare: 0.2 },
      });
    });

    it('expires grant after ttlSec and reverts to configured limits', async () => {
      const now = Date.parse('2026-09-24T12:00:00.000Z');
      setBudgetClock(() => now);

      // PUT with ttlSec: 600 (10 minutes)
      const resPut = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: { day: 12_000_000, ttlSec: 600 },
      });
      assert.equal(resPut.statusCode, 200);
      assert.equal(resPut.json().effective.source, 'grant');
      assert.equal(resPut.json().effective.day, 12_000_000);

      // Advance clock past expiration (10 minutes + 5 seconds)
      setBudgetClock(() => now + 605_000);

      // GET should now show source = 'config' and grant reverted
      const resGet = await app.inject({
        method: 'GET',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
      });
      assert.equal(resGet.statusCode, 200);
      const data = resGet.json();
      assert.equal(data.effective.source, 'config');
      assert.equal(data.requested, null);
      assert.equal(data.granted, null);
      assert.equal(data.limitedBy, null);
      assert.equal(data.expiresAt, null);
      // Default config tenant day limit is 5,000,000
      assert.equal(data.effective.day, 5_000_000);
    });
  });

  describe('7) Grant overrides in isOverBudget & check-time clamping', () => {
    beforeEach(() => {
      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({
        'proj-01': { dayShare: 0.5, hourShare: 0.2 },
      });
    });

    it('overrides config limits via PUT and checks isOverBudget', async () => {
      const now = Date.parse('2026-09-24T12:00:00.000Z');
      setBudgetClock(() => now);

      process.env.ROUTER_MINIMAX_TENANT_LIMITS = JSON.stringify({
        'proj-01': { day: 5_000_000, hour: 0 },
      });
      process.env.ROUTER_MINIMAX_USER_LIMITS = JSON.stringify({
        'proj-01': { day: 200_000, hour: 0 },
      });

      // Tenant total usage: 6M (exceeds config 5M)
      // Alice usage: 300k (exceeds user day config 200k)
      recordBudgetUsage('proj-01', 5_700_000, now);
      recordBudgetUsage('proj-01', 300_000, now, 'alice');

      assert.equal(isOverBudget('proj-01', now, 'alice')?.reason, 'user-day');
      assert.equal(isOverBudget('proj-01', now)?.reason, 'tenant-day');

      const res = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: {
          day: 20_000_000,
          hour: 10_000_000,
          user: { day: 1_000_000, hour: 500_000 },
        },
      });
      assert.equal(res.statusCode, 200);

      // Now within budget!
      assert.equal(isOverBudget('proj-01', now, 'alice'), null);
      assert.equal(isOverBudget('proj-01', now), null);
    });

    it('further clamps stored grant to todays ownerMax at check time', async () => {
      const day1 = Date.parse('2026-09-24T12:00:00.000Z');
      setBudgetClock(() => day1);

      // On day 1, todayAllowance = 56,666,666. Owner dayShare = 0.5, hourShare = 0.5
      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({
        'proj-01': { dayShare: 0.5, hourShare: 0.5 },
      });

      // Grant 25,000,000 day and 10,000,000 hour with 2 days TTL
      await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: { day: 25_000_000, hour: 10_000_000, ttlSec: 172800 },
      });

      // Now simulate day 2 where ownerMax configuration is lowered (or allowance dropped)
      // e.g. owner lowers dayShare to 0.1 on day 2, keeps hourShare at 0.5
      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({
        'proj-01': { dayShare: 0.1, hourShare: 0.5 },
      });
      // dayShare 0.1 * ~56.6M = ~5.66M
      const day2 = Date.parse('2026-09-25T12:00:00.000Z');
      setBudgetClock(() => day2);

      // Record 7M usage on day 2 (less than 10M hour limit, but greater than ~5.66M ownerMaxDay)
      recordBudgetUsage('proj-01', 7_000_000, day2);

      // isOverBudget should clamp stored grant (25M) down to today's ownerMax (~5.66M) -> tenant-day!
      const resOver = isOverBudget('proj-01', day2);
      assert.notEqual(resOver, null);
      assert.equal(resOver?.reason, 'tenant-day');
    });
  });

  describe('8) GET & DELETE', () => {
    beforeEach(() => {
      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({
        '*': { dayShare: 0.5, hourShare: 0.2 },
      });
    });

    it('returns complete JSON response on GET and drops grant on DELETE', async () => {
      const now = Date.parse('2026-09-24T12:00:00.000Z');
      setBudgetClock(() => now);

      await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: { day: 15_000_000, hour: 3_000_000 },
      });

      const getRes = await app.inject({
        method: 'GET',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
      });
      assert.equal(getRes.statusCode, 200);
      const data = getRes.json();
      assert.equal(data.tenant, 'proj-01');
      assert.deepEqual(data.requested, { day: 15_000_000, hour: 3_000_000 });
      assert.equal(data.granted.day, 15_000_000);
      assert.equal(data.effective.source, 'grant');
      assert.ok(data.cycle);
      assert.equal(data.cycle.total, 1_700_000_000);
      assert.ok(data.cycle.todayAllowance > 0);
      assert.ok(data.usage);

      // DELETE drops the grant
      const delRes = await app.inject({
        method: 'DELETE',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
      });
      assert.equal(delRes.statusCode, 200);
      assert.equal(delRes.json().ok, true);

      // Subsequent GET shows config limits
      const getAfterDel = await app.inject({
        method: 'GET',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
      });
      assert.equal(getAfterDel.json().effective.source, 'config');
      assert.equal(getAfterDel.json().requested, null);
      assert.equal(getAfterDel.json().granted, null);
    });
  });

  describe('9) Persistence roundtrip', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-quota-test-'));
      process.env.ROUTER_STATE_DIR = tmpDir;
      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({
        '*': { dayShare: 0.5, hourShare: 0.2 },
      });
    });

    afterEach(() => {
      if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('persists quotas to budget.json and reloads on startup / reloadBudgetFromDisk', async () => {
      const now = Date.parse('2026-09-24T12:00:00.000Z');
      setBudgetClock(() => now);

      await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: { day: 18_000_000, hour: 3_500_000 },
      });

      // Verify file written to disk contains quotas
      const filePath = path.join(tmpDir, 'budget.json');
      assert.ok(fs.existsSync(filePath));
      const fileContent = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      assert.ok(fileContent.quotas);
      assert.equal(fileContent.quotas['proj-01'].granted.day, 18_000_000);

      // Reload state from disk
      reloadBudgetFromDisk();

      const getRes = await app.inject({
        method: 'GET',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
      });
      assert.equal(getRes.statusCode, 200);
      assert.equal(getRes.json().effective.source, 'grant');
      assert.equal(getRes.json().granted.day, 18_000_000);
    });

    it('loads legacy budget.json without quotas key compatibly', () => {
      const legacyState = {
        currentCycleStart: '2026-09-24',
        usedCycle: 1000,
        usedCycleRaw: 1200,
        daily: {},
        hourly: {},
      };
      const filePath = path.join(tmpDir, 'budget.json');
      fs.writeFileSync(filePath, JSON.stringify(legacyState), 'utf-8');

      reloadBudgetFromDisk();
      const status = getQuotaStatus('proj-01');
      assert.equal(status.effective.source, 'config');
      assert.equal(status.requested, null);
    });
  });

  describe('10) Admin status reflects quota info', () => {
    it('includes quota information in getBudgetStatus() tenants', async () => {
      const now = Date.parse('2026-09-24T12:00:00.000Z');
      setBudgetClock(() => now);

      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({
        '*': { dayShare: 0.5, hourShare: 0.2 },
      });

      await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: { day: 14_000_000, hour: 2_500_000 },
      });

      const budgetStatus = getBudgetStatus(now);
      const tenantStatus = budgetStatus.tenants['proj-01'];
      assert.ok(tenantStatus);
      assert.equal(tenantStatus.dayLimit, 14_000_000);
      assert.equal(tenantStatus.hourLimit, 2_500_000);
      assert.ok(tenantStatus.quota);
      assert.equal(tenantStatus.quota.granted?.day, 14_000_000);
      assert.equal(tenantStatus.quota.limitedBy, null);
      assert.ok(tenantStatus.quota.expiresAt);
    });
  });
});
