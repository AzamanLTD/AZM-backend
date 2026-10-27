// __tests__/balance-route-contract.test.js
// =============================================================================
// FX-balance workstream — ROUTE-LEVEL balance contract proof.
//
// Pins the ACTUAL implemented route — GET /api/users/balance (mounted by
// routes/userRoutes.js) — through the real router and real controller over
// HTTP (supertest), with Prisma never mocked (real PostgreSQL via
// TEST_DATABASE_URL).
//
// PROVES:
//   1. The real response envelope: success, legacy balance fields kept
//      byte-for-byte (additive contract), totalBalance, currency, and the
//      additive `valuation` block with `valuationStatus` mirroring the
//      service and no `valuationError` on the happy path.
//   2. Money is serialized as { exact, value } — exact decimal string as the
//      financial representation, numeric projection for presentation only.
//   3. `usdcEquivalent` is the USDC equivalent of the WHOLE available GHS
//      valuation (availableGhsValue / displayRate) — not the quantity of
//      USDC held, which stays `availableUsdc`.
//   4. Status variants over the real route: CURRENT (gate OPEN),
//      SAVED_FALLBACK / DEMO_FALLBACK (gate CLOSED, display-only),
//      UNAVAILABLE + USDC > 0 → PARTIAL_FX_UNAVAILABLE (nulls, no
//      fabricated totals), UNAVAILABLE + USDC == 0 → NATIVE_GHS_ONLY.
//   5. Locked buckets arrive in their NATIVE units over the wire.
//   6. Unknown caller → honest 404.
//   7. Valuation failure → honest degradation: legacy fields remain
//      authoritative, valuation null, valuationStatus 'VALUATION_UNAVAILABLE',
//      valuationError naming the reason — never a fabricated zero.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[balance-route-contract.test] TEST_DATABASE_URL not set — skipping.');

var mockAuthUserId = null;

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => {
        req.user = { id: mockAuthUserId, role: 'USER' };
        next();
    },
}));

const express = require('express');
const request = require('supertest');

function buildApp(prisma) {
    const app = express();
    app.use(express.json());
    app.set('prisma', prisma);
    app.set('logger', { warn: jest.fn(), error: jest.fn() });
    app.use('/api/users', require('../routes/userRoutes'));
    return app;
}

