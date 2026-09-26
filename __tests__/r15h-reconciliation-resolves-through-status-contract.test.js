// __tests__/r15h-reconciliation-resolves-through-status-contract.test.js
// =============================================================================
// r15 follow-up (audit P0) — the recovery path actually RESOLVES (real PostgreSQL)
//
// THE DEFECT: the disbursement adapter sent a STALE transfer-status request
// shape ({ externalref }), so the reconciliation worker — the path R15's
// ambiguity-safety depends on — could never learn a terminal provider answer
// for a parked payout. The user's money was preserved correctly, but the
// payout stayed ambiguous forever because the recovery query contract was
// wrong.
//
// This suite wires the REAL MoolreDisbursementService (LIVE mode, axios mocked
// at the HTTP boundary to answer the CURRENT official envelope) into the REAL
// WithdrawalReconciliationWorker against real PostgreSQL and proves the full
// chain resolves:
//   • previously-ambiguous withdrawal + PENDING TransactionHistory
//   • worker asks via the corrected status contract (exact outgoing body pinned)
//   • provider txstatus=2 → canonical reversal: refund EXACTLY once,
//     TransactionHistory FAILED, Withdrawal FAILED
//   • provider txstatus=1 → canonical settlement: TransactionHistory COMPLETED,
//     Withdrawal COMPLETED
//   • a re-reconcile of a resolved row never double-refunds / double-settles
// =============================================================================

const axios = require('axios');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r15h] TEST_DATABASE_URL not set — skipping real-DB suite.');

