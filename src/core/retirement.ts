import { CONFIG } from '../config.js';
import { LogicalModelConfig, PoolEntry, RetirementAlert } from '../types.js';
import { resolveEntryKey } from './keys.js';

const retiredEntries = new Set<string>();
const retirementAlerts: RetirementAlert[] = [];

export function isModelRetired(entryId: string): boolean {
  return retiredEntries.has(entryId);
}

export function getRetirementAlerts(): RetirementAlert[] {
  return [...retirementAlerts];
}

export function markEntryRetired(
  entryId: string,
  physicalModel: string,
  reason: string
): RetirementAlert {
  retiredEntries.add(entryId);

  const existing = retirementAlerts.find((a) => a.entryId === entryId && a.active);
  if (existing) {
    existing.reason = reason;
    return existing;
  }

  const alert: RetirementAlert = {
    entryId,
    physicalModel,
    detectedAt: Date.now(),
    reason,
    active: true,
  };

  retirementAlerts.push(alert);
  console.warn(
    `[ROUTER_RETIREMENT_ALERT] Physical model ${physicalModel} (entry: ${entryId}) retired from active rotation: ${reason}`
  );
  return alert;
}

export function clearRetirementAlerts(): void {
  retiredEntries.clear();
  retirementAlerts.length = 0;
}

/**
 * Queries Ollama's model catalogue to check available model tags.
 */
export async function fetchOllamaAvailableModels(apiKey?: string): Promise<string[] | null> {
  const key = apiKey !== undefined ? apiKey : process.env.OLLAMA_API_KEY;
  const url = `${CONFIG.cloudBaseUrl.replace(/\/$/, '')}/models`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);

  try {
    const res = await fetch(url, {
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: ac.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[retirement] Ollama models check returned HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    if (Array.isArray(data?.data)) {
      return data.data.map((m) => m.id || '').filter(Boolean);
    }
    return null;
  } catch (err) {
    clearTimeout(timer);
    console.warn('[retirement] Could not fetch models from Ollama catalog:', err);
    return null;
  }
}

/**
 * Checks all configured pool entries against known retirement dates and upstream availability.
 */
export async function checkRetirements(
  routes: Record<string, LogicalModelConfig>
): Promise<RetirementAlert[]> {
  const uniqueEntries = new Map<string, PoolEntry>();
  for (const config of Object.values(routes)) {
    for (const entry of config.pool) {
      if (!uniqueEntries.has(entry.id)) {
        uniqueEntries.set(entry.id, entry);
      }
    }
  }

  const now = new Date();

  // 1. Check configured retirement dates
  for (const entry of uniqueEntries.values()) {
    if (entry.fromRule) continue;
    if (entry.retirementDate) {
      const retireDate = new Date(entry.retirementDate);
      if (!isNaN(retireDate.getTime()) && now >= retireDate) {
        markEntryRetired(
          entry.id,
          entry.model,
          `Configured retirement date reached (${entry.retirementDate})`
        );
      }
    }
  }

  // 2. Check Ollama online catalog if accessible
  const ollamaEntry = Array.from(uniqueEntries.values()).find(
    (e) => e.provider === 'ollama-cloud' && !e.fromRule
  );
  const apiKey = ollamaEntry ? resolveEntryKey(ollamaEntry) : process.env.OLLAMA_API_KEY;
  const availableOllamaModels = await fetchOllamaAvailableModels(apiKey);
  if (availableOllamaModels && availableOllamaModels.length > 0) {
    for (const entry of uniqueEntries.values()) {
      if (entry.fromRule) continue;
      if (entry.provider === 'ollama-cloud') {
        const cleanEntryModel = entry.model.replace(/:cloud$/, '');
        const found = availableOllamaModels.some(
          (m) => m.replace(/:cloud$/, '') === cleanEntryModel
        );
        if (!found) {
          markEntryRetired(
            entry.id,
            entry.model,
            `Model ${entry.model} no longer present in upstream Ollama catalog`
          );
        }
      }
    }
  }

  return getRetirementAlerts();
}

/**
 * Starts background retirement checker loop.
 */
export function startRetirementCheckerLoop(
  getRoutes: () => Record<string, LogicalModelConfig>,
  intervalSeconds: number = CONFIG.retirementCheckIntervalSeconds
): { stop: () => void; checkNow: () => Promise<RetirementAlert[]> } {
  let timer: NodeJS.Timeout | undefined;

  const checkNow = async () => {
    try {
      return await checkRetirements(getRoutes());
    } catch (e) {
      console.error('[retirement] Unexpected error checking model retirements:', e);
      return getRetirementAlerts();
    }
  };

  // Run initial check
  checkNow();

  timer = setInterval(checkNow, Math.max(intervalSeconds, 60) * 1000);
  timer.unref();

  return {
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    checkNow,
  };
}
