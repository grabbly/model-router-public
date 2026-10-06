import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { waitForAdmissionIdleForTests } from '../src/core/admission.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearCatalogsForTests,
  getCatalog,
  getCatalogModel,
  refreshCatalog,
  reportModelMissing,
  resetModelManual,
  saveCatalogSync,
  setModelManual,
  triggerAdmissionProbes,
} from '../src/core/catalog.js';
import { keyFingerprint, resolveEntryKey } from '../src/core/keys.js';
import { getRecentRouterEvents, resetRouterEventsForTests } from '../src/core/events.js';
import { forwardChat } from '../src/core/forwarder.js';
import { LogicalModelConfig, PoolEntry } from '../src/types.js';

describe('Model Catalog & Admission Probes (tests/catalog.test.ts)', () => {
  const originalFetch = global.fetch;
  const originalStateDir = process.env.ROUTER_STATE_DIR;
  const testKey = 'ollama-secret-key-1234';
  const testFp = keyFingerprint(testKey);
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-catalog-test-'));
    process.env.ROUTER_STATE_DIR = tmpDir;
    process.env.OLLAMA_API_KEY = testKey;
    clearCatalogsForTests();
    resetRouterEventsForTests();
  });

  afterEach(() => {
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

  describe('Key Resolution & Fingerprinting', () => {
    it('resolves key from env var and computes 12-char fingerprint', () => {
      const entry: PoolEntry = {
        id: 'entry-1',
        provider: 'ollama-cloud',
        model: 'test',
        baseUrl: 'https://ollama.com/v1',
        apiKeyEnv: 'OLLAMA_API_KEY',
        priority: 1,
        enabled: true,
        tier: 'high',
        modality: 'text',
        censored: true,
      };

      const resolved = resolveEntryKey(entry);
      assert.equal(resolved, testKey);

      const fp = keyFingerprint(testKey);
      assert.equal(fp.length, 12);
      assert.match(fp, /^[0-9a-f]{12}$/);
    });

    it('persists catalog atomically and never stores the key itself', async () => {
      global.fetch = async (url: any) => {
        const u = String(url);
        if (u.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              object: 'list',
              data: [{ id: 'model-a', created: 1789000000 }],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ capabilities: ['completion'] }), { status: 200 });
      };

      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey);

      const catalogFile = path.join(tmpDir, 'catalog', `ollama-cloud-${testFp}.json`);
      assert.ok(fs.existsSync(catalogFile), 'Catalog file must exist on disk');

      const fileContent = fs.readFileSync(catalogFile, 'utf-8');
      assert.ok(!fileContent.includes(testKey), 'Catalog file must NEVER store the raw key');
      assert.ok(fileContent.includes(testFp), 'Catalog file contains key fingerprint');
    });
  });

  describe('Catalog Refresh Lifecycle & Events', () => {
    it('first fetch populates models and emits NO added events', async () => {
      global.fetch = async (url: any) => {
        const u = String(url);
        if (u.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              object: 'list',
              data: [
                { id: 'deepseek-v4.1-flash', created: 1789000000 },
                { id: 'glm-4-flash', created: 1789001000 },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ capabilities: ['completion', 'tools'] }), {
          status: 200,
        });
      };

      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey);

      const cat = getCatalog('ollama-cloud', testFp);
      assert.ok(cat);
      assert.ok(cat.models['deepseek-v4.1-flash']);
      assert.ok(cat.models['glm-4-flash']);

      const events = getRecentRouterEvents();
      const addedEvents = events.filter((e) => e.type === 'catalog.model-added');
      assert.equal(
        addedEvents.length,
        0,
        'First catalog fetch must not emit catalog.model-added storm'
      );
    });

    it('subsequent fetch with new model emits catalog.model-added', async () => {
      // First fetch: only deepseek-v4.1-flash
      global.fetch = async (url: any) => {
        const u = String(url);
        if (u.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              object: 'list',
              data: [{ id: 'deepseek-v4.1-flash', created: 1789000000 }],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ capabilities: ['completion'] }), { status: 200 });
      };

      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey);
      resetRouterEventsForTests();

      // Second fetch: deepseek-v4.1-flash + newly added model-new
      global.fetch = async (url: any) => {
        const u = String(url);
        if (u.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              object: 'list',
              data: [
                { id: 'deepseek-v4.1-flash', created: 1789000000 },
                { id: 'model-new', created: 1789002000 },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ capabilities: ['completion'] }), { status: 200 });
      };

      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey);

      const events = getRecentRouterEvents();
      const added = events.find((e) => e.type === 'catalog.model-added');
      assert.ok(added, 'Should emit catalog.model-added for newly discovered model');
      assert.equal(added.model, 'model-new');
      assert.equal(added.provider, 'ollama-cloud');
      assert.equal(added.fp, testFp);
    });

    it('model absent from successful list sets missingSince and emits catalog.model-removed; returning clears it', async () => {
      let returnedModels = [
        { id: 'deepseek-v4.1-flash', created: 100 },
        { id: 'temporary-model', created: 200 },
      ];

      global.fetch = async (url: any) => {
        const u = String(url);
        if (u.endsWith('/models')) {
          return new Response(JSON.stringify({ object: 'list', data: returnedModels }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ capabilities: ['completion'] }), { status: 200 });
      };

      // Initial populate
      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey);
      resetRouterEventsForTests();

      // Next fetch: temporary-model has disappeared
      returnedModels = [{ id: 'deepseek-v4.1-flash', created: 100 }];
      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey);

      const cat = getCatalog('ollama-cloud', testFp);
      const tempModel = cat?.models['temporary-model'];
      assert.ok(tempModel?.missingSince, 'Missing model should have missingSince set');

      const events = getRecentRouterEvents();
      const removed = events.find((e) => e.type === 'catalog.model-removed');
      assert.ok(removed, 'Should emit catalog.model-removed');
      assert.equal(removed.model, 'temporary-model');

      // Next fetch: temporary-model reappears
      resetRouterEventsForTests();
      returnedModels = [
        { id: 'deepseek-v4.1-flash', created: 100 },
        { id: 'temporary-model', created: 200 },
      ];
      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey);

      const restored = cat?.models['temporary-model'];
      assert.equal(restored?.missingSince, undefined, 'missingSince should be cleared on return');
    });

    it('failed list call changes nothing (never treat outage as all models gone)', async () => {
      global.fetch = async (url: any) => {
        const u = String(url);
        if (u.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              object: 'list',
              data: [{ id: 'model-stable', created: 100 }],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ capabilities: ['completion'] }), { status: 200 });
      };

      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey);
      const initialCat = getCatalog('ollama-cloud', testFp);
      assert.ok(initialCat?.models['model-stable']);

      // Now upstream fails (502 Bad Gateway)
      global.fetch = async () => new Response('Bad Gateway', { status: 502 });

      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey);

      const afterOutage = getCatalog('ollama-cloud', testFp);
      assert.ok(afterOutage?.models['model-stable']);
      assert.equal(afterOutage?.models['model-stable'].missingSince, undefined);
    });

    it('describeModel parses capabilities, context length and family', async () => {
      global.fetch = async (url: any) => {
        const u = String(url);
        if (u.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              object: 'list',
              data: [{ id: 'deepseek-v4.1-flash', created: 1789009200 }],
            }),
            { status: 200 }
          );
        }
        if (u.endsWith('/api/show')) {
          return new Response(
            JSON.stringify({
              capabilities: ['completion', 'thinking', 'tools', 'vision'],
              details: { family: 'deepseek_v41', parameter_size: '763205315794' },
              model_info: {
                'deepseek_v41.context_length': 1048576,
                'general.parameter_count': 763205315794,
              },
            }),
            { status: 200 }
          );
        }
        return new Response('Not found', { status: 404 });
      };

      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey);

      const m = getCatalogModel('ollama-cloud', testFp, 'deepseek-v4.1-flash');
      assert.ok(m);
      assert.deepEqual(m.capabilities, ['completion', 'thinking', 'tools', 'vision']);
      assert.equal(m.contextLength, 1048576);
      assert.equal(m.parameterCount, 763205315794);
      assert.equal(m.family, 'deepseek_v41');
      assert.ok(m.describedAt);
    });
  });

  describe('Admission Probing', () => {
    const routeWithRule: Record<string, LogicalModelConfig> = {
      'text-high': {
        id: 'text-high',
        description: 'Test text high',
        modality: 'text',
        tier: 'high',
        censored: true,
        timeoutMs: 10000,
        cooldownSec: 60,
        pool: [
          {
            id: 'rule-test-tools',
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
              need: ['tools'],
              prefer: ['deepseek-v4.1-flash', 'deepseek-*-flash*'],
              take: 1,
            },
          },
          {
            id: 'rule-test-vision',
            provider: 'ollama-cloud',
            model: '',
            baseUrl: 'https://ollama.com/v1',
            apiKeyEnv: 'OLLAMA_API_KEY',
            priority: 2,
            enabled: true,
            tier: 'high',
            modality: 'vision',
            censored: true,
            select: {
              need: ['vision'],
              prefer: ['minimax-m3', 'gemma*'],
              take: 1,
            },
          },
        ],
      },
    };

    it('pre-admits model equal to the FIRST prefer pattern without wildcard', async () => {
      global.fetch = async (url: any) => {
        const u = String(url);
        if (u.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              object: 'list',
              data: [{ id: 'deepseek-v4.1-flash', created: 100 }],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ capabilities: ['completion', 'tools'] }), {
          status: 200,
        });
      };

      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey, routeWithRule);

      const m = getCatalogModel('ollama-cloud', testFp, 'deepseek-v4.1-flash');
      assert.ok(m);
      assert.equal(
        m.admission?.status,
        'admitted',
        'First prefer pattern without wildcard must be pre-admitted'
      );
    });

    it('runs background probe for wildcard candidates; completion pass emits catalog.model-admitted', async () => {
      let probeBodies: any[] = [];
      global.fetch = async (url: any, opts: any) => {
        const u = String(url);
        if (u.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              object: 'list',
              // deepseek-v4.2-flash matches prefer[1] (wildcard deepseek-*-flash*)
              data: [{ id: 'deepseek-v4.2-flash', created: 100 }],
            }),
            { status: 200 }
          );
        }
        if (u.endsWith('/api/show')) {
          return new Response(JSON.stringify({ capabilities: ['completion', 'tools'] }), {
            status: 200,
          });
        }
        if (u.endsWith('/chat/completions')) {
          const body = JSON.parse(opts.body || '{}');
          probeBodies.push(body);
          if (body.tools) {
            // Tools probe response
            return new Response(
              JSON.stringify({
                choices: [{ message: { tool_calls: [{ function: { name: 'get_time' } }] } }],
              }),
              { status: 200 }
            );
          }
          // Completion probe response
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: 'ok' } }],
            }),
            { status: 200 }
          );
        }
        return new Response('Not found', { status: 404 });
      };

      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey, routeWithRule);

      // Wait a moment for background admission probe queue to process
      await waitForAdmissionIdleForTests();

      const m = getCatalogModel('ollama-cloud', testFp, 'deepseek-v4.2-flash');
      assert.equal(m?.admission?.status, 'admitted');
      assert.equal(m?.admission?.checks?.completion, true);
      assert.equal(m?.admission?.checks?.tools, true);

      const events = getRecentRouterEvents();
      const admittedEv = events.find((e) => e.type === 'catalog.model-admitted');
      assert.ok(admittedEv);
      assert.equal(admittedEv.model, 'deepseek-v4.2-flash');
    });

    it('probe failure marks model rejected with reason and emits catalog.model-rejected', async () => {
      global.fetch = async (url: any, opts: any) => {
        const u = String(url);
        if (u.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              object: 'list',
              data: [{ id: 'deepseek-broken-flash', created: 100 }],
            }),
            { status: 200 }
          );
        }
        if (u.endsWith('/api/show')) {
          return new Response(JSON.stringify({ capabilities: ['completion', 'tools'] }), {
            status: 200,
          });
        }
        if (u.endsWith('/chat/completions')) {
          // Upstream error
          return new Response('Model engine failed', { status: 500 });
        }
        return new Response('Not found', { status: 404 });
      };

      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey, routeWithRule);
      await waitForAdmissionIdleForTests();

      const m = getCatalogModel('ollama-cloud', testFp, 'deepseek-broken-flash');
      assert.equal(m?.admission?.status, 'rejected');
      assert.ok(m?.admission?.reason?.includes('HTTP 500'));

      const events = getRecentRouterEvents();
      const rejEv = events.find((e) => e.type === 'catalog.model-rejected');
      assert.ok(rejEv);
      assert.equal(rejEv.model, 'deepseek-broken-flash');
      assert.ok(String(rejEv.reason).includes('HTTP 500'));
    });

    it('probe returning HTTP 429 keeps status pending without emitting rejected', async () => {
      global.fetch = async (url: any) => {
        const u = String(url);
        if (u.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              object: 'list',
              data: [{ id: 'deepseek-ratelimited-flash', created: 100 }],
            }),
            { status: 200 }
          );
        }
        if (u.endsWith('/api/show')) {
          return new Response(JSON.stringify({ capabilities: ['completion', 'tools'] }), {
            status: 200,
          });
        }
        if (u.endsWith('/chat/completions')) {
          return new Response('Rate limited', { status: 429 });
        }
        return new Response('Not found', { status: 404 });
      };

      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey, routeWithRule);
      await waitForAdmissionIdleForTests();

      const m = getCatalogModel('ollama-cloud', testFp, 'deepseek-ratelimited-flash');
      assert.equal(m?.admission?.status, 'pending');

      const events = getRecentRouterEvents();
      const rejEv = events.find((e) => e.type === 'catalog.model-rejected');
      assert.equal(rejEv, undefined, '429 must not reject the model');
    });

    it('probes vision with 32x32 red PNG and passes if response contains red/красн', async () => {
      let sawDataUrl = false;
      global.fetch = async (url: any, opts: any) => {
        const u = String(url);
        if (u.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              object: 'list',
              // gemma-vision matches prefer[1] of vision rule
              data: [{ id: 'gemma-vision', created: 100 }],
            }),
            { status: 200 }
          );
        }
        if (u.endsWith('/api/show')) {
          return new Response(JSON.stringify({ capabilities: ['completion', 'vision'] }), {
            status: 200,
          });
        }
        if (u.endsWith('/chat/completions')) {
          const body = JSON.parse(opts.body || '{}');
          if (body.messages?.[0]?.content?.[1]?.image_url?.url?.startsWith('data:image/png;base64,')) {
            sawDataUrl = true;
            return new Response(
              JSON.stringify({
                choices: [{ message: { content: 'Красный' } }],
              }),
              { status: 200 }
            );
          }
          // completion
          return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
            status: 200,
          });
        }
        return new Response('Not found', { status: 404 });
      };

      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey, routeWithRule);
      await waitForAdmissionIdleForTests();

      assert.equal(sawDataUrl, true, 'Vision probe must send base64 data URL generated with sharp');
      const m = getCatalogModel('ollama-cloud', testFp, 'gemma-vision');
      assert.equal(m?.admission?.status, 'admitted');
      assert.equal(m?.admission?.checks?.vision, true);
    });

    it('admin manual override admit / block wins over probes, and reset clears them', async () => {
      global.fetch = async (url: any) => {
        const u = String(url);
        if (u.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              object: 'list',
              data: [{ id: 'model-override', created: 100 }],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ capabilities: ['completion'] }), { status: 200 });
      };

      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey);
      const catId = `ollama-cloud-${testFp}`;

      // 1. Manual block
      setModelManual(catId, 'model-override', 'block');
      let m = getCatalogModel('ollama-cloud', testFp, 'model-override');
      assert.equal(m?.manual, 'block');

      // 2. Manual admit
      setModelManual(catId, 'model-override', 'admit');
      m = getCatalogModel('ollama-cloud', testFp, 'model-override');
      assert.equal(m?.manual, 'admit');

      // 3. Reset
      resetModelManual(catId, 'model-override');
      m = getCatalogModel('ollama-cloud', testFp, 'model-override');
      assert.equal(m?.manual, undefined);
      assert.equal(m?.admission, undefined);
    });
  });

  describe('Forwarder 404 -> reportModelMissing -> Replacement Candidate', () => {
    it('forwarder 404 marks model missing and next request uses replacement', async () => {
      // Setup catalog with 2 models: v4.1 and v4.2
      global.fetch = async (url: any) => {
        const u = String(url);
        if (u.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              object: 'list',
              data: [
                { id: 'deepseek-v4.1-flash', created: 200 },
                { id: 'deepseek-v4.2-flash', created: 100 },
              ],
            }),
            { status: 200 }
          );
        }
        if (u.includes('/chat/completions')) {
          return new Response(
            JSON.stringify({
              id: 'chat-ok',
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: 'ok',
                    tool_calls: [
                      {
                        id: 'tc1',
                        type: 'function',
                        function: { name: 'get_time', arguments: '{}' },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ capabilities: ['completion', 'tools'] }), {
          status: 200,
        });
      };

      const testRoute: LogicalModelConfig = {
        id: 'text-high',
        description: 'Test text high',
        modality: 'text',
        tier: 'high',
        censored: true,
        timeoutMs: 5000,
        cooldownSec: 60,
        pool: [
          {
            id: 'rule-ollama',
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
              take: 2,
            },
          },
        ],
      };

      await refreshCatalog('ollama-cloud', 'https://ollama.com/v1', testKey, {
        'text-high': testRoute,
      });

      // Wait briefly for background admission probes to finish
      await waitForAdmissionIdleForTests();

      const cat = getCatalog('ollama-cloud', testFp)!;
      cat.models['deepseek-v4.1-flash'].admission = { status: 'admitted', at: Date.now() };
      cat.models['deepseek-v4.2-flash'].admission = { status: 'admitted', at: Date.now() };
      saveCatalogSync('ollama-cloud', testFp);

      // Now simulate upstream: deepseek-v4.1-flash returns 404 "model not found"
      // while deepseek-v4.2-flash returns 200 OK
      global.fetch = async (url: any, opts: any) => {
        const body = JSON.parse(opts?.body || '{}');
        if (body.model === 'deepseek-v4.1-flash') {
          return new Response(
            JSON.stringify({ error: { message: 'model "deepseek-v4.1-flash" not found' } }),
            { status: 404 }
          );
        }
        if (body.model === 'deepseek-v4.2-flash') {
          return new Response(
            JSON.stringify({
              id: 'chat-ok',
              object: 'chat.completion',
              choices: [{ message: { role: 'assistant', content: 'hello from replacement' } }],
            }),
            { status: 200 }
          );
        }
        return new Response('Not found', { status: 404 });
      };

      const { expandRuleEntries } = await import('../src/core/rules.js');

      // Request 1: initial expansion has both candidates. Candidate 1 returns 404.
      const initialPool = expandRuleEntries(testRoute.pool, testRoute);
      assert.equal(initialPool[0]?.model, 'deepseek-v4.1-flash');

      const res1 = await forwardChat(
        'text-high',
        { ...testRoute, pool: initialPool },
        { messages: [{ role: 'user', content: 'hi' }] }
      );

      // Failover during request 1 succeeds via replacement
      assert.equal(res1.ok, true);
      assert.equal(res1.via?.model, 'deepseek-v4.2-flash');

      // Verify deepseek-v4.1-flash was marked missing
      const m1 = getCatalogModel('ollama-cloud', testFp, 'deepseek-v4.1-flash');
      assert.ok(m1?.missingSince, 'Model returning 404 must be marked missingSince');

      // Request 2: new expansion on next request completely excludes deepseek-v4.1-flash!
      const nextPool = expandRuleEntries(testRoute.pool, testRoute);
      assert.equal(nextPool.length, 1);
      assert.equal(nextPool[0].model, 'deepseek-v4.2-flash');

      const res2 = await forwardChat(
        'text-high',
        { ...testRoute, pool: nextPool },
        { messages: [{ role: 'user', content: 'hi 2' }] }
      );
      assert.equal(res2.ok, true);
      assert.equal(res2.via?.model, 'deepseek-v4.2-flash');
    });
  });
});
