import { CONFIG } from '../../config.js';
import { globMatch } from '../rules.js';
import { CatalogModelInfo, ProviderAdapter } from './types.js';

export const OPENAI_CHAT_ID_POSITIVE_REGEX = /^(?:gpt-|o\d|chatgpt-)/i;
export const OPENAI_CHAT_ID_NEGATIVE_REGEX =
  /(?:audio|realtime|tts|transcribe|whisper|image|dall-e|search|embedding|moderation|instruct|codex)/i;

export function isOpenAiChatModel(id: string): boolean {
  return (
    OPENAI_CHAT_ID_POSITIVE_REGEX.test(id) &&
    !OPENAI_CHAT_ID_NEGATIVE_REGEX.test(id)
  );
}

export const OPENAI_CAPABILITY_TABLE: Array<{ pattern: string; capabilities: string[] }> = [
  { pattern: 'o3*', capabilities: ['completion', 'tools', 'thinking', 'vision'] },
  { pattern: 'o4*', capabilities: ['completion', 'tools', 'thinking', 'vision'] },
  { pattern: 'o1*', capabilities: ['completion', 'tools', 'thinking'] },
  { pattern: 'gpt-5*', capabilities: ['completion', 'tools', 'vision'] },
  { pattern: 'gpt-4.1*', capabilities: ['completion', 'tools', 'vision'] },
  { pattern: 'gpt-4o*', capabilities: ['completion', 'tools', 'vision'] },
  { pattern: 'chatgpt-4o*', capabilities: ['completion', 'tools', 'vision'] },
  { pattern: 'gpt-3.5*', capabilities: ['completion', 'tools'] },
];

export function resolveOpenAiCapabilities(modelId: string): string[] {
  for (const rule of OPENAI_CAPABILITY_TABLE) {
    if (globMatch(rule.pattern, modelId)) {
      return [...rule.capabilities];
    }
  }
  return ['completion'];
}

function normalizeModelsUrl(baseUrl: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  return cleanBase.endsWith('/v1') ? `${cleanBase}/models` : `${cleanBase}/v1/models`;
}

export const openaiAdapter: ProviderAdapter = {
  id: 'openai',

  async listModels(baseUrl: string, key: string): Promise<CatalogModelInfo[]> {
    const url = normalizeModelsUrl(baseUrl || CONFIG.openaiBaseUrl);

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`openai listModels failed: HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const json = (await res.json()) as { data?: Array<{ id?: string; created?: number }> };
    const list = Array.isArray(json?.data) ? json.data : [];

    return list
      .filter((item) => item.id && isOpenAiChatModel(item.id))
      .map((item) => {
        const id = String(item.id);
        return {
          id,
          created: typeof item.created === 'number' ? item.created : undefined,
          capabilities: resolveOpenAiCapabilities(id),
        };
      });
  },

  async validateKey(baseUrl: string, key: string): Promise<{ plan?: string }> {
    const url = normalizeModelsUrl(baseUrl || CONFIG.openaiBaseUrl);
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`openai key rejected: HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    return {};
  },
};
