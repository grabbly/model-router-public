import crypto from 'node:crypto';
import { CONFIG } from '../config.js';
import { getTenant } from '../core/tenants.js';

const PREFIX = 'pft_';

function getSecret(customSecret?: string): string {
  const s = customSecret || CONFIG.tenantTokenSecret || CONFIG.serviceApiKey;
  if (!s) {
    throw new Error(
      'ROUTER_TENANT_TOKEN_SECRET or ROUTER_SERVICE_API_KEY (legacy PF_TENANT_TOKEN_SECRET / PF_SERVICE_API_KEY) must be set to handle tenant tokens'
    );
  }
  return s;
}

export function mac(tenantId: string, customSecret?: string, tokenVersion?: number): string {
  const version = tokenVersion !== undefined ? tokenVersion : (getTenant(tenantId)?.tokenVersion || 0);
  const input = version > 0 ? `tenant:${tenantId}:v${version}` : `tenant:${tenantId}`;
  return crypto
    .createHmac('sha256', getSecret(customSecret))
    .update(input)
    .digest('base64url');
}

/**
 * Creates a signed tenant token: `pft_<tenantId>.<hmac>`
 */
export function mintTenantToken(
  tenantId: string,
  customSecret?: string,
  tokenVersion?: number
): string {
  if (!tenantId) throw new Error('tenantId is required');
  const version = tokenVersion !== undefined ? tokenVersion : (getTenant(tenantId)?.tokenVersion || 0);
  return `${PREFIX}${tenantId}.${mac(tenantId, customSecret, version)}`;
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifies a tenant token and returns tenantId if valid, or null if invalid.
 */
export function verifyTenantToken(
  token: string | null | undefined,
  customSecret?: string
): string | null {
  if (!token || !token.startsWith(PREFIX)) return null;

  const body = token.slice(PREFIX.length);
  const dot = body.lastIndexOf('.');
  if (dot <= 0) return null;

  const tenantId = body.slice(0, dot);
  const provided = body.slice(dot + 1);

  let expected: string;
  try {
    const version = getTenant(tenantId)?.tokenVersion || 0;
    expected = mac(tenantId, customSecret, version);
  } catch {
    return null;
  }

  return timingSafeEqualStrings(provided, expected) ? tenantId : null;
}
