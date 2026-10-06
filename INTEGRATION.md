# Integrating with `model-router`

`model-router` is an OpenAI-compatible gateway. Any client or SDK that can talk
to the OpenAI Chat Completions API can talk to it — you only change the base URL,
the API key, and the `model` field.

- **Base URL (prod):** `https://router.example.com`
- **Auth:** `Authorization: Bearer <token>` (or `X-API-Key: <token>`)
- **OpenAI path:** `/v1/chat/completions`, `/v1/models`

## 1. Get a token

Two kinds of bearer token are accepted:

| Token | Who it's for | How to get it |
|---|---|---|
| **Service key** | Our own first-party projects | The shared `ROUTER_SERVICE_API_KEY`. Ask the router owner. |
| **Tenant token** (`pft_<tenantId>.<hmac>`) | A separate project / external client | The owner mints one for your `tenantId` from the router's HMAC secret. Per-project, revocable by rotating the secret. |

Prefer a **tenant token** for a separate project — it identifies you without sharing the master key.

## 2. Pick a logical model

You do **not** name a physical model (`gemini-3.1-pro`, `deepseek-…`). You name a
**capability**, and the router maps it to whatever real model is alive and fast
right now, failing over automatically:

| Logical name | Modality | Content | Tier |
|---|---|---|---|
| `text-high` | text | safe | smart / pro |
| `text-high-think` | text | safe | smart / pro (MiniMax-M3.1-Flash-Preview, default reasoning_effort medium) |
| `text-low` | text | safe | fast / flash |
| `text-summarize` | text | safe | fast / flash (long-input summarization ≥30k tokens) |
| `text-uncensored-high` | text | 18+ | smart / pro |
| `text-uncensored-low` | text | 18+ | fast / flash |
| `vision-high` | vision | safe | smart / pro |
| `vision-low` | vision | safe | fast / flash |
| `vision-uncensored-high` / `-low` | vision | 18+ | — |
| `text-embed` | embedding | multilingual | 1024 dims (bge-m3) |

`GET /v1/models` returns this catalog live.

> Uncensored tiers may be empty depending on what is hosted; an empty pool
> returns a clean error rather than silently falling back to a safe model.

> **Uncensored tiers just work.** The models refuse bare explicit requests, so
> the router auto-injects the right system overlay (text vs vision, by tier) —
> you don't need to send one. If you send your own `system` message it's kept
> and merged. To disable per request, send header `x-router-no-overlay: 1`.
> The administrator can also disable the overlay for your entire tenant
> (`overlay: 'off'`); you can force it back on for a single request with
> `x-router-overlay: 1` (`x-router-no-overlay` wins if both are present).

## 3. Required request metadata

All requests to `/v1/chat/completions` should supply metadata identifying the
calling application, the agent worker, and the session/task:

- `x-router-app`: calling application/service name (e.g. `my-portal`)
- `x-router-agent`: agent worker or subagent role (e.g. `pf-work-1`)
- `x-router-session`: unique task, conversation, or session ID (e.g. `sess-4f9a12`)
- `x-router-user`: (optional) user identifier for per-user limit isolation and tracking. If not passed, the router automatically derives the user ID from `x-router-session` as the prefix before the first `:` (e.g. session `164393c9-...:chat:abc` -> user `164393c9-...`).

Values must match `[A-Za-z0-9._:@/-]` (max 128 characters).

### Migration notice

The router currently runs in **soft mode** (`ROUTER_METADATA_MODE=soft`):
- If headers are missing, requests proceed but return the response header `x-router-warning: missing-metadata`.
- In a future release, the router will switch to **enforce mode** (`ROUTER_METADATA_MODE=enforce`), where requests missing any of these headers are rejected with HTTP 400 (`missing_metadata`).

Configure these headers now to ensure uninterrupted service.

### Sending metadata headers

**curl:**

```bash
curl -sS https://router.example.com/v1/chat/completions \
  -H "Authorization: Bearer $ROUTER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-router-app: my-portal" \
  -H "x-router-agent: pf-work-1" \
  -H "x-router-session: sess-4f9a12" \
  -d '{
    "model": "text-low",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

**OpenAI SDK (JS / TS):**

`x-router-app` and `x-router-agent` are fixed per client — set them once in
`defaultHeaders`. `x-router-session` changes per conversation/task — pass it per
request:

```js
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.ROUTER_TOKEN,
  baseURL: 'https://router.example.com/v1',
  defaultHeaders: {
    'x-router-app': 'my-portal',
    'x-router-agent': 'pf-work-1',
  },
});

