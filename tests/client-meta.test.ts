import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { CONFIG } from '../src/config.js';
import { mintTenantToken } from '../src/auth/tenant-token.js';
import {
  parseClientMeta,
  setMetadataModeForTests,
  resetClientMetaForTests,
  getClientMetadataStatus,
} from '../src/core/client-meta.js';

describe('Client Metadata Headers (src/core/client-meta.ts)', () => {
  describe('Unit tests for parseClientMeta', () => {
    it('sanitizes headers: trims, retains allowed chars, truncates to 128', () => {
      const longVal = 'a'.repeat(150);
      const meta = parseClientMeta({
        'x-router-app': '  my-portal!#$  ',
        'x-router-agent': 'pf-work_1.0:beta@test/job',
        'x-router-session': longVal,
      });

      assert.equal(meta.app, 'my-portal');
      assert.equal(meta.agent, 'pf-work_1.0:beta@test/job');
      assert.equal(meta.session?.length, 128);
      assert.equal(meta.complete, true);
    });

    it('returns complete = false when any header is missing or empty', () => {
      const meta1 = parseClientMeta({
        'x-router-app': 'app1',
        'x-router-agent': 'agent1',
      });
      assert.equal(meta1.complete, false);
      assert.equal(meta1.session, undefined);

      const meta2 = parseClientMeta({
        'x-router-app': '   ',
        'x-router-agent': 'agent1',
        'x-router-session': 'sess1',
      });
      assert.equal(meta2.complete, false);
      assert.equal(meta2.app, undefined);

      const meta3 = parseClientMeta({});
      assert.equal(meta3.complete, false);
      assert.equal(meta3.app, undefined);
      assert.equal(meta3.agent, undefined);
      assert.equal(meta3.session, undefined);
    });
  });

  describe('Fastify Route Integration (soft, enforce, off modes)', () => {
    let app: FastifyInstance;
    let mockBackend: http.Server;
    let backendPort: number;
    const masterKey = 'test-meta-key-1234';
    const tenantToken = mintTenantToken('test-meta-tenant', masterKey);

    before(async () => {
      CONFIG.serviceApiKey = masterKey;
      CONFIG.tenantTokenSecret = masterKey;

      mockBackend = http.createServer((req, res) => {
        if (req.url === '/chat/completions') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion',
              created: 1700000000,
              model: 'raw-model',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'hello' },
                  finish_reason: 'stop',
                },
              ],
            })
          );
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

      CONFIG.backend2BaseUrl = `http://127.0.0.1:${backendPort}`;
      CONFIG.cloudBaseUrl = `http://127.0.0.1:${backendPort}`;
      CONFIG.localOllamaBaseUrl = `http://127.0.0.1:${backendPort}`;

      app = buildApp();
      await app.ready();
    });

    after(async () => {
      await app.close();
      await new Promise<void>((resolve) => mockBackend.close(() => resolve()));
    });

    beforeEach(() => {
      resetClientMetaForTests();
      setMetadataModeForTests(null);
    });

    it('soft mode (default): missing metadata allows request, sets warning header, logs warning once', async () => {
      setMetadataModeForTests('soft');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${tenantToken}`,
        },
        payload: {
          model: 'text-low',
          messages: [{ role: 'user', content: 'test soft mode' }],
        },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['x-router-warning'], 'missing-metadata');

      // Check admin status counters
      const status = getClientMetadataStatus();
      assert.equal(status.mode, 'soft');
      assert.equal(status.tenants['test-meta-tenant'].withoutMeta, 1);
      assert.ok(status.tenants['test-meta-tenant'].lastSeenMissing);
    });

    it('soft mode: complete metadata proceeds without warning header', async () => {
      setMetadataModeForTests('soft');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${tenantToken}`,
          'x-router-app': 'my-portal',
          'x-router-agent': 'pf-work-1',
          'x-router-session': 'sess-100',
        },
        payload: {
          model: 'text-low',
          messages: [{ role: 'user', content: 'test complete' }],
        },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['x-router-warning'], undefined);

      const status = getClientMetadataStatus();
      assert.equal(status.tenants['test-meta-tenant'].withMeta, 1);
    });

    it('enforce mode: missing metadata returns 400 missing_metadata', async () => {
      setMetadataModeForTests('enforce');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${tenantToken}`,
          'x-router-app': 'my-portal',
          // missing agent and session
        },
        payload: {
          model: 'text-low',
          messages: [{ role: 'user', content: 'test enforce fail' }],
        },
      });

      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.equal(body.error.code, 'missing_metadata');
      assert.equal(body.error.type, 'invalid_request_error');
      assert.ok(body.error.message.includes('Missing required metadata headers'));
    });

    it('enforce mode: complete metadata returns 200 OK', async () => {
      setMetadataModeForTests('enforce');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${tenantToken}`,
          'x-router-app': 'my-portal',
          'x-router-agent': 'pf-agent-1',
          'x-router-session': 'sess-enforce-ok',
        },
        payload: {
          model: 'text-low',
          messages: [{ role: 'user', content: 'test enforce ok' }],
        },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['x-router-warning'], undefined);
    });

    it('off mode: missing metadata proceeds with no warning header', async () => {
      setMetadataModeForTests('off');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${tenantToken}`,
        },
        payload: {
          model: 'text-low',
          messages: [{ role: 'user', content: 'test off' }],
        },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['x-router-warning'], undefined);
    });
  });
});
