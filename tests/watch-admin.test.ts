import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { CONFIG } from '../src/config.js';
import { resetFailedLoginsForTest } from '../src/auth/admin-auth.js';
import { resetNotifyForTests, setNotifyTransportsForTests } from '../src/core/notify.js';
import { resetWatchForTests } from '../src/core/watch.js';

describe('Watch Admin API (tests/watch-admin.test.ts)', () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let cookieVal: string;

  const adminPassword = 'watch-admin-test-password-999';

  async function login(): Promise<string> {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `username=admin&password=${adminPassword}`,
    });
    const setCookie = loginRes.headers['set-cookie'] as string;
    return setCookie.split(';')[0]; // rr_admin=...
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-watch-admin-'));
    process.env.ROUTER_STATE_DIR = tmpDir;
    process.env.ROUTER_WATCH = 'off';
    process.env.MINIMAX_API_KEY = '';
    process.env.ROUTER_MINIMAX_REMAINS_INTERVAL_SEC = '0';
    process.env.ROUTER_ADMIN_PASSWORD = adminPassword;
    CONFIG.serviceApiKey = 'watch-admin-test-master-000';

    resetWatchForTests();
    resetNotifyForTests();
    setNotifyTransportsForTests([]);

    app = buildApp();
    await app.ready();

    cookieVal = await login();
  });

  after(async () => {
    await app.close();
    resetWatchForTests();
    resetNotifyForTests();
    delete process.env.ROUTER_ADMIN_PASSWORD;
    delete process.env.ROUTER_STATE_DIR;
    delete process.env.ROUTER_WATCH;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.ROUTER_MINIMAX_REMAINS_INTERVAL_SEC;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetFailedLoginsForTest();
  });

  // ---- GET /admin/api/watch ----

  it('GET /admin/api/watch returns 401 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/api/watch' });
    assert.equal(res.statusCode, 401);
  });

  it('GET /admin/api/watch returns empty list when no reports exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/watch',
      headers: { cookie: cookieVal },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.reports));
    assert.equal(body.reports.length, 0);
  });

  it('GET /admin/api/watch returns reports sorted newest first', async () => {
    // Write two fake reports
    const watchDir = path.join(tmpDir, 'watch');
    fs.mkdirSync(watchDir, { recursive: true });

    const report1 = {
      version: 1,
      window: { from: '2026-09-28T00:00:00.000Z', to: '2026-09-29T00:00:00.000Z' },
      generatedAt: '2026-09-29T03:00:00.000Z',
      level: 'warn',
      signals: [{ id: 'errors.high-rate', level: 'warn', title: 'High error rate', details: 'x' }],
      metrics: {},
    };
    const report2 = {
      version: 1,
      window: { from: '2026-09-29T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z' },
      generatedAt: '2026-09-30T03:00:00.000Z',
      level: 'ok',
      signals: [],
      metrics: {},
    };

    fs.writeFileSync(path.join(watchDir, '2026-09-29.json'), JSON.stringify(report1));
    fs.writeFileSync(path.join(watchDir, '2026-09-30.json'), JSON.stringify(report2));

    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/watch',
      headers: { cookie: cookieVal },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.reports));
    // Should be sorted newest first
    assert.equal(body.reports.length >= 2, true);
    const names = body.reports.map((r: any) => r.name);
    const idx29 = names.indexOf('2026-09-29.json');
    const idx30 = names.indexOf('2026-09-30.json');
    assert.ok(idx30 < idx29, '2026-09-30 should appear before 2026-09-29 (newest first)');
  });

  // ---- GET /admin/api/watch/:name ----

  it('GET /admin/api/watch/:name returns 401 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/api/watch/2026-09-30.json' });
    assert.equal(res.statusCode, 401);
  });

  it('GET /admin/api/watch/:name returns report JSON', async () => {
    const watchDir = path.join(tmpDir, 'watch');
    fs.mkdirSync(watchDir, { recursive: true });
    const report = { version: 1, level: 'ok', signals: [] };
    fs.writeFileSync(path.join(watchDir, '2026-09-30.json'), JSON.stringify(report));

    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/watch/2026-09-30.json',
      headers: { cookie: cookieVal },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.version, 1);
    assert.equal(body.level, 'ok');
  });

  it('GET /admin/api/watch/:name with path traversal returns 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/watch/..%2F..%2Fetc%2Fpasswd',
      headers: { cookie: cookieVal },
    });
    // Should not return 200 - must return 404 (name doesn't match safe pattern)
    assert.notEqual(res.statusCode, 200);
    assert.ok(res.statusCode === 404 || res.statusCode === 400);
  });

  it('GET /admin/api/watch/:name with non-existent report returns 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/api/watch/2020-01-01.json',
      headers: { cookie: cookieVal },
    });
    assert.equal(res.statusCode, 404);
  });

  it('GET /admin/api/watch/:name rejects invalid file names', async () => {
    // Names with ../ or non-matching pattern
    const badNames = [
      '../secrets.json',
      'state.json',
      'notadate.json',
      '2026-09-30.txt',
    ];

    for (const badName of badNames) {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/api/watch/' + encodeURIComponent(badName),
        headers: { cookie: cookieVal },
      });
      assert.notEqual(res.statusCode, 200, `Expected non-200 for: ${badName}`);
    }
  });

  // ---- POST /admin/api/watch/run ----

  it('POST /admin/api/watch/run returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/watch/run',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ notify: false }),
    });
    assert.equal(res.statusCode, 401);
  });

  it('POST /admin/api/watch/run returns a valid WatchReport', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/watch/run',
      headers: {
        cookie: cookieVal,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ notify: false }),
    });
    assert.equal(res.statusCode, 200);
    const report = JSON.parse(res.body);
    assert.equal(report.version, 1);
    assert.ok(['ok', 'warn', 'crit'].includes(report.level));
    assert.ok(Array.isArray(report.signals));
    assert.ok(report.window && report.window.from && report.window.to);
    assert.ok(report.generatedAt);
  });

  it('POST /admin/api/watch/run with notify:false does not send email', async () => {
    const sent: any[] = [];
    setNotifyTransportsForTests([
      {
        send: async (msg: any) => { sent.push(msg); },
        name: 'test-email',
      },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/watch/run',
      headers: {
        cookie: cookieVal,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ notify: false }),
    });
    assert.equal(res.statusCode, 200);
    // No email should be sent when notify is false
    assert.equal(sent.length, 0, 'notify:false should not send any email');

    setNotifyTransportsForTests([]);
  });

  it('POST /admin/api/watch/run saves manual report file', async () => {
    const watchDir = path.join(tmpDir, 'watch');

    // Count existing files before
    const filesBefore = fs.existsSync(watchDir) ? fs.readdirSync(watchDir).filter(f => f.startsWith('manual-')) : [];

    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/watch/run',
      headers: {
        cookie: cookieVal,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ notify: false }),
    });
    assert.equal(res.statusCode, 200);

    // A manual-*.json file should now exist
    const filesAfter = fs.existsSync(watchDir) ? fs.readdirSync(watchDir).filter(f => f.startsWith('manual-')) : [];
    assert.ok(filesAfter.length > filesBefore.length, 'A manual report file should be created');
  });
});
