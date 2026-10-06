import fs from 'node:fs';
import path from 'node:path';
import {
  getMinimaxRemainsStopPct,
  getMinimaxRemainsTightenPct,
  getProviderQuotaStatus,
  MinimaxRemainsSnapshot,
  resetMinimaxRemainsForTests,
} from './provider-quota.js';
import { resolveMinimaxLimits, listTenants } from './tenants.js';
import { emitRouterEvent } from './events.js';

// MiniMax budget guard to prevent runaway usage from draining credits.
// Tracks:
//   - cycle total (default 1.7B / 30 days)
//   - daily global allowance = floor((TOTAL - usedInCycleBeforeToday) / daysLeftInCycleIncludingToday)
//   - per-tenant day and hour limits (0 = no cap)
//   - per-user day and hour limits within a tenant
//
// When over budget, MiniMax direct entries are skipped, as well as ollama-cloud
// entries on censored tiers (to protect shared quota), and local ollama on text-high.

export type OverBudgetReason =
  | 'user-hour'
  | 'user-day'
  | 'tenant-hour'
  | 'tenant-day'
  | 'provider-quota'
  | 'global-day'
  | 'cycle';

export interface TenantLimit {
  day: number;
  hour: number;
}

export interface UserBudgetStatus {
  user: string;
  hourUsed: number;
  hourLimit: number;
  dayUsed: number;
  dayLimit: number;
  over: boolean;
  reason?: OverBudgetReason;
}

export interface TenantQuotaGrant {
  tenant: string;
  requested: {
    day?: number;
    hour?: number;
    user?: { day?: number; hour?: number };
  };
  granted: {
    day: number;
    hour: number;
    user?: { day: number; hour: number };
  };
  limitedBy: 'owner-max' | 'capacity' | 'provider-low' | null;
  expiresAt: string; // ISO 8601 string
  updatedAt: string; // ISO 8601 string
}

export interface TenantQuotaStatus {
  requested: {
    day?: number;
    hour?: number;
    user?: { day?: number; hour?: number };
  } | null;
  granted: {
    day: number;
    hour: number;
    user?: { day: number; hour: number };
  } | null;
  limitedBy: 'owner-max' | 'capacity' | 'provider-low' | null;
  expiresAt: string | null;
}

export interface QuotaProviderStatus {
  weeklyRemainingPercent: number;
  intervalRemainingPercent: number;
  weeklyEnd: string;
  intervalEnd: string;
  fetchedAt: string;
  fresh: boolean;
}

export interface QuotaResponse {
  tenant: string;
  requested: {
    day?: number;
    hour?: number;
    user?: { day?: number; hour?: number };
  } | null;
  granted: {
    day: number;
    hour: number;
    user?: { day: number; hour: number };
  } | null;
  effective: {
    day: number;
    hour: number;
    user: { day: number; hour: number } | null;
    source: 'grant' | 'config';
  };
  limitedBy: 'owner-max' | 'capacity' | 'provider-low' | null;
  expiresAt: string | null;
  updatedAt: string | null;
  usage: {
    dayUsed: number;
    hourUsed: number;
  };
  cycle: {
    start: string;
    end: string;
    total: number;
    usedCycle: number;
    usedCycleRaw: number;
    remaining: number;
    daysLeft: number;
    todayAllowance: number;
    cacheFactor: number;
    provider: QuotaProviderStatus | null;
  };
}

export interface TenantBudgetStatus {
  hourUsed: number;
  hourLimit: number;
  dayUsed: number;
  dayLimit: number;
  over: boolean;
  reason?: OverBudgetReason;
  users?: UserBudgetStatus[];
  quota?: TenantQuotaStatus;
}

export interface BudgetStatus {
  cycleStart: string;
  cycleEnd: string;
  total: number;
  usedCycle: number;
  usedCycleRaw: number;
  todayAllowance: number;
  usedToday: number;
  usedTodayRaw: number;
  cacheFactor: number;
  tenants: Record<string, TenantBudgetStatus>;
  users?: Record<string, UserBudgetStatus[]>;
  provider: {
    snapshot: MinimaxRemainsSnapshot | null;
    fresh: boolean;
    estimates: {
      weeklyQuotaRaw: number | null;
      weeklyQuotaWeighted: number | null;
    };
  };
}

export interface BudgetTokensResult {
  raw: number;
  weighted: number;
  cached: number;
}

export type BudgetUsageTokens = number | { raw: number; weighted: number; cached?: number };

interface BudgetState {
  currentCycleStart: string; // YYYY-MM-DD
  usedCycle: number;
  usedCycleRaw: number;
  daily: Record<string, Record<string, number>>;
  hourly: Record<string, Record<string, number>>;
  usersDaily: Record<string, Record<string, Record<string, number>>>; // dateStr -> tenantId -> userId -> weighted
  usersHourly: Record<string, Record<string, Record<string, number>>>; // hourStr -> tenantId -> userId -> weighted
  quotas: Record<string, TenantQuotaGrant>; // tenantId -> TenantQuotaGrant
}

const DEFAULT_TENANT_LIMITS: Record<string, TenantLimit> = {
  'master-service': { day: 30_000_000, hour: 6_000_000 },
  'companion-app': { day: 15_000_000, hour: 3_000_000 },
  '*': { day: 5_000_000, hour: 1_000_000 },
};

let clockFn: (() => number) | null = null;
let saveTimer: NodeJS.Timeout | null = null;
const lastWarned = new Map<string, number>();
const lastSuccessfulPut = new Map<string, number>();
const exceededEventsEmitted = new Set<string>();
const budgetWarningsEmitted = new Set<string>();

let state: BudgetState = {
  currentCycleStart: '',
  usedCycle: 0,
  usedCycleRaw: 0,
  daily: {},
  hourly: {},
  usersDaily: {},
  usersHourly: {},
  quotas: {},
};
let isLoaded = false;

export function setBudgetClock(fn: (() => number) | null): void {
  clockFn = fn;
}

function getNow(): number {
  return clockFn ? clockFn() : Date.now();
}

function getStateFilePath(): string {
  const dir = process.env.ROUTER_STATE_DIR || './data';
  return path.join(dir, 'budget.json');
}

