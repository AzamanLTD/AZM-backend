// __tests__/native-ghs-destination-snapshot.test.js
// =============================================================================
// Issue #389 P1-4: the acceptance snapshot is EVIDENCE, and evidence is
// server-owned.
//
// A MoMo payout recorded nothing but the string the request carried, and
// nothing at all about whether the payee name had ever been checked. Verified
// and unverified were indistinguishable because neither was written down. On top
// of that, the metadata key called every snapshot a "bank" one, and the quote
// route read a destinationSnapshot straight out of the request body — a payer
// could describe its own payout.
//
// PROVES:
//   1. A MoMo payout records a momo snapshot: masked number, rail, network, and
//      an explicit "not name-checked" statement.
//   2. The full number is not copied into the metadata.
//   3. A client-supplied destinationSnapshot is ignored on the payout route.
//   4. A shortfall request is REFUSED before any quote exists (WP-C), and
//      neither a client-supplied destinationSnapshot nor a forged beneficiaryId
//      can turn that refusal into an executable route.
//   5. The accepted response discloses what was recorded.
//   6. The payout intent digest is a pure function of the SERVER-resolved
//      destination identity, not of anything the caller asserts about it.
//
// NOTE ON (4): this file used to claim it proved "a client-supplied snapshot
// cannot steer a quote binding". There is no quote to bind — `quoteGhsShortfall`
// refuses while SHORTFALL_EXECUTION_ENABLED is false, deliberately, because the
// platform cannot evidence the GHS a shortfall conversion would create. The
// test now proves the refusal and the absence of every execution artefact.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[native-ghs-destination-snapshot] TEST_DATABASE_URL not set — skipping.');

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

