import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { LogicalModelConfig, ChatCompletionRequest } from '../src/types.js';
import { forwardChat } from '../src/core/forwarder.js';
import { resetCooldowns, isCoolingDown } from '../src/core/cooldown.js';
import { resetPreselections } from '../src/core/selector.js';

describe('Forwarder & Reactive Failover (0-byte & Hang Protection)', () => {
  let mockServer: http.Server;
  let serverPort: number;

  before(async () => {
    mockServer = http.createServer((req, res) => {
      if (req.url === '/chat/completions') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}');

          // 1. Error mock
          if (parsed.model === 'error-primary') {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'service overloaded' }));
            return;
          }

          // 2. 0-chunk hanging stream mock (sends 200 headers, then never writes any data)
          if (parsed.model === 'zero-chunk-primary') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            // Deliberately keep socket open without writing anything
            return;
          }

          // 3. 0-byte empty response mock (sends 200 headers, immediately ends with 0 bytes)
          if (parsed.model === 'empty-stream-primary') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end();
            return;
          }

          // 4. Healthy secondary fallback
          if (parsed.model === 'healthy-secondary') {
            if (parsed.stream) {
              res.writeHead(200, { 'Content-Type': 'text/event-stream' });
              res.write(
                'data: {"id":"chat-2","choices":[{"delta":{"content":"Hello from fallback"}}]}\n\n'
              );
              res.end('data: [DONE]\n\n');
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  id: 'chatcmpl-fallback',
                  object: 'chat.completion',
                  created: 1700000000,
                  model: 'healthy-secondary',
                  choices: [
                    {
                      index: 0,
                      message: { role: 'assistant', content: 'Fallback answer' },
                      finish_reason: 'stop',
                    },
                  ],
                })
              );
            }
            return;
          }

          res.writeHead(404);
          res.end();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address() as { port: number };
        serverPort = addr.port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  beforeEach(() => {
    resetCooldowns();
    resetPreselections();
  });

  it('fails over immediately when primary returns HTTP 503 error', async () => {
    const config: LogicalModelConfig = {
      id: 'text-low',
      description: 'test',
      modality: 'text',
      tier: 'low',
      censored: true,
      timeoutMs: 1000,
      cooldownSec: 60,
      pool: [
        {
          id: 'primary-err',
          provider: 'custom',
          model: 'error-primary',
          baseUrl: `http://127.0.0.1:${serverPort}`,
          priority: 1,
          enabled: true,
          tier: 'low',
          modality: 'text',
          censored: true,
        },
        {
          id: 'fallback-ok',
          provider: 'custom',
          model: 'healthy-secondary',
          baseUrl: `http://127.0.0.1:${serverPort}`,
          priority: 2,
          enabled: true,
          tier: 'low',
          modality: 'text',
          censored: true,
        },
      ],
    };

    const req: ChatCompletionRequest = {
      model: 'text-low',
      messages: [{ role: 'user', content: 'test' }],
      stream: false,
    };

    const result = await forwardChat('text-low', config, req, 'tenant-test');
    assert.equal(result.ok, true);
    assert.equal(result.via?.id, 'fallback-ok');
    assert.equal(result.failoverCount, 1);

    // Verify primary is put in cooldown
    const cooling = isCoolingDown('text-low', 'primary-err');
    assert.equal(cooling.cooling, true);
  });

  it('detects 0-byte hanging stream within TTFB timeout and fails over to secondary', async () => {
    const config: LogicalModelConfig = {
      id: 'text-low',
      description: 'test',
      modality: 'text',
      tier: 'low',
      censored: true,
      timeoutMs: 150, // fast TTFB timeout for test
      cooldownSec: 60,
      pool: [
        {
          id: 'primary-hanging-0-chunk',
          provider: 'custom',
          model: 'zero-chunk-primary',
          baseUrl: `http://127.0.0.1:${serverPort}`,
          priority: 1,
          enabled: true,
          tier: 'low',
          modality: 'text',
          censored: true,
        },
        {
          id: 'fallback-ok',
          provider: 'custom',
          model: 'healthy-secondary',
          baseUrl: `http://127.0.0.1:${serverPort}`,
          priority: 2,
          enabled: true,
          tier: 'low',
          modality: 'text',
          censored: true,
        },
      ],
    };

    const req: ChatCompletionRequest = {
      model: 'text-low',
      messages: [{ role: 'user', content: 'test' }],
      stream: true,
    };

    const startTime = Date.now();
    const result = await forwardChat('text-low', config, req, 'tenant-test');
    const duration = Date.now() - startTime;

    assert.equal(result.ok, true);
    assert.equal(result.via?.id, 'fallback-ok');
    assert.equal(result.failoverCount, 1);
    assert.ok(result.stream !== undefined);

    // Verify failover happened within short TTFB timeout (well below default 15s)
    assert.ok(duration < 800, `Failover took ${duration}ms, expected <= 800ms`);

    // Verify failing primary is put in cooldown
    const cooling = isCoolingDown('text-low', 'primary-hanging-0-chunk');
    assert.equal(cooling.cooling, true);
  });

  it('fails over immediately when primary stream ends with 0 bytes', async () => {
    const config: LogicalModelConfig = {
      id: 'text-low',
      description: 'test',
      modality: 'text',
      tier: 'low',
      censored: true,
      timeoutMs: 500,
      cooldownSec: 60,
      pool: [
        {
          id: 'primary-empty',
          provider: 'custom',
          model: 'empty-stream-primary',
          baseUrl: `http://127.0.0.1:${serverPort}`,
          priority: 1,
          enabled: true,
          tier: 'low',
          modality: 'text',
          censored: true,
        },
        {
          id: 'fallback-ok',
          provider: 'custom',
          model: 'healthy-secondary',
          baseUrl: `http://127.0.0.1:${serverPort}`,
          priority: 2,
          enabled: true,
          tier: 'low',
          modality: 'text',
          censored: true,
        },
      ],
    };

    const req: ChatCompletionRequest = {
      model: 'text-low',
      messages: [{ role: 'user', content: 'test' }],
      stream: true,
    };

    const result = await forwardChat('text-low', config, req, 'tenant-test');
    assert.equal(result.ok, true);
    assert.equal(result.via?.id, 'fallback-ok');
    assert.equal(result.failoverCount, 1);
  });
});
