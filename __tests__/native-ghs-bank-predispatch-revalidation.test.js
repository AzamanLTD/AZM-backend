// __tests__/native-ghs-bank-predispatch-revalidation.test.js
// =============================================================================
// #392 addendum: the destination must be PROVIDER-validated immediately before
// the BANK transfer post.
//
// The route validates at quote time and the service re-reads the stored payee
// before dispatch, but that second check only proves our own row still resolves
// to the accepted fingerprint. There is no approved validation TTL, so no
// freshness window is invented: the exact stored number and bank code go to the
// provider one last time, and a rail that cannot ask that question does not
// dispatch.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[native-ghs-bank-predispatch-revalidation] TEST_DATABASE_URL not set — skipping.');

if (hasDb) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
    process.env.GHS_RISK_AMOUNT_POLICY = process.env.GHS_RISK_AMOUNT_POLICY
        || '{"largeGhs":1000000,"hugeGhs":2000000,"newAccountMinGhs":900000}';
    // A ZERO bank fee is the only approved policy: it must be stated
    // explicitly (silence is not a fee agreement), and a non-zero value is
    // still refused. This is a test fixture, not a production configuration.
    process.env.BANK_PAYOUT_FEE_GHS = '0';
    // Bank payee storage is encrypted at rest: the suites that create payees
    // need the field-cipher key, exactly like the beneficiary suites do.
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    process.env.BANK_BENEFICIARY_HMAC_KEY = process.env.BANK_BENEFICIARY_HMAC_KEY
        || 'test-only-bank-beneficiary-hmac-key-32bytes';
}

