// server.js
// =============================================================================
// WS6: Sentry must be the very first require so its auto-instrumentation can
// patch http/express/pg before they are loaded. No-op when SENTRY_DSN is unset.
const Sentry = require('./instrument');
const logger = require('./src/config/logger');

// =============================================================================
// AZAMAN V3 — PRODUCTION-HARDENED SERVER
//
// SECURITY FIXES APPLIED:
//   CRITICAL-3: Rate limiting on all route tiers
//   CRITICAL-4: Socket.IO JWT authentication middleware
//   CRITICAL-5: vendor_accept authorization check
//   HIGH-1:     Helmet security headers
//   HIGH-2:     CORS locked to configured origins
//   HIGH-4:     Error message sanitization in production
//   HIGH-5:     Fixed mark_messages_read (removed non-existent fields)
//   HIGH-9:     File upload validation (type + size)
//   HIGH-10:    Admin spy room role verification
//   ADDED:      Health check endpoint + graceful shutdown
// =============================================================================

const express = require('express');
const cron = require('node-cron');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const socketRateLimiter = require('./middleware/socketRateLimiter');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// ── Startup Validation ───────────────────────────────────────────────────────
// CRITICAL-2: Fail fast if essential env vars are missing
if (!process.env.JWT_SECRET) {
    logger.fatal('JWT_SECRET is not set. Server cannot start.');
    process.exit(1);
}
// A short secret is brute-forceable and silently weakens every token. Enforce
// at least 32 chars (256 bits) so a misconfigured deploy fails loudly at boot
// instead of running with weak auth.
if (process.env.JWT_SECRET.length < 32) {
    logger.fatal('JWT_SECRET must be at least 32 characters (256 bits). Server cannot start.');
    process.exit(1);
}
if (!process.env.DATABASE_URL) {
    logger.fatal('DATABASE_URL is not set. Server cannot start.');
    process.exit(1);
}

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET;

// ── Health/observability holders (D-05) ──────────────────────────────────────
// Populated later as components come online; read by GET /health. Kept at
// module scope so the health handler (defined before workers start) can close
// over them and report live state per-request.
const APP_VERSION = require('./package.json').version;
// kind ('cron' workers etc.) -> 'running'. Filled in as each worker .start()s.
const workerStatus = {};
// 'not_configured' until B-07 wires the Socket.IO Redis adapter; then
// 'connected' / 'disconnected' driven by the ioredis client events.
let redisStatus = 'not_configured';

// ── Socket helpers (extracted to src/sockets/helpers.js) ─────────────────────
const { createPushIfOffline, createEmitBalanceUpdate } = require('./src/sockets/helpers');

// --- RATE LIMITING (CRITICAL-3) ---
const {
    authLimiter,
    financialLimiter,
    generalLimiter,
    webhookLimiter
} = require('./middleware/rateLimitMiddleware');

// ── Base Services (extracted to src/config/baseServices.js) ──────────────────
const {
    pool, prisma, marketOracle, gatewayService,
    mtnDisbursementService, moolreCollectionService,
    paymentFailoverService,
    tatumService, emailService, smsService,
} = require('./src/config/baseServices');

// ── Upload Config (extracted to src/config/upload.js) ────────────────────────
const { upload } = require('./src/config/upload');


const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

// ══════════════════════════════════════════════════════════════════════════════
// 3. MIDDLEWARES (extracted to src/middleware/appMiddleware.js)
// ══════════════════════════════════════════════════════════════════════════════

const { configureMiddleware } = require('./src/middleware/appMiddleware');
const { corsOrigins } = configureMiddleware(app, { IS_PRODUCTION });

// ── Health Check + Admin Susu Release (extracted to src/routes/health.js) ──────
const { mountHealthRoutes } = require('./src/routes/health');
mountHealthRoutes(app, { prisma, workerStatus, redisStatusRef: () => redisStatus, APP_VERSION, IS_PRODUCTION });

// ══════════════════════════════════════════════════════════════════════════════
// 4. REAL-TIME ENGINE (Socket.IO)
// ══════════════════════════════════════════════════════════════════════════════

const io = new Server(server, {
    cors: {
        origin: corsOrigins.includes('*') ? '*' : corsOrigins,
        methods: ["GET", "POST"],
        credentials: true
    }
});

