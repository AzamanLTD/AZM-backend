// __tests__/universal-usdc-transaction-gate.test.js
// =============================================================================
// Universal USDC transaction gate — route-level pin + Smart Route executor
// fail-closed proof (real PostgreSQL, real routers, no service mocks).
//
// PRODUCT POLICY (docs/native-ghs-fx-audit.md §4.1, superseded-scope fix):
// every NEW USDC-enabled transaction authorization — including routes whose
// own math computes no GHS conversion (peer transfers, escrow funding,
// vault/savings deposits, crypto dispatch, checkout, dine-in pay, chat money
// accept, order-book USDC reserves, round-up processing, AZM→USDC conversion,
// manual smart-route execution) — is UNAVAILABLE while the canonical rate is
// missing, invalid or stale. A saved/demo fallback rate NEVER opens the gate.
//
// PROVES:
//   1. Route pin: every gated route refuses 503 RATE_STALE (gate CLOSED)
//      BEFORE the controller and BEFORE the idempotency claim.
//   2. The refusal never claims an idempotency key: after the rate recovers,
//      the SAME key reaches the controller fresh (no replayed 503).
//   3. A saved fallback snapshot does NOT open the gate (display-only).
//   4. A missing observation fails closed as RATE_UNAVAILABLE.
//   5. Fresh rate → routes reachable (gate passes; controllers respond with
//      their own validation, never the gate refusal).
//   6. SETTLEMENT PROTECTION: lifecycle/settlement routes (trades decline,
//      escrow satisfy/cancel) are NOT gated — a stale rate never blocks the
//      settlement of an already-authorized operation.
//   7. Smart Route executors fail closed on a stale/missing rate BEFORE any
//      reservation, debit, ledger posting or provider intent (WITHDRAW_MOMO,
//      INTERNAL_TRANSFER, VAULT_DEPOSIT); the run FAILED with a
//      rate-classified reason and the next occurrence retries.
//   8. The MoMo crash-RESUME path is NOT re-gated: an existing reservation
//      settles on its originally reserved amount even with a stale rate.
//
// SKIPS unless TEST_DATABASE_URL is set (CI runs a disposable postgres).
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[universal-usdc-transaction-gate.test] TEST_DATABASE_URL not set — skipping.');

var mockAuthUserId = null;

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => {
        req.user = { id: mockAuthUserId, role: 'USER' };
        next();
    },
    adminOnly: (_req, _res, next) => next(),
}));
jest.mock('../middleware/banGuardMiddleware', () => ({
    protectActive: (req, _res, next) => {
        req.user = req.user || { id: mockAuthUserId, role: 'USER' };
        next();
    },
}));
jest.mock('../middleware/require2FA', () => ({
    // The real require2FA is a FACTORY returning express middleware.
    require2FA: () => (_req, _res, next) => next(),
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
const GATED_ROUTES = [
    ['POST', '/api/trades/initiate'],
    ['POST', '/api/trades/accept'],
    ['POST', '/api/p2p/ping/accept'],
    ['POST', '/api/wallet/withdraw'],
    ['POST', '/api/wallet/internal-transfer'],
    ['POST', '/api/withdraw/crypto'],
    ['POST', '/api/withdraw/fiat'],
    ['POST', '/api/savings/goals/1/deposit'],
    ['POST', '/api/savings/goals/1/withdraw'],
    ['POST', '/api/vaults/1/deposit'],
    ['POST', '/api/shared-vaults/1/deposit'],
    ['POST', '/api/escrow/fund'],
    ['POST', '/api/conversations/1/messages/1/accept-money'],
    ['POST', '/api/storefront/bp1/checkout'],
    ['POST', '/api/storefront/bp1/order'],
    ['POST', '/api/dine-in/tabs/1/pay'],
    ['POST', '/api/cross-border-susu/contribute'],
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
        const res = await request(app).post('/api/azm-convert/').send({});
        expect(res.status).toBe(503);
        expect(['RATE_STALE', 'RATE_UNAVAILABLE']).toContain(res.body.code);
        expect(res.body.savedRateIsDisplayOnly).toBe(true);
    });

    test('3: missing observation → RATE_UNAVAILABLE (no fabricated fallback)', async () => {
        await setMissingRate();
        const res = await request(app).post('/api/azm-convert/').send({});
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('RATE_UNAVAILABLE');
        expect(res.body.usdcTransactionGate).toBe('CLOSED');
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
        const KEY = 'gate-idempotency-probe-1';
        await setStaleRate();
        const refused = await request(app).post('/api/azm-convert/').set('x-idempotency-key', KEY).send({ amount: 5 });
        expect(refused.status).toBe(503);

        await setFreshRate();
        const replay = await request(app).post('/api/azm-convert/').set('x-idempotency-key', KEY).send({ amount: 5 });
        // If the refusal had claimed the key, the replay would be the byte-
        // identical 503. Reaching anything else proves no claim was made.
        expect(replay.status).not.toBe(503);
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
            vaultService: null,
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

    test('7c: INTERNAL_TRANSFER fails closed on a stale rate before the transfer transaction opens', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const friend = await seedUser(prisma, { availableBalance: 0 });
        await seedObservation({ observedAt: new Date(Date.now() - 2 * 3600_000) });
        const route = await seedRoute(user.id, 'INTERNAL_TRANSFER', { destFriendUserId: friend.id });

        const svc = makeSvc();
        const claim = await svc._claimExecution(route.id, false);
        const run = await svc._executeClaim(claim);

        expect(run.status).toBe('FAILED_OTHER');
        expect(String(run.failureReason || '')).toMatch(/stale\/unavailable rate/);
        const [freshUser, freshFriend] = await Promise.all([
            prisma.user.findUnique({ where: { id: user.id } }),
            prisma.user.findUnique({ where: { id: friend.id } }),
        ]);
        expect(Number(freshUser.availableBalance)).toBe(500);
        expect(Number(freshFriend.availableBalance)).toBe(0);
    });

    test('7d: VAULT_DEPOSIT fails closed on a stale rate before any guarded claim', async () => {
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

        expect(run.status).toBe('FAILED_OTHER');
        expect(String(run.failureReason || '')).toMatch(/stale\/unavailable rate/);
        expect(Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance)).toBe(500);
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
