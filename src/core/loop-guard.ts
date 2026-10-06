import crypto from 'node:crypto';
import { LoopLimits, listTenants } from './tenants.js';
import { emitRouterEvent } from './events.js';

// Sliding-window agent loop guard to prevent runaway loops (e.g. agent spinning
// in a loop burning hundreds of thousands of tokens per minute).
// Tracks per-session: rate (req/5m), volume (tokens/10m), repeat (identical messages).
// Sessions are identified by `${tenantId}|${app}|${agent}|${session}`.
// Sessions with incomplete metadata run in dry-run mode only.

export type LoopRule = 'rate' | 'volume' | 'repeat';

export interface LoopGuardEvent {
  type: 'block' | 'dry-run';
  key: string;
  rule: LoopRule | string;
  details: string;
  timestamp: string;
}

export type CheckLoopResult =
  | { blocked: false }
  | {
      blocked: true;
      rule: LoopRule | string;
      details: string;
      until: string;
      retryAfterSec: number;
    };

interface SessionState {
  lastSeen: number;
  blockedUntil?: number;
  blockRule?: string;
  blockDetails?: string;
  dryRunWarnedUntil?: number;
  requests: number[];
  tokenEntries: Array<{ timestamp: number; tokens: number }>;
  lastMessageHash?: string;
  repeatCount: number;
  lastRepeatTimestamp: number;
}

export interface LoopGuardStatus {
  mode: string;
  thresholds: {
    maxRequests: number;
    maxRequestsWorker: number;
    reqWindowSec: number;
    maxTokens: number;
    tokenWindowSec: number;
    maxRepeat: number;
    blockSec: number;
  };
  blocked: Record<string, string>;
  events: LoopGuardEvent[];
  overrides?: Record<string, LoopLimits>;
}

const sessions = new Map<string, SessionState>();
const events: LoopGuardEvent[] = [];
let clockFn: (() => number) | null = null;
let modeOverride: string | null = null;

export function setLoopGuardClock(fn: (() => number) | null): void {
  clockFn = fn;
}

export function setLoopGuardModeForTests(mode: string | null): void {
  modeOverride = mode;
}

function getNow(): number {
  return clockFn ? clockFn() : Date.now();
}

function getMode(): string {
  if (modeOverride) return modeOverride;
  const envMode = process.env.ROUTER_LOOP_GUARD?.toLowerCase();
  if (envMode === 'dry-run' || envMode === 'off') return envMode;
  return 'enforce';
}

function getEnvNum(name: string, fallback: number): number {
  const val = Number(process.env[name]);
  return Number.isFinite(val) && val > 0 ? val : fallback;
}

/**
 * Estimates input tokens as Math.ceil(JSON.stringify(messages).length / 4).
 * Replaces base64 image data URIs with a constant 1000 chars so vision requests
 * are not over-counted as millions of tokens.
 */
