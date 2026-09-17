// src/lib/bullScheduler.js
// =============================================================================
// AZAMAN — BullMQ Distributed Scheduler (Phase 2: Scalability & Security)
//
// Replaces per-process setInterval / node-cron workers with Redis-backed
// BullMQ repeatable jobs. When multiple server instances are running,
// BullMQ guarantees each scheduled tick fires on exactly ONE instance
// (distributed locking via Redis). This prevents duplicate trade
// processing, double withdrawals, etc. in a multi-instance deployment.
//
// ── Operating modes (explicit, single source of truth: this file) ───────────
//
//   DISTRIBUTED  — REDIS_URL is set AND Redis answers a boot-time PING.
//                  BullMQ queues + workers own the cadence. Intended for
//                  multi-instance deployments.
//
//   SINGLE_INSTANCE_FALLBACK — REDIS_URL is unset (deliberate Redis-off
//                  mode), or Redis fails the boot gate / trips the runtime
//                  circuit breaker. node-cron + setInterval own the cadence.
//                  Correct for exactly ONE backend instance; all financial
//                  atomicity remains PostgreSQL-based (conditional updates,
//                  advisory locks, ledger dedup keys), so a crash/restart
//                  delays work at worst — it never duplicates committed
//                  economic operations. With two instances this mode
//                  double-fires ticks (economically safe via PG claims but
//                  operationally noisy) and splits Socket.IO fan-out —
//                  do NOT run Redis-off with more than one instance.
//
// ── Redis failure hardening (2026-09-17 incident) ────────────────────────────
//
//   The Upstash quota exhaustion proved two weaknesses:
//     1. ioredis' default retryStrategy (attempts × 100ms) reconnects at a
//        ~100ms floor forever — a command/reconnect storm.
//     2. `maxRetriesPerRequest: null` (required by BullMQ) means commands
//        QUEUE client-side instead of rejecting, so a dead Redis silently
//        stalls boot registration and leaves jobs unregistered.
//
//   Hardening applied here:
//     • retryStrategy with a 500ms floor, exponential growth, 10s cap —
//       worst case ~6 reconnect attempts/min/connection instead of ~600.
//     • Boot gate: ONE PING (5s timeout) before registering anything in
//       Bull mode. Redis dead at boot → clean wholesale fallback, zero
//       partial Bull state, zero orphaned repeatable jobs.
//     • Runtime circuit breaker: fatal error classes (Upstash quota
//       exhausted, OOM) trip immediately; 20 consecutive connection-class
//       errors trip sustained-failure. On trip: close ALL Bull workers and
//       queues, hard-disconnect Redis, re-register EVERY job in fallback
//       mode exactly once. Repeatable-job definitions left in Redis are
//       dormant (no workers poll them) and are deduped on later restore.
//     • Recovery probe: while tripped, one PING every 5 minutes (rejected
//       commands are not billed by Upstash; a healthy Redis is never
//       probed because the breaker is only armed while it is down). On a
//       successful probe the scheduler restores distributed mode via the
//       same exactly-once transition used by the breaker.
//     • Mode transitions are serialized by a single `_transitioning` lock;
//       every job ends up in exactly ONE mechanism (Bull queue+worker XOR
//       fallback timer) at any time.
//
// Usage (from src/workers/index.js):
//
//   const { getScheduler } = require('../lib/bullScheduler');
//   const scheduler = getScheduler();
//   await scheduler.init();           // picks the mode, logs ONE mode line
//   await scheduler.register('savings', '0 * * * *', async (job) => { ... });
//   await scheduler.closeAll();      // graceful shutdown
//
// Diagnostics: scheduler.getMode() → 'distributed' | 'single_instance_fallback'
// is surfaced through /health as `scheduler.mode`.
// =============================================================================

const logger = require('../config/logger');

