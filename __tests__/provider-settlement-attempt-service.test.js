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
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ id: 'tx-1' }])
                .mockResolvedValueOnce([{ id: 'attempt-1', transactionHistoryId: 'tx-1', provider: 'MTN_MOMO_DISBURSEMENT', providerReference: 'ref-1', status: 'PENDING' }]),
            $executeRawUnsafe: jest.fn()
        };

        const result = await recordProviderSettlementAttempt(prisma, {
            reference: 'ref-1',
            provider: 'MTN_MOMO_DISBURSEMENT',
            providerReference: 'ref-1',
            providerTransactionId: 'provider-1'
        });

        expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(3);
        expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
        expect(result).toMatchObject({ id: 'attempt-1', changed: true });
    });

    test('updates a pending provider attempt to completed', async () => {
        const prisma = {
            $queryRawUnsafe: jest.fn().mockResolvedValueOnce([{
                id: 'attempt-1',
                transactionHistoryId: 'tx-1',
                provider: 'MOOLRE',
                providerReference: 'external-1',
                status: 'PENDING'
            }]),
            $executeRawUnsafe: jest.fn().mockResolvedValue(1)
        };

        const result = await recordProviderSettlementAttempt(prisma, {
            reference: 'ref-1',
            provider: 'MOOLRE',
            providerReference: 'external-1',
            providerTransactionId: 'moolre-tx-1',
            status: 'COMPLETED'
        });

        expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
        expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({ id: 'attempt-1', changed: true, status: 'COMPLETED' });
    });

    test('does not regress a completed provider attempt when a late failed callback arrives', async () => {
        const prisma = {
            $queryRawUnsafe: jest.fn()
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
                }]),
            $executeRawUnsafe: jest.fn()
        };

        const result = await recordProviderSettlementAttempt(prisma, {
            reference: 'ref-1',
            provider: 'MOOLRE',
            providerReference: 'external-1',
            providerTransactionId: 'late-failed-tx',
            status: 'FAILED',
            failureReason: 'late contradictory callback'
        });

        expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
        expect(result).toMatchObject({ id: 'attempt-1', changed: false, status: 'COMPLETED' });
    });

    test('does not regress a failed provider attempt when a late success callback arrives', async () => {
        const prisma = {
            $queryRawUnsafe: jest.fn()
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
                }]),
            $executeRawUnsafe: jest.fn()
        };

        const result = await recordProviderSettlementAttempt(prisma, {
            reference: 'ref-1',
            provider: 'MOOLRE',
            providerReference: 'external-1',
            providerTransactionId: 'late-success-tx',
            status: 'COMPLETED'
        });

        expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
        expect(result).toMatchObject({ id: 'attempt-1', changed: false, status: 'FAILED' });
    });

    test('returns the database winner if a concurrent callback terminalizes after the initial read', async () => {
        const prisma = {
            $queryRawUnsafe: jest.fn()
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
                }]),
            $executeRawUnsafe: jest.fn()
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
});
