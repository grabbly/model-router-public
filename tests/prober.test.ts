import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PoolEntry } from '../src/types.js';
import { probeEntry, getProbeMetrics } from '../src/core/prober.js';
import { resetCooldowns } from '../src/core/cooldown.js';

describe('Proactive Prober Engine', () => {
  let mockServer: http.Server;
  let serverPort: number;

  before(async () => {
    mockServer = http.createServer((req, res) => {
      if (req.url === '/chat/completions') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body);
          if (parsed.model === 'failing-model') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal error' }));
            return;
          }
          if (parsed.model === 'slow-model') {
            setTimeout(() => {
              res.writeHead(200, { 'Content-Type': 'text/event-stream' });
              res.write('data: {"choices":[{"delta":{"content":"pong"}}]}\n\n');
              res.end('data: [DONE]\n\n');
            }, 100);
            return;
          }
          // Default fast response
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"pong"}}]}\n\n');
          res.end('data: [DONE]\n\n');
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
  });

  it('measures TTFB and health on successful probe', async () => {
    const entry: PoolEntry = {
      id: 'mock-fast',
      provider: 'custom',
      model: 'fast-model',
      baseUrl: `http://127.0.0.1:${serverPort}`,
      priority: 1,
      enabled: true,
      tier: 'low',
      modality: 'text',
      censored: true,
    };

    const metrics = await probeEntry(entry, 2000);
    assert.equal(metrics.healthy, true);
    assert.ok(metrics.ttfbMs >= 0);
    assert.equal(metrics.consecutiveSuccesses, 1);
    assert.equal(metrics.consecutiveFailures, 0);

    const stored = getProbeMetrics('mock-fast');
    assert.equal(stored?.healthy, true);
  });

  it('records failure and error message on probe error', async () => {
    const entry: PoolEntry = {
      id: 'mock-failing',
      provider: 'custom',
      model: 'failing-model',
      baseUrl: `http://127.0.0.1:${serverPort}`,
      priority: 1,
      enabled: true,
      tier: 'low',
      modality: 'text',
      censored: true,
    };

    const metrics = await probeEntry(entry, 2000);
    assert.equal(metrics.healthy, false);
    assert.equal(metrics.consecutiveFailures, 1);
    assert.ok(metrics.lastError?.includes('500'));
  });

  it('handles probe timeout gracefully without crashing', async () => {
    const entry: PoolEntry = {
      id: 'mock-slow',
      provider: 'custom',
      model: 'slow-model',
      baseUrl: `http://127.0.0.1:${serverPort}`,
      priority: 1,
      enabled: true,
      tier: 'low',
      modality: 'text',
      censored: true,
    };

    // Set probe timeout to 20ms while server delays 100ms
    const metrics = await probeEntry(entry, 20);
    assert.equal(metrics.healthy, false);
    assert.ok(metrics.lastError?.includes('timeout') || metrics.lastError?.includes('aborted'));
  });
});
