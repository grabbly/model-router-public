import { IncomingHttpHeaders } from 'node:http';

// Clients identify themselves via three request headers:
//   x-router-app: calling service or application (e.g. my-portal)
//   x-router-agent: agent worker / subagent name (e.g. pf-work-1)
//   x-router-session: task or session identifier
//
// These headers allow loop detection, per-session rate limits, and per-tenant
// audit trails. Modes:
//   soft: default during migration; warns on missing headers
//   enforce: returns 400 when any of the three is missing
//   off: no enforcement or warning

export type MetadataMode = 'soft' | 'enforce' | 'off';

export interface ClientMeta {
  app?: string;
  agent?: string;
  session?: string;
  user?: string;
  complete: boolean;
}

export interface TenantMetaCounters {
  withMeta: number;
  withoutMeta: number;
  lastSeenMissing?: string;
}

export interface ClientMetadataStatus {
  mode: MetadataMode;
  tenants: Record<string, TenantMetaCounters>;
}

const tenantCounters = new Map<string, TenantMetaCounters>();
const lastWarned = new Map<string, number>();
let modeOverride: MetadataMode | null = null;

function sanitizeValue(raw: unknown): string | undefined {
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  if (!trimmed) return undefined;
  // Keep only [A-Za-z0-9._:@/-], truncate to 128 chars
  const cleaned = trimmed.replace(/[^A-Za-z0-9._:@/-]/g, '').slice(0, 128);
  return cleaned.length > 0 ? cleaned : undefined;
}

export function parseClientMeta(
  headers: IncomingHttpHeaders | Record<string, unknown>
): ClientMeta {
  const app = sanitizeValue(headers['x-router-app']);
  const agent = sanitizeValue(headers['x-router-agent']);
  const session = sanitizeValue(headers['x-router-session']);
  const userHeader = sanitizeValue(headers['x-router-user']);
  let user = userHeader;
  if (!user && session) {
    const colonIdx = session.indexOf(':');
    if (colonIdx > 0) {
      user = session.slice(0, colonIdx);
    }
  }
  const complete = Boolean(app && agent && session);
  return { app, agent, session, user, complete };
}

export function getMetadataMode(): MetadataMode {
  if (modeOverride) return modeOverride;
  const envMode = process.env.ROUTER_METADATA_MODE?.toLowerCase();
  if (envMode === 'enforce' || envMode === 'off') return envMode;
  return 'soft';
}

export function setMetadataModeForTests(mode: MetadataMode | null): void {
  modeOverride = mode;
}

export function recordClientMeta(
  tenantId: string,
  complete: boolean,
  now = Date.now()
): void {
  let stats = tenantCounters.get(tenantId);
  if (!stats) {
    stats = { withMeta: 0, withoutMeta: 0 };
    tenantCounters.set(tenantId, stats);
  }

  if (complete) {
    stats.withMeta += 1;
  } else {
    stats.withoutMeta += 1;
    stats.lastSeenMissing = new Date(now).toISOString();
  }
}

export function warnMissingMetadataOnce(tenantId: string, now = Date.now()): void {
  const last = lastWarned.get(tenantId);
  const tenMinutesMs = 10 * 60 * 1000;
  if (!last || now - last >= tenMinutesMs) {
    console.warn(`[meta] ${tenantId} missing x-router-{app,agent,session}`);
    lastWarned.set(tenantId, now);
  }
}

export function getClientMetadataStatus(): ClientMetadataStatus {
  const tenants: Record<string, TenantMetaCounters> = {};
  for (const [k, v] of tenantCounters.entries()) {
    tenants[k] = { ...v };
  }
  return {
    mode: getMetadataMode(),
    tenants,
  };
}

export function resetClientMetaForTests(): void {
  tenantCounters.clear();
  lastWarned.clear();
  modeOverride = null;
}
