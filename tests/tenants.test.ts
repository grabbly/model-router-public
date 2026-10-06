import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateTenantRecord,
  upsertTenant,
  getTenant,
  listTenants,
  deleteTenant,
  resolveRateLimits,
  resolveLoopLimits,
  resolveMinimaxLimits,
  resetTenantsForTests,
  setTenantsClockForTests,
  TenantRecord,
} from '../src/core/tenants.js';

describe('Tenants Registry (src/core/tenants.ts)', () => {
  let tmpDir: string;
  const originalStateDir = process.env.ROUTER_STATE_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-tenants-test-'));
    process.env.ROUTER_STATE_DIR = tmpDir;
    resetTenantsForTests();
  });

  afterEach(() => {
    resetTenantsForTests();
    if (originalStateDir !== undefined) {
      process.env.ROUTER_STATE_DIR = originalStateDir;
    } else {
      delete process.env.ROUTER_STATE_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('validateTenantRecord', () => {
    it('accepts a valid minimal record', () => {
      const record = {
        id: 'tenant-1',
        status: 'active' as const,
      };
      const res = validateTenantRecord(record);
      assert.equal(res.ok, true, `Validation errors: ${res.errors.join(', ')}`);
      assert.equal(res.errors.length, 0);
    });

    it('accepts a valid full record', () => {
      const record: TenantRecord = {
        id: 'team_alpha.01',
        name: 'Alpha Team',
        status: 'active',
        tokenVersion: 2,
        limits: {
          rate: { rpm: 60, concurrent: 5, dayRequests: 1000 },
          loop: { mode: 'enforce', maxReq: 30, reqWindowSec: 300, maxTokens: 100000, tokenWindowSec: 600, maxRepeat: 3, blockSec: 900 },
          minimax: {
            day: 50,
            hour: 10,
            user: { day: 20, hour: 5 },
            quotaMax: { dayShare: 0.5, hourShare: 0.25 },
          },
          agents: {
            'code-reviewer': {
              rate: { rpm: 120 },
              loop: { maxReq: 50 },
            },
          },
        },
        notify: {
          email: ['admin@example.com', 'alerts@company.org'],
          telegram: ['123456789', '-100987654321'],
          lang: 'ru',
        },
        notes: 'Production tenant for team Alpha',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      const res = validateTenantRecord(record);
      assert.equal(res.ok, true, `Validation errors: ${res.errors.join(', ')}`);
    });

    it('accepts special tenant id "*"', () => {
      const res = validateTenantRecord({ id: '*', status: 'active' });
      assert.equal(res.ok, true);
    });

    it('rejects invalid tenant IDs', () => {
      const badIds = ['', '   ', 'tenant/1', 'tenant:1', 'tenant@1', 'tenant name', 'a'.repeat(65)];
      for (const id of badIds) {
        const res = validateTenantRecord({ id, status: 'active' });
        assert.equal(res.ok, false, `Expected id "${id}" to fail validation`);
        assert.ok(res.errors.some(e => e.includes('id')));
      }
    });

    it('rejects invalid status', () => {
      const res = validateTenantRecord({ id: 't1', status: 'paused' as any });
      assert.equal(res.ok, false);
      assert.ok(res.errors.some(e => e.includes('status')));
    });

    it('accepts valid overlay settings', () => {
      assert.equal(validateTenantRecord({ id: 't1', status: 'active', overlay: 'auto' }).ok, true);
      assert.equal(validateTenantRecord({ id: 't1', status: 'active', overlay: 'off' }).ok, true);
    });

    it('rejects invalid overlay settings', () => {
      for (const val of ['on', 'disabled', 'true', true, 123, null]) {
        const res = validateTenantRecord({ id: 't1', status: 'active', overlay: val as any });
        assert.equal(res.ok, false, `Expected overlay "${val}" to fail`);
        assert.ok(res.errors.some(e => e.includes('"overlay"')));
      }
    });

    it('accepts valid thinkingWithTools settings', () => {
      assert.equal(validateTenantRecord({ id: 't1', status: 'active', thinkingWithTools: 'model-default' }).ok, true);
      assert.equal(validateTenantRecord({ id: 't1', status: 'active', thinkingWithTools: 'off' }).ok, true);
    });

    it('rejects invalid thinkingWithTools settings', () => {
      for (const val of ['on', 'disabled', 'adaptive', true, 123, null]) {
        const res = validateTenantRecord({ id: 't1', status: 'active', thinkingWithTools: val as any });
        assert.equal(res.ok, false, `Expected thinkingWithTools "${val}" to fail`);
        assert.ok(res.errors.some(e => e.includes('"thinkingWithTools"')));
      }
    });

    it('rejects negative or non-integer rate limits', () => {
      const badCases = [
        { rate: { rpm: -1 } },
        { rate: { rpm: 12.5 } },
        { rate: { concurrent: -5 } },
        { rate: { dayRequests: -100 } },
      ];
      for (const limits of badCases) {
        const res = validateTenantRecord({ id: 't1', status: 'active', limits: limits as any });
        assert.equal(res.ok, false, `Expected limits ${JSON.stringify(limits)} to fail`);
      }
    });

    it('rejects invalid loop limits', () => {
      const badCases = [
        { loop: { mode: 'super-strict' } },
        { loop: { maxReq: -1 } },
        { loop: { reqWindowSec: 0.5 } },
        { loop: { maxTokens: -10 } },
        { loop: { tokenWindowSec: -60 } },
        { loop: { maxRepeat: -2 } },
        { loop: { blockSec: -30 } },
      ];
      for (const limits of badCases) {
        const res = validateTenantRecord({ id: 't1', status: 'active', limits: limits as any });
        assert.equal(res.ok, false, `Expected loop limits ${JSON.stringify(limits)} to fail`);
      }
    });

    it('rejects invalid minimax limits and quota shares', () => {
      const badCases = [
        { minimax: { day: -1 } },
        { minimax: { hour: -1 } },
        { minimax: { user: { day: -5 } } },
        { minimax: { quotaMax: { dayShare: 1.5 } } }, // > 1
        { minimax: { quotaMax: { hourShare: -0.1 } } }, // < 0
      ];
      for (const limits of badCases) {
        const res = validateTenantRecord({ id: 't1', status: 'active', limits: limits as any });
        assert.equal(res.ok, false, `Expected minimax limits ${JSON.stringify(limits)} to fail`);
      }
    });

    it('rejects invalid notify fields', () => {
      assert.equal(validateTenantRecord({ id: 't1', status: 'active', notify: { email: ['not-an-email'] } }).ok, false);
      assert.equal(validateTenantRecord({ id: 't1', status: 'active', notify: { telegram: [12345 as any] } }).ok, false);
      assert.equal(validateTenantRecord({ id: 't1', status: 'active', notify: { lang: 'de' as any } }).ok, false);
    });

    it('rejects unknown top-level or nested keys', () => {
      const resTop = validateTenantRecord({ id: 't1', status: 'active', unknownKey: 123 } as any);
      assert.equal(resTop.ok, false);
      assert.ok(resTop.errors.some(e => e.includes('unknownKey')));

      const resNested = validateTenantRecord({
        id: 't1',
        status: 'active',
        limits: { rate: { rpm: 10, invalidRateKey: 5 } as any },
      });
      assert.equal(resNested.ok, false);
      assert.ok(resNested.errors.some(e => e.includes('invalidRateKey')));
    });
  });

  describe('CRUD operations & atomic persistence', () => {
    it('upsertTenant creates new record, saves atomically, and getTenant retrieves it', () => {
      const record: TenantRecord = {
        id: 'tenant-crud',
        name: 'CRUD Tenant',
        status: 'active',
        tokenVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      upsertTenant(record);

      const retrieved = getTenant('tenant-crud');
      assert.ok(retrieved);
      assert.equal(retrieved.id, 'tenant-crud');
      assert.equal(retrieved.name, 'CRUD Tenant');
      assert.equal(retrieved.tokenVersion, 1);

      // Verify file on disk
      const filePath = path.join(tmpDir, 'tenants.json');
      assert.ok(fs.existsSync(filePath), 'tenants.json must exist');
      const fileData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      assert.equal(fileData.version, 1);
      assert.ok(fileData.tenants['tenant-crud']);
    });

    it('listTenants lists all records', () => {
      upsertTenant({ id: 't1', status: 'active', createdAt: '', updatedAt: '' });
      upsertTenant({ id: 't2', status: 'disabled', createdAt: '', updatedAt: '' });

      const all = listTenants();
      assert.equal(all.length, 2);
      assert.ok(all.some(t => t.id === 't1'));
      assert.ok(all.some(t => t.id === 't2'));
    });

    it('deleteTenant removes record and persists file', () => {
      upsertTenant({ id: 't-del', status: 'active', createdAt: '', updatedAt: '' });
      assert.ok(getTenant('t-del'));

      const deleted = deleteTenant('t-del');
      assert.equal(deleted, true);
      assert.equal(getTenant('t-del'), null);

      const filePath = path.join(tmpDir, 'tenants.json');
      const fileData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      assert.equal(fileData.tenants['t-del'], undefined);

      // Deleting non-existent returns false
      assert.equal(deleteTenant('non-existent'), false);
    });
  });

  describe('Resolution order: agent override -> tenant record -> * template -> defaults', () => {
    it('resolves rate limits field-by-field', () => {
      // 1. Template '*' sets default dayRequests and rpm
      upsertTenant({
        id: '*',
        status: 'active',
        limits: {
          rate: { rpm: 60, dayRequests: 500 },
        },
        createdAt: '',
        updatedAt: '',
      });

      // 2. Tenant 't-rate' overrides rpm and sets concurrent
      upsertTenant({
        id: 't-rate',
        status: 'active',
        limits: {
          rate: { rpm: 120, concurrent: 10 },
          agents: {
            'fast-agent': {
              rate: { rpm: 300 },
            },
          },
        },
        createdAt: '',
        updatedAt: '',
      });

      // Without agent: rpm from tenant (120), concurrent from tenant (10), dayRequests from '*' (500)
      const resNormal = resolveRateLimits('t-rate');
      assert.equal(resNormal.rpm, 120);
      assert.equal(resNormal.concurrent, 10);
      assert.equal(resNormal.dayRequests, 500);

      // With agent 'fast-agent': rpm from agent (300), concurrent from tenant (10), dayRequests from '*' (500)
      const resAgent = resolveRateLimits('t-rate', 'fast-agent');
      assert.equal(resAgent.rpm, 300);
      assert.equal(resAgent.concurrent, 10);
      assert.equal(resAgent.dayRequests, 500);

      // With an unknown agent: falls back to tenant
      const resOtherAgent = resolveRateLimits('t-rate', 'other-agent');
      assert.equal(resOtherAgent.rpm, 120);
      assert.equal(resOtherAgent.concurrent, 10);
      assert.equal(resOtherAgent.dayRequests, 500);

      // Tenant with no record: falls back to '*' template
      const resUnknown = resolveRateLimits('unknown-tenant');
      assert.equal(resUnknown.rpm, 60);
      assert.equal(resUnknown.concurrent, undefined);
      assert.equal(resUnknown.dayRequests, 500);
    });

    it('resolves loop limits field-by-field', () => {
      upsertTenant({
        id: '*',
        status: 'active',
        limits: {
          loop: { mode: 'dry-run', maxReq: 50, reqWindowSec: 300 },
        },
        createdAt: '',
        updatedAt: '',
      });

      upsertTenant({
        id: 't-loop',
        status: 'active',
        limits: {
          loop: { mode: 'enforce', maxRepeat: 4 },
          agents: {
            'noisy-agent': {
              loop: { maxReq: 80 },
            },
          },
        },
        createdAt: '',
        updatedAt: '',
      });

      // Normal tenant: mode 'enforce' (tenant), maxRepeat 4 (tenant), maxReq 50 (*), reqWindowSec 300 (*)
      const resNormal = resolveLoopLimits('t-loop');
      assert.equal(resNormal.mode, 'enforce');
      assert.equal(resNormal.maxRepeat, 4);
      assert.equal(resNormal.maxReq, 50);
      assert.equal(resNormal.reqWindowSec, 300);

      // With noisy-agent: maxReq 80 (agent), mode 'enforce' (tenant), maxRepeat 4 (tenant), reqWindowSec 300 (*)
      const resAgent = resolveLoopLimits('t-loop', 'noisy-agent');
      assert.equal(resAgent.maxReq, 80);
      assert.equal(resAgent.mode, 'enforce');
      assert.equal(resAgent.maxRepeat, 4);
      assert.equal(resAgent.reqWindowSec, 300);
    });

    it('resolves minimax limits field-by-field', () => {
      upsertTenant({
        id: '*',
        status: 'active',
        limits: {
          minimax: {
            hour: 20,
            user: { day: 15, hour: 5 },
            quotaMax: { dayShare: 0.8 },
          },
        },
        createdAt: '',
        updatedAt: '',
      });

      upsertTenant({
        id: 't-minimax',
        status: 'active',
        limits: {
          minimax: {
            day: 100,
            user: { hour: 10 },
            quotaMax: { hourShare: 0.4 },
          },
        },
        createdAt: '',
        updatedAt: '',
      });

      const res = resolveMinimaxLimits('t-minimax');
      assert.equal(res.day, 100); // from tenant
      assert.equal(res.hour, 20); // from '*'
      assert.equal(res.user?.day, 15); // from '*'
      assert.equal(res.user?.hour, 10); // from tenant
      assert.equal(res.quotaMax?.dayShare, 0.8); // from '*'
      assert.equal(res.quotaMax?.hourShare, 0.4); // from tenant
    });
  });

  describe('Hot reload & crash resilience', () => {
    it('reloads when file is modified externally', async () => {
      let now = 100_000;
      setTenantsClockForTests(() => now);

      upsertTenant({ id: 't1', status: 'active', createdAt: '', updatedAt: '' });
      assert.ok(getTenant('t1'));
      assert.equal(getTenant('t2'), null);

      // Externally update the file
      const filePath = path.join(tmpDir, 'tenants.json');
      const updatedJson = {
        version: 1,
        tenants: {
          t1: { id: 't1', status: 'active', createdAt: '', updatedAt: '' },
          t2: { id: 't2', name: 'External Tenant', status: 'active', createdAt: '', updatedAt: '' },
        },
      };
      fs.writeFileSync(filePath, JSON.stringify(updatedJson), 'utf-8');

      // Advance clock by 10s (> 5s debounce)
      now += 10_000;

      // Next access reloads
      const reloadedT2 = getTenant('t2');
      assert.ok(reloadedT2, 't2 should be reloaded from disk');
      assert.equal(reloadedT2.name, 'External Tenant');
    });

    it('keeps last good in-memory copy when file contains broken JSON', () => {
      upsertTenant({ id: 'good-tenant', status: 'active', createdAt: '', updatedAt: '' });
      assert.ok(getTenant('good-tenant'));

      const filePath = path.join(tmpDir, 'tenants.json');
      const futureTime = new Date(Date.now() + 10000);
      fs.writeFileSync(filePath, '{ invalid json syntax !!!', 'utf-8');
      fs.utimesSync(filePath, futureTime, futureTime);

      // Reading should not throw and should retain good-tenant
      const stillGood = getTenant('good-tenant');
      assert.ok(stillGood, 'Should keep in-memory copy when file is broken');
      assert.equal(stillGood.id, 'good-tenant');
    });

    it('handles missing file gracefully by returning empty registry', () => {
      resetTenantsForTests();
      assert.equal(listTenants().length, 0);
      assert.equal(getTenant('any'), null);
    });
  });
});
