import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkLoop,
  effectiveLoopLimits,
  estimateInputTokens,
  getLoopGuardStatus,
  hashLastMessage,
  resetLoopGuard,
  setLoopGuardClock,
  setLoopGuardModeForTests,
} from '../src/core/loop-guard.js';
import { buildApp } from '../src/index.js';
import { mintTenantToken } from '../src/auth/tenant-token.js';
import { CONFIG } from '../src/config.js';
import { upsertTenant, resetTenantsForTests } from '../src/core/tenants.js';

describe('Loop Guard (src/core/loop-guard.ts)', () => {
  beforeEach(() => {
    resetLoopGuard();
  });

  describe('estimateInputTokens and image base64 normalization', () => {
    it('normalizes base64 data URIs to 1000 chars so vision requests are not over-counted', () => {
      const largeBase64 = 'A'.repeat(200_000);
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${largeBase64}` } },
          ],
        },
      ];

      const tokens = estimateInputTokens(messages);
      // Normalized length should be around 1100-1200 chars -> ~275-300 tokens
      // Without normalization, 200k chars would be > 50,000 tokens
      assert.ok(tokens < 500, `Expected tokens < 500, got ${tokens}`);
      assert.ok(tokens > 200, `Expected tokens > 200, got ${tokens}`);
    });
  });

  describe('Rate rule (threshold + 1)', () => {
    it('allows 40 requests and trips on the 41st within 5 minutes', () => {
      const key = 'tenant1|app1|agent1|session1';
      let now = 1_000_000;

      // 40 requests pass
      for (let i = 1; i <= 40; i++) {
        const res = checkLoop(
          key,
          [{ role: 'user', content: `unique message ${i}` }],
          { now }
        );
        assert.equal(res.blocked, false, `Request ${i} should not be blocked`);
        now += 1000; // 1 second apart
      }

      // 41st request trips rate limit
      const res41 = checkLoop(
        key,
        [{ role: 'user', content: 'unique message 41' }],
        { now }
      );
      assert.equal(res41.blocked, true);
      if (res41.blocked) {
        assert.equal(res41.rule, 'rate');
        assert.ok(res41.details.includes('41 requests'));
        assert.equal(res41.retryAfterSec, 260);
        assert.ok(res41.until);
      }

      // Rate does not set a session block
      const status = getLoopGuardStatus();
      assert.equal(status.blocked[key], undefined, 'Rate must not set session block');

      // Request after waiting retryAfterSec is admitted (rejected req timestamp was removed)
      const res42 = checkLoop(
        key,
        [{ role: 'user', content: 'unique message 42' }],
        { now: now + 260_000 }
      );
      assert.equal(res42.blocked, false, 'Request after waiting Retry-After should succeed');
    });
  });

  describe('Volume rule (over 3,000,000 estimated input tokens)', () => {
    it('trips when window tokens exceed 3,000,000', () => {
      const key = 'tenant2|app2|agent2|session2';
      const now = 2_000_000;

      // 12,000,004 characters -> ~3,000,001 tokens
      const hugeText = 'x'.repeat(12_000_004);
      const res = checkLoop(
        key,
        [{ role: 'user', content: hugeText }],
        { now }
      );

      assert.equal(res.blocked, true);
      if (res.blocked) {
        assert.equal(res.rule, 'volume');
        assert.ok(res.details.includes('limit 3000000'));
      }
    });
  });

  describe('Repeat rule (3 identical consecutive last messages)', () => {
    it('trips on the 3rd consecutive identical last message within 5 minutes', () => {
      const key = 'tenant3|app3|agent3|session3';
      const now = 3_000_000;
      const repeatedMessages = [{ role: 'user', content: 'identical query' }];

      const res1 = checkLoop(key, repeatedMessages, { now: now + 1000 });
      assert.equal(res1.blocked, false);

      const res2 = checkLoop(key, repeatedMessages, { now: now + 2000 });
      assert.equal(res2.blocked, false);

      // 3rd consecutive identical message trips repeat rule
      const res3 = checkLoop(key, repeatedMessages, { now: now + 3000 });
      assert.equal(res3.blocked, true);
      if (res3.blocked) {
        assert.equal(res3.rule, 'repeat');
        assert.ok(res3.details.includes('3 consecutive identical messages'));
      }
    });

    it('resets streak if an intermediate request has a different message', () => {
      const key = 'tenant3|app3|agent3|session3-diff';
      const now = 3_500_000;

      assert.equal(checkLoop(key, [{ role: 'user', content: 'msg A' }], { now: now + 1000 }).blocked, false);
      assert.equal(checkLoop(key, [{ role: 'user', content: 'msg A' }], { now: now + 2000 }).blocked, false);
      // Different message resets streak
      assert.equal(checkLoop(key, [{ role: 'user', content: 'msg B' }], { now: now + 3000 }).blocked, false);
      // msg A is only 1 in streak now
      assert.equal(checkLoop(key, [{ role: 'user', content: 'msg A' }], { now: now + 4000 }).blocked, false);
    });
  });

  describe('Block duration and auto-clearing', () => {
    it('keeps session blocked for the block period (600s) and clears afterwards', () => {
      const key = 'tenant4|app4|agent4|session4';
      const blockStart = 4_000_000;

      // Trip repeat rule
      checkLoop(key, [{ role: 'user', content: 'loop' }], { now: blockStart });
      checkLoop(key, [{ role: 'user', content: 'loop' }], { now: blockStart + 1000 });
      const tripRes = checkLoop(key, [{ role: 'user', content: 'loop' }], { now: blockStart + 2000 });
      assert.equal(tripRes.blocked, true);

      // Still blocked after 300 seconds
      const midRes = checkLoop(key, [{ role: 'user', content: 'another' }], { now: blockStart + 300_000 });
      assert.equal(midRes.blocked, true);

      // Clears after 600s + 3s (603s)
      const afterRes = checkLoop(key, [{ role: 'user', content: 'another' }], { now: blockStart + 603_000 });
      assert.equal(afterRes.blocked, false);
    });
  });

  describe('Dry-run behavior and incomplete metadata', () => {
    it('dry-run never blocks even when rules are tripped', () => {
      setLoopGuardModeForTests('dry-run');
      const key = 'tenant5|app5|agent5|session5';
      const now = 5_000_000;

      for (let i = 1; i <= 45; i++) {
        const res = checkLoop(
          key,
          [{ role: 'user', content: `msg ${i}` }],
          { now: now + i * 1000 }
        );
        assert.equal(res.blocked, false, `Dry run should never block (req ${i})`);
      }

      const status = getLoopGuardStatus();
      assert.equal(status.mode, 'dry-run');
      assert.ok(status.events.some((e) => e.type === 'dry-run' && e.rule === 'rate'));
      assert.equal(Object.keys(status.blocked).length, 0);
    });

    it('incomplete metadata runs in dry-run mode even when mode is enforce', () => {
      setLoopGuardModeForTests('enforce');
      // Incomplete metadata key has '?'
      const incompleteKey = 'tenant6|?|?|?';
      const now = 6_000_000;

      // Pass dryRun: true (as chat.ts does for incomplete metadata)
      for (let i = 1; i <= 42; i++) {
        const res = checkLoop(
          incompleteKey,
          [{ role: 'user', content: `msg ${i}` }],
          { dryRun: true, now: now + i * 1000 }
        );
        assert.equal(res.blocked, false);
      }

      const status = getLoopGuardStatus();
      assert.equal(status.mode, 'enforce');
      assert.ok(status.events.some((e) => e.type === 'dry-run' && e.key === incompleteKey));
      assert.equal(status.blocked[incompleteKey], undefined);
    });
  });
  it('repeat: a retry with a different max_tokens salt is not an identical request', () => {
    const key = 'salt-tenant|app|agent|sess';
    const msgs = [{ role: 'user', content: 'write the file' }];
    const now = Date.now();
    for (const [i, mt] of [4096, 8192, 16384, 32768].entries()) {
      const r = checkLoop(key, msgs, { now: now + i * 1000, repeatSalt: `max_tokens=${mt}` });
      assert.equal(r.blocked, false, `step ${mt}`);
    }
    // same salt three times still trips repeat
    checkLoop(key, msgs, { now: now + 5000, repeatSalt: 'max_tokens=32768' });
    const r3 = checkLoop(key, msgs, { now: now + 6000, repeatSalt: 'max_tokens=32768' });
    assert.equal(r3.blocked, true);
    assert.equal(r3.rule, 'repeat');
  });

  describe('Worker agent default rate limits and thresholds', () => {
    it('defaults to 120 for worker agent vs 40 for other agents or unspecified', () => {
      assert.equal(effectiveLoopLimits(undefined, 'worker').maxReq, 120);
      assert.equal(effectiveLoopLimits(undefined, 'other').maxReq, 40);
      assert.equal(effectiveLoopLimits(undefined, undefined).maxReq, 40);
    });

    it('honors ROUTER_LOOP_MAX_REQ_WORKER env override', () => {
      const orig = process.env.ROUTER_LOOP_MAX_REQ_WORKER;
      try {
        process.env.ROUTER_LOOP_MAX_REQ_WORKER = '250';
        assert.equal(effectiveLoopLimits(undefined, 'worker').maxReq, 250);
      } finally {
        if (orig !== undefined) process.env.ROUTER_LOOP_MAX_REQ_WORKER = orig;
        else delete process.env.ROUTER_LOOP_MAX_REQ_WORKER;
      }
    });

    it('registry override still wins over worker default', () => {
      assert.equal(effectiveLoopLimits({ maxReq: 15 }, 'worker').maxReq, 15);
      assert.equal(effectiveLoopLimits({ maxReq: 0 }, 'worker').maxReq, 0);
    });

    it('checkLoop with agent: worker allows 120 requests and trips on 121st', () => {
      const key = 'tenant-worker|app|worker|sess1';
      let now = 10_000_000;
      for (let i = 1; i <= 120; i++) {
        const res = checkLoop(key, [{ role: 'user', content: `worker req ${i}` }], {
          now,
          agent: 'worker',
        });
        assert.equal(res.blocked, false, `Worker request ${i} should be allowed`);
        now += 1000;
      }
      const res121 = checkLoop(key, [{ role: 'user', content: 'worker req 121' }], {
        now,
        agent: 'worker',
      });
      assert.equal(res121.blocked, true);
      assert.equal(res121.rule, 'rate');
    });

    it('getLoopGuardStatus().thresholds includes maxRequestsWorker', () => {
      const status = getLoopGuardStatus();
      assert.equal(typeof status.thresholds.maxRequestsWorker, 'number');
      assert.equal(status.thresholds.maxRequestsWorker, 120);
    });
  });

  describe('tool_call_id and name in hashLastMessage and repeat rule', () => {
    it('different tool_call_id with identical result text produces different hashes and resets repeat', () => {
      const msgsA = [{ role: 'tool', tool_call_id: 'call_1', content: '[]' }];
      const msgsB = [{ role: 'tool', tool_call_id: 'call_2', content: '[]' }];

      const hashA = hashLastMessage(msgsA);
      const hashB = hashLastMessage(msgsB);
      assert.notEqual(hashA, hashB, 'Different tool_call_ids must yield different hashes');

      const key = 'tenant-tool|app|agent|sess';
      let now = 20_000_000;
      // 3 alternating tool calls with same content "[]" but different ids do not trip repeat
      assert.equal(checkLoop(key, msgsA, { now: now + 1000 }).blocked, false);
      assert.equal(checkLoop(key, msgsB, { now: now + 2000 }).blocked, false);
      assert.equal(checkLoop(key, msgsA, { now: now + 3000 }).blocked, false);
    });

    it('identical tool_call_id with identical result text trips repeat rule', () => {
      const msgs = [{ role: 'tool', tool_call_id: 'same_call_id', content: '[]' }];
      const key = 'tenant-tool-repeat|app|agent|sess';
      let now = 21_000_000;

      assert.equal(checkLoop(key, msgs, { now: now + 1000 }).blocked, false);
      assert.equal(checkLoop(key, msgs, { now: now + 2000 }).blocked, false);
      const r3 = checkLoop(key, msgs, { now: now + 3000 });
      assert.equal(r3.blocked, true);
      assert.equal(r3.rule, 'repeat');
    });

    it('name is included in tool hash if present', () => {
      const msgsNamed = [{ role: 'tool', tool_call_id: 'call_1', name: 'search', content: '[]' }];
      const msgsUnnamed = [{ role: 'tool', tool_call_id: 'call_1', content: '[]' }];
      assert.notEqual(
        hashLastMessage(msgsNamed),
        hashLastMessage(msgsUnnamed),
        'Name must affect the hash when present'
      );
    });
  });

  describe('chat route returns 429 rate_limited for rate', () => {
    it('returns 429 rate_limited with proper message and headers', async () => {
      resetTenantsForTests();
      resetLoopGuard();
      const testSecret = 'test-chat-loop-secret-key-12345';
      CONFIG.serviceApiKey = testSecret;
      CONFIG.tenantTokenSecret = testSecret;

      upsertTenant({
        id: 'tenant-rate-chat',
        status: 'active',
        limits: {
          loop: { maxReq: 2, reqWindowSec: 60 },
        },
        createdAt: '',
        updatedAt: '',
      });

      const token = mintTenantToken('tenant-rate-chat', testSecret);
      const app = buildApp();
      await app.ready();

      const headers = {
        authorization: `Bearer ${token}`,
        'x-router-app': 'test-app',
        'x-router-agent': 'test-agent',
        'x-router-session': 'session-rate-chat',
      };

      // In loop guard, we mock the clock or do 2 requests
      // 1st request trips loop check? No, maxReq=2 so request 1 & 2 pass loop check
      // Request 1
      checkLoop('tenant-rate-chat|test-app|test-agent|session-rate-chat', [{ role: 'user', content: 'm1' }], {
        limits: { maxReq: 2, reqWindowSec: 60 },
      });
      // Request 2
      checkLoop('tenant-rate-chat|test-app|test-agent|session-rate-chat', [{ role: 'user', content: 'm2' }], {
        limits: { maxReq: 2, reqWindowSec: 60 },
      });

      // Request 3 hits the chat endpoint and trips rate limit in chat.ts
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers,
        payload: {
          model: 'text-low',
          messages: [{ role: 'user', content: 'm3' }],
        },
      });

      assert.equal(res.statusCode, 429);
      assert.equal(res.headers['x-router-loop'], 'rate');
      assert.ok(res.headers['retry-after'], 'retry-after header must be set');

      const body = JSON.parse(res.body);
      assert.equal(body.error.code, 'rate_limited');
      assert.equal(body.error.type, 'rate_limit_error');
      assert.match(body.error.message, /^Session request rate exceeded/);
      assert.match(body.error.message, /Retry after \d+s\./);
      assert.doesNotMatch(body.error.message, /Do not retry/);

      await app.close();
    });
  });
});
