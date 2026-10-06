import { LogicalModelConfig, PoolEntry, SelectRule } from '../types.js';
import { emitRouterEvent } from './events.js';
import { resolveEntryKey, keyFingerprint } from './keys.js';
import { getCatalog, getCatalogModel } from './catalog.js';

export function globMatch(pattern: string, text: string): boolean {
  const p = pattern.replace(/:cloud$/, '').trim();
  const t = text.replace(/:cloud$/, '').trim();
  const regexPattern =
    '^' +
    p
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*') +
    '$';
  return new RegExp(regexPattern, 'i').test(t);
}

const warnedUncensoredRules = new Set<string>();
const emptyRulesReported = new Set<string>();

export function resetRulesTrackingForTests(): void {
  warnedUncensoredRules.clear();
  emptyRulesReported.clear();
}

export interface CandidateWithMatch {
  id: string;
  created?: number;
  preferIndex: number;
  contextLength?: number;
}

/**
 * Expands rule entries in a pool into concrete PoolEntry objects.
 * Called per request; must be fast (in-memory only, no disk I/O).
 */
export function expandRuleEntries(
  pool: PoolEntry[],
  routeConfig: LogicalModelConfig
): PoolEntry[] {
  // Rule entries are allowed ONLY on censored routes (censored: true).
  if (routeConfig.censored !== true) {
    const result: PoolEntry[] = [];
    for (const entry of pool) {
      if (entry.select) {
        const warnKey = `${routeConfig.id}:${entry.id}`;
        if (!warnedUncensoredRules.has(warnKey)) {
          warnedUncensoredRules.add(warnKey);
          console.warn(
            `[rules] Rule entry "${entry.id}" ignored on uncensored route "${routeConfig.id}". Uncensored models must be pinned.`
          );
        }
      } else {
        result.push(entry);
      }
    }
    return result;
  }

  // Deduplication: collect pinned models with :cloud stripped
  const activeModelsInRoute = new Set<string>();
  for (const entry of pool) {
    if (!entry.select && entry.model) {
      activeModelsInRoute.add(entry.model.replace(/:cloud$/, ''));
    }
  }

  const result: PoolEntry[] = [];

  for (const entry of pool) {
    if (!entry.select) {
      result.push(entry);
      continue;
    }

    const rule: SelectRule = entry.select;
    const key = resolveEntryKey(entry);
    const fp = key ? keyFingerprint(key) : '';
    const catalog = getCatalog(entry.provider, fp);

    const candidates: CandidateWithMatch[] = [];

    if (catalog && catalog.models) {
      for (const [modelId, model] of Object.entries(catalog.models)) {
        const cleanId = modelId.replace(/:cloud$/, '');

        // 1. Not missing
        if (model.missingSince) continue;

        // 2. Not blocked manually
        if (model.manual === 'block') continue;

        // 3. Admitted (or manual admit)
        const isAdmitted = model.manual === 'admit' || model.admission?.status === 'admitted';
        if (!isAdmitted) continue;

        // 4. Have all need capabilities
        if (rule.need && rule.need.length > 0) {
          const caps = model.capabilities || [];
          const hasAllNeeds = rule.need.every((needCap) => caps.includes(needCap));
          if (!hasAllNeeds) continue;
        }

        // 5. contextLength >= minContext (unknown context passes)
        if (
          rule.minContext !== undefined &&
          model.contextLength !== undefined &&
          model.contextLength < rule.minContext
        ) {
          continue;
        }

        // 6. Match some prefer pattern and no exclude pattern
        let matchedPreferIndex = -1;
        for (let pIdx = 0; pIdx < rule.prefer.length; pIdx++) {
          if (globMatch(rule.prefer[pIdx], cleanId)) {
            matchedPreferIndex = pIdx;
            break;
          }
        }
        if (matchedPreferIndex === -1) continue;

        if (rule.exclude && rule.exclude.length > 0) {
          const isExcluded = rule.exclude.some((exPat) => globMatch(exPat, cleanId));
          if (isExcluded) continue;
        }

        // 7. Dedupe with pinned or already added models
        if (activeModelsInRoute.has(cleanId)) continue;

        candidates.push({
          id: cleanId,
          created: model.created,
          preferIndex: matchedPreferIndex,
          contextLength: model.contextLength,
        });
      }
    }

    // Sort order: index of first matching prefer pattern, then created desc (newest first), then id asc
    candidates.sort((a, b) => {
      if (a.preferIndex !== b.preferIndex) {
        return a.preferIndex - b.preferIndex;
      }
      const createdA = a.created ?? 0;
      const createdB = b.created ?? 0;
      if (createdA !== createdB) {
        return createdB - createdA;
      }
      return a.id.localeCompare(b.id);
    });

    const takeCount = rule.take ?? 1;
    const selected = candidates.slice(0, takeCount);

    const emptyKey = `${routeConfig.id}:${entry.id}`;
    // Before the first catalog fetch (startup) "empty" is expected, not news.
    if (selected.length === 0 && catalog && catalog.fetchedAt > 0) {
      if (!emptyRulesReported.has(emptyKey)) {
        emptyRulesReported.add(emptyKey);
        emitRouterEvent({
          type: 'catalog.rule-empty',
          route: routeConfig.id,
          ruleId: entry.id,
        });
      }
    } else if (selected.length > 0) {
      emptyRulesReported.delete(emptyKey);
    }

    for (let i = 0; i < selected.length; i++) {
      const cand = selected[i];
      activeModelsInRoute.add(cand.id);

      const concreteEntry: PoolEntry = {
        ...entry,
        id: `${entry.id}~${cand.id}`,
        model: cand.id,
        priority: entry.priority + i * 0.01,
        fromRule: entry.id,
      };
      if (cand.contextLength !== undefined) {
        concreteEntry.contextLength = cand.contextLength;
      }
      delete concreteEntry.select;

      result.push(concreteEntry);
    }
  }

  return result;
}
