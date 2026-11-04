// __tests__/native-ghs-bank-reconciliation.test.js
// =============================================================================
// BANK payouts must reconcile on the BANK rail (issue #389 P0-2).
// Real PostgreSQL.
//
// PROVES the existing WithdrawalReconciliationWorker routes a BANK payout to
// Agent B's getBankTransferStatus() and never to the MoMo status service, that
// the adapter's `amountGhsExact` is adapted into the evidence binder's amount
// field, and that UNRESOLVED / NOT_FOUND / contradictory answers are HELD:
//   A. SUCCESSFUL + exact amount   -> settled once (canonical COMPLETED).
//   B. FAILED + exact amount       -> reversed once (real GHS restored).
//   C. UNRESOLVED                  -> held, rail named BANK, nothing moves.
//   D. NOT_FOUND                   -> parked with evidence, nothing moves.
//   E. amount mismatch             -> evidence binding refused, nothing moves.
//   F. no bank port bound          -> parked as BANK_STATUS_PORT_UNAVAILABLE,
//                                     MoMo adapter never asked.
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

maybe('BANK payouts reconcile on the BANK rail (real PostgreSQL)', () => {
    const { randomUUID } = require('crypto');
    const { PrismaClient, Prisma } = require('@prisma/client');

    let prisma;
    let seedUser;
    let svc;
    let beneSvc;
    let WithdrawalReconciliationWorker;

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser } = require('./helpers/factories'));
        svc = require('../src/services/nativeGhsWithdrawalService');
        beneSvc = require('../src/services/savedBankBeneficiaryService');
        WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');
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

    /** A payout dispatched to the bank provider and awaiting settlement. */
    async function seedDispatchedBankPayout({ amountGhs = '80.00' } = {}) {
        await setFlags();
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
        const dispatched = await svc.dispatchNaturalGhsBankWithdrawal(prisma, {
            reference,
            amountGhsExact: facts.recipientGhsExact,
            bank,
            port: {
                // The REAL adapter contract (#391 @ pinned head): capabilities
                // declare BOTH legs, validation answers with the holder name
                // and NO account-number echo, and the directory is fresh.
                capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true, mode: 'sandbox' }),
                listBanks: async () => ({ stale: false, banks: [{ code: 'GCB', name: 'GCB Bank' }] }),
                validateBankAccount: async ({ accountNumber, bankCode }) => ({
                    valid: true,
                    accountName: 'AMA MENSAH',
                    bankCode,
                    validatedAt: new Date().toISOString(),
                    provider: 'MOOLRE',
                }),
                initiateBankTransfer: async () => ({
                    provider: 'MOOLRE_DISBURSEMENT',
                    rail: 'BANK',
                    referenceId: reference,
                    externalId: reference,
                    providerRef: 'MP-RECON-1',
                    status: 'PENDING',
                    amountGhsExact: '80.00',
                }),
            },
        });
        expect(dispatched.dispatched).toBe(true);
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        const mirror = await prisma.withdrawal.findFirst({ where: { transactionHistoryId: canonical.id } });
        const loaded = await prisma.withdrawal.findUnique({
            where: { id: mirror.id },
            include: { user: { select: { id: true, email: true, username: true, phoneNumber: true, phoneVerified: true } } },
        });
        return { user, reference, canonical, mirror, withdrawal: loaded };
    }

    const mtnForbidden = () => ({
        getTransferStatus: async () => {
            throw new Error('MoMo status service must NEVER be asked about a BANK payout');
        },
    });

    const worker = (bankPayoutPort) => new WithdrawalReconciliationWorker(
        prisma, null, mtnForbidden(), null, null, bankPayoutPort
    );

    const liquidity = async () => prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
    // Scope by the DURABLE payout identity (reference), not by entityId.
    // ReconciliationException is written through raw SQL with no foreign key,
    // so rows survive test-user sweeps and a reprovisioned database hands a
    // fresh withdrawal an id an older exception already names. The reference is
    // the authoritative payout identity and cannot be reused.
    const exceptions = async (reference) => prisma.$queryRawUnsafe(
        'SELECT "reason", "details" FROM "ReconciliationException" WHERE "reference" = $1',
        String(reference)
    );
    const canonicalOf = async (reference) => prisma.transactionHistory.findUnique({ where: { txHash: reference } });
    const mirrorOf = async (id) => prisma.withdrawal.findUnique({ where: { id } });

    test('A: SUCCESSFUL with the exact amount settles once on the BANK rail', async () => {
        const { user, reference, mirror, withdrawal } = await seedDispatchedBankPayout();

        await worker({
            getBankTransferStatus: async ({ referenceId }) => {
                expect(referenceId).toBe(reference);
                return {
                    provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', referenceId,
                    externalId: reference, providerRef: 'MP-RECON-1',
                    status: 'SUCCESSFUL', amountGhsExact: '80.00',
                };
            },
        })._reconcileOne(withdrawal);

        const th = await canonicalOf(reference);
        expect(th.status).toBe('COMPLETED');
        expect((await mirrorOf(mirror.id)).status).toBe('COMPLETED');

        const state = await liquidity();
        expect(new Prisma.Decimal(state.inTransitGhs || 0).toFixed(2)).toBe('0.00');
        expect(new Prisma.Decimal(state.paidOutGhs || 0).toFixed(2)).toBe('80.00');

        // The observation is durable evidence on the BANK rail.
        const event = await prisma.fiatProviderEvent.findFirst({
            where: { relatedReference: reference, dedupKey: { contains: 'payout-outbound' } },
            orderBy: { receivedAt: 'desc' },
        });
        expect(event.rail).toBe('BANK');
        expect((await exceptions(reference)).map((e) => e.reason)).toEqual([]);
    });

    test('B: FAILED with the exact amount reverses once and restores the real GHS', async () => {
        const { user, reference, mirror, withdrawal } = await seedDispatchedBankPayout();
        const before = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(new Prisma.Decimal(before.nativeGhsBalance).toFixed(2)).toBe('420.00');

        await worker({
            getBankTransferStatus: async ({ referenceId }) => ({
                provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', referenceId,
                externalId: reference, providerRef: 'MP-RECON-1',
                status: 'FAILED', amountGhsExact: '80.00', reason: 'BANK_REJECTED',
            }),
        })._reconcileOne(withdrawal);

        expect((await canonicalOf(reference)).status).toBe('FAILED');
        expect((await mirrorOf(mirror.id)).status).toBe('FAILED');
        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(new Prisma.Decimal(after.nativeGhsBalance).toFixed(2)).toBe('500.00');
    });

    test('C: UNRESOLVED holds the payout and names the BANK rail', async () => {
        const { reference, mirror, withdrawal } = await seedDispatchedBankPayout();
        const before = await liquidity();

        await worker({
            getBankTransferStatus: async ({ referenceId }) => ({
                provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', referenceId,
                status: 'UNRESOLVED', reason: 'PROVIDER_OUTCOME_UNKNOWN',
                externalId: null, providerRef: null, amountGhsExact: null,
            }),
        })._reconcileOne(withdrawal);

        expect((await canonicalOf(reference)).status).toBe('PENDING');
        expect((await mirrorOf(mirror.id)).status).toBe('DISPATCHING');
        const state = await liquidity();
        expect(new Prisma.Decimal(state.inTransitGhs || 0).toFixed(2)).toBe('80.00');

        const parked = (await exceptions(reference)).find(e => e.reason === 'PROVIDER_STATUS_UNRESOLVED');
        expect(parked).toBeTruthy();
        expect(parked.details.rail).toBe('BANK');
        // The provider never stated an amount; it must NOT be backfilled.
        expect(parked.details.observedAmountGhs).toBeNull();
    });

    test('D: NOT_FOUND is parked with evidence and moves nothing', async () => {
        const { reference, mirror, withdrawal } = await seedDispatchedBankPayout();

        await worker({
            getBankTransferStatus: async ({ referenceId }) => ({
                provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', referenceId,
                status: 'NOT_FOUND', providerCode: 'X1',
            }),
        })._reconcileOne(withdrawal);

        expect((await canonicalOf(reference)).status).toBe('PENDING');
        const parked = (await exceptions(reference)).find(e => e.reason === 'PROVIDER_REFERENCE_NOT_FOUND');
        expect(parked).toBeTruthy();
        expect(parked.details.rail).toBe('BANK');
        expect(new Prisma.Decimal((await liquidity()).inTransitGhs || 0).toFixed(2)).toBe('80.00');
    });

    test('E: a mismatched provider amount is refused by the evidence binder', async () => {
        const { user, reference, mirror, withdrawal } = await seedDispatchedBankPayout();

        await worker({
            getBankTransferStatus: async ({ referenceId }) => ({
                provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', referenceId,
                externalId: reference, providerRef: 'MP-RECON-1',
                status: 'SUCCESSFUL', amountGhsExact: '80.01', // one pesewa off
            }),
        })._reconcileOne(withdrawal);

        expect((await canonicalOf(reference)).status).toBe('PENDING');
        expect((await mirrorOf(mirror.id)).status).toBe('DISPATCHING');
        const refused = (await exceptions(reference)).find(e => e.reason === 'SETTLEMENT_EVIDENCE_REJECTED');
        expect(refused).toBeTruthy();
        expect(new Prisma.Decimal((await liquidity()).inTransitGhs || 0).toFixed(2)).toBe('80.00');
        const userAfter = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(new Prisma.Decimal(userAfter.nativeGhsBalance).toFixed(2)).toBe('420.00'); // no refund, no settlement
    });

    test('F: without a bank port the payout parks and MoMo is never asked', async () => {
        const { reference, mirror, withdrawal } = await seedDispatchedBankPayout();

        await worker(null)._reconcileOne(withdrawal);

        expect((await canonicalOf(reference)).status).toBe('PENDING');
        const parked = (await exceptions(reference)).find(e => e.reason === 'BANK_STATUS_PORT_UNAVAILABLE');
        expect(parked).toBeTruthy();
        expect(new Prisma.Decimal((await liquidity()).inTransitGhs || 0).toFixed(2)).toBe('80.00');
    });
});
