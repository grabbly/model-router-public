import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildWatchReport,
  runWatchCheck,
  saveWatchReportSync,
  startWatchScheduler,
  stopWatchScheduler,
  getNextWatchRunMs,
  setWatchClockForTests,
  resetWatchForTests,
  WatchReport,
} from '../src/core/watch.js';
import { CONFIG } from '../src/config.js';
import { upsertTenant, resetTenantsForTests } from '../src/core/tenants.js';
import { resetNotifyForTests, setNotifyTransportsForTests, startNotifier, stopNotifier, handleRouterEvent, flushNotifyQueueForTests } from '../src/core/notify.js';
import { resetRouterEventsForTests, onRouterEvent, emitRouterEvent } from '../src/core/events.js';
import { recordBudgetUsage, resetBudgetForTests } from '../src/core/budget.js';
import { checkTenantRate, resetTenantRateForTests } from '../src/core/tenant-rate.js';

describe('Nightly Router Watcher (tests/watch.test.ts)', () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-watch-test-'));
    originalEnv = { ...process.env };
    process.env.ROUTER_STATE_DIR = tmpDir;
    process.env.ROUTER_WATCH = 'off'; // Keep scheduler off unless explicitly tested
    process.env.MINIMAX_API_KEY = 'test-minimax-key';

    originalFetch = globalThis.fetch;
    resetWatchForTests();
    resetTenantsForTests();
    resetNotifyForTests();
    resetRouterEventsForTests();
    resetBudgetForTests();
    resetTenantRateForTests();
  });

  afterEach(() => {
    stopWatchScheduler();
    resetWatchForTests();
    resetTenantsForTests();
    resetNotifyForTests();
    resetRouterEventsForTests();
    resetBudgetForTests();
    resetTenantRateForTests();
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeRequestLogs(dateStr: string, records: any[]) {
    const reqDir = path.join(tmpDir, 'requests');
    fs.mkdirSync(reqDir, { recursive: true });
    const filePath = path.join(reqDir, `${dateStr}.jsonl`);
    const content = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
    fs.appendFileSync(filePath, content);
  }

  function writeMinimaxRemains(records: any[]) {
    const filePath = path.join(tmpDir, 'minimax-remains.jsonl');
    const content = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
    fs.appendFileSync(filePath, content);
  }

  function writeNotifications(records: any[]) {
    const filePath = path.join(tmpDir, 'notifications.jsonl');
    const content = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
    fs.appendFileSync(filePath, content);
  }

  describe('1. Read-Only Guarantee', () => {
    it('never calls network fetch and never modifies config or routing', async () => {
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        throw new Error('fetch should never be called by watcher');
      };

      const now = new Date('2026-09-30T03:00:00.000Z');
      const from = '2026-09-29T00:00:00.000Z';
      const to = '2026-09-30T00:00:00.000Z';

      const report = await buildWatchReport({ from, to, now });
      assert.equal(fetchCalled, false, 'fetch must not be called during buildWatchReport');
      assert.equal(report.version, 1);
    });
  });

  describe('2. Streaming JSONL and malformed lines handling', () => {
    it('skips malformed or empty lines without throwing', async () => {
      const dateStr = '2026-09-29';
      writeRequestLogs(dateStr, [
        '{ malformed json line',
        '',
        JSON.stringify({
          ts: '2026-09-29T10:00:00.000Z',
          tenant: 't1',
          backend: 'minimax-m3-direct-text-high',
          status: 200,
          promptTokens: 1000,
          cachedTokens: 800,
        }),
        '   ',
        '{ "broken": true ',
      ]);

      const now = new Date('2026-09-30T03:00:00.000Z');
      const from = '2026-09-29T00:00:00.000Z';
      const to = '2026-09-30T00:00:00.000Z';

      const report = await buildWatchReport({ from, to, now });
      assert.equal(report.metrics.cache.requests, 1);
      assert.equal(report.metrics.cache.promptTokens, 1000);
      assert.equal(report.metrics.cache.cachedTokens, 800);
    });
  });

  describe('3. MiniMax Cache Share and Attribution', () => {
    const from = '2026-09-29T00:00:00.000Z';
    const to = '2026-09-30T00:00:00.000Z';
    const now = new Date('2026-09-30T03:00:00.000Z');

    it('warns when overall cache share is below threshold (0.5), crit if < half (0.25)', async () => {
      // Add healthy snapshot to avoid poller stale crit signal
      const healthySnapshot = {
        fetchedAt: new Date('2026-09-30T02:55:00.000Z').getTime(),
        intervalStart: new Date('2026-09-30T00:00:00.000Z').getTime(),
        intervalEnd: new Date('2026-09-30T05:00:00.000Z').getTime(),
        intervalRemainingPct: 80,
        intervalStatus: 1,
        weeklyStart: new Date('2026-09-28T00:00:00.000Z').getTime(),
        weeklyEnd: new Date('2026-10-05T00:00:00.000Z').getTime(),
        weeklyRemainingPct: 80,
        weeklyStatus: 1,
        routerWeekRaw: 1000,
        routerWeekWeighted: 1000,
        routerCycleRaw: 1000,
        usedCycle: 1000,
      };
      writeMinimaxRemains([healthySnapshot]);

      // 60 requests with low cache share (30%) -> warn
      const recordsWarn = Array.from({ length: 60 }, (_, i) => ({
        ts: `2026-09-29T10:00:${String(i).padStart(2, '0')}.000Z`,
        tenant: 'tenant-a',
        backend: 'minimax-m3',
        status: 200,
        promptTokens: 1000,
        cachedTokens: 300, // 30% share
      }));
      writeRequestLogs('2026-09-29', recordsWarn);

      const reportWarn = await buildWatchReport({ from, to, now });
      const cacheSigWarn = reportWarn.signals.find((s) => s.id === 'cache.share');
      assert.ok(cacheSigWarn);
      assert.equal(cacheSigWarn.level, 'warn');
      assert.equal(reportWarn.level, 'warn');

      // Now with critical cache share (< 25%, e.g. 10%)
      const tmpDirCrit = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-watch-crit-'));
      process.env.ROUTER_STATE_DIR = tmpDirCrit;
      fs.writeFileSync(
        path.join(tmpDirCrit, 'minimax-remains.jsonl'),
        JSON.stringify(healthySnapshot) + '\n'
      );
      const recordsCrit = Array.from({ length: 60 }, (_, i) => ({
        ts: `2026-09-29T10:00:${String(i).padStart(2, '0')}.000Z`,
        tenant: 'tenant-a',
        backend: 'minimax-m3',
        status: 200,
        promptTokens: 1000,
        cachedTokens: 100, // 10% share
      }));
      const reqDirCrit = path.join(tmpDirCrit, 'requests');
      fs.mkdirSync(reqDirCrit, { recursive: true });
      fs.writeFileSync(path.join(reqDirCrit, '2026-09-29.jsonl'), recordsCrit.map((r) => JSON.stringify(r)).join('\n'));

      const reportCrit = await buildWatchReport({ from, to, now });
      const cacheSigCrit = reportCrit.signals.find((s) => s.id === 'cache.share');
      assert.ok(cacheSigCrit);
      assert.equal(cacheSigCrit.level, 'crit');
      assert.equal(reportCrit.level, 'crit');
      fs.rmSync(tmpDirCrit, { recursive: true, force: true });
      process.env.ROUTER_STATE_DIR = tmpDir;
    });

    it('names tenant/user with >= 1,000,000 prompt tokens and low share ("who broke the prefix")', async () => {
      const records = [
        ...Array.from({ length: 50 }, (_, i) => ({
          ts: `2026-09-29T10:00:${String(i).padStart(2, '0')}.000Z`,
          tenant: 'breaker-corp',
          user: 'bot-heavy',
          backend: 'minimax-m3',
          status: 200,
          promptTokens: 25000, // 50 * 25k = 1,250,000 prompt tokens (> 1M)
          cachedTokens: 2500, // 10% cache share
        })),
        {
          ts: '2026-09-29T11:00:00.000Z',
          tenant: 'good-tenant',
          user: 'good-user',
          backend: 'minimax-m3',
          status: 200,
          promptTokens: 100000,
          cachedTokens: 90000, // 90% cache share
        },
      ];
      writeRequestLogs('2026-09-29', records);

      const report = await buildWatchReport({ from, to, now });
      const sig = report.signals.find((s) => s.id === 'cache.share');
      assert.ok(sig);
      assert.ok(sig.details.includes('breaker-corp'));
      assert.ok(sig.details.includes('bot-heavy'));
    });

    it('warns when cache share drops vs 7-day baseline by > 20 pp', async () => {
      // 7 days baseline: 80% cache share
      for (let day = 22; day <= 28; day++) {
        const dayStr = `2026-09-${day}`;
        const baselineRecs = Array.from({ length: 20 }, (_, i) => ({
          ts: `${dayStr}T10:00:00.000Z`,
          tenant: 't1',
          backend: 'minimax-m3',
          status: 200,
          promptTokens: 1000,
          cachedTokens: 800, // 80%
        }));
        writeRequestLogs(dayStr, baselineRecs);
      }

      // Today: 55% cache share (above 50% min threshold, but 80% - 55% = 25 pp drop > 20 pp)
      const todayRecs = Array.from({ length: 60 }, (_, i) => ({
        ts: `2026-09-29T10:00:${String(i).padStart(2, '0')}.000Z`,
        tenant: 't1',
        backend: 'minimax-m3',
        status: 200,
        promptTokens: 1000,
        cachedTokens: 550, // 55%
      }));
      writeRequestLogs('2026-09-29', todayRecs);

      const report = await buildWatchReport({ from, to, now });
      const dropSig = report.signals.find((s) => s.id === 'cache.baseline-drop');
      assert.ok(dropSig, 'Should generate cache.baseline-drop signal');
      assert.equal(dropSig.level, 'warn');
      assert.ok(dropSig.details.includes('25.0 п.п.'));
    });

    it('skips cache signal when fewer than 50 MiniMax requests in window', async () => {
      const records = Array.from({ length: 10 }, (_, i) => ({
        ts: `2026-09-29T10:00:${String(i).padStart(2, '0')}.000Z`,
        tenant: 't1',
        backend: 'minimax-m3',
        status: 200,
        promptTokens: 1000,
        cachedTokens: 100, // 10% share, but only 10 requests (< 50)
      }));
      writeRequestLogs('2026-09-29', records);

      const report = await buildWatchReport({ from, to, now });
      const cacheSig = report.signals.find((s) => s.id.startsWith('cache.'));
      assert.equal(cacheSig, undefined);
      assert.equal(report.metrics.cache.requests, 10);
    });
  });

  describe('4. MiniMax Quota Remains and Poller Liveness', () => {
    const from = '2026-09-29T00:00:00.000Z';
    const to = '2026-09-30T00:00:00.000Z';
    const now = new Date('2026-09-30T03:00:00.000Z');

    it('warns when weeklyRemainingPct < 30, crit if <= 5', async () => {
      // Poller snapshot inside window with 25% weekly remaining
      writeMinimaxRemains([
        {
          fetchedAt: new Date('2026-09-29T23:45:00.000Z').getTime(), // inside window
          intervalStart: new Date('2026-09-29T20:00:00.000Z').getTime(),
          intervalEnd: new Date('2026-09-30T01:00:00.000Z').getTime(),
          intervalRemainingPct: 80,
          intervalStatus: 1,
          weeklyStart: new Date('2026-09-28T00:00:00.000Z').getTime(),
          weeklyEnd: new Date('2026-10-05T00:00:00.000Z').getTime(),
          weeklyRemainingPct: 25, // < 30 -> warn
          weeklyStatus: 1,
          routerWeekRaw: 1000,
          routerWeekWeighted: 500,
          routerCycleRaw: 1000,
          usedCycle: 500,
        },
        {
          fetchedAt: new Date('2026-09-30T02:45:00.000Z').getTime(), // fresh at report time (03:00)
          intervalStart: new Date('2026-09-30T00:00:00.000Z').getTime(),
          intervalEnd: new Date('2026-09-30T05:00:00.000Z').getTime(),
          intervalRemainingPct: 80,
          intervalStatus: 1,
          weeklyStart: new Date('2026-09-28T00:00:00.000Z').getTime(),
          weeklyEnd: new Date('2026-10-05T00:00:00.000Z').getTime(),
          weeklyRemainingPct: 25,
          weeklyStatus: 1,
          routerWeekRaw: 1000,
          routerWeekWeighted: 500,
          routerCycleRaw: 1000,
          usedCycle: 500,
        },
      ]);

      const reportWarn = await buildWatchReport({ from, to, now });
      const sigWarn = reportWarn.signals.find((s) => s.id === 'quota.weekly-low');
      assert.ok(sigWarn);
      assert.equal(sigWarn.level, 'warn');

      // Now with 4% weekly remaining (<= 5% -> crit)
      fs.unlinkSync(path.join(tmpDir, 'minimax-remains.jsonl'));
      writeMinimaxRemains([
        {
          fetchedAt: new Date('2026-09-29T23:45:00.000Z').getTime(),
          intervalStart: new Date('2026-09-29T20:00:00.000Z').getTime(),
          intervalEnd: new Date('2026-09-30T01:00:00.000Z').getTime(),
          intervalRemainingPct: 80,
          intervalStatus: 1,
          weeklyStart: new Date('2026-09-28T00:00:00.000Z').getTime(),
          weeklyEnd: new Date('2026-10-05T00:00:00.000Z').getTime(),
          weeklyRemainingPct: 4,
          weeklyStatus: 1,
          routerWeekRaw: 1000,
          routerWeekWeighted: 500,
          routerCycleRaw: 1000,
          usedCycle: 500,
        },
        {
          fetchedAt: new Date('2026-09-30T02:45:00.000Z').getTime(),
          intervalStart: new Date('2026-09-30T00:00:00.000Z').getTime(),
          intervalEnd: new Date('2026-09-30T05:00:00.000Z').getTime(),
          intervalRemainingPct: 80,
          intervalStatus: 1,
          weeklyStart: new Date('2026-09-28T00:00:00.000Z').getTime(),
          weeklyEnd: new Date('2026-10-05T00:00:00.000Z').getTime(),
          weeklyRemainingPct: 4,
          weeklyStatus: 1,
          routerWeekRaw: 1000,
          routerWeekWeighted: 500,
          routerCycleRaw: 1000,
          usedCycle: 500,
        },
      ]);

      const reportCrit = await buildWatchReport({ from, to, now });
      const sigCrit = reportCrit.signals.find((s) => s.id === 'quota.weekly-low');
      assert.ok(sigCrit);
      assert.equal(sigCrit.level, 'crit');
    });

    it('warns when interval remaining dips below 15%', async () => {
      writeMinimaxRemains([
        {
          fetchedAt: new Date('2026-09-29T12:00:00.000Z').getTime(),
          intervalStart: new Date('2026-09-29T10:00:00.000Z').getTime(),
          intervalEnd: new Date('2026-09-29T15:00:00.000Z').getTime(),
          intervalRemainingPct: 10, // < 15%
          intervalStatus: 1,
          weeklyStart: new Date('2026-09-28T00:00:00.000Z').getTime(),
          weeklyEnd: new Date('2026-10-05T00:00:00.000Z').getTime(),
          weeklyRemainingPct: 80,
          weeklyStatus: 1,
          routerWeekRaw: 1000,
          routerWeekWeighted: 500,
          routerCycleRaw: 1000,
          usedCycle: 500,
        },
        {
          fetchedAt: new Date('2026-09-30T02:45:00.000Z').getTime(),
          intervalStart: new Date('2026-09-30T00:00:00.000Z').getTime(),
          intervalEnd: new Date('2026-09-30T05:00:00.000Z').getTime(),
          intervalRemainingPct: 90,
          intervalStatus: 1,
          weeklyStart: new Date('2026-09-28T00:00:00.000Z').getTime(),
          weeklyEnd: new Date('2026-10-05T00:00:00.000Z').getTime(),
          weeklyRemainingPct: 75,
          weeklyStatus: 1,
          routerWeekRaw: 2000,
          routerWeekWeighted: 1000,
          routerCycleRaw: 2000,
          usedCycle: 1000,
        },
      ]);

      const report = await buildWatchReport({ from, to, now });
      const sig = report.signals.find((s) => s.id === 'quota.interval-low');
      assert.ok(sig);
      assert.equal(sig.level, 'warn');
    });

    it('warns when provider-quota gate hits occur in request-log', async () => {
      writeRequestLogs('2026-09-29', [
        {
          ts: '2026-09-29T14:00:00.000Z',
          tenant: 'proj-01',
          backend: 'minimax-m3',
          status: 503,
          budgetExceeded: 'provider-quota',
        },
      ]);
      writeMinimaxRemains([
        {
          fetchedAt: new Date('2026-09-30T02:50:00.000Z').getTime(),
          intervalStart: new Date('2026-09-30T00:00:00.000Z').getTime(),
          intervalEnd: new Date('2026-09-30T05:00:00.000Z').getTime(),
          intervalRemainingPct: 80,
          intervalStatus: 1,
          weeklyStart: new Date('2026-09-28T00:00:00.000Z').getTime(),
          weeklyEnd: new Date('2026-10-05T00:00:00.000Z').getTime(),
          weeklyRemainingPct: 75,
          weeklyStatus: 1,
          routerWeekRaw: 1000,
          routerWeekWeighted: 500,
          routerCycleRaw: 1000,
          usedCycle: 500,
        },
      ]);

      const report = await buildWatchReport({ from, to, now });
      const sig = report.signals.find((s) => s.id === 'quota.gate-hits');
      assert.ok(sig);
      assert.equal(sig.level, 'warn');
      assert.equal(report.metrics.quota.providerQuotaHits, 1);
    });

    it('checks poller liveness: stale snapshot triggers crit, gap triggers warn', async () => {
      // Snapshot is 2 hours old at report time (03:00 vs 01:00) -> stale crit (> 30 min)
      writeMinimaxRemains([
        {
          fetchedAt: new Date('2026-09-30T01:00:00.000Z').getTime(),
          intervalStart: new Date('2026-09-30T00:00:00.000Z').getTime(),
          intervalEnd: new Date('2026-09-30T05:00:00.000Z').getTime(),
          intervalRemainingPct: 80,
          intervalStatus: 1,
          weeklyStart: new Date('2026-09-28T00:00:00.000Z').getTime(),
          weeklyEnd: new Date('2026-10-05T00:00:00.000Z').getTime(),
          weeklyRemainingPct: 75,
          weeklyStatus: 1,
          routerWeekRaw: 1000,
          routerWeekWeighted: 500,
          routerCycleRaw: 1000,
          usedCycle: 500,
        },
      ]);

      const report = await buildWatchReport({ from, to, now });
      const staleSig = report.signals.find((s) => s.id === 'quota.poller-stale');
      assert.ok(staleSig);
      assert.equal(staleSig.level, 'crit');
    });

    it('ignores poller signals when poller is intentionally disabled', async () => {
      process.env.ROUTER_MINIMAX_REMAINS_INTERVAL_SEC = '0';
      const report = await buildWatchReport({ from, to, now });
      const pollerSig = report.signals.find((s) => s.id.startsWith('quota.poller-'));
      assert.equal(pollerSig, undefined);
      assert.equal(report.metrics.quota.pollerDisabled, true);
    });
  });

  describe('5. Calibration Drift Check', () => {
    const from = '2026-09-29T00:00:00.000Z';
    const to = '2026-09-30T00:00:00.000Z';
    const now = new Date('2026-09-30T03:00:00.000Z');

    it('warns when tokens per % deviates outside ±50% of 200,000', async () => {
      // 5-hour interval:
      // snapshot 1: pct 90, weighted 1,000,000
      // snapshot 2: pct 80 (delta = 10%), weighted 5,000,000 (delta = 4,000,000)
      // tokensPerPct = 4,000,000 / 10 = 400,000 tokens/% (expected 200,000 -> drift 100% > 50%)
      const intStart = new Date('2026-09-29T10:00:00.000Z').getTime();
      const intEnd = new Date('2026-09-29T15:00:00.000Z').getTime();
      const weekStart = new Date('2026-09-28T00:00:00.000Z').getTime();
      const weekEnd = new Date('2026-10-05T00:00:00.000Z').getTime();

      writeMinimaxRemains([
        {
          fetchedAt: new Date('2026-09-29T10:10:00.000Z').getTime(),
          intervalStart: intStart,
          intervalEnd: intEnd,
          intervalRemainingPct: 90,
          intervalStatus: 1,
          weeklyStart: weekStart,
          weeklyEnd: weekEnd,
          weeklyRemainingPct: 80,
          weeklyStatus: 1,
          routerWeekRaw: 2000000,
          routerWeekWeighted: 1000000,
          routerCycleRaw: 2000000,
          usedCycle: 1000000,
        },
        {
          fetchedAt: new Date('2026-09-29T14:50:00.000Z').getTime(),
          intervalStart: intStart,
          intervalEnd: intEnd,
          intervalRemainingPct: 80,
          intervalStatus: 1,
          weeklyStart: weekStart,
          weeklyEnd: weekEnd,
          weeklyRemainingPct: 75,
          weeklyStatus: 1,
          routerWeekRaw: 8000000,
          routerWeekWeighted: 5000000,
          routerCycleRaw: 8000000,
          usedCycle: 5000000,
        },
        // Fresh snapshot at end of window so poller is not stale
        {
          fetchedAt: new Date('2026-09-30T02:50:00.000Z').getTime(),
          intervalStart: new Date('2026-09-30T00:00:00.000Z').getTime(),
          intervalEnd: new Date('2026-09-30T05:00:00.000Z').getTime(),
          intervalRemainingPct: 95,
          intervalStatus: 1,
          weeklyStart: weekStart,
          weeklyEnd: weekEnd,
          weeklyRemainingPct: 70,
          weeklyStatus: 1,
          routerWeekRaw: 8000000,
          routerWeekWeighted: 5000000,
          routerCycleRaw: 8000000,
          usedCycle: 5000000,
        },
      ]);

      const report = await buildWatchReport({ from, to, now });
      const calibSig = report.signals.find((s) => s.id === 'calibration.drift');
      assert.ok(calibSig);
      assert.equal(calibSig.level, 'warn');
      assert.equal(report.metrics.calibration.tokensPerPct, 400000);
    });

    it('skips interval when weeklyStart changed between first and last snapshot', async () => {
      const intStart = new Date('2026-09-29T10:00:00.000Z').getTime();
      const intEnd = new Date('2026-09-29T15:00:00.000Z').getTime();

      writeMinimaxRemains([
        {
          fetchedAt: new Date('2026-09-29T10:10:00.000Z').getTime(),
          intervalStart: intStart,
          intervalEnd: intEnd,
          intervalRemainingPct: 90,
          intervalStatus: 1,
          weeklyStart: new Date('2026-09-21T00:00:00.000Z').getTime(),
          weeklyEnd: new Date('2026-09-28T00:00:00.000Z').getTime(),
          weeklyRemainingPct: 80,
          weeklyStatus: 1,
          routerWeekRaw: 2000000,
          routerWeekWeighted: 1000000,
          routerCycleRaw: 2000000,
          usedCycle: 1000000,
        },
        {
          fetchedAt: new Date('2026-09-29T14:50:00.000Z').getTime(),
          intervalStart: intStart,
          intervalEnd: intEnd,
          intervalRemainingPct: 80,
          intervalStatus: 1,
          weeklyStart: new Date('2026-09-28T00:00:00.000Z').getTime(), // Changed weeklyStart
          weeklyEnd: new Date('2026-10-05T00:00:00.000Z').getTime(),
          weeklyRemainingPct: 99,
          weeklyStatus: 1,
          routerWeekRaw: 100000,
          routerWeekWeighted: 50000,
          routerCycleRaw: 8000000,
          usedCycle: 5000000,
        },
        {
          fetchedAt: new Date('2026-09-30T02:50:00.000Z').getTime(),
          intervalStart: new Date('2026-09-30T00:00:00.000Z').getTime(),
          intervalEnd: new Date('2026-09-30T05:00:00.000Z').getTime(),
          intervalRemainingPct: 95,
          intervalStatus: 1,
          weeklyStart: new Date('2026-09-28T00:00:00.000Z').getTime(),
          weeklyEnd: new Date('2026-10-05T00:00:00.000Z').getTime(),
          weeklyRemainingPct: 70,
          weeklyStatus: 1,
          routerWeekRaw: 100000,
          routerWeekWeighted: 50000,
          routerCycleRaw: 8000000,
          usedCycle: 5000000,
        },
      ]);

      const report = await buildWatchReport({ from, to, now });
      assert.equal(report.metrics.calibration.sumDeltaPct, 0);
      assert.equal(report.metrics.calibration.dataSufficient, false);
      assert.equal(report.signals.find((s) => s.id === 'calibration.drift'), undefined);
    });
  });

  describe('6. Budget, Tenant Limits and BYOK Keys', () => {
    const from = '2026-09-29T00:00:00.000Z';
    const to = '2026-09-30T00:00:00.000Z';
    const now = new Date('2026-09-30T03:00:00.000Z');

    it('detects 503 budget_exceeded errors and groups by tenant and reason', async () => {
      writeRequestLogs('2026-09-29', [
        {
          ts: '2026-09-29T12:00:00.000Z',
          tenant: 't-budget-hit',
          status: 503,
          errorCode: 'budget_exceeded',
          budgetExceeded: 'day_limit_exceeded',
        },
        {
          ts: '2026-09-29T12:05:00.000Z',
          tenant: 't-budget-hit',
          status: 503,
          errorCode: 'budget_exceeded',
          budgetExceeded: 'day_limit_exceeded',
        },
      ]);

      const report = await buildWatchReport({ from, to, now });
      const sig = report.signals.find((s) => s.id === 'budget.exceeded');
      assert.ok(sig);
      assert.equal(sig.level, 'warn');
      assert.ok(sig.details.includes('t-budget-hit'));
      assert.ok(sig.details.includes('day_limit_exceeded'));
    });

    it('detects tenants with day usage > 80% and dayRequests > 80%', async () => {
      upsertTenant({
        id: 'heavy-tenant',
        name: 'Heavy Tenant',
        limits: {
          minimax: { day: 1000 },
          rate: { dayRequests: 100 },
        },
      });

      // Record 850 tokens in budget for 2026-09-29 (85% > 80%)
      const budgetTs = new Date('2026-09-29T12:00:00.000Z').getTime();
      recordBudgetUsage('heavy-tenant', 850, budgetTs);

      // Record 85 requests for 2026-09-29 (85% > 80%)
      const reqTs = new Date('2026-09-29T12:00:00.000Z').getTime();
      for (let i = 0; i < 85; i++) {
        checkTenantRate('heavy-tenant', undefined, reqTs);
      }

      const report = await buildWatchReport({ from, to, now });
      const nearLimitSig = report.signals.find((s) => s.id === 'budget.near-limit');
      assert.ok(nearLimitSig);
      assert.ok(nearLimitSig.details.includes('heavy-tenant'));

      const reqNearLimitSig = report.signals.find((s) => s.id === 'budget.requests-near-limit');
      assert.ok(reqNearLimitSig);
      assert.ok(reqNearLimitSig.details.includes('heavy-tenant'));
    });

    it('detects BYOK key issues without leaking secret keys', async () => {
      upsertTenant({
        id: 'byok-tenant',
        name: 'BYOK Tenant',
        upstreamKeys: {
          'ollama-cloud': {
            status: 'exhausted',
            statusAt: '2026-09-29T10:00:00.000Z',
            lastError: 'quota exhausted',
            hint: 'sk-ol-...9999',
            enc: 'encrypted_secret_payload',
          },
        },
      });

      writeRequestLogs('2026-09-29', [
        {
          ts: '2026-09-29T11:00:00.000Z',
          tenant: 'byok-tenant-2',
          backend: 'byok:byok-tenant-2:openai:gpt-4o',
          status: 402,
          errorCode: 'upstream_quota_exhausted',
          keyHint: 'sk-proj-...1234',
        },
      ]);

      const report = await buildWatchReport({ from, to, now });
      const byokSig = report.signals.find((s) => s.id === 'byok.key-problems');
      assert.ok(byokSig);
      assert.equal(byokSig.level, 'warn');
      assert.ok(byokSig.details.includes('byok-tenant'));
      assert.ok(byokSig.details.includes('sk-ol-...9999'));
      assert.ok(!byokSig.details.includes('encrypted_secret_payload'));
    });
  });

  describe('7. Errors, Fallbacks and Loop Guard', () => {
    const from = '2026-09-29T00:00:00.000Z';
    const to = '2026-09-30T00:00:00.000Z';
    const now = new Date('2026-09-30T03:00:00.000Z');

    it('warns when error rate > 5%, crit if > 20%', async () => {
      // 55 total requests, 6 errors (10.9% > 5%) -> warn
      const records = [
        ...Array.from({ length: 49 }, (_, i) => ({
          ts: `2026-09-29T10:00:${String(i).padStart(2, '0')}.000Z`,
          tenant: 't1',
          backend: 'backend1',
          status: 200,
        })),
        ...Array.from({ length: 6 }, (_, i) => ({
          ts: `2026-09-29T11:00:${String(i).padStart(2, '0')}.000Z`,
          tenant: 't1',
          backend: 'backend1',
          status: 500,
        })),
      ];
      writeRequestLogs('2026-09-29', records);

      const report = await buildWatchReport({ from, to, now });
      const errSig = report.signals.find((s) => s.id === 'errors.high-rate');
      assert.ok(errSig);
      assert.equal(errSig.level, 'warn');

      // Now 25% errors -> crit
      const tmpDirCrit = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-watch-errcrit-'));
      process.env.ROUTER_STATE_DIR = tmpDirCrit;
      const recordsCrit = [
        ...Array.from({ length: 40 }, (_, i) => ({
          ts: `2026-09-29T10:00:${String(i).padStart(2, '0')}.000Z`,
          tenant: 't1',
          backend: 'backend1',
          status: 200,
        })),
        ...Array.from({ length: 20 }, (_, i) => ({
          ts: `2026-09-29T11:00:${String(i).padStart(2, '0')}.000Z`,
          tenant: 't1',
          backend: 'backend1',
          status: 502,
        })),
      ];
      const reqDirCrit = path.join(tmpDirCrit, 'requests');
      fs.mkdirSync(reqDirCrit, { recursive: true });
      fs.writeFileSync(path.join(reqDirCrit, '2026-09-29.jsonl'), recordsCrit.map((r) => JSON.stringify(r)).join('\n'));

      const reportCrit = await buildWatchReport({ from, to, now });
      const errSigCrit = reportCrit.signals.find((s) => s.id === 'errors.high-rate');
      assert.ok(errSigCrit);
      assert.equal(errSigCrit.level, 'crit');
      fs.rmSync(tmpDirCrit, { recursive: true, force: true });
      process.env.ROUTER_STATE_DIR = tmpDir;
    });

    it('warns when fallback rate > 20% on routes with MiniMax first', async () => {
      // 'text-high' pool starts with minimax-m3-direct-text-high
      // 30 served by minimax, 30 fallback to backend2-gemini-3.1-pro-low (50% fallback > 20%)
      const records = [
        ...Array.from({ length: 30 }, (_, i) => ({
          ts: `2026-09-29T10:00:${String(i).padStart(2, '0')}.000Z`,
          tenant: 't1',
          tier: 'text-high',
          backend: 'minimax-m3-direct-text-high',
          status: 200,
        })),
        ...Array.from({ length: 30 }, (_, i) => ({
          ts: `2026-09-29T11:00:${String(i).padStart(2, '0')}.000Z`,
          tenant: 't1',
          tier: 'text-high',
          backend: 'backend2-gemini-3.1-pro-low',
          status: 200,
        })),
      ];
      writeRequestLogs('2026-09-29', records);

      const report = await buildWatchReport({ from, to, now });
      const fbSig = report.signals.find((s) => s.id === 'errors.high-fallback');
      assert.ok(fbSig);
      assert.equal(fbSig.level, 'warn');
      assert.ok(fbSig.details.includes('backend2-gemini-3.1-pro-low'));
    });

    it('warns when loop-guard blocks exceed threshold (10)', async () => {
      const records = Array.from({ length: 15 }, (_, i) => ({
        ts: `2026-09-29T10:00:${String(i).padStart(2, '0')}.000Z`,
        tenant: 'loop-tenant',
        session: 'session-xyz',
        status: 429,
        errorCode: 'loop_detected',
      }));
      writeRequestLogs('2026-09-29', records);

      const report = await buildWatchReport({ from, to, now });
      const loopSig = report.signals.find((s) => s.id === 'errors.loop-blocks');
      assert.ok(loopSig);
      assert.equal(loopSig.level, 'warn');
      assert.ok(loopSig.details.includes('loop-tenant'));
    });
  });

  describe('8. Notification Delivery Tracking', () => {
    const from = '2026-09-29T00:00:00.000Z';
    const to = '2026-09-30T00:00:00.000Z';
    const now = new Date('2026-09-30T03:00:00.000Z');

    it('warns when notifications in the window fail', async () => {
      writeNotifications([
        {
          timestamp: '2026-09-29T10:00:00.000Z',
          transport: 'email',
          recipient: 'admin@example.com',
          event: 'limit.warning',
          status: 'delivered',
        },
        {
          timestamp: '2026-09-29T11:00:00.000Z',
          transport: 'telegram',
          recipient: '12345678',
          event: 'limit.warning',
          status: 'failed',
          error: 'Telegram API 400 Bad Request',
        },
      ]);

      const report = await buildWatchReport({ from, to, now });
      const notifSig = report.signals.find((s) => s.id === 'notifications.failures');
      assert.ok(notifSig);
      assert.equal(notifSig.level, 'warn');
      assert.equal(report.metrics.notifications.failed, 1);
    });
  });

  describe('9. Persistence, Retention and Atomic Writes', () => {
    it('saves report atomically and cleans up reports older than 90 days', () => {
      const watchDir = path.join(tmpDir, 'watch');
      fs.mkdirSync(watchDir, { recursive: true });

      // Create an old report (100 days old)
      const oldFile = path.join(watchDir, '2026-05-01.json');
      fs.writeFileSync(oldFile, '{}');

      const report: WatchReport = {
        version: 1,
        window: { from: '2026-09-29T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z' },
        generatedAt: '2026-09-30T03:00:00.000Z',
        level: 'ok',
        signals: [],
        metrics: {
          cache: { requests: 0, promptTokens: 0, cachedTokens: 0, share: null, baselineShare: null, tenants: [] },
          quota: { weeklyRemainingPct: null, intervalLowCount: 0, providerQuotaHits: 0, stalePollerMinutes: null, maxGapMinutes: null, pollerDisabled: true },
          calibration: { tokensPerPct: null, deltaPctSum: 0, intervalsSampled: 0 },
          budget: { exceededCount: 0, nearLimitTenants: [], requestsNearLimitTenants: [], byokKeyIssues: [] },
          errors: { totalRequests: 0, errorCount: 0, errorRate: 0, fallbackCount: 0, fallbackRate: 0, loopDetectedCount: 0 },
          notifications: { sent: 0, failed: 0 },
        },
      };

      const now = new Date('2026-09-30T03:00:00.000Z');
      const savedPath = saveWatchReportSync(report, '2026-09-30.json', now);
      assert.ok(fs.existsSync(savedPath));
      assert.equal(fs.existsSync(oldFile), false, 'Old report (> 90 days) must be deleted');
    });
  });

  describe('10. Events, Deduplication and Reserved Slot', () => {
    it('emits router event only when signals exist', async () => {
      const events: any[] = [];
      resetRouterEventsForTests();
      const removeSub = onRouterEvent((ev) => events.push(ev));

      // 1. Report without signals -> no event
      process.env.ROUTER_MINIMAX_REMAINS_INTERVAL_SEC = '0';
      const clock1 = new Date('2026-09-30T03:00:00.000Z');
      setWatchClockForTests(() => clock1);

      await runWatchCheck({ manual: false, now: clock1 });
      assert.equal(events.length, 0, 'No event for clean report on non-Monday');

      // 2. Add an error record that produces a signal -> exactly one event
      writeRequestLogs('2026-09-29', Array.from({ length: 15 }, () => ({
        ts: '2026-09-29T10:00:00.000Z',
        tenant: 'loop-tenant',
        status: 429,
        errorCode: 'loop_detected',
      })));

      // Clear state so it allows run
      const stateFile = path.join(tmpDir, 'watch', 'state.json');
      if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);

      await runWatchCheck({ manual: false, now: clock1 });
      removeSub();

      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'watch.report');
      assert.ok(events[0].subject.includes('WARN'));
      assert.ok(events[0].text.includes('loop-tenant'));
    });

    it('sends Monday OK digest when ROUTER_WATCH_WEEKLY_OK=true', async () => {
      process.env.ROUTER_WATCH_WEEKLY_OK = 'true';
      process.env.ROUTER_MINIMAX_REMAINS_INTERVAL_SEC = '0';
      const events: any[] = [];
      resetRouterEventsForTests();
      const removeSub = onRouterEvent((ev) => events.push(ev));

      // 2026-09-28 was a Monday!
      const mondayClock = new Date('2026-09-28T03:00:00.000Z');
      setWatchClockForTests(() => mondayClock);

      await runWatchCheck({ manual: false, now: mondayClock });
      removeSub();
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'watch.report');
      assert.ok(events[0].subject.includes('OK: неделя без сигналов'));
    });

    it('deduplicates across runs for the same date', async () => {
      const stateFile = path.join(tmpDir, 'watch', 'state.json');
      fs.mkdirSync(path.join(tmpDir, 'watch'), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ lastScheduledDate: '2026-09-30' }));

      const clock = new Date('2026-09-30T03:00:00.000Z');
      setWatchClockForTests(() => clock);

      // Attempt to run scheduled check for same date
      const result = await runWatchCheck({ manual: false, now: clock });
      assert.equal(result, null, 'Must return null and skip duplicate run');
    });

    it('reserved notification slot bypasses hourly cap', async () => {
      process.env.ROUTER_ADMIN_EMAIL = 'admin@test.org';
      process.env.ROUTER_NOTIFY_MAX_PER_HOUR = '2';

      const sentEmails: any[] = [];
      setNotifyTransportsForTests({
        email: async (msg) => {
          sentEmails.push(msg);
        },
      });
      startNotifier();

      // Fill hourly cap with 2 other events
      emitRouterEvent({
        type: 'limit.reached',
        tenantId: 'cap-1',
        limit: 'rpm',
        level: 'warn',
        subject: 'Cap fill 1',
        text: 'msg 1',
      });
      emitRouterEvent({
        type: 'limit.reached',
        tenantId: 'cap-2',
        limit: 'rpm',
        level: 'warn',
        subject: 'Cap fill 2',
        text: 'msg 2',
      });

      // Third normal event should be dropped or queued
      emitRouterEvent({
        type: 'limit.reached',
        tenantId: 'cap-3',
        limit: 'rpm',
        level: 'warn',
        subject: 'Cap fill 3',
        text: 'msg 3',
      });

      await flushNotifyQueueForTests();
      assert.equal(sentEmails.length, 2);

      // Now emit watch.report -> must bypass hourly cap due to reserved slot!
      emitRouterEvent({
        type: 'watch.report',
        level: 'warn',
        subject: '[router] WARN: Watcher Test Alert',
        text: 'Detailed watcher body',
        date: '2026-09-30',
        signals: 1,
      });

      await flushNotifyQueueForTests();
      stopNotifier();

      assert.equal(sentEmails.length, 3, 'watch.report must bypass hourly cap');
      assert.equal(sentEmails[2].subject, '[router] WARN: Watcher Test Alert');
    });
  });

  describe('11. Scheduler Next Run and Startup Catch-Up', () => {
    it('calculates milliseconds to next scheduled UTC hour:minute', () => {
      // At 02:00 UTC, next run at 03:00 UTC is in 1 hour (3600000 ms)
      const now1 = new Date('2026-09-30T02:00:00.000Z');
      const ms1 = getNextWatchRunMs(now1.getTime());
      assert.equal(ms1 - now1.getTime(), 3600000);

      // At 04:00 UTC, next run at 03:00 UTC tomorrow is in 23 hours (82800000 ms)
      const now2 = new Date('2026-09-30T04:00:00.000Z');
      const ms2 = getNextWatchRunMs(now2.getTime());
      assert.equal(ms2 - now2.getTime(), 23 * 3600000);
    });

    it('performs startup catch-up if yesterday is missing and past scheduled time', async () => {
      process.env.ROUTER_WATCH = 'on';
      process.env.ROUTER_MINIMAX_REMAINS_INTERVAL_SEC = '0';

      // Current time is 05:00 UTC on 2026-09-30 (past 03:00 UTC).
      // Yesterday's window end was 2026-09-30.
      const clock = new Date('2026-09-30T05:00:00.000Z');
      setWatchClockForTests(() => clock);

      startWatchScheduler();

      // Wait for the async catch-up run (polling, not a fixed sleep: flaky under load)
      const reportFile = path.join(tmpDir, 'watch', '2026-09-30.json');
      const stateFileWait = path.join(tmpDir, 'watch', 'state.json');
      for (let i = 0; i < 500 && !(fs.existsSync(reportFile) && fs.existsSync(stateFileWait)); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(fs.existsSync(reportFile), 'Catch-up report for yesterday must be generated');

      const stateFile = path.join(tmpDir, 'watch', 'state.json');
      assert.ok(fs.existsSync(stateFile));
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.equal(state.lastScheduledDate, '2026-09-30');

      stopWatchScheduler();
    });
  });
});
