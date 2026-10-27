// __tests__/route-specific-fx-authorization-gate.test.js
// =============================================================================
// Route-specific FX authorization gate — route-level pin + Smart Route
// executor proof (real PostgreSQL, real routers, no service mocks).
//
// PRODUCT POLICY (AZM-Planning #75, rework of the universal scope):
// a fresh canonical GHS/USDC rate is required exactly when an
// authorization needs (a) GHS conversion, (b) a GHS-valued limit, or
// (c) a route-specific executable quote. USDC-native SAME-ASSET actions
// (peer transfers, escrow funding, vault/savings-bucket deposits in
// USDC, crypto dispatch, checkout, dine-in pay, chat money accept,
// order-book USDC reserves, round-up processing, AZM->USDC conversion at
// the internal policy rate) are NOT gated: their availability is
// independent of whether the combined GHS display valuation can be
// refreshed.
//
// PROVES:
//   1. Route pin: every FX-DEPENDENT gated route refuses 503 RATE_STALE
//      (gate CLOSED) BEFORE the controller and BEFORE the idempotency
//      claim.
//   1n. AVAILABILITY: USDC-native same-asset routes are NOT gated — a
//      stale rate never produces the gate refusal on them.
//   1m. DESTINATION-CONDITIONAL: /api/wallet/withdraw gates ONLY MoMo
//      phone destinations (a GHS payout needs a fresh rate); crypto
//      destinations pass through on the same stale rate.
//   2. The refusal never claims an idempotency key: after the rate
//      recovers, the SAME key reaches the controller fresh.
//   3. A saved fallback snapshot does NOT open the gate (display-only).
//   4. A missing observation fails closed as RATE_UNAVAILABLE.
//   5. Fresh rate -> gated routes reachable (controllers respond with
//      their own validation, never the gate refusal).
//   6. SETTLEMENT PROTECTION: lifecycle/settlement routes are NOT gated.
//   1b. ORDERING - authentication precedes the gate.
//   1c. ORDERING - stack pin on every gated mount: guards before gate,
//      gate before idempotency.
//   7. Smart Route executors: WITHDRAW_MOMO fails closed on a
//      stale/missing rate BEFORE any reservation, debit, ledger posting
//      or provider intent; INTERNAL_TRANSFER and VAULT_DEPOSIT (same
//      USDC-native actions) EXECUTE on the same stale rate.
//   8. The MoMo crash-RESUME path is NOT re-gated: an existing
//      reservation settles on its originally reserved amount even with
//      a stale rate.
//
// SKIPS unless TEST_DATABASE_URL is set (CI runs a disposable postgres).
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[route-specific-fx-authorization-gate.test] TEST_DATABASE_URL not set — skipping.');

var mockAuthUserId = null;

jest.mock('../middleware/authMiddleware', () => ({
    // Named so the stack-order pin can identify auth layers by signature.
    protect: function protectGuard(req, res, next) {
        if (mockAuthUserId === null) {
            return res.status(401).json({ success: false, message: 'Not authenticated.' });
        }
        req.user = { id: mockAuthUserId, role: 'USER' };
        next();
    },
    adminOnly: function adminOnlyGuard(_req, _res, next) { next(); },
}));
jest.mock('../middleware/banGuardMiddleware', () => ({
    protectActive: function protectActiveGuard(req, res, next) {
        if (mockAuthUserId === null) {
            return res.status(401).json({ success: false, message: 'Not authenticated.' });
        }
        req.user = req.user || { id: mockAuthUserId, role: 'USER' };
        next();
    },
}));
jest.mock('../middleware/require2FA', () => ({
    // The real require2FA is a FACTORY returning express middleware.
    require2FA: () => function require2FAGuard(_req, _res, next) { next(); },
}));

const express = require('express');
const request = require('supertest');

function buildApp(prisma) {
    const app = express();
    app.use(express.json());
    app.set('prisma', prisma);
    app.set('logger', { warn: jest.fn(), error: jest.fn() });
    app.use('/api/trades', require('../routes/tradeRoutes'));
    app.use('/api/p2p', require('../routes/p2pRoutes'));
    app.use('/api/wallet', require('../routes/walletRoutes'));
    app.use('/api/withdraw', require('../routes/withdrawalRoutes'));
    app.use('/api/savings', require('../routes/savingsRoutes'));
    app.use('/api/vaults', require('../routes/vaultRoutes'));
    app.use('/api/shared-vaults', require('../routes/sharedVaultRoutes'));
    app.use('/api/escrow', require('../routes/escrowRoutes'));
    app.use('/api/conversations', require('../routes/conversationRoutes'));
    app.use('/api/storefront', require('../routes/storefrontRoutes'));
    app.use('/api/dine-in', require('../routes/dineInRoutes'));
    app.use('/api/cross-border-susu', require('../routes/crossBorderSusuRoutes'));
    app.use('/api/order-book', require('../routes/orderBookRoutes'));
    app.use('/api/round-up', require('../routes/roundUpRoutes'));
    app.use('/api/azm-convert', require('../routes/azmConversionRoutes'));
    app.use('/api/smart-routes', require('../routes/smartRouteRoutes'));
    return app;
}

