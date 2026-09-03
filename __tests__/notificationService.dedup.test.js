jest.mock('../utils/firebaseService', () => ({
    sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));

const NotificationService = require('../services/notificationService');

describe('NotificationService OPEN_TRADE dedup', () => {
    test('includes tradeId in the dedup predicate', async () => {
        const prisma = {
            notification: {
                findFirst: jest.fn().mockResolvedValue(null),
            },
        };
        const service = new NotificationService(prisma, null);
        const batchKey = service._buildBatchKey({
            action: 'OPEN_TRADE',
            tradeId: 'trade-42',
        });

        expect(batchKey).toEqual({
            filters: [
                { actionPayload: { path: ['action'], equals: 'OPEN_TRADE' } },
                { actionPayload: { path: ['tradeId'], equals: 'trade-42' } },
            ],
        });

        await service._tryBatchUpdate(7, batchKey, 'Trade opened', 'MONEY');

        expect(prisma.notification.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                userId: 7,
                category: 'MONEY',
                AND: [
                    { actionPayload: { path: ['action'], equals: 'OPEN_TRADE' } },
                    { actionPayload: { path: ['tradeId'], equals: 'trade-42' } },
                ],
            }),
        }));
    });

    test('does not claim a different trade can share an existing OPEN_TRADE batch', () => {
        const service = new NotificationService({}, null);

        const first = service._buildBatchKey({ action: 'OPEN_TRADE', tradeId: 'trade-a' });
        const second = service._buildBatchKey({ action: 'OPEN_TRADE', tradeId: 'trade-b' });

        expect(first.filters).not.toEqual(second.filters);
        expect(second.filters).toContainEqual({
            actionPayload: { path: ['tradeId'], equals: 'trade-b' },
        });
    });
});
