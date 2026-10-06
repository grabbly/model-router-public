export interface CatalogModelInfo {
  id: string;
  created?: number;
  capabilities: string[];
  contextLength?: number;
  parameterCount?: number;
  family?: string;
}

export interface ProviderAdapter {
  id: 'ollama-cloud' | 'openai';
  listModels(baseUrl: string, key: string): Promise<CatalogModelInfo[]>; // ids + created
  describeModel?(baseUrl: string, key: string, id: string): Promise<Partial<CatalogModelInfo>>; // capabilities etc
  /**
   * Proves the key is accepted by the provider. listModels is NOT proof:
   * ollama.com serves /v1/models, /api/tags and /api/show without any key.
   * Resolves with the plan name when the provider reports one; throws on a bad key.
   */
  validateKey(baseUrl: string, key: string): Promise<{ plan?: string }>;
}
