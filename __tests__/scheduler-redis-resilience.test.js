// __tests__/scheduler-redis-resilience.test.js
// =============================================================================
// Redis/scheduler resilience — covers the hardening added after the 2026-09-17
// Upstash quota-exhaustion incident.
//
// Covers (per docs/REDIS_OPERATING_MODES.md):
//   1. Redis-off startup → single-instance fallback, all jobs scheduled
//   2. Redis-on normal startup → distributed mode, bounded retryStrategy
//   3. Redis down at boot (ping gate) → clean wholesale fallback, no partial
//      Bull state, connection hard-disconnected (no retry loop)
//   4. Fatal runtime Redis error → circuit breaker trips → every job
//      re-registered on fallback EXACTLY once, no job in both mechanisms
//   5. Non-connection worker errors (job handler failures) NEVER trip the
//      breaker
//   6. queue.add hangs mid-boot → demote-all → every job lands on fallback
//      (registration is never silently dropped)
//   7. Recovery probe → distributed mode restored, fallbacks cleared
//   8. Fallback registration failure (invalid cron) → register() throws
//      (fail startup, never silently omit a worker)
//   9. vaultWorker / savingsWorker overlap guards: a second concurrent tick
//      is a no-op (restart/replay-safe by construction)
//
// No real Redis, no real BullMQ, no network: ioredis + bullmq are jest-mocked.
// No PostgreSQL needed — scheduler is Redis/infra-only.
// =============================================================================

const { EventEmitter } = require('events');

// ── ioredis mock ─────────────────────────────────────────────────────────────
// Behavior is steered through `redisMockState` per test.
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
        if (redisMockState.pingShouldFail) {
            throw new Error('Connection is closed');
        }
        return 'PONG';
    }
    async connect() {
        if (redisMockState.pingShouldFail) {
            throw new Error('connect ECONNREFUSED');
        }
        return this;
    }
    disconnect() { this.disconnected = true; }
    async quit() { this.disconnected = true; }
}
MockRedis.instances = [];

jest.mock('ioredis', () => MockRedis);

// ── bullmq mock ──────────────────────────────────────────────────────────────
// queue.add behavior is steered through `bullMockState` per test.
const bullMockState = { addBehavior: 'ok' };

class MockQueue {
    constructor(name, opts) {
        this.name = name;
        this.opts = opts;
        this.repeatables = [];
        this.closed = false;
        MockQueue.instances.set(name, this);
    }
    async add(jobId, data, opts) {
        if (bullMockState.addBehavior === 'hang') {
            return new Promise(() => {}); // never settles — mirrors maxRetriesPerRequest:null on dead Redis
        }
        if (bullMockState.addBehavior === 'fail') {
            throw new Error('Connection is closed');
        }
        this.repeatables.push({ jobId, opts });
        return { id: jobId };
    }
    async close() { this.closed = true; }
}
MockQueue.instances = new Map();

class MockWorker extends EventEmitter {
    constructor(name, processor, opts) {
        super();
        this.name = name;
        this.opts = opts;
        this.closed = false;
        MockWorker.instances.set(name, this);
    }
    async close() { this.closed = true; }
}
MockWorker.instances = new Map();

jest.mock('bullmq', () => ({ Queue: MockQueue, Worker: MockWorker }));

const { BullScheduler } = require('../src/lib/bullScheduler');

const settle = () => new Promise((r) => setTimeout(r, 25));

// Every job must be scheduled in EXACTLY ONE mechanism at any time.
const activeMechanisms = (sched) => sched.queues.size + sched.fallbacks.size;

