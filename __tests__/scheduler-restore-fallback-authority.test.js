// __tests__/scheduler-restore-fallback-authority.test.js
// =============================================================================
// DEFECT A (2026-11-17 audit) — a FAILED BullMQ restore must never arm local
// schedulers.
//
// The old `_restoreBull()` catch path set mode='unavailable_no_scheduling' and
// then called `_registerFallback()` for every registered job DIRECTLY, bypassing
// the enforcement point in `register()`. With N replicas, one partial Bull
// registration failure (say job 2 of 6) turned every replica into an independent
// financial scheduler running the same jobs.
//
// These tests fail on that code and pass on the fix. The case the pre-existing
// suite did NOT cover is exactly this: a partial restore failure AFTER Redis has
// come back.
//
// No network, no real Redis, no real BullMQ, no PostgreSQL.
// =============================================================================
'use strict';

const { EventEmitter } = require('events');

// ── ioredis mock ─────────────────────────────────────────────────────────────
const redisMockState = { pingShouldFail: false };

class MockRedis extends EventEmitter {
    constructor(url, opts = {}) {
        super();
        this.url = url;
        this.opts = opts;
        this.disconnected = false;
        this.disconnectCount = 0;
        MockRedis.instances.push(this);
    }
    async ping() {
        if (redisMockState.pingShouldFail) throw new Error('Connection is closed');
        return 'PONG';
    }
    async connect() {
        if (redisMockState.pingShouldFail) throw new Error('connect ECONNREFUSED');
        return this;
    }
    disconnect() { this.disconnected = true; this.disconnectCount += 1; }
    async quit() { this.disconnected = true; }
}
MockRedis.instances = [];

jest.mock('ioredis', () => MockRedis);

// ── bullmq mock ──────────────────────────────────────────────────────────────
// `failOn` makes queue.add reject for ONE named job, which is what a partial
// restore failure looks like in production (job 1 registered, job 2 refused).
const bullMockState = { failOn: null };

class MockQueue {
    constructor(name) {
        this.name = name;
        this.repeatables = [];
        this.closed = false;
        MockQueue.instances.set(name, this);
        MockQueue.created.push(name);
    }
    async add(jobId, data, opts) {
        if (bullMockState.failOn && bullMockState.failOn === this.name) {
            throw new Error('Connection is closed');
        }
        this.repeatables.push({ jobId, opts });
        return { id: jobId };
    }
    async close() { this.closed = true; }
}
MockQueue.instances = new Map();
MockQueue.created = [];

class MockWorker extends EventEmitter {
    constructor(name) {
        super();
        this.name = name;
        this.closed = false;
        MockWorker.instances.set(name, this);
    }
    async close() { this.closed = true; }
}
MockWorker.instances = new Map();

jest.mock('bullmq', () => ({ Queue: MockQueue, Worker: MockWorker }));

const { BullScheduler } = require('../src/lib/bullScheduler');

const JOBS = [
    ['job-a', '*/1 * * * *'],
    ['job-b', '*/2 * * * *'],
    ['job-c', '*/3 * * * *'],
];

// Scheduled in exactly one mechanism, or in neither (which is the correct
// state while Redis is unavailable in a multi-replica deployment).
const mechanisms = (sched) => sched.queues.size + sched.fallbacks.size;

// A restore only happens after the breaker has tripped and closed Bull state.
// (Calling _restoreBull with live queues is a no-op in the real state machine:
// every queue already exists, so no registration is attempted.)
async function trip(sched) {
    sched.redisConnection.emit('error', new Error('ERR max requests limit exceeded. Limit: 500000, Usage: 500006'));
    await new Promise((r) => setTimeout(r, 25));
    expect(sched.mode).toBe('unavailable_no_scheduling');
    expect(sched.queues.size).toBe(0);
}

async function bootDistributed(sched) {
    for (const [name, cron] of JOBS) {
        await sched.register(name, cron, async () => {});
    }
}

