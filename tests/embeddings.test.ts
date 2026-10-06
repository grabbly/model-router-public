import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Fastify, { FastifyInstance } from 'fastify';
import { embeddingsRoutes } from '../src/routes/embeddings.js';
import { modelsRoutes } from '../src/routes/models.js';
import { mintTenantToken } from '../src/auth/tenant-token.js';
import { resetCooldowns } from '../src/core/cooldown.js';
import { CONFIG } from '../src/config.js';

describe('POST /v1/embeddings Integration Tests', () => {
  let app: FastifyInstance;
  let mockBackend: http.Server;
  let backendPort: number;
  let upstreamStatusCode = 200;
  let lastUpstreamBody: any = null;
  let lastUpstreamHeaders: http.IncomingHttpHeaders = {};

  const masterKey = 'test-master-key-embeddings-9999';
  const tenantToken = mintTenantToken('tenant-embed-alpha', masterKey);

  before(async () => {
    CONFIG.serviceApiKey = masterKey;
    CONFIG.tenantTokenSecret = masterKey;

    mockBackend = http.createServer((req, res) => {
      lastUpstreamHeaders = req.headers;
      if (req.url?.startsWith('/embeddings')) {
        let bodyStr = '';
        req.on('data', (c) => (bodyStr += c));
        req.on('end', () => {
          try {
            lastUpstreamBody = JSON.parse(bodyStr || '{}');
          } catch {
            lastUpstreamBody = null;
          }

          if (upstreamStatusCode !== 200) {
            res.writeHead(upstreamStatusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'upstream failure' }));
            return;
          }

          const inputs = Array.isArray(lastUpstreamBody?.input)
            ? lastUpstreamBody.input
            : [lastUpstreamBody?.input];

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              object: 'list',
              data: inputs.map((_: unknown, idx: number) => ({
                object: 'embedding',
                index: idx,
                // Mock returns a 3-dimensional vector
                embedding: [0.123, -0.456, 0.789],
              })),
              model: lastUpstreamBody?.model || 'bge-m3:latest',
              usage: {
                prompt_tokens: 15,
                total_tokens: 15,
              },
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
        const addr = mockBackend.address() as { port: number };
        backendPort = addr.port;
        resolve();
      });
    });

    CONFIG.localOllamaBaseUrl = `http://127.0.0.1:${backendPort}`;

    app = Fastify({ logger: false });
    app.register(modelsRoutes);
    app.register(embeddingsRoutes);
    await app.ready();
  });

  after(async () => {
    await app.close();
    await new Promise<void>((resolve) => mockBackend.close(() => resolve()));
  });

  beforeEach(() => {
    resetCooldowns();
    upstreamStatusCode = 200;
    lastUpstreamBody = null;
    lastUpstreamHeaders = {};
  });

  it('1. success: string input -> 200, model === "text-embed", correct headers, upstream received bge-m3:latest', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: `Bearer ${tenantToken}`,
        'x-router-app': 'test-app',
        'x-router-agent': 'test-agent',
        'x-router-session': 'test-session',
      },
      payload: {
        model: 'text-embed',
        input: 'Hello world embedding test',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    assert.equal(body.object, 'list');
    assert.equal(body.model, 'text-embed');
    assert.equal(body.data.length, 1);
    assert.deepEqual(body.data[0].embedding, [0.123, -0.456, 0.789]);

    // Response headers verification
    assert.equal(res.headers['x-router-model'], 'bge-m3:latest');
    assert.equal(res.headers['x-router-provider'], 'local-gpu');
    assert.equal(res.headers['x-router-backend'], 'local-bge-m3-embed');
    assert.equal(res.headers['x-router-dims'], '3');

    // Upstream received model and input
    assert.equal(lastUpstreamBody.model, 'bge-m3:latest');
    assert.equal(lastUpstreamBody.input, 'Hello world embedding test');
  });

  it('2. array input passes through', async () => {
    const inputArray = ['First sentence to embed', 'Second sentence to embed'];
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: `Bearer ${tenantToken}`,
        'x-router-app': 'test-app',
        'x-router-agent': 'test-agent',
        'x-router-session': 'test-session',
      },
      payload: {
        model: 'text-embed',
        input: inputArray,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.model, 'text-embed');
    assert.equal(body.data.length, 2);
    assert.deepEqual(lastUpstreamBody.input, inputArray);
    assert.equal(lastUpstreamBody.model, 'bge-m3:latest');
  });

  it('3. unknown model text-high -> 404 model_not_found; bge-m3 physical -> 404', async () => {
    // 3a. Chat logical model name text-high must be rejected on /v1/embeddings
    const resChat = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: `Bearer ${tenantToken}`,
        'x-router-app': 'test-app',
        'x-router-agent': 'test-agent',
        'x-router-session': 'test-session',
      },
      payload: {
        model: 'text-high',
        input: 'test text',
      },
    });

    assert.equal(resChat.statusCode, 404);
    const bodyChat = JSON.parse(resChat.body);
    assert.equal(bodyChat.error.code, 'model_not_found');
    assert.ok(bodyChat.error.message.includes('text-embed'));

    // 3b. Physical model name bge-m3 must be rejected on /v1/embeddings
    const resPhysical = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: `Bearer ${tenantToken}`,
        'x-router-app': 'test-app',
        'x-router-agent': 'test-agent',
        'x-router-session': 'test-session',
      },
      payload: {
        model: 'bge-m3',
        input: 'test text',
      },
    });

    assert.equal(resPhysical.statusCode, 404);
    const bodyPhysical = JSON.parse(resPhysical.body);
    assert.equal(bodyPhysical.error.code, 'model_not_found');
  });

  it('4. missing/empty input -> 400 invalid_input', async () => {
    // Missing input
    const resMissing = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: `Bearer ${tenantToken}`,
        'x-router-app': 'test-app',
        'x-router-agent': 'test-agent',
        'x-router-session': 'test-session',
      },
      payload: {
        model: 'text-embed',
      },
    });
    assert.equal(resMissing.statusCode, 400);
    assert.equal(JSON.parse(resMissing.body).error.code, 'invalid_input');

    // Empty string input
    const resEmptyStr = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: `Bearer ${tenantToken}`,
        'x-router-app': 'test-app',
        'x-router-agent': 'test-agent',
        'x-router-session': 'test-session',
      },
      payload: {
        model: 'text-embed',
        input: '',
      },
    });
    assert.equal(resEmptyStr.statusCode, 400);
    assert.equal(JSON.parse(resEmptyStr.body).error.code, 'invalid_input');

    // Empty array input
    const resEmptyArr = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: `Bearer ${tenantToken}`,
        'x-router-app': 'test-app',
        'x-router-agent': 'test-agent',
        'x-router-session': 'test-session',
      },
      payload: {
        model: 'text-embed',
        input: [],
      },
    });
    assert.equal(resEmptyArr.statusCode, 400);
    assert.equal(JSON.parse(resEmptyArr.body).error.code, 'invalid_input');

    // Array with empty string
    const resArrEmptyStr = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: `Bearer ${tenantToken}`,
        'x-router-app': 'test-app',
        'x-router-agent': 'test-agent',
        'x-router-session': 'test-session',
      },
      payload: {
        model: 'text-embed',
        input: ['hello', ''],
      },
    });
    assert.equal(resArrEmptyStr.statusCode, 400);
    assert.equal(JSON.parse(resArrEmptyStr.body).error.code, 'invalid_input');
  });

  it('5. upstream 500 -> 502 upstream_unavailable', async () => {
    upstreamStatusCode = 500;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: `Bearer ${tenantToken}`,
        'x-router-app': 'test-app',
        'x-router-agent': 'test-agent',
        'x-router-session': 'test-session',
      },
      payload: {
        model: 'text-embed',
        input: 'should fail upstream',
      },
    });

    assert.equal(res.statusCode, 502);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'upstream_unavailable');
    assert.ok(body.error.message.includes('All embedding backends failed for "text-embed"'));
  });

  it('6. no auth -> 401 (same as chat)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      payload: {
        model: 'text-embed',
        input: 'test unauthenticated',
      },
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'unauthorized');
  });

  it('7. missing metadata in soft mode -> 200 + x-router-warning: missing-metadata', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: {
        authorization: `Bearer ${tenantToken}`,
        // Omit x-router-app, x-router-agent, x-router-session
      },
      payload: {
        model: 'text-embed',
        input: 'test soft mode warning',
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-router-warning'], 'missing-metadata');
    const body = JSON.parse(res.body);
    assert.equal(body.model, 'text-embed');
  });

  it('GET /v1/models includes text-embed with modality embedding and dims 1024', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: {
        authorization: `Bearer ${tenantToken}`,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const textEmbed = body.data.find((m: any) => m.id === 'text-embed');
    assert.ok(textEmbed, 'text-embed must be listed in /v1/models');
    assert.equal(textEmbed.modality, 'embedding');
    assert.equal(textEmbed.dims, 1024);
  });
});
