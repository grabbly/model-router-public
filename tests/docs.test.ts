import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';

describe('Public client guide /docs', () => {
  let app: FastifyInstance;
  before(async () => { app = buildApp(); await app.ready(); });
  after(async () => { await app.close(); });

  it('is served without auth as HTML and documents the metadata headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /text\/html/);
    for (const h of ['x-router-app', 'x-router-agent', 'x-router-session', 'text-summarize', 'loop_detected']) {
      assert.ok(res.body.includes(h), h);
    }
    assert.ok(!/pft_[A-Za-z0-9-]+\.[A-Za-z0-9_-]{20,}/.test(res.body), 'no real tenant token in the page');
  });
});