describe('Scheduler Redis resilience', () => {
    let savedRedisUrl;

    beforeAll(() => { savedRedisUrl = process.env.REDIS_URL; });
    afterAll(() => { if (savedRedisUrl !== undefined) process.env.REDIS_URL = savedRedisUrl; else delete process.env.REDIS_URL; });

    beforeEach(() => {
        redisMockState.pingShouldFail = false;
        bullMockState.addBehavior = 'ok';
        MockRedis.instances.length = 0;
        MockQueue.instances.clear();
        MockWorker.instances.clear();
    });

    afterEach(async () => {
        delete process.env.REDIS_URL;
    });

    // ── 1. Redis-off startup ─────────────────────────────────────────────────
    test('REDIS_URL unset → fallback mode, every job scheduled exactly once', async () => {
        delete process.env.REDIS_URL;
        const sched = new BullScheduler();
        const ticks = { a: 0, b: 0 };

        await sched.init();
        expect(sched.getMode()).toBe('single_instance_fallback');
        expect(sched.useBull).toBe(false);

        await sched.register('jobA', '60000', () => { ticks.a++; });
        await sched.register('jobB', '*/5 * * * *', () => { ticks.b++; });

        expect(sched.jobs.size).toBe(2);
        expect(sched.fallbacks.size).toBe(2);
        expect(sched.queues.size).toBe(0);
        expect(activeMechanisms(sched)).toBe(2);
        // interval jobs fire once immediately (documented fallback behavior)
        expect(ticks.a).toBe(1);
        expect(ticks.b).toBe(0);

        await sched.closeAll();
        expect(sched.fallbacks.size).toBe(0);
    });

    // ── 2. Redis-on normal startup ───────────────────────────────────────────
    test('REDIS_URL set + healthy → distributed mode, bounded retryStrategy', async () => {
        process.env.REDIS_URL = 'rediss://default:pw@fake.upstash.io:6379';
        const sched = new BullScheduler();

        await sched.init();
        expect(sched.getMode()).toBe('distributed');
        expect(sched.useBull).toBe(true);

        await sched.register('jobA', '60000', async () => {});
        await sched.register('jobB', '0 * * * *', async () => {});

        expect(sched.queues.size).toBe(2);
        expect(sched.workers.size).toBe(2);
        expect(sched.fallbacks.size).toBe(0);
        expect(activeMechanisms(sched)).toBe(2);

        // repeatable options carry the cadence (interval vs cron pattern)
        const qA = MockQueue.instances.get('jobA');
        const qB = MockQueue.instances.get('jobB');
        expect(qA.repeatables[0].opts.repeat.every).toBe(60000);
        expect(qB.repeatables[0].opts.repeat.pattern).toBe('0 * * * *');

        // retryStrategy: >=500ms floor, capped at 10s — never the stormy
        // ioredis default (~100ms), never unbounded.
        const conn = sched.redisConnection;
        expect(conn).toBeTruthy();
        const strategy = conn.opts.retryStrategy;
        expect(strategy(1)).toBeGreaterThanOrEqual(500);
        expect(strategy(2)).toBeGreaterThanOrEqual(1000);
        expect(strategy(1000)).toBeLessThanOrEqual(10000);

        await sched.closeAll();
    });

    // ── 3. Boot gate: Redis dead at boot ─────────────────────────────────────
    test('Redis unreachable at boot → clean wholesale fallback, connection killed', async () => {
        process.env.REDIS_URL = 'rediss://default:pw@fake.upstash.io:6379';
        redisMockState.pingShouldFail = true;
        const sched = new BullScheduler();

        await sched.init();
        expect(sched.getMode()).toBe('single_instance_fallback');
        expect(sched.useBull).toBe(false);
        // no partial Bull state, and the failing connection was hard-disconnected
        expect(sched.queues.size).toBe(0);
        expect(sched.redisConnection).toBe(null);
        expect(MockRedis.instances[0].disconnected).toBe(true);

        await sched.register('jobA', '60000', async () => {});
        expect(sched.fallbacks.size).toBe(1);
        expect(activeMechanisms(sched)).toBe(1);

        await sched.closeAll();
    });

    // ── 4. Fatal runtime error trips the breaker ─────────────────────────────
    test('Upstash quota-exhausted error trips breaker → all jobs on fallback exactly once', async () => {
        process.env.REDIS_URL = 'rediss://default:pw@fake.upstash.io:6379';
        const sched = new BullScheduler();
        await sched.init();
        await sched.register('jobA', '60000', async () => {});
        await sched.register('jobB', '*/5 * * * *', async () => {});
        expect(sched.getMode()).toBe('distributed');

        // The exact error class from the 2026-09-17 incident
        sched.redisConnection.emit('error', new Error(
            'ERR max requests limit exceeded. Limit: 500000, Usage: 500006. See https://upstash.com/docs/redis/troubleshooting/max_requests_limit for details'
        ));
        await settle(); // breaker trip is async

        expect(sched.breakerTripped).toBe(true);
        expect(sched.getMode()).toBe('single_instance_fallback');
        expect(sched.useBull).toBe(false);
        // every job re-registered on fallback; no job left in Bull
        expect(sched.fallbacks.size).toBe(2);
        expect(sched.queues.size).toBe(0);
        expect(sched.workers.size).toBe(0);
        expect(activeMechanisms(sched)).toBe(2);
        // recovery probe armed
        expect(sched._probeTimer).toBeTruthy();

        await sched.closeAll();
    });

    // ── 5. Handler-style errors never trip the breaker ───────────────────────
    test('non-connection worker error does NOT trip the breaker', async () => {
        process.env.REDIS_URL = 'rediss://default:pw@fake.upstash.io:6379';
        const sched = new BullScheduler();
        await sched.init();
        await sched.register('transit-reminders', '*/15 * * * *', async () => {});
        expect(sched.getMode()).toBe('distributed');

        // A job-handler failure class (e.g. the transit-reminders Prisma bug)
        MockWorker.instances.get('transit-reminders').emit('error', new Error("Unknown argument `seat`. Available options are listed here."));
        await settle();

        expect(sched.breakerTripped).toBe(false);
        expect(sched.getMode()).toBe('distributed');
        expect(sched.queues.size).toBe(1);
        expect(sched.fallbacks.size).toBe(0);

        await sched.closeAll();
    });

    // ── 6. queue.add hang → demote-all (boot registration gap) ───────────────
    test('hanging queue.add demotes the whole fleet to fallback — no job silently dropped', async () => {
        process.env.REDIS_URL = 'rediss://default:pw@fake.upstash.io:6379';
        const sched = new BullScheduler();
        sched.addTimeoutMs = 50; // shrink the boot-registration timeout
        await sched.init();

        await sched.register('jobA', '60000', async () => {}); // registers in Bull fine
        expect(sched.queues.size).toBe(1);

        bullMockState.addBehavior = 'hang'; // Redis dies between the two adds
        await sched.register('jobB', '60000', async () => {});
        await settle();

        // demote-all: BOTH jobs (incl. the already-Bull-registered one) are on
        // fallback, nothing stays in Bull, nothing is silently dropped
        expect(sched.getMode()).toBe('single_instance_fallback');
        expect(sched.fallbacks.size).toBe(2);
        expect(sched.queues.size).toBe(0);
        expect(sched.workers.size).toBe(0);
        expect(activeMechanisms(sched)).toBe(2);

        await sched.closeAll();
    });

    // ── 7. Recovery probe restores distributed mode ───────────────────────────
    test('recovery probe → distributed mode restored exactly once', async () => {
        process.env.REDIS_URL = 'rediss://default:pw@fake.upstash.io:6379';
        const sched = new BullScheduler();
        await sched.init();
        await sched.register('jobA', '60000', async () => {});
        await sched.register('jobB', '0 * * * *', async () => {});

        sched.redisConnection.emit('error', new Error('ERR max requests limit exceeded. Limit: 500000, Usage: 500006'));
        await settle();
        expect(sched.breakerTripped).toBe(true);
        expect(sched.fallbacks.size).toBe(2);

        // Redis comes back
        redisMockState.pingShouldFail = false;
        await sched._probeTick();
        await settle();

        expect(sched.breakerTripped).toBe(false);
        expect(sched.getMode()).toBe('distributed');
        expect(sched.useBull).toBe(true);
        expect(sched.fallbacks.size).toBe(0);
        expect(sched.queues.size).toBe(2);
        expect(sched.workers.size).toBe(2);
        expect(activeMechanisms(sched)).toBe(2);
        expect(sched._probeTimer).toBe(null); // probe disarmed

        await sched.closeAll();
    });

    // ── 8. Neither mode can schedule the job → fail loudly ───────────────────
    test('invalid cron in fallback mode throws (fail startup, never silently omit)', async () => {
        delete process.env.REDIS_URL;
        const sched = new BullScheduler();
        await sched.init();

        await expect(sched.register('broken', 'not a cron', async () => {})).rejects.toThrow();
        await sched.closeAll();
    });

    // ── 9. Worker overlap guards ──────────────────────────────────────────────
    test('vaultWorker: concurrent second tick is a no-op (no double due-list read)', async () => {
        const VaultWorker = require('../workers/vaultWorker');
        let reads = 0;
        const prisma = { vault: { findMany: async () => { reads++; return new Promise(() => {}); } } };
        const worker = new VaultWorker(prisma, { runAutoRule: async () => ({ ok: true }) }, null);

        const p1 = worker._tick();
        const p2 = worker._tick(); // overlaps while p1 awaits the hanging findMany
        await Promise.race([p1, p2, settle()]);

        // the guard short-circuits the second tick BEFORE it can read the due
        // vault list — runAutoRule is a stale-read TOCTOU, so a second read of
        // the same due list would execute the same auto-rule twice (double money)
        expect(reads).toBe(1);
        expect(worker._running).toBe(true); // first tick still in flight
        worker._running = false; // test teardown for the hanging promise
    });

    test('savingsWorker: concurrent second _checkReminders is a no-op', async () => {
        const SavingsWorker = require('../workers/savingsWorker');
        let reads = 0;
        const prisma = { savingsGoal: { findMany: async () => { reads++; return new Promise(() => {}); } } };
        const worker = new SavingsWorker(prisma, null);

        const p1 = worker._checkReminders();
        const p2 = worker._checkReminders();
        await Promise.race([p1, p2, settle()]);

        // only the first tick reached the DB read
        expect(reads).toBe(1);
        worker._running = false; // test teardown
    });
});
