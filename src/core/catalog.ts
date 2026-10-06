import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, loadRawLogicalModelConfigs } from '../config.js';
import { LogicalModelConfig, LogicalModelId, LOGICAL_MODEL_IDS, PoolEntry } from '../types.js';
import {
  admissionProbeQueue,
  runCompletionProbe,
  runToolsProbe,
  runVisionProbe,
} from './admission.js';
import { emitRouterEvent } from './events.js';
import { keyFingerprint, resolveEntryKey } from './keys.js';
import { getProviderAdapter } from './providers/index.js';
import { globMatch } from './rules.js';
import { listTenants, upsertTenant, UpstreamKeyProvider } from './tenants.js';
import { getRawTenantRouteConfig } from './byok-defaults.js';

export interface CatalogAdmissionRecord {
  status: 'admitted' | 'rejected' | 'pending';
  at: number;
  reason?: string;
  checks?: {
    completion?: boolean;
    tools?: boolean;
    vision?: boolean;
  };
}

export interface CatalogModelRecord {
  created?: number;
  capabilities: string[];
  contextLength?: number;
  parameterCount?: number;
  family?: string;
  firstSeen: number;
  lastSeen: number;
  missingSince?: number;
  describedAt?: number;
  admission?: CatalogAdmissionRecord;
  manual?: 'admit' | 'block';
}

export interface CatalogData {
  provider: string;
  baseUrl: string;
  fp: string;
  fetchedAt: number;
  models: Record<string, CatalogModelRecord>;
}

const catalogMap = new Map<string, CatalogData>();
const debouncedTimers = new Map<string, NodeJS.Timeout>();
let pollerTimer: NodeJS.Timeout | undefined;

function getCatalogDir(): string {
  const base = process.env.ROUTER_STATE_DIR || './data';
  return path.join(base, 'catalog');
}

function getCatalogFilePath(provider: string, fp: string): string {
  return path.join(getCatalogDir(), `${provider}-${fp}.json`);
}

/**
 * Loads all catalog files from disk into memory synchronously.
 */
export function loadCatalogsFromDiskSync(): void {
  const dir = getCatalogDir();
  if (!fs.existsSync(dir)) return;

  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        const data = JSON.parse(content) as CatalogData;
        if (data && data.provider && data.fp && data.models) {
          const key = `${data.provider}-${data.fp}`;
          catalogMap.set(key, data);
        }
      } catch (e) {
        console.warn(`[catalog] Failed to read catalog file ${file}:`, e);
      }
    }
  } catch (err) {
    console.warn('[catalog] Failed to list catalog directory:', err);
  }
}

// Initial load on module load
loadCatalogsFromDiskSync();

/**
 * Atomically writes catalog data to disk.
 * Never stores the key itself.
 */
export function saveCatalogSync(provider: string, fp: string): void {
  const key = `${provider}-${fp}`;
  const data = catalogMap.get(key);
  if (!data) return;

  const dir = getCatalogDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const filePath = getCatalogFilePath(provider, fp);
  const tmpPath = `${filePath}.tmp`;

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error(`[catalog] Failed to atomically save catalog ${key}:`, err);
  }
}

export function getCatalog(provider: string, fp: string): CatalogData | undefined {
  return catalogMap.get(`${provider}-${fp}`);
}

export function getCatalogModel(
  provider: string,
  fp: string,
  modelId: string
): CatalogModelRecord | undefined {
  const cat = getCatalog(provider, fp);
  if (!cat || !cat.models) return undefined;
  const cleanId = modelId.replace(/:cloud$/, '');
  return cat.models[cleanId];
}

export function getAllCatalogs(): CatalogData[] {
  return Array.from(catalogMap.values());
}

export function clearCatalogsForTests(): void {
  catalogMap.clear();
  for (const t of debouncedTimers.values()) {
    clearTimeout(t);
  }
  debouncedTimers.clear();
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = undefined;
  }
}

export function setCatalogForTests(cat: CatalogData): void {
  catalogMap.set(`${cat.provider}-${cat.fp}`, cat);
}

/**
 * Admin manual overrides: admit, block, reset.
 */