function getBudgetTotal(): number {
  const v = Number(process.env.ROUTER_MINIMAX_BUDGET_TOTAL);
  return Number.isFinite(v) && v > 0 ? v : 1_700_000_000;
}

function getCycleStartStr(): string {
  return process.env.ROUTER_MINIMAX_CYCLE_START || '2026-09-24';
}

function getCycleDays(): number {
  const v = Number(process.env.ROUTER_MINIMAX_CYCLE_DAYS);
  return Number.isFinite(v) && v > 0 ? v : 30;
}

export function getCacheFactor(): number {
  const raw = process.env.ROUTER_MINIMAX_CACHE_FACTOR;
  if (raw === undefined || raw === null || raw.trim() === '') return 0.1;
  const v = Number(raw);
  if (!Number.isFinite(v) || isNaN(v)) return 0.1;
  return Math.min(1, Math.max(0, v));
}

/**
 * Calculates raw, cache-weighted, and cached tokens from upstream usage.
 * prompt = usage.prompt_tokens; cached = usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? usage.prompt_cache_hit_tokens ?? 0, clamped to [0, prompt]; completion = usage.completion_tokens.
 * raw = prompt + completion; weighted = ceil((prompt - cached) + cached * CACHE_FACTOR + completion).
 * If usage has no token numbers, raw = weighted = fallbackEstimate, cached = 0.
 */
export function budgetTokensFromUsage(
  usage: any,
  fallbackEstimate: number
): BudgetTokensResult {
  const hasPrompt = typeof usage?.prompt_tokens === 'number' && Number.isFinite(usage.prompt_tokens);
  const hasCompletion = typeof usage?.completion_tokens === 'number' && Number.isFinite(usage.completion_tokens);

  if (!hasPrompt && !hasCompletion) {
    return { raw: fallbackEstimate, weighted: fallbackEstimate, cached: 0 };
  }

  const prompt = hasPrompt ? Math.max(0, usage.prompt_tokens) : 0;
  const completion = hasCompletion ? Math.max(0, usage.completion_tokens) : 0;

  let rawCached =
    usage?.prompt_tokens_details?.cached_tokens ??
    usage?.cache_read_input_tokens ??
    usage?.prompt_cache_hit_tokens ??
    0;
  if (typeof rawCached !== 'number' || !Number.isFinite(rawCached)) {
    rawCached = 0;
  }
  const cached = Math.min(Math.max(0, rawCached), prompt);
  const factor = getCacheFactor();
  const raw = prompt + completion;
  const weighted = Math.ceil((prompt - cached) + cached * factor + completion);
  return { raw, weighted, cached };
}

export function getTenantLimitsMap(): Record<string, TenantLimit> {
  const raw = process.env.ROUTER_MINIMAX_TENANT_LIMITS;
  if (!raw) return DEFAULT_TENANT_LIMITS;
  try {
    const parsed = JSON.parse(raw) as Record<string, TenantLimit>;
    return { ...DEFAULT_TENANT_LIMITS, ...parsed };
  } catch (err) {
    console.warn('[budget] Failed to parse ROUTER_MINIMAX_TENANT_LIMITS, using defaults:', err);
    return DEFAULT_TENANT_LIMITS;
  }
}

export function getTenantLimit(tenantId: string): TenantLimit {
  const resolved = resolveMinimaxLimits(tenantId);
  return {
    day: resolved.day ?? 5_000_000,
    hour: resolved.hour ?? 1_000_000,
  };
}

export function getUserLimitsMap(): Record<string, TenantLimit> {
  const raw = process.env.ROUTER_MINIMAX_USER_LIMITS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, TenantLimit>;
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    return {};
  } catch (err) {
    console.warn('[budget] Failed to parse ROUTER_MINIMAX_USER_LIMITS:', err);
    return {};
  }
}

export function getUserLimit(tenantId: string): TenantLimit | null {
  const resolved = resolveMinimaxLimits(tenantId);
  if (!resolved.user) return null;
  return {
    day: typeof resolved.user.day === 'number' ? resolved.user.day : 0,
    hour: typeof resolved.user.hour === 'number' ? resolved.user.hour : 0,
  };
}

export function getOwnerMaxConfig(): Record<string, { dayShare?: number; hourShare?: number }> {
  const raw = process.env.ROUTER_MINIMAX_QUOTA_MAX;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    return {};
  } catch (err) {
    console.warn('[budget] Failed to parse ROUTER_MINIMAX_QUOTA_MAX:', err);
    return {};
  }
}

export function getOwnerMaxShare(
  tenantId: string
): { dayShare?: number; hourShare?: number } | null {
  const resolved = resolveMinimaxLimits(tenantId);
  if (!resolved.quotaMax) return null;
  return resolved.quotaMax;
}

// Owner max in tokens for today. hourShare defaults to dayShare, so a grant is
// always finite: inside a grant 0 means "nothing left", never "no cap".
function getOwnerMaxTokens(
  tenantId: string,
  todayAllowance: number
): { ownerMaxDay: number; ownerMaxHour: number } {
  const cfg = getOwnerMaxShare(tenantId);
  const dayShare = typeof cfg?.dayShare === 'number' ? cfg.dayShare : undefined;
  const hourShare = typeof cfg?.hourShare === 'number' ? cfg.hourShare : dayShare;
  return {
    ownerMaxDay: dayShare === undefined ? Infinity : Math.max(0, Math.floor(dayShare * todayAllowance)),
    ownerMaxHour: hourShare === undefined ? Infinity : Math.max(0, Math.floor(hourShare * todayAllowance)),
  };
}

export function getReserveShare(): number {
  const raw = process.env.ROUTER_MINIMAX_QUOTA_RESERVE_SHARE;
  if (raw === undefined || raw === null || raw.trim() === '') return 0.2;
  const num = Number(raw);
  if (!Number.isFinite(num) || isNaN(num)) return 0.2;
  return Math.min(0.9, Math.max(0, num));
}

function getCapacityDay(tenantId: string, todayAllowance: number, now: number): number {
  const reserveShare = getReserveShare();
  let sumOther = 0;
  if (state.quotas) {
    for (const [tid, grant] of Object.entries(state.quotas)) {
      if (tid !== tenantId && grant) {
        const exp = new Date(grant.expiresAt).getTime();
        if (exp > now) {
          sumOther += grant.granted.day;
        }
      }
    }
  }
  const maxDayAllTenants = (1 - reserveShare) * todayAllowance;
  return maxDayAllTenants - sumOther;
}

