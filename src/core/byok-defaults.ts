import { CONFIG, loadRawLogicalModelConfigs } from '../config.js';
import { expandRuleEntries } from './rules.js';
import { getTenant } from './tenants.js';
import { LogicalModelConfig, LogicalModelId, PoolEntry } from '../types.js';

function getOllamaCloudByokDefaultRules(logicalId: LogicalModelId): PoolEntry[] {
  switch (logicalId) {
    case 'text-high':
    case 'text-high-think':
      return [
        {
          id: 'byok-default-text-high',
          provider: 'ollama-cloud',
          model: 'deepseek-v4.1-flash',
          baseUrl: CONFIG.cloudBaseUrl,
          priority: 1,
          weight: 1,
          enabled: true,
          tier: 'high',
          modality: 'text',
          censored: true,
          params: { reasoning_effort: 'none' },
          select: {
            need: ['tools'],
            minContext: 64000,
            prefer: ['deepseek-*-flash*', 'glm-*', 'kimi-k*', 'gpt-oss:120b', 'qwen*'],
            exclude: ['*-code*'],
            take: 3,
          },
        },
      ];

    case 'text-low':
      return [
        {
          id: 'byok-default-text-low',
          provider: 'ollama-cloud',
          model: 'gpt-oss:20b',
          baseUrl: CONFIG.cloudBaseUrl,
          priority: 1,
          weight: 1,
          enabled: true,
          tier: 'low',
          modality: 'text',
          censored: true,
          params: { reasoning_effort: 'none' },
          select: {
            prefer: ['gpt-oss:20b', 'glm-*-flash*', 'deepseek-*-flash*', 'gemma*', 'nemotron-*-nano*'],
            take: 3,
          },
        },
      ];

    case 'text-summarize':
      return [
        {
          id: 'byok-default-text-summarize',
          provider: 'ollama-cloud',
          model: 'deepseek-v4.1-flash',
          baseUrl: CONFIG.cloudBaseUrl,
          priority: 1,
          weight: 1,
          enabled: true,
          tier: 'low',
          modality: 'text',
          censored: true,
          params: { reasoning_effort: 'none' },
          select: {
            minContext: 128000,
            prefer: ['deepseek-*-flash*', 'glm-*-flash*', 'gemma*', 'kimi-k*'],
            take: 2,
          },
        },
      ];

    case 'vision-high':
      return [
        {
          id: 'byok-default-vision-high',
          provider: 'ollama-cloud',
          model: 'minimax-m3',
          baseUrl: CONFIG.cloudBaseUrl,
          priority: 1,
          weight: 1,
          enabled: true,
          tier: 'high',
          modality: 'vision',
          censored: true,
          params: { reasoning_effort: 'none' },
          select: {
            need: ['vision'],
            prefer: ['minimax-m*', 'gemma*', 'kimi-k*', 'deepseek-*-flash*'],
            take: 2,
          },
        },
      ];

    case 'vision-low':
      return [
        {
          id: 'byok-default-vision-low',
          provider: 'ollama-cloud',
          model: 'minimax-m3',
          baseUrl: CONFIG.cloudBaseUrl,
          priority: 1,
          weight: 1,
          enabled: true,
          tier: 'low',
          modality: 'vision',
          censored: true,
          params: { reasoning_effort: 'none' },
          select: {
            need: ['vision'],
            prefer: ['minimax-m*', 'gemma*', 'kimi-k*', 'deepseek-*-flash*'],
            take: 2,
          },
        },
      ];

    case 'text-uncensored-high':
    case 'text-uncensored-low':
    case 'vision-uncensored-high':
    case 'vision-uncensored-low':
    default:
      return [];
  }
}

function getOpenAiByokDefaultRules(logicalId: LogicalModelId): PoolEntry[] {
  switch (logicalId) {
    case 'text-high':
    case 'text-high-think':
      return [
        {
          id: 'byok-default-openai-text-high',
          provider: 'openai',
          model: 'gpt-5',
          baseUrl: CONFIG.openaiBaseUrl,
          priority: 1,
          weight: 1,
          enabled: true,
          tier: 'high',
          modality: 'text',
          censored: true,
          select: {
            need: ['tools'],
            prefer: ['gpt-5*', 'gpt-4.1', 'gpt-4o'],
            exclude: ['*-mini*', '*-nano*'],
            take: 2,
          },
        },
      ];

    case 'text-low':
      return [
        {
          id: 'byok-default-openai-text-low',
          provider: 'openai',
          model: 'gpt-5-mini',
          baseUrl: CONFIG.openaiBaseUrl,
          priority: 1,
          weight: 1,
          enabled: true,
          tier: 'low',
          modality: 'text',
          censored: true,
          select: {
            prefer: ['gpt-5*-mini*', 'gpt-4.1-mini*', 'gpt-4o-mini*'],
            take: 2,
          },
        },
      ];

    case 'text-summarize':
      return [
        {
          id: 'byok-default-openai-text-summarize',
          provider: 'openai',
          model: 'gpt-5-mini',
          baseUrl: CONFIG.openaiBaseUrl,
          priority: 1,
          weight: 1,
          enabled: true,
          tier: 'low',
          modality: 'text',
          censored: true,
          select: {
            prefer: ['gpt-5*-mini*', 'gpt-4.1-mini*', 'gpt-4o-mini*'],
            take: 2,
          },
        },
      ];

    case 'vision-high':
      return [
        {
          id: 'byok-default-openai-vision-high',
          provider: 'openai',
          model: 'gpt-5',
          baseUrl: CONFIG.openaiBaseUrl,
          priority: 1,
          weight: 1,
          enabled: true,
          tier: 'high',
          modality: 'vision',
          censored: true,
          select: {
            need: ['vision'],
            prefer: ['gpt-5*', 'gpt-4.1', 'gpt-4o'],
            exclude: ['*-mini*', '*-nano*'],
            take: 2,
          },
        },
      ];

    case 'vision-low':
      return [
        {
          id: 'byok-default-openai-vision-low',
          provider: 'openai',
          model: 'gpt-5-mini',
          baseUrl: CONFIG.openaiBaseUrl,
          priority: 1,
          weight: 1,
          enabled: true,
          tier: 'low',
          modality: 'vision',
          censored: true,
          select: {
            need: ['vision'],
            prefer: ['gpt-5*-mini*', 'gpt-4.1-mini*', 'gpt-4o-mini*'],
            take: 2,
          },
        },
      ];

    case 'text-uncensored-high':
    case 'text-uncensored-low':
    case 'vision-uncensored-high':
    case 'vision-uncensored-low':
    default:
      return [];
  }
}

