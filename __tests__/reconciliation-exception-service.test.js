const { recordReconciliationException } = require('../services/reconciliationExceptionService');

describe('reconciliationExceptionService', () => {
    test('records an open exception through an idempotent upsert', async () => {
        const prisma = {
            $queryRawUnsafe: jest.fn().mockResolvedValue([{
                id: 'exception-1',
                entityType: 'WITHDRAWAL',
                entityId: '42',
                reference: null,
                reason: 'MISSING_TRANSACTION_REFERENCE',
                status: 'OPEN'
            }])
        };

        const result = await recordReconciliationException(prisma, {
            entityType: 'WITHDRAWAL',
            entityId: 42,
            reason: 'MISSING_TRANSACTION_REFERENCE',
            details: { amount: '100' }
        });

        expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
            id: 'exception-1',
            entityType: 'WITHDRAWAL',
            entityId: '42',
            status: 'OPEN'
        });
    });

    test('rejects unsupported entity types before touching the database', async () => {
        const prisma = { $queryRawUnsafe: jest.fn() };
        await expect(recordReconciliationException(prisma, {
            entityType: 'USER',
            entityId: '1',
            reason: 'TEST'
        })).rejects.toThrow(/unsupported entityType/i);
        expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });
});
