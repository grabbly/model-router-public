import { CONFIG } from '../config.js';
import {
  ChatCompletionRequest,
  LogicalModelConfig,
  LogicalModelId,
  PoolEntry,
} from '../types.js';
import { rateLimitCooldownSec, recordFailure, recordSuccess } from './cooldown.js';
import { markHealthyFromTraffic } from './prober.js';
import { getOrderedCandidates, getPreselectedCandidate } from './selector.js';
import { createWatchdog, maskCompletion, maskStream } from './stream-masker.js';
import { adaptMessagesForEntry } from './entry-adapt.js';
import { resolveEntryKey } from './keys.js';
import { reportModelMissing, reportModelRejected } from './catalog.js';
import { globMatch } from './rules.js';
import { resolveThinkingIntent, THINKING_ALIAS_FIELDS } from './thinking.js';
import { emitRouterEvent } from './events.js';
import { getTenant, upsertTenant, TenantRecord, UpstreamKeyRecord } from './tenants.js';

export interface ForwardResult {
  ok: boolean;
  status: number;
  data?: unknown;
  stream?: ReadableStream<Uint8Array>;
  via?: PoolEntry;
  failoverCount?: number;
  /** Upstream token usage; for streams it is filled in once the stream ends. */
  usage?: Record<string, unknown>;
  retryAfter?: string;
  error?: {
    message: string;
    type: string;
    code?: string;
  };
}

const stats = {
  totalRequests: 0,
  streamingRequests: 0,
  failedRequests: 0,
  failoversCount: 0,
  tenantsSeen: new Set<string>(),
};

export function getRequestStats() {
  return {
    totalRequests: stats.totalRequests,
    streamingRequests: stats.streamingRequests,
    failedRequests: stats.failedRequests,
    failoversCount: stats.failoversCount,
    tenantsSeen: Array.from(stats.tenantsSeen),
  };
}

function sanitizeEntryParams(params?: Record<string, unknown>): Record<string, unknown> {
  if (!params) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === 'messages' || k === 'model') continue;
    out[k] = v;
  }
  return out;
}

export interface BuildUpstreamBodyOptions {
  /** Tenant setting: 'off' keeps the entry's thinking: disabled even with tools. */
  thinkingWithTools?: 'model-default' | 'off';
}

/**
 * The request body to send to one pool entry. Entry params win over the
 * client's body, except thinking on entries that define it (MiniMax):
 * - the client's thinking intent, in any dialect (see core/thinking.ts), is
 *   translated to MiniMax's own thinking.type adaptive | disabled;
 * - with `tools` and no client choice, the entry's `thinking: disabled` is
 *   dropped — M3 with thinking off ignores tool_choice (2/10 calls for a forced
 *   function vs 10/10 with default thinking, and no slower; measured 25.09),
 *   unless the tenant set thinkingWithTools: 'off' (options).
 * Non-OpenAI dialect fields (thinking, enable_thinking, think, …) never reach
 * any backend as-is. `reasoning_effort` (standard OpenAI) still reaches
 * non-MiniMax backends, where entry params may override it.
 */
