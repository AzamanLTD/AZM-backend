// Order tracking security/regression coverage. Pure unit tests; no database required.

const controller = require('../controllers/orderTrackingController');

describe('Order tracking controller boundaries', () => {
    const makeResponse = () => ({
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
    });

    test('timeline refuses an authenticated user who is not an order participant', async () => {
        const prisma = {
            businessOrder: {
                findUnique: jest.fn().mockResolvedValue({
                    customerId: 'customer-1',
                    businessProfileId: 'biz-1',
                    status: 'PAID',
                    orderRef: 'ORD-1',
                }),
            },
            businessProfile: {
                findUnique: jest.fn().mockResolvedValue({ ownerId: 'owner-1' }),
            },
        };
        const req = {
            params: { orderId: 'order-1' },
            user: { id: 'attacker-1' },
            app: { get: jest.fn((key) => key === 'prisma' ? prisma : undefined) },
        };
        const res = makeResponse();

        await controller.getTimeline(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Not authorized' });
        expect(prisma.orderTracking).toBeUndefined();
    });

    test('timeline is readable by the customer without exposing another order', async () => {
        const prisma = {
            businessOrder: {
                findUnique: jest.fn().mockResolvedValue({
                    customerId: 'customer-1',
                    businessProfileId: 'biz-1',
                    status: 'PAID',
                    orderRef: 'ORD-1',
                }),
            },
            businessProfile: { findUnique: jest.fn() },
            orderTracking: {
                findUnique: jest.fn().mockResolvedValue({ timeline: [{ status: 'PICKED_UP' }] }),
            },
        };
        const req = {
            params: { orderId: 'order-1' },
            user: { id: 'customer-1' },
            app: { get: jest.fn((key) => key === 'prisma' ? prisma : undefined) },
        };
        const res = makeResponse();

        await controller.getTimeline(req, res);

        expect(res.json).toHaveBeenCalledWith({
            success: true,
            timeline: [{ status: 'PICKED_UP' }],
        });
    });

    test('location updates preserve legitimate zero coordinates', async () => {
        const tracking = {};
        const prisma = {
            businessOrder: {
                findUnique: jest.fn().mockResolvedValue({ businessProfileId: 'biz-1' }),
            },
            businessProfile: {
                findUnique: jest.fn().mockResolvedValue({ ownerId: 'owner-1' }),
            },
            orderTracking: {
                findUnique: jest.fn().mockResolvedValue(tracking),
                update: jest.fn().mockResolvedValue(tracking),
            },
        };
        const req = {
            params: { orderId: 'order-1' },
            user: { id: 'owner-1' },
            body: { latitude: 0, longitude: 0, heading: 0, speedKmh: 0 },
            app: { get: jest.fn((key) => key === 'prisma' ? prisma : key === 'io' ? null : undefined) },
        };
        const res = makeResponse();

        await controller.updateLocation(req, res);

        expect(prisma.orderTracking.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                courierLatitude: 0,
                courierLongitude: 0,
                courierHeading: 0,
                courierSpeedKmh: 0,
            }),
        }));
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
});
