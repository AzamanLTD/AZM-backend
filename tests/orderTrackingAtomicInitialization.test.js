const controller = require('../controllers/orderTrackingController');

const makeResponse = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
});

describe('order tracking atomic initialization', () => {
    test('GET tracking uses upsert when a paid order races into tracking initialization', async () => {
        const tracking = { orderId: 'order-1', businessProfileId: 'biz-1', timeline: [] };
        const prisma = {
            businessOrder: {
                findUnique: jest.fn().mockResolvedValue({
                    customerId: 7,
                    businessProfileId: 'biz-1',
                    status: 'PAID',
                    orderRef: 'ORD-1',
                }),
            },
            orderTracking: {
                findUnique: jest.fn().mockResolvedValue(null),
                upsert: jest.fn().mockResolvedValue(tracking),
                create: jest.fn(),
            },
            businessProfile: { findUnique: jest.fn() },
        };
        const req = {
            app: { get: jest.fn((key) => key === 'prisma' ? prisma : undefined) },
            params: { orderId: 'order-1' },
            user: { id: 7 },
        };
        const res = makeResponse();

        await controller.getTracking(req, res);

        expect(prisma.orderTracking.upsert).toHaveBeenCalledWith({
            where: { orderId: 'order-1' },
            create: { orderId: 'order-1', businessProfileId: 'biz-1' },
            update: {},
        });
        expect(prisma.orderTracking.create).not.toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith({ success: true, tracking });
    });

    test('POST tracking status initializes with upsert instead of find-then-create', async () => {
        const tracking = { orderId: 'order-1', businessProfileId: 'biz-1', timeline: [] };
        const updatedTracking = { ...tracking, timeline: [{ status: 'IN_TRANSIT', note: '', timestamp: expect.any(String) }] };
        const prisma = {
            businessOrder: {
                findUnique: jest.fn().mockResolvedValue({
                    businessProfileId: 'biz-1',
                    customerId: 7,
                    status: 'PAID',
                    orderRef: 'ORD-1',
                }),
            },
            businessProfile: {
                findUnique: jest.fn().mockResolvedValue({ ownerId: 11 }),
            },
            orderTracking: {
                upsert: jest.fn().mockResolvedValue(tracking),
                update: jest.fn().mockResolvedValue(updatedTracking),
                findUnique: jest.fn(),
                create: jest.fn(),
            },
        };
        const req = {
            app: { get: jest.fn((key) => key === 'prisma' ? prisma : undefined) },
            params: { orderId: 'order-1' },
            user: { id: 11 },
            body: { status: 'IN_TRANSIT' },
        };
        const res = makeResponse();

        await controller.updateStatus(req, res);

        expect(prisma.orderTracking.upsert).toHaveBeenCalledWith({
            where: { orderId: 'order-1' },
            create: { orderId: 'order-1', businessProfileId: 'biz-1' },
            update: {},
        });
        expect(prisma.orderTracking.create).not.toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith({ success: true, tracking: updatedTracking });
    });
});