export interface QuotaRequestBody {
  day?: number;
  hour?: number;
  user?: {
    day?: number;
    hour?: number;
  };
  ttlSec?: number;
}

export interface ValidationResult {
  valid: boolean;
  error?: {
    message: string;
    param?: string;
  };
}

export function validateQuotaRequestBody(body: any): ValidationResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      valid: false,
      error: { message: 'Request body must be a JSON object' },
    };
  }

  const allowedKeys = new Set(['day', 'hour', 'user', 'ttlSec']);
  for (const k of Object.keys(body)) {
    if (!allowedKeys.has(k)) {
      return {
        valid: false,
        error: { message: `Unrecognized field "${k}" in request body`, param: k },
      };
    }
  }

  if (body.day !== undefined) {
    if (typeof body.day !== 'number' || !Number.isInteger(body.day) || body.day <= 0) {
      return {
        valid: false,
        error: { message: '"day" must be a positive integer', param: 'day' },
      };
    }
  }

  if (body.hour !== undefined) {
    if (typeof body.hour !== 'number' || !Number.isInteger(body.hour) || body.hour <= 0) {
      return {
        valid: false,
        error: { message: '"hour" must be a positive integer', param: 'hour' },
      };
    }
  }

  if (body.ttlSec !== undefined) {
    if (typeof body.ttlSec !== 'number' || !Number.isInteger(body.ttlSec) || body.ttlSec <= 0) {
      return {
        valid: false,
        error: { message: '"ttlSec" must be a positive integer', param: 'ttlSec' },
      };
    }
  }

  if (body.user !== undefined) {
    if (!body.user || typeof body.user !== 'object' || Array.isArray(body.user)) {
      return {
        valid: false,
        error: { message: '"user" must be a JSON object', param: 'user' },
      };
    }

    const allowedUserKeys = new Set(['day', 'hour']);
    for (const uk of Object.keys(body.user)) {
      if (!allowedUserKeys.has(uk)) {
        return {
          valid: false,
          error: { message: `Unrecognized field "${uk}" in "user" object`, param: `user.${uk}` },
        };
      }
    }

    if (body.user.day === undefined && body.user.hour === undefined) {
      return {
        valid: false,
        error: { message: '"user" must contain at least "day" or "hour"', param: 'user' },
      };
    }

    if (body.user.day !== undefined) {
      if (typeof body.user.day !== 'number' || !Number.isInteger(body.user.day) || body.user.day <= 0) {
        return {
          valid: false,
          error: { message: '"user.day" must be a positive integer', param: 'user.day' },
        };
      }
    }

    if (body.user.hour !== undefined) {
      if (typeof body.user.hour !== 'number' || !Number.isInteger(body.user.hour) || body.user.hour <= 0) {
        return {
          valid: false,
          error: { message: '"user.hour" must be a positive integer', param: 'user.hour' },
        };
      }
    }
  }

  // At least one of day, hour, or user must be provided
  if (body.day === undefined && body.hour === undefined && body.user === undefined) {
    return {
      valid: false,
      error: { message: 'At least one of "day", "hour", or "user" must be provided' },
    };
  }

  return { valid: true };
}

export type RequestQuotaResult =
  | { ok: true; data: QuotaResponse }
  | { ok: false; status: 403 | 429 | 400; message: string; retryAfterSec?: number };