export function setModelManual(
  catalogId: string,
  model: string,
  manual: 'admit' | 'block'
): boolean {
  const cat = catalogMap.get(catalogId);
  if (!cat) return false;
  const cleanId = model.replace(/:cloud$/, '');
  const rec = cat.models[cleanId];
  if (!rec) return false;

  rec.manual = manual;
  saveCatalogSync(cat.provider, cat.fp);
  return true;
}

export function resetModelManual(catalogId: string, model: string): boolean {
  const cat = catalogMap.get(catalogId);
  if (!cat) return false;
  const cleanId = model.replace(/:cloud$/, '');
  const rec = cat.models[cleanId];
  if (!rec) return false;

  delete rec.manual;
  delete rec.admission;
  saveCatalogSync(cat.provider, cat.fp);

  // Trigger admission re-evaluation in background
  triggerAdmissionProbes(loadRawLogicalModelConfigs());
  return true;
}

/**
 * Finds all active rules matching a provider and key fingerprint.
 */
function findRulesForCatalog(
  routes: Record<string, LogicalModelConfig>,
  provider: string,
  fp: string
): PoolEntry[] {
  const result: PoolEntry[] = [];
  for (const route of Object.values(routes)) {
    if (route.censored !== true) continue;
    for (const entry of route.pool) {
      if (!entry.select || entry.provider !== provider) continue;
      const key = resolveEntryKey(entry);
      if (key && keyFingerprint(key) === fp) {
        result.push(entry);
      }
    }
  }

  // Also check all active BYOK tenants for rules matching this provider and key fingerprint
  const tenants = listTenants();
  for (const tenant of tenants) {
    if (tenant.mode !== 'byok' || tenant.status === 'disabled') continue;
    const keyInfo = tenant.upstreamKeys?.[provider as 'ollama-cloud' | 'openai'];
    if (!keyInfo || keyInfo.status === 'invalid' || keyInfo.fp !== fp) continue;

    for (const logicalId of LOGICAL_MODEL_IDS) {
      const baseCfg = routes[logicalId];
      if (!baseCfg || baseCfg.censored !== true) continue;
      const rawCfg = getRawTenantRouteConfig(tenant.id, logicalId, baseCfg);
      for (const entry of rawCfg.pool) {
        if (!entry.select || entry.provider !== provider) continue;
        const key = resolveEntryKey(entry);
        if (key && keyFingerprint(key) === fp) {
          result.push(entry);
        }
      }
    }
  }

  return result;
}

/**
 * Refreshes a single catalog from upstream.
 */