export function buildUpstreamBody(
  entry: PoolEntry,
  body: ChatCompletionRequest,
  messages: ChatCompletionRequest['messages'],
  options?: BuildUpstreamBodyOptions
): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...body };
  for (const k of THINKING_ALIAS_FIELDS) delete rest[k];
  const params = sanitizeEntryParams(entry.params);
  const entryHasThinking = 'thinking' in params;

  if (entry.reasoningEfforts && Array.isArray(entry.reasoningEfforts)) {
    // MiniMax-M3.1-Flash-Preview always reasons; rejects thinking parameter
    delete params.thinking;
    delete rest.thinking;
    const clientEffort =
      typeof body.reasoning_effort === 'string'
        ? body.reasoning_effort
        : typeof (body as any).reasoning?.effort === 'string'
          ? (body as any).reasoning.effort
          : undefined;
    if (clientEffort && entry.reasoningEfforts.includes(clientEffort)) {
      params.reasoning_effort = clientEffort;
    } else {
      params.reasoning_effort = entry.params?.reasoning_effort;
    }
  } else if (entryHasThinking) {
    // MiniMax ignores these; the intent is carried by thinking.
    delete rest.reasoning_effort;
    delete rest.google;
    if (rest.extra_body && typeof rest.extra_body === 'object') {
      const { google: _g, ...extra } = rest.extra_body as Record<string, unknown>;
      if (Object.keys(extra).length) rest.extra_body = extra;
      else delete rest.extra_body;
    }
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const intent = resolveThinkingIntent(body);
    if (intent) {
      params.thinking = { type: intent === 'on' ? 'adaptive' : 'disabled' };
    } else if (hasTools) {
      if (options?.thinkingWithTools !== 'off') {
        delete params.thinking;
      }
    }
  }

  const result: Record<string, unknown> = {
    ...rest,
    messages,
    model: entry.model,
    ...params,
    // Always ask for usage on streams so per-tenant token burn is logged.
    ...(body.stream
      ? { stream_options: { ...(body.stream_options || {}), include_usage: true } }
      : {}),
  };

  if (entry.reasoningEfforts) {
    delete result.thinking;
  }

  if (entry.provider === 'openai') {
    // 1. max_tokens -> max_completion_tokens (keep client value; if both present keep max_completion_tokens)
    if (result.max_completion_tokens !== undefined) {
      delete result.max_tokens;
    } else if (result.max_tokens !== undefined) {
      result.max_completion_tokens = result.max_tokens;
      delete result.max_tokens;
    }

    // 2. Drop router-only/other-dialect fields that OpenAI rejects
    for (const k of THINKING_ALIAS_FIELDS) delete result[k];
    delete result.reasoning_split;
    delete result.top_k;
    delete result.google;
    if (result.extra_body && typeof result.extra_body === 'object') {
      const { google: _g, ...extra } = result.extra_body as Record<string, unknown>;
      if (Object.keys(extra).length) result.extra_body = extra;
      else delete result.extra_body;
    }

    // 3. For reasoning models (o*, gpt-5*): drop temperature, top_p, presence_penalty, frequency_penalty unless equal to defaults
    const isReasoning =
      globMatch('o*', entry.model) ||
      globMatch('gpt-5*', entry.model) ||
      /^(?:o\d|gpt-5)/i.test(entry.model);

    if (isReasoning) {
      if (result.temperature !== undefined && result.temperature !== 1) {
        delete result.temperature;
      }
      if (result.top_p !== undefined && result.top_p !== 1) {
        delete result.top_p;
      }
      if (result.presence_penalty !== undefined && result.presence_penalty !== 0) {
        delete result.presence_penalty;
      }
      if (result.frequency_penalty !== undefined && result.frequency_penalty !== 0) {
        delete result.frequency_penalty;
      }
    }
  }

  return result;
}

export interface ForwardChatOptions {
  excludeEntry?: (e: PoolEntry) => boolean;
  excludeReason?: string;
  /** Pass model reasoning fields through to the client (default: stripped). */
  keepReasoning?: boolean;
  thinkingWithTools?: 'model-default' | 'off';
  /** Callback for stream errors/incomplete ends to log request-log errorCode. */
  onError?: (code: string, message: string) => void;
}

const REQUEST_SPECIFIC_STATUSES = new Set([400, 413, 422]);

/**
 * Forwards a chat completion request to the best healthy candidate with reactive failover.
 */
function checkKeyRecovery(
  entry: PoolEntry,
  tenantRecord: TenantRecord | null,
  tenantKeyInfo?: UpstreamKeyRecord
): void {
  if (entry.keyRef && tenantRecord && tenantKeyInfo && tenantKeyInfo.status !== 'ok') {
    const previousStatus = tenantKeyInfo.status;
    tenantKeyInfo.status = 'ok';
    tenantKeyInfo.statusAt = new Date().toISOString();
    delete tenantKeyInfo.lastError;
    delete tenantKeyInfo.exhaustedUntil;
    upsertTenant(tenantRecord);
    emitRouterEvent({
      type: 'byok.key-recovered',
      tenantId: entry.keyRef.tenantId,
      provider: entry.keyRef.provider,
      hint: tenantKeyInfo.hint,
      previousStatus,
    });
  }
}

