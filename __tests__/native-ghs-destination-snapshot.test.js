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
//   4. A client-supplied destinationSnapshot cannot steer a quote's binding.
//   5. The accepted response discloses what was recorded.
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
        app.set('paymentFailoverService', { initiateTransfer: jest.fn(async () => ({ success: true, transactionId: 'MOO-SNAP-1' })) });
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

    test('4: a client-supplied snapshot cannot steer a quote binding', async () => {
        await setSettings();
        const user = await ghsUser();
        const app = buildApp();
        const quoted = await quotePost(app, user, {
            amountGhs: '500.00', // above the wallet: forces a shortfall quote
            destinationSnapshot: { fingerprint: 'forged-fingerprint', bankCode: 'GCB' },
            beneficiaryId: 999999,
        });
        expect(quoted.status).toBe(200);
        const { intent } = quoted.body.quote;
        // Bound to the number the server resolved, not to anything the caller asserted.
        expect(intent.destinationIdentity).toBe(DEST);
        expect(intent.destinationIdentity).not.toContain('forged');
        expect(intent.rail).toBe('MOMO');
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
