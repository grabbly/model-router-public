import fs from 'node:fs';
import path from 'node:path';
import { getTenant, resolveRateLimits } from './tenants.js';
import { emitRouterEvent } from './events.js';

export interface TenantRateUsage {
  rpmWindow: number;
  inFlight: number;
  dayRequests: number;
}

export type TenantRateCheckResult =
  | { ok: true; release: () => void }
  | {
      ok: false;
      limit: 'rpm' | 'concurrent' | 'day';
      errorCode: 'rate_limited' | 'too_many_concurrent' | 'daily_request_limit';
      retryAfterSec: number;
      message: string;
    };

interface TenantUsageFile {
  version: 1;
  daily: Record<string, Record<string, number>>; // dateStr -> tenantId -> count
}

const inFlight = new Map<string, number>();
const tenantWindows = new Map<string, number[]>();
const agentWindows = new Map<string, number[]>();
const dayWarningsEmitted = new Set<string>();

let dailyUsage: Record<string, Record<string, number>> = {};
let isLoaded = false;
let saveTimer: NodeJS.Timeout | null = null;
let clockFn: (() => number) | null = null;

function getNow(): number {
  return clockFn ? clockFn() : Date.now();
}

export function setTenantRateClock(fn: (() => number) | null): void {
  clockFn = fn;
}

function getStateFilePath(): string {
  const dir = process.env.ROUTER_STATE_DIR || './data';
  return path.join(dir, 'tenant-usage.json');
}

function ensureLoaded(): void {
  if (isLoaded) return;
  isLoaded = true;

  const filePath = getStateFilePath();
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content) as TenantUsageFile;
      if (parsed && typeof parsed === 'object' && parsed.version === 1 && parsed.daily) {
        dailyUsage = parsed.daily;
      }
    } catch (err) {
      console.warn('[tenant-rate] Failed to parse tenant-usage.json, starting empty:', err);
      dailyUsage = {};
    }
  }
}

function pruneOldDays(now: number): void {
  const cutoff7d = now - 7 * 86_400_000;
  for (const dateKey of Object.keys(dailyUsage)) {
    const time = Date.parse(`${dateKey}T00:00:00.000Z`);
    if (Number.isFinite(time) && time < cutoff7d) {
      delete dailyUsage[dateKey];
    }
  }
}

/**
 * Synchronously persists daily request counters to disk.
 */
export function saveTenantUsageSync(): void {
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
    pruneOldDays(getNow());

    const fileContent: TenantUsageFile = {
      version: 1,
      daily: dailyUsage,
    };
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(fileContent, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error('[tenant-rate] Failed to save tenant-usage.json synchronously:', err);
  }
}

function scheduleSaveDebounced(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveTenantUsageSync();
  }, 30_000);
  saveTimer.unref?.();
}

function cleanWindow(arr: number[] | undefined, cutoff: number): number[] {
  if (!arr || arr.length === 0) return [];
  const filtered = arr.filter((t) => t >= cutoff);
  return filtered;
}

/**
 * Checks per-tenant rate limits: dayRequests, concurrent, and rpm.
 * If limits are not exceeded, acquires the in-flight slot, updates counters,
 * and returns { ok: true, release }.
 */
