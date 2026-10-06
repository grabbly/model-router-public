import { ollamaCloudAdapter } from './ollama-cloud.js';
import { openaiAdapter } from './openai.js';
import { ProviderAdapter } from './types.js';

export * from './types.js';
export { ollamaCloudAdapter } from './ollama-cloud.js';
export { openaiAdapter } from './openai.js';

const adapters: Record<string, ProviderAdapter> = {
  'ollama-cloud': ollamaCloudAdapter,
  'openai': openaiAdapter,
};

export function getProviderAdapter(provider: string): ProviderAdapter | undefined {
  return adapters[provider];
}