export function requestQuotaGrant(
  tenantId: string,
  req: QuotaRequestBody,
  now = getNow()
): RequestQuotaResult {
  syncCycle(now);
  pruneExpiredQuotas(now);

  // Rate limit PUT: at most one successful PUT per tenant per 60s
  const lastPut = lastSuccessfulPut.get(tenantId);
  if (lastPut !== undefined && now - lastPut < 60_000) {
    const retryAfterSec = Math.max(1, Math.ceil((60_000 - (now - lastPut)) / 1000));
    return {
      ok: false,
      status: 429,
      message: `Quota request rate limited. Try again in ${retryAfterSec} seconds.`,
      retryAfterSec,
    };
  }

  // Owner max check
  const ownerMaxConfig = getOwnerMaxShare(tenantId);
  if (!ownerMaxConfig) {
    return {
      ok: false,
      status: 403,
      message: `Tenant '${tenantId}' is not allowed to request quota grants`,
    };
  }

  const todayAllowance = getDailyGlobalAllowance(now);
  const { ownerMaxDay, ownerMaxHour } = getOwnerMaxTokens(tenantId, todayAllowance);

  const capacityDay = getCapacityDay(tenantId, todayAllowance, now);
  const normalCapacityDay = Math.floor(Math.max(0, capacityDay));

  const providerStatus = getProviderQuotaStatus(now);
  const tightenPct = getMinimaxRemainsTightenPct();
  const providerTightened =
    providerStatus.fresh &&
    providerStatus.snapshot !== null &&
    (providerStatus.snapshot.weeklyRemainingPct <= tightenPct ||
      providerStatus.snapshot.intervalRemainingPct <= tightenPct);

  const effectiveCapacityDay = providerTightened
    ? Math.floor(Math.max(0, capacityDay / 2))
    : normalCapacityDay;

  const existingGrant = state.quotas[tenantId];
  const isExistingActive = existingGrant && new Date(existingGrant.expiresAt).getTime() > now;

  const configLimits = getTenantLimit(tenantId);
  const configUserLimits = getUserLimit(tenantId);

  const currentEffectiveDay = isExistingActive ? existingGrant.granted.day : configLimits.day;
  const currentEffectiveHour = isExistingActive ? existingGrant.granted.hour : configLimits.hour;
  const currentEffectiveUser = isExistingActive
    ? existingGrant.granted.user
    : (configUserLimits ? { day: configUserLimits.day, hour: configUserLimits.hour } : undefined);

  // A config value of 0 means "no cap"; a grant is always clamped to owner max
  // and free capacity, so an unrequested window cannot slip through uncapped.
  const orInf = (v: number) => (v > 0 ? v : Infinity);
  const requestedDay = req.day ?? orInf(currentEffectiveDay);
  const grantedDay = Math.floor(
    Math.min(requestedDay, ownerMaxDay, effectiveCapacityDay)
  );
  let grantedHour = Math.min(req.hour ?? orInf(currentEffectiveHour), ownerMaxHour);
  // hour stays uncapped only if the owner set no share at all; store 0 = no cap
  grantedHour = Number.isFinite(grantedHour) ? Math.floor(grantedHour) : 0;

  let grantedUser: { day: number; hour: number } | undefined;
  if (req.user !== undefined) {
    const reqUserDay = req.user.day !== undefined ? req.user.day : (currentEffectiveUser?.day ?? 0);
    const reqUserHour = req.user.hour !== undefined ? req.user.hour : (currentEffectiveUser?.hour ?? 0);
    grantedUser = {
      day: Math.floor(Math.min(reqUserDay, grantedDay)),
      hour: Math.floor(Math.min(reqUserHour, grantedHour)),
    };
  } else if (isExistingActive && existingGrant.granted.user) {
    grantedUser = {
      day: Math.floor(Math.min(existingGrant.granted.user.day, grantedDay)),
      hour: Math.floor(Math.min(existingGrant.granted.user.hour, grantedHour)),
    };
  }

  const grantedDayWithoutTighten = Math.floor(
    Math.min(requestedDay, ownerMaxDay, normalCapacityDay)
  );

  let limitedBy: 'owner-max' | 'capacity' | 'provider-low' | null = null;
  if (req.day !== undefined && grantedDay < req.day) {
    if (providerTightened && grantedDay < grantedDayWithoutTighten) {
      limitedBy = 'provider-low';
    } else if (effectiveCapacityDay < ownerMaxDay) {
      limitedBy = 'capacity';
    } else {
      limitedBy = 'owner-max';
    }
  } else if (req.hour !== undefined && grantedHour < req.hour) {
    limitedBy = 'owner-max';
  } else {
    limitedBy = null;
  }

  const defaultTtlSec = 86400;
  const rawTtlSec = req.ttlSec ?? defaultTtlSec;
  const clampedTtlSec = Math.min(604800, Math.max(300, rawTtlSec));
  const expiresAtMs = now + clampedTtlSec * 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const updatedAt = new Date(now).toISOString();

  const reqDayLog = req.day ?? grantedDay;
  const reqHourLog = req.hour ?? grantedHour;
  const limitedByLog = limitedBy ?? 'none';
  console.log(
    `[budget] quota ${tenantId} requested day=${reqDayLog} hour=${reqHourLog} -> granted day=${grantedDay} hour=${grantedHour} limitedBy=${limitedByLog} ttl=${clampedTtlSec}`
  );

  const requestedObj: { day?: number; hour?: number; user?: { day?: number; hour?: number } } = {};
  if (req.day !== undefined) requestedObj.day = req.day;
  if (req.hour !== undefined) requestedObj.hour = req.hour;
  if (req.user !== undefined) requestedObj.user = req.user;

  const grantRecord: TenantQuotaGrant = {
    tenant: tenantId,
    requested: requestedObj,
    granted: {
      day: grantedDay,
      hour: grantedHour,
      ...(grantedUser ? { user: grantedUser } : {}),
    },
    limitedBy,
    expiresAt,
    updatedAt,
  };

  state.quotas[tenantId] = grantRecord;
  lastSuccessfulPut.set(tenantId, now);
  saveBudgetSync();

  const status = getQuotaStatus(tenantId, now);
  return { ok: true, data: status };
}

export function getQuotaStatus(tenantId: string, now = getNow()): QuotaResponse {
  syncCycle(now);
  pruneExpiredQuotas(now);

  const total = getBudgetTotal();
  const { cycleStartStr, cycleEndStr, daysLeftIncludingToday } = calculateCycle(now);
  const todayStr = new Date(now).toISOString().slice(0, 10);
  const hourStr = new Date(now).toISOString().slice(0, 13);
  const todayAllowance = getDailyGlobalAllowance(now);
  const cacheFactor = getCacheFactor();
  const providerStatus = getProviderQuotaStatus(now);

  const grant = state.quotas[tenantId];
  const isGrantActive = grant && new Date(grant.expiresAt).getTime() > now;

  let effectiveDay: number;
  let effectiveHour: number;
  let effectiveUser: { day: number; hour: number } | null = null;
  let source: 'grant' | 'config';

  const configLimits = getTenantLimit(tenantId);
  const configUserLimits = getUserLimit(tenantId);

  if (isGrantActive) {
    source = 'grant';
    const { ownerMaxDay, ownerMaxHour } = getOwnerMaxTokens(tenantId, todayAllowance);

    effectiveDay = Math.min(grant.granted.day, ownerMaxDay);
    effectiveHour = Math.min(grant.granted.hour, ownerMaxHour);

    if (grant.granted.user) {
      effectiveUser = {
        day: Math.min(grant.granted.user.day, effectiveDay),
        hour: Math.min(grant.granted.user.hour, effectiveHour),
      };
    } else if (configUserLimits) {
      effectiveUser = {
        day: configUserLimits.day,
        hour: configUserLimits.hour,
      };
    }
  } else {
    source = 'config';
    effectiveDay = configLimits.day;
    effectiveHour = configLimits.hour;
    effectiveUser = configUserLimits ? { day: configUserLimits.day, hour: configUserLimits.hour } : null;
  }

  const dayUsed = state.daily[todayStr]?.[tenantId] ?? 0;
  const hourUsed = state.hourly[hourStr]?.[tenantId] ?? 0;

  return {
    tenant: tenantId,
    requested: isGrantActive ? grant.requested : null,
    granted: isGrantActive ? grant.granted : null,
    effective: {
      day: effectiveDay,
      hour: effectiveHour,
      user: effectiveUser,
      source,
    },
    limitedBy: isGrantActive ? grant.limitedBy : null,
    expiresAt: isGrantActive ? grant.expiresAt : null,
    updatedAt: isGrantActive ? grant.updatedAt : null,
    usage: {
      dayUsed,
      hourUsed,
    },
    cycle: {
      start: cycleStartStr,
      end: cycleEndStr,
      total,
      usedCycle: state.usedCycle,
      usedCycleRaw: state.usedCycleRaw,
      remaining: Math.max(0, total - state.usedCycle),
      daysLeft: daysLeftIncludingToday,
      todayAllowance,
      cacheFactor,
      provider: providerStatus.snapshot
        ? {
            weeklyRemainingPercent: providerStatus.snapshot.weeklyRemainingPct,
            intervalRemainingPercent: providerStatus.snapshot.intervalRemainingPct,
            weeklyEnd: new Date(providerStatus.snapshot.weeklyEnd).toISOString(),
            intervalEnd: new Date(providerStatus.snapshot.intervalEnd).toISOString(),
            fetchedAt: new Date(providerStatus.snapshot.fetchedAt).toISOString(),
            fresh: providerStatus.fresh,
          }
        : null,
    },
  };
}