// ── Breaker / backoff constants (see hardening notes above) ──────────────────
const BOOT_PING_TIMEOUT_MS = 5_000;      // boot gate: one PING decides the mode
const ADD_TIMEOUT_MS = 10_000;           // queue.add must not hang boot forever
const SHUTDOWN_TIMEOUT_MS = 5_000;       // max wait for Bull close before hard disconnect
const RETRY_FLOOR_MS = 500;              // ioredis reconnect floor (default is ~100ms → storm)
const RETRY_CAP_MS = 10_000;             // reconnect cap — preserves recovery
const SUSTAINED_ERROR_TRIP = 20;         // consecutive connection-class errors → trip
const WORKER_ERROR_LOG_THROTTLE_MS = 60_000; // one error line per worker per minute
const RECOVERY_PROBE_INTERVAL_MS = 300_000;  // 1 PING / 5 min while breaker is open

// Errors that mean "Redis is unavailable for everything, now":
// quota exhausted / memory pressure / auth are never transient per-tick errors.
const FATAL_ERROR_RE = /max requests limit|OOM command not allowed|WRONGPASS|WRONGTYPE.*auth/i;
// Connection/infrastructure errors that count toward the sustained-failure
// breaker. Deliberately narrow: job HANDLER failures (e.g. Prisma validation
// errors) surface as BullMQ 'failed' events and never trip the breaker.
const CONNECTION_ERROR_RE = /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|EAI_AGAIN|Connection is closed|Socket closed|Stream isn't writeable|Loading READY|READONLY|UNCERTAIN_STATE/i;

const _withTimeout = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
]);

let _instance = null;

/**
 * BullScheduler — singleton that manages all BullMQ queues + repeatable jobs.
 * Falls back to in-process timers when Redis is unavailable.
 */
class BullScheduler {
    constructor() {
        this.queues = new Map();        // name → Queue
        this.workers = new Map();       // name → Worker
        this.fallbacks = new Map();     // name → { timer | cronJob }
        this.jobs = new Map();          // name → { cronExpr, handler, opts } — mode-independent registry
        this.redisConnection = null;
        this.useBull = false;
        this.mode = null;               // 'distributed' | 'single_instance_fallback' | null (pre-init)
        this.breakerTripped = false;
        this._transitioning = false;    // serializes exactly-once mode switches
        this._probeTimer = null;
        this._consecutiveErrors = 0;
        this._workerErrorLogAt = new Map(); // name → last logged error ts (throttle)
        // Instance-level knobs (env-overridable; tests shrink them). These bound
        // the worst-case latency of failure paths, never the semantics.
        this.addTimeoutMs = parseInt(process.env.SCHED_ADD_TIMEOUT_MS || '', 10) || ADD_TIMEOUT_MS;
        this.probeIntervalMs = parseInt(process.env.SCHED_PROBE_INTERVAL_MS || '', 10) || RECOVERY_PROBE_INTERVAL_MS;
        this.sustainedErrorTrip = parseInt(process.env.SCHED_SUSTAINED_TRIP || '', 10) || SUSTAINED_ERROR_TRIP;
    }

