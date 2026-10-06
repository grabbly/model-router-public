import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maskStream } from '../src/core/stream-masker.js';

// A pull() that enqueues nothing is never called again (WHATWG streams only
// re-pull when asked during the pull) — the stream then hangs forever. That
// happens whenever an upstream chunk holds no complete line (MiniMax splits
// SSE frames mid-line) or only lines we drop (comments, usage-only frames).
function upstreamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]));
      else c.close();
    },
  });
}

async function readAll(s: ReadableStream<Uint8Array>, ms = 2000): Promise<string> {
  const dec = new TextDecoder();
  const r = s.getReader();
  let out = '';
  const deadline = Date.now() + ms;
  for (;;) {
    const res = await Promise.race([
      r.read(),
      new Promise<'timeout'>((ok) => setTimeout(() => ok('timeout'), Math.max(1, deadline - Date.now()))),
    ]);
    if (res === 'timeout') throw new Error('stream stalled; got so far: ' + JSON.stringify(out));
    if (res.done) return out;
    out += dec.decode(res.value, { stream: true });
  }
}

describe('maskStream never stalls', () => {
  it('frame split mid-line across chunks', async () => {
    const f = 'data: {"id":"x","choices":[{"delta":{"content":"привет"}}]}\n\n';
    const out = await readAll(maskStream(upstreamOf([f.slice(0, 7), f.slice(7, 30), f.slice(30), 'data: [DONE]\n\n']), 'text-uncensored-high'));
    assert.match(out, /привет/);
    assert.match(out, /\[DONE\]/);
  });

  it('chunk with only dropped lines (comment / usage-only)', async () => {
    const out = await readAll(maskStream(upstreamOf([
      ': keep-alive\n',
      'data: {"choices":[],"usage":{"prompt_tokens":1}}\n',
      'data: {"id":"y","choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: [DONE]\n\n',
    ]), 'text-low', { stripUsageOnlyChunks: true }));
    assert.match(out, /"ok"/);
  });
});
