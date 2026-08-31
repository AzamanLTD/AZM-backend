jest.mock('../services/webhookEmitter', () => ({
    emitWebhookEvent: jest.fn(),
}));

const { emitWebhookEvent } = require('../services/webhookEmitter');
const {
    markDelivered,
    updateOrderStatusFromEscrow,
} = require('../services/businessOrderService');

const makeOrder = (overrides = {}) => ({
    id: 'order-1',
    orderRef: 'ORD-TEST-01',
    businessProfileId: 'business-1',
    customerId: 'customer-1',
    amountUsdc: 25,
    status: 'DELIVERED',
    completedAt: null,
    cancelledAt: null,
    ...overrides,
});

describe('business order webhook semantics', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('markDelivered emits order.delivered only after the delivery mutation succeeds', async () => {
        const order = makeOrder();
        const prisma = {
            businessOrder: {
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                findUnique: jest.fn().mockResolvedValue(order),
            },
        };

        await markDelivered(prisma, {
            orderId: order.id,
            businessProfileId: order.businessProfileId,
            deliveryNotes: 'left with customer',
        });

        expect(emitWebhookEvent).toHaveBeenCalledTimes(1);
        expect(emitWebhookEvent).toHaveBeenCalledWith(
            'business-1',
            'order.delivered',
            expect.objectContaining({
                orderId: 'order-1',
                orderRef: 'ORD-TEST-01',
                amount: 25,
                status: 'DELIVERED',
            }),
        );
    });

    test('markDelivered does not emit when the PAID claim fails', async () => {
        const prisma = {
            businessOrder: {
                updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                findUnique: jest.fn().mockResolvedValue({
                    businessProfileId: 'business-1',
                    status: 'DELIVERED',
                }),
            },
        };

        await expect(markDelivered(prisma, {
            orderId: 'order-1',
            businessProfileId: 'business-1',
        })).rejects.toThrow('PAID status');

        expect(emitWebhookEvent).not.toHaveBeenCalled();
    });

    test('escrow-driven completion emits order.completed only when the conditional transition wins', async () => {
        const order = makeOrder({ status: 'DELIVERED', amountUsdc: 40 });
        const updated = makeOrder({ status: 'COMPLETED', amountUsdc: 40, completedAt: new Date() });
        const prisma = {
            businessOrder: {
                findFirst: jest.fn().mockResolvedValue(order),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                findUnique: jest.fn().mockResolvedValue(updated),
            },
        };

        await updateOrderStatusFromEscrow(prisma, 'escrow-1', 'SETTLED');

        expect(emitWebhookEvent).toHaveBeenCalledTimes(1);
        expect(emitWebhookEvent).toHaveBeenCalledWith(
            'business-1',
            'order.completed',
            expect.objectContaining({
                orderId: 'order-1',
                orderRef: 'ORD-TEST-01',
                amount: 40,
                status: 'COMPLETED',
            }),
        );
    });

    test('escrow-driven completion does not emit when another transition wins the conditional claim', async () => {
        const order = makeOrder({ status: 'DELIVERED' });
        const prisma = {
            businessOrder: {
                findFirst: jest.fn().mockResolvedValue(order),
                updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                findUnique: jest.fn().mockResolvedValue({
                    id: 'order-1',
                    status: 'COMPLETED',
                    completedAt: new Date(),
                    cancelledAt: null,
                }),
            },
        };

        await updateOrderStatusFromEscrow(prisma, 'escrow-1', 'SETTLED');

        expect(emitWebhookEvent).not.toHaveBeenCalled();
    });
});
