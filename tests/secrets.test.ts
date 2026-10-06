import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  encryptSecret,
  decryptSecret,
  isSecretsConfigured
} from '../src/core/secrets.js';

describe('Secrets (AES-256-GCM)', () => {
  const originalEnv = process.env.ROUTER_SECRETS_KEY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ROUTER_SECRETS_KEY = originalEnv;
    } else {
      delete process.env.ROUTER_SECRETS_KEY;
    }
  });

  it('reports isSecretsConfigured correctly', () => {
    delete process.env.ROUTER_SECRETS_KEY;
    assert.equal(isSecretsConfigured(), false);

    process.env.ROUTER_SECRETS_KEY = '   ';
    assert.equal(isSecretsConfigured(), false);

    process.env.ROUTER_SECRETS_KEY = 'valid-key';
    assert.equal(isSecretsConfigured(), true);
  });

  it('throws when encrypting or decrypting without ROUTER_SECRETS_KEY', () => {
    delete process.env.ROUTER_SECRETS_KEY;
    assert.throws(
      () => encryptSecret('my-secret'),
      /Secrets master key is not configured/
    );
    assert.throws(
      () => decryptSecret('v1:iv:tag:ct'),
      /Secrets master key is not configured/
    );
  });

  it('encrypts and decrypts with a 32-byte base64 master key', () => {
    const keyBytes = crypto.randomBytes(32);
    process.env.ROUTER_SECRETS_KEY = keyBytes.toString('base64');

    const plaintext = 'sk-ollama-client-secret-12345';
    const encrypted = encryptSecret(plaintext);

    assert.ok(encrypted.startsWith('v1:'));
    const parts = encrypted.split(':');
    assert.equal(parts.length, 4);

    const decrypted = decryptSecret(encrypted);
    assert.equal(decrypted, plaintext);
  });

  it('encrypts and decrypts with a 64-hex char master key', () => {
    const keyBytes = crypto.randomBytes(32);
    process.env.ROUTER_SECRETS_KEY = keyBytes.toString('hex');

    const plaintext = 'sk-another-secret-token';
    const encrypted = encryptSecret(plaintext);
    const decrypted = decryptSecret(encrypted);
    assert.equal(decrypted, plaintext);
  });

  it('encrypts and decrypts with an arbitrary passphrase via scrypt derivation', () => {
    process.env.ROUTER_SECRETS_KEY = 'my-custom-passphrase-string';

    const plaintext = 'test-secret-with-passphrase';
    const encrypted = encryptSecret(plaintext);
    const decrypted = decryptSecret(encrypted);
    assert.equal(decrypted, plaintext);
  });

  it('throws clear error on wrong master key', () => {
    process.env.ROUTER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
    const encrypted = encryptSecret('confidential');

    // Switch to another master key
    process.env.ROUTER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
    assert.throws(
      () => decryptSecret(encrypted),
      /Failed to decrypt secret: invalid master key or corrupted data/
    );
  });

  it('throws on corrupted or malformed blob', () => {
    process.env.ROUTER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

    assert.throws(() => decryptSecret(''), /Invalid secret blob format/);
    assert.throws(() => decryptSecret('v2:a:b:c'), /expected v1:<iv>:<tag>:<ct>/);
    assert.throws(() => decryptSecret('v1:shortiv:tag:ct'), /invalid iv or tag length/);
  });
});
