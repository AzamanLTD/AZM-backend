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
const { PrismaClient, Prisma } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const path = require('path');
const socketRateLimiter = require('./middleware/socketRateLimiter');
const multer = require('multer');
const fs = require('fs');
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

// ── Phase J3: Prisma Decimal → Number JSON Serialization ─────────────────────
// Prisma returns NUMERIC/DECIMAL columns as Decimal.js objects which serialize
// to strings in JSON ("12.50" instead of 12.50). This patch ensures they
// serialize as plain numbers for all res.json() calls and socket emissions.
// decimal.js's valueOf() returns a string by default — we override it to
// return a number so that arithmetic operators (+, -, *, /, <, >) work
// correctly with Decimal fields in controller code without explicit casts.
Prisma.Decimal.prototype.toJSON = function () {
    return Number(this.toString());
};
Prisma.Decimal.prototype.valueOf = function () {
    return Number(this.toString());
};

// --- FIREBASE CLOUD MESSAGING ---
const { sendPushNotification } = require('./utils/firebaseService');

// --- RATE LIMITING (CRITICAL-3) ---
const {
    authLimiter,
    financialLimiter,
    generalLimiter,
    webhookLimiter
} = require('./middleware/rateLimitMiddleware');

// 1. Initialize PostgreSQL Connection Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected error on idle client');
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Test database connection on startup
(async () => {
    try {
        await prisma.$connect();
        logger.info('Prisma connected successfully');
    } catch (error) {
        logger.error({ err: error }, 'Database connection failed');
        process.exit(1);
    }
})();

// --- LIVE MARKET ORACLE ---
const OracleService = require('./services/oracleService');
const marketOracle = new OracleService(prisma);
marketOracle.startOracle();

// --- KOTANI PAY V3 GATEWAY ---
const GatewayService = require('./services/gatewayService');
const gatewayService = new GatewayService(prisma);
gatewayService.startRateSync();

// --- FIAT OFF-RAMP DISBURSEMENT (Moolre — primary; MTN MoMo — fallback) ──────
// The off-ramp provider is bound to ONE variable (`mtnDisbursementService`) that
// every consumer reads (finance.controller, withdrawalReconciliationWorker,
// payoutBatchWorker, smartRouteService). Because MoolreDisbursementService
// mirrors the MTN adapter's public method shape EXACTLY
// (initiateTransfer / getTransferStatus / newReferenceId / simulateInboundWebhook,
// and deliberately NO `dispatch`), swapping which class backs that variable
// changes the provider for the whole platform with zero consumer edits.
//
// The legacy MTN wiring is preserved (commented) directly below as a safe
// fallback — to revert, comment the Moolre block and uncomment the MTN block.

// ── PRIMARY: Moolre ───────────────────────────────────────────────────────────
const MoolreDisbursementService = require('./services/moolreDisbursementService');
const mtnDisbursementService = new MoolreDisbursementService();

// --- FIAT ON-RAMP COLLECTION (Moolre — 2026-06-23) ───────────────────────────
// Inbound sibling of the disbursement adapter above: PIN-push MoMo deposits.
// Bound under 'moolreCollectionService' (depositController reads it via
// req.app.get). Pure I/O adapter — no Prisma, MOCK unless MOOLRE_PROVIDER=LIVE.
const MoolreCollectionService = require('./services/moolreCollectionService');
const moolreCollectionService = new MoolreCollectionService();

// Startup guard: the Moolre settlement webhook hard-disables itself (503) if
// MOOLRE_WEBHOOK_SECRET is unset, so warn loudly at boot to make the disabled
// endpoint obvious instead of silently rejecting every callback in production.
if (!process.env.MOOLRE_WEBHOOK_SECRET) {
    logger.warn('MOOLRE_WEBHOOK_SECRET is not set — webhook endpoint is disabled');
}

// ── FALLBACK: MTN MoMo (kept intact — uncomment to revert) ────────────────────
// const MtnDisbursementService = require('./services/mtnDisbursementService');
// const mtnDisbursementService = new MtnDisbursementService();

// --- TATUM WEB3 SERVICE ---
const TatumService = require('./services/tatumService');
const tatumService = new TatumService();

// --- EMAIL SERVICE (Phase L1) ---
// Stateless aside from in-memory token-store + provider config (env-driven).
// Singleton: instantiated once here, shared across the worker (constructor
// arg) and request handlers (req.app.get('emailService')). Defaults to
// MOCK provider — set EMAIL_PROVIDER + EMAIL_API_KEY to flip to a real
// transport. All sends from the receipt surface are fire-and-forget.
const EmailService = require('./services/emailService');
const emailService = new EmailService();

// --- SMS SERVICE (Phase L2) ---
// Mirrors the emailService singleton pattern. OTP state is stored in-memory
// (use Redis in production for multi-process). Defaults to MOCK provider —
// set SMS_PROVIDER + SMS_API_KEY in .env for real delivery. Shared across
// security routes (phone OTP) and withdrawal controller (large-withdrawal
// confirmations). All transactional sends are fire-and-forget.
const SMSService = require('./services/smsService');
const smsService = new SMSService();

