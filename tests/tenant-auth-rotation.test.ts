import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { CONFIG } from '../src/config.js';
import { mintTenantToken, verifyTenantToken } from '../src/auth/tenant-token.js';
import { upsertTenant, resetTenantsForTests } from '../src/core/tenants.js';
import { queryRequests, flushRequestLogSync } from '../src/core/request-log.js';

describe('Tenant Auth, Rotation & Disabling (tests/tenant-auth-rotation.test.ts)', () => {
  let app: FastifyInstance;
  let tmpDir: string;
  const originalStateDir = process.env.ROUTER_STATE_DIR;
  const masterKey = 'test-master-key-xyz-987654';
  const tenantSecret = 'test-tenant-secret-abc-123456';

  before(async () => {
    CONFIG.serviceApiKey = masterKey;
    CONFIG.tenantTokenSecret = tenantSecret;
  });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-auth-test-'));
    process.env.ROUTER_STATE_DIR = tmpDir;
    resetTenantsForTests();

    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    resetTenantsForTests();
    if (originalStateDir !== undefined) {
      process.env.ROUTER_STATE_DIR = originalStateDir;
    } else {
      delete process.env.ROUTER_STATE_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Stateless HMAC token versioning and rotation', () => {
    it('legacy tokens (tokenVersion: 0 or undefined) verify successfully', () => {
      // No tenant record exists
      const tokenNoRecord = mintTenantToken('tenant-legacy', tenantSecret);
      assert.ok(tokenNoRecord.startsWith('pft_tenant-legacy.'));
      assert.equal(verifyTenantToken(tokenNoRecord, tenantSecret), 'tenant-legacy');

      // Tenant record with tokenVersion: 0
      upsertTenant({
        id: 'tenant-v0',
        status: 'active',
        tokenVersion: 0,
        createdAt: '',
        updatedAt: '',
      });
      const tokenV0 = mintTenantToken('tenant-v0', tenantSecret);
      assert.equal(verifyTenantToken(tokenV0, tenantSecret), 'tenant-v0');
    });

    it('versioned tokens (tokenVersion > 0) use versioned MAC input', () => {
      upsertTenant({
        id: 'tenant-v1',
        status: 'active',
        tokenVersion: 1,
        createdAt: '',
        updatedAt: '',
      });

      const tokenV1 = mintTenantToken('tenant-v1', tenantSecret);
      assert.ok(tokenV1.startsWith('pft_tenant-v1.'));
      assert.equal(verifyTenantToken(tokenV1, tenantSecret), 'tenant-v1');

      // A legacy token for tenant-v1 must fail verification because registry requires v1
      const legacyToken = mintTenantToken('tenant-v1', tenantSecret, 0);
      assert.equal(verifyTenantToken(legacyToken, tenantSecret), null);
    });

    it('rotation invalidates old version token immediately', () => {
      upsertTenant({
        id: 'tenant-rotate',
        status: 'active',
        tokenVersion: 1,
        createdAt: '',
        updatedAt: '',
      });

      const oldToken = mintTenantToken('tenant-rotate', tenantSecret);
      assert.equal(verifyTenantToken(oldToken, tenantSecret), 'tenant-rotate');

      // Rotate: increment tokenVersion to 2
      upsertTenant({
        id: 'tenant-rotate',
        status: 'active',
        tokenVersion: 2,
        createdAt: '',
        updatedAt: '',
      });

      // Old token no longer verifies
      assert.equal(verifyTenantToken(oldToken, tenantSecret), null);

      // New token verifies
      const newToken = mintTenantToken('tenant-rotate', tenantSecret);
      assert.notEqual(newToken, oldToken);
      assert.equal(verifyTenantToken(newToken, tenantSecret), 'tenant-rotate');
    });
  });

  describe('Disabled tenant handling (HTTP 403 tenant_disabled)', () => {
    it('returns 403 tenant_disabled when using bearer token of a disabled tenant', async () => {
      upsertTenant({
        id: 'disabled-client',
        status: 'disabled',
        createdAt: '',
        updatedAt: '',
      });

      const token = mintTenantToken('disabled-client', tenantSecret);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'fast',
          messages: [{ role: 'user', content: 'hello' }],
        },
      });

      assert.equal(res.statusCode, 403);
      const body = JSON.parse(res.body);
      assert.equal(body.error.code, 'tenant_disabled');
      assert.equal(body.error.type, 'invalid_request_error');
      assert.ok(body.error.message.includes('disabled'));

      // Check that it was logged to request log with status 403 and errorCode tenant_disabled
      const logs = queryRequests({ tenant: 'disabled-client' });
      const disabledLog = logs.items.find(l => l.tenant === 'disabled-client' && l.status === 403);
      assert.ok(disabledLog, 'Must record 403 request in request log');
      assert.equal(disabledLog.errorCode, 'tenant_disabled');
    });

    it('returns 403 tenant_disabled when master key impersonates a disabled tenant', async () => {
      upsertTenant({
        id: 'disabled-team',
        status: 'disabled',
        createdAt: '',
        updatedAt: '',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${masterKey}`,
          'x-tenant-id': 'disabled-team',
          'content-type': 'application/json',
        },
        payload: {
          model: 'fast',
          messages: [{ role: 'user', content: 'hello' }],
        },
      });

      assert.equal(res.statusCode, 403);
      const body = JSON.parse(res.body);
      assert.equal(body.error.code, 'tenant_disabled');
    });

    it('active tenant is allowed through auth', async () => {
      upsertTenant({
        id: 'active-client',
        status: 'active',
        createdAt: '',
        updatedAt: '',
      });

      const token = mintTenantToken('active-client', tenantSecret);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'invalid-model-tier-so-we-fail-after-auth',
          messages: [{ role: 'user', content: 'hello' }],
        },
      });

      // Auth succeeded! (Fails later due to unknown model, 400 invalid_request_error)
      assert.notEqual(res.statusCode, 401);
      assert.notEqual(res.statusCode, 403);
    });

    it('tenant tokens are rejected with 403 on admin endpoints', async () => {
      const token = mintTenantToken('active-client', tenantSecret);

      const res = await app.inject({
        method: 'GET',
        url: '/admin/api/tenants',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      assert.equal(res.statusCode, 403);
    });
  });
});
