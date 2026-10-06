import dotenv from 'dotenv';
import fs from 'fs';
import {
  EmbeddingModelConfig,
  EmbeddingModelId,
  LogicalModelConfig,
  LogicalModelId,
  LOGICAL_MODEL_IDS,
  PoolEntry,
  SelectRule,
} from './types.js';
import { expandRuleEntries } from './core/rules.js';

dotenv.config();

// Prefer the neutral ROUTER_* names; fall back to the legacy PF_* names so an
// existing the portal .env keeps working through the split. Drop the legacy
// fallbacks once every deployment sets ROUTER_*.
const env = (name: string, legacy?: string): string | undefined =>
  process.env[name] ?? (legacy ? process.env[legacy] : undefined);

export const CONFIG = {
  port: Number(process.env.PORT || 4200),
  host: process.env.HOST || '0.0.0.0',
  serviceApiKey: env('ROUTER_SERVICE_API_KEY', 'PF_SERVICE_API_KEY') || '',
  tenantTokenSecret:
    env('ROUTER_TENANT_TOKEN_SECRET', 'PF_TENANT_TOKEN_SECRET') ||
    env('ROUTER_SERVICE_API_KEY', 'PF_SERVICE_API_KEY') ||
    '',

  // Base URLs.
  // backend2 discriminates by path prefix: chat models live under /gemini/v1
  // (gemini/claude/gpt-oss) and the GPU Ollama under /ollama/v1 — a bare /v1 is
  // 404. Verified against backend2.example.com on 2026-09-17.
  backend2BaseUrl: env('ROUTER_BACKEND2_BASE_URL', 'PF_BACKEND2_BASE_URL') || 'https://backend2.example.com/gemini/v1',
  // MiniMax native API (OpenAI-compatible). Its M3 is the uncensored primary —
  // more permissive than the ollama.com-hosted minimax-m3, and the only native
  // MiniMax that (a) does vision and (b) can turn off thinking.
  minimaxBaseUrl: process.env.ROUTER_MINIMAX_BASE_URL || 'https://api.minimax.io/v1',
  cloudBaseUrl: env('ROUTER_CLOUD_BASE_URL', 'PF_CLOUD_BASE_URL') || 'https://ollama.com/v1',
  openaiBaseUrl: process.env.ROUTER_OPENAI_BASE_URL || 'https://api.openai.com/v1',
  // On prod (prod-host) the local GPU is unreachable on the LAN — reach it through
  // backend2's /ollama/v1 gate. The LAN address is the dev default;
  // prod sets ROUTER_OLLAMA_BASE_URL=https://backend2.example.com/ollama/v1
  // (legacy PF_OLLAMA_BASE_URL still honoured).
  localOllamaBaseUrl: env('ROUTER_OLLAMA_BASE_URL', 'PF_OLLAMA_BASE_URL') || 'http://localhost:11434/v1',
  
  // Timeouts
  ttfbTimeoutMs: Number(process.env.TTFB_TIMEOUT_MS || 15_000),
  streamIdleTimeoutMs: Number(process.env.STREAM_IDLE_TIMEOUT_MS || 30_000),
  probeIntervalSeconds: Number(process.env.PROBE_INTERVAL_SECONDS || 60),
  probeTimeoutMs: Number(process.env.PROBE_TIMEOUT_MS || 10_000),
  retirementCheckIntervalSeconds: Number(process.env.RETIREMENT_CHECK_INTERVAL_SECONDS || 3600),
  catalogIntervalSec: Number(process.env.ROUTER_CATALOG_INTERVAL_SEC ?? 900),
  
  // External config file path (optional)
  configPath: process.env.ROUTER_CONFIG_PATH || '',
};

export const ALIAS_MAP: Record<string, LogicalModelId> = {
  'pf-core-1': 'text-low',
  'pf-lite-1': 'text-low',
  'pf-core-x': 'text-uncensored-low',
  'pf-vision-1': 'vision-low',
};

export function resolveLogicalModelId(requestedModel: string): LogicalModelId | null {
  if (LOGICAL_MODEL_IDS.includes(requestedModel as LogicalModelId)) {
    return requestedModel as LogicalModelId;
  }
  if (ALIAS_MAP[requestedModel]) {
    return ALIAS_MAP[requestedModel];
  }
  return null;
}

