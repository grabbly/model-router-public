import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { CONFIG } from '../src/config.js';
import { mintTenantToken, verifyTenantToken } from '../src/auth/tenant-token.js';
import { upsertTenant, getTenant, resetTenantsForTests } from '../src/core/tenants.js';
import { emitRouterEvent, resetRouterEventsForTests } from '../src/core/events.js';
import { checkLoop, resetLoopGuard } from '../src/core/loop-guard.js';

describe('Admin API for Tenants (tests/tenants-admin.test.ts)', () => {
  let app: FastifyInstance;
  let tmpDir: string;
  const originalStateDir = process.env.ROUTER_STATE_DIR;
  const masterKey = 'admin-api-master-key-5555';
  const tenantSecret = 'admin-api-tenant-secret-6666';

  before(async () => {
    CONFIG.serviceApiKey = masterKey;
    CONFIG.tenantTokenSecret = tenantSecret;
  });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-admin-test-'));
    process.env.ROUTER_STATE_DIR = tmpDir;
    resetTenantsForTests();
    resetRouterEventsForTests();
    resetLoopGuard();

    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    resetTenantsForTests();
    resetRouterEventsForTests();
    resetLoopGuard();
    if (originalStateDir !== undefined) {
      process.env.ROUTER_STATE_DIR = originalStateDir;
    } else {
      delete process.env.ROUTER_STATE_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Admin Auth Protection', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/api/tenants',
      });
      assert.equal(res.statusCode, 401);
    });

    it('rejects tenant tokens with 403', async () => {
      const token = mintTenantToken('tenant-user', tenantSecret);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/api/tenants',
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(res.statusCode, 403);
    });

    it('accepts master key with 200', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/api/tenants',
        headers: { authorization: `Bearer ${masterKey}` },
      });
      assert.equal(res.statusCode, 200);
    });
  });

  describe('GET /admin/api/tenants and GET /admin/api/tenants/:id', () => {
    it('returns registered tenants and includes unknown tenants seen in traffic', async () => {
      upsertTenant({
        id: 'registered-1',
        name: 'Registered One',
        status: 'active',
        limits: { rate: { rpm: 30 } },
        createdAt: '',
        updatedAt: '',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/admin/api/tenants',
        headers: { authorization: `Bearer ${masterKey}` },
      });

      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.ok(Array.isArray(data.tenants));
      const t1 = data.tenants.find((t: any) => t.record?.id === 'registered-1');
      assert.ok(t1, 'Registered tenant must be present');
      assert.equal(t1.known, true);
      assert.equal(t1.record.name, 'Registered One');
      assert.equal(t1.effective.rate.rpm, 30);
      assert.ok(t1.usage);
    });

    it('returns 404 for non-existent tenant on GET /admin/api/tenants/:id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/api/tenants/non-existent-tenant',
        headers: { authorization: `Bearer ${masterKey}` },
      });
      assert.equal(res.statusCode, 404);
    });

    it('returns tenant details on GET /admin/api/tenants/:id', async () => {
      upsertTenant({
        id: 't-details',
        name: 'Details Tenant',
        status: 'active',
        createdAt: '',
        updatedAt: '',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/admin/api/tenants/t-details',
        headers: { authorization: `Bearer ${masterKey}` },
      });
      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.record.id, 't-details');
      assert.equal(data.record.name, 'Details Tenant');
    });
  });

  describe('PUT /admin/api/tenants/:id', () => {
    it('validates request body and returns 400 on error', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/api/tenants/t-bad',
        headers: { authorization: `Bearer ${masterKey}`, 'content-type': 'application/json' },
        payload: {
          status: 'invalid-status',
          limits: { rate: { rpm: -10 } },
        },
      });

      assert.equal(res.statusCode, 400);
      const data = JSON.parse(res.body);
      assert.equal(data.error.code, 'validation_error');
      assert.ok(Array.isArray(data.error.errors));
      assert.ok(data.error.errors.length >= 2);
    });

    it('returns 400 if body id does not match path id', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/api/tenants/path-id',
        headers: { authorization: `Bearer ${masterKey}`, 'content-type': 'application/json' },
        payload: {
          id: 'mismatched-body-id',
          status: 'active',
        },
      });

      assert.equal(res.statusCode, 400);
    });

    it('creates or updates tenant record and sets timestamps', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/api/tenants/t-save',
        headers: { authorization: `Bearer ${masterKey}`, 'content-type': 'application/json' },
        payload: {
          name: 'Saved Tenant',
          status: 'active',
          limits: { rate: { concurrent: 5 } },
        },
      });

      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.ok, true);
      assert.equal(data.tenant.id, 't-save');
      assert.equal(data.tenant.name, 'Saved Tenant');
      assert.ok(data.tenant.createdAt);
      assert.ok(data.tenant.updatedAt);

      const saved = getTenant('t-save');
      assert.ok(saved);
      assert.equal(saved.limits?.rate?.concurrent, 5);
    });
  });

  describe('DELETE /admin/api/tenants/:id', () => {
    it('deletes tenant with tokenVersion: 0 without conflict', async () => {
      upsertTenant({
        id: 't-del-legacy',
        status: 'active',
        tokenVersion: 0,
        createdAt: '',
        updatedAt: '',
      });

      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/api/tenants/t-del-legacy',
        headers: { authorization: `Bearer ${masterKey}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(getTenant('t-del-legacy'), null);
    });

    it('refuses delete with 409 conflict when tokenVersion > 0 unless ?force=1', async () => {
      upsertTenant({
        id: 't-del-versioned',
        status: 'active',
        tokenVersion: 2,
        createdAt: '',
        updatedAt: '',
      });

      // Without force: 409 Conflict
      const resConflict = await app.inject({
        method: 'DELETE',
        url: '/admin/api/tenants/t-del-versioned',
        headers: { authorization: `Bearer ${masterKey}` },
      });

      assert.equal(resConflict.statusCode, 409);
      const conflictBody = JSON.parse(resConflict.body);
      assert.equal(conflictBody.error.code, 'token_version_conflict');
      assert.ok(getTenant('t-del-versioned'), 'Tenant must not be deleted');

      // With ?force=1: 200 OK
      const resForce = await app.inject({
        method: 'DELETE',
        url: '/admin/api/tenants/t-del-versioned?force=1',
        headers: { authorization: `Bearer ${masterKey}` },
      });

      assert.equal(resForce.statusCode, 200);
      assert.equal(getTenant('t-del-versioned'), null);
    });
  });

  describe('POST /admin/api/tenants/:id/token', () => {
    it('mints token for current version without rotating when rotate=false', async () => {
      upsertTenant({
        id: 't-token',
        status: 'active',
        tokenVersion: 1,
        createdAt: '',
        updatedAt: '',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/admin/api/tenants/t-token/token',
        headers: { authorization: `Bearer ${masterKey}`, 'content-type': 'application/json' },
        payload: { rotate: false },
      });

      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.ok(data.token);
      assert.equal(verifyTenantToken(data.token, tenantSecret), 't-token');
      assert.equal(getTenant('t-token')?.tokenVersion, 1);
    });

    it('increments tokenVersion and invalidates old token when rotate=true', async () => {
      upsertTenant({
        id: 't-rotate',
        status: 'active',
        tokenVersion: 1,
        createdAt: '',
        updatedAt: '',
      });

      const oldToken = mintTenantToken('t-rotate', tenantSecret);

      const res = await app.inject({
        method: 'POST',
        url: '/admin/api/tenants/t-rotate/token',
        headers: { authorization: `Bearer ${masterKey}`, 'content-type': 'application/json' },
        payload: { rotate: true },
      });

      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.notEqual(data.token, oldToken);
      assert.equal(verifyTenantToken(data.token, tenantSecret), 't-rotate');
      assert.equal(verifyTenantToken(oldToken, tenantSecret), null, 'Old token must be invalidated');
      assert.equal(getTenant('t-rotate')?.tokenVersion, 2);
    });
  });

  describe('POST /admin/api/tenants/:id/unblock', () => {
    it('unblocks loop guard sessions for the tenant', async () => {
      // Trip a loop block
      const sessionKey = 't-unblock|app|agent|session1';
      const repeated = [{ role: 'user', content: 'trip' }];
      checkLoop(sessionKey, repeated, { limits: { maxRepeat: 2 } });
      checkLoop(sessionKey, repeated, { limits: { maxRepeat: 2 } });

      // Unblock via Admin API
      const res = await app.inject({
        method: 'POST',
        url: '/admin/api/tenants/t-unblock/unblock',
        headers: { authorization: `Bearer ${masterKey}` },
      });

      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.cleared, 1);
    });
  });

  describe('GET /admin/api/events', () => {
    it('returns recent router events with limit', async () => {
      emitRouterEvent({ type: 'test.event.1', tenantId: 't1' });
      emitRouterEvent({ type: 'test.event.2', tenantId: 't2' });

      const res = await app.inject({
        method: 'GET',
        url: '/admin/api/events?limit=10',
        headers: { authorization: `Bearer ${masterKey}` },
      });

      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.ok(Array.isArray(data.events));
      assert.ok(data.events.some((e: any) => e.type === 'test.event.1'));
      assert.ok(data.events.some((e: any) => e.type === 'test.event.2'));
    });
  });
});
