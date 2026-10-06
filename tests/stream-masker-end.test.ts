import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { maskStream, setStreamMaskerClock } from '../src/core/stream-masker.js';

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

function erroringUpstream(chunks: string[], err: Error): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) {
        c.enqueue(enc.encode(chunks[i++]));
      } else {
        c.error(err);
      }
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

describe('Stream End & Empty Frames (src/core/stream-masker.ts)', () => {
  beforeEach(() => {
    setStreamMaskerClock(null);
  });

  it('idle timeout mid-stream → error frame + [DONE]', async () => {
    let capturedCode = '';
    let capturedMsg = '';
    const upstream = erroringUpstream(
      ['data: {"id":"1","choices":[{"delta":{"content":"start"}}\n\n'],
      new Error('Stream idle timeout: no data for 15s')
    );

    const stream = maskStream(upstream, 'text-low', {
      onError: (code, msg) => {
        capturedCode = code;
        capturedMsg = msg;
      },
    });

    const out = await readAll(stream);
    assert.match(out, /"content":"start"/);
    assert.match(out, /"code":"upstream_stream_error"/);
    assert.match(out, /Stream idle timeout: no data for 15s/);
    assert.ok(out.endsWith('data: [DONE]\n\n'));
    assert.equal(capturedCode, 'upstream_stream_error');
    assert.match(capturedMsg, /Stream idle timeout/);
  });

  it('upstream close without finish_reason → incomplete frame + [DONE]', async () => {
    let capturedCode = '';
    const upstream = upstreamOf([
      'data: {"id":"1","choices":[{"delta":{"content":"halfway"},"finish_reason":null}]}\n\n',
    ]);

    const stream = maskStream(upstream, 'text-low', {
      onError: (code) => {
        capturedCode = code;
      },
    });

    const out = await readAll(stream);
    assert.match(out, /"content":"halfway"/);
    assert.match(out, /"code":"upstream_stream_incomplete"/);
    assert.ok(out.endsWith('data: [DONE]\n\n'));
    assert.equal(capturedCode, 'upstream_stream_incomplete');
  });

  it('upstream close with [DONE] but no finish_reason → treated as a proper end', async () => {
    let capturedCode = '';
    const upstream = upstreamOf([
      'data: {"id":"1","choices":[{"delta":{"content":"almost"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const stream = maskStream(upstream, 'text-low', {
      onError: (code) => {
        capturedCode = code;
      },
    });

    const out = await readAll(stream);
    assert.match(out, /"content":"almost"/);
    assert.doesNotMatch(out, /upstream_stream_incomplete/);
    const doneCount = (out.match(/\[DONE\]/g) || []).length;
    assert.equal(doneCount, 1, 'Must not duplicate [DONE]');
    assert.equal(capturedCode, '');
  });

  it('normal stream unchanged (no error frame, exact chunks)', async () => {
    let errorCalled = false;
    const upstream = upstreamOf([
      'data: {"id":"1","choices":[{"delta":{"content":"all good"},"finish_reason":null}]}\n\n',
      'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const stream = maskStream(upstream, 'text-low', {
      onError: () => {
        errorCalled = true;
      },
    });

    const out = await readAll(stream);
    assert.match(out, /"content":"all good"/);
    assert.match(out, /"finish_reason":"stop"/);
    assert.match(out, /data: \[DONE\]\n*$/);
    assert.doesNotMatch(out, /"error"/);
    assert.equal(errorCalled, false);
  });

  it('50 reasoning-only frames within 100 ms → client gets 1 empty frame', async () => {
    let time = 10_000;
    setStreamMaskerClock(() => time);

    let pokedCount = 0;
    const mockWatchdog = {
      poke: () => {
        pokedCount++;
      },
      stop: () => {},
    };

    // 50 frames with only role and reasoning_content (which gets stripped)
    const frames: string[] = [];
    for (let i = 0; i < 50; i++) {
      frames.push(
        `data: {"id":"chk-${i}","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"step ${i}"},"finish_reason":null}]}\n\n`
      );
    }
    frames.push('data: {"id":"chk-end","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    frames.push('data: [DONE]\n\n');

    const enc = new TextEncoder();
    let idx = 0;
    const upstream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (idx < frames.length) {
          if (idx < 50) time += 2; // ~2ms per frame, 100ms total
          c.enqueue(enc.encode(frames[idx++]));
        } else {
          c.close();
        }
      },
    });

    const stream = maskStream(upstream, 'text-low', {
      keepReasoning: false,
      watchdog: mockWatchdog,
      emptyFrameMinIntervalMs: 1000,
    });

    const out = await readAll(stream);

    // Watchdog was poked for all model frames (50 reasoning + 1 stop)
    assert.ok(pokedCount >= 51, `Watchdog should be poked for every frame (got ${pokedCount})`);

    // Parse all SSE JSON frames received by client
    const clientFrames = out
      .split('\n\n')
      .filter((line) => line.startsWith('data:') && !line.includes('[DONE]'))
      .map((line) => JSON.parse(line.slice(5).trim()));

    // The first frame was forwarded as an empty/role frame; remaining 49 were dropped
    const roleOnlyFrames = clientFrames.filter(
      (f) =>
        f.choices &&
        f.choices[0]?.delta?.role === 'assistant' &&
        f.choices[0]?.delta?.content === undefined &&
        f.choices[0]?.finish_reason === null
    );

    assert.equal(roleOnlyFrames.length, 1, 'Client should receive exactly 1 empty frame');
    assert.equal(clientFrames.length, 2, 'Total frames should be 1 empty frame + 1 stop frame');
  });

  it('content frames are never dropped even if arriving rapidly', async () => {
    let time = 20_000;
    setStreamMaskerClock(() => time);

    const frames: string[] = [];
    for (let i = 0; i < 10; i++) {
      frames.push(
        `data: {"id":"chk-${i}","choices":[{"index":0,"delta":{"content":"word ${i}"},"finish_reason":null}]}\n\n`
      );
    }
    frames.push('data: {"id":"chk-end","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    frames.push('data: [DONE]\n\n');

    const enc = new TextEncoder();
    let idx = 0;
    const upstream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (idx < frames.length) {
          time += 1; // 1ms per frame
          c.enqueue(enc.encode(frames[idx++]));
        } else {
          c.close();
        }
      },
    });

    const stream = maskStream(upstream, 'text-low', {
      emptyFrameMinIntervalMs: 1000,
    });

    const out = await readAll(stream);
    for (let i = 0; i < 10; i++) {
      assert.match(out, new RegExp(`word ${i}`));
    }
  });
});
