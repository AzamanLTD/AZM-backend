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
    process.env.GHS_RISK_AMOUNT_POLICY = process.env.GHS_RISK_AMOUNT_POLICY
        || '{"largeGhs":1000000,"hugeGhs":2000000,"newAccountMinGhs":900000}';
}

maybe('native-GHS payout in the operator review queue (real PostgreSQL)', () => {
    const express = require('express');
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    const { randomUUID } = require('crypto');
    const { PrismaClient, Prisma } = require('@prisma/client');

    let prisma;
    let seedUser;
    let recordReconciliationException;
    const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser } = require('./helpers/factories'));
        ({ recordReconciliationException } = require('../services/reconciliationExceptionService'));
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    // §1 TRACKED FIXTURE SCOPE. The exception table's OPEN rows are unique per
    // (entityType, entityId, reason) and entityId is a bare numeric string with
    // no foreign key. A shared test database can therefore hand a new withdrawal
    // an id an older OPEN row already names, so this suite deletes ONLY the
    // exception rows its own payouts produced — never the shared queue, never a
    // TRUNCATE, never an identity reset.
    const ownedReferences = new Set();

    // §1 ORPHAN SWEEP (disposable test database). An OPEN row whose numeric
    // entityId no longer names a live withdrawal is evidence for a payout that
    // does not exist — it can only shadow a later payout that reuses the id.
    // This CLOSES those rows (status RESOLVED, never deleted) and touches no row
    // that belongs to a still-existing payout, so live evidence is preserved.
    beforeEach(async () => {
        if (!prisma) return;
        await prisma.$executeRawUnsafe(
            'UPDATE "ReconciliationException" r SET "status" = \'RESOLVED\', "resolvedAt" = now() '
            + 'WHERE r."status" = \'OPEN\' AND r."entityType" = \'WITHDRAWAL\' '
            + 'AND NOT EXISTS (SELECT 1 FROM "Withdrawal" w WHERE w."id"::text = r."entityId")'
        );
    });

    afterEach(async () => {
        if (!prisma || ownedReferences.size === 0) return;
        const refs = [...ownedReferences];
        ownedReferences.clear();
        await prisma.$executeRawUnsafe(
            'DELETE FROM "ReconciliationException" WHERE "entityType" = $1 AND "reference" = ANY($2::text[])',
            'WITHDRAWAL', refs
        );
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

        const port = { capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true, mode: 'sandbox' }), initiateBankTransfer: jest.fn() };
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
        ownedReferences.add(String(reference));
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
        const app = buildApp({ capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true, mode: 'sandbox' }), initiateBankTransfer: jest.fn() });
        const list = await request(app)
            .get('/api/admin/payouts/needs-review')
            .set('Authorization', `Bearer ${tokenFor(admin)}`);
        expect(list.status).toBe(200);
        if (list.status === 200) {
            const row = (list.body.withdrawals || []).find((w) => w.id === mirror.id);
            expect(row).toBeTruthy();
            expect(row.manualReview.reasons.map((r) => r.reason)).toContain('BANK_DESTINATION_CHANGED');
            expect(row.manualReview.reasons.find((r) => r.reason === 'BANK_DESTINATION_CHANGED').phase).toBe('PRE_DISPATCH');
        }
    });

    // §P1-1 RESUME USED TO BE A LIE. Setting the mirror back to PENDING only
    // re-enters a pipeline that selects the row: nothing claims a native-GHS
    // payout (the fiat batch worker excludes it and native GHS dispatches
    // inline at acceptance), and for BANK_DESTINATION_CHANGED a redispatch would
    // pay a payee the customer never confirmed. The operator was told the payout
    // "resumed" while the funds stayed reserved forever.
    test('§P1-1 RESUME is refused where no dispatcher exists, and the row stays in review', async () => {
        await setFlags();
        const { user, mirror } = await seedParkedPayout();
        const before = await prisma.user.findUnique({
            where: { id: user.id },
            select: { availableBalance: true, nativeGhsBalance: true },
        });

        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const app = buildApp({ capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true, mode: 'sandbox' }), initiateBankTransfer: jest.fn() });
        const res = await request(app)
            .post(`/api/admin/withdrawals/${mirror.id}/resolve-review`)
            .set('Authorization', `Bearer ${tokenFor(admin)}`)
            .send({ action: 'RESUME', reason: 'operator believes the account is fine now' });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('RESUME_NOT_AVAILABLE');
        expect(res.body.data.availableActions).toEqual(['REJECT', 'ESCALATE']);
        expect(res.body.data.blockers.join(' ')).toMatch(/destination changed|dispatcher/i);

        const after = await prisma.withdrawal.findUnique({ where: { id: mirror.id }, select: { status: true } });
        expect(after.status).toBe('NEEDS_MANUAL_REVIEW');
        const funds = await prisma.user.findUnique({
            where: { id: user.id },
            select: { availableBalance: true, nativeGhsBalance: true },
        });
        expect(new Prisma.Decimal(funds.nativeGhsBalance).toFixed(2)).toBe(new Prisma.Decimal(before.nativeGhsBalance).toFixed(2));
        expect(new Prisma.Decimal(funds.availableBalance).toFixed(2)).toBe(new Prisma.Decimal(before.availableBalance).toFixed(2));
    });

    // §P1-2 EVIDENCE MUST NAME THIS PAYOUT. entityId has no foreign key, so a
    // stale OPEN row written for a deleted payout can share a numeric id with a
    // fresh one. Grouping by entityId alone put another payout's exception
    // reason (and its resolution options) on this review card.
    test('§P1-2 evidence naming another payout is never shown on this one', async () => {
        await setFlags();
        const { mirror } = await seedParkedPayout();
        // A stale row for a DIFFERENT payout that reuses this numeric id.
        const staleReference = 'ref-of-a-different-payout';
        // A row written for some OTHER payout that happens to share this numeric
        // id. Written through the production authority (upsert on the OPEN
        // uniqueness rule) so a re-run cannot collide with 23505.
        await recordReconciliationException(prisma, {
            entityType: 'WITHDRAWAL',
            entityId: mirror.id,
            reference: staleReference,
            reason: 'PROVIDER_STATUS_UNAVAILABLE',
            details: { phase: 'POST_DISPATCH' },
        });

        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const app = buildApp({ capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true, mode: 'sandbox' }), initiateBankTransfer: jest.fn() });
        const list = await request(app)
            .get('/api/admin/payouts/needs-review')
            .set('Authorization', `Bearer ${tokenFor(admin)}`);
        expect(list.status).toBe(200);
        if (list.status === 200) {
            const row = (list.body.withdrawals || []).find((w) => w.id === mirror.id);
            expect(row).toBeTruthy();
            const reasons = row.manualReview.reasons.map((r) => r.reason);
            expect(reasons).toContain('BANK_DESTINATION_CHANGED');
            // The other payout's unknowable anomaly must not appear here.
            expect(reasons).not.toContain('PROVIDER_STATUS_UNAVAILABLE');
            expect(row.manualReview.reasons.every((r) => !r.reference || r.reference !== staleReference)).toBe(true);
        }
    });

    test('§1 bookkeeping failure is visible to operators, allowlisted, and never leaks or attaches elsewhere', async () => {
        await setFlags();
        const { mirror, reference } = await seedParkedPayout();
        const other = await seedParkedPayout();
        // The row shape is produced by the real dispatch path (proven in the
        // initiation suite); this inserts the SAME shape with hostile extras so
        // the read projection's allowlist is what is under test.
        await recordReconciliationException(prisma, {
            entityType: 'WITHDRAWAL',
            entityId: mirror.id,
            reference: String(reference),
            reason: 'PARK_BOOKKEEPING_INCOMPLETE',
            details: {
                phase: 'POST_DISPATCH_BOOKKEEPING',
                decision: 'UNRESOLVED',
                failedSteps: ['OWNERSHIP', 'RAW_SQL_UPDATE', 42],
                recordedSteps: ['PARK_METADATA', 'PROVIDER_EVENT', 'IN_TRANSIT'],
                error: 'connect ECONNREFUSED 10.0.0.1:5432',
                sql: 'UPDATE "TransactionHistory" SET "metadata" = $1',
                providerRaw: { authorization: 'Bearer sk_live_deadbeef' },
                accountNumber: '1234567890123',
            },
        });

        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const app = buildApp({ capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true, mode: 'sandbox' }), initiateBankTransfer: jest.fn() });
        const list = await request(app)
            .get('/api/admin/payouts/needs-review')
            .set('Authorization', `Bearer ${tokenFor(admin)}`);
        expect(list.status).toBe(200);

        const row = (list.body.withdrawals || []).find((w) => w.id === mirror.id);
        expect(row).toBeTruthy();
        const evidence = (row.manualReview.reasons || []).find((r) => r.reason === 'PARK_BOOKKEEPING_INCOMPLETE');
        expect(evidence).toBeTruthy();
        // identity: this payout's own canonical reference
        expect(evidence.reference).toBe(String(reference));
        expect(evidence.phase).toBe('POST_DISPATCH_BOOKKEEPING');
        expect(evidence.decision).toBe('UNRESOLVED');
        // allowlist: unknown step names and non-strings are dropped, not echoed
        expect(evidence.failedSteps).toEqual(['OWNERSHIP']);
        expect(evidence.recordedSteps).toEqual(['PARK_METADATA', 'PROVIDER_EVENT', 'IN_TRANSIT']);

        // no leakage of errors, SQL, credentials or customer bank data in THIS
        // payout's evidence (other queued rows are not what this test creates)
        const blob = JSON.stringify(evidence);
        expect(blob).not.toContain('ECONNREFUSED');
        expect(blob).not.toContain('sk_live_deadbeef');
        expect(blob).not.toContain('1234567890123');
        expect(blob).not.toContain('RAW_SQL_UPDATE');

        // an unrelated payout never receives another payout's bookkeeping failure
        const otherRow = (list.body.withdrawals || []).find((w) => w.id === other.mirror.id);
        if (otherRow) {
            expect((otherRow.manualReview.reasons || []).map((r) => r.reason)).not.toContain('PARK_BOOKKEEPING_INCOMPLETE');
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
        const app = buildApp({ capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true, mode: 'sandbox' }), initiateBankTransfer: jest.fn() });
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
    test('§2 a legacy BANK destination never leaves the operator response, and other rails are untouched', async () => {
        await setFlags();
        const LEGACY_BANK_ACCOUNT = '1234567890123';

        // A BANK payout whose stored destination predates masking.
        const legacy = await seedParkedPayout();
        await prisma.withdrawal.update({
            where: { id: legacy.mirror.id },
            data: { destination: LEGACY_BANK_ACCOUNT },
        });
        // A BANK payout that is already masked: the mask must be preserved.
        const alreadyMasked = await seedParkedPayout();
        // A MoMo payout: a phone-number destination is not a bank account.
        const momo = await seedParkedPayout();
        await prisma.withdrawal.update({
            where: { id: momo.mirror.id },
            data: { payoutMethod: 'MOMO', destination: '0244123456' },
        });
        // Hostile exception evidence carrying a raw account number.
        await recordReconciliationException(prisma, {
            entityType: 'WITHDRAWAL',
            entityId: legacy.mirror.id,
            reference: String(legacy.reference),
            reason: 'BANK_DESTINATION_CHANGED',
            details: {
                phase: 'PRE_DISPATCH',
                providerDispatched: false,
                accountNumber: LEGACY_BANK_ACCOUNT,
                sql: 'UPDATE "Withdrawal" SET "destination" = $1',
            },
        });

        const storedMasked = (await prisma.withdrawal.findUnique({ where: { id: alreadyMasked.mirror.id } })).destination;


        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const app = buildApp({ capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true, mode: 'sandbox' }), initiateBankTransfer: jest.fn() });
        const list = await request(app)
            .get('/api/admin/payouts/needs-review')
            .set('Authorization', `Bearer ${tokenFor(admin)}`);
        expect(list.status).toBe(200);

        // THE WHOLE RESPONSE, not just manualReview.reasons.
        const responseBlob = JSON.stringify(list.body);
        expect(responseBlob).not.toContain(LEGACY_BANK_ACCOUNT);

        const byId = new Map((list.body.withdrawals || []).map((w) => [w.id, w]));
        const legacyRow = byId.get(legacy.mirror.id);
        expect(legacyRow).toBeTruthy();
        expect(legacyRow.destination).not.toBe(LEGACY_BANK_ACCOUNT);
        // 1234567890123 -> the last four digits survive, the rest is shielded.
        expect(legacyRow.destination).toContain('0123');
        expect(legacyRow.destination).toBe('*********0123');
        expect(legacyRow.destination).toMatch(/^\*+0123$/);

        const maskedRow = byId.get(alreadyMasked.mirror.id);
        expect(maskedRow.destination).toBe(storedMasked);
        expect(maskedRow.destination).toContain('*');

        // MoMo destinations are not bank accounts and must survive verbatim.
        const momoRow = byId.get(momo.mirror.id);
        expect(momoRow.destination).toBe('0244123456');
        expect(momoRow.payoutMethod).toBe('MOMO');

        // The stored rows themselves are untouched: this is display only.
        const legacyStored = await prisma.withdrawal.findUnique({ where: { id: legacy.mirror.id } });
        expect(legacyStored.destination).toBe(LEGACY_BANK_ACCOUNT);
    });
});
