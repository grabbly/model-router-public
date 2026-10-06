import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { mintTenantToken } from '../src/auth/tenant-token.js';
import { resetCooldowns } from '../src/core/cooldown.js';
import { clearRetirementAlerts } from '../src/core/retirement.js';
import { CONFIG } from '../src/config.js';

describe('API Integration Test (Fastify & OpenAI compatibility)', () => {
  let app: FastifyInstance;
  let mockBackend: http.Server;
  let backendPort: number;
  const masterKey = 'test-master-service-key-9999';
  const tenant1Token = mintTenantToken('tenant-alpha', masterKey);
  const tenant2Token = mintTenantToken('tenant-beta', masterKey);

  before(async () => {
    // Set test configuration keys
    CONFIG.serviceApiKey = masterKey;
    CONFIG.tenantTokenSecret = masterKey;

    mockBackend = http.createServer((req, res) => {
      if (req.url === '/chat/completions') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}');
          if (parsed.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(
              'data: {"id":"chatcmpl-backend-1","choices":[{"delta":{"role":"assistant","content":"Hello world!"}}]}\n\n'
            );
            res.end('data: [DONE]\n\n');
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'chatcmpl-backend-1',
                object: 'chat.completion',
                created: 1700000000,
                model: parsed.model || 'raw-model',
                system_fingerprint: 'fp_raw_123',
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'Non-streaming response' },
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

    // Point cloud and backend2 to mock backend
    CONFIG.cloudBaseUrl = `http://127.0.0.1:${backendPort}`;
    CONFIG.backend2BaseUrl = `http://127.0.0.1:${backendPort}`;
    CONFIG.localOllamaBaseUrl = `http://127.0.0.1:${backendPort}`;

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

  it('GET /healthz returns 200 OK without auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'model-router');
  });

  it('GET /v1/models rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'unauthorized');
  });

  it('GET /v1/models returns logical models catalog when authorized', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: {
        authorization: `Bearer ${tenant1Token}`,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data));

    const ids = body.data.map((m: { id: string }) => m.id);
    assert.ok(ids.includes('text-high'));
    assert.ok(ids.includes('text-low'));
    assert.ok(ids.includes('text-summarize'));
    assert.ok(ids.includes('vision-high'));
    assert.ok(ids.includes('vision-low'));
  });

  it('POST /v1/chat/completions (non-streaming) returns masked completion', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${tenant1Token}`,
      },
      payload: {
        model: 'text-low',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.model, 'text-low');
    assert.equal(body.system_fingerprint, undefined);
    assert.equal(body.choices[0].message.content, 'Non-streaming response');
  });

  it('POST /v1/chat/completions (streaming) returns SSE stream with masked chunks', async () => {
    // text-high has no local entry any more; serve it from (mock) backend2
    process.env.PF_MODELS_TOKEN = 'mock-backend2-token';
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${tenant2Token}`,
      },
      payload: {
        model: 'text-high',
        messages: [{ role: 'user', content: 'stream please' }],
        stream: true,
      },
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type']?.includes('text/event-stream'));
    assert.ok(res.body.includes('"model":"text-high"'));
    assert.ok(res.body.includes('Hello world!'));
    assert.ok(res.body.includes('data: [DONE]'));
    delete process.env.PF_MODELS_TOKEN;
  });

  it('GET /admin/status returns system status and telemetry', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: {
        authorization: `Bearer ${masterKey}`,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.logicalModels['text-high'] !== undefined);
    assert.ok(body.logicalModels['text-low'] !== undefined);
    assert.ok(body.logicalModels['text-summarize'] !== undefined);
    assert.ok(body.requestStats.totalRequests >= 2);
    assert.ok(body.requestStats.tenantsSeen.includes('tenant-alpha'));
    assert.ok(body.requestStats.tenantsSeen.includes('tenant-beta'));
    assert.ok(body.budget !== undefined);
    assert.ok(body.loopGuard !== undefined);
    assert.ok(body.clientMetadata !== undefined);
  });
});
