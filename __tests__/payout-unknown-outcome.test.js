// __tests__/payout-unknown-outcome.test.js
// =============================================================================
// P0 payout regression — persisted provider-outcome state machine, proven
// against real PostgreSQL (gated on TEST_DATABASE_URL).
//
// Pre-fix defect: payoutBatchWorker converted EVERY provider initiation
// exception into NEEDS_MANUAL_REVIEW after the PENDING -> PROCESSING claim,
// even though the request may already have reached MTN (client timeout after
// transmission, connection reset, 5xx gateway response). That removed the
// withdrawal from normal reconciliation and could strand an ambiguous live
// payout.
//
// Post-fix invariants proven here (DB rows, not mock calls):
//   A. Successful payout: PENDING -> PROCESSING -> reconciliation settles
//      SUCCESSFUL -> withdrawal + TransactionHistory COMPLETED.
//   B. UNKNOWN provider outcome: the withdrawal was already claimed
//      PROCESSING; the worker does NOT move it to NEEDS_MANUAL_REVIEW; it
//      stays PROCESSING in the DB (durable, reconcilable); the batch summary
//      reports it as unknown-outcome and emits an observability alert.
//   C. Crash-equivalent recovery: reconciliation with an unreachable provider
//      keeps the withdrawal PROCESSING and records a ReconciliationException;
//      once the provider answers SUCCESSFUL, the SAME durable state settles.
//   D. DEFINITIVE provider rejection: explicit refusal still lands in
//      NEEDS_MANUAL_REVIEW (existing behavior preserved).
//   E. Replay/idempotency: re-running the batch does not re-dispatch — the
//      PROCESSING claim removes the row from the PENDING scan.
//   F. Canonical transaction bridge: dispatch uses the fallback-resolved
//      TransactionHistory.txHash as the provider referenceId; the reconcile
//      path settles that exact row.
// =============================================================================
const { PrismaClient } = require('@prisma/client');
const PayoutBatchWorker = require('../workers/payoutBatchWorker');
const WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[payout-unknown-outcome] TEST_DATABASE_URL not set — skipping real-DB suite.');

