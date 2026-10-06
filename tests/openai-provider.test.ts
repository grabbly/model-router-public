import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { waitForAdmissionIdleForTests } from '../src/core/admission.js';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { CONFIG, getDefaultLogicalModelConfigs, getEmbeddingModelConfigs } from '../src/config.js';
import {
  openaiAdapter,
  isOpenAiChatModel,
  resolveOpenAiCapabilities,
} from '../src/core/providers/openai.js';
import { getProviderAdapter } from '../src/core/providers/index.js';
import {
  getByokDefaultRules,
  getRawTenantRouteConfig,
  getTenantRouteConfig,
} from '../src/core/byok-defaults.js';
import { buildUpstreamBody, forwardChat } from '../src/core/forwarder.js';
import {
  upsertTenant,
  getTenant,
  resetTenantsForTests,
  validateTenantRecord,
} from '../src/core/tenants.js';
import { encryptSecret } from '../src/core/secrets.js';
import { keyFingerprint, dropDecryptedKeyCache } from '../src/core/keys.js';
import { resetRouterEventsForTests, onRouterEvent, RouterEvent } from '../src/core/events.js';
import { resetCooldowns } from '../src/core/cooldown.js';
import {
  getCatalog,
  refreshCatalog,
  clearCatalogsForTests,
  setCatalogForTests,
  saveCatalogSync,
  triggerAdmissionProbes,
} from '../src/core/catalog.js';
import { runCompletionProbe } from '../src/core/admission.js';
import { PoolEntry } from '../src/types.js';

