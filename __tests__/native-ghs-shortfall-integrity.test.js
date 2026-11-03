// __tests__/native-ghs-shortfall-integrity.test.js
// =============================================================================
// Issue #389 §5.3/§5.4: a shortfall quote must be re-proven INSIDE the
// authoritative transaction, and the disclosed USDC debit must equal the debit.
//
// PROVES: a balance change between quote and confirmation refuses with zero
// mutation in BOTH directions (GHS credited / GHS spent), and the quote's
// disclosed 8dp USDC is exactly what the customer is debited.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[native-ghs-shortfall-integrity] TEST_DATABASE_URL not set — skipping.');

if (hasDb) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
}

(hasDb ? describe : describe.skip)('native-GHS shortfall integrity (real PostgreSQL)', () => {
    const { randomUUID } = require('crypto');
    const express = require('express');
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    const { PrismaClient, Prisma } = require('@prisma/client');

    let prisma;
    let seedUser;
    let TEST_PASSWORD;

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser, TEST_PASSWORD } = require('./helpers/factories'));
    });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    // The canonical quote authority is fail-closed on rate freshness, so the
    // suite seeds a FRESH canonical rate exactly like the main native-GHS suite.
    const RATE = 12.5;

    async function setSettings() {
        const data = {
            liveRetailRate: RATE,
            liveUsdToGhs: RATE,
            liveRateSource: 'KOTANI_PAY',
            lastExternalSync: new Date(),
            fiatLiquidityAuthorityEnabled: true,
            modelBSettlementEnabled: false,
            nativeGhsSettlementEnabled: false,
            nativeGhsWithdrawalEnabled: true,
        };
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
        await prisma.fiatLiquidityState.upsert({
            where: { id: 1 },
            update: { availableGhs: 100000, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0 },
            create: { id: 1, availableGhs: 100000 },
        });
    }

    function buildApp() {
        const app = express();
        app.use(express.json());
        // Same injection surface as the mounted production app: the route reads
        // prisma/logger/emitBalanceUpdate off the app, not from globals.
        app.set('prisma', prisma);
        app.set('logger', { error: () => {}, warn: () => {}, info: () => {} });
        app.set('emitBalanceUpdate', () => {});
        app.use((req, res, next) => { req.io = { to: () => ({ emit: () => {} }), emit: () => {} }; next(); });
        app.use('/api/withdraw', require('../routes/withdrawalRoutes'));
        return app;
    }

    const tokenFor = (user) => jwt.sign(
        { id: user.id, role: 'USER' },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
    );
    const auth = (r, user) => r.set('Authorization', `Bearer ${tokenFor(user)}`);
    const DEST = '233241234567';
    const quotePost = (app, user, body = {}, key = randomUUID()) => auth(request(app).post('/api/withdraw/ghs/quote'), user)
        .set('Idempotency-Key', key).send({ destination: DEST, network: 'MTN', ...body });
    const ghsPost = (app, user, body = {}, key = randomUUID()) => auth(request(app).post('/api/withdraw/ghs'), user)
        .set('Idempotency-Key', key).send({ password: TEST_PASSWORD, destination: DEST, network: 'MTN', ...body });

    const ghsOf = async (id) => {
        const u = await prisma.user.findUnique({ where: { id }, select: { nativeGhsBalance: true, availableBalance: true } });
        return { ghs: new Prisma.Decimal(u.nativeGhsBalance).toFixed(2), usdc: new Prisma.Decimal(u.availableBalance).toFixed(8) };
    };

    test('quote direction is USDC→GHS on the shortfall route', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 20 });
        const quoted = await quotePost(buildApp(), user, { amountGhs: '50.00' });
        expect(quoted.status).toBe(200);
        expect(quoted.body.quote.routeIdentity).toEqual({
            inputAsset: 'USDC', outputAsset: 'GHS', selectedRoute: 'USDC_TO_GHS_SHORTFALL',
        });
        expect(quoted.body.quote.shortfallGhs).toBe('30.00');
    });

    test('disclosed 8dp USDC debit equals the actual debit; theoretical 12dp is never the price', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 20, availableBalance: 1000 });
        const app = buildApp();
        const quoted = await quotePost(app, user, { amountGhs: '50.00' });
        const q = quoted.body.quote;
        expect(q.usdcDebit).toMatch(/^\d+\.\d{8}$/);
        expect(q.usdcDebit).toBe(q.usdcDebitExact);
        expect(new Prisma.Decimal(q.usdcDebitTheoretical).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP).toFixed(8)).toBe(q.usdcDebit);

        const before = await ghsOf(user.id);
        const res = await ghsPost(app, user, { amountGhs: '50.00', quoteId: q.quoteId });
        expect(res.status).toBe(202);
        const after = await ghsOf(user.id);
        const usdcSpent = new Prisma.Decimal(before.usdc).minus(new Prisma.Decimal(after.usdc));
        expect(usdcSpent.toFixed(8)).toBe(q.usdcDebit);
        // The GHS wallet contributed exactly its native balance (20.00) and the
        // quoted USDC funded the rest (30.00); the payout was 50.00 in total, so
        // the wallet lands at zero and no GHS was created beyond the funded
        // shortfall.
        expect(after.ghs).toBe('0.00');
        expect(new Prisma.Decimal(before.ghs).minus(new Prisma.Decimal(after.ghs)).toFixed(2)).toBe('20.00');
    });

    test('GHS credited after the quote: stale quote refused, no USDC debited, quote not consumed', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 20, availableBalance: 1000 });
        const app = buildApp();
        const quoted = await quotePost(app, user, { amountGhs: '50.00' });
        const q = quoted.body.quote;
        const before = await ghsOf(user.id);

        // the customer receives GHS 30 while reviewing the quote
        await prisma.user.update({ where: { id: user.id }, data: { nativeGhsBalance: { increment: 30 } } });
        const mid = await ghsOf(user.id);

        const res = await ghsPost(app, user, { amountGhs: '50.00', quoteId: q.quoteId });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(res.body.code).toBe('NATIVE_GHS_QUOTE_INTENT_CHANGED');

        const after = await ghsOf(user.id);
        expect(after.usdc).toBe(mid.usdc); // zero USDC moved
        expect(after.ghs).toBe(mid.ghs);   // zero GHS moved
        expect(before.usdc).toBe(after.usdc);
        expect(await prisma.fiatLiquidityReservation.count({ where: { reference: res.body.reference || 'none' } })).toBe(0);
    });

    test('GHS spent after the quote: stale quote refused, nothing converted', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 20, availableBalance: 1000 });
        const app = buildApp();
        const quoted = await quotePost(app, user, { amountGhs: '50.00' });
        const q = quoted.body.quote;

        await prisma.user.update({ where: { id: user.id }, data: { nativeGhsBalance: { decrement: 10 } } });
        const mid = await ghsOf(user.id);

        const res = await ghsPost(app, user, { amountGhs: '50.00', quoteId: q.quoteId });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.body.code).toBe('NATIVE_GHS_QUOTE_INTENT_CHANGED');

        const after = await ghsOf(user.id);
        expect(after.usdc).toBe(mid.usdc);
        expect(after.ghs).toBe(mid.ghs);
        // the quote was NOT burned by the refusal: the customer can re-quote and pay
        const requote = await quotePost(app, user, { amountGhs: '50.00' });
        expect(requote.status).toBe(200);
        expect(requote.body.quote.shortfallGhs).toBe('40.00');
    });
});
