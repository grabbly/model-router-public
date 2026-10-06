import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FastifyRequest } from 'fastify';
import { getBudgetStatus, getTenantLimit } from './budget.js';

export type AuthType = 'tenant-token' | 'master' | 'master-impersonated' | 'invalid' | 'none';

export interface RequestLogRecord {
  /** Unique per record — the only safe de-duplication key (see recordKey). */
  id?: string;
  ts: string; // ISO timestamp
  tenant: string;
  authType: AuthType;
  keyHint?: string;
  app?: string;
  agent?: string;
  session?: string;
  ip?: string;
  userAgent?: string;
  tier?: string; // requested model field
  backend?: string; // via.id
  physicalModel?: string; // via.model
  stream?: boolean;
  status: number; // HTTP status returned to client
  errorCode?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  user?: string;
  latencyMs?: number; // total duration
  ttfbMs?: number; // streams: time to first byte sent
  failoverCount?: number;
  budgetExceeded?: string; // reason string
  loopRule?: string;
  missingMetadata?: boolean;
  msgs?: number; // message count
  chars?: number; // JSON length of messages
  hasTools?: boolean;
  hasImages?: boolean;
  overlay?: boolean;
  preview?: string;
}

export interface RequestLogFilter {
  from?: string; // ISO
  to?: string; // ISO
  tenant?: string;
  user?: string;
  app?: string;
  agent?: string;
  session?: string; // substring match
  tier?: string;
  backend?: string;
  status?: number | '2xx' | '4xx' | '5xx' | string;
  errorCode?: string;
}

export interface AggregateResult {
  totals: {
    requests: number;
    errors: number;
    promptTokens: number;
    completionTokens: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
  };
  series: Array<{
    t: string; // bucket ISO
    byTenant: Record<string, { requests: number; tokens: number; errors: number }>;
  }>;
  byTenant: Record<string, { requests: number; errors: number; promptTokens: number; completionTokens: number }>;
  byTier: Record<string, number>;
  byBackend: Record<string, number>;
  byStatus: {
    '2xx': number;
    '4xx': number;
    '5xx': number;
    errorCodes: Record<string, number>;
  };
}

export interface ClientStat {
  tenant: string;
  authTypes: string[];
  keyHints: string[];
  apps: string[];
  agents: Record<string, number>;
  ips: string[];
  userAgents: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  requests24h: number;
  requests7d: number;
  tokens24h: number;
  errors24h: number;
  missingMetadataShare24h: number;
  loopBlocks7d: number;
  budget: any;
}

// In-memory buffer of records waiting to be written to disk
let inMemoryBuffer: RequestLogRecord[] = [];
// Records taken out of the buffer by an async flush that is still writing.
// Queries must see them too, or they vanish from the dashboard for the write's
// duration (a flaky test caught it: queried mid-flush, a 401 record was gone).
let pendingWrite: RequestLogRecord[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let retentionTimer: NodeJS.Timeout | null = null;
let lastWarnTime = 0;

function warnOncePerMinute(msg: string, err?: unknown): void {
  const now = Date.now();
  if (now - lastWarnTime >= 60_000) {
    lastWarnTime = now;
    console.warn(`[request-log] ${msg}:`, err);
  }
}

let customStateDir: string | undefined;

export function setRequestLogDir(dir?: string): void {
  customStateDir = dir;
}

function getRequestsDir(customDir?: string): string {
  const base = customDir || customStateDir || process.env.ROUTER_STATE_DIR || './data';
  return path.join(base, 'requests');
}

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    warnOncePerMinute('Failed to create requests dir', err);
  }
}

/**
 * Format partially masked key hint. NEVER exposes the full key.
 */