(hasDb ? describe : describe.skip)('BANK pre-dispatch provider revalidation (real PostgreSQL)', () => {
    const { randomUUID } = require('crypto');
    const { PrismaClient, Prisma } = require('@prisma/client');

    const svc = require('../src/services/nativeGhsWithdrawalService');
    const ghsWallet = require('../src/services/nativeGhsWalletService');
    const savedBankBeneficiaryService = require('../src/services/savedBankBeneficiaryService');

    let prisma;
    let seedUser;
    let riskUser;

    const RATE = 12.5;
    const ACCOUNT = '1234567890123';
    const BANK_CODE = 'GCB';
    const ACCOUNT_NAME = 'Ama Mensah';

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser } = require('./helpers/factories'));
    });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    async function setSettings() {
        const data = {
            liveRetailRate: RATE, liveUsdToGhs: RATE, liveRateSource: 'KOTANI_PAY',
            lastExternalSync: new Date(), fiatLiquidityAuthorityEnabled: true,
            modelBSettlementEnabled: false, nativeGhsSettlementEnabled: false,
            nativeGhsWithdrawalEnabled: true,
        };
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
        await prisma.fiatLiquidityState.upsert({
            where: { id: 1 },
            update: { availableGhs: 100000, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0 },
            create: { id: 1, availableGhs: 100000 },
        });
    }

    /** An accepted BANK payout, funded from the customer's own GHS. */
    async function acceptedBankPayout({ ghs = 500 } = {}) {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 0, availableBalance: 0 });
        await prisma.$transaction(async (tx) => {
            await ghsWallet.creditNativeGhs({
                tx, userId: user.id, amountGhs: new Prisma.Decimal(ghs).toFixed(2),
                idempotencyKey: `test:seed:ghs:${user.id}`, description: 'test seed GHS',
            });
        });
        // The payee is created the way the API creates it: the provider's
        // answer is the ONLY verification, never a client flag.
        const beneficiary = await savedBankBeneficiaryService.createBeneficiary(prisma, user.id, {
            accountNumber: ACCOUNT,
            bankCode: BANK_CODE,
            bankName: 'GCB Bank',
            accountName: ACCOUNT_NAME,
        }, {
            port: {
                validateBankAccount: async ({ accountNumber, bankCode }) => ({
                    valid: true, accountName: ACCOUNT_NAME, bankCode, provider: 'MOOLRE', validatedAt: new Date().toISOString(),
                }),
            },
        });
        const reference = `GHSTB-${randomUUID()}`;
        const facts = await svc.processNativeGhsWithdrawal(prisma, user.id, {
            amountGhs: '100.00',
            destination: ACCOUNT,
            destinationType: 'BANK',
            destinationSnapshot: {
                beneficiaryId: String(beneficiary.id),
                fingerprint: savedBankBeneficiaryService.fingerprint(ACCOUNT),
                bankCode: BANK_CODE,
                bankName: 'GCB Bank',
                accountNumberMasked: '*******0123',
                accountName: ACCOUNT_NAME,
                verificationSource: 'MOOLRE_ACCOUNT_ENQUIRY',
            },
            reference,
        });
        const bank = { accountNumber: ACCOUNT, bankCode: BANK_CODE, accountName: ACCOUNT_NAME, bankName: 'GCB Bank' };
        return { user, reference, facts, bank };
    }

    const OK = (accountNumber, bankCode, accountName) => ({
        valid: true, accountName, bankCode, provider: 'MOOLRE', validatedAt: new Date().toISOString(),
    });
    const definitiveNotFound = () => {
        const err = new Error('account not found');
        err.outcome = 'DEFINITIVE_REJECTION';
        err.code = 'ACCOUNT_NOT_FOUND';
        err.refusalDocumented = true;
        err.dispatchProven = true;
        err.provider = 'MOOLRE';
        return err;
    };
    const port = (validateBankAccountFn, overrides = {}) => ({
        capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true, mode: 'sandbox', ...(overrides.caps || {}) }),
        validateBankAccount: validateBankAccountFn,
        initiateBankTransfer: overrides.initiate || jest.fn(async () => {
            throw new Error('initiateBankTransfer MUST NOT be called when revalidation does not confirm');
        }),
    });

    const coins = (portObj) => portObj.initiateBankTransfer;

    async function state(reference) {
        const th = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        const mirror = await prisma.withdrawal.findFirst({ where: { transactionHistoryId: th.id } });
        const reservation = await prisma.fiatLiquidityReservation.findUnique({ where: { reference } });
        return { th, mirror, reservation };
    }

    test('a provider that confirms the SAME account and bank code lets the dispatch proceed', async () => {
        const { user, reference, facts, bank } = await acceptedBankPayout();
        const validated = [];
        const p = port(async (args) => {
            validated.push(args);
            return OK(ACCOUNT, BANK_CODE, ACCOUNT_NAME);
        }, {
            initiate: jest.fn(async () => ({
                provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', referenceId: reference, externalId: reference,
                providerRef: 'MP-1', status: 'PENDING', amountGhsExact: facts.recipientGhsExact,
            })),
        });

        const out = await svc.dispatchNaturalGhsBankWithdrawal(prisma, {
            reference, amountGhsExact: facts.recipientGhsExact, bank, port: p,
        });
        expect(out.dispatched).toBe(true);
        // the enquiry used the STORED destination, never a client value
        expect(validated).toHaveLength(1);
        expect(validated[0]).toEqual({ accountNumber: ACCOUNT, bankCode: BANK_CODE });
        expect(p.initiateBankTransfer).toHaveBeenCalledTimes(1);

        const { th } = await state(reference);
        expect(th.metadata.dispatch.providerValidatedAccountName).toBe(ACCOUNT_NAME);
        expect(th.metadata.dispatch.providerValidatedBankCode).toBe(BANK_CODE);
        expect(th.metadata.dispatch.providerValidatedAccountFingerprint)
            .toBe(savedBankBeneficiaryService.fingerprint(ACCOUNT));
        expect(th.metadata.dispatch.providerValidatedAt).toBeTruthy();
        expect(user.id).toBeTruthy();
    });

    test('a definitive ACCOUNT_NOT_FOUND refunds pre-dispatch and never posts a transfer', async () => {
        const { user, reference, facts, bank } = await acceptedBankPayout();
        const before = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        const p = port(async () => { throw definitiveNotFound(); });

        const out = await svc.dispatchNaturalGhsBankWithdrawal(prisma, {
            reference, amountGhsExact: facts.recipientGhsExact, bank, port: p,
        });
        expect(out.dispatched).toBe(false);
        expect(out.refunded).toBe(true);
        expect(out.providerDispatched).toBe(false);
        expect(coins(p)).not.toHaveBeenCalled();

        const { th, mirror, reservation } = await state(reference);
        expect(th.status).toBe('FAILED');
        expect(mirror.status).toBe('FAILED');
        expect(reservation.status).toBe('RELEASED');
        expect(th.metadata.bankPreDispatchRefusal.code).toBe('PROVIDER_ACCOUNT_NOT_FOUND');
        expect(th.metadata.bankPreDispatchRefusal.disposition).toBe('REFUNDED_PRE_DISPATCH');
        // the customer is whole again: the pre-dispatch refusal is not a loss
        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(new Prisma.Decimal(after.nativeGhsBalance).toFixed(2))
            .toBe(new Prisma.Decimal(before.nativeGhsBalance).plus(new Prisma.Decimal('100.00')).toFixed(2));
        const recon = await ghsWallet.ghsWalletReconciliation({ db: prisma, userId: user.id });
        expect(recon.reconciled).toBe(true);
    });

    test('a response for a DIFFERENT bank code is refused and refunded as a definitive negative', async () => {
        const { reference, facts, bank } = await acceptedBankPayout();
        const p = port(async () => OK(ACCOUNT, 'ECO', ACCOUNT_NAME));
        const out = await svc.dispatchNaturalGhsBankWithdrawal(prisma, {
            reference, amountGhsExact: facts.recipientGhsExact, bank, port: p,
        });
        expect(out.dispatched).toBe(false);
        expect(out.reason).toBe('PROVIDER_BANK_CODE_MISMATCH');
        expect(coins(p)).not.toHaveBeenCalled();
        expect((await state(reference)).th.status).toBe('FAILED');
    });

    test('Moolre does not echo the account number, so the binding is the REQUEST we made', async () => {
        const { reference, facts, bank } = await acceptedBankPayout();
        // The documented provider response carries the holder NAME; there is no
        // account-number echo to compare. The binding is therefore the enquiry
        // request: it must carry the exact stored account + bank code.
        const seen = [];
        const p = port(async (args) => {
            seen.push(args);
            return { valid: true, accountName: ACCOUNT_NAME, bankCode: BANK_CODE, provider: 'MOOLRE', validatedAt: new Date().toISOString() };
        }, {
            initiate: jest.fn(async () => ({
                provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', referenceId: reference, externalId: reference,
                providerRef: 'MP-2', status: 'PENDING', amountGhsExact: facts.recipientGhsExact,
            })),
        });
        const out = await svc.dispatchNaturalGhsBankWithdrawal(prisma, {
            reference, amountGhsExact: facts.recipientGhsExact, bank, port: p,
        });
        expect(out.dispatched).toBe(true);
        expect(seen).toEqual([{ accountNumber: ACCOUNT, bankCode: BANK_CODE }]);
        // no fabricated echo is persisted as provider evidence
        const th = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(th.metadata.dispatch.providerValidatedAccountName).toBe(ACCOUNT_NAME);
        expect(th.metadata.dispatch.providerValidatedBankCode).toBe(BANK_CODE);
        expect(th.metadata.dispatch.providerEchoedAccountNumber).toBeUndefined();
    });

    test('a DIFFERENT account name is held for review, never dispatched', async () => {
        const { reference, facts, bank } = await acceptedBankPayout();
        const p = port(async () => OK(ACCOUNT, BANK_CODE, 'Kofi Boateng'));
        const out = await svc.dispatchNaturalGhsBankWithdrawal(prisma, {
            reference, amountGhsExact: facts.recipientGhsExact, bank, port: p,
        });
        expect(out.dispatched).toBe(false);
        expect(out.reason).toBe('BANK_PROVIDER_ACCOUNT_NAME_MISMATCH');
        expect(out.disposition).toBe('HELD_FOR_REVIEW');
        expect(coins(p)).not.toHaveBeenCalled();
        const { th } = await state(reference);
        expect(th.status).toBe('PENDING');
        expect(th.metadata.bankPreDispatchRefusal.disposition).toBe('HELD_FOR_REVIEW');
    });

    test('an unavailable provider is inconclusive: held, no transfer, no refund', async () => {
        const { reference, facts, bank } = await acceptedBankPayout();
        const p = port(async () => { throw new Error('provider timeout'); });
        const out = await svc.dispatchNaturalGhsBankWithdrawal(prisma, {
            reference, amountGhsExact: facts.recipientGhsExact, bank, port: p,
        });
        expect(out.dispatched).toBe(false);
        expect(out.disposition).toBe('HELD_FOR_REVIEW');
        expect(coins(p)).not.toHaveBeenCalled();
        const { th, reservation } = await state(reference);
        expect(th.status).toBe('PENDING');
        expect(reservation.status).toBe('RESERVED');
        expect(th.metadata.bankPreDispatchRefusal.code).toBe('BANK_PROVIDER_REVALIDATION_INCONCLUSIVE');
    });

    test('a malformed validation answer is inconclusive: held, no transfer', async () => {
        const { reference, facts, bank } = await acceptedBankPayout();
        for (const answer of [null, 'OK', {}, { valid: true }, { valid: true, bankCode: BANK_CODE }, { valid: true, accountName: ACCOUNT_NAME }, { valid: false }, { valid: true, accountName: ACCOUNT_NAME, bankCode: BANK_CODE, provider: 'SOMEONE_ELSE' }, { valid: true, accountName: ACCOUNT_NAME, bankCode: BANK_CODE, provider: 'MOOLRE', validatedAt: 'not-a-date' }]) {
            const p = port(async () => answer);
            const out = await svc.dispatchNaturalGhsBankWithdrawal(prisma, {
                reference, amountGhsExact: facts.recipientGhsExact, bank, port: p,
            });
            expect(out.dispatched).toBe(false);
            expect(coins(p)).not.toHaveBeenCalled();
        }
    });

    test('a rail with NO enquiry capability keeps the BANK rail unavailable', async () => {
        const { reference, facts, bank } = await acceptedBankPayout();
        const withoutCapability = { capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: false }), validateBankAccount: async () => null, initiateBankTransfer: jest.fn() };
        const throwingCapability = { capabilities: () => { throw new Error('boom'); }, validateBankAccount: async () => null, initiateBankTransfer: jest.fn() };
        const noMethod = { capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true }), initiateBankTransfer: jest.fn() };
        const withoutMethod = { capabilities: () => ({ canInitiateBankPayout: true, canValidateBankAccount: true }), initiateBankTransfer: jest.fn() };

        for (const p of [withoutCapability, throwingCapability, withoutMethod]) {
            const out = await svc.dispatchNaturalGhsBankWithdrawal(prisma, {
                reference, amountGhsExact: facts.recipientGhsExact, bank, port: p,
            });
            expect(out.dispatched).toBe(false);
            expect(out.reason).toBe('BANK_REVALIDATION_CAPABILITY_UNAVAILABLE');
            expect(out.refunded).toBe(false);
            expect(p.initiateBankTransfer).not.toHaveBeenCalled();
        }
        const { th, reservation } = await state(reference);
        expect(th.status).toBe('PENDING');
        expect(reservation.status).toBe('RESERVED');
        expect(th.metadata.bankPreDispatchRefusal.code).toBe('BANK_REVALIDATION_CAPABILITY_UNAVAILABLE');
    });

    test('a beneficiary edited or deleted between acceptance and dispatch is never paid', async () => {
        const { user, reference, facts, bank } = await acceptedBankPayout();
        const p = port(async () => OK(ACCOUNT, BANK_CODE, ACCOUNT_NAME));
        // the saved payee is deleted after acceptance
        await prisma.savedBankBeneficiary.deleteMany({ where: { userId: user.id } });

        const out = await svc.dispatchNaturalGhsBankWithdrawal(prisma, {
            reference, amountGhsExact: facts.recipientGhsExact, bank, port: p,
        });
        expect(out.dispatched).toBe(false);
        expect(coins(p)).not.toHaveBeenCalled();
        expect(p.initiateBankTransfer).not.toHaveBeenCalled();
        const { th, mirror } = await state(reference);
        expect(mirror.status).toBe('NEEDS_MANUAL_REVIEW');
        expect(th.metadata.bankDestinationRevalidation.code).toBe('BANK_DESTINATION_CHANGED');
        expect(th.metadata.bankDestinationRevalidation.refunded).toBe(false);
        expect(th.status).toBe('PENDING');
    });

    // ── GHS risk amount: exact decimal boundaries ───────────────────────────
    // The GHS threshold boundary coverage lives where the DEFECT was: at the
    // real routes, on both rails — see __tests__/native-ghs-trusted-age-risk.test.js
    // (pesewa-exact sweeps around largeGhs/hugeGhs/newAccountMinGhs). Nothing
    // here is skipped: a skipped test would be a claim without evidence.
});
