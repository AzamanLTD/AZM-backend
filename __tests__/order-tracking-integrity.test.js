// Order tracking security/integrity coverage. Pure unit tests; no database required.

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

    test('timeline is readable by the customer', async () => {
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

    test('location rejects out-of-range coordinates before database access', async () => {
        const prisma = {
            businessOrder: { findUnique: jest.fn() },
        };
        const req = {
            params: { orderId: 'order-1' },
            user: { id: 'owner-1' },
            body: { latitude: 91, longitude: 0 },
            app: { get: jest.fn((key) => key === 'prisma' ? prisma : undefined) },
        };
        const res = makeResponse();

        await controller.updateLocation(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            success: false,
            message: 'valid latitude and longitude required',
        });
        expect(prisma.businessOrder.findUnique).not.toHaveBeenCalled();
    });

    test('location rejects invalid heading and speed before database access', async () => {
        const prisma = {
            businessOrder: { findUnique: jest.fn() },
        };
        const makeRequest = (body) => ({
            params: { orderId: 'order-1' },
            user: { id: 'owner-1' },
            body,
            app: { get: jest.fn((key) => key === 'prisma' ? prisma : undefined) },
        });

        const headingRes = makeResponse();
        await controller.updateLocation(makeRequest({ latitude: 5, longitude: 5, heading: 360 }), headingRes);
        expect(headingRes.status).toHaveBeenCalledWith(400);
        expect(headingRes.json).toHaveBeenCalledWith({ success: false, message: 'invalid heading' });

        const speedRes = makeResponse();
        await controller.updateLocation(makeRequest({ latitude: 5, longitude: 5, speedKmh: -1 }), speedRes);
        expect(speedRes.status).toHaveBeenCalledWith(400);
        expect(speedRes.json).toHaveBeenCalledWith({ success: false, message: 'invalid speedKmh' });

        expect(prisma.businessOrder.findUnique).not.toHaveBeenCalled();
    });

    test('status updates preserve zero-valued delivery coordinates and reuse one event timestamp', async () => {
        const tracking = { timeline: [] };
        const io = { to: jest.fn().mockReturnThis(), emit: jest.fn() };
        const prisma = {
            businessOrder: {
                findUnique: jest.fn().mockResolvedValue({
                    businessProfileId: 'biz-1',
                    customerId: 'customer-1',
                    status: 'PAID',
                    orderRef: 'ORD-1',
                }),
            },
            businessProfile: { findUnique: jest.fn().mockResolvedValue({ ownerId: 'owner-1' }) },
            orderTracking: {
                findUnique: jest.fn().mockResolvedValue(tracking),
                update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...tracking, ...data })),
            },
        };
        const req = {
            params: { orderId: 'order-1' },
            user: { id: 'owner-1' },
            body: {
                status: 'DELIVERED',
                deliveryLat: 0,
                deliveryLng: 0,
            },
            app: { get: jest.fn((key) => key === 'prisma' ? prisma : key === 'io' ? io : undefined) },
        };
        const res = makeResponse();

        await controller.updateStatus(req, res);

        expect(prisma.orderTracking.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ deliveryLatitude: 0, deliveryLongitude: 0 }),
        }));
        const updateCall = prisma.orderTracking.update.mock.calls[0][0];
        const timelineTimestamp = updateCall.data.timeline[0].timestamp;
        expect(io.emit).toHaveBeenCalledWith('order:status', expect.objectContaining({ timestamp: timelineTimestamp }));
        expect(updateCall.data.actualArrival.toISOString()).toBe(timelineTimestamp);
    });

    test('status rejects invalid delivery coordinates before tracking mutation', async () => {
        const prisma = {
            businessOrder: {
                findUnique: jest.fn().mockResolvedValue({ businessProfileId: 'biz-1' }),
            },
            businessProfile: { findUnique: jest.fn().mockResolvedValue({ ownerId: 'owner-1' }) },
            orderTracking: { findUnique: jest.fn(), update: jest.fn() },
        };
        const req = {
            params: { orderId: 'order-1' },
            user: { id: 'owner-1' },
            body: { status: 'DELIVERED', deliveryLat: 91, deliveryLng: 0 },
            app: { get: jest.fn((key) => key === 'prisma' ? prisma : undefined) },
        };
        const res = makeResponse();

        await controller.updateStatus(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ success: false, message: 'invalid deliveryLat' });
        expect(prisma.orderTracking.findUnique).not.toHaveBeenCalled();
        expect(prisma.orderTracking.update).not.toHaveBeenCalled();
    });
});
