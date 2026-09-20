// __tests__/r15l-dispatch-bookkeeping-failure-paths.test.js
// =============================================================================
// r15 hardening (audit P0, 2026-09-20) — DISPATCH-ACCEPTANCE BOOKKEEPING
// FAILURE PATHS, end-to-end against real PostgreSQL.
//
// THE AUDIT FINDING: the payment failover chain (moolre → mtn) can accept a
// payout on EITHER rail, and the post-dispatch bookkeeping (dispatch
// evidence, canonical ownership, IN_TRANSIT transition) runs AFTER real money
// has moved. When that bookkeeping fails, the previous code either (a) fell
// back to a hardcoded rail identity ('MTN_MOMO') for evidence, or (b) treated
// ownership/evidence writes as interchangeable soft failures. Either behavior
// can strand or mis-settle a real payout.
//
// THE CONTRACT THIS SUITE PINS (matrix A–J; r15k additionally pins the
// healthy-failover, owner-down, legacy-search, and all-rails-absent cases):
//   • A. ownership write fails after MOOLRE accepted → the durable dispatch
//       observation recovers the owner → reconciliation queries MOOLRE ONLY
//       and settles COMPLETED exactly once.
//   • B. ownership write fails after failover to MTN → evidence names MTN →
//       reconciliation queries MTN ONLY; moolre is NEVER asked.
//   • C. the dispatch EVIDENCE write itself fails → the payout parks
//       (NEEDS_MANUAL_REVIEW + durable exception); even an operator reopen
//       NEVER lets reconciliation cross-rail guess a dispatched payout.
//   • D. a KNOWN owner authoritatively answers NOT_FOUND → parked with a
//       durable exception; the other rail is never asked.
//   • E. two different providers hold dispatch evidence for one reference →
//       OWNERSHIP CONFLICT park — never a coin flip between them.
//   • F. an accepted dispatch carries NO provider identity at all → the
//       worker parks (DISPATCH_IDENTITY_UNKNOWN), never invents a rail.
//   • G. CONTROLLER path: ownership failure after acceptance → tracked (not
//       refunded, not falsely rejected), reconciliation recovers the owner
//       from evidence and settles exactly once (and a later FAILED reverses
//       exactly once).
//   • H. CONTROLLER path: if the reconciliation record cannot be
//       established, the reservation is rolled back BEFORE any provider I/O.
//   • I. CONTROLLER path: a no-identity accepted dispatch → fail-closed 503,
//       no evidence under an invented rail, reconciliation never guesses.
// =============================================================================

jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/fraudDetectionService', () => ({ evaluate: jest.fn().mockResolvedValue({ allowed: true, triggeredRules: [] }) }));
// The ownership write is injectable for the post-acceptance failure paths;
// default behavior is the REAL fail-closed implementation.
jest.mock('../services/payoutProviderOwnership', () => {
    const actual = jest.requireActual('../services/payoutProviderOwnership');
    return { ...actual, persistPayoutOwnership: jest.fn(actual.persistPayoutOwnership) };
});

const axios = require('axios');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r15l] TEST_DATABASE_URL not set — skipping real-DB suite.');

const TRUNCATE_LIST = '"User", "TransactionHistory", "Withdrawal", "ReconciliationException", "AzmSpendLog", "AdminProfitLog", "GlobalSettings", "SystemFiatPool", "SystemProfitFees", "SystemMasterCrypto", "FiatLiquidityReceipt", "FiatProviderEvent", "ProviderSettlementAttempt"';

