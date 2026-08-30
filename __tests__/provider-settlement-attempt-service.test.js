const {
    normalizeProvider,
    recordProviderSettlementAttempt
} = require('../services/providerSettlementAttemptService');

describe('providerSettlementAttemptService', () => {
    test('normalizes supported providers and rejects unknown providers', () => {
        expect(normalizeProvider('mtn_momo_disbursement')).toBe('MTN_MOMO_DISBURSEMENT');
        expect(normalizeProvider('moolre')).toBe('MOOLRE');
        expect(() => normalizeProvider('unknown')).toThrow(/unsupported provider/i);
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

    test('updates the same provider attempt instead of creating duplicates', async () => {
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

        expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ id: 'attempt-1', changed: false });
    });
});
