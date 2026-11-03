// __tests__/native-ghs-reconciliation.test.js
// =============================================================================
// Native-GHS payout RECONCILIATION contracts — issue #389 §4.4. Real PostgreSQL.
//
// PROVES:
//   A. Provider SUCCESS on a native-GHS payout settles the canonical row
//      through the ONE finance boundary WITHOUT any USDC side-effect: the
//      customer's USDC availableBalance is untouched and no USDC fiat
//      settlement ledger entry is invented for a GHS payout.
//   B. The §P.5-D provider float follows the payout it belongs to:
//      available -> reserved at acceptance, reserved -> in-transit at the
//      dispatch claim, in-transit -> paid-out on settlement. Availability is
//      NEVER restored for settled money.
//   C. SUCCESS evidence that arrives BEFORE the dispatch claim contradicts our
//      own lifecycle: the reservation is quarantined into the reconciliation
//      hold and never auto-repaired, so a bucket can never be spent twice.
//   D. Settlement is idempotent: a second observation changes nothing and
//      never double-posts.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[native-ghs-reconciliation.test] TEST_DATABASE_URL not set — skipping.');

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

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { Prisma } = require('@prisma/client');

describe('native-GHS reconciliation (real PostgreSQL)', () => {
    if (!hasDb) return;

    let prisma;
    let seedUser, TEST_PASSWORD;
    let financeService;

    const RATE = 13.42;

    function buildApp(dispatcher) {
        const app = express();
        app.use(express.json());
        app.set('prisma', prisma);
        app.set('logger', { error: () => {}, warn: () => {}, info: () => {} });
        app.set('emitBalanceUpdate', () => {});
        if (dispatcher) app.set('paymentFailoverService', dispatcher);
        app.use('/api/withdraw', require('../routes/withdrawalRoutes'));
        return app;
    }

    const tokenFor = (user) => jwt.sign({ id: user.id, role: 'USER' }, process.env.JWT_SECRET, { expiresIn: '1h' });

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
            create: { id: 1, availableGhs: 100000, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0 },
        });
    }

    async function ghsUser({ ghs = 500, usdc = 1000 } = {}) {
        const user = await seedUser(prisma, { availableBalance: usdc });
        await prisma.user.update({ where: { id: user.id }, data: { nativeGhsBalance: new Prisma.Decimal(String(ghs)) } });
        return user;
    }

    const ghsPost = (app, user, body = {}) => request(app)
        .post('/api/withdraw/ghs')
        .set('Authorization', `Bearer ${tokenFor(user)}`)
        .set('Idempotency-Key', randomUUID())
        .send({ password: TEST_PASSWORD, destination: '233241234567', network: 'MTN', ...body });

    beforeAll(async () => {
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        ({ seedUser, TEST_PASSWORD } = require('./helpers/factories'));
        financeService = require('../services/finance.service');
    });

    afterAll(async () => {
        if (prisma) {
            await prisma.globalSettings.update({
                where: { id: 1 },
                data: { nativeGhsWithdrawalEnabled: false },
            }).catch(() => {});
            await prisma.$disconnect();
        }
    });

    test('provider SUCCESS settles a native-GHS payout with NO USDC side-effect, once', async () => {
        await setSettings();
        const user = await ghsUser({ ghs: 500, usdc: 1000 });
        const before = await prisma.user.findUnique({
            where: { id: user.id },
            select: { availableBalance: true, nativeGhsBalance: true },
        });

        const app = buildApp({ initiateTransfer: async () => ({ providerRef: 'GHS-OK-1', status: 'PENDING' }) });
        const res = await ghsPost(app, user, { amountGhs: '80.00' });
        expect(res.status).toBe(202);
        const { reference } = res.body;

        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.settlementCurrency).toBe('GHS_NATIVE');
        // Acceptance takes the §P.5-D reservation exactly once.
        const floatAfterAccept = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
        expect(new Prisma.Decimal(floatAfterAccept.availableGhs).toFixed(2)).toBe('99920.00');
        expect(new Prisma.Decimal(floatAfterAccept.reservedGhs).toFixed(2)).toBe('80.00');
        expect(new Prisma.Decimal(floatAfterAccept.paidOutGhs).toFixed(2)).toBe('0.00');

        // Wait for the post-commit dispatch claim so the reservation is in
        // IN_TRANSIT before we settle: the state machine must be exercised from
        // its real pre-settlement state, not from a race.
        const startedAt = Date.now();
        let reservation = null;
        while (Date.now() - startedAt < 4000) {
            reservation = await prisma.fiatLiquidityReservation.findFirst({ where: { reference }, orderBy: { id: 'desc' } });
            if (reservation && reservation.status === 'IN_TRANSIT') break;
            await new Promise((r) => setTimeout(r, 25));
        }
        expect(reservation && reservation.status).toBe('IN_TRANSIT');

        // The worker's authorised SUCCESS transition.
        const settled = await financeService.completeFiatWithdrawal(prisma, reference, { providerTxId: 'GHS-OK-1' });
        expect(settled.changed).toBe(true);
        expect(settled.status).toBe('COMPLETED');

        const after = await prisma.user.findUnique({
            where: { id: user.id },
            select: { availableBalance: true, nativeGhsBalance: true },
        });
        // A GHS payout must never create or destroy USDC.
        expect(new Prisma.Decimal(after.availableBalance).toFixed(2)).toBe(new Prisma.Decimal(before.availableBalance).toFixed(2));
        expect(new Prisma.Decimal(after.nativeGhsBalance).toFixed(2)).toBe('420.00');

        // No USDC fiat settlement entry was invented for this reference.
        const usdcSettlement = await prisma.ledgerTransaction.findMany({
            where: { idempotencyKey: `ledger:withdrawal:fiat:settle:${reference}` },
        });
        expect(usdcSettlement).toHaveLength(0);

        // The float follows the payout: in-transit becomes paid-out, and
        // availability is NOT restored (this money is spent).
        const float = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
        expect(new Prisma.Decimal(float.inTransitGhs).toFixed(2)).toBe('0.00');
        expect(new Prisma.Decimal(float.reservedGhs).toFixed(2)).toBe('0.00');
        expect(new Prisma.Decimal(float.paidOutGhs).toFixed(2)).toBe('80.00');
        expect(new Prisma.Decimal(float.availableGhs).toFixed(2)).toBe('99920.00');
        expect(new Prisma.Decimal(float.reconciliationHeldGhs).toFixed(2)).toBe('0.00');

        const settledReservation = await prisma.fiatLiquidityReservation.findFirst({ where: { reference } });
        expect(settledReservation.status).toBe('PAID_OUT');
        // The dispatch-time provider reference survives settlement: evidence
        // must stay attributable to the provider transaction that paid it.
        expect(settledReservation.providerRef).toBe('GHS-OK-1');

        // Idempotent: a second observation changes nothing, posts nothing.
        const again = await financeService.completeFiatWithdrawal(prisma, reference, { providerTxId: 'GHS-OK-1' });
        expect(again.changed).toBe(false);
        const after2 = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true, availableBalance: true } });
        expect(new Prisma.Decimal(after2.nativeGhsBalance).toFixed(2)).toBe('420.00');
        expect(new Prisma.Decimal(after2.availableBalance).toFixed(2)).toBe(new Prisma.Decimal(before.availableBalance).toFixed(2));
        const float2 = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
        expect(new Prisma.Decimal(float2.paidOutGhs).toFixed(2)).toBe('80.00');
        expect(new Prisma.Decimal(float2.inTransitGhs).toFixed(2)).toBe('0.00');
    });

    test('SUCCESS evidence before the dispatch claim is quarantined, never auto-repaired', async () => {
        await setSettings();
        const liquidity = require('../src/services/fiatLiquidityService');
        const reference = `GHS-PREDISPATCH-${Date.now()}`;

        // Reserved but never dispatched: our lifecycle says "no provider saw
        // this" while the provider says it paid. Both cannot be true.
        await prisma.$transaction(async (tx) => {
            await liquidity.reserveForPayout(tx, {
                reference,
                amountGhs: '50.00',
                provider: 'MOOLRE_DISBURSEMENT',
                rail: 'MOMO',
            });
        });
        const before = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
        expect(new Prisma.Decimal(before.reservedGhs).toFixed(2)).toBe('50.00');
        expect(new Prisma.Decimal(before.availableGhs).toFixed(2)).toBe('99950.00');

        const settled = await prisma.$transaction(async (tx) => liquidity.settleReservation(tx, {
            reference,
            outcome: 'SUCCESSFUL',
            providerTxId: 'PREDISPATCH-1',
            reason: 'success before dispatch claim',
        }));
        expect(settled.reservation.status).toBe('RECONCILIATION_REQUIRED');

        const after = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
        // Held, not spent and not spendable: the disputed 50 leaves both
        // reserved and available until an operator resolves it.
        expect(new Prisma.Decimal(after.reservedGhs).toFixed(2)).toBe('0.00');
        expect(new Prisma.Decimal(after.reconciliationHeldGhs).toFixed(2)).toBe('50.00');
        expect(new Prisma.Decimal(after.paidOutGhs).toFixed(2)).toBe('0.00');
        expect(new Prisma.Decimal(after.inTransitGhs).toFixed(2)).toBe('0.00');
        expect(new Prisma.Decimal(after.availableGhs).toFixed(2)).toBe('99950.00');

        // A later identical observation is a replay: it never "fixes" the
        // quarantine by writing PAID_OUT on its own.
        const replay = await prisma.$transaction(async (tx) => liquidity.settleReservation(tx, {
            reference,
            outcome: 'SUCCESSFUL',
            providerTxId: 'PREDISPATCH-1',
        }));
        expect(replay.replay).toBe(true);
        const after2 = await prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
        expect(new Prisma.Decimal(after2.reconciliationHeldGhs).toFixed(2)).toBe('50.00');
        expect(new Prisma.Decimal(after2.availableGhs).toFixed(2)).toBe('99950.00');

        // Test hygiene only: the quarantined row stays in the DB (that IS the
        // evidence), but the shared aggregate is returned to the seeded shape
        // so this file cannot leak a held balance into another suite's
        // arithmetic. Nothing above depends on this.
        await prisma.fiatLiquidityState.update({
            where: { id: 1 },
            data: { availableGhs: 100000, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0 },
        });
    });
});