function createCloudEntry(
  id: string,
  model: string,
  priority: number,
  tier: 'high' | 'low',
  modality: 'text' | 'vision',
  censored: boolean,
  extraParams?: Record<string, unknown>,
  retirementDate?: string
): PoolEntry {
  return {
    id,
    provider: 'ollama-cloud',
    model,
    baseUrl: CONFIG.cloudBaseUrl,
    apiKeyEnv: 'OLLAMA_API_KEY',
    priority,
    weight: 1,
    enabled: true,
    tier,
    modality,
    censored,
    params: {
      reasoning_effort: 'none',
      ...extraParams,
    },
    retirementDate,
  };
}

function createCloudRuleEntry(
  id: string,
  select: SelectRule,
  priority: number,
  tier: 'high' | 'low',
  modality: 'text' | 'vision',
  censored: boolean,
  extraParams?: Record<string, unknown>
): PoolEntry {
  return {
    id,
    provider: 'ollama-cloud',
    model: select.prefer[0] || '',
    baseUrl: CONFIG.cloudBaseUrl,
    apiKeyEnv: 'OLLAMA_API_KEY',
    priority,
    weight: 1,
    enabled: true,
    tier,
    modality,
    censored,
    select,
    params: {
      reasoning_effort: 'none',
      ...extraParams,
    },
  };
}

function getBackend2ContextLength(model: string): number | undefined {
  if (
    model === 'gemini-3.1-pro-low' ||
    model === 'gemini-3-flash' ||
    model === 'gemini-3.1-flash-lite' ||
    model === 'gemini-3.5-flash-lite'
  ) {
    return 1048576;
  }
  if (model === 'claude-sonnet-4-6') {
    return 200000;
  }
  return undefined;
}

function createBackend2Entry(
  id: string,
  model: string,
  priority: number,
  tier: 'high' | 'low',
  modality: 'text' | 'vision',
  censored: boolean,
  extraParams?: Record<string, unknown>
): PoolEntry {
  const contextLength = getBackend2ContextLength(model);
  return {
    id,
    provider: 'custom',
    model,
    baseUrl: CONFIG.backend2BaseUrl,
    apiKeyEnv: process.env.ROUTER_BACKEND2_TOKEN_ENV || 'PF_MODELS_TOKEN',
    priority,
    weight: 1,
    enabled: true,
    tier,
    modality,
    censored,
    params: extraParams,
    ...(contextLength !== undefined ? { contextLength } : {}),
  };
}

function createLocalEntry(
  id: string,
  model: string,
  priority: number,
  tier: 'high' | 'low',
  modality: 'text' | 'vision',
  censored: boolean,
  extraParams?: Record<string, unknown>
): PoolEntry {
  const contextLength = model === 'qwen2.5:7b-64k' ? 65536 : undefined;
  return {
    id,
    provider: 'ollama',
    model,
    baseUrl: CONFIG.localOllamaBaseUrl,
    apiKeyEnv: process.env.ROUTER_LOCAL_KEY_ENV || process.env.PF_MODELS_KEY_ENV || undefined,
    priority,
    weight: 1,
    enabled: true,
    tier,
    modality,
    censored,
    params: extraParams,
    ...(contextLength !== undefined ? { contextLength } : {}),
  };
}

function createMiniMaxEntry(
  id: string,
  model: string,
  priority: number,
  tier: 'high' | 'low',
  modality: 'text' | 'vision',
  censored: boolean,
  extraParams?: Record<string, unknown>
): PoolEntry {
  return {
    id,
    provider: 'custom',
    model,
    baseUrl: CONFIG.minimaxBaseUrl,
    apiKeyEnv: 'MINIMAX_API_KEY',
    priority,
    weight: 1,
    enabled: true,
    tier,
    modality,
    censored,
    budgetGroup: 'minimax',
    contextLength: 512000,
    // MiniMax-M3 can turn off interleaved thinking — keep it off for
    // latency/cost. (M2.x ignore this: they cannot disable thinking.)
    // reasoning_split: when thinking runs (tool calls, client opt-in) M3 puts it
    // in reasoning_content instead of inline <think> tags in the answer text.
    params: { thinking: { type: 'disabled' }, reasoning_split: true, ...extraParams },
  };
}