export function estimateInputTokens(messages: unknown): number {
  const raw = JSON.stringify(messages ?? []);
  const replaced = raw.replace(/data:[^;\"']+;base64,[^\"']+/g, 'x'.repeat(1000));
  return Math.ceil(replaced.length / 4);
}

/**
 * Produces sha1 hex hash for the last message's role and JSON content.
 * For role 'tool', includes tool_call_id (and name if present) to distinguish
 * separate tool invocations with identical return values.
 */
export function hashLastMessage(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const last = messages[messages.length - 1];
  if (!last || typeof last !== 'object') return '';
  const role = (last as { role?: string }).role ?? '';
  const content = (last as { content?: unknown }).content;
  let payload: string;
  if (role === 'tool') {
    const toolCallId = (last as { tool_call_id?: string }).tool_call_id ?? '';
    const name = (last as { name?: string }).name;
    payload = `tool:${toolCallId}:${name ? `${name}:` : ''}${JSON.stringify(content ?? '')}`;
  } else {
    payload = `${role}:${JSON.stringify(content ?? '')}`;
  }
  return crypto.createHash('sha1').update(payload).digest('hex');
}

function recordEvent(ev: LoopGuardEvent): void {
  events.push(ev);
  if (events.length > 50) {
    events.shift();
  }
}

function pruneIdleSessions(now: number): void {
  const cutoff = now - 30 * 60 * 1000;
  for (const [k, s] of sessions.entries()) {
    if (s.lastSeen < cutoff && (!s.blockedUntil || s.blockedUntil <= now)) {
      sessions.delete(k);
    }
  }
}

/** Registry limits (possibly partial) completed with the env defaults. */
export function effectiveLoopLimits(limits?: LoopLimits, agent?: string): Required<LoopLimits> {
  const defaultMaxReq =
    agent === 'worker'
      ? getEnvNum('ROUTER_LOOP_MAX_REQ_WORKER', 120)
      : getEnvNum('ROUTER_LOOP_MAX_REQ', 40);
  return {
    mode: (limits?.mode ?? getMode()) as Required<LoopLimits>['mode'],
    maxReq: limits?.maxReq ?? defaultMaxReq,
    reqWindowSec: limits?.reqWindowSec ?? getEnvNum('ROUTER_LOOP_REQ_WINDOW_SEC', 300),
    maxTokens: limits?.maxTokens ?? getEnvNum('ROUTER_LOOP_MAX_TOKENS', 3_000_000),
    tokenWindowSec: limits?.tokenWindowSec ?? getEnvNum('ROUTER_LOOP_TOKEN_WINDOW_SEC', 600),
    maxRepeat: limits?.maxRepeat ?? getEnvNum('ROUTER_LOOP_MAX_REPEAT', 3),
    blockSec: limits?.blockSec ?? getEnvNum('ROUTER_LOOP_BLOCK_SEC', 600),
  };
}

export function checkLoop(
  key: string,
  messages: unknown,
  options?: {
    dryRun?: boolean;
    now?: number;
    repeatSalt?: string;
    limits?: LoopLimits;
    agent?: string;
  }
): CheckLoopResult {
  const now = options?.now ?? getNow();
  pruneIdleSessions(now);

  const mode = options?.limits?.mode ?? getMode();
  if (mode === 'off') {
    return { blocked: false };
  }

  const dryRun = options?.dryRun === true || mode === 'dry-run';

  let session = sessions.get(key);
  if (!session) {
    session = {
      lastSeen: now,
      requests: [],
      tokenEntries: [],
      repeatCount: 0,
      lastRepeatTimestamp: 0,
    };
    sessions.set(key, session);
  }
  session.lastSeen = now;

  // If already actively blocked, return 429
  if (session.blockedUntil && session.blockedUntil > now) {
    const retryAfterSec = Math.max(1, Math.ceil((session.blockedUntil - now) / 1000));
    return {
      blocked: true,
      rule: session.blockRule || 'loop',
      details: session.blockDetails || 'Blocked',
      until: new Date(session.blockedUntil).toISOString(),
      retryAfterSec,
    };
  }

  // Clear expired block if any
  if (session.blockedUntil && session.blockedUntil <= now) {
    session.blockedUntil = undefined;
    session.blockRule = undefined;
    session.blockDetails = undefined;
  }

  const eff = effectiveLoopLimits(options?.limits, options?.agent);
  const { maxReq, reqWindowSec, maxTokens, tokenWindowSec, maxRepeat, blockSec } = eff;
  const reqWindowMs = reqWindowSec * 1000;
  const tokenWindowMs = tokenWindowSec * 1000;
  const repeatWindowMs = 300 * 1000; // 5 minutes
  const blockMs = blockSec * 1000;

  let triggeredRule: LoopRule | null = null;
  let triggeredDetails = '';

  // 1. Check Rate
  session.requests = session.requests.filter((t) => t > now - reqWindowMs);
  session.requests.push(now);
  // A registry value of 0 turns that rule off for the tenant (0 = no cap).
  if (maxReq > 0 && session.requests.length > maxReq) {
    triggeredRule = 'rate';
    triggeredDetails = `${session.requests.length} requests in ${reqWindowSec}s (limit ${maxReq})`;
  }

  if (triggeredRule === 'rate') {
    if (dryRun) {
      // In dry-run mode, warn at most once per key per block period; never block
      if (!session.dryRunWarnedUntil || now >= session.dryRunWarnedUntil) {
        session.dryRunWarnedUntil = now + blockMs;
        console.warn(`[loop] DRY-RUN would block ${key}: ${triggeredRule}`);
        recordEvent({
          type: 'dry-run',
          key,
          rule: triggeredRule,
          details: triggeredDetails,
          timestamp: new Date(now).toISOString(),
        });
      }
      return { blocked: false };
    }

    // Rate is pacing, not a session block: remove rejected timestamp so waiting Retry-After allows re-entry
    session.requests.pop();
    const oldestInWindow = session.requests[0] ?? now;
    const untilMs = oldestInWindow + reqWindowMs;
    const retryAfterSec = Math.max(1, Math.ceil((untilMs - now) / 1000));
    const until = new Date(untilMs).toISOString();
    console.log(`[loop] RATE ${key} ${triggeredDetails} retryAfter=${retryAfterSec}s until ${until}`);
    return {
      blocked: true,
      rule: 'rate',
      details: triggeredDetails,
      until,
      retryAfterSec,
    };
  }

  // 2. Check Volume
  if (!triggeredRule) {
    const reqTokens = estimateInputTokens(messages);
    session.tokenEntries = session.tokenEntries.filter((e) => e.timestamp >= now - tokenWindowMs);
    session.tokenEntries.push({ timestamp: now, tokens: reqTokens });
    const totalTokens = session.tokenEntries.reduce((acc, e) => acc + e.tokens, 0);
    if (maxTokens > 0 && totalTokens > maxTokens) {
      triggeredRule = 'volume';
      triggeredDetails = `${totalTokens} tokens in ${tokenWindowSec}s (limit ${maxTokens})`;
    }
  }

  // 3. Check Repeat
  if (!triggeredRule) {
    // repeatSalt (the request's max_tokens) makes a retry with a raised output
    // limit a different request: Hermes re-sends a truncated tool call with
    // max_tokens ×2 (4k → 8k → 16k → 32k), which is not a loop.
    const lastHash = hashLastMessage(messages);
    const msgHash = lastHash && options?.repeatSalt ? `${lastHash}|${options.repeatSalt}` : lastHash;
    if (msgHash) {
      if (
        msgHash === session.lastMessageHash &&
        now - session.lastRepeatTimestamp <= repeatWindowMs
      ) {
        session.repeatCount += 1;
      } else {
        session.lastMessageHash = msgHash;
        session.repeatCount = 1;
      }
      session.lastRepeatTimestamp = now;

      if (maxRepeat > 0 && session.repeatCount >= maxRepeat) {
        triggeredRule = 'repeat';
        triggeredDetails = `${session.repeatCount} consecutive identical messages`;
      }
    }
  }

  if (triggeredRule) {
    if (dryRun) {
      // In dry-run mode, warn at most once per key per block period; never block
      if (!session.dryRunWarnedUntil || now >= session.dryRunWarnedUntil) {
        session.dryRunWarnedUntil = now + blockMs;
        console.warn(`[loop] DRY-RUN would block ${key}: ${triggeredRule}`);
        recordEvent({
          type: 'dry-run',
          key,
          rule: triggeredRule,
          details: triggeredDetails,
          timestamp: new Date(now).toISOString(),
        });
      }
      return { blocked: false };
    }

    // Enforce block
    session.blockedUntil = now + blockMs;
    session.blockRule = triggeredRule;
    session.blockDetails = triggeredDetails;
    const until = new Date(session.blockedUntil).toISOString();
    console.log(`[loop] BLOCK ${key} rule=${triggeredRule} ${triggeredDetails} until ${until}`);
    recordEvent({
      type: 'block',
      key,
      rule: triggeredRule,
      details: triggeredDetails,
      timestamp: new Date(now).toISOString(),
    });

    const tenantId = key.split('|')[0] || '';
    emitRouterEvent({
      type: 'loop.blocked',
      tenantId,
      key,
      rule: triggeredRule,
      details: triggeredDetails,
      until,
      retryAfterSec: blockSec,
    });

    return {
      blocked: true,
      rule: triggeredRule,
      details: triggeredDetails,
      until,
      retryAfterSec: blockSec,
    };
  }

  return { blocked: false };
}

export function unblockLoopSessions(prefix: string): number {
  let cleared = 0;
  const now = getNow();
  for (const [k, session] of sessions.entries()) {
    if (k.startsWith(prefix)) {
      if (session.blockedUntil && session.blockedUntil > now) {
        cleared++;
      }
      session.blockedUntil = undefined;
      session.blockRule = undefined;
      session.blockDetails = undefined;
    }
  }
  return cleared;
}

export function getLoopGuardStatus(): LoopGuardStatus {
  const now = getNow();
  const blocked: Record<string, string> = {};
  for (const [k, s] of sessions.entries()) {
    if (s.blockedUntil && s.blockedUntil > now) {
      blocked[k] = new Date(s.blockedUntil).toISOString();
    }
  }

  const overrides: Record<string, LoopLimits> = {};
  for (const t of listTenants()) {
    if (t.limits?.loop) {
      overrides[t.id] = t.limits.loop;
    }
  }

  return {
    mode: getMode(),
    thresholds: {
      maxRequests: getEnvNum('ROUTER_LOOP_MAX_REQ', 40),
      maxRequestsWorker: getEnvNum('ROUTER_LOOP_MAX_REQ_WORKER', 120),
      reqWindowSec: getEnvNum('ROUTER_LOOP_REQ_WINDOW_SEC', 300),
      maxTokens: getEnvNum('ROUTER_LOOP_MAX_TOKENS', 3_000_000),
      tokenWindowSec: getEnvNum('ROUTER_LOOP_TOKEN_WINDOW_SEC', 600),
      maxRepeat: getEnvNum('ROUTER_LOOP_MAX_REPEAT', 3),
      blockSec: getEnvNum('ROUTER_LOOP_BLOCK_SEC', 600),
    },
    blocked,
    events: [...events],
    overrides,
  };
}

export function resetLoopGuard(): void {
  sessions.clear();
  events.length = 0;
  clockFn = null;
  modeOverride = null;
}
