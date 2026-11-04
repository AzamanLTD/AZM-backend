// __tests__/native-ghs-bank-initiation-reconciliation.test.js
// =============================================================================
// #392 — INTEGRATED initiation -> reconciliation proof, BANK rail.
// Real PostgreSQL, real #391 adapter.
//
// The other suites prove each half separately: the dispatch suite proves a
// payout is initiated with the right evidence, the reconciliation suite proves
// a status observation settles once. Neither proves the two halves meet on the
// SAME payout identity, so this suite drives one payout through both:
//
//   1. processNativeGhsWithdrawal  -> quote, debit, reservation
//   2. dispatchNaturalGhsBankWithdrawal with Agent B's REAL MoolreBankPayoutService
//      (loaded from git @ the agreed commit) whose transfer POST answers
//      txstatus '1' -> the provider's SUCCESSFUL observation
//   3. WithdrawalReconciliationWorker._reconcileOne observing SUCCESSFUL
//      for the same reference
//
// and then proves the money moved EXACTLY ONCE: one canonical settlement, one
// mirror row, one liquidity movement, the user debited once, nothing held.
// =============================================================================

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const hasDb = !!process.env.TEST_DATABASE_URL;
const REPO_ROOT = path.resolve(__dirname, '..');
const ADAPTER_SHA = process.env.MOOLRE_ADAPTER_SHA || '31a81cfd5bec116b6b50414789ba709bc40cca85';
const TMP_DIR = path.join(REPO_ROOT, '.tmp-391-integration');
const ADAPTER_FILE = path.join(TMP_DIR, 'moolreBankPayoutService.js');

function materialiseAdapter() {
    try {
        const source = execFileSync('git', ['show', `${ADAPTER_SHA}:services/moolreBankPayoutService.js`], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
        });
        fs.mkdirSync(TMP_DIR, { recursive: true });
        fs.writeFileSync(ADAPTER_FILE, source);
        return source;
    } catch (err) {
        return null;
    }
}

const adapterSource = materialiseAdapter();
const hasAdapter = !!adapterSource;
if (!hasAdapter) {
    console.warn(`[initiation-reconciliation] ${ADAPTER_SHA} is not available in this clone — skipping.`);
}

if (hasDb) {
    process.env.BANK_BENEFICIARY_HMAC_KEY = process.env.BANK_BENEFICIARY_HMAC_KEY || 'test-hmac-key-distinct-from-encryption';
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    process.env.BANK_PAYOUT_FEE_GHS = '0';
    process.env.GHS_RISK_AMOUNT_POLICY = process.env.GHS_RISK_AMOUNT_POLICY
        || '{"largeGhs":1000000,"hugeGhs":2000000,"newAccountMinGhs":900000}';
}

