import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isOverBudget,
  recordBudgetUsage,
  resetBudgetForTests,
  getTenantLimit,
} from '../src/core/budget.js';
import {
  upsertTenant,
  resetTenantsForTests,
} from '../src/core/tenants.js';
import {
  onRouterEvent,
  getRecentRouterEvents,
  resetRouterEventsForTests,
} from '../src/core/events.js';

describe('Per-Tenant MiniMax Budget Limits & Events (tests/tenant-budget.test.ts)', () => {
  let tmpDir: string;
  const originalStateDir = process.env.ROUTER_STATE_DIR;
  const originalTenantLimits = process.env.ROUTER_MINIMAX_TENANT_LIMITS;
  const originalUserLimits = process.env.ROUTER_MINIMAX_USER_LIMITS;
  const originalQuotaMax = process.env.ROUTER_MINIMAX_QUOTA_MAX;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-budget-test-'));
    process.env.ROUTER_STATE_DIR = tmpDir;
    resetTenantsForTests();
    resetBudgetForTests();
    resetRouterEventsForTests();
  });

  afterEach(() => {
    resetTenantsForTests();
    resetBudgetForTests();
    resetRouterEventsForTests();
    if (originalStateDir !== undefined) {
      process.env.ROUTER_STATE_DIR = originalStateDir;
    } else {
      delete process.env.ROUTER_STATE_DIR;
    }
    if (originalTenantLimits !== undefined) {
      process.env.ROUTER_MINIMAX_TENANT_LIMITS = originalTenantLimits;
    } else {
      delete process.env.ROUTER_MINIMAX_TENANT_LIMITS;
    }
    if (originalUserLimits !== undefined) {
      process.env.ROUTER_MINIMAX_USER_LIMITS = originalUserLimits;
    } else {
      delete process.env.ROUTER_MINIMAX_USER_LIMITS;
    }
    if (originalQuotaMax !== undefined) {
      process.env.ROUTER_MINIMAX_QUOTA_MAX = originalQuotaMax;
    } else {
      delete process.env.ROUTER_MINIMAX_QUOTA_MAX;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Registry limits override env field-by-field', () => {
    it('applies custom tenant record day limit while falling back to env for hour', () => {
      // Env sets default hour: 1,000,000 and day: 10,000,000
      process.env.ROUTER_MINIMAX_TENANT_LIMITS = JSON.stringify({
        '*': { hour: 1_000_000, day: 10_000_000 },
      });

      // Tenant registry overrides ONLY day limit to 500,000
      upsertTenant({
        id: 'tenant-budget-override',
        status: 'active',
        limits: {
          minimax: { day: 500_000 },
        },
        createdAt: '',
        updatedAt: '',
      });

      const now = Date.parse('2026-09-24T10:00:00.000Z');

      // Record 400k tokens
      recordBudgetUsage('tenant-budget-override', 400_000, now);
      assert.equal(isOverBudget('tenant-budget-override', now), null);

      // Record 100k more -> 500k total (exceeds day limit of 500k)
      recordBudgetUsage('tenant-budget-override', 100_001, now);
      const res = isOverBudget('tenant-budget-override', now);
      assert.ok(res);
      assert.equal(res?.reason, 'tenant-day');
      assert.equal(getTenantLimit('tenant-budget-override').day, 500_000);
      assert.equal(getTenantLimit('tenant-budget-override').hour, 1_000_000); // kept from env!
    });

    it('falls back to "*" template record before env', () => {
      process.env.ROUTER_MINIMAX_TENANT_LIMITS = JSON.stringify({
        '*': { hour: 5_000_000, day: 20_000_000 },
      });

      // Registry "*" sets hour limit to 200,000
      upsertTenant({
        id: '*',
        status: 'active',
        limits: {
          minimax: { hour: 200_000 },
        },
        createdAt: '',
        updatedAt: '',
      });

      const now = Date.parse('2026-09-24T10:00:00.000Z');

      // Unknown tenant uses registry "*" hour limit (200,000)
      recordBudgetUsage('unregistered-client', 200_001, now);
      const res = isOverBudget('unregistered-client', now);
      assert.ok(res);
      assert.equal(res?.reason, 'tenant-hour');
      assert.equal(getTenantLimit('unregistered-client').hour, 200_000);
    });
  });

  describe('Event emissions: budget.exceeded and budget.warning (80%)', () => {
    it('emits budget.exceeded event on first over-budget and dedupes within the hour', () => {
      upsertTenant({
        id: 't-exceeded',
        status: 'active',
        limits: {
          minimax: { hour: 100_000 },
        },
        createdAt: '',
        updatedAt: '',
      });

      const now = Date.parse('2026-09-24T11:00:00.000Z');
      recordBudgetUsage('t-exceeded', 150_000, now);

      const events: any[] = [];
      const unsubscribe = onRouterEvent((ev) => {
        if (ev.type === 'budget.exceeded') {
          events.push(ev);
        }
      });

      // First check: emits event
      const res1 = isOverBudget('t-exceeded', now);
      assert.ok(res1);
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'budget.exceeded');
      assert.equal(events[0].tenantId, 't-exceeded');
      assert.equal(events[0].reason, 'tenant-hour');

      // Second check in the same hour: deduped, does not re-emit
      const res2 = isOverBudget('t-exceeded', now + 10_000);
      assert.ok(res2);
      assert.equal(events.length, 1);

      // In the next hour: can emit again
      const nextHour = now + 3600_000;
      recordBudgetUsage('t-exceeded', 150_000, nextHour);
      isOverBudget('t-exceeded', nextHour);
      assert.equal(events.length, 2);

      unsubscribe();
    });

    it('emits budget.warning when tenant reaches 80% of daily limit', () => {
      upsertTenant({
        id: 't-warn',
        status: 'active',
        limits: {
          minimax: { day: 1_000_000 },
        },
        createdAt: '',
        updatedAt: '',
      });

      const now = Date.parse('2026-09-24T12:00:00.000Z');

      const warnings: any[] = [];
      const unsubscribe = onRouterEvent((ev) => {
        if (ev.type === 'budget.warning') {
          warnings.push(ev);
        }
      });

      // 700k tokens (70%): no warning
      recordBudgetUsage('t-warn', 700_000, now);
      assert.equal(warnings.length, 0);

      // Record 150k more -> 850k tokens (85% >= 80%): emits warning
      recordBudgetUsage('t-warn', 150_000, now);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].type, 'budget.warning');
      assert.equal(warnings[0].tenantId, 't-warn');
      assert.equal(warnings[0].window, 'day');
      assert.equal(warnings[0].percent, 80);

      // Record more tokens in the same day: deduped once per day
      recordBudgetUsage('t-warn', 50_000, now);
      assert.equal(warnings.length, 1);

      unsubscribe();
    });

    it('does NOT emit budget.exceeded for per-user limits', () => {
      process.env.ROUTER_MINIMAX_USER_LIMITS = JSON.stringify({
        '*': { hour: 50_000 },
      });

      upsertTenant({
        id: 't-user-limit',
        status: 'active',
        limits: {
          minimax: { hour: 10_000_000, day: 50_000_000 },
        },
        createdAt: '',
        updatedAt: '',
      });

      const now = Date.parse('2026-09-24T14:00:00.000Z');
      recordBudgetUsage('t-user-limit', 60_000, now, 'user-123');

      let emitted = false;
      const unsubscribe = onRouterEvent((ev) => {
        if (ev.type === 'budget.exceeded') {
          emitted = true;
        }
      });

      const res = isOverBudget('t-user-limit', now, 'user-123');
      assert.ok(res);
      assert.equal(res?.reason, 'user-hour');
      assert.equal(emitted, false, 'Should not emit budget.exceeded for per-user limits');

      unsubscribe();
    });
  });
  it('a `*` record never overrides env or built-in limits set for an exact tenant', () => {
    process.env.ROUTER_MINIMAX_TENANT_LIMITS = JSON.stringify({ 'proj-04': { day: 31_000_000, hour: 8_000_000 }, '*': { day: 2_000_000 } });
    process.env.ROUTER_MINIMAX_USER_LIMITS = JSON.stringify({ 'proj-04': { day: 8_000_000, hour: 2_000_000 } });
    upsertTenant({
      id: '*',
      status: 'active',
      limits: { minimax: { day: 1_000_000, hour: 100_000, user: { day: 10, hour: 1 } } },
      createdAt: '',
      updatedAt: '',
    } as any);
    assert.deepEqual(getTenantLimit('proj-04'), { day: 31_000_000, hour: 8_000_000 });
    assert.deepEqual(getTenantLimit('master-service'), { day: 30_000_000, hour: 6_000_000 });
    assert.deepEqual(getTenantLimit('unlisted'), { day: 1_000_000, hour: 100_000 });
  });

  it('env `*` does not override built-in per-tenant defaults (as before the registry)', () => {
    process.env.ROUTER_MINIMAX_TENANT_LIMITS = JSON.stringify({ '*': { day: 2_000_000, hour: 500_000 } });
    assert.deepEqual(getTenantLimit('companion-app'), { day: 15_000_000, hour: 3_000_000 });
    assert.deepEqual(getTenantLimit('other'), { day: 2_000_000, hour: 500_000 });
  });
});