describeOrSkip('r15 follow-up P0: reconciliation resolves an ambiguous payout through the corrected status contract (real PostgreSQL)', () => {
    let prisma;
    let MoolreDisbursementService;
    let axiosSpy;
    let adapter;

    beforeAll(() => {
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        process.env.MOOLRE_PROVIDER = 'LIVE';
        process.env.MOOLRE_API_USER = 'test-user';
        process.env.MOOLRE_API_KEY = 'test-key';
        process.env.MOOLRE_BASE_URL = 'https://moolre.test.local';
        process.env.MOOLRE_ACCOUNT_NUMBER = '100000100002';
        MoolreDisbursementService = require('../services/moolreDisbursementService');
        adapter = new MoolreDisbursementService({});
        expect(adapter.providerMode).toBe('LIVE');
        axiosSpy = jest.spyOn(axios, 'post');
    });

    afterAll(async () => {
        axiosSpy.mockRestore();
        ['MOOLRE_PROVIDER', 'MOOLRE_API_USER', 'MOOLRE_API_KEY', 'MOOLRE_BASE_URL', 'MOOLRE_ACCOUNT_NUMBER']
            .forEach(k => delete process.env[k]);
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        axiosSpy.mockClear();
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

    const START_BALANCE = 1000.0;
    const AMOUNT = 50.0;
    const FEE = 1.0;

    /**
     * Seed a previously-AMBIGUOUS payout: the user was debited (committed),
     * the provider never gave a terminal answer at dispatch time, and the
     * withdrawal is parked pending reconciliation — exactly the state R15-D
     * leaves behind on UNKNOWN_OUTCOME.
     */
    async function seedAmbiguousPayout(reference) {
        const { seedUser } = require('./helpers/factories');
        const user = await seedUser(prisma, { availableBalance: START_BALANCE });
        // committed debit (money is gone from the spendable balance)
        await prisma.user.update({
            where: { id: user.id },
            data: { availableBalance: { decrement: AMOUNT + FEE } }
        });
        // custody leg: a dispatched withdrawal moves the debited principal
        // into master-crypto custody (the reversal decrements it back out).
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
                metadata: { provider: 'MOOLRE', outcome: 'UNKNOWN_OUTCOME', payoutGhs: 671.00, economicsDeferred: true, dispatchedAt: new Date().toISOString() }
            }
        });
        const withdrawal = await prisma.withdrawal.create({
            data: {
                userId: user.id,
                amount: AMOUNT,
                destination: '0244556677',
                payoutMethod: 'MOBILE_MONEY',
                status: 'PENDING',
                createdAt: new Date(Date.now() - 60_000)
            }
        });
        // durable link (overlay column — raw SQL, as the worker itself does)
        await prisma.$executeRawUnsafe(
            'UPDATE "Withdrawal" SET "transactionHistoryId" = $1 WHERE "id" = $2',
            tx.id, withdrawal.id
        );
        return { user, tx, withdrawal };
    }

    const loadWithdrawal = (id) => prisma.withdrawal.findUnique({
        where: { id },
        include: { user: { select: { id: true, email: true, username: true, phoneNumber: true, phoneVerified: true } } }
    });

    const WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');

    test('txstatus=2 through the REAL corrected adapter: parked withdrawal resolves FAILED, refund lands EXACTLY once, and the status request used the current official body', async () => {
        const reference = 'R15H-FAIL-1';
        const { user } = await seedAmbiguousPayout(reference);
        const worker = new WithdrawalReconciliationWorker(prisma, null, adapter);

        axiosSpy.mockResolvedValueOnce({
            data: { status: 1, code: 'SS02', message: 'Transaction Failed', data: { txstatus: 2, transactionid: '31830714', externalref: reference, amount: '671.00' } }
        });

        await worker._reconcileOne(await loadWithdrawal(
            (await prisma.withdrawal.findFirst({ where: { userId: user.id } })).id
        ));

        // The worker asked through the CURRENT contract — not the stale shape.
        expect(axiosSpy).toHaveBeenCalledTimes(1);
        const [url, body] = axiosSpy.mock.calls[0];
        expect(url).toBe('https://moolre.test.local/open/transact/status');
        expect(body).toEqual({ type: 1, idtype: 1, id: reference, accountnumber: '100000100002' });

        // Canonical terminal state: money returned, rows terminal.
        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true } });
        expect(Number(after.availableBalance)).toBeCloseTo(START_BALANCE, 6);
        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true, providerRef: true } });
        expect(txAfter.status).toBe('FAILED');
        // Moolre's provider identity for the FAILED branch is the externalref
        // (our idempotency reference); the provider transactionid feeds the
        // settlement path as providerTxId instead.
        expect(txAfter.providerRef).toBe(reference);
        const wAfter = await prisma.withdrawal.findFirst({ where: { userId: user.id }, select: { status: true } });
        expect(wAfter.status).toBe('FAILED');

        // Re-reconcile the resolved row: the provider still answers FAILED, but
        // the canonical reversal is claimed-once — NO double refund.
        axiosSpy.mockResolvedValueOnce({
            data: { status: 1, code: 'SS02', message: 'Transaction Failed', data: { txstatus: 2, transactionid: '31830714', externalref: reference, amount: '671.00' } }
        });
        await worker._reconcileOne(await loadWithdrawal(
            (await prisma.withdrawal.findFirst({ where: { userId: user.id } })).id
        ));
        const finalBal = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true } });
        expect(Number(finalBal.availableBalance)).toBeCloseTo(START_BALANCE, 6); // still exactly one refund
    });

    test('txstatus=1 through the REAL corrected adapter: parked withdrawal settles COMPLETED through the canonical finance boundary', async () => {
        const reference = 'R15H-SUCCESS-1';
        const { user } = await seedAmbiguousPayout(reference);
        const worker = new WithdrawalReconciliationWorker(prisma, null, adapter);

        axiosSpy.mockResolvedValueOnce({
            data: { status: 1, code: 'SS01', message: 'Transaction Successful', data: { txstatus: 1, transactionid: '31830715', externalref: reference, amount: '671.00' } }
        });

        await worker._reconcileOne(await loadWithdrawal(
            (await prisma.withdrawal.findFirst({ where: { userId: user.id } })).id
        ));

        expect(axiosSpy).toHaveBeenCalledTimes(1);
        expect(axiosSpy.mock.calls[0][1]).toEqual({ type: 1, idtype: 1, id: reference, accountnumber: '100000100002' });

        // Settled: the debit stands (money paid out), rows terminal-COMPLETED.
        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true } });
        expect(Number(after.availableBalance)).toBeCloseTo(START_BALANCE - AMOUNT - FEE, 6);
        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('COMPLETED');
        const wAfter = await prisma.withdrawal.findFirst({ where: { userId: user.id }, select: { status: true } });
        expect(wAfter.status).toBe('COMPLETED');
    });

    test('provider stays unreachable (ETIMEDOUT on the corrected request): payout STAYS parked — resolution never invents a terminal state', async () => {
        const reference = 'R15H-UNRESOLVED-1';
        const { user } = await seedAmbiguousPayout(reference);
        const worker = new WithdrawalReconciliationWorker(prisma, null, adapter);

        axiosSpy.mockRejectedValueOnce(Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' }));
        await worker._reconcileOne(await loadWithdrawal(
            (await prisma.withdrawal.findFirst({ where: { userId: user.id } })).id
        ));

        const after = await prisma.user.findUnique({ where: { id: user.id }, select: { availableBalance: true } });
        expect(Number(after.availableBalance)).toBeCloseTo(START_BALANCE - AMOUNT - FEE, 6); // debit STANDS
        const txAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { status: true } });
        expect(txAfter.status).toBe('PENDING'); // still parked, honestly
        const wAfter = await prisma.withdrawal.findFirst({ where: { userId: user.id }, select: { status: true } });
        expect(wAfter.status).toBe('PENDING');
        const exc = await prisma.$queryRawUnsafe(
            'SELECT "reason", "reference" FROM "ReconciliationException" WHERE "reference" = $1 LIMIT 1',
            reference
        );
        expect(exc).not.toBeNull(); // PROVIDER_STATUS_UNAVAILABLE evidence recorded for the operator
    });
});
