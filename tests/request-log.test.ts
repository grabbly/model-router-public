import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { CONFIG } from '../src/config.js';
import { mintTenantToken } from '../src/auth/tenant-token.js';
import {
  aggregate,
  cleanOldRequestLogs,
  extractPreview,
  flushRequestLogSync,
  formatKeyHint,
  queryRequests,
  recordRequest,
  resetRequestLogForTest,
  setRequestLogDir,
} from '../src/core/request-log.js';

describe('Persistent Request Log (src/core/request-log.ts)', () => {
  let tempDir: string;
  let app: FastifyInstance;
  let mockBackend: http.Server;
  let backendPort: number;
  const masterKey = 'test-master-key-xyz-12345678';
  const tenantSecret = 'test-tenant-secret-87654321';

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-log-'));
    process.env.ROUTER_STATE_DIR = tempDir;
    setRequestLogDir(tempDir);
    CONFIG.serviceApiKey = masterKey;
    CONFIG.tenantTokenSecret = tenantSecret;

    // Mock upstream backend
    mockBackend = http.createServer((req, res) => {
      if (req.url === '/chat/completions') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}');
          if (parsed.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(
              'data: {"id":"chatcmpl-1","choices":[{"delta":{"role":"assistant","content":"Hi" rule}}]}\n\n'
            );
            res.write(
              'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":8}}\n\n'
            );
            res.end('data: [DONE]\n\n');
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'chatcmpl-1',
                object: 'chat.completion',
                created: 1700000000,
                model: parsed.model || 'raw-model',
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'Test reply' },
                    finish_reason: 'stop',
                  },
                ],
                usage: {
                  prompt_tokens: 15,
                  completion_tokens: 25,
                  total_tokens: 40,
                },
              })
            );
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      mockBackend.listen(0, '127.0.0.1', () => {
        const addr = mockBackend.address() as { port: number };
        backendPort = addr.port;
        resolve();
      });
    });

    CONFIG.cloudBaseUrl = `http://127.0.0.1:${backendPort}`;
    CONFIG.backend2BaseUrl = `http://127.0.0.1:${backendPort}`;
    CONFIG.localOllamaBaseUrl = `http://127.0.0.1:${backendPort}`;

    app = buildApp();
    await app.ready();
  });

  after(async () => {
    await app.close();
    await new Promise<void>((resolve) => mockBackend.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
    setRequestLogDir(undefined);
    resetRequestLogForTest();
  });

  beforeEach(() => {
    resetRequestLogForTest();
    const reqDir = path.join(tempDir, 'requests');
    if (fs.existsSync(reqDir)) {
      fs.rmSync(reqDir, { recursive: true, force: true });
    }
  });

  it('keyHint masking for all key kinds (full key never appears in the stored line)', () => {
    // 1. Tenant token
    const fullTenantToken = mintTenantToken('client-alpha', tenantSecret);
    const tenantHint = formatKeyHint(fullTenantToken, 'tenant-token', 'client-alpha');
    assert.ok(tenantHint.startsWith('pft_client-alpha.'));
    assert.ok(tenantHint.includes('…'));
    assert.ok(!tenantHint.includes(fullTenantToken));
    assert.notEqual(tenantHint, fullTenantToken);

    // 2. Master key
    const fullMaster = 'secret-master-api-key-99999';
    const masterHint = formatKeyHint(fullMaster, 'master');
    assert.equal(masterHint, 'master …9999');
    assert.ok(!masterHint.includes(fullMaster));

    // 3. Master impersonated
    const impHint = formatKeyHint(fullMaster, 'master-impersonated');
    assert.equal(impHint, 'master …9999');

    // 4. Invalid key
    const badKey = 'invalid-secret-key-12345678';
    const badHint = formatKeyHint(badKey, 'invalid');
    assert.ok(badHint.includes('…'));
    assert.ok(!badHint.includes(badKey));

    // 5. Missing / none
    assert.equal(formatKeyHint(null, 'none'), 'none');
    assert.equal(formatKeyHint('', 'none'), 'none');

    // Check stored line in JSONL
    recordRequest({
      ts: new Date().toISOString(),
      tenant: 'client-alpha',
      authType: 'tenant-token',
      keyHint: tenantHint,
      status: 200,
    });
    recordRequest({
      ts: new Date().toISOString(),
      tenant: 'master-service',
      authType: 'master',
      keyHint: masterHint,
      status: 200,
    });
    recordRequest({
      ts: new Date().toISOString(),
      tenant: '(unauthenticated)',
      authType: 'invalid',
      keyHint: badHint,
      status: 401,
    });

    flushRequestLogSync();

    const reqDir = path.join(tempDir, 'requests');
    const files = fs.readdirSync(reqDir);
    assert.ok(files.length > 0);

    const storedContent = fs.readFileSync(path.join(reqDir, files[0]), 'utf8');
    assert.ok(!storedContent.includes(fullTenantToken), 'Full tenant token must not appear in stored file');
    assert.ok(!storedContent.includes(fullMaster), 'Full master key must not appear in stored file');
    assert.ok(!storedContent.includes(badKey), 'Full bad key must not appear in stored file');
  });

  it('preview off by default and truncated when on (base64 excluded)', () => {
    delete process.env.ROUTER_LOG_PREVIEW_CHARS;
    const msg = [
      { role: 'user', content: 'This is confidential text that should not be stored by default' },
    ];
    assert.equal(extractPreview(msg), undefined);

    // Truncated when enabled
    process.env.ROUTER_LOG_PREVIEW_CHARS = '12';
    assert.equal(extractPreview(msg), 'This is conf');

    // Base64 data URI exclusion
    const b64DataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const msgWithImage = [
      { role: 'user', content: `Check this data: ${b64DataUri} please` },
    ];
    const previewImg = extractPreview(msgWithImage);
    assert.ok(previewImg);
    assert.ok(!previewImg.includes('data:image'));
    assert.ok(!previewImg.includes('iVBORw'));
    assert.equal(previewImg, 'Check this d');

    // Multipart with text and image_url
    const multipart = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: b64DataUri } },
          { type: 'text', text: 'Analyze this sample receipt' },
        ],
      },
    ];
    assert.equal(extractPreview(multipart), 'Analyze this');
    delete process.env.ROUTER_LOG_PREVIEW_CHARS;
  });

  it('record written for success, stream, 400, 429 loop, 401', async () => {
    const validToken = mintTenantToken('log-test-tenant', tenantSecret);

    // 1. Success non-streaming (200)
    const res200 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${validToken}`,
        'x-router-app': 'test-app',
        'x-router-agent': 'agent-1',
        'x-router-session': 'sess-100',
      },
      payload: {
        model: 'text-low',
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
      },
    });
    assert.equal(res200.statusCode, 200);

    // 2. Success streaming (200)
    const resStream = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${validToken}`,
        'x-router-app': 'test-app',
        'x-router-agent': 'agent-1',
        'x-router-session': 'sess-100',
      },
      payload: {
        model: 'text-low',
        messages: [{ role: 'user', content: 'stream' }],
        stream: true,
      },
    });
    assert.equal(resStream.statusCode, 200);

    // 3. 400 missing model
    const res400Model = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${validToken}` },
      payload: { messages: [{ role: 'user', content: 'no model' }] },
    });
    assert.equal(res400Model.statusCode, 400);

    // 4. 400 missing messages
    const res400Msgs = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${validToken}` },
      payload: { model: 'text-low', messages: [] },
    });
    assert.equal(res400Msgs.statusCode, 400);

    // 5. 401 unauthorized (missing token)
    const res401Missing = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'text-low', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res401Missing.statusCode, 401);

    // 6. 401 unauthorized (invalid token)
    const res401Bad = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer bad-invalid-token' },
      payload: { model: 'text-low', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res401Bad.statusCode, 401);

    // 7. 429 loop detected (trip repeat rule: 3 identical consecutive messages with complete metadata)
    const loopSession = 'loop-sess-999';
    const loopHeaders = {
      authorization: `Bearer ${validToken}`,
      'x-router-app': 'loop-app',
      'x-router-agent': 'loop-agent',
      'x-router-session': loopSession,
    };
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: loopHeaders,
      payload: { model: 'text-low', messages: [{ role: 'user', content: 'exact-same-text' }] },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: loopHeaders,
      payload: { model: 'text-low', messages: [{ role: 'user', content: 'exact-same-text' }] },
    });
    const res429 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: loopHeaders,
      payload: { model: 'text-low', messages: [{ role: 'user', content: 'exact-same-text' }] },
    });
    assert.equal(res429.statusCode, 429);

    // Flush and verify all records were logged
    flushRequestLogSync();

    const queryAll = queryRequests({}, { limit: 100 });
    const statuses = queryAll.items.map((i) => i.status);
    assert.ok(statuses.includes(200), 'Contains 200 success');
    assert.ok(statuses.includes(400), 'Contains 400 error');
    assert.ok(statuses.includes(401), 'Contains 401 error');
    assert.ok(statuses.includes(429), 'Contains 429 loop block');

    const streamRec = queryAll.items.find((i) => i.stream === true && i.status === 200);
    assert.ok(streamRec, 'Contains stream record');
    assert.ok(streamRec.ttfbMs !== undefined, 'Stream record has ttfbMs');

    const loopRec = queryAll.items.find((i) => i.status === 429);
    assert.ok(loopRec, 'Contains 429 record');
    assert.equal(loopRec.errorCode, 'loop_detected');
    assert.ok(loopRec.loopRule, 'Contains loop rule');

    const unauthRec = queryAll.items.find((i) => i.status === 401 && i.authType === 'none');
    assert.ok(unauthRec, 'Contains unauthenticated record');
    assert.equal(unauthRec.tenant, '(unauthenticated)');
  });

  it('query filters and aggregation buckets', () => {
    // Record sample items directly
    const now = Date.now();
    const t0 = new Date(now - 7200 * 1000).toISOString(); // 2 hours ago
    const t1 = new Date(now - 3600 * 1000).toISOString(); // 1 hour ago
    const t2 = new Date(now).toISOString(); // now

    recordRequest({
      ts: t0,
      tenant: 'tenant-a',
      authType: 'tenant-token',
      app: 'app-x',
      agent: 'agent-1',
      session: 'sess-alpha-001',
      tier: 'text-high',
      backend: 'backend-1',
      status: 200,
      promptTokens: 100,
      completionTokens: 50,
      latencyMs: 500,
    });
    recordRequest({
      ts: t1,
      tenant: 'tenant-a',
      authType: 'tenant-token',
      app: 'app-x',
      agent: 'agent-2',
      session: 'sess-beta-002',
      tier: 'text-low',
      backend: 'backend-2',
      status: 400,
      errorCode: 'missing_model',
      latencyMs: 10,
    });
    recordRequest({
      ts: t2,
      tenant: 'tenant-b',
      authType: 'master',
      app: 'app-y',
      agent: 'agent-1',
      session: 'sess-alpha-003',
      tier: 'text-high',
      backend: 'backend-1',
      status: 500,
      errorCode: 'server_error',
      latencyMs: 1200,
    });

    // Test filter by tenant
    const resTenantA = queryRequests({ tenant: 'tenant-a' });
    assert.equal(resTenantA.items.length, 2);

    // Test filter by session substring
    const resSession = queryRequests({ session: 'alpha' });
    assert.equal(resSession.items.length, 2);

    // Test filter by status class
    const res2xx = queryRequests({ status: '2xx' });
    assert.equal(res2xx.items.length, 1);
    assert.equal(res2xx.items[0].status, 200);

    const res4xx = queryRequests({ status: '4xx' });
    assert.equal(res4xx.items.length, 1);
    assert.equal(res4xx.items[0].status, 400);

    const res5xx = queryRequests({ status: '5xx' });
    assert.equal(res5xx.items.length, 1);
    assert.equal(res5xx.items[0].status, 500);

    // Test pagination (limit & nextBefore)
    const page1 = queryRequests({}, { limit: 2 });
    assert.equal(page1.items.length, 2);
    assert.ok(page1.nextBefore);

    const page2 = queryRequests({}, { limit: 2, before: page1.nextBefore });
    assert.equal(page2.items.length, 1);

    // Test aggregation
    const agg = aggregate({});
    assert.equal(agg.totals.requests, 3);
    assert.equal(agg.totals.errors, 2);
    assert.equal(agg.totals.promptTokens, 100);
    assert.equal(agg.totals.completionTokens, 50);
    assert.ok(agg.totals.avgLatencyMs > 0);
    assert.ok(agg.totals.p95LatencyMs > 0);
    assert.equal(agg.byTenant['tenant-a'].requests, 2);
    assert.equal(agg.byTenant['tenant-b'].requests, 1);
    assert.equal(agg.byTier['text-high'], 2);
    assert.equal(agg.byTier['text-low'], 1);
    assert.equal(agg.byStatus['2xx'], 1);
    assert.equal(agg.byStatus['4xx'], 1);
    assert.equal(agg.byStatus['5xx'], 1);
    assert.equal(agg.byStatus.errorCodes['missing_model'], 1);
  });

  it('retention deletes old files (temp ROUTER_STATE_DIR)', () => {
    const reqDir = path.join(tempDir, 'requests');
    fs.mkdirSync(reqDir, { recursive: true });

    const oldFile = path.join(reqDir, '2026-08-01.jsonl'); // ~55 days ago
    const newFile = path.join(reqDir, '2026-09-25.jsonl');

    fs.writeFileSync(oldFile, '{"ts":"2026-08-01T00:00:00Z","tenant":"old","status":200}\n');
    fs.writeFileSync(newFile, '{"ts":"2026-09-25T00:00:00Z","tenant":"new","status":200}\n');

    assert.ok(fs.existsSync(oldFile));
    assert.ok(fs.existsSync(newFile));

    cleanOldRequestLogs(30, tempDir);

    assert.ok(!fs.existsSync(oldFile), 'Old file should have been deleted');
    assert.ok(fs.existsSync(newFile), 'Recent file should be kept');
  });
});