export async function refreshCatalog(
  provider: string,
  baseUrl: string,
  key: string,
  routes?: Record<string, LogicalModelConfig>
): Promise<CatalogData> {
  const fp = keyFingerprint(key);
  const catKey = `${provider}-${fp}`;

  let existing = catalogMap.get(catKey);
  const isFirstFetch = !existing || (existing.fetchedAt === 0 && Object.keys(existing.models).length === 0);

  if (!existing) {
    existing = {
      provider,
      baseUrl,
      fp,
      fetchedAt: 0,
      models: {},
    };
    catalogMap.set(catKey, existing);
  }

  const adapter = getProviderAdapter(provider);
  if (!adapter) {
    throw new Error(`[catalog] No adapter registered for provider "${provider}"`);
  }

  // 1. List models
  let list;
  try {
    list = await adapter.listModels(baseUrl, key);
  } catch (err) {
    console.warn(`[catalog] Failed to list models for ${catKey}:`, err);
    // A failed list call changes nothing (never treat an outage as "all models gone")
    return existing;
  }

  const now = Date.now();
  const returnedIds = new Set<string>();

  for (const item of list) {
    const cleanId = item.id.replace(/:cloud$/, '');
    returnedIds.add(cleanId);

    const prev = existing.models[cleanId];
    if (!prev) {
      existing.models[cleanId] = {
        created: item.created,
        capabilities: item.capabilities || [],
        firstSeen: now,
        lastSeen: now,
      };
      if (!isFirstFetch) {
        emitRouterEvent({
          type: 'catalog.model-added',
          provider,
          fp,
          model: cleanId,
        });
      }
    } else {
      prev.lastSeen = now;
      if (item.created !== undefined) {
        prev.created = item.created;
      }
      if (prev.missingSince) {
        delete prev.missingSince;
      }
    }
  }

  // Check models missing from list
  for (const [mId, m] of Object.entries(existing.models)) {
    if (!returnedIds.has(mId)) {
      if (!m.missingSince) {
        m.missingSince = now;
        emitRouterEvent({
          type: 'catalog.model-removed',
          provider,
          fp,
          model: mId,
        });
      }
    }
  }

  // 2. Describe new / stale models
  if (adapter.describeModel) {
    for (const [mId, m] of Object.entries(existing.models)) {
      if (m.missingSince) continue;
      const needsDescribe = !m.describedAt || now - m.describedAt >= 24 * 3600 * 1000;
      if (needsDescribe) {
        try {
          const desc = await adapter.describeModel(baseUrl, key, mId);
          if (desc.capabilities) m.capabilities = desc.capabilities;
          if (desc.contextLength !== undefined) m.contextLength = desc.contextLength;
          if (desc.parameterCount !== undefined) m.parameterCount = desc.parameterCount;
          if (desc.family !== undefined) m.family = desc.family;
          m.describedAt = now;
        } catch (err) {
          console.warn(`[catalog] describeModel failed for ${mId}:`, err);
        }
      }
    }
  }

  // 3. Pre-admission of exact first prefer pattern
  const activeRoutes = routes || loadRawLogicalModelConfigs();
  const rules = findRulesForCatalog(activeRoutes, provider, fp);

  for (const ruleEntry of rules) {
    const rule = ruleEntry.select!;
    const firstPrefer = rule.prefer[0];
    if (firstPrefer && !firstPrefer.includes('*')) {
      const targetId = firstPrefer.replace(/:cloud$/, '');
      const rec = existing.models[targetId];
      // Only a model with no verdict yet: never flip a rejection (e.g. a 402
      // "not in your plan" seen in traffic) back to admitted on each refresh.
      if (rec && rec.manual !== 'block' && (!rec.admission || rec.admission.status === 'pending')) {
        rec.admission = {
          status: 'admitted',
          at: now,
          checks: { completion: true },
        };
      }
    }
  }

  // 4. Mark candidate models for rules as pending probe if needed
  for (const ruleEntry of rules) {
    const rule = ruleEntry.select!;
    for (const [mId, m] of Object.entries(existing.models)) {
      if (m.missingSince || m.manual === 'block' || m.manual === 'admit') continue;
      if (m.admission?.status === 'admitted') continue;

      // Check if matches prefer and not excluded
      const matchesPrefer = rule.prefer.some((pat) => globMatch(pat, mId));
      if (!matchesPrefer) continue;
      if (rule.exclude && rule.exclude.some((pat) => globMatch(pat, mId))) continue;

      // Check capabilities and context
      if (rule.need && rule.need.length > 0) {
        const testable = new Set(['tools', 'vision']);
        const hasAllNeeds = rule.need.every(
          (needCap) =>
            m.capabilities.includes(needCap) ||
            (testable.has(needCap) && m.admission?.checks?.[needCap as 'tools' | 'vision'] !== false)
        );
        if (!hasAllNeeds) continue;
      }
      if (
        rule.minContext !== undefined &&
        m.contextLength !== undefined &&
        m.contextLength < rule.minContext
      ) {
        continue;
      }

      // Check if probe needed
      const isRejectedRecent =
        m.admission?.status === 'rejected' && now - m.admission.at < 24 * 3600 * 1000;
      if (isRejectedRecent) continue;

      if (!m.admission || m.admission.status !== 'pending') {
        m.admission = {
          status: 'pending',
          at: now,
          checks: m.admission?.checks,
        };
      }
    }
  }

  existing.fetchedAt = now;
  saveCatalogSync(provider, fp);

  // Trigger background admission probes
  triggerAdmissionProbes(activeRoutes);

  return existing;
}

