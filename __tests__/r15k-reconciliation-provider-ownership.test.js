// __tests__/r15k-reconciliation-provider-ownership.test.js
// =============================================================================
// r15 follow-up (audit P0) — END-TO-END ownership against real PostgreSQL
//
// THE DEFECT: disbursement runs through PaymentFailoverService (moolre →
// mtn), but the ACTUAL provider that accepted a dispatch was never durably
// recorded, and the reconciliation status contract answered "reference not
// found on this rail" as PENDING. Consequence: a payout that failed over to
// MTN could NEVER be resolved — Moolre's "not found" → PENDING meant the
// reconciliation worker believed the payout was alive on Moolre and never
// asked MTN.
//
// This suite wires the REAL PaymentFailoverService (MoolreDisbursementService
// LIVE + MtnDisbursementService LIVE, axios mocked at the HTTP boundary)
// into the REAL PayoutBatchWorker (dispatch) and
// WithdrawalReconciliationWorker (recovery) against real PostgreSQL and
// proves the whole chain:
//   • A. moolre DEFINITIVE_REJECTION → mtn accepts → ownership ('mtn')
//       is durably recorded on the canonical row → reconciliation queries
//       the OWNER RAIL ONLY (mtn) and settles COMPLETED exactly once.
//   • B. the owner rail going down PARKS the payout (UNRESOLVED evidence +
//       exception row); the healthy moolre rail is NEVER asked about an
//       mtn-owned payout — the cross-provider mis-settlement guard.
//   • C. LEGACY row (no persisted ownership): moolre "reference not found"
//       → NOT_FOUND → the search continues → mtn resolves it. THE direct
//       regression proof of the defect.
//   • D. every rail authoritatively answers absence → durable
//       PROVIDER_REFERENCE_NOT_FOUND exception, the payout is parked.
// =============================================================================

const axios = require('axios');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r15k] TEST_DATABASE_URL not set — skipping real-DB suite.');

