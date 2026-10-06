import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDefaultLogicalModelConfigs } from '../src/config.js';
import { getByokDefaultRules } from '../src/core/byok-defaults.js';
import { buildApp } from '../src/index.js';
import { mintTenantToken } from '../src/auth/tenant-token.js';
import { CONFIG } from '../src/config.js';

describe('Logical Tier text-high-think (Item C)', () => {
  it('config has the tier with the right order and properties', () => {
    const configs = getDefaultLogicalModelConfigs();
    const cfg = configs['text-high-think'];
    assert.ok(cfg, 'text-high-think must exist in configs');
    assert.equal(cfg.id, 'text-high-think');
    assert.equal(cfg.tier, 'high');
    assert.equal(cfg.modality, 'text');
    assert.equal(cfg.censored, true);
    assert.equal(cfg.timeoutMs, 90_000);
    assert.equal(cfg.cooldownSec, 120);

    assert.equal(cfg.pool.length, 4, 'Pool must have 4 entries');

    // Entry 1
    const e1 = cfg.pool[0];
    assert.equal(e1.id, 'minimax-m31-flash-think');
    assert.equal(e1.model, 'MiniMax-M3.1-Flash-Preview');
    assert.equal(e1.provider, 'custom');
    assert.equal(e1.budgetGroup, 'minimax');
    assert.equal(e1.priority, 1);
    assert.deepEqual(e1.params, { reasoning_split: true, reasoning_effort: 'medium' });
    assert.deepEqual(e1.reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);

    // Entry 2
    const e2 = cfg.pool[1];
    assert.equal(e2.id, 'minimax-m3-direct-text-high-think');
    assert.equal(e2.model, 'MiniMax-M3');
    assert.equal(e2.priority, 2);

    // Entry 3
    const e3 = cfg.pool[2];
    assert.equal(e3.id, 'backend2-gemini-3.5-flash-lite-think');
    assert.equal(e3.model, 'gemini-3.5-flash-lite');
    assert.equal(e3.priority, 3);

    // Entry 4
    const e4 = cfg.pool[3];
    assert.equal(e4.id, 'backend2-gemini-3.1-pro-low-think');
    assert.equal(e4.model, 'gemini-3.1-pro-low');
    assert.equal(e4.priority, 4);
  });

  it('BYOK default rules match text-high', () => {
    const cloudRules = getByokDefaultRules('text-high-think', 'ollama-cloud');
    const cloudHighRules = getByokDefaultRules('text-high', 'ollama-cloud');
    assert.deepEqual(cloudRules, cloudHighRules);

    const openaiRules = getByokDefaultRules('text-high-think', 'openai');
    const openaiHighRules = getByokDefaultRules('text-high', 'openai');
    assert.deepEqual(openaiRules, openaiHighRules);
  });

  it('GET /v1/models lists text-high-think tier', async () => {
    const secret = 'test-secret-models-think-999';
    CONFIG.serviceApiKey = secret;
    CONFIG.tenantTokenSecret = secret;

    const token = mintTenantToken('tenant-think-test', secret);
    const app = buildApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const item = body.data.find((m: { id: string }) => m.id === 'text-high-think');
    assert.ok(item, 'text-high-think must be in /v1/models catalog');
    assert.equal(item.tier, 'high');
    assert.equal(item.modality, 'text');
    assert.equal(item.censored, true);

    await app.close();
  });
});