export function formatKeyHint(
  token: string | null | undefined,
  authType: AuthType,
  tenantId?: string
): string {
  if (!token || !token.trim()) return 'none';
  const clean = token.trim();

  if (authType === 'tenant-token') {
    const dot = clean.lastIndexOf('.');
    if (dot > 0 && clean.startsWith('pft_')) {
      const prefix = clean.slice(0, dot + 1);
      const mac = clean.slice(dot + 1);
      if (mac.length >= 8) {
        return `${prefix}${mac.slice(0, 4)}…${mac.slice(-4)}`;
      }
      return `${prefix}${mac.slice(0, 2)}…${mac.slice(-2)}`;
    }
  }

  if (authType === 'master' || authType === 'master-impersonated') {
    const last4 = clean.length >= 4 ? clean.slice(-4) : clean.slice(-2);
    return `master …${last4}`;
  }

  // Invalid or unknown token: first 6 + … + last 2
  if (clean.length >= 8) {
    return `${clean.slice(0, 6)}…${clean.slice(-2)}`;
  }
  return `${clean.slice(0, 2)}…${clean.slice(-1)}`;
}

/**
 * Extract preview of the last user message text, excluding images/base64 data URIs.
 */
export function extractPreview(
  messages: Array<{ role: string; content: any }> | undefined,
  charsLimit?: number
): string | undefined {
  const n = charsLimit !== undefined ? charsLimit : Number(process.env.ROUTER_LOG_PREVIEW_CHARS || 0);
  if (!n || n <= 0 || !Array.isArray(messages)) return undefined;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === 'user') {
      let rawText = '';
      if (typeof msg.content === 'string') {
        rawText = msg.content;
      } else if (Array.isArray(msg.content)) {
        rawText = msg.content
          .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text)
          .join('\n');
      }
      // Strip base64 data URIs
      rawText = rawText.replace(/data:[a-zA-Z0-9.+/-]+;base64,[A-Za-z0-9+/=]+/g, '').trim();
      if (!rawText) return undefined;
      return rawText.slice(0, n);
    }
  }
  return undefined;
}

/**
 * Extract client IP preferring x-real-ip, then first x-forwarded-for, then req.ip.
 */
export function extractClientIp(req: FastifyRequest): string {
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  return req.ip || '';
}

/**
 * Check if request messages contain any image content.
 */
export function hasImageContent(messages: Array<{ role: string; content: any }> | undefined): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((m) => {
    if (Array.isArray(m.content)) {
      return m.content.some((c) => c && (c.type === 'image_url' || c.image_url));
    }
    if (typeof m.content === 'string') {
      return m.content.includes('data:image/');
    }
    return false;
  });
}

/**
 * Check if request has tool definitions or function calls.
 */
export function hasToolCallsOrDefinitions(body: any): boolean {
  if (!body) return false;
  return Boolean(
    (Array.isArray(body.tools) && body.tools.length > 0) ||
    (Array.isArray(body.functions) && body.functions.length > 0)
  );
}

function startTimersIfNeeded(): void {
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      flushRequestLogAsync().catch((err) => warnOncePerMinute('Async flush failed', err));
    }, 2000);
    flushTimer.unref();
  }

  if (!retentionTimer) {
    retentionTimer = setInterval(() => {
      cleanOldRequestLogs();
    }, 3600 * 1000);
    retentionTimer.unref();
  }
}

/**
 * Record a single request log entry. Never throws.
 */
// De-dup key for a record seen both in memory and on disk (the moment between
// an async append landing and pendingWrite being trimmed). It must be unique:
// the old ts|tenant|status|latency|chars key merged distinct requests made in
// the same millisecond (two 401s, two 400s…) and the dashboard undercounted.
function recordKey(rec: RequestLogRecord): string {
  return rec.id ?? `${rec.ts}|${rec.tenant}|${rec.status}|${rec.latencyMs}|${rec.chars}|${rec.errorCode}|${rec.authType}|${rec.keyHint}|${rec.session}|${rec.user}`;
}

export function recordRequest(record: RequestLogRecord): void {
  try {
    if (!record.id) record.id = crypto.randomUUID();
    inMemoryBuffer.push(record);
    startTimersIfNeeded();
  } catch (err) {
    warnOncePerMinute('Failed to record request', err);
  }
}

/**
 * Flush in-memory buffer to disk asynchronously.
 */
