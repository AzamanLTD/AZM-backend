// Unit regression for the Moolre deposit reconciliation scan.
// No database or provider access: verify the Prisma query uses fields that
// exist on the authoritative TransactionHistory Prisma model.

jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/moolreCollectionRecoveryService', () => ({
    resolvePendingDeposit: jest.fn().mockResolvedValue({ outcome: 'STILL_PENDING' }),
}));

const { resolvePendingDeposit } = require('../src/services/moolreCollectionRecoveryService');
const DepositReconciliationWorker = require('../workers/depositReconciliationWorker');

describe('DepositReconciliationWorker stale pending scan', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    test('uses TransactionHistory.createdAt to find stale Moolre deposits (not nonexistent updatedAt)', async () => {
        const fixedNow = new Date('2026-10-11T12:00:00.000Z').getTime();
        jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

        const row = { id: 'tx-1', txHash: 'moolre-ref-1' };
        const prisma = {
            transactionHistory: {
                findMany: jest.fn().mockResolvedValue([row]),
            },
        };
        const moolre = {};
        const worker = new DepositReconciliationWorker(prisma, moolre, null);

        await worker._tick();

        expect(prisma.transactionHistory.findMany).toHaveBeenCalledTimes(1);
        const query = prisma.transactionHistory.findMany.mock.calls[0][0];
        expect(query.where).toMatchObject({
            type: 'DEPOSIT_FIAT',
            status: 'PENDING',
            createdAt: { lt: new Date(fixedNow - 60_000) },
            metadata: { path: ['selectedRoute'], equals: 'MOOLRE_MOMO_COLLECTION' },
        });
        expect(query.where).not.toHaveProperty('updatedAt');
        expect(query.select).toEqual({ id: true, txHash: true });
        expect(query.orderBy).toEqual({ createdAt: 'asc' });
        expect(query.take).toBe(50);
        expect(resolvePendingDeposit).toHaveBeenCalledWith({
            prisma,
            moolre,
            transactionHistoryId: row.id,
        });
    });

    test('does not overlap concurrent ticks', async () => {
        let resolveScan;
        const prisma = {
            transactionHistory: {
                findMany: jest.fn(() => new Promise((resolve) => { resolveScan = resolve; })),
            },
        };
        const worker = new DepositReconciliationWorker(prisma, {}, null);

        const first = worker._tick();
        await Promise.resolve();
        await worker._tick();
        expect(prisma.transactionHistory.findMany).toHaveBeenCalledTimes(1);

        resolveScan([]);
        await first;
        expect(worker._running).toBe(false);
    });
});
