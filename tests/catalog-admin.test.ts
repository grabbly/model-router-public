import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { CONFIG } from '../src/config.js';
import { mintTenantToken } from '../src/auth/tenant-token.js';
import { clearCatalogsForTests, getCatalog, refreshCatalog, saveCatalogSync } from '../src/core/catalog.js';
import { keyFingerprint } from '../src/core/keys.js';
import { resetRouterEventsForTests } from '../src/core/events.js';

describe('Admin API for Catalog & Rules (tests/catalog-admin.test.ts)', () => {
  let app: FastifyInstance;
  let tmpDir: string;
  const originalStateDir = process.env.ROUTER_STATE_DIR;
  const originalFetch = global.fetch;
  const masterKey = 'admin-catalog-master-key-8888';
  const tenantSecret = 'admin-catalog-tenant-secret-9999';
  const testKey = 'test-ollama-admin-key-777';
  const testFp = keyFingerprint(testKey);

  before(async () => {
    CONFIG.serviceApiKey = masterKey;
    CONFIG.tenantTokenSecret = tenantSecret;
  });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-cat-admin-test-'));
    process.env.ROUTER_STATE_DIR = tmpDir;
    process.env.OLLAMA_API_KEY = testKey;
    clearCatalogsForTests();
    resetRouterEventsForTests();

    global.fetch = async (url: any) => {
      const u = String(url);
      if (u.endsWith('/models')) {
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'deepseek-v4.1-flash', created: 1789000000 },
              { id: 'deepseek-v4.2-flash', created: 1789000100 },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          capabilities: ['completion', 'tools'],
          details: { family: 'deepseek' },
          model_info: { 'deepseek.context_length': 128000 },
        }),
        { status: 200 }
      );
    };

    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    global.fetch = originalFetch;
    clearCatalogsForTests();
    resetRouterEventsForTests();
    if (originalStateDir !== undefined) {
      process.env.ROUTER_STATE_DIR = originalStateDir;
    } else {
      delete process.env.ROUTER_STATE_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Auth Protection', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/api/catalog',
      });
      assert.equal(res.statusCode, 401);
    });

    it('rejects tenant tokens with 403', async () => {
      const token = mintTenantToken('tenant-1', tenantSecret);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/api/catalog',
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(res.statusCode, 403);
    });

    it('accepts master key with 200', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/api/catalog',
        headers: { authorization: `Bearer ${masterKey}` },
      });
      assert.equal(res.statusCode, 200);
    });
  });

  describe('GET /admin/api/catalog', () => {
    it('returns empty catalogs initially when none loaded', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/api/catalog',
        headers: { authorization: `Bearer ${masterKey}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(Array.isArray(body.catalogs));
      assert.ok(Array.isArray(body.rules));
      // Rules list reflects active configured rule entries
      assert.ok(body.rules.length > 0);
      const textHighRule = body.rules.find((r: any) => r.ruleId === 'ollama-cloud-deepseek-flash-high');
      assert.ok(textHighRule, 'Should list default text-high rule');
      assert.equal(textHighRule.route, 'text-high');
    });

    it('returns catalog models with admission and rules resolution after refresh', async () => {
      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey);

      const res = await app.inject({
        method: 'GET',
        url: '/admin/api/catalog',
        headers: { authorization: `Bearer ${masterKey}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.catalogs.length, 1);
      const cat = body.catalogs[0];
      assert.equal(cat.provider, 'ollama-cloud');
      assert.equal(cat.fp, testFp);
      assert.ok(cat.models['deepseek-v4.1-flash']);
      assert.ok(cat.models['deepseek-v4.2-flash']);

      // Pre-admission admitted deepseek-v4.1-flash
      assert.equal(cat.models['deepseek-v4.1-flash'].admission?.status, 'admitted');

      const textHighRule = body.rules.find((r: any) => r.ruleId === 'ollama-cloud-deepseek-flash-high');
      assert.ok(textHighRule);
      assert.deepEqual(textHighRule.resolved, ['deepseek-v4.1-flash']);
    });
  });

  describe('POST /admin/api/catalog/refresh', () => {
    it('refreshes all registered catalogs and returns summary', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/api/catalog/refresh',
        headers: { authorization: `Bearer ${masterKey}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.ok, true);
      assert.ok(Array.isArray(body.refreshed));
      assert.ok(typeof body.timestamp === 'number');

      // Check catalog is now populated in memory
      const cat = getCatalog('ollama-cloud', testFp);
      assert.ok(cat);
      assert.ok(cat.models['deepseek-v4.1-flash']);
    });
  });

  describe('POST /admin/api/catalog/:catalogId/models/:model/admit, block, reset', () => {
    beforeEach(async () => {
      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey);
    });

    it('returns 404 for non-existent catalog or model', async () => {
      const catId = `ollama-cloud-${testFp}`;
      const res1 = await app.inject({
        method: 'POST',
        url: '/admin/api/catalog/nonexistent-catalog/models/m1/admit',
        headers: { authorization: `Bearer ${masterKey}` },
      });
      assert.equal(res1.statusCode, 404);

      const res2 = await app.inject({
        method: 'POST',
        url: `/admin/api/catalog/${catId}/models/nonexistent-model/admit`,
        headers: { authorization: `Bearer ${masterKey}` },
      });
      assert.equal(res2.statusCode, 404);
    });

    it('admits model manually and persists', async () => {
      const catId = `ollama-cloud-${testFp}`;
      const res = await app.inject({
        method: 'POST',
        url: `/admin/api/catalog/${catId}/models/deepseek-v4.2-flash/admit`,
        headers: { authorization: `Bearer ${masterKey}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.ok, true);

      const cat = getCatalog('ollama-cloud', testFp);
      assert.equal(cat?.models['deepseek-v4.2-flash']?.manual, 'admit');
    });

    it('blocks model manually, excluding it from rule resolution', async () => {
      const catId = `ollama-cloud-${testFp}`;
      const res = await app.inject({
        method: 'POST',
        url: `/admin/api/catalog/${catId}/models/deepseek-v4.1-flash/block`,
        headers: { authorization: `Bearer ${masterKey}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.ok, true);

      const cat = getCatalog('ollama-cloud', testFp);
      assert.equal(cat?.models['deepseek-v4.1-flash']?.manual, 'block');

      // Now verify GET /admin/api/catalog reflects the change
      const catRes = await app.inject({
        method: 'GET',
        url: '/admin/api/catalog',
        headers: { authorization: `Bearer ${masterKey}` },
      });
      const catBody = catRes.json();
      const textHighRule = catBody.rules.find((r: any) => r.ruleId === 'ollama-cloud-deepseek-flash-high');
      // Candidate 1 was blocked, so it should not be in resolved
      assert.ok(!textHighRule.resolved.includes('deepseek-v4.1-flash'));
    });

    it('resets model manual override and admission state', async () => {
      const catId = `ollama-cloud-${testFp}`;
      // First block it
      await app.inject({
        method: 'POST',
        url: `/admin/api/catalog/${catId}/models/deepseek-v4.1-flash/block`,
        headers: { authorization: `Bearer ${masterKey}` },
      });

      // Then reset it
      const res = await app.inject({
        method: 'POST',
        url: `/admin/api/catalog/${catId}/models/deepseek-v4.1-flash/reset`,
        headers: { authorization: `Bearer ${masterKey}` },
      });
      assert.equal(res.statusCode, 200);

      const cat = getCatalog('ollama-cloud', testFp);
      assert.equal(cat?.models['deepseek-v4.1-flash']?.manual, undefined);
      assert.equal(cat?.models['deepseek-v4.1-flash']?.admission, undefined);
    });
  });

  describe('/admin/status with expanded rule entries', () => {
    it('shows expanded candidate pool entries in /admin/status', async () => {
      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey);

      const res = await app.inject({
        method: 'GET',
        url: '/admin/status',
        headers: { authorization: `Bearer ${masterKey}` },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(body.logicalModels);

      // Route text-high should contain an expanded entry
      const textHigh = body.logicalModels['text-high'];
      assert.ok(textHigh);
      assert.ok(Array.isArray(textHigh.candidates));
      const expandedCandidate = textHigh.candidates.find(
        (c: any) => c.id === 'ollama-cloud-deepseek-flash-high~deepseek-v4.1-flash'
      );
      assert.ok(expandedCandidate, 'Should contain entry expanded from rule');
      assert.equal(expandedCandidate.model, 'deepseek-v4.1-flash');
    });
  });
});
