import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { CONFIG } from '../src/config.js';
import { mintTenantToken } from '../src/auth/tenant-token.js';
import { emitRouterEvent, resetRouterEventsForTests } from '../src/core/events.js';
import { upsertTenant, resetTenantsForTests } from '../src/core/tenants.js';
import {
  flushNotifyQueueForTests,
  getNotificationStatus,
  getRecentNotifications,
  handleRouterEvent,
  maskRecipient,
  renderNotificationMessage,
  resetNotifyForTests,
  sendTestNotification,
  setNotifyBackoffForTests,
  setNotifyTransportsForTests,
  shouldNotifyEvent,
  startNotifier,
  stopNotifier,
} from '../src/core/notify.js';

describe('Notifications System (tests/notify.test.ts)', () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-notify-test-'));
    originalEnv = { ...process.env };
    process.env.ROUTER_STATE_DIR = tmpDir;
    resetRouterEventsForTests();
    resetTenantsForTests();
    resetNotifyForTests();
  });

  afterEach(() => {
    resetNotifyForTests();
    resetRouterEventsForTests();
    resetTenantsForTests();
    process.env = originalEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Event filtering and deduplication', () => {
    it('notifies only for configured event types', () => {
      assert.equal(shouldNotifyEvent('limit.reached'), true);
      assert.equal(shouldNotifyEvent('limit.warning'), true);
      assert.equal(shouldNotifyEvent('loop.blocked'), true);
      assert.equal(shouldNotifyEvent('budget.exceeded'), true);
      assert.equal(shouldNotifyEvent('budget.warning'), true);
      assert.equal(shouldNotifyEvent('byok.expired'), true);
      assert.equal(shouldNotifyEvent('catalog.deprecated'), true);
      assert.equal(shouldNotifyEvent('other.unknown'), false);
      assert.equal(shouldNotifyEvent('model.probed'), false);
    });

    it('deduplicates identical events within dedupe window', async () => {
      process.env.ROUTER_ADMIN_EMAIL = 'admin@example.com';
      process.env.ROUTER_NOTIFY_DEDUP_SEC = '3600';

      const sentEmails: Array<{ to: string; subject: string; text: string }> = [];
      setNotifyTransportsForTests({
        email: async (msg) => {
          sentEmails.push(msg);
        },
      });

      startNotifier();

      // Emit first limit.reached event
      emitRouterEvent({
        type: 'limit.reached',
        tenantId: 't-dedup',
        limit: 'rpm',
        current: 60,
        max: 60,
      });

      // Emit identical limit.reached event immediately
      emitRouterEvent({
        type: 'limit.reached',
        tenantId: 't-dedup',
        limit: 'rpm',
        current: 61,
        max: 60,
      });

      await flushNotifyQueueForTests();
      assert.equal(sentEmails.length, 1, 'Second identical event within dedupe window must be dropped');

      // Emit a distinct event (different limit type)
      emitRouterEvent({
        type: 'limit.reached',
        tenantId: 't-dedup',
        limit: 'concurrent',
        current: 5,
        max: 5,
      });

      await flushNotifyQueueForTests();
      assert.equal(sentEmails.length, 2, 'Different limit type must not be deduplicated');
    });

    it('deduplicates loop.blocked events per tenant and rule, not per session', async () => {
      process.env.ROUTER_ADMIN_EMAIL = 'admin@example.com';
      const sentEmails: Array<{ to: string; subject: string; text: string }> = [];
      setNotifyTransportsForTests({
        email: async (msg) => {
          sentEmails.push(msg);
        },
      });

      startNotifier();

      // Session A blocked
      emitRouterEvent({
        type: 'loop.blocked',
        tenantId: 't-loop',
        key: 't-loop|app1|agent1|sessA',
        rule: 'repeat',
        details: '2 identical msgs',
      });

      // Session A blocked again -> dropped
      emitRouterEvent({
        type: 'loop.blocked',
        tenantId: 't-loop',
        key: 't-loop|app1|agent1|sessA',
        rule: 'repeat',
        details: '2 identical msgs',
      });

      // Session B, same rule -> dropped (no flood from a fleet of sessions)
      emitRouterEvent({
        type: 'loop.blocked',
        tenantId: 't-loop',
        key: 't-loop|app1|agent1|sessB',
        rule: 'repeat',
        details: '3 identical msgs',
      });

      // Session B, other rule -> delivered
      emitRouterEvent({
        type: 'loop.blocked',
        tenantId: 't-loop',
        key: 't-loop|app1|agent1|sessB',
        rule: 'rate',
        details: '10 requests in 5s',
      });

      await flushNotifyQueueForTests();
      assert.equal(sentEmails.length, 2, 'One message per tenant + rule');
    });
  });

  describe('Recipient selection', () => {
    it('defaults to admin-only; tenant contacts are NEVER messaged', async () => {
      process.env.ROUTER_ADMIN_EMAIL = 'admin@example.com';
      process.env.ROUTER_ADMIN_TELEGRAM_CHAT_ID = '9999';
      delete process.env.ROUTER_NOTIFY_TENANTS; // default: false

      upsertTenant({
        id: 't-client',
        name: 'Client One',
        status: 'active',
        notify: {
          email: ['client@example.com'],
          telegram: ['1111'],
        },
        createdAt: '',
        updatedAt: '',
      });

      const sentEmails: string[] = [];
      const sentTelegrams: string[] = [];
      setNotifyTransportsForTests({
        email: async (msg) => {
          sentEmails.push(msg.to);
        },
        telegram: async (chatId) => {
          sentTelegrams.push(chatId);
        },
      });

      startNotifier();

      emitRouterEvent({
        type: 'limit.reached',
        tenantId: 't-client',
        limit: 'day',
        current: 100,
        max: 100,
      });

      await flushNotifyQueueForTests();

      assert.deepEqual(sentEmails, ['admin@example.com'], 'Only admin email must be messaged');
      assert.deepEqual(sentTelegrams, ['9999'], 'Only admin telegram must be messaged');
      assert.ok(!sentEmails.includes('client@example.com'), 'Client email must NOT be messaged');
      assert.ok(!sentTelegrams.includes('1111'), 'Client telegram must NOT be messaged');
    });

    it('adds tenant contacts when ROUTER_NOTIFY_TENANTS=true, never another tenant contacts', async () => {
      process.env.ROUTER_ADMIN_EMAIL = 'admin@example.com';
      process.env.ROUTER_ADMIN_TELEGRAM_CHAT_ID = '9999';
      process.env.ROUTER_NOTIFY_TENANTS = 'true';

      upsertTenant({
        id: 'tenant-a',
        name: 'Tenant Alpha',
        status: 'active',
        notify: {
          email: ['alpha@example.com'],
          telegram: ['1111'],
        },
        createdAt: '',
        updatedAt: '',
      });

      upsertTenant({
        id: 'tenant-b',
        name: 'Tenant Beta',
        status: 'active',
        notify: {
          email: ['beta@example.com'],
          telegram: ['2222'],
        },
        createdAt: '',
        updatedAt: '',
      });

      const sentEmails: string[] = [];
      const sentTelegrams: string[] = [];
      setNotifyTransportsForTests({
        email: async (msg) => {
          sentEmails.push(msg.to);
        },
        telegram: async (chatId) => {
          sentTelegrams.push(chatId);
        },
      });

      startNotifier();

      // Trigger event for tenant-a
      emitRouterEvent({
        type: 'limit.reached',
        tenantId: 'tenant-a',
        limit: 'day',
        current: 50,
        max: 50,
      });

      await flushNotifyQueueForTests();

      // Must include admin and tenant-a
      assert.ok(sentEmails.includes('admin@example.com'), 'Admin must receive email');
      assert.ok(sentEmails.includes('alpha@example.com'), 'Tenant A must receive email');
      assert.ok(sentTelegrams.includes('9999'), 'Admin must receive telegram');
      assert.ok(sentTelegrams.includes('1111'), 'Tenant A must receive telegram');

      // Must NEVER include tenant-b
      assert.ok(!sentEmails.includes('beta@example.com'), 'Tenant B must NOT receive Tenant A notification');
      assert.ok(!sentTelegrams.includes('2222'), 'Tenant B must NOT receive Tenant A notification');
    });

    it('catalog.* events go to admin only even if ROUTER_NOTIFY_TENANTS=true', async () => {
      process.env.ROUTER_ADMIN_EMAIL = 'admin@example.com';
      process.env.ROUTER_NOTIFY_TENANTS = 'true';

      upsertTenant({
        id: 't-catalog-test',
        status: 'active',
        notify: {
          email: ['client@example.com'],
        },
        createdAt: '',
        updatedAt: '',
      });

      const sentEmails: string[] = [];
      setNotifyTransportsForTests({
        email: async (msg) => {
          sentEmails.push(msg.to);
        },
      });

      startNotifier();

      emitRouterEvent({
        type: 'catalog.model_retired',
        tenantId: 't-catalog-test',
        model: 'old-model',
      });

      await flushNotifyQueueForTests();

      assert.deepEqual(sentEmails, ['admin@example.com']);
      assert.ok(!sentEmails.includes('client@example.com'));
    });
  });

  describe('Queue, Retries and Failure Handling', () => {
    it('retries up to 3 times on transport error, then gives up and logs failure', async () => {
      process.env.ROUTER_ADMIN_EMAIL = 'admin@example.com';
      setNotifyBackoffForTests([1, 1, 1]); // Fast backoff in test

      let attempts = 0;
      setNotifyTransportsForTests({
        email: async () => {
          attempts++;
          throw new Error('SMTP connection timed out');
        },
      });

      startNotifier();

      emitRouterEvent({
        type: 'limit.reached',
        tenantId: 't-fail',
        limit: 'day',
        current: 10,
        max: 10,
      });

      await flushNotifyQueueForTests();

      // Initial attempt (0) + 3 retries (1, 2, 3) = 4 total attempts
      assert.equal(attempts, 4, 'Must retry 3 times then give up (4 total attempts)');

      // Verify notifications.jsonl has error record
      const deliveries = getRecentNotifications(10);
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].ok, false);
      assert.equal(deliveries[0].channel, 'email');
      assert.equal(deliveries[0].to, 'a***@example.com');
      assert.ok(deliveries[0].error?.includes('SMTP connection timed out'));
    });
  });

  describe('ROUTER_NOTIFY=off', () => {
    it('disables all notifications when set to off', async () => {
      process.env.ROUTER_NOTIFY = 'off';
      process.env.ROUTER_ADMIN_EMAIL = 'admin@example.com';

      let called = false;
      setNotifyTransportsForTests({
        email: async () => {
          called = true;
        },
      });

      startNotifier();

      emitRouterEvent({
        type: 'limit.reached',
        tenantId: 't-off',
        limit: 'day',
        current: 10,
        max: 10,
      });

      await flushNotifyQueueForTests();

      assert.equal(called, false, 'No notification should be sent when ROUTER_NOTIFY=off');
      const deliveries = getRecentNotifications(10);
      assert.equal(deliveries.length, 0);
    });
  });

  describe('Templates (RU and EN)', () => {
    it('renders Russian template with limit info, tenant name and no secrets', () => {
      const msg = renderNotificationMessage(
        {
          type: 'limit.reached',
          tenantId: 'client-xyz',
          limit: 'day',
          current: 500,
          max: 500,
          ts: '2026-09-30T10:00:00Z',
        },
        'ru',
        'Acme Corporation'
      );

      assert.ok(msg.subject.startsWith('[AI Router]'), 'Subject must start with [AI Router]');
      assert.ok(msg.subject.includes('client-xyz (Acme Corporation)'));
      assert.ok(msg.text.includes('Клиент: client-xyz (Acme Corporation)'));
      assert.ok(msg.text.includes('Лимит: 500'));
      assert.ok(msg.text.includes('Текущее использование: 500'));
      assert.ok(msg.text.includes('Сброс: в 00:00 UTC'));
      assert.ok(msg.text.includes('поднимите лимит в дашборде'));

      // Check no secrets
      assert.ok(!msg.text.toLowerCase().includes('bearer'));
      assert.ok(!msg.text.toLowerCase().includes('password'));
      assert.ok(!msg.text.toLowerCase().includes('pft_'));
    });

    it('renders English template with limit info, tenant name and no secrets', () => {
      const msg = renderNotificationMessage(
        {
          type: 'limit.reached',
          tenantId: 'client-xyz',
          limit: 'rpm',
          current: 60,
          max: 60,
          agent: 'indexer',
          ts: '2026-09-30T10:00:00Z',
        },
        'en',
        'Acme Corp'
      );

      assert.ok(msg.subject.startsWith('[AI Router]'), 'Subject must start with [AI Router]');
      assert.ok(msg.subject.includes('Limit reached: client-xyz (Acme Corp)'));
      assert.ok(msg.text.includes('Client: client-xyz (Acme Corp)'));
      assert.ok(msg.text.includes('Limit: 60'));
      assert.ok(msg.text.includes('Current usage: 60'));
      assert.ok(msg.text.includes('indexer'));
      assert.ok(msg.text.includes('contact the administrator to increase the limit'));

      // Check no secrets
      assert.ok(!msg.text.toLowerCase().includes('bearer'));
      assert.ok(!msg.text.toLowerCase().includes('password'));
      assert.ok(!msg.text.toLowerCase().includes('pft_'));
    });

    it('renders loop.blocked and budget.exceeded templates', () => {
      const loopMsgRu = renderNotificationMessage(
        {
          type: 'loop.blocked',
          tenantId: 't-loop',
          key: 't-loop|app|agent|session123',
          rule: 'repeat',
          details: '3 consecutive identical msgs',
          until: '2026-09-30T12:00:00Z',
          retryAfterSec: 600,
          ts: '2026-09-30T10:00:00Z',
        },
        'ru'
      );
      assert.ok(loopMsgRu.subject.startsWith('[AI Router]'));
      assert.ok(loopMsgRu.text.includes('Loop Guard'));
      assert.ok(loopMsgRu.text.includes('session123'));
      assert.ok(loopMsgRu.text.includes('600 с'));

      const budgetMsgEn = renderNotificationMessage(
        {
          type: 'budget.exceeded',
          tenantId: 't-budget',
          reason: 'tenant-day',
          ts: '2026-09-30T10:00:00Z',
        },
        'en'
      );
      assert.ok(budgetMsgEn.subject.startsWith('[AI Router]'));
      assert.ok(budgetMsgEn.text.includes('MiniMax budget exceeded'));
      assert.ok(budgetMsgEn.text.includes('tenant-day'));
    });
  });

  describe('Masking in logs', () => {
    it('masks email addresses and telegram IDs correctly', () => {
      assert.equal(maskRecipient('alice@example.com', 'email'), 'a***@example.com');
      assert.equal(maskRecipient('bob.smith@domain.org', 'email'), 'b***@domain.org');
      assert.equal(maskRecipient('123456789', 'telegram'), '***6789');
      assert.equal(maskRecipient('42', 'telegram'), '***42');
    });

    it('writes masked recipient to notifications.jsonl on successful send', async () => {
      process.env.ROUTER_ADMIN_EMAIL = 'admin-team@company.com';
      process.env.ROUTER_ADMIN_TELEGRAM_CHAT_ID = '987654321';

      setNotifyTransportsForTests({
        email: async () => {},
        telegram: async () => {},
      });

      startNotifier();

      emitRouterEvent({
        type: 'limit.reached',
        tenantId: 't-mask',
        limit: 'concurrent',
        current: 5,
        max: 5,
      });

      await flushNotifyQueueForTests();

      const deliveries = getRecentNotifications(10);
      assert.equal(deliveries.length, 2);

      const emailDelivery = deliveries.find((d) => d.channel === 'email');
      const tgDelivery = deliveries.find((d) => d.channel === 'telegram');

      assert.ok(emailDelivery);
      assert.equal(emailDelivery.to, 'a***@company.com');
      assert.equal(emailDelivery.ok, true);

      assert.ok(tgDelivery);
      assert.equal(tgDelivery.to, '***4321');
      assert.equal(tgDelivery.ok, true);

      // Verify file on disk does NOT contain full raw admin email or chat id
      const filePath = path.join(tmpDir, 'notifications.jsonl');
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(!content.includes('admin-team@company.com'));
      assert.ok(!content.includes('987654321'));
    });
  });

  describe('Admin Endpoints (/admin/api/notifications and /admin/api/notify-test)', () => {
    let app: FastifyInstance;
    const masterKey = 'notify-master-key-1234';

    beforeEach(async () => {
      CONFIG.serviceApiKey = masterKey;
      process.env.ROUTER_ADMIN_EMAIL = 'admin@example.com';
      process.env.ROUTER_ADMIN_TELEGRAM_CHAT_ID = '88887777';

      app = buildApp();
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it('requires admin authorization for GET and POST', async () => {
      const getRes = await app.inject({
        method: 'GET',
        url: '/admin/api/notifications',
      });
      assert.equal(getRes.statusCode, 401);

      const postRes = await app.inject({
        method: 'POST',
        url: '/admin/api/notify-test',
      });
      assert.equal(postRes.statusCode, 401);
    });

    it('GET /admin/api/notifications returns transport status and masked contacts', async () => {
      setNotifyTransportsForTests({
        email: async () => {},
      });

      const res = await app.inject({
        method: 'GET',
        url: '/admin/api/notifications',
        headers: { authorization: `Bearer ${masterKey}` },
      });

      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);

      assert.equal(data.transports.email, 'configured');
      assert.deepEqual(data.admin.email, ['a***@example.com']);
      assert.deepEqual(data.admin.telegram, ['***7777']);
      assert.ok(Array.isArray(data.deliveries));
    });

    it('POST /admin/api/notify-test sends test message to admin contacts and logs to jsonl', async () => {
      let emailSent = false;
      let tgSent = false;

      setNotifyTransportsForTests({
        email: async (msg) => {
          emailSent = true;
          assert.ok(msg.subject.includes('Тестовое уведомление'));
        },
        telegram: async (chatId, text) => {
          tgSent = true;
          assert.equal(chatId, '88887777');
          assert.ok(text.includes('Тестовое уведомление'));
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/admin/api/notify-test',
        headers: { authorization: `Bearer ${masterKey}` },
      });

      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.ok, true);
      assert.equal(emailSent, true);
      assert.equal(tgSent, true);

      // Verify delivery logged to jsonl
      const deliveries = getRecentNotifications(10);
      assert.equal(deliveries.length, 2);
      assert.ok(deliveries.every((d) => d.type === 'test' && d.ok === true));
    });
  });

  describe('End-to-End: dayRequests 429 produces exactly one notification', () => {
    let app: FastifyInstance;
    const masterKey = 'master-key-e2e';
    const tenantSecret = 'tenant-secret-e2e';

    beforeEach(async () => {
      CONFIG.serviceApiKey = masterKey;
      CONFIG.tenantTokenSecret = tenantSecret;
      process.env.ROUTER_ADMIN_EMAIL = 'admin@example.com';

      app = buildApp();
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it('tripping dayRequests limit returns 429 and emits exactly one queued notification', async () => {
      const delivered: Array<{ to: string; subject: string; text: string }> = [];
      setNotifyTransportsForTests({
        email: async (msg) => {
          delivered.push(msg);
        },
      });

      startNotifier();

      // Configure tenant with daily limit of 1 request
      upsertTenant({
        id: 't-e2e-daily',
        name: 'Daily Limited Tenant',
        status: 'active',
        limits: {
          rate: { dayRequests: 1 },
        },
        createdAt: '',
        updatedAt: '',
      });

      const token = mintTenantToken('t-e2e-daily', tenantSecret);

      // Request 1: Allowed (passes rate check)
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'text-low',
          messages: [{ role: 'user', content: 'first request' }],
        },
      });
      assert.notEqual(res1.statusCode, 429, 'First request should not be 429');

      // Flush any warning notifications from request 1 and clear delivery accumulator
      await flushNotifyQueueForTests();
      delivered.length = 0;

      // Request 2: Blocked by daily limit (returns 429)
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'text-low',
          messages: [{ role: 'user', content: 'second request' }],
        },
      });

      assert.equal(res2.statusCode, 429, 'Second request must return 429');
      assert.equal(res2.headers['x-router-limit'], 'day');

      // Request 3: Also 429, but should be deduplicated!
      const res3 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'text-low',
          messages: [{ role: 'user', content: 'third request' }],
        },
      });
      assert.equal(res3.statusCode, 429);

      // Drain notification queue
      await flushNotifyQueueForTests();

      // Assert exactly one notification was queued and delivered for the 429
      assert.equal(delivered.length, 1, 'Exactly one notification must be delivered to admin');
      assert.equal(delivered[0].to, 'admin@example.com');
      assert.ok(delivered[0].subject.includes('t-e2e-daily'));
      assert.ok(delivered[0].text.includes('Daily Limited Tenant'));
      assert.ok(delivered[0].text.includes('dayRequests'));
    });
  });
  it('caps messages per hour across all events', async () => {
    process.env.ROUTER_ADMIN_EMAIL = 'admin@example.com';
    process.env.ROUTER_NOTIFY_MAX_PER_HOUR = '3';
    const sent: string[] = [];
    setNotifyTransportsForTests({ email: async (m) => { sent.push(m.subject); } });
    startNotifier();
    for (let i = 0; i < 6; i++) {
      emitRouterEvent({ type: 'limit.reached', tenantId: `cap-${i}`, limit: 'rpm', current: 1, max: 1 });
    }
    await flushNotifyQueueForTests();
    delete process.env.ROUTER_NOTIFY_MAX_PER_HOUR;
    assert.equal(sent.length, 3);
  });
  it('requires STARTTLS whenever implicit TLS is off (port 587)', async () => {
    const { getSmtpOptions } = await import('../src/core/notify.js');
    const saved = { port: process.env.ROUTER_SMTP_PORT, secure: process.env.ROUTER_SMTP_SECURE };
    process.env.ROUTER_SMTP_PORT = '587';
    process.env.ROUTER_SMTP_SECURE = 'false';
    let o = getSmtpOptions();
    assert.equal(o.secure, false);
    assert.equal(o.requireTLS, true);
    process.env.ROUTER_SMTP_PORT = '465';
    delete process.env.ROUTER_SMTP_SECURE;
    o = getSmtpOptions();
    assert.equal(o.secure, true);
    assert.equal(o.requireTLS, false);
    if (saved.port === undefined) delete process.env.ROUTER_SMTP_PORT; else process.env.ROUTER_SMTP_PORT = saved.port;
    if (saved.secure === undefined) delete process.env.ROUTER_SMTP_SECURE; else process.env.ROUTER_SMTP_SECURE = saved.secure;
  });
});
