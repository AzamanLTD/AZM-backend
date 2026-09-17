// __tests__/withdrawal-reconciliation-terminal-claim.test.js
// =============================================================================
// Concurrent reconciliation regression — the same stale withdrawal can be
// observed by multiple scheduler instances. Financial reversal/settlement is
// already idempotent; this suite proves the outer Withdrawal terminal claim
// and terminal realtime/admin effects are also single-winner.
// =============================================================================
const { PrismaClient } = require('@prisma/client');
const { installPayoutReconciliationInfra } = require('../infra/install-payout-reconciliation-infra');
const WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[withdrawal-reconciliation-terminal-claim] TEST_DATABASE_URL not set — skipping real-DB suite.');

describeOrSkip('withdrawal reconciliation terminal claim (real PostgreSQL)', () => {
    let prisma;

    beforeAll(async () => {
        prisma = new PrismaClient();
        const result = await installPayoutReconciliationInfra(prisma);
        if (result.failed) throw new Error(`reconciliation infra install failed: ${result.errors.join('; ')}`);
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    // The battery shares one database and may run twice (CI retry pass);
    // other suites leak system-ledger rows. Clean before AND after each test.
    const cleanupSharedTables = async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "Withdrawal", "TransactionHistory", "SystemFiatPool", "SystemMasterCrypto", "SystemProfitFees", "AdminProfitLog", "GlobalSettings", "ProviderSettlementAttempt", "ReconciliationException" RESTART IDENTITY CASCADE'
        );
    };

    beforeEach(cleanupSharedTables);
    afterEach(cleanupSharedTables);

    const makeIo = () => {
        const emitted = [];
        return {
            emitted,
            to: jest.fn(() => ({
                emit: jest.fn((event, payload) => emitted.push({ scope: 'user', event, payload }))
            })),
            emit: jest.fn((event, payload) => emitted.push({ scope: 'global', event, payload }))
        };
    };

    const seed = async ({ amount = 50, fee = 1 } = {}) => {
        const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        const createdAt = new Date(Date.now() - 60_000);
        const user = await prisma.user.create({
            data: {
                username: `recon_${suffix}`,
                email: `recon_${suffix}@test.com`,
                password: 'x',
                azamanId: `AZM-R-${suffix}`,
                availableBalance: 100,
            }
        });

        await prisma.systemFiatPool.create({ data: { id: 1, balance: 1_000 } });
        await prisma.systemMasterCrypto.create({ data: { id: 1, balance: amount } });
        // Legacy (non-deferred) rows recognized the exit fee at creation time;
        // mirror that booking so the FAILED-path reversal unwinds real profit
        // instead of driving SystemProfitFees negative (blocked by
        // SystemProfitFees_balance_nonneg — the CHECK is correct app semantics).
        await prisma.systemProfitFees.create({ data: { id: 1, balance: fee } });
        await prisma.adminProfitLog.create({
            data: { amountUsdc: fee, source: 'EXIT_FEE', relatedTxId: `full_fee_RECON_${suffix}` }
        });
        const tx = await prisma.transactionHistory.create({
            data: {
                userId: user.id,
                type: 'WITHDRAWAL_FIAT',
                amountUsdc: amount,
                feeUsdc: fee,
                status: 'PENDING',
                txHash: `RECON_${suffix}`,
                createdAt,
            }
        });
        const withdrawal = await prisma.withdrawal.create({
            data: {
                userId: user.id,
                amount,
                payoutMethod: 'MTN_MOMO',
                network: 'MTN',
                destination: '0240000000',
                status: 'PROCESSING',
                createdAt,
            }
        });

        await prisma.$executeRawUnsafe(
            'UPDATE "Withdrawal" SET "transactionHistoryId" = $1 WHERE "id" = $2',
            tx.id,
            withdrawal.id
        );
        return { user, tx, withdrawal };
    };

    test('concurrent SUCCESS polls produce exactly one terminal realtime/notification winner', async () => {
        const { user, tx, withdrawal } = await seed();
        const provider = {
            getTransferStatus: jest.fn().mockResolvedValue({
                status: 'SUCCESSFUL',
                providerRef: 'MTN-SUCCESS-1',
                provider: 'MTN_MOMO_DISBURSEMENT'
            })
        };
        const ioA = makeIo();
        const ioB = makeIo();
        const emailA = { sendWithdrawalReceipt: jest.fn().mockResolvedValue(undefined) };
        const emailB = { sendWithdrawalReceipt: jest.fn().mockResolvedValue(undefined) };
        const a = new WithdrawalReconciliationWorker(prisma, ioA, provider, emailA, null);
        const b = new WithdrawalReconciliationWorker(prisma, ioB, provider, emailB, null);

        // The worker reads withdrawal.user?.email for the receipt; the bare
        // prisma row carries no relation, so attach the seeded user.
        const withdrawalWithUser = { ...withdrawal, user };
        await Promise.all([a._reconcileOne(withdrawalWithUser), b._reconcileOne(withdrawalWithUser)]);

        // Receipts are dispatched via setImmediate — flush the immediate
        // queue before counting them.
        await new Promise((resolve) => setImmediate(resolve));

        const currentWithdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        const currentTx = await prisma.transactionHistory.findUnique({ where: { id: tx.id } });
        expect(currentWithdrawal.status).toBe('COMPLETED');
        expect(currentTx.status).toBe('COMPLETED');
        expect(currentTx.providerRef).toBe('MTN-SUCCESS-1');

        const userSettlements = [ioA, ioB].flatMap((io) => io.emitted)
            .filter((entry) => entry.scope === 'user' && entry.event === 'withdrawal_settled');
        expect(userSettlements).toHaveLength(1);
        expect(emailA.sendWithdrawalReceipt.mock.calls.length + emailB.sendWithdrawalReceipt.mock.calls.length).toBe(1);
    });

    test('concurrent FAILED polls produce exactly one refund notification with a defined refund amount', async () => {
        const { tx, withdrawal } = await seed({ amount: 50, fee: 1 });
        const provider = {
            getTransferStatus: jest.fn().mockResolvedValue({
                status: 'FAILED',
                providerRef: 'MTN-FAILED-1',
                provider: 'MTN_MOMO_DISBURSEMENT',
                reason: 'INVALID_MSISDN'
            })
        };
        const ioA = makeIo();
        const ioB = makeIo();
        const a = new WithdrawalReconciliationWorker(prisma, ioA, provider, null, null);
        const b = new WithdrawalReconciliationWorker(prisma, ioB, provider, null, null);

        await Promise.all([a._reconcileOne(withdrawal), b._reconcileOne(withdrawal)]);

        const currentWithdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        const currentTx = await prisma.transactionHistory.findUnique({ where: { id: tx.id } });
        const currentUser = await prisma.user.findUnique({ where: { id: withdrawal.userId } });
        expect(currentWithdrawal.status).toBe('FAILED');
        expect(currentTx.status).toBe('FAILED');
        expect(Number(currentUser.availableBalance)).toBeCloseTo(151, 6);

        const all = [ioA, ioB].flatMap((io) => io.emitted);
        const userSettlements = all.filter((entry) => entry.scope === 'user' && entry.event === 'withdrawal_settled');
        expect(userSettlements).toHaveLength(1);
        expect(userSettlements[0].payload).toMatchObject({
            status: 'FAILED',
            refunded: 51,
            reference: tx.txHash
        });

        const adminAlerts = all.filter((entry) => entry.scope === 'global' && entry.event === 'admin_alert');
        expect(adminAlerts).toHaveLength(1);
    });
});
