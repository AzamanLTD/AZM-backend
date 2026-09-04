const logger = require('../src/config/logger');
const { notifyDineInEvent } = require('../services/bizNotificationService');

jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn() }));

describe('business dine-in realtime notifications', () => {
    beforeEach(() => jest.clearAllMocks());

    test('persists and emits a supported dine-in lifecycle event only to the business owner', async () => {
        const emit = jest.fn();
        const io = { to: jest.fn(() => ({ emit })) };
        const prisma = {
            businessProfile: { findUnique: jest.fn().mockResolvedValue({ id: 'biz-1', userId: 42 }) },
            businessNotification: { create: jest.fn().mockResolvedValue({ id: 'notif-1', businessProfileId: 'biz-1', type: 'DINE_IN_TAB_FINALIZED', createdAt: new Date() }) },
        };

        const result = await notifyDineInEvent(prisma, {
            businessProfileId: 'biz-1', tabId: 'tab-12345678', type: 'DINE_IN_TAB_FINALIZED', totalAmount: 45, io,
        });

        expect(result.id).toBe('notif-1');
        expect(prisma.businessNotification.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ businessProfileId: 'biz-1', type: 'DINE_IN_TAB_FINALIZED', metadata: expect.objectContaining({ tabId: 'tab-12345678', totalAmount: 45 }) }),
        }));
        expect(io.to).toHaveBeenCalledWith('user_42');
        expect(emit).toHaveBeenCalledWith('biz_notification', expect.objectContaining({ notificationId: 'notif-1', businessProfileId: 'biz-1', type: 'DINE_IN_TAB_FINALIZED' }));
    });

    test('resolves business scope from the tab when no business id is supplied', async () => {
        const emit = jest.fn();
        const io = { to: jest.fn(() => ({ emit })) };
        const prisma = {
            dineInTab: { findUnique: jest.fn().mockResolvedValue({ businessProfileId: 'biz-2' }) },
            businessProfile: { findUnique: jest.fn().mockResolvedValue({ id: 'biz-2', userId: 7 }) },
            businessNotification: { create: jest.fn().mockResolvedValue({ id: 'notif-2', businessProfileId: 'biz-2', type: 'DINE_IN_TAB_OPENED', createdAt: new Date() }) },
        };

        await notifyDineInEvent(prisma, { tabId: 'tab-1', type: 'DINE_IN_TAB_OPENED', io });

        expect(prisma.dineInTab.findUnique).toHaveBeenCalledWith({ where: { id: 'tab-1' }, select: { businessProfileId: true } });
        expect(io.to).toHaveBeenCalledWith('user_7');
    });

    test('notification failure is non-fatal', async () => {
        const prisma = { businessProfile: { findUnique: jest.fn().mockRejectedValue(new Error('db unavailable')) } };
        const result = await notifyDineInEvent(prisma, { businessProfileId: 'biz-1', tabId: 'tab-1', type: 'DINE_IN_TAB_PAID' });
        expect(result).toBeNull();
        expect(logger.error).toHaveBeenCalled();
    });
});
