import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { LogicalModelConfig, ChatMessage } from '../src/types.js';
import { applyUncensoredOverlay } from '../src/core/overlay.js';
import { buildApp } from '../src/index.js';
import { CONFIG } from '../src/config.js';
import { mintTenantToken } from '../src/auth/tenant-token.js';
import { upsertTenant, resetTenantsForTests } from '../src/core/tenants.js';
import {
  queryRequests,
  flushRequestLogSync,
  resetRequestLogForTest,
  setRequestLogDir,
} from '../src/core/request-log.js';

function cfg(over: Partial<LogicalModelConfig>): LogicalModelConfig {
  return {
    id: 'text-uncensored-high',
    description: '',
    modality: 'text',
    tier: 'high',
    censored: false,
    timeoutMs: 1000,
    cooldownSec: 1,
    pool: [],
    ...over,
  } as LogicalModelConfig;
}

const user: ChatMessage = { role: 'user', content: 'hi' };

describe('Uncensored overlay injection', () => {
  afterEach(() => {
    delete process.env.ROUTER_AUTO_OVERLAY;
    delete process.env.ROUTER_UNCENSORED_TEXT_OVERLAY;
    delete process.env.ROUTER_UNCENSORED_VISION_OVERLAY;
  });

  it('inserts a system overlay when the uncensored tier has none', () => {
    const out = applyUncensoredOverlay(cfg({}), [user]);
    assert.equal(out.length, 2);
    assert.equal(out[0].role, 'system');
    assert.match(out[0].content as string, /uncensored adult-fiction/i);
    assert.equal(out[1], user);
  });

  it('uses the vision overlay for a vision tier', () => {
    const out = applyUncensoredOverlay(cfg({ modality: 'vision' }), [user]);
    assert.match(out[0].content as string, /vision assistant/i);
  });

  it('merges into an existing system message, keeping caller persona', () => {
    const sys: ChatMessage = { role: 'system', content: 'You are Aria.' };
    const out = applyUncensoredOverlay(cfg({}), [sys, user]);
    assert.equal(out.length, 2);
    assert.match(out[0].content as string, /uncensored adult-fiction/i);
    assert.match(out[0].content as string, /You are Aria\./);
  });

  it('leaves censored tiers untouched', () => {
    const out = applyUncensoredOverlay(cfg({ censored: true }), [user]);
    assert.deepEqual(out, [user]);
  });

  it('respects ROUTER_AUTO_OVERLAY=0', () => {
    process.env.ROUTER_AUTO_OVERLAY = '0';
    const out = applyUncensoredOverlay(cfg({}), [user]);
    assert.deepEqual(out, [user]);
  });

  it('does not double-inject', () => {
    const once = applyUncensoredOverlay(cfg({}), [user]);
    const twice = applyUncensoredOverlay(cfg({}), once);
    assert.equal(twice.length, once.length);
  });

  it('honours a custom overlay from env', () => {
    process.env.ROUTER_UNCENSORED_TEXT_OVERLAY = 'CUSTOM-OVERLAY-X';
    const out = applyUncensoredOverlay(cfg({}), [user]);
    assert.equal(out[0].content, 'CUSTOM-OVERLAY-X');
  });
});

