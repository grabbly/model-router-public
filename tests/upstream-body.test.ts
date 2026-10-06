import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpstreamBody } from '../src/core/forwarder.js';
import { ChatCompletionRequest, PoolEntry } from '../src/types.js';

function entry(params?: Record<string, unknown>): PoolEntry {
  return {
    id: 'e', provider: 'custom', model: 'phys', baseUrl: 'http://x', priority: 1,
    enabled: true, tier: 'low', modality: 'text', censored: true, params,
  };
}
const minimax = () => entry({ thinking: { type: 'disabled' } });
const msgs = [{ role: 'user' as const, content: 'hi' }];
const tools = [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }];

describe('buildUpstreamBody — thinking on MiniMax entries', () => {
  it('keeps the entry default (thinking disabled) for plain text', () => {
    const out = buildUpstreamBody(minimax(), { model: 'text-low', messages: msgs }, msgs);
    assert.deepEqual(out.thinking, { type: 'disabled' });
    assert.equal(out.model, 'phys');
  });

  it('drops thinking: disabled when the request carries tools', () => {
    const body: ChatCompletionRequest = { model: 'text-low', messages: msgs, tools, tool_choice: 'required' };
    const out = buildUpstreamBody(minimax(), body, msgs);
    assert.equal('thinking' in out, false);
    assert.equal(out.tool_choice, 'required');
    assert.deepEqual(out.tools, tools);
  });

  it('empty tools array counts as no tools', () => {
    const out = buildUpstreamBody(minimax(), { model: 'text-low', messages: msgs, tools: [] }, msgs);
    assert.deepEqual(out.thinking, { type: 'disabled' });
  });

  it("honours the client's own thinking, with or without tools", () => {
    const on = { type: 'adaptive' };
    assert.deepEqual(buildUpstreamBody(minimax(), { model: 'm', messages: msgs, thinking: on }, msgs).thinking, on);
    const off = { type: 'disabled' };
    assert.deepEqual(buildUpstreamBody(minimax(), { model: 'm', messages: msgs, tools, thinking: off }, msgs).thinking, off);
  });

  it("keeps thinking disabled with tools when thinkingWithTools is 'off'", () => {
    const body: ChatCompletionRequest = { model: 'text-low', messages: msgs, tools };
    const out = buildUpstreamBody(minimax(), body, msgs, { thinkingWithTools: 'off' });
    assert.deepEqual(out.thinking, { type: 'disabled' });
  });

  it("drops thinking with tools when thinkingWithTools is 'model-default' or absent", () => {
    const body: ChatCompletionRequest = { model: 'text-low', messages: msgs, tools };
    const outDefault = buildUpstreamBody(minimax(), body, msgs, { thinkingWithTools: 'model-default' });
    assert.equal('thinking' in outDefault, false);
    const outAbsent = buildUpstreamBody(minimax(), body, msgs);
    assert.equal('thinking' in outAbsent, false);
  });

  it("honours explicit client intent when thinkingWithTools is 'off'", () => {
    const bodyOn: ChatCompletionRequest = { model: 'text-low', messages: msgs, tools, thinking: { type: 'adaptive' } };
    const outOn = buildUpstreamBody(minimax(), bodyOn, msgs, { thinkingWithTools: 'off' });
    assert.deepEqual(outOn.thinking, { type: 'adaptive' });

    const bodyOff: ChatCompletionRequest = { model: 'text-low', messages: msgs, tools, reasoning_effort: 'none' };
    const outOff = buildUpstreamBody(minimax(), bodyOff, msgs, { thinkingWithTools: 'off' });
    assert.deepEqual(outOff.thinking, { type: 'disabled' });
  });

  it("honours explicit client intent when thinkingWithTools is absent or 'model-default'", () => {
    const bodyOn: ChatCompletionRequest = { model: 'text-low', messages: msgs, tools, thinking: { type: 'adaptive' } };
    const outOn = buildUpstreamBody(minimax(), bodyOn, msgs, { thinkingWithTools: 'model-default' });
    assert.deepEqual(outOn.thinking, { type: 'adaptive' });

    const bodyOff: ChatCompletionRequest = { model: 'text-low', messages: msgs, tools, reasoning_effort: 'none' };
    const outOff = buildUpstreamBody(minimax(), bodyOff, msgs, { thinkingWithTools: 'model-default' });
    assert.deepEqual(outOff.thinking, { type: 'disabled' });
  });

  it('never forwards a client thinking field to entries without one', () => {
    const out = buildUpstreamBody(entry({ reasoning_effort: 'none' }), { model: 'm', messages: msgs, thinking: { type: 'enabled' }, tools }, msgs);
    assert.equal('thinking' in out, false);
    assert.equal(out.reasoning_effort, 'none');
  });

  it('other entry params still override the body; tool_choice object passes through', () => {
    const fc = { type: 'function', function: { name: 'search' } };
    const out = buildUpstreamBody(entry({ reasoning_effort: 'none' }), { model: 'm', messages: msgs, reasoning_effort: 'high', tools, tool_choice: fc }, msgs);
    assert.equal(out.reasoning_effort, 'none');
    assert.deepEqual(out.tool_choice, fc);
  });

  it('asks for usage on streams', () => {
    const out = buildUpstreamBody(minimax(), { model: 'm', messages: msgs, stream: true }, msgs);
    assert.deepEqual(out.stream_options, { include_usage: true });
  });

  describe('entries with reasoningEfforts (MiniMax-M3.1-Flash-Preview)', () => {
    const m31Entry: PoolEntry = {
      id: 'minimax-m31-flash-think',
      provider: 'custom',
      model: 'MiniMax-M3.1-Flash-Preview',
      baseUrl: 'http://minimax',
      priority: 1,
      enabled: true,
      tier: 'high',
      modality: 'text',
      censored: true,
      budgetGroup: 'minimax',
      params: { reasoning_split: true, reasoning_effort: 'medium' },
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    };

    it('has reasoning_effort medium by default', () => {
      const out = buildUpstreamBody(m31Entry, { model: 'text-high-think', messages: msgs }, msgs);
      assert.equal(out.reasoning_effort, 'medium');
      assert.equal('thinking' in out, false);
    });

    it('client reasoning_effort high wins', () => {
      const out = buildUpstreamBody(
        m31Entry,
        { model: 'text-high-think', messages: msgs, reasoning_effort: 'high' },
        msgs
      );
      assert.equal(out.reasoning_effort, 'high');
      assert.equal('thinking' in out, false);
    });

    it('client reasoning.effort xhigh wins', () => {
      const out = buildUpstreamBody(
        m31Entry,
        { model: 'text-high-think', messages: msgs, reasoning: { effort: 'xhigh' } } as any,
        msgs
      );
      assert.equal(out.reasoning_effort, 'xhigh');
      assert.equal('thinking' in out, false);
    });

    it('client reasoning_effort none is ignored and falls back to entry default medium', () => {
      const out = buildUpstreamBody(
        m31Entry,
        { model: 'text-high-think', messages: msgs, reasoning_effort: 'none' },
        msgs
      );
      assert.equal(out.reasoning_effort, 'medium');
      assert.equal('thinking' in out, false);
    });

    it('no thinking key even if client sent thinking adaptive or disabled', () => {
      const outAdaptive = buildUpstreamBody(
        m31Entry,
        { model: 'text-high-think', messages: msgs, thinking: { type: 'adaptive' } } as any,
        msgs
      );
      assert.equal('thinking' in outAdaptive, false);
      assert.equal(outAdaptive.reasoning_effort, 'medium');

      const outDisabled = buildUpstreamBody(
        m31Entry,
        { model: 'text-high-think', messages: msgs, thinking: { type: 'disabled' } } as any,
        msgs
      );
      assert.equal('thinking' in outDisabled, false);
      assert.equal(outDisabled.reasoning_effort, 'medium');
    });

    it('fallback MiniMax-M3 entry still gets thinking as before', () => {
      const fallbackEntry: PoolEntry = {
        id: 'minimax-m3-direct-text-high-think',
        provider: 'custom',
        model: 'MiniMax-M3',
        baseUrl: 'http://minimax',
        priority: 2,
        enabled: true,
        tier: 'high',
        modality: 'text',
        censored: true,
        budgetGroup: 'minimax',
        params: { thinking: { type: 'disabled' }, reasoning_split: true },
      };
      const out = buildUpstreamBody(fallbackEntry, { model: 'text-high-think', messages: msgs }, msgs);
      assert.deepEqual(out.thinking, { type: 'disabled' });
      assert.equal(out.reasoning_split, true);
    });
  });
});