    /**
     * Initialise. Called once at boot before any register().
     * Decides the operating mode and logs exactly ONE authoritative mode line.
     */
    async init() {
        if (!process.env.REDIS_URL) {
            this.mode = 'single_instance_fallback';
            this._logMode('REDIS_URL not set (Redis-off single-instance mode)');
            return;
        }

        try {
            const { Queue, Worker } = require('bullmq');
            const Redis = require('ioredis');

            // Dedicated connection for BullMQ (separate from Socket.IO / rate limiter)
            const isTLS = process.env.REDIS_URL.startsWith('rediss://');
            this.redisConnection = new Redis(process.env.REDIS_URL, {
                maxRetriesPerRequest: null,  // BullMQ requirement: commands queue client-side
                enableReadyCheck: true,
                lazyConnect: false,
                // Bounded backoff — the default (~100ms floor, forever) is what
                // turned the Upstash quota rejection into a command storm:
                // 500ms → 1s → 2s → 4s → 8s → capped at 10s. A transient outage
                // still recovers automatically (next attempt is at most 10s
                // away); a dead Redis costs at most ~6 attempts/min, not ~600.
                retryStrategy: (times) => Math.min(RETRY_FLOOR_MS * Math.pow(2, Math.min(times - 1, 5)), RETRY_CAP_MS),
                ...(isTLS ? { tls: { rejectUnauthorized: false } } : {}),
            });

            this._installBreakerHooks(this.redisConnection);

            // ── Boot gate ────────────────────────────────────────────────────
            // With maxRetriesPerRequest: null a dead Redis never rejects
            // commands — queue.add would hang boot forever and silently drop
            // every worker. ONE PING, bounded, decides the mode up front.
            await _withTimeout(this.redisConnection.ping(), BOOT_PING_TIMEOUT_MS, 'Redis boot PING');

            this.Queue = Queue;
            this.Worker = Worker;
            this.useBull = true;
            this.mode = 'distributed';
            this._logMode(`Redis connected — BullMQ distributed scheduling (${isTLS ? 'TLS/Upstash' : 'plain'})`);
        } catch (err) {
            // Clean wholesale fallback: no partial Bull state, no retry loop.
            await this._hardDisconnect();
            this.useBull = false;
            this.mode = 'single_instance_fallback';
            this._logMode(`Redis unavailable at boot (${err.message}) — single-instance fallback`);
        }
    }

    /**
     * One authoritative mode line per boot / transition. Never per-worker.
     */
    _logMode(reason) {
        const modeLabel = this.mode === 'distributed' ? 'DISTRIBUTED' : 'SINGLE_INSTANCE_FALLBACK';
        logger.info(`[Scheduling] Mode: ${modeLabel} — ${reason}`);
    }

    /**
     * Current mode for /health diagnostics.
     */
    getMode() {
        return this.mode || 'uninitialized';
    }

    // ── Breaker plumbing ─────────────────────────────────────────────────────

    _installBreakerHooks(conn) {
        conn.on('error', (err) => this._onRedisError(err));
        conn.on('ready', () => { this._consecutiveErrors = 0; });
    }

    _onRedisError(err) {
        if (!this.useBull || this._transitioning) return;
        const msg = String(err?.message || err);
        this._consecutiveErrors += 1;

        if (FATAL_ERROR_RE.test(msg)) {
            this._trip('fatal Redis error class', msg).catch(() => {});
        } else if (this._consecutiveErrors >= this.sustainedErrorTrip) {
            this._trip(`${this._consecutiveErrors} consecutive Redis errors`, msg).catch(() => {});
        }
    }

    /**
     * Open the circuit: shut Bull down, run EVERY job on in-process fallback.
     * Serialized + idempotent — tripping twice is a no-op.
     */
    async _trip(reason, detail) {
        if (this._transitioning || !this.useBull) return;
        this._transitioning = true;
        try {
            this.breakerTripped = true;
            this._startProbe();
            logger.error(`[BullScheduler] Circuit breaker OPEN (${reason}: ${detail}) — switching ALL jobs to in-process fallback`);
            await this._shutdownBull();
            this.useBull = false;
            this.mode = 'single_instance_fallback';
            for (const [name, job] of this.jobs) {
                if (!this.fallbacks.has(name)) {
                    this._registerFallback(name, job.cronExpr, job.handler, job.opts);
                }
            }
            logger.info(`[BullScheduler] Fallback active for ${this.fallbacks.size}/${this.jobs.size} jobs — distributed scheduling disabled until Redis recovers`);
        } finally {
            this._transitioning = false;
        }
    }