// Every route mounted with the universal gate (new USDC-enabled transaction
// authorizations). Path params are dummy ids — the gate refuses before any
// controller lookup, so the ids never resolve.
// EXACTLY the FX-dependent authorizations (docs/native-ghs-fx-audit.md §4.1,
// route-specific scope): GHS conversion, GHS-valued limits, or a
// route-specific executable quote at authorization time.
const GATED_ROUTES = [
    ['POST', '/api/withdraw/fiat'],
    ['POST', '/api/savings/goals/1/deposit'],
    ['POST', '/api/savings/goals/1/withdraw'],
    ['POST', '/api/cross-border-susu/contribute'],
];

// USDC-native SAME-ASSET authorizations — availability must be independent
// of the canonical GHS/USDC display rate (route-specific contract). Each
// entry documents its evidence-based classification in §4.1.
const USDC_NATIVE_ROUTES = [
    ['POST', '/api/trades/initiate'],
    ['POST', '/api/trades/accept'],
    ['POST', '/api/p2p/ping/accept'],
    ['POST', '/api/wallet/internal-transfer'],
    ['POST', '/api/withdraw/crypto'],
    ['POST', '/api/vaults/1/deposit'],
    ['POST', '/api/vaults/1/break'],
    ['POST', '/api/shared-vaults/1/deposit'],
    ['POST', '/api/escrow/fund'],
    ['POST', '/api/conversations/1/messages/1/accept-money'],
    ['POST', '/api/storefront/bp1/checkout'],
    ['POST', '/api/storefront/bp1/order'],
    ['POST', '/api/dine-in/tabs/1/pay'],
    ['POST', '/api/order-book/orders'],
    ['POST', '/api/round-up/process'],
    ['POST', '/api/azm-convert/'],
    ['POST', '/api/smart-routes/1/run-now'],
];

// Settlement/lifecycle routes that must NEVER be gated: they finalize or
// reverse an ALREADY-AUTHORIZED operation (docs/native-ghs-fx-audit.md —
// rate-gate refusals must not block settlement after authorization).
const PROTECTED_SETTLEMENT_ROUTES = [
    ['POST', '/api/trades/decline'],
    ['POST', '/api/escrow/satisfy'],
    ['POST', '/api/escrow/cancel'],
];