describe('Tenant overlay route handling (/v1/chat/completions)', () => {
  let app: FastifyInstance;
  let mockBackend: http.Server;
  let backendPort: number;
  let tmpDir: string;
  const masterKey = 'test-overlay-master-1234';
  const tenantSecret = 'test-overlay-tenant-secret';
  let receivedRequests: Array<{ url?: string; headers: http.IncomingHttpHeaders; body: any }> = [];

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-overlay-test-'));
    process.env.ROUTER_STATE_DIR = tmpDir;
    setRequestLogDir(tmpDir);
    resetRequestLogForTest();
    resetTenantsForTests();

    CONFIG.serviceApiKey = masterKey;
    CONFIG.tenantTokenSecret = tenantSecret;
    process.env.MINIMAX_API_KEY = 'test-minimax-key';

    mockBackend = http.createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
      });
      req.on('end', () => {
        try {
          const body = JSON.parse(data);
          receivedRequests.push({ url: req.url, headers: req.headers, body });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion',
              created: 1700000000,
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'test response' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            })
          );
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
    });

    await new Promise<void>((resolve) => {
      mockBackend.listen(0, '127.0.0.1', () => {
        const addr = mockBackend.address() as { port: number };
        backendPort = addr.port;
        resolve();
      });
    });

    CONFIG.minimaxBaseUrl = `http://127.0.0.1:${backendPort}`;
    CONFIG.cloudBaseUrl = `http://127.0.0.1:${backendPort}`;

    upsertTenant({
      id: 'tenant-default',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    upsertTenant({
      id: 'tenant-overlay-off',
      status: 'active',
      overlay: 'off',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    upsertTenant({
      id: 'tenant-overlay-auto',
      status: 'active',
      overlay: 'auto',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    app = buildApp();
    await app.ready();
  });

  after(async () => {
    await app.close();
    await new Promise<void>((resolve) => mockBackend.close(() => resolve()));
    resetTenantsForTests();
    resetRequestLogForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.MINIMAX_API_KEY;
  });

  beforeEach(() => {
    receivedRequests = [];
    resetRequestLogForTest();
  });

  let callIndex = 0;
  async function callChat(tenantId: string, headers: Record<string, string> = {}) {
    callIndex++;
    const session = `test-session-${callIndex}-${Date.now()}`;
    const token = mintTenantToken(tenantId, tenantSecret);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${token}`,
        'x-router-app': 'test-app',
        'x-router-agent': 'test-agent',
        'x-router-session': session,
        ...headers,
      },
      payload: {
        model: 'text-uncensored-high',
        messages: [{ role: 'user', content: `hello ${session}` }],
      },
    });
    return { res, session };
  }

  it('applies overlay for tenant without overlay field (default / auto)', async () => {
    const { res, session } = await callChat('tenant-default');
    assert.equal(res.statusCode, 200);
    assert.equal(receivedRequests.length, 1);
    const msgs = receivedRequests[0].body.messages;
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'system');
    assert.match(msgs[0].content, /uncensored adult-fiction/i);

    flushRequestLogSync();
    const logs = queryRequests({ session });
    assert.equal(logs.items.length, 1);
    assert.equal(logs.items[0].overlay, true);
  });

  it("skips overlay for tenant with overlay: 'off'", async () => {
    const { res, session } = await callChat('tenant-overlay-off');
    assert.equal(res.statusCode, 200);
    assert.equal(receivedRequests.length, 1);
    const msgs = receivedRequests[0].body.messages;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'user');

    flushRequestLogSync();
    const logs = queryRequests({ session });
    assert.equal(logs.items.length, 1);
    assert.equal(logs.items[0].overlay, undefined);
  });

  it("forces overlay ON for tenant with overlay: 'off' when x-router-overlay: 1 is sent", async () => {
    const { res, session } = await callChat('tenant-overlay-off', { 'x-router-overlay': '1' });
    assert.equal(res.statusCode, 200);
    assert.equal(receivedRequests.length, 1);
    const msgs = receivedRequests[0].body.messages;
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'system');
    assert.match(msgs[0].content, /uncensored adult-fiction/i);

    flushRequestLogSync();
    const logs = queryRequests({ session });
    assert.equal(logs.items.length, 1);
    assert.equal(logs.items[0].overlay, true);
  });

  it("forces overlay ON for tenant with overlay: 'off' when x-router-overlay: true is sent", async () => {
    const { res, session } = await callChat('tenant-overlay-off', { 'x-router-overlay': 'true' });
    assert.equal(res.statusCode, 200);
    assert.equal(receivedRequests.length, 1);
    const msgs = receivedRequests[0].body.messages;
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'system');

    flushRequestLogSync();
    const logs = queryRequests({ session });
    assert.equal(logs.items.length, 1);
    assert.equal(logs.items[0].overlay, true);
  });

  it('skips overlay when both x-router-no-overlay and x-router-overlay are sent (no-overlay wins)', async () => {
    const { res, session } = await callChat('tenant-overlay-off', {
      'x-router-overlay': '1',
      'x-router-no-overlay': '1',
    });
    assert.equal(res.statusCode, 200);
    assert.equal(receivedRequests.length, 1);
    const msgs = receivedRequests[0].body.messages;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'user');

    flushRequestLogSync();
    const logs = queryRequests({ session });
    assert.equal(logs.items.length, 1);
    assert.equal(logs.items[0].overlay, undefined);
  });

  it('skips overlay when x-router-no-overlay: 1 is sent for tenant without overlay field', async () => {
    const { res, session } = await callChat('tenant-default', { 'x-router-no-overlay': '1' });
    assert.equal(res.statusCode, 200);
    assert.equal(receivedRequests.length, 1);
    const msgs = receivedRequests[0].body.messages;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'user');

    flushRequestLogSync();
    const logs = queryRequests({ session });
    assert.equal(logs.items.length, 1);
    assert.equal(logs.items[0].overlay, undefined);
  });

  it("applies overlay for tenant with overlay: 'auto'", async () => {
    const { res, session } = await callChat('tenant-overlay-auto');
    assert.equal(res.statusCode, 200);
    assert.equal(receivedRequests.length, 1);
    const msgs = receivedRequests[0].body.messages;
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'system');

    flushRequestLogSync();
    const logs = queryRequests({ session });
    assert.equal(logs.items.length, 1);
    assert.equal(logs.items[0].overlay, true);
  });
});
