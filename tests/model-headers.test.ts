import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { providerLabel } from '../src/core/provider-label.js';
import { mintTenantToken } from '../src/auth/tenant-token.js';
import { resetCooldowns, recordFailure } from '../src/core/cooldown.js';
import { clearRetirementAlerts } from '../src/core/retirement.js';
import { CONFIG } from '../src/config.js';
import { PoolEntry } from '../src/types.js';

describe('providerLabel unit tests (all branches)', () => {
  const baseEntry: PoolEntry = {
    id: 'test-entry',
    provider: 'custom',
    model: 'test-model',
    baseUrl: 'https://example.com/v1',
    priority: 1,
    enabled: true,
    tier: 'high',
    modality: 'text',
    censored: true,
  };

  it('1a. budgetGroup === "minimax" -> "minimax"', () => {
    const entry: PoolEntry = { ...baseEntry, budgetGroup: 'minimax', baseUrl: 'https://api.example.com/v1' };
    assert.equal(providerLabel(entry), 'minimax');
  });

  it('1b. baseUrl contains "minimax" -> "minimax"', () => {
    const entry: PoolEntry = { ...baseEntry, baseUrl: 'https://api.minimax.io/v1' };
    assert.equal(providerLabel(entry), 'minimax');
  });

  it('2. provider === "ollama-cloud" -> "ollama-cloud"', () => {
    const entry: PoolEntry = { ...baseEntry, provider: 'ollama-cloud', baseUrl: 'https://ollama.com/v1' };
    assert.equal(providerLabel(entry), 'ollama-cloud');
  });

  it('3. baseUrl contains "/gemini/" -> "backend2-gemini"', () => {
    const entry: PoolEntry = { ...baseEntry, baseUrl: 'https://backend2.example.com/gemini/v1' };
    assert.equal(providerLabel(entry), 'backend2-gemini');
  });

  it('4. provider === "ollama" -> "local-gpu"', () => {
    const entry: PoolEntry = { ...baseEntry, provider: 'ollama', baseUrl: 'http://localhost:11434/v1' };
    assert.equal(providerLabel(entry), 'local-gpu');
  });

  it('5a. otherwise returns URL hostname', () => {
    const entry: PoolEntry = { ...baseEntry, provider: 'custom', baseUrl: 'https://api.groq.com/openai/v1' };
    assert.equal(providerLabel(entry), 'api.groq.com');
  });

  it('5b. unparseable URL falls back to "custom"', () => {
    const entry: PoolEntry = { ...baseEntry, provider: 'custom', baseUrl: 'not-a-valid-url' };
    assert.equal(providerLabel(entry), 'custom');
  });
});

