import { CONFIG } from '../config.js';
import { recordFailure } from './cooldown.js';
import { PoolEntry } from '../types.js';

export interface Watchdog {
  poke: () => void;
  stop: () => void;
}

export function createWatchdog(
  onTimeout: (reason: string) => void,
  firstChunkTimeoutMs: number = CONFIG.ttfbTimeoutMs,
  idleTimeoutMs: number = CONFIG.streamIdleTimeoutMs
): Watchdog {
  let timer: NodeJS.Timeout | undefined;
  let receivedFirstChunk = false;

  const arm = (ms: number, isInitial: boolean) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const msg = isInitial
        ? `No initial stream chunk received within ${Math.round(ms / 1000)}s`
        : `Stream idle timeout: no data for ${Math.round(ms / 1000)}s`;
      onTimeout(msg);
    }, ms);
    timer.unref();
  };

  // Start with first chunk timeout
  arm(firstChunkTimeoutMs, true);

  return {
    poke: () => {
      receivedFirstChunk = true;
      arm(idleTimeoutMs, false);
    },
    stop: () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

// Reasoning fields providers attach to a message/delta. With reasoning_split
// MiniMax puts its thinking here instead of inline <think> tags in content.
// Clients get plain OpenAI output unless they opt in (x-router-reasoning: 1).
const REASONING_KEYS = ['reasoning_content', 'reasoning_details', 'reasoning'];
const INLINE_THINK = /<think>[\s\S]*?<\/think>\s*/g;

function stripReasoning(choices: unknown): unknown {
  if (!Array.isArray(choices)) return choices;
  return choices.map((c) => {
    if (!c || typeof c !== 'object') return c;
    const choice = { ...(c as Record<string, unknown>) };
    for (const field of ['message', 'delta']) {
      const m = choice[field];
      if (!m || typeof m !== 'object') continue;
      const msg = { ...(m as Record<string, unknown>) };
      for (const k of REASONING_KEYS) delete msg[k];
      // Safety net for a complete message that still carries inline tags.
      if (field === 'message' && typeof msg.content === 'string' && msg.content.includes('<think>')) {
        msg.content = msg.content.replace(INLINE_THINK, '');
      }
      choice[field] = msg;
    }
    return choice;
  });
}

export function maskCompletion(
  payload: unknown,
  logicalModel: string,
  options?: { keepReasoning?: boolean }
): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') {
    return { model: logicalModel };
  }
  const out = { ...(payload as Record<string, unknown>) };
  out.model = logicalModel;
  if (!options?.keepReasoning && 'choices' in out) {
    out.choices = stripReasoning(out.choices);
  }
  delete out.system_fingerprint;
  if (typeof out.id === 'string') {
    out.id = out.id.startsWith('pfc-') ? out.id : `pfc-${out.id.slice(-12)}`;
  }
  return out;
}

let clockFn: (() => number) | null = null;

export function setStreamMaskerClock(fn: (() => number) | null): void {
  clockFn = fn;
}

function getNow(): number {
  return clockFn ? clockFn() : Date.now();
}

function isEmptyFrame(masked: Record<string, unknown>): boolean {
  if (masked.usage != null) return false;
  if (!Array.isArray(masked.choices) || masked.choices.length === 0) return false;
  for (const choice of masked.choices) {
    if (!choice || typeof choice !== 'object') continue;
    if (choice.finish_reason != null) return false;
    const delta = choice.delta ?? choice.message;
    if (delta && typeof delta === 'object') {
      if (delta.content != null && delta.content !== '') return false;
      if (delta.tool_calls != null && (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 0)) return false;
      for (const k of REASONING_KEYS) {
        if (delta[k] != null && delta[k] !== '') return false;
      }
    }
  }
  return true;
}

export interface MaskStreamOptions {
  route?: string;
  via?: PoolEntry;
  cooldownSec?: number;
  watchdog?: Watchdog;
  onDone?: () => void;
  /** Called with the upstream `usage` object when a chunk carries one. */
  onUsage?: (usage: Record<string, unknown>) => void;
  /** Drop usage-only chunks (`choices: []`) the client did not ask for. */
  stripUsageOnlyChunks?: boolean;
  /** Pass reasoning fields through (default: stripped). */
  keepReasoning?: boolean;
  /** Callback for stream errors/incomplete ends to log request-log errorCode. */
  onError?: (code: string, message: string) => void;
  /** Minimum interval in ms between forwarded empty/role-only frames (default 1000). */
  emptyFrameMinIntervalMs?: number;
}

