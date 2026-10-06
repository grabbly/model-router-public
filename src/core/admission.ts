import sharp from 'sharp';

export interface ProbeResult {
  pass: boolean;
  status429?: boolean;
  isQuota?: boolean;
  isAuthError?: boolean;
  reason?: string;
}

function tokenField(baseUrl: string, modelId: string, tokens: number): Record<string, number> {
  const isReasoning = /^(?:o\d|gpt-5)/i.test(modelId);
  const isOpenAi = baseUrl.includes('openai') || isReasoning;
  return isOpenAi ? { max_completion_tokens: tokens } : { max_tokens: tokens };
}

let redPngDataUrlCache: string | null = null;

export async function getRedPngDataUrl(): Promise<string> {
  if (redPngDataUrlCache) return redPngDataUrlCache;
  const buf = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  redPngDataUrlCache = `data:image/png;base64,${buf.toString('base64')}`;
  return redPngDataUrlCache;
}

export function resetRedPngCacheForTests(): void {
  redPngDataUrlCache = null;
}

/**
 * Concurrency limiter (max 2 concurrent probes).
 */
class ProbeQueue {
  private running = 0;
  private queue: Array<() => Promise<void>> = [];

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const res = await task();
          resolve(res);
        } catch (err) {
          reject(err);
        }
      });
      this.processNext();
    });
  }

  private processNext() {
    if (this.running >= 2 || this.queue.length === 0) return;
    this.running++;
    const next = this.queue.shift()!;
    next().finally(() => {
      this.running--;
      this.processNext();
    });
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get runningCount(): number {
    return this.running;
  }
}

export const admissionProbeQueue = new ProbeQueue();

/**
 * Tests: resolve once no admission probe is queued or running. Fixed sleeps
 * were flaky under load (a probe does sharp + network + scrypt work).
 */
export async function waitForAdmissionIdleForTests(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // One tick first: probes are enqueued synchronously but start on the next turn.
  await new Promise((r) => setImmediate(r));
  while (admissionProbeQueue.pendingCount > 0 || admissionProbeQueue.runningCount > 0) {
    if (Date.now() > deadline) throw new Error('admission probes still running after ' + timeoutMs + 'ms');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function normalizeChatUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, '');
  return clean.endsWith('/chat/completions') ? clean : `${clean}/chat/completions`;
}

/**
 * Executes a single completion probe: { messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 64 }
 */
export async function runCompletionProbe(
  baseUrl: string,
  key: string,
  modelId: string
): Promise<ProbeResult> {
  const url = normalizeChatUrl(baseUrl);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        ...tokenField(baseUrl, modelId, 64),
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const errText = !res.ok ? await res.text().catch(() => '') : '';
    // Only a 429 with plan/quota wording parks the key (OpenAI insufficient_quota).
    // ollama.com's 402 "add usage credits" is about this model on this plan:
    // it must reject the model, not park the whole key.
    const isQuota = res.status === 429 && /insufficient_quota|exceeded your current quota|billing|weekly|usage limit/i.test(errText);
    const isAuth = res.status === 401 || res.status === 403;

    // 429 = throttled, 401/403 = the key's problem, not the model's: stay
    // pending and retry later instead of rejecting a good model for 24 h.
    // Also if insufficient_quota: treat as key exhausted, keep pending!
    if (res.status === 429 || isAuth || isQuota) {
      return {
        pass: false,
        status429: true,
        isQuota,
        isAuthError: isAuth,
        reason: `HTTP ${res.status}: ${errText.slice(0, 150)}`,
      };
    }

    if (!res.ok) {
      return { pass: false, reason: `HTTP ${res.status}: ${errText.slice(0, 150)}` };
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string } }>;
    };
    const msg = json?.choices?.[0]?.message;
    const text = (msg?.content || msg?.reasoning_content || msg?.reasoning || '').trim();

    if (text.length > 0) {
      return { pass: true };
    }
    return { pass: false, reason: 'Empty response content or reasoning' };
  } catch (err) {
    return { pass: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Executes a single tools probe: function tool get_time (no params) + prompt "What time is it? Use the tool."
 */
export async function runToolsProbe(
  baseUrl: string,
  key: string,
  modelId: string
): Promise<ProbeResult> {
  const url = normalizeChatUrl(baseUrl);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'What time is it? Use the tool.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_time',
              description: 'Get current time',
              parameters: {
                type: 'object',
                properties: {},
              },
            },
          },
        ],
        ...tokenField(baseUrl, modelId, 128),
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const errText = !res.ok ? await res.text().catch(() => '') : '';
    // Only a 429 with plan/quota wording parks the key (OpenAI insufficient_quota).
    // ollama.com's 402 "add usage credits" is about this model on this plan:
    // it must reject the model, not park the whole key.
    const isQuota = res.status === 429 && /insufficient_quota|exceeded your current quota|billing|weekly|usage limit/i.test(errText);
    const isAuth = res.status === 401 || res.status === 403;

    // 429 = throttled, 401/403 = the key's problem, not the model's: stay
    // pending and retry later instead of rejecting a good model for 24 h.
    // Also if insufficient_quota: treat as key exhausted, keep pending!
    if (res.status === 429 || isAuth || isQuota) {
      return {
        pass: false,
        status429: true,
        isQuota,
        isAuthError: isAuth,
        reason: `HTTP ${res.status}: ${errText.slice(0, 150)}`,
      };
    }

    if (!res.ok) {
      return { pass: false, reason: `HTTP ${res.status}: ${errText.slice(0, 150)}` };
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { tool_calls?: unknown[] } }>;
    };
    const toolCalls = json?.choices?.[0]?.message?.tool_calls;

    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      return { pass: true };
    }
    return { pass: false, reason: 'No tool_calls in response' };
  } catch (err) {
    return { pass: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Executes a single vision probe: 32x32 solid red PNG + "What colour is this square? Answer with one word."
 */
export async function runVisionProbe(
  baseUrl: string,
  key: string,
  modelId: string
): Promise<ProbeResult> {
  const url = normalizeChatUrl(baseUrl);
  const dataUrl = await getRedPngDataUrl();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What colour is this square? Answer with one word.' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        ...tokenField(baseUrl, modelId, 64),
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const errText = !res.ok ? await res.text().catch(() => '') : '';
    // Only a 429 with plan/quota wording parks the key (OpenAI insufficient_quota).
    // ollama.com's 402 "add usage credits" is about this model on this plan:
    // it must reject the model, not park the whole key.
    const isQuota = res.status === 429 && /insufficient_quota|exceeded your current quota|billing|weekly|usage limit/i.test(errText);
    const isAuth = res.status === 401 || res.status === 403;

    // 429 = throttled, 401/403 = the key's problem, not the model's: stay
    // pending and retry later instead of rejecting a good model for 24 h.
    // Also if insufficient_quota: treat as key exhausted, keep pending!
    if (res.status === 429 || isAuth || isQuota) {
      return {
        pass: false,
        status429: true,
        isQuota,
        isAuthError: isAuth,
        reason: `HTTP ${res.status}: ${errText.slice(0, 150)}`,
      };
    }

    if (!res.ok) {
      return { pass: false, reason: `HTTP ${res.status}: ${errText.slice(0, 150)}` };
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string } }>;
    };
    const msg = json?.choices?.[0]?.message;
    const text = (msg?.content || msg?.reasoning_content || msg?.reasoning || '').toLowerCase();

    if (/red|красн/i.test(text)) {
      return { pass: true };
    }
    return { pass: false, reason: `Response "${text.slice(0, 80)}" did not contain red/красн` };
  } catch (err) {
    return { pass: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