export function deleteQuotaGrant(tenantId: string, _now = getNow()): boolean {
  ensureLoaded();
  if (state.quotas && state.quotas[tenantId]) {
    delete state.quotas[tenantId];
    saveBudgetSync();
    return true;
  }
  return false;
}

function calculateCycle(now: number): {
  cycleStartMs: number;
  cycleEndMs: number;
  cycleStartStr: string;
  cycleEndStr: string;
  dayIndexInCycle: number;
  daysLeftIncludingToday: number;
} {
  const baseStartStr = getCycleStartStr();
  const baseStartMs = Date.parse(`${baseStartStr}T00:00:00.000Z`);
  const cycleDays = getCycleDays();
  const cycleDurationMs = cycleDays * 86_400_000;

  let cycleIndex = 0;
  if (now >= baseStartMs) {
    cycleIndex = Math.floor((now - baseStartMs) / cycleDurationMs);
  }
  const cycleStartMs = baseStartMs + cycleIndex * cycleDurationMs;
  const cycleEndMs = cycleStartMs + cycleDurationMs;
  const cycleStartStr = new Date(cycleStartMs).toISOString().slice(0, 10);
  const cycleEndStr = new Date(cycleEndMs).toISOString().slice(0, 10);

  const todayStr = new Date(now).toISOString().slice(0, 10);
  const todayStartMs = Date.parse(`${todayStr}T00:00:00.000Z`);
  const dayIndexInCycle = Math.floor((todayStartMs - cycleStartMs) / 86_400_000);
  const daysLeftIncludingToday = Math.max(1, cycleDays - dayIndexInCycle);

  return {
    cycleStartMs,
    cycleEndMs,
    cycleStartStr,
    cycleEndStr,
    dayIndexInCycle,
    daysLeftIncludingToday,
  };
}

function ensureLoaded(): void {
  if (isLoaded) return;
  isLoaded = true;

  const filePath = getStateFilePath();
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content) as any;
      if (parsed && typeof parsed === 'object') {
        const usedCycle = Number(parsed.usedCycle) || 0;
        state = {
          currentCycleStart: parsed.currentCycleStart || '',
          usedCycle,
          usedCycleRaw: Number(parsed.usedCycleRaw ?? usedCycle) || 0,
          daily: parsed.daily || {},
          hourly: parsed.hourly || {},
          usersDaily: parsed.usersDaily || {},
          usersHourly: parsed.usersHourly || {},
          quotas: parsed.quotas || {},
        };
      }
    } catch (err) {
      console.warn('[budget] Failed to parse budget state file, starting empty:', err);
    }
  }
}

export function pruneExpiredQuotas(now = getNow()): void {
  if (!state.quotas) return;
  for (const [tid, grant] of Object.entries(state.quotas)) {
    if (!grant || new Date(grant.expiresAt).getTime() <= now) {
      delete state.quotas[tid];
    }
  }
}

function pruneOldBuckets(now: number): void {
  pruneExpiredQuotas(now);
  const cutoff40d = now - 40 * 86_400_000;
  for (const dateKey of Object.keys(state.daily)) {
    const time = Date.parse(`${dateKey}T00:00:00.000Z`);
    if (Number.isFinite(time) && time < cutoff40d) {
      delete state.daily[dateKey];
    }
  }
  if (state.usersDaily) {
    for (const dateKey of Object.keys(state.usersDaily)) {
      const time = Date.parse(`${dateKey}T00:00:00.000Z`);
      if (Number.isFinite(time) && time < cutoff40d) {
        delete state.usersDaily[dateKey];
      }
    }
  }

  const cutoff48h = now - 48 * 3_600_000;
  for (const hourKey of Object.keys(state.hourly)) {
    const time = Date.parse(`${hourKey}:00:00.000Z`);
    if (Number.isFinite(time) && time < cutoff48h) {
      delete state.hourly[hourKey];
    }
  }
  if (state.usersHourly) {
    for (const hourKey of Object.keys(state.usersHourly)) {
      const time = Date.parse(`${hourKey}:00:00.000Z`);
      if (Number.isFinite(time) && time < cutoff48h) {
        delete state.usersHourly[hourKey];
      }
    }
  }
}

export function saveBudgetSync(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    const filePath = getStateFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    pruneOldBuckets(getNow());
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error('[budget] Failed to save budget state synchronously:', err);
  }
}

function scheduleSaveDebounced(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveBudgetSync();
  }, 30_000);
  saveTimer.unref?.();
}

function syncCycle(now: number): void {
  ensureLoaded();
  const { cycleStartStr } = calculateCycle(now);
  if (state.currentCycleStart !== cycleStartStr) {
    state.currentCycleStart = cycleStartStr;
    state.usedCycle = 0;
    state.usedCycleRaw = 0;
  }
}

/**
 * Calculates the current daily global allowance.
 * Daily allowance = floor((TOTAL - usedInCycleBeforeToday) / daysLeftInCycleIncludingToday)
 */
export function getDailyGlobalAllowance(now = getNow()): number {
  syncCycle(now);
  const total = getBudgetTotal();
  const { daysLeftIncludingToday } = calculateCycle(now);
  const todayStr = new Date(now).toISOString().slice(0, 10);
  const usedToday = state.daily[todayStr]?.__total__ ?? 0;
  const usedInCycleBeforeToday = Math.max(0, state.usedCycle - usedToday);
  const remaining = Math.max(0, total - usedInCycleBeforeToday);
  return Math.floor(remaining / daysLeftIncludingToday);
}