export function checkTenantRate(
  tenantId: string,
  agent?: string,
  now = getNow()
): TenantRateCheckResult {
  ensureLoaded();
  const limits = resolveRateLimits(tenantId, agent);

  const todayStr = new Date(now).toISOString().slice(0, 10);
  const curDayRequests = dailyUsage[todayStr]?.[tenantId] ?? 0;
  const curInFlight = inFlight.get(tenantId) ?? 0;

  const windowCutoff = now - 60_000;
  const tWindow = cleanWindow(tenantWindows.get(tenantId), windowCutoff);
  tenantWindows.set(tenantId, tWindow);

  const tenantRecord = getTenant(tenantId);
  const starRecord = getTenant('*');
  const tenantRpm = tenantRecord?.limits?.rate?.rpm ?? starRecord?.limits?.rate?.rpm;
  const agentOverrideRpm = agent && tenantRecord?.limits?.agents?.[agent]?.rate?.rpm !== undefined
    ? tenantRecord.limits.agents[agent]?.rate?.rpm
    : undefined;

  let aWindow: number[] | undefined;
  if (agent && agentOverrideRpm !== undefined) {
    const agentKey = `${tenantId}:${agent}`;
    aWindow = cleanWindow(agentWindows.get(agentKey), windowCutoff);
    agentWindows.set(agentKey, aWindow);
  }

  // 1. Check daily request limit
  if (limits.dayRequests && limits.dayRequests > 0 && curDayRequests >= limits.dayRequests) {
    const d = new Date(now);
    const nextMidnightMs = Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() + 1,
      0, 0, 0, 0
    );
    const retryAfterSec = Math.max(1, Math.ceil((nextMidnightMs - now) / 1000));

    emitRouterEvent({
      type: 'limit.reached',
      tenantId,
      limit: 'day',
      current: curDayRequests,
      max: limits.dayRequests,
    });

    return {
      ok: false,
      limit: 'day',
      errorCode: 'daily_request_limit',
      retryAfterSec,
      message: 'Daily request limit reached for this tenant',
    };
  }

  // 2. Check concurrent request limit
  if (limits.concurrent && limits.concurrent > 0 && curInFlight >= limits.concurrent) {
    emitRouterEvent({
      type: 'limit.reached',
      tenantId,
      limit: 'concurrent',
      current: curInFlight,
      max: limits.concurrent,
    });

    return {
      ok: false,
      limit: 'concurrent',
      errorCode: 'too_many_concurrent',
      retryAfterSec: 1,
      message: 'Too many concurrent requests for this tenant',
    };
  }

  // 3. Check agent-specific rpm override if present
  if (agent && agentOverrideRpm !== undefined && agentOverrideRpm > 0 && aWindow && aWindow.length >= agentOverrideRpm) {
    const oldest = aWindow[aWindow.length - agentOverrideRpm];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000));

    emitRouterEvent({
      type: 'limit.reached',
      tenantId,
      agent,
      limit: 'rpm',
      current: aWindow.length,
      max: agentOverrideRpm,
    });

    return {
      ok: false,
      limit: 'rpm',
      errorCode: 'rate_limited',
      retryAfterSec,
      message: 'Rate limit exceeded (rpm) for this agent',
    };
  }

  // 4. Check tenant rpm limit
  if (tenantRpm && tenantRpm > 0 && tWindow.length >= tenantRpm) {
    const oldest = tWindow[tWindow.length - tenantRpm];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000));

    emitRouterEvent({
      type: 'limit.reached',
      tenantId,
      limit: 'rpm',
      current: tWindow.length,
      max: tenantRpm,
    });

    return {
      ok: false,
      limit: 'rpm',
      errorCode: 'rate_limited',
      retryAfterSec,
      message: 'Rate limit exceeded (rpm)',
    };
  }

  // Admitted: update state
  inFlight.set(tenantId, curInFlight + 1);
  tWindow.push(now);
  if (aWindow) {
    aWindow.push(now);
  }

  if (!dailyUsage[todayStr]) {
    dailyUsage[todayStr] = {};
  }
  const newDayRequests = curDayRequests + 1;
  dailyUsage[todayStr][tenantId] = newDayRequests;
  scheduleSaveDebounced();

  // Check 80% daily limit warning
  if (limits.dayRequests && limits.dayRequests > 0) {
    const threshold80 = Math.ceil(0.8 * limits.dayRequests);
    const warnKey = `${tenantId}:${todayStr}:dayRequests-80`;
    if (newDayRequests >= threshold80 && !dayWarningsEmitted.has(warnKey)) {
      dayWarningsEmitted.add(warnKey);
      emitRouterEvent({
        type: 'limit.warning',
        tenantId,
        limit: 'day',
        percent: 80,
        current: newDayRequests,
        max: limits.dayRequests,
      });
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const cur = inFlight.get(tenantId) ?? 1;
    inFlight.set(tenantId, Math.max(0, cur - 1));
  };

  return { ok: true, release };
}

/**
 * Returns current rate limit usage statistics for a tenant.
 */
export function getTenantRateUsage(tenantId: string, now = getNow()): TenantRateUsage {
  ensureLoaded();
  const todayStr = new Date(now).toISOString().slice(0, 10);
  const dayRequests = dailyUsage[todayStr]?.[tenantId] ?? 0;
  const curInFlight = inFlight.get(tenantId) ?? 0;

  const windowCutoff = now - 60_000;
  const tWindow = cleanWindow(tenantWindows.get(tenantId), windowCutoff);
  tenantWindows.set(tenantId, tWindow);
  const rpmWindow = tWindow.length;

  return {
    rpmWindow,
    inFlight: curInFlight,
    dayRequests,
  };
}

/**
 * Returns all tenant IDs that currently have tracked usage (in-flight, rpm, or today's count).
 */
export function getAllActiveRateTenantIds(now = getNow()): string[] {
  ensureLoaded();
  const todayStr = new Date(now).toISOString().slice(0, 10);
  const ids = new Set<string>();

  if (dailyUsage[todayStr]) {
    for (const id of Object.keys(dailyUsage[todayStr])) {
      ids.add(id);
    }
  }
  for (const [id, count] of inFlight.entries()) {
    if (count > 0) ids.add(id);
  }
  for (const [id, window] of tenantWindows.entries()) {
    if (window.some((t) => t >= now - 60_000)) {
      ids.add(id);
    }
  }

  return [...ids];
}

export function getTenantDailyRequestCount(dateStr: string): Record<string, number> {
  ensureLoaded();
  return dailyUsage[dateStr] ? { ...dailyUsage[dateStr] } : {};
}

export function resetTenantRateForTests(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  inFlight.clear();
  tenantWindows.clear();
  agentWindows.clear();
  dailyUsage = {};
  dayWarningsEmitted.clear();
  isLoaded = false;
  clockFn = null;
}
