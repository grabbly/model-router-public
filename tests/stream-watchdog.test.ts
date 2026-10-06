import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maskCompletion, maskStream, createWatchdog } from '../src/core/stream-masker.js';

describe('Stream Masking & Watchdog', () => {
  it('masks completion payloads and replaces model name with logical tier', () => {
    const raw = {
      id: 'chatcmpl-internal-upstream-1234567890',
      object: 'chat.completion',
      created: 1700000000,
      model: 'deepseek-v4-flash:0731',
      system_fingerprint: 'fp_ollama_internal',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello from router' },
          finish_reason: 'stop',
        },
      ],
    };

    const masked = maskCompletion(raw, 'text-low');
    assert.equal(masked.model, 'text-low');
    assert.equal(masked.system_fingerprint, undefined);
    assert.ok(typeof masked.id === 'string' && masked.id.startsWith('pfc-'));
  });

  it('triggers watchdog when first chunk does not arrive within initial deadline', async () => {
    let timedOutReason: string | null = null;
    const watchdog = createWatchdog(
      (reason) => {
        timedOutReason = reason;
      },
      50, // 50ms initial timeout
      100 // 100ms idle timeout
    );

    // Do NOT poke watchdog
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(timedOutReason !== null);
    assert.match(timedOutReason, /No initial stream chunk/i);
    watchdog.stop();
  });

  it('resets watchdog when chunks arrive within deadline', async () => {
    let timedOutReason: string | null = null;
    const watchdog = createWatchdog(
      (reason) => {
        timedOutReason = reason;
      },
      80,
      80
    );

    // Poke within deadline
    await new Promise((resolve) => setTimeout(resolve, 40));
    watchdog.poke();
    await new Promise((resolve) => setTimeout(resolve, 40));
    watchdog.poke();

    assert.equal(timedOutReason, null);
    watchdog.stop();
  });

  it('streams chunks through maskStream and updates model in SSE events', async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const sampleSSE = [
      'data: {"id":"chat-1","choices":[{"delta":{"role":"assistant","content":"Hi"}}]}\n\n',
      'data: {"id":"chat-1","choices":[{"delta":{"content":" there!"}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const upstreamStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const item of sampleSSE) {
          controller.enqueue(encoder.encode(item));
        }
        controller.close();
      },
    });

    const maskedStream = maskStream(upstreamStream, 'text-high');
    const reader = maskedStream.getReader();

    let output = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value);
    }

    assert.ok(output.includes('"model":"text-high"'));
    assert.ok(output.includes('Hi'));
    assert.ok(output.includes('there!'));
    assert.ok(output.includes('data: [DONE]'));
  });

  it('captures upstream usage and strips usage-only chunks the client did not ask for', async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const sampleSSE = [
      'data: {"id":"c","choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"id":"c","choices":[],"usage":{"prompt_tokens":42,"completion_tokens":7}}\n\n',
      'data: [DONE]\n\n',
    ];
    const run = async (strip: boolean) => {
      const upstream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const item of sampleSSE) controller.enqueue(encoder.encode(item));
          controller.close();
        },
      });
      let usage: Record<string, unknown> | undefined;
      const reader = maskStream(upstream, 'text-high', {
        onUsage: (u) => {
          usage = u;
        },
        stripUsageOnlyChunks: strip,
      }).getReader();
      let output = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value);
      }
      return { output, usage };
    };

    const stripped = await run(true);
    assert.equal(stripped.usage?.prompt_tokens, 42);
    assert.ok(!stripped.output.includes('prompt_tokens'));
    assert.ok(stripped.output.includes('Hi'));
    assert.ok(stripped.output.includes('data: [DONE]'));

    const kept = await run(false);
    assert.equal(kept.usage?.completion_tokens, 7);
    assert.ok(kept.output.includes('"prompt_tokens":42'));
  });
});