/**
 * Checks whether a tenant (and optionally a user) is over budget.
 * Check order: user-hour, user-day, tenant-hour, tenant-day, global-day, cycle.
 * Tenant limit value of 0 means "no cap" for that window.
 * Returns null if within budget, or { reason } if exceeded.
 */
export function isOverBudget(
  tenantId: string,
  nowOrOptions?: number | { now?: number; userId?: string },
  maybeUserId?: string
): { reason: OverBudgetReason } | null {
  let now = getNow();
  let userId: string | undefined;

  if (typeof nowOrOptions === 'number') {
    now = nowOrOptions;
    userId = maybeUserId;
  } else if (nowOrOptions && typeof nowOrOptions === 'object') {
    now = nowOrOptions.now ?? getNow();
    userId = nowOrOptions.userId ?? maybeUserId;
  } else {
    userId = maybeUserId;
  }

  syncCycle(now);
  pruneExpiredQuotas(now);
  const todayStr = new Date(now).toISOString().slice(0, 10);
  const hourStr = new Date(now).toISOString().slice(0, 13);
  const todayAllowance = getDailyGlobalAllowance(now);

  const grant = state.quotas?.[tenantId];
  const isGrantActive = grant && new Date(grant.expiresAt).getTime() > now;

  let tenantLimits: TenantLimit;
  let userLimits: TenantLimit | null = null;

  if (isGrantActive) {
    const { ownerMaxDay, ownerMaxHour } = getOwnerMaxTokens(tenantId, todayAllowance);

    const effectiveDay = Math.min(grant.granted.day, ownerMaxDay);
    const effectiveHour = Math.min(grant.granted.hour, ownerMaxHour);
    tenantLimits = { day: effectiveDay, hour: effectiveHour };

    if (grant.granted.user) {
      userLimits = {
        day: Math.min(grant.granted.user.day, effectiveDay),
        hour: Math.min(grant.granted.user.hour, effectiveHour),
      };
    } else {
      userLimits = getUserLimit(tenantId);
    }
  } else {
    tenantLimits = getTenantLimit(tenantId);
    userLimits = getUserLimit(tenantId);
  }

  // 1. Check user limits if user id provided and user limits configured for this tenant
  if (userId && userLimits) {
    if (userLimits.hour > 0) {
      const userHourUsed = state.usersHourly[hourStr]?.[tenantId]?.[userId] ?? 0;
      if (userHourUsed >= userLimits.hour) {
        return { reason: 'user-hour' };
      }
    }
    if (userLimits.day > 0) {
      const userDayUsed = state.usersDaily[todayStr]?.[tenantId]?.[userId] ?? 0;
      if (userDayUsed >= userLimits.day) {
        return { reason: 'user-day' };
      }
    }
  }

  function emitBudgetExceededOnce(tId: string, reason: OverBudgetReason, hStr: string): void {
    const key = `${tId}:${reason}:${hStr}`;
    if (!exceededEventsEmitted.has(key)) {
      exceededEventsEmitted.add(key);
      emitRouterEvent({ type: 'budget.exceeded', tenantId: tId, reason });
    }
  }

  // 2. Check tenant limits. Config: 0 means no cap. Grant: a day of 0 means
  // nothing was granted (capacity exhausted) and blocks MiniMax.
  if (tenantLimits.hour > 0) {
    const hourUsed = state.hourly[hourStr]?.[tenantId] ?? 0;
    if (hourUsed >= tenantLimits.hour) {
      emitBudgetExceededOnce(tenantId, 'tenant-hour', hourStr);
      return { reason: 'tenant-hour' };
    }
  }

  if (tenantLimits.day > 0 || isGrantActive) {
    const dayUsed = state.daily[todayStr]?.[tenantId] ?? 0;
    if (dayUsed >= tenantLimits.day) {
      emitBudgetExceededOnce(tenantId, 'tenant-day', hourStr);
      return { reason: 'tenant-day' };
    }
  }

  // 3. Provider Quota Gating (checked after user/tenant limits, before global-day; only when fresh)
  const providerStatus = getProviderQuotaStatus(now);
  if (providerStatus.fresh && providerStatus.snapshot) {
    const stopPct = getMinimaxRemainsStopPct();
    if (
      providerStatus.snapshot.weeklyRemainingPct <= stopPct ||
      providerStatus.snapshot.intervalRemainingPct <= stopPct
    ) {
      return { reason: 'provider-quota' };
    }
  }

  // 4. Check global daily allowance
  // When the snapshot is fresh and weeklyRemainingPct > tighten, the 'global-day' check is relaxed: skip it
  // (the real provider quota is the authority). Keep 'cycle' as is.
  const tightenPct = getMinimaxRemainsTightenPct();
  const relaxGlobalDay =
    providerStatus.fresh &&
    providerStatus.snapshot !== null &&
    providerStatus.snapshot.weeklyRemainingPct > tightenPct;

  if (!relaxGlobalDay) {
    const usedToday = state.daily[todayStr]?.__total__ ?? 0;
    if (usedToday >= todayAllowance) {
      return { reason: 'global-day' };
    }
  }

  // 5. Check monthly cycle total
  const total = getBudgetTotal();
  if (state.usedCycle >= total) {
    return { reason: 'cycle' };
  }

  return null;
}

export function warnBudgetOnce(
  tenantId: string,
  reason: string,
  nowOrUser?: number | string,
  maybeUserOrNow?: string | number
): void {
  let now = getNow();
  let userId: string | undefined;

  if (typeof nowOrUser === 'number') {
    now = nowOrUser;
    userId = typeof maybeUserOrNow === 'string' ? maybeUserOrNow : undefined;
  } else if (typeof nowOrUser === 'string') {
    userId = nowOrUser;
    now = typeof maybeUserOrNow === 'number' ? maybeUserOrNow : getNow();
  } else {
    // (tenant, tokens, undefined, user) — how chat.ts calls it. Dropping the
    // user here left every per-user bucket empty (28.09).
    userId = typeof maybeUserOrNow === 'string' ? maybeUserOrNow : undefined;
    if (typeof maybeUserOrNow === 'number') now = maybeUserOrNow;
  }

  const userKey = userId || '-';
  const warnKey = `${tenantId}:${userKey}`;
  const last = lastWarned.get(warnKey);
  const oneHourMs = 3600 * 1000;
  if (!last || now - last >= oneHourMs) {
    console.warn(`[budget] ${tenantId} user=${userKey} over (${reason}) → MiniMax skipped`);
    lastWarned.set(warnKey, now);
  }
}

