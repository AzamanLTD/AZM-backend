const { settleFiatWithdrawal } = require('../services/fiatSettlementService');
const financeService = require('../services/finance.service');

jest.mock('../services/finance.service', () => ({
    completeFiatWithdrawal: jest.fn(),
    reverseFiatWithdrawal: jest.fn()
}));

describe('fiatSettlementService', () => {
    beforeEach(() => jest.clearAllMocks());

    const attemptDb = () => ({
        $queryRawUnsafe: jest.fn().mockResolvedValue([{
            id: 'tx-1',
            transactionHistoryId: 'tx-1',
            provider: 'MTN_MOMO_DISBURSEMENT',
            providerReference: 'ref-1',
            status: 'PENDING'
        }]),
        $executeRawUnsafe: jest.fn().mockResolvedValue(1)
    });

    test('delegates provider SUCCESS to the atomic finance settlement boundary', async () => {
        const pending = {
            txHash: 'ref-1', userId: 11, type: 'WITHDRAWAL_FIAT', status: 'PENDING', providerRef: null
        };
        const completed = { ...pending, status: 'COMPLETED', providerRef: 'moolre-991' };
        financeService.completeFiatWithdrawal.mockResolvedValue({
            reference: 'ref-1', userId: 11, status: 'COMPLETED', changed: true,
            providerTxId: 'moolre-991', transaction: completed
        });
        const prisma = {
            ...attemptDb(),
            transactionHistory: { findUnique: jest.fn().mockResolvedValue(pending), update: jest.fn() }
        };

        const result = await settleFiatWithdrawal(prisma, {
            reference: 'ref-1', provider: 'MOOLRE', status: 'SUCCESSFUL', providerTxId: 'moolre-991'
        });

        expect(financeService.completeFiatWithdrawal).toHaveBeenCalledWith(
            prisma, 'ref-1', { providerTxId: 'moolre-991' }
        );
        expect(result).toMatchObject({
            reference: 'ref-1', userId: 11, status: 'COMPLETED', changed: true, providerTxId: 'moolre-991'
        });
        expect(financeService.reverseFiatWithdrawal).not.toHaveBeenCalled();
    });

    test('does not resurrect a FAILED withdrawal on a late success callback', async () => {
        const failed = {
            txHash: 'ref-2', userId: 12, type: 'WITHDRAWAL_FIAT', status: 'FAILED', providerRef: null
        };
        financeService.completeFiatWithdrawal.mockResolvedValue({
            reference: 'ref-2', userId: 12, status: 'FAILED', changed: false,
            providerTxId: 'late-success', transaction: failed
        });
        const prisma = {
            ...attemptDb(),
            transactionHistory: { findUnique: jest.fn().mockResolvedValue(failed), update: jest.fn() }
        };

        const result = await settleFiatWithdrawal(prisma, {
            reference: 'ref-2', provider: 'MOOLRE', status: 'SUCCESSFUL', providerTxId: 'late-success'
        });

        expect(result).toMatchObject({ status: 'FAILED', changed: false });
        expect(prisma.transactionHistory.update).not.toHaveBeenCalled();
        expect(financeService.reverseFiatWithdrawal).not.toHaveBeenCalled();
    });

    test('enriches a duplicate completed success with a missing provider reference without re-running economics', async () => {
        const completed = {
            txHash: 'ref-dup', userId: 17, type: 'WITHDRAWAL_FIAT', status: 'COMPLETED', providerRef: null
        };
        const enriched = { ...completed, providerRef: 'provider-dup' };
        financeService.completeFiatWithdrawal.mockResolvedValue({
            reference: 'ref-dup', userId: 17, status: 'COMPLETED', changed: false,
            providerTxId: 'provider-dup', transaction: completed
        });
        const prisma = {
            ...attemptDb(),
            transactionHistory: { findUnique: jest.fn().mockResolvedValue(completed), update: jest.fn().mockResolvedValue(enriched) }
        };

        const result = await settleFiatWithdrawal(prisma, {
            reference: 'ref-dup', provider: 'MOOLRE', status: 'SUCCESSFUL', providerTxId: 'provider-dup'
        });

        expect(prisma.transactionHistory.update).toHaveBeenCalledWith({
            where: { txHash: 'ref-dup' }, data: { providerRef: 'provider-dup' }
        });
        expect(result).toMatchObject({ status: 'COMPLETED', changed: false, providerTxId: 'provider-dup' });
    });

    test('delegates a still-PENDING provider failure to atomic reversal and preserves provider reference', async () => {
        const pending = {
            txHash: 'ref-3', userId: 13, type: 'WITHDRAWAL_FIAT', status: 'PENDING', providerRef: null
        };
        const failedWithProviderRef = { ...pending, status: 'FAILED', providerRef: 'moolre-fail-3' };
        financeService.reverseFiatWithdrawal.mockResolvedValue({
            alreadyReversed: false, userId: 13, refundedAmount: 10
        });

        const prisma = {
            ...attemptDb(),
            transactionHistory: {
                findUnique: jest.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(failedWithProviderRef),
                update: jest.fn().mockResolvedValue(failedWithProviderRef)
            }
        };

        const result = await settleFiatWithdrawal(prisma, {
            reference: 'ref-3', provider: 'MOOLRE', status: 'FAILED', providerTxId: 'moolre-fail-3',
            reason: 'provider rejected transfer'
        });

        expect(financeService.reverseFiatWithdrawal).toHaveBeenCalledWith(
            prisma, 'ref-3', { reason: 'provider rejected transfer' }
        );
        expect(prisma.transactionHistory.update).toHaveBeenCalledWith({
            where: { txHash: 'ref-3' }, data: { providerRef: 'moolre-fail-3' }
        });
        expect(result).toMatchObject({ status: 'FAILED', changed: true, providerTxId: 'moolre-fail-3' });
    });

    test('rejects an unknown provider reference before recording or mutating ledger state', async () => {
        const prisma = {
            ...attemptDb(),
            transactionHistory: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() }
        };
        await expect(settleFiatWithdrawal(prisma, {
            reference: 'unknown-ref', provider: 'MOOLRE', status: 'SUCCESSFUL', providerTxId: 'moolre-404'
        })).rejects.toMatchObject({ code: 'UNKNOWN_REFERENCE' });
        expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
        expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
        expect(financeService.completeFiatWithdrawal).not.toHaveBeenCalled();
        expect(financeService.reverseFiatWithdrawal).not.toHaveBeenCalled();
    });

    test('rejects a non-fiat transaction reference', async () => {
        const trade = {
            txHash: 'trade-ref-1', userId: 14, type: 'TRADE_PAYMENT', status: 'PENDING', providerRef: null
        };
        const prisma = {
            ...attemptDb(),
            transactionHistory: { findUnique: jest.fn().mockResolvedValue(trade), update: jest.fn() }
        };
        await expect(settleFiatWithdrawal(prisma, {
            reference: 'trade-ref-1', provider: 'MOOLRE', status: 'SUCCESSFUL', providerTxId: 'moolre-trade-1'
        })).rejects.toMatchObject({ code: 'WRONG_TRANSACTION_TYPE' });
        expect(financeService.completeFiatWithdrawal).not.toHaveBeenCalled();
        expect(financeService.reverseFiatWithdrawal).not.toHaveBeenCalled();
    });
});