    /**
     * Close all BullMQ workers/queues, then hard-disconnect Redis.
     * Workers are closed FIRST and awaited (bounded) so in-flight jobs finish;
     * the hard disconnect then drops any client-side queued commands so a
     * dead Redis cannot hold lingering sockets open.
     */
    async _shutdownBull() {
        const workerCloses = [];
        for (const [, worker] of this.workers) workerCloses.push(worker.close().catch(() => {}));
        await _withTimeout(Promise.allSettled(workerCloses), SHUTDOWN_TIMEOUT_MS, 'worker close').catch(() => {});
        const queueCloses = [];
        for (const [, queue] of this.queues) queueCloses.push(queue.close().catch(() => {}));
        await _withTimeout(Promise.allSettled(queueCloses), SHUTDOWN_TIMEOUT_MS, 'queue close').catch(() => {});
        this.workers.clear();
        this.queues.clear();
        this._workerErrorLogAt.clear();
        await this._hardDisconnect();
    }

    async _hardDisconnect() {
        if (this.redisConnection) {
            try { this.redisConnection.disconnect(); } catch (_) { /* already gone */ }
            this.redisConnection = null;
        }
    }

    // ── Recovery probe ───────────────────────────────────────────────────────

    _startProbe() {
        if (this._probeTimer) return;
        this._probeTimer = setInterval(() => { this._probeTick().catch(() => {}); }, this.probeIntervalMs);
        this._probeTimer.unref?.();
        logger.info(`[BullScheduler] Recovery probe armed — 1 PING every ${Math.round(this.probeIntervalMs / 60000)} min until Redis answers`);
    }

    async _stopProbe() {
        if (this._probeTimer) { clearInterval(this._probeTimer); this._probeTimer = null; }
    }

    /**
     * One bounded PING on a throwaway connection. Rejected commands are not
     * billed by Upstash, so probing a quota-dead Redis costs nothing.
     */
    async _probeTick() {
        if (this._transitioning || !this.breakerTripped || !process.env.REDIS_URL) return;
        let probe = null;
        try {
            const Redis = require('ioredis');
            const isTLS = process.env.REDIS_URL.startsWith('rediss://');
            probe = new Redis(process.env.REDIS_URL, {
                lazyConnect: true,
                maxRetriesPerRequest: 1,
                retryStrategy: () => 60_000, // probe owns its retries; never auto-loop
                enableReadyCheck: true,
                ...(isTLS ? { tls: { rejectUnauthorized: false } } : {}),
            });
            probe.on('error', () => {}); // silence — failure is the normal path
            await _withTimeout(probe.connect().then(() => probe.ping()), BOOT_PING_TIMEOUT_MS, 'Redis probe');
            await this._restoreBull();
        } catch (_) {
            // still down — stay in fallback, probe fires again
        } finally {
            if (probe) { try { probe.disconnect(); } catch (_) {} }
        }
    }

    /**
     * Redis answered — restore distributed mode with the same exactly-once
     * discipline: fallbacks closed first, then Bull registration. On any
     * failure we land back in fallback with every job still scheduled.
     */
    async _restoreBull() {
        if (this._transitioning) return;
        this._transitioning = true;
        try {
            const { Queue, Worker } = require('bullmq');
            const Redis = require('ioredis');
            const isTLS = process.env.REDIS_URL.startsWith('rediss://');
            const conn = new Redis(process.env.REDIS_URL, {
                maxRetriesPerRequest: null,
                enableReadyCheck: true,
                lazyConnect: false,
                retryStrategy: (times) => Math.min(RETRY_FLOOR_MS * Math.pow(2, Math.min(times - 1, 5)), RETRY_CAP_MS),
                ...(isTLS ? { tls: { rejectUnauthorized: false } } : {}),
            });
            await _withTimeout(conn.ping(), BOOT_PING_TIMEOUT_MS, 'Redis restore PING');
            conn.disconnect();

            // Close every fallback timer FIRST — a job must never tick through
            // both mechanisms at once.
            this._shutdownFallbacks();

            this.redisConnection = new Redis(process.env.REDIS_URL, {
                maxRetriesPerRequest: null,
                enableReadyCheck: true,
                lazyConnect: false,
                retryStrategy: (times) => Math.min(RETRY_FLOOR_MS * Math.pow(2, Math.min(times - 1, 5)), RETRY_CAP_MS),
                ...(isTLS ? { tls: { rejectUnauthorized: false } } : {}),
            });
            this._installBreakerHooks(this.redisConnection);
            this.Queue = Queue;
            this.Worker = Worker;

            for (const [name, job] of this.jobs) {
                if (!this.queues.has(name)) {
                    await _withTimeout(this._registerBull(name, job.cronExpr, job.handler), this.addTimeoutMs, `queue.add ${name}`);
                }
            }
            this.useBull = true;
            this.mode = 'distributed';
            this.breakerTripped = false;
            this._consecutiveErrors = 0;
            await this._stopProbe();
            this._logMode(`Redis recovered — BullMQ restored for ${this.queues.size}/${this.jobs.size} jobs`);
        } catch (err) {
            logger.warn(`[BullScheduler] Redis recovery incomplete (${err.message}) — remaining in single-instance fallback`);
            // Guarantee nothing is lost: every job must be scheduled in exactly
            // one mode even if the restore half-failed.
            await this._shutdownBull().catch(() => {});
            this.useBull = false;
            this.mode = 'single_instance_fallback';
            for (const [name, job] of this.jobs) {
                if (!this.fallbacks.has(name)) {
                    this._registerFallback(name, job.cronExpr, job.handler, job.opts);
                }
            }
        } finally {
            this._transitioning = false;
        }
    }

