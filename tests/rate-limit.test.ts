import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ChatCompletionRequest, LogicalModelConfig } from '../src/types.js';
import { forwardChat } from '../src/core/forwarder.js';
import { isCoolingDown, rateLimitCooldownSec, resetCooldowns } from '../src/core/cooldown.js';
import { getProbeMetrics, probeEntry, setProbeMetrics } from '../src/core/prober.js';
import { resetPreselections } from '../src/core/selector.js';

describe('rateLimitCooldownSec', () => {
  it('defaults to 10 s, honours Retry-After seconds, clamps to 3–30', () => {
    assert.equal(rateLimitCooldownSec(null), 10);
    assert.equal(rateLimitCooldownSec('7'), 7);
    assert.equal(rateLimitCooldownSec('1'), 3);
    assert.equal(rateLimitCooldownSec('600'), 30);
    const now = Date.parse('2026-09-25T00:00:00Z');
    assert.equal(rateLimitCooldownSec('Fri, 25 Sep 2026 00:00:20 GMT', now), 20);
    assert.equal(rateLimitCooldownSec('garbage'), 10);
  });
});

describe('429 does not knock a backend out', () => {
  let server: http.Server;
  let port: number;
  before(async () => {
    server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const model = JSON.parse(b || '{}').model;
        if (model === 'limited') { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end('{"error":"Token Plan rate limit reached"}'); return; }
        if (model === 'down') { res.writeHead(503); res.end('{}'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'ok', object: 'chat.completion', created: 1, model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'fine' } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  after(() => server.close());
  beforeEach(() => { resetCooldowns(); resetPreselections(); });

  const entry = (id: string, model: string, priority: number) => ({ id, provider: 'custom' as const, model, baseUrl: `http://127.0.0.1:${port}`,
    priority, enabled: true, tier: 'low' as const, modality: 'text' as const, censored: true });
  const cfg = (first: string): LogicalModelConfig => ({ id: 'text-low', description: 't', modality: 'text', tier: 'low', censored: true,
    timeoutMs: 1000, cooldownSec: 120, pool: [entry('e1', first, 1), entry('e2', 'good', 2)] });
  const req: ChatCompletionRequest = { model: 'text-low', messages: [{ role: 'user', content: 'x' }] };

  it('429 → fails over; short cooldown (≤30 s), not the tier 120 s', async () => {
    const r = await forwardChat('text-low', cfg('limited'), req);
    assert.equal(r.ok, true);
    assert.equal(r.via?.id, 'e2');
    const c = isCoolingDown('text-low', 'e1');
    assert.equal(c.cooling, true);
    assert.ok(c.remainingSec <= 30, `remaining ${c.remainingSec}`);
  });

  it('503 still gets the full tier cooldown', async () => {
    await forwardChat('text-low', cfg('down'), req);
    assert.ok(isCoolingDown('text-low', 'e1').remainingSec > 60);
  });

  it('probe that gets 429 keeps the entry healthy', async () => {
    const m = await probeEntry(entry('p429', 'limited', 1));
    assert.equal(m.healthy, true);
    assert.match(m.lastError || '', /429/);
  });

  it('a successful real request clears a stale unhealthy probe verdict', async () => {
    setProbeMetrics('e2', { entryId: 'e2', lastChecked: 0, healthy: false, ttfbMs: 0, totalMs: 0, throughputTokensSec: 0,
      consecutiveSuccesses: 0, consecutiveFailures: 3, lastError: 'old' });
    const r = await forwardChat('text-low', { ...cfg('good'), pool: [entry('e2', 'good', 1)] }, req);
    assert.equal(r.ok, true);
    assert.equal(getProbeMetrics('e2')?.healthy, true);
  });
});
