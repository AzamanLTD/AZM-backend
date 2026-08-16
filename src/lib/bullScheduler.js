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
// Graceful degradation: if REDIS_URL is not set, the scheduler falls
// back to in-process setInterval / node-cron — identical to the pre-BullMQ
// behavior. This keeps local dev and single-instance deploys zero-config.
//
// Usage (from src/workers/index.js):
//
//   const { getScheduler } = require('../lib/bullScheduler');
//   const scheduler = getScheduler();
//
//   // Register a worker — its run() method fires on the cron schedule.
//   // Only ONE instance picks up each tick.
//   await scheduler.register('savings', '0 * * * *', async (job) => {
//       await savingsWorker._checkReminders();
//   });
//
//   // Graceful shutdown
//   await scheduler.closeAll();
// =============================================================================

const logger = require('../config/logger');

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
        this.redisConnection = null;
        this.useBull = false;
    }

    /**
     * Initialise the Redis connection. Called once at boot.
     * If REDIS_URL is missing or connection fails, we operate in fallback mode.
     */
    async init() {
        if (!process.env.REDIS_URL) {
            logger.info('[BullScheduler] No REDIS_URL — using in-process fallback (single-instance mode)');
            this.useBull = false;
            return;
        }

        try {
            const { Queue, Worker } = require('bullmq');
            const Redis = require('ioredis');

            // Dedicated connection for BullMQ (separate from Socket.IO / rate limiter)
            const isTLS = process.env.REDIS_URL.startsWith('rediss://');
            this.redisConnection = new Redis(process.env.REDIS_URL, {
                maxRetriesPerRequest: null,  // BullMQ requires this
                enableReadyCheck: true,
                lazyConnect: false,
                ...(isTLS ? { tls: { rejectUnauthorized: false } } : {}),
            });

            this.redisConnection.on('error', (err) => {
                logger.warn({ err: err.message }, '[BullScheduler] Redis error (operating in degraded mode)');
            });

            this.redisConnection.on('connect', () => {
                logger.info('[BullScheduler] Redis connected — multi-instance safe scheduling active');
            });

            this.Queue = Queue;
            this.Worker = Worker;
            this.useBull = true;
        } catch (err) {
            logger.warn({ err: err.message }, '[BullScheduler] Failed to init Redis, using in-process fallback');
            this.useBull = false;
        }
    }

    /**
     * Register a scheduled job. The `handler` fires on the given cron
     * expression. In BullMQ mode, only one instance processes each tick.
     * In fallback mode, uses node-cron or setInterval.
     *
     * @param {string} name      - Unique job name (also used as queue name)
     * @param {string} cronExpr  - Cron expression (e.g. cron expressions and intervals)
     *                              or a millisecond interval string like '60000'
     * @param {function} handler - async (job) => void — the work to do
     * @param {object} [opts]    - { fallbackIntervalMs } override for fallback mode
     */
    async register(name, cronExpr, handler, opts = {}) {
        if (this.useBull) {
            await this._registerBull(name, cronExpr, handler);
        } else {
            this._registerFallback(name, cronExpr, handler, opts);
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

        worker.on('error', (err) => {
            logger.error({ err: err.message, worker: name }, `[BullScheduler] Worker ${name} error`);
        });

        this.workers.set(name, worker);

        // Determine if cronExpr is a cron pattern or a millisecond interval
        const isCronPattern = /[^\d]/.test(cronExpr) && cronExpr.includes(' ');

        if (isCronPattern) {
            // Standard cron expression
            await queue.add(
                `${name}-repeat`,
                {},
                {
                    repeat: { pattern: cronExpr },
                    removeOnComplete: 10,
                    removeOnFail: 50,
                }
            );
            logger.info(`[BullScheduler] Registered "${name}" on cron: ${cronExpr}`);
        } else {
            // Millisecond interval (e.g. '60000' = every 60s)
            const intervalMs = parseInt(cronExpr, 10);
            await queue.add(
                `${name}-repeat`,
                {},
                {
                    repeat: { every: intervalMs },
                    removeOnComplete: 10,
                    removeOnFail: 50,
                }
            );
            logger.info(`[BullScheduler] Registered "${name}" every ${intervalMs}ms`);
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
            this.fallbacks.set(name, { type: 'interval', timer });
            logger.info(`[BullScheduler:fallback] Registered "${name}" every ${intervalMs}ms`);
        }
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
     * Graceful shutdown — close all workers and queues.
     */
    async closeAll() {
        logger.info('[BullScheduler] Shutting down...');

        // Close fallbacks
        for (const [name, fb] of this.fallbacks) {
            if (fb.type === 'cron') fb.cronJob.stop();
            else if (fb.type === 'interval') clearInterval(fb.timer);
        }
        this.fallbacks.clear();

        if (!this.useBull) return;

        // Close BullMQ workers
        const workerCloses = [];
        for (const [name, worker] of this.workers) {
            workerCloses.push(worker.close());
        }
        await Promise.allSettled(workerCloses);
        this.workers.clear();

        // Close queues
        const queueCloses = [];
        for (const [name, queue] of this.queues) {
            queueCloses.push(queue.close());
        }
        await Promise.allSettled(queueCloses);
        this.queues.clear();

        // Close Redis connection
        if (this.redisConnection) {
            await this.redisConnection.quit().catch(() => {});
        }

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