    /**
     * Register a scheduled job. The job is recorded in the mode-independent
     * registry FIRST, so a mode switch (breaker trip / restore) can always
     * re-register it in the other mechanism without the original call site.
     *
     * Registration guarantee: a job ends up in EXACTLY ONE mechanism — a
     * Bull registration failure trips the breaker and lands the whole fleet
     * in fallback (consistent single mode), and a fallback registration
     * failure is a hard boot error (neither mode can schedule it → crash
     * startup rather than silently omit a worker).
     */
    async register(name, cronExpr, handler, opts = {}) {
        this.jobs.set(name, { cronExpr, handler, opts });

        if (this.useBull) {
            try {
                await _withTimeout(this._registerBull(name, cronExpr, handler), this.addTimeoutMs, `queue.add ${name}`);
                return;
            } catch (err) {
                // Mid-boot Bull failure (or a breaker trip racing us): demote
                // the whole fleet to fallback so no job sits in mixed modes.
                await this._trip(`Bull registration failed for "${name}"`, err.message);
            }
        }

        if (!this.useBull && !this.fallbacks.has(name)) {
            try {
                this._registerFallback(name, cronExpr, handler, opts);
            } catch (err) {
                // Neither mode can schedule this job — that must never be
                // silent. Crash the boot (README documents the contract).
                logger.error({ err: err.message, job: name }, `[BullScheduler] FATAL: cannot schedule "${name}" in any mode`);
                throw err;
            }
        }
    }

    /**
     * BullMQ registration — creates a Queue + Worker, adds a repeatable job.
     */
    async _registerBull(name, cronExpr, handler) {
        const connection = this.redisConnection;

        // One queue per job type (shared name for queue + worker)
        const queue = new this.Queue(name, { connection });
        this.queues.set(name, queue);

        const worker = new this.Worker(name, async (job) => {
            try {
                await handler(job);
            } catch (err) {
                logger.error({ err: err.message, job: name }, `[BullScheduler] Job ${name} failed`);
                throw err; // let BullMQ handle retries
            }
        }, {
            connection,
            // Only one concurrent job per worker — scheduled ticks are serial
            concurrency: 1,
        });

        worker.on('error', (err) => this._onWorkerError(name, err));
        this.workers.set(name, worker);

        // Determine if cronExpr is a cron pattern or a millisecond interval
        const isCronPattern = /[^\d]/.test(cronExpr) && cronExpr.includes(' ');

        const repeatOpts = isCronPattern
            ? { repeat: { pattern: cronExpr }, removeOnComplete: 10, removeOnFail: 50 }
            : { repeat: { every: parseInt(cronExpr, 10) }, removeOnComplete: 10, removeOnFail: 50 };

        // Return the add promise so register() can race it with a timeout —
        // with maxRetriesPerRequest: null a dead Redis would otherwise hang
        // here forever and silently drop the job.
        const addPromise = queue.add(`${name}-repeat`, {}, repeatOpts);
        addPromise.catch(() => {}); // outcome is owned by register()'s timeout
        await addPromise;
        logger.info(`[BullScheduler] Registered "${name}" ${isCronPattern ? `on cron: ${cronExpr}` : `every ${parseInt(cronExpr, 10)}ms`} (distributed)`);
    }