(hasDb && hasAdapter ? describe : describe.skip)('BANK initiation SUCCESSFUL then worker reconciliation settles exactly once', () => {
    const { randomUUID } = require('crypto');
    const { PrismaClient } = require('@prisma/client');

    let prisma;
    let seedUser;
    let svc;
    let beneSvc;
    let MoolreBankPayoutService;
    let WithdrawalReconciliationWorker;

    const ACCOUNT = '1234567890123';
    const BANK_CODE = 'GCB';
    const ACCOUNT_NAME = 'Ama Mensah';
    const AMOUNT = '80.00';

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser } = require('./helpers/factories'));
        svc = require('../src/services/nativeGhsWithdrawalService');
        beneSvc = require('../src/services/savedBankBeneficiaryService');
        WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');
        const loaded = require(ADAPTER_FILE);
        MoolreBankPayoutService = loaded.MoolreBankPayoutService || loaded;
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { /* best effort */ }
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

    /** The REAL adapter, wired to a transport that answers validate + transfer. */
    function liveAdapter(reference) {
        const calls = [];
        const transport = {
            post: async (url) => {
                calls.push(url);
                if (url.endsWith('/validate')) {
                    return { status: 200, data: { status: 1, code: 'AVD01', data: ACCOUNT_NAME } };
                }
                // The transfer POST: Moolre's VERIFIED_SUCCESS_STATUS is '1'.
                return {
                    status: 200,
                    data: {
                        status: 1,
                        data: {
                            txstatus: '1',
                            externalref: reference,
                            amount: AMOUNT,
                            txid: 'MP-INTEGRATION-1',
                        },
                    },
                };
            },
            get: async (url) => { calls.push(url); throw new Error(`unexpected GET ${url}`); },
        };
        const service = new MoolreBankPayoutService({
            providerMode: 'LIVE',
            bankPayoutEnabled: true,
            endpointFamilyConfirmed: true,
            channel2EligibilityConfirmed: true,
            apiUser: 'test-user',
            apiKey: 'test-key',
            accountNumber: '1000000001',
            baseUrl: 'https://sandbox.moolre.com',
            http: transport,
        });
        service._directoryCache = {
            banks: [{ code: BANK_CODE, name: 'GCB Bank' }],
            fetchedAtMs: Date.now(),
            retrievedAt: new Date().toISOString(),
        };
        service.__calls = calls;
        return service;
    }

    const liquidity = async () => prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
    const canonicalOf = async (reference) => prisma.transactionHistory.findUnique({ where: { txHash: reference } });
    const exceptions = async (reference) => prisma.$queryRawUnsafe(
        'SELECT "reason" FROM "ReconciliationException" WHERE "reference" = $1', String(reference)
    );

    test('one payout initiated SUCCESSFUL is settled once, and a second observation moves nothing', async () => {
        await setFlags();
        const user = await seedUser(prisma, { nativeGhsBalance: 500, availableBalance: 1000 });
        const bene = await beneSvc.createBeneficiary(prisma, user.id, {
            bankCode: BANK_CODE, bankName: 'GCB Bank', accountNumber: ACCOUNT, accountName: ACCOUNT_NAME,
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

        // 1. quote, debit and reservation, exactly as the route does
        const facts = await svc.processNativeGhsWithdrawal(
            prisma,
            user.id,
            {
                amountGhs: AMOUNT,
                destination: bank.accountNumberMasked,
                reference,
                destinationType: 'BANK',
                beneficiaryId: bank.id,
                destinationSnapshot: snapshot,
            },
            { commitOperationClaimInTransaction: async () => {} }
        );

        // 2. initiation through the REAL adapter: provider says SUCCESSFUL
        const adapter = liveAdapter(reference);
        const dispatched = await svc.dispatchNaturalGhsBankWithdrawal(prisma, {
            reference,
            amountGhsExact: facts.recipientGhsExact,
            bank,
            port: adapter,
        });
        // The provider answered SUCCESSFUL to the initiation POST itself. The
        // dispatcher does NOT settle on a terminal-at-initiation answer: it
        // parks the payout with the provider's own evidence and leaves the
        // reservation in place, so exactly ONE component settles it.
        expect(dispatched.dispatched).toBe(false);
        expect(dispatched.reason).toBe('PROVIDER_TERMINAL_AT_INITIATION');
        expect(dispatched.refunded).toBe(false);
        // the adapter really did validate, then transfer, once each
        expect(adapter.__calls.filter((u) => u.endsWith('/validate'))).toHaveLength(1);
        expect(adapter.__calls.filter((u) => u.endsWith('/transfer'))).toHaveLength(1);
        // still reserved: the money is out at the provider, not yet settled
        const held = await liquidity();
        expect(Number(held.reservedGhs)).toBe(0);
        expect(Number(held.inTransitGhs)).toBe(80);
        expect(Number(held.paidOutGhs)).toBe(0);

        const canonical = await canonicalOf(reference);
        const mirror = await prisma.withdrawal.findFirst({ where: { transactionHistoryId: canonical.id } });
        const load = () => prisma.withdrawal.findUnique({
            where: { id: mirror.id },
            include: { user: { select: { id: true, email: true, username: true, phoneNumber: true, phoneVerified: true } } },
        });

        // 3. the worker observes the same payout SUCCESSFUL and reconciles it
        const worker = new WithdrawalReconciliationWorker(prisma, null, {
            getTransferStatus: async () => { throw new Error('MoMo must never be asked about a BANK payout'); },
        }, null, null, {
            getBankTransferStatus: async ({ referenceId }) => {
                expect(referenceId).toBe(reference);
                return {
                    provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', referenceId,
                    externalId: reference, providerRef: 'MP-INTEGRATION-1',
                    status: 'SUCCESSFUL', amountGhsExact: AMOUNT,
                };
            },
        });
        await worker._reconcileOne(await load());

        const settledCanonical = await canonicalOf(reference);
        const settledMirror = await prisma.withdrawal.findUnique({ where: { id: mirror.id } });
        const state = await liquidity();

        expect(settledCanonical.status).toBe('COMPLETED');
        expect(settledMirror.status).toBe('COMPLETED');
        // exactly one canonical row and one mirror row for this payout identity
        expect(await prisma.transactionHistory.count({ where: { txHash: reference } })).toBe(1);
        expect(await prisma.withdrawal.count({ where: { transactionHistoryId: settledCanonical.id } })).toBe(1);
        // the money moved once: 80.00 paid out, nothing in transit, nothing held
        expect(Number(state.paidOutGhs)).toBe(80);
        expect(Number(state.reservedGhs)).toBe(0);
        expect(Number(state.inTransitGhs)).toBe(0);
        expect(Number(state.reconciliationHeldGhs)).toBe(0);
        expect(Number(state.reconciliationHeldGhs)).toBe(0);
        // the customer paid once
        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(Number(after.nativeGhsBalance)).toBe(420);

        // 4. a SECOND observation of the same settled payout must move nothing
        await worker._reconcileOne(await load());
        expect(await prisma.transactionHistory.count({ where: { txHash: reference } })).toBe(1);
        const twice = await liquidity();
        expect(Number(twice.paidOutGhs)).toBe(80);
        const afterTwice = await prisma.user.findUnique({ where: { id: user.id }, select: { nativeGhsBalance: true } });
        expect(Number(afterTwice.nativeGhsBalance)).toBe(420);
        // The park that held the payout wrote its OWN durable evidence. It
        // stays (ops can see the payout was parked and later settled) but there
        // must be no CONTRADICTORY evidence: the provider's SUCCESSFUL answer
        // agreed with the lifecycle instead of quarantining the funds.
        const queue = await exceptions(reference);
        expect(queue.map((e) => e.reason)).toEqual(['PROVIDER_TERMINAL_AT_INITIATION']);
    }, 60000);
});
