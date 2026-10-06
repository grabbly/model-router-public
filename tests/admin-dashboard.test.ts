import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { CONFIG } from '../src/config.js';
import { mintTenantToken } from '../src/auth/tenant-token.js';
import { resetFailedLoginsForTest } from '../src/auth/admin-auth.js';

describe('Admin Dashboard & Auth (tests/admin-dashboard.test.ts)', () => {
  let app: FastifyInstance;
  const masterKey = 'admin-test-master-key-77777777';
  const tenantSecret = 'admin-test-tenant-secret-88888888';
  const adminPassword = 'admin-password-test-secret-123';

  before(async () => {
    CONFIG.serviceApiKey = masterKey;
    CONFIG.tenantTokenSecret = tenantSecret;
    process.env.ROUTER_ADMIN_PASSWORD = adminPassword;

    app = buildApp();
    await app.ready();
  });

  after(async () => {
    await app.close();
    delete process.env.ROUTER_ADMIN_PASSWORD;
  });

  beforeEach(() => {
    resetFailedLoginsForTest();
    process.env.ROUTER_ADMIN_PASSWORD = adminPassword;
  });

  it('dashboard disabled without password', async () => {
    delete process.env.ROUTER_ADMIN_PASSWORD;

    const resUi = await app.inject({
      method: 'GET',
      url: '/admin/ui',
    });
    assert.equal(resUi.statusCode, 503);
    assert.ok(resUi.body.includes('Dashboard disabled: set ROUTER_ADMIN_PASSWORD'));

    const resLogin = await app.inject({
      method: 'GET',
      url: '/admin/login',
    });
    assert.equal(resLogin.statusCode, 503);
    assert.ok(resLogin.body.includes('Dashboard disabled: set ROUTER_ADMIN_PASSWORD'));

    const resPostLogin = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'username=admin&password=anything',
    });
    assert.equal(resPostLogin.statusCode, 503);
  });

  it('login page has username=admin + current-password fields', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/login',
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type']?.includes('text/html'));
    assert.ok(res.body.includes('<form method="post" action="/admin/login">'));
    assert.ok(res.body.includes('name="username"'));
    assert.ok(res.body.includes('autocomplete="username"'));
    assert.ok(res.body.includes('value="admin"'));
    assert.ok(res.body.includes('readonly'));
    assert.ok(res.body.includes('name="password"'));
    assert.ok(res.body.includes('type="password"'));
    assert.ok(res.body.includes('autocomplete="current-password"'));
    assert.ok(res.body.includes('autofocus'));
  });

  it('wrong password → redirect ?e=1', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'username=admin&password=wrong-password',
    });

    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/admin/login?e=1');

    // GET /admin/login?e=1 shows error banner
    const resPage = await app.inject({
      method: 'GET',
      url: '/admin/login?e=1',
    });
    assert.equal(resPage.statusCode, 200);
    assert.ok(resPage.body.includes('Неверный пароль'));
  });

  it('6th failed attempt → 429', async () => {
    resetFailedLoginsForTest();

    // 5 failed attempts redirect to ?e=1
    for (let i = 1; i <= 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-real-ip': '198.51.100.42',
        },
        payload: 'username=admin&password=wrong-attempt',
      });
      assert.equal(res.statusCode, 303, `Attempt ${i} should be 303`);
      assert.equal(res.headers.location, '/admin/login?e=1');
    }

    // 6th failed attempt gets 429
    const res6 = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-real-ip': '198.51.100.42',
      },
      payload: 'username=admin&password=wrong-attempt',
    });
    assert.equal(res6.statusCode, 429, '6th attempt must be 429');
    assert.ok(res6.body.includes('429') || res6.body.includes('попыток'));
  });

  it('right password → 303 + HttpOnly SameSite=Strict cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `username=admin&password=${adminPassword}`,
    });

    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/admin/ui');

    const setCookie = res.headers['set-cookie'] as string;
    assert.ok(setCookie, 'set-cookie header must be present');
    assert.ok(setCookie.includes('rr_admin='));
    assert.ok(setCookie.includes('HttpOnly'));
    assert.ok(setCookie.includes('SameSite=Strict'));
    assert.ok(setCookie.includes('Path=/admin'));
    assert.ok(setCookie.includes('Max-Age=604800'));
  });

  it('cookie opens /admin/ui and /admin/api/*', async () => {
    // Login to get valid cookie
    const loginRes = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `username=admin&password=${adminPassword}`,
    });
    const cookieHeader = loginRes.headers['set-cookie'] as string;
    const cookieVal = cookieHeader.split(';')[0]; // rr_admin=...

    // 1. GET /admin/ui
    const resUi = await app.inject({
      method: 'GET',
      url: '/admin/ui',
      headers: { cookie: cookieVal },
    });
    assert.equal(resUi.statusCode, 200);
    assert.ok(resUi.body.includes('model-router · мониторинг'));

    // 2. GET /admin/api/summary
    const resSummary = await app.inject({
      method: 'GET',
      url: '/admin/api/summary',
      headers: { cookie: cookieVal },
    });
    assert.equal(resSummary.statusCode, 200);
    const summaryData = JSON.parse(resSummary.body);
    assert.ok(summaryData.totals !== undefined);
    assert.ok(Array.isArray(summaryData.series));

    // 3. GET /admin/api/requests
    const resRequests = await app.inject({
      method: 'GET',
      url: '/admin/api/requests',
      headers: { cookie: cookieVal },
    });
    assert.equal(resRequests.statusCode, 200);
    const reqData = JSON.parse(resRequests.body);
    assert.ok(Array.isArray(reqData.items));

    // 4. GET /admin/api/clients
    const resClients = await app.inject({
      method: 'GET',
      url: '/admin/api/clients',
      headers: { cookie: cookieVal },
    });
    assert.equal(resClients.statusCode, 200);
    const clientData = JSON.parse(resClients.body);
    assert.ok(Array.isArray(clientData));
  });

  it('tampered/expired cookie rejected', async () => {
    // 1. Tampered cookie
    const loginRes = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `username=admin&password=${adminPassword}`,
    });
    const cookieHeader = loginRes.headers['set-cookie'] as string;
    const rawVal = cookieHeader.split(';')[0].replace('rr_admin=', '');

    const tampered = `rr_admin=${rawVal.slice(0, 10)}TAMPERED${rawVal.slice(18)}`;

    const resUiTampered = await app.inject({
      method: 'GET',
      url: '/admin/ui',
      headers: { cookie: tampered },
    });
    assert.equal(resUiTampered.statusCode, 303);
    assert.equal(resUiTampered.headers.location, '/admin/login');

    const resApiTampered = await app.inject({
      method: 'GET',
      url: '/admin/api/summary',
      headers: { cookie: tampered },
    });
    assert.equal(resApiTampered.statusCode, 401);

    // 2. Expired cookie
    const expiredPayload = Buffer.from(
      JSON.stringify({ exp: Date.now() - 10_000 }),
      'utf8'
    ).toString('base64url');

    const secret = crypto
      .createHash('sha256')
      .update(`admin-session:${adminPassword}:${tenantSecret}`)
      .digest();
    const expiredHmac = crypto
      .createHmac('sha256', secret)
      .update(expiredPayload)
      .digest('base64url');
    const expiredCookie = `rr_admin=${expiredPayload}.${expiredHmac}`;

    const resUiExpired = await app.inject({
      method: 'GET',
      url: '/admin/ui',
      headers: { cookie: expiredCookie },
    });
    assert.equal(resUiExpired.statusCode, 303);
    assert.equal(resUiExpired.headers.location, '/admin/login');

    const resApiExpired = await app.inject({
      method: 'GET',
      url: '/admin/api/summary',
      headers: { cookie: expiredCookie },
    });
    assert.equal(resApiExpired.statusCode, 401);
  });

  it('changing ROUTER_ADMIN_PASSWORD invalidates the cookie', async () => {
    // 1. Mint valid cookie with original password
    const loginRes = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `username=admin&password=${adminPassword}`,
    });
    const cookieVal = (loginRes.headers['set-cookie'] as string).split(';')[0];

    // Confirm it works
    const resBefore = await app.inject({
      method: 'GET',
      url: '/admin/ui',
      headers: { cookie: cookieVal },
    });
    assert.equal(resBefore.statusCode, 200);

    // 2. Change admin password
    process.env.ROUTER_ADMIN_PASSWORD = 'a-completely-different-password-xyz';

    // 3. Old cookie should now be rejected
    const resAfterUi = await app.inject({
      method: 'GET',
      url: '/admin/ui',
      headers: { cookie: cookieVal },
    });
    assert.equal(resAfterUi.statusCode, 303);
    assert.equal(resAfterUi.headers.location, '/admin/login');

    const resAfterApi = await app.inject({
      method: 'GET',
      url: '/admin/api/summary',
      headers: { cookie: cookieVal },
    });
    assert.equal(resAfterApi.statusCode, 401);
  });

  it('master key works for /admin/api/*', async () => {
    // Test Bearer auth
    const resBearer = await app.inject({
      method: 'GET',
      url: '/admin/api/summary',
      headers: { authorization: `Bearer ${masterKey}` },
    });
    assert.equal(resBearer.statusCode, 200);
    const dataBearer = JSON.parse(resBearer.body);
    assert.ok(dataBearer.totals !== undefined);

    // Test X-API-Key auth
    const resApiKey = await app.inject({
      method: 'GET',
      url: '/admin/api/requests',
      headers: { 'x-api-key': masterKey },
    });
    assert.equal(resApiKey.statusCode, 200);

    // Master key still works when ROUTER_ADMIN_PASSWORD is unset
    delete process.env.ROUTER_ADMIN_PASSWORD;
    const resNoPwd = await app.inject({
      method: 'GET',
      url: '/admin/api/clients',
      headers: { authorization: `Bearer ${masterKey}` },
    });
    assert.equal(resNoPwd.statusCode, 200);
  });

  it('tenant token → 403 on /admin/status and /admin/api/*', async () => {
    const validTenantToken = mintTenantToken('some-tenant-user', tenantSecret);

    // 1. /admin/status returns 403 Forbidden
    const resStatus = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: `Bearer ${validTenantToken}` },
    });
    assert.equal(resStatus.statusCode, 403);
    const bodyStatus = JSON.parse(resStatus.body);
    assert.equal(bodyStatus.error.code, 'forbidden');

    // 2. /admin/api/summary returns 403 Forbidden
    const resSummary = await app.inject({
      method: 'GET',
      url: '/admin/api/summary',
      headers: { authorization: `Bearer ${validTenantToken}` },
    });
    assert.equal(resSummary.statusCode, 403);
    const bodySummary = JSON.parse(resSummary.body);
    assert.equal(bodySummary.error.code, 'forbidden');

    // 3. /admin/api/requests returns 403 Forbidden
    const resRequests = await app.inject({
      method: 'GET',
      url: '/admin/api/requests',
      headers: { authorization: `Bearer ${validTenantToken}` },
    });
    assert.equal(resRequests.statusCode, 403);

    // 4. /admin/api/clients returns 403 Forbidden
    const resClients = await app.inject({
      method: 'GET',
      url: '/admin/api/clients',
      headers: { authorization: `Bearer ${validTenantToken}` },
    });
    assert.equal(resClients.statusCode, 403);
  });

  it('POST /admin/logout clears cookie and redirects to /admin/login', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/logout',
    });

    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/admin/login');
    const setCookie = res.headers['set-cookie'] as string;
    assert.ok(setCookie.includes('Max-Age=0'));
    assert.ok(setCookie.includes('Path=/admin'));
  });
});
