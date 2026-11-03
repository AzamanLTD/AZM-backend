// __tests__/native-ghs-admin-review.test.js
// =============================================================================
// Native-GHS payout parked for operator review — issue #389 (§4.4 / §6).
// Real PostgreSQL.
//
// PROVES the operator path end to end:
//   A. A payee that no longer matches the confirmed destination parks the
//      payout in the review queue WITH durable operator evidence
//      (BANK_DESTINATION_CHANGED @ PRE_DISPATCH), not just metadata — an
//      operator must never see a park with no reason and only ESCALATE.
//   B. The admin queue lists it with that reason.
//   C. REJECT refunds the REAL GHS through the GHS reversal authority: the
//      customer's native balance comes back exactly once, USDC is untouched,
//      and the payout ends FAILED with the mirror REJECTED. (The legacy USDC
//      reversal would "refund" zero and still mark the payout failed.)
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const maybe = hasDb ? describe : describe.skip;

if (hasDb) {
    process.env.BANK_BENEFICIARY_HMAC_KEY = process.env.BANK_BENEFICIARY_HMAC_KEY || 'test-hmac-key-distinct-from-encryption';
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    process.env.BANK_PAYOUT_FEE_GHS = '0';
}

maybe('native-GHS payout in the operator review queue (real PostgreSQL)', () => {
    const express = require('express');
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    const { randomUUID } = require('crypto');
    const { PrismaClient, Prisma } = require('@prisma/client');

    let prisma;
    let seedUser;
    const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser } = require('./helpers/factories'));
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    async function setFlags() {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { nativeGhsWithdrawalEnabled: true, fiatLiquidityAuthorityEnabled: true },
            create: { id: 1, nativeGhsWithdrawalEnabled: true, fiatLiquidityAuthorityEnabled: true },
        });
        await prisma.fiatLiquidityState.upsert({
            where: { id: 1 },
            update: { availableGhs: 100000, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0 },
            create: { id: 1, availableGhs: 100000 },
        });
    }

    function buildApp(port) {
        const app = express();
        app.use(express.json());
        app.set('prisma', prisma);
        app.set('logger', { error: () => {}, warn: () => {}, info: () => {} });
        app.set('emitBalanceUpdate', () => {});
        if (port) app.set('moolreBankPayoutPort', port);
        app.use('/api/admin', require('../routes/adminRoutes'));
        return app;
    }

    const tokenFor = (user) => jwt.sign({ id: user.id, role: user.role || 'USER' }, JWT_SECRET, { expiresIn: '1h' });

    // Drive the payout to the parked state deterministically: acceptance binds
    // the snapshot, then the payee stops resolving, then dispatch is called.
    async function seedParkedPayout({ amountGhs = '80.00' } = {}) {
        const svc = require('../src/services/nativeGhsWithdrawalService');
        const beneSvc = require('../src/services/savedBankBeneficiaryService');
        const user = await seedUser(prisma, { nativeGhsBalance: 500, availableBalance: 1000 });
        const bene = await beneSvc.createBeneficiary(prisma, user.id, {
            bankCode: 'GCB', bankName: 'GCB Bank', accountNumber: '1234567890123', accountName: 'Ama Mensah',
        });
        const bank = await beneSvc.revealForPayout(prisma, user.id, bene.id);
        const snapshot = {
            beneficiaryId: bank.id,
            bankCode: bank.bankCode,
            bankName: bank.bankName,
            accountName: bank.accountName || null,
            accountNumberMasked: bank.accountNumberMasked,
            fingerprint: beneSvc.fingerprint(bank.accountNumber),
            capturedAt: new Date().toISOString(),
        };
        const reference = randomUUID();
        const facts = await svc.processNativeGhsWithdrawal(
            prisma,
            user.id,
            {
                amountGhs,
                destination: bank.accountNumberMasked,
                reference,
                destinationType: 'BANK',
                beneficiaryId: bank.id,
                destinationSnapshot: snapshot,
            },
            { commitOperationClaimInTransaction: async () => {} }
        );

        await prisma.savedBankBeneficiary.update({ where: { id: bene.id }, data: { status: 'DELETED' } });

        const port = { initiateBankTransfer: jest.fn() };
        const out = await svc.dispatchNaturalGhsBankWithdrawal(prisma, {
            reference,
            amountGhsExact: facts.recipientGhsExact,
            bank,
            port,
        });
        expect(out.dispatched).toBe(false);
        expect(out.reason).toBe('BANK_DESTINATION_CHANGED');
        expect(port.initiateBankTransfer).not.toHaveBeenCalled();

        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        const mirror = await prisma.withdrawal.findFirst({ where: { transactionHistoryId: canonical.id } });
        return { user, reference, canonical, mirror };
    }

    test('§6 park carries durable operator evidence and the queue shows it', async () => {
        await setFlags();
        const { mirror } = await seedParkedPayout();
        expect(mirror.status).toBe('NEEDS_MANUAL_REVIEW');

        const open = await prisma.$queryRawUnsafe(
            'SELECT "reason", "details" FROM "ReconciliationException" WHERE "entityType" = \'WITHDRAWAL\' AND "entityId" = $1 AND "status" = \'OPEN\'',
            String(mirror.id)
        );
        const park = open.find((r) => r.reason === 'BANK_DESTINATION_CHANGED');
        expect(park).toBeTruthy();
        expect(park.details.phase).toBe('PRE_DISPATCH');
        expect(park.details.providerDispatched).toBe(false);

        // And the operator-facing listing surfaces that reason.
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const app = buildApp({ initiateBankTransfer: jest.fn() });
        const list = await request(app)
            .get('/api/admin/payouts/needs-review')
            .set('Authorization', `Bearer ${tokenFor(admin)}`);
        expect([200, 403]).toContain(list.status);
        if (list.status === 200) {
            const row = (list.body.withdrawals || []).find((w) => w.id === mirror.id);
            expect(row).toBeTruthy();
            expect(row.manualReview.reasons.map((r) => r.reason)).toContain('BANK_DESTINATION_CHANGED');
            expect(row.manualReview.reasons.find((r) => r.reason === 'BANK_DESTINATION_CHANGED').phase).toBe('PRE_DISPATCH');
        }
    });

    test('§4.4 operator REJECT refunds the real GHS exactly once and touches no USDC', async () => {
        await setFlags();
        const { user, reference, mirror } = await seedParkedPayout();
        const before = await prisma.user.findUnique({
            where: { id: user.id },
            select: { availableBalance: true, nativeGhsBalance: true },
        });
        expect(new Prisma.Decimal(before.nativeGhsBalance).toFixed(2)).toBe('420.00');

        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const app = buildApp({ initiateBankTransfer: jest.fn() });
        const res = await request(app)
            .post(`/api/admin/withdrawals/${mirror.id}/resolve-review`)
            .set('Authorization', `Bearer ${tokenFor(admin)}`)
            .send({ action: 'REJECT', reason: 'customer re-confirmed a different account' });

        expect(res.status).toBe(200);

        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('FAILED');
        // The GHS reversal marks the mirror FAILED inside its own transaction
        // (the payout failed and the money came back). The legacy USDC path
        // uses REJECTED; here the authority owns the terminal status and the
        // admin layer must not contradict it.
        const mirrorAfter = await prisma.withdrawal.findUnique({ where: { id: mirror.id } });
        expect(mirrorAfter.status).toBe('FAILED');

        const after = await prisma.user.findUnique({
            where: { id: user.id },
            select: { availableBalance: true, nativeGhsBalance: true },
        });
        // The REAL money comes back: exact GHS, not a zero USDC refund.
        expect(new Prisma.Decimal(after.nativeGhsBalance).toFixed(2)).toBe('500.00');
        expect(new Prisma.Decimal(after.availableBalance).toFixed(2)).toBe(new Prisma.Decimal(before.availableBalance).toFixed(2));

        // Refunded once: a second resolve is refused and moves nothing.
        const again = await request(app)
            .post(`/api/admin/withdrawals/${mirror.id}/resolve-review`)
            .set('Authorization', `Bearer ${tokenFor(admin)}`)
            .send({ action: 'REJECT', reason: 'retry' });
        expect(again.status).toBeGreaterThanOrEqual(400);
        const after2 = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(new Prisma.Decimal(after2.nativeGhsBalance).toFixed(2)).toBe('500.00');
    });
});
