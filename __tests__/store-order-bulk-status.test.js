// =============================================================================
// Bulk order status never moves an escrow-backed order.
//
// The Business OS bulk tool could mark an unpaid escrow order PAID, start the
// buyer's release window (DELIVERED) with no notice and no held payment, or
// say COMPLETED over an unreleased escrow. Escrow-backed orders move only
// through the escrow: funding, markDelivered, release, the refund path.
// Orders without an escrow (direct orders) still move in bulk.
// =============================================================================

jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/requirePermission', () => ({
    requirePermission: () => (req, res, next) => next(),
    resolveBusinessContext: async () => ({ businessProfileId: 'bp-1' }),
    resolvePermissions: async () => [],
}));
jest.mock('../utils/businessAudit', () => ({ logBusinessAudit: jest.fn().mockResolvedValue(undefined) }));

const { table } = require('./helpers/transitPrismaFake');
const router = require('../routes/businessOSRoutes');

const handler = (() => {
    const layer = router.stack.find((l) => l.route && l.route.path === '/orders/bulk-status');
    return layer.route.stack[layer.route.stack.length - 1].handle;
})();

function makeDb() {
    const db = {
        businessOrder: table([
            { id: 'esc-order', businessProfileId: 'bp-1', status: 'AWAITING_PAYMENT', escrowId: 'esc-1' },
            { id: 'esc-paid', businessProfileId: 'bp-1', status: 'PAID', escrowId: 'esc-2' },
            { id: 'direct', businessProfileId: 'bp-1', status: 'AWAITING_PAYMENT', escrowId: null },
        ]),
    };
    // The route uses the array form; the fake runs each query in order.
    db.$transaction = jest.fn(async (ops) => (Array.isArray(ops) ? Promise.all(ops) : ops(db)));
    return db;
}

const call = (db, body) => new Promise((resolve, reject) => {
    const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(p) { resolve({ status: this.statusCode, body: p }); return this; },
    };
    Promise.resolve(handler({
        app: { get: (k) => (k === 'prisma' ? db : null) },
        user: { id: 20, username: 'owner' }, body, ip: '127.0.0.1',
    }, res, reject)).catch(reject);
});

describe('bulk order status', () => {
    test.each(['PAID', 'DELIVERED', 'COMPLETED', 'CANCELLED'])('%s skips escrow-backed orders', async (status) => {
        const db = makeDb();
        await call(db, { orderIds: ['esc-order', 'esc-paid'], status });
        const rows = Object.fromEntries(db.businessOrder.rows.map((r) => [r.id, r]));
        expect(rows['esc-order'].status).toBe('AWAITING_PAYMENT');
        expect(rows['esc-paid'].status).toBe('PAID');
        expect(rows['esc-paid'].deliveredAt).toBeUndefined();
    });

    test('a direct order still moves in bulk', async () => {
        const db = makeDb();
        const out = await call(db, { orderIds: ['direct'], status: 'PAID' });
        expect(out.status).toBe(200);
        expect(db.businessOrder.rows.find((r) => r.id === 'direct').status).toBe('PAID');
    });
});
