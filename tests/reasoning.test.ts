import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ChatCompletionRequest, LogicalModelConfig, PoolEntry } from '../src/types.js';
import { buildUpstreamBody, forwardChat } from '../src/core/forwarder.js';
import { isCoolingDown, resetCooldowns } from '../src/core/cooldown.js';
import { resetPreselections } from '../src/core/selector.js';
import { maskCompletion } from '../src/core/stream-masker.js';

const THINK_MSG = {
  id: 'x', object: 'chat.completion', created: 1, model: 'phys',
  choices: [{ index: 0, finish_reason: 'stop', message: {
    role: 'assistant', content: '<think>secret plan</think>\n\n391',
    reasoning_content: 'secret plan', reasoning_details: [{ type: 'reasoning.text', text: 'secret plan' }],
  } }],
};

describe('Reasoning is stripped from answers', () => {
  it('removes reasoning fields and inline <think> from a JSON message', () => {
    const out = maskCompletion(THINK_MSG, 'text-low') as any;
    const m = out.choices[0].message;
    assert.equal(m.content, '391');
    assert.equal('reasoning_content' in m, false);
    assert.equal('reasoning_details' in m, false);
  });

  it('removes reasoning fields from a stream delta', () => {
    const out = maskCompletion({ choices: [{ index: 0, delta: { reasoning_content: 'hmm', content: 'ok' } }] }, 'text-low') as any;
    assert.deepEqual(out.choices[0].delta, { content: 'ok' });
  });

  it('keeps everything with keepReasoning (x-router-reasoning: 1)', () => {
    const out = maskCompletion(THINK_MSG, 'text-low', { keepReasoning: true }) as any;
    assert.equal(out.choices[0].message.reasoning_content, 'secret plan');
    assert.ok(out.choices[0].message.content.includes('<think>'));
  });

  it('does not touch tool_calls', () => {
    const tc = [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }];
    const out = maskCompletion({ choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: tc, reasoning_content: 'r' } }] }, 'm') as any;
    assert.deepEqual(out.choices[0].message.tool_calls, tc);
    assert.equal(out.choices[0].message.content, null);
  });
});

describe('Client thinking is normalised for MiniMax', () => {
  const minimax: PoolEntry = { id: 'mm', provider: 'custom', model: 'MiniMax-M3', baseUrl: 'http://x', priority: 1,
    enabled: true, tier: 'low', modality: 'text', censored: true, params: { thinking: { type: 'disabled' }, reasoning_split: true } };
  const msgs = [{ role: 'user' as const, content: 'hi' }];
  const body = (thinking: unknown): ChatCompletionRequest => ({ model: 'text-low', messages: msgs, thinking });

  it("maps 'enabled' to 'adaptive' (M3 rejects 'enabled')", () => {
    assert.deepEqual(buildUpstreamBody(minimax, body({ type: 'enabled' }), msgs).thinking, { type: 'adaptive' });
  });
  it("passes 'adaptive' and 'disabled'", () => {
    assert.deepEqual(buildUpstreamBody(minimax, body({ type: 'adaptive' }), msgs).thinking, { type: 'adaptive' });
    assert.deepEqual(buildUpstreamBody(minimax, body({ type: 'disabled' }), msgs).thinking, { type: 'disabled' });
  });
  it('ignores unknown values and keeps the entry default', () => {
    assert.deepEqual(buildUpstreamBody(minimax, body({ type: 'turbo' }), msgs).thinking, { type: 'disabled' });
    assert.deepEqual(buildUpstreamBody(minimax, body('banana'), msgs).thinking, { type: 'disabled' });
  });
  it('keeps reasoning_split from the entry', () => {
    assert.equal(buildUpstreamBody(minimax, body(undefined), msgs).reasoning_split, true);
  });
});

describe('Request-specific 4xx fails over without cooling the backend down', () => {
  let server: http.Server;
  let port: number;
  before(async () => {
    server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const model = JSON.parse(b || '{}').model;
        if (model === 'bad-400') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"invalid thinking.type"}'); return; }
        if (model === 'down-503') { res.writeHead(503); res.end('{}'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'ok', object: 'chat.completion', created: 1, model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'fine' } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  after(() => server.close());
  beforeEach(() => { resetCooldowns(); resetPreselections(); });

  const cfg = (first: string): LogicalModelConfig => ({
    id: 'text-low', description: 't', modality: 'text', tier: 'low', censored: true, timeoutMs: 1000, cooldownSec: 60,
    pool: [first, 'good'].map((model, i) => ({ id: `e-${model}`, provider: 'custom' as const, model, baseUrl: `http://127.0.0.1:${port}`,
      priority: i + 1, enabled: true, tier: 'low' as const, modality: 'text' as const, censored: true })),
  });
  const req: ChatCompletionRequest = { model: 'text-low', messages: [{ role: 'user', content: 'x' }] };

  it('400 → fails over, entry NOT in cooldown', async () => {
    const r = await forwardChat('text-low', cfg('bad-400'), req);
    assert.equal(r.ok, true);
    assert.equal(r.via?.model, 'good');
    assert.equal(isCoolingDown('text-low', 'e-bad-400').cooling, false);
  });
  it('503 → fails over, entry IS in cooldown (unchanged)', async () => {
    const r = await forwardChat('text-low', cfg('down-503'), req);
    assert.equal(r.ok, true);
    assert.equal(isCoolingDown('text-low', 'e-down-503').cooling, true);
  });
});
