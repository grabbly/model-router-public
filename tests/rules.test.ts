import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { expandRuleEntries, globMatch, resetRulesTrackingForTests } from '../src/core/rules.js';
import {
  clearCatalogsForTests,
  setCatalogForTests,
  CatalogData,
} from '../src/core/catalog.js';
import { keyFingerprint } from '../src/core/keys.js';
import { emitRouterEvent, resetRouterEventsForTests, getRecentRouterEvents } from '../src/core/events.js';
import { getDefaultLogicalModelConfigs, loadLogicalModelConfigs } from '../src/config.js';
import { LogicalModelConfig, PoolEntry } from '../src/types.js';

describe('Rule-based pool entries & expansion (tests/rules.test.ts)', () => {
  const testKey = 'test-ollama-key-123';
  const testFp = keyFingerprint(testKey);

  beforeEach(() => {
    process.env.OLLAMA_API_KEY = testKey;
    clearCatalogsForTests();
    resetRulesTrackingForTests();
    resetRouterEventsForTests();
  });

  describe('glob matching', () => {
    it('matches exact pattern', () => {
      assert.equal(globMatch('deepseek-v4.1-flash', 'deepseek-v4.1-flash'), true);
      assert.equal(globMatch('deepseek-v4.1-flash', 'deepseek-v4.2-flash'), false);
    });

    it('matches wildcards at beginning, middle, and end', () => {
      assert.equal(globMatch('deepseek-*-flash*', 'deepseek-v4.1-flash'), true);
      assert.equal(globMatch('deepseek-*-flash*', 'deepseek-lite-flash-fast'), true);
      assert.equal(globMatch('deepseek-*-flash*', 'deepseek-v4-pro'), false);
      assert.equal(globMatch('*-pro*', 'deepseek-v4-pro-max'), true);
      assert.equal(globMatch('*-pro*', 'deepseek-v4-flash'), false);
    });

    it('is case-insensitive', () => {
      assert.equal(globMatch('DeepSeek-*-Flash*', 'deepseek-v4.1-flash'), true);
      assert.equal(globMatch('minimax-m3', 'MiniMax-M3'), true);
    });

    it('strips :cloud suffix when matching', () => {
      assert.equal(globMatch('deepseek-v4.1-flash', 'deepseek-v4.1-flash:cloud'), true);
      assert.equal(globMatch('deepseek-v4.1-flash:cloud', 'deepseek-v4.1-flash'), true);
    });
  });

  describe('expandRuleEntries', () => {
    const makeRouteConfig = (censored = true): LogicalModelConfig => ({
      id: 'text-high',
      description: 'Test high tier',
      modality: 'text',
      tier: 'high',
      censored,
      timeoutMs: 10000,
      cooldownSec: 60,
      pool: [],
    });

    const sampleCatalog: CatalogData = {
      provider: 'ollama-cloud',
      baseUrl: 'https://ollama.com/v1',
      fp: testFp,
      fetchedAt: Date.now(),
      models: {
        'deepseek-v4.1-flash': {
          created: 1000,
          capabilities: ['completion', 'tools'],
          contextLength: 128000,
          firstSeen: Date.now(),
          lastSeen: Date.now(),
          admission: { status: 'admitted', at: Date.now() },
        },
        'deepseek-v4.2-flash': {
          created: 2000,
          capabilities: ['completion', 'tools'],
          contextLength: 128000,
          firstSeen: Date.now(),
          lastSeen: Date.now(),
          admission: { status: 'admitted', at: Date.now() },
        },
        'glm-4-flash': {
          created: 1500,
          capabilities: ['completion', 'tools'],
          contextLength: 64000,
          firstSeen: Date.now(),
          lastSeen: Date.now(),
          admission: { status: 'admitted', at: Date.now() },
        },
        'deepseek-v4-pro': {
          created: 3000,
          capabilities: ['completion', 'tools'],
          contextLength: 128000,
          firstSeen: Date.now(),
          lastSeen: Date.now(),
          admission: { status: 'admitted', at: Date.now() },
        },
      },
    };

    it('orders by prefer pattern index first, then created desc, then id asc', () => {
      setCatalogForTests(sampleCatalog);

      const routeConfig = makeRouteConfig(true);
      const ruleEntry: PoolEntry = {
        id: 'rule-1',
        provider: 'ollama-cloud',
        model: '',
        baseUrl: 'https://ollama.com/v1',
        apiKeyEnv: 'OLLAMA_API_KEY',
        priority: 1,
        enabled: true,
        tier: 'high',
        modality: 'text',
        censored: true,
        select: {
          prefer: ['glm-*', 'deepseek-*-flash*'],
          take: 3,
        },
      };

      const expanded = expandRuleEntries([ruleEntry], routeConfig);
      assert.equal(expanded.length, 3);
      // glm-* matches prefer[0], so it comes first despite created = 1500
      assert.equal(expanded[0].model, 'glm-4-flash');
      assert.equal(expanded[0].id, 'rule-1~glm-4-flash');
      assert.equal(expanded[0].priority, 1);
      assert.equal(expanded[0].fromRule, 'rule-1');

      // deepseek-*-flash* matches prefer[1], sorted by created desc (v4.2 created 2000 > v4.1 created 1000)
      assert.equal(expanded[1].model, 'deepseek-v4.2-flash');
      assert.equal(expanded[1].priority, 1.01);
      assert.equal(expanded[2].model, 'deepseek-v4.1-flash');
      assert.equal(expanded[2].priority, 1.02);
    });

    it('filters by need capabilities, minContext, and exclude patterns', () => {
      setCatalogForTests(sampleCatalog);

      const routeConfig = makeRouteConfig(true);
      const ruleEntry: PoolEntry = {
        id: 'rule-filters',
        provider: 'ollama-cloud',
        model: '',
        baseUrl: 'https://ollama.com/v1',
        apiKeyEnv: 'OLLAMA_API_KEY',
        priority: 2,
        enabled: true,
        tier: 'high',
        modality: 'text',
        censored: true,
        select: {
          need: ['vision'], // None of the sampleCatalog models have vision
          prefer: ['deepseek-*'],
          take: 2,
        },
      };

      const expanded = expandRuleEntries([ruleEntry], routeConfig);
      assert.equal(expanded.length, 0);

      // Now with need: ['tools'] and minContext: 100000 (glm has 64000 so excluded)
      // and exclude: ['*-v4.2-*'] (so v4.2 is excluded)
      const ruleEntry2: PoolEntry = {
        ...ruleEntry,
        select: {
          need: ['tools'],
          minContext: 100000,
          prefer: ['deepseek-*', 'glm-*'],
          exclude: ['*-v4.2-*'],
          take: 5,
        },
      };

      const expanded2 = expandRuleEntries([ruleEntry2], routeConfig);
      // deepseek-v4.1-flash passes (128k context, has tools, not v4.2)
      // deepseek-v4-pro passes (128k context, has tools, not v4.2)
      assert.equal(expanded2.length, 2);
      assert.ok(expanded2.some((e) => e.model === 'deepseek-v4.1-flash'));
      assert.ok(expanded2.some((e) => e.model === 'deepseek-v4-pro'));
      assert.ok(!expanded2.some((e) => e.model === 'glm-4-flash'));
      assert.ok(!expanded2.some((e) => e.model === 'deepseek-v4.2-flash'));
    });

    it('deduplicates with pinned entries in the same route (:cloud stripped)', () => {
      setCatalogForTests(sampleCatalog);

      const routeConfig = makeRouteConfig(true);
      const pinnedEntry: PoolEntry = {
        id: 'pinned-flash',
        provider: 'ollama-cloud',
        model: 'deepseek-v4.2-flash:cloud', // pinned with :cloud
        baseUrl: 'https://ollama.com/v1',
        apiKeyEnv: 'OLLAMA_API_KEY',
        priority: 1,
        enabled: true,
        tier: 'high',
        modality: 'text',
        censored: true,
      };

      const ruleEntry: PoolEntry = {
        id: 'rule-dedupe',
        provider: 'ollama-cloud',
        model: '',
        baseUrl: 'https://ollama.com/v1',
        apiKeyEnv: 'OLLAMA_API_KEY',
        priority: 2,
        enabled: true,
        tier: 'high',
        modality: 'text',
        censored: true,
        select: {
          prefer: ['deepseek-*-flash*'],
          take: 2,
        },
      };

      const expanded = expandRuleEntries([pinnedEntry, ruleEntry], routeConfig);
      // Pinned entry remains; rule entry skips deepseek-v4.2-flash and picks deepseek-v4.1-flash
      assert.equal(expanded.length, 2);
      assert.equal(expanded[0].id, 'pinned-flash');
      assert.equal(expanded[1].id, 'rule-dedupe~deepseek-v4.1-flash');
      assert.equal(expanded[1].model, 'deepseek-v4.1-flash');
    });

    it('excludes missing model and picks replacement', () => {
      const catWithMissing: CatalogData = {
        ...sampleCatalog,
        models: {
          ...sampleCatalog.models,
          'deepseek-v4.2-flash': {
            ...sampleCatalog.models['deepseek-v4.2-flash'],
            missingSince: Date.now() - 60000,
          },
        },
      };
      setCatalogForTests(catWithMissing);

      const routeConfig = makeRouteConfig(true);
      const ruleEntry: PoolEntry = {
        id: 'rule-missing',
        provider: 'ollama-cloud',
        model: '',
        baseUrl: 'https://ollama.com/v1',
        apiKeyEnv: 'OLLAMA_API_KEY',
        priority: 1,
        enabled: true,
        tier: 'high',
        modality: 'text',
        censored: true,
        select: {
          prefer: ['deepseek-*-flash*'],
          take: 1,
        },
      };

      const expanded = expandRuleEntries([ruleEntry], routeConfig);
      assert.equal(expanded.length, 1);
      // v4.2 is missing, so v4.1 is picked
      assert.equal(expanded[0].model, 'deepseek-v4.1-flash');
    });

    it('ignores rule entries on uncensored routes with a warning', () => {
      setCatalogForTests(sampleCatalog);

      const uncensoredRoute = makeRouteConfig(false);
      const ruleEntry: PoolEntry = {
        id: 'rule-uncensored',
        provider: 'ollama-cloud',
        model: '',
        baseUrl: 'https://ollama.com/v1',
        apiKeyEnv: 'OLLAMA_API_KEY',
        priority: 1,
        enabled: true,
        tier: 'high',
        modality: 'text',
        censored: false,
        select: {
          prefer: ['deepseek-*'],
          take: 1,
        },
      };

      const pinned: PoolEntry = {
        id: 'pinned-uncensored',
        provider: 'custom',
        model: 'uncensored-model',
        baseUrl: 'http://localhost',
        priority: 2,
        enabled: true,
        tier: 'high',
        modality: 'text',
        censored: false,
      };

      const expanded = expandRuleEntries([ruleEntry, pinned], uncensoredRoute);
      assert.equal(expanded.length, 1);
      assert.equal(expanded[0].id, 'pinned-uncensored');
    });

    it('emits catalog.rule-empty when a rule resolves to nothing', () => {
      setCatalogForTests({
        ...sampleCatalog,
        models: {}, // Empty catalog
      });

      const routeConfig = makeRouteConfig(true);
      const ruleEntry: PoolEntry = {
        id: 'rule-empty-test',
        provider: 'ollama-cloud',
        model: '',
        baseUrl: 'https://ollama.com/v1',
        apiKeyEnv: 'OLLAMA_API_KEY',
        priority: 1,
        enabled: true,
        tier: 'high',
        modality: 'text',
        censored: true,
        select: {
          prefer: ['nonexistent-*'],
          take: 1,
        },
      };

      const expanded = expandRuleEntries([ruleEntry], routeConfig);
      assert.equal(expanded.length, 0);

      const events = getRecentRouterEvents();
      const emptyEv = events.find((e) => e.type === 'catalog.rule-empty');
      assert.ok(emptyEv, 'Should emit catalog.rule-empty');
      assert.equal(emptyEv.route, 'text-high');
      assert.equal(emptyEv.ruleId, 'rule-empty-test');
    });

    it('performs expansion without any disk I/O on hot path', () => {
      setCatalogForTests(sampleCatalog);
      const routeConfig = makeRouteConfig(true);
      const ruleEntry: PoolEntry = {
        id: 'rule-io',
        provider: 'ollama-cloud',
        model: '',
        baseUrl: 'https://ollama.com/v1',
        apiKeyEnv: 'OLLAMA_API_KEY',
        priority: 1,
        enabled: true,
        tier: 'high',
        modality: 'text',
        censored: true,
        select: {
          prefer: ['deepseek-*'],
          take: 1,
        },
      };

      let ioCallCount = 0;
      const originalReadSync = fs.readFileSync;
      const originalWriteSync = fs.writeFileSync;
      const originalReaddirSync = fs.readdirSync;

      fs.readFileSync = ((...args: any[]) => {
        ioCallCount++;
        return (originalReadSync as any)(...args);
      }) as any;
      fs.writeFileSync = ((...args: any[]) => {
        ioCallCount++;
        return (originalWriteSync as any)(...args);
      }) as any;
      fs.readdirSync = ((...args: any[]) => {
        ioCallCount++;
        return (originalReaddirSync as any)(...args);
      }) as any;

      try {
        const expanded = expandRuleEntries([ruleEntry], routeConfig);
        assert.equal(expanded.length, 1);
        assert.equal(ioCallCount, 0, 'Rule expansion must not perform any disk I/O');
      } finally {
        fs.readFileSync = originalReadSync;
        fs.writeFileSync = originalWriteSync;
        fs.readdirSync = originalReaddirSync;
      }
    });

    it('default config resolves to today models when catalog contains them', () => {
      setCatalogForTests({
        provider: 'ollama-cloud',
        baseUrl: 'https://ollama.com/v1',
        fp: testFp,
        fetchedAt: Date.now(),
        models: {
          'deepseek-v4.1-flash': {
            created: 1000,
            capabilities: ['completion', 'tools'],
            contextLength: 128000,
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            admission: { status: 'admitted', at: Date.now() },
          },
          'minimax-m3': {
            created: 1000,
            capabilities: ['completion', 'vision'],
            contextLength: 64000,
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            admission: { status: 'admitted', at: Date.now() },
          },
        },
      });

      const configs = loadLogicalModelConfigs();

      // text-high should have ollama-cloud-deepseek-flash-high~deepseek-v4.1-flash
      const textHighPool = configs['text-high'].pool;
      const deepseekEntry = textHighPool.find((e) => e.model === 'deepseek-v4.1-flash');
      assert.ok(deepseekEntry, 'text-high should contain deepseek-v4.1-flash');
      assert.equal(deepseekEntry.fromRule, 'ollama-cloud-deepseek-flash-high');

      // vision-high should have minimax-m3
      const visionHighPool = configs['vision-high'].pool;
      const minimaxHigh = visionHighPool.find(
        (e) => e.fromRule === 'ollama-cloud-minimax-m3-vision-high'
      );
      assert.ok(minimaxHigh, 'vision-high should contain minimax-m3 from rule');
      assert.equal(minimaxHigh.model, 'minimax-m3');

      // vision-low should have minimax-m3
      const visionLowPool = configs['vision-low'].pool;
      const minimaxLow = visionLowPool.find(
        (e) => e.fromRule === 'ollama-cloud-minimax-m3-vision-low'
      );
      assert.ok(minimaxLow, 'vision-low should contain minimax-m3 from rule');
      assert.equal(minimaxLow.model, 'minimax-m3');
    });
  });
});