// --- MULTER SETUP (HIGH-9: Validated file uploads) ---
const uploadDir = 'uploads/proofs/';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// HIGH-9: File type validation — only allow images
// Accepts both MIME type check AND file extension check because Android
// devices frequently report incorrect MIME types (application/octet-stream)
// for camera captures.
const imageFileFilter = (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'];
    const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif'];
    const ext = path.extname(file.originalname).toLowerCase();
    const mimeOk = allowedMimes.includes(file.mimetype);
    const extOk = allowedExts.includes(ext);
    if (mimeOk || extOk) {
        cb(null, true);
    } else {
        cb(new Error('Only image files (JPEG, PNG, GIF, WebP, HEIC) are allowed.'), false);
    }
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

// HIGH-9: 5MB limit + image-only filter
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: imageFileFilter
});


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

// CRITICAL-4: Socket.IO JWT Authentication Middleware
io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');

    if (!token) {
        return next(new Error('Authentication required: No token provided.'));
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (!decoded.id) {
            return next(new Error('Authentication failed: Invalid token structure.'));
        }
        socket.user = decoded; // Attach user context to socket
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return next(new Error('Authentication failed: Token expired.'));
        }
        return next(new Error('Authentication failed: Invalid token.'));
    }
});

const vendorStatus = new Map();


// --- TRADE SOCKET SERVICE ---
const TradeSocketService = require('./services/tradeSocketService');
const tradeSocketService = new TradeSocketService(io, prisma);

// --- CHAT SOCKET SERVICE ---
const ChatSocketService = require('./services/chatSocketService');
const chatSocketService = new ChatSocketService(io, prisma);

const GroupChatSocketService = require('./services/groupChatSocketService');
const groupChatSocketService = new GroupChatSocketService(io, prisma);

// --- FRIEND SOCKET SERVICE ---
const FriendSocketService = require('./services/friendSocketService');
const friendSocketService = new FriendSocketService(io, prisma);

// --- TICKET SOCKET SERVICE (Phase UI-4, 2026-05-26) ---
const TicketSocketService = require('./services/ticketSocketService');
const ticketSocketService = new TicketSocketService(io, prisma);

// --- NOTIFICATION SERVICE (canonical persistence + emit) ---
const NotificationService = require('./services/notificationService');
const notificationService = new NotificationService(prisma, io);
app.set('notificationService', notificationService);

// --- ADMIN_DISPUTE_ESCROW (Private Susu Ecosystem, 2026-05-31) ───────────────
// Cache the treasury wallet's User id at startup so cycle workers and
// service code can look it up via req.app.get('azamanTreasuryUserId') in
// O(1) instead of querying every cycle.
//
// Boot-time auto-release (Susu Sprint, 2026-06-01): free-tier hosting has
// no Shell / Pre-Deploy hook, so we run the one-time, idempotent
// migrate + seed step here at boot (infra/autoRelease.js). It only does
// work when the treasury row is missing, never blocks request handling,
// and never crashes the process. Once it seeds, the treasury cache below
// resolves on its retry and Susu comes online — no redeploy required.
//
// Resilience: the treasury check is intentionally NON-FATAL. The treasury
// row is required for the escrow-diversion path (Req 10.8) and self-default
// seizure routing (Req 11.3), but a missing
// row must NOT take down the entire backend (trades, wallet, chat, etc.).
// If the seed hasn't run yet, we log a loud warning, leave
// `azamanTreasuryUserId` unset, and let the Susu cycle workers skip
// themselves (they already guard on the cache resolving — see the
// startV2Workers poll below). Once `node infra/seed-susu-foundation.js`
// runs and the service restarts, the id resolves and Susu comes online.
// A self-heal retry also re-checks every 60s so a seed applied while the
// process is live is picked up without a restart.
const { autoRelease } = require('./infra/autoRelease');
(async () => {
    const cacheTreasury = async () => {
        const treasury = await prisma.user.findUnique({
            where: { username: 'azaman-treasury' },
            select: { id: true },
        });
        if (treasury) {
            app.set('azamanTreasuryUserId', treasury.id);
            return treasury.id;
        }
        return null;
    };

    try {
        // Run the boot release (installer converges schema; seed is
        // internally gated on treasury-missing). This lands additive
        // columns/tables on every deploy without prisma migrate (prod Neon
        // is db push-managed behind a pooler — see infra/autoRelease.js).
        // Skipped under test: CI applies the schema via `prisma db push`, and
        // booting auth.test.js must not trigger the installer/seed path.
        if (process.env.NODE_ENV !== 'test') {
            await autoRelease(prisma);

            // Apply business OS schema additions (Modules 01+03) idempotently.
            // Same pattern as the susu overlay: plain DDL with IF NOT EXISTS guards.
            try {
                const { execSync } = require('child_process');
                execSync('node infra/install-business-os-overlay.js', { stdio: 'inherit', timeout: 30000 });
            } catch (e) {
                logger.warn({ err: e }, 'business-os-overlay: boot-time install skipped');
            }
        }

        // Resolve + cache the treasury id (seeded by autoRelease if it was
        // missing).
        const id = await cacheTreasury();

        if (id) {
            logger.info({ userId: id }, 'Susu: treasury wallet cached');
        } else {
            logger.warn('Susu: azaman-treasury User row not found after auto-release. Susu escrow/cycle features are DISABLED until it is seeded. Retrying every 60s.');
            const retry = setInterval(async () => {
                try {
                    const rid = await cacheTreasury();
                    if (rid) {
                        logger.info({ userId: rid }, 'Susu: treasury wallet cached on retry');
                        clearInterval(retry);
                    }
                } catch (e) {
                    logger.warn({ err: e }, 'Susu: treasury retry failed');
                }
            }, 60_000);
            retry.unref?.();
        }
    } catch (err) {
        // Non-fatal: log and continue. Susu stays dark; everything else runs.
        logger.warn({ err }, 'Susu: treasury wallet cache failed (non-fatal)');
    }
})();

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
const { tradeWorker, withdrawalReconciliationWorker } = startWorkers(app, {
    prisma,
    io,
    workerStatus,
    tradeSocketService,
    mtnDisbursementService,
    emailService,
    smsService,
    notificationService,
    vaultService,
    susuService,
    smartRouteService,
    azmAuctionService,
    susuInitiationService,
});