export async function flushRequestLogAsync(): Promise<void> {
  if (inMemoryBuffer.length === 0) return;
  const toWrite = inMemoryBuffer.splice(0, inMemoryBuffer.length);
  pendingWrite.push(...toWrite);
  const written = new Set(toWrite);

  try {
    const dir = getRequestsDir();
    ensureDir(dir);

    const byDate = new Map<string, string[]>();
    for (const rec of toWrite) {
      const dateStr = rec.ts.slice(0, 10);
      let arr = byDate.get(dateStr);
      if (!arr) {
        arr = [];
        byDate.set(dateStr, arr);
      }
      arr.push(JSON.stringify(rec) + '\n');
    }

    for (const [dateStr, lines] of byDate.entries()) {
      const filePath = path.join(dir, `${dateStr}.jsonl`);
      await fs.promises.appendFile(filePath, lines.join(''), 'utf8');
    }
  } catch (err) {
    // Put back at beginning of buffer so we don't lose them
    inMemoryBuffer.unshift(...toWrite);
    warnOncePerMinute('Flush failed', err);
  } finally {
    pendingWrite = pendingWrite.filter((r) => !written.has(r));
  }
}

/**
 * Flush in-memory buffer to disk synchronously (used during process shutdown).
 */
export function flushRequestLogSync(): void {
  if (inMemoryBuffer.length === 0) return;
  const toWrite = inMemoryBuffer.splice(0, inMemoryBuffer.length);

  try {
    const dir = getRequestsDir();
    ensureDir(dir);

    const byDate = new Map<string, string[]>();
    for (const rec of toWrite) {
      const dateStr = rec.ts.slice(0, 10);
      let arr = byDate.get(dateStr);
      if (!arr) {
        arr = [];
        byDate.set(dateStr, arr);
      }
      arr.push(JSON.stringify(rec) + '\n');
    }

    for (const [dateStr, lines] of byDate.entries()) {
      const filePath = path.join(dir, `${dateStr}.jsonl`);
      fs.appendFileSync(filePath, lines.join(''), 'utf8');
    }
  } catch (err) {
    inMemoryBuffer.unshift(...toWrite);
    warnOncePerMinute('Sync flush failed', err);
  }
}

/**
 * Clean request log files older than ROUTER_REQUEST_LOG_DAYS (default 30).
 */
export function cleanOldRequestLogs(retentionDays?: number, customDir?: string): void {
  try {
    const days = retentionDays ?? Number(process.env.ROUTER_REQUEST_LOG_DAYS || 30);
    const dir = getRequestsDir(customDir);
    if (!fs.existsSync(dir)) return;

    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10);

    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) {
        const fileDate = file.slice(0, 10);
        if (fileDate < cutoffDate) {
          try {
            fs.unlinkSync(path.join(dir, file));
          } catch (delErr) {
            warnOncePerMinute(`Failed to delete old log ${file}`, delErr);
          }
        }
      }
    }
  } catch (err) {
    warnOncePerMinute('Retention clean failed', err);
  }
}

function matchesFilter(
  rec: RequestLogRecord,
  filter: RequestLogFilter,
  before?: string
): boolean {
  if (before && rec.ts >= before) return false;
  if (filter.from && rec.ts < filter.from) return false;
  if (filter.to && rec.ts > filter.to) return false;
  if (filter.tenant && rec.tenant !== filter.tenant) return false;
  if (filter.user && rec.user !== filter.user) return false;
  if (filter.app && rec.app !== filter.app) return false;
  if (filter.agent && rec.agent !== filter.agent) return false;
  if (filter.session && (!rec.session || !rec.session.toLowerCase().includes(filter.session.toLowerCase()))) {
    return false;
  }
  if (filter.tier && rec.tier !== filter.tier) return false;
  if (filter.backend && rec.backend !== filter.backend) return false;
  if (filter.errorCode && rec.errorCode !== filter.errorCode) return false;

  if (filter.status !== undefined && filter.status !== '') {
    if (filter.status === '2xx') {
      if (rec.status < 200 || rec.status >= 300) return false;
    } else if (filter.status === '4xx') {
      if (rec.status < 400 || rec.status >= 500) return false;
    } else if (filter.status === '5xx') {
      if (rec.status < 500 || rec.status >= 600) return false;
    } else {
      const numStatus = Number(filter.status);
      if (!isNaN(numStatus) && rec.status !== numStatus) return false;
    }
  }

  return true;
}

/**
 * Read overlapping day files and return parsed records.
 */