function handleKeyProbeIssue(
  provider: string,
  fp: string,
  res: { isQuota?: boolean; isAuthError?: boolean; reason?: string }
): void {
  for (const tenant of Object.values(listTenants())) {
    const keyInfo = tenant.upstreamKeys?.[provider as UpstreamKeyProvider];
    if (keyInfo && keyInfo.fp === fp) {
      if (res.isQuota) {
        const waitSec = 3600;
        const exhaustedUntil = new Date(Date.now() + waitSec * 1000).toISOString();
        keyInfo.status = 'exhausted';
        keyInfo.statusAt = new Date().toISOString();
        keyInfo.exhaustedUntil = exhaustedUntil;
        keyInfo.lastError = (res.reason || 'Upstream quota exhausted').slice(0, 150);
        upsertTenant(tenant);
        emitRouterEvent({
          type: 'byok.key-exhausted',
          tenantId: tenant.id,
          provider: provider as UpstreamKeyProvider,
          hint: keyInfo.hint,
          exhaustedUntil,
        });
      } else if (res.isAuthError) {
        keyInfo.status = 'invalid';
        keyInfo.statusAt = new Date().toISOString();
        keyInfo.lastError = (res.reason || 'Upstream key rejected').slice(0, 150);
        upsertTenant(tenant);
        emitRouterEvent({
          type: 'byok.key-invalid',
          tenantId: tenant.id,
          provider: provider as UpstreamKeyProvider,
          hint: keyInfo.hint,
        });
      }
      break;
    }
  }
}

/**
 * Triggers background probing for models with status: 'pending'.
 */
export function triggerAdmissionProbes(routes?: Record<string, LogicalModelConfig>): void {
  const activeRoutes = routes || loadRawLogicalModelConfigs();

  for (const cat of catalogMap.values()) {
    const rules = findRulesForCatalog(activeRoutes, cat.provider, cat.fp);
    if (rules.length === 0) continue;

    for (const [mId, m] of Object.entries(cat.models)) {
      if (m.missingSince || m.manual === 'block' || m.manual === 'admit') continue;
      if (m.admission?.status !== 'pending') continue;

      // Determine needed capabilities across rules that match this model
      const neededCaps = new Set<'tools' | 'vision'>();
      let candidateKey: string | undefined;

      for (const ruleEntry of rules) {
        const rule = ruleEntry.select!;
        const matchesPrefer = rule.prefer.some((p) => globMatch(p, mId));
        if (!matchesPrefer) continue;
        if (rule.exclude && rule.exclude.some((p) => globMatch(p, mId))) continue;

        if (!candidateKey) {
          candidateKey = resolveEntryKey(ruleEntry);
        }
        if (rule.need?.includes('tools')) neededCaps.add('tools');
        if (rule.need?.includes('vision')) neededCaps.add('vision');
      }

      if (!candidateKey) continue;
      const keyToUse = candidateKey;

      // Enqueue admission probe task (max 2 concurrent)
      admissionProbeQueue.enqueue(async () => {
        // Double check status before running
        const current = cat.models[mId];
        if (!current || current.admission?.status !== 'pending') return;

        const checks = { ...(current.admission.checks || {}) };

        // 1. Completion probe
        const compRes = await runCompletionProbe(cat.baseUrl, keyToUse, mId);
        if (compRes.status429) {
          if (compRes.isQuota || compRes.isAuthError) {
            handleKeyProbeIssue(cat.provider, cat.fp, compRes);
          }
          // Keep pending, retry later
          return;
        }
        if (!compRes.pass) {
          current.admission = {
            status: 'rejected',
            at: Date.now(),
            reason: compRes.reason || 'Completion probe failed',
            checks: { ...checks, completion: false },
          };
          saveCatalogSync(cat.provider, cat.fp);
          emitRouterEvent({
            type: 'catalog.model-rejected',
            provider: cat.provider,
            fp: cat.fp,
            model: mId,
            reason: compRes.reason || 'Completion probe failed',
          });
          return;
        }
        checks.completion = true;
        if (!current.capabilities.includes('completion')) {
          current.capabilities.push('completion');
        }

        // 2. Tools probe (if needed)
        if (neededCaps.has('tools')) {
          const toolsRes = await runToolsProbe(cat.baseUrl, keyToUse, mId);
          if (toolsRes.status429) {
            if (toolsRes.isQuota || toolsRes.isAuthError) {
              handleKeyProbeIssue(cat.provider, cat.fp, toolsRes);
            }
            return;
          }
          if (!toolsRes.pass) {
            current.admission = {
              status: 'rejected',
              at: Date.now(),
              reason: toolsRes.reason || 'Tools probe failed',
              checks: { ...checks, tools: false },
            };
            saveCatalogSync(cat.provider, cat.fp);
            emitRouterEvent({
              type: 'catalog.model-rejected',
              provider: cat.provider,
              fp: cat.fp,
              model: mId,
              reason: toolsRes.reason || 'Tools probe failed',
            });
            return;
          }
          checks.tools = true;
          if (!current.capabilities.includes('tools')) {
            current.capabilities.push('tools');
          }
        }

        // 3. Vision probe (if needed)
        if (neededCaps.has('vision')) {
          const visionRes = await runVisionProbe(cat.baseUrl, keyToUse, mId);
          if (visionRes.status429) {
            if (visionRes.isQuota || visionRes.isAuthError) {
              handleKeyProbeIssue(cat.provider, cat.fp, visionRes);
            }
            return;
          }
          if (!visionRes.pass) {
            current.admission = {
              status: 'rejected',
              at: Date.now(),
              reason: visionRes.reason || 'Vision probe failed',
              checks: { ...checks, vision: false },
            };
            saveCatalogSync(cat.provider, cat.fp);
            emitRouterEvent({
              type: 'catalog.model-rejected',
              provider: cat.provider,
              fp: cat.fp,
              model: mId,
              reason: visionRes.reason || 'Vision probe failed',
            });
            return;
          }
          checks.vision = true;
          if (!current.capabilities.includes('vision')) {
            current.capabilities.push('vision');
          }
        }

        // All needed passed!
        current.admission = {
          status: 'admitted',
          at: Date.now(),
          checks,
        };
        saveCatalogSync(cat.provider, cat.fp);
        emitRouterEvent({
          type: 'catalog.model-admitted',
          provider: cat.provider,
          fp: cat.fp,
          model: mId,
        });
      });
    }
  }
}

