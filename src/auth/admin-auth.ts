import crypto from 'node:crypto';
import { CONFIG } from '../config.js';
import { timingSafeEqualStrings } from './tenant-token.js';

const FAILED_LOGIN_LIMIT = 5;
const FAILED_LOGIN_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// Map of IP to failed login attempt timestamps
const failedLoginMap = new Map<string, number[]>();

export function isDashboardEnabled(): boolean {
  return Boolean(process.env.ROUTER_ADMIN_PASSWORD && process.env.ROUTER_ADMIN_PASSWORD.trim());
}

/**
 * Compare password with crypto.timingSafeEqual on sha256 digests.
 */
export function verifyAdminPassword(provided: string): boolean {
  const adminPassword = process.env.ROUTER_ADMIN_PASSWORD;
  if (!adminPassword) return false;
  const userDigest = crypto.createHash('sha256').update(provided || '').digest();
  const expectedDigest = crypto.createHash('sha256').update(adminPassword).digest();
  return crypto.timingSafeEqual(userDigest, expectedDigest);
}

function getAdminSessionSecret(adminPassword?: string): Buffer {
  const pwd = adminPassword !== undefined ? adminPassword : (process.env.ROUTER_ADMIN_PASSWORD || '');
  const tenantSecret = CONFIG.tenantTokenSecret || CONFIG.serviceApiKey || '';
  return crypto.createHash('sha256').update(`admin-session:${pwd}:${tenantSecret}`).digest();
}

/**
 * Create HMAC-SHA256 signed session cookie value: `<payloadB64>.<hmac>`
 */
export function createAdminSessionToken(adminPassword?: string): string {
  const secret = getAdminSessionSecret(adminPassword);
  // exp = now + 7 days
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payloadObj = { exp };
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const hmac = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${hmac}`;
}

/**
 * Verify HMAC-SHA256 admin session token and expiration.
 */
export function verifyAdminSessionToken(
  token: string | null | undefined,
  adminPassword?: string
): boolean {
  if (!token) return false;
  const pwd = adminPassword !== undefined ? adminPassword : process.env.ROUTER_ADMIN_PASSWORD;
  if (!pwd) return false;

  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;

  const payloadB64 = token.slice(0, dot);
  const providedHmac = token.slice(dot + 1);

  const secret = getAdminSessionSecret(pwd);
  const expectedHmac = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');

  if (!timingSafeEqualStrings(providedHmac, expectedHmac)) {
    return false;
  }

  try {
    const jsonStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const data = JSON.parse(jsonStr);
    if (!data.exp || typeof data.exp !== 'number') return false;
    return data.exp > Date.now();
  } catch {
    return false;
  }
}

/**
 * Parse Cookie header into key-value map.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

/**
 * Rate limit: max 5 failed attempts per IP per 10 minutes.
 */
export function isLoginRateLimited(ip: string): boolean {
  const now = Date.now();
  let attempts = failedLoginMap.get(ip);
  if (!attempts || attempts.length === 0) return false;

  attempts = attempts.filter((t) => now - t < FAILED_LOGIN_WINDOW_MS);
  failedLoginMap.set(ip, attempts);
  return attempts.length >= FAILED_LOGIN_LIMIT;
}

export function recordFailedLogin(ip: string): void {
  const now = Date.now();
  let attempts = failedLoginMap.get(ip) || [];
  attempts = attempts.filter((t) => now - t < FAILED_LOGIN_WINDOW_MS);
  attempts.push(now);
  failedLoginMap.set(ip, attempts);
}

export function clearFailedLogins(ip: string): void {
  failedLoginMap.delete(ip);
}

export function resetFailedLoginsForTest(): void {
  failedLoginMap.clear();
}
