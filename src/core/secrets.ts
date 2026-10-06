import crypto from 'node:crypto';

const SALT = 'model-router-secrets-salt-v1';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const TAG_LENGTH = 16; // 128-bit auth tag

/**
 * Checks whether the secrets master key is configured via environment variable.
 */
export function isSecretsConfigured(): boolean {
  const key = process.env.ROUTER_SECRETS_KEY;
  return typeof key === 'string' && key.trim().length > 0;
}

/**
 * Retrieves the 32-byte master key buffer from ROUTER_SECRETS_KEY.
 * Supports:
 * - 32 bytes encoded as base64 (44 chars)
 * - 64 hex characters (32 bytes)
 * - Arbitrary string derived via scrypt with a fixed salt.
 */
function getMasterKeyBuffer(): Buffer {
  const raw = process.env.ROUTER_SECRETS_KEY;
  if (!raw || raw.trim().length === 0) {
    throw new Error('Secrets master key is not configured (ROUTER_SECRETS_KEY)');
  }
  const trimmed = raw.trim();

  // 1. Try 64 hex chars (32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  // 2. Try base64: if decodes to exactly 32 bytes
  try {
    const b64 = Buffer.from(trimmed, 'base64');
    if (b64.length === 32 && b64.toString('base64') === trimmed) {
      return b64;
    }
  } catch {
    // not base64
  }

  // 3. Otherwise derive with scrypt
  return crypto.scryptSync(trimmed, SALT, 32);
}

/**
 * Encrypts a plaintext secret string using AES-256-GCM.
 * Output format: v1:<iv b64>:<tag b64>:<ct b64>
 */
export function encryptSecret(plain: string): string {
  const key = getMasterKeyBuffer();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * Decrypts a v1 AES-256-GCM blob.
 * Throws a clear error if the master key is incorrect or data is corrupted.
 */
export function decryptSecret(blob: string): string {
  const key = getMasterKeyBuffer();
  if (!blob || typeof blob !== 'string') {
    throw new Error('Invalid secret blob format');
  }
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Invalid secret blob format: expected v1:<iv>:<tag>:<ct>');
  }
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct = Buffer.from(parts[3], 'base64');

  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error('Corrupted secret blob: invalid iv or tag length');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (err: any) {
    throw new Error(
      `Failed to decrypt secret: invalid master key or corrupted data (${err?.message || err})`
    );
  }
}