describeOrSkip('r15 follow-up P0: payout provider ownership end-to-end (real PostgreSQL)', () => {
    let prisma;
    let moolre;
    let mtn;
    let failover;
    let axiosPostSpy;
    let axiosGetSpy;

    const MOOLRE_BASE = 'https://moolre.test.local';
    const MTN_BASE = 'https://mtn.test.local';
    const START_BALANCE = 1000.0;
    const AMOUNT = 50.0;
    const FEE = 1.0;

    beforeAll(() => {
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();

        process.env.MOOLRE_PROVIDER = 'LIVE';
        process.env.MOOLRE_API_USER = 'test-user';
        process.env.MOOLRE_API_KEY = 'test-key';
        process.env.MOOLRE_BASE_URL = MOOLRE_BASE;
        process.env.MOOLRE_ACCOUNT_NUMBER = '100000100002';
        process.env.MTN_MOMO_PROVIDER = 'LIVE';
        process.env.MTN_MOMO_API_USER = 'mtn-user';
        process.env.MTN_MOMO_API_KEY = 'mtn-key';
        process.env.MTN_MOMO_SUBSCRIPTION_KEY = 'mtn-sub';
        process.env.MTN_MOMO_BASE_URL = MTN_BASE;

        // Axios is mocked at the HTTP boundary, URL-routed per rail:
        //   POST /open/transact/transfer   → moolre dispatch
        //   POST /open/transact/status     → moolre status
        //   POST /disbursement/token/      → mtn OAuth token
        //   POST /disbursement/v1_0/transfer → mtn dispatch (202, no body)
        //   GET  /disbursement/v1_0/transfer/{ref} → mtn status
        axiosPostSpy = jest.spyOn(axios, 'post').mockImplementation(async (url) => {
            throw new Error(`r15k: unmocked POST ${url}`);
        });
        axiosGetSpy = jest.spyOn(axios, 'get').mockImplementation(async (url) => {
            throw new Error(`r15k: unmocked GET ${url}`);
        });
    });

    afterAll(async () => {
        axiosPostSpy.mockRestore();
        axiosGetSpy.mockRestore();
        [
            'MOOLRE_PROVIDER', 'MOOLRE_API_USER', 'MOOLRE_API_KEY', 'MOOLRE_BASE_URL', 'MOOLRE_ACCOUNT_NUMBER',
            'MTN_MOMO_PROVIDER', 'MTN_MOMO_API_USER', 'MTN_MOMO_API_KEY', 'MTN_MOMO_SUBSCRIPTION_KEY', 'MTN_MOMO_BASE_URL',
        ].forEach(k => delete process.env[k]);
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        // Fresh adapters + failover per test: provider health and the mtn
        // OAuth token cache are instance state — sharing them across tests
        // couples test order (a capacity-class rejection in one test
        // legitimately degrades moolre health for the NEXT test's routing).
        const MoolreDisbursementService = require('../services/moolreDisbursementService');
        const MtnDisbursementService = require('../services/mtnDisbursementService');
        const { PaymentFailoverService } = require('../src/services/paymentFailoverService');
        moolre = new MoolreDisbursementService({});
        mtn = new MtnDisbursementService({});
        expect(moolre.providerMode).toBe('LIVE');
        expect(mtn.providerMode).toBe('LIVE');
        failover = new PaymentFailoverService({ primary: moolre, secondary: mtn, probeMinIntervalMs: 0 });

        // Full reset: a failed earlier test can leave unconsumed one-shot
        // mock implementations behind — mockReset drops them (mockClear does
        // not), keeping this suite deterministic.
        axiosPostSpy.mockReset().mockImplementation(async (url) => {
            throw new Error(`r15k: unmocked POST ${url}`);
        });
        axiosGetSpy.mockReset().mockImplementation(async (url) => {
            throw new Error(`r15k: unmocked GET ${url}`);
        });
        await prisma.systemFiatPool.upsert({
            where: { id: 1 },
            update: { balance: 100_000.0 },
            create: { id: 1, balance: 100_000.0 }
        });
        await prisma.systemMasterCrypto.upsert({
            where: { id: 1 },
            update: { balance: 0.0 },
            create: { id: 1, balance: 0.0 }
        });
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', fiatLiquidityAuthorityEnabled: false, modelBSettlementEnabled: false },
            create: { id: 1, liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY', fiatLiquidityAuthorityEnabled: false, modelBSettlementEnabled: false }
        });
    });

    afterEach(async () => {
        await new Promise(r => setTimeout(r, 150));
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "TransactionHistory", "Withdrawal", "ReconciliationException", "AzmSpendLog", "AdminProfitLog", "GlobalSettings", "SystemFiatPool", "SystemProfitFees", "SystemMasterCrypto", "FiatLiquidityReceipt", "FiatProviderEvent", "ProviderSettlementAttempt" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    /**
     * Seed an auto-payout candidate: committed user debit, PENDING canonical
     * WITHDRAWAL_FIAT row (legacy, no ownership metadata) and a PENDING
     * Withdrawal for the batch worker to claim.
     */
    async function seedAutoPayoutCandidate(reference) {
        const { seedUser } = require('./helpers/factories');
        const user = await seedUser(prisma, { availableBalance: START_BALANCE });
        await prisma.user.update({
            where: { id: user.id },
            data: { availableBalance: { decrement: AMOUNT + FEE } }
        });
        await prisma.systemMasterCrypto.update({
            where: { id: 1 },
            data: { balance: { increment: AMOUNT } }
        });
        const tx = await prisma.transactionHistory.create({
            data: {
                userId: user.id,
                type: 'WITHDRAWAL_FIAT',
                amountUsdc: AMOUNT,
                feeUsdc: FEE,
                status: 'PENDING',
                txHash: reference,
                metadata: { provider: 'MOOLRE', outcome: 'UNKNOWN_OUTCOME', economicsDeferred: true, dispatchedAt: new Date().toISOString() }
            }
        });
        const withdrawal = await prisma.withdrawal.create({
            data: {
                userId: user.id,
                amount: AMOUNT,
                destination: '0244556677',
                payoutMethod: 'MTN_MOMO',
                network: 'MTN',
                status: 'PENDING',
                createdAt: new Date()
            }
        });
        return { user, tx, withdrawal };
    }

    const loadWithdrawal = (id) => prisma.withdrawal.findUnique({
        where: { id },
        include: { user: { select: { id: true, email: true, username: true, phoneNumber: true, phoneVerified: true } } }
    });

    const settings = {
        autoPayoutEnabled: true,
        autoPayoutMaxAmountUsdc: 200,
        autoPayoutThresholdUsdc: 500,
        autoPayoutIntervalMs: 120000,
    };

    function mockMoolreTransferReject() {
        axiosPostSpy.mockImplementationOnce(async (url) => {
            if (url !== `${MOOLRE_BASE}/open/transact/transfer`) throw new Error(`r15k: unexpected POST ${url}`);
            return { data: { status: 0, code: 'LM01', message: 'Daily beneficiary limit exceeded', data: null } };
        });
    }

    function mockMtnDispatch() {
        // token fetch then transfer acceptance (202, no body)
        axiosPostSpy.mockImplementationOnce(async (url) => {
            if (!url.startsWith(`${MTN_BASE}/disbursement/token`)) throw new Error(`r15k: unexpected POST ${url}`);
            return { data: { access_token: 'mtn-token', token_type: 'access_token', expires_in: 3600 } };
        }).mockImplementationOnce(async (url) => {
            if (!url.startsWith(`${MTN_BASE}/disbursement/v1_0/transfer`)) throw new Error(`r15k: unexpected POST ${url}`);
            return { status: 202, data: null };
        });
    }

    function mockMtnToken() {
        axiosPostSpy.mockImplementationOnce(async (url) => {
            if (!url.startsWith(`${MTN_BASE}/disbursement/token`)) throw new Error(`r15k: unexpected POST ${url}`);
            return { data: { access_token: 'mtn-token', token_type: 'access_token', expires_in: 3600 } };
        });
    }

    function mockMtnStatus(status, extra = {}) {
        axiosGetSpy.mockImplementationOnce(async (url) => {
            if (!url.startsWith(`${MTN_BASE}/disbursement/v1_0/transfer/`)) throw new Error(`r15k: unexpected GET ${url}`);
            return { data: { status, ...extra } };
        });
    }

    function mockMoolreTransferAccept() {
        axiosPostSpy.mockImplementationOnce(async (url) => {
            if (url !== `${MOOLRE_BASE}/open/transact/transfer`) throw new Error(`r15k: unexpected POST ${url}`);
            return { data: { status: 1, code: 'SS01', message: 'Transaction Successful', data: { txstatus: 0, transactionid: 'MOOL-777', externalref: null } } };
        });
    }

    const PayoutBatchWorker = require('../workers/payoutBatchWorker');
    const WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');

    test('A. moolre rejection → mtn dispatch: ownership durably recorded, reconciliation queries the OWNER rail ONLY and settles EXACTLY once', async () => {
        const reference = 'R15K-FAILOVER-1';
        const { user, withdrawal } = await seedAutoPayoutCandidate(reference);

        mockMoolreTransferReject(); // moolre explicitly refuses (DEFINITIVE_REJECTION)
        mockMtnDispatch();         // mtn accepts the payout

        const batch = new PayoutBatchWorker(prisma, { emit: jest.fn() }, failover, null);
        const result = await batch._processBatch(settings, { isManualTrigger: true });
        expect(result.processed).toBe(1);

        // The withdrawal is claimed and dispatched.
        const claimed = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(claimed.status).toBe('PROCESSING');

        // ── THE OWNERSHIP WRITE ── the canonical row durably names the ACTUAL
        // provider that accepted this payout, not the hardcoded primary rail.
        const txAfterDispatch = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(txAfterDispatch.metadata.payoutProvider).toBe('mtn');
        expect(txAfterDispatch.metadata.payoutProviderName).toBe('MTN_MOMO_DISBURSEMENT');
        expect(txAfterDispatch.metadata.intendedProvider).toBe('MOOLRE_DISBURSEMENT');
        expect(txAfterDispatch.metadata.ownershipRecordedAt).toBeDefined();

        // Dispatch evidence names the ACTUAL provider.
        const evidence = await prisma.fiatProviderEvent.findUnique({
            where: { dedupKey: `event:payout-dispatch:MTN_MOMO_DISBURSEMENT:${reference}` }
        });
        expect(evidence).not.toBeNull();
        expect(evidence.provider).toBe('MTN_MOMO_DISBURSEMENT');

        // ── RECONCILIATION ── fresh spies: moolre must NEVER be asked.
        axiosPostSpy.mockClear();
        axiosGetSpy.mockClear();
        mockMtnStatus('SUCCESSFUL', { externalId: reference });

        const recon = new WithdrawalReconciliationWorker(prisma, null, failover);
        await recon._reconcileOne(await loadWithdrawal(withdrawal.id));

        // The owner rail ONLY: exactly one mtn status GET, zero moolre calls.
        expect(axiosGetSpy).toHaveBeenCalledTimes(1);
        expect(axiosGetSpy.mock.calls[0][0]).toBe(`${MTN_BASE}/disbursement/v1_0/transfer/${reference}`);
        expect(axiosPostSpy).not.toHaveBeenCalled();

        // Canonical terminal state: settled exactly once.
        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('COMPLETED');
        const wAfter = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(wAfter.status).toBe('COMPLETED');

        // Re-reconcile: idempotent, no duplicate settlement effects.
        axiosGetSpy.mockClear();
        mockMtnStatus('SUCCESSFUL', { externalId: reference });
        await recon._reconcileOne(await loadWithdrawal(withdrawal.id));
        const attempts = await prisma.$queryRawUnsafe(
            'SELECT COUNT(*)::int AS n FROM "ProviderSettlementAttempt" WHERE "providerReference" = $1 AND "status" = $2',
            reference, 'COMPLETED'
        );
        expect(attempts[0].n).toBe(1);
    });

    test('B. owner rail down: payout PARKS (UNRESOLVED evidence + exception), the healthy moolre rail is NEVER asked about an mtn-owned payout', async () => {
        const reference = 'R15K-FAILOVER-2';
        const { withdrawal } = await seedAutoPayoutCandidate(reference);

        mockMoolreTransferReject();
        mockMtnDispatch();
        const batch = new PayoutBatchWorker(prisma, { emit: jest.fn() }, failover, null);
        await batch._processBatch(settings, { isManualTrigger: true });

        // Owner rail goes down: mtn status lookup times out.
        axiosPostSpy.mockClear();
        axiosGetSpy.mockClear();
        axiosGetSpy.mockImplementationOnce(async () => {
            throw Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' });
        });

        const recon = new WithdrawalReconciliationWorker(prisma, null, failover);
        await recon._reconcileOne(await loadWithdrawal(withdrawal.id));

        // mtn was asked (the owner), moolre was NOT (the cross-provider guard).
        expect(axiosGetSpy).toHaveBeenCalledTimes(1);
        expect(axiosPostSpy).not.toHaveBeenCalled();

        // The payout stays parked — NO invented terminal state.
        const wAfter = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(['PENDING', 'PROCESSING']).toContain(wAfter.status);
        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('PENDING');

        // Durable UNRESOLVED observation + exception naming the actual owner.
        const unresolvedEvidence = await prisma.fiatProviderEvent.findUnique({
            where: { dedupKey: `event:payout-outbound:MTN_MOMO_DISBURSEMENT:${reference}:UNKNOWN` }
        });
        expect(unresolvedEvidence).not.toBeNull();
        const excRows = await prisma.$queryRawUnsafe(
            'SELECT "details" FROM "ReconciliationException" WHERE "reference" = $1 AND "reason" = $2 LIMIT 1',
            reference, 'PROVIDER_STATUS_UNRESOLVED'
        );
        expect(excRows).toHaveLength(1);
        const excDetails = typeof excRows[0].details === 'string' ? JSON.parse(excRows[0].details) : excRows[0].details;
        expect(excDetails.owner).toBe('mtn');
        expect(excDetails.ownerCanonicalName).toBe('MTN_MOMO_DISBURSEMENT');

        // Owner recovers → the SAME payout resolves on the next tick.
        axiosGetSpy.mockClear();
        mockMtnStatus('SUCCESSFUL', { externalId: reference });
        await recon._reconcileOne(await loadWithdrawal(withdrawal.id));
        const wFinal = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(wFinal.status).toBe('COMPLETED');
        expect(axiosPostSpy).not.toHaveBeenCalled(); // moolre STILL never asked
    });

    test('C. LEGACY row (no persisted ownership): moolre "reference not found" → search CONTINUES → mtn resolves it (the P0 regression proof)', async () => {
        const reference = 'R15K-LEGACY-1';
        const { withdrawal } = await seedAutoPayoutCandidate(reference);
        // (seedAutoPayoutCandidate leaves NO payoutProvider metadata — the
        // genuinely-unknown-ownership legacy state the old defect stranded.)

        // moolre status: authoritative absence. mtn status: SUCCESSFUL.
        axiosPostSpy.mockImplementationOnce(async (url) => {
            if (url !== `${MOOLRE_BASE}/open/transact/status`) throw new Error(`r15k: unexpected POST ${url}`);
            return { data: { status: 0, code: 'RD01', message: 'Reference not found', data: null } };
        });
        mockMtnToken();
        mockMtnStatus('SUCCESSFUL', { externalId: reference });

        const recon = new WithdrawalReconciliationWorker(prisma, null, failover);
        await recon._reconcileOne(await loadWithdrawal(withdrawal.id));

        // BOTH rails were consulted (ownership genuinely unknown — the search
        // continued past moolre's authoritative absence) and mtn's answer
        // resolved the payout. Under the OLD contract, moolre's "not found"
        // collapsed to PENDING and mtn was NEVER asked: this payout could
        // never resolve.
        // moolre status (POST) + mtn OAuth token (POST) + mtn status (GET).
        expect(axiosPostSpy.mock.calls.map(c => c[0]).sort()).toEqual([
            `${MOOLRE_BASE}/open/transact/status`,
            `${MTN_BASE}/disbursement/token/`,
        ]);
        expect(axiosGetSpy).toHaveBeenCalledTimes(1);

        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('COMPLETED');
        const wAfter = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(wAfter.status).toBe('COMPLETED');
    });

    test('D. every rail authoritatively answers absence: durable PROVIDER_REFERENCE_NOT_FOUND exception, the payout parks — never an invented state', async () => {
        const reference = 'R15K-ABSENT-1';
        const { withdrawal } = await seedAutoPayoutCandidate(reference);

        axiosPostSpy.mockImplementationOnce(async (url) => {
            if (url !== `${MOOLRE_BASE}/open/transact/status`) throw new Error(`r15k: unexpected POST ${url}`);
            return { data: { status: 0, code: 'RD01', message: 'Reference not found', data: null } };
        });
        mockMtnToken();
        axiosGetSpy.mockImplementationOnce(async () => {
            throw Object.assign(
                new Error('Request failed with status code 404'),
                { response: { status: 404, data: { code: 'RESOURCE_NOT_FOUND', message: 'referenceId not found' } } }
            );
        });

        const recon = new WithdrawalReconciliationWorker(prisma, null, failover);
        await recon._reconcileOne(await loadWithdrawal(withdrawal.id));

        // moolre status (POST) + mtn OAuth token (POST) + mtn status (GET).
        expect(axiosPostSpy.mock.calls.map(c => c[0]).sort()).toEqual([
            `${MOOLRE_BASE}/open/transact/status`,
            `${MTN_BASE}/disbursement/token/`,
        ]);
        expect(axiosGetSpy).toHaveBeenCalledTimes(1);

        const wAfter = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(['PENDING', 'PROCESSING']).toContain(wAfter.status);
        const excRows = await prisma.$queryRawUnsafe(
            'SELECT "details" FROM "ReconciliationException" WHERE "reference" = $1 AND "reason" = $2 LIMIT 1',
            reference, 'PROVIDER_REFERENCE_NOT_FOUND'
        );
        expect(excRows).toHaveLength(1);
        const excDetails = typeof excRows[0].details === 'string' ? JSON.parse(excRows[0].details) : excRows[0].details;
        expect(excDetails.observedStatus).toBe('NOT_FOUND');
    });

    test('E. moolre-owned payout (no failover): ownership recorded as moolre, reconciliation queries moolre ONLY and mtn is never invoked', async () => {
        const reference = 'R15K-MOOLRE-1';
        const { withdrawal } = await seedAutoPayoutCandidate(reference);

        mockMoolreTransferAccept(); // primary rail accepts directly
        const batch = new PayoutBatchWorker(prisma, { emit: jest.fn() }, failover, null);
        const result = await batch._processBatch(settings, { isManualTrigger: true });
        expect(result.processed).toBe(1);

        const txAfterDispatch = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(txAfterDispatch.metadata.payoutProvider).toBe('moolre');
        expect(txAfterDispatch.metadata.payoutProviderName).toBe('MOOLRE_DISBURSEMENT');

        // Reconciliation: moolre status txstatus=1 → SUCCESSFUL; mtn untouched.
        axiosPostSpy.mockClear();
        axiosGetSpy.mockClear();
        axiosPostSpy.mockImplementationOnce(async (url) => {
            if (url !== `${MOOLRE_BASE}/open/transact/status`) throw new Error(`r15k: unexpected POST ${url}`);
            return { data: { status: 1, code: 'SS01', message: 'Transaction Successful', data: { txstatus: 1, transactionid: 'MOOL-888', externalref: reference } } };
        });

        const recon = new WithdrawalReconciliationWorker(prisma, null, failover);
        await recon._reconcileOne(await loadWithdrawal(withdrawal.id));

        expect(axiosPostSpy).toHaveBeenCalledTimes(1);
        expect(axiosGetSpy).not.toHaveBeenCalled();
        const wAfter = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(wAfter.status).toBe('COMPLETED');
    });
});
