import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { LogicalModelId, LOGICAL_MODEL_IDS, PoolEntry } from '../types.js';

export interface RateLimits {
  rpm?: number;
  concurrent?: number;
  dayRequests?: number;
} // 0/undefined = no cap

export interface LoopLimits {
  mode?: 'enforce' | 'dry-run' | 'off';
  maxReq?: number;
  reqWindowSec?: number;
  maxTokens?: number;
  tokenWindowSec?: number;
  maxRepeat?: number;
  blockSec?: number;
}

export interface MinimaxLimits {
  day?: number;
  hour?: number; // same semantics as ROUTER_MINIMAX_TENANT_LIMITS (0 = no cap)
  user?: { day?: number; hour?: number }; // same as ROUTER_MINIMAX_USER_LIMITS
  quotaMax?: { dayShare?: number; hourShare?: number }; // same as ROUTER_MINIMAX_QUOTA_MAX
}

export interface TenantLimits {
  rate?: RateLimits;
  loop?: LoopLimits;
  minimax?: MinimaxLimits;
  agents?: Record<string, { rate?: RateLimits; loop?: LoopLimits }>; // override per x-router-agent value
}

export type UpstreamKeyProvider = 'ollama-cloud' | 'openai';

export interface UpstreamKeyRecord {
  enc: string;
  hint: string;
  fp: string;
  addedAt: string;
  status: 'ok' | 'invalid' | 'exhausted' | 'unknown';
  statusAt?: string;
  lastError?: string;
  exhaustedUntil?: string;
  plan?: string; // provider plan reported when the key was validated (e.g. ollama.com "free")
}

