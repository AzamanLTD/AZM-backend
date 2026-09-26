const { InventoryRestockService } = require('../services/businessOS/inventoryRestockService');

describe('InventoryRestockService input boundary', () => {
    const prisma = { inventoryRestockOperation: { findUnique: jest.fn() }, $transaction: jest.fn() };
    const svc = new InventoryRestockService(prisma);
    const input = { businessProfileId: 'biz-1', itemId: 'item-1', quantity: 5, idempotencyKey: 'new-restock-1' };
    test.each([
        [undefined, 'missing'], ['', 'empty'], ['  ', 'blank'], [' a ', 'padded'],
        ['x'.repeat(129), 'oversized'], [7, 'non-string'], ['x\n', 'control char'],
    ])('rejects %s key (%s) without touching the database', async (key) => {
        await expect(svc.restock({ ...input, idempotencyKey: key })).rejects.toMatchObject({ code: 'RESTOCK_IDEMPOTENCY_KEY_REQUIRED' });
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.inventoryRestockOperation.findUnique).not.toHaveBeenCalled();
    });
    test.each([0, -1, '', 'NaN', null, Infinity])('rejects invalid quantity %s', async (quantity) => {
        await expect(svc.restock({ ...input, quantity })).rejects.toMatchObject({ code: 'RESTOCK_INVALID_QUANTITY' });
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });
    test('only one router implements the restock POST', () => {
        const authoritative = require('../routes/businessOSInventoryRoutes');
        const legacy = require('../routes/businessOSRoutes');
        const path = '/restaurant/inventory/:id/restock';
        const match = (router) => router.stack.filter(layer => layer.route?.path === path && layer.route?.methods.post).length;
        expect(match(authoritative)).toBe(1);
        expect(match(legacy)).toBe(0);
        const routes = require('fs').readFileSync(require.resolve('../src/routes/index.js'), 'utf8');
        expect(routes.indexOf("require('../../routes/businessOSInventoryRoutes')"))
            .toBeLessThan(routes.indexOf("require('../../routes/businessOSRoutes')"));
    });
});