/**
 * Records token consumption for a tenant and updates all buckets.
 * Accepts plain number (compatible with existing tests) or { raw, weighted } split.
 */
export function recordBudgetUsage(
  tenantId: string,
  tokens: BudgetUsageTokens,
  nowOrUser?: number | string,
  maybeUserOrNow?: string | number
): void {
  let now = getNow();
  let userId: string | undefined;

  if (typeof nowOrUser === 'number') {
    now = nowOrUser;
    userId = typeof maybeUserOrNow === 'string' ? maybeUserOrNow : undefined;
  } else if (typeof nowOrUser === 'string') {
    userId = nowOrUser;
    now = typeof maybeUserOrNow === 'number' ? maybeUserOrNow : getNow();
  } else {
    // (tenant, tokens, undefined, user) — how chat.ts calls it. Dropping the
    // user here left every per-user bucket empty (28.09).
    userId = typeof maybeUserOrNow === 'string' ? maybeUserOrNow : undefined;
    if (typeof maybeUserOrNow === 'number') now = maybeUserOrNow;
  }

  let raw = 0;
  let weighted = 0;
  if (typeof tokens === 'number') {
    raw = tokens;
    weighted = tokens;
  } else if (tokens && typeof tokens === 'object') {
    raw = Number(tokens.raw) || 0;
    weighted = Number(tokens.weighted) || 0;
  }

  if (raw <= 0 && weighted <= 0) return;

  syncCycle(now);

  const todayStr = new Date(now).toISOString().slice(0, 10);
  const hourStr = new Date(now).toISOString().slice(0, 13);

  state.usedCycle += weighted;
  state.usedCycleRaw += raw;

  // Daily bucket
  let dayRecord = state.daily[todayStr];
  if (!dayRecord) {
    dayRecord = { __total__: 0, __raw__: 0 };
    state.daily[todayStr] = dayRecord;
  }
  if (dayRecord.__raw__ === undefined) {
    dayRecord.__raw__ = dayRecord.__total__;
  }
  dayRecord[tenantId] = (dayRecord[tenantId] ?? 0) + weighted;
  dayRecord.__total__ = (dayRecord.__total__ ?? 0) + weighted;
  dayRecord.__raw__ = (dayRecord.__raw__ ?? 0) + raw;

  const tLimit = getTenantLimit(tenantId);
  if (tLimit.day > 0 && dayRecord[tenantId] >= Math.ceil(0.8 * tLimit.day)) {
    const warnKey = `${tenantId}:${todayStr}:budget-day-80`;
    if (!budgetWarningsEmitted.has(warnKey)) {
      budgetWarningsEmitted.add(warnKey);
      emitRouterEvent({
        type: 'budget.warning',
        tenantId,
        window: 'day',
        percent: 80,
      });
    }
  }

  // Hourly bucket
  let hourRecord = state.hourly[hourStr];
  if (!hourRecord) {
    hourRecord = {};
    state.hourly[hourStr] = hourRecord;
  }
  hourRecord[tenantId] = (hourRecord[tenantId] ?? 0) + weighted;

  // Per-user buckets
  if (userId) {
    if (!state.usersDaily[todayStr]) {
      state.usersDaily[todayStr] = {};
    }
    if (!state.usersDaily[todayStr][tenantId]) {
      state.usersDaily[todayStr][tenantId] = {};
    }
    state.usersDaily[todayStr][tenantId][userId] =
      (state.usersDaily[todayStr][tenantId][userId] ?? 0) + weighted;

    if (!state.usersHourly[hourStr]) {
      state.usersHourly[hourStr] = {};
    }
    if (!state.usersHourly[hourStr][tenantId]) {
      state.usersHourly[hourStr][tenantId] = {};
    }
    state.usersHourly[hourStr][tenantId][userId] =
      (state.usersHourly[hourStr][tenantId][userId] ?? 0) + weighted;
  }

  scheduleSaveDebounced();
}