describe('Phase 5 — OpenAI as a second BYOK provider', () => {
  let tmpDir: string;
  const originalStateDir = process.env.ROUTER_STATE_DIR;
  const originalSecretsKey = process.env.ROUTER_SECRETS_KEY;
  const originalOpenaiBase = CONFIG.openaiBaseUrl;
  const originalCloudBase = CONFIG.cloudBaseUrl;

  const masterAdminKey = 'master-admin-service-key-999';
  const tenantSecret = 'tenant-token-secret-888';
  const fakeSecretsMasterKey = crypto.randomBytes(32).toString('base64');

  before(() => {
    CONFIG.serviceApiKey = masterAdminKey;
    CONFIG.tenantTokenSecret = tenantSecret;
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-openai-p5-test-'));
    process.env.ROUTER_STATE_DIR = tmpDir;
    process.env.ROUTER_SECRETS_KEY = fakeSecretsMasterKey;
    resetTenantsForTests();
    resetRouterEventsForTests();
    resetCooldowns();
    clearCatalogsForTests();
    dropDecryptedKeyCache();
  });

  afterEach(() => {
    resetTenantsForTests();
    resetRouterEventsForTests();
    clearCatalogsForTests();
    dropDecryptedKeyCache();
    CONFIG.openaiBaseUrl = originalOpenaiBase;
    CONFIG.cloudBaseUrl = originalCloudBase;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  after(() => {
    process.env.ROUTER_STATE_DIR = originalStateDir;
    process.env.ROUTER_SECRETS_KEY = originalSecretsKey;
    CONFIG.openaiBaseUrl = originalOpenaiBase;
    CONFIG.cloudBaseUrl = originalCloudBase;
  });

  describe('1. Model filtering (isOpenAiChatModel)', () => {
    it('keeps chat-capable model IDs', () => {
      const allowed = [
        'gpt-4o',
        'gpt-4o-2024-08-06',
        'gpt-4o-mini',
        'gpt-4o-mini-2024-07-18',
        'gpt-4.1',
        'gpt-4.1-mini',
        'gpt-5',
        'gpt-5-mini',
        'o1',
        'o1-2024-12-17',
        'o1-mini',
        'o1-preview',
        'o3-mini',
        'o4',
        'chatgpt-4o-latest',
        'gpt-3.5-turbo',
      ];
      for (const id of allowed) {
        assert.equal(isOpenAiChatModel(id), true, `Expected ${id} to be accepted`);
      }
    });

    it('rejects non-chat / specialized IDs', () => {
      const rejected = [
        'gpt-4o-audio-preview',
        'gpt-4o-realtime-preview',
        'gpt-4o-realtime-preview-2024-10-01',
        'tts-1',
        'tts-1-hd',
        'whisper-1',
        'text-embedding-3-small',
        'text-embedding-3-large',
        'text-embedding-ada-002',
        'text-moderation-latest',
        'text-moderation-stable',
        'dall-e-2',
        'dall-e-3',
        'gpt-3.5-turbo-instruct',
        'davinci-002',
        'babbage-002',
        'code-search-babbage-code-001',
      ];
      for (const id of rejected) {
        assert.equal(isOpenAiChatModel(id), false, `Expected ${id} to be rejected`);
      }
    });
  });

  describe('2. Capability Table & Adapter Resolution', () => {
    it('resolves capabilities from pattern rules', () => {
      const gpt4o = resolveOpenAiCapabilities('gpt-4o');
      assert.ok(gpt4o.includes('completion'));
      assert.ok(gpt4o.includes('tools'));
      assert.ok(gpt4o.includes('vision'));

      const gpt4oMini = resolveOpenAiCapabilities('gpt-4o-mini');
      assert.ok(gpt4oMini.includes('tools'));
      assert.ok(gpt4oMini.includes('vision'));

      const gpt5 = resolveOpenAiCapabilities('gpt-5');
      assert.ok(gpt5.includes('tools'));
      assert.ok(gpt5.includes('vision'));

      const o1 = resolveOpenAiCapabilities('o1');
      assert.ok(o1.includes('tools'));
      assert.ok(o1.includes('thinking'));
      assert.equal(o1.includes('vision'), false);

      const o3Mini = resolveOpenAiCapabilities('o3-mini');
      assert.ok(o3Mini.includes('tools'));
      assert.ok(o3Mini.includes('thinking'));
      assert.ok(o3Mini.includes('vision'));

      const gpt35 = resolveOpenAiCapabilities('gpt-3.5-turbo');
      assert.ok(gpt35.includes('tools'));
      assert.equal(gpt35.includes('vision'), false);

      const unknown = resolveOpenAiCapabilities('unknown-future-model');
      assert.deepEqual(unknown, ['completion']);
    });

    it('adapter is registered in provider registry', () => {
      const adapter = getProviderAdapter('openai');
      assert.ok(adapter);
      assert.equal(adapter.id, 'openai');
      assert.equal(typeof adapter.listModels, 'function');
      assert.equal(typeof adapter.validateKey, 'function');
    });

    it('validateKey checks GET /models and throws on 401', async () => {
      let serverCalls = 0;
      let lastAuthHeader = '';

      const server = http.createServer((req, res) => {
        serverCalls++;
        lastAuthHeader = req.headers.authorization || '';
        if (req.headers.authorization === 'Bearer valid-key') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'gpt-4o', created: 1700000000 }] }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Incorrect API key', code: 'invalid_api_key' } }));
        }
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as any).port;
      const baseUrl = `http://127.0.0.1:${port}/v1`;

      try {
        const res = await openaiAdapter.validateKey(baseUrl, 'valid-key');
        assert.deepEqual(res, {});
        assert.equal(lastAuthHeader, 'Bearer valid-key');

        await assert.rejects(
          async () => {
            await openaiAdapter.validateKey(baseUrl, 'invalid-key');
          },
          /HTTP 401/
        );
      } finally {
        server.close();
      }
    });

    it('listModels parses created and filters models', async () => {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              { id: 'gpt-4o', created: 1715368132 },
              { id: 'gpt-4o-audio-preview', created: 1715368132 },
              { id: 'o1-mini', created: 1720000000 },
              { id: 'text-embedding-3-small', created: 1700000000 },
              { id: 'gpt-unknown-future', created: 1730000000 },
            ],
          })
        );
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as any).port;
      const baseUrl = `http://127.0.0.1:${port}/v1`;

      try {
        const models = await openaiAdapter.listModels(baseUrl, 'test-key');
        const ids = models.map((m) => m.id);
        assert.deepEqual(ids, ['gpt-4o', 'o1-mini', 'gpt-unknown-future']);

        const gpt4o = models.find((m) => m.id === 'gpt-4o');
        assert.equal(gpt4o?.created, 1715368132);
        assert.ok(gpt4o?.capabilities.includes('tools'));
        assert.ok(gpt4o?.capabilities.includes('vision'));

        const unknown = models.find((m) => m.id === 'gpt-unknown-future');
        assert.deepEqual(unknown?.capabilities, ['completion']);
        assert.equal(unknown?.contextLength, undefined);
      } finally {
        server.close();
      }
    });
  });

  describe('3. Dialect Transformations (buildUpstreamBody)', () => {
    const entry = (model: string, extraParams?: Record<string, unknown>): PoolEntry => ({
      id: 'e-openai',
      provider: 'openai',
      model,
      baseUrl: 'https://api.openai.com/v1',
      priority: 1,
      enabled: true,
      tier: 'high',
      modality: 'text',
      censored: true,
      params: extraParams,
    });

    const msgs = [{ role: 'user' as const, content: 'hello' }];

    it('translates max_tokens to max_completion_tokens for OpenAI', () => {
      const out1 = buildUpstreamBody(entry('gpt-4o'), { model: 'gpt-4o', messages: msgs, max_tokens: 150 }, msgs);
      assert.equal(out1.max_completion_tokens, 150);
      assert.equal('max_tokens' in out1, false);

      // If both present, keep max_completion_tokens
      const out2 = buildUpstreamBody(
        entry('gpt-4o'),
        { model: 'gpt-4o', messages: msgs, max_tokens: 100, max_completion_tokens: 250 },
        msgs
      );
      assert.equal(out2.max_completion_tokens, 250);
      assert.equal('max_tokens' in out2, false);
    });

    it('strips non-default parameters for reasoning models (o*, gpt-5*) but keeps reasoning_effort', () => {
      const reasoningModels = ['o1', 'o1-mini', 'o3-mini', 'gpt-5', 'gpt-5-mini'];

      for (const m of reasoningModels) {
        const out = buildUpstreamBody(
          entry(m),
          {
            model: m,
            messages: msgs,
            temperature: 0.7,
            top_p: 0.8,
            presence_penalty: 0.5,
            frequency_penalty: -0.2,
            reasoning_effort: 'high',
          },
          msgs
        );

        assert.equal('temperature' in out, false, `temperature should be dropped for ${m}`);
        assert.equal('top_p' in out, false, `top_p should be dropped for ${m}`);
        assert.equal('presence_penalty' in out, false, `presence_penalty should be dropped for ${m}`);
        assert.equal('frequency_penalty' in out, false, `frequency_penalty should be dropped for ${m}`);
        assert.equal(out.reasoning_effort, 'high', `reasoning_effort should be kept for ${m}`);
      }

      // Default values (temperature: 1, top_p: 1, presence_penalty: 0, frequency_penalty: 0) are kept
      const outDefaults = buildUpstreamBody(
        entry('o1'),
        {
          model: 'o1',
          messages: msgs,
          temperature: 1,
          top_p: 1,
          presence_penalty: 0,
          frequency_penalty: 0,
        },
        msgs
      );
      assert.equal(outDefaults.temperature, 1);
      assert.equal(outDefaults.top_p, 1);
      assert.equal(outDefaults.presence_penalty, 0);
      assert.equal(outDefaults.frequency_penalty, 0);
    });

    it('keeps temperature and top_p for non-reasoning models (gpt-4o)', () => {
      const out = buildUpstreamBody(
        entry('gpt-4o'),
        {
          model: 'gpt-4o',
          messages: msgs,
          temperature: 0.7,
          top_p: 0.9,
          presence_penalty: 0.5,
          frequency_penalty: 0.2,
        },
        msgs
      );
      assert.equal(out.temperature, 0.7);
      assert.equal(out.top_p, 0.9);
      assert.equal(out.presence_penalty, 0.5);
      assert.equal(out.frequency_penalty, 0.2);
    });

    it('removes router-only and other-dialect fields for OpenAI', () => {
      const out = buildUpstreamBody(
        entry('gpt-4o'),
        {
          model: 'gpt-4o',
          messages: msgs,
          thinking: { type: 'enabled' },
          enable_thinking: true,
          think: 'high',
          reasoning: { effort: 'high' },
          include_reasoning: true,
          reasoning_split: true,
          top_k: 40,
          google: { some: 'value' },
          extra_body: { google: { thinking_budget: 1024 }, other: 'custom' },
        } as any,
        msgs
      );

      for (const k of [
        'thinking',
        'enable_thinking',
        'think',
        'reasoning',
        'include_reasoning',
        'reasoning_split',
        'top_k',
        'google',
      ]) {
        assert.equal(k in out, false, `Field ${k} should be removed for OpenAI`);
      }
      assert.deepEqual(out.extra_body, { other: 'custom' });
    });

    it('adds include_usage on streams', () => {
      const out = buildUpstreamBody(entry('gpt-4o'), { model: 'gpt-4o', messages: msgs, stream: true }, msgs);
      assert.deepEqual(out.stream_options, { include_usage: true });
    });
  });

  describe('4. BYOK Defaults & Route Configurations for OpenAI', () => {
    it('returns expected default rules per censored route for openai', () => {
      const high = getByokDefaultRules('text-high', 'openai');
      assert.equal(high.length, 1);
      assert.equal(high[0].provider, 'openai');
      assert.deepEqual(high[0].select?.need, ['tools']);
      assert.deepEqual(high[0].select?.prefer, ['gpt-5*', 'gpt-4.1', 'gpt-4o']);
      assert.deepEqual(high[0].select?.exclude, ['*-mini*', '*-nano*']);
      assert.equal(high[0].select?.take, 2);

      const low = getByokDefaultRules('text-low', 'openai');
      assert.equal(low.length, 1);
      assert.equal(low[0].provider, 'openai');
      assert.deepEqual(low[0].select?.prefer, ['gpt-5*-mini*', 'gpt-4.1-mini*', 'gpt-4o-mini*']);
      assert.equal(low[0].select?.take, 2);

      const sum = getByokDefaultRules('text-summarize', 'openai');
      assert.equal(sum.length, 1);
      assert.deepEqual(sum[0].select?.prefer, ['gpt-5*-mini*', 'gpt-4.1-mini*', 'gpt-4o-mini*']);
      assert.equal(sum[0].select?.take, 2);

      const vHigh = getByokDefaultRules('vision-high', 'openai');
      assert.equal(vHigh.length, 1);
      assert.deepEqual(vHigh[0].select?.need, ['vision']);
      assert.deepEqual(vHigh[0].select?.prefer, ['gpt-5*', 'gpt-4.1', 'gpt-4o']);
      assert.deepEqual(vHigh[0].select?.exclude, ['*-mini*', '*-nano*']);
      assert.equal(vHigh[0].select?.take, 2);

      const vLow = getByokDefaultRules('vision-low', 'openai');
      assert.equal(vLow.length, 1);
      assert.deepEqual(vLow[0].select?.need, ['vision']);
      assert.deepEqual(vLow[0].select?.prefer, ['gpt-5*-mini*', 'gpt-4.1-mini*', 'gpt-4o-mini*']);
      assert.equal(vLow[0].select?.take, 2);

      assert.equal(getByokDefaultRules('text-uncensored-high', 'openai').length, 0);
      assert.equal(getByokDefaultRules('text-uncensored-low', 'openai').length, 0);
      assert.equal(getByokDefaultRules('vision-uncensored-high', 'openai').length, 0);
      assert.equal(getByokDefaultRules('vision-uncensored-low', 'openai').length, 0);
    });

    it('tenant with only OpenAI key gets OpenAI default rules', () => {
      upsertTenant({
        id: 'client-openai-only',
        mode: 'byok',
        upstreamKeys: {
          openai: {
            enc: encryptSecret('sk-fake-openai'),
            hint: '…pain',
            fp: keyFingerprint('sk-fake-openai'),
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
      });

      const cfg = getRawTenantRouteConfig('client-openai-only', 'text-high');
      assert.ok(cfg.pool.length > 0);
      for (const entry of cfg.pool) {
        assert.equal(entry.provider, 'openai');
        assert.deepEqual(entry.keyRef, { tenantId: 'client-openai-only', provider: 'openai' });
        assert.equal(entry.baseUrl, CONFIG.openaiBaseUrl);
        assert.equal(entry.priority, 1);
      }
    });

    it('tenant with both keys follows providerOrder (default: ollama-cloud, openai)', () => {
      upsertTenant({
        id: 'client-both-keys-default',
        mode: 'byok',
        upstreamKeys: {
          'ollama-cloud': {
            enc: encryptSecret('ollama-key'),
            hint: '…olma',
            fp: keyFingerprint('ollama-key'),
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
          openai: {
            enc: encryptSecret('openai-key'),
            hint: '…opai',
            fp: keyFingerprint('openai-key'),
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
      });

      const cfg = getRawTenantRouteConfig('client-both-keys-default', 'text-high');
      assert.equal(cfg.pool.length, 2);
      assert.equal(cfg.pool[0].provider, 'ollama-cloud');
      assert.equal(cfg.pool[0].priority, 1);
      assert.deepEqual(cfg.pool[0].keyRef, { tenantId: 'client-both-keys-default', provider: 'ollama-cloud' });

      assert.equal(cfg.pool[1].provider, 'openai');
      assert.equal(cfg.pool[1].priority, 2);
      assert.deepEqual(cfg.pool[1].keyRef, { tenantId: 'client-both-keys-default', provider: 'openai' });
    });

    it('tenant with both keys follows custom providerOrder (openai first)', () => {
      upsertTenant({
        id: 'client-both-keys-reversed',
        mode: 'byok',
        providerOrder: ['openai', 'ollama-cloud'],
        upstreamKeys: {
          'ollama-cloud': {
            enc: encryptSecret('ollama-key'),
            hint: '…olma',
            fp: keyFingerprint('ollama-key'),
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
          openai: {
            enc: encryptSecret('openai-key'),
            hint: '…opai',
            fp: keyFingerprint('openai-key'),
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
      });

      const cfg = getRawTenantRouteConfig('client-both-keys-reversed', 'text-high');
      assert.equal(cfg.pool.length, 2);
      assert.equal(cfg.pool[0].provider, 'openai');
      assert.equal(cfg.pool[0].priority, 1);
      assert.deepEqual(cfg.pool[0].keyRef, { tenantId: 'client-both-keys-reversed', provider: 'openai' });

      assert.equal(cfg.pool[1].provider, 'ollama-cloud');
      assert.equal(cfg.pool[1].priority, 2);
      assert.deepEqual(cfg.pool[1].keyRef, { tenantId: 'client-both-keys-reversed', provider: 'ollama-cloud' });
    });

    it('tenant never uses a key it does not own', () => {
      upsertTenant({
        id: 'tenant-a',
        mode: 'byok',
        upstreamKeys: {
          openai: {
            enc: encryptSecret('key-a'),
            hint: '…keya',
            fp: keyFingerprint('key-a'),
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
      });

      upsertTenant({
        id: 'tenant-b',
        mode: 'byok',
        upstreamKeys: {
          openai: {
            enc: encryptSecret('key-b'),
            hint: '…keyb',
            fp: keyFingerprint('key-b'),
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
      });

      const cfgA = getRawTenantRouteConfig('tenant-a', 'text-high');
      for (const e of cfgA.pool) {
        assert.equal(e.keyRef?.tenantId, 'tenant-a');
      }

      const cfgB = getRawTenantRouteConfig('tenant-b', 'text-high');
      for (const e of cfgB.pool) {
        assert.equal(e.keyRef?.tenantId, 'tenant-b');
      }
    });

    it('OpenAI never appears in any shared/default pool in src/config.ts', () => {
      const defaultConfigs = getDefaultLogicalModelConfigs();
      for (const [routeId, cfg] of Object.entries(defaultConfigs)) {
        for (const entry of cfg.pool) {
          assert.notEqual(
            entry.provider,
            'openai',
            `OpenAI must never appear in shared pool for route ${routeId} (found entry ${entry.id})`
          );
        }
      }

      const embConfigs = getEmbeddingModelConfigs();
      for (const [routeId, cfg] of Object.entries(embConfigs)) {
        for (const entry of cfg.pool) {
          assert.notEqual(
            entry.provider,
            'openai',
            `OpenAI must never appear in embedding shared pool ${routeId}`
          );
        }
      }
    });
  });

  describe('5. Admission probe capability upgrading & quota handling', () => {
    it('upgrades capabilities when tools and vision probes pass', async () => {
      const tenantKey = 'sk-upgrade-test';
      const fp = keyFingerprint(tenantKey);

      setCatalogForTests({
        provider: 'openai',
        fp,
        baseUrl: 'http://127.0.0.1:9999/v1',
        fetchedAt: Date.now(),
        models: {
          'gpt-unknown-probeable': {
            capabilities: ['completion'],
            admission: {
              status: 'pending',
              at: Date.now(),
            },
          },
        },
      });

      let probeCalls: string[] = [];

      const mockOpenai = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}');
          if (parsed.tools) {
            probeCalls.push('tools');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'get_time', arguments: '{}' } }],
                    },
                  },
                ],
              })
            );
          } else if (Array.isArray(parsed.messages?.[0]?.content)) {
            probeCalls.push('vision');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'red' } }] }));
          } else {
            probeCalls.push('completion');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
          }
        });
      });

      await new Promise<void>((resolve) => mockOpenai.listen(0, '127.0.0.1', () => resolve()));
      const port = (mockOpenai.address() as any).port;
      const baseUrl = `http://127.0.0.1:${port}/v1`;

      try {
        const cat = getCatalog('openai', fp)!;
        cat.baseUrl = baseUrl;

        // Custom routes needing tools and vision
        const routes = {
          'text-high': {
            id: 'text-high' as const,
            tier: 'high' as const,
            modality: 'text' as const,
            censored: true,
            pool: [
              {
                id: 'rule-tools-vision',
                provider: 'openai' as const,
                model: 'gpt-unknown-probeable',
                baseUrl,
                priority: 1,
                enabled: true,
                tier: 'high' as const,
                modality: 'text' as const,
                censored: true,
                keyRef: { tenantId: 'tenant-upgrade', provider: 'openai' as const },
                select: {
                  need: ['tools', 'vision'] as Array<'tools' | 'vision'>,
                  prefer: ['gpt-unknown-*'],
                  take: 1,
                },
              },
            ],
          },
        };

        upsertTenant({
          id: 'tenant-upgrade',
          mode: 'byok',
          upstreamKeys: {
            openai: {
              enc: encryptSecret(tenantKey),
              hint: '…upgr',
              fp,
              addedAt: new Date().toISOString(),
              status: 'ok',
            },
          },
        });

        triggerAdmissionProbes(routes);

        // Wait for probes to complete
        await waitForAdmissionIdleForTests();

        const updatedCat = getCatalog('openai', fp);
        const modelRecord = updatedCat?.models['gpt-unknown-probeable'];
        assert.ok(modelRecord);
        assert.equal(modelRecord.admission?.status, 'admitted');
        assert.ok(modelRecord.capabilities.includes('completion'));
        assert.ok(modelRecord.capabilities.includes('tools'));
        assert.ok(modelRecord.capabilities.includes('vision'));
      } finally {
        mockOpenai.close();
      }
    });

    it('handles OpenAI insufficient_quota during admission as key exhausted, not model rejection', async () => {
      const tenantKey = 'sk-quota-key';
      const fp = keyFingerprint(tenantKey);

      setCatalogForTests({
        provider: 'openai',
        fp,
        baseUrl: 'http://127.0.0.1:9998/v1',
        fetchedAt: Date.now(),
        models: {
          'gpt-4o': {
            capabilities: ['completion', 'tools', 'vision'],
            admission: {
              status: 'pending',
              at: Date.now(),
            },
          },
        },
      });

      const mockOpenai = http.createServer((req, res) => {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: 'You exceeded your current quota, please check your plan and billing details.',
              type: 'insufficient_quota',
              code: 'insufficient_quota',
            },
          })
        );
      });

      await new Promise<void>((resolve) => mockOpenai.listen(0, '127.0.0.1', () => resolve()));
      const port = (mockOpenai.address() as any).port;
      const baseUrl = `http://127.0.0.1:${port}/v1`;

      try {
        const cat = getCatalog('openai', fp)!;
        cat.baseUrl = baseUrl;

        upsertTenant({
          id: 'tenant-quota',
          mode: 'byok',
          upstreamKeys: {
            openai: {
              enc: encryptSecret(tenantKey),
              hint: '…quot',
              fp,
              addedAt: new Date().toISOString(),
              status: 'ok',
            },
          },
        });

        const routes = {
          'text-high': {
            id: 'text-high' as const,
            tier: 'high' as const,
            modality: 'text' as const,
            censored: true,
            pool: [
              {
                id: 'rule-quota',
                provider: 'openai' as const,
                model: 'gpt-4o',
                baseUrl,
                priority: 1,
                enabled: true,
                tier: 'high' as const,
                modality: 'text' as const,
                censored: true,
                keyRef: { tenantId: 'tenant-quota', provider: 'openai' as const },
                select: {
                  need: ['tools'] as Array<'tools'>,
                  prefer: ['gpt-4o*'],
                  take: 1,
                },
              },
            ],
          },
        };

        triggerAdmissionProbes(routes);
        await waitForAdmissionIdleForTests();

        // Model must remain pending (not rejected!)
        const updatedCat = getCatalog('openai', fp);
        const m = updatedCat?.models['gpt-4o'];
        assert.equal(m?.admission?.status, 'pending');

        // Tenant key status must be marked exhausted!
        const tenant = getTenant('tenant-quota');
        assert.equal(tenant?.upstreamKeys?.openai?.status, 'exhausted');
        assert.ok(tenant?.upstreamKeys?.openai?.exhaustedUntil);
      } finally {
        mockOpenai.close();
      }
    });
  });

  describe('6. Error Mapping for BYOK Status (forwardChat)', () => {
    it('maps 401 to invalid and emits byok.key-invalid', async () => {
      let serverCalls = 0;
      const mockServer = http.createServer((req, res) => {
        serverCalls++;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }));
      });

      await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
      const port = (mockServer.address() as any).port;
      const baseUrl = `http://127.0.0.1:${port}/v1`;

      const events: RouterEvent[] = [];
      const unsub = onRouterEvent((ev) => events.push(ev));

      try {
        upsertTenant({
          id: 't-invalid-key',
          mode: 'byok',
          upstreamKeys: {
            openai: {
              enc: encryptSecret('bad-openai-key'),
              hint: '…bado',
              fp: keyFingerprint('bad-openai-key'),
              addedAt: new Date().toISOString(),
              status: 'ok',
            },
          },
        });

        const entry: PoolEntry = {
          id: 'byok:t-invalid-key:openai-4o',
          provider: 'openai',
          model: 'gpt-4o',
          baseUrl,
          priority: 1,
          enabled: true,
          tier: 'high',
          modality: 'text',
          censored: true,
          keyRef: { tenantId: 't-invalid-key', provider: 'openai' },
        };

        const config = {
          id: 'text-high' as const,
          tier: 'high' as const,
          modality: 'text' as const,
          censored: true,
          pool: [entry],
        };

        const res = await forwardChat(
          'text-high',
          config,
          { model: 'text-high', messages: [{ role: 'user', content: 'hi' }] },
          't-invalid-key'
        );

        assert.equal(res.ok, false);
        assert.equal(res.status, 502);
        assert.equal(res.error?.code, 'upstream_key_invalid');

        const tenant = getTenant('t-invalid-key');
        assert.equal(tenant?.upstreamKeys?.openai?.status, 'invalid');

        const invalidEv = events.find((e) => e.type === 'byok.key-invalid');
        assert.ok(invalidEv);
      } finally {
        unsub();
        mockServer.close();
      }
    });

    it('maps 429 insufficient_quota to exhausted', async () => {
      const mockServer = http.createServer((req, res) => {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: 'You exceeded your current quota, please check your plan and billing details.',
              type: 'insufficient_quota',
              code: 'insufficient_quota',
            },
          })
        );
      });

      await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
      const port = (mockServer.address() as any).port;
      const baseUrl = `http://127.0.0.1:${port}/v1`;

      const events: RouterEvent[] = [];
      const unsub = onRouterEvent((ev) => events.push(ev));

      try {
        upsertTenant({
          id: 't-exhausted-key',
          mode: 'byok',
          upstreamKeys: {
            openai: {
              enc: encryptSecret('quota-openai-key'),
              hint: '…quot',
              fp: keyFingerprint('quota-openai-key'),
              addedAt: new Date().toISOString(),
              status: 'ok',
            },
          },
        });

        const entry: PoolEntry = {
          id: 'byok:t-exhausted-key:openai-4o',
          provider: 'openai',
          model: 'gpt-4o',
          baseUrl,
          priority: 1,
          enabled: true,
          tier: 'high',
          modality: 'text',
          censored: true,
          keyRef: { tenantId: 't-exhausted-key', provider: 'openai' },
        };

        const config = {
          id: 'text-high' as const,
          tier: 'high' as const,
          modality: 'text' as const,
          censored: true,
          pool: [entry],
        };

        const res = await forwardChat(
          'text-high',
          config,
          { model: 'text-high', messages: [{ role: 'user', content: 'hi' }] },
          't-exhausted-key'
        );

        assert.equal(res.ok, false);
        assert.equal(res.status, 429);
        assert.equal(res.error?.code, 'upstream_quota_exhausted');

        const tenant = getTenant('t-exhausted-key');
        assert.equal(tenant?.upstreamKeys?.openai?.status, 'exhausted');
        assert.ok(tenant?.upstreamKeys?.openai?.exhaustedUntil);

        const exhEv = events.find((e) => e.type === 'byok.key-exhausted');
        assert.ok(exhEv);
      } finally {
        unsub();
        mockServer.close();
      }
    });

    it('maps 429 rate_limit_exceeded to short cooldown and fails over to next candidate', async () => {
      let candidate1Calls = 0;
      let candidate2Calls = 0;

      const mockServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}');
          if (parsed.model === 'gpt-4o') {
            candidate1Calls++;
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '5' });
            res.end(
              JSON.stringify({
                error: {
                  message: 'Rate limit reached for requests',
                  type: 'requests',
                  code: 'rate_limit_exceeded',
                },
              })
            );
          } else {
            candidate2Calls++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'hello from fallback' } }] }));
          }
        });
      });

      await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
      const port = (mockServer.address() as any).port;
      const baseUrl = `http://127.0.0.1:${port}/v1`;

      try {
        upsertTenant({
          id: 't-ratelimit-user',
          mode: 'byok',
          upstreamKeys: {
            openai: {
              enc: encryptSecret('rate-openai-key'),
              hint: '…rate',
              fp: keyFingerprint('rate-openai-key'),
              addedAt: new Date().toISOString(),
              status: 'ok',
            },
          },
        });

        const entry1: PoolEntry = {
          id: 'byok:t-ratelimit-user:openai-4o',
          provider: 'openai',
          model: 'gpt-4o',
          baseUrl,
          priority: 1,
          enabled: true,
          tier: 'high',
          modality: 'text',
          censored: true,
          keyRef: { tenantId: 't-ratelimit-user', provider: 'openai' },
        };

        const entry2: PoolEntry = {
          id: 'byok:t-ratelimit-user:openai-4o-mini',
          provider: 'openai',
          model: 'gpt-4o-mini',
          baseUrl,
          priority: 2,
          enabled: true,
          tier: 'high',
          modality: 'text',
          censored: true,
          keyRef: { tenantId: 't-ratelimit-user', provider: 'openai' },
        };

        const config = {
          id: 'text-high' as const,
          tier: 'high' as const,
          modality: 'text' as const,
          censored: true,
          pool: [entry1, entry2],
        };

        const res = await forwardChat(
          'text-high',
          config,
          { model: 'text-high', messages: [{ role: 'user', content: 'hi' }] },
          't-ratelimit-user'
        );

        assert.equal(res.ok, true);
        assert.equal(res.failoverCount, 1);
        assert.equal(candidate1Calls, 1);
        assert.equal(candidate2Calls, 1);

        // Key must still be 'ok' (not parked as exhausted!)
        const tenant = getTenant('t-ratelimit-user');
        assert.equal(tenant?.upstreamKeys?.openai?.status, 'ok');
      } finally {
        mockServer.close();
      }
    });
  });

  describe('7. Admin API Endpoints for OpenAI Keys & Tenant Management', () => {
    let app: FastifyInstance;
    let mockOpenai: http.Server;
    let mockOpenaiUrl: string;

    before(async () => {
      app = await buildApp();
      await app.ready();

      mockOpenai = http.createServer((req, res) => {
        if (req.headers.authorization === 'Bearer valid-openai-key') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              data: [
                { id: 'gpt-4o', created: 1715368132 },
                { id: 'gpt-4o-mini', created: 1715368132 },
              ],
            })
          );
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
        }
      });

      await new Promise<void>((resolve) => mockOpenai.listen(0, '127.0.0.1', () => resolve()));
      const port = (mockOpenai.address() as any).port;
      mockOpenaiUrl = `http://127.0.0.1:${port}/v1`;
      CONFIG.openaiBaseUrl = mockOpenaiUrl;
    });

    after(async () => {
      await app.close();
      mockOpenai.close();
      CONFIG.openaiBaseUrl = originalOpenaiBase;
    });

    it('PUT /admin/api/tenants/:id/keys/openai validates and saves key', async () => {
      upsertTenant({
        id: 'client-key-test',
        mode: 'byok',
        status: 'active',
      });

      // Bad key rejected
      const badRes = await app.inject({
        method: 'PUT',
        url: '/admin/api/tenants/client-key-test/keys/openai',
        headers: { authorization: `Bearer ${masterAdminKey}` },
        payload: { key: 'bad-key' },
      });
      assert.equal(badRes.statusCode, 400);

      // Good key accepted
      const goodRes = await app.inject({
        method: 'PUT',
        url: '/admin/api/tenants/client-key-test/keys/openai',
        headers: { authorization: `Bearer ${masterAdminKey}` },
        payload: { key: 'valid-openai-key' },
      });
      assert.equal(goodRes.statusCode, 200);
      const json = JSON.parse(goodRes.body);
      assert.equal(json.status, 'ok');
      assert.equal(json.hint, '…-key');
      assert.equal(json.models, 2);

      const tenant = getTenant('client-key-test');
      assert.ok(tenant?.upstreamKeys?.openai);
      assert.equal(tenant?.upstreamKeys?.openai?.status, 'ok');
    });

    it('DELETE /admin/api/tenants/:id/keys/openai removes key or enforces force', async () => {
      upsertTenant({
        id: 'client-key-test',
        mode: 'byok',
        status: 'active',
        upstreamKeys: {
          openai: {
            enc: encryptSecret('test-key'),
            hint: '…-key',
            fp: keyFingerprint('test-key'),
            addedAt: new Date().toISOString(),
            status: 'ok',
          },
        },
      });

      // Trying to delete last key without force returns 409
      const delRes1 = await app.inject({
        method: 'DELETE',
        url: '/admin/api/tenants/client-key-test/keys/openai',
        headers: { authorization: `Bearer ${masterAdminKey}` },
      });
      assert.equal(delRes1.statusCode, 409);

      // With force=1 disables tenant and removes key
      const delRes2 = await app.inject({
        method: 'DELETE',
        url: '/admin/api/tenants/client-key-test/keys/openai?force=1',
        headers: { authorization: `Bearer ${masterAdminKey}` },
      });
      assert.equal(delRes2.statusCode, 200);

      const tenant = getTenant('client-key-test');
      assert.equal(tenant?.status, 'disabled');
      assert.equal(tenant?.upstreamKeys?.openai, undefined);
    });

    it('validates providerOrder in tenant record', () => {
      const valid = validateTenantRecord({
        id: 't-valid-order',
        providerOrder: ['openai', 'ollama-cloud'],
      });
      assert.equal(valid.ok, true);

      const invalid1 = validateTenantRecord({
        id: 't-invalid-order-1',
        providerOrder: 'not-an-array' as any,
      });
      assert.equal(invalid1.ok, false);

      const invalid2 = validateTenantRecord({
        id: 't-invalid-order-2',
        providerOrder: ['openai', 'unknown-provider'] as any,
      });
      assert.equal(invalid2.ok, false);
    });

    it('PUT /admin/api/tenants/:id accepts providerOrder', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/api/tenants/t-order-api',
        headers: { authorization: `Bearer ${masterAdminKey}` },
        payload: {
          name: 'Order Test',
          mode: 'byok',
          providerOrder: ['openai', 'ollama-cloud'],
          upstreamKeys: {
            openai: {
              enc: encryptSecret('test-key'),
              hint: '…test',
              fp: keyFingerprint('test-key'),
              addedAt: new Date().toISOString(),
              status: 'ok',
            },
          },
        },
      });

      assert.equal(res.statusCode, 200);
      const tenant = getTenant('t-order-api');
      assert.deepEqual(tenant?.providerOrder, ['openai', 'ollama-cloud']);
    });
  });
});

describe('Admission probe: ollama 402 is a model rejection, not an exhausted key', () => {
  it('runCompletionProbe on 402 "add usage credits" does not flag quota', async () => {
    const http = await import('node:http');
    const { runCompletionProbe } = await import('../src/core/admission.js');
    const srv = http.createServer((_req, res) => {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"this model is not included in your free usage, add usage credits to pay as you go"}}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as any).port;
    const r = await runCompletionProbe(`http://127.0.0.1:${port}/v1`, 'k', 'glm-5.3-flash');
    srv.close();
    assert.equal(r.pass, false);
    assert.ok(!r.status429, 'must not be treated as a transient/key problem');
    assert.ok(!r.isQuota);
  });
});
