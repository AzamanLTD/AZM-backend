// __tests__/native-ghs-reversal-atomicity.test.js
// =============================================================================
// Native-GHS reversal is ONE atomic boundary (issue #389 P1-1). Real PostgreSQL.
//
// The admin rejection path used to claim the payout (move it to PENDING) in a
// separate statement before asking the GHS authority to reverse it, and to
// "restore" the previous status afterwards with .catch(() => {}). A refusal or
// an error therefore left the payout sitting at PENDING — claimable by the
// dispatcher — while the operator was told nothing was refunded. That is a
// payout that can be paid after being rejected.
//
// PROVES:
//   A. A successful admin rejection ends with the mirror FAILED (never PENDING)
//      and the exact GHS restored once.
//   B. A payout already recorded as paid is refused, with ZERO mutation.
//   C. A state outside the states the caller is willing to claim is refused,
//      with ZERO mutation, and the same call succeeds once that state is
//      offered — so the refusal is about policy, not about broken state.
//   D. An ERROR inside the reversal (not just a refusal) leaves the row in
//      NEEDS_MANUAL_REVIEW, not PENDING.
//   E. Replaying a successful reversal credits nothing a second time.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const maybe = hasDb ? describe : describe.skip;

if (hasDb) {
    process.env.BANK_BENEFICIARY_HMAC_KEY = process.env.BANK_BENEFICIARY_HMAC_KEY || 'test-hmac-key-distinct-from-encryption';
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    process.env.BANK_PAYOUT_FEE_GHS = '0';
}

