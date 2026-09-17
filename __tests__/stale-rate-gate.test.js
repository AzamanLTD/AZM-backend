// __tests__/stale-rate-gate.test.js
// =============================================================================
// Real-PostgreSQL proof of the PR 271C fail-closed stale-rate gate:
//
//   A new fiat deposit quote is permitted ONLY when
//     lastExternalSync IS NOT NULL
//   AND now - lastExternalSync <= RATE_FRESHNESS_MAX_AGE_SECONDS (default 1800)
//   AND liveRetailRate is finite and > 0
//
// Covers BOTH mounted initiation paths (generic /fiat/initiate and Moolre
// /fiat/initiate/moolre), the config resolver, the exact age boundary, every
// "fabricated freshness" bypass attempt, and — critically — that already
// issued quotes remain settleable at their persisted fixed price even after
// the current rate goes stale (271C must not strand valid quotes).
//
// Prisma is NEVER mocked: every assertion runs against real PostgreSQL
// (TEST_DATABASE_URL). Only non-DB boundaries (audit, journal) and the Moolre
// external provider are stubbed. Skips cleanly without TEST_DATABASE_URL.
// =============================================================================

jest.mock('../utils/audit', () => ({ audit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/journalIntegration', () => ({ recordDeposit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/config/logger', () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(),
}));

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[stale-rate-gate.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('271C fail-closed stale-rate gate (real PostgreSQL)', () => {
    let prisma;
    const { seedUser } = require('./helpers/factories');
    const {
        getFreshServerRateGhsPerUsdc,
        RateUnavailableError,
    } = require('../src/services/transactionQuoteService');
    const quoteFiatDepositController = require('../controllers/quoteFiatDepositController');
    const moolreQuoteDepositController = require('../controllers/moolreQuoteDepositController');
    const depositRouter = require('../routes/depositRoutes');

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        process.env.FIAT_WEBHOOK_SECRET = 'test_webhook_secret_271c';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    // ---- helpers -------------------------------------------------------------

    const second = (ms) => ms * 1000;

    async function seedSettings(overrides = {}) {
        const base = {
            liveUsdToGhs: 13.10,
            liveRetailRate: 13.42,
            liveCorporateRate: 13.22,
            liveRateSource: 'KOTANI_PAY',
            lastRateSync: null,
            lastExternalSync: new Date(Date.now() - second(60)),
            lastAdminSetAt: null,
            lastEchoAt: null,
        };
        const data = { ...base, ...overrides };
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
        return data;
    }

    function makeApp(services = {}) {
        const registry = {
            prisma,
            marketOracle: null,
            notificationService: { sendNotification: jest.fn().mockResolvedValue(undefined) },
            socketio: null,
            emitBalanceUpdate: null,
            moolreCollectionService: { initiatePayment: jest.fn().mockResolvedValue({ requiresOtp: false, providerRef: 'PR-271C' }) },
            ...services,
        };
        return { get: (key) => registry[key] };
    }

    function mockResponse() {
        return {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.payload = payload; return this; },
        };
    }

    async function initiateGeneric(user, amountGhs = 134.20) {
        const res = mockResponse();
        await quoteFiatDepositController.initiate(
            { app: makeApp(), user: { id: user.id }, body: { amountGhs, provider: 'MTN_MOMO' }, ip: '127.0.0.1' },
            res
        );
        return res;
    }

    async function initiateMoolre(user, amountGhs = 134.20) {
        const app = makeApp();
        const res = mockResponse();
        await moolreQuoteDepositController.initiate(
            { app, user: { id: user.id }, body: { amountGhs, provider: 'MTN_MOMO', phoneNumber: '0241234567' } },
            res
        );
        return { res, moolre: app.get('moolreCollectionService') };
    }

    async function quotesFor(userId) {
        return prisma.$queryRaw`SELECT * FROM "TransactionQuote" WHERE "userId" = ${userId}`;
    }

    async function pendingFor(userId) {
        return prisma.transactionHistory.findMany({ where: { userId, type: 'DEPOSIT_FIAT', status: 'PENDING' } });
    }

    async function webhook(reference, amountGhs) {
        const res = mockResponse();
        await quoteFiatDepositController.webhook(
            {
                app: makeApp(),
                headers: { 'x-azaman-webhook-secret': process.env.FIAT_WEBHOOK_SECRET },
                body: { reference, amountGhs, status: 'SUCCESS' },
            },
            res
        );
        return res;
    }

    // =========================================================================
    // Config resolver
    // =========================================================================

    describe('RATE_FRESHNESS_MAX_AGE_SECONDS config resolution', () => {
        const { resolveRateFreshnessMaxAgeSeconds } = require('../src/config/rateFreshness');
        const logger = require('../src/config/logger');

        beforeEach(() => logger.warn.mockClear());

        test('absent -> safe default 1800, no warning', () => {
            expect(resolveRateFreshnessMaxAgeSeconds({})).toBe(1800);
            expect(logger.warn).not.toHaveBeenCalled();
        });

        test('valid in-range values are honored (600 and 1800 bounds inclusive)', () => {
            expect(resolveRateFreshnessMaxAgeSeconds({ RATE_FRESHNESS_MAX_AGE_SECONDS: '600' })).toBe(600);
            expect(resolveRateFreshnessMaxAgeSeconds({ RATE_FRESHNESS_MAX_AGE_SECONDS: '1800' })).toBe(1800);
            expect(resolveRateFreshnessMaxAgeSeconds({ RATE_FRESHNESS_MAX_AGE_SECONDS: '1799.5' })).toBe(1799.5);
        });

        test('malformed / non-finite / below-min / above-max fall back to 1800 with a warning', () => {
            for (const bad of ['not-a-number', 'NaN', 'Infinity', '300', '2500', '-1', '0']) {
                expect(resolveRateFreshnessMaxAgeSeconds({ RATE_FRESHNESS_MAX_AGE_SECONDS: bad })).toBe(1800);
            }
            expect(logger.warn).toHaveBeenCalled();
        });

        test('there is NO off value — the gate cannot be disabled via configuration', () => {
            for (const off of ['0', '-1', 'off', 'false', 'none', '']) {
                expect(resolveRateFreshnessMaxAgeSeconds({ RATE_FRESHNESS_MAX_AGE_SECONDS: off })).toBe(1800);
            }
        });
    });

    // =========================================================================
    // Gate helper: deterministic boundary (injected clock, no sleeps)
    // =========================================================================

    describe('gate boundary contract (deterministic, injected clock)', () => {
        const NOW = new Date('2026-09-17T12:00:00.000Z');
        const at = (ageSeconds) => new Date(NOW.getTime() - second(ageSeconds));

        test('age 0 -> accepted', async () => {
            await seedSettings({ lastExternalSync: at(0) });
            const rate = await getFreshServerRateGhsPerUsdc({ prisma, now: NOW });
            expect(rate.rateGhsPerUsdc).toBe(13.42);
            expect(rate.externalAgeSeconds).toBe(0);
        });

        test('age 599s -> accepted', async () => {
            await seedSettings({ lastExternalSync: at(599) });
            const rate = await getFreshServerRateGhsPerUsdc({ prisma, now: NOW });
            expect(rate.rateGhsPerUsdc).toBe(13.42);
        });

        test('age EXACTLY 1800s -> accepted (documented boundary: age <= maxAge is fresh)', async () => {
            await seedSettings({ lastExternalSync: at(1800) });
            const rate = await getFreshServerRateGhsPerUsdc({ prisma, now: NOW });
            expect(rate.rateGhsPerUsdc).toBe(13.42);
        });

        test('age 1800.001s -> REJECTED (age > maxAge is stale)', async () => {
            await seedSettings({ lastExternalSync: new Date(NOW.getTime() - second(1800) - 1) });
            await expect(getFreshServerRateGhsPerUsdc({ prisma, now: NOW }))
                .rejects.toMatchObject({ code: 'RATE_STALE', statusCode: 503 });
        });

        test('age > 1800s -> REJECTED with RATE_STALE', async () => {
            await seedSettings({ lastExternalSync: at(3600) });
            await expect(getFreshServerRateGhsPerUsdc({ prisma, now: NOW }))
                .rejects.toMatchObject({ code: 'RATE_STALE' });
        });

        test('missing timestamp -> RATE_UNAVAILABLE', async () => {
            await seedSettings({ lastExternalSync: null });
            await expect(getFreshServerRateGhsPerUsdc({ prisma, now: NOW }))
                .rejects.toMatchObject({ code: 'RATE_UNAVAILABLE' });
        });

        test('future timestamp (beyond the tiny skew allowance) -> REJECTED, never infinitely fresh', async () => {
            await seedSettings({ lastExternalSync: new Date(NOW.getTime() + second(600)) });
            await expect(getFreshServerRateGhsPerUsdc({ prisma, now: NOW }))
                .rejects.toMatchObject({ code: 'RATE_STALE' });
        });

        test('invalid timestamp data -> REJECTED', async () => {
            await seedSettings({ lastExternalSync: null }); // NULL is the representable invalid case
            await expect(getFreshServerRateGhsPerUsdc({ prisma, now: NOW }))
                .rejects.toMatchObject({ code: 'RATE_UNAVAILABLE' });
        });

        test('non-positive / invalid retail rate with a FRESH timestamp -> REJECTED', async () => {
            await seedSettings({ lastExternalSync: at(60), liveRetailRate: 0, liveUsdToGhs: 0 });
            await expect(getFreshServerRateGhsPerUsdc({ prisma, now: NOW }))
                .rejects.toMatchObject({ code: 'RATE_UNAVAILABLE' });

            await seedSettings({ lastExternalSync: at(60), liveRetailRate: -5, liveUsdToGhs: -5 });
            await expect(getFreshServerRateGhsPerUsdc({ prisma, now: NOW }))
                .rejects.toMatchObject({ code: 'RATE_UNAVAILABLE' });
        });

        test('canonical retail rate wins over the legacy headline rate (same resolution as the ungated reader)', async () => {
            await seedSettings({ lastExternalSync: at(60), liveRetailRate: 13.42, liveUsdToGhs: 13.10 });
            expect((await getFreshServerRateGhsPerUsdc({ prisma, now: NOW })).rateGhsPerUsdc).toBe(13.42);

            // Legacy fallback when the retail field is missing.
            await seedSettings({ lastExternalSync: at(60), liveRetailRate: 0, liveUsdToGhs: 13.10 });
            expect((await getFreshServerRateGhsPerUsdc({ prisma, now: NOW })).rateGhsPerUsdc).toBe(13.10);
        });
    });

    // =========================================================================
    // Mounted route: generic POST /api/deposit/fiat/initiate
    // =========================================================================

    describe('generic /fiat/initiate (mounted handler, real Prisma)', () => {
        test('1. FRESH external observation -> 201, quote created, expected rate, true rateAsOf, 600s TTL', async () => {
            const externalTs = new Date(Date.now() - second(60));
            await seedSettings({ lastExternalSync: externalTs });
            const user = await seedUser(prisma);

            const res = await initiateGeneric(user);

            expect(res.statusCode).toBe(201);
            expect(res.payload.success).toBe(true);
            expect(res.payload.data.quotedRate).toBe(13.42);
            expect(res.payload.data.quoteValidUntil).toBeTruthy();

            const quotes = await quotesFor(user.id);
            expect(quotes).toHaveLength(1);
            expect(Number(quotes[0].rateGhsPerUsdc)).toBe(13.42);
            expect(new Date(quotes[0].rateAsOf).getTime()).toBe(externalTs.getTime());
            // 600-second quote TTL unchanged.
            expect((new Date(quotes[0].expiresAt) - new Date(quotes[0].createdAt)) / 1000).toBe(600);
        });

        test('3. external observation 30+ minutes old -> 503 RATE_STALE, no quote, no PENDING intent', async () => {
            await seedSettings({ lastExternalSync: new Date(Date.now() - second(3600)) });
            const user = await seedUser(prisma);
            const balanceBefore = (await prisma.user.findUnique({ where: { id: user.id } })).availableBalance;

            const res = await initiateGeneric(user);

            expect(res.statusCode).toBe(503);
            expect(res.payload).toEqual({
                success: false,
                message: 'Exchange rate is temporarily unavailable. Please retry shortly.',
                code: 'RATE_STALE',
            });
            expect(await quotesFor(user.id)).toHaveLength(0);
            expect(await pendingFor(user.id)).toHaveLength(0);
            const balanceAfter = (await prisma.user.findUnique({ where: { id: user.id } })).availableBalance;
            expect(Number(balanceAfter)).toBe(Number(balanceBefore));
        });

        test('4. NULL external provenance with an otherwise valid rate -> 503 RATE_UNAVAILABLE, no financial intent', async () => {
            await seedSettings({ lastExternalSync: null });
            const user = await seedUser(prisma);

            const res = await initiateGeneric(user);

            expect(res.statusCode).toBe(503);
            expect(res.payload.code).toBe('RATE_UNAVAILABLE');
            expect(await quotesFor(user.id)).toHaveLength(0);
            expect(await pendingFor(user.id)).toHaveLength(0);
        });

        test('5. a recent admin override does NOT refresh freshness', async () => {
            await seedSettings({
                lastExternalSync: null,
                lastAdminSetAt: new Date(Date.now() - second(30)),
                liveRateSource: 'AZM_ADMIN_OVERRIDE',
            });
            const user = await seedUser(prisma);

            const res = await initiateGeneric(user);

            expect(res.statusCode).toBe(503);
            expect(res.payload.code).toBe('RATE_UNAVAILABLE');
            expect(await quotesFor(user.id)).toHaveLength(0);
        });

        test('6. a recent MOCK echo does NOT refresh freshness', async () => {
            await seedSettings({
                lastExternalSync: new Date(Date.now() - second(3600)),
                lastEchoAt: new Date(Date.now() - second(30)),
            });
            const user = await seedUser(prisma);

            const res = await initiateGeneric(user);

            expect(res.statusCode).toBe(503);
            expect(res.payload.code).toBe('RATE_STALE');
            expect(await quotesFor(user.id)).toHaveLength(0);
        });

        test('7. a recent legacy lastRateSync CANNOT bypass the gate', async () => {
            await seedSettings({
                lastExternalSync: null,
                lastRateSync: new Date(Date.now() - second(30)),
            });
            const user = await seedUser(prisma);

            const res = await initiateGeneric(user);

            expect(res.statusCode).toBe(503);
            expect(res.payload.code).toBe('RATE_UNAVAILABLE');
            expect(await quotesFor(user.id)).toHaveLength(0);
        });

        test('8. FUTURE external timestamp -> no quote issued', async () => {
            await seedSettings({ lastExternalSync: new Date(Date.now() + second(600)) });
            const user = await seedUser(prisma);

            const res = await initiateGeneric(user);

            expect(res.statusCode).toBe(503);
            expect(res.payload.code).toBe('RATE_STALE');
            expect(await quotesFor(user.id)).toHaveLength(0);
        });

        test('9. invalid retail rate with fresh timestamp -> 503, no quote', async () => {
            await seedSettings({ lastExternalSync: new Date(Date.now() - second(60)), liveRetailRate: 0, liveUsdToGhs: 0 });
            const user = await seedUser(prisma);

            const res = await initiateGeneric(user);

            expect(res.statusCode).toBe(503);
            expect(res.payload.code).toBe('RATE_UNAVAILABLE');
            expect(await quotesFor(user.id)).toHaveLength(0);
            expect(await pendingFor(user.id)).toHaveLength(0);
        });
    });

    // =========================================================================
    // Mounted route: Moolre POST /api/deposit/fiat/initiate/moolre
    // =========================================================================

    describe('moolre /fiat/initiate/moolre (mounted handler, real Prisma)', () => {
        test('10a. FRESH rate -> 201 with quote + PENDING intent and provider initiation', async () => {
            const externalTs = new Date(Date.now() - second(60));
            await seedSettings({ lastExternalSync: externalTs });
            const user = await seedUser(prisma);

            const { res, moolre } = await initiateMoolre(user);

            expect(res.statusCode).toBe(201);
            expect(res.payload.data.quotedRate).toBe(13.42);
            expect(moolre.initiatePayment).toHaveBeenCalledTimes(1);

            const quotes = await quotesFor(user.id);
            expect(quotes).toHaveLength(1);
            expect(Number(quotes[0].rateGhsPerUsdc)).toBe(13.42);
            expect(new Date(quotes[0].rateAsOf).getTime()).toBe(externalTs.getTime());
            expect((new Date(quotes[0].expiresAt) - new Date(quotes[0].createdAt)) / 1000).toBe(600);

            const pending = await pendingFor(user.id);
            expect(pending).toHaveLength(1);
            expect(pending[0].metadata.rateAtInitiation).toBe(13.42);
        });

        test('10b/11/14. STALE rate -> 503 RATE_STALE BEFORE provider initiation; no quote, no PENDING, no balance change', async () => {
            await seedSettings({ lastExternalSync: new Date(Date.now() - second(3600)) });
            const user = await seedUser(prisma);
            const balanceBefore = (await prisma.user.findUnique({ where: { id: user.id } })).availableBalance;

            const { res, moolre } = await initiateMoolre(user);

            expect(res.statusCode).toBe(503);
            expect(res.payload).toEqual({
                success: false,
                message: 'Exchange rate is temporarily unavailable. Please retry shortly.',
                code: 'RATE_STALE',
            });
            // The provider was NEVER contacted.
            expect(moolre.initiatePayment).not.toHaveBeenCalled();
            expect(await quotesFor(user.id)).toHaveLength(0);
            expect(await pendingFor(user.id)).toHaveLength(0);
            const balanceAfter = (await prisma.user.findUnique({ where: { id: user.id } })).availableBalance;
            expect(Number(balanceAfter)).toBe(Number(balanceBefore));
        });

        test('10c. NULL external provenance -> the SAME gate outcome on the Moolre route', async () => {
            await seedSettings({ lastExternalSync: null });
            const user = await seedUser(prisma);

            const { res, moolre } = await initiateMoolre(user);

            expect(res.statusCode).toBe(503);
            expect(res.payload.code).toBe('RATE_UNAVAILABLE');
            expect(moolre.initiatePayment).not.toHaveBeenCalled();
            expect(await quotesFor(user.id)).toHaveLength(0);
        });

        test('10d. recent admin override cannot bypass the Moolre gate', async () => {
            await seedSettings({
                lastExternalSync: new Date(Date.now() - second(3600)),
                lastAdminSetAt: new Date(Date.now() - second(30)),
                liveRateSource: 'AZM_ADMIN_OVERRIDE',
            });
            const user = await seedUser(prisma);

            const { res, moolre } = await initiateMoolre(user);

            expect(res.statusCode).toBe(503);
            expect(res.payload.code).toBe('RATE_STALE');
            expect(moolre.initiatePayment).not.toHaveBeenCalled();
            expect(await quotesFor(user.id)).toHaveLength(0);
        });
    });

    // =========================================================================
    // Settlement of already-issued quotes is untouched by the gate
    // =========================================================================

    describe('existing quotes remain settleable at their persisted fixed price', () => {
        test('12/13. quote issued while fresh stays settleable after the rate goes STALE and DRIFTS', async () => {
            await seedSettings({ lastExternalSync: new Date(Date.now() - second(60)) });
            const user = await seedUser(prisma);

            // 1. Issue the quote at rate A = 13.42.
            const initiated = await initiateGeneric(user, 134.20);
            expect(initiated.statusCode).toBe(201);
            const reference = initiated.payload.data.reference;
            const quotedUsdc = initiated.payload.data.usdcEquivalent;
            const balanceBefore = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);

            // 2. The current rate goes stale AND drifts to rate B = 12.00.
            await seedSettings({
                liveRetailRate: 12.00,
                liveUsdToGhs: 12.00,
                lastExternalSync: new Date(Date.now() - second(3600)),
            });

            // 3. A late webhook settles the still-valid quote.
            const settled = await webhook(reference, 134.20);

            expect(settled.statusCode).toBe(200);
            expect(settled.payload.success).toBe(true);
            // Credited USDC is the ORIGINAL quote amount — no re-pricing.
            expect(settled.payload.data.usdcEquivalent).toBe(quotedUsdc);
            expect(settled.payload.data.rate).toBe(13.42);

            const tx = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
            expect(tx.status).toBe('COMPLETED');
            expect(Number(tx.amountUsdc)).toBeCloseTo(Number(quotedUsdc), 8);

            const balanceAfter = Number((await prisma.user.findUnique({ where: { id: user.id } })).availableBalance);
            expect(balanceAfter - balanceBefore).toBeCloseTo(Number(quotedUsdc), 8);
        });

        test('a NEW quote while stale is still refused — the gate only guards creation', async () => {
            await seedSettings({ lastExternalSync: new Date(Date.now() - second(3600)) });
            const user = await seedUser(prisma);
            const res = await initiateGeneric(user);
            expect(res.statusCode).toBe(503);
            expect(res.payload.code).toBe('RATE_STALE');
        });
    });

    // =========================================================================
    // Mounted-path proof: both routes resolve to the gated handlers
    // =========================================================================

    describe('mounted wiring proof (issue #271 invariant)', () => {
        test('every mounted fiat initiation route resolves to the handler that passes through the gate', () => {
            // Walk the REAL Express router stack of routes/depositRoutes.js.
            const handlers = {};
            for (const layer of depositRouter.stack) {
                if (!layer.route) continue;
                const method = layer.route.stack[0].method.toUpperCase();
                handlers[`${method} ${layer.route.path}`] = layer.route.stack[layer.route.stack.length - 1].handle;
            }
            // Both mounted initiation routes are the gated controllers tested above.
            expect(handlers['POST /fiat/initiate']).toBe(quoteFiatDepositController.initiate);
            expect(handlers['POST /fiat/initiate/moolre']).toBe(moolreQuoteDepositController.initiate);
        });
    });
});
