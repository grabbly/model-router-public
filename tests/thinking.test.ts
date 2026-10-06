import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveThinkingIntent, wantsReasoningShown } from '../src/core/thinking.js';
import { buildUpstreamBody } from '../src/core/forwarder.js';
import { ChatCompletionRequest, PoolEntry } from '../src/types.js';

const msgs = [{ role: 'user' as const, content: 'hi' }];
const b = (extra: Record<string, unknown>): ChatCompletionRequest => ({ model: 'text-low', messages: msgs, ...extra });
const intent = (extra: Record<string, unknown>) => resolveThinkingIntent(b(extra));

describe('resolveThinkingIntent — every dialect', () => {
  const cases: Array<[string, Record<string, unknown>, 'on' | 'off' | undefined]> = [
    ['nothing', {}, undefined],
    ['Anthropic enabled + budget', { thinking: { type: 'enabled', budget_tokens: 4000 } }, 'on'],
    ['MiniMax adaptive', { thinking: { type: 'adaptive' } }, 'on'],
    ['disabled', { thinking: { type: 'disabled' } }, 'off'],
    ['thinking: true', { thinking: true }, 'on'],
    ['thinking: false', { thinking: false }, 'off'],
    ['thinking: "on"', { thinking: 'on' }, 'on'],
    ['thinking: {budget_tokens: 0}', { thinking: { budget_tokens: 0 } }, 'off'],
    ['OpenAI reasoning_effort high', { reasoning_effort: 'high' }, 'on'],
    ['OpenAI reasoning_effort low', { reasoning_effort: 'low' }, 'on'],
    ['OpenAI reasoning_effort minimal', { reasoning_effort: 'minimal' }, 'off'],
    ['OpenAI reasoning_effort none', { reasoning_effort: 'none' }, 'off'],
    ['Responses reasoning.effort', { reasoning: { effort: 'medium' } }, 'on'],
    ['OpenRouter reasoning.enabled false', { reasoning: { enabled: false } }, 'off'],
    ['OpenRouter reasoning.max_tokens', { reasoning: { max_tokens: 2000 } }, 'on'],
    ['OpenRouter reasoning: {}', { reasoning: {} }, 'on'],
    ['Qwen enable_thinking false', { enable_thinking: false }, 'off'],
    ['vLLM chat_template_kwargs', { chat_template_kwargs: { enable_thinking: true } }, 'on'],
    ['Ollama think true', { think: true }, 'on'],
    ['Ollama think "high"', { think: 'high' }, 'on'],
    ['Gemini thinking_budget 0', { extra_body: { google: { thinking_config: { thinking_budget: 0 } } } }, 'off'],
    ['Gemini thinking_budget -1 (dynamic)', { extra_body: { google: { thinking_config: { thinking_budget: -1 } } } }, 'on'],
    ['OpenRouter include_reasoning', { include_reasoning: true }, 'on'],
    ['garbage', { thinking: { type: 'turbo' }, reasoning_effort: 'extreme' }, undefined],
    ['thinking wins over reasoning_effort', { thinking: { type: 'disabled' }, reasoning_effort: 'high' }, 'off'],
  ];
  for (const [name, extra, want] of cases) {
    it(name, () => assert.equal(intent(extra), want));
  }
});

describe('wantsReasoningShown', () => {
  it('include_reasoning / reasoning.exclude:false → show; default hidden', () => {
    assert.equal(wantsReasoningShown(b({ include_reasoning: true })), true);
    assert.equal(wantsReasoningShown(b({ reasoning: { exclude: false } })), true);
    assert.equal(wantsReasoningShown(b({ reasoning: { effort: 'high' } })), false);
    assert.equal(wantsReasoningShown(b({})), false);
  });
});

describe('buildUpstreamBody — dialects reach each backend in its own form', () => {
  const e = (params?: Record<string, unknown>): PoolEntry => ({ id: 'e', provider: 'custom', model: 'phys', baseUrl: 'http://x',
    priority: 1, enabled: true, tier: 'low', modality: 'text', censored: true, params });
  const minimax = () => e({ thinking: { type: 'disabled' }, reasoning_split: true });

  it('MiniMax: reasoning_effort high → thinking adaptive, reasoning_effort removed', () => {
    const out = buildUpstreamBody(minimax(), b({ reasoning_effort: 'high' }), msgs);
    assert.deepEqual(out.thinking, { type: 'adaptive' });
    assert.equal('reasoning_effort' in out, false);
  });
  it('MiniMax: Qwen/Ollama/Gemini dialects translated, alias fields removed', () => {
    for (const extra of [{ enable_thinking: true }, { think: 'high' }, { chat_template_kwargs: { enable_thinking: true } },
      { extra_body: { google: { thinking_config: { thinking_budget: 1024 } } } }]) {
      const out = buildUpstreamBody(minimax(), b(extra), msgs);
      assert.deepEqual(out.thinking, { type: 'adaptive' }, JSON.stringify(extra));
      for (const k of ['enable_thinking', 'think', 'chat_template_kwargs', 'extra_body']) assert.equal(k in out, false, k);
    }
  });
  it('MiniMax: explicit off beats tools', () => {
    const tools = [{ type: 'function', function: { name: 'f' } }];
    assert.deepEqual(buildUpstreamBody(minimax(), b({ tools, reasoning_effort: 'none' }), msgs).thinking, { type: 'disabled' });
  });
  it('non-MiniMax: alias fields stripped, reasoning_effort kept', () => {
    const out = buildUpstreamBody(e(), b({ thinking: { type: 'enabled' }, enable_thinking: true, think: true, reasoning: { effort: 'high' }, include_reasoning: true, reasoning_effort: 'high' }), msgs);
    for (const k of ['thinking', 'enable_thinking', 'think', 'reasoning', 'include_reasoning']) assert.equal(k in out, false, k);
    assert.equal(out.reasoning_effort, 'high');
  });
  it('ollama-cloud entry param still overrides reasoning_effort', () => {
    assert.equal(buildUpstreamBody(e({ reasoning_effort: 'none' }), b({ reasoning_effort: 'high' }), msgs).reasoning_effort, 'none');
  });
});
