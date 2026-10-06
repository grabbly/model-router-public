import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkLoop,
  resetLoopGuard,
  unblockLoopSessions,
  getLoopGuardStatus,
  setLoopGuardClock,
} from '../src/core/loop-guard.js';
import {
  onRouterEvent,
  getRecentRouterEvents,
  resetRouterEventsForTests,
} from '../src/core/events.js';
import {
  upsertTenant,
  resetTenantsForTests,
  resolveLoopLimits,
} from '../src/core/tenants.js';

describe('Per-Tenant Loop Guard (tests/tenant-loop.test.ts)', () => {
  beforeEach(() => {
    resetLoopGuard();
    setLoopGuardClock(null);
    resetRouterEventsForTests();
    resetTenantsForTests();
  });

  describe('Custom per-tenant thresholds via checkLoop limits option', () => {
    it('applies custom maxReq limit and trips earlier than default', () => {
      const key = 'tenant-custom|app1|agent1|session1';
      let now = 1_000_000;
      const customLimits = { maxReq: 3, reqWindowSec: 60 };

      // 3 requests pass
      for (let i = 1; i <= 3; i++) {
        const res = checkLoop(
          key,
          [{ role: 'user', content: `msg ${i}` }],
          { now, limits: customLimits }
        );
        assert.equal(res.blocked, false, `Request ${i} should be allowed`);
        now += 1000;
      }

      // 4th request trips maxReq=3
      const res4 = checkLoop(
        key,
        [{ role: 'user', content: 'msg 4' }],
        { now, limits: customLimits }
      );
      assert.equal(res4.blocked, true);
      assert.equal(res4.rule, 'rate');
    });

    it('applies custom maxRepeat limit (e.g. 2 instead of 3)', () => {
      const key = 'tenant-repeat|app1|agent1|session1';
      const now = 2_000_000;
      const customLimits = { maxRepeat: 2 };
      const repeated = [{ role: 'user', content: 'same text' }];

      // 1st request passes
      assert.equal(checkLoop(key, repeated, { now: now + 1000, limits: customLimits }).blocked, false);

      // 2nd identical request trips because maxRepeat is 2
      const res2 = checkLoop(key, repeated, { now: now + 2000, limits: customLimits });
      assert.equal(res2.blocked, true);
      assert.equal(res2.rule, 'repeat');
    });

    it('mode: "off" per tenant disables blocking completely', () => {
      const key = 'tenant-off|app1|agent1|session1';
      let now = 3_000_000;
      const customLimits = { mode: 'off' as const, maxReq: 2 };

      for (let i = 1; i <= 10; i++) {
        const res = checkLoop(
          key,
          [{ role: 'user', content: `msg ${i}` }],
          { now, limits: customLimits }
        );
        assert.equal(res.blocked, false, `Request ${i} should not be blocked in mode off`);
        now += 1000;
      }
    });

    it('mode: "dry-run" per tenant warns without blocking', () => {
      const key = 'tenant-dry|app1|agent1|session1';
      let now = 4_000_000;
      const customLimits = { mode: 'dry-run' as const, maxReq: 2 };

      checkLoop(key, [{ role: 'user', content: 'msg 1' }], { now: now + 1000, limits: customLimits });
      checkLoop(key, [{ role: 'user', content: 'msg 2' }], { now: now + 2000, limits: customLimits });

      // 3rd exceeds maxReq=2 but mode is dry-run -> blocked is false
      const res3 = checkLoop(key, [{ role: 'user', content: 'msg 3' }], { now: now + 3000, limits: customLimits });
      assert.equal(res3.blocked, false);
    });
  });

  describe('unblockLoopSessions', () => {
    it('clears active blocks matching tenant prefix and allows immediate reuse', () => {
      const tenantA1 = 'tenant-a|app|agent|session1';
      const tenantA2 = 'tenant-a|app|agent|session2';
      const tenantB1 = 'tenant-b|app|agent|session1';
      let now = 5_000_000;
      setLoopGuardClock(() => now);
      const customLimits = { maxRepeat: 2, blockSec: 600 };
      const repeated = [{ role: 'user', content: 'trip me' }];

      // Trip blocks for tenant-a (2 sessions) and tenant-b (1 session)
      checkLoop(tenantA1, repeated, { now, limits: customLimits });
      checkLoop(tenantA1, repeated, { now: now + 1000, limits: customLimits }); // blocked

      checkLoop(tenantA2, repeated, { now, limits: customLimits });
      checkLoop(tenantA2, repeated, { now: now + 1000, limits: customLimits }); // blocked

      checkLoop(tenantB1, repeated, { now, limits: customLimits });
      checkLoop(tenantB1, repeated, { now: now + 1000, limits: customLimits }); // blocked

      // Verify they are blocked
      assert.equal(checkLoop(tenantA1, [{ role: 'user', content: 'next' }], { now: now + 2000 }).blocked, true);
      assert.equal(checkLoop(tenantA2, [{ role: 'user', content: 'next' }], { now: now + 2000 }).blocked, true);
      assert.equal(checkLoop(tenantB1, [{ role: 'user', content: 'next' }], { now: now + 2000 }).blocked, true);

      // Unblock only tenant-a
      const cleared = unblockLoopSessions('tenant-a|');
      assert.equal(cleared, 2);

      // tenant-a sessions are now unblocked!
      assert.equal(checkLoop(tenantA1, [{ role: 'user', content: 'next' }], { now: now + 3000 }).blocked, false);
      assert.equal(checkLoop(tenantA2, [{ role: 'user', content: 'next' }], { now: now + 3000 }).blocked, false);

      // tenant-b session remains blocked
      assert.equal(checkLoop(tenantB1, [{ role: 'user', content: 'next' }], { now: now + 3000 }).blocked, true);
    });
  });

  describe('getLoopGuardStatus with overrides', () => {
    it('includes tenants with loop overrides in status', () => {
      upsertTenant({
        id: 'tenant-with-loop-override',
        status: 'active',
        limits: {
          loop: { maxReq: 10, mode: 'enforce' },
        },
        createdAt: '',
        updatedAt: '',
      });

      const status = getLoopGuardStatus();
      assert.ok(status.thresholds);
      assert.ok(status.overrides);
      assert.ok(status.overrides['tenant-with-loop-override']);
      assert.equal(status.overrides['tenant-with-loop-override'].maxReq, 10);
    });
  });

  describe('Event emission on loop block', () => {
    it('emits loop.blocked router event when a session is blocked', () => {
      const key = 'tenant-event|app1|agent1|session1';
      const now = 6_000_000;
      const customLimits = { maxRepeat: 2 };
      const repeated = [{ role: 'user', content: 'trigger event' }];

      let capturedEvent: any = null;
      const unsubscribe = onRouterEvent((ev) => {
        if (ev.type === 'loop.blocked') {
          capturedEvent = ev;
        }
      });

      checkLoop(key, repeated, { now: now + 1000, limits: customLimits });
      checkLoop(key, repeated, { now: now + 2000, limits: customLimits });

      unsubscribe();

      assert.ok(capturedEvent, 'loop.blocked event must be emitted');
      assert.equal(capturedEvent.type, 'loop.blocked');
      assert.equal(capturedEvent.tenantId, 'tenant-event');
      assert.equal(capturedEvent.key, key);
      assert.equal(capturedEvent.rule, 'repeat');

      // Verify it is also stored in recent events buffer
      const recent = getRecentRouterEvents();
      assert.ok(recent.some(e => e.type === 'loop.blocked' && e.tenantId === 'tenant-event'));
    });
  });
  it('a registry value of 0 turns that loop rule off; unset fields fall back to env', () => {
    upsertTenant({
      id: 'no-rate',
      status: 'active',
      limits: { loop: { maxReq: 0 } },
      createdAt: '',
      updatedAt: '',
    } as any);
    const limits = resolveLoopLimits('no-rate');
    assert.deepEqual(limits, { maxReq: 0 });
    let now = 1_000_000;
    for (let i = 0; i < 60; i++) {
      const r = checkLoop('no-rate|a|b|c', [{ role: 'user', content: `m${i}` }], { now, limits });
      assert.equal(r.blocked, false, `request ${i} must pass`);
      now += 100;
    }
    // repeat rule still active from env default (3)
    for (let i = 0; i < 2; i++) checkLoop('no-rate|a|b|c', [{ role: 'user', content: 'same' }], { now: ++now, limits });
    assert.equal(checkLoop('no-rate|a|b|c', [{ role: 'user', content: 'same' }], { now: ++now, limits }).blocked, true);
  });
});
