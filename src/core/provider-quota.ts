import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';
import {
  getBudgetRangeSums,
  getRouterCountersForRemains,
} from './budget.js';

export interface MinimaxRemainsSnapshot {
  fetchedAt: number; // epoch ms
  intervalStart: number; // epoch ms
  intervalEnd: number; // epoch ms
  intervalRemainingPct: number; // integer percent
  intervalStatus: number;
  weeklyStart: number; // epoch ms
  weeklyEnd: number; // epoch ms
  weeklyRemainingPct: number; // integer percent
  weeklyStatus: number;
}

export interface MinimaxRemainsLogEntry extends MinimaxRemainsSnapshot {
  routerWeekRaw: number;
  routerWeekWeighted: number;
  routerCycleRaw: number;
  usedCycle: number;
}

export interface ProviderStatus {
  snapshot: MinimaxRemainsSnapshot | null;
  fresh: boolean;
  estimates: {
    weeklyQuotaRaw: number | null;
    weeklyQuotaWeighted: number | null;
  };
}

let currentSnapshot: MinimaxRemainsSnapshot | null = null;
let lastFailureLogTime = 0;
let customBaseUrl: string | null = null;
let customClockFn: (() => number) | null = null;
let pollerTimer: NodeJS.Timeout | null = null;

export function setMinimaxRemainsBaseUrl(url: string | null): void {
  customBaseUrl = url;
}

export function setMinimaxRemainsClock(fn: (() => number) | null): void {
  customClockFn = fn;
}

export function setMinimaxRemainsSnapshot(snap: MinimaxRemainsSnapshot | null): void {
  currentSnapshot = snap;
}

export function getMinimaxRemainsSnapshot(): MinimaxRemainsSnapshot | null {
  return currentSnapshot;
}

function getNow(): number {
  return customClockFn ? customClockFn() : Date.now();
}

function getBaseUrl(): string {
  if (customBaseUrl) return customBaseUrl;
  return CONFIG.minimaxBaseUrl || 'https://api.minimax.io/v1';
}

export function getMinimaxRemainsIntervalSec(): number {
  const raw = process.env.ROUTER_MINIMAX_REMAINS_INTERVAL_SEC;
  if (raw === undefined || raw === null || raw.trim() === '') return 600;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 600;
}

export function getMinimaxRemainsStopPct(): number {
  const raw = process.env.ROUTER_MINIMAX_REMAINS_STOP_PCT;
  if (raw === undefined || raw === null || raw.trim() === '') return 5;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 5;
}

export function getMinimaxRemainsTightenPct(): number {
  const raw = process.env.ROUTER_MINIMAX_REMAINS_TIGHTEN_PCT;
  if (raw === undefined || raw === null || raw.trim() === '') return 15;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 15;
}

export function isMinimaxRemainsFresh(now = getNow()): boolean {
  if (!currentSnapshot) return false;
  const intervalSec = getMinimaxRemainsIntervalSec();
  const maxAgeMs = Math.max(3 * intervalSec, 1800) * 1000;
  const age = now - currentSnapshot.fetchedAt;
  return age >= -5000 && age <= maxAgeMs;
}

function logFailureThrottled(reason: string, now: number): void {
  const oneHourMs = 3600 * 1000;
  if (!lastFailureLogTime || now - lastFailureLogTime >= oneHourMs) {
    console.warn(`[minimax-remains] poll failed: ${reason}`);
    lastFailureLogTime = now;
  }
}

function appendRemainsLog(entry: MinimaxRemainsLogEntry): void {
  try {
    const dir = process.env.ROUTER_STATE_DIR || './data';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = path.join(dir, 'minimax-remains.jsonl');
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    console.error('[provider-quota] Failed to append to minimax-remains.jsonl:', err);
  }
}

