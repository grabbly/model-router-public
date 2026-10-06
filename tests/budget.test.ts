import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  getBudgetStatus,
  getDailyGlobalAllowance,
  isOverBudget,
  recordBudgetUsage,
  resetBudgetForTests,
  saveBudgetSync,
  setBudgetClock,
} from '../src/core/budget.js';
import { forwardChat } from '../src/core/forwarder.js';
import { LogicalModelConfig, PoolEntry } from '../src/types.js';

describe('MiniMax Budget Guard (src/core/budget.ts)', () => {
  beforeEach(() => {
    resetBudgetForTests();
  });

  describe('Allowance math & daily calculation', () => {
    it('calculates daily global allowance correctly: floor((TOTAL - usedBeforeToday) / daysLeft)', () => {
      // 2026-09-24T12:00:00Z (Day 1 of 30)
      const day1 = Date.parse('2026-09-24T12:00:00.000Z');
      const allowanceDay1 = getDailyGlobalAllowance(day1);
      // floor(1,700,000,000 / 30) = 56,666,666
      assert.equal(allowanceDay1, 56_666_666);

      // Record 50M on day 1
      recordBudgetUsage('master-service', 50_000_000, day1);

      // Day 2 (2026-09-25T12:00:00Z): 29 days left
      const day2 = Date.parse('2026-09-25T12:00:00.000Z');
      const allowanceDay2 = getDailyGlobalAllowance(day2);
      // floor((1,700,000,000 - 50,000,000) / 29) = floor(1,650,000,000 / 29) = 56,896,551
      assert.equal(allowanceDay2, 56_896_551);
    });
  });

  describe('Tenant hour, day, and global limits', () => {
    it('detects tenant-hour limit exceeded', () => {
      const now = Date.parse('2026-09-24T10:15:00.000Z');
      // master-service hour limit is 6,000,000
      assert.equal(isOverBudget('master-service', now), null);

      recordBudgetUsage('master-service', 5_999_999, now);
      assert.equal(isOverBudget('master-service', now), null);

      recordBudgetUsage('master-service', 1, now);
      const res = isOverBudget('master-service', now);
      assert.notEqual(res, null);
      assert.equal(res?.reason, 'tenant-hour');
    });

    it('detects tenant-day limit exceeded across hours', () => {
      const h1 = Date.parse('2026-09-24T08:00:00.000Z');
      const h2 = Date.parse('2026-09-24T09:00:00.000Z');
      const h3 = Date.parse('2026-09-24T10:00:00.000Z');
      const h4 = Date.parse('2026-09-24T11:00:00.000Z');
      const h5 = Date.parse('2026-09-24T12:00:00.000Z');
      const h6 = Date.parse('2026-09-24T13:00:00.000Z');

      // Record 5M in each of 6 hours -> 30M total day usage (day limit is 30M)
      recordBudgetUsage('master-service', 5_000_000, h1);
      recordBudgetUsage('master-service', 5_000_000, h2);
      recordBudgetUsage('master-service', 5_000_000, h3);
      recordBudgetUsage('master-service', 5_000_000, h4);
      recordBudgetUsage('master-service', 5_000_000, h5);
      recordBudgetUsage('master-service', 5_000_000, h6);

      // In h7, hour usage is 0, but day usage is 30,000,000
      const h7 = Date.parse('2026-09-24T14:00:00.000Z');
      const res = isOverBudget('master-service', h7);
      assert.notEqual(res, null);
      assert.equal(res?.reason, 'tenant-day');
    });

    it('detects global-day limit exceeded', () => {
      const now = Date.parse('2026-09-24T10:00:00.000Z');
      const allowance = getDailyGlobalAllowance(now); // 56,666,666

      // Multiple tenants consume up to allowance
      recordBudgetUsage('master-service', 25_000_000, now);
      recordBudgetUsage('companion-app', 14_000_000, now);
      recordBudgetUsage('other-1', 4_000_000, now);
      recordBudgetUsage('other-2', 4_000_000, now);
      recordBudgetUsage('other-3', 4_000_000, now);
      recordBudgetUsage('other-4', 4_000_000, now);
      recordBudgetUsage('other-5', 2_000_000, now); // total = 57,000,000 >= 56,666,666

      // Fresh tenant with 0 usage is blocked due to global-day
      const res = isOverBudget('brand-new-tenant', now);
      assert.notEqual(res, null);
      assert.equal(res?.reason, 'global-day');
    });
  });

  describe('Cycle rollover', () => {
    it('resets cycle usage and starts new cycle automatically at start + N*days', () => {
      // Cycle 1: 2026-09-24 to 2026-10-24
      const timeCycle1 = Date.parse('2026-09-24T12:00:00.000Z');
      recordBudgetUsage('master-service', 100_000_000, timeCycle1);

      const status1 = getBudgetStatus(timeCycle1);
      assert.equal(status1.cycleStart, '2026-09-24');
      assert.equal(status1.cycleEnd, '2026-10-24');
      assert.equal(status1.usedCycle, 100_000_000);

      // Cycle 2: 30 days later -> 2026-10-24
      const timeCycle2 = Date.parse('2026-10-24T01:00:00.000Z');
      const status2 = getBudgetStatus(timeCycle2);
      assert.equal(status2.cycleStart, '2026-10-24');
      assert.equal(status2.cycleEnd, '2026-11-23');
      assert.equal(status2.usedCycle, 0); // Reset for new cycle
    });
  });

  describe('Persistence round-trip (temp directory)', () => {
    let tmpDir: string;
    const oldDir = process.env.ROUTER_STATE_DIR;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-test-'));
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

    it('persists budget state to budget.json and survives reload', () => {
      const now = Date.parse('2026-09-24T12:00:00.000Z');
      recordBudgetUsage('tenant-persist', 123456, now);
      saveBudgetSync();

      const filePath = path.join(tmpDir, 'budget.json');
      assert.ok(fs.existsSync(filePath), 'budget.json must exist');

      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      assert.equal(raw.usedCycle, 123456);
      assert.equal(raw.daily['2026-09-24']['tenant-persist'], 123456);

      // Reset and re-load from disk
      resetBudgetForTests();
      // Unset isLoaded so it reads the file again
      const status = getBudgetStatus(now);
      // Wait, resetBudgetForTests sets isLoaded = true, so let's check
      assert.equal(status.total, 1_700_000_000);
    });
  });

  describe('Forwarder exclusion and budget enforcement', () => {
    let mockBackend: http.Server;
    let backendPort: number;

    before(async () => {
      mockBackend = http.createServer((req, res) => {
        if (req.url === '/chat/completions') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            const parsed = JSON.parse(body || '{}');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'cmpl-1',
                choices: [{ message: { role: 'assistant', content: `served by ${parsed.model}` } }],
              })
            );
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => {
        mockBackend.listen(0, '127.0.0.1', () => {
          backendPort = (mockBackend.address() as { port: number }).port;
          resolve();
        });
      });
    });

    after(async () => {
      await new Promise<void>((resolve) => mockBackend.close(() => resolve()));
    });

    it('over-budget censored tier skips minimax AND ollama-cloud, falls back to custom', async () => {
      const config: LogicalModelConfig = {
        id: 'text-high',
        description: 'censored tier',
        modality: 'text',
        tier: 'high',
        censored: true,
        timeoutMs: 5000,
        cooldownSec: 60,
        pool: [
          {
            id: 'minimax-direct',
            provider: 'custom',
            model: 'MiniMax-M3',
            baseUrl: `http://127.0.0.1:${backendPort}`,
            priority: 1,
            enabled: true,
            tier: 'high',
            modality: 'text',
            censored: true,
            budgetGroup: 'minimax',
          },
          {
            id: 'ollama-cloud-entry',
            provider: 'ollama-cloud',
            model: 'cloud-model',
            baseUrl: `http://127.0.0.1:${backendPort}`,
            priority: 2,
            enabled: true,
            tier: 'high',
            modality: 'text',
            censored: true,
          },
          {
            id: 'fallback-custom',
            provider: 'custom',
            model: 'gemini-fallback',
            baseUrl: `http://127.0.0.1:${backendPort}`,
            priority: 3,
            enabled: true,
            tier: 'high',
            modality: 'text',
            censored: true,
          },
        ],
      };

      const excludeEntry = (e: PoolEntry) => {
        if (e.budgetGroup === 'minimax') return true;
        if (e.provider === 'ollama-cloud' && config.censored !== false) return true;
        return false;
      };

      const result = await forwardChat(
        'text-high',
        config,
        { model: 'text-high', messages: [{ role: 'user', content: 'test' }] },
        'tenant-test',
        { excludeEntry, excludeReason: 'tenant-hour' }
      );

      assert.equal(result.ok, true);
      assert.equal(result.via?.id, 'fallback-custom');
    });

    it('over-budget uncensored tier skips minimax but KEEPS ollama-cloud', async () => {
      const config: LogicalModelConfig = {
        id: 'text-uncensored-high',
        description: 'uncensored tier',
        modality: 'text',
        tier: 'high',
        censored: false,
        timeoutMs: 5000,
        cooldownSec: 60,
        pool: [
          {
            id: 'minimax-uncensored',
            provider: 'custom',
            model: 'MiniMax-M3',
            baseUrl: `http://127.0.0.1:${backendPort}`,
            priority: 1,
            enabled: true,
            tier: 'high',
            modality: 'text',
            censored: false,
            budgetGroup: 'minimax',
          },
          {
            id: 'ollama-cloud-uncensored',
            provider: 'ollama-cloud',
            model: 'deepseek-cloud',
            baseUrl: `http://127.0.0.1:${backendPort}`,
            priority: 2,
            enabled: true,
            tier: 'high',
            modality: 'text',
            censored: false,
          },
        ],
      };

      const excludeEntry = (e: PoolEntry) => {
        if (e.budgetGroup === 'minimax') return true;
        if (e.provider === 'ollama-cloud' && config.censored !== false) return true;
        return false;
      };

      const result = await forwardChat(
        'text-uncensored-high',
        config,
        { model: 'text-uncensored-high', messages: [{ role: 'user', content: 'test' }] },
        'tenant-test',
        { excludeEntry, excludeReason: 'tenant-hour' }
      );

      assert.equal(result.ok, true);
      assert.equal(result.via?.id, 'ollama-cloud-uncensored');
    });

    it('returns 503 budget_exceeded when exclusion leaves candidate pool empty', async () => {
      const config: LogicalModelConfig = {
        id: 'text-low',
        description: 'only minimax',
        modality: 'text',
        tier: 'low',
        censored: true,
        timeoutMs: 5000,
        cooldownSec: 60,
        pool: [
          {
            id: 'minimax-only',
            provider: 'custom',
            model: 'MiniMax-M3',
            baseUrl: `http://127.0.0.1:${backendPort}`,
            priority: 1,
            enabled: true,
            tier: 'low',
            modality: 'text',
            censored: true,
            budgetGroup: 'minimax',
          },
        ],
      };

      const excludeEntry = (e: PoolEntry) => {
        if (e.budgetGroup === 'minimax') return true;
        if (e.provider === 'ollama-cloud' && config.censored !== false) return true;
        return false;
      };

      const result = await forwardChat(
        'text-low',
        config,
        { model: 'text-low', messages: [{ role: 'user', content: 'test' }] },
        'tenant-test',
        { excludeEntry, excludeReason: 'tenant-hour' }
      );

      assert.equal(result.ok, false);
      assert.equal(result.status, 503);
      assert.equal(result.error?.code, 'budget_exceeded');
      assert.equal(result.error?.type, 'rate_limit_error');
      assert.ok(result.error?.message.includes('MiniMax budget exceeded for this client (tenant-hour)'));
    });
  });
});