function readCandidateRecords(
  fromISO?: string,
  toISO?: string,
  customDir?: string
): { diskRecords: RequestLogRecord[]; inMemory: RequestLogRecord[] } {
  const dir = getRequestsDir(customDir);
  const fromDate = fromISO ? fromISO.slice(0, 10) : '1970-01-01';
  const toDate = toISO ? toISO.slice(0, 10) : '9999-12-31';

  const diskRecords: RequestLogRecord[] = [];

  if (fs.existsSync(dir)) {
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .filter((f) => {
        const d = f.slice(0, 10);
        return d >= fromDate && d <= toDate;
      })
      .sort()
      .reverse(); // Newest file first

    let scannedLines = 0;
    for (const file of files) {
      if (scannedLines >= 200_000) break;
      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        // Read file lines in reverse (newest first)
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line) continue;
          scannedLines++;
          if (scannedLines > 200_000) break;
          try {
            diskRecords.push(JSON.parse(line));
          } catch {}
        }
      } catch (err) {
        warnOncePerMinute(`Failed to read log file ${file}`, err);
      }
    }
  }

  // Filter in-memory buffer for range as well (newest first)
  const inMemory = [...pendingWrite, ...inMemoryBuffer].reverse().filter((rec) => {
    const d = rec.ts.slice(0, 10);
    return d >= fromDate && d <= toDate;
  });

  return { diskRecords, inMemory };
}

/**
 * Query requests matching filters, newest-first, with pagination via before.
 */
export function queryRequests(
  filter: RequestLogFilter,
  options?: { limit?: number; before?: string; customDir?: string }
): { items: RequestLogRecord[]; nextBefore: string | null } {
  const limit = Math.max(1, Math.min(options?.limit || 100, 1000));
  const before = options?.before;

  const { diskRecords, inMemory } = readCandidateRecords(filter.from, filter.to, options?.customDir);

  const matched: RequestLogRecord[] = [];

  // Combine in-memory and disk records, both already in reverse-chronological order
  // To avoid duplicates if something is currently being flushed, track unique keys
  const seen = new Set<string>();

  const checkRecord = (rec: RequestLogRecord) => {
    if (matched.length >= limit) return;
    const key = recordKey(rec);
    if (seen.has(key)) return;
    seen.add(key);

    if (matchesFilter(rec, filter, before)) {
      matched.push(rec);
    }
  };

  for (const rec of inMemory) {
    checkRecord(rec);
    if (matched.length >= limit) break;
  }

  if (matched.length < limit) {
    for (const rec of diskRecords) {
      checkRecord(rec);
      if (matched.length >= limit) break;
    }
  }

  const nextBefore = matched.length === limit ? matched[matched.length - 1].ts : null;
  return { items: matched, nextBefore };
}

/**
 * Aggregate metrics across the specified range and bucket.
 */