// --- OFFLINE PUSH HELPER ---
const pushIfOffline = async (userId, title, body, extra = {}) => {
    try {
        if (!userId) return;
        const room = `user_${userId}`;
        const sockets = await io.in(room).allSockets();
        if (sockets && sockets.size > 0) return;

        const user = await prisma.user.findUnique({
            where: { id: parseInt(userId) },
            select: { fcmToken: true }
        });
        if (!user || !user.fcmToken) return;

        await sendPushNotification(user.fcmToken, title, body, extra);
    } catch (err) {
        logger.error({ err }, 'pushIfOffline error');
    }
};

const emitBalanceUpdate = async (userId) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: parseInt(userId) },
            select: {
                availableBalance: true,
                vendorUnallocatedBalance: true,
                escrowLockedBalance: true,
                disputeEscrowBalance: true,
                azmBalance: true
            }
        });
        if (user) {
            io.to(`balance_room_${userId}`).emit('balance_update', {
                availableBalance: user.availableBalance,
                vendorUnallocatedBalance: user.vendorUnallocatedBalance,
                escrowLockedBalance: user.escrowLockedBalance,
                disputeEscrowBalance: user.disputeEscrowBalance,
                azmBalance: user.azmBalance,
                currency: 'USDC'
            });
        }
    } catch (err) {
        logger.error({ err }, "Balance emit error");
    }
};

// ── Global app registrations (services already handled by registry) ──────────
app.set('socketio', io);
app.set('prisma', prisma);
app.set('vendorStatus', vendorStatus);
app.set('pushIfOffline', pushIfOffline);
app.set('emitBalanceUpdate', emitBalanceUpdate);

// ── Storefront Stake Worker ──────────────────────────────────────────────────
const storefrontStakeWorker = require('./workers/storefrontStakeWorker');
storefrontStakeWorker.start(prisma);

// ── Keep-Alive Worker (prevents external services from sleeping) ─────────────
const keepAliveWorker = require('./workers/keepAliveWorker');
keepAliveWorker.start();

// Stories expiration cron
cron.schedule('*/15 * * * *', () => {
    app.get('storyService').expireOldStories().catch(err => logger.error({ err }, 'StoryCron error'));
});

// ══════════════════════════════════════════════════════════════════════════════
// API VERSIONING + RESPONSE ENVELOPE (additive, non-breaking)
// ══════════════════════════════════════════════════════════════════════════════
// ── Route Registry (extracted to src/routes/index.js) ───────────────────────
const { mountRoutes } = require('./src/routes/index');
mountRoutes(app, {
    authLimiter,
    financialLimiter,
    generalLimiter,
    webhookLimiter,
});

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
// ERROR HANDLING
// ══════════════════════════════════════════════════════════════════════════════

// 404 catch-all
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint not found', path: req.originalUrl });
});

// WS6: Sentry error handler — must come AFTER all controllers/routes and the
// 404 catch-all, but BEFORE our own error responder so the exception is
// captured first, then formatted for the client below. No-op without SENTRY_DSN.
if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
}

// HIGH-4: Global error handler — sanitize in production
app.use((err, req, res, next) => {
    logger.error({ err }, 'Server error');
    if (!IS_PRODUCTION) {
        logger.error({ err }, err.stack);
    }

    // Multer file size error
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
            success: false,
            message: 'File too large. Maximum size is 5MB.'
        });
    }

    // Multer file type error
    if (err.message && err.message.includes('Only image files')) {
        return res.status(400).json({
            success: false,
            message: err.message
        });
    }

    res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        // HIGH-4: Only expose details in non-production
        ...(IS_PRODUCTION ? {} : { details: err.message })
    });
});

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
        tradeWorker.start();
        workerStatus.tradeWorker = 'running';
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
