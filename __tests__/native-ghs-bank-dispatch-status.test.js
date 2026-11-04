// __tests__/native-ghs-bank-dispatch-status.test.js
// =============================================================================
// BANK dispatch must decide on the provider's ANSWER (issue #389 P0-1).
// Real PostgreSQL.
//
// PROVES:
//   A. status:'UNRESOLVED' (Agent B's answer for timeouts, duplicate refs and
//      malformed responses) is NOT an accepted dispatch: no acceptedAt stamp,
//      no P5-D IN_TRANSIT movement, funds stay reserved, durable operator
//      evidence on the ORIGINAL reference.
//   B. status:'PENDING' with full identity/reference/amount IS accepted, and
//      ownership is persisted under the existing authorities.
//   C. A terminal status returned at initiation is parked, never settled or
//      refunded, and the canonical row stays PENDING.
//   D. Contradictory or incomplete observations (foreign provider, echoed
//      reference mismatch, missing amount) are parked. The caller's requested
//      amount is never substituted.
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

maybe('BANK dispatch decides on the provider answer (real PostgreSQL)', () => {
    const { randomUUID } = require('crypto');
    const { PrismaClient, Prisma } = require('@prisma/client');

    let prisma;
    let seedUser;
    let svc;
    let beneSvc;

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser } = require('./helpers/factories'));
        svc = require('../src/services/nativeGhsWithdrawalService');
        beneSvc = require('../src/services/savedBankBeneficiaryService');
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

    /** A payout sitting at PENDING with a bound, still-matching destination. */
    async function seedAcceptedPayout({ amountGhs = '80.00' } = {}) {
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
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        const mirror = await prisma.withdrawal.findFirst({ where: { transactionHistoryId: canonical.id } });
        return { user, bank, reference, mirror, facts };
    }

    const dispatch = (reference, facts, bank, port) => svc.dispatchNaturalGhsBankWithdrawal(prisma, {
        reference,
        amountGhsExact: facts.recipientGhsExact,
        bank,
        port,
    });

    const liquidity = async () => prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
    const canonicalOf = async (reference) => prisma.transactionHistory.findUnique({ where: { txHash: reference } });
    // Scope by the DURABLE payout identity. ReconciliationException is raw
    // SQL with no foreign key, so rows outlive a test-user sweep and a
    // reprovisioned database can re-issue an id an older row already names.
    const openExceptions = async (reference) => prisma.$queryRawUnsafe(
        'SELECT "reason", "details" FROM "ReconciliationException" WHERE "reference" = $1 AND "status" = \'OPEN\'',
        String(reference)
    );

    test('A: UNRESOLVED is never reported as an accepted dispatch and moves no reservation', async () => {
        const { bank, reference, mirror, facts } = await seedAcceptedPayout();
        const before = await liquidity();

        const out = await dispatch(reference, facts, bank, {
            validateAccount: async ({ accountNumber, bankCode }) => ({ status: 'OK', accountNumber, bankCode, accountName: bank.accountName || null, providerRef: 'MP-VALIDATED', validatedAt: new Date() }),
            capabilities: () => ({ canInitiateBankPayout: true, canValidateAccount: true, mode: 'sandbox' }),
            initiateBankTransfer: async () => ({
            validateAccount: async ({ accountNumber, bankCode }) => ({ status: 'OK', accountNumber, bankCode, accountName: bank.accountName || null, providerRef: 'MP-VALIDATED', validatedAt: new Date() }),
            capabilities: () => ({ canInitiateBankPayout: true, canValidateAccount: true, mode: 'sandbox' }),
                provider: 'MOOLRE_DISBURSEMENT',
                rail: 'BANK',
                referenceId: reference,
                externalId: reference,
                providerRef: null,
                status: 'UNRESOLVED',
                amountGhsExact: null,
                reason: 'PROVIDER_OUTCOME_UNKNOWN',
            }),
        });

        expect(out.dispatched).toBe(false);
        expect(out.reason).toBe('PROVIDER_DISPATCH_UNRESOLVED');
        expect(out.refunded).toBe(false);

        const th = await canonicalOf(reference);
        expect(th.status).toBe('PENDING');                       // nothing settled or reversed
        expect(th.metadata.dispatch).toBeUndefined();            // never stamped accepted
        expect(th.metadata.dispatchException.code).toBe('PROVIDER_DISPATCH_UNRESOLVED');
        expect(th.metadata.dispatchException.refunded).toBe(false);
        expect(th.txHash).toBe(reference);                        // original reference retained

        // Funds stay reserved; nothing moved to in-transit or paid out.
        const after = await liquidity();
        expect(String(after.inTransitGhs)).toBe(String(before.inTransitGhs));
        expect(new Prisma.Decimal(after.inTransitGhs || 0).toFixed(2)).toBe('0.00');

        const exceptions = await openExceptions(reference);
        expect(exceptions.map(e => e.reason)).toContain('PROVIDER_DISPATCH_UNRESOLVED');
    });

    test('B: PENDING with full identity is accepted, owned and moved to IN_TRANSIT', async () => {
        const { bank, reference, mirror, facts } = await seedAcceptedPayout();

        const out = await dispatch(reference, facts, bank, {
            validateAccount: async ({ accountNumber, bankCode }) => ({ status: 'OK', accountNumber, bankCode, accountName: bank.accountName || null, providerRef: 'MP-VALIDATED', validatedAt: new Date() }),
            capabilities: () => ({ canInitiateBankPayout: true, canValidateAccount: true, mode: 'sandbox' }),
            initiateBankTransfer: async () => ({
            validateAccount: async ({ accountNumber, bankCode }) => ({ status: 'OK', accountNumber, bankCode, accountName: bank.accountName || null, providerRef: 'MP-VALIDATED', validatedAt: new Date() }),
            capabilities: () => ({ canInitiateBankPayout: true, canValidateAccount: true, mode: 'sandbox' }),
                provider: 'MOOLRE_DISBURSEMENT',
                rail: 'BANK',
                referenceId: reference,
                externalId: reference,
                providerRef: 'MP-1234',
                status: 'PENDING',
                amountGhsExact: '80.00',
            }),
        });

        expect(out.dispatched).toBe(true);
        expect(out.providerRef).toBe('MP-1234');

        const th = await canonicalOf(reference);
        expect(th.providerRef).toBe('MP-1234');
        expect(th.metadata.dispatch.rail).toBe('BANK');
        expect(th.metadata.dispatch.observedStatus).toBe('PENDING');
        expect(th.metadata.payoutProvider).toBe('moolre');
        expect(th.metadata.payoutProviderName).toBe('MOOLRE_DISBURSEMENT');

        const event = await prisma.fiatProviderEvent.findUnique({
            where: { dedupKey: `event:payout-dispatch:MOOLRE_DISBURSEMENT:${reference}` },
        });
        expect(event).toBeTruthy();
        expect(event.rail).toBe('BANK');
        expect(event.direction).toBe('OUTBOUND');

        const after = await liquidity();
        expect(new Prisma.Decimal(after.inTransitGhs || 0).toFixed(2)).toBe('80.00');
        expect((await openExceptions(reference)).length).toBe(0);
    });

    test.each([
        ['SUCCESSFUL', 'C1: a terminal SUCCESSFUL at initiation is parked, not settled'],
        ['FAILED', 'C2: a terminal FAILED at initiation is parked, never refunded here'],
    ])('%s is parked at initiation (%s)', async (status) => {
        const { bank, reference, mirror, facts } = await seedAcceptedPayout();
        const before = await liquidity();

        const out = await dispatch(reference, facts, bank, {
            validateAccount: async ({ accountNumber, bankCode }) => ({ status: 'OK', accountNumber, bankCode, accountName: bank.accountName || null, providerRef: 'MP-VALIDATED', validatedAt: new Date() }),
            capabilities: () => ({ canInitiateBankPayout: true, canValidateAccount: true, mode: 'sandbox' }),
            initiateBankTransfer: async () => ({
            validateAccount: async ({ accountNumber, bankCode }) => ({ status: 'OK', accountNumber, bankCode, accountName: bank.accountName || null, providerRef: 'MP-VALIDATED', validatedAt: new Date() }),
            capabilities: () => ({ canInitiateBankPayout: true, canValidateAccount: true, mode: 'sandbox' }),
                provider: 'MOOLRE_DISBURSEMENT',
                rail: 'BANK',
                referenceId: reference,
                externalId: reference,
                providerRef: 'MP-9999',
                status,
                amountGhsExact: '80.00',
            }),
        });

        expect(out.dispatched).toBe(false);
        expect(out.reason).toBe('PROVIDER_TERMINAL_AT_INITIATION');

        const th = await canonicalOf(reference);
        expect(th.status).toBe('PENDING');                    // the binder/authority decides
        expect(th.metadata.dispatch).toBeUndefined();

        const after = await liquidity();
        expect(new Prisma.Decimal(after.inTransitGhs || 0).toFixed(2))
            .toBe(new Prisma.Decimal(before.inTransitGhs || 0).toFixed(2));
        expect((await openExceptions(reference)).map(e => e.reason)).toContain('PROVIDER_TERMINAL_AT_INITIATION');
    });

    test.each([
        ['foreign provider identity', { provider: 'MTN_MOMO', rail: 'BANK', status: 'PENDING', amountGhsExact: '80.00' }, 'DISPATCH_PROVIDER_IDENTITY_CONTRADICTION'],
        ['missing provider identity', { status: 'PENDING', amountGhsExact: '80.00' }, 'DISPATCH_PROVIDER_IDENTITY_MISSING'],
        ['non-BANK rail', { provider: 'MOOLRE_DISBURSEMENT', rail: 'MOMO', status: 'PENDING', amountGhsExact: '80.00' }, 'DISPATCH_RAIL_CONTRADICTION'],
        ['missing amount', { provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', status: 'PENDING', amountGhsExact: null }, 'DISPATCH_AMOUNT_MISSING'],
        ['amount mismatch', { provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', status: 'PENDING', amountGhsExact: '80.01' }, 'DISPATCH_AMOUNT_MISMATCH'],
    ])('D: %s is parked as a contradiction', async (_label, observation, expectedReason) => {
        const { bank, reference, mirror, facts } = await seedAcceptedPayout();

        const out = await dispatch(reference, facts, bank, {
            validateAccount: async ({ accountNumber, bankCode }) => ({ status: 'OK', accountNumber, bankCode, accountName: bank.accountName || null, providerRef: 'MP-VALIDATED', validatedAt: new Date() }),
            capabilities: () => ({ canInitiateBankPayout: true, canValidateAccount: true, mode: 'sandbox' }),
            initiateBankTransfer: async () => ({ referenceId: reference, externalId: reference, ...observation }),
            validateAccount: async ({ accountNumber, bankCode }) => ({ status: 'OK', accountNumber, bankCode, accountName: bank.accountName || null, providerRef: 'MP-VALIDATED', validatedAt: new Date() }),
            capabilities: () => ({ canInitiateBankPayout: true, canValidateAccount: true, mode: 'sandbox' }),
        });

        expect(out.dispatched).toBe(false);
        expect(out.reason).toBe('DISPATCH_OBSERVATION_CONTRADICTION');
        expect(out.detail).toBe(expectedReason);

        const th = await canonicalOf(reference);
        expect(th.status).toBe('PENDING');
        expect(th.metadata.dispatchException.reason).toBe(expectedReason);
        // Never the caller's amount substituted for the provider's.
        expect(th.metadata.dispatchException.requestedAmountGhsExact).toBe('80.00');
        expect((await openExceptions(reference)).map(e => e.reason)).toContain('DISPATCH_OBSERVATION_CONTRADICTION');
    });

    test('D2: an echoed reference that is not ours is never adopted', async () => {
        const { bank, reference, facts } = await seedAcceptedPayout();
        const out = await dispatch(reference, facts, bank, {
            validateAccount: async ({ accountNumber, bankCode }) => ({ status: 'OK', accountNumber, bankCode, accountName: bank.accountName || null, providerRef: 'MP-VALIDATED', validatedAt: new Date() }),
            capabilities: () => ({ canInitiateBankPayout: true, canValidateAccount: true, mode: 'sandbox' }),
            initiateBankTransfer: async () => ({
            validateAccount: async ({ accountNumber, bankCode }) => ({ status: 'OK', accountNumber, bankCode, accountName: bank.accountName || null, providerRef: 'MP-VALIDATED', validatedAt: new Date() }),
            capabilities: () => ({ canInitiateBankPayout: true, canValidateAccount: true, mode: 'sandbox' }),
                provider: 'MOOLRE_DISBURSEMENT',
                rail: 'BANK',
                referenceId: 'SOMEONE-ELSES-REFERENCE',
                status: 'PENDING',
                amountGhsExact: '80.00',
            }),
        });
        expect(out.dispatched).toBe(false);
        expect(out.detail).toBe('DISPATCH_REFERENCE_MISMATCH');
        const th = await canonicalOf(reference);
        expect(th.txHash).toBe(reference);
        expect(th.providerRef).toBeNull();
    });
});
