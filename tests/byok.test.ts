import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { CONFIG } from '../src/config.js';
import { mintTenantToken } from '../src/auth/tenant-token.js';
import {
  upsertTenant,
  getTenant,
  resetTenantsForTests,
  validateTenantRecord,
  sanitizeTenantForApi,
  TenantRecord
} from '../src/core/tenants.js';
import { encryptSecret, decryptSecret } from '../src/core/secrets.js';
import { resolveEntryKey, dropDecryptedKeyCache, keyFingerprint } from '../src/core/keys.js';
import {
  getRawTenantRouteConfig,
  getTenantRouteConfig,
  getByokDefaultRules
} from '../src/core/byok-defaults.js';
import { resetRouterEventsForTests, onRouterEvent, RouterEvent } from '../src/core/events.js';
import { resetCooldowns, isCoolingDown } from '../src/core/cooldown.js';
import { resetPreselections } from '../src/core/selector.js';

describe('Phase 4 — BYOK (Bring Your Own Key)', () => {
  let tmpDir: string;
  const originalStateDir = process.env.ROUTER_STATE_DIR;
  const originalSecretsKey = process.env.ROUTER_SECRETS_KEY;
  const originalCloudBase = process.env.ROUTER_CLOUD_BASE_URL;
  const originalOllamaKey = process.env.OLLAMA_API_KEY;

  const masterAdminKey = 'master-admin-service-key-999';
  const tenantSecret = 'tenant-token-secret-888';
  const fakeSecretsMasterKey = crypto.randomBytes(32).toString('base64');

  before(() => {
    CONFIG.serviceApiKey = masterAdminKey;
    CONFIG.tenantTokenSecret = tenantSecret;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-byok-test-'));
    process.env.ROUTER_STATE_DIR = tmpDir;
    process.env.ROUTER_SECRETS_KEY = fakeSecretsMasterKey;
    resetTenantsForTests();
    resetRouterEventsForTests();
    resetCooldowns();
    resetPreselections();
    dropDecryptedKeyCache();
  });

  afterEach(() => {
    resetTenantsForTests();
    resetRouterEventsForTests();
    resetCooldowns();
    resetPreselections();
    dropDecryptedKeyCache();
    if (originalStateDir !== undefined) {
      process.env.ROUTER_STATE_DIR = originalStateDir;
    } else {
      delete process.env.ROUTER_STATE_DIR;
    }
    if (originalSecretsKey !== undefined) {
      process.env.ROUTER_SECRETS_KEY = originalSecretsKey;
    } else {
      delete process.env.ROUTER_SECRETS_KEY;
    }
    if (originalCloudBase !== undefined) {
      process.env.ROUTER_CLOUD_BASE_URL = originalCloudBase;
    } else {
      delete process.env.ROUTER_CLOUD_BASE_URL;
    }
    if (originalOllamaKey !== undefined) {
      process.env.OLLAMA_API_KEY = originalOllamaKey;
    } else {
      delete process.env.OLLAMA_API_KEY;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('1. Tenant Record Validation & Serialization', () => {
    it('rejects mode: "byok" without upstreamKeys', () => {
      const rec = {
        id: 'tenant-byok-1',
        mode: 'byok' as const,
      };
      const v = validateTenantRecord(rec);
      assert.equal(v.ok, false);
      assert.ok(v.errors.some((e) => e.includes('requires at least one upstream key')));
    });

    it('rejects mode: "byok" with empty upstreamKeys', () => {
      const rec = {
        id: 'tenant-byok-1',
        mode: 'byok' as const,
        upstreamKeys: {},
      };
      const v = validateTenantRecord(rec);
      assert.equal(v.ok, false);
      assert.ok(v.errors.some((e) => e.includes('requires at least one upstream key')));
    });

    it('accepts mode: "byok" with valid upstreamKeys', () => {
      const rec: TenantRecord = {
        id: 'tenant-byok-1',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc: encryptSecret('fake-ollama-key-12345'),
            hint: '…2345',
            fp: keyFingerprint('fake-ollama-key-12345'),
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
      };
      const v = validateTenantRecord(rec);
      assert.equal(v.ok, true);
    });

    it('rejects pools containing baseUrl (SSRF prevention)', () => {
      const rec: any = {
        id: 'tenant-byok-ssrf',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc: 'v1:a:b:c',
            hint: '…1234',
            fp: 'fp123',
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
        pools: {
          'text-high': [
            {
              id: 'custom-entry',
              provider: 'ollama-cloud',
              model: 'deepseek-v4.1-flash',
              baseUrl: 'http://malicious-internal-service:8080/v1',
            },
          ],
        },
      };
      const v = validateTenantRecord(rec);
      assert.equal(v.ok, false);
      assert.ok(v.errors.some((e) => e.includes('baseUrl') && e.includes('not permitted')));
    });

    it('rejects pools referencing a provider for which the tenant has no key', () => {
      const rec: any = {
        id: 'tenant-byok-no-key',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc: 'v1:a:b:c',
            hint: '…1234',
            fp: 'fp123',
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
        pools: {
          'text-high': [
            {
              id: 'openai-entry',
              provider: 'openai',
              model: 'gpt-4o',
            },
          ],
        },
      };
      const v = validateTenantRecord(rec);
      assert.equal(v.ok, false);
      assert.ok(v.errors.some((e) => e.includes('no key configured for provider "openai"')));
    });

    it('accepts valid pools override', () => {
      const rec: any = {
        id: 'tenant-byok-custom-pool',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc: 'v1:a:b:c',
            hint: '…1234',
            fp: 'fp123',
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
        pools: {
          'text-uncensored-high': [
            {
              id: 'custom-uncensored',
              provider: 'ollama-cloud',
              model: 'custom-uncensored-model',
            },
          ],
        },
      };
      const v = validateTenantRecord(rec);
      assert.equal(v.ok, true);
    });

    it('sanitizeTenantForApi strips enc field from upstreamKeys', () => {
      const rec: TenantRecord = {
        id: 'tenant-byok-sanitized',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc: 'v1:secret:encrypted:blob',
            hint: '…9999',
            fp: 'fp9999',
            addedAt: '2026-09-30T12:00:00Z',
            status: 'ok',
          },
        },
      };
      const sanitized = sanitizeTenantForApi(rec);
      assert.ok(sanitized.upstreamKeys);
      assert.equal((sanitized.upstreamKeys as any)['ollama-cloud'].enc, undefined);
      assert.equal(sanitized.upstreamKeys['ollama-cloud']?.hint, '…9999');
      assert.equal(sanitized.upstreamKeys['ollama-cloud']?.fp, 'fp9999');
    });
  });

  describe('2. Key Resolution & In-Memory Decryption Cache', () => {
    it('decrypts tenant key and caches it in memory by fingerprint', () => {
      const rawKey = 'obviously-fake-ollama-client-key-777';
      const fp = keyFingerprint(rawKey);
      const enc = encryptSecret(rawKey);

      upsertTenant({
        id: 'tenant-cache-test',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc,
            hint: '…k777',
            fp,
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
      });

      const entry = {
        id: 'byok:tenant-cache-test:entry-1',
        model: 'some-model',
        keyRef: {
          tenantId: 'tenant-cache-test',
          provider: 'ollama-cloud' as const,
        },
      };

      // 1. First resolution should decrypt and return the plain key
      const resolved1 = resolveEntryKey(entry as any);
      assert.equal(resolved1, rawKey);

      // 2. Corrupt master key in env: subsequent resolveEntryKey should still work due to memory cache
      process.env.ROUTER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
      const resolved2 = resolveEntryKey(entry as any);
      assert.equal(resolved2, rawKey);

      // 3. Drop cache: now decryption with wrong master key returns undefined (unusable key)
      dropDecryptedKeyCache(fp);
      assert.throws(() => decryptSecret(enc), /Failed to decrypt secret/);
      assert.equal(resolveEntryKey(entry as any), undefined);
    });

    it('never falls back to env key when entry has keyRef', () => {
      process.env.OLLAMA_API_KEY = 'env-ollama-key-should-never-be-used';

      upsertTenant({
        id: 'tenant-missing-key',
        mode: 'byok',
        upstreamKeys: {},
      });

      const entry = {
        id: 'byok:tenant-missing-key:entry-1',
        model: 'some-model',
        keyRef: {
          tenantId: 'tenant-missing-key',
          provider: 'ollama-cloud' as const,
        },
      };

      assert.equal(resolveEntryKey(entry as any), undefined);
    });
  });

  describe('3. BYOK Defaults & Route Configurations', () => {
    it('provides default rules for censored routes and empty defaults for uncensored routes', () => {
      assert.ok(getByokDefaultRules('text-high').length > 0);
      assert.ok(getByokDefaultRules('text-low').length > 0);
      assert.ok(getByokDefaultRules('text-summarize').length > 0);
      assert.ok(getByokDefaultRules('vision-high').length > 0);
      assert.ok(getByokDefaultRules('vision-low').length > 0);

      // Uncensored must be empty by default
      assert.equal(getByokDefaultRules('text-uncensored-high').length, 0);
      assert.equal(getByokDefaultRules('text-uncensored-low').length, 0);
      assert.equal(getByokDefaultRules('vision-uncensored-high').length, 0);
      assert.equal(getByokDefaultRules('vision-uncensored-low').length, 0);
    });

    it('binds entries with byok:<tenantId>:<id> and keyRef', () => {
      upsertTenant({
        id: 'client-abc',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc: encryptSecret('fake-key'),
            hint: '…fake',
            fp: keyFingerprint('fake-key'),
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
      });

      const rawCfg = getRawTenantRouteConfig('client-abc', 'text-high');
      assert.ok(rawCfg);
      assert.ok(rawCfg.pool.length > 0);
      for (const entry of rawCfg.pool) {
        assert.ok(entry.id.startsWith('byok:client-abc:'));
        assert.deepEqual(entry.keyRef, {
          tenantId: 'client-abc',
          provider: 'ollama-cloud',
        });
        assert.equal((entry as any).budgetGroup, undefined);
      }
    });

    it('uses tenant pools override when provided', () => {
      const customPool = [
        {
          id: 'manual-pinned-model',
          provider: 'ollama-cloud' as const,
          model: 'special-finetune:latest',
        },
      ];
      upsertTenant({
        id: 'client-custom',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc: encryptSecret('fake-key'),
            hint: '…fake',
            fp: keyFingerprint('fake-key'),
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
        pools: {
          'text-high': customPool,
        },
      });

      const rawCfg = getRawTenantRouteConfig('client-custom', 'text-high');
      assert.ok(rawCfg);
      assert.equal(rawCfg.pool.length, 1);
      assert.equal(rawCfg.pool[0].id, 'byok:client-custom:manual-pinned-model');
      assert.equal(rawCfg.pool[0].model, 'special-finetune:latest');
    });
  });

  describe('4. Admin API for Keys & Pools', () => {
    let app: FastifyInstance;
    let mockOllamaServer: http.Server;
    let mockOllamaPort: number;

    before(async () => {
      mockOllamaServer = http.createServer((req, res) => {
        const auth = req.headers.authorization;
        // Like real ollama.com: the model list is public, /api/me checks the key.
        if (req.url === '/api/me') {
          if (auth === 'Bearer invalid-key-xyz') {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid credentials' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Plan: 'free', Email: 'someone@example.com' }));
          return;
        }

        if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              object: 'list',
              data: [
                { id: 'deepseek-v4.1-flash', created: 1000 },
                { id: 'glm-5.3-flash', created: 2000 },
              ],
            })
          );
          return;
        }

        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((r) => mockOllamaServer.listen(0, '127.0.0.1', () => r()));
      mockOllamaPort = (mockOllamaServer.address() as any).port;
      CONFIG.cloudBaseUrl = `http://127.0.0.1:${mockOllamaPort}/v1`;

      app = buildApp();
      await app.ready();
    });

    after(async () => {
      await app.close();
      await new Promise<void>((r) => mockOllamaServer.close(() => r()));
    });

    it('rejects PUT key when ROUTER_SECRETS_KEY is missing', async () => {
      delete process.env.ROUTER_SECRETS_KEY;
      upsertTenant({ id: 'tenant-no-sec' });

      const res = await app.inject({
        method: 'PUT',
        url: '/admin/api/tenants/tenant-no-sec/keys/ollama-cloud',
        headers: { authorization: `Bearer ${masterAdminKey}` },
        payload: { key: 'some-key' },
      });
      assert.equal(res.statusCode, 400);
      const data = res.json();
      assert.equal(data.error?.code, 'secrets_not_configured');
    });

    it('rejects PUT key when upstream validation fails (401)', async () => {
      upsertTenant({ id: 'tenant-val-fail' });

      const res = await app.inject({
        method: 'PUT',
        url: '/admin/api/tenants/tenant-val-fail/keys/ollama-cloud',
        headers: { authorization: `Bearer ${masterAdminKey}` },
        payload: { key: 'invalid-key-xyz' },
      });
      assert.equal(res.statusCode, 400);
      const data = res.json();
      assert.equal(data.error?.code, 'invalid_key');
    });

    it('validates and stores key on PUT, never returning enc', async () => {
      upsertTenant({ id: 'tenant-valid-store' });

      const plainKey = 'valid-test-ollama-key-123';
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/api/tenants/tenant-valid-store/keys/ollama-cloud',
        headers: { authorization: `Bearer ${masterAdminKey}` },
        payload: { key: plainKey },
      });
      assert.equal(res.statusCode, 200);
      const data = res.json();
      assert.equal(data.status, 'ok');
      assert.ok(data.hint.includes('…'));
      assert.equal(data.models, 2);
      assert.equal(data.plan, 'free');
      assert.equal(data.enc, undefined);
      assert.ok(!JSON.stringify(data).includes('someone@example.com'), 'account e-mail must not leak');

      // Verify stored record in registry
      const stored = getTenant('tenant-valid-store');
      assert.ok(stored);
      assert.ok(stored.upstreamKeys?.['ollama-cloud']);
      assert.ok(stored.upstreamKeys?.['ollama-cloud']?.enc);
      assert.equal(stored.upstreamKeys['ollama-cloud']?.status, 'ok');

      // Verify GET tenant never exposes enc
      const getRes = await app.inject({
        method: 'GET',
        url: '/admin/api/tenants/tenant-valid-store',
        headers: { authorization: `Bearer ${masterAdminKey}` },
      });
      assert.equal(getRes.statusCode, 200);
      const getJson = getRes.json();
      assert.equal(getJson.upstreamKeys?.['ollama-cloud']?.enc, undefined);
      assert.ok(!JSON.stringify(getJson).includes(plainKey));
    });

    it('DELETE key rejects deleting last key of a byok tenant with 409 unless force=1 disables tenant', async () => {
      upsertTenant({
        id: 'tenant-del-key',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc: encryptSecret('fake-k'),
            hint: '…fake',
            fp: 'fp123',
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
      });

      // 1. Without force
      const res409 = await app.inject({
        method: 'DELETE',
        url: '/admin/api/tenants/tenant-del-key/keys/ollama-cloud',
        headers: { authorization: `Bearer ${masterAdminKey}` },
      });
      assert.equal(res409.statusCode, 409);

      // 2. With force=1: sets tenant status to disabled and deletes key
      const resForce = await app.inject({
        method: 'DELETE',
        url: '/admin/api/tenants/tenant-del-key/keys/ollama-cloud?force=1',
        headers: { authorization: `Bearer ${masterAdminKey}` },
      });
      assert.equal(resForce.statusCode, 200);

      const after = getTenant('tenant-del-key');
      assert.ok(after);
      assert.equal(after.status, 'disabled');
      assert.equal(after.mode, 'byok'); // Must NEVER switch to shared!
      assert.equal(after.upstreamKeys?.['ollama-cloud'], undefined);
    });

    it('GET /admin/api/tenants/:id/pools returns resolved pools', async () => {
      upsertTenant({
        id: 'tenant-pools-api',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc: encryptSecret('fake-k'),
            hint: '…fake',
            fp: 'fp123',
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/admin/api/tenants/tenant-pools-api/pools',
        headers: { authorization: `Bearer ${masterAdminKey}` },
      });
      assert.equal(res.statusCode, 200);
      const data = res.json();
      assert.ok(data.pools);
      assert.ok(Array.isArray(data.pools));
      const textHigh = data.pools.find((p: any) => p.route === 'text-high');
      assert.ok(textHigh);
      const uncensored = data.pools.find((p: any) => p.route === 'text-uncensored-high');
      assert.ok(uncensored);
      assert.equal(uncensored.entries.length, 0);
    });
  });

  describe('5. Chat Execution, Upstream Headers & Failover Isolation', () => {
    let app: FastifyInstance;
    let mockUpstream: http.Server;
    let mockPort: number;
    let lastAuthHeader: string | undefined;
    let requestCount = 0;
    let simulatedUpstreamBehavior: 'success' | '401' | 'quota429' | 'short429' | 'error500' = 'success';

    before(async () => {
      mockUpstream = http.createServer((req, res) => {
        lastAuthHeader = req.headers.authorization;
        requestCount++;

        if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              object: 'list',
              data: [
                { id: 'deepseek-v4.1-flash', created: 1000 },
                { id: 'glm-5.3-flash', created: 2000 },
              ],
            })
          );
          return;
        }

        if (req.url === '/v1/chat/completions') {
          if (simulatedUpstreamBehavior === '401') {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
            return;
          }
          if (simulatedUpstreamBehavior === 'quota429') {
            res.writeHead(429, {
              'Content-Type': 'application/json',
              'retry-after': '600',
            });
            res.end(JSON.stringify({ error: { message: 'Weekly usage quota exceeded' } }));
            return;
          }
          if (simulatedUpstreamBehavior === 'short429') {
            res.writeHead(429, {
              'Content-Type': 'application/json',
              'retry-after': '2',
            });
            res.end(JSON.stringify({ error: { message: 'Rate limit exceeded, slow down' } }));
            return;
          }
          if (simulatedUpstreamBehavior === 'error500') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Internal server error' } }));
            return;
          }

          // Success response
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion',
              created: 1700000000,
              model: 'deepseek-v4.1-flash',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Hello from mock upstream!' },
                  finish_reason: 'stop',
                },
              ],
            })
          );
          return;
        }

        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((r) => mockUpstream.listen(0, '127.0.0.1', () => r()));
      mockPort = (mockUpstream.address() as any).port;
      CONFIG.cloudBaseUrl = `http://127.0.0.1:${mockPort}/v1`;

      app = buildApp();
      await app.ready();
    });

    after(async () => {
      await app.close();
      await new Promise<void>((r) => mockUpstream.close(() => r()));
    });

    beforeEach(() => {
      lastAuthHeader = undefined;
      requestCount = 0;
      simulatedUpstreamBehavior = 'success';
    });

    it('sends the tenant API key in Authorization header and never our env key', async () => {
      process.env.OLLAMA_API_KEY = 'shared-env-ollama-key-secret';
      const tenantKey = 'client-secret-ollama-key-xyz999';

      upsertTenant({
        id: 'client-chat-1',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc: encryptSecret(tenantKey),
            hint: '…z999',
            fp: keyFingerprint(tenantKey),
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
        pools: {
          'text-high': [
            {
              id: 'pinned-test-model',
              provider: 'ollama-cloud',
              model: 'deepseek-v4.1-flash',
            },
          ],
        },
      });

      const token = mintTenantToken('client-chat-1', tenantSecret);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-router-app': 'test-app',
          'x-router-agent': 'test-agent',
          'x-router-session': 'test-session',
        },
        payload: {
          model: 'text-high',
          messages: [{ role: 'user', content: 'Hello' }],
        },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(lastAuthHeader, `Bearer ${tenantKey}`);
      assert.notEqual(lastAuthHeader, `Bearer ${process.env.OLLAMA_API_KEY}`);
    });

    it('never falls back to shared backends when tenant upstream fails with 500', async () => {
      simulatedUpstreamBehavior = 'error500';
      const tenantKey = 'client-key-will-fail-500';

      upsertTenant({
        id: 'client-failover-iso',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc: encryptSecret(tenantKey),
            hint: '…f500',
            fp: keyFingerprint(tenantKey),
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
        pools: {
          'text-high': [
            {
              id: 'model-a',
              provider: 'ollama-cloud',
              model: 'deepseek-v4.1-flash',
            },
          ],
        },
      });

      const token = mintTenantToken('client-failover-iso', tenantSecret);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-router-app': 'test-app',
          'x-router-agent': 'test-agent',
          'x-router-session': 'test-session',
        },
        payload: {
          model: 'text-high',
          messages: [{ role: 'user', content: 'Hello' }],
        },
      });

      // Must fail with 502, NOT succeed via MiniMax or local fallback
      assert.equal(res.statusCode, 502);
      assert.equal(res.json().error?.code, 'all_candidates_failed');
    });

    it('handles 401: marks key invalid, emits byok.key-invalid, returns 502 upstream_key_invalid', async () => {
      simulatedUpstreamBehavior = '401';
      const events: RouterEvent[] = [];
      const unsub = onRouterEvent((e) => events.push(e));

      const tenantKey = 'client-key-invalid-401';
      upsertTenant({
        id: 'client-401',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc: encryptSecret(tenantKey),
            hint: '…i401',
            fp: keyFingerprint(tenantKey),
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
        pools: {
          'text-high': [
            {
              id: 'model-1',
              provider: 'ollama-cloud',
              model: 'deepseek-v4.1-flash',
            },
            {
              id: 'model-2',
              provider: 'ollama-cloud',
              model: 'glm-5.3-flash',
            },
          ],
        },
      });

      const token = mintTenantToken('client-401', tenantSecret);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-router-app': 'test-app',
          'x-router-agent': 'test-agent',
          'x-router-session': 'test-session',
        },
        payload: {
          model: 'text-high',
          messages: [{ role: 'user', content: 'Hello' }],
        },
      });

      unsub();

      assert.equal(res.statusCode, 502);
      assert.equal(res.json().error?.code, 'upstream_key_invalid');
      // Only 1 upstream request made: did not attempt model-2 because key was marked invalid
      assert.equal(requestCount, 1);

      // Check key status updated in registry
      const record = getTenant('client-401');
      assert.equal(record?.upstreamKeys?.['ollama-cloud']?.status, 'invalid');

      // Check event emitted
      const invalidEvent = events.find((e) => e.type === 'byok.key-invalid');
      assert.ok(invalidEvent);
      assert.equal(invalidEvent.tenantId, 'client-401');
      assert.equal(invalidEvent.provider, 'ollama-cloud');
    });

    it('handles quota 429: marks key exhausted, emits event, and fast-fails while exhaustedUntil is future', async () => {
      simulatedUpstreamBehavior = 'quota429';
      const events: RouterEvent[] = [];
      const unsub = onRouterEvent((e) => events.push(e));

      const tenantKey = 'client-key-quota-429';
      upsertTenant({
        id: 'client-quota',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc: encryptSecret(tenantKey),
            hint: '…q429',
            fp: keyFingerprint(tenantKey),
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
        pools: {
          'text-high': [
            {
              id: 'model-1',
              provider: 'ollama-cloud',
              model: 'deepseek-v4.1-flash',
            },
          ],
        },
      });

      const token = mintTenantToken('client-quota', tenantSecret);

      // Request 1: hits upstream, gets 429 quota
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-router-app': 'test-app',
          'x-router-agent': 'test-agent',
          'x-router-session': 'test-session',
        },
        payload: {
          model: 'text-high',
          messages: [{ role: 'user', content: 'Hello' }],
        },
      });

      assert.equal(res1.statusCode, 429);
      assert.equal(res1.json().error?.code, 'upstream_quota_exhausted');
      assert.equal(res1.headers['retry-after'], '600');
      assert.equal(requestCount, 1);

      const record = getTenant('client-quota');
      assert.equal(record?.upstreamKeys?.['ollama-cloud']?.status, 'exhausted');
      assert.ok(record?.upstreamKeys?.['ollama-cloud']?.exhaustedUntil);

      const exhaustedEvent = events.find((e) => e.type === 'byok.key-exhausted');
      assert.ok(exhaustedEvent);

      // Request 2: fast-fails without hitting upstream!
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-router-app': 'test-app',
          'x-router-agent': 'test-agent',
          'x-router-session': 'test-session',
        },
        payload: {
          model: 'text-high',
          messages: [{ role: 'user', content: 'Hello' }],
        },
      });

      unsub();
      assert.equal(res2.statusCode, 429);
      assert.equal(res2.json().error?.code, 'upstream_quota_exhausted');
      assert.equal(requestCount, 1); // Still 1!
    });

    it('recovers key status to "ok" and emits byok.key-recovered on success', async () => {
      const events: RouterEvent[] = [];
      const unsub = onRouterEvent((e) => events.push(e));

      const tenantKey = 'client-key-recovered';
      upsertTenant({
        id: 'client-rec',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc: encryptSecret(tenantKey),
            hint: '…rec',
            fp: keyFingerprint(tenantKey),
            addedAt: new Date().toISOString(),
            status: 'unknown',
          },
        },
        pools: {
          'text-high': [
            {
              id: 'model-1',
              provider: 'ollama-cloud',
              model: 'deepseek-v4.1-flash',
            },
          ],
        },
      });

      const token = mintTenantToken('client-rec', tenantSecret);
      simulatedUpstreamBehavior = 'success';

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-router-app': 'test-app',
          'x-router-agent': 'test-agent',
          'x-router-session': 'test-session',
        },
        payload: {
          model: 'text-high',
          messages: [{ role: 'user', content: 'Hello' }],
        },
      });

      unsub();
      assert.equal(res.statusCode, 200);

      const after = getTenant('client-rec');
      assert.equal(after?.upstreamKeys?.['ollama-cloud']?.status, 'ok');

      const recEvent = events.find((e) => e.type === 'byok.key-recovered');
      assert.ok(recEvent);
      assert.equal(recEvent.tenantId, 'client-rec');
    });

    it('returns 503 byok_no_models for uncensored routes by default', async () => {
      const tenantKey = 'client-key-uncensored';
      upsertTenant({
        id: 'client-uncensored-test',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc: encryptSecret(tenantKey),
            hint: '…unc',
            fp: keyFingerprint(tenantKey),
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
      });

      const token = mintTenantToken('client-uncensored-test', tenantSecret);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-router-app': 'test-app',
          'x-router-agent': 'test-agent',
          'x-router-session': 'test-session',
        },
        payload: {
          model: 'text-uncensored-high',
          messages: [{ role: 'user', content: 'Hello' }],
        },
      });

      assert.equal(res.statusCode, 503);
      assert.equal(res.json().error?.code, 'byok_no_models');
      assert.ok(res.json().error?.message.includes('text-uncensored-high'));
    });

    it('cooldown on a BYOK entry does not affect shared entries for the same model', async () => {
      const sharedEntryId = 'ollama-cloud-shared-deepseek';
      const byokEntryId = 'byok:client-cd:pinned-deepseek';

      // Mark BYOK entry in cooldown
      const { recordFailure, isCoolingDown } = await import('../src/core/cooldown.js');
      recordFailure('text-high', byokEntryId, 60);

      assert.equal(isCoolingDown('text-high', byokEntryId).cooling, true);
      assert.equal(isCoolingDown('text-high', sharedEntryId).cooling, false);
    });
  });

  describe('6. Embeddings Endpoint Isolation', () => {
    let app: FastifyInstance;

    before(async () => {
      app = buildApp();
      await app.ready();
    });

    after(async () => {
      await app.close();
    });

    it('returns 403 not_available_for_byok for BYOK tenant by default', async () => {
      upsertTenant({
        id: 'client-emb-blocked',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc: encryptSecret('fake-k'),
            hint: '…fake',
            fp: 'fp123',
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
      });

      const token = mintTenantToken('client-emb-blocked', tenantSecret);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'text-embed',
          input: 'Hello world',
        },
      });

      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error?.code, 'not_available_for_byok');
    });

    it('permits embeddings when allowSharedEmbeddings: true is set', async () => {
      upsertTenant({
        id: 'client-emb-allowed',
        mode: 'byok',
        allowSharedEmbeddings: true,
        upstreamKeys: {
          'ollama-cloud': {
            enc: encryptSecret('fake-k'),
            hint: '…fake',
            fp: 'fp123',
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
      });

      const token = mintTenantToken('client-emb-allowed', tenantSecret);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'text-embed',
          input: 'Hello world',
        },
      });

      // Did not get 403 not_available_for_byok!
      assert.notEqual(res.statusCode, 403);
    });
  });

  describe('7. Key Secrecy Scan (plain key never leaks to disk, logs, or API responses)', () => {
    let app: FastifyInstance;
    const testSecretKey = 'super-secret-plain-key-must-never-leak-998877';

    before(async () => {
      app = buildApp();
      await app.ready();
    });

    after(async () => {
      await app.close();
    });

    it('plain key never appears in GET responses, persisted state, or logs', async () => {
      const fp = keyFingerprint(testSecretKey);
      const enc = encryptSecret(testSecretKey);
      upsertTenant({
        id: 'leak-check-tenant',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc,
            hint: '…8877',
            fp,
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
      });

      // Query tenant GET endpoints
      const resList = await app.inject({
        method: 'GET',
        url: '/admin/api/tenants',
        headers: { authorization: `Bearer ${masterAdminKey}` },
      });
      assert.equal(resList.statusCode, 200);
      assert.ok(!resList.body.includes(testSecretKey), 'Secret leaked in GET /admin/api/tenants');
      assert.ok(!resList.body.includes(enc), 'Encrypted blob leaked in GET /admin/api/tenants');

      const resSingle = await app.inject({
        method: 'GET',
        url: '/admin/api/tenants/leak-check-tenant',
        headers: { authorization: `Bearer ${masterAdminKey}` },
      });
      assert.equal(resSingle.statusCode, 200);
      assert.ok(!resSingle.body.includes(testSecretKey), 'Secret leaked in GET /admin/api/tenants/:id');
      assert.ok(!resSingle.body.includes(enc), 'Encrypted blob leaked in GET /admin/api/tenants/:id');

      const resPools = await app.inject({
        method: 'GET',
        url: '/admin/api/tenants/leak-check-tenant/pools',
        headers: { authorization: `Bearer ${masterAdminKey}` },
      });
      assert.equal(resPools.statusCode, 200);
      assert.ok(!resPools.body.includes(testSecretKey), 'Secret leaked in GET /admin/api/tenants/:id/pools');

      // Scan all persisted files in tmpDir
      const scanDir = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile()) {
            const content = fs.readFileSync(fullPath, 'utf8');
            assert.ok(
              !content.includes(testSecretKey),
              `Secret leaked into file: ${fullPath}`
            );
          }
        }
      };
      scanDir(tmpDir);
    });
  });

  describe('8. BYOK Catalog Wiring & Admission (End-to-End)', () => {
    let mockOllama: http.Server;
    let mockOllamaPort: number;
    let pollerInstance: { stop: () => void; refreshNow: () => Promise<any> } | null = null;
    const byokKey = 'fake-byok-wiring-key-555';
    const byokFp = keyFingerprint(byokKey);

    const catalogModels = new Map<string, { created: number; caps: string[] }>([
      ['deepseek-v4.1-flash', { created: 1789009200, caps: ['completion', 'tools'] }],
      ['glm-5.3-flash', { created: 1787752800, caps: ['completion', 'tools'] }],
    ]);

    before(async () => {
      mockOllama = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          res.setHeader('content-type', 'application/json');
          if (req.url === '/v1/models') {
            return res.end(
              JSON.stringify({
                object: 'list',
                data: [...catalogModels.keys()].map((id) => ({
                  id,
                  object: 'model',
                  created: catalogModels.get(id)!.created,
                })),
              })
            );
          }
          if (req.url === '/api/show') {
            const m = catalogModels.get(JSON.parse(body || '{}').model);
            if (!m) {
              res.statusCode = 404;
              return res.end('{"error":"model not found"}');
            }
            return res.end(
              JSON.stringify({
                capabilities: m.caps,
                model_info: { 'x.context_length': 131072 },
              })
            );
          }
          if (req.url === '/v1/chat/completions') {
            return res.end(
              JSON.stringify({
                id: 'c1',
                object: 'chat.completion',
                created: 1,
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: 'ok red',
                      tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_time', arguments: '{}' } }],
                    },
                    finish_reason: 'stop',
                  },
                ],
              })
            );
          }
          res.statusCode = 404;
          res.end('{}');
        });
      });

      await new Promise<void>((r) => mockOllama.listen(0, '127.0.0.1', () => r()));
      mockOllamaPort = (mockOllama.address() as any).port;
      CONFIG.cloudBaseUrl = `http://127.0.0.1:${mockOllamaPort}/v1`;
    });

    after(async () => {
      if (pollerInstance) {
        pollerInstance.stop();
      }
      await new Promise<void>((r) => mockOllama.close(() => r()));
    });

    it('runs catalog refresh & admission for BYOK tenant rules and expands route', async () => {
      const { startCatalogPoller, stopCatalogPoller } = await import('../src/core/catalog.js');
      const { admissionProbeQueue } = await import('../src/core/admission.js');
      const { loadRawLogicalModelConfigs } = await import('../src/config.js');

      upsertTenant({
        id: 'byok-wiring-tenant',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc: encryptSecret(byokKey),
            hint: '…k555',
            fp: byokFp,
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
      });

      pollerInstance = startCatalogPoller(() => loadRawLogicalModelConfigs(), 0);
      await pollerInstance.refreshNow();

      // Wait for probes to complete
      for (let i = 0; i < 200 && (admissionProbeQueue.pendingCount || admissionProbeQueue.runningCount); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // Check tenant route config expanded pool
      const routeCfg = getTenantRouteConfig('byok-wiring-tenant', 'text-high');
      assert.ok(routeCfg);
      assert.ok(routeCfg.pool.length > 0);

      const models = routeCfg.pool.map((e) => e.model);
      assert.ok(models.includes('deepseek-v4.1-flash'));
      assert.ok(models.includes('glm-5.3-flash'));

      for (const entry of routeCfg.pool) {
        assert.ok(entry.id.startsWith('byok:byok-wiring-tenant:'));
        assert.deepEqual(entry.keyRef, {
          tenantId: 'byok-wiring-tenant',
          provider: 'ollama-cloud',
        });
      }

      pollerInstance.stop();
      pollerInstance = null;
      stopCatalogPoller();
    });
  });
});