export function getDefaultLogicalModelConfigs(): Record<LogicalModelId, LogicalModelConfig> {
  return {
    'text-high': {
      id: 'text-high',
      description: 'High-capability smart language model (censored/safe)',
      modality: 'text',
      tier: 'high',
      censored: true,
      timeoutMs: 60_000,
      cooldownSec: 120,
      pool: [
        // MiniMax-M3 direct first everywhere (owner, 25.09): it is on our 1.7B/
        // month subscription and answers in 2–6 s vs 12–24 s on backend2 Gemini.
        // Safe traffic is fine on it (the uncensored overlay is only injected on
        // *-uncensored-* tiers); per-tenant budgets in core/budget.ts cap it.
        createMiniMaxEntry('minimax-m3-direct-text-high', 'MiniMax-M3', 1, 'high', 'text', true),
        createBackend2Entry('backend2-gemini-3.1-pro-low', 'gemini-3.1-pro-low', 2, 'high', 'text', true),
        createBackend2Entry('backend2-claude-sonnet', 'claude-sonnet-4-6', 3, 'high', 'text', true),
        // deepseek flash (not v4-pro): the 1.6T pro model burned the shared
        // ollama.com weekly quota whenever backend2 was down.
        // flash-lite pair (the portal R6, 28.09): they call tools and stay up
        // when the backend2 account runs out of pro/sonnet quota. No local 7B
        // here: on 24–36k-token prompts it answered in the wrong register and
        // polluted chat history MiniMax then copied (28.09).
        createBackend2Entry('backend2-gemini-3.5-flash-lite-high', 'gemini-3.5-flash-lite', 4, 'high', 'text', true),
        createBackend2Entry('backend2-gemini-3.1-flash-lite-high', 'gemini-3.1-flash-lite', 5, 'high', 'text', true),
        // Auto-switching rule entry: selects an admitted, tools-capable model with >=64k context.
        // Today resolves to deepseek-v4.1-flash while present; auto-switches if missing or rejected.
        createCloudRuleEntry(
          'ollama-cloud-deepseek-flash-high',
          {
            need: ['tools'],
            minContext: 64000,
            prefer: ['deepseek-v4.1-flash', 'deepseek-*-flash*', 'glm-*-flash*', 'kimi-k*', 'gpt-oss:120b'],
            exclude: ['*-pro*', '*-code*'],
            // Two models, so a 402 ("not in this key's plan") on the first
            // fails over inside the same request instead of failing it.
            take: 2,
          },
          6,
          'high',
          'text',
          true
        ),
      ],
    },

    'text-high-think': {
      id: 'text-high-think',
      description: 'High-capability smart language model with mandatory reasoning (censored/safe)',
      modality: 'text',
      tier: 'high',
      censored: true,
      timeoutMs: 90_000,
      cooldownSec: 120,
      pool: [
        {
          id: 'minimax-m31-flash-think',
          provider: 'custom',
          model: 'MiniMax-M3.1-Flash-Preview',
          baseUrl: CONFIG.minimaxBaseUrl,
          apiKeyEnv: 'MINIMAX_API_KEY',
          priority: 1,
          weight: 1,
          enabled: true,
          tier: 'high',
          modality: 'text',
          censored: true,
          budgetGroup: 'minimax',
          params: { reasoning_split: true, reasoning_effort: 'medium' },
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          contextLength: 1000000,
        },
        createMiniMaxEntry('minimax-m3-direct-text-high-think', 'MiniMax-M3', 2, 'high', 'text', true),
        createBackend2Entry('backend2-gemini-3.5-flash-lite-think', 'gemini-3.5-flash-lite', 3, 'high', 'text', true),
        createBackend2Entry('backend2-gemini-3.1-pro-low-think', 'gemini-3.1-pro-low', 4, 'high', 'text', true),
      ],
    },

    'text-low': {
      id: 'text-low',
      description: 'Fast, cost-efficient language model (censored/safe)',
      modality: 'text',
      tier: 'low',
      censored: true,
      timeoutMs: 45_000,
      cooldownSec: 120,
      pool: [
        createMiniMaxEntry('minimax-m3-direct-text-low', 'MiniMax-M3', 1, 'low', 'text', true),
        createBackend2Entry('backend2-gemini-3-flash', 'gemini-3-flash', 2, 'low', 'text', true),
        createBackend2Entry('backend2-gemini-flash-lite', 'gemini-3.1-flash-lite', 3, 'low', 'text', true),
        createLocalEntry('local-qwen-low', 'qwen2.5:7b-64k', 4, 'low', 'text', true),
      ],
    },

    'text-summarize': {
      id: 'text-summarize',
      description: 'Long-input summarization (≥30k tokens in, long steady stream out; censored/safe)',
      modality: 'text',
      tier: 'low',
      censored: true,
      timeoutMs: 60_000,
      cooldownSec: 120,
      // MiniMax first here too (owner, 25.09). Caveat, the portal R1: on
      // ~50k-token inputs MiniMax once stalled >10s mid-stream while flash-lite
      // streamed steadily — flash-lite stays right behind it. No local qwen
      // (64k window too small).
      pool: [
        createMiniMaxEntry('minimax-m3-direct-summarize', 'MiniMax-M3', 1, 'low', 'text', true),
        createBackend2Entry('backend2-gemini-flash-lite-summarize', 'gemini-3.1-flash-lite', 2, 'low', 'text', true),
        createBackend2Entry('backend2-gemini-3-flash-summarize', 'gemini-3-flash', 3, 'low', 'text', true),
        createBackend2Entry('backend2-claude-sonnet-summarize', 'claude-sonnet-4-6', 4, 'low', 'text', true),
      ],
    },

    'text-uncensored-high': {
      id: 'text-uncensored-high',
      description: 'High-capability smart language model (uncensored / 18+ unrestricted)',
      modality: 'text',
      tier: 'high',
      censored: false,
      timeoutMs: 60_000,
      cooldownSec: 120,
      // Primary: MiniMax-M3 direct (verified uncensored with a spicy overlay,
      // thinking off). Fallback deepseek-v4.1-flash (ollama) is a stopgap for
      // the 5-day trial and self-retires 2026-09-25.
      pool: [
        createMiniMaxEntry('minimax-m3-direct-text-unc-high', 'MiniMax-M3', 1, 'high', 'text', false),
        createCloudEntry(
          'ollama-cloud-deepseek-flash-uncensored-high',
          'deepseek-v4.1-flash:cloud',
          2,
          'high',
          'text',
          false,
          undefined,
          '2026-09-25'
        ),
      ],
    },

    'text-uncensored-low': {
      id: 'text-uncensored-low',
      description: 'Fast language model (uncensored / 18+ unrestricted)',
      modality: 'text',
      tier: 'low',
      censored: false,
      timeoutMs: 45_000,
      cooldownSec: 120,
      // Primary: MiniMax-M3 direct. Fallback deepseek-v4.1-flash (ollama) is
      // a 5-day-trial stopgap and self-retires 2026-09-25.
      pool: [
        createMiniMaxEntry('minimax-m3-direct-text-unc-low', 'MiniMax-M3', 1, 'low', 'text', false),
        createCloudEntry(
          'ollama-cloud-deepseek-flash-uncensored-low',
          'deepseek-v4.1-flash:cloud',
          2,
          'low',
          'text',
          false,
          undefined,
          '2026-09-25'
        ),
      ],
    },

    'vision-high': {
      id: 'vision-high',
      description: 'High-capability multimodal vision model (censored/safe)',
      modality: 'vision',
      tier: 'high',
      censored: true,
      timeoutMs: 60_000,
      cooldownSec: 120,
      pool: [
        // MiniMax-M3 direct is the vision primary: ~2s and reads text well,
        // vs ~45s local qwen2.5vl when Gemini image is cooling down.
        createMiniMaxEntry('minimax-m3-direct-vision-high', 'MiniMax-M3', 1, 'high', 'vision', true),
        createBackend2Entry('backend2-gemini-flash-image', 'gemini-3.1-flash-image', 2, 'high', 'vision', true),
        // Auto-switching rule entry: selects an admitted vision model.
        createCloudRuleEntry(
          'ollama-cloud-minimax-m3-vision-high',
          {
            need: ['vision'],
            prefer: ['minimax-m3', 'minimax-m*', 'gemma*', 'kimi-k*'],
            take: 1,
          },
          3,
          'high',
          'vision',
          true
        ),
        // qwen2.5vl:7b on the shared RTX 3060 — full-size photos are ~3x slower,
        // and its Russian output garbles food names (buckwheat -> "bulgur") while
        // English is accurate (tested 2026-09-24).
        {
          ...createLocalEntry('local-qwen-vl-high', 'qwen2.5vl:7b', 4, 'high', 'vision', true),
          imageMaxSide: 1024,
          replyInEnglish: true,
        },
      ],
    },

    'vision-low': {
      id: 'vision-low',
      description: 'Fast, lightweight multimodal vision model (censored/safe)',
      modality: 'vision',
      tier: 'low',
      censored: true,
      timeoutMs: 45_000,
      cooldownSec: 120,
      pool: [
        createMiniMaxEntry('minimax-m3-direct-vision-low', 'MiniMax-M3', 1, 'low', 'vision', true),
        // qwen2.5vl:7b on the shared RTX 3060 — full-size photos are ~3x slower,
        // and its Russian output garbles food names (buckwheat -> "bulgur") while
        // English is accurate (tested 2026-09-24).
        {
          ...createLocalEntry('local-qwen-vl-low', 'qwen2.5vl:7b', 2, 'low', 'vision', true),
          imageMaxSide: 1024,
          replyInEnglish: true,
        },
        createBackend2Entry('backend2-gemini-flash-image-low', 'gemini-3.1-flash-image', 3, 'low', 'vision', true),
        // Auto-switching rule entry: selects an admitted vision model.
        createCloudRuleEntry(
          'ollama-cloud-minimax-m3-vision-low',
          {
            need: ['vision'],
            prefer: ['minimax-m3', 'minimax-m*', 'gemma*', 'kimi-k*'],
            take: 1,
          },
          4,
          'low',
          'vision',
          true
        ),
      ],
    },

    'vision-uncensored-high': {
      id: 'vision-uncensored-high',
      description: 'High-capability vision model (uncensored)',
      modality: 'vision',
      tier: 'high',
      censored: false,
      timeoutMs: 60_000,
      cooldownSec: 120,
      // Primary: MiniMax-M3 direct — with a spicy overlay it describes NSFW
      // images (the ollama.com-hosted minimax-m3 refuses even with overlay, so
      // it is only an availability fallback for safe images).
      pool: [
        createMiniMaxEntry('minimax-m3-direct-vision-unc-high', 'MiniMax-M3', 1, 'high', 'vision', false),
        createCloudEntry('ollama-cloud-minimax-m3-vision-unc-high', 'minimax-m3', 2, 'high', 'vision', false),
      ],
    },

    'vision-uncensored-low': {
      id: 'vision-uncensored-low',
      description: 'Fast vision model (uncensored)',
      modality: 'vision',
      tier: 'low',
      censored: false,
      timeoutMs: 45_000,
      cooldownSec: 120,
      // Primary: MiniMax-M3 direct (see vision-uncensored-high). ollama.com
      // minimax-m3 is an availability fallback only.
      pool: [
        createMiniMaxEntry('minimax-m3-direct-vision-unc-low', 'MiniMax-M3', 1, 'low', 'vision', false),
        createCloudEntry('ollama-cloud-minimax-m3-vision-unc-low', 'minimax-m3', 2, 'low', 'vision', false),
      ],
    },
  };
}

