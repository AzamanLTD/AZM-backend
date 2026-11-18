// __tests__/scheduler-redis-transport-guard.test.js
// =============================================================================
// DEFECT B (2026-11-17 audit) — every BullMQ Redis path must enforce the SAME
// production transport-security policy as src/lib/redisConnection.js.
//
// Before the fix, src/lib/bullScheduler.js built ioredis directly in four places
// (init, probe, restore ping, restored connection) and decided TLS by sniffing
// the `rediss://` prefix itself. A production `redis://` URL was refused by the
// shared request-path client and ACCEPTED by the scheduler — the same password
// and keys in clear on the wire, through the component that moves money.
//
// The proof here is deliberately strong: when the policy refuses, NO client is
// constructed at all (not merely "constructed and then rejected").
// =============================================================================
'use strict';

const { EventEmitter } = require('events');

const redisMockState = { pingShouldFail: false };

class MockRedis extends EventEmitter {
    constructor(url, opts = {}) {
        super();
        this.url = url;
        this.opts = opts;
        this.disconnected = false;
        MockRedis.instances.push(this);
    }
    async ping() {
        if (redisMockState.pingShouldFail) throw new Error('Connection is closed');
        return 'PONG';
    }
    async connect() { return this; }
    disconnect() { this.disconnected = true; }
    async quit() { this.disconnected = true; }
}
MockRedis.instances = [];

jest.mock('ioredis', () => MockRedis);

class MockQueue {
    constructor(name) { this.name = name; this.repeatables = []; }
    async add(jobId) { this.repeatables.push(jobId); return { id: jobId }; }
    async close() { this.closed = true; }
}
class MockWorker extends EventEmitter {
    constructor(name) { super(); this.name = name; }
    async close() { this.closed = true; }
}
jest.mock('bullmq', () => ({ Queue: MockQueue, Worker: MockWorker }));

const { BullScheduler } = require('../src/lib/bullScheduler');
const { createQueueClient } = require('../src/lib/redisConnection');

const ENV_KEYS = ['NODE_ENV', 'REDIS_URL', 'REDIS_ALLOW_PLAINTEXT', 'SCHEDULER_SINGLE_INSTANCE'];

describe('DEFECT B — scheduler Redis paths enforce the shared transport policy', () => {
    const saved = {};

    beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
    afterAll(() => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
        }
    });

    beforeEach(() => {
        redisMockState.pingShouldFail = false;
        MockRedis.instances.length = 0;
        delete process.env.REDIS_ALLOW_PLAINTEXT;
        delete process.env.SCHEDULER_SINGLE_INSTANCE;
    });

    afterEach(() => {
        process.env.NODE_ENV = 'test';
        delete process.env.REDIS_URL;
    });

    // ── the boot path ────────────────────────────────────────────────────────
    test('production redis:// is refused and NOT ONE client is constructed', async () => {
        process.env.NODE_ENV = 'production';
        process.env.REDIS_URL = 'redis://default:secret@cache.example:6379';

        const sched = new BullScheduler();
        await sched.init();

        expect(MockRedis.instances.length).toBe(0);          // nothing on the wire
        expect(sched.mode).toBe('unavailable_no_scheduling'); // fail closed
        expect(sched.useBull).toBe(false);
        // and never a quiet local scheduler as a consolation prize
        expect(sched.fallbacks.size).toBe(0);
    });

    test('production redis:// is accepted ONLY under the explicit override, with a warning', async () => {
        process.env.NODE_ENV = 'production';
        process.env.REDIS_URL = 'redis://default:secret@cache.example:6379';
        process.env.REDIS_ALLOW_PLAINTEXT = 'true';

        const sched = new BullScheduler();
        await sched.init();

        expect(MockRedis.instances.length).toBe(1);
        expect(sched.mode).toBe('distributed');
    });

    test('rediss:// is accepted with certificate verification explicitly ON', async () => {
        process.env.NODE_ENV = 'production';
        process.env.REDIS_URL = 'rediss://default:secret@cache.example:6379';

        const sched = new BullScheduler();
        await sched.init();

        expect(sched.mode).toBe('distributed');
        const client = MockRedis.instances[0];
        expect(client).toBeDefined();
        expect(client.opts.tls).toBeDefined();
        // Verification must never be disabled to make a connection succeed.
        expect(client.opts.tls.rejectUnauthorized).toBe(true);
        // BullMQ's hard requirement is preserved through the factory.
        expect(client.opts.maxRetriesPerRequest).toBeNull();
    });

    // ── the recovery probe ───────────────────────────────────────────────────
    test('the recovery probe cannot construct a production plaintext connection', async () => {
        process.env.NODE_ENV = 'production';
        process.env.REDIS_URL = 'redis://default:secret@cache.example:6379';

        const sched = new BullScheduler();
        sched.breakerTripped = true;   // the only state in which the probe runs

        await sched._probeTick();

        expect(MockRedis.instances.length).toBe(0);
        expect(sched.mode).toBeNull(); // never promoted to distributed by a probe
    });

    // ── the restore path ─────────────────────────────────────────────────────
    test('a restore cannot construct a production plaintext connection and never falls back locally', async () => {
        process.env.NODE_ENV = 'production';
        process.env.REDIS_URL = 'redis://default:secret@cache.example:6379';

        const sched = new BullScheduler();
        sched.mode = 'unavailable_no_scheduling';
        sched.breakerTripped = true;
        sched.jobs.set('job-a', { cronExpr: '*/1 * * * *', handler: async () => {}, opts: {} });

        await sched._restoreBull();

        expect(MockRedis.instances.length).toBe(0);
        expect(sched.mode).toBe('unavailable_no_scheduling');
        expect(sched.fallbacks.size).toBe(0);
    });

    // ── non-production compatibility ─────────────────────────────────────────
    test('non-production redis:// keeps working exactly as before', async () => {
        process.env.NODE_ENV = 'test';
        process.env.REDIS_URL = 'redis://localhost:6379';

        const sched = new BullScheduler();
        await sched.init();

        expect(sched.mode).toBe('distributed');
        expect(MockRedis.instances.length).toBe(1);
        expect(MockRedis.instances[0].opts.tls).toBeUndefined();
    });

    // ── the factory itself ───────────────────────────────────────────────────
    test('the shared factory refuses a malformed URL, a REST URL and production plaintext', () => {
        process.env.NODE_ENV = 'test';
        process.env.REDIS_URL = 'not-a-url';
        expect(() => createQueueClient()).toThrow(/must start with redis/);

        process.env.REDIS_URL = 'https://us1-example.upstash.io';
        expect(() => createQueueClient()).toThrow(/REST URL/);

        process.env.NODE_ENV = 'production';
        process.env.REDIS_URL = 'redis://default:secret@cache.example:6379';
        expect(() => createQueueClient()).toThrow(/refusing plaintext redis/);
        expect(MockRedis.instances.length).toBe(0);

        delete process.env.REDIS_URL;
        expect(() => createQueueClient()).toThrow(/not configured/);
    });
});