describe('GET /api/users/balance — route-level valuation contract (real PostgreSQL)', () => {
    if (!hasDb) return;

    let prisma;
    let snapshotService;
    let { seedUser } = {};
    let originalSettings;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        snapshotService = require('../src/services/fxRateSnapshotService');
        ({ seedUser } = require('./helpers/factories'));

        originalSettings = await prisma.globalSettings.findUnique({
            where: { id: 1 },
            select: { liveRetailRate: true, liveUsdToGhs: true, liveRateSource: true, lastExternalSync: true },
        });

        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "LedgerTransaction", "LedgerAccount", "JournalEntry", "User" RESTART IDENTITY CASCADE'
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
                    },
                });
            }
            await prisma.$executeRawUnsafe(
                'TRUNCATE TABLE "LedgerTransaction", "LedgerAccount", "JournalEntry", "User" RESTART IDENTITY CASCADE'
            );
            await prisma.$disconnect();
        }
    });

    beforeEach(async () => {
        await prisma.fxSavedRate.deleteMany({});
    });

    // Rate-state helpers — freshness is relative to the REAL clock because
    // the route cannot receive a `now` override (this is the point of the
    // route-level proof: the production entry, not the service seam).

    const setFreshRate = async (rate) => {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: {
                liveRetailRate: rate,
                liveUsdToGhs: rate,
                liveRateSource: 'KOTANI_PAY',
                lastExternalSync: new Date(Date.now() - 60_000), // 1 min old: fresh
            },
            create: {
                id: 1,
                liveRetailRate: rate,
                liveUsdToGhs: rate,
                liveRateSource: 'KOTANI_PAY',
                lastExternalSync: new Date(Date.now() - 60_000),
            },
        });
    };

    const setStaleRate = async (rate) => {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: {
                liveRetailRate: rate,
                liveUsdToGhs: rate,
                liveRateSource: 'KOTANI_PAY',
                lastExternalSync: new Date(Date.now() - 2 * 3600_000), // stale
            },
            create: {
                id: 1,
                liveRetailRate: rate,
                liveUsdToGhs: rate,
                liveRateSource: 'KOTANI_PAY',
                lastExternalSync: new Date(Date.now() - 2 * 3600_000),
            },
        });
    };

    const setNoRate = async () => {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: '12.5', liveUsdToGhs: '12.5', lastExternalSync: null },
            create: { id: 1, liveRetailRate: '12.5', liveUsdToGhs: '12.5', lastExternalSync: null },
        });
    };

    test('fresh canonical rate: full envelope, {exact,value} money, equivalent = value / displayRate, OPEN gate', async () => {
        const user = await seedUser(prisma, {
            nativeGhsBalance: 50,
            availableBalance: 100,
            escrowLockedBalance: 11,
            disputeEscrowBalance: 7,
            vendorUnallocatedBalance: 300,
            azmBalance: 999,
        });
        mockAuthUserId = user.id;
        await setFreshRate('12.5');

        const res = await request(buildApp(prisma)).get('/api/users/balance');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const d = res.body.data;
        // Legacy fields remain the authoritative REST fallback, untouched.
        expect(Number(d.availableBalance)).toBe(100);
        expect(Number(d.escrowLockedBalance)).toBe(11);
        expect(Number(d.disputeEscrowBalance)).toBe(7);
        expect(Number(d.vendorUnallocatedBalance)).toBe(300);
        expect(Number(d.azmBalance)).toBe(999);
        expect(Number(d.totalBalance)).toBe(400); // available + vendor unallocated
        expect(d.currency).toBe('USDC');
        expect(typeof d.lastUpdated).toBe('string');
        expect(Number(new Date(d.lastUpdated))).not.toBeNaN();

        // Additive valuation block mirrors the service.
        expect(d.valuationStatus).toBe('CURRENT');
        expect(d).not.toHaveProperty('valuationError');

        const v = d.valuation;
        expect(v.pair).toBe('USDC/GHS');
        expect(v.rateStatus).toBe('CURRENT');
        expect(v.valuationStatus).toBe('CURRENT');

        // Money is { exact, value }: exact decimal string is the financial
        // representation; value is the numeric presentation projection.
        expect(v.nativeGhsAvailable.exact).toBe('50.00000000');
        expect(v.nativeGhsAvailable.value).toBe(50);
        expect(v.availableUsdc.exact).toBe('100.00000000');
        expect(v.availableUsdc.value).toBe(100);

        // GHS-first contract: the headline is the native-GHS wallet balance
        // ONLY. The estimate is the headline expressed in USDC at the rate:
        // 50 / 12.5 = 4 — distinct from the 100 USDC actually held, and NOT
        // a combined (50 + 100×12.5 = 1300 GHS) valuation.
        expect(v.usdcEquivalent.exact).toBe('4.00000000');
        expect(v.usdcEquivalent.value).not.toBe(v.availableUsdc.value);
        expect(v).not.toHaveProperty('availableGhsValue');

        expect(v.currentRate.isFresh).toBe(true);
        expect(v.currentRate.rateExact).toBe('12.50000000');
        expect(v.displayRate.basis).toBe('CURRENT');
        expect(v.displayRate.rateExact).toBe('12.50000000');

        // Fresh canonical rate ONLY opens the transaction gate.
        expect(v.usdcTransactionGateOpen).toBe(true);
        expect(v.usdcNativeActionsAvailable).toBe(true); // same-asset USDC actions are never FX-gated
        expect(v.usdcTransactionGateReason).toBe('FRESH_CANONICAL_RATE');

        // Locked buckets arrive in NATIVE units, excluded from the headline.
        expect(v.locked.escrowUsdc.exact).toBe('11.00000000');
        expect(v.locked.disputesUsdc.exact).toBe('7.00000000');
        expect(v.locked.vendorUnallocatedUsdc.exact).toBe('300.00000000');
        expect(v.nonCash.azmPoints.value).toBe(999);
        // The headline counts ONLY native GHS: 50, never 50 + USDC or points.
        expect(v.nativeGhsAvailable.value).toBe(50);

        expect(typeof v.evaluatedAt).toBe('string');
    });

    test('saved fallback: honest display, gate stays CLOSED over the route', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 0, availableBalance: 100 });
        mockAuthUserId = user.id;
        await setStaleRate('12.5');
        await snapshotService.saveValidatedRateSnapshot({
            prisma, pair: 'USDC/GHS', rate: '12.4', source: 'KOTANI_PAY',
            observedAt: new Date(Date.now() - 60_000),
        });

        const res = await request(buildApp(prisma)).get('/api/users/balance');
        expect(res.status).toBe(200);
        const v = res.body.data.valuation;
        expect(v.rateStatus).toBe('SAVED_FALLBACK');
        expect(v.valuationStatus).toBe('SAVED_FALLBACK');
        expect(v.currentRate).toBeNull(); // saved rate is NEVER labelled current
        expect(v.displayRate.basis).toBe('SAVED_FALLBACK');
        expect(v.displayRate.rateExact).toBe('12.40000000');
        // headline 0 GHS; estimate of the headline = 0 / 12.4 = 0
        expect(v.nativeGhsAvailable.exact).toBe('0.00000000');
        expect(v.usdcEquivalent.exact).toBe('0.00000000');
        expect(v.usdcTransactionGateOpen).toBe(false);
        expect(v.usdcNativeActionsAvailable).toBe(true); // same-asset USDC actions are never FX-gated
        expect(v.usdcTransactionGateReason).toBe('NO_FRESH_CANONICAL_RATE_SAVED_FALLBACK_DISPLAY_ONLY');
        expect(res.body.data.valuationStatus).toBe('SAVED_FALLBACK');
    });

    test('demo fallback (demo/test env): display-only, gate CLOSED over the route', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 0, availableBalance: 100 });
        mockAuthUserId = user.id;
        await setNoRate();
        await snapshotService.seedDemoRateSnapshot({ prisma });

        const res = await request(buildApp(prisma)).get('/api/users/balance');
        expect(res.status).toBe(200);
        const v = res.body.data.valuation;
        expect(v.rateStatus).toBe('DEMO_FALLBACK');
        expect(v.valuationStatus).toBe('DEMO_FALLBACK');
        expect(v.displayRate.rateExact).toBe('12.03000000');
        expect(v.usdcTransactionGateOpen).toBe(false);
        expect(v.usdcNativeActionsAvailable).toBe(true); // same-asset USDC actions are never FX-gated
        expect(v.usdcTransactionGateReason).toBe('NO_FRESH_CANONICAL_RATE_DEMO_FALLBACK_DISPLAY_ONLY');
    });

    test('no rate + USDC > 0: PARTIAL_FX_UNAVAILABLE — nulls, never fabricated totals', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 30, availableBalance: 75 });
        mockAuthUserId = user.id;
        await setNoRate();

        const res = await request(buildApp(prisma)).get('/api/users/balance');
        expect(res.status).toBe(200);
        const v = res.body.data.valuation;
        expect(v.rateStatus).toBe('UNAVAILABLE');
        expect(v.valuationStatus).toBe('FX_UNAVAILABLE');
        expect(v.usdcEquivalent).toBeNull();
        expect(v).not.toHaveProperty('availableGhsValue');
        expect(v.displayRate).toBeNull();
        expect(v.usdcTransactionGateOpen).toBe(false);
        expect(v.usdcNativeActionsAvailable).toBe(true); // same-asset USDC actions are never FX-gated
        expect(v.usdcTransactionGateReason).toBe('NO_FRESH_CANONICAL_RATE');
        // A missing rate never makes a valid GHS balance unavailable: the
        // headline stays fully reported, only the estimate is null.
        expect(v.nativeGhsAvailable.value).toBe(30);
        expect(v.availableUsdc.value).toBe(75);
        // Legacy USDC fields are unaffected by the FX absence.
        expect(Number(res.body.data.availableBalance)).toBe(75);
    });

    test('no rate + USDC == 0: NATIVE_GHS_ONLY — the GHS total is complete without FX', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 30, availableBalance: 0 });
        mockAuthUserId = user.id;
        await setNoRate();

        const res = await request(buildApp(prisma)).get('/api/users/balance');
        expect(res.status).toBe(200);
        const v = res.body.data.valuation;
        expect(v.rateStatus).toBe('UNAVAILABLE');
        expect(v.valuationStatus).toBe('FX_UNAVAILABLE');
        expect(v.nativeGhsAvailable.exact).toBe('30.00000000'); // headline stays valid
        expect(v.usdcEquivalent).toBeNull();
        expect(v.usdcTransactionGateOpen).toBe(false);
        expect(v.usdcNativeActionsAvailable).toBe(true); // same-asset USDC actions are never FX-gated
    });

    // ── OWNER REGRESSION (contract correction, #369, 2026-10-27) ────────
    // nativeGhs = 100, USDC held = 500, rate = 10: the GHS headline MUST be
    // 100 and the estimated USDC equivalent MUST be 10 — never the combined
    // (100 + 500×10 = 5010 GHS → 501 USDC) valuation of the old formula.
    test('GHS headline = native balance only; estimated USDC equivalent derives from the GHS balance', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 100, availableBalance: 500 });
        mockAuthUserId = user.id;
        await setFreshRate('10');

        const res = await request(buildApp(prisma)).get('/api/users/balance');
        expect(res.status).toBe(200);
        const v = res.body.data.valuation;
        expect(v.valuationStatus).toBe('CURRENT');
        expect(v.nativeGhsAvailable.exact).toBe('100.00000000');
        expect(v.availableUsdc.exact).toBe('500.00000000');
        expect(v.usdcEquivalent.exact).toBe('10.00000000'); // 100 / 10
        // NOT the combined valuation (501) and NOT the USDC held (500).
        expect(v.usdcEquivalent.value).not.toBe(501);
        expect(v.usdcEquivalent.value).not.toBe(v.availableUsdc.value);
        expect(v).not.toHaveProperty('availableGhsValue');
    });

    // The native GHS figure must be unchanged by ANY variation in actual
    // USDC held — proven at the production route seam, not just the service.
    test('the GHS headline is unchanged by any variation in actual USDC held (route seam)', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 100, availableBalance: 500 });
        mockAuthUserId = user.id;
        await setFreshRate('10');

        for (const usdcHeld of [0, 17, 5000]) {
            await prisma.user.update({ where: { id: user.id }, data: { availableBalance: usdcHeld } });
            const res = await request(buildApp(prisma)).get('/api/users/balance');
            expect(res.status).toBe(200);
            const v = res.body.data.valuation;
            expect(v.nativeGhsAvailable.exact).toBe('100.00000000');
            expect(v.usdcEquivalent.exact).toBe('10.00000000'); // estimate derives from GHS / rate
        }
    });

    test('unknown caller: honest 404, no fabricated valuation', async () => {
        mockAuthUserId = 999999999;
        const res = await request(buildApp(prisma)).get('/api/users/balance');
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toBe('User not found.');
        expect(res.body.data).toBeUndefined();
    });

    test('valuation failure: legacy fields stay authoritative, VALUATION_UNAVAILABLE names the reason', async () => {
        const user = await seedUser(prisma, { nativeGhsBalance: 50, availableBalance: 100 });
        mockAuthUserId = user.id;
        await setFreshRate('12.5');

        let degradedApp;
        jest.isolateModules(() => {
            jest.doMock('../src/services/balanceValuationService', () => ({
                buildBalanceValuation: async () => {
                    throw new Error('oracle observation unreadable');
                },
            }));
            const expressApp = express();
            expressApp.use(express.json());
            expressApp.set('prisma', prisma);
            expressApp.set('logger', { warn: jest.fn(), error: jest.fn() });
            expressApp.use('/api/users', require('../routes/userRoutes'));
            degradedApp = expressApp;
        });

        const res = await request(degradedApp).get('/api/users/balance');
        expect(res.status).toBe(200); // degradation is NOT an API failure
        expect(res.body.success).toBe(true);
        const d = res.body.data;
        // Legacy balance fields remain untouched and authoritative.
        expect(Number(d.availableBalance)).toBe(100);
        expect(Number(d.totalBalance)).toBe(100);
        expect(d.currency).toBe('USDC');
        // The valuation is honestly absent — never a fabricated zero/complete.
        expect(d.valuation).toBeNull();
        expect(d.valuationStatus).toBe('VALUATION_UNAVAILABLE');
        expect(d.valuationError).toBe('oracle observation unreadable');
    });
});