export interface TenantRecord {
  id: string;
  name?: string;
  status: 'active' | 'disabled';
  mode?: 'shared' | 'byok';
  tokenVersion?: number; // 0/undefined = legacy token; see §2
  upstreamKeys?: Partial<Record<UpstreamKeyProvider, UpstreamKeyRecord>>;
  providerOrder?: ('ollama-cloud' | 'openai')[];
  pools?: Partial<Record<LogicalModelId, PoolEntry[]>>;
  allowSharedEmbeddings?: boolean;
  overlay?: 'auto' | 'off';
  thinkingWithTools?: 'model-default' | 'off';
  limits?: TenantLimits;
  notify?: { email?: string[]; telegram?: string[]; lang?: 'ru' | 'en' }; // used by phase 2, just store+validate now
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TenantsFile {
  version: 1;
  tenants: Record<string, TenantRecord>;
}

const ID_REGEX = /^([A-Za-z0-9._-]{1,64}|\*)$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let registry: Record<string, TenantRecord> = {};
let isLoaded = false;
let lastMtimeMs = 0;
let lastCheckedMtimeTime = 0;
let clockFn: (() => number) | null = null;

function getNow(): number {
  return clockFn ? clockFn() : Date.now();
}

export function setTenantsClockForTests(fn: (() => number) | null): void {
  clockFn = fn;
}

function getTenantsFilePath(): string {
  const dir = process.env.ROUTER_STATE_DIR || './data';
  return path.join(dir, 'tenants.json');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonNegativeInteger(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isUnitShare(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

/**
 * Validates a tenant record or partial tenant record body.
 * Enforces strict schemas and rejects any unknown properties.
 */
export function validateTenantRecord(body: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!isPlainObject(body)) {
    return { ok: false, errors: ['Body must be a JSON object'] };
  }

  const allowedTopKeys = new Set([
    'id',
    'name',
    'status',
    'mode',
    'tokenVersion',
    'upstreamKeys',
    'providerOrder',
    'pools',
    'allowSharedEmbeddings',
    'overlay',
    'thinkingWithTools',
    'limits',
    'notify',
    'notes',
    'createdAt',
    'updatedAt',
  ]);

  for (const k of Object.keys(body)) {
    if (!allowedTopKeys.has(k)) {
      errors.push(`Unknown field: "${k}"`);
    }
  }

  // id
  if (body.id !== undefined) {
    if (typeof body.id !== 'string' || !ID_REGEX.test(body.id)) {
      errors.push(
        'Invalid "id": must match ^[A-Za-z0-9._-]{1,64}$ or be "*"'
      );
    }
  }

  // mode
  if (body.mode !== undefined) {
    if (body.mode !== 'shared' && body.mode !== 'byok') {
      errors.push('"mode" must be either "shared" or "byok"');
    }
  }

  // allowSharedEmbeddings
  if (body.allowSharedEmbeddings !== undefined && typeof body.allowSharedEmbeddings !== 'boolean') {
    errors.push('"allowSharedEmbeddings" must be a boolean');
  }

  // overlay
  if (body.overlay !== undefined) {
    if (body.overlay !== 'auto' && body.overlay !== 'off') {
      errors.push('"overlay" must be either "auto" or "off"');
    }
  }

  // thinkingWithTools
  if (body.thinkingWithTools !== undefined) {
    if (body.thinkingWithTools !== 'model-default' && body.thinkingWithTools !== 'off') {
      errors.push('"thinkingWithTools" must be either "model-default" or "off"');
    }
  }

  // upstreamKeys
  if (body.upstreamKeys !== undefined) {
    if (!isPlainObject(body.upstreamKeys)) {
      errors.push('"upstreamKeys" must be a JSON object');
    } else {
      const allowedProviders = new Set(['ollama-cloud', 'openai']);
      for (const [prov, keyInfo] of Object.entries(body.upstreamKeys)) {
        if (!allowedProviders.has(prov)) {
          errors.push(`Unknown provider in "upstreamKeys": "${prov}"`);
          continue;
        }
        if (!isPlainObject(keyInfo)) {
          errors.push(`"upstreamKeys.${prov}" must be a JSON object`);
          continue;
        }
        const allowedKeyFields = new Set([
          'enc',
          'hint',
          'fp',
          'addedAt',
          'status',
          'statusAt',
          'lastError',
          'exhaustedUntil',
          'plan',
        ]);
        for (const kf of Object.keys(keyInfo)) {
          if (!allowedKeyFields.has(kf)) {
            errors.push(`Unknown field in "upstreamKeys.${prov}": "${kf}"`);
          }
        }
        if (keyInfo.enc !== undefined && typeof keyInfo.enc !== 'string') {
          errors.push(`"upstreamKeys.${prov}.enc" must be a string`);
        }
        if (keyInfo.hint !== undefined && typeof keyInfo.hint !== 'string') {
          errors.push(`"upstreamKeys.${prov}.hint" must be a string`);
        }
        if (keyInfo.fp !== undefined && typeof keyInfo.fp !== 'string') {
          errors.push(`"upstreamKeys.${prov}.fp" must be a string`);
        }
        if (keyInfo.addedAt !== undefined && typeof keyInfo.addedAt !== 'string') {
          errors.push(`"upstreamKeys.${prov}.addedAt" must be an ISO date string`);
        }
        if (
          keyInfo.status !== undefined &&
          !['ok', 'invalid', 'exhausted', 'unknown'].includes(keyInfo.status as string)
        ) {
          errors.push(
            `"upstreamKeys.${prov}.status" must be "ok", "invalid", "exhausted", or "unknown"`
          );
        }
        if (keyInfo.statusAt !== undefined && typeof keyInfo.statusAt !== 'string') {
          errors.push(`"upstreamKeys.${prov}.statusAt" must be an ISO date string`);
        }
        if (keyInfo.lastError !== undefined && typeof keyInfo.lastError !== 'string') {
          errors.push(`"upstreamKeys.${prov}.lastError" must be a string`);
        }
        if (keyInfo.exhaustedUntil !== undefined && typeof keyInfo.exhaustedUntil !== 'string') {
          errors.push(`"upstreamKeys.${prov}.exhaustedUntil" must be an ISO date string`);
        }
      }
    }
  }

  // providerOrder
  if (body.providerOrder !== undefined) {
    if (!Array.isArray(body.providerOrder)) {
      errors.push('"providerOrder" must be an array of strings');
    } else {
      const allowedProviders = new Set(['ollama-cloud', 'openai']);
      for (let i = 0; i < body.providerOrder.length; i++) {
        const p = body.providerOrder[i];
        if (typeof p !== 'string' || !allowedProviders.has(p)) {
          errors.push(
            `"providerOrder[${i}]" must be "ollama-cloud" or "openai"`
          );
        }
      }
    }
  }

  // mode "byok" requires at least one upstream key
  if (body.mode === 'byok') {
    const keysCount =
      isPlainObject(body.upstreamKeys) ? Object.keys(body.upstreamKeys).length : 0;
    if (keysCount === 0) {
      errors.push('mode "byok" requires at least one upstream key');
    }
  }

  // pools
  if (body.pools !== undefined) {
    if (!isPlainObject(body.pools)) {
      errors.push('"pools" must be a JSON object');
    } else {
      const allowedLogicalIds = new Set(LOGICAL_MODEL_IDS);
      const configuredProviders = new Set<string>();
      if (isPlainObject(body.upstreamKeys)) {
        for (const prov of Object.keys(body.upstreamKeys)) {
          configuredProviders.add(prov);
        }
      }
      for (const [routeKey, poolEntries] of Object.entries(body.pools)) {
        if (!allowedLogicalIds.has(routeKey as LogicalModelId)) {
          errors.push(`Unknown logical model in "pools": "${routeKey}"`);
          continue;
        }
        if (!Array.isArray(poolEntries)) {
          errors.push(`"pools.${routeKey}" must be an array of pool entries`);
          continue;
        }
        for (let i = 0; i < poolEntries.length; i++) {
          const entry = poolEntries[i];
          if (!isPlainObject(entry)) {
            errors.push(`"pools.${routeKey}[${i}]" must be a JSON object`);
            continue;
          }
          if (
            !entry.provider ||
            (entry.provider !== 'ollama-cloud' && entry.provider !== 'openai')
          ) {
            errors.push(
              `"pools.${routeKey}[${i}].provider" must be "ollama-cloud" or "openai"`
            );
          } else if (
            configuredProviders.size > 0 &&
            !configuredProviders.has(entry.provider as string)
          ) {
            errors.push(
              `"pools.${routeKey}[${i}].provider" "${entry.provider}": no key configured for provider "${entry.provider}" for this tenant`
            );
          }
          if (entry.baseUrl !== undefined) {
            errors.push(
              `"pools.${routeKey}[${i}].baseUrl" is not permitted (baseUrl cannot be customized)`
            );
          }
        }
      }
    }
  }

  // name
  if (body.name !== undefined && typeof body.name !== 'string') {
    errors.push('"name" must be a string');
  }

  // status
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'disabled') {
      errors.push('"status" must be either "active" or "disabled"');
    }
  }

  // tokenVersion
  if (body.tokenVersion !== undefined && !isNonNegativeInteger(body.tokenVersion)) {
    errors.push('"tokenVersion" must be a non-negative integer');
  }

  // notes
  if (body.notes !== undefined && typeof body.notes !== 'string') {
    errors.push('"notes" must be a string');
  }

  // createdAt / updatedAt
  if (body.createdAt !== undefined && typeof body.createdAt !== 'string') {
    errors.push('"createdAt" must be an ISO date string');
  }
  if (body.updatedAt !== undefined && typeof body.updatedAt !== 'string') {
    errors.push('"updatedAt" must be an ISO date string');
  }

  // notify
  if (body.notify !== undefined) {
    if (!isPlainObject(body.notify)) {
      errors.push('"notify" must be a JSON object');
    } else {
      const allowedNotifyKeys = new Set(['email', 'telegram', 'lang']);
      for (const nk of Object.keys(body.notify)) {
        if (!allowedNotifyKeys.has(nk)) {
          errors.push(`Unknown field in "notify": "${nk}"`);
        }
      }

      if (body.notify.email !== undefined) {
        if (!Array.isArray(body.notify.email)) {
          errors.push('"notify.email" must be an array of strings');
        } else {
          for (let i = 0; i < body.notify.email.length; i++) {
            const email = body.notify.email[i];
            if (typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
              errors.push(`Invalid email format at notify.email[${i}]: "${email}"`);
            }
          }
        }
      }

      if (body.notify.telegram !== undefined) {
        if (!Array.isArray(body.notify.telegram)) {
          errors.push('"notify.telegram" must be an array of strings');
        } else {
          for (let i = 0; i < body.notify.telegram.length; i++) {
            const tg = body.notify.telegram[i];
            if (typeof tg !== 'string' || tg.trim().length === 0) {
              errors.push(`Invalid telegram chat id at notify.telegram[${i}]`);
            }
          }
        }
      }

      if (body.notify.lang !== undefined) {
        if (body.notify.lang !== 'ru' && body.notify.lang !== 'en') {
          errors.push('"notify.lang" must be either "ru" or "en"');
        }
      }
    }
  }

  // limits
  if (body.limits !== undefined) {
    if (!isPlainObject(body.limits)) {
      errors.push('"limits" must be a JSON object');
    } else {
      const allowedLimitKeys = new Set(['rate', 'loop', 'minimax', 'agents']);
      for (const lk of Object.keys(body.limits)) {
        if (!allowedLimitKeys.has(lk)) {
          errors.push(`Unknown field in "limits": "${lk}"`);
        }
      }

      validateRateLimits(body.limits.rate, 'limits.rate', errors);
      validateLoopLimits(body.limits.loop, 'limits.loop', errors);
      validateMinimaxLimits(body.limits.minimax, 'limits.minimax', errors);

      if (body.limits.agents !== undefined) {
        if (!isPlainObject(body.limits.agents)) {
          errors.push('"limits.agents" must be a JSON object');
        } else {
          for (const [agentKey, agentConfig] of Object.entries(body.limits.agents)) {
            if (!isPlainObject(agentConfig)) {
              errors.push(`"limits.agents.${agentKey}" must be an object`);
              continue;
            }
            const allowedAgentKeys = new Set(['rate', 'loop']);
            for (const ak of Object.keys(agentConfig)) {
              if (!allowedAgentKeys.has(ak)) {
                errors.push(`Unknown field in "limits.agents.${agentKey}": "${ak}"`);
              }
            }
            validateRateLimits(agentConfig.rate, `limits.agents.${agentKey}.rate`, errors);
            validateLoopLimits(agentConfig.loop, `limits.agents.${agentKey}.loop`, errors);
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateRateLimits(rate: unknown, prefix: string, errors: string[]): void {
  if (rate === undefined) return;
  if (!isPlainObject(rate)) {
    errors.push(`"${prefix}" must be a JSON object`);
    return;
  }
  const allowed = new Set(['rpm', 'concurrent', 'dayRequests']);
  for (const k of Object.keys(rate)) {
    if (!allowed.has(k)) {
      errors.push(`Unknown field in "${prefix}": "${k}"`);
    }
  }
  if (rate.rpm !== undefined && !isNonNegativeInteger(rate.rpm)) {
    errors.push(`"${prefix}.rpm" must be a non-negative integer`);
  }
  if (rate.concurrent !== undefined && !isNonNegativeInteger(rate.concurrent)) {
    errors.push(`"${prefix}.concurrent" must be a non-negative integer`);
  }
  if (rate.dayRequests !== undefined && !isNonNegativeInteger(rate.dayRequests)) {
    errors.push(`"${prefix}.dayRequests" must be a non-negative integer`);
  }
}

function validateLoopLimits(loop: unknown, prefix: string, errors: string[]): void {
  if (loop === undefined) return;
  if (!isPlainObject(loop)) {
    errors.push(`"${prefix}" must be a JSON object`);
    return;
  }
  const allowed = new Set([
    'mode',
    'maxReq',
    'reqWindowSec',
    'maxTokens',
    'tokenWindowSec',
    'maxRepeat',
    'blockSec',
  ]);
  for (const k of Object.keys(loop)) {
    if (!allowed.has(k)) {
      errors.push(`Unknown field in "${prefix}": "${k}"`);
    }
  }
  if (
    loop.mode !== undefined &&
    loop.mode !== 'enforce' &&
    loop.mode !== 'dry-run' &&
    loop.mode !== 'off'
  ) {
    errors.push(`"${prefix}.mode" must be "enforce", "dry-run", or "off"`);
  }
  if (loop.maxReq !== undefined && !isNonNegativeInteger(loop.maxReq)) {
    errors.push(`"${prefix}.maxReq" must be a non-negative integer`);
  }
  if (loop.reqWindowSec !== undefined && (!isNonNegativeInteger(loop.reqWindowSec) || (loop.reqWindowSec as number) < 1)) {
    errors.push(`"${prefix}.reqWindowSec" must be a positive integer`);
  }
  if (loop.maxTokens !== undefined && !isNonNegativeInteger(loop.maxTokens)) {
    errors.push(`"${prefix}.maxTokens" must be a non-negative integer`);
  }
  if (loop.tokenWindowSec !== undefined && (!isNonNegativeInteger(loop.tokenWindowSec) || (loop.tokenWindowSec as number) < 1)) {
    errors.push(`"${prefix}.tokenWindowSec" must be a positive integer`);
  }
  if (loop.maxRepeat !== undefined && !isNonNegativeInteger(loop.maxRepeat)) {
    errors.push(`"${prefix}.maxRepeat" must be a non-negative integer`);
  }
  if (loop.blockSec !== undefined && (!isNonNegativeInteger(loop.blockSec) || (loop.blockSec as number) < 1)) {
    errors.push(`"${prefix}.blockSec" must be a positive integer`);
  }
}

function validateMinimaxLimits(minimax: unknown, prefix: string, errors: string[]): void {
  if (minimax === undefined) return;
  if (!isPlainObject(minimax)) {
    errors.push(`"${prefix}" must be a JSON object`);
    return;
  }
  const allowed = new Set(['day', 'hour', 'user', 'quotaMax']);
  for (const k of Object.keys(minimax)) {
    if (!allowed.has(k)) {
      errors.push(`Unknown field in "${prefix}": "${k}"`);
    }
  }
  if (minimax.day !== undefined && !isNonNegativeInteger(minimax.day)) {
    errors.push(`"${prefix}.day" must be a non-negative integer`);
  }
  if (minimax.hour !== undefined && !isNonNegativeInteger(minimax.hour)) {
    errors.push(`"${prefix}.hour" must be a non-negative integer`);
  }
  if (minimax.user !== undefined) {
    if (!isPlainObject(minimax.user)) {
      errors.push(`"${prefix}.user" must be a JSON object`);
    } else {
      const allowedUser = new Set(['day', 'hour']);
      for (const uk of Object.keys(minimax.user)) {
        if (!allowedUser.has(uk)) {
          errors.push(`Unknown field in "${prefix}.user": "${uk}"`);
        }
      }
      if (minimax.user.day !== undefined && !isNonNegativeInteger(minimax.user.day)) {
        errors.push(`"${prefix}.user.day" must be a non-negative integer`);
      }
      if (minimax.user.hour !== undefined && !isNonNegativeInteger(minimax.user.hour)) {
        errors.push(`"${prefix}.user.hour" must be a non-negative integer`);
      }
    }
  }
  if (minimax.quotaMax !== undefined) {
    if (!isPlainObject(minimax.quotaMax)) {
      errors.push(`"${prefix}.quotaMax" must be a JSON object`);
    } else {
      const allowedQuota = new Set(['dayShare', 'hourShare']);
      for (const qk of Object.keys(minimax.quotaMax)) {
        if (!allowedQuota.has(qk)) {
          errors.push(`Unknown field in "${prefix}.quotaMax": "${qk}"`);
        }
      }
      if (
        minimax.quotaMax.dayShare !== undefined &&
        !isUnitShare(minimax.quotaMax.dayShare)
      ) {
        errors.push(
          `"${prefix}.quotaMax.dayShare" must be a number between 0 and 1`
        );
      }
      if (
        minimax.quotaMax.hourShare !== undefined &&
        !isUnitShare(minimax.quotaMax.hourShare)
      ) {
        errors.push(
          `"${prefix}.quotaMax.hourShare" must be a number between 0 and 1`
        );
      }
    }
  }
}

/**
 * Checks for mtime changes on disk at most once every 5 seconds.
 * If the file is broken or cannot be parsed, logs a warning and keeps the in-memory copy.
 */
function ensureLoaded(): void {
  const now = getNow();
  const filePath = getTenantsFilePath();

  if (isLoaded && now - lastCheckedMtimeTime < 5000) {
    return;
  }
  lastCheckedMtimeTime = now;

  if (!fs.existsSync(filePath)) {
    if (!isLoaded) {
      registry = {};
      lastMtimeMs = 0;
      isLoaded = true;
    }
    return;
  }

  try {
    const stats = fs.statSync(filePath);
    if (!isLoaded || stats.mtimeMs !== lastMtimeMs) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content) as TenantsFile;
      if (parsed && typeof parsed === 'object' && parsed.version === 1 && parsed.tenants) {
        registry = parsed.tenants;
        lastMtimeMs = stats.mtimeMs;
        isLoaded = true;
      } else {
        console.warn(
          '[tenants] tenants.json has unexpected format, keeping last good copy'
        );
      }
    }
  } catch (err) {
    console.warn(
      '[tenants] Failed to read or parse tenants.json, keeping last good copy:',
      err
    );
    if (!isLoaded) {
      registry = {};
      isLoaded = true;
    }
  }
}

/**
 * Persists the registry to disk atomically via write-then-rename.
 */
function saveRegistrySync(): void {
  const filePath = getTenantsFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${filePath}.tmp`;
  const fileContent: TenantsFile = {
    version: 1,
    tenants: registry,
  };
  fs.writeFileSync(tmpPath, JSON.stringify(fileContent, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);

  try {
    const stats = fs.statSync(filePath);
    lastMtimeMs = stats.mtimeMs;
    lastCheckedMtimeTime = getNow();
  } catch {
    // Ignore stat failure after write
  }
}

export function loadTenants(): Record<string, TenantRecord> {
  ensureLoaded();
  return { ...registry };
}

export function getTenant(id: string): TenantRecord | null {
  ensureLoaded();
  return registry[id] ? { ...registry[id] } : null;
}

export function listTenants(): TenantRecord[] {
  ensureLoaded();
  return Object.values(registry).map((r) => ({ ...r }));
}

export function upsertTenant(record: TenantRecord): TenantRecord {
  ensureLoaded();
  const existing = registry[record.id];
  const nowStr = new Date(getNow()).toISOString();

  const toSave: TenantRecord = {
    ...record,
    createdAt: existing?.createdAt || record.createdAt || nowStr,
    updatedAt: nowStr,
  };

  registry[toSave.id] = toSave;
  saveRegistrySync();
  return { ...toSave };
}

export function deleteTenant(id: string): boolean {
  ensureLoaded();
  if (registry[id]) {
    delete registry[id];
    saveRegistrySync();
    return true;
  }
  return false;
}

/**
 * Resolves rate limits field-by-field:
 * agent override -> tenant record -> '*' record -> undefined (no cap)
 */
export function resolveRateLimits(tenantId: string, agent?: string): RateLimits {
  ensureLoaded();
  const tenant = registry[tenantId];
  const star = registry['*'];
  const agentOverride = agent ? tenant?.limits?.agents?.[agent]?.rate : undefined;

  const rpm =
    agentOverride?.rpm ??
    tenant?.limits?.rate?.rpm ??
    star?.limits?.rate?.rpm;

  const concurrent =
    agentOverride?.concurrent ??
    tenant?.limits?.rate?.concurrent ??
    star?.limits?.rate?.concurrent;

  const dayRequests =
    agentOverride?.dayRequests ??
    tenant?.limits?.rate?.dayRequests ??
    star?.limits?.rate?.dayRequests;

  return { rpm, concurrent, dayRequests };
}

/**
 * Registry loop limits field-by-field: agent override → tenant record → `*`
 * record. Unset fields stay undefined; checkLoop falls back to env for them.
 */
export function resolveLoopLimits(tenantId: string, agent?: string): LoopLimits {
  ensureLoaded();
  const tenant = registry[tenantId];
  const star = registry['*'];
  const agentOverride = agent ? tenant?.limits?.agents?.[agent]?.loop : undefined;
  const out: LoopLimits = {};
  const keys = ['mode', 'maxReq', 'reqWindowSec', 'maxTokens', 'tokenWindowSec', 'maxRepeat', 'blockSec'] as const;
  for (const k of keys) {
    const v = agentOverride?.[k] ?? tenant?.limits?.loop?.[k] ?? star?.limits?.loop?.[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function parseEnvJson<T>(envVar: string | undefined): Record<string, T> {
  if (!envVar) return {};
  try {
    const parsed = JSON.parse(envVar);
    return isPlainObject(parsed) ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}

/**
 * Resolves MiniMax limits field-by-field:
 * tenant record -> '*' record -> env / default
 */
export function resolveMinimaxLimits(tenantId: string): MinimaxLimits {
  ensureLoaded();
  const tenant = registry[tenantId];
  const star = registry['*'];

  const envTenantLimits = parseEnvJson<{ day?: number; hour?: number }>(
    process.env.ROUTER_MINIMAX_TENANT_LIMITS
  );
  const defaultLimits: Record<string, { day: number; hour: number }> = {
    'master-service': { day: 30_000_000, hour: 6_000_000 },
    'companion-app': { day: 15_000_000, hour: 3_000_000 },
    '*': { day: 5_000_000, hour: 1_000_000 },
  };

  // Specific beats generic, so a `*` record never overrides a limit that env
  // (or the built-in defaults) set for this exact tenant — tenants not in the
  // registry keep today's limits: tenant record → env[tenant] → default[tenant]
  // → `*` record → env['*'] → default['*'].
  const envSpecific = envTenantLimits[tenantId] ?? defaultLimits[tenantId];
  const envGeneric = { ...defaultLimits['*'], ...envTenantLimits['*'] };

  const day =
    tenant?.limits?.minimax?.day ??
    envSpecific?.day ??
    star?.limits?.minimax?.day ??
    envGeneric.day;

  const hour =
    tenant?.limits?.minimax?.hour ??
    envSpecific?.hour ??
    star?.limits?.minimax?.hour ??
    envGeneric.hour;

  // User limits
  const envUserLimits = parseEnvJson<{ day?: number; hour?: number }>(
    process.env.ROUTER_MINIMAX_USER_LIMITS
  );
  const userDay =
    tenant?.limits?.minimax?.user?.day ??
    envUserLimits[tenantId]?.day ??
    star?.limits?.minimax?.user?.day ??
    envUserLimits['*']?.day;

  const userHour =
    tenant?.limits?.minimax?.user?.hour ??
    envUserLimits[tenantId]?.hour ??
    star?.limits?.minimax?.user?.hour ??
    envUserLimits['*']?.hour;

  let user: { day?: number; hour?: number } | undefined;
  if (userDay !== undefined || userHour !== undefined) {
    user = {
      day: userDay ?? 0,
      hour: userHour ?? 0,
    };
  }

  // QuotaMax shares
  const envQuotaMax = parseEnvJson<{ dayShare?: number; hourShare?: number }>(
    process.env.ROUTER_MINIMAX_QUOTA_MAX
  );
  const dayShare =
    tenant?.limits?.minimax?.quotaMax?.dayShare ??
    envQuotaMax[tenantId]?.dayShare ??
    star?.limits?.minimax?.quotaMax?.dayShare ??
    envQuotaMax['*']?.dayShare;

  const hourShare =
    tenant?.limits?.minimax?.quotaMax?.hourShare ??
    envQuotaMax[tenantId]?.hourShare ??
    star?.limits?.minimax?.quotaMax?.hourShare ??
    envQuotaMax['*']?.hourShare;

  let quotaMax: { dayShare?: number; hourShare?: number } | undefined;
  if (dayShare !== undefined || hourShare !== undefined) {
    quotaMax = {
      dayShare,
      hourShare,
    };
  }

  return {
    day,
    hour,
    user,
    quotaMax,
  };
}

export function sanitizeTenantForApi(tenant: TenantRecord): TenantRecord {
  if (!tenant.upstreamKeys) return { ...tenant };
  const safeKeys: Partial<Record<UpstreamKeyProvider, UpstreamKeyRecord>> = {};
  for (const [prov, info] of Object.entries(tenant.upstreamKeys)) {
    if (!info) continue;
    const { enc, ...safeInfo } = info;
    safeKeys[prov as UpstreamKeyProvider] = safeInfo as UpstreamKeyRecord;
  }
  return {
    ...tenant,
    upstreamKeys: safeKeys,
  };
}

export function resetTenantsForTests(): void {
  registry = {};
  isLoaded = false;
  lastMtimeMs = 0;
  lastCheckedMtimeTime = 0;
  clockFn = null;
}