export function getBudgetStatus(now = getNow()): BudgetStatus {
  syncCycle(now);
  pruneExpiredQuotas(now);
  const { cycleStartStr, cycleEndStr } = calculateCycle(now);
  const total = getBudgetTotal();
  const todayStr = new Date(now).toISOString().slice(0, 10);
  const hourStr = new Date(now).toISOString().slice(0, 13);

  const usedToday = state.daily[todayStr]?.__total__ ?? 0;
  const usedTodayRaw = state.daily[todayStr]?.__raw__ ?? usedToday;
  const todayAllowance = getDailyGlobalAllowance(now);
  const cacheFactor = getCacheFactor();

  const tenantIds = new Set<string>();
  const limitsMap = getTenantLimitsMap();
  for (const tid of Object.keys(limitsMap)) {
    if (tid !== '*') tenantIds.add(tid);
  }
  for (const t of listTenants()) {
    if (t.id !== '*') tenantIds.add(t.id);
  }
  const userLimitsMap = getUserLimitsMap();
  for (const tid of Object.keys(userLimitsMap)) {
    if (tid !== '*') tenantIds.add(tid);
  }
  if (state.daily[todayStr]) {
    for (const tid of Object.keys(state.daily[todayStr])) {
      if (tid !== '__total__' && tid !== '__raw__') tenantIds.add(tid);
    }
  }
  if (state.hourly[hourStr]) {
    for (const tid of Object.keys(state.hourly[hourStr])) {
      tenantIds.add(tid);
    }
  }
  if (state.quotas) {
    for (const [tid, grant] of Object.entries(state.quotas)) {
      if (grant && new Date(grant.expiresAt).getTime() > now) {
        tenantIds.add(tid);
      }
    }
  }

  const tenants: Record<string, TenantBudgetStatus> = {};
  const statusUsers: Record<string, UserBudgetStatus[]> = {};

  for (const tid of tenantIds) {
    const grant = state.quotas?.[tid];
    const isGrantActive = grant && new Date(grant.expiresAt).getTime() > now;

    let dayLimit: number;
    let hourLimit: number;
    let effectiveUserLimit: TenantLimit | null = null;
    let quotaInfo: TenantQuotaStatus | undefined;

    if (isGrantActive) {
      const { ownerMaxDay, ownerMaxHour } = getOwnerMaxTokens(tid, todayAllowance);

      dayLimit = Math.min(grant.granted.day, ownerMaxDay);
      hourLimit = Math.min(grant.granted.hour, ownerMaxHour);

      if (grant.granted.user) {
        effectiveUserLimit = {
          day: Math.min(grant.granted.user.day, dayLimit),
          hour: Math.min(grant.granted.user.hour, hourLimit),
        };
      } else {
        effectiveUserLimit = getUserLimit(tid);
      }

      quotaInfo = {
        requested: grant.requested,
        granted: grant.granted,
        limitedBy: grant.limitedBy,
        expiresAt: grant.expiresAt,
      };
    } else {
      const limits = getTenantLimit(tid);
      dayLimit = limits.day;
      hourLimit = limits.hour;
      effectiveUserLimit = getUserLimit(tid);
    }

    const hourUsed = state.hourly[hourStr]?.[tid] ?? 0;
    const dayUsed = state.daily[todayStr]?.[tid] ?? 0;
    const overResult = isOverBudget(tid, now);

    const tenantStatus: TenantBudgetStatus = {
      hourUsed,
      hourLimit,
      dayUsed,
      dayLimit,
      over: overResult !== null,
      reason: overResult?.reason,
      quota: quotaInfo,
    };

    if (effectiveUserLimit) {
      const usersToday = new Set<string>();
      const dailyUsers = state.usersDaily?.[todayStr]?.[tid];
      if (dailyUsers) {
        for (const u of Object.keys(dailyUsers)) usersToday.add(u);
      }
      const hourlyUsers = state.usersHourly?.[hourStr]?.[tid];
      if (hourlyUsers) {
        for (const u of Object.keys(hourlyUsers)) usersToday.add(u);
      }

      const userList: UserBudgetStatus[] = [];
      for (const u of usersToday) {
        const uDayUsed = dailyUsers?.[u] ?? 0;
        const uHourUsed = hourlyUsers?.[u] ?? 0;
        let uOver = false;
        let uReason: OverBudgetReason | undefined;

        if (effectiveUserLimit.hour > 0 && uHourUsed >= effectiveUserLimit.hour) {
          uOver = true;
          uReason = 'user-hour';
        } else if (effectiveUserLimit.day > 0 && uDayUsed >= effectiveUserLimit.day) {
          uOver = true;
          uReason = 'user-day';
        }

        userList.push({
          user: u,
          hourUsed: uHourUsed,
          hourLimit: effectiveUserLimit.hour,
          dayUsed: uDayUsed,
          dayLimit: effectiveUserLimit.day,
          over: uOver,
          reason: uReason,
        });
      }

      userList.sort((a, b) => b.dayUsed - a.dayUsed);
      const top50 = userList.slice(0, 50);
      tenantStatus.users = top50;
      statusUsers[tid] = top50;
    }

    tenants[tid] = tenantStatus;
  }

  const providerStatus = getProviderQuotaStatus(now);

  return {
    cycleStart: cycleStartStr,
    cycleEnd: cycleEndStr,
    total,
    usedCycle: state.usedCycle,
    usedCycleRaw: state.usedCycleRaw,
    todayAllowance,
    usedToday,
    usedTodayRaw,
    cacheFactor,
    tenants,
    users: statusUsers,
    provider: {
      snapshot: providerStatus.snapshot,
      fresh: providerStatus.fresh,
      estimates: providerStatus.estimates,
    },
  };
}

export function getBudgetRangeSums(
  startDateOrMs: string | number,
  endDateOrMs: string | number
): { raw: number; weighted: number } {
  ensureLoaded();
  const startStr = typeof startDateOrMs === 'number'
    ? new Date(startDateOrMs).toISOString().slice(0, 10)
    : startDateOrMs.slice(0, 10);
  const endStr = typeof endDateOrMs === 'number'
    ? new Date(endDateOrMs).toISOString().slice(0, 10)
    : endDateOrMs.slice(0, 10);

  let raw = 0;
  let weighted = 0;

  for (const [dateKey, dayRecord] of Object.entries(state.daily)) {
    if (dateKey >= startStr && dateKey <= endStr) {
      const dayWeighted = dayRecord.__total__ ?? 0;
      const dayRaw = dayRecord.__raw__ ?? dayWeighted;
      weighted += dayWeighted;
      raw += dayRaw;
    }
  }

  return { raw, weighted };
}

export function getTenantBudgetDailyUsage(dateStr: string): Record<string, number> {
  ensureLoaded();
  const day = state.daily[dateStr];
  if (!day) return {};
  const res: Record<string, number> = {};
  for (const [k, v] of Object.entries(day)) {
    if (k !== '__total__' && k !== '__raw__') {
      res[k] = v;
    }
  }
  return res;
}

export function getRouterCountersForRemains(weeklyStartMs: number, now = getNow()): {
  routerWeekRaw: number;
  routerWeekWeighted: number;
  routerCycleRaw: number;
  usedCycle: number;
} {
  ensureLoaded();
  const { raw, weighted } = getBudgetRangeSums(weeklyStartMs, now);
  return {
    routerWeekRaw: raw,
    routerWeekWeighted: weighted,
    routerCycleRaw: state.usedCycleRaw,
    usedCycle: state.usedCycle,
  };
}

export function resetBudgetForTests(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  state = {
    currentCycleStart: '',
    usedCycle: 0,
    usedCycleRaw: 0,
    daily: {},
    hourly: {},
    usersDaily: {},
    usersHourly: {},
    quotas: {},
  };
  lastSuccessfulPut.clear();
  isLoaded = true;
  lastWarned.clear();
  exceededEventsEmitted.clear();
  budgetWarningsEmitted.clear();
  clockFn = null;
  resetMinimaxRemainsForTests();
}

export function reloadBudgetFromDisk(): void {
  isLoaded = false;
  ensureLoaded();
}