// ── B-07: optional Socket.IO Redis adapter for horizontal scaling ────────────
// The default in-memory adapter can't fan events out across processes, so
// running >1 backend instance silently breaks real-time delivery (a socket on
// instance A never hears an io.emit issued on instance B). When REDIS_URL is
// set, swap in the Redis pub/sub adapter so all instances share one event bus
// and PM2 cluster mode / multiple dynos work correctly. When it's unset (local
// dev, single-instance deploys) the server runs exactly as before — Redis is
// strictly opt-in. All io.emit / io.in(room).emit callsites are unchanged.
if (process.env.REDIS_URL) {
    try {
        const { createAdapter } = require('@socket.io/redis-adapter');
        const { Redis } = require('ioredis');
        const isTLS = process.env.REDIS_URL.startsWith('rediss://');
        const pubClient = new Redis(process.env.REDIS_URL, isTLS ? { tls: {} } : {});
        const subClient = pubClient.duplicate();
        pubClient.on('connect', () => { redisStatus = 'connected'; });
        pubClient.on('error', (e) => {
            redisStatus = 'disconnected';
            logger.error({ err: e }, 'Redis adapter error');
        });
        io.adapter(createAdapter(pubClient, subClient));
        logger.info('Socket.IO Redis adapter enabled (multi-instance mode)');
    } catch (e) {
        // Don't take the whole server down over a missing optional dep or a
        // bad URL — fall back to the in-memory adapter (single-instance only).
        redisStatus = 'disconnected';
        logger.error({ err: e }, 'Redis adapter init failed, using in-memory adapter');
    }
} else {
    logger.info('REDIS_URL not set — Socket.IO using in-memory adapter (single instance)');
}

// ── STARTUP: warn if Cloudinary not configured (profile pics will use local disk) ──
if (process.env.NODE_ENV === 'production' &&
    !(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)) {
    logger.warn('CLOUDINARY credentials not set. Profile pictures & media uploads will be saved to EPHEMERAL local disk — files lost on redeploy. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.');
}

// CRITICAL-4: Socket.IO JWT Authentication (extracted to src/sockets/socketAuth.js)
const { createSocketAuthMiddleware } = require('./src/sockets/socketAuth');
io.use(createSocketAuthMiddleware(JWT_SECRET));

// ── Socket Services (extracted to src/sockets/socketServices.js) ──────────────
const { createSocketServices } = require('./src/sockets/socketServices');
const {
    tradeSocketService, chatSocketService, groupChatSocketService,
    friendSocketService, ticketSocketService, notificationService,
    vendorStatus,
} = createSocketServices(io, prisma, app);

// ── Treasury boot (extracted to src/boot/treasury.js) ────────────────────────
const { bootTreasury } = require('./src/boot/treasury');
bootTreasury(app, prisma);

// ── Service Registry (extracted to src/services/registry.js) ──────────────────
const { registerServices } = require('./src/services/registry');
const {
    kycService,
    rateAlertService,
    vaultService,
    groupChatService,
    smartRouteService,
    azmAuctionService,
    adminAlertService,
    storyService,
    susuService,
    susuInitiationService,
} = registerServices(app, {
    prisma,
    io,
    notificationService,
    marketOracle,
    gatewayService,
    mtnDisbursementService,
    moolreCollectionService,
    emailService,
    smsService,
    tatumService,
});

// The KYC service runs webhook processing outside the request lifecycle (no
// req.app handle), so hand it the alert service directly.
kycService.adminAlertService = adminAlertService;

const IS_TEST_ENV = process.env.NODE_ENV === 'test';

// ── Worker Registry (extracted to src/workers/index.js) ──────────────────────
const { startWorkers } = require('./src/workers/index');
const workersPromise = startWorkers(app, {
    prisma,
    io,
    workerStatus,
    tradeSocketService,
    mtnDisbursementService,
    paymentFailoverService,
    emailService,
    smsService,
    notificationService,
    vaultService,
    susuService,
    smartRouteService,
    azmAuctionService,
    susuInitiationService,
});
let tradeWorker, withdrawalReconciliationWorker;
let tradeWorkerReady = false;
workersPromise.then(result => {
    ({ tradeWorker, withdrawalReconciliationWorker } = result);
    tradeWorkerReady = true;
    // Start the trade worker now that it's instantiated.
    // Previously this was in the server.listen callback, but the async
    // workersPromise may not have resolved by the time the port is bound,
    // causing "Cannot read properties of undefined (reading 'start')".
    if (!IS_TEST_ENV && tradeWorker) {
        // Register tradeWorker intervals with BullMQ scheduler (no raw setInterval)
        const scheduler = getScheduler();
        scheduler.register('trade-milestones', String(60 * 1000), () => tradeWorker._checkMilestones());
        scheduler.register('trade-escrow-release', String(30 * 1000), () => tradeWorker._checkEscrowAutoRelease());
        workerStatus.tradeWorker = 'running';
    }
}).catch(err => logger.error({ err }, 'Worker startup error'));

// ── Socket helpers (pushIfOffline, emitBalanceUpdate) ──
const pushIfOffline = createPushIfOffline(io, prisma);
const emitBalanceUpdate = createEmitBalanceUpdate(io, prisma);

// ── Global app registrations (services already handled by registry) ──────────
app.set('socketio', io);
app.set('prisma', prisma);
app.set('vendorStatus', vendorStatus);
app.set('pushIfOffline', pushIfOffline);
app.set('emitBalanceUpdate', emitBalanceUpdate);

