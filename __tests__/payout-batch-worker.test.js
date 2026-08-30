const PayoutBatchWorker = require('../workers/payoutBatchWorker');

describe('PayoutBatchWorker canonical withdrawal transaction', () => {
    const settings = {
        autoPayoutEnabled: true,
        autoPayoutMaxAmountUsdc: 200,
        autoPayoutThresholdUsdc: 500,
        autoPayoutIntervalMs: 120000,
    };

    test('atomically claims before dispatching with the existing canonical transaction reference', async () => {
        const initiateTransfer = jest.fn().mockResolvedValue({ status: 'ACCEPTED' });
        const withdrawalUpdate = jest.fn().mockResolvedValue({});
        const withdrawalUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
        const txCreate = jest.fn();
        const txFindMany = jest.fn().mockResolvedValue([{
            id: 'tx-1',
            txHash: 'canonical-ref-1',
            status: 'PENDING',
            userId: 7,
            amountUsdc: 50,
        }]);
        const prisma = {
            globalSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
            systemFiatPool: { findUnique: jest.fn().mockResolvedValue({ balance: 1000 }) },
            withdrawal: {
                findMany: jest.fn().mockResolvedValue([{
                    id: 91,
                    userId: 7,
                    amount: 50,
                    destination: '0240000000',
                    payoutMethod: 'MTN_MOMO',
                    createdAt: new Date('2026-08-30T10:00:00.000Z'),
                }]),
                update: withdrawalUpdate,
                updateMany: withdrawalUpdateMany,
            },
            transactionHistory: {
                findMany: txFindMany,
                findUnique: jest.fn(),
                create: txCreate,
            },
        };
        const worker = new PayoutBatchWorker(prisma, null, { initiateTransfer }, null);

        const result = await worker._processBatch(settings, { isManualTrigger: true });

        expect(result.processed).toBe(1);
        expect(withdrawalUpdateMany).toHaveBeenCalledWith({
            where: { id: 91, status: 'PENDING' },
            data: { status: 'PROCESSING' },
        });
        expect(initiateTransfer).toHaveBeenCalledWith(expect.objectContaining({
            referenceId: 'canonical-ref-1',
            externalId: 'auto_payout_91',
        }));
        expect(withdrawalUpdate).not.toHaveBeenCalled();
        expect(txCreate).not.toHaveBeenCalled();
    });

    test('refuses auto-dispatch when another worker has already claimed the withdrawal', async () => {
        const initiateTransfer = jest.fn();
        const prisma = {
            globalSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
            systemFiatPool: { findUnique: jest.fn().mockResolvedValue({ balance: 1000 }) },
            withdrawal: {
                findMany: jest.fn().mockResolvedValue([{
                    id: 93,
                    userId: 7,
                    amount: 50,
                    destination: '0240000000',
                    payoutMethod: 'MTN_MOMO',
                    createdAt: new Date('2026-08-30T10:00:00.000Z'),
                }]),
                update: jest.fn(),
                updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            },
            transactionHistory: {
                findMany: jest.fn().mockResolvedValue([{
                    id: 'tx-3', txHash: 'ref-3', status: 'PENDING', amountUsdc: 50
                }]),
                findUnique: jest.fn(),
            },
        };
        const worker = new PayoutBatchWorker(prisma, null, { initiateTransfer }, null);

        const result = await worker._processBatch(settings, { isManualTrigger: true });

        expect(result.processed).toBe(0);
        expect(result.flagged).toBe(0);
        expect(result.details.errors).toEqual([
            { id: 93, reason: 'WITHDRAWAL_ALREADY_CLAIMED' }
        ]);
        expect(initiateTransfer).not.toHaveBeenCalled();
    });

    test('refuses auto-dispatch when canonical transaction correlation is ambiguous', async () => {
        const initiateTransfer = jest.fn();
        const prisma = {
            globalSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
            systemFiatPool: { findUnique: jest.fn().mockResolvedValue({ balance: 1000 }) },
            withdrawal: {
                findMany: jest.fn().mockResolvedValue([{
                    id: 92,
                    userId: 7,
                    amount: 50,
                    destination: '0240000000',
                    payoutMethod: 'MTN_MOMO',
                    createdAt: new Date('2026-08-30T10:00:00.000Z'),
                }]),
                update: jest.fn().mockResolvedValue({}),
                updateMany: jest.fn(),
            },
            transactionHistory: {
                findMany: jest.fn().mockResolvedValue([
                    { id: 'tx-1', txHash: 'ref-1', status: 'PENDING', amountUsdc: 50 },
                    { id: 'tx-2', txHash: 'ref-2', status: 'PENDING', amountUsdc: 50 },
                ]),
                findUnique: jest.fn(),
            },
        };
        const worker = new PayoutBatchWorker(prisma, null, { initiateTransfer }, null);

        const result = await worker._processBatch(settings, { isManualTrigger: true });

        expect(result.processed).toBe(0);
        expect(result.flagged).toBe(1);
        expect(initiateTransfer).not.toHaveBeenCalled();
        expect(prisma.withdrawal.update).toHaveBeenCalledWith({
            where: { id: 92 },
            data: { status: 'NEEDS_MANUAL_REVIEW' },
        });
    });
});
