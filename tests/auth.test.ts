import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mintTenantToken, verifyTenantToken } from '../src/auth/tenant-token.js';

describe('Auth - Tenant Tokens', () => {
  const testSecret = 'super-secret-test-key-1234567890';

  it('mints and verifies a valid tenant token', () => {
    const token = mintTenantToken('tenant-alpha', testSecret);
    assert.ok(token.startsWith('pft_tenant-alpha.'));

    const verified = verifyTenantToken(token, testSecret);
    assert.equal(verified, 'tenant-alpha');
  });

  it('rejects tampered tenant tokens', () => {
    const token = mintTenantToken('tenant-alpha', testSecret);
    const tampered = token.replace('tenant-alpha', 'tenant-beta');
    const verified = verifyTenantToken(tampered, testSecret);
    assert.equal(verified, null);
  });

  it('rejects token signed with different secret', () => {
    const token = mintTenantToken('tenant-alpha', testSecret);
    const verified = verifyTenantToken(token, 'different-secret-key-999');
    assert.equal(verified, null);
  });

  it('rejects malformed token strings', () => {
    assert.equal(verifyTenantToken('not-a-token', testSecret), null);
    assert.equal(verifyTenantToken('pft_malformed', testSecret), null);
    assert.equal(verifyTenantToken('', testSecret), null);
    assert.equal(verifyTenantToken(null, testSecret), null);
    assert.equal(verifyTenantToken(undefined, testSecret), null);
  });
});
