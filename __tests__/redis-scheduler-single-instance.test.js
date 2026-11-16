// §3 — MULTI-INSTANCE SCHEDULING SAFETY.
//
// The hazard: if a configured-but-unreachable Redis degrades to "single-instance
// fallback", then N replicas each become an independent local scheduler and run
// the same financial job N times. A local scheduler is therefore only allowed as
// an EXPLICIT operating mode, and a configured Redis that does not answer must
// schedule NOTHING.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'lib', 'bullScheduler.js');

const loadScheduler = () => {
  jest.resetModules();
  return require('../src/lib/bullScheduler');
};

describe('financial scheduler operating modes', () => {
  const original = { REDIS_URL: process.env.REDIS_URL, SINGLE: process.env.SCHEDULER_SINGLE_INSTANCE };

  beforeEach(() => {
    delete process.env.REDIS_URL;
    delete process.env.SCHEDULER_SINGLE_INSTANCE;
  });

  afterEach(() => {
    if (original.REDIS_URL === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = original.REDIS_URL;
    if (original.SINGLE === undefined) delete process.env.SCHEDULER_SINGLE_INSTANCE; else process.env.SCHEDULER_SINGLE_INSTANCE = original.SINGLE;
  });

  test('no REDIS_URL and no explicit opt-in schedules NOTHING', async () => {
    const { BullScheduler } = loadScheduler();
    const s = new BullScheduler();
    await s.init();
    expect(s.mode).toBe('disabled_no_scheduling');
    expect(s.useBull).toBe(false);
    expect(s.fallbacks.size).toBe(0);
  });

  test('single-instance scheduling requires the explicit flag', async () => {
    process.env.SCHEDULER_SINGLE_INSTANCE = 'true';
    const { BullScheduler } = loadScheduler();
    const s = new BullScheduler();
    await s.init();
    expect(s.mode).toBe('single_instance_fallback');
    expect(s.useBull).toBe(false);
  });

  test('a CONFIGURED but unreachable Redis schedules nothing (never local fallback)', async () => {
    // Port 1 on loopback: connection refused immediately, no DNS, no waiting.
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    const { BullScheduler } = loadScheduler();
    const s = new BullScheduler();
    await s.init();
    expect(s.mode).toBe('unavailable_no_scheduling');
    expect(s.useBull).toBe(false);
    expect(s.fallbacks.size).toBe(0);
    // and it must not have left a live connection behind
    expect(s.redisConnection).toBeFalsy();
  });

  test('the source has exactly ONE path into single-instance scheduling, and it is the explicit flag', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    const assignments = src.match(/this\.mode = 'single_instance_fallback';/g) || [];
    expect(assignments).toHaveLength(1);
    // That one assignment is guarded by the flag check, in the same branch.
    expect(src).toContain("process.env.SCHEDULER_SINGLE_INSTANCE || '').toLowerCase() === 'true'");
  });

  test('the socket limiter arms its window atomically (no partial key without expiry)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'socketRateLimiter.js'), 'utf8');
    expect(src).toContain('_INCR_WITH_TTL');
    // The un-atomic pair must be gone: incr() followed by a separate pexpire().
    expect(src).not.toMatch(/await redis\.incr\(/);
    expect(src).not.toMatch(/await redis\.pexpire\(/);
    expect(src).toContain("redis.call('PEXPIRE'");
  });
});
