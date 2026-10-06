import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadRawLogicalModelConfigs, CONFIG } from '../config.js';
import { emitRouterEvent } from './events.js';
import { flushRequestLogSync, RequestLogRecord } from './request-log.js';
import { getTenantBudgetDailyUsage, getTenantLimit } from './budget.js';
import { getTenantDailyRequestCount } from './tenant-rate.js';
import { listTenants, resolveRateLimits } from './tenants.js';
import { getMinimaxRemainsIntervalSec } from './provider-quota.js';

export interface WatchSignal {
  id: string;
  level: 'warn' | 'crit';
  title: string;
  details: string;
  data?: Record<string, unknown>;
}

export interface WatchReport {
  version: 1;
  window: { from: string; to: string };
  generatedAt: string;
  level: 'ok' | 'warn' | 'crit';
  signals: WatchSignal[];
  metrics: {
    malformedLines: number;
    cache: {
      requests: number;
      promptTokens: number;
      cachedTokens: number;
      completionTokens: number;
      cacheShare: number;
      baselineRequests: number;
      baselinePromptTokens: number;
      baselineCachedTokens: number;
      baselineCacheShare: number | null;
      dropPP: number | null;
      topTenants: Array<{ tenant: string; promptTokens: number; cachedTokens: number; cacheShare: number }>;
      topUsers: Array<{ user: string; tenant: string; promptTokens: number; cachedTokens: number; cacheShare: number }>;
      whoBrokePrefix: string[];
    };
    quota: {
      pollerDisabled: boolean;
      pollerStaleMinutes: number | null;
      pollerMaxGapMinutes: number | null;
      latestWeeklyRemainingPct: number | null;
      intervalsBelowLowPctCount: number;
      providerQuotaHits: number;
    };
    calibration: {
      tokensPerPct: number | null;
      sumDeltaWeighted: number;
      sumDeltaPct: number;
      targetTokensPerPct: number;
      tolerance: number;
      dataSufficient: boolean;
    };
    budget: {
      budgetExceededCounts: Record<string, number>;
      tenantsExceeded80MiniMax: Array<{ tenant: string; used: number; limit: number; pct: number }>;
      tenantsExceeded80DayRequests: Array<{ tenant: string; used: number; limit: number; pct: number }>;
      byokKeyIssues: Array<{ tenant: string; provider: string; hint: string; status?: string; errorCode?: string; lastError?: string }>;
    };
    errors: {
      totalRequests: number;
      errorResponsesCount: number;
      errorRate: number;
      minimaxRouteSuccessRequests: number;
      minimaxRouteFallbackRequests: number;
      fallbackRate: number;
      topFallbackBackends: Record<string, number>;
      loopGuard429Count: number;
      topLoopSessions: Array<{ key: string; count: number }>;
    };
    notifications: {
      email: { sent: number; failed: number };
      telegram: { sent: number; failed: number };
      failed: number;
      sent: number;
    };
    [key: string]: unknown;
  };
}

export interface WatchSchedulerState {
  lastScheduledDate: string;
}

let customClockFn: (() => number) | null = null;
let schedulerTimer: NodeJS.Timeout | null = null;
let isSchedulerRunning = false;

export function setWatchClockForTests(fn: (() => number) | null): void {
  customClockFn = fn;
}

function getNow(): number {
  return customClockFn ? customClockFn() : Date.now();
}

function getStateDir(): string {
  return process.env.ROUTER_STATE_DIR || './data';
}

function getWatchDir(): string {
  return path.join(getStateDir(), 'watch');
}

function getEnvNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim() === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && !isNaN(v) ? v : fallback;
}

function getEnvBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim() === '') return fallback;
  return raw === 'true' || raw === '1';
}

/**
 * Stream a JSONL file line-by-line without buffering the entire file into memory.
 */
async function streamJsonlFile<T>(
  filePath: string,
  onRecord: (rec: T) => void,
  onMalformed?: () => void
): Promise<void> {
  if (!fs.existsSync(filePath)) return;

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as T;
      onRecord(rec);
    } catch {
      onMalformed?.();
    }
  }
}

/**
 * Clean watch report files older than ROUTER_WATCH_RETENTION_DAYS (default 90).
 */
export function cleanOldWatchReports(retentionDays = getEnvNum('ROUTER_WATCH_RETENTION_DAYS', 90)): void {
  try {
    const dir = getWatchDir();
    if (!fs.existsSync(dir)) return;

    const cutoffMs = getNow() - retentionDays * 86_400_000;
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (f === 'state.json' || !f.endsWith('.json')) continue;
      const fullPath = path.join(dir, f);
      try {
        const stats = fs.statSync(fullPath);
        const match = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
        const fileDateMs = match ? new Date(`${match[1]}T00:00:00.000Z`).getTime() : NaN;
        if ((!isNaN(fileDateMs) && fileDateMs < cutoffMs) || stats.mtimeMs < cutoffMs) {
          fs.unlinkSync(fullPath);
        }
      } catch {}
    }
  } catch (err) {
    console.warn('[watch] cleanOldWatchReports error:', err);
  }
}

/**
 * Save report to disk atomically.
 */