    /**
     * Worker-level errors: throttle the log (the quota incident produced
     * ~100 lines/sec), and classify for the breaker. Only connection/infra
     * error classes count — job handler failures never trip it.
     */
    _onWorkerError(name, err) {
        const msg = String(err?.message || err);
        const now = Date.now();
        const last = this._workerErrorLogAt.get(name) || 0;
        if (now - last > WORKER_ERROR_LOG_THROTTLE_MS) {
            this._workerErrorLogAt.set(name, now);
            logger.error({ err: msg, worker: name }, `[BullScheduler] Worker ${name} error`);
        }
        if (FATAL_ERROR_RE.test(msg) || CONNECTION_ERROR_RE.test(msg)) {
            this._onRedisError(err);
        }
    }

    /**
     * Fallback registration — uses node-cron for cron patterns, setInterval
     * for numeric intervals. Identical to the pre-BullMQ behavior.
     */
    _registerFallback(name, cronExpr, handler, opts = {}) {
        const isCronPattern = /[^\d]/.test(cronExpr) && cronExpr.includes(' ');

        const wrappedHandler = async () => {
            try {
                await handler({});
            } catch (err) {
                logger.error({ err: err.message, worker: name }, `[BullScheduler:fallback] ${name} failed`);
            }
        };

        if (isCronPattern) {
            const cron = require('node-cron');
            const cronJob = cron.schedule(cronExpr, wrappedHandler);
            this.fallbacks.set(name, { type: 'cron', cronJob });
            logger.info(`[BullScheduler:fallback] Registered "${name}" on cron: ${cronExpr}`);
        } else {
            const intervalMs = opts.fallbackIntervalMs || parseInt(cronExpr, 10);
            // Fire immediately on start, then on interval (matches existing worker behavior)
            wrappedHandler();
            const timer = setInterval(wrappedHandler, intervalMs);
            timer.unref?.();
            this.fallbacks.set(name, { type: 'interval', timer });
            logger.info(`[BullScheduler:fallback] Registered "${name}" every ${intervalMs}ms`);
        }
    }

    _shutdownFallbacks() {
        for (const [, fb] of this.fallbacks) {
            if (fb.type === 'cron') fb.cronJob.stop();
            else if (fb.type === 'interval') clearInterval(fb.timer);
        }
        this.fallbacks.clear();
    }

    /**
     * Manually trigger a job (useful for testing / admin endpoints).
     */
    async triggerNow(name) {
        if (this.useBull) {
            const queue = this.queues.get(name);
            if (queue) {
                await queue.add(`${name}-manual`, { manual: true });
                logger.info(`[BullScheduler] Manually triggered "${name}"`);
            }
        }
    }

    /**
     * Graceful shutdown — close all workers and queues in whichever mode is active.
     */
    async closeAll() {
        logger.info('[BullScheduler] Shutting down...');
        await this._stopProbe();
        this._shutdownFallbacks();
        if (!this.useBull) return;
        await this._shutdownBull();
        logger.info('[BullScheduler] Shutdown complete');
    }
}

/**
 * Get the singleton scheduler instance.
 */
function getScheduler() {
    if (!_instance) {
        _instance = new BullScheduler();
    }
    return _instance;
}

module.exports = { BullScheduler, getScheduler };