export function aggregate(
  filter: RequestLogFilter,
  bucket: 'hour' | 'day' = 'hour',
  customDir?: string
): AggregateResult {
  const { diskRecords, inMemory } = readCandidateRecords(filter.from, filter.to, customDir);

  const totals = {
    requests: 0,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
  };

  const byTenant: Record<string, { requests: number; errors: number; promptTokens: number; completionTokens: number }> = {};
  const byTier: Record<string, number> = {};
  const byBackend: Record<string, number> = {};
  const byStatus: { '2xx': number; '4xx': number; '5xx': number; errorCodes: Record<string, number> } = {
    '2xx': 0,
    '4xx': 0,
    '5xx': 0,
    errorCodes: {},
  };

  const seriesMap = new Map<string, Record<string, { requests: number; tokens: number; errors: number }>>();
  const latencies: number[] = [];
  const seen = new Set<string>();

  const processRecord = (rec: RequestLogRecord) => {
    const key = recordKey(rec);
    if (seen.has(key)) return;
    seen.add(key);

    if (!matchesFilter(rec, filter)) return;

    totals.requests++;
    const isError = rec.status >= 400;
    if (isError) totals.errors++;

    const pTokens = rec.promptTokens || 0;
    const cTokens = rec.completionTokens || 0;
    totals.promptTokens += pTokens;
    totals.completionTokens += cTokens;

    if (typeof rec.latencyMs === 'number' && !isNaN(rec.latencyMs)) {
      latencies.push(rec.latencyMs);
    }

    // Tenant breakdown
    let tEntry = byTenant[rec.tenant];
    if (!tEntry) {
      tEntry = { requests: 0, errors: 0, promptTokens: 0, completionTokens: 0 };
      byTenant[rec.tenant] = tEntry;
    }
    tEntry.requests++;
    if (isError) tEntry.errors++;
    tEntry.promptTokens += pTokens;
    tEntry.completionTokens += cTokens;

    // Tier breakdown
    if (rec.tier) {
      byTier[rec.tier] = (byTier[rec.tier] || 0) + 1;
    }

    // Backend breakdown
    if (rec.backend) {
      byBackend[rec.backend] = (byBackend[rec.backend] || 0) + 1;
    }

    // Status breakdown
    if (rec.status >= 200 && rec.status < 300) {
      byStatus['2xx']++;
    } else if (rec.status >= 400 && rec.status < 500) {
      byStatus['4xx']++;
    } else if (rec.status >= 500) {
      byStatus['5xx']++;
    }

    if (rec.errorCode) {
      byStatus.errorCodes[rec.errorCode] = (byStatus.errorCodes[rec.errorCode] || 0) + 1;
    }

    // Bucket series
    let bucketKey: string;
    if (bucket === 'day') {
      bucketKey = rec.ts.slice(0, 10) + 'T00:00:00.000Z';
    } else {
      bucketKey = rec.ts.slice(0, 13) + ':00:00.000Z';
    }

    let bMap = seriesMap.get(bucketKey);
    if (!bMap) {
      bMap = {};
      seriesMap.set(bucketKey, bMap);
    }

    let sTenant = bMap[rec.tenant];
    if (!sTenant) {
      sTenant = { requests: 0, tokens: 0, errors: 0 };
      bMap[rec.tenant] = sTenant;
    }
    sTenant.requests++;
    sTenant.tokens += pTokens + cTokens;
    if (isError) sTenant.errors++;
  };

  for (const rec of inMemory) processRecord(rec);
  for (const rec of diskRecords) processRecord(rec);

  // Latency percentiles
  if (latencies.length > 0) {
    latencies.sort((a, b) => a - b);
    totals.avgLatencyMs = Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length);
    const p95Idx = Math.floor(latencies.length * 0.95);
    totals.p95LatencyMs = latencies[Math.min(p95Idx, latencies.length - 1)];
  }

  // Convert series map to chronological array
  const series: AggregateResult['series'] = Array.from(seriesMap.entries())
    .map(([t, byTenantMap]) => ({ t, byTenant: byTenantMap }))
    .sort((a, b) => (a.t < b.t ? -1 : 1));

  return {
    totals,
    series,
    byTenant,
    byTier,
    byBackend,
    byStatus,
  };
}

/**
 * Get distinct clients seen in logs and budget configuration.
 */