export function getProviderQuotaStatus(now = getNow()): ProviderStatus {
  const snapshot = currentSnapshot;
  const fresh = isMinimaxRemainsFresh(now);

  if (!snapshot) {
    return {
      snapshot: null,
      fresh: false,
      estimates: {
        weeklyQuotaRaw: null,
        weeklyQuotaWeighted: null,
      },
    };
  }

  const usedPct = 100 - snapshot.weeklyRemainingPct;
  let weeklyQuotaRaw: number | null = null;
  let weeklyQuotaWeighted: number | null = null;

  if (usedPct >= 5) {
    const { raw, weighted } = getBudgetRangeSums(snapshot.weeklyStart, now);
    weeklyQuotaRaw = Math.round(raw / (usedPct / 100));
    weeklyQuotaWeighted = Math.round(weighted / (usedPct / 100));
  }

  return {
    snapshot,
    fresh,
    estimates: {
      weeklyQuotaRaw,
      weeklyQuotaWeighted,
    },
  };
}

export async function pollMinimaxRemainsOnce(now = getNow()): Promise<MinimaxRemainsSnapshot | null> {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    logFailureThrottled('MINIMAX_API_KEY is not set or empty', now);
    return null;
  }

  const baseUrl = getBaseUrl();
  const url = `${baseUrl.replace(/\/+$/, '')}/api/openplatform/coding_plan/remains`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out after 10s')), 10_000);
  timer.unref();

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as any;
    if (!data || typeof data !== 'object') {
      throw new Error('Response is not a JSON object');
    }

    if (data.base_resp?.status_code !== 0) {
      throw new Error(
        `base_resp.status_code is ${data.base_resp?.status_code} (${data.base_resp?.status_msg || 'unknown error'})`
      );
    }

    if (!Array.isArray(data.model_remains)) {
      throw new Error('Missing or invalid model_remains array');
    }

    const general = data.model_remains.find((m: any) => m?.model_name === 'general');
    if (!general) {
      throw new Error("No model_remains entry with model_name 'general'");
    }

    const intervalStart = Number(general.start_time);
    const intervalEnd = Number(general.end_time);
    const intervalRemainingPct = Number(general.current_interval_remaining_percent);
    const intervalStatus = Number(general.current_interval_status);
    const weeklyStart = Number(general.weekly_start_time);
    const weeklyEnd = Number(general.weekly_end_time);
    const weeklyRemainingPct = Number(general.current_weekly_remaining_percent);
    const weeklyStatus = Number(general.current_weekly_status);

    const nums = [
      intervalStart,
      intervalEnd,
      intervalRemainingPct,
      intervalStatus,
      weeklyStart,
      weeklyEnd,
      weeklyRemainingPct,
      weeklyStatus,
    ];
    if (nums.some((n) => !Number.isFinite(n))) {
      throw new Error('Invalid or non-finite numbers in general model_remains entry');
    }

    const snapshot: MinimaxRemainsSnapshot = {
      fetchedAt: now,
      intervalStart,
      intervalEnd,
      intervalRemainingPct: Math.round(intervalRemainingPct),
      intervalStatus,
      weeklyStart,
      weeklyEnd,
      weeklyRemainingPct: Math.round(weeklyRemainingPct),
      weeklyStatus,
    };

    currentSnapshot = snapshot;

    // Append to JSONL log
    const counters = getRouterCountersForRemains(snapshot.weeklyStart, now);
    appendRemainsLog({
      ...snapshot,
      ...counters,
    });

    return snapshot;
  } catch (err: any) {
    const reason = err?.message || String(err);
    logFailureThrottled(reason, now);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function startMinimaxRemainsPoller(): void {
  stopMinimaxRemainsPoller();

  const intervalSec = getMinimaxRemainsIntervalSec();
  if (intervalSec <= 0) {
    return;
  }

  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    return;
  }

  // Poll immediately on start
  pollMinimaxRemainsOnce().catch(() => {});

  // Then every intervalSec
  pollerTimer = setInterval(() => {
    pollMinimaxRemainsOnce().catch(() => {});
  }, intervalSec * 1000);
  pollerTimer.unref();
}

export function stopMinimaxRemainsPoller(): void {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
  }
}

export function resetMinimaxRemainsForTests(): void {
  stopMinimaxRemainsPoller();
  currentSnapshot = null;
  lastFailureLogTime = 0;
  customBaseUrl = null;
  customClockFn = null;
}
