import { CatalogModelInfo, ProviderAdapter } from './types.js';

export const ollamaCloudAdapter: ProviderAdapter = {
  id: 'ollama-cloud',

  async listModels(baseUrl: string, key: string): Promise<CatalogModelInfo[]> {
    const cleanBase = baseUrl.replace(/\/+$/, '');
    const url = cleanBase.endsWith('/v1') ? `${cleanBase}/models` : `${cleanBase}/v1/models`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`ollama-cloud listModels failed: HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const json = (await res.json()) as { data?: Array<{ id?: string; created?: number }> };
    const list = Array.isArray(json?.data) ? json.data : [];

    return list.map((item) => ({
      id: String(item.id || '').replace(/:cloud$/, ''),
      created: typeof item.created === 'number' ? item.created : undefined,
      capabilities: [],
    }));
  },

  // POST /api/me is the cheapest authenticated call: 401 "invalid credentials"
  // for a bad key, 200 with the account (we keep only the plan) for a good one.
  async validateKey(baseUrl: string, key: string): Promise<{ plan?: string }> {
    const host = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    const res = await fetch(`${host}/api/me`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`ollama-cloud key rejected: HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    const json = (await res.json().catch(() => ({}))) as { Plan?: unknown };
    return { plan: typeof json.Plan === 'string' && json.Plan ? json.Plan : undefined };
  },

  async describeModel(baseUrl: string, key: string, id: string): Promise<Partial<CatalogModelInfo>> {
    const host = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    const url = `${host}/api/show`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: id }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`ollama-cloud describeModel failed: HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      capabilities?: string[];
      details?: { family?: string; parameter_size?: string | number };
      model_info?: Record<string, unknown>;
    };

    const capabilities = Array.isArray(json?.capabilities) ? json.capabilities : [];

    let contextLength: number | undefined;
    let parameterCount: number | undefined;

    if (json?.model_info && typeof json.model_info === 'object') {
      for (const [k, v] of Object.entries(json.model_info)) {
        if (k.endsWith('.context_length') && typeof v === 'number') {
          contextLength = v;
        }
        if (k.endsWith('.parameter_count') && typeof v === 'number') {
          parameterCount = v;
        }
      }
    }

    if (parameterCount === undefined && json?.details?.parameter_size !== undefined) {
      const parsed = parseInt(String(json.details.parameter_size), 10);
      if (!isNaN(parsed)) {
        parameterCount = parsed;
      }
    }

    const family = json?.details?.family || undefined;

    return {
      capabilities,
      contextLength,
      parameterCount,
      family,
    };
  },
};