describe('Universal USDC transaction gate — route-level pin (real PostgreSQL)', () => {
    if (!hasDb) return;

    let prisma;
    let app;
    let originalSettings;

    const setFreshRate = (rate = 12.5) =>
        prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: rate, liveUsdToGhs: rate, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date(Date.now() - 60_000), lastRateSync: new Date(Date.now() - 60_000) },
            create: { id: 1, liveRetailRate: rate, liveUsdToGhs: rate, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date(Date.now() - 60_000), lastRateSync: new Date(Date.now() - 60_000) },
        });

    const setStaleRate = (rate = 12.5) =>
        prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: rate, liveUsdToGhs: rate, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date(Date.now() - 2 * 3600_000), lastRateSync: new Date(Date.now() - 2 * 3600_000) },
            create: { id: 1, liveRetailRate: rate, liveUsdToGhs: rate, liveRateSource: 'KOTANI_PAY', lastExternalSync: new Date(Date.now() - 2 * 3600_000), lastRateSync: new Date(Date.now() - 2 * 3600_000) },
        });

    // Rates present but NO trustworthy external timestamp (the pre-271B
    // world): the gate must treat the cached number as untrusted and fail
    // closed — never a fabricated fallback. The rate fields themselves are
    // non-nullable in the schema, so "missing" is simulated by the null
    // observation timestamp, exactly like the 271E suite.
    const setMissingRate = () =>
        prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: 12.5, liveUsdToGhs: 12.5, lastExternalSync: null, lastRateSync: null },
            create: { id: 1, liveRetailRate: 12.5, liveUsdToGhs: 12.5, lastExternalSync: null, lastRateSync: null },
        });

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        app = buildApp(prisma);
        originalSettings = await prisma.globalSettings.findUnique({
            where: { id: 1 },
            select: { liveRetailRate: true, liveUsdToGhs: true, liveRateSource: true, lastExternalSync: true, lastRateSync: true },
        });
        mockAuthUserId = 'gate-pin-user';
    });

    // The dispatch-proof regressions (1m-2/1m-3/5) now persist REAL rows
    // (seeded users + their ledger-backing deposits, withdrawals, idempotency
    // claims). Without per-test cleanup those leaked into the executor
    // describe's first run (7a) and polluted its exact-count assertions.
    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "TransactionHistory", "Withdrawal", "FinancialOperation", "SmartRoute", "SmartRouteRun", "Vault" RESTART IDENTITY CASCADE'
        );
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount", "RestrictedObligation" RESTART IDENTITY CASCADE'
        );
    });

    afterAll(async () => {
        if (prisma) {
            await prisma.fxSavedRate.deleteMany({});
            if (originalSettings) {
                await prisma.globalSettings.update({
                    where: { id: 1 },
                    data: {
                        liveRetailRate: originalSettings.liveRetailRate,
                        liveUsdToGhs: originalSettings.liveUsdToGhs,
                        liveRateSource: originalSettings.liveRateSource,
                        lastExternalSync: originalSettings.lastExternalSync,
                        ...(originalSettings.lastRateSync !== undefined ? { lastRateSync: originalSettings.lastRateSync } : {}),
                    },
                });
            }
            await prisma.$disconnect();
        }
    });

    beforeEach(async () => {
        await prisma.fxSavedRate.deleteMany({});
    });

    test('1: stale canonical rate → every gated route refuses 503 RATE_STALE with the gate CLOSED, before the controller', async () => {
        await setStaleRate();
        for (const [method, path] of GATED_ROUTES) {
            const res = await request(app)[method.toLowerCase()](path).send({});
            expect(res.status).toBe(503);
            expect(res.body.success).toBe(false);
            expect(['RATE_STALE', 'RATE_UNAVAILABLE']).toContain(res.body.code);
            expect(res.body.usdcTransactionGate).toBe('CLOSED');
            expect(res.body.retryable).toBe(true);
        }
    });

    test('1n: AVAILABILITY — USDC-native same-asset routes are NOT gated; a stale rate never produces the gate refusal on them', async () => {
        await setStaleRate();
        for (const [method, path] of USDC_NATIVE_ROUTES) {
            const res = await request(app)[method.toLowerCase()](path).send({});
            // The authorization is available: whatever the controller
            // answers (validation 4xx, not-found, ...) it is NEVER the
            // FX-gate refusal.
            if (res.status === 503) {
                expect(['RATE_STALE', 'RATE_UNAVAILABLE']).not.toContain(res.body.code);
                expect(res.body.usdcTransactionGate).toBeUndefined();
            } else {
                expect(true).toBe(true);
            }
        }
    });

    test('1m: DESTINATION-CONDITIONAL — gate decision and dispatch classification are ONE contract (blocker A)', async () => {
        await setStaleRate();
        // Realistic MoMo destination OUTSIDE the Binance Pay ID window
        // (13+ digits): the GHS payout leg needs a fresh executable quote ->
        // gate refuses CLOSED before the controller.
        const momo = await request(app).post('/api/wallet/withdraw').send({ amount: 5, destination: '0244000000123' });
        expect(momo.status).toBe(503);
        expect(['RATE_STALE', 'RATE_UNAVAILABLE']).toContain(momo.body.code);
        expect(momo.body.usdcTransactionGate).toBe('CLOSED');
        // 16+ digit MoMo destination: formerly a FAIL-OPEN HOLE (the old
        // 9-15 regex never gated it, while the dispatcher pays it as GHS).
        const momo16 = await request(app).post('/api/wallet/withdraw').send({ amount: 5, destination: '0244000000123456' });
        expect(momo16.status).toBe(503);
        expect(momo16.body.usdcTransactionGate).toBe('CLOSED');
        // Realistic Binance Pay ID (9 digits, numeric): dispatched as a
        // same-asset USDC Binance payout -> the SAME stale rate must NOT
        // refuse it (formerly mis-flagged as MoMo by the 9-15 regex).
        const binance = await request(app).post('/api/wallet/withdraw').send({ amount: 5, destination: '123456789' });
        expect(binance.status).not.toBe(503);
        expect(binance.body && binance.body.usdcTransactionGate).toBeUndefined();
        // Crypto destination (TRC20) -> same-asset USDC dispatch, no GHS
        // conversion -> NOT gated; the request proceeds to the controller's
        // own validation.
        const trc = await request(app).post('/api/wallet/withdraw').send({ amount: 5, destination: 'TQ5nRc9eK7mYfP2ZQ9G3eV2XtRrEStQXbW' });
        expect(trc.status).not.toBe(503);
        expect(trc.body && trc.body.usdcTransactionGate).toBeUndefined();
    });

    test('1m-2: DISPATCH PROOF — with a fresh rate the persisted Withdrawal carries the SAME payoutMethod the gate classified', async () => {
        // Mounted-route end-to-end: gate passes on a fresh rate, the
        // controller runs, and the created Withdrawal row records the actual
        // provider dispatch classification. Gate and dispatch must agree for
        // every destination class.
        await setFreshRate();
        const { seedUser } = require('./helpers/factories');
        const prisma = app.get('prisma');
        const prevAuth = mockAuthUserId;
        const user = await seedUser(prisma, { availableBalance: 50 });
        mockAuthUserId = user.id;
        try {
            // 13-digit numeric -> gated class MOMO -> dispatch row MOMO.
            const momo = await request(app).post('/api/wallet/withdraw')
                .set('idempotency-key', 'blk-a-momo-1')
                .send({ amount: 5, destination: '0244000000123' });
            expect(momo.status).toBe(200);
            expect(momo.body.withdrawal.payoutMethod).toBe('MOMO');
            expect(momo.body.withdrawal.network).toBe('MTN');
            // 9-digit Binance Pay ID -> ungated class BINANCE_ID -> dispatch row BINANCE_ID.
            const binance = await request(app).post('/api/wallet/withdraw')
                .set('idempotency-key', 'blk-a-binance-1')
                .send({ amount: 5, destination: '123456789' });
            expect(binance.status).toBe(200);
            expect(binance.body.withdrawal.payoutMethod).toBe('BINANCE_ID');
            expect(binance.body.withdrawal.network).toBe('BINANCE_PAY');
            // TRC20 -> ungated class EXTERNAL_WALLET -> dispatch row EXTERNAL_WALLET.
            const trc = await request(app).post('/api/wallet/withdraw')
                .set('idempotency-key', 'blk-a-trc-1')
                .send({ amount: 5, destination: 'TQ5nRc9eK7mYfP2ZQ9G3eV2XtRrEStQXbW' });
            expect(trc.status).toBe(200);
            expect(trc.body.withdrawal.payoutMethod).toBe('EXTERNAL_WALLET');
            expect(trc.body.withdrawal.network).toBe('TRC20');
            // Persisted rows agree with the response (dispatch evidence, not just the echo).
            const rows = await prisma.withdrawal.findMany({ where: { userId: user.id }, select: { payoutMethod: true, network: true, destination: true } });
            expect(rows.map(r => r.payoutMethod).sort()).toEqual(['BINANCE_ID', 'EXTERNAL_WALLET', 'MOMO']);
        } finally {
            mockAuthUserId = prevAuth;
        }
    });

    test('1m-3: KNOWN CONTRACT GAP — a 10-digit MoMo-style number dispatches as BINANCE_ID (pinned, reported to the owner)', async () => {
        // The 8-12 digit numeric window is inherently ambiguous between a
        // Ghana MoMo number and a Binance Pay ID under the current request
        // contract ({ destination, networkPref }). The dispatcher has always
        // resolved it as BINANCE_ID, so the gate follows the SAME rule. A
        // durable fix needs an explicit destination-type request field (a
        // contract change requiring product approval) — pinned here so the
        // ambiguity is visible and cannot silently drift.
        await setFreshRate();
        const { seedUser } = require('./helpers/factories');
        const prisma = app.get('prisma');
        const prevAuth = mockAuthUserId;
        const user = await seedUser(prisma, { availableBalance: 50 });
        mockAuthUserId = user.id;
        try {
            const res = await request(app).post('/api/wallet/withdraw')
                .set('idempotency-key', 'blk-a-gap-1')
                .send({ amount: 5, destination: '0244000000' });
            expect(res.status).toBe(200);
            expect(res.body.withdrawal.payoutMethod).toBe('BINANCE_ID');
        } finally {
            mockAuthUserId = prevAuth;
        }
    });

    test('1c-m: stack pin — the conditional gate on /api/wallet/withdraw sits after guards, before idempotency', async () => {
        const router = require('../routes/walletRoutes');
        const sig = (h) => String(h);
        const mount = router.stack.find((l) => l.route && l.route.path === '/withdraw' && l.route.methods && l.route.methods.post);
        expect(mount).toBeTruthy();
        const stack = mount.route.stack;
        const gateIdx = stack.findIndex((l) => sig(l.handle).includes('freshFxRate') || sig(l.handle).includes('usdcTransactionGate'));
        expect(gateIdx).toBeGreaterThanOrEqual(0);
        const guardIdxs = stack.map((l, i) => (/protectGuard|protectActiveGuard|require2FAGuard/.test(sig(l.handle)) ? i : -1)).filter((i) => i >= 0);
        for (const gi of guardIdxs) expect(gi).toBeLessThan(gateIdx);
        const idemIdx = stack.findIndex((l) => /Idempotency-Key|idempotency/i.test(sig(l.handle)));
        if (idemIdx >= 0) expect(gateIdx).toBeLessThan(idemIdx);
    });

    test('2: a saved fallback snapshot NEVER opens the gate (display-only)', async () => {
        await setStaleRate();
        await prisma.fxSavedRate.create({
            data: {
                pair: 'USDC_GHS',
                rateGhsPerUsdc: 12.5,
                rateSource: 'KOTANI_PAY',
                observedAt: new Date(Date.now() - 3600_000),
                eligible: true,
            },
        }).catch(() => {}); // schema-tolerant: eligible column optional
        const res = await request(app).post('/api/savings/goals/1/deposit').send({});
        expect(res.status).toBe(503);
        expect(['RATE_STALE', 'RATE_UNAVAILABLE']).toContain(res.body.code);
        expect(res.body.savedRateIsDisplayOnly).toBe(true);
    });

    test('3: missing observation → RATE_UNAVAILABLE (no fabricated fallback)', async () => {
        await setMissingRate();
        const res = await request(app).post('/api/savings/goals/1/deposit').send({});
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('RATE_UNAVAILABLE');
        expect(res.body.usdcTransactionGate).toBe('CLOSED');
    });

    test('1b: ORDERING — an unauthenticated request gets 401 on every gated route (never the 503 gate verdict)', async () => {
        await setStaleRate(); // gate CLOSED
        const prevUser = mockAuthUserId;
        mockAuthUserId = null; // auth middleware now rejects
        try {
            for (const [method, path] of GATED_ROUTES) {
                const res = await request(app).post(path).send({});
                // Authentication precedes the gate: the caller learns the
                // auth verdict, never the FX-gate state.
                expect(res.status).toBe(401);
                expect(res.body && res.body.code).toBeUndefined();
            }
        } finally {
            mockAuthUserId = prevUser;
        }
    });

    test('1c: ORDERING — stack pin: auth/ban/2FA before the gate, gate before idempotency, on every gated mount', async () => {
        const ROUTER_BY_PREFIX = [
            ['/api/trades', require('../routes/tradeRoutes')],
            ['/api/p2p', require('../routes/p2pRoutes')],
            ['/api/wallet', require('../routes/walletRoutes')],
            ['/api/withdraw', require('../routes/withdrawalRoutes')],
            ['/api/savings', require('../routes/savingsRoutes')],
            ['/api/vaults', require('../routes/vaultRoutes')],
            ['/api/shared-vaults', require('../routes/sharedVaultRoutes')],
            ['/api/escrow', require('../routes/escrowRoutes')],
            ['/api/conversations', require('../routes/conversationRoutes')],
            ['/api/storefront', require('../routes/storefrontRoutes')],
            ['/api/dine-in', require('../routes/dineInRoutes')],
            ['/api/cross-border-susu', require('../routes/crossBorderSusuRoutes')],
            ['/api/order-book', require('../routes/orderBookRoutes')],
            ['/api/round-up', require('../routes/roundUpRoutes')],
            ['/api/azm-convert', require('../routes/azmConversionRoutes')],
            ['/api/smart-routes', require('../routes/smartRouteRoutes')],
        ];
        const pathMatches = (pattern, concrete) => {
            const ps = pattern.split('/').filter(Boolean);
            const cs = concrete.split('/').filter(Boolean);
            if (ps.length !== cs.length) return false;
            return ps.every((seg, i) => (seg.startsWith(':') ? !!cs[i] : seg === cs[i]));
        };
        const sig = (h) => String(h);
        const isGuard = (l) => /protectGuard|protectActiveGuard|require2FAGuard/.test(sig(l.handle));
        const isGate = (l) => sig(l.handle).includes('freshFxRate') || sig(l.handle).includes('usdcTransactionGate');
        const isIdempotency = (l) => /Idempotency-Key|idempotency/i.test(sig(l.handle));

        const mountsChecked = [];
        for (const [prefix, router] of ROUTER_BY_PREFIX) {
            for (const layer of router.stack) {
                if (!layer.route || !layer.route.methods || !layer.route.methods.post) continue;
                for (const [method, path] of GATED_ROUTES) {
                    if (method !== 'POST' || !path.startsWith(prefix + '/')) continue;
                    const remainder = path.slice(prefix.length);
                    if (!pathMatches(layer.route.path, remainder)) continue;
                    const stack = layer.route.stack;
                    const gateIdx = stack.findIndex(isGate);
                    expect(gateIdx).toBeGreaterThanOrEqual(0); // the gate IS mounted
                    const guardIdxs = stack.map((l, i) => (isGuard(l) ? i : -1)).filter((i) => i >= 0);
                    for (const gi of guardIdxs) {
                        expect(gi).toBeLessThan(gateIdx); // auth/ban/2FA first
                    }
                    const idemIdx = stack.findIndex(isIdempotency);
                    if (idemIdx >= 0) {
                        expect(gateIdx).toBeLessThan(idemIdx); // then idempotency
                    }
                    mountsChecked.push(prefix + layer.route.path);
                    break; // first matching GATED_ROUTES entry per route
                }
            }
        }
        // Every GATED_ROUTES entry was found in a real router stack.
        expect(new Set(mountsChecked).size).toBe(GATED_ROUTES.length);
    });

    test('4: fresh rate → the gate PASSES: controllers answer with their own validation, never the gate refusal', async () => {
        await setFreshRate();
        // azm-convert reaches the controller (insufficient AZM balance → its
        // own 4xx), smart-route run-now reaches its 404, crypto withdraw
        // reaches its own validation — none is a 503 gate refusal.
        for (const path of ['/api/azm-convert/', '/api/smart-routes/1/run-now', '/api/withdraw/crypto']) {
            const res = await request(app).post(path).send({});
            expect(res.status).not.toBe(503);
            if (res.body && res.body.code) expect(res.body.code).not.toBe('RATE_STALE');
        }
    });

    test('5: a gate refusal NEVER claims an idempotency key — the same key reaches the controller after recovery', async () => {
        // The idempotency authority persists FinancialOperation rows keyed by
        // the REAL integer userId — the claim path is genuinely exercised
        // (the earlier x-idempotency-key header never engaged it, so this
        // test used to pass vacuously). A real user makes the replay's claim
        // write succeed and the controller's own validation answer.
        const { seedUser } = require('./helpers/factories');
        const prevAuth = mockAuthUserId;
        const user = await seedUser(prisma, { availableBalance: 50 });
        mockAuthUserId = user.id;
        try {
            const KEY = 'gate-idempotency-probe-1';
            await setStaleRate();
            const refused = await request(app).post('/api/savings/goals/1/deposit').set('idempotency-key', KEY).send({ amount: 5 });
            expect(refused.status).toBe(503);

            await setFreshRate();
            const replay = await request(app).post('/api/savings/goals/1/deposit').set('idempotency-key', KEY).send({ amount: 5 });
            // If the refusal had claimed the key, the replay would be the byte-
            // identical 503 gate refusal. Reaching the controller's own
            // validation (savings goal 1 does not exist for this user → 4xx)
            // proves no claim was made and the idempotency authority is live.
            expect(replay.status).not.toBe(503);
            expect(replay.body.code).not.toBe('IDEMPOTENCY_UNAVAILABLE');
            expect(replay.body.code).not.toBe('IDEMPOTENCY_KEY_REQUIRED');
            // No durable claim was poisoned by the refused request.
            const claims = await prisma.financialOperation.count({ where: { key: KEY } });
            if (claims > 0) {
                const claim = await prisma.financialOperation.findFirst({ where: { key: KEY } });
                expect(claim.status).not.toBe('IN_PROGRESS');
                expect(claim.status).toBe('COMMITTED');
            }
        } finally {
            mockAuthUserId = prevAuth;
        }
    });

    test('6: SETTLEMENT PROTECTION — lifecycle/settlement routes are never gated by the stale-rate refusal', async () => {
        await setStaleRate();
        for (const [method, path] of PROTECTED_SETTLEMENT_ROUTES) {
            const res = await request(app)[method.toLowerCase()](path).send({});
            expect(res.status).not.toBe(503);
        }
    });
});