const res = await client.chat.completions.create(
  { model: 'text-high', messages: [{ role: 'user', content: 'Hi' }] },
  { headers: { 'x-router-session': sessionId } },
);
```

### Tools and thinking (MiniMax)

`tools` / `tool_choice` (string or `{type:"function",function:{name}}`) are passed
through unchanged. MiniMax-M3 runs with thinking **off** by default for speed, but
with thinking off it often ignores `tool_choice`. So when a request carries
`tools`, the router leaves MiniMax thinking **on** (measured: 10/10 tool calls vs
2–7/10, no slower).

To choose explicitly, use whichever form your SDK already speaks — the router
understands all of these and translates them for MiniMax (`adaptive` = the model
decides how much to think, `disabled` = off):

| Form | On | Off |
|---|---|---|
| `thinking` (Anthropic / MiniMax) | `{"type":"enabled"}`, `{"type":"adaptive"}`, `true` | `{"type":"disabled"}`, `false` |
| `reasoning_effort` (OpenAI) | `low` / `medium` / `high` | `none` / `minimal` |
| `reasoning` (Responses API, OpenRouter) | `{"effort":"high"}`, `{"enabled":true}`, `{}` | `{"enabled":false}` |
| `enable_thinking`, `chat_template_kwargs.enable_thinking` (Qwen, vLLM) | `true` | `false` |
| `think` (Ollama) | `true`, `"high"` | `false` |
| `extra_body.google.thinking_config.thinking_budget` (Gemini) | `>0` or `-1` | `0` |

If several are sent, the first in this table wins. Budgets (`budget_tokens`,
`max_tokens`, `thinking_budget`) only switch thinking on/off — MiniMax decides the
amount itself. On other backends these non-OpenAI fields are dropped (so an
unknown field never breaks the request); `reasoning_effort` is passed through.

**Reasoning is never mixed into the answer.** The router asks MiniMax to return
its thinking separately and strips `reasoning_content` / `reasoning_details`
from responses, so `content` holds only the answer. To receive the reasoning
fields, send header `x-router-reasoning: 1` (or `include_reasoning: true` /
`reasoning: {"exclude": false}` in the body).

Both streaming (`stream: true`, SSE) and non-streaming JSON are supported. The
response's `model` field is the **logical** name, not the physical model behind it.

### Which physical model served me?

Every response carries headers indicating the actual physical backend and model that served the request:

- `x-router-model`: physical model name (e.g. `MiniMax-M3`, `bge-m3:latest`, `qwen2.5:7b-64k`).
- `x-router-provider`: provider label:
  - `minimax`: MiniMax native API / budget group
  - `ollama-cloud`: Ollama cloud hosted models
  - `backend2-gemini`: backend2 resident gateway (`/gemini/v1`)
  - `local-gpu`: local GPU Ollama instance
  - URL hostname (or `custom`): third-party or custom providers
- `x-router-backend`: pool entry ID that served the call (e.g. `local-bge-m3-embed`, `minimax-m3-direct-text-high`).
- `x-router-dims`: (embeddings only) dimension count of the returned vectors (e.g. `1024`).

For backward compatibility, chat responses continue to set `x-pf-backend` and `x-pf-backend-model`.

## 4. Embeddings (`POST /v1/embeddings`)

The router provides an OpenAI-compatible embeddings endpoint backed by local GPU Ollama (`bge-m3:latest`, 1024 dimensions).

### Request format

Pass `"model": "text-embed"`. The `input` field accepts either a single string or an array of up to 256 strings (total character count ≤ 200,000 across all inputs).

The same client metadata headers (`x-router-app`, `x-router-agent`, `x-router-session`) and bearer auth (`Authorization: Bearer <token>`) are required.

```bash
curl -sS https://router.example.com/v1/embeddings \
  -H "Authorization: Bearer $ROUTER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-router-app: my-portal" \
  -H "x-router-agent: pf-work-1" \
  -H "x-router-session: sess-4f9a12" \
  -d '{
    "model": "text-embed",
    "input": "Multilingual retrieval and dense vector indexing with bge-m3."
  }'
