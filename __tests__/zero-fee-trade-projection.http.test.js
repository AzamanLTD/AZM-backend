// __tests__/zero-fee-trade-projection.http.test.js
// =============================================================================
// HTTP-level proof that POST /api/trades/initiate advertises the SAME fee the
// settlement will charge. Goes through the real router, the real controller and
// the real resolver; only authentication (protectActive / require2FA) and
// idempotency are stubbed, because the claim is not the subject here.
//
// The bug this closes: the projection read only GlobalSettings.p2pFeePct, while
// settlement also applied GlobalSettings.feeByPaymentMethod, so a buyer could be
// shown a vendor-earnings estimate the trade would never pay.
// =============================================================================
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[zero-fee-trade-projection.http] TEST_DATABASE_URL not set — skipping.');

const { Prisma, PrismaClient } = require('@prisma/client');
const express = require('express');
const request = require('supertest');

// The buyer identity for the request under test.
global.__PROJECTION_BUYER__ = null;

jest.mock('../middleware/banGuardMiddleware', () => ({
    protectActive: (req, _res, next) => { req.user = { id: global.__PROJECTION_BUYER__ }; next(); },
    protectNotBanned: (req, _res, next) => next(),
    enforceBan: (req, _res, next) => next(),
}));
jest.mock('../middleware/require2FA', () => ({ require2FA: () => (req, _res, next) => next() }));
// Only the middleware is stubbed. This module ALSO exports commitOperation,
// which settlement calls, so everything else stays real.
jest.mock('../middleware/idempotency', () => {
    const actual = jest.requireActual('../middleware/idempotency');
    return { ...actual, idempotency: () => (req, _res, next) => next() };
});

