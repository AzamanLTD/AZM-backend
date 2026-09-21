// __tests__/withdrawal-reconciliation-finance-settlement.test.js
// =============================================================================
// Provider-success accounting regression — reconciliation must use the
// canonical finance settlement boundary so deferred economics are realized.
// =============================================================================
const { PrismaClient } = require('@prisma/client');
const { installPayoutReconciliationInfra } = require('../infra/install-payout-reconciliation-infra');
const WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[withdrawal-reconciliation-finance-settlement] TEST_DATABASE_URL not set — skipping real-DB suite.');

describeOrSkip('withdrawal reconciliation finance settlement (real PostgreSQL)', () => {
    let prisma;

    beforeAll(async () => {
        prisma = new PrismaClient();
        const result = await installPayoutReconciliationInfra(prisma);
        if (result.failed) throw new Error(`reconciliation infra install failed: ${result.errors.join('; ')}`);
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    // The battery shares one database: earlier suites can leave system-ledger
    // rows behind (several never clean SystemProfitFees). Clean BEFORE each
    // test as well so the suite's seeds never depend on external state.
    const cleanupSharedTables = async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "Withdrawal", "TransactionHistory", "SystemFiatPool", "SystemMasterCrypto", "SystemProfitFees", "AdminProfitLog", "ProviderSettlementAttempt", "ReconciliationException" RESTART IDENTITY CASCADE'
        );
    };

    beforeEach(cleanupSharedTables);
    afterEach(cleanupSharedTables);

    const seed = async ({ transactionStatus = 'PENDING' } = {}) => {
        const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        const createdAt = new Date(Date.now() - 60_000);
        const user = await prisma.user.create({
            data: {
                username: `finrecon_${suffix}`,
                email: `finrecon_${suffix}@test.com`,
                password: 'x',
                azamanId: `AZM-FR-${suffix}`,
                availableBalance: 100,
            }
        });
        await prisma.systemFiatPool.create({ data: { id: 1, balance: 950 } });
        await prisma.systemMasterCrypto.create({ data: { id: 1, balance: 50 } });
        await prisma.systemProfitFees.create({ data: { id: 1, balance: 0 } });

        const tx = await prisma.transactionHistory.create({
            data: {
                userId: user.id,
                type: 'WITHDRAWAL_FIAT',
                amountUsdc: 50,
                feeUsdc: 1,
                status: transactionStatus,
                txHash: `FIN_RECON_${suffix}`,
                // r20: creation-time GHS payout economics — the durable
                // amount authority the settlement binding compares against.
                metadata: transactionStatus === 'PENDING'
                    ? {
                        economicsDeferred: true,
                        referrerId: null,
                        referrerShareUsdc: 0,
                        systemFeeShareUsdc: 1,
                        payoutGhs: 750,
                    }
                    : { payoutGhs: 750 },
                createdAt,
            }
        });
        const withdrawal = await prisma.withdrawal.create({
            data: {
                userId: user.id,
                amount: 50,
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
        return { tx, withdrawal };
    };

    const makeIo = () => ({
        to: jest.fn(() => ({ emit: jest.fn() })),
        emit: jest.fn()
    });

    test('provider success realizes deferred economics exactly once', async () => {
        const { tx, withdrawal } = await seed();
        const io = makeIo();
        const provider = {
            // r20: REAL adapter contract shape — the status answer echoes the
            // queried reference and reports the provider payout amount.
            getTransferStatus: jest.fn().mockImplementation(async (referenceId) => ({
                provider: 'MTN_MOMO_DISBURSEMENT',
                referenceId,
                externalId: referenceId,
                status: 'SUCCESSFUL',
                amountGhs: 750,
                reason: null,
                source: 'MOCK',
                providerRef: 'MTN-DEFERRED-1',
            }))
        };
        const worker = new WithdrawalReconciliationWorker(prisma, io, provider, null, null);

        await worker._reconcileOne(withdrawal);
        // Reconciliation replay must not duplicate realized economics.
        await worker._reconcileOne({ ...withdrawal, status: 'PROCESSING' });

        const currentWithdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        const currentTx = await prisma.transactionHistory.findUnique({ where: { id: tx.id } });
        const profitFees = await prisma.systemProfitFees.findUnique({ where: { id: 1 } });
        const logs = await prisma.adminProfitLog.findMany({
            where: { relatedTxId: { endsWith: tx.txHash } },
            orderBy: { createdAt: 'asc' }
        });

        expect(currentWithdrawal.status).toBe('COMPLETED');
        expect(currentTx.status).toBe('COMPLETED');
        expect(currentTx.providerRef).toBe('MTN-DEFERRED-1');
        expect(Number(profitFees.balance)).toBeCloseTo(1, 6);
        expect(logs).toHaveLength(2);
        expect(logs.filter((row) => row.source === 'EXIT_FEE')).toHaveLength(1);
        expect(logs.filter((row) => row.source === 'ARBITRAGE_SPREAD')).toHaveLength(1);
        expect(io.to.mock.results.filter(Boolean).length).toBe(1);
    });

    test('provider SUCCESS cannot overwrite a transaction already failed by a prior reconciliation', async () => {
        const { tx, withdrawal } = await seed({ transactionStatus: 'FAILED' });
        const io = makeIo();
        const provider = {
            getTransferStatus: jest.fn().mockImplementation(async (referenceId) => ({
                provider: 'MTN_MOMO_DISBURSEMENT',
                referenceId,
                externalId: referenceId,
                status: 'SUCCESSFUL',
                amountGhs: 750,
                reason: null,
                source: 'MOCK',
                providerRef: 'MTN-LATE-SUCCESS',
            }))
        };
        const worker = new WithdrawalReconciliationWorker(prisma, io, provider, null, null);

        await worker._reconcileOne(withdrawal);

        const currentWithdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(currentWithdrawal.status).toBe('PROCESSING');
        expect(io.to).not.toHaveBeenCalled();
        const exceptions = await prisma.$queryRawUnsafe(
            'SELECT "reason" FROM "ReconciliationException" WHERE "entityId" = $1',
            String(withdrawal.id)
        );
        expect(exceptions.some((row) => row.reason === 'FINANCIAL_SETTLEMENT_CONFLICT')).toBe(true);
    });
});