```

Response:
```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.0123, -0.0456, 0.0789]
    }
  ],
  "model": "text-embed",
  "usage": {
    "prompt_tokens": 14,
    "total_tokens": 14
  }
}
```

Response headers include `x-router-model: bge-m3:latest`, `x-router-provider: local-gpu`, `x-router-backend: local-bge-m3-embed`, and `x-router-dims: 1024`.

### The "One Model per Route" Rule

Every entry in an embedding route pool MUST be the exact same model and dimension. Vectors produced by different models (e.g. `bge-m3` vs `nomic-embed-text`) exist in completely different vector spaces and are **not comparable** — calculating cosine similarity between vectors from different models corrupts index retrieval.

Therefore, never add a different physical model as a fallback candidate under the same logical embedding ID. If a new model or dimension is introduced in the future, create a new logical embedding ID (e.g. `text-embed-2`).

### Error Codes

- **400 `missing_model`**: Request body is missing the `model` field.
- **400 `invalid_input`**: The `input` field is empty, not a string/array, exceeds 256 items, or total characters exceed 200,000.
- **400 `missing_metadata`**: Returned when the router runs in `enforce` mode and metadata headers are absent.
- **404 `model_not_found`**: The specified model is not supported on `/v1/embeddings`. Chat models (`text-high`, etc.) and raw physical model names (`bge-m3`) return 404 with a list of supported embedding models.
- **502 `upstream_unavailable`**: All embedding backend candidates failed or are in cooldown.

## 5. Protection layers: rate limits, loop guard, and budget

To protect shared resources, ensure stability, and manage provider subscriptions, the router enforces three layers of protection:

### Tenant Rate Limits (HTTP 429)

Every tenant can have configured rate caps on request frequency and concurrency. These are evaluated before forwarding requests and before the Loop Guard:

| Error Code | Limit Header | Cause | Retry Behavior |
|---|---|---|---|
| `rate_limited` | `x-router-limit: rpm` | Sliding 60-second window request cap exceeded (per tenant or per agent). | **Transient.** Inspect `retry-after: <seconds>` (typically 1–60s) and wait until the oldest request leaves the sliding window before retrying. |
| `too_many_concurrent` | `x-router-limit: concurrent` | Maximum simultaneous in-flight requests reached. | **Transient.** Inspect `retry-after: 1`. Retry after 1 second with exponential backoff and jitter. |
| `daily_request_limit` | `x-router-limit: day` | Tenant UTC daily request allowance exhausted. | **Hard stop for today.** Inspect `retry-after: <seconds>`, which indicates the duration until next UTC midnight. Do not hammer the router; wait until the new UTC day starts or contact your administrator. |

Example 429 rate limit response:
```json
{
  "error": {
    "message": "Rate limit exceeded (rpm)",
    "type": "rate_limit_error",
    "code": "rate_limited"
  }
}
```

Response headers:
- `retry-after: <seconds>` (seconds to wait before retry)
- `x-router-limit: <rpm | concurrent | day>`

### Tenant Disabled (HTTP 403 `tenant_disabled`)

If an administrator deactivates your tenant in the registry, all requests (both chat completions and embeddings) are rejected with HTTP 403:

```json
{
  "error": {
    "message": "Tenant is disabled",
    "type": "invalid_request_error",
    "code": "tenant_disabled"
  }
}
```

> **IMPORTANT:** Do NOT retry upon receiving `tenant_disabled`. Check with the router administrator to reactivate your tenant account or obtain a valid token.

### Loop Guard (HTTP 429 `loop_detected`)

The loop guard monitors per-session activity (`${tenantId}|${app}|${agent}|${session}`) using sliding windows across three rules:
1. **Rate:** more than 40 requests in 5 minutes (or custom per-tenant threshold).
2. **Volume:** more than 3,000,000 estimated input tokens in 10 minutes (base64 image payloads are normalized to 1,000 chars to avoid false positives).
3. **Repeat:** the exact same last message (identical role + content sha1 hash) sent across 3 consecutive requests in 5 minutes (or custom per-tenant threshold). A request with a different `max_tokens` / `max_completion_tokens` counts as a different request, so re-sending a truncated reply with a raised output limit is not a loop.

When triggered, the session is **blocked for 10 minutes** (or custom per-tenant block duration). The router responds with HTTP 429:

```json
{
  "error": {
    "message": "Loop detected for this session (repeat: 3 consecutive identical messages). Blocked until 2026-09-24T22:10:00.000Z. Do not retry — stop the agent loop.",
    "type": "rate_limit_error",
    "code": "loop_detected"
  }
}
```

Response headers:
- `retry-after: <seconds>` (remaining block duration)
- `x-router-loop: <rule>` (`rate`, `volume`, or `repeat`)

> **IMPORTANT:** Do NOT automatically retry requests when receiving 429 `loop_detected`. Immediately terminate the agent loop.

*Note on migration:* If request metadata headers are incomplete, the loop guard operates in **dry-run mode** (logged for admins, but not blocked). Once metadata headers are complete, loop protection is fully enforced.

### Summary: Client Retry Recommendations

| Status Code & Error Code | Category | Automated Retry Recommended? | Strategy |
|---|---|---|---|
| **429 `rate_limited`** | Short Rate Limit | **YES** | Wait `retry-after` seconds, then retry once. |
| **429 `too_many_concurrent`** | Concurrency Spurt | **YES** | Wait 1–2 seconds with randomized jitter, then retry with backoff. |
| **429 `daily_request_limit`** | Daily Allowance | **NO** | Stop processing until next UTC day (after `retry-after` seconds). |
| **429 `loop_detected`** | Runaway Loop | **NO** | Immediately terminate the agent session/task loop. |
| **403 `tenant_disabled`** | Auth / Account | **NO** | Abort execution; contact service administrator. |
| **503 `budget_exceeded`** | Provider Budget | **NO** | MiniMax and fallbacks unavailable; wait or route to external backup. |
| **502 `upstream_unavailable`** | Backend Failure | **YES (with backoff)** | Retry with exponential backoff up to 3 times. |


### MiniMax Budget Guard (HTTP 503 `budget_exceeded`)

The router tracks token consumption against the MiniMax subscription (1.7B tokens / 30 days) with cache-weighted accounting, per-tenant caps, and per-user hourly/daily caps:
- When a tenant or user exceeds their limits or daily global allowance, requests automatically skip MiniMax backends, avoid shared `ollama-cloud` quota on censored tiers, and `text-high` has no local 7B entry at all (its pool ends with cloud flash-lite and deepseek).
- Successful responses carry header `x-router-budget: exceeded; reason=<reason>`. Possible reasons:
  - `user-hour`: hourly limit exceeded for this user
  - `user-day`: daily limit exceeded for this user
  - `tenant-hour`: hourly limit exceeded for this tenant
  - `tenant-day`: daily limit exceeded for this tenant
  - `provider-quota`: remaining quota on the upstream provider (MiniMax) is below cutoff (<= 5%)
  - `global-day`: global daily allowance exceeded across all tenants
  - `cycle`: monthly subscription quota exceeded
- If no alternative fallback backends remain for the requested tier (or if fallback backends fail), the router returns HTTP 503:

```json
{
  "error": {
    "message": "MiniMax budget exceeded for this client (tenant-hour) and fallback backends were unavailable",
    "type": "rate_limit_error",
    "code": "budget_exceeded"
  }
}
```

### Dynamic Quota Management (`/v1/budget/quota`)

Client portals can dynamically request token quota for the MiniMax model tier (e.g. based on real-time active user counts and tariff plans), raise or lower limits, and receive immediate capacity feedback.

#### Authentication & Rate Limits
- Authenticated with the same Bearer token (`pft_...`) or `X-API-Key` as `/v1/chat/completions`.
- **PUT rate limit**: At most one successful `PUT /v1/budget/quota` per tenant per 60 seconds. Subsequent updates within 60s receive HTTP 429 `quota_rate_limited` with a `Retry-After` header. `GET` and `DELETE` are not rate-limited.

#### Recomputing & Requesting Quota (PUT)

Portals typically run an hourly cron that calculates:
$$\text{requestedDay} = \sum_{\text{active users}} \text{userTariffDailyTokens}$$
and issues `PUT /v1/budget/quota`:

```bash
curl -X PUT https://model-router.local/v1/budget/quota \
  -H "Authorization: Bearer pft_..." \
  -H "Content-Type: application/json" \
  -d '{
    "day": 20000000,
    "hour": 5000000,
    "user": {
      "day": 1000000,
      "hour": 250000
    },
    "ttlSec": 86400
  }'
