// __tests__/native-ghs-quote-intent-binding.test.js
// =============================================================================
// Issue #389 P1-2: a shortfall quote is bound to the payout it funds.
//
// A quote carrying only an amount is a consent to fund *a* payout, not *this*
// payout: the same quote could fund a different payee or a different amount
// that happens to need the same shortfall, and every money figure would still
// be correct. PROVES:
//   A. A quote minted for payee A cannot fund a payout to payee B, nothing
//      moves, and the refusal does NOT burn the quote (paying A still works).
//   B. A quote minted for 50.00 cannot fund 60.00.
//   C. An amount-only quote (no declared payee) cannot be spent on a payout
//      that names one.
//   D. The digest is a real function of rail, amount and payee.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[native-ghs-quote-intent-binding] TEST_DATABASE_URL not set — skipping.');

if (hasDb) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
}

(hasDb ? describe : describe.skip)('native-GHS quote intent binding (real PostgreSQL)', () => {
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

    const RATE = 12.5;
    const PAYEE_A = '233241234567';
    const PAYEE_B = '233559876543';

    async function setSettings() {
        const data = {
            liveRetailRate: RATE, liveUsdToGhs: RATE, liveRateSource: 'KOTANI_PAY',
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
        app.set('prisma', prisma);
        app.set('logger', { error: () => {}, warn: () => {}, info: () => {} });
        app.set('emitBalanceUpdate', () => {});
        app.use((req, res, next) => { req.io = { to: () => ({ emit: () => {} }), emit: () => {} }; next(); });
        app.use('/api/withdraw', require('../routes/withdrawalRoutes'));
        return app;
    }

    const tokenFor = (user) => jwt.sign({ id: user.id, role: 'USER' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const auth = (r, user) => r.set('Authorization', `Bearer ${tokenFor(user)}`);
    const quotePost = (app, user, body = {}) => auth(request(app).post('/api/withdraw/ghs/quote'), user)
        .set('Idempotency-Key', randomUUID()).send(body);
    const ghsPost = (app, user, body = {}) => auth(request(app).post('/api/withdraw/ghs'), user)
        .set('Idempotency-Key', randomUUID()).send({ password: TEST_PASSWORD, network: 'MTN', ...body });

    const stateOf = async (id) => {
        const u = await prisma.user.findUnique({ where: { id }, select: { nativeGhsBalance: true, availableBalance: true } });
        return { ghs: new Prisma.Decimal(u.nativeGhsBalance).toFixed(2), usdc: new Prisma.Decimal(u.availableBalance).toFixed(8) };
    };
    const quoteConsumed = async (quoteId) => {
        const rows = await prisma.$queryRawUnsafe('SELECT "consumedAt" FROM "TransactionQuote" WHERE "id" = $1::uuid', quoteId);
        return !!rows?.[0]?.consumedAt;
    };

    test('A: a quote for payee A cannot fund payee B, and is not burned by the attempt', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 20, availableBalance: 1000 });
        const app = buildApp();

        const quoted = await quotePost(app, user, { amountGhs: '50.00', destination: PAYEE_A });
        expect(quoted.status).toBe(200);
        const { quoteId } = quoted.body.quote;
        expect(quoted.body.quote.intent.rail).toBe('MOMO');
        expect(quoted.body.quote.intent.recipientGhs).toBe('50.00');

        const before = await stateOf(user.id);
        const ledgerBefore = await prisma.ledgerTransaction.count();

        const wrongPayee = await ghsPost(app, user, { amountGhs: '50.00', quoteId, destination: PAYEE_B });
        expect(wrongPayee.status).toBe(409);
        expect(wrongPayee.body.code).toBe('NATIVE_GHS_QUOTE_INTENT_MISMATCH');
        expect(await stateOf(user.id)).toEqual(before);
        expect(await prisma.ledgerTransaction.count()).toBe(ledgerBefore);
        // The refusal must not consume what the customer consented to.
        expect(await quoteConsumed(quoteId)).toBe(false);

        const rightPayee = await ghsPost(app, user, { amountGhs: '50.00', quoteId, destination: PAYEE_A });
        expect(rightPayee.status).toBe(202);
        expect(await quoteConsumed(quoteId)).toBe(true);
        const after = await stateOf(user.id);
        expect(new Prisma.Decimal(after.usdc).lessThan(new Prisma.Decimal(before.usdc))).toBe(true);
    });

    test('B: a quote for 50.00 cannot fund a 60.00 payout', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 20, availableBalance: 1000 });
        const app = buildApp();

        const quoted = await quotePost(app, user, { amountGhs: '50.00', destination: PAYEE_A });
        const { quoteId } = quoted.body.quote;
        const before = await stateOf(user.id);

        const res = await ghsPost(app, user, { amountGhs: '60.00', quoteId, destination: PAYEE_A });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('NATIVE_GHS_QUOTE_INTENT_MISMATCH');
        expect(await stateOf(user.id)).toEqual(before);
        expect(await quoteConsumed(quoteId)).toBe(false);
    });

    test('C: the API cannot mint an unbound quote, and one minted by hand is still refused', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 20, availableBalance: 1000 });
        const app = buildApp();

        // The quote route validates the payout shape, so a consent with no payee
        // cannot be minted through the API at all.
        const unbound = await quotePost(app, user, { amountGhs: '50.00' });
        expect(unbound.status).toBe(400);

        // Defence in depth: even a quote minted without a payee (here, straight
        // through the planner) cannot be spent on a payout that names one.
        const planner = require('../src/services/ghsFundingPlanner');
        const plan = planner.planGhsPayoutFunding({ amountGhs: '50.00', feeGhs: 0, availableNativeGhs: '20.00' });
        const manual = await planner.quoteGhsShortfall({
            prisma,
            marketOracle: undefined,
            userId: user.id,
            shortfallGhs: plan.shortfallGhs,
            intent: { rail: 'MOMO', recipientGhs: plan.recipientGhs, feeGhs: plan.feeGhs, destinationIdentity: null },
        });
        expect(manual.intent.destinationIdentity).toBe(null);

        const before = await stateOf(user.id);
        const res = await ghsPost(app, user, { amountGhs: '50.00', quoteId: manual.quoteId, destination: PAYEE_A });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('NATIVE_GHS_QUOTE_INTENT_MISMATCH');
        expect(await stateOf(user.id)).toEqual(before);
    });

    test('D: the digest is a real function of rail, amount and payee', () => {
        const { payoutIntentDigest, destinationIdentityOf } = require('../src/services/payoutIntent');
        const base = {
            rail: 'MOMO',
            recipientGhs: '50.00',
            feeGhs: 0,
            destinationIdentity: destinationIdentityOf({ destination: PAYEE_A }),
        };
        const d = payoutIntentDigest(base);
        expect(d).toMatch(/^[0-9a-f]{24}$/);
        expect(payoutIntentDigest({ ...base })).toBe(d);
        // formatting is not identity
        expect(destinationIdentityOf({ destination: '+233 24 123 4567' })).toBe(destinationIdentityOf({ destination: PAYEE_A }));
        // but payee, amount and rail are
        expect(payoutIntentDigest({ ...base, destinationIdentity: destinationIdentityOf({ destination: PAYEE_B }) })).not.toBe(d);
        expect(payoutIntentDigest({ ...base, recipientGhs: '50.01' })).not.toBe(d);
        expect(payoutIntentDigest({ ...base, rail: 'BANK' })).not.toBe(d);
        expect(payoutIntentDigest({ ...base, feeGhs: '0.50' })).not.toBe(d);
        // a BANK payee is identified by the acceptance-time fingerprint
        expect(destinationIdentityOf({ destinationType: 'BANK', destinationSnapshot: { fingerprint: 'fp-1' }, beneficiaryId: 7 })).toBe('fp-1');
    });
});