maybe('native-GHS reversal atomicity (real PostgreSQL)', () => {
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

    function buildApp() {
        const app = express();
        app.use(express.json());
        app.set('prisma', prisma);
        app.set('logger', { error: () => {}, warn: () => {}, info: () => {} });
        app.set('emitBalanceUpdate', () => {});
        app.use('/api/admin', require('../routes/adminRoutes'));
        return app;
    }

    const tokenFor = (user) => jwt.sign({ id: user.id, role: user.role || 'ADMIN' }, JWT_SECRET, { expiresIn: '1h' });
    const auth = (req, user) => req.set('Authorization', `Bearer ${tokenFor(user)}`);

    /** A bank payout parked in NEEDS_MANUAL_REVIEW with PRE_DISPATCH evidence. */
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
            prisma, user.id,
            {
                amountGhs, destination: bank.accountNumberMasked, reference,
                destinationType: 'BANK', beneficiaryId: bank.id, destinationSnapshot: snapshot,
            },
            { commitOperationClaimInTransaction: async () => {} }
        );
        await prisma.savedBankBeneficiary.update({ where: { id: bene.id }, data: { status: 'DELETED' } });
        const out = await svc.dispatchNaturalGhsBankWithdrawal(prisma, {
            reference, amountGhsExact: facts.recipientGhsExact, bank, port: { initiateBankTransfer: jest.fn() },
        });
        expect(out.reason).toBe('BANK_DESTINATION_CHANGED');

        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        const mirror = await prisma.withdrawal.findFirst({ where: { transactionHistoryId: canonical.id } });
        expect(mirror.status).toBe('NEEDS_MANUAL_REVIEW');
        return { user, reference, canonical, mirror, svc };
    }

    // Seeded per test: the sweep removes test users, so an admin found by
    // lookup may simply not exist when this file runs after a sweep.
    const admin = async () => seedUser(prisma, { role: 'ADMIN' });
    const balanceOf = async (userId) => {
        const u = await prisma.user.findUnique({ where: { id: userId }, select: { nativeGhsBalance: true } });
        return new Prisma.Decimal(u.nativeGhsBalance).toFixed(2);
    };
    const liquidity = () => prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
    const mirrorStatus = async (id) => (await prisma.withdrawal.findUnique({ where: { id }, select: { status: true } })).status;

    test('A: a successful rejection ends FAILED with the exact GHS restored once', async () => {
        await setFlags();
        const { user, mirror } = await seedParkedPayout();
        expect(await balanceOf(user.id)).toBe('420.00');
        const app = buildApp();
        const adminUser = await admin();

        const res = await auth(request(app).post(`/api/admin/withdrawals/${mirror.id}/resolve-review`), adminUser)
            .send({ action: 'REJECT', reason: 'customer re-confirmed a different account' });

        expect(res.status).toBe(200);
        expect(await mirrorStatus(mirror.id)).toBe('FAILED');
        expect(await balanceOf(user.id)).toBe('500.00');
        const state = await liquidity();
        expect(new Prisma.Decimal(state.inTransitGhs || 0).toFixed(2)).toBe('0.00');
    });

    test('B: a payout recorded as paid is refused with zero mutation', async () => {
        await setFlags();
        const { user, reference, canonical, mirror, svc } = await seedParkedPayout();
        // The provider paid; the mirror says so, the canonical still reads PENDING
        // (a real inconsistency: settlement wrote one side only).
        await prisma.withdrawal.update({ where: { id: mirror.id }, data: { status: 'PAID_OUT' } });
        const before = await balanceOf(user.id);
        const stateBefore = await liquidity();

        const out = await svc.reverseNativeGhsWithdrawal(prisma, { reference, reason: 'admin_refund' });

        expect(out.reversed).toBe(false);
        expect(out.reason).toBe('ALREADY_PAID_OR_COMPLETED');
        expect(out.status).toBe('PAID_OUT');
        expect(await balanceOf(user.id)).toBe(before);
        expect((await prisma.transactionHistory.findUnique({ where: { id: canonical.id } })).status).toBe('PENDING');
        expect(await mirrorStatus(mirror.id)).toBe('PAID_OUT');
        const stateAfter = await liquidity();
        expect(new Prisma.Decimal(stateAfter.inTransitGhs || 0).toFixed(2))
            .toBe(new Prisma.Decimal(stateBefore.inTransitGhs || 0).toFixed(2));
    });

    test('C: a state the caller will not claim is refused untouched, then succeeds once offered', async () => {
        await setFlags();
        const { user, reference, mirror, svc } = await seedParkedPayout();
        await prisma.withdrawal.update({ where: { id: mirror.id }, data: { status: 'APPROVED' } });
        const before = await balanceOf(user.id);

        const refused = await svc.reverseNativeGhsWithdrawal(prisma, { reference, reason: 'admin_refund' });
        expect(refused.reversed).toBe(false);
        expect(refused.reason).toBe('NOT_REVERSIBLE_IN_STATE');
        expect(await balanceOf(user.id)).toBe(before);
        expect(await mirrorStatus(mirror.id)).toBe('APPROVED');

        const reversed = await svc.reverseNativeGhsWithdrawal(prisma, {
            reference, reason: 'admin_refund', allowedMirrorStatuses: ['APPROVED'],
        });
        expect(reversed.reversed).toBe(true);
        expect(await balanceOf(user.id)).toBe('500.00');
        expect(await mirrorStatus(mirror.id)).toBe('FAILED');
    });

    test('D: a reversal ERROR leaves the row in review, not at PENDING', async () => {
        await setFlags();
        const { user, canonical, mirror } = await seedParkedPayout();
        // Force the reversal to throw inside its transaction.
        await prisma.transactionHistory.update({ where: { id: canonical.id }, data: { amountGhs: null } });
        const app = buildApp();
        const adminUser = await admin();
        const before = await balanceOf(user.id);

        const res = await auth(request(app).post(`/api/admin/withdrawals/${mirror.id}/resolve-review`), adminUser)
            .send({ action: 'REJECT', reason: 'customer re-confirmed a different account' });

        expect(res.status).not.toBe(200);
        // THE REGRESSION: this used to be PENDING, i.e. queued for dispatch.
        expect(await mirrorStatus(mirror.id)).toBe('NEEDS_MANUAL_REVIEW');
        expect(await balanceOf(user.id)).toBe(before);
        expect((await prisma.transactionHistory.findUnique({ where: { id: canonical.id } })).status).toBe('PENDING');
    });

    test('E: replaying a successful reversal credits nothing again', async () => {
        await setFlags();
        const { user, reference, svc } = await seedParkedPayout();

        const first = await svc.reverseNativeGhsWithdrawal(prisma, {
            reference, reason: 'admin_refund', allowedMirrorStatuses: ['NEEDS_MANUAL_REVIEW'],
        });
        expect(first.reversed).toBe(true);
        expect(await balanceOf(user.id)).toBe('500.00');

        const second = await svc.reverseNativeGhsWithdrawal(prisma, {
            reference, reason: 'admin_refund', allowedMirrorStatuses: ['NEEDS_MANUAL_REVIEW'],
        });
        expect(second.reversed).toBe(false);
        expect(await balanceOf(user.id)).toBe('500.00');
    });
});
