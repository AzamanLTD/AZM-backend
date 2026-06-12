// server.js
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
const http = require('http');
const { Server } = require('socket.io');
const { PrismaClient, Prisma } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// ── Startup Validation ───────────────────────────────────────────────────────
// CRITICAL-2: Fail fast if essential env vars are missing
if (!process.env.JWT_SECRET) {
    console.error('FATAL: JWT_SECRET is not set. Server cannot start.');
    process.exit(1);
}
// A short secret is brute-forceable and silently weakens every token. Enforce
// at least 32 chars (256 bits) so a misconfigured deploy fails loudly at boot
// instead of running with weak auth.
if (process.env.JWT_SECRET.length < 32) {
    console.error('FATAL: JWT_SECRET must be at least 32 characters (256 bits). Server cannot start.');
    process.exit(1);
}
if (!process.env.DATABASE_URL) {
    console.error('FATAL: DATABASE_URL is not set. Server cannot start.');
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
    console.error('Unexpected error on idle client', err.message);
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Test database connection on startup
(async () => {
    try {
        await prisma.$connect();
        console.log('[DB] Prisma connected successfully');
    } catch (error) {
        console.error('[DB] Failed to connect:', error.message);
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

// Startup guard: the Moolre settlement webhook hard-disables itself (503) if
// MOOLRE_WEBHOOK_SECRET is unset, so warn loudly at boot to make the disabled
// endpoint obvious instead of silently rejecting every callback in production.
if (!process.env.MOOLRE_WEBHOOK_SECRET) {
    console.warn('[STARTUP] MOOLRE_WEBHOOK_SECRET is not set — webhook endpoint is disabled.');
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

// Import Routes
const authRoutes = require('./routes/authRoutes');
const tradeRoutes = require('./routes/tradeRoutes');
const adRoutes = require('./routes/adRoutes');
const chatRoutes = require('./routes/chatRoutes');
const walletRoutes = require('./routes/walletRoutes');
const adminRoutes = require('./routes/adminRoutes');
const kycRoutes = require('./routes/kycRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const depositRoutes = require('./routes/depositRoutes');
const withdrawalRoutes = require('./routes/withdrawalRoutes');
const tradeAccountRoutes = require('./routes/tradeAccountRoutes');
const payoutDestinationRoutes = require('./routes/payoutDestinationRoutes');
const adminChatRoutes = require('./routes/adminChatRoutes');
const securityRoutes = require('./routes/securityRoutes');
const userRoutes = require('./routes/userRoutes');
const warRoomRoutes = require('./routes/warRoomRoutes');
const aiRoutes = require('./routes/aiRoutes');
const financeRoutes = require('./routes/financeRoutes');
const p2pRoutes = require('./routes/p2pRoutes');
const friendRoutes = require('./routes/friendRoutes');
const vendorStatsRoutes = require('./routes/vendorStatsRoutes');
const savingsRoutes     = require('./routes/savingsRoutes');
const oracleRoutes      = require('./routes/oracleRoutes');
const azmRoutes         = require('./routes/azmRoutes');
const receiptRoutes     = require('./routes/receiptRoutes');
const ticketRoutes      = require('./routes/ticketRoutes');

// Master Sprint (2026-05-27): Vault, Susu, Group Chat, Smart Route, AZM Auction
const vaultRoutes       = require('./routes/vaultRoutes');
const groupChatRoutes   = require('./routes/groupChatRoutes');
const susuRoutes        = require('./routes/susuRoutes');
const smartRouteRoutes  = require('./routes/smartRouteRoutes');
const azmAuctionRoutes  = require('./routes/azmAuctionRoutes');

// Master Sprint v2 (2026-05-27): Saved MoMo Accounts
const savedMomoRoutes   = require('./routes/savedMomoRoutes');

const app = express();
const server = http.createServer(app);

// ══════════════════════════════════════════════════════════════════════════════
// 3. MIDDLEWARES
// ══════════════════════════════════════════════════════════════════════════════

// HIGH-1: Security headers (helmet-equivalent without dependency)
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.removeHeader('X-Powered-By');
    next();
});

// HIGH-2: CORS locked to configured origins
const corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : ['*']; // Dev fallback — override in production!

// In production, explicitly reject any browser origin not on the allow-list.
// In development (or when CORS_ORIGINS is the '*' wildcard), CORS stays open.
// Requests without an Origin header (curl, mobile apps, server-to-server) are
// always permitted since the browser same-origin policy does not apply to them.
const corsOriginValidator = (origin, callback) => {
    if (!origin) return callback(null, true);
    if (!IS_PRODUCTION || corsOrigins.includes('*')) return callback(null, true);
    if (corsOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: origin ${origin} is not allowed`));
};

app.use(cors({
    origin: corsOriginValidator,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true
}));

// Surface the CORS posture at boot so misconfigured deploys are obvious.
if (IS_PRODUCTION) {
    console.log(`CORS locked to: [${corsOrigins.join(', ')}]`);
} else {
    console.log('CORS open (development mode)');
}

// Body parser with size limit (M-1 fix) + raw body for HMAC verification
app.use(express.json({
    limit: '2mb',
    verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
}));

// Request logging (only in non-production or when LOG_REQUESTS=true)
if (!IS_PRODUCTION || process.env.LOG_REQUESTS === 'true') {
    app.use((req, res, next) => {
        console.log(`[${req.method}] ${req.url}`);
        next();
    });
}

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Health Check Endpoint ────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
    try {
        await prisma.$queryRaw`SELECT 1`;

        // Phase Q15: Include version gate info for client startup check
        let versionGate = null;
        try {
            const settings = await prisma.globalSettings.findUnique({
                where: { id: 1 },
                select: { minAppVersion: true, forceUpdateUrl: true, updateMessage: true },
            });
            if (settings) {
                versionGate = {
                    minVersion: settings.minAppVersion,
                    updateUrl: settings.forceUpdateUrl,
                    message: settings.updateMessage,
                };
            }
        } catch (_) { /* non-fatal */ }

        res.status(200).json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: APP_VERSION,
            uptime: process.uptime(),
            database: 'connected',
            redis: redisStatus,
            workers: workerStatus,
            versionGate,
            // Susu Sprint (2026-06-01): surface the boot-time auto-release
            // outcome + treasury cache state so deploy health can be checked
            // with a single curl on free-tier hosting (no dashboard logs).
            susu: {
                treasuryCached: !!app.get('azamanTreasuryUserId'),
                release: (() => {
                    try { return require('./infra/autoRelease').releaseStatus; }
                    catch (_) { return null; }
                })(),
            },
        });
    } catch (err) {
        res.status(503).json({
            status: 'unhealthy',
            timestamp: new Date().toISOString(),
            version: APP_VERSION,
            database: 'disconnected',
            redis: redisStatus,
            error: IS_PRODUCTION ? 'Service unavailable' : err.message
        });
    }
});

// --- ADMIN: manual one-time Susu release trigger (free-tier ops lever) ────────
// Lets an authenticated admin run the idempotent migrate + seed on demand
// without dashboard Shell access. Safe to call repeatedly. Returns the
// release status object. Mirrors what boot-time autoRelease does.
const { protect: protectRelease, adminOnly: adminOnlyRelease } = require('./middleware/authMiddleware');
app.post('/api/admin/susu/release', protectRelease, adminOnlyRelease, async (req, res) => {
    try {
        const { autoRelease } = require('./infra/autoRelease');
        const status = await autoRelease(prisma, { force: true });
        // Re-resolve the treasury cache immediately so Susu comes online
        // without waiting for the 60s retry tick.
        try {
            const treasury = await prisma.user.findUnique({
                where: { username: 'azaman-treasury' },
                select: { id: true },
            });
            if (treasury) app.set('azamanTreasuryUserId', treasury.id);
        } catch (_) { /* non-fatal */ }
        res.status(200).json({
            success: true,
            data: { release: status, treasuryCached: !!app.get('azamanTreasuryUserId') },
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. REAL-TIME ENGINE (Socket.IO)
// ══════════════════════════════════════════════════════════════════════════════

const io = new Server(server, {
    cors: {
        origin: corsOrigins.includes('*') ? '*' : corsOrigins,
        methods: ["GET", "POST"]
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
        const pubClient = new Redis(process.env.REDIS_URL);
        const subClient = pubClient.duplicate();
        pubClient.on('connect', () => { redisStatus = 'connected'; });
        pubClient.on('error', (e) => {
            redisStatus = 'disconnected';
            console.error('[Redis] adapter error:', e.message);
        });
        io.adapter(createAdapter(pubClient, subClient));
        console.log('Socket.IO Redis adapter enabled (multi-instance mode).');
    } catch (e) {
        // Don't take the whole server down over a missing optional dep or a
        // bad URL — fall back to the in-memory adapter (single-instance only).
        redisStatus = 'disconnected';
        console.error('[Redis] adapter init failed; using in-memory adapter:', e.message);
    }
} else {
    console.log('REDIS_URL not set — Socket.IO using in-memory adapter (single instance).');
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
        // Always run the boot release (installer converges schema; seed is
        // internally gated on treasury-missing). This lands additive
        // columns/tables on every deploy without prisma migrate (prod Neon
        // is db push-managed behind a pooler — see infra/autoRelease.js).
        await autoRelease(prisma);

        // Resolve + cache the treasury id (seeded by autoRelease if it was
        // missing).
        const id = await cacheTreasury();

        if (id) {
            console.log(`[Susu] Treasury wallet cached (userId=${id})`);
        } else {
            console.warn(
                '[Susu] WARNING: azaman-treasury User row not found after ' +
                'auto-release. Susu escrow/cycle features are DISABLED until ' +
                'it is seeded. The rest of the backend is unaffected. ' +
                'Retrying every 60s…'
            );
            const retry = setInterval(async () => {
                try {
                    const rid = await cacheTreasury();
                    if (rid) {
                        console.log(`[Susu] Treasury wallet cached on retry (userId=${rid}).`);
                        clearInterval(retry);
                    }
                } catch (e) {
                    console.warn('[Susu] treasury retry failed:', e.message);
                }
            }, 60_000);
            retry.unref?.();
        }
    } catch (err) {
        // Non-fatal: log and continue. Susu stays dark; everything else runs.
        console.warn('[Susu] WARNING: failed to cache treasury wallet id (non-fatal):', err.message);
    }
})();

// --- KYC SERVICE (Phase Q6) ---
// Singleton: manages KYC verification lifecycle (initialize, webhook, admin override).
// Shared across controllers via req.app.get('kycService').
//
// SWAPPABLE ADAPTER (Phase Q6 LIVE):
// kycService.js (MOCK) and dojahKycService.js (LIVE Ghana lookups) expose the
// exact same public surface, so we bind ONE of them based on KYC_PROVIDER:
//   - KYC_PROVIDER=LIVE | dojah → real Dojah sandbox/production calls
//   - anything else (default)   → deterministic MOCK, safe for local dev + CI
//
// The MOCK wiring is preserved (commented out) right below the live wiring so we
// always have a one-line fallback if the live provider misbehaves.
const KYCService = require('./services/kycService');
const DojahKYCService = require('./services/dojahKycService');

const KYC_PROVIDER = (process.env.KYC_PROVIDER || 'mock').toLowerCase();
const KYC_LIVE = KYC_PROVIDER === 'live' || KYC_PROVIDER === 'dojah';

// ── LIVE Dojah wiring ────────────────────────────────────────────────────────
// const kycService = new KYCService(prisma, notificationService); // ← MOCK fallback (uncomment to revert)
const kycService = KYC_LIVE
    ? new DojahKYCService(prisma, notificationService)
    : new KYCService(prisma, notificationService);
app.set('kycService', kycService);
console.log(`🪪  [KYC] Provider = ${KYC_LIVE ? 'DOJAH (live)' : 'MOCK'}`);

// --- RATE ALERT SERVICE (Phase Q12) ---
// Singleton: manages user rate alerts (CRUD + threshold checking on oracle sync).
// Shared across controllers via req.app.get('rateAlertService').
const RateAlertService = require('./services/rateAlertService');
const rateAlertService = new RateAlertService(prisma, notificationService);
app.set('rateAlertService', rateAlertService);
// Hook into oracle sync — check alerts after every rate update
marketOracle.rateAlertService = rateAlertService;

// --- AZM REWARD SERVICE (Phase E1) ---
// Singleton: manages all AZM loyalty-point crediting with audit trail + socket.
// Shared across controllers via req.app.get('azmRewardService').
const { AzmRewardService } = require('./services/azmRewardService');
const azmRewardService = new AzmRewardService(prisma, io);
app.set('azmRewardService', azmRewardService);

// --- AZM SPEND SERVICE (Phase E2) ---
// Singleton: manages all AZM loyalty-point debiting (fee discounts, ad boosts).
// Shared across controllers via req.app.get('azmSpendService').
const { AzmSpendService } = require('./services/azmSpendService');
const azmSpendService = new AzmSpendService(prisma, io);
app.set('azmSpendService', azmSpendService);

// ─────────────────────────────────────────────────────────────────────────────
// MASTER SPRINT (2026-05-27): VAULTS, SUSU, GROUP CHAT, SMART ROUTE, AZM AUCTION
// ─────────────────────────────────────────────────────────────────────────────

const { VaultService } = require('./services/vaultService');
const vaultService = new VaultService(prisma, io, notificationService, azmRewardService);
app.set('vaultService', vaultService);

const { GroupChatService } = require('./services/groupChatService');
const groupChatService = new GroupChatService(prisma, io, notificationService);
app.set('groupChatService', groupChatService);

// PHASE 6 — member-proposed group adds + admin add-quota engine.
const { GroupJoinRequestService } = require('./services/groups/groupJoinRequest.service');
const groupJoinRequestService = new GroupJoinRequestService(prisma, { notificationService, io });
app.set('groupJoinRequestService', groupJoinRequestService);

const { SusuService } = require('./services/susuService');
const susuService = new SusuService(prisma, io, notificationService, azmRewardService);
app.set('susuService', susuService);

// ── PRIVATE SUSU ECOSYSTEM OVERLAY (2026-05-31) ───────────────────────────────
// New service layer for the additive Susu features (KYC/PoR gating,
// three-channel invites, Liability Contract acceptance, Vouch slashing,
// Admin War Room alerts). Lives in services/susu/ subdir to avoid
// colliding with the legacy susuService.js above. Each overlay service
// is exposed via its own app.set key.
const SusuMemberService            = require('./services/susu/susuMember.service');
const SusuVouchService             = require('./services/susu/susuVouch.service');
const SusuOverlayService           = require('./services/susu/susu.service');
const SusuInviteService            = require('./services/susu/susuInvite.service');
const LiabilityContractServiceCls  = require('./services/susu/liabilityContract.service');
const ProofOfResidencyServiceCls   = require('./services/susu/proofOfResidency.service');
const AdminWarRoomServiceCls       = require('./services/susu/adminWarRoom.service');

const susuMemberService            = new SusuMemberService(prisma);
const susuVouchService             = new SusuVouchService(prisma, { notificationService });
const liabilityContractService     = new LiabilityContractServiceCls(prisma);
const susuOverlayService           = new SusuOverlayService(prisma, {
    susuVouchService,
    susuMemberService,
    liabilityContractService,
});
const susuInviteService            = new SusuInviteService(prisma, {
    susuVouchService,
    susuMemberService,
    notificationService,
});
const proofOfResidencyService      = new ProofOfResidencyServiceCls(prisma, { susuMemberService });
const adminWarRoomService          = new AdminWarRoomServiceCls(prisma, { notificationService });

// PHASE 5 / Workstream E — Admin Portal Susu monitor (list/detail/member
// decryption/resolve). Reuses the vouch service for REFUND_AND_CLOSE vouch
// voiding.
const AdminSusuMonitorServiceCls   = require('./services/susu/adminSusuMonitor.service');
const adminSusuMonitorService      = new AdminSusuMonitorServiceCls(prisma, {
    susuVouchService,
    notificationService,
});

// PHASE 5 / Workstream D — group-chat-first Susu initiation
const SusuInitiationService        = require('./services/susu/susuInitiation.service');
const susuInitiationService        = new SusuInitiationService(prisma, {
    susuOverlayService,
    susuMemberService,
    liabilityContractService,
    notificationService,
    io,
});

app.set('susuMemberService',        susuMemberService);
app.set('susuVouchService',         susuVouchService);
app.set('susuOverlayService',       susuOverlayService);
app.set('susuInviteService',        susuInviteService);
app.set('liabilityContractService', liabilityContractService);
app.set('proofOfResidencyService',  proofOfResidencyService);
app.set('adminWarRoomService',      adminWarRoomService);
app.set('susuInitiationService',    susuInitiationService);
app.set('adminSusuMonitorService',  adminSusuMonitorService);

const { SmartRouteService } = require('./services/smartRouteService');
const smartRouteService = new SmartRouteService({
    prisma,
    io,
    notificationService,
    mtnDisbursementService,
    vaultService,
});
app.set('smartRouteService', smartRouteService);

const { AzmAuctionService } = require('./services/azmAuctionService');
const azmAuctionService = new AzmAuctionService({
    prisma,
    io,
    azmSpendService,
    notificationService,
});
app.set('azmAuctionService', azmAuctionService);

// Master Sprint v2 (2026-05-27): MoMo name lookup (mock until Kotani V3 wires)
const { MomoNameLookupService } = require('./services/momoNameLookupService');
const momoNameLookupService = new MomoNameLookupService();
app.set('momoNameLookupService', momoNameLookupService);

// --- WORKERS ---
const TradeWorker = require('./workers/tradeWorker');
const tradeWorker = new TradeWorker(prisma, io, tradeSocketService);

const LeaderboardWorker = require('./workers/leaderboardWorker');
const leaderboardWorker = new LeaderboardWorker(prisma, io);
leaderboardWorker.start();

const AnalyticsWorker = require('./workers/analyticsWorker');
const analyticsWorker = new AnalyticsWorker(prisma);
analyticsWorker.start();

const CfoWorker = require('./workers/cfoWorker');
const cfoWorker = new CfoWorker(prisma, io);
cfoWorker.start();

const SavingsWorker = require('./workers/savingsWorker');
const savingsWorker = new SavingsWorker(prisma, io);
savingsWorker.start();

const WithdrawalReconciliationWorker = require('./workers/withdrawalReconciliationWorker');
const withdrawalReconciliationWorker =
    new WithdrawalReconciliationWorker(prisma, io, mtnDisbursementService, emailService, smsService);
withdrawalReconciliationWorker.start();

// --- PAYOUT BATCH WORKER (Phase Q8) ---
// Scans PENDING fiat withdrawals and auto-dispatches when pool has liquidity
// AND amount is below the admin-configured threshold. Flags oversized or
// under-funded withdrawals as NEEDS_MANUAL_REVIEW for the War Room.
const PayoutBatchWorker = require('./workers/payoutBatchWorker');
const payoutBatchWorker = new PayoutBatchWorker(prisma, io, mtnDisbursementService, notificationService);
payoutBatchWorker.start();
app.set('payoutBatchWorker', payoutBatchWorker);

// --- MASTER SPRINT WORKERS (Vault / Susu / Smart Route / AZM Auction) ---
const VaultWorker = require('./workers/vaultWorker');
const vaultWorker = new VaultWorker(prisma, vaultService, notificationService);
vaultWorker.start();

const SusuWorker = require('./workers/susuWorker');
const susuWorker = new SusuWorker(prisma, susuService);
susuWorker.start();

// ── Phase 3 (private-susu-ecosystem) workers — 2026-05-31 ───────────────────
// V2 cycle scheduler (60s cadence) handles SusuGroups with contractVersion
// set. Legacy susuWorker above continues to handle pre-Phase-3 SusuGroups
// whose contractVersion is null. Reminder cron + PoR expiry sweep complete
// the Phase 3 surface. All three workers are no-ops in test mode.
if (process.env.NODE_ENV !== 'test') {
    const SusuCycleService          = require('./services/susu/susuCycle.service');
    const SusuCycleSchedulerV2      = require('./workers/susuCycleSchedulerV2');
    const SusuReminderCron          = require('./workers/susuReminderCron');
    const PorExpirySweep            = require('./workers/porExpirySweep');

    // Wait until the treasury cache (server.js earlier IIFE) has resolved
    // before instantiating the cycle service — it depends on the
    // azamanTreasuryUserId.
    //
    // Resilience (Susu Sprint, 2026-06-01): the treasury seed may land
    // after boot (e.g. the release `migrate + seed` step runs in parallel
    // with the first server start, or an operator seeds manually later).
    // Rather than give up after 10s and leave the cycle workers dead until
    // the next full restart, we poll patiently (every 5s for up to 30 min).
    // The poll is cheap (an in-memory app.get) and self-terminates the
    // moment the id resolves. Susu cycle execution thus comes online
    // automatically once the DB is prepared — no redeploy required.
    const startV2Workers = async () => {
        const start = Date.now();
        const MAX_WAIT_MS = 30 * 60 * 1000; // 30 minutes
        while (!app.get('azamanTreasuryUserId') && Date.now() - start < MAX_WAIT_MS) {
            await new Promise(r => setTimeout(r, 5000));
        }
        const treasuryUserId = app.get('azamanTreasuryUserId');
        if (!treasuryUserId) {
            console.warn('[SusuV2 Workers] treasury cache not resolved within 30 min; ' +
                'cycle/reminder/PoR workers NOT started. Seed the treasury row and ' +
                'restart the service to enable them. (Rest of backend unaffected.)');
            return;
        }
        const susuCycleService = new SusuCycleService(prisma, {
            susuVouchService:    app.get('susuVouchService'),
            susuMemberService:   app.get('susuMemberService'),
            adminWarRoomService: app.get('adminWarRoomService'),
            notificationService,
            io,
            treasuryUserId,
        });
        app.set('susuCycleService', susuCycleService);

        const cycleSchedulerV2 = new SusuCycleSchedulerV2(prisma, susuCycleService);
        cycleSchedulerV2.start();
        app.set('susuCycleSchedulerV2', cycleSchedulerV2);

        const reminderCron = new SusuReminderCron(prisma, notificationService);
        reminderCron.start();
        app.set('susuReminderCron', reminderCron);

        const porExpirySweep = new PorExpirySweep(prisma, app.get('susuMemberService'), notificationService);
        porExpirySweep.start();
        app.set('porExpirySweep', porExpirySweep);
    };
    startV2Workers().catch(err => console.error('[SusuV2 Workers] startup error:', err.message));
}

const SmartRouteWorker = require('./workers/smartRouteWorker');
const smartRouteWorker = new SmartRouteWorker(prisma, smartRouteService);
smartRouteWorker.start();

// PHASE 5 / Workstream D — Susu initiation countdown sweep (every 60s).
// Independent of the treasury cache (it only manages membership + activation),
// so it starts unconditionally. No-op in test mode.
if (process.env.NODE_ENV !== 'test') {
    const SusuInitiationSweep = require('./workers/susuInitiationSweep');
    const susuInitiationSweep = new SusuInitiationSweep(prisma, susuInitiationService);
    susuInitiationSweep.start();
    app.set('susuInitiationSweep', susuInitiationSweep);
}

const AzmAuctionWorker = require('./workers/azmAuctionWorker');
const azmAuctionWorker = new AzmAuctionWorker(prisma, azmAuctionService);
azmAuctionWorker.start();

// ── D-05: record worker liveness for GET /health ─────────────────────────────
// These all called .start() above. tradeWorker is special: it is instantiated
// here but only .start()'d in the server.listen callback (so its expiry sweep
// doesn't run before the server is accepting traffic). We seed it as
// 'pending_listen' and flip it to 'running' from that callback, so /health
// reflects its true state rather than omitting it. The Susu V2 cycle workers
// start asynchronously after the treasury cache resolves and register
// themselves via app.set(...); /health reflects them through the app registry.
Object.assign(workerStatus, {
    leaderboardWorker: 'running',
    analyticsWorker: 'running',
    cfoWorker: 'running',
    savingsWorker: 'running',
    withdrawalReconciliationWorker: 'running',
    payoutBatchWorker: 'running',
    vaultWorker: 'running',
    susuWorker: 'running',
    smartRouteWorker: 'running',
    azmAuctionWorker: 'running',
    tradeWorker: 'pending_listen',
});
if (process.env.NODE_ENV === 'test') {
    // Workers are no-ops in test mode; don't claim they're running.
    for (const k of Object.keys(workerStatus)) workerStatus[k] = 'disabled_in_test';
}

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
        console.error('pushIfOffline error:', err.message);
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
        console.error("Balance Emit Error:", err.message);
    }
};

// --- GLOBAL APP SETTINGS ---
app.set('socketio', io);
app.set('prisma', prisma);
app.set('vendorStatus', vendorStatus);
app.set('emitBalanceUpdate', emitBalanceUpdate);
app.set('pushIfOffline', pushIfOffline);
app.set('gatewayService', gatewayService);
app.set('mtnDisbursementService', mtnDisbursementService);
app.set('tatumService', tatumService);
app.set('emailService', emailService);
app.set('smsService', smsService);

// B-11: admin alert service (socket broadcast + email to ADMIN_ALERT_EMAIL).
// Registered for controllers to fetch via req.app.get('adminAlertService').
// Inert until trigger points are wired (see services/adminAlertService.js
// WIRING block) and harmless until ADMIN_ALERT_EMAIL / a real email provider
// are set.
const AdminAlertService = require('./services/adminAlertService');
const adminAlertService = new AdminAlertService({ io, emailService });
app.set('adminAlertService', adminAlertService);
// The KYC service runs webhook processing outside the request lifecycle (no
// req.app handle), so hand it the alert service directly. Optional chaining at
// the callsite keeps it safe if this ever isn't set.
kycService.adminAlertService = adminAlertService;

// ══════════════════════════════════════════════════════════════════════════════
// API ROUTES (with rate limiting — CRITICAL-3)
// ══════════════════════════════════════════════════════════════════════════════

app.use('/api/public', generalLimiter, require('./routes/publicRoutes'));
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/trades', financialLimiter, tradeRoutes);
app.use('/api/ads', generalLimiter, adRoutes);
app.use('/api/chat', generalLimiter, chatRoutes);
app.use('/api/wallet', financialLimiter, walletRoutes);
app.use('/api/admin', generalLimiter, adminRoutes);
app.use('/api/kyc', generalLimiter, kycRoutes);
app.use('/api/notifications', generalLimiter, notificationRoutes);
app.use('/api/deposit', webhookLimiter, depositRoutes);
app.use('/api/withdraw', financialLimiter, withdrawalRoutes);
app.use('/api/trade-accounts', generalLimiter, tradeAccountRoutes);
app.use('/api/payout-destinations', generalLimiter, payoutDestinationRoutes);
app.use('/api/admin/chat', generalLimiter, adminChatRoutes);
app.use('/api/security', generalLimiter, securityRoutes);
app.use('/api/users', generalLimiter, userRoutes);
app.use('/api/war-room', generalLimiter, warRoomRoutes);
app.use('/api/ai', generalLimiter, aiRoutes);
app.use('/api/finance', financialLimiter, financeRoutes);
app.use('/api/p2p', financialLimiter, p2pRoutes);
app.use('/api/friends', generalLimiter, friendRoutes);
app.use('/api/vendor', generalLimiter, vendorStatsRoutes);
app.use('/api/savings', generalLimiter, savingsRoutes);
app.use('/api/oracle', generalLimiter, oracleRoutes);
app.use('/api/azm', generalLimiter, azmRoutes);
app.use('/api/receipts', generalLimiter, receiptRoutes);
app.use('/api/tickets', generalLimiter, ticketRoutes);

// Master Sprint (2026-05-27)
app.use('/api/vaults',        financialLimiter, vaultRoutes);
app.use('/api/group-chats',   generalLimiter,   groupChatRoutes);
app.use('/api/susu',          financialLimiter, susuRoutes);
app.use('/api/smart-routes',  financialLimiter, smartRouteRoutes);
app.use('/api/azm-auction',   generalLimiter,   azmAuctionRoutes);

// Master Sprint v2 (2026-05-27): Saved MoMo accounts (deposit address book)
app.use('/api/saved-momo',    financialLimiter, savedMomoRoutes);

// ── PRIVATE SUSU ECOSYSTEM OVERLAY ROUTES (2026-05-31) ────────────────────────
// PoR + Liability + Admin War Room. Susu overlay endpoints are added inside
// the existing /api/susu router (routes/susuRoutes.js) so /api/susu remains
// the single mount point.
const { userRouter: porUserRouter, adminRouter: porAdminRouter } = require('./routes/proofOfResidencyRoutes');
const { publicRouter: liabPublicRouter, adminRouter: liabAdminRouter } = require('./routes/liabilityContractRoutes');
const adminWarRoomRoutes = require('./routes/adminWarRoomRoutes');

app.use('/api/users/proof-of-residency',  generalLimiter, porUserRouter);
app.use('/api/admin/proof-of-residency',  generalLimiter, porAdminRouter);
app.use('/api/liability-contract',        generalLimiter, liabPublicRouter);
app.use('/api/admin/liability-contract',  generalLimiter, liabAdminRouter);
app.use('/api/admin/war-room',            generalLimiter, adminWarRoomRoutes);

// PHASE 5 / Workstream E — Admin Portal Susu monitor + operator actions.
const adminSusuRoutes = require('./routes/adminSusuRoutes');
app.use('/api/admin/susu',                generalLimiter, adminSusuRoutes);

// --- CHAT MEDIA UPLOAD (Phase UI-3, 2026-05-26) ──────────────────────────────
//
// Four typed multer endpoints for chat media + the legacy
// /api/chat/upload-media endpoint (kept for backwards compat). All four new
// endpoints are AUTHENTICATED via `protect`. The legacy endpoint was
// historically open and image-only; it stays open here to avoid breaking any
// in-the-wild builds, but the new clients should target the typed routes.
//
// Storage: Cloudinary (folders azaman/chat/{images,audio,video,documents}).
// Files are buffered in memory by multer, then streamed to Cloudinary via the
// shared uploadToCloudinary() service so the persisted URL survives Render
// redeploys (the local disk is ephemeral on free-tier hosting).
//
// Size limits:
//   • image    — 10 MB
//   • audio    —  5 MB
//   • video    — 50 MB
//   • document — 25 MB
const { uploadToCloudinary: uploadChatMedia } = require('./services/cloudinaryService');

// Cloudinary folder per media kind (the service prefixes everything with azaman/).
const _chatFolderFor = { image: 'chat/images', audio: 'chat/audio', video: 'chat/video', document: 'chat/documents' };

const _chatStorageFor = () => multer.memoryStorage();

const _chatMimeFilter = (allowed) => (req, file, cb) => {
    if (allowed.some((p) => file.mimetype === p || file.mimetype.startsWith(p))) {
        cb(null, true);
    } else {
        cb(new Error(`Disallowed mime: ${file.mimetype}`), false);
    }
};

const chatImageUpload = multer({
    storage: _chatStorageFor('image'),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: _chatMimeFilter(['image/'])
});
const chatAudioUpload = multer({
    storage: _chatStorageFor('audio'),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: _chatMimeFilter([
        'audio/mp4', 'audio/m4a', 'audio/x-m4a',
        'audio/mpeg', 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/aac'
    ])
});
const chatVideoUpload = multer({
    storage: _chatStorageFor('video'),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: _chatMimeFilter(['video/'])
});
const chatDocumentUpload = multer({
    storage: _chatStorageFor('document'),
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: _chatMimeFilter([
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain', 'text/csv'
    ])
});

const { protect: protectChatUpload } = require('./middleware/authMiddleware');

// Helper: upload a buffered multer file to Cloudinary and return its secure_url.
// `kind` selects the destination folder; documents are stored as `raw` so office
// formats (docx/xlsx/csv/txt) are served back with their original bytes.
const _uploadChatMediaUrl = async (file, kind) => {
    const opts = kind === 'document' ? { resource_type: 'raw' } : {};
    const { url } = await uploadChatMedia(file, _chatFolderFor[kind], opts);
    return url;
};

// POST /api/chat/upload/image — { url, mimeType, size, filename }
app.post('/api/chat/upload/image', protectChatUpload, chatImageUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    try {
        const url = await _uploadChatMediaUrl(req.file, 'image');
        res.status(200).json({
            success: true,
            url,
            mimeType: req.file.mimetype,
            size: req.file.size,
            filename: req.file.originalname
        });
    } catch (err) {
        console.error('chat image upload error:', err.message);
        res.status(500).json({ success: false, message: 'Upload failed' });
    }
});

// POST /api/chat/upload/audio — { url, mimeType, size, duration, waveformPeaks }
// `duration` (seconds) and `waveformPeaks` (50-bucket int array) are optional
// body fields the client precomputes and includes alongside the file. The
// server trusts them for MVP; a future PR can resample server-side via
// audiowaveform if the trust model needs to tighten.
app.post('/api/chat/upload/audio', protectChatUpload, chatAudioUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    let waveformPeaks = null;
    if (req.body.waveformPeaks) {
        try {
            const parsed = JSON.parse(req.body.waveformPeaks);
            if (Array.isArray(parsed) && parsed.length <= 100) waveformPeaks = parsed;
        } catch (_) { /* swallow */ }
    }
    const duration = parseInt(req.body.duration, 10);
    try {
        const url = await _uploadChatMediaUrl(req.file, 'audio');
        res.status(200).json({
            success: true,
            url,
            mimeType: req.file.mimetype,
            size: req.file.size,
            duration: Number.isFinite(duration) ? duration : null,
            waveformPeaks
        });
    } catch (err) {
        console.error('chat audio upload error:', err.message);
        res.status(500).json({ success: false, message: 'Upload failed' });
    }
});

// POST /api/chat/upload/video — { url, mimeType, size, duration }
app.post('/api/chat/upload/video', protectChatUpload, chatVideoUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const duration = parseInt(req.body.duration, 10);
    try {
        const url = await _uploadChatMediaUrl(req.file, 'video');
        res.status(200).json({
            success: true,
            url,
            mimeType: req.file.mimetype,
            size: req.file.size,
            duration: Number.isFinite(duration) ? duration : null
        });
    } catch (err) {
        console.error('chat video upload error:', err.message);
        res.status(500).json({ success: false, message: 'Upload failed' });
    }
});

// POST /api/chat/upload/document — { url, mimeType, size, filename }
app.post('/api/chat/upload/document', protectChatUpload, chatDocumentUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    try {
        const url = await _uploadChatMediaUrl(req.file, 'document');
        res.status(200).json({
            success: true,
            url,
            mimeType: req.file.mimetype,
            size: req.file.size,
            filename: req.file.originalname
        });
    } catch (err) {
        console.error('chat document upload error:', err.message);
        res.status(500).json({ success: false, message: 'Upload failed' });
    }
});

// POST /api/chat/link-preview — { url } -> { url, title, description, image, favicon, siteName, status }
const LinkPreviewService = require('./services/linkPreviewService');
const linkPreviewService = new LinkPreviewService(prisma);
app.set('linkPreviewService', linkPreviewService);

app.post('/api/chat/link-preview', protectChatUpload, async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ success: false, message: 'url required' });
        const preview = await linkPreviewService.fetch(url);
        if (!preview) return res.status(400).json({ success: false, message: 'invalid url' });
        return res.status(200).json({ success: true, preview });
    } catch (err) {
        console.error('link-preview error:', err.message);
        return res.status(500).json({ success: false, message: 'preview failed' });
    }
});

// LEGACY (Phase 0): kept alive for older builds. Image-only, 8MB, public.
// Phase UI-3 superseded this with the four typed endpoints above.
const chatMediaUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: imageFileFilter
});

app.post('/api/chat/upload-media', chatMediaUpload.any(), async (req, res) => {
    try {
        const file = Array.isArray(req.files) ? req.files[0] : req.file;
        if (!file) return res.status(400).json({ error: 'No file uploaded' });
        const mediaUrl = await _uploadChatMediaUrl(file, 'image');
        res.status(200).json({ mediaUrl, path: mediaUrl, url: mediaUrl });
    } catch (err) {
        console.error('Chat media upload error:', err.message);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// --- VENDOR DOCUMENT UPLOAD ---
const vendorDocsDir = 'uploads/vendor/';
if (!fs.existsSync(vendorDocsDir)) fs.mkdirSync(vendorDocsDir, { recursive: true });

const vendorDocsStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, vendorDocsDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'vendor-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const vendorDocsUpload = multer({
    storage: vendorDocsStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per file
    fileFilter: imageFileFilter
});

// POST /api/vendor/upload-docs — Upload vendor application documents (authenticated)
const { protect: protectUpload } = require('./middleware/authMiddleware');
app.post('/api/vendor/upload-docs', protectUpload, vendorDocsUpload.fields([
    { name: 'idFront', maxCount: 1 },
    { name: 'idBack', maxCount: 1 },
    { name: 'selfie', maxCount: 1 },
    { name: 'addressProof', maxCount: 1 },
]), async (req, res) => {
    try {
        if (!req.files || Object.keys(req.files).length === 0) {
            return res.status(400).json({ success: false, message: 'No files uploaded' });
        }

        const { uploadToCloudinary } = require('./services/cloudinaryService');
        const urls = {};
        for (const [field, files] of Object.entries(req.files)) {
            if (files && files.length > 0) {
                const { url } = await uploadToCloudinary(files[0], 'vendor-docs');
                urls[field] = url;
            }
        }

        console.log(`✅ [Vendor] Documents uploaded by user ${req.user.id}:`, Object.keys(urls));
        return res.status(200).json({ success: true, urls });
    } catch (err) {
        console.error('Vendor docs upload error:', err.message);
        return res.status(500).json({ success: false, message: 'Upload failed' });
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// REAL-TIME CONNECTIONS (Authenticated — CRITICAL-4)
// ══════════════════════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
    const userId = socket.user.id;

    // Auto-join user's own rooms (safe — verified by JWT)
    socket.join(`user_${userId}`);
    socket.join(`balance_room_${userId}`);

    // Emit current balance immediately on connection
    emitBalanceUpdate(userId).catch(err => {
        console.error('[socket.connect] initial balance emit error:', err.message);
    });

    // 1. Room Management — VALIDATED against socket.user
    socket.on('join_balance_room', (requestedUserId) => {
        // Only allow joining own balance room
        if (parseInt(requestedUserId) === userId) {
            socket.join(`balance_room_${userId}`);
        }
    });

    socket.on('join_user_room', (data) => {
        let requestedId;
        if (typeof data === 'object' && data !== null) {
            requestedId = data.userId || data.id;
        } else {
            requestedId = data;
        }
        // Only allow joining own user room
        if (parseInt(requestedId) === userId) {
            socket.join(`user_${userId}`);
        }
    });

    // Master Sprint (2026-05-27): Group chat & Susu rooms.
    // Membership check before joining — uses JWT-attached userId.
    socket.on('join_group', async (groupId) => {
        if (!groupId) return;
        try {
            const member = await prisma.groupMember.findUnique({
                where: { groupId_userId: { groupId, userId } },
            });
            if (member && !member.removedAt) {
                socket.join(`group_${groupId}`);
            }
        } catch (_) { /* swallow */ }
    });
    socket.on('leave_group', (groupId) => {
        if (groupId) socket.leave(`group_${groupId}`);
    });

    socket.on('join_susu', async (susuGroupId) => {
        if (!susuGroupId) return;
        try {
            const m = await prisma.susuMember.findUnique({
                where: { susuGroupId_userId: { susuGroupId, userId } },
            });
            if (m) socket.join(`susu_${susuGroupId}`);
        } catch (_) { /* swallow */ }
    });
    socket.on('leave_susu', (susuGroupId) => {
        if (susuGroupId) socket.leave(`susu_${susuGroupId}`);
    });

    socket.on('join_trade', async (tradeId) => {
        if (!tradeId) return;
        const cleanId = tradeId.toString().replace(/^#/, '');
        // Verify user is participant in this trade
        try {
            const trade = await prisma.trade.findUnique({
                where: { id: parseInt(cleanId) },
                select: { userId: true, vendorId: true }
            });
            if (trade && (trade.userId === userId || trade.vendorId === userId)) {
                socket.join(`trade_${cleanId}`);
            }
        } catch (err) {
            // Silently reject invalid trade IDs
        }
    });

    // --- TRADE SOCKET SERVICE HANDLERS ---
    tradeSocketService.registerHandlers(socket);

    // --- CHAT SOCKET SERVICE HANDLERS ---
    chatSocketService.registerHandlers(socket);

    // --- FRIEND SOCKET SERVICE HANDLERS ---
    friendSocketService.registerHandlers(socket);

    // --- TICKET SOCKET SERVICE HANDLERS (Phase UI-4) ---
    ticketSocketService.registerHandlers(socket);

    // 2. LIVE CHAT
    socket.on('typing', (data) => {
        if (data && data.tradeId) {
            socket.to(`trade_${data.tradeId}`).emit('vendor_typing', { isTyping: data.isTyping });
        }
    });

    // HIGH-5: Fixed mark_messages_read — removed references to non-existent fields
    socket.on('mark_messages_read', async (data) => {
        try {
            const rawTradeId = (data.tradeId || '').toString().replace(/^#/, '');
            const tradeId = parseInt(rawTradeId);
            if (isNaN(tradeId)) return;

            const trade = await prisma.trade.findUnique({ where: { id: tradeId } });
            if (!trade) return;

            // Verify the reader is a participant
            if (trade.userId !== userId && trade.vendorId !== userId) return;

            // Emit read update to the other party (UI-only, no DB write for
            // non-existent status/readAt fields on Message model)
            socket.to(`trade_${tradeId}`).emit('messages_read_update', {
                readerId: userId === trade.userId ? 'buyer' : 'vendor',
                tradeId: tradeId,
                readAt: new Date().toISOString()
            });
        } catch (err) {
            console.error("mark_messages_read error:", err.message);
        }
    });

    // 3. TRADE EXECUTION — CRITICAL-5: Authorization check
    socket.on('vendor_accept', async (data) => {
        try {
            const tradeId = parseInt((data.tradeId || '').toString().replace(/^#/, ''));
            if (isNaN(tradeId)) return;

            // CRITICAL-5: Verify the socket user IS the vendor on this trade
            const trade = await prisma.trade.findUnique({
                where: { id: tradeId },
                select: { vendorId: true, userId: true, status: true }
            });

            if (!trade) {
                socket.emit('trade_error', { message: 'Trade not found.', tradeId });
                return;
            }

            if (trade.vendorId !== userId) {
                socket.emit('trade_error', { message: 'Not authorized: You are not the vendor on this trade.', tradeId });
                return;
            }

            if (trade.status !== 'PENDING' && trade.status !== 'PENDING_PAYMENT') {
                socket.emit('trade_error', { message: `Cannot accept: trade is already ${trade.status}.`, tradeId });
                return;
            }

            // Phase H9 BUGFIX (2026-05-27): atomic conditional flip.
            // Two concurrent vendor_accept emits (network retry) would
            // both pass the status check above and both update the row.
            // The conditional updateMany scopes the flip to the
            // PENDING/PENDING_PAYMENT preconditions; if the second ack
            // sees count=0 we skip the duplicate notification + socket
            // emit silently.
            const claimed = await prisma.trade.updateMany({
                where: { id: tradeId, status: { in: ['PENDING', 'PENDING_PAYMENT'] } },
                data:  { status: 'PENDING_PAYMENT' }
            });
            if (claimed.count === 0) {
                // Already handled by an earlier in-flight ack — silent no-op.
                return;
            }
            const updatedTrade = await prisma.trade.findUnique({
                where: { id: tradeId }
            });

            io.to(`trade_${tradeId}`).emit('trade_update', {
                status: 'PENDING_PAYMENT',
                vendorPaymentDetails: updatedTrade.vendorPaymentDetails
            });

            // Persist + emit (notificationService handles both DB write and
            // WS emission). Replaces the previous fire-and-forget
            // io.emit('new_notification') which never wrote to the DB and
            // produced the "the bell is empty after I reopen the app" bug.
            await notificationService.sendNotification({
                userId:        trade.userId,
                title:         'Trade Accepted',
                body:          `Vendor accepted your order #${tradeId}. Complete payment to continue.`,
                category:      'TRADE',
                actionPayload: { action: 'OPEN_TRADE', tradeId: String(tradeId) }
            });
            pushIfOffline(
                trade.userId,
                'Trade Accepted',
                `Vendor accepted your order #${tradeId}. Complete payment to continue.`,
                { type: 'TRADE_UPDATE', tradeId: tradeId }
            );
        } catch (e) {
            console.error("vendor_accept Error:", e.message);
        }
    });

    // HIGH-10: Admin spy room — verify ADMIN role
    socket.on('join_admin_spy', () => {
        if (socket.user.role === 'ADMIN') {
            socket.join('admin_spy_room');
        } else {
            socket.emit('error', { message: 'Access denied: Admin role required.' });
        }
    });

    socket.on('disconnect', () => {
        // Clean disconnect — no logging in production to reduce noise
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// ERROR HANDLING
// ══════════════════════════════════════════════════════════════════════════════

// 404 catch-all
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint not found', path: req.originalUrl });
});

// HIGH-4: Global error handler — sanitize in production
app.use((err, req, res, next) => {
    console.error('SERVER ERROR:', err.message);
    if (!IS_PRODUCTION) {
        console.error(err.stack);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`AZAMAN BACKEND LIVE ON PORT ${PORT} [${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}]`);
    tradeWorker.start();
    workerStatus.tradeWorker = 'running';
});

// Graceful shutdown handler
const shutdown = async (signal) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);

    // Stop accepting new connections
    server.close(() => {
        console.log('[Shutdown] HTTP server closed.');
    });

    // Stop workers
    tradeWorker.stop();
    if (typeof withdrawalReconciliationWorker?.stop === 'function') {
        withdrawalReconciliationWorker.stop();
    }

    // Close socket connections
    io.close(() => {
        console.log('[Shutdown] Socket.IO closed.');
    });

    // Disconnect Prisma
    try {
        await prisma.$disconnect();
        console.log('[Shutdown] Database disconnected.');
    } catch (err) {
        console.error('[Shutdown] Prisma disconnect error:', err.message);
    }

    // Close PG pool
    try {
        await pool.end();
        console.log('[Shutdown] PG pool closed.');
    } catch (err) {
        console.error('[Shutdown] Pool close error:', err.message);
    }

    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Prevent unhandled promise rejections from crashing the process silently
process.on('unhandledRejection', (reason, promise) => {
    console.error('[UnhandledRejection]', reason);
});

// A synchronous throw outside any try/catch lands here. Node's default is to
// print and exit; we log explicitly first (stack included) so the crash is
// never silent, then exit non-zero so the process manager (PM2/Render) restarts
// us into a known-good state rather than limping on in an undefined one.
process.on('uncaughtException', (err) => {
    console.error('[UncaughtException]', err && err.message);
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
});