// ── Storefront Stake + Keep-Alive + Stories cron (registered via scheduler) ──
const storefrontStakeWorker = require('./workers/storefrontStakeWorker');
const keepAliveWorker = require('./workers/keepAliveWorker');
const { getScheduler } = require('./src/lib/bullScheduler');
(async () => {
    const scheduler = getScheduler();
    // Storefront stake: daily tier check + hourly unstake queue
    await scheduler.register('storefront-stake-daily', String(24 * 60 * 60 * 1000), () => storefrontStakeWorker.dailyStakeCheckTick(prisma));
    await scheduler.register('storefront-stake-unstake', String(60 * 60 * 1000), () => storefrontStakeWorker.processUnstakeQueueTick(prisma));
    // Keep-alive: ping external services every 5 min
    await scheduler.register('keep-alive', String(5 * 60 * 1000), () => keepAliveWorker.pingAll());
    // Stories expiration
    await scheduler.register('stories-expire', '*/15 * * * *', () => app.get('storyService')?.expireOldStories().catch(err => logger.error({ err }, 'StoryCron error')));
})();

// ══════════════════════════════════════════════════════════════════════════════
// API VERSIONING + RESPONSE ENVELOPE (additive, non-breaking)
// ══════════════════════════════════════════════════════════════════════════════
// ── Route Registry (extracted to src/routes/index.js) ───────────────────────
const { captureMountPaths } = require('./src/config/openapiGenerator');
captureMountPaths(app);

const { mountRoutes } = require('./src/routes/index');
mountRoutes(app, {
    authLimiter,
    financialLimiter,
    generalLimiter,
    webhookLimiter,
});


// ── OpenAPI Spec Endpoint ─────────────────────────────────────────────────────
const { serveSpec } = require('./src/config/openapiGenerator');
app.get('/api/docs/openapi.json', serveSpec(app));
// ══════════════════════════════════════════════════════════════════════════════
// REAL-TIME CONNECTIONS (Authenticated — CRITICAL-4)
// ══════════════════════════════════════════════════════════════════════════════

// ── Socket event handlers (extracted to src/sockets/connectionHandler.js) ──
const { setupSocketHandlers } = require('./src/sockets/connectionHandler');
setupSocketHandlers(io, {
    prisma,
    socketRateLimiter,
    tradeSocketService,
    chatSocketService,
    groupChatSocketService,
    friendSocketService,
    ticketSocketService,
    notificationService,
    pushIfOffline,
    emitBalanceUpdate,
});

// ══════════════════════════════════════════════════════════════════════════════
// ERROR HANDLING (extracted to src/middleware/errorHandler.js)
// ══════════════════════════════════════════════════════════════════════════════
const { mountErrorHandlers } = require('./src/middleware/errorHandler');
mountErrorHandlers(app, { Sentry, isProduction: IS_PRODUCTION });

// ══════════════════════════════════════════════════════════════════════════════
// START SERVER + GRACEFUL SHUTDOWN
// ══════════════════════════════════════════════════════════════════════════════

// Export the fully-built Express app so integration tests (supertest) can mount
// it without binding a port. Must come AFTER all routes + error handlers are
// registered (above) so the exported app is complete. See __tests__/auth.test.js.
module.exports = app;

const PORT = process.env.PORT || 3000;
// In test mode we never bind a port (supertest drives the app object directly),
// which also avoids EADDRINUSE and leaving a live listener after the suite ends.
if (!IS_TEST_ENV) {
    server.listen(PORT, '0.0.0.0', () => {
        logger.info({ port: PORT, env: IS_PRODUCTION ? 'production' : 'development' }, 'Azaman backend live');
        // tradeWorker.start() is handled by the workersPromise.then() callback
        // to avoid a race condition where the promise hadn't resolved yet.
    });
}

// Graceful shutdown handler
const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutdown signal received');

    // Stop accepting new connections
    server.close(() => {
        logger.info('Shutdown: HTTP server closed');
    });

    // Stop workers
    tradeWorker.stop();
    if (typeof withdrawalReconciliationWorker?.stop === 'function') {
        withdrawalReconciliationWorker.stop();
    }

    // Close BullMQ scheduler (all workers, queues, Redis connection)
    try {
        const { getScheduler } = require('./src/lib/bullScheduler');
        await getScheduler().closeAll();
    } catch (err) {
        logger.error({ err }, 'Shutdown: scheduler close error');
    }

    // Close socket connections
    io.close(() => {
        logger.info('Shutdown: Socket.IO closed');
    });

    // Disconnect Prisma
    try {
        await prisma.$disconnect();
        logger.info('Shutdown: database disconnected');
    } catch (err) {
        logger.error({ err }, 'Shutdown: Prisma disconnect error');
    }

    // Close PG pool
    try {
        await pool.end();
        logger.info('Shutdown: PG pool closed');
    } catch (err) {
        logger.error({ err }, 'Shutdown: pool close error');
    }

    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Prevent unhandled promise rejections from crashing the process silently
process.on('unhandledRejection', (reason, promise) => {
    logger.error({ reason }, 'Unhandled rejection');
});

// A synchronous throw outside any try/catch lands here. Node's default is to
// print and exit; we log explicitly first (stack included) so the crash is
// never silent, then exit non-zero so the process manager (PM2/Render) restarts
// us into a known-good state rather than limping on in an undefined one.
process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception');
    if (err && err.stack) logger.error({ err }, err.stack);
    process.exit(1);
});