/**
 * Pools as configured (defaults + ROUTER_CONFIG_PATH), rule entries still as
 * rules. The catalog poller needs these: after expansion no `select` is left,
 * so it would find no rule and never fetch a catalog.
 */
export function loadRawLogicalModelConfigs(): Record<LogicalModelId, LogicalModelConfig> {
  const defaults = getDefaultLogicalModelConfigs();
  if (CONFIG.configPath && fs.existsSync(CONFIG.configPath)) {
    try {
      const fileData = fs.readFileSync(CONFIG.configPath, 'utf-8');
      const custom = JSON.parse(fileData) as Partial<Record<LogicalModelId, Partial<LogicalModelConfig>>>;
      for (const [key, val] of Object.entries(custom)) {
        const modelId = key as LogicalModelId;
        if (defaults[modelId] && val) {
          defaults[modelId] = {
            ...defaults[modelId],
            ...val,
            pool: (val.pool || defaults[modelId].pool).map((p) => ({
              ...p,
              params: {
                ...(p.provider === 'ollama-cloud' ? { reasoning_effort: 'none' } : {}),
                ...p.params,
              },
            })),
          };
        }
      }
    } catch (e) {
      console.error('[config] Failed to parse ROUTER_CONFIG_PATH, using defaults:', e);
    }
  }
  return defaults;
}