/**
 * Returns default BYOK rules for a logical route (censored routes only).
 * Uncensored routes return empty array by owner decision.
 */
export function getByokDefaultRules(
  logicalId: LogicalModelId,
  provider: 'ollama-cloud' | 'openai' = 'ollama-cloud'
): PoolEntry[] {
  if (provider === 'openai') {
    return getOpenAiByokDefaultRules(logicalId);
  }
  return getOllamaCloudByokDefaultRules(logicalId);
}

/**
 * Returns raw route config for a tenant (rule entries with select intact).
 */
export function getRawTenantRouteConfig(
  tenantId: string,
  logicalId: LogicalModelId,
  baseConfig?: LogicalModelConfig
): LogicalModelConfig {
  const base = baseConfig || loadRawLogicalModelConfigs()[logicalId] || {
    tier: 'high' as const,
    modality: 'text' as const,
    censored: !logicalId.includes('uncensored'),
    pool: [],
  };
  const tenant = getTenant(tenantId);
  if (!tenant || tenant.mode !== 'byok') {
    return base;
  }

  let rawEntries: PoolEntry[];
  if (tenant.pools?.[logicalId]) {
    rawEntries = tenant.pools[logicalId];
  } else {
    const hasOllama = !!tenant.upstreamKeys?.['ollama-cloud'];
    const hasOpenai = !!tenant.upstreamKeys?.['openai'];

    if (hasOllama && hasOpenai) {
      const order =
        tenant.providerOrder && tenant.providerOrder.length > 0
          ? tenant.providerOrder
          : (['ollama-cloud', 'openai'] as const);
      rawEntries = [];
      let priorityCounter = 1;
      for (const prov of order) {
        if (prov === 'ollama-cloud' && hasOllama) {
          const rules = getByokDefaultRules(logicalId, 'ollama-cloud');
          for (const r of rules) {
            rawEntries.push({ ...r, priority: priorityCounter++ });
          }
        } else if (prov === 'openai' && hasOpenai) {
          const rules = getByokDefaultRules(logicalId, 'openai');
          for (const r of rules) {
            rawEntries.push({ ...r, priority: priorityCounter++ });
          }
        }
      }
    } else if (hasOpenai) {
      rawEntries = getByokDefaultRules(logicalId, 'openai');
    } else {
      rawEntries = getByokDefaultRules(logicalId, 'ollama-cloud');
    }
  }

  const boundEntries: PoolEntry[] = rawEntries.map((raw) => {
    const origId = raw.id.startsWith(`byok:${tenantId}:`)
      ? raw.id.slice(`byok:${tenantId}:`.length)
      : raw.id;
    const provider = (raw.provider || 'ollama-cloud') as 'ollama-cloud' | 'openai';
    // Fixed provider URLs only, whatever the record says: a client-set URL
    // would let the router be pointed at internal hosts (SSRF).
    const baseUrl = provider === 'ollama-cloud' ? CONFIG.cloudBaseUrl : CONFIG.openaiBaseUrl;

    const bound: PoolEntry = {
      ...raw,
      id: `byok:${tenantId}:${origId}`,
      provider,
      keyRef: { tenantId, provider },
      baseUrl,
      priority: raw.priority,
      enabled: raw.enabled !== false,
      tier: base.tier,
      modality: base.modality,
      censored: base.censored,
    };
    delete bound.budgetGroup;
    delete bound.apiKeyEnv;
    return bound;
  });

  return {
    ...base,
    pool: boundEntries,
  };
}

/**
 * For a BYOK tenant returns a copy of the route config whose pool is tenant
 * pools[logicalId] if set, else BYOK default rules; entries are bound to the
 * tenant key: id = byok:<tenantId>:<original id>, keyRef = { tenantId, provider },
 * baseUrl from CONFIG, no budgetGroup. Rule entries are expanded against the
 * tenant's catalog.
 */
export function getTenantRouteConfig(
  tenantId: string,
  logicalId: LogicalModelId,
  baseConfig?: LogicalModelConfig
): LogicalModelConfig {
  const rawConfig = getRawTenantRouteConfig(tenantId, logicalId, baseConfig);
  if (baseConfig && rawConfig === baseConfig) {
    return baseConfig;
  }

  return {
    ...rawConfig,
    pool: expandRuleEntries(rawConfig.pool, rawConfig),
  };
}