export async function forwardChat(
  logicalModelId: LogicalModelId,
  config: LogicalModelConfig,
  body: ChatCompletionRequest,
  tenantId?: string,
  options?: ForwardChatOptions
): Promise<ForwardResult> {
  stats.totalRequests += 1;
  if (body.stream) {
    stats.streamingRequests += 1;
  }
  if (tenantId) {
    stats.tenantsSeen.add(tenantId);
  }

  // Retrieve candidates to try in order
  const preselected = getPreselectedCandidate(logicalModelId, config);
  const allOrdered = getOrderedCandidates(logicalModelId, config);

  let candidates: PoolEntry[] = [];
  if (preselected) {
    candidates.push(preselected);
  }
  for (const c of allOrdered) {
    if (!candidates.some((e) => e.id === c.id)) {
      candidates.push(c);
    }
  }

  // Filter candidates if an exclusion predicate was provided (e.g. over-budget)
  if (options?.excludeEntry) {
    candidates = candidates.filter((e) => !options.excludeEntry!(e));
  }

  if (candidates.length === 0) {
    stats.failedRequests += 1;
    if (options?.excludeEntry) {
      const reason = options.excludeReason || 'budget';
      return {
        ok: false,
        status: 503,
        error: {
          message: `MiniMax budget exceeded for this client (${reason}) and no fallback backend is available for this tier`,
          type: 'rate_limit_error',
          code: 'budget_exceeded',
        },
      };
    }
    return {
      ok: false,
      status: 503,
      error: {
        message: `No candidate models available or configured for ${logicalModelId}`,
        type: 'invalid_request_error',
        code: 'model_unavailable',
      },
    };
  }

  const candidateTimeoutMs = config.timeoutMs || CONFIG.ttfbTimeoutMs;
  const cooldownSec = config.cooldownSec || 120;
  const failures: string[] = [];
  let failoverCount = 0;

  for (const entry of candidates) {
    let tenantKeyInfo: UpstreamKeyRecord | undefined;
    let tenantRecord: TenantRecord | null = null;
    if (entry.keyRef) {
      tenantRecord = getTenant(entry.keyRef.tenantId);
      tenantKeyInfo = tenantRecord?.upstreamKeys?.[entry.keyRef.provider];

      if (tenantKeyInfo?.status === 'invalid') {
        stats.failedRequests += 1;
        return {
          ok: false,
          status: 502,
          error: {
            message: 'Upstream key is invalid',
            type: 'api_error',
            code: 'upstream_key_invalid',
          },
        };
      }

      if (tenantKeyInfo?.status === 'exhausted' && tenantKeyInfo.exhaustedUntil) {
        const remainingSec = Math.ceil(
          (Date.parse(tenantKeyInfo.exhaustedUntil) - Date.now()) / 1000
        );
        if (remainingSec > 0) {
          stats.failedRequests += 1;
          return {
            ok: false,
            status: 429,
            retryAfter: String(remainingSec),
            error: {
              message: `Upstream quota exhausted until ${tenantKeyInfo.exhaustedUntil}`,
              type: 'rate_limit_error',
              code: 'upstream_quota_exhausted',
            },
          };
        }
      }
    }

    const key = resolveEntryKey(entry);
    if (entry.keyRef && !key) {
      stats.failedRequests += 1;
      return {
        ok: false,
        status: 502,
        error: {
          message: 'Upstream key is missing or invalid',
          type: 'api_error',
          code: 'upstream_key_invalid',
        },
      };
    }
    if (entry.apiKeyEnv && !key) {
      failures.push(`${entry.id}: missing env key ${entry.apiKeyEnv}`);
      continue;
    }

    const ac = new AbortController();
    let timeoutHandle: NodeJS.Timeout | undefined = setTimeout(() => {
      ac.abort(new Error(`TTFB timeout after ${candidateTimeoutMs}ms`));
    }, candidateTimeoutMs);

    const clearCandidateTimeout = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
    };

    try {
      const messages = await adaptMessagesForEntry(entry, body.messages);
      const upstreamUrl = `${entry.baseUrl.replace(/\/$/, '')}/chat/completions`;
      const upstreamBody = buildUpstreamBody(entry, body, messages, {
        thinkingWithTools: options?.thinkingWithTools,
      });

      const res = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(upstreamBody),
        signal: ac.signal,
      });

      if (!res.ok) {
        clearCandidateTimeout();
        const errText = await res.text().catch(() => '');
        const reason = `HTTP ${res.status}: ${errText.slice(0, 150)}`;

        if (entry.keyRef && (res.status === 401 || res.status === 403)) {
          if (tenantRecord && tenantKeyInfo) {
            tenantKeyInfo.status = 'invalid';
            tenantKeyInfo.statusAt = new Date().toISOString();
            tenantKeyInfo.lastError = `HTTP ${res.status}: ${errText.slice(0, 150)}`;
            upsertTenant(tenantRecord);
            emitRouterEvent({
              type: 'byok.key-invalid',
              tenantId: entry.keyRef.tenantId,
              provider: entry.keyRef.provider,
              hint: tenantKeyInfo.hint,
            });
          }
          stats.failedRequests += 1;
          return {
            ok: false,
            status: 502,
            error: {
              message: `Upstream key is invalid (status ${res.status})`,
              type: 'api_error',
              code: 'upstream_key_invalid',
            },
          };
        }

        if (entry.keyRef && res.status === 429) {
          const retryHeader = res.headers.get('retry-after');
          let retrySec = 0;
          if (retryHeader) {
            const n = Number(retryHeader);
            if (Number.isFinite(n) && n > 0) {
              retrySec = n;
            } else {
              const at = Date.parse(retryHeader);
              if (Number.isFinite(at)) {
                retrySec = Math.max(0, Math.ceil((at - Date.now()) / 1000));
              }
            }
          }

          // A plain "rate limit exceeded" is a short throttle (try the next
          // entry of the same key), not an exhausted plan; only quota/plan
          // wording or a long Retry-After parks the key.
          const isQuota =
            retrySec > 300 ||
            /quota|weekly|usage limit|session limit|insufficient|billing|credits/i.test(errText);

          if (isQuota) {
            const waitSec = retrySec > 0 ? retrySec : 3600;
            const exhaustedUntil = new Date(Date.now() + waitSec * 1000).toISOString();
            if (tenantRecord && tenantKeyInfo) {
              tenantKeyInfo.status = 'exhausted';
              tenantKeyInfo.statusAt = new Date().toISOString();
              tenantKeyInfo.exhaustedUntil = exhaustedUntil;
              tenantKeyInfo.lastError = `HTTP 429: ${errText.slice(0, 150)}`;
              upsertTenant(tenantRecord);
              emitRouterEvent({
                type: 'byok.key-exhausted',
                tenantId: entry.keyRef.tenantId,
                provider: entry.keyRef.provider,
                hint: tenantKeyInfo.hint,
                exhaustedUntil,
              });
            }
            stats.failedRequests += 1;
            return {
              ok: false,
              status: 429,
              retryAfter: String(waitSec),
              error: {
                message: `Upstream quota exhausted until ${exhaustedUntil}`,
                type: 'rate_limit_error',
                code: 'upstream_quota_exhausted',
              },
            };
          }
        }

        if (
          (res.status === 400 || res.status === 404) &&
          /model.*not found|not found.*model|does not exist/i.test(errText)
        ) {
          reportModelMissing(entry);
        } else if (res.status === 402) {
          reportModelRejected(entry, reason);
        }

        // 400/413/422 are about this request (a bad client param, too long an
        // input), not the backend's health — fail over, but don't cool the
        // entry down for every other client. 25.09: a client thinking value
        // MiniMax rejects put it in cooldown for everyone.
        if (res.status === 429) {
          recordFailure(logicalModelId, entry.id, rateLimitCooldownSec(res.headers.get('retry-after')), reason);
        } else if (!REQUEST_SPECIFIC_STATUSES.has(res.status)) {
          recordFailure(logicalModelId, entry.id, cooldownSec, reason);
        }
        failures.push(`${entry.id}: ${reason}`);
        failoverCount += 1;
        stats.failoversCount += 1;
        continue;
      }

      // If streaming is requested
      if (body.stream && res.body) {
        let onTimeoutReject: ((err: Error) => void) | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          onTimeoutReject = reject;
        });

        const watchdog = createWatchdog(
          (reason) => {
            // Abort and surface the timeout; the failure is recorded exactly
            // once by whoever catches the resulting error — the initial-read
            // catch below, or maskStream mid-stream — not here, to avoid a
            // double recordFailure for the same event.
            ac.abort(new Error(reason));
            if (onTimeoutReject) {
              onTimeoutReject(new Error(reason));
            }
          },
          candidateTimeoutMs,
          CONFIG.streamIdleTimeoutMs
        );

        // Try reading first chunk synchronously before returning stream to client
        // This ensures if upstream sends HTTP 200 and immediately hangs/closes with 0 bytes,
        // we catch it right here and fail over cleanly!
        const reader = res.body.getReader();
        let initialRead;
        try {
          initialRead = await Promise.race([
            reader.read(),
            timeoutPromise,
          ]);
        } catch (streamErr) {
          clearCandidateTimeout();
          watchdog.stop();
          const reason = streamErr instanceof Error ? streamErr.message : String(streamErr);
          recordFailure(logicalModelId, entry.id, cooldownSec, `Zero-chunk failure: ${reason}`);
          failures.push(`${entry.id}: 0-chunk stream hang (${reason})`);
          failoverCount += 1;
          stats.failoversCount += 1;
          continue;
        }

        clearCandidateTimeout();

        if (initialRead.done && (!initialRead.value || initialRead.value.length === 0)) {
          // Empty stream with 0 bytes immediately closed
          watchdog.stop();
          recordFailure(logicalModelId, entry.id, cooldownSec, 'Empty stream (0 bytes delivered)');
          failures.push(`${entry.id}: empty stream`);
          failoverCount += 1;
          stats.failoversCount += 1;
          continue;
        }

        // We have successfully verified first byte!
        recordSuccess(logicalModelId, entry.id);
        markHealthyFromTraffic(entry.id);
        checkKeyRecovery(entry, tenantRecord, tenantKeyInfo);
        watchdog.poke();

        // Construct combined readable stream that yields first chunk then continues reading
        const combinedStream = new ReadableStream<Uint8Array>({
          start(controller) {
            if (initialRead.value) {
              controller.enqueue(initialRead.value);
            }
            if (initialRead.done) {
              controller.close();
            }
          },
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                return;
              }
              controller.enqueue(value);
            } catch (e) {
              controller.error(e);
            }
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });

        const result: ForwardResult = {
          ok: true,
          status: 200,
          via: entry,
          failoverCount,
        };
        result.stream = maskStream(combinedStream, logicalModelId, {
          keepReasoning: options?.keepReasoning,
          route: logicalModelId,
          via: entry,
          cooldownSec,
          watchdog,
          onUsage: (u) => {
            result.usage = u;
          },
          stripUsageOnlyChunks: body.stream_options?.include_usage !== true,
          onError: options?.onError,
        });

        return result;
      }

      // Non-streaming response. Keep the abort timer armed across the body
      // read: a provider can send headers and then stall the body, and clearing
      // the timeout first would let that hang forever instead of failing over.
      const rawJson = (await res.json()) as Record<string, unknown>;
      clearCandidateTimeout();
      recordSuccess(logicalModelId, entry.id);
      markHealthyFromTraffic(entry.id);
      checkKeyRecovery(entry, tenantRecord, tenantKeyInfo);
      const masked = maskCompletion(rawJson, logicalModelId, { keepReasoning: options?.keepReasoning });

      return {
        ok: true,
        status: 200,
        data: masked,
        via: entry,
        failoverCount,
        usage:
          rawJson.usage && typeof rawJson.usage === 'object'
            ? (rawJson.usage as Record<string, unknown>)
            : undefined,
      };
    } catch (err: unknown) {
      clearCandidateTimeout();
      const reason = err instanceof Error ? err.message : String(err);
      recordFailure(logicalModelId, entry.id, cooldownSec, reason);
      failures.push(`${entry.id}: ${reason}`);
      failoverCount += 1;
      stats.failoversCount += 1;
    }
  }

  stats.failedRequests += 1;
  return {
    ok: false,
    status: 502,
    error: {
      message: `All upstream models for ${logicalModelId} failed: ${failures.join(' | ')}`,
      type: 'api_error',
      code: 'all_candidates_failed',
    },
  };
}