/** Pools with rule entries expanded against the in-memory catalog (hot path). */
export function loadLogicalModelConfigs(): Record<LogicalModelId, LogicalModelConfig> {
  const configs = loadRawLogicalModelConfigs();
  for (const config of Object.values(configs)) {
    config.pool = expandRuleEntries(config.pool, config);
  }
  return configs;
}

// Every entry of an embedding route MUST be the same model/dimension — vectors
// from different models are not comparable, so never add a different-model
// fallback; add a new logical id (e.g. text-embed-2) instead.
export function getEmbeddingModelConfigs(): Record<EmbeddingModelId, EmbeddingModelConfig> {
  return {
    'text-embed': {
      id: 'text-embed',
      description: 'Multilingual embedding model (bge-m3, 1024 dims)',
      dims: 1024,
      timeoutMs: 30_000,
      cooldownSec: 60,
      pool: [
        {
          id: 'local-bge-m3-embed',
          provider: 'ollama',
          model: 'bge-m3:latest',
          baseUrl: CONFIG.localOllamaBaseUrl,
          apiKeyEnv: process.env.ROUTER_LOCAL_KEY_ENV || process.env.PF_MODELS_KEY_ENV || undefined,
          priority: 1,
          weight: 1,
          enabled: true,
          tier: 'low',
          modality: 'text',
          censored: false,
        },
      ],
    },
  };
}