describe('DEFECT A — a failed Bull restore cannot create local schedulers', () => {
    let savedRedisUrl;
    let savedSingle;

    beforeAll(() => {
        savedRedisUrl = process.env.REDIS_URL;
        savedSingle = process.env.SCHEDULER_SINGLE_INSTANCE;
    });
    afterAll(() => {
        if (savedRedisUrl !== undefined) process.env.REDIS_URL = savedRedisUrl; else delete process.env.REDIS_URL;
        if (savedSingle !== undefined) process.env.SCHEDULER_SINGLE_INSTANCE = savedSingle; else delete process.env.SCHEDULER_SINGLE_INSTANCE;
    });

    beforeEach(() => {
        redisMockState.pingShouldFail = false;
        bullMockState.failOn = null;
        MockRedis.instances.length = 0;
        MockQueue.instances.clear();
        MockQueue.created.length = 0;
        MockWorker.instances.clear();
        delete process.env.SCHEDULER_SINGLE_INSTANCE;
        process.env.REDIS_URL = 'redis://localhost:6379';
    });

    afterEach(() => {
        delete process.env.REDIS_URL;
        delete process.env.SCHEDULER_SINGLE_INSTANCE;
    });

    test('partial restore failure (2nd job) arms NO local fallback and schedules nothing', async () => {
        const sched = new BullScheduler();
        await sched.init();
        await bootDistributed(sched);
        expect(sched.mode).toBe('distributed');

        // Redis goes away → breaker trips → nothing scheduled, jobs retained.
        sched.redisConnection.emit('error', new Error('ERR max requests limit exceeded. Limit: 500000, Usage: 500006'));
        await new Promise((r) => setTimeout(r, 25));
        expect(sched.mode).toBe('unavailable_no_scheduling');
        expect(sched.fallbacks.size).toBe(0);

        // Redis returns, but the restore half-fails on the SECOND job.
        bullMockState.failOn = 'job-b';
        await sched._restoreBull();

        // THE INVARIANT: no local timers, no half-active Bull state, jobs kept.
        expect(sched.mode).toBe('unavailable_no_scheduling');
        expect(sched.fallbacks.size).toBe(0);
        expect(sched.queues.size).toBe(0);
        expect(sched.useBull).toBe(false);
        expect(mechanisms(sched)).toBe(0);
        expect(sched.jobs.size).toBe(JOBS.length);
        // The breaker stays armed so the probe keeps trying.
        expect(sched.breakerTripped).toBe(true);
    });

    test('two replicas: a partial restore must not make either one a local scheduler', async () => {
        const replicaA = new BullScheduler();
        const replicaB = new BullScheduler();
        await replicaA.init();
        await replicaB.init();
        await bootDistributed(replicaA);
        await bootDistributed(replicaB);

        await trip(replicaA);
        await trip(replicaB);

        bullMockState.failOn = 'job-c';
        await replicaA._restoreBull();
        await replicaB._restoreBull();

        // Neither replica scheduled anything locally: with two replicas that
        // would have been two schedulers running every financial job.
        expect(replicaA.fallbacks.size).toBe(0);
        expect(replicaB.fallbacks.size).toBe(0);
        expect(replicaA.mode).toBe('unavailable_no_scheduling');
        expect(replicaB.mode).toBe('unavailable_no_scheduling');
    });

    test('a later successful restore converges to distributed with each job registered once', async () => {
        const sched = new BullScheduler();
        await sched.init();
        await bootDistributed(sched);

        await trip(sched);

        bullMockState.failOn = 'job-b';
        await sched._restoreBull();
        expect(sched.mode).toBe('unavailable_no_scheduling');

        // Repeated failed attempts must not accumulate anything.
        await sched._restoreBull();
        await sched._restoreBull();
        expect(sched.fallbacks.size).toBe(0);
        expect(sched.queues.size).toBe(0);

        // Redis genuinely healthy again.
        bullMockState.failOn = null;
        await sched._restoreBull();

        expect(sched.mode).toBe('distributed');
        expect(sched.fallbacks.size).toBe(0);
        expect(sched.queues.size).toBe(JOBS.length);
        for (const [name] of JOBS) {
            const q = MockQueue.instances.get(name);
            expect(q).toBeDefined();
            // Exactly one repeatable registration — no duplicate scheduling.
            expect(q.repeatables.length).toBe(1);
        }
    });

    test('the restore ping connection is always closed, even when the ping fails', async () => {
        const sched = new BullScheduler();
        await sched.init();
        const before = MockRedis.instances.length;

        redisMockState.pingShouldFail = true;
        await sched._restoreBull();

        const opened = MockRedis.instances.slice(before);
        expect(opened.length).toBeGreaterThan(0);
        for (const c of opened) {
            expect(c.disconnectCount).toBeGreaterThan(0);
        }
        expect(sched.fallbacks.size).toBe(0);
    });

    test('explicit single-instance mode keeps working, and the re-arm helper is idempotent', async () => {
        delete process.env.REDIS_URL;
        process.env.SCHEDULER_SINGLE_INSTANCE = 'true';

        const sched = new BullScheduler();
        await sched.init();
        expect(sched.mode).toBe('single_instance_fallback');
        await bootDistributed(sched);
        expect(sched.fallbacks.size).toBe(JOBS.length);

        // Already armed → nothing duplicated.
        expect(sched._armFallbacksForAllJobs('test')).toBe(0);
        expect(sched.fallbacks.size).toBe(JOBS.length);
    });

    test('the re-arm helper refuses outside the explicit single-instance mode', async () => {
        const sched = new BullScheduler();
        await sched.init();
        sched.mode = 'unavailable_no_scheduling';
        sched.useBull = false;
        for (const [name, cron] of JOBS) sched.jobs.set(name, { cronExpr: cron, handler: async () => {}, opts: {} });

        expect(sched._armFallbacksForAllJobs('probe')).toBe(0);
        expect(sched.fallbacks.size).toBe(0);
    });
});

// ── A+: re-arming after a failed restore must not re-run interval jobs ───────
describe('DEFECT A+ — a re-arm is not a new registration', () => {
    test('the explicit single-instance mode re-arms timers WITHOUT re-running interval jobs', async () => {
        delete process.env.REDIS_URL;
        process.env.SCHEDULER_SINGLE_INSTANCE = 'true';
        const sched = new BullScheduler();
        let runs = 0;
        await sched.init();
        await sched.register('money-sweep', '60000', async () => { runs += 1; });
        // First registration is allowed to fire once immediately (pre-BullMQ behaviour).
        expect(runs).toBe(1);
        // Simulate what a failed restore does in this mode: tear the timers down
        // and re-arm from the registry.
        sched._shutdownFallbacks();
        const rearmed = sched._armFallbacksForAllJobs('repro of failed restore');
        expect(rearmed).toBe(1);
        await new Promise((r) => setTimeout(r, 60));
        // Re-armed, but the job must NOT have run again. Otherwise every failed
        // probe (one per 5 min) would execute every financial interval job.
        expect(runs).toBe(1);
        sched._shutdownFallbacks();
        delete process.env.SCHEDULER_SINGLE_INSTANCE;
    });
});
