import type { BudgetStatus } from './core/budget.js';
import type { LoopGuardStatus } from './core/loop-guard.js';
import type { ClientMetadataStatus } from './core/client-meta.js';

export type Modality = 'text' | 'vision';
export type Tier = 'high' | 'low';
export type Censorship = 'censored' | 'uncensored';

export type LogicalModelId =
  | 'text-high'
  | 'text-high-think'
  | 'text-low'
  | 'text-summarize'
  | 'text-uncensored-high'
  | 'text-uncensored-low'
  | 'vision-high'
  | 'vision-low'
  | 'vision-uncensored-high'
  | 'vision-uncensored-low';

export const LOGICAL_MODEL_IDS: readonly LogicalModelId[] = [
  'text-high',
  'text-high-think',
  'text-low',
  'text-summarize',
  'text-uncensored-high',
  'text-uncensored-low',
  'vision-high',
  'vision-low',
  'vision-uncensored-high',
  'vision-uncensored-low',
] as const;

export type ModelProvider = 'ollama' | 'ollama-cloud' | 'custom' | 'openai';

export interface SelectRule {
  need?: Array<'tools' | 'vision' | 'thinking'>; // required capabilities
  minContext?: number;
  prefer: string[];   // glob patterns (* wildcard, case-insensitive), in order of preference, e.g. 'deepseek-*-flash*'
  exclude?: string[]; // glob patterns
  take?: number;      // how many matching models to put into the pool (default 1)
}

export interface PoolEntry {
  id: string;
  provider: ModelProvider;
  model: string;
  baseUrl: string;
  apiKeyEnv?: string;
  keyRef?: { tenantId: string; provider: 'ollama-cloud' | 'openai' };
  priority: number;
  weight?: number;
  enabled: boolean;
  tier: Tier;
  modality: Modality;
  censored: boolean;
  budgetGroup?: string;
  params?: Record<string, unknown>;
  retirementDate?: string;
  imageMaxSide?: number; // downscale inline (data:) images so the longest side <= N px before sending to this entry
  replyInEnglish?: boolean; // append an "answer in English" instruction to the last user message (model is weak in other languages)
  select?: SelectRule;
  fromRule?: string;
  reasoningEfforts?: string[];
  contextLength?: number;
}

export interface LogicalModelConfig {
  id: LogicalModelId;
  description: string;
  modality: Modality;
  tier: Tier;
  censored: boolean;
  pool: PoolEntry[];
  timeoutMs: number;
  cooldownSec: number;
}

export type EmbeddingModelId = 'text-embed';
export const EMBEDDING_MODEL_IDS = ['text-embed'] as const;

export interface EmbeddingModelConfig {
  id: EmbeddingModelId;
  description: string;
  dims: number;
  timeoutMs: number;
  cooldownSec: number;
  pool: PoolEntry[];
}

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: string;
  user?: string;
  [key: string]: unknown;
}

export interface ProbeMetrics {
  entryId: string;
  lastChecked: number;
  healthy: boolean;
  ttfbMs: number;
  totalMs: number;
  throughputTokensSec: number;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  lastError?: string;
}

export interface CooldownRecord {
  failedAt: number;
  cooldownUntil: number;
  reason?: string;
}

export interface RetirementAlert {
  entryId: string;
  physicalModel: string;
  detectedAt: number;
  reason: string;
  active: boolean;
}

export interface TenantContext {
  tenantId: string;
  isMaster?: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  name?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  stream_options?: { include_usage?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ChatCompletionResponseChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
  };
  finish_reason: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionResponseChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: {
    role?: string;
    content?: string | null;
  };
  finish_reason: string | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
}

export interface OpenAIModelItem {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  permission: unknown[];
  root: string;
  parent: null;
}

export interface OpenAIModelsResponse {
  object: 'list';
  data: OpenAIModelItem[];
}

export interface AdminStatusResponse {
  uptimeSeconds: number;
  serverTime: string;
  logicalModels: Record<
    string,
    {
      selectedCandidate: {
        id: string;
        model: string;
        provider: string;
        baseUrl: string;
        tier: string;
        ttfbMs: number;
      } | null;
      candidates: Array<{
        id: string;
        model: string;
        provider: string;
        baseUrl: string;
        priority: number;
        enabled: boolean;
        cooling: boolean;
        cooldownRemainingSec: number;
        healthy: boolean;
        ttfbMs: number;
        lastError?: string;
      }>;
    }
  >;
  retirementAlerts: RetirementAlert[];
  cooldowns: Record<string, { cooling: boolean; remainingSec: number; reason?: string }>;
  probeMetrics: Record<string, ProbeMetrics>;
  requestStats: {
    totalRequests: number;
    streamingRequests: number;
    failedRequests: number;
    failoversCount: number;
    tenantsSeen: string[];
  };
  budget: BudgetStatus;
  loopGuard: LoopGuardStatus;
  clientMetadata: ClientMetadataStatus;
}