const AMOUNT = 50;
const REF = `PAYOUT_REF_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

describeOrSkip('payout provider unknown-outcome (real PostgreSQL)', () => {
    let prisma;

    beforeAll(() => { prisma = new PrismaClient(); });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "Withdrawal", "TransactionHistory", "GlobalSettings", "SystemFiatPool", "ProviderSettlementAttempt", "ReconciliationException" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    // ── seeds ────────────────────────────────────────────────────────────────
    const seedScenario = async () => {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: {
                autoPayoutEnabled: true, autoPayoutMaxAmountUsdc: 200,
                autoPayoutThresholdUsdc: 500, liveRetailRate: 13.0
            },
            create: { id: 1, liveRetailRate: 13.0, autoPayoutEnabled: true, autoPayoutMaxAmountUsdc: 200, autoPayoutThresholdUsdc: 500 }
        });
        await prisma.systemFiatPool.upsert({
            where: { id: 1 },
            update: { balance: 100_000.0 },
            create: { id: 1, balance: 100_000.0 }
        });
        const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        const user = await prisma.user.create({
            data: {
                username: `wd_${suffix}`,
                email: `wd_${suffix}@test.com`,
                password: 'x',
                azamanId: `AZM-W-${suffix}`,
                availableBalance: 0
            }
        });
        // Backdated so the reconciliation worker's 30s staleness gate includes it.
        const createdAt = new Date(Date.now() - 60_000);
        const tx = await prisma.transactionHistory.create({
            data: {
                userId: user.id,
                type: 'WITHDRAWAL_FIAT',
                amountUsdc: AMOUNT,
                feeUsdc: 0,
                status: 'PENDING',
                txHash: REF,
                createdAt
            }
        });
        const withdrawal = await prisma.withdrawal.create({
            data: {
                userId: user.id,
                amount: AMOUNT,
                payoutMethod: 'MTN_MOMO',
                network: 'MTN',
                destination: '0240000000',
                status: 'PENDING',
                createdAt
            }
        });
        return { user, tx, withdrawal };
    };

    const withdrawalStatus = (id) =>
        prisma.withdrawal.findUnique({ where: { id } }).then((w) => w && w.status);

    const makeIo = () => ({ emit: jest.fn(), to: jest.fn().mockReturnThis() });

    // ── A + E + F: success, replay, canonical reference ────────────────────────
    test('A/E/F. dispatch claims PROCESSING, settles via reconciliation, replay never re-dispatches', async () => {
        const { withdrawal, tx } = await seedScenario();
        const initiateTransfer = jest.fn().mockResolvedValue({ status: 'PENDING', referenceId: REF });
        const io = makeIo();
        const worker = new PayoutBatchWorker(prisma, io, { initiateTransfer }, null);

        const summary = await worker.processNow({ force: true });
        expect(summary.processed).toBe(1);
        // F. canonical fallback reference was used for dispatch
        expect(initiateTransfer).toHaveBeenCalledWith(expect.objectContaining({ referenceId: REF }));
        // claim persisted
        expect(await withdrawalStatus(withdrawal.id)).toBe('PROCESSING');

        // E. replay: the PROCESSING claim removes it from the PENDING scan
        const replay = await worker.processNow({ force: true });
        expect(replay.processed).toBe(0);
        expect(initiateTransfer).toHaveBeenCalledTimes(1);
        expect(await withdrawalStatus(withdrawal.id)).toBe('PROCESSING');

        // A. reconciliation settles the durable state to the final COMPLETED state
        const getTransferStatus = jest.fn().mockResolvedValue({ status: 'SUCCESSFUL', providerRef: 'MTN-123' });
        const recon = new WithdrawalReconciliationWorker(prisma, makeIo(), { getTransferStatus }, null, null);
        await recon._tick();

        expect(await withdrawalStatus(withdrawal.id)).toBe('COMPLETED');
        const settledTx = await prisma.transactionHistory.findUnique({ where: { id: tx.id } });
        expect(settledTx.status).toBe('COMPLETED');
        expect(settledTx.providerRef).toBe('MTN-123');
    });

    // ── B: unknown outcome stays in the reconciliation pipeline ────────────────
    test('B. UNKNOWN provider exception keeps the withdrawal PROCESSING — never manual review', async () => {
        const { withdrawal } = await seedScenario();
        const dispatchErr = new Error('timeout of 15000ms exceeded');
        dispatchErr.providerOutcome = 'UNKNOWN_OUTCOME';
        const initiateTransfer = jest.fn().mockRejectedValue(dispatchErr);
        const io = makeIo();
        const notify = jest.fn().mockResolvedValue({});
        const worker = new PayoutBatchWorker(prisma, io, { initiateTransfer }, { sendNotification: notify });

        const summary = await worker.processNow({ force: true });

        // already claimed PROCESSING before dispatch
        expect(initiateTransfer).toHaveBeenCalledTimes(1);
        // NOT moved out of the reconciliation pipeline
        expect(await withdrawalStatus(withdrawal.id)).toBe('PROCESSING');
        expect(summary.flagged).toBe(0);
        expect(summary.unknownOutcome).toBe(1);
        expect(summary.details.unknownOutcome[0]).toMatchObject({
            id: withdrawal.id, reason: 'DISBURSEMENT_OUTCOME_UNKNOWN', providerOutcome: 'UNKNOWN_OUTCOME'
        });
        // observability alert emitted; the user is NOT told "under review"
        expect(io.emit).toHaveBeenCalledWith('admin_alert', expect.objectContaining({
            type: 'PAYOUTS_PENDING_PROVIDER_RECONCILIATION', count: 1
        }));
        expect(notify).not.toHaveBeenCalled();
    });

    // ── C: crash-equivalent durable recovery through reconciliation ───────────
    test('C. crash-equivalent: unreachable provider keeps it recoverable, then it settles', async () => {
        const { withdrawal, tx } = await seedScenario();
        const dispatchErr = new Error('socket hang up');
        dispatchErr.providerOutcome = 'UNKNOWN_OUTCOME';
        const worker = new PayoutBatchWorker(prisma, makeIo(), {
            initiateTransfer: jest.fn().mockRejectedValue(dispatchErr)
        }, null);
        await worker.processNow({ force: true });
        expect(await withdrawalStatus(withdrawal.id)).toBe('PROCESSING');

        // provider unreachable — reconciliation must NOT finalize anything
        const downRecon = new WithdrawalReconciliationWorker(prisma, makeIo(), {
            getTransferStatus: jest.fn().mockRejectedValue(new Error('status query failed'))
        }, null, null);
        await downRecon._tick();
        expect(await withdrawalStatus(withdrawal.id)).toBe('PROCESSING');
        const exceptions = await prisma.$queryRawUnsafe(
            'SELECT "reason", "status" FROM "ReconciliationException" WHERE "entityId" = $1',
            String(withdrawal.id)
        );
        expect(exceptions.some((e) => e.reason === 'PROVIDER_STATUS_UNAVAILABLE' && e.status === 'OPEN')).toBe(true);

        // provider answers — the SAME durable state settles
        const upRecon = new WithdrawalReconciliationWorker(prisma, makeIo(), {
            getTransferStatus: jest.fn().mockResolvedValue({ status: 'SUCCESSFUL', providerRef: 'MTN-456' })
        }, null, null);
        await upRecon._tick();
        expect(await withdrawalStatus(withdrawal.id)).toBe('COMPLETED');
        expect((await prisma.transactionHistory.findUnique({ where: { id: tx.id } })).status).toBe('COMPLETED');
    });

    // ── D: definitive rejection keeps the manual-review contract ───────────────
    test('D. DEFINITIVE provider rejection persists NEEDS_MANUAL_REVIEW', async () => {
        const { withdrawal } = await seedScenario();
        const dispatchErr = new Error('MTN transfer rejected: INVALID_MSISDN');
        dispatchErr.providerOutcome = 'DEFINITIVE_REJECTION';
        const notify = jest.fn().mockResolvedValue({});
        const worker = new PayoutBatchWorker(prisma, makeIo(), {
            initiateTransfer: jest.fn().mockRejectedValue(dispatchErr)
        }, { sendNotification: notify });

        const summary = await worker.processNow({ force: true });

        expect(await withdrawalStatus(withdrawal.id)).toBe('NEEDS_MANUAL_REVIEW');
        expect(summary.flagged).toBe(1);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'WITHDRAWAL_REVIEW' }));
    });
});
