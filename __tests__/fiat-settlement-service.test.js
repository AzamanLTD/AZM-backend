const { settleFiatWithdrawal } = require('../services/fiatSettlementService');
const financeService = require('../services/finance.service');

jest.mock('../services/finance.service', () => ({
    reverseFiatWithdrawal: jest.fn()
}));

describe('fiatSettlementService', () => {
    beforeEach(() => jest.clearAllMocks());

    const attemptDb = () => ({
        $queryRawUnsafe: jest.fn().mockResolvedValue([{
            id: 'attempt-1',
            transactionHistoryId: 'tx-1',
            provider: 'MTN_MOMO_DISBURSEMENT',
            providerReference: 'ref-1',
            status: 'PENDING'
        }]),
        $executeRawUnsafe: jest.fn().mockResolvedValue(1)
    });

    test('moves a PENDING withdrawal to COMPLETED and records provider reference atomically', async () => {
        const pending = {
            txHash: 'ref-1',
            userId: 11,
            type: 'WITHDRAWAL_FIAT',
            status: 'PENDING',
            providerRef: null
        };
        const completed = { ...pending, status: 'COMPLETED', providerRef: 'moolre-991' };
        const prisma = {
            ...attemptDb(),
            transactionHistory: {
                findUnique: jest.fn()
                    .mockResolvedValueOnce(pending)
                    .mockResolvedValueOnce(completed),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                update: jest.fn()
            }
        };

        const result = await settleFiatWithdrawal(prisma, {
            reference: 'ref-1',
            provider: 'MOOLRE',
            status: 'SUCCESSFUL',
            providerTxId: 'moolre-991'
        });

        expect(prisma.transactionHistory.updateMany).toHaveBeenCalledWith({
            where: { txHash: 'ref-1', status: 'PENDING' },
            data: { status: 'COMPLETED', providerRef: 'moolre-991' }
        });
        expect(result).toMatchObject({
            reference: 'ref-1',
            userId: 11,
            status: 'COMPLETED',
            changed: true,
            providerTxId: 'moolre-991'
        });
        expect(financeService.reverseFiatWithdrawal).not.toHaveBeenCalled();
    });

    test('does not resurrect a FAILED withdrawal on a late success callback', async () => {
        const failed = {
            txHash: 'ref-2',
            userId: 12,
            type: 'WITHDRAWAL_FIAT',
            status: 'FAILED',
            providerRef: null
        };
        const prisma = {
            ...attemptDb(),
            transactionHistory: {
                findUnique: jest.fn().mockResolvedValue(failed),
                updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                update: jest.fn()
            }
        };

        const result = await settleFiatWithdrawal(prisma, {
            reference: 'ref-2',
            provider: 'MOOLRE',
            status: 'SUCCESSFUL',
            providerTxId: 'late-success'
        });

        expect(result).toMatchObject({ status: 'FAILED', changed: false });
        expect(prisma.transactionHistory.update).not.toHaveBeenCalled();
        expect(financeService.reverseFiatWithdrawal).not.toHaveBeenCalled();
    });

    test('delegates a still-PENDING provider failure to the existing atomic reversal path and preserves provider reference', async () => {
        const pending = {
            txHash: 'ref-3',
            userId: 13,
            type: 'WITHDRAWAL_FIAT',
            status: 'PENDING',
            providerRef: null
        };
        const reversedWithoutProviderRef = { ...pending, status: 'FAILED', providerRef: null };
        const failedWithProviderRef = { ...pending, status: 'FAILED', providerRef: 'moolre-fail-3' };
        financeService.reverseFiatWithdrawal.mockResolvedValue({
            alreadyReversed: false,
            userId: 13,
            refundedAmount: 10
        });

        const prisma = {
            ...attemptDb(),
            transactionHistory: {
                findUnique: jest.fn()
                    .mockResolvedValueOnce(pending)
                    .mockResolvedValueOnce(reversedWithoutProviderRef),
                updateMany: jest.fn(),
                update: jest.fn().mockResolvedValue(failedWithProviderRef)
            }
        };

        const result = await settleFiatWithdrawal(prisma, {
            reference: 'ref-3',
            provider: 'MOOLRE',
            status: 'FAILED',
            providerTxId: 'moolre-fail-3',
            reason: 'provider rejected transfer'
        });

        expect(financeService.reverseFiatWithdrawal).toHaveBeenCalledWith(
            prisma,
            'ref-3',
            { reason: 'provider rejected transfer' }
        );
        expect(prisma.transactionHistory.update).toHaveBeenCalledWith({
            where: { txHash: 'ref-3' },
            data: { providerRef: 'moolre-fail-3' }
        });
        expect(result).toMatchObject({
            status: 'FAILED',
            changed: true,
            providerTxId: 'moolre-fail-3'
        });
    });
});