describe('Chat responses physical model headers (x-router-*)', () => {
  let app: FastifyInstance;
  let mockBackend: http.Server;
  let backendPort: number;

  const masterKey = 'test-master-key-chat-headers-9999';
  const tenantToken = mintTenantToken('tenant-headers-test', masterKey);

  before(async () => {
    CONFIG.serviceApiKey = masterKey;
    CONFIG.tenantTokenSecret = masterKey;

    mockBackend = http.createServer((req, res) => {
      if (req.url?.startsWith('/chat/completions')) {
        let bodyStr = '';
        req.on('data', (c) => (bodyStr += c));
        req.on('end', () => {
          const parsed = JSON.parse(bodyStr || '{}');

          // If requested model is 'force-fail', trigger error response
          if (parsed.messages?.[0]?.content === 'force-fail') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'upstream boom', code: 'upstream_failed' } }));
            return;
          }

          if (parsed.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: {"id":"chatcmpl-test","choices":[{"delta":{"content":"Hi" models}}]}\n\n');
            res.end('data: [DONE]\n\n');
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'chatcmpl-test',
                object: 'chat.completion',
                created: 1700000000,
                model: parsed.model || 'raw-model',
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'Chat response' },
                    finish_reason: 'stop',
                  },
                ],
              })
            );
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      mockBackend.listen(0, '127.0.0.1', () => {
        const addr = mockBackend.address() as { port: number };
        backendPort = addr.port;
        resolve();
      });
    });

    CONFIG.cloudBaseUrl = `http://127.0.0.1:${backendPort}`;
    CONFIG.backend2BaseUrl = `http://127.0.0.1:${backendPort}`;
    CONFIG.localOllamaBaseUrl = `http://127.0.0.1:${backendPort}`;
    CONFIG.minimaxBaseUrl = `http://127.0.0.1:${backendPort}`;

    app = buildApp();
    await app.ready();
  });

  after(async () => {
    await app.close();
    await new Promise<void>((resolve) => mockBackend.close(() => resolve()));
  });

  beforeEach(() => {
    resetCooldowns();
    clearRetirementAlerts();
  });

  it('non-streaming chat response carries x-router-* and x-pf-* headers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${tenantToken}`,
        'x-router-app': 'test-app',
        'x-router-agent': 'test-agent',
        'x-router-session': 'test-session',
      },
      payload: {
        model: 'text-low',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      },
    });

    assert.equal(res.statusCode, 200);

    // New x-router-* headers
    assert.equal(res.headers['x-router-model'], 'qwen2.5:7b-64k');
    assert.equal(res.headers['x-router-provider'], 'local-gpu');
    assert.equal(res.headers['x-router-backend'], 'local-qwen-low');
    assert.equal(res.headers['x-router-context-length'], '65536');

    // Backward-compatible x-pf-* headers
    assert.equal(res.headers['x-pf-backend'], 'local-qwen-low');
    assert.equal(res.headers['x-pf-backend-model'], 'qwen2.5:7b-64k');
  });

  it('streaming chat response carries x-router-* and x-pf-* headers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${tenantToken}`,
        'x-router-app': 'test-app',
        'x-router-agent': 'test-agent',
        'x-router-session': 'test-session',
      },
      payload: {
        model: 'text-low',
        messages: [{ role: 'user', content: 'Hello stream' }],
        stream: true,
      },
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type']?.includes('text/event-stream'));

    // New x-router-* headers in SSE response
    assert.equal(res.headers['x-router-model'], 'qwen2.5:7b-64k');
    assert.equal(res.headers['x-router-provider'], 'local-gpu');
    assert.equal(res.headers['x-router-backend'], 'local-qwen-low');
    assert.equal(res.headers['x-router-context-length'], '65536');

    // Backward-compatible x-pf-* headers
    assert.equal(res.headers['x-pf-backend'], 'local-qwen-low');
    assert.equal(res.headers['x-pf-backend-model'], 'qwen2.5:7b-64k');
  });

  it('omits x-router-context-length when backend lacks contextLength', async () => {
    // Cool down primary vision entry so it falls back to backend2-gemini-flash-image (which has no contextLength)
    recordFailure('vision-high', 'minimax-m3-direct-vision-high', 60);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${tenantToken}`,
        'x-router-app': 'test-app',
      },
      payload: {
        model: 'vision-high',
        messages: [{ role: 'user', content: 'Describe this image' }],
        stream: false,
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-router-backend'], 'local-qwen-vl-high');
    assert.equal(res.headers['x-router-context-length'], undefined);
  });

  it('GET /v1/models includes context_length_min and context_length_unknown', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: {
        authorization: `Bearer ${tenantToken}`,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.object, 'list');

    const byId = Object.fromEntries(body.data.map((m: any) => [m.id, m]));

    // text-low: local-qwen-low is 65536, gemini is 1048576, minimax is 512000 -> min is 65536
    assert.equal(byId['text-low'].context_length_min, 65536);

    // text-high-think: all entries have contextLength (512000 to 1048576) -> min is 512000, context_length_unknown is undefined
    assert.equal(byId['text-high-think'].context_length_min, 512000);
    assert.equal(byId['text-high-think'].context_length_unknown, undefined);

    // vision-high: minimax is 512000, but gemini-flash-image and qwen2.5vl:7b have no contextLength -> unknown is true
    assert.equal(byId['vision-high'].context_length_min, 512000);
    assert.equal(byId['vision-high'].context_length_unknown, true);
  });
});