(hasDb ? describe : describe.skip)('native-GHS destination snapshot honesty (real PostgreSQL)', () => {
    const { randomUUID } = require('crypto');
    const express = require('express');
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    const { PrismaClient } = require('@prisma/client');

    let prisma;
    let seedUser;
    let TEST_PASSWORD;

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser, TEST_PASSWORD } = require('./helpers/factories'));
    });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    const DEST = '233241234567';
    const RATE = 12.5;

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
        // Exposed so a refusal test can assert the rail was never called.
        app.__provider = { initiateTransfer: jest.fn(async () => ({ success: true, transactionId: 'MOO-SNAP-1' })) };
        app.set('paymentFailoverService', app.__provider);
        app.use((req, res, next) => { req.io = { to: () => ({ emit: () => {} }), emit: () => {} }; next(); });
        app.use('/api/withdraw', require('../routes/withdrawalRoutes'));
        return app;
    }

    const tokenFor = (user) => jwt.sign({ id: user.id, role: 'USER' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const auth = (r, user) => r.set('Authorization', `Bearer ${tokenFor(user)}`);
    const ghsPost = (app, user, body = {}) => auth(request(app).post('/api/withdraw/ghs'), user)
        .set('Idempotency-Key', randomUUID()).send({ password: TEST_PASSWORD, destination: DEST, network: 'MTN', ...body });
    const quotePost = (app, user, body = {}) => auth(request(app).post('/api/withdraw/ghs/quote'), user)
        .set('Idempotency-Key', randomUUID()).send({ destination: DEST, network: 'MTN', ...body });
    const metadataOf = async (reference) => {
        const [row] = await prisma.$queryRawUnsafe('SELECT "metadata" FROM "TransactionHistory" WHERE "txHash" = $1', reference);
        return row?.metadata || null;
    };
    const ghsUser = () => seedUser(prisma, { nativeGhsBalance: 300 });

    test('1+2: a MoMo payout records a masked, rail-honest, name-unchecked snapshot', async () => {
        await setSettings();
        const user = await ghsUser();
        const app = buildApp();
        const res = await ghsPost(app, user, { amountGhs: '50.00' });
        expect(res.status).toBe(202);
        const { reference } = res.body;

        const metadata = await metadataOf(reference);
        expect(metadata.momoDestinationSnapshot).toMatchObject({
            destinationType: 'MOMO',
            network: 'MTN',
            destinationMasked: '********4567',
            accountNameVerified: false,
            verification: 'NOT_LOOKED_UP',
        });
        expect(metadata.momoDestinationSnapshot.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        // It is a MoMo payout: there is no bank evidence to report.
        expect(metadata.bankDestinationSnapshot).toBeUndefined();
        // The whole number must not be copied into the EVIDENCE blob. (The
        // surrounding payout metadata still carries `destination` for dispatch;
        // minimising that is a separate PII decision, not a snapshot claim.)
        expect(JSON.stringify(metadata.momoDestinationSnapshot)).not.toContain(DEST);
    });

    test('3: a client-supplied destinationSnapshot is ignored by the payout route', async () => {
        await setSettings();
        const user = await ghsUser();
        const app = buildApp();
        const res = await ghsPost(app, user, {
            amountGhs: '50.00',
            destinationSnapshot: {
                destinationType: 'BANK', bankCode: 'GCB', fingerprint: 'forged-fingerprint',
                accountNameVerified: true, accountNumberMasked: '****9999',
            },
        });
        expect(res.status).toBe(202);
        const metadata = await metadataOf(res.body.reference);
        expect(metadata.momoDestinationSnapshot.destinationType).toBe('MOMO');
        expect(metadata.momoDestinationSnapshot.accountNameVerified).toBe(false);
        expect(metadata.bankDestinationSnapshot).toBeUndefined();
        expect(JSON.stringify(metadata)).not.toContain('forged-fingerprint');
        expect(JSON.stringify(metadata)).not.toContain('****9999');
    });

    // Everything a refused shortfall must NOT leave behind, captured as an
    // exact before/after delta so pre-existing rows from tests 1-3 cannot hide a
    // movement (and cannot create one).
    const financialState = async (userId) => {
        const u = await prisma.user.findUnique({ where: { id: userId }, select: { availableBalance: true, nativeGhsBalance: true } });
        const liq = await prisma.fiatLiquidityState.findUnique({
            where: { id: 1 }, select: { availableGhs: true, reservedGhs: true, inTransitGhs: true, paidOutGhs: true },
        });
        const one = async (sql, ...args) => (await prisma.$queryRawUnsafe(sql, ...args))[0].n;
        return {
            usdc: u.availableBalance.toString(),
            ghs: String(u.nativeGhsBalance ?? 0),
            availableGhs: liq.availableGhs.toString(),
            reservedGhs: liq.reservedGhs.toString(),
            inTransitGhs: String(liq.inTransitGhs ?? 0),
            paidOutGhs: String(liq.paidOutGhs ?? 0),
            quotes: await one('SELECT count(*)::int AS n FROM "TransactionQuote" WHERE "userId" = $1', userId),
            history: await one('SELECT count(*)::int AS n FROM "TransactionHistory" WHERE "userId" = $1', userId),
            ledger: await one('SELECT count(*)::int AS n FROM "LedgerTransaction" WHERE "userId" = $1', userId),
            journal: await one('SELECT count(*)::int AS n FROM "JournalEntry"'),
            openClaims: await one(
                `SELECT count(*)::int AS n FROM "FinancialOperation" WHERE "userId" = $1 AND "status" = 'IN_PROGRESS'`,
                userId,
            ),
        };
    };

    test('4: a shortfall request is refused before any quote exists and cannot be steered into execution', async () => {
        await setSettings();
        const user = await ghsUser(); // GHS 300 against a GHS 500 payout: GHS 200 short
        const app = buildApp();
        const before = await financialState(user.id);

        const refused = await quotePost(app, user, {
            amountGhs: '500.00',
            destinationSnapshot: { fingerprint: 'forged-fingerprint', bankCode: 'GCB', accountNumberMasked: '****9999' },
            beneficiaryId: 999999,
        });

        // 1. The refusal is the typed one, and it states the shortfall it will not fund.
        expect(refused.status).toBe(200);
        expect(refused.body.quote).toBeNull();
        expect(refused.body.shortfallFunding).toMatchObject({
            executable: false,
            code: 'NATIVE_GHS_SHORTFALL_BACKING_UNAVAILABLE',
        });
        expect(refused.body.shortfallFunding.message).toBeTruthy();

        // 2. No executable quote and no quote identity exists.
        expect(refused.body.quoteId ?? null).toBeNull();
        expect((await financialState(user.id)).quotes).toBe(before.quotes);

        // 3-5. No USDC debited, no GHS credited or debited, no ledger or
        // transaction-history posting. Compared field by field for a readable
        // failure: these MUST be identical.
        const after = await financialState(user.id);
        expect(after.usdc).toBe(before.usdc);
        expect(after.ghs).toBe(before.ghs);
        expect(after.availableGhs).toBe(before.availableGhs);
        expect(after.reservedGhs).toBe(before.reservedGhs);
        expect(after.inTransitGhs).toBe(before.inTransitGhs);
        expect(after.paidOutGhs).toBe(before.paidOutGhs);
        expect(after.history).toBe(before.history);
        expect(after.ledger).toBe(before.ledger);
        expect(after.journal).toBe(before.journal);

        // 6. No payout provider was called.
        expect(app.__provider.initiateTransfer).not.toHaveBeenCalled();

        // 7. No idempotency claim is left in a state that could later execute.
        expect(after.openClaims).toBe(0);
        expect(after.openClaims).toBe(before.openClaims);

        // 8. Neither a forged snapshot nor a forged beneficiaryId changes the
        // refusal or opens an alternative route.
        const plain = await quotePost(app, user, { amountGhs: '500.00' });
        expect(plain.status).toBe(refused.status);
        expect(plain.body.quote).toBeNull();
        expect(plain.body.shortfallFunding).toEqual(refused.body.shortfallFunding);
        expect((await financialState(user.id)).quotes).toBe(before.quotes);
        expect((await financialState(user.id)).usdc).toBe(before.usdc);
        expect(JSON.stringify(refused.body)).not.toContain('forged');
        expect(JSON.stringify(refused.body)).not.toContain('9999');
    });

    // 6. The digest is the pure boundary: it names the SERVER-resolved payout.
    test('6: the payout intent digest binds the server-resolved destination, not client claims', async () => {
        const { payoutIntentDigest } = require('../src/services/payoutIntent');
        const intent = { rail: 'MOMO', recipientGhs: 500, destinationIdentity: DEST };
        const base = payoutIntentDigest(intent);

        expect(payoutIntentDigest({ ...intent })).toBe(base);
        // Caller-asserted snapshot/metadata never enters the identity.
        expect(payoutIntentDigest({ ...intent, destinationSnapshot: { fingerprint: 'forged' }, beneficiaryId: 999999 })).toBe(base);
        // A different payee is a different promise.
        expect(payoutIntentDigest({ ...intent, destinationIdentity: '2332412345670' })).not.toBe(base);
        expect(payoutIntentDigest({ ...intent, recipientGhs: 501 })).not.toBe(base);
    });

    test('5: the accepted response discloses what was recorded', async () => {
        await setSettings();
        const user = await ghsUser();
        const res = await ghsPost(buildApp(), user, { amountGhs: '50.00' });
        expect(res.status).toBe(202);
        expect(res.body.data.destinationEvidence).toMatchObject({
            masked: '********4567',
            accountNameVerified: false,
        });
        expect(res.body.data.destinationEvidence.note).toContain('not name-checked');
    });
});