describe('Universal USDC transaction gate — Smart Route executors fail closed (real PostgreSQL)', () => {
    if (!hasDb) return;

    let prisma;
    let notifStub;
    const { seedUser } = require('./helpers/factories');

    function makeSvc() {
        const { SmartRouteService } = require('../services/smartRouteService');
        return new SmartRouteService({
            prisma,
            io: null,
            notificationService: notifStub,
            mtnDisbursementService: null,
            // The VAULT_DEPOSIT executor delegates the guarded deposit to
            // the real vaultService seam. A minimal depositManual stand-in
            // performs the same guarded debit + vault credit the executor
            // contract expects (same-asset USDC move; no rate consulted).
            vaultService: {
                depositManual: async ({ userId, vaultId, amountUsdc, authorizationGuardInTransaction }) => {
                    await prisma.$transaction(async (tx) => {
                        if (authorizationGuardInTransaction) {
                            await authorizationGuardInTransaction(tx);
                        }
                        const claimed = await tx.user.updateMany({
                            where: { id: userId, availableBalance: { gte: amountUsdc } },
                            data: { availableBalance: { decrement: amountUsdc } },
                        });
                        if (claimed.count !== 1) throw new Error('insufficient balance');
                        await tx.vault.update({
                            where: { id: vaultId },
                            data: { currentAmountUsdc: { increment: amountUsdc } },
                        });
                    });
                },
            },
        });
    }

    async function seedObservation({ retailRate = 12.5, observedAt = new Date(Date.now() - 60_000) } = {}) {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: retailRate, liveUsdToGhs: 15, lastExternalSync: observedAt, lastRateSync: observedAt, liveRateSource: 'KOTANI_PAY' },
            create: { id: 1, liveRetailRate: retailRate, liveUsdToGhs: 15, lastExternalSync: observedAt, lastRateSync: observedAt, liveRateSource: 'KOTANI_PAY' },
        });
    }

    async function seedRoute(userId, action, overrides = {}) {
        return prisma.smartRoute.create({
            data: {
                userId,
                name: `route-${action}`,
                action,
                amountUsdc: 10,
                frequency: 'WEEKLY',
                startDate: new Date(Date.now() - 7 * 86400000),
                nextRunAt: new Date(Date.now() - 3600_000),
                status: 'ACTIVE',
                ...overrides,
            },
        });
    }

    const TRUNCATE = async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "SmartRoute", "SmartRouteRun", "TransactionHistory", "GlobalSettings", "Withdrawal", "Vault" RESTART IDENTITY CASCADE'
        );
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount", "RestrictedObligation" RESTART IDENTITY CASCADE'
        );
    };

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        notifStub = { sendNotification: async () => ({}) };
    });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });
    afterEach(TRUNCATE);

    test('7a: WITHDRAW_MOMO fails closed on a stale rate BEFORE any reservation/debit/ledger/provider intent', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        await seedObservation({ observedAt: new Date(Date.now() - 2 * 3600_000) });
        const route = await seedRoute(user.id, 'WITHDRAW_MOMO', {
            destMomoNumber: '0244000000',
            destMomoProvider: 'MTN',
        });

        const svc = makeSvc();
        const claim = await svc._claimExecution(route.id, false);
        const run = await svc._executeClaim(claim);

        expect(run.status).toBe('FAILED_OTHER');
        expect(String(run.failureReason || '')).toMatch(/stale\/unavailable rate/);
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshUser.availableBalance)).toBe(500);
        expect(await prisma.transactionHistory.count({})).toBe(1); // the seeded deposit backing only
        expect(await prisma.withdrawal.count({})).toBe(0);
    });

    test('7b: WITHDRAW_MOMO fails closed on a MISSING observation (RATE_UNAVAILABLE)', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        await seedObservation({ observedAt: null });
        const route = await seedRoute(user.id, 'WITHDRAW_MOMO', {
            destMomoNumber: '0244000000',
            destMomoProvider: 'MTN',
        });

        const svc = makeSvc();
        const claim = await svc._claimExecution(route.id, false);
        const run = await svc._executeClaim(claim);

        expect(run.status).toBe('FAILED_OTHER');
        expect(String(run.failureReason || '')).toMatch(/stale\/unavailable rate \(RATE_UNAVAILABLE\)/);
        expect(await prisma.withdrawal.count({})).toBe(0);
    });

    test('7c: INTERNAL_TRANSFER (same-asset USDC move) EXECUTES on a stale rate — availability per the route-specific contract', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const friend = await seedUser(prisma, { availableBalance: 0 });
        await prisma.friendship.create({ data: { requesterId: user.id, addresseeId: friend.id, status: 'ACCEPTED' } });
        await seedObservation({ observedAt: new Date(Date.now() - 2 * 3600_000) });
        const route = await seedRoute(user.id, 'INTERNAL_TRANSFER', { destFriendUserId: friend.id });

        const svc = makeSvc();
        const claim = await svc._claimExecution(route.id, false);
        const run = await svc._executeClaim(claim);

        // Same-asset USDC authorization: no GHS conversion, no GHS limit,
        // no GHS quote — the stale canonical rate must NOT make it
        // unavailable. The transfer completes.
        expect(run.status).toBe('SUCCESS');
        expect(String(run.failureReason || '')).not.toMatch(/stale.unavailable rate/);
        const [freshUser, freshFriend] = await Promise.all([
            prisma.user.findUnique({ where: { id: user.id } }),
            prisma.user.findUnique({ where: { id: friend.id } }),
        ]);
        expect(Number(freshUser.availableBalance)).toBe(490);
        expect(Number(freshFriend.availableBalance)).toBe(10);
    });

    test('7d: VAULT_DEPOSIT (same-asset USDC move) EXECUTES on a stale rate', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const vault = await prisma.vault.create({
            data: {
                userId: user.id,
                name: 'V',
                targetAmountUsdc: 100,
                currentAmountUsdc: 0,
                rulesAcceptedAt: new Date(),
                maturityDate: new Date(Date.now() + 365 * 86400000),
            },
        });
        await seedObservation({ observedAt: new Date(Date.now() - 2 * 3600_000) });
        const route = await seedRoute(user.id, 'VAULT_DEPOSIT', { destVaultId: vault.id });

        const svc = makeSvc();
        const claim = await svc._claimExecution(route.id, false);
        const run = await svc._executeClaim(claim);

        expect(run.status).toBe('SUCCESS');
        expect(String(run.failureReason || '')).not.toMatch(/stale.unavailable rate/);
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshUser.availableBalance)).toBe(490);
        const freshVault = await prisma.vault.findUnique({ where: { id: vault.id } });
        expect(Number(freshVault.currentAmountUsdc)).toBe(10);
    });

    test('8: the MoMo crash-RESUME path is NOT re-gated — an existing reservation converges even with a stale rate', async () => {
        // Realistic crashed-execution wallet: the reservation already debited 10
        // USDC from availableBalance into escrowLockedBalance (availableBalance
        // reflects the post-reservation remainder, which still clears the
        // pre-execution balance check exactly like production recovery).
        const user = await seedUser(prisma, { availableBalance: 490, escrowLockedBalance: 10 });
        await seedObservation({ observedAt: new Date(Date.now() - 2 * 3600_000) });
        const route = await seedRoute(user.id, 'WITHDRAW_MOMO', {
            destMomoNumber: '0244000000',
            destMomoProvider: 'MTN',
        });

        // Simulate a CRASHED execution mid-flight: the run is still PENDING
        // (claimed, never finalized) and a durable PENDING reservation from a
        // moment when the rate WAS fresh exists (payout struck at 12.5).
        const run = await prisma.smartRouteRun.create({
            data: {
                routeId: route.id,
                userId: user.id,
                action: 'WITHDRAW_MOMO',
                amountUsdc: 10,
                destMomoNumber: '0244000000',
                destMomoProvider: 'MTN',
                status: 'PENDING',
            },
        });
        const reference = `SRWD_${run.id}`;
        await prisma.transactionHistory.create({
            data: {
                userId: user.id,
                type: 'WITHDRAWAL_FIAT',
                amountUsdc: 10,
                feeUsdc: 0,
                status: 'PENDING',
                txHash: reference,
                metadata: { payoutGhs: 125, retailRate: 12.5, smartRoute: true, smartRouteRunId: run.id },
            },
        });

        // Rate is STILL stale. The recovery re-drive must take the RESUME
        // path (never re-gated, never re-priced) — it parks for
        // reconciliation (no withdrawal mirror), which proves the rate
        // refusal did NOT intercept the recovery of a prior authorization.
        const svc = makeSvc();
        const run2 = await svc._executeClaim({ run, route, occurrenceBased: false, occurrenceBase: null, recovery: true });

        expect(run2.status).toBe('AWAITING_RECONCILIATION');
        expect(String(run2.failureReason || '')).not.toMatch(/stale\/unavailable rate/);
        // The reservation is untouched — the resume path did NOT debit, re-
        // price, or dispatch anything new.
        const freshUser = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(freshUser.availableBalance)).toBe(490);
    });
});
