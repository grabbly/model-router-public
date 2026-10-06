import { CooldownRecord } from '../types.js';

const cooldowns = new Map<string, CooldownRecord>();

export function cooldownKey(route: string, entryId: string): string {
  return `${route}:${entryId}`;
}

export function isCoolingDown(
  route: string,
  entryId: string
): { cooling: boolean; remainingSec: number; reason?: string } {
  const key = cooldownKey(route, entryId);
  const rec = cooldowns.get(key);
  if (!rec) return { cooling: false, remainingSec: 0 };
  const remaining = Math.ceil((rec.cooldownUntil - Date.now()) / 1000);
  if (remaining <= 0) {
    cooldowns.delete(key);
    return { cooling: false, remainingSec: 0 };
  }
  return { cooling: true, remainingSec: remaining, reason: rec.reason };
}

export function recordFailure(
  route: string,
  entryId: string,
  cooldownSec: number,
  reason?: string
): void {
  const now = Date.now();
  const durSec = Math.max(cooldownSec, 5);
  cooldowns.set(cooldownKey(route, entryId), {
    failedAt: now,
    cooldownUntil: now + durSec * 1000,
    reason: reason || 'upstream failure',
  });
}

// A 429 means "slow down", not "down". 25.09: a burst hit the MiniMax Token
// Plan rate limit, it recovered within a minute, but the normal 120 s cooldown
// pushed every client off MiniMax for two minutes. Honour Retry-After when the
// provider sends it, otherwise pause briefly; clamp to 3–30 s.
export const RATE_LIMIT_DEFAULT_SEC = 10;
const RATE_LIMIT_MAX_SEC = 30;

export function rateLimitCooldownSec(retryAfter?: string | null, now = Date.now()): number {
  let sec = RATE_LIMIT_DEFAULT_SEC;
  if (retryAfter) {
    const n = Number(retryAfter);
    if (Number.isFinite(n)) {
      sec = n;
    } else {
      const at = Date.parse(retryAfter);
      if (Number.isFinite(at)) sec = Math.ceil((at - now) / 1000);
    }
  }
  return Math.min(Math.max(sec, 3), RATE_LIMIT_MAX_SEC);
}

export function recordSuccess(route: string, entryId: string): void {
  cooldowns.delete(cooldownKey(route, entryId));
}

export function resetCooldowns(): void {
  cooldowns.clear();
}

export function getCooldownStatus(): Record<
  string,
  { cooling: boolean; remainingSec: number; reason?: string }
> {
  const result: Record<string, { cooling: boolean; remainingSec: number; reason?: string }> = {};
  const now = Date.now();
  for (const [key, rec] of cooldowns.entries()) {
    const remaining = Math.ceil((rec.cooldownUntil - now) / 1000);
    if (remaining > 0) {
      result[key] = { cooling: true, remainingSec: remaining, reason: rec.reason };
      const parts = key.split(':');
      if (parts.length === 2 && !result[parts[1]]) {
        result[parts[1]] = { cooling: true, remainingSec: remaining, reason: rec.reason };
      }
    } else {
      cooldowns.delete(key);
    }
  }
  return result;
}

export function getCooldownRecord(route: string, entryId: string): CooldownRecord | undefined {
  return cooldowns.get(cooldownKey(route, entryId));
}