export function getClientStats(retentionDays?: number, customDir?: string): ClientStat[] {
  const days = retentionDays ?? Number(process.env.ROUTER_REQUEST_LOG_DAYS || 30);
  const fromISO = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { diskRecords, inMemory } = readCandidateRecords(fromISO, undefined, customDir);

  const nowMs = Date.now();
  const ms24h = nowMs - 24 * 60 * 60 * 1000;
  const ms7d = nowMs - 7 * 24 * 60 * 60 * 1000;

  interface ClientAccumulator {
    tenant: string;
    authTypes: Set<string>;
    keyHints: Set<string>;
    apps: Set<string>;
    agents: Map<string, number>;
    ips: string[];
    userAgents: string[];
    firstSeen: string | null;
    lastSeen: string | null;
    requests24h: number;
    requests7d: number;
    tokens24h: number;
    errors24h: number;
    missingMeta24h: number;
    loopBlocks7d: number;
  }

  const clients = new Map<string, ClientAccumulator>();

  const getOrCreate = (tenant: string): ClientAccumulator => {
    let c = clients.get(tenant);
    if (!c) {
      c = {
        tenant,
        authTypes: new Set(),
        keyHints: new Set(),
        apps: new Set(),
        agents: new Map(),
        ips: [],
        userAgents: [],
        firstSeen: null,
        lastSeen: null,
        requests24h: 0,
        requests7d: 0,
        tokens24h: 0,
        errors24h: 0,
        missingMeta24h: 0,
        loopBlocks7d: 0,
      };
      clients.set(tenant, c);
    }
    return c;
  };

  const seen = new Set<string>();

  const processRec = (rec: RequestLogRecord) => {
    const key = recordKey(rec);
    if (seen.has(key)) return;
    seen.add(key);

    const c = getOrCreate(rec.tenant);

    if (rec.authType) c.authTypes.add(rec.authType);
    if (rec.keyHint && rec.keyHint !== 'none') c.keyHints.add(rec.keyHint);
    if (rec.app && rec.app !== '-') c.apps.add(rec.app);

    if (rec.agent && rec.agent !== '-') {
      c.agents.set(rec.agent, (c.agents.get(rec.agent) || 0) + 1);
    }

    if (rec.ip && !c.ips.includes(rec.ip)) {
      if (c.ips.length < 10) c.ips.push(rec.ip);
    }

    if (rec.userAgent && !c.userAgents.includes(rec.userAgent)) {
      if (c.userAgents.length < 5) c.userAgents.push(rec.userAgent);
    }

    if (!c.firstSeen || rec.ts < c.firstSeen) c.firstSeen = rec.ts;
    if (!c.lastSeen || rec.ts > c.lastSeen) c.lastSeen = rec.ts;

    const tMs = new Date(rec.ts).getTime();
    const isError = rec.status >= 400;
    const tokens = (rec.promptTokens || 0) + (rec.completionTokens || 0);

    if (tMs >= ms7d) {
      c.requests7d++;
      if (rec.status === 429 && (rec.errorCode === 'loop_detected' || rec.loopRule)) {
        c.loopBlocks7d++;
      }
    }

    if (tMs >= ms24h) {
      c.requests24h++;
      c.tokens24h += tokens;
      if (isError) c.errors24h++;
      if (rec.missingMetadata) c.missingMeta24h++;
    }
  };

  for (const rec of inMemory) processRec(rec);
  for (const rec of diskRecords) processRec(rec);

  // Also include any tenants configured in budget that may not have recent traffic
  const budgetStatus = getBudgetStatus();
  if (budgetStatus && budgetStatus.tenants) {
    for (const t of Object.keys(budgetStatus.tenants)) {
      if (t !== '*') {
        getOrCreate(t);
      }
    }
  }

  const result: ClientStat[] = [];
  for (const [tenant, c] of clients.entries()) {
    const agentsObj: Record<string, number> = {};
    for (const [ag, count] of c.agents.entries()) {
      agentsObj[ag] = count;
    }

    const missingMetadataShare24h =
      c.requests24h > 0 ? Number((c.missingMeta24h / c.requests24h).toFixed(4)) : 0;

    result.push({
      tenant,
      authTypes: Array.from(c.authTypes),
      keyHints: Array.from(c.keyHints),
      apps: Array.from(c.apps),
      agents: agentsObj,
      ips: c.ips,
      userAgents: c.userAgents,
      firstSeen: c.firstSeen,
      lastSeen: c.lastSeen,
      requests24h: c.requests24h,
      requests7d: c.requests7d,
      tokens24h: c.tokens24h,
      errors24h: c.errors24h,
      missingMetadataShare24h,
      loopBlocks7d: c.loopBlocks7d,
      // Tenants without an explicit limit fall under the "*" default.
      budget: budgetStatus?.tenants?.[tenant] || {
        hourUsed: 0,
        hourLimit: getTenantLimit(tenant).hour,
        dayUsed: 0,
        dayLimit: getTenantLimit(tenant).day,
        over: false,
      },
    });
  }

  // Sort by 24h activity descending
  result.sort((a, b) => b.requests24h - a.requests24h);
  return result;
}

/**
 * Reset in-memory buffer and timers for testing.
 */
export function resetRequestLogForTest(): void {
  inMemoryBuffer = [];
  pendingWrite = [];
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}