describeOrSkip('r15 hardening A–F: dispatch-acceptance bookkeeping failure paths (real PostgreSQL)', () => {
    let prisma;
    let failover;
    let axiosPostSpy;
    let axiosGetSpy;
    let recordProviderEventSpy;
    let originalRecordProviderEvent;
    let persistPayoutOwnershipMock;

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

        // Axios mocked at the HTTP boundary: any UNMOCKED call throws, so a
        // "wrong rail was consulted" assertion fails loudly instead of
        // silently hitting the network.
        axiosPostSpy = jest.spyOn(axios, 'post').mockImplementation(async (url) => {
            throw new Error(`r15l: unmocked POST ${url}`);
        });
        axiosGetSpy = jest.spyOn(axios, 'get').mockImplementation(async (url) => {
            throw new Error(`r15l: unmocked GET ${url}`);
        });

        const fiatLiquidity = require('../src/services/fiatLiquidityService');
        // Capture the ORIGINAL implementation BEFORE spying — after
        // jest.spyOn replaces the property, re-reading it yields the spy.
        originalRecordProviderEvent = fiatLiquidity.recordProviderEvent;
        recordProviderEventSpy = jest.spyOn(fiatLiquidity, 'recordProviderEvent');

        persistPayoutOwnershipMock = require('../services/payoutProviderOwnership').persistPayoutOwnership;
    });

    afterAll(async () => {
        axiosPostSpy.mockRestore();
        axiosGetSpy.mockRestore();
        recordProviderEventSpy.mockRestore();
        [
            'MOOLRE_PROVIDER', 'MOOLRE_API_USER', 'MOOLRE_API_KEY', 'MOOLRE_BASE_URL', 'MOOLRE_ACCOUNT_NUMBER',
            'MTN_MOMO_PROVIDER', 'MTN_MOMO_API_USER', 'MTN_MOMO_API_KEY', 'MTN_MOMO_SUBSCRIPTION_KEY', 'MTN_MOMO_BASE_URL',
        ].forEach(k => delete process.env[k]);
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        const MoolreDisbursementService = require('../services/moolreDisbursementService');
        const MtnDisbursementService = require('../services/mtnDisbursementService');
        const { PaymentFailoverService } = require('../src/services/paymentFailoverService');
        failover = new PaymentFailoverService({
            primary: new MoolreDisbursementService({}),
            secondary: new MtnDisbursementService({}),
            probeMinIntervalMs: 0,
        });

        axiosPostSpy.mockReset().mockImplementation(async (url) => {
            throw new Error(`r15l: unmocked POST ${url}`);
        });
        axiosGetSpy.mockReset().mockImplementation(async (url) => {
            throw new Error(`r15l: unmocked GET ${url}`);
        });
        recordProviderEventSpy.mockReset().mockImplementation(originalRecordProviderEvent);
        persistPayoutOwnershipMock.mockClear();

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
        await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TRUNCATE_LIST} RESTART IDENTITY CASCADE`);
    }, 15000);

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
            if (url !== `${MOOLRE_BASE}/open/transact/transfer`) throw new Error(`r15l: unexpected POST ${url}`);
            return { data: { status: 0, code: 'LM01', message: 'Daily beneficiary limit exceeded', data: null } };
        });
    }

    function mockMtnDispatch() {
        axiosPostSpy.mockImplementationOnce(async (url) => {
            if (!url.startsWith(`${MTN_BASE}/disbursement/token`)) throw new Error(`r15l: unexpected POST ${url}`);
            return { data: { access_token: 'mtn-token', token_type: 'access_token', expires_in: 3600 } };
        }).mockImplementationOnce(async (url) => {
            if (!url.startsWith(`${MTN_BASE}/disbursement/v1_0/transfer`)) throw new Error(`r15l: unexpected POST ${url}`);
            return { status: 202, data: null };
        });
    }

    function mockMtnToken() {
        axiosPostSpy.mockImplementationOnce(async (url) => {
            if (!url.startsWith(`${MTN_BASE}/disbursement/token`)) throw new Error(`r15l: unexpected POST ${url}`);
            return { data: { access_token: 'mtn-token', token_type: 'access_token', expires_in: 3600 } };
        });
    }

    function mockMtnStatus(status, extra = {}) {
        axiosGetSpy.mockImplementationOnce(async (url) => {
            if (!url.startsWith(`${MTN_BASE}/disbursement/v1_0/transfer/`)) throw new Error(`r15l: unexpected GET ${url}`);
            return { data: { status, ...extra } };
        });
    }

    function mockMoolreTransferAccept() {
        axiosPostSpy.mockImplementationOnce(async (url) => {
            if (url !== `${MOOLRE_BASE}/open/transact/transfer`) throw new Error(`r15l: unexpected POST ${url}`);
            return { data: { status: 1, code: 'SS01', message: 'Transaction Successful', data: { txstatus: 0, transactionid: 'MOOL-777', externalref: null } } };
        });
    }

    function mockMoolreStatus(txstatus, transactionid = 'MOOL-888') {
        axiosPostSpy.mockImplementationOnce(async (url) => {
            if (url !== `${MOOLRE_BASE}/open/transact/status`) throw new Error(`r15l: unexpected POST ${url}`);
            return { data: { status: 1, code: 'SS01', message: 'Transaction Successful', data: { txstatus, transactionid, externalref: 'R15L-EXT' } } };
        });
    }

    const PayoutBatchWorker = require('../workers/payoutBatchWorker');
    const WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');

    const durableExceptions = (reference) => prisma.$queryRawUnsafe(
        'SELECT "reason" FROM "ReconciliationException" WHERE "reference" = $1 ORDER BY "firstSeenAt"',
        reference
    );

    test('A. ownership write FAILS after moolre accepted: evidence recovers the owner — reconciliation queries MOOLRE ONLY and settles EXACTLY once', async () => {
        const reference = 'R15L-A-OWNERSHIP-FAIL-MOOLRE';
        const { withdrawal } = await seedAutoPayoutCandidate(reference);

        mockMoolreTransferAccept();
        // Inject: the canonical ownership write fails AFTER acceptance.
        persistPayoutOwnershipMock.mockImplementationOnce(async () => {
            throw new Error('r15l: injected ownership write failure');
        });

        const batch = new PayoutBatchWorker(prisma, { emit: jest.fn() }, failover, null);
        const result = await batch._processBatch(settings, { isManualTrigger: true });
        expect(result.processed).toBe(1);

        // The payout is dispatched and tracked — NOT flagged out of
        // auto-recovery, no refund.
        const claimed = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(claimed.status).toBe('PROCESSING');

        // Canonical ownership is absent (the write failed)...
        const txAfterDispatch = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(txAfterDispatch.metadata.payoutProvider).toBeUndefined();

        // ...but the durable dispatch observation names the ACTUAL provider.
        const evidence = await prisma.fiatProviderEvent.findUnique({
            where: { dedupKey: `event:payout-dispatch:MOOLRE_DISBURSEMENT:${reference}` }
        });
        expect(evidence).not.toBeNull();

        // The failure is loudly visible.
        const exc = await durableExceptions(reference);
        expect(exc.map(e => e.reason)).toContain('POST_DISPATCH_OWNERSHIP_WRITE_FAILED');

        // ── RECONCILIATION: owner recovered from evidence → moolre ONLY. ──
        axiosPostSpy.mockClear();
        axiosGetSpy.mockClear();
        mockMoolreStatus(1); // txstatus 1 = success

        const recon = new WithdrawalReconciliationWorker(prisma, null, failover);
        await recon._reconcileOne(await loadWithdrawal(withdrawal.id));

        // Exactly one moolre status call; MTN never invoked.
        expect(axiosPostSpy).toHaveBeenCalledTimes(1);
        expect(axiosPostSpy.mock.calls[0][0]).toBe(`${MOOLRE_BASE}/open/transact/status`);
        expect(axiosGetSpy).not.toHaveBeenCalled();

        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('COMPLETED');
        const wAfter = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(wAfter.status).toBe('COMPLETED');

        // Idempotent: a second reconcile changes nothing.
        axiosPostSpy.mockClear();
        mockMoolreStatus(1);
        await recon._reconcileOne(await loadWithdrawal(withdrawal.id));
        const attempts = await prisma.$queryRawUnsafe(
            'SELECT COUNT(*)::int AS n FROM "ProviderSettlementAttempt" WHERE "providerReference" = $1 AND "status" = $2',
            reference, 'COMPLETED'
        );
        expect(attempts[0].n).toBe(1);
    });

    test('B. ownership write FAILS after failover to MTN: evidence names MTN — reconciliation queries MTN ONLY, moolre is NEVER asked', async () => {
        const reference = 'R15L-B-OWNERSHIP-FAIL-MTN';
        const { withdrawal } = await seedAutoPayoutCandidate(reference);

        mockMoolreTransferReject(); // definitive rejection → failover
        mockMtnDispatch();          // mtn accepts
        persistPayoutOwnershipMock.mockImplementationOnce(async () => {
            throw new Error('r15l: injected ownership write failure');
        });

        const batch = new PayoutBatchWorker(prisma, { emit: jest.fn() }, failover, null);
        const result = await batch._processBatch(settings, { isManualTrigger: true });
        expect(result.processed).toBe(1);

        const claimed = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(claimed.status).toBe('PROCESSING');

        const evidence = await prisma.fiatProviderEvent.findUnique({
            where: { dedupKey: `event:payout-dispatch:MTN_MOMO_DISBURSEMENT:${reference}` }
        });
        expect(evidence).not.toBeNull();
        const exc = await durableExceptions(reference);
        expect(exc.map(e => e.reason)).toContain('POST_DISPATCH_OWNERSHIP_WRITE_FAILED');

        // ── RECONCILIATION: owner recovered from evidence → mtn ONLY. ──
        axiosPostSpy.mockClear();
        axiosGetSpy.mockClear();
        mockMtnStatus('SUCCESSFUL', { externalId: reference });

        const recon = new WithdrawalReconciliationWorker(prisma, null, failover);
        await recon._reconcileOne(await loadWithdrawal(withdrawal.id));

        // Status GET on mtn ONLY; the mtn OAuth token is cached from the
        // dispatch phase, so reconciliation needs no token POST. moolre is
        // NEVER queried.
        expect(axiosGetSpy).toHaveBeenCalledTimes(1);
        expect(axiosGetSpy.mock.calls[0][0]).toBe(`${MTN_BASE}/disbursement/v1_0/transfer/${reference}`);
        expect(axiosPostSpy).not.toHaveBeenCalled();

        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('COMPLETED');
        const wAfter = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(wAfter.status).toBe('COMPLETED');

        // Settled exactly once.
        mockMtnToken();
        mockMtnStatus('SUCCESSFUL', { externalId: reference });
        await recon._reconcileOne(await loadWithdrawal(withdrawal.id));
        const attempts = await prisma.$queryRawUnsafe(
            'SELECT COUNT(*)::int AS n FROM "ProviderSettlementAttempt" WHERE "providerReference" = $1 AND "status" = $2',
            reference, 'COMPLETED'
        );
        expect(attempts[0].n).toBe(1);
    });

    test('C. the dispatch EVIDENCE write fails: the payout parks (manual review + durable exception) and reconciliation NEVER cross-rail guesses it, even after an operator reopen', async () => {
        const reference = 'R15L-C-EVIDENCE-FAIL';
        const { withdrawal } = await seedAutoPayoutCandidate(reference);

        mockMoolreTransferAccept();
        // Inject: the durable dispatch observation write fails.
        recordProviderEventSpy.mockImplementationOnce(async () => {
            throw new Error('r15l: injected evidence write failure');
        });

        const batch = new PayoutBatchWorker(prisma, { emit: jest.fn() }, failover, null);
        const result = await batch._processBatch(settings, { isManualTrigger: true });
        expect(result.details.errors).toEqual([{ id: withdrawal.id, reason: 'POST_DISPATCH_BOOKKEEPING_FAILED', referenceId: reference }]);

        // Parked for manual review — the payout is in flight, so no refund.
        const flagged = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(flagged.status).toBe('NEEDS_MANUAL_REVIEW');

        // NO evidence row exists under any invented rail.
        const evidence = await prisma.fiatProviderEvent.findFirst({
            where: { dedupKey: { startsWith: 'event:payout-dispatch:' }, relatedReference: reference }
        });
        expect(evidence).toBeNull();

        // The durable exception exists — this is what the guard reads.
        const exc = await durableExceptions(reference);
        expect(exc.map(e => e.reason)).toContain('POST_DISPATCH_BOOKKEEPING_FAILED');

        // The user was NOT refunded: money is with the provider.
        const txRow = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txRow.status).toBe('PENDING');

        // ── An operator reopens the row (status reset): reconciliation must
        //    STILL refuse to cross-rail guess a dispatched payout. ──
        axiosPostSpy.mockClear();
        axiosGetSpy.mockClear();
        await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status: 'PENDING' } });

        const recon = new WithdrawalReconciliationWorker(prisma, null, failover);
        await recon._reconcileOne(await loadWithdrawal(withdrawal.id));

        // ZERO provider calls — the guard parked it before any I/O.
        expect(axiosPostSpy).not.toHaveBeenCalled();
        expect(axiosGetSpy).not.toHaveBeenCalled();

        const excAfter = await durableExceptions(reference);
        expect(excAfter.map(e => e.reason)).toContain('DISPATCHED_OWNERSHIP_NOT_DURABLE');

        const wAfter = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(['PENDING', 'NEEDS_MANUAL_REVIEW']).toContain(wAfter.status);
    });

    test('D. KNOWN owner answers NOT_FOUND: durable PROVIDER_REFERENCE_NOT_FOUND park, the other rail is NEVER asked', async () => {
        const reference = 'R15L-D-OWNER-NOT-FOUND';
        const { withdrawal } = await seedAutoPayoutCandidate(reference);

        mockMoolreTransferReject();
        mockMtnDispatch();
        const batch = new PayoutBatchWorker(prisma, { emit: jest.fn() }, failover, null);
        await batch._processBatch(settings, { isManualTrigger: true });

        // Owner is mtn (canonical ownership write succeeded).
        const txAfterDispatch = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(txAfterDispatch.metadata.payoutProvider).toBe('mtn');

        // ── Reconciliation: mtn authoritatively says the reference does not
        //    exist ON ITS RAIL. The owner is known — moolre may not be asked. ──
        axiosPostSpy.mockClear();
        axiosGetSpy.mockClear();
        axiosGetSpy.mockImplementationOnce(async () => {
            throw Object.assign(
                new Error('Request failed with status code 404'),
                { response: { status: 404, data: { code: 'RESOURCE_NOT_FOUND', message: 'referenceId not found' } } }
            );
        });

        const recon = new WithdrawalReconciliationWorker(prisma, null, failover);
        await recon._reconcileOne(await loadWithdrawal(withdrawal.id));

        // Status GET on mtn ONLY (token cached from dispatch); moolre NEVER.
        expect(axiosGetSpy).toHaveBeenCalledTimes(1);
        expect(axiosGetSpy.mock.calls[0][0]).toBe(`${MTN_BASE}/disbursement/v1_0/transfer/${reference}`);
        expect(axiosPostSpy).not.toHaveBeenCalled();

        const wAfter = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(['PENDING', 'PROCESSING']).toContain(wAfter.status);
        const exc = await durableExceptions(reference);
        expect(exc.map(e => e.reason)).toContain('PROVIDER_REFERENCE_NOT_FOUND');
    });

    test('E. two providers hold dispatch evidence for one reference: OWNERSHIP CONFLICT park — never a coin flip', async () => {
        const reference = 'R15L-E-CONFLICT';
        const { withdrawal } = await seedAutoPayoutCandidate(reference);

        // Durable dispatch evidence for BOTH rails, no canonical owner.
        for (const provider of ['MOOLRE_DISBURSEMENT', 'MTN_MOMO_DISBURSEMENT']) {
            await prisma.fiatProviderEvent.create({
                data: {
                    provider,
                    rail: 'MOMO',
                    direction: 'OUTBOUND',
                    status: 'DISPATCH_ACCEPTED',
                    dedupKey: `event:payout-dispatch:${provider}:${reference}`,
                    relatedReference: reference,
                }
            });
        }

        const recon = new WithdrawalReconciliationWorker(prisma, null, failover);
        await recon._reconcileOne(await loadWithdrawal(withdrawal.id));

        // ZERO provider calls — a conflict is a human decision, not a poll.
        expect(axiosPostSpy).not.toHaveBeenCalled();
        expect(axiosGetSpy).not.toHaveBeenCalled();

        const exc = await durableExceptions(reference);
        expect(exc.map(e => e.reason)).toContain('PAYOUT_OWNERSHIP_CONFLICT');

        const wAfter = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(['PENDING', 'PROCESSING']).toContain(wAfter.status);
        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('PENDING');
    });

    test('F. accepted dispatch carries NO provider identity: the worker parks (DISPATCH_IDENTITY_UNKNOWN), never invents a rail', async () => {
        const reference = 'R15L-F-IDENTITY-UNKNOWN';
        const { withdrawal } = await seedAutoPayoutCandidate(reference);

        // A provider stub that accepts but self-identifies nowhere: no
        // failover tag, no provider field.
        const identitylessProvider = {
            newReferenceId: () => `r15l-${Date.now()}`,
            async initiateTransfer() {
                return { status: 'PENDING', referenceId: 'PROV-1', data: { reference: 'PROV-1' } };
            },
            async getTransferStatus() { return { status: 'PENDING' }; },
        };

        const batch = new PayoutBatchWorker(prisma, { emit: jest.fn() }, identitylessProvider, null);
        const result = await batch._processBatch(settings, { isManualTrigger: true });
        expect(result.details.errors).toEqual([{ id: withdrawal.id, reason: 'DISPATCH_IDENTITY_UNKNOWN', referenceId: reference }]);

        const flagged = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(flagged.status).toBe('NEEDS_MANUAL_REVIEW');

        // NO evidence row exists — no rail identity was invented.
        const evidence = await prisma.fiatProviderEvent.findFirst({
            where: { dedupKey: { startsWith: 'event:payout-dispatch:' }, relatedReference: reference }
        });
        expect(evidence).toBeNull();

        const exc = await durableExceptions(reference);
        expect(exc.map(e => e.reason)).toContain('DISPATCH_IDENTITY_UNKNOWN');

        // The user was NOT refunded (payout in flight) and no ownership was
        // written under an invented rail.
        const txRow = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(txRow.status).toBe('PENDING');
        expect(txRow.metadata.payoutProvider).toBeUndefined();

        // Operator reopen → reconciliation parks via the guard, never guesses.
        await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status: 'PENDING' } });
        const recon = new WithdrawalReconciliationWorker(prisma, null, failover);
        await recon._reconcileOne(await loadWithdrawal(withdrawal.id));
        expect(axiosPostSpy).not.toHaveBeenCalled();
        expect(axiosGetSpy).not.toHaveBeenCalled();
        const excAfter = await durableExceptions(reference);
        expect(excAfter.map(e => e.reason)).toContain('DISPATCHED_OWNERSHIP_NOT_DURABLE');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Matrix G–I: the CONTROLLER path (controllers/withdrawalController.fiatWithdrawal)
// ─────────────────────────────────────────────────────────────────────────────

describeOrSkip('r15 hardening G–I: controller path — tracked, fail-closed, recoverable (real PostgreSQL)', () => {
    let prisma;
    let azm;
    let failover;
    let axiosPostSpy;
    let axiosGetSpy;
    let persistPayoutOwnershipMock;

    const MOOLRE_BASE = 'https://moolre.test.local';
    const MTN_BASE = 'https://mtn.test.local';
    const START_USDC = 500.0;
    const WITHDRAWAL = 50.0;
    const EXIT_FEE = 1.0; // 2% of 50

    const { seedUser } = require('./helpers/factories');
    const { AzmSpendService } = require('../services/azmSpendService');
    const { fiatWithdrawal } = require('../controllers/withdrawalController');
    const WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');

    beforeAll(() => {
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        azm = new AzmSpendService(prisma);

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

        axiosPostSpy = jest.spyOn(axios, 'post').mockImplementation(async (url) => {
            throw new Error(`r15l: unmocked POST ${url}`);
        });
        axiosGetSpy = jest.spyOn(axios, 'get').mockImplementation(async (url) => {
            throw new Error(`r15l: unmocked GET ${url}`);
        });

        persistPayoutOwnershipMock = require('../services/payoutProviderOwnership').persistPayoutOwnership;
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
        const MoolreDisbursementService = require('../services/moolreDisbursementService');
        const MtnDisbursementService = require('../services/mtnDisbursementService');
        const { PaymentFailoverService } = require('../src/services/paymentFailoverService');
        failover = new PaymentFailoverService({
            primary: new MoolreDisbursementService({}),
            secondary: new MtnDisbursementService({}),
            probeMinIntervalMs: 0,
        });

        axiosPostSpy.mockReset().mockImplementation(async (url) => {
            throw new Error(`r15l: unmocked POST ${url}`);
        });
        axiosGetSpy.mockReset().mockImplementation(async (url) => {
            throw new Error(`r15l: unmocked GET ${url}`);
        });
        persistPayoutOwnershipMock.mockClear();

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
        await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TRUNCATE_LIST} RESTART IDENTITY CASCADE`);
    }, 15000);

    const freshUser = (id) =>
        prisma.user.findUnique({ where: { id }, select: { availableBalance: true, azmBalance: true } });

    function makeHarness(providerImpl) {
        const appMap = new Map([
            ['prisma', prisma],
            ['azmSpendService', azm],
            ['paymentFailoverService', providerImpl],
            ['emitBalanceUpdate', async () => {}],
            ['emailService', null],
            ['smsService', null],
            ['adminAlertService', null],
            ['socketio', null],
        ]);
        const app = { get: (k) => (appMap.has(k) ? appMap.get(k) : null) };
        const res = {
            statusCode: null,
            body: null,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; return this; },
        };
        return { app, res };
    }

    async function runWithdrawal(user, { app, res }, phone = '0244556677') {
        const req = {
            app,
            ip: '127.0.0.1',
            headers: {},
            body: { amount: String(WITHDRAWAL), payoutMethod: 'MTN_MOMO', recipientPhone: phone },
            user: { id: user.id, username: 'r15l', createdAt: new Date(Date.now() - 90 * 86400000) },
        };
        await fiatWithdrawal(req, res);
        return res;
    }

    /** A provider that ACCEPTS the dispatch (moolre identity, failover-tagged). */
    function acceptingMoolreProvider() {
        return {
            name: 'r15l-accepting-provider',
            _dispatchCalls: 0,
            newReferenceId: () => 'r15l-prov-ref',
            async initiateTransfer(payload) {
                this._dispatchCalls += 1;
                return {
                    _provider: 'moolre',
                    provider: 'MOOLRE_DISBURSEMENT',
                    status: 'PENDING',
                    referenceId: 'r15l-prov-ref',
                    data: { reference: 'MOOL-PROV-1' },
                };
            },
            async getTransferStatus() { return { status: 'PENDING' }; },
        };
    }

    function mockMoolreStatus(txstatus, transactionid = 'MOOL-888') {
        axiosPostSpy.mockImplementationOnce(async (url) => {
            if (url !== `${MOOLRE_BASE}/open/transact/status`) throw new Error(`r15l: unexpected POST ${url}`);
            return { data: { status: 1, code: 'SS01', message: 'Transaction Successful', data: { txstatus, transactionid, externalref: 'R15L-EXT' } } };
        });
    }

    const loadWithdrawal = (id) => prisma.withdrawal.findUnique({
        where: { id },
        include: { user: { select: { id: true, email: true, username: true, phoneNumber: true, phoneVerified: true } } }
    });

    test('G. ownership write fails AFTER the provider accepted: payout stays tracked (no refund, no false rejection), reconciliation recovers the owner from evidence and settles EXACTLY once', async () => {
        const user = await seedUser(prisma, { availableBalance: START_USDC });
        const provider = acceptingMoolreProvider();
        const { app, res } = makeHarness(provider);

        // Inject: canonical ownership write fails post-acceptance.
        persistPayoutOwnershipMock.mockImplementationOnce(async () => {
            throw new Error('r15l: injected ownership write failure');
        });

        const response = await runWithdrawal(user, { app, res });
        expect(response.statusCode).toBe(200);
        expect(response.body.success).toBe(true);

        // NOT refunded — the provider has the money.
        const u = await freshUser(user.id);
        expect(Number(u.availableBalance)).toBeCloseTo(START_USDC - WITHDRAWAL - EXIT_FEE, 6);

        // The reconciliation record exists and is linked to the canonical row.
        const txRow = await prisma.transactionHistory.findFirst({
            where: { userId: user.id, type: 'WITHDRAWAL_FIAT' },
            orderBy: { id: 'desc' },
        });
        expect(txRow.status).toBe('PENDING');
        expect(txRow.metadata.payoutProvider).toBeUndefined(); // ownership write failed

        const wRow = await prisma.withdrawal.findFirst({ where: { userId: user.id } });
        expect(wRow).not.toBeNull();
        expect(wRow.status).toBe('PENDING');
        expect(wRow.transactionHistoryId).toBe(txRow.id); // the J-item link: no orphaned bookkeeping

        // The durable dispatch observation names the actual provider.
        const evidence = await prisma.fiatProviderEvent.findFirst({
            where: { dedupKey: { startsWith: 'event:payout-dispatch:MOOLRE_DISBURSEMENT:' } }
        });
        expect(evidence).not.toBeNull();
        expect(evidence.relatedReference).toBe(txRow.txHash);

        // Loud, durable failure.
        const exc = await prisma.$queryRawUnsafe(
            'SELECT "reason" FROM "ReconciliationException" WHERE "reference" = $1',
            txRow.txHash
        );
        expect(exc.map(e => e.reason)).toContain('POST_DISPATCH_OWNERSHIP_WRITE_FAILED');

        // ── Reconciliation recovers the owner FROM EVIDENCE: moolre only. ──
        mockMoolreStatus(1); // txstatus 1 = success
        const recon = new WithdrawalReconciliationWorker(prisma, null, failover);
        await recon._reconcileOne(await loadWithdrawal(wRow.id));

        expect(axiosPostSpy).toHaveBeenCalledTimes(1);
        expect(axiosPostSpy.mock.calls[0][0]).toBe(`${MOOLRE_BASE}/open/transact/status`);
        expect(axiosGetSpy).not.toHaveBeenCalled();

        const txAfter = await prisma.transactionHistory.findUnique({ where: { id: txRow.id }, select: { status: true } });
        expect(txAfter.status).toBe('COMPLETED');
        const wAfter = await prisma.withdrawal.findUnique({ where: { id: wRow.id } });
        expect(wAfter.status).toBe('COMPLETED');

        // Settled EXACTLY once.
        mockMoolreStatus(1);
        await recon._reconcileOne(await loadWithdrawal(wRow.id));
        const attempts = await prisma.$queryRawUnsafe(
            'SELECT COUNT(*)::int AS n FROM "ProviderSettlementAttempt" WHERE "providerReference" = $1 AND "status" = $2',
            txRow.txHash, 'COMPLETED'
        );
        expect(attempts[0].n).toBe(1);
    });

    test('G2. the same payout later answers FAILED: reversed EXACTLY once (balance restored once, terminal state idempotent)', async () => {
        const user = await seedUser(prisma, { availableBalance: START_USDC });
        const provider = acceptingMoolreProvider();
        const { app, res } = makeHarness(provider);

        const response = await runWithdrawal(user, { app, res });
        expect(response.statusCode).toBe(200);

        const txRow = await prisma.transactionHistory.findFirst({
            where: { userId: user.id, type: 'WITHDRAWAL_FIAT' },
            orderBy: { id: 'desc' },
        });
        const wRow = await prisma.withdrawal.findFirst({ where: { userId: user.id } });
        expect(txRow.metadata.payoutProvider).toBe('moolre'); // ownership write succeeded

        // Provider async failure.
        mockMoolreStatus(2); // txstatus 2 = failed
        const recon = new WithdrawalReconciliationWorker(prisma, null, failover);
        await recon._reconcileOne(await loadWithdrawal(wRow.id));

        // Reversed: user balance restored (amount + exit fee).
        const u = await freshUser(user.id);
        expect(Number(u.availableBalance)).toBeCloseTo(START_USDC, 6);
        const txAfter = await prisma.transactionHistory.findUnique({ where: { id: txRow.id }, select: { status: true } });
        expect(txAfter.status).toBe('FAILED');
        const wAfter = await prisma.withdrawal.findUnique({ where: { id: wRow.id } });
        expect(wAfter.status).toBe('FAILED');

        // Re-reconcile: the reversal is idempotent — balance restored ONCE.
        mockMoolreStatus(2);
        await recon._reconcileOne(await loadWithdrawal(wRow.id));
        const u2 = await freshUser(user.id);
        expect(Number(u2.availableBalance)).toBeCloseTo(START_USDC, 6);
        const failedAttempts = await prisma.$queryRawUnsafe(
            'SELECT COUNT(*)::int AS n FROM "ProviderSettlementAttempt" WHERE "providerReference" = $1 AND "status" = $2',
            txRow.txHash, 'FAILED'
        );
        expect(failedAttempts[0].n).toBe(1);
    });

    test('H. the reconciliation record cannot be established: the reservation is rolled back BEFORE any provider I/O (no debit, no dispatch, no ledger row)', async () => {
        const user = await seedUser(prisma, { availableBalance: START_USDC });
        const provider = acceptingMoolreProvider();
        const { app, res } = makeHarness(provider);

        // Make the Withdrawal record unwritable: the table cannot accept the
        // reconciliation insert inside the reservation transaction.
        await prisma.$executeRawUnsafe('ALTER TABLE "Withdrawal" RENAME TO "Withdrawal_r15l_hidden"');
        try {
            const response = await runWithdrawal(user, { app, res });
            expect(response.statusCode).toBe(503);
            expect(response.body.success).toBe(false);
            expect(response.body.code).toBe('WITHDRAWAL_RECORD_CREATION_FAILED');

            // The provider was NEVER instructed — money never left.
            expect(provider._dispatchCalls).toBe(0);

            // The reservation transaction rolled back: user not debited.
            const u = await freshUser(user.id);
            expect(Number(u.availableBalance)).toBeCloseTo(START_USDC, 6);

            // No canonical ledger row exists.
            const txRows = await prisma.transactionHistory.findMany({
                where: { userId: user.id, type: 'WITHDRAWAL_FIAT' }
            });
            expect(txRows).toHaveLength(0);
        } finally {
            await prisma.$executeRawUnsafe('ALTER TABLE "Withdrawal_r15l_hidden" RENAME TO "Withdrawal"');
        }
    });

    test('I. the provider accepts but carries NO identity: fail-closed 503, no evidence under an invented rail, reconciliation never guesses', async () => {
        const user = await seedUser(prisma, { availableBalance: START_USDC });
        const provider = {
            name: 'r15l-identityless-provider',
            _dispatchCalls: 0,
            newReferenceId: () => 'r15l-prov-ref',
            async initiateTransfer() {
                this._dispatchCalls += 1;
                // Accepted — but self-identifies NOWHERE: no failover tag,
                // no provider field.
                return { status: 'PENDING', referenceId: 'r15l-prov-ref', data: { reference: 'PROV-2' } };
            },
            async getTransferStatus() { return { status: 'PENDING' }; },
        };
        const { app, res } = makeHarness(provider);

        const response = await runWithdrawal(user, { app, res });
        expect(response.statusCode).toBe(503);
        expect(response.body.success).toBe(false);

        // The dispatch DID happen (provider called once) and the user was NOT
        // refunded — the payout is in flight.
        expect(provider._dispatchCalls).toBe(1);
        const u = await freshUser(user.id);
        expect(Number(u.availableBalance)).toBeCloseTo(START_USDC - WITHDRAWAL - EXIT_FEE, 6);

        // The reconciliation record and canonical row exist (tracked).
        const txRow = await prisma.transactionHistory.findFirst({
            where: { userId: user.id, type: 'WITHDRAWAL_FIAT' },
            orderBy: { id: 'desc' },
        });
        expect(txRow.status).toBe('PENDING');
        const wRow = await prisma.withdrawal.findFirst({ where: { userId: user.id } });
        expect(wRow.status).toBe('PENDING');
        expect(wRow.transactionHistoryId).toBe(txRow.id);

        // NO dispatch evidence exists — no rail identity was invented.
        const evidence = await prisma.fiatProviderEvent.findFirst({
            where: { dedupKey: { startsWith: 'event:payout-dispatch:' } }
        });
        expect(evidence).toBeNull();

        // The durable fail-closed exception exists.
        const exc = await prisma.$queryRawUnsafe(
            'SELECT "reason" FROM "ReconciliationException" WHERE "reference" = $1',
            txRow.txHash
        );
        expect(exc.map(e => e.reason)).toContain('DISPATCH_IDENTITY_UNKNOWN');

        // ── Reconciliation: the guard parks it — ZERO rail calls. ──
        const recon = new WithdrawalReconciliationWorker(prisma, null, failover);
        await recon._reconcileOne(await loadWithdrawal(wRow.id));
        expect(axiosPostSpy).not.toHaveBeenCalled();
        expect(axiosGetSpy).not.toHaveBeenCalled();

        const excAfter = await prisma.$queryRawUnsafe(
            'SELECT "reason" FROM "ReconciliationException" WHERE "reference" = $1',
            txRow.txHash
        );
        expect(excAfter.map(e => e.reason)).toContain('DISPATCHED_OWNERSHIP_NOT_DURABLE');

        const wAfter = await prisma.withdrawal.findUnique({ where: { id: wRow.id } });
        expect(wAfter.status).toBe('PENDING');
    });
});