```

All values are cache-weighted tokens (positive integers). At least one of `day`, `hour`, or `user` must be provided; omitted fields retain their currently effective values. `ttlSec` defaults to 86400 (24h) and is clamped between 300 (5m) and 604800 (7d).

#### Capacity Feedback Signal (`limitedBy`)

The router grants what it can afford based on:
1. **Owner ceiling (`owner-max`)**: Maximum share of today's global allowance configured for the tenant. If unconfigured and no default exists, returns HTTP 403 `quota_not_allowed`.
2. **Global reserve & capacity (`capacity`)**: Ensures all tenants retain a collective reserve (default 20%).
3. **Provider tightening (`provider-low`)**: When provider remaining quota drops below the tighten threshold (default <= 15%), available capacity is halved and grants clamped by this limit receive `limitedBy: "provider-low"`.

```json
{
  "tenant": "proj-04",
  "requested": {
    "day": 20000000,
    "hour": 5000000,
    "user": { "day": 1000000, "hour": 250000 }
  },
  "granted": {
    "day": 16000000,
    "hour": 5000000,
    "user": { "day": 1000000, "hour": 250000 }
  },
  "effective": {
    "day": 16000000,
    "hour": 5000000,
    "user": { "day": 1000000, "hour": 250000 },
    "source": "grant"
  },
  "limitedBy": "capacity",
  "expiresAt": "2026-09-25T12:00:00.000Z",
  "updatedAt": "2026-09-24T12:00:00.000Z",
  "usage": { "dayUsed": 240000, "hourUsed": 15000 },
  "cycle": {
    "start": "2026-09-24",
    "end": "2026-10-24",
    "total": 1700000000,
    "usedCycle": 240000,
    "usedCycleRaw": 270000,
    "remaining": 1699760000,
    "daysLeft": 30,
    "todayAllowance": 56666666,
    "cacheFactor": 0.1,
    "provider": {
      "weeklyRemainingPercent": 98,
      "intervalRemainingPercent": 98,
      "weeklyEnd": "2026-10-04T00:00:00.000Z",
      "intervalEnd": "2026-09-28T16:00:00.000Z",
      "fetchedAt": "2026-09-28T12:00:00.000Z",
      "fresh": true
    }
  }
}
```

> **Capacity Signal:** When `granted.day < requested.day` (or `granted.hour < requested.hour`), `limitedBy` will be `'capacity'`, `'owner-max'`, or `'provider-low'`. The client portal should treat `granted < requested` as a signal that the router cannot allocate the full requested capacity, and may throttle bulk jobs or route lower-tier requests to external models.

#### Inspecting Status (GET)
`GET /v1/budget/quota` returns the caller's active grant, effective limits, usage, monthly cycle metrics, and `cycle.provider`.

#### Reverting to Static Limits (DELETE)
`DELETE /v1/budget/quota` drops the active grant, immediately reverting the tenant to the statically configured limits in `ROUTER_MINIMAX_TENANT_LIMITS`.

## 6. Health & discovery

- `GET /healthz` — public, no auth. `{ "status": "ok", ... }`.
- `GET /v1/models` — requires a token; lists logical models.
- `GET /admin/status` — requires the service key; shows the live candidate per
  logical model, pool health, cooldowns, TTFB, retirement alerts, loop guard telemetry, and budget tracking.

## 7. What it does not do

- No persistence — it is a stateless proxy. Your conversation state stays yours.
- No physical model names as input — use logical names (a physical name gets a 400).
- One credential is one identity — do not share your tenant token across projects;
  ask for one per project so they can be revoked independently.

## 8. Client Upstream Keys (BYOK) & Error Codes

When a client is configured in BYOK mode (`mode: 'byok'`), its requests are strictly executed using the client's own upstream provider keys and catalogs. Supported providers are `ollama-cloud` and `openai`. They never fall back to shared infrastructure.

If both provider keys are configured, the order of models is controlled by the tenant's `providerOrder` (`['ollama-cloud', 'openai']` by default). OpenAI dialect nuances (e.g. `max_tokens` automatically converted to `max_completion_tokens`, reasoning model parameter adjustments for `o1`/`o3`/`gpt-5`) are handled transparently by the router.

The following specific error codes can be returned:

| HTTP Status | Error Code (`error.code`) | Meaning | Recommended Client Reaction |
|---|---|---|---|
| `502` | `upstream_key_invalid` | The upstream provider rejected the key (HTTP 401/403). The key has been marked invalid. | Update the API key in the admin panel (`/admin/ui`) or via the Admin API. |
| `429` | `upstream_quota_exhausted` | Upstream provider account quota or spending budget is exhausted (e.g. OpenAI `insufficient_quota` or Ollama quota limits). The response carries a `retry-after` header. | Pause outgoing requests until `retry-after` expires or add credits/quota to the upstream provider account. |
| `503` | `byok_no_models` | No admitted models exist in the resolved BYOK pool for the requested route (e.g. uncensored routes which are empty by default, or all candidate models failed admission). | Check model availability on the provider or configure custom route entries in `pools`. |
| `403` | `not_available_for_byok` | The endpoint (such as `/v1/embeddings`) is disabled for BYOK clients by default. | Ask the administrator to enable `allowSharedEmbeddings: true` on your tenant record. |

