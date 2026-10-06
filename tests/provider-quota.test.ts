import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { CONFIG } from '../src/config.js';
import { mintTenantToken } from '../src/auth/tenant-token.js';
import {
  getBudgetRangeSums,
  getBudgetStatus,
  getDailyGlobalAllowance,
  getQuotaStatus,
  getRouterCountersForRemains,
  isOverBudget,
  recordBudgetUsage,
  requestQuotaGrant,
  resetBudgetForTests,
  setBudgetClock,
} from '../src/core/budget.js';
import {
  getMinimaxRemainsSnapshot,
  getProviderQuotaStatus,
  isMinimaxRemainsFresh,
  pollMinimaxRemainsOnce,
  resetMinimaxRemainsForTests,
  setMinimaxRemainsBaseUrl,
  setMinimaxRemainsClock,
  setMinimaxRemainsSnapshot,
} from '../src/core/provider-quota.js';

describe('MiniMax Provider Quota & Remains Polling (tests/provider-quota.test.ts)', () => {
  let mockServer: http.Server;
  let mockPort: number;
  let mockHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  let app: FastifyInstance;

  const testSecret = 'provider-quota-test-secret-12345';
  const tokenProj1 = mintTenantToken('proj-01', testSecret);
  const testStateDir = path.join(process.cwd(), '.test-provider-quota-data');

  const validGeneralResponse = {
    model_remains: [
      {
        start_time: 1790539200000,
        end_time: 1790553600000,
        remains_time: 6821841,
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        model_name: 'general',
        current_weekly_total_count: 0,
        current_weekly_usage_count: 0,
        weekly_start_time: 1789948800000,
        weekly_end_time: 1790553600000,
        weekly_remains_time: 6821841,
        current_interval_status: 1,
        current_interval_remaining_percent: 98,
        current_weekly_status: 1,
        current_weekly_remaining_percent: 98,
      },
      {
        model_name: 'video',
        current_weekly_remaining_percent: 50,
      },
    ],
    base_resp: {
      status_code: 0,
      status_msg: 'success',
    },
  };

  before(async () => {
    // Start local mock HTTP server
    await new Promise<void>((resolve) => {
      mockServer = http.createServer((req, res) => {
        if (mockHandler) {
          mockHandler(req, res);
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address() as any;
        mockPort = addr.port;
        resolve();
      });
    });

    CONFIG.serviceApiKey = testSecret;
    CONFIG.tenantTokenSecret = testSecret;
    setMinimaxRemainsBaseUrl(`http://127.0.0.1:${mockPort}`);
    process.env.MINIMAX_API_KEY = 'test-minimax-key';
    process.env.ROUTER_STATE_DIR = testStateDir;

    if (!fs.existsSync(testStateDir)) {
      fs.mkdirSync(testStateDir, { recursive: true });
    }

    app = buildApp();
    await app.ready();
  });

  after(async () => {
    await app.close();
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    try {
      fs.rmSync(testStateDir, { recursive: true, force: true });
    } catch {}
    delete process.env.ROUTER_STATE_DIR;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.ROUTER_MINIMAX_REMAINS_STOP_PCT;
    delete process.env.ROUTER_MINIMAX_REMAINS_TIGHTEN_PCT;
    delete process.env.ROUTER_MINIMAX_REMAINS_INTERVAL_SEC;
  });

  beforeEach(() => {
    resetBudgetForTests();
    resetMinimaxRemainsForTests();
    setMinimaxRemainsBaseUrl(`http://127.0.0.1:${mockPort}`);
    process.env.MINIMAX_API_KEY = 'test-minimax-key';
    delete process.env.ROUTER_MINIMAX_REMAINS_STOP_PCT;
    delete process.env.ROUTER_MINIMAX_REMAINS_TIGHTEN_PCT;
    delete process.env.ROUTER_MINIMAX_REMAINS_INTERVAL_SEC;
    try {
      const jsonlFile = path.join(testStateDir, 'minimax-remains.jsonl');
      if (fs.existsSync(jsonlFile)) fs.unlinkSync(jsonlFile);
    } catch {}
  });

  describe('1) Parsing MiniMax coding_plan/remains response', () => {
    it('parses valid response and selects model_name "general"', async () => {
      let authHeaderReceived = '';
      let urlReceived = '';

      mockHandler = (req, res) => {
        urlReceived = req.url || '';
        authHeaderReceived = req.headers.authorization || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(validGeneralResponse));
      };

      const now = 1790540000000;
      const snapshot = await pollMinimaxRemainsOnce(now);

      assert.ok(snapshot !== null);
      assert.equal(urlReceived, '/api/openplatform/coding_plan/remains');
      assert.equal(authHeaderReceived, 'Bearer test-minimax-key');

      assert.equal(snapshot.fetchedAt, now);
      assert.equal(snapshot.intervalStart, 1790539200000);
      assert.equal(snapshot.intervalEnd, 1790553600000);
      assert.equal(snapshot.intervalRemainingPct, 98);
      assert.equal(snapshot.intervalStatus, 1);
      assert.equal(snapshot.weeklyStart, 1789948800000);
      assert.equal(snapshot.weeklyEnd, 1790553600000);
      assert.equal(snapshot.weeklyRemainingPct, 98);
      assert.equal(snapshot.weeklyStatus, 1);

      assert.deepEqual(getMinimaxRemainsSnapshot(), snapshot);
    });

    it('handles disabled poller when MINIMAX_API_KEY is missing', async () => {
      delete process.env.MINIMAX_API_KEY;
      const snapshot = await pollMinimaxRemainsOnce();
      assert.equal(snapshot, null);
      assert.equal(getMinimaxRemainsSnapshot(), null);
    });
  });

  describe('2) Error handling: status_code != 0 and server failures', () => {
    it('treats base_resp.status_code != 0 as failed poll', async () => {
      mockHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          base_resp: { status_code: 1001, status_msg: 'invalid token' },
          model_remains: [],
        }));
      };

      const snapshot = await pollMinimaxRemainsOnce();
      assert.equal(snapshot, null);
      assert.equal(getMinimaxRemainsSnapshot(), null);
    });

    it('timeout/failure keeps old snapshot', async () => {
      // Step 1: Successful poll
      mockHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(validGeneralResponse));
      };
      const initialSnapshot = await pollMinimaxRemainsOnce(1790540000000);
      assert.ok(initialSnapshot);
      assert.equal(getMinimaxRemainsSnapshot(), initialSnapshot);

      // Step 2: Next poll fails with HTTP 500
      mockHandler = (_req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      };
      const failedResult = await pollMinimaxRemainsOnce(1790541000000);
      assert.equal(failedResult, null);

      // Previous snapshot in memory is preserved intact
      const preserved = getMinimaxRemainsSnapshot();
      assert.ok(preserved);
      assert.equal(preserved.fetchedAt, 1790540000000);
      assert.equal(preserved.weeklyRemainingPct, 98);
    });
  });

  describe('3) JSONL log append with router week sums', () => {
    it('appends one JSON line on success with router counters', async () => {
      // Mock clock on 2026-09-28
      const now = Date.parse('2026-09-28T12:00:00.000Z');
      setBudgetClock(() => now);
      setMinimaxRemainsClock(() => now);

      // Record usage for today (2026-09-28) and yesterday (2026-09-27)
      const yesterday = Date.parse('2026-09-27T12:00:00.000Z');
      recordBudgetUsage('proj-01', { raw: 1000, weighted: 500 }, yesterday);
      recordBudgetUsage('proj-01', { raw: 2000, weighted: 1000 }, now);

      // Mock server returns weeklyStart on 2026-09-25
      const weeklyStartMs = Date.parse('2026-09-25T00:00:00.000Z');
      const responseWithDate = {
        model_remains: [
          {
            ...validGeneralResponse.model_remains[0],
            weekly_start_time: weeklyStartMs,
          },
        ],
        base_resp: { status_code: 0, status_msg: 'success' },
      };

      mockHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseWithDate));
      };

      await pollMinimaxRemainsOnce(now);

      const jsonlPath = path.join(testStateDir, 'minimax-remains.jsonl');
      assert.ok(fs.existsSync(jsonlPath), 'jsonl file should exist');

      const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n');
      assert.equal(lines.length, 1);

      const parsedLine = JSON.parse(lines[0]);
      assert.equal(parsedLine.weeklyStart, weeklyStartMs);
      assert.equal(parsedLine.weeklyRemainingPct, 98);
      assert.equal(parsedLine.routerWeekRaw, 3000);
      assert.equal(parsedLine.routerWeekWeighted, 1500);
      assert.equal(parsedLine.routerCycleRaw, 3000);
      assert.equal(parsedLine.usedCycle, 1500);

      // Verify budget.ts range sum helpers
      const rangeSums = getBudgetRangeSums(weeklyStartMs, now);
      assert.deepEqual(rangeSums, { raw: 3000, weighted: 1500 });

      const routerCounters = getRouterCountersForRemains(weeklyStartMs, now);
      assert.deepEqual(routerCounters, {
        routerWeekRaw: 3000,
        routerWeekWeighted: 1500,
        routerCycleRaw: 3000,
        usedCycle: 1500,
      });
    });
  });

  describe('4) Freshness window: max(3 × interval, 30 min)', () => {
    it('evaluates freshness correctly based on interval and age', () => {
      const fetchedAt = 1000000000;
      setMinimaxRemainsSnapshot({
        fetchedAt,
        intervalStart: 0,
        intervalEnd: 0,
        intervalRemainingPct: 50,
        intervalStatus: 1,
        weeklyStart: 0,
        weeklyEnd: 0,
        weeklyRemainingPct: 50,
        weeklyStatus: 1,
      });

      // Default interval 600s: 3 * 600 = 1800s (30m)
      assert.equal(isMinimaxRemainsFresh(fetchedAt + 10 * 60 * 1000), true);
      assert.equal(isMinimaxRemainsFresh(fetchedAt + 29 * 60 * 1000), true);
      assert.equal(isMinimaxRemainsFresh(fetchedAt + 31 * 60 * 1000), false);

      // Custom interval 1200s (20m): 3 * 1200 = 3600s (60m)
      process.env.ROUTER_MINIMAX_REMAINS_INTERVAL_SEC = '1200';
      assert.equal(isMinimaxRemainsFresh(fetchedAt + 45 * 60 * 1000), true);
      assert.equal(isMinimaxRemainsFresh(fetchedAt + 65 * 60 * 1000), false);
    });
  });

  describe('5) Gating: OverBudgetReason "provider-quota"', () => {
    it('returns "provider-quota" when weeklyRemainingPct <= stopPct', () => {
      const now = Date.parse('2026-09-28T12:00:00.000Z');
      setBudgetClock(() => now);

      setMinimaxRemainsSnapshot({
        fetchedAt: now,
        intervalStart: 0,
        intervalEnd: 0,
        intervalRemainingPct: 20,
        intervalStatus: 1,
        weeklyStart: 0,
        weeklyEnd: 0,
        weeklyRemainingPct: 5, // <= stopPct (default 5)
        weeklyStatus: 1,
      });

      const res = isOverBudget('master-service', now);
      assert.ok(res !== null);
      assert.equal(res.reason, 'provider-quota');
    });

    it('returns "provider-quota" when intervalRemainingPct <= stopPct', () => {
      const now = Date.parse('2026-09-28T12:00:00.000Z');
      setBudgetClock(() => now);

      setMinimaxRemainsSnapshot({
        fetchedAt: now,
        intervalStart: 0,
        intervalEnd: 0,
        intervalRemainingPct: 4, // <= 5
        intervalStatus: 1,
        weeklyStart: 0,
        weeklyEnd: 0,
        weeklyRemainingPct: 50,
        weeklyStatus: 1,
      });

      const res = isOverBudget('master-service', now);
      assert.ok(res !== null);
      assert.equal(res.reason, 'provider-quota');
    });

    it('ignores provider gating when snapshot is stale', () => {
      const fetchedAt = Date.parse('2026-09-28T10:00:00.000Z');
      const now = Date.parse('2026-09-28T12:00:00.000Z'); // 2 hours old
      setBudgetClock(() => now);

      setMinimaxRemainsSnapshot({
        fetchedAt,
        intervalStart: 0,
        intervalEnd: 0,
        intervalRemainingPct: 1, // very low, but snapshot is stale!
        intervalStatus: 1,
        weeklyStart: 0,
        weeklyEnd: 0,
        weeklyRemainingPct: 1,
        weeklyStatus: 1,
      });

      assert.equal(isMinimaxRemainsFresh(now), false);
      const res = isOverBudget('master-service', now);
      assert.equal(res, null); // no provider gating when stale
    });
  });

  describe('6) Tighten: halves capacity and sets limitedBy "provider-low"', () => {
    it('halves capacityDay and sets limitedBy="provider-low" when weekly remaining <= tighten', () => {
      const now = Date.parse('2026-09-28T12:00:00.000Z');
      setBudgetClock(() => now);

      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({
        'proj-01': { dayShare: 0.8 },
      });

      // Daily global allowance ~56.6M
      // reserveShare 0.2 -> capacityDay = 0.8 * todayAllowance ~ 45,333,332
      // When tightened (remaining <= 15): capacityDay halved -> ~ 22,666,666
      setMinimaxRemainsSnapshot({
        fetchedAt: now,
        intervalStart: 0,
        intervalEnd: 0,
        intervalRemainingPct: 50,
        intervalStatus: 1,
        weeklyStart: 0,
        weeklyEnd: 0,
        weeklyRemainingPct: 12, // <= tightenPct (15)
        weeklyStatus: 1,
      });

      const reqRes = requestQuotaGrant('proj-01', { day: 40_000_000 }, now);
      assert.equal(reqRes.ok, true);
      if (reqRes.ok) {
        assert.equal(reqRes.data.limitedBy, 'provider-low');
        const todayAllowance = getDailyGlobalAllowance(now);
        const expectedTightenedCapacity = Math.floor(0.8 * todayAllowance / 2);
        assert.equal(reqRes.data.granted?.day, expectedTightenedCapacity);
      }
    });

    it('does not halve capacity when healthy (> tighten)', () => {
      const now = Date.parse('2026-09-28T12:00:00.000Z');
      setBudgetClock(() => now);

      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({
        'proj-01': { dayShare: 0.8 },
      });

      setMinimaxRemainsSnapshot({
        fetchedAt: now,
        intervalStart: 0,
        intervalEnd: 0,
        intervalRemainingPct: 50,
        intervalStatus: 1,
        weeklyStart: 0,
        weeklyEnd: 0,
        weeklyRemainingPct: 50, // healthy > 15
        weeklyStatus: 1,
      });

      const reqRes = requestQuotaGrant('proj-01', { day: 40_000_000 }, now);
      assert.equal(reqRes.ok, true);
      if (reqRes.ok) {
        // 40M fits within ~45.3M normal capacity and ownerMax ~45.3M
        assert.equal(reqRes.data.granted?.day, 40_000_000);
        assert.equal(reqRes.data.limitedBy, null);
      }
    });
  });

  describe('7) Relaxing global-day check', () => {
    it('skips global-day when fresh and weeklyRemainingPct > tighten, but enforces when stale', () => {
      const now = Date.parse('2026-09-28T12:00:00.000Z');
      setBudgetClock(() => now);

      process.env.ROUTER_MINIMAX_TENANT_LIMITS = JSON.stringify({
        'no-cap-tenant': { day: 0, hour: 0 },
      });

      const todayAllowance = getDailyGlobalAllowance(now);
      // Consume all daily allowance
      recordBudgetUsage('no-cap-tenant', todayAllowance + 1000, now);

      // Case A: Fresh and healthy (> 15) -> global-day check relaxed!
      setMinimaxRemainsSnapshot({
        fetchedAt: now,
        intervalStart: 0,
        intervalEnd: 0,
        intervalRemainingPct: 50,
        intervalStatus: 1,
        weeklyStart: 0,
        weeklyEnd: 0,
        weeklyRemainingPct: 50, // > 15
        weeklyStatus: 1,
      });
      assert.equal(isOverBudget('no-cap-tenant', now), null);

      // Case B: Stale snapshot -> global-day check enforced!
      const oldTime = now - 60 * 60 * 1000;
      setMinimaxRemainsSnapshot({
        fetchedAt: oldTime,
        intervalStart: 0,
        intervalEnd: 0,
        intervalRemainingPct: 50,
        intervalStatus: 1,
        weeklyStart: 0,
        weeklyEnd: 0,
        weeklyRemainingPct: 50,
        weeklyStatus: 1,
      });
      const staleRes = isOverBudget('no-cap-tenant', now);
      assert.ok(staleRes !== null);
      assert.equal(staleRes.reason, 'global-day');

      // Case C: Fresh but low weeklyRemainingPct (10 <= 15) -> global-day check enforced!
      setMinimaxRemainsSnapshot({
        fetchedAt: now,
        intervalStart: 0,
        intervalEnd: 0,
        intervalRemainingPct: 50,
        intervalStatus: 1,
        weeklyStart: 0,
        weeklyEnd: 0,
        weeklyRemainingPct: 10, // <= 15
        weeklyStatus: 1,
      });
      const lowRes = isOverBudget('no-cap-tenant', now);
      assert.ok(lowRes !== null);
      assert.equal(lowRes.reason, 'global-day');
    });
  });

  describe('8) Estimates: null below 5% used', () => {
    it('returns null estimates when usedPct < 5%, calculates estimates when usedPct >= 5%', () => {
      const now = Date.parse('2026-09-28T12:00:00.000Z');
      setBudgetClock(() => now);
      setMinimaxRemainsClock(() => now);

      const weeklyStartMs = Date.parse('2026-09-25T00:00:00.000Z');
      recordBudgetUsage('proj-01', { raw: 100_000, weighted: 50_000 }, now);

      // 98% remaining -> usedPct = 2% (< 5%)
      setMinimaxRemainsSnapshot({
        fetchedAt: now,
        intervalStart: 0,
        intervalEnd: 0,
        intervalRemainingPct: 98,
        intervalStatus: 1,
        weeklyStart: weeklyStartMs,
        weeklyEnd: 0,
        weeklyRemainingPct: 98,
        weeklyStatus: 1,
      });

      const statusLowUsed = getBudgetStatus(now);
      assert.deepEqual(statusLowUsed.provider.estimates, {
        weeklyQuotaRaw: null,
        weeklyQuotaWeighted: null,
      });

      // 90% remaining -> usedPct = 10% (>= 5%)
      // estimate = routerWeekX / 0.10
      // raw = 100,000 / 0.10 = 1,000,000
      // weighted = 50,000 / 0.10 = 500,000
      setMinimaxRemainsSnapshot({
        fetchedAt: now,
        intervalStart: 0,
        intervalEnd: 0,
        intervalRemainingPct: 90,
        intervalStatus: 1,
        weeklyStart: weeklyStartMs,
        weeklyEnd: 0,
        weeklyRemainingPct: 90,
        weeklyStatus: 1,
      });

      const statusUsed = getBudgetStatus(now);
      assert.deepEqual(statusUsed.provider.estimates, {
        weeklyQuotaRaw: 1_000_000,
        weeklyQuotaWeighted: 500_000,
      });
    });
  });

  describe('9) Visibility via API: GET/PUT /v1/budget/quota and Admin endpoints', () => {
    it('includes cycle.provider in GET and PUT /v1/budget/quota', async () => {
      const now = Date.parse('2026-09-28T12:00:00.000Z');
      setBudgetClock(() => now);

      process.env.ROUTER_MINIMAX_QUOTA_MAX = JSON.stringify({
        'proj-01': { dayShare: 0.5 },
      });

      setMinimaxRemainsSnapshot({
        fetchedAt: now,
        intervalStart: 1790539200000,
        intervalEnd: 1790553600000,
        intervalRemainingPct: 95,
        intervalStatus: 1,
        weeklyStart: 1789948800000,
        weeklyEnd: 1790553600000,
        weeklyRemainingPct: 95,
        weeklyStatus: 1,
      });

      // PUT /v1/budget/quota
      const putRes = await app.inject({
        method: 'PUT',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
        payload: { day: 10_000_000 },
      });
      assert.equal(putRes.statusCode, 200);
      const putData = putRes.json();
      assert.ok(putData.cycle.provider);
      assert.equal(putData.cycle.provider.weeklyRemainingPercent, 95);
      assert.equal(putData.cycle.provider.intervalRemainingPercent, 95);
      assert.equal(putData.cycle.provider.fresh, true);
      assert.equal(putData.cycle.provider.weeklyEnd, new Date(1790553600000).toISOString());

      // GET /v1/budget/quota
      const getRes = await app.inject({
        method: 'GET',
        url: '/v1/budget/quota',
        headers: { authorization: `Bearer ${tokenProj1}` },
      });
      assert.equal(getRes.statusCode, 200);
      const getData = getRes.json();
      assert.ok(getData.cycle.provider);
      assert.equal(getData.cycle.provider.weeklyRemainingPercent, 95);

      // GET /admin/api/budget
      const adminBudgetRes = await app.inject({
        method: 'GET',
        url: '/admin/api/budget',
        headers: { authorization: `Bearer ${testSecret}` },
      });
      assert.equal(adminBudgetRes.statusCode, 200);
      const adminBudgetData = adminBudgetRes.json();
      assert.ok(adminBudgetData.provider);
      assert.equal(adminBudgetData.provider.snapshot.weeklyRemainingPct, 95);
      assert.equal(adminBudgetData.provider.fresh, true);
    });
  });
});