/**
 * Called by forwarder when upstream says model does not exist.
 * Marks missingSince=now immediately, emits catalog.model-removed, and schedules refresh within 30s.
 */
export function reportModelMissing(entry: PoolEntry): void {
  if (!entry || !entry.provider) return;
  // Only catalog-backed providers, and only this key's own catalog: a 404 from
  // one key must never mark a model missing in another key's (client's) catalog.
  if (!getProviderAdapter(entry.provider)) return;

  const cleanModel = entry.model.replace(/:cloud$/, '');
  const key = resolveEntryKey(entry);
  const fp = key ? keyFingerprint(key) : '';
  const cat = fp ? catalogMap.get(`${entry.provider}-${fp}`) : undefined;

  if (cat && cat.models[cleanModel]) {
    const m = cat.models[cleanModel];
    if (!m.missingSince) {
      m.missingSince = Date.now();
      saveCatalogSync(cat.provider, cat.fp);
      emitRouterEvent({
        type: 'catalog.model-removed',
        provider: cat.provider,
        fp: cat.fp,
        model: cleanModel,
      });
    }
  }

  if (key) {
    scheduleDebouncedRefresh(entry.provider, entry.baseUrl, key, 30_000);
  }
}

/**
 * Called by the forwarder when the upstream refuses a model for this key's
 * plan (HTTP 402 "not included in your free usage"): the model is listed but
 * unusable, so reject it (re-probed after 24 h) and let the rule pick the next.
 * Only rule-expanded entries: a pinned entry keeps today's behaviour.
 */
export function reportModelRejected(entry: PoolEntry, reason: string): void {
  if (!entry?.fromRule || !getProviderAdapter(entry.provider)) return;
  const key = resolveEntryKey(entry);
  const fp = key ? keyFingerprint(key) : '';
  const cat = fp ? catalogMap.get(`${entry.provider}-${fp}`) : undefined;
  const cleanModel = entry.model.replace(/:cloud$/, '');
  const m = cat?.models[cleanModel];
  if (!cat || !m || m.manual === 'admit') return;
  if (m.admission?.status === 'rejected') return;
  m.admission = { status: 'rejected', at: Date.now(), reason: reason.slice(0, 200), checks: m.admission?.checks };
  saveCatalogSync(cat.provider, cat.fp);
  emitRouterEvent({ type: 'catalog.model-rejected', provider: cat.provider, fp: cat.fp, model: cleanModel, reason: reason.slice(0, 200) });
}

