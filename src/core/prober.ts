import { CONFIG } from '../config.js';
import { PoolEntry, ProbeMetrics, LogicalModelConfig } from '../types.js';
import { recordFailure, recordSuccess } from './cooldown.js';
import { resolveEntryKey } from './keys.js';

const probeMetricsMap = new Map<string, ProbeMetrics>();

export function getProbeMetrics(entryId: string): ProbeMetrics | undefined {
  return probeMetricsMap.get(entryId);
}

export function getAllProbeMetrics(): Record<string, ProbeMetrics> {
  const res: Record<string, ProbeMetrics> = {};
  for (const [k, v] of probeMetricsMap.entries()) {
    res[k] = v;
  }
  return res;
}

/**
 * A real request just succeeded on this entry: clear a stale "unhealthy" probe
 * verdict instead of keeping the entry demoted until the next probe cycle.
 */
export function markHealthyFromTraffic(entryId: string): void {
  const m = probeMetricsMap.get(entryId);
  if (m && !m.healthy) {
    probeMetricsMap.set(entryId, { ...m, healthy: true, consecutiveFailures: 0, lastError: undefined });
  }
}

export function setProbeMetrics(entryId: string, metrics: ProbeMetrics): void {
  probeMetricsMap.set(entryId, metrics);
}

/**
 * Executes a single speed/health probe against a physical backend entry.
 */
export async function probeEntry(
  entry: PoolEntry,
  timeoutMs: number = CONFIG.probeTimeoutMs
): Promise<ProbeMetrics> {
  const current = probeMetricsMap.get(entry.id) || {
    entryId: entry.id,
    lastChecked: 0,
    healthy: false,
    ttfbMs: 0,
    totalMs: 0,
    throughputTokensSec: 0,
    consecutiveSuccesses: 0,
    consecutiveFailures: 0,
  };

  const key = resolveEntryKey(entry);
  if (entry.apiKeyEnv && !key) {
    const updated: ProbeMetrics = {
      ...current,
      lastChecked: Date.now(),
      healthy: false,
      lastError: `Environment variable ${entry.apiKeyEnv} is not set`,
      consecutiveFailures: current.consecutiveFailures + 1,
      consecutiveSuccesses: 0,
    };
    probeMetricsMap.set(entry.id, updated);
    return updated;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`Probe timeout after ${timeoutMs}ms`)), timeoutMs);

  const startTime = Date.now();
  let ttfbMs = 0;

  try {
    const probePayload = {
      model: entry.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      temperature: 0.0,
      stream: true,
      ...(entry.params || {}),
    };

    const response = await fetch(`${entry.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(probePayload),
      signal: ac.signal,
    });

    // 429 = reachable but throttled. Marking it unhealthy would rank it below
    // every healthy fallback until the next probe (30 min on prod) — the probe
    // burst itself (all MiniMax entries at once) can trigger it.
    if (response.status === 429) {
      clearTimeout(timer);
      await response.body?.cancel().catch(() => {});
      const updated: ProbeMetrics = {
        ...current,
        entryId: entry.id,
        lastChecked: Date.now(),
        healthy: true,
        lastError: 'rate limited (429) — reachable, not counted as down',
      };
      probeMetricsMap.set(entry.id, updated);
      return updated;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    // Read first chunk to verify TTFB & stream viability
    if (response.body) {
      const reader = response.body.getReader();
      const firstChunk = await reader.read();
      ttfbMs = Date.now() - startTime;
      
      // Drain or cancel the rest
      await reader.cancel();
    } else {
      ttfbMs = Date.now() - startTime;
    }

    clearTimeout(timer);
    const totalMs = Date.now() - startTime;

    const updated: ProbeMetrics = {
      entryId: entry.id,
      lastChecked: Date.now(),
      healthy: true,
      ttfbMs: ttfbMs || totalMs,
      totalMs,
      throughputTokensSec: 1000 / Math.max(ttfbMs, 1),
      consecutiveSuccesses: current.consecutiveSuccesses + 1,
      consecutiveFailures: 0,
      lastError: undefined,
    };

    probeMetricsMap.set(entry.id, updated);
    return updated;
  } catch (err: unknown) {
    clearTimeout(timer);
    const errorMsg = err instanceof Error ? err.message : String(err);
    const updated: ProbeMetrics = {
      entryId: entry.id,
      lastChecked: Date.now(),
      healthy: false,
      ttfbMs: current.ttfbMs,
      totalMs: Date.now() - startTime,
      throughputTokensSec: 0,
      consecutiveFailures: current.consecutiveFailures + 1,
      consecutiveSuccesses: 0,
      lastError: errorMsg,
    };

    probeMetricsMap.set(entry.id, updated);
    return updated;
  }
}

/**
 * Runs a probe cycle over all enabled candidates across all configured logical routes.
 */
export async function runProbeCycle(
  routes: Record<string, LogicalModelConfig>
): Promise<Record<string, ProbeMetrics>> {
  const uniqueEntries = new Map<string, { entry: PoolEntry; routeId: string }>();

  for (const [routeId, config] of Object.entries(routes)) {
    for (const entry of config.pool) {
      if (entry.keyRef || entry.id.startsWith('byok:')) continue;
      if (entry.enabled !== false && !uniqueEntries.has(entry.id)) {
        uniqueEntries.set(entry.id, { entry, routeId });
      }
    }
  }

  const promises = Array.from(uniqueEntries.values()).map(async ({ entry, routeId }) => {
    const metrics = await probeEntry(entry);
    if (!metrics.healthy) {
      recordFailure(
        routeId,
        entry.id,
        routes[routeId]?.cooldownSec || 120,
        metrics.lastError || 'Probe failed'
      );
    } else if (metrics.consecutiveSuccesses >= 1) {
      recordSuccess(routeId, entry.id);
    }
    return metrics;
  });

  await Promise.allSettled(promises);
  return getAllProbeMetrics();
}

/**
 * Starts the proactive prober background loop.
 */
export function startProberLoop(
  getRoutes: () => Record<string, LogicalModelConfig>,
  intervalSeconds: number = CONFIG.probeIntervalSeconds
): { stop: () => void; runNow: () => Promise<Record<string, ProbeMetrics>> } {
  let timer: NodeJS.Timeout | undefined;

  const runNow = async () => {
    try {
      return await runProbeCycle(getRoutes());
    } catch (e) {
      console.error('[prober] Unexpected error during probe cycle:', e);
      return getAllProbeMetrics();
    }
  };

  timer = setInterval(runNow, Math.max(intervalSeconds, 5) * 1000);
  timer.unref();

  return {
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    runNow,
  };
}
