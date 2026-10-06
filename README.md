# `model-router` — Adaptive OpenAI-Compatible Model Router

`model-router` is a lightweight, stateless, OpenAI-compatible proxy and routing gateway for LLM and Vision models. It decouples client applications from volatile upstream model names, dynamic cloud provider deprecations, and backend outages.

---

## 1. Key Features

- **Stable Logical Model Catalog**: Clients request models by logical capability rather than brittle physical names.
- **Proactive Background Prober**: Continuously measures Time-To-First-Byte (TTFB) and throughput to maintain a pre-selected "best candidate" for zero-overhead routing.
- **Zero-Chunk & TTFB Hang Protection**: Upstream models that accept connections but freeze without delivering chunks (e.g. 0-byte hangs) are caught within TTFB deadline and immediately failed over to backup candidates.
- **Upstream Retirement Detection**: Periodically cross-references physical models against provider catalogs (`https://ollama.com/v1/models`) and flags decommissioned models for removal without unauthorized auto-adoption.
- **Multi-Tenant HMAC Bearer Auth**: Uses HMAC token signing (`pft_<tenantId>.<mac>`) to identify tenants without database lookups on the hot path.

---

## 2. Logical Model Catalog

Clients specify one of the following logical model names in the standard OpenAI `model` field:

| Logical Model Name | Modality | Censorship | Tier | Purpose |
|---|---|---|---|---|
| `text-high` | Text | Censored / Safe | Pro (`high`) | Complex reasoning, high-capability conversations |
| `text-low` | Text | Censored / Safe | Flash (`low`) | Fast, cost-efficient conversational chat |
| `text-uncensored-high` | Text | Uncensored (18+) | Pro (`high`) | Complex reasoning in unrestricted domains |
| `text-uncensored-low` | Text | Uncensored (18+) | Flash (`low`) | Fast unrestricted/spicy chat |
| `vision-high` | Vision | Censored / Safe | Pro (`high`) | High-accuracy visual document & image understanding |
| `vision-low` | Vision | Censored / Safe | Flash (`low`) | Fast, lightweight image processing |
| `vision-uncensored-high` | Vision | Uncensored (18+) | Pro (`high`) | Unrestricted vision pro |
| `vision-uncensored-low` | Vision | Uncensored (18+) | Flash (`low`) | Unrestricted vision flash |
| `text-embed` | Embedding | Censored / Safe | — | Multilingual embedding (bge-m3, 1024 dims) |

---

## 3. API Reference (OpenAI Compatible)

### `POST /v1/chat/completions`
Dispatches chat completions (supporting both SSE streaming with `stream: true` and non-streaming JSON).
- **Headers**: `Authorization: Bearer <tenant-token-or-service-key>`
- **Request Body**:
  ```json
  {
    "model": "text-low",
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "Hello!" }
    ],
    "stream": true,
    "temperature": 0.7
  }
  ```

### `POST /v1/embeddings`
Generates vector embeddings for a string or array of strings (multilingual, 1024 dimensions via `bge-m3`).
- **Headers**: `Authorization: Bearer <tenant-token-or-service-key>`, `x-router-app`, `x-router-agent`, `x-router-session`
- **Request Body**:
  ```json
  {
    "model": "text-embed",
    "input": "Text to embed, or array of strings (<= 256 items)"
  }
  ```
- **Response Headers**: `x-router-model`, `x-router-provider`, `x-router-backend`, `x-router-dims`

### `GET /v1/models`
Returns list of available logical models in standard OpenAI format.

### `GET /healthz`
Public health check endpoint:
```json
{
  "status": "ok",
  "service": "model-router",
  "uptime": 1245.3,
  "timestamp": 1773730000000
}
```

### `GET /admin/status`
Admin telemetry endpoint (requires `PF_SERVICE_API_KEY`):
- Current pre-selected candidate per logical model
- Full candidate pool health, cooldown timers, and TTFB measurements
- Active retirement alerts
- Request counts and tenant activity breakdown

---

## 4. Mandatory Client-Side Anti-SPOF Guideline

> [!CRITICAL]
> **Anti-SPOF Direct Fallback Requirement**:
> `model-router` is designed for high availability and graceful failovers. However, to prevent `model-router` itself from becoming a Single Point of Failure (SPOF), **every client application / bot integrating with this router MUST maintain an emergency hardcoded direct fallback** to a known alive provider endpoint (e.g. direct Gemini or Ollama key) if the router becomes unreachable (e.g. network partition or 5xx).

---

## 5. Environment Variables

| Variable | Default | Description |
|---|---|---|
Names are the neutral `ROUTER_*` set; each still falls back to its legacy
`PF_*` name for backward compatibility. See [`.env.example`](.env.example).

| Variable | Legacy fallback | Default | Description |
|---|---|---|---|
| `PORT` | — | `4200` | Port for the HTTP server |
| `HOST` | — | `0.0.0.0` | Bind address |
| `ROUTER_SERVICE_API_KEY` | `PF_SERVICE_API_KEY` | *required in prod* | Master key for admin endpoints & service auth |
| `ROUTER_TENANT_TOKEN_SECRET` | `PF_TENANT_TOKEN_SECRET` | `${ROUTER_SERVICE_API_KEY}` | Secret used to sign/verify `pft_<tenantId>.<mac>` |
| `ROUTER_BACKEND2_BASE_URL` | `PF_BACKEND2_BASE_URL` | `https://backend2.example.com/gemini/v1` | Base URL for backend2 resident proxy |
| `ROUTER_BACKEND2_TOKEN_ENV` | — | `PF_MODELS_TOKEN` | Name of the env var holding the backend2 bearer token |
| `ROUTER_CLOUD_BASE_URL` | `PF_CLOUD_BASE_URL` | `https://ollama.com/v1` | Base URL for Ollama Cloud models |
| `OLLAMA_API_KEY` | — | *optional* | API key for Ollama Cloud |
| `ROUTER_OLLAMA_BASE_URL` | `PF_OLLAMA_BASE_URL` | `http://localhost:11434/v1` | Local GPU Ollama instance base URL |
| `ROUTER_OWNER` | — | `model-router` | `owned_by` value in `GET /v1/models` |
| `TTFB_TIMEOUT_MS` | — | `15000` | Max time allowed for upstream to emit headers/first byte |
| `STREAM_IDLE_TIMEOUT_MS` | — | `30000` | Max silence between consecutive stream chunks |
| `PROBE_INTERVAL_SECONDS` | — | `60` | Interval between background probe cycles |
| `PROBE_TIMEOUT_MS` | — | `10000` | Max timeout for individual background probe |
| `ROUTER_CONFIG_PATH` | — | *empty* | Optional path to custom JSON route configuration |

---

## 6. Local Development & Testing

```bash
# Install dependencies
npm ci

# Run TypeScript compilation
npm run build

# Run automated test suite
npm test

# Run locally (loads .env)
cp .env.example .env   # then fill in secrets
npm run dev
```

---

## 7. Integrating & Deploying

- **Call it from another project:** see [`INTEGRATION.md`](INTEGRATION.md).
