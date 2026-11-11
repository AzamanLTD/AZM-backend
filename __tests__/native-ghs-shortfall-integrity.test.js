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
    // §P0 GHS amount-risk policy: the gate REFUSES a payout while this policy is
    // absent, partial or malformed, so a suite that exercises the happy path
    // configures one explicitly. The numbers are deliberately far above every
    // fixture amount in this suite so no amount rule fires here.
    process.env.GHS_RISK_AMOUNT_POLICY = process.env.GHS_RISK_AMOUNT_POLICY
        || '{"largeGhs":1000000,"hugeGhs":2000000,"newAccountMinGhs":900000}';
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

    // ── WP-C: the executable shortfall quote no longer exists ───────────────
    // The proofs below keep their original subject — DIRECTION correctness, the
    // disclosed-debit-equals-debit rule, and zero mutation when the split has
    // moved — but they now prove it against the refusal, because a USDC-funded
    // conversion may not execute until the platform can evidence the GHS asset
    // it would create. Historical rows (already committed) keep the old shape
    // and are exercised in native-ghs-funded-shortfall-reversal.test.js.

    // "TransactionQuote" is created by infra/install-transaction-quote-overlay.js,
    // so it has no Prisma delegate: count it through SQL or the assertion would
    // silently test an undefined property.
    const quoteCount = async () => {
        const rows = await prisma.$queryRaw`SELECT count(*)::int AS c FROM "TransactionQuote"`;
        return rows[0].c;
    };

    test('the shortfall route refuses to mint a direction-bearing conversion quote', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 20 });
        const before = await quoteCount();

        const quoted = await quotePost(buildApp(), user, { amountGhs: '50.00' });

        expect(quoted.status).toBe(200);
        expect(quoted.body.quote).toBeNull();
        expect(quoted.body.plan.requiresQuote).toBe(true);
        expect(quoted.body.plan.shortfallGhs).toBe('30.00');
        expect(quoted.body.shortfallFunding).toEqual({
            executable: false,
            code: 'NATIVE_GHS_SHORTFALL_BACKING_UNAVAILABLE',
            message: expect.stringContaining('cannot yet evidence the GHS'),
        });
        // No quote row is persisted, so no direction can be read backwards by a
        // settlement path and nothing can be consumed later.
        expect(await quoteCount()).toBe(before);
    });

    test('a shortfall execution refuses with the backing code and debits nothing', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 20, availableBalance: 1000 });
        const app = buildApp();
        const before = await ghsOf(user.id);
        const reservationsBefore = await prisma.fiatLiquidityReservation.count();
        // seedUser seeds a DEPOSIT_CRYPTO row, so the invariant is "unchanged
        // and no WITHDRAWAL row", not "zero rows".
        const txBefore = await prisma.transactionHistory.count({ where: { userId: user.id } });

        const res = await ghsPost(app, user, { amountGhs: '50.00', quoteId: randomUUID() });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('NATIVE_GHS_SHORTFALL_BACKING_UNAVAILABLE');
        expect(res.body.message).toContain('no USDC was debited');

        const after = await ghsOf(user.id);
        expect(after.usdc).toBe(before.usdc);  // no USDC debit
        expect(after.ghs).toBe(before.ghs);    // no GHS credit, no GHS debit
        expect(await prisma.fiatLiquidityReservation.count()).toBe(reservationsBefore);
        expect(await prisma.transactionHistory.count({ where: { userId: user.id } })).toBe(txBefore);
        // `type` is an enum: filter in JS rather than sending a String filter.
        const types = (await prisma.transactionHistory.findMany({
            where: { userId: user.id }, select: { type: true },
        })).map((r) => String(r.type));
        expect(types.filter((t) => t.startsWith('WITHDRAWAL'))).toHaveLength(0);
    });

    test('a refused shortfall leaves no withdrawal, no ledger posting and no consumed quote', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 20, availableBalance: 1000 });
        const app = buildApp();
        const ledgerBefore = await prisma.ledgerTransaction.count();
        const quoteBefore = await quoteCount();

        const res = await ghsPost(app, user, { amountGhs: '50.00', quoteId: randomUUID() });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('NATIVE_GHS_SHORTFALL_BACKING_UNAVAILABLE');
        expect(await prisma.withdrawal.count({ where: { userId: user.id } })).toBe(0);
        expect(await prisma.ledgerTransaction.count()).toBe(ledgerBefore);
        expect(await quoteCount()).toBe(quoteBefore);
    });

    test('GHS spent after a quote: the refusal is the same and nothing is converted', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 20, availableBalance: 1000 });
        const app = buildApp();

        await prisma.user.update({ where: { id: user.id }, data: { nativeGhsBalance: { decrement: 10 } } });
        const mid = await ghsOf(user.id);

        const res = await ghsPost(app, user, { amountGhs: '50.00', quoteId: randomUUID() });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('NATIVE_GHS_SHORTFALL_BACKING_UNAVAILABLE');

        const after = await ghsOf(user.id);
        expect(after.usdc).toBe(mid.usdc);
        expect(after.ghs).toBe(mid.ghs);
        // and the preflight still reports the plan honestly, unchanged by the
        // refusal
        const requote = await quotePost(app, user, { amountGhs: '50.00' });
        expect(requote.status).toBe(200);
        expect(requote.body.plan.shortfallGhs).toBe('40.00');
        expect(requote.body.quote).toBeNull();
    });
});
