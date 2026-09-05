const controller = require('../controllers/orderTrackingController');

const makeResponse = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
});

const makeReq = (body) => {
    const prisma = {
        businessOrder: { findUnique: jest.fn() },
        businessProfile: { findUnique: jest.fn() },
        orderTracking: { upsert: jest.fn(), update: jest.fn() },
    };
    return {
        params: { orderId: 'order-1' },
        user: { id: 'owner-1' },
        body,
        app: { get: jest.fn((key) => key === 'prisma' ? prisma : undefined) },
    };
};

describe('order tracking controller payload validation', () => {
    test.each([
        [undefined, 'invalid status'],
        ['', 'invalid status'],
        ['   ', 'invalid status'],
        ['x'.repeat(65), 'invalid status'],
        [123, 'invalid status'],
    ])('rejects invalid status %p before database access', async (status, message) => {
        const req = makeReq({ status });
        const res = makeResponse();

        await controller.updateStatus(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ success: false, message });
        const prisma = req.app.get('prisma');
        expect(prisma.businessOrder.findUnique).not.toHaveBeenCalled();
    });

    test.each([
        [123, 'invalid note'],
        ['x'.repeat(1001), 'invalid note'],
    ])('rejects malformed note %p before database access', async (note, message) => {
        const req = makeReq({ status: 'IN_TRANSIT', note });
        const res = makeResponse();

        await controller.updateStatus(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ success: false, message });
        const prisma = req.app.get('prisma');
        expect(prisma.businessOrder.findUnique).not.toHaveBeenCalled();
    });

    test('trims status for the persisted timeline and emitted notification payload', async () => {
        const tracking = { timeline: [] };
        const orderTracking = {
            upsert: jest.fn().mockResolvedValue(tracking),
            update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...tracking, ...data })),
        };
        const tx = {
            $queryRaw: jest.fn().mockResolvedValue([]),
            orderTracking,
        };
        const io = { to: jest.fn().mockReturnThis(), emit: jest.fn() };
        const notificationService = { sendToUser: jest.fn().mockResolvedValue(undefined) };
        const prisma = {
            $transaction: jest.fn((callback) => callback(tx)),
            businessOrder: { findUnique: jest.fn().mockResolvedValue({ businessProfileId: 'biz-1', customerId: 'customer-1', orderRef: 'ORD-1' }) },
            businessProfile: { findUnique: jest.fn().mockResolvedValue({ ownerId: 'owner-1' }) },
            orderTracking,
        };
        const req = {
            params: { orderId: 'order-1' },
            user: { id: 'owner-1' },
            body: { status: ' DELIVERED ', note: 'left at reception' },
            app: { get: jest.fn((key) => key === 'prisma' ? prisma : key === 'io' ? io : key === 'notificationService' ? notificationService : undefined) },
        };
        const res = makeResponse();

        await controller.updateStatus(req, res);

        const updateCall = tx.orderTracking.update.mock.calls[0][0];
        expect(updateCall.data.timeline[0].status).toBe('DELIVERED');
        expect(notificationService.sendToUser).toHaveBeenCalledWith('customer-1', expect.objectContaining({
            title: 'Order ORD-1 — DELIVERED',
            data: { orderId: 'order-1', status: 'DELIVERED' },
        }));
        expect(io.emit).toHaveBeenCalledWith('order:status', expect.objectContaining({ status: 'DELIVERED' }));
    });

    test.each([null, undefined, 1700000000000])('rejects non-string ETA %p before database access', async (estimatedArrival) => {
        const req = makeReq({ estimatedArrival });
        const res = makeResponse();

        await controller.updateEta(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ success: false, message: 'valid estimatedArrival required' });
        const prisma = req.app.get('prisma');
        expect(prisma.businessOrder.findUnique).not.toHaveBeenCalled();
    });
});
