import { LogicalModelConfig, LogicalModelId, PoolEntry } from '../types.js';
import { isCoolingDown, getCooldownRecord } from './cooldown.js';
import { getProbeMetrics } from './prober.js';
import { isModelRetired } from './retirement.js';
import { resolveEntryKey } from './keys.js';

const bestCandidateCache = new Map<LogicalModelId, PoolEntry | null>();

/**
 * Returns true if the entry is runnable in this environment (e.g. required API key exists).
 */
export function isEntryRunnable(entry: PoolEntry): boolean {
  if (entry.enabled === false) return false;
  if (isModelRetired(entry.id)) return false;
  if (entry.apiKeyEnv) {
    const key = resolveEntryKey(entry);
    if (!key) return false;
  }
  return true;
}

/**
 * Ranks candidates for a logical route based on priority, probe TTFB latency, and health.
 */
export function rankCandidates(
  candidates: PoolEntry[],
  routeId: string
): { ready: PoolEntry[]; cooling: PoolEntry[] } {
  const ready: PoolEntry[] = [];
  const cooling: PoolEntry[] = [];

  for (const entry of candidates) {
    if (!isEntryRunnable(entry)) continue;

    const coolStatus = isCoolingDown(routeId, entry.id);
    if (coolStatus.cooling) {
      cooling.push(entry);
    } else {
      ready.push(entry);
    }
  }

  // Sort ready candidates:
  // 1. Probed healthy first
  // 2. Priority (1 is top)
  // 3. Lowest TTFB (if probed)
  ready.sort((a, b) => {
    const metricsA = getProbeMetrics(a.id);
    const metricsB = getProbeMetrics(b.id);

    const healthyA = metricsA ? metricsA.healthy : true;
    const healthyB = metricsB ? metricsB.healthy : true;

    if (healthyA !== healthyB) {
      return healthyA ? -1 : 1;
    }

    const prioA = a.priority ?? 99;
    const prioB = b.priority ?? 99;
    if (prioA !== prioB) {
      return prioA - prioB;
    }

    const ttfbA = metricsA && metricsA.ttfbMs > 0 ? metricsA.ttfbMs : 99999;
    const ttfbB = metricsB && metricsB.ttfbMs > 0 ? metricsB.ttfbMs : 99999;
    return ttfbA - ttfbB;
  });

  // Sort cooling candidates by oldest failed (closest to cooldown expiration)
  cooling.sort((a, b) => {
    const recA = getCooldownRecord(routeId, a.id);
    const recB = getCooldownRecord(routeId, b.id);
    return (recA?.cooldownUntil ?? 0) - (recB?.cooldownUntil ?? 0);
  });

  return { ready, cooling };
}

/**
 * Evaluates candidate pool and picks the pre-selected best candidate.
 */
export function selectBestCandidate(
  routeId: LogicalModelId,
  config: LogicalModelConfig
): PoolEntry | null {
  const pool = config.pool || [];
  const { ready, cooling } = rankCandidates(pool, routeId);

  if (ready.length > 0) {
    return ready[0];
  }

  if (cooling.length > 0) {
    return cooling[0];
  }

  return null;
}

/**
 * Returns the full ordered candidate list for failover execution.
 */
export function getOrderedCandidates(
  routeId: LogicalModelId,
  config: LogicalModelConfig
): PoolEntry[] {
  const pool = config.pool || [];
  const { ready, cooling } = rankCandidates(pool, routeId);
  return [...ready, ...cooling];
}

/**
 * Updates the in-memory pre-selection cache for all logical routes.
 */
export function updateAllPreselections(
  routes: Record<LogicalModelId, LogicalModelConfig>
): Map<LogicalModelId, PoolEntry | null> {
  for (const [id, config] of Object.entries(routes)) {
    const modelId = id as LogicalModelId;
    const best = selectBestCandidate(modelId, config);
    bestCandidateCache.set(modelId, best);
  }
  return bestCandidateCache;
}

export function resetPreselections(): void {
  bestCandidateCache.clear();
}

/**
 * Retrieves the currently pre-selected candidate for immediate live dispatch.
 */
export function getPreselectedCandidate(
  routeId: LogicalModelId,
  config?: LogicalModelConfig
): PoolEntry | null {
  // With a config, always re-rank (cheap, in-memory): a cached pick made while
  // higher-priority entries were cooling would otherwise stick until restart.
  if (config) {
    const newlySelected = selectBestCandidate(routeId, config);
    bestCandidateCache.set(routeId, newlySelected);
    return newlySelected;
  }

  return bestCandidateCache.get(routeId) ?? null;
}
