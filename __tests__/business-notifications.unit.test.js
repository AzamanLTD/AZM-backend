const notificationService = require('../services/bizNotificationService');

describe('BusinessNotification service', () => {
    test('getNotifications uses deterministic createdAt + id ordering and preserves unread count', async () => {
        const rows = [
            { id: 'n-3', createdAt: new Date('2026-08-30T12:00:00Z') },
            { id: 'n-2', createdAt: new Date('2026-08-30T12:00:00Z') },
            { id: 'n-1', createdAt: new Date('2026-08-29T12:00:00Z') },
        ];
        const prisma = {
            businessNotification: {
                findMany: jest.fn().mockResolvedValue(rows),
                count: jest.fn().mockResolvedValue(4),
            },
        };

        const result = await notificationService.getNotifications(prisma, 'biz-1', { limit: 2 });

        expect(prisma.businessNotification.findMany).toHaveBeenCalledWith(expect.objectContaining({
            take: 3,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }));
        expect(prisma.businessNotification.count).toHaveBeenCalledWith({
            where: { businessProfileId: 'biz-1', isRead: false },
        });
        expect(result.notifications).toEqual(rows.slice(0, 2));
        expect(result.hasMore).toBe(true);
        expect(result.nextCursor).toBe('n-2');
        expect(result.unreadCount).toBe(4);
    });

    test('unreadOnly scopes the page without changing the global unread badge count', async () => {
        const prisma = {
            businessNotification: {
                findMany: jest.fn().mockResolvedValue([{ id: 'n-1' }]),
                count: jest.fn().mockResolvedValue(7),
            },
        };

        await notificationService.getNotifications(prisma, 'biz-1', { unreadOnly: 'true' });

        expect(prisma.businessNotification.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { businessProfileId: 'biz-1', isRead: false },
        }));
        expect(prisma.businessNotification.count).toHaveBeenCalledWith({
            where: { businessProfileId: 'biz-1', isRead: false },
        });
    });

    test('markAsRead cannot mutate another business notification', async () => {
        const prisma = {
            businessNotification: {
                updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            },
        };

        await expect(notificationService.markAsRead(prisma, 'notification-1', 'biz-2'))
            .rejects.toThrow('Notification not found.');

        expect(prisma.businessNotification.updateMany).toHaveBeenCalledWith({
            where: { id: 'notification-1', businessProfileId: 'biz-2' },
            data: { isRead: true },
        });
    });

    test('notifyOrderEvent is a silent no-op for non-business escrows', async () => {
        const prisma = {
            businessOrder: { findFirst: jest.fn().mockResolvedValue(null) },
        };

        await expect(notificationService.notifyOrderEvent(prisma, {
            escrowId: 'escrow-peer',
            type: 'ORDER_FUNDED',
        })).resolves.toBeNull();
    });
});
