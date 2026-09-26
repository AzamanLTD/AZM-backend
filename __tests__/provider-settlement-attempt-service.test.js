const {
    normalizeProvider,
    normalizeStatus,
    recordProviderSettlementAttempt
} = require('../services/providerSettlementAttemptService');

describe('providerSettlementAttemptService', () => {
    test('normalizes supported providers and rejects unknown providers', () => {
        expect(normalizeProvider('mtn_momo_disbursement')).toBe('MTN_MOMO_DISBURSEMENT');
        expect(normalizeProvider('moolre')).toBe('MOOLRE');
        expect(() => normalizeProvider('unknown')).toThrow(/unsupported provider/i);
    });

    test('normalizes supported attempt statuses and rejects unknown statuses', () => {
        expect(normalizeStatus('pending')).toBe('PENDING');
        expect(normalizeStatus('completed')).toBe('COMPLETED');
        expect(normalizeStatus('failed')).toBe('FAILED');
        expect(() => normalizeStatus('CANCELLED')).toThrow(/unsupported status/i);
    });

    test('creates an explicit provider attempt linked to the canonical transaction', async () => {
        const prisma = {
            $queryRawUnsafe: jest.fn()
                .mockResolvedValueOnce([{ id: 'tx-1' }])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ id: 'attempt-1', transactionHistoryId: 'tx-1', provider: 'MTN_MOMO_DISBURSEMENT', providerReference: 'ref-1', status: 'PENDING' }])
        };

        const result = await recordProviderSettlementAttempt(prisma, {
            reference: 'ref-1',
            provider: 'MTN_MOMO_DISBURSEMENT',
            providerReference: 'ref-1',
            providerTransactionId: 'provider-1'
        });

        expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(3);
        expect(result).toMatchObject({ id: 'attempt-1', changed: true });
    });

    test('updates a pending provider attempt to completed', async () => {
        const pending = {
            id: 'attempt-1',
            transactionHistoryId: 'tx-1',
            provider: 'MOOLRE',
            providerReference: 'external-1',
            status: 'PENDING'
        };
        const completed = { ...pending, status: 'COMPLETED', providerTransactionId: 'moolre-tx-1' };
        const prisma = {
            $queryRawUnsafe: jest.fn()
                .mockResolvedValueOnce([{ id: 'tx-1' }])
                .mockResolvedValueOnce([pending])
                .mockResolvedValueOnce([completed])
        };

        const result = await recordProviderSettlementAttempt(prisma, {
            reference: 'ref-1',
            provider: 'MOOLRE',
            providerReference: 'external-1',
            providerTransactionId: 'moolre-tx-1',
            status: 'COMPLETED'
        });

        expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(3);
        expect(result).toMatchObject({ id: 'attempt-1', changed: true, status: 'COMPLETED' });
    });

    test('rejects an existing provider reference linked to a different canonical transaction', async () => {
        const prisma = {
            $queryRawUnsafe: jest.fn()
                .mockResolvedValueOnce([{ id: 'tx-2' }])
                .mockResolvedValueOnce([{
                    id: 'attempt-1',
                    transactionHistoryId: 'tx-1',
                    provider: 'MOOLRE',
                    providerReference: 'external-1',
                    status: 'PENDING'
                }])
        };

        await expect(recordProviderSettlementAttempt(prisma, {
            reference: 'ref-2',
            provider: 'MOOLRE',
            providerReference: 'external-1',
            status: 'COMPLETED'
        })).rejects.toMatchObject({ code: 'PROVIDER_REFERENCE_CONFLICT' });
        expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    });

    test('does not regress a completed provider attempt when a late failed callback arrives', async () => {
        const prisma = {
            $queryRawUnsafe: jest.fn()
                .mockResolvedValueOnce([{ id: 'tx-1' }])
                .mockResolvedValueOnce([{
                    id: 'attempt-1',
                    transactionHistoryId: 'tx-1',
                    provider: 'MOOLRE',
                    providerReference: 'external-1',
                    providerTransactionId: 'moolre-tx-1',
                    status: 'COMPLETED',
                    failureReason: null
                }])
                .mockResolvedValueOnce([{
                    id: 'attempt-1',
                    transactionHistoryId: 'tx-1',
                    provider: 'MOOLRE',
                    providerReference: 'external-1',
                    providerTransactionId: 'late-failed-tx',
                    status: 'COMPLETED',
                    failureReason: null
                }])
        };

        const result = await recordProviderSettlementAttempt(prisma, {
            reference: 'ref-1',
            provider: 'MOOLRE',
            providerReference: 'external-1',
            providerTransactionId: 'late-failed-tx',
            status: 'FAILED',
            failureReason: 'late contradictory callback'
        });

        expect(result).toMatchObject({ id: 'attempt-1', changed: false, status: 'COMPLETED' });
    });

    test('does not regress a failed provider attempt when a late success callback arrives', async () => {
        const prisma = {
            $queryRawUnsafe: jest.fn()
                .mockResolvedValueOnce([{ id: 'tx-1' }])
                .mockResolvedValueOnce([{
                    id: 'attempt-1',
                    transactionHistoryId: 'tx-1',
                    provider: 'MOOLRE',
                    providerReference: 'external-1',
                    providerTransactionId: 'moolre-failed-tx',
                    status: 'FAILED',
                    failureReason: 'provider rejected transfer'
                }])
                .mockResolvedValueOnce([{
                    id: 'attempt-1',
                    transactionHistoryId: 'tx-1',
                    provider: 'MOOLRE',
                    providerReference: 'external-1',
                    providerTransactionId: 'late-success-tx',
                    status: 'FAILED',
                    failureReason: 'provider rejected transfer'
                }])
        };

        const result = await recordProviderSettlementAttempt(prisma, {
            reference: 'ref-1',
            provider: 'MOOLRE',
            providerReference: 'external-1',
            providerTransactionId: 'late-success-tx',
            status: 'COMPLETED'
        });

        expect(result).toMatchObject({ id: 'attempt-1', changed: false, status: 'FAILED' });
    });

    test('returns the database winner if a concurrent callback terminalizes after the initial read', async () => {
        const prisma = {
            $queryRawUnsafe: jest.fn()
                .mockResolvedValueOnce([{ id: 'tx-1' }])
                .mockResolvedValueOnce([{
                    id: 'attempt-1',
                    transactionHistoryId: 'tx-1',
                    provider: 'MOOLRE',
                    providerReference: 'external-1',
                    status: 'PENDING'
                }])
                .mockResolvedValueOnce([{
                    id: 'attempt-1',
                    transactionHistoryId: 'tx-1',
                    provider: 'MOOLRE',
                    providerReference: 'external-1',
                    status: 'FAILED',
                    failureReason: 'another callback won'
                }])
        };

        const result = await recordProviderSettlementAttempt(prisma, {
            reference: 'ref-1',
            provider: 'MOOLRE',
            providerReference: 'external-1',
            providerTransactionId: 'late-success-tx',
            status: 'COMPLETED'
        });

        expect(result).toMatchObject({ id: 'attempt-1', changed: true, status: 'FAILED' });
    });

    test('rejects a concurrent provider-reference collision after another transaction wins the insert race', async () => {
        const prisma = {
            $queryRawUnsafe: jest.fn()
                .mockResolvedValueOnce([{ id: 'tx-2' }])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{
                    id: 'attempt-1',
                    transactionHistoryId: 'tx-1',
                    provider: 'MOOLRE',
                    providerReference: 'external-1',
                    status: 'PENDING'
                }])
        };

        await expect(recordProviderSettlementAttempt(prisma, {
            reference: 'ref-2',
            provider: 'MOOLRE',
            providerReference: 'external-1',
            status: 'COMPLETED'
        })).rejects.toMatchObject({ code: 'PROVIDER_REFERENCE_CONFLICT' });
        expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(4);
    });
});
