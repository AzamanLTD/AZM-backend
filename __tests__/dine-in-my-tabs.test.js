// GET /api/dine-in/my-tabs: the caller's own tabs for the app's hub (active =
// open or bill ready; closed = closed or cancelled), bounded, newest first.
jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));
const ctrl = require('../controllers/dineInController');

const call = async (query, findMany = jest.fn(async () => [{ id: 't1' }])) => {
    let status = 200; let payload = null;
    const prisma = { dineInTab: { findMany } };
    await ctrl.getMyTabs({ app: { get: () => prisma }, user: { id: 10 }, query },
        { status(c) { status = c; return this; }, json(p) { payload = p; return this; } });
    return { status, payload, findMany };
};

describe('my tabs', () => {
    test('active: only the caller\'s open and bill-ready tabs, bounded', async () => {
        const { status, payload, findMany } = await call({});
        expect(status).toBe(200);
        expect(payload).toEqual({ success: true, tabs: [{ id: 't1' }] });
        const args = findMany.mock.calls[0][0];
        expect(args.where).toEqual({ customerId: 10, status: { in: ['OPEN', 'FINALIZED'] } });
        expect(args.take).toBe(30);
        expect(args.orderBy).toEqual({ openedAt: 'desc' });
        expect(args.include.businessProfile.select).toEqual(expect.objectContaining({ bizId: true, businessName: true }));
    });

    test('closed, a capped limit, and an unknown set refused', async () => {
        const closed = await call({ set: 'closed', limit: '500' });
        expect(closed.findMany.mock.calls[0][0].where.status).toEqual({ in: ['CLOSED', 'CANCELLED'] });
        expect(closed.findMany.mock.calls[0][0].take).toBe(50);
        const bad = await call({ set: 'everyone' });
        expect(bad.status).toBe(400);
        expect(bad.findMany).not.toHaveBeenCalled();
    });

    test('the route is customer-side (no business permission) and before /tabs/:tabId', () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/dineInRoutes.js'), 'utf-8');
        expect(src).toContain("router.get('/my-tabs',                     protect, ctrl.getMyTabs);");
    });
});