describe('Request log — no records lost or merged', () => {
  it('two distinct requests in the same millisecond are both counted', async () => {
    const { recordRequest, flushRequestLogSync, queryRequests, aggregate, resetRequestLogForTest, setRequestLogDir } = await import('../src/core/request-log.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-samems-'));
    resetRequestLogForTest();
    setRequestLogDir(dir);
    const ts = new Date().toISOString();
    recordRequest({ ts, tenant: '(unauthenticated)', status: 401, authType: 'none', latencyMs: 0 });
    recordRequest({ ts, tenant: '(unauthenticated)', status: 401, authType: 'none', latencyMs: 0 });
    flushRequestLogSync();
    const items = queryRequests({}, { limit: 10 }).items.filter((r) => r.status === 401);
    const agg = aggregate({}, 'hour');
    setRequestLogDir(undefined);
    assert.equal(items.length, 2);
    assert.ok(items[0].id && items[1].id && items[0].id !== items[1].id);
    assert.equal(agg.totals.requests, 2);
  });

  it('a query during an async flush sees in-flight records exactly once', async () => {
    const { recordRequest, flushRequestLogAsync, queryRequests, resetRequestLogForTest, setRequestLogDir } = await import('../src/core/request-log.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-inflight-'));
    resetRequestLogForTest();
    setRequestLogDir(dir);
    recordRequest({ ts: new Date().toISOString(), tenant: 'inflight', status: 401, authType: 'none' });
    const p = flushRequestLogAsync(); // not awaited: query mid-write
    const seen = queryRequests({}, { limit: 10 }).items.filter((r) => r.tenant === 'inflight').length;
    await p;
    const after = queryRequests({}, { limit: 10 }).items.filter((r) => r.tenant === 'inflight').length;
    setRequestLogDir(undefined);
    assert.equal(seen, 1, 'visible while being written');
    assert.equal(after, 1, 'exactly once after the write');
  });
});
