import { createHash } from 'node:crypto';
import type { PoolEntry } from '../types.js';
import { getTenant } from './tenants.js';
import { decryptSecret } from './secrets.js';

const decryptedKeyCache = new Map<string, string>(); // fp -> plain key

/**
 * Drops one or all cached decrypted keys from memory.
 */
export function dropDecryptedKeyCache(fp?: string): void {
  if (fp) {
    decryptedKeyCache.delete(fp);
  } else {
    decryptedKeyCache.clear();
  }
}

/**
 * Resolves the physical API key for a pool entry.
 * Single source of truth for key resolution.
 * When entry.keyRef is set, decrypts the tenant's upstream key and caches
 * the plain key in memory keyed by fp.
 * Never falls back to environment variables when entry.keyRef is set.
 */
export function resolveEntryKey(
  entry:
    | {
        apiKeyEnv?: string;
        keyRef?: { tenantId: string; provider: 'ollama-cloud' | 'openai' };
      }
    | PoolEntry
): string | undefined {
  if (entry.keyRef) {
    const tenant = getTenant(entry.keyRef.tenantId);
    if (!tenant) return undefined;
    const keyInfo = tenant.upstreamKeys?.[entry.keyRef.provider];
    if (!keyInfo || !keyInfo.enc) return undefined;
    if (keyInfo.status === 'invalid') return undefined;

    const fp = keyInfo.fp;
    const cached = decryptedKeyCache.get(fp);
    if (cached) return cached;

    try {
      const plain = decryptSecret(keyInfo.enc);
      decryptedKeyCache.set(fp, plain);
      return plain;
    } catch (err) {
      console.warn(
        `[keys] Failed to decrypt key for tenant "${entry.keyRef.tenantId}" (${entry.keyRef.provider}):`,
        err
      );
      return undefined;
    }
  }

  if (!entry.apiKeyEnv) return undefined;
  return process.env[entry.apiKeyEnv];
}

/**
 * Computes a 12-hex-character sha256 fingerprint of an API key.
 */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}