export function maskStream(
  upstream: ReadableStream<Uint8Array>,
  logicalModel: string,
  options?: MaskStreamOptions
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = upstream.getReader();
  let buffer = '';
  let finished = false;
  let cancelled = false;
  let sent = 0;   // chunks handed to the client — see pull()
  let hasSeenFinishReason = false;
  let hasSeenDone = false;
  let lastEmptyFrameTime = -Infinity;

  const done = () => {
    if (finished) return;
    finished = true;
    options?.watchdog?.stop();
    options?.onDone?.();
  };

  const emit = (out: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array) => {
    sent++;
    out.enqueue(chunk);
  };

  const handleLine = (line: string, out: ReadableStreamDefaultController<Uint8Array>) => {
    if (line.trim() === '') {
      emit(out, encoder.encode('\n'));
      return;
    }
    if (!line.startsWith('data:')) {
      return;
    }
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      hasSeenDone = true;
      emit(out, encoder.encode('data: [DONE]\n\n'));
      return;
    }

    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === 'object' && parsed.usage && typeof parsed.usage === 'object') {
        options?.onUsage?.(parsed.usage);
        if (
          options?.stripUsageOnlyChunks &&
          Array.isArray(parsed.choices) &&
          parsed.choices.length === 0
        ) {
          options?.watchdog?.poke();
          return;
        }
      }
      if (Array.isArray(parsed?.choices)) {
        for (const choice of parsed.choices) {
          if (choice && typeof choice === 'object' && choice.finish_reason != null) {
            hasSeenFinishReason = true;
          }
        }
      }
      const masked = maskCompletion(parsed, logicalModel, { keepReasoning: options?.keepReasoning });
      // A real model frame — not a keep-alive or blank separator. Only this
      // resets the idle deadline; a stream that sends nothing but keep-alives
      // after the first byte must still time out.
      options?.watchdog?.poke();

      if (isEmptyFrame(masked)) {
        const now = getNow();
        const minInterval = options?.emptyFrameMinIntervalMs ?? 1000;
        if (now - lastEmptyFrameTime >= minInterval) {
          lastEmptyFrameTime = now;
          emit(out, encoder.encode(`data: ${JSON.stringify(masked)}\n\n`));
        }
        // Dropped empty frames still poked watchdog above!
      } else {
        emit(out, encoder.encode(`data: ${JSON.stringify(masked)}\n\n`));
      }
    } catch {
      // Pass-through raw if unparseable
      emit(out, encoder.encode(`${line}\n`));
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // Keep reading until this pull has handed the client at least one
        // chunk (or the upstream ended). A pull that enqueues nothing is never
        // called again — the stream just hangs. That is what happened to every
        // MiniMax-direct stream: its chunks often end mid-line, so a read could
        // yield no complete line, and the client got headers and then silence.
        const before = sent;
        for (;;) {
          const { done: end, value } = await reader.read();

          if (end) {
            buffer += decoder.decode();
            if (buffer.length > 0) {
              handleLine(buffer, controller);
            }
            // A stream cut off before [DONE] and before any finish_reason would
            // look like an empty answer to the client — say so explicitly.
            // [DONE] alone counts as a proper end (some backends omit finish_reason).
            if (!hasSeenFinishReason && !hasSeenDone) {
              const reason = 'Upstream stream closed without finish_reason or [DONE]';
              options?.onError?.('upstream_stream_incomplete', reason);
              const errPayload = JSON.stringify({
                error: {
                  message: reason,
                  type: 'api_error',
                  code: 'upstream_stream_incomplete',
                },
              });
              emit(controller, encoder.encode(`data: ${errPayload}\n\n`));
              emit(controller, encoder.encode('data: [DONE]\n\n'));
            }
            done();
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            handleLine(line, controller);
          }
          if (sent !== before) return;   // something went out
        }
      } catch (e) {
        done();
        const message = e instanceof Error ? e.message : String(e);
        if (cancelled || /closed controller|Controller is already closed/i.test(message)) {
          return;
        }
        if (options?.route && options?.via) {
          recordFailure(
            options.route,
            options.via.id,
            options.cooldownSec || 120,
            `Stream error: ${message}`
          );
        }
        options?.onError?.('upstream_stream_error', message);
        try {
          const errPayload = JSON.stringify({
            error: {
              message,
              type: 'api_error',
              code: 'upstream_stream_error',
            },
          });
          emit(controller, encoder.encode(`data: ${errPayload}\n\n`));
          emit(controller, encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch {
          // Controller might already be closed
        }
      }
    },
    cancel(reason) {
      cancelled = true;
      done();
      return reader.cancel(reason);
    },
  });
}