/**
 * Debounced refresh within specified delay (ms).
 */
export function scheduleDebouncedRefresh(
  provider: string,
  baseUrl: string,
  key: string,
  delayMs = 30_000
): void {
  const fp = keyFingerprint(key);
  const catKey = `${provider}-${fp}`;

  const existing = debouncedTimers.get(catKey);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    debouncedTimers.delete(catKey);
    refreshCatalog(provider, baseUrl, key).catch((err) => {
      console.warn(`[catalog] Debounced refresh failed for ${catKey}:`, err);
    });
  }, delayMs);

  timer.unref();
  debouncedTimers.set(catKey, timer);
}

/**
 * Refreshes all active rule key catalogs now.
 */
export async function refreshAllCatalogs(
  routes?: Record<string, LogicalModelConfig>
): Promise<{ refreshed: string[]; timestamp: number }> {
  const activeRoutes = routes || loadRawLogicalModelConfigs();
  const refreshed: string[] = [];

  const targets = new Map<string, { provider: string; baseUrl: string; key: string }>();

  for (const route of Object.values(activeRoutes)) {
    if (route.censored !== true) continue;
    for (const entry of route.pool) {
      if (!entry.select) continue;
      const key = resolveEntryKey(entry);
      if (!key) continue;
      const fp = keyFingerprint(key);
      const targetId = `${entry.provider}-${fp}`;
      if (!targets.has(targetId)) {
        targets.set(targetId, {
          provider: entry.provider,
          baseUrl: entry.baseUrl,
          key,
        });
      }
    }
  }

  // Include every active BYOK tenant key
  const tenants = listTenants();
  for (const tenant of tenants) {
    if (tenant.mode !== 'byok' || tenant.status === 'disabled') continue;
    if (!tenant.upstreamKeys) continue;
    for (const [prov, keyInfo] of Object.entries(tenant.upstreamKeys)) {
      if (!keyInfo || keyInfo.status === 'invalid') continue;
      const provider = prov as 'ollama-cloud' | 'openai';
      const key = resolveEntryKey({ keyRef: { tenantId: tenant.id, provider } });
      if (!key) continue;
      const fp = keyFingerprint(key);
      const targetId = `${provider}-${fp}`;
      if (!targets.has(targetId)) {
        const baseUrl =
          provider === 'ollama-cloud' ? CONFIG.cloudBaseUrl : CONFIG.openaiBaseUrl;
        targets.set(targetId, {
          provider,
          baseUrl,
          key,
        });
      }
    }
  }

  for (const [targetId, t] of targets.entries()) {
    try {
      await refreshCatalog(t.provider, t.baseUrl, t.key, activeRoutes);
      refreshed.push(targetId);
    } catch (e) {
      console.warn(`[catalog] Refresh failed for ${targetId}:`, e);
    }
  }

  return { refreshed, timestamp: Date.now() };
}

/**
 * Starts the periodic catalog refresh poller loop.
 */
export function startCatalogPoller(
  getRoutes: () => Record<string, LogicalModelConfig>,
  intervalSec: number = Number(process.env.ROUTER_CATALOG_INTERVAL_SEC ?? 900)
): { stop: () => void; refreshNow: () => Promise<{ refreshed: string[]; timestamp: number }> } {
  const refreshNow = async () => {
    return refreshAllCatalogs(getRoutes());
  };

  // Immediate refresh on startup in background
  refreshNow().catch((err) => {
    console.warn('[catalog] Initial catalog refresh failed:', err);
  });

  if (intervalSec > 0) {
    pollerTimer = setInterval(refreshNow, intervalSec * 1000);
    pollerTimer.unref();
  }

  return {
    stop: () => {
      if (pollerTimer) {
        clearInterval(pollerTimer);
        pollerTimer = undefined;
      }
    },
    refreshNow,
  };
}

export function stopCatalogPoller(): void {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = undefined;
  }
}