export function saveWatchReportSync(report: WatchReport, fileName: string): string {
  const dir = getWatchDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const filePath = path.join(dir, fileName);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(report, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
  cleanOldWatchReports();
  return filePath;
}

export function computeDefaultWindow(nowMs: number): { from: string; to: string } {
  const todayDateStr = new Date(nowMs).toISOString().slice(0, 10);
  const todayStartMs = Date.parse(`${todayDateStr}T00:00:00.000Z`);
  const yesterdayStartMs = todayStartMs - 86_400_000;
  return {
    from: new Date(yesterdayStartMs).toISOString(),
    to: new Date(todayStartMs).toISOString(),
  };
}

/**
 * Builds the watch report for a given time window.
 * Strictly READ-ONLY with respect to external systems (no upstream requests).
 */
export async function buildWatchReport(options?: {
  from?: string;
  to?: string;
  now?: number | Date;
  isManual?: boolean;
}): Promise<WatchReport> {
  // Ensure recent in-memory log buffer is persisted to disk before streaming
  flushRequestLogSync();

  const nowMs = typeof options?.now === 'number'
    ? options.now
    : (options?.now instanceof Date ? options.now.getTime() : getNow());

  let fromISO: string;
  let toISO: string;

  if (options?.from && options?.to) {
    fromISO = options.from;
    toISO = options.to;
  } else if (options?.isManual) {
    // Rolling 24 hours
    toISO = new Date(nowMs).toISOString();
    fromISO = new Date(nowMs - 24 * 3600 * 1000).toISOString();
  } else {
    // Previous full UTC day (00:00 - 24:00)
    const win = computeDefaultWindow(nowMs);
    fromISO = win.from;
    toISO = win.to;
  }

  // Baseline: 7 full UTC days strictly preceding fromISO's UTC date
  const windowFromDate = fromISO.slice(0, 10);
  const windowFromStartMs = Date.parse(`${windowFromDate}T00:00:00.000Z`);
  const baselineStartMs = windowFromStartMs - 7 * 86_400_000;
  const baselineFromISO = new Date(baselineStartMs).toISOString();
  const baselineToISO = new Date(windowFromStartMs).toISOString();

  let malformedLines = 0;
  const onMalformed = () => { malformedLines++; };

  // --- 1. Stream Request Logs ---
  // Determine date files to inspect: all dates from baselineStartMs to toISO's date
  const minDateStr = baselineFromISO.slice(0, 10);
  const maxDateStr = toISO.slice(0, 10);

  const reqDir = path.join(getStateDir(), 'requests');
  let dateFiles: string[] = [];
  if (fs.existsSync(reqDir)) {
    dateFiles = fs.readdirSync(reqDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .filter((f) => {
        const d = f.slice(0, 10);
        return d >= minDateStr && d <= maxDateStr;
      })
      .sort();
  }

  // Detect routes where primary pool entry is MiniMax
  const rawConfigs = loadRawLogicalModelConfigs();
  const minimaxPrimaryRoutes = new Set<string>();
  for (const [routeId, cfg] of Object.entries(rawConfigs)) {
    const first = cfg.pool?.[0];
    if (first && (first.budgetGroup === 'minimax' || first.id.startsWith('minimax-') || (first.provider === 'custom' && first.baseUrl === CONFIG.minimaxBaseUrl))) {
      minimaxPrimaryRoutes.add(routeId);
    }
  }

  // Baseline accumulators
  let baselineMiniMaxRequests = 0;
  let baselineMiniMaxPromptTokens = 0;
  let baselineMiniMaxCachedTokens = 0;

  // Window accumulators
  let windowTotalRequests = 0;
  let windowErrorResponsesCount = 0;
  let windowMiniMaxRequests = 0;
  let windowMiniMaxPromptTokens = 0;
  let windowMiniMaxCachedTokens = 0;
  let windowMiniMaxCompletionTokens = 0;

  let minimaxRouteSuccessRequests = 0;
  let minimaxRouteFallbackRequests = 0;
  const fallbackBackends: Record<string, number> = {};

  let loopGuard429Count = 0;
  const loopSessionsMap = new Map<string, number>();

  let providerQuotaHits = 0;
  const budgetExceededMap = new Map<string, number>(); // key: "tenant:reason"
  const byokKeyErrorsMap = new Map<string, { tenant: string; provider: string; hint: string; errorCode: string }>();

  const tenantPromptTokens = new Map<string, { prompt: number; cached: number }>();
  const userPromptTokens = new Map<string, { prompt: number; cached: number; tenant: string; user: string }>();

  for (const file of dateFiles) {
    const filePath = path.join(reqDir, file);
    await streamJsonlFile<RequestLogRecord>(
      filePath,
      (rec) => {
        const ts = rec.ts;
        if (!ts) return;

        // Baseline window check
        if (ts >= baselineFromISO && ts < baselineToISO) {
          if (rec.backend && rec.backend.startsWith('minimax-')) {
            baselineMiniMaxRequests++;
            baselineMiniMaxPromptTokens += rec.promptTokens || 0;
            baselineMiniMaxCachedTokens += rec.cachedTokens || 0;
          }
        }

        // Target window check
        if (ts >= fromISO && ts <= toISO) {
          windowTotalRequests++;

          // Errors: >= 500 or 429
          if (rec.status >= 500 || rec.status === 429) {
            windowErrorResponsesCount++;
          }

          // Loop guard blocks
          if (rec.errorCode === 'loop_detected' || (rec.status === 429 && rec.errorCode === 'loop_detected')) {
            loopGuard429Count++;
            const sKey = rec.session ? `${rec.tenant}|${rec.session}` : rec.tenant;
            loopSessionsMap.set(sKey, (loopSessionsMap.get(sKey) || 0) + 1);
          }

          // Provider quota gate hits
          if (rec.budgetExceeded === 'provider-quota' || rec.errorCode === 'provider-quota') {
            providerQuotaHits++;
          }

          // Budget exceeded records
          if (rec.budgetExceeded || (rec.status === 503 && rec.errorCode === 'budget_exceeded')) {
            const reason = rec.budgetExceeded || rec.errorCode || 'unknown';
            const k = `${rec.tenant}:${reason}`;
            budgetExceededMap.set(k, (budgetExceededMap.get(k) || 0) + 1);
          }

          // BYOK errors in request log
          if (
            rec.errorCode === 'upstream_key_invalid' ||
            rec.errorCode === 'upstream_quota_exhausted' ||
            rec.status === 402
          ) {
            const code = rec.errorCode || 'http_402';
            const k = `${rec.tenant}:${rec.backend || 'unknown'}:${rec.keyHint || 'unknown'}:${code}`;
            if (!byokKeyErrorsMap.has(k)) {
              byokKeyErrorsMap.set(k, {
                tenant: rec.tenant,
                provider: rec.backend || 'unknown',
                hint: rec.keyHint || 'unknown',
                errorCode: code,
              });
            }
          }

          // MiniMax traffic
          const isMiniMax = rec.backend && rec.backend.startsWith('minimax-');
          if (isMiniMax) {
            windowMiniMaxRequests++;
            const pTokens = rec.promptTokens || 0;
            const cTokens = rec.cachedTokens || 0;
            const compTokens = rec.completionTokens || 0;
            windowMiniMaxPromptTokens += pTokens;
            windowMiniMaxCachedTokens += cTokens;
            windowMiniMaxCompletionTokens += compTokens;

            // Tenant breakdown
            const curT = tenantPromptTokens.get(rec.tenant) || { prompt: 0, cached: 0 };
            curT.prompt += pTokens;
            curT.cached += cTokens;
            tenantPromptTokens.set(rec.tenant, curT);

            // User breakdown
            const userStr = rec.user || '-';
            const uKey = `${rec.tenant}#${userStr}`;
            const curU = userPromptTokens.get(uKey) || { prompt: 0, cached: 0, tenant: rec.tenant, user: userStr };
            curU.prompt += pTokens;
            curU.cached += cTokens;
            userPromptTokens.set(uKey, curU);
          }

          // Fallback share on routes that start with MiniMax
          if (rec.tier && minimaxPrimaryRoutes.has(rec.tier)) {
            if (rec.status >= 200 && rec.status < 300) {
              minimaxRouteSuccessRequests++;
              if (!isMiniMax) {
                minimaxRouteFallbackRequests++;
                const bId = rec.backend || 'unknown';
                fallbackBackends[bId] = (fallbackBackends[bId] || 0) + 1;
              }
            }
          }
        }
      },
      onMalformed
    );
  }

  // --- 2. Stream minimax-remains.jsonl ---
  interface MinimaxRemainsRecord {
    fetchedAt: number;
    intervalStart: number;
    intervalEnd: number;
    intervalRemainingPct: number;
    intervalStatus: number;
    weeklyStart: number;
    weeklyEnd: number;
    weeklyRemainingPct: number;
    weeklyStatus: number;
    routerWeekRaw: number;
    routerWeekWeighted: number;
    routerCycleRaw: number;
    usedCycle: number;
  }

  let newestSnapshotOverall: MinimaxRemainsRecord | null = null;
  const windowRemainsSnapshots: MinimaxRemainsRecord[] = [];

  const remainsLogPath = path.join(getStateDir(), 'minimax-remains.jsonl');
  await streamJsonlFile<MinimaxRemainsRecord>(
    remainsLogPath,
    (snap) => {
      if (typeof snap.fetchedAt !== 'number') return;
      if (!newestSnapshotOverall || snap.fetchedAt > newestSnapshotOverall.fetchedAt) {
        newestSnapshotOverall = snap;
      }
      const iso = new Date(snap.fetchedAt).toISOString();
      if (iso >= fromISO && iso <= toISO) {
        windowRemainsSnapshots.push(snap);
      }
    },
    onMalformed
  );

  windowRemainsSnapshots.sort((a, b) => a.fetchedAt - b.fetchedAt);

  // --- 3. Stream notifications.jsonl ---
  interface NotificationRecord {
    ts?: string;
    timestamp?: string;
    channel?: 'email' | 'telegram';
    transport?: 'email' | 'telegram';
    ok?: boolean;
    status?: string;
    error?: string;
  }

  const notificationCounts = {
    email: { sent: 0, failed: 0 },
    telegram: { sent: 0, failed: 0 },
  };

  const notifLogPath = path.join(getStateDir(), 'notifications.jsonl');
  await streamJsonlFile<NotificationRecord>(
    notifLogPath,
    (rec) => {
      const time = rec.ts || rec.timestamp;
      const chan = rec.channel || rec.transport;
      const isSuccess = rec.ok === true || rec.status === 'delivered' || rec.status === 'ok';
      if (time && time >= fromISO && time <= toISO) {
        if (chan === 'email' || chan === 'telegram') {
          if (isSuccess) {
            notificationCounts[chan].sent++;
          } else {
            notificationCounts[chan].failed++;
          }
        }
      }
    },
    onMalformed
  );

  // --- 4. Signals Evaluation ---
  const signals: WatchSignal[] = [];

  // Threshold constants
  const CACHE_MIN = getEnvNum('ROUTER_WATCH_CACHE_MIN', 0.5);
  const CACHE_DROP_PP = getEnvNum('ROUTER_WATCH_CACHE_DROP_PP', 20);
  const CACHE_MIN_PROMPT = getEnvNum('ROUTER_WATCH_CACHE_MIN_PROMPT', 1_000_000);
  const MIN_REQUESTS = getEnvNum('ROUTER_WATCH_MIN_REQUESTS', 50);

  const WEEKLY_MIN_PCT = getEnvNum('ROUTER_WATCH_WEEKLY_MIN_PCT', 30);
  const REMAINS_STOP_PCT = getEnvNum('ROUTER_MINIMAX_REMAINS_STOP_PCT', 5);
  const INTERVAL_LOW_PCT = getEnvNum('ROUTER_WATCH_INTERVAL_LOW_PCT', 15);
  const POLLER_STALE_MIN = getEnvNum('ROUTER_WATCH_POLLER_STALE_MIN', 30);

  const CALIB_TOKENS_PER_PCT = getEnvNum('ROUTER_WATCH_CALIB_TOKENS_PER_PCT', 200_000);
  const CALIB_TOLERANCE = getEnvNum('ROUTER_WATCH_CALIB_TOLERANCE', 0.5);

  const ERROR_RATE_THRESH = getEnvNum('ROUTER_WATCH_ERROR_RATE', 0.05);
  const FALLBACK_RATE_THRESH = getEnvNum('ROUTER_WATCH_FALLBACK_RATE', 0.2);
  const LOOP_BLOCKS_THRESH = getEnvNum('ROUTER_WATCH_LOOP_BLOCKS', 10);

  // --- Signal 1: MiniMax cache share ---
  const windowCacheShare = windowMiniMaxPromptTokens > 0 ? windowMiniMaxCachedTokens / windowMiniMaxPromptTokens : 0;
  const baselineCacheShare = baselineMiniMaxPromptTokens > 0 ? baselineMiniMaxCachedTokens / baselineMiniMaxPromptTokens : null;
  const dropPP = baselineCacheShare !== null ? (baselineCacheShare - windowCacheShare) * 100 : null;

  // Breakdown per tenant
  const topTenants = Array.from(tenantPromptTokens.entries())
    .map(([t, stat]) => ({
      tenant: t,
      promptTokens: stat.prompt,
      cachedTokens: stat.cached,
      cacheShare: stat.prompt > 0 ? Number((stat.cached / stat.prompt).toFixed(4)) : 0,
    }))
    .sort((a, b) => b.promptTokens - a.promptTokens);

  // Breakdown per user
  const topUsers = Array.from(userPromptTokens.values())
    .map((stat) => ({
      user: stat.user,
      tenant: stat.tenant,
      promptTokens: stat.prompt,
      cachedTokens: stat.cached,
      cacheShare: stat.prompt > 0 ? Number((stat.cached / stat.prompt).toFixed(4)) : 0,
    }))
    .sort((a, b) => b.promptTokens - a.promptTokens);

  // Who broke the prefix: tenants or (tenant, user) with >= CACHE_MIN_PROMPT and share < CACHE_MIN
  const whoBrokePrefix: string[] = [];
  for (const t of topTenants) {
    if (t.promptTokens >= CACHE_MIN_PROMPT && t.cacheShare < CACHE_MIN) {
      whoBrokePrefix.push(`${t.tenant} (${Math.round(t.cacheShare * 100)}%)`);
    }
  }
  for (const u of topUsers) {
    if (u.user !== '-' && u.promptTokens >= CACHE_MIN_PROMPT && u.cacheShare < CACHE_MIN) {
      const label = `${u.tenant}:${u.user} (${Math.round(u.cacheShare * 100)}%)`;
      if (!whoBrokePrefix.includes(label)) {
        whoBrokePrefix.push(label);
      }
    }
  }

  if (windowMiniMaxRequests >= MIN_REQUESTS) {
    const worstTenant = whoBrokePrefix[0]?.split(' ')[0];
    const tenantSuffix = worstTenant ? ` (${worstTenant})` : '';

    if (windowCacheShare < CACHE_MIN) {
      const isCrit = windowCacheShare < CACHE_MIN / 2;
      signals.push({
        id: 'cache.share',
        level: isCrit ? 'crit' : 'warn',
        title: `кэш MiniMax ${Math.round(windowCacheShare * 100)}%${tenantSuffix}`,
        details: `Доля кэша MiniMax составила ${(windowCacheShare * 100).toFixed(1)}% (порог ${(CACHE_MIN * 100).toFixed(0)}%). Запросов: ${windowMiniMaxRequests}, prompt tokens: ${windowMiniMaxPromptTokens}, cached: ${windowMiniMaxCachedTokens}.${whoBrokePrefix.length > 0 ? ` Нарушители префикса (>= ${CACHE_MIN_PROMPT} токенов): ${whoBrokePrefix.join(', ')}.` : ''}`,
        data: {
          cacheShare: windowCacheShare,
          threshold: CACHE_MIN,
          whoBrokePrefix,
        },
      });
    } else if (dropPP !== null && dropPP > CACHE_DROP_PP) {
      signals.push({
        id: 'cache.baseline-drop',
        level: 'warn',
        title: `кэш MiniMax упал на ${Math.round(dropPP)} п.п.${tenantSuffix}`,
        details: `Падение доли кэша MiniMax на ${dropPP.toFixed(1)} п.п. по сравнению с 7-дневным базовым уровнем (${(baselineCacheShare! * 100).toFixed(1)}% → ${(windowCacheShare * 100).toFixed(1)}%).${whoBrokePrefix.length > 0 ? ` Нарушители префикса: ${whoBrokePrefix.join(', ')}.` : ''}`,
        data: {
          baselineCacheShare,
          windowCacheShare,
          dropPP,
          thresholdPP: CACHE_DROP_PP,
          whoBrokePrefix,
        },
      });
    }
  }

  // --- Signal 2: MiniMax quota ---
  const pollerIntervalSec = getMinimaxRemainsIntervalSec();
  const apiKey = process.env.MINIMAX_API_KEY;
  const pollerDisabled = pollerIntervalSec === 0 || !apiKey || apiKey.trim() === '';

  let pollerStaleMinutes: number | null = null;
  let pollerMaxGapMinutes: number | null = null;

  if (pollerDisabled) {
    // Poller intentionally disabled: no poller liveness signals
  } else {
    // Check poller staleness at report time
    const latestOverall = newestSnapshotOverall as MinimaxRemainsRecord | null;
    if (!latestOverall) {
      signals.push({
        id: 'quota.poller-stale',
        level: 'crit',
        title: 'поллер квоты MiniMax: нет снимков',
        details: 'Опросник квоты MiniMax не записал ни одного снимка в minimax-remains.jsonl.',
      });
    } else {
      pollerStaleMinutes = Math.round((nowMs - latestOverall.fetchedAt) / 60000);
      if (pollerStaleMinutes > POLLER_STALE_MIN) {
        signals.push({
          id: 'quota.poller-stale',
          level: 'crit',
          title: `поллер квоты MiniMax молчит ${pollerStaleMinutes} мин`,
          details: `Последний снимок квоты MiniMax сделан ${pollerStaleMinutes} мин назад (порог ${POLLER_STALE_MIN} мин).`,
          data: { staleMinutes: pollerStaleMinutes, threshold: POLLER_STALE_MIN },
        });
      }
    }

    // Check gap inside the window
    if (windowRemainsSnapshots.length >= 2) {
      let maxGapMs = 0;
      for (let i = 1; i < windowRemainsSnapshots.length; i++) {
        const gap = windowRemainsSnapshots[i].fetchedAt - windowRemainsSnapshots[i - 1].fetchedAt;
        if (gap > maxGapMs) maxGapMs = gap;
      }
      pollerMaxGapMinutes = Math.round(maxGapMs / 60000);
      if (pollerMaxGapMinutes > POLLER_STALE_MIN) {
        signals.push({
          id: 'quota.poller-gap',
          level: 'warn',
          title: `поллер квоты MiniMax: пропуск ${pollerMaxGapMinutes} мин`,
          details: `Обнаружен разрыв между снимками квоты MiniMax в ${pollerMaxGapMinutes} мин внутри окна отчета (порог ${POLLER_STALE_MIN} мин).`,
          data: { gapMinutes: pollerMaxGapMinutes, threshold: POLLER_STALE_MIN },
        });
      }
    }
  }

  // Quota remaining thresholds
  const latestWindowSnapshot = windowRemainsSnapshots[windowRemainsSnapshots.length - 1] ?? null;
  const latestWeeklyRemainingPct = latestWindowSnapshot ? latestWindowSnapshot.weeklyRemainingPct : null;

  if (latestWeeklyRemainingPct !== null && latestWeeklyRemainingPct < WEEKLY_MIN_PCT) {
    const isCrit = latestWeeklyRemainingPct <= REMAINS_STOP_PCT;
    signals.push({
      id: 'quota.weekly-low',
      level: isCrit ? 'crit' : 'warn',
      title: `недельная квота MiniMax ${latestWeeklyRemainingPct}%`,
      details: `Остаток недельной квоты MiniMax: ${latestWeeklyRemainingPct}% (порог предупреждения ${WEEKLY_MIN_PCT}%, стоп ${REMAINS_STOP_PCT}%).`,
      data: { weeklyRemainingPct: latestWeeklyRemainingPct, threshold: WEEKLY_MIN_PCT },
    });
  }

  // Count distinct 5-hour intervals with intervalRemainingPct < INTERVAL_LOW_PCT
  const lowIntervalStarts = new Set<number>();
  for (const s of windowRemainsSnapshots) {
    if (s.intervalRemainingPct < INTERVAL_LOW_PCT) {
      lowIntervalStarts.add(s.intervalStart);
    }
  }
  const intervalsBelowLowPctCount = lowIntervalStarts.size;
  if (intervalsBelowLowPctCount >= 1) {
    signals.push({
      id: 'quota.interval-low',
      level: 'warn',
      title: `5-часовое окно MiniMax ниже ${INTERVAL_LOW_PCT}% (${intervalsBelowLowPctCount} раз)`,
      details: `Остаток в 5-часовом окне опускался ниже ${INTERVAL_LOW_PCT}% в ${intervalsBelowLowPctCount} различных интервалах.`,
      data: { intervalsCount: intervalsBelowLowPctCount, threshold: INTERVAL_LOW_PCT },
    });
  }

  // Provider-quota gate hits
  if (providerQuotaHits >= 1) {
    signals.push({
      id: 'quota.gate-hits',
      level: 'warn',
      title: `блокировки provider-quota: ${providerQuotaHits}`,
      details: `Зафиксировано ${providerQuotaHits} запросов, заблокированных защитой provider-quota.`,
      data: { hits: providerQuotaHits },
    });
  }

  // --- Signal 3: Calibration ---
  // Group snapshots by intervalStart
  const intervalMap = new Map<number, MinimaxRemainsRecord[]>();
  for (const s of windowRemainsSnapshots) {
    let arr = intervalMap.get(s.intervalStart);
    if (!arr) {
      arr = [];
      intervalMap.set(s.intervalStart, arr);
    }
    arr.push(s);
  }

  let sumDeltaPct = 0;
  let sumDeltaWeighted = 0;

  for (const [, snaps] of intervalMap.entries()) {
    if (snaps.length < 2) continue;
    const first = snaps[0];
    const last = snaps[snaps.length - 1];

    // Skip if weeklyStart changed between first and last
    if (first.weeklyStart !== last.weeklyStart) continue;

    const deltaPct = first.intervalRemainingPct - last.intervalRemainingPct;
    const deltaWeighted = last.routerWeekWeighted - first.routerWeekWeighted;

    if (deltaPct >= 2) {
      sumDeltaPct += deltaPct;
      sumDeltaWeighted += deltaWeighted;
    }
  }

  const calibrationDataSufficient = sumDeltaPct >= 4;
  let tokensPerPct: number | null = null;
  if (calibrationDataSufficient) {
    tokensPerPct = Math.round(sumDeltaWeighted / sumDeltaPct);
    const minAllowed = Math.round(CALIB_TOKENS_PER_PCT * (1 - CALIB_TOLERANCE));
    const maxAllowed = Math.round(CALIB_TOKENS_PER_PCT * (1 + CALIB_TOLERANCE));

    if (tokensPerPct < minAllowed || tokensPerPct > maxAllowed) {
      signals.push({
        id: 'calibration.drift',
        level: 'warn',
        title: `калибровка MiniMax уехала: ${tokensPerPct} ток./%`,
        details: `Калибровка MiniMax: ${tokensPerPct} взвешенных токенов на 1% (норма ${CALIB_TOKENS_PER_PCT} ±${Math.round(CALIB_TOLERANCE * 100)}%, допустимо ${minAllowed}–${maxAllowed}). MiniMax изменил учет, или ключ используется другим потребителем.`,
        data: {
          tokensPerPct,
          target: CALIB_TOKENS_PER_PCT,
          tolerance: CALIB_TOLERANCE,
          sumDeltaPct,
          sumDeltaWeighted,
        },
      });
    }
  }

  // --- Signal 4: Budget & tenants ---
  // 1. budget_exceeded / 503
  const budgetExceededSummary: Record<string, number> = {};
  for (const [k, count] of budgetExceededMap.entries()) {
    budgetExceededSummary[k] = count;
  }
  if (Object.keys(budgetExceededSummary).length > 0) {
    const listStr = Object.entries(budgetExceededSummary).map(([k, c]) => `${k} (${c})`).join(', ');
    signals.push({
      id: 'budget.exceeded',
      level: 'warn',
      title: 'клиенты упирались в бюджет MiniMax',
      details: `Зафиксированы ответы 503 / budget_exceeded: ${listStr}.`,
      data: { details: budgetExceededSummary },
    });
  }

  // 2. MiniMax day usage in the window exceeded 80% of day limit
  // Inspect days overlapping the window
  const startDay = fromISO.slice(0, 10);
  const endDay = toISO.slice(0, 10);
  const windowDays = new Set<string>([startDay, endDay]);

  const tenantsExceeded80MiniMax: Array<{ tenant: string; used: number; limit: number; pct: number }> = [];
  const seenExceededMiniMax = new Set<string>();

  for (const dayStr of windowDays) {
    const dayUsage = getTenantBudgetDailyUsage(dayStr);
    for (const [tId, usedTokens] of Object.entries(dayUsage)) {
      if (seenExceededMiniMax.has(tId)) continue;
      const limit = getTenantLimit(tId).day;
      if (limit > 0 && usedTokens >= 0.8 * limit) {
        seenExceededMiniMax.add(tId);
        tenantsExceeded80MiniMax.push({
          tenant: tId,
          used: usedTokens,
          limit,
          pct: Math.round((usedTokens / limit) * 100),
        });
      }
    }
  }

  if (tenantsExceeded80MiniMax.length > 0) {
    const listStr = tenantsExceeded80MiniMax.map((t) => `${t.tenant} (${t.pct}%)`).join(', ');
    signals.push({
      id: 'budget.near-limit',
      level: 'warn',
      title: 'клиенты израсходовали >80% дневного лимита MiniMax',
      details: `Клиенты, израсходовавшие более 80% дневного лимита токенов MiniMax: ${listStr}.`,
      data: { tenants: tenantsExceeded80MiniMax },
    });
  }

  // 3. dayRequests usage exceeded 80%
  const tenantsExceeded80DayRequests: Array<{ tenant: string; used: number; limit: number; pct: number }> = [];
  const seenExceededRequests = new Set<string>();

  for (const dayStr of windowDays) {
    const reqUsage = getTenantDailyRequestCount(dayStr);
    for (const [tId, usedReqs] of Object.entries(reqUsage)) {
      if (seenExceededRequests.has(tId)) continue;
      const rLimits = resolveRateLimits(tId);
      const limit = rLimits.dayRequests || 0;
      if (limit > 0 && usedReqs >= 0.8 * limit) {
        seenExceededRequests.add(tId);
        tenantsExceeded80DayRequests.push({
          tenant: tId,
          used: usedReqs,
          limit,
          pct: Math.round((usedReqs / limit) * 100),
        });
      }
    }
  }

  if (tenantsExceeded80DayRequests.length > 0) {
    const listStr = tenantsExceeded80DayRequests.map((t) => `${t.tenant} (${t.pct}%)`).join(', ');
    signals.push({
      id: 'budget.requests-near-limit',
      level: 'warn',
      title: 'клиенты израсходовали >80% суточного лимита запросов',
      details: `Клиенты, израсходовавшие более 80% дневного лимита запросов: ${listStr}.`,
      data: { tenants: tenantsExceeded80DayRequests },
    });
  }

  // 4. BYOK keys status (invalid / exhausted or errors in request log)
  // NEVER leak keys: hint, tenant, provider only!
  const byokIssuesMap = new Map<string, { tenant: string; provider: string; hint: string; status?: string; errorCode?: string; lastError?: string }>();

  // From registry
  for (const tenant of listTenants()) {
    if (tenant.upstreamKeys) {
      for (const [prov, keyInfo] of Object.entries(tenant.upstreamKeys)) {
        if (!keyInfo) continue;
        if (keyInfo.status === 'invalid' || keyInfo.status === 'exhausted') {
          const k = `${tenant.id}:${prov}:${keyInfo.hint}`;
          byokIssuesMap.set(k, {
            tenant: tenant.id,
            provider: prov,
            hint: keyInfo.hint || 'none',
            status: keyInfo.status,
            lastError: keyInfo.lastError,
          });
        }
      }
    }
  }

  // From request log in window
  for (const err of byokKeyErrorsMap.values()) {
    const k = `${err.tenant}:${err.provider}:${err.hint}`;
    const existing = byokIssuesMap.get(k);
    if (!existing) {
      byokIssuesMap.set(k, {
        tenant: err.tenant,
        provider: err.provider,
        hint: err.hint,
        errorCode: err.errorCode,
      });
    }
  }

  const byokKeyIssues = Array.from(byokIssuesMap.values());
  if (byokKeyIssues.length > 0) {
    const listStr = byokKeyIssues.map((b) => `${b.tenant} (${b.provider}, ${b.hint}: ${b.status || b.errorCode})`).join(', ');
    signals.push({
      id: 'byok.key-problems',
      level: 'warn',
      title: 'проблемы с ключами клиентов (BYOK)',
      details: `Обнаружены проблемы с ключами BYOK: ${listStr}.`,
      data: { issues: byokKeyIssues },
    });
  }

  // --- Signal 5: Errors & fallbacks ---
  const errorRate = windowTotalRequests > 0 ? windowErrorResponsesCount / windowTotalRequests : 0;
  if (windowTotalRequests >= MIN_REQUESTS && errorRate > ERROR_RATE_THRESH) {
    const isCrit = errorRate > 4 * ERROR_RATE_THRESH;
    signals.push({
      id: 'errors.high-rate',
      level: isCrit ? 'crit' : 'warn',
      title: `доля ошибок ${(errorRate * 100).toFixed(1)}%`,
      details: `Доля ошибок (статусы >= 500 или 429) составила ${(errorRate * 100).toFixed(1)}% (порог ${(ERROR_RATE_THRESH * 100).toFixed(0)}%). Ошибок: ${windowErrorResponsesCount} из ${windowTotalRequests}.`,
      data: { errorRate, errorResponsesCount: windowErrorResponsesCount, totalRequests: windowTotalRequests },
    });
  }

  const fallbackRate = minimaxRouteSuccessRequests > 0 ? minimaxRouteFallbackRequests / minimaxRouteSuccessRequests : 0;
  if (minimaxRouteSuccessRequests >= MIN_REQUESTS && fallbackRate > FALLBACK_RATE_THRESH) {
    const topBackendsStr = Object.entries(fallbackBackends)
      .sort((a, b) => b[1] - a[1])
      .map(([b, c]) => `${b} (${c})`)
      .join(', ');
    signals.push({
      id: 'errors.high-fallback',
      level: 'warn',
      title: `мимо MiniMax на резервы ${(fallbackRate * 100).toFixed(1)}%`,
      details: `Доля fallback с маршрутов MiniMax на другие бэкенды составила ${(fallbackRate * 100).toFixed(1)}% (порог ${(FALLBACK_RATE_THRESH * 100).toFixed(0)}%). Использованы бэкенды: ${topBackendsStr || 'нет'}.`,
      data: { fallbackRate, fallbackRequests: minimaxRouteFallbackRequests, successRequests: minimaxRouteSuccessRequests, topBackends: fallbackBackends },
    });
  }

  const topLoopSessions = Array.from(loopSessionsMap.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  if (loopGuard429Count > LOOP_BLOCKS_THRESH) {
    const listStr = topLoopSessions.map((s) => `${s.key} (${s.count})`).join(', ');
    signals.push({
      id: 'errors.loop-blocks',
      level: 'warn',
      title: `блокировки Loop Guard: ${loopGuard429Count}`,
      details: `Количество блокировок Loop Guard (429) превысило порог: ${loopGuard429Count} (порог ${LOOP_BLOCKS_THRESH}). Топ сессий: ${listStr}.`,
      data: { loopGuard429Count, threshold: LOOP_BLOCKS_THRESH, topLoopSessions },
    });
  }

  // --- Signal 6: Notification delivery ---
  const failedNotificationsCount = notificationCounts.email.failed + notificationCounts.telegram.failed;
  if (failedNotificationsCount > 0) {
    signals.push({
      id: 'notifications.failures',
      level: 'warn',
      title: `не доставлено уведомлений: ${failedNotificationsCount}`,
      details: `Ошибки доставки уведомлений: email failed=${notificationCounts.email.failed}, telegram failed=${notificationCounts.telegram.failed}.`,
      data: { notificationCounts },
    });
  }

  // Overall report level
  let reportLevel: 'ok' | 'warn' | 'crit' = 'ok';
  if (signals.some((s) => s.level === 'crit')) {
    reportLevel = 'crit';
  } else if (signals.some((s) => s.level === 'warn')) {
    reportLevel = 'warn';
  }

  const report: WatchReport = {
    version: 1,
    window: { from: fromISO, to: toISO },
    generatedAt: new Date(nowMs).toISOString(),
    level: reportLevel,
    signals,
    metrics: {
      malformedLines,
      cache: {
        requests: windowMiniMaxRequests,
        promptTokens: windowMiniMaxPromptTokens,
        cachedTokens: windowMiniMaxCachedTokens,
        completionTokens: windowMiniMaxCompletionTokens,
        cacheShare: Number(windowCacheShare.toFixed(4)),
        baselineRequests: baselineMiniMaxRequests,
        baselinePromptTokens: baselineMiniMaxPromptTokens,
        baselineCachedTokens: baselineMiniMaxCachedTokens,
        baselineCacheShare: baselineCacheShare !== null ? Number(baselineCacheShare.toFixed(4)) : null,
        dropPP: dropPP !== null ? Number(dropPP.toFixed(2)) : null,
        topTenants: topTenants.slice(0, 10),
        topUsers: topUsers.slice(0, 10),
        whoBrokePrefix,
      },
      quota: {
        pollerDisabled,
        pollerStaleMinutes,
        pollerMaxGapMinutes,
        latestWeeklyRemainingPct,
        intervalsBelowLowPctCount,
        providerQuotaHits,
      },
      calibration: {
        tokensPerPct,
        sumDeltaWeighted,
        sumDeltaPct,
        targetTokensPerPct: CALIB_TOKENS_PER_PCT,
        tolerance: CALIB_TOLERANCE,
        dataSufficient: calibrationDataSufficient,
      },
      budget: {
        budgetExceededCounts: budgetExceededSummary,
        tenantsExceeded80MiniMax,
        tenantsExceeded80DayRequests,
        byokKeyIssues,
      },
      errors: {
        totalRequests: windowTotalRequests,
        errorResponsesCount: windowErrorResponsesCount,
        errorRate: Number(errorRate.toFixed(4)),
        minimaxRouteSuccessRequests,
        minimaxRouteFallbackRequests,
        fallbackRate: Number(fallbackRate.toFixed(4)),
        topFallbackBackends: fallbackBackends,
        loopGuard429Count,
        topLoopSessions,
      },
      notifications: {
        ...notificationCounts,
        failed: notificationCounts.email.failed + notificationCounts.telegram.failed,
        sent: notificationCounts.email.sent + notificationCounts.telegram.sent,
      },
    },
  };

  return report;
}

/**
 * Format plain-text Russian summary for the admin notification.
 */
export function formatWatchReportNotificationText(
  report: WatchReport,
  reportPath: string
): { subject: string; text: string } {
  const m = report.metrics;
  const isOkDigest = report.signals.length === 0;

  if (isOkDigest) {
    const subject = '[router] OK: неделя без сигналов';
    const textLines = [
      '[AI Router] Ночной вотчер: неделя без сигналов',
      '',
      `Период: с ${report.window.from} по ${report.window.to} UTC`,
      `Время генерации: ${report.generatedAt}`,
      '',
      'Ключевые метрики за последние 7 дней:',
      `- Доля кэша MiniMax: ${(m.cache.cacheShare * 100).toFixed(1)}% (запросов: ${m.cache.requests})`,
      `- Недельный остаток MiniMax: ${m.quota.latestWeeklyRemainingPct !== null ? `${m.quota.latestWeeklyRemainingPct}%` : 'нет данных'}`,
      `- Калибровка MiniMax: ${m.calibration.tokensPerPct !== null ? `${m.calibration.tokensPerPct} токенов/%` : 'недостаточно данных'}`,
      `- Ошибки (>=500 или 429): ${(m.errors.errorRate * 100).toFixed(2)}% (${m.errors.errorResponsesCount}/${m.errors.totalRequests})`,
      `- Fallback с MiniMax: ${(m.errors.fallbackRate * 100).toFixed(1)}%`,
      `- Блокировок Loop Guard: ${m.errors.loopGuard429Count}`,
      '',
      `Отчет сохранен в: ${reportPath}`,
      'Панель управления: /admin/ui#watch',
    ];
    return { subject, text: textLines.join('\n') };
  }

  // Find most severe signal for subject
  const critSignal = report.signals.find((s) => s.level === 'crit');
  const primarySignal = critSignal || report.signals[0];
  const moreCount = report.signals.length - 1;
  const levelPrefix = report.level === 'crit' ? 'CRIT' : 'WARN';
  const subject = `[router] ${levelPrefix}: ${primarySignal.title}${moreCount > 0 ? ` (+ещё ${moreCount})` : ''}`;

  const textLines: string[] = [
    `[AI Router] Ночной отчет вотчера: ${report.level.toUpperCase()}`,
    `Период: с ${report.window.from} по ${report.window.to} UTC`,
    `Сформирован: ${report.generatedAt}`,
    '',
    `Обнаружено сигналов: ${report.signals.length}`,
    '----------------------------------------',
  ];

  for (const s of report.signals) {
    textLines.push(`* [${s.level.toUpperCase()}] ${s.title}`);
    textLines.push(`  ${s.details}`);
  }

  textLines.push(
    '----------------------------------------',
    'Ключевые показатели:',
    `- Доля кэша MiniMax: ${(m.cache.cacheShare * 100).toFixed(1)}% (базовый уровень: ${m.cache.baselineCacheShare !== null ? `${(m.cache.baselineCacheShare * 100).toFixed(1)}%` : 'нет данных'})`,
    `- Недельный остаток MiniMax: ${m.quota.latestWeeklyRemainingPct !== null ? `${m.quota.latestWeeklyRemainingPct}%` : 'нет данных'}`,
    `- Калибровка MiniMax: ${m.calibration.tokensPerPct !== null ? `${m.calibration.tokensPerPct} токенов/%` : 'недостаточно данных'}`,
    `- Доля ошибок: ${(m.errors.errorRate * 100).toFixed(2)}% (${m.errors.errorResponsesCount} из ${m.errors.totalRequests})`,
    `- Fallback с маршрутов MiniMax: ${(m.errors.fallbackRate * 100).toFixed(1)}%`,
    `- Блокировок Loop Guard: ${m.errors.loopGuard429Count}`,
    `- Доставка уведомлений: email ${m.notifications.email.sent}/${m.notifications.email.failed}, telegram ${m.notifications.telegram.sent}/${m.notifications.telegram.failed}`,
    '',
    `Полный JSON отчета: ${reportPath}`,
    'Панель управления: /admin/ui#watch'
  );

  return { subject, text: textLines.join('\n') };
}

/**
 * Runs the watch check and emits event / notification if appropriate.
 */
export async function runWatchCheck(options?: {
  from?: string;
  to?: string;
  now?: number | Date;
  manual?: boolean;
  isManual?: boolean;
  notify?: boolean;
}): Promise<{ report: WatchReport; reportPath: string; eventEmitted: boolean } | null> {
  const isManual = Boolean(options?.isManual || options?.manual);
  const nowMs = typeof options?.now === 'number'
    ? options.now
    : (options?.now instanceof Date ? options.now.getTime() : getNow());

  if (!isManual) {
    const targetDateKey = options?.to ? options.to.slice(0, 10) : computeDefaultWindow(nowMs).to.slice(0, 10);
    const schedState = loadWatchSchedulerState();
    if (schedState.lastScheduledDate === targetDateKey) {
      return null;
    }
  }

  const report = await buildWatchReport({ ...options, isManual });
  const dateKey = report.window.to.slice(0, 10);

  // Determine output file name
  let fileName: string;
  if (isManual) {
    fileName = `manual-${report.generatedAt}.json`;
  } else {
    fileName = `${dateKey}.json`;
  }

  const reportPath = saveWatchReportSync(report, fileName);

  if (!isManual) {
    saveWatchSchedulerState({ lastScheduledDate: dateKey });
  }

  let eventEmitted = false;
  if (isManual) {
    if (options?.notify && report.signals.length > 0) {
      const { subject, text } = formatWatchReportNotificationText(report, reportPath);
      emitRouterEvent({
        type: 'watch.report',
        level: report.level,
        subject,
        text,
        date: `manual-${report.generatedAt}`,
        signals: report.signals.length,
      });
      eventEmitted = true;
    }
  } else {
    // Scheduled run
    if (report.signals.length > 0) {
      const { subject, text } = formatWatchReportNotificationText(report, reportPath);
      emitRouterEvent({
        type: 'watch.report',
        level: report.level,
        subject,
        text,
        date: dateKey,
        signals: report.signals.length,
      });
      eventEmitted = true;
    } else {
      // Weekly digest on Mondays if enabled
      const weeklyOkEnabled = getEnvBool('ROUTER_WATCH_WEEKLY_OK', false);
      const isMonday = new Date(nowMs).getUTCDay() === 1;

      if (weeklyOkEnabled && isMonday) {
        const { subject, text } = formatWatchReportNotificationText(report, reportPath);
        emitRouterEvent({
          type: 'watch.report',
          level: 'ok',
          subject,
          text,
          date: dateKey,
          signals: 0,
        });
        eventEmitted = true;
      }
    }
  }

  return { report, reportPath, eventEmitted };
}

// --- Scheduler Implementation ---

function getSchedulerStatePath(): string {
  return path.join(getWatchDir(), 'state.json');
}

export function loadWatchSchedulerState(): WatchSchedulerState {
  const p = getSchedulerStatePath();
  if (fs.existsSync(p)) {
    try {
      const content = fs.readFileSync(p, 'utf8');
      return JSON.parse(content);
    } catch {}
  }
  return { lastScheduledDate: '' };
}

export function saveWatchSchedulerState(state: WatchSchedulerState): void {
  const dir = getWatchDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const p = getSchedulerStatePath();
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/**
 * Calculates next scheduled run timestamp in milliseconds.
 */
export function getNextWatchRunMs(nowMs = getNow()): number {
  const schedHour = getEnvNum('ROUTER_WATCH_HOUR_UTC', 3);
  const schedMin = getEnvNum('ROUTER_WATCH_MINUTE_UTC', 0);

  const d = new Date(nowMs);
  const todaySchedMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), schedHour, schedMin, 0, 0);

  if (nowMs < todaySchedMs) {
    return todaySchedMs;
  }
  // Next day at the same scheduled UTC time
  const tomorrow = new Date(todaySchedMs + 86_400_000);
  return Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), schedHour, schedMin, 0, 0);
}