describeOrSkip('Trade-creation earnings projection agrees with settlement (real PostgreSQL, HTTP)', () => {
    let prisma, p2pService, app;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        prisma = new PrismaClient();
        p2pService = require('../services/p2p.service');

        app = express();
        app.use(express.json());
        app.set('prisma', prisma);
        app.set('logger', { error: () => {}, warn: () => {}, info: () => {} });
        // The controller emits socket updates on the trade path; a no-op io
        // keeps the HTTP flow real without a socket server.
        app.set('socketio', { to: () => ({ emit: () => {} }), emit: () => {} });
        app.use('/api/trades', require('../routes/tradeRoutes'));
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.adminFeeProfile.deleteMany();
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "Trade", "Ad", "TransactionHistory", "AdminProfitLog", "SystemProfitFees", '
            + '"AuditLog", "LedgerTransaction", "JournalEntry", "LedgerAccount", "RestrictedObligation" RESTART IDENTITY CASCADE'
        );
    }, 20000);

    const { seedUser, seedVendor } = require('./helpers/factories');
    const tag = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    async function seedContext({ paymentMethod = 'Bank Transfer', amountCrypto = 100, rate = 15.5 } = {}) {
        const vendor = await seedVendor(prisma, { availableBalance: 5000, escrowLockedBalance: 0 });
        const buyer = await seedUser(prisma, {
            availableBalance: 5000, escrowLockedBalance: 0, kycStatus: 'VERIFIED',
        });
        const ad = await prisma.ad.create({
            data: {
                vendorId: vendor.id, type: 'SELL', crypto: 'USDT',
                pricePerUSD: rate, minLimit: 10, maxLimit: 500,
                paymentMethod, status: 'ACTIVE',
            },
        });
        global.__PROJECTION_BUYER__ = buyer.id;
        return { vendor, buyer, ad, amountCrypto, rate, paymentMethod };
    }

    const configure = (over = {}) => prisma.globalSettings.upsert({
        where: { id: 1 },
        update: { p2pFeePct: 0.01, tierThreshold: 1000, vendorShareUnder1k: 0.4, vendorShareOver1k: 0.5, feeByPaymentMethod: null, ...over },
        create: { id: 1, p2pFeePct: 0.01, tierThreshold: 1000, vendorShareUnder1k: 0.4, vendorShareOver1k: 0.5, feeByPaymentMethod: null, ...over },
    });

    const profile = (over = {}) => prisma.adminFeeProfile.create({
        data: {
            name: `hp-${tag()}`, targetScope: 'ALL', priority: 100, isActive: true,
            platformFeePct: 0.02, adminSplitPct: 0.6, vendorSplitPct: 0.4, exitFeePct: 0,
            ...over,
        },
    });

    async function initiate(ctx) {
        return request(app)
            .post('/api/trades/initiate')
            .send({
                adId: ctx.ad.id,
                amountCrypto: ctx.amountCrypto,
                amountFiat: ctx.amountCrypto * ctx.rate,
                paymentMethod: ctx.paymentMethod,
                idempotencyKey: `k-${tag()}`,
            });
    }

    // Settlement truth: complete an identically-configured trade and read what
    // the vendor actually received as their cut.
    async function settledVendorCut({ paymentMethod = 'Bank Transfer', amountCrypto = 100 } = {}) {
        const vendor = await seedVendor(prisma, { availableBalance: 0 });
        const user = await seedUser(prisma, { availableBalance: 0, escrowLockedBalance: amountCrypto });
        const trade = await prisma.trade.create({
            data: {
                userId: user.id, vendorId: vendor.id, type: 'BUY',
                crypto: 'USDT', amountCrypto, amountFiat: amountCrypto * 15.5,
                currency: 'GHS', rate: 15.5, paymentMethod,
                status: 'PAID', expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            },
        });
        await p2pService.completeTrade(prisma, { tradeId: trade.id, releasedByUserId: user.id });
        const done = await prisma.trade.findUnique({ where: { id: trade.id } });
        return Number(done.vendorProfitCut);
    }

    test('matched profile with platformFeePct 0 projects zero vendor earnings', async () => {
        await configure();
        await profile({ platformFeePct: 0 });
        const ctx = await seedContext();

        const res = await initiate(ctx);
        expect(res.status).toBe(201);
        expect(res.body.earnings.platformFeePct).toBe(0);
        expect(res.body.earnings.expectedVendorEarningsUsdc).toBe(0);
        expect(await settledVendorCut()).toBe(0);
    });

    test('matched profile admin 0 / vendor 1 agrees with settlement', async () => {
        await configure();
        await profile({ platformFeePct: 0.02, adminSplitPct: 0, vendorSplitPct: 1 });
        const ctx = await seedContext();

        const res = await initiate(ctx);
        expect(res.status).toBe(201);
        expect(res.body.earnings.vendorSplitPct).toBe(1);
        const projected = res.body.earnings.expectedVendorEarningsUsdc;
        // 100 * 2% * 1 = 2.00, exactly what settlement pays the vendor.
        expect(projected).toBeCloseTo(2, 6);
        expect(projected).toBeCloseTo(await settledVendorCut(), 6);
    });

    test('matched profile admin 1 / vendor 0 agrees with settlement', async () => {
        await configure();
        await profile({ platformFeePct: 0.02, adminSplitPct: 1, vendorSplitPct: 0 });
        const ctx = await seedContext();

        const res = await initiate(ctx);
        expect(res.status).toBe(201);
        expect(res.body.earnings.vendorSplitPct).toBe(0);
        expect(res.body.earnings.expectedVendorEarningsUsdc).toBe(0);
        expect(await settledVendorCut()).toBe(0);
    });

    test('no profile keeps the GlobalSettings fallback intact', async () => {
        await configure();
        await prisma.adminFeeProfile.deleteMany();
        const ctx = await seedContext();

        const res = await initiate(ctx);
        expect(res.status).toBe(201);
        expect(res.body.earnings.platformFeePct).toBeCloseTo(0.01, 8);
        expect(res.body.earnings.vendorSplitPct).toBeCloseTo(0.4, 8);
        // 100 * 1% * 0.4 = 0.40
        expect(res.body.earnings.expectedVendorEarningsUsdc).toBeCloseTo(0.4, 6);
        expect(res.body.earnings.expectedVendorEarningsUsdc).toBeCloseTo(await settledVendorCut(), 6);
    });

    test('no profile WITH a payment-method override projects the override settlement uses', async () => {
        // Settlement applies feeByPaymentMethod on the fallback path; the old
        // projection ignored it and advertised 1% instead of 5%.
        await configure({ feeByPaymentMethod: { BANK_TRANSFER: 0.05 } });
        await prisma.adminFeeProfile.deleteMany();
        const ctx = await seedContext();

        const res = await initiate(ctx);
        expect(res.status).toBe(201);
        expect(res.body.earnings.platformFeePct).toBeCloseTo(0.05, 8);
        // 100 * 5% * 0.4 = 2.00
        expect(res.body.earnings.expectedVendorEarningsUsdc).toBeCloseTo(2, 6);
        expect(res.body.earnings.expectedVendorEarningsUsdc).toBeCloseTo(await settledVendorCut(), 6);
    });

    test('a matched zero profile with no method entry projects zero', async () => {
        await configure();
        await profile({ platformFeePct: 0, adminSplitPct: 0.6, vendorSplitPct: 0.4 });
        const ctx = await seedContext();

        const res = await initiate(ctx);
        expect(res.status).toBe(201);
        expect(res.body.earnings.platformFeePct).toBe(0);
        expect(res.body.earnings.expectedVendorEarningsUsdc).toBe(0);
        expect(await settledVendorCut()).toBe(0);
    });

    test('a matched zero profile WITH a method entry uses the override', async () => {
        // Preserved legacy precedence: an explicit per-method rate outranks the
        // profile's base rate, including a legitimate zero.
        await configure({ feeByPaymentMethod: { BANK_TRANSFER: 0.05 } });
        await profile({ platformFeePct: 0, adminSplitPct: 0.6, vendorSplitPct: 0.4 });
        const ctx = await seedContext();

        const res = await initiate(ctx);
        expect(res.status).toBe(201);
        expect(res.body.earnings.platformFeePct).toBeCloseTo(0.05, 8);
        // 100 * 5% * 0.4 (profile vendor split) = 2.00
        expect(res.body.earnings.expectedVendorEarningsUsdc).toBeCloseTo(2, 6);
        expect(res.body.earnings.expectedVendorEarningsUsdc).toBeCloseTo(await settledVendorCut(), 6);
    });

    test('a matched non-zero profile WITH a method entry uses the override', async () => {
        await configure({ feeByPaymentMethod: { BANK_TRANSFER: 0.05 } });
        await profile({ platformFeePct: 0.02, adminSplitPct: 0.6, vendorSplitPct: 0.4 });
        const ctx = await seedContext();

        const res = await initiate(ctx);
        expect(res.status).toBe(201);
        expect(res.body.earnings.platformFeePct).toBeCloseTo(0.05, 8);
        expect(res.body.earnings.expectedVendorEarningsUsdc).toBeCloseTo(2, 6);
        expect(res.body.earnings.expectedVendorEarningsUsdc).toBeCloseTo(await settledVendorCut(), 6);
    });

    test('the seeded System Default ALL profile plus an override agrees end to end', async () => {
        // Production shape after migration 20260525_phase_q1_admin_fee_profiles:
        // an active ALL profile matches every trade, so this is the case that
        // the old !hasProfile gate silently broke.
        await configure({ feeByPaymentMethod: { BANK_TRANSFER: 0.05 } });
        await prisma.adminFeeProfile.create({
            data: {
                name: `System Default ${tag()}`, targetScope: 'ALL', priority: 0, isActive: true,
                platformFeePct: 0.02, adminSplitPct: 0.6, vendorSplitPct: 0.4, exitFeePct: 0.02,
            },
        });
        const ctx = await seedContext();

        const res = await initiate(ctx);
        expect(res.status).toBe(201);
        expect(res.body.earnings.platformFeePct).toBeCloseTo(0.05, 8);
        expect(res.body.earnings.vendorSplitPct).toBeCloseTo(0.4, 8);
        expect(res.body.earnings.expectedVendorEarningsUsdc).toBeCloseTo(2, 6);
        expect(res.body.earnings.expectedVendorEarningsUsdc).toBeCloseTo(await settledVendorCut(), 6);
    });
});