function scheduleNextRun(): void {
  if (!isSchedulerRunning) return;

  const nowMs = getNow();
  const nextRunMs = getNextWatchRunMs(nowMs);
  const delayMs = Math.max(100, nextRunMs - nowMs);

  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
  }

  schedulerTimer = setTimeout(async () => {
    try {
      const runNowMs = getNow();
      const todayDateStr = new Date(runNowMs).toISOString().slice(0, 10);
      const st = loadWatchSchedulerState();

      if (st.lastScheduledDate !== todayDateStr) {
        await runWatchCheck({ now: runNowMs, isManual: false });
        saveWatchSchedulerState({ lastScheduledDate: todayDateStr });
      }
    } catch (err) {
      console.error('[watch] Scheduled watch run error:', err);
    } finally {
      scheduleNextRun();
    }
  }, delayMs);

  if (typeof schedulerTimer.unref === 'function') {
    schedulerTimer.unref();
  }
}

export function startWatchScheduler(): void {
  stopWatchScheduler();

  if (process.env.ROUTER_WATCH === 'off') {
    return;
  }

  isSchedulerRunning = true;
  const nowMs = getNow();
  const schedHour = getEnvNum('ROUTER_WATCH_HOUR_UTC', 3);
  const schedMin = getEnvNum('ROUTER_WATCH_MINUTE_UTC', 0);

  const d = new Date(nowMs);
  const todaySchedMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), schedHour, schedMin, 0, 0);
  const todayDateStr = new Date(nowMs).toISOString().slice(0, 10);

  // Catch-up check: if it is already past scheduled time today and today has not run yet
  const st = loadWatchSchedulerState();
  if (nowMs >= todaySchedMs && st.lastScheduledDate !== todayDateStr) {
    runWatchCheck({ now: nowMs, isManual: false })
      .then(() => {
        saveWatchSchedulerState({ lastScheduledDate: todayDateStr });
      })
      .catch((err) => {
        console.error('[watch] Catch-up run error:', err);
      });
  }

  scheduleNextRun();
}

export function stopWatchScheduler(): void {
  isSchedulerRunning = false;
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}

export function resetWatchForTests(): void {
  stopWatchScheduler();
  customClockFn = null;
}
