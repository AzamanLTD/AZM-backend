// __tests__/r32-kds-route-service-contract.test.js
// =============================================================================
// r32 audit item D — KDS ROUTE/SERVICE CONTRACT (real PostgreSQL proofs).
//
// Historical defects:
//   • the four KDS mutation routes called the service WITHOUT the
//     server-derived businessProfileId (updateOrderStatus, updateItemStatus,
//     assignChef were tenant-unscoped at the route layer; bump read the order
//     with a global findUnique, leaking foreign state);
//   • the backend expected `itemIndex`/`employeeId` while the live Business
//     Portal sends `itemId`/`chefId` — the item endpoint was contract-broken;
//   • updateItemStatus operated on `order.orderItems`, a field that DOES NOT
//     EXIST on the KitchenOrder model (items are a KitchenOrderItem relation),
//     so item mutation was fully broken at the schema level.
//
// Canonical contract (fixed in this round, backend + portal + tests):
//   • every KDS mutation takes the server-derived businessProfileId;
//   • the item mutation key is `itemId` — a durable KitchenOrderItem row id;
//   • the chef mutation key is `employeeId` — a BusinessEmployee id;
//   • statuses follow the forward-only FLOW NEW→PREPARING→READY→SERVED with
//     idempotent re-submit; the bump pre-read is tenant-scoped.
// =============================================================================
const { PrismaClient } = require('@prisma/client');
const { RestaurantOpsService } = require('../services/businessOS/restaurantOpsService');
const { seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r32 D — KDS route/service contract (real PostgreSQL)', () => {
    let db;
    let seq = 0;

    beforeAll(() => { process.env.DATABASE_URL = url; db = new PrismaClient(); });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => db.$executeRawUnsafe('TRUNCATE TABLE "KitchenOrderItem", "KitchenOrder", "BusinessEmployee", "TransactionHistory", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE'));

    const mkOrder = async (biz, product, n = 1) => {
        const svc = new RestaurantOpsService(db);
        return svc.createKitchenOrder({
            businessProfileId: biz.id,
            tableNumber: `T${++seq}`,
            items: Array.from({ length: n }, () => ({ productId: product.id, quantity: 1 })),
        });
    };

    test('1. same-business order status mutation succeeds with correct timing writes', async () => {
        const { biz, product } = await seedBusiness(db);
        const svc = new RestaurantOpsService(db);
        const order = await mkOrder(biz, product);

        const preparing = await svc.updateOrderStatus(order.id, 'PREPARING', biz.id);
        expect(preparing.status).toBe('PREPARING');
        expect(preparing.startedAt).toBeTruthy();
        const ready = await svc.updateOrderStatus(order.id, 'READY', biz.id);
        expect(ready.status).toBe('READY');
        expect(ready.readyAt).toBeTruthy();
        const served = await svc.updateOrderStatus(order.id, 'SERVED', biz.id);
        expect(served.status).toBe('SERVED');
        expect(served.servedAt).toBeTruthy();
    });

    test('2. foreign order mutations are denied for status, item, and chef paths', async () => {
        const A = await seedBusiness(db);
        const B = await seedBusiness(db);
        const svc = new RestaurantOpsService(db);
        const orderA = await mkOrder(A.biz, A.product);

        // Status path.
        await expect(svc.updateOrderStatus(orderA.id, 'PREPARING', B.biz.id)).rejects.toThrow('Kitchen order not found.');
        // Item path: the foreign caller can't even resolve the ORDER.
        await expect(svc.updateItemStatus(orderA.id, 'any-item', 'READY', B.biz.id)).rejects.toThrow('Order not found.');
        // Bump path: pre-read is scoped; the foreign caller learns nothing.
        await expect(svc.bumpOrderStatus(orderA.id, B.biz.id)).rejects.toThrow('Kitchen order not found.');
        // Chef path: a B employee is refused, and the A order is never mutated.
        const empB = await db.businessEmployee.create({ data: { businessProfileId: B.biz.id, userId: B.owner.id, role: 'CHEF', permissions: [] } });
        await expect(svc.assignChef(orderA.id, empB.id, B.biz.id)).rejects.toThrow('Kitchen order not found.');

        const after = await db.kitchenOrder.findUnique({ where: { id: orderA.id } });
        expect(after.status).toBe('NEW');
        expect(after.employeeId).toBeNull();
    });

    test('3. item mutation by the canonical item identifier (portal contract: itemId)', async () => {
        const { biz, product } = await seedBusiness(db);
        const svc = new RestaurantOpsService(db);
        const order = await mkOrder(biz, product, 2);
        const items = await db.kitchenOrderItem.findMany({ where: { kitchenOrderId: order.id }, orderBy: { createdAt: 'asc' } });
        expect(items).toHaveLength(2);

        // Positional jumps are refused: NEW → READY is a two-step skip.
        await expect(svc.updateItemStatus(order.id, items[0].id, 'READY', biz.id)).rejects.toThrow('Invalid item status transition');

        // One item advances NEW → PREPARING → READY; the parent recomputes to
        // READY only when ALL items are ready.
        await svc.updateItemStatus(order.id, items[0].id, 'PREPARING', biz.id);
        const first = await svc.updateItemStatus(order.id, items[0].id, 'READY', biz.id);
        expect(first.items.find(i => i.id === items[0].id).status).toBe('READY');
        expect(first.items.find(i => i.id === items[1].id).status).toBe('NEW');
        expect(first.status).toBe('NEW'); // not all ready yet

        await svc.updateItemStatus(order.id, items[1].id, 'PREPARING', biz.id);
        const second = await svc.updateItemStatus(order.id, items[1].id, 'READY', biz.id);
        expect(second.status).toBe('READY'); // all items ready → parent READY
        expect(second.readyAt).toBeTruthy();
    });

    test('3b. an item id is addressed only THROUGH its parent order — cross-order item ids are refused', async () => {
        const { biz, product } = await seedBusiness(db);
        const svc = new RestaurantOpsService(db);
        const order1 = await mkOrder(biz, product);
        const order2 = await mkOrder(biz, product);
        const item2 = (await db.kitchenOrderItem.findMany({ where: { kitchenOrderId: order2.id } }))[0];

        // Same business, but the item belongs to a different order.
        await expect(svc.updateItemStatus(order1.id, item2.id, 'READY', biz.id)).rejects.toThrow('Kitchen item not found.');
        // And a foreign business is refused before the item is even read.
        const B = await seedBusiness(db);
        await expect(svc.updateItemStatus(order1.id, item2.id, 'READY', B.biz.id)).rejects.toThrow('Order not found.');
    });

    test('4. chef assignment by the canonical employee identifier (portal contract: employeeId)', async () => {
        const { biz, product, owner } = await seedBusiness(db);
        const svc = new RestaurantOpsService(db);
        const order = await mkOrder(biz, product);
        const chef = await db.businessEmployee.create({ data: { businessProfileId: biz.id, userId: owner.id, role: 'CHEF', permissions: [] } });

        const updated = await svc.assignChef(order.id, chef.id, biz.id);
        expect(updated.employeeId).toBe(chef.id);
        expect(updated.status).toBe('PREPARING');
        expect(updated.startedAt).toBeTruthy();

        // Non-chef/manager roles are refused.
        const { biz: biz2, product: product2, owner: owner2 } = await seedBusiness(db);
        const order2 = await mkOrder(biz2, product2);
        const staff = await db.businessEmployee.create({ data: { businessProfileId: biz2.id, userId: owner2.id, role: 'STAFF', permissions: [] } });
        await expect(svc.assignChef(order2.id, staff.id, biz2.id)).rejects.toThrow('Only chefs or managers can be assigned to orders.');
    });

    test('5. bump on a foreign order is denied without leaking its state; same-business bump advances one step', async () => {
        const A = await seedBusiness(db);
        const B = await seedBusiness(db);
        const svc = new RestaurantOpsService(db);
        const orderA = await mkOrder(A.biz, A.product);

        // Foreign bump: refused, and the B caller never learns orderA's state.
        await expect(svc.bumpOrderStatus(orderA.id, B.biz.id)).rejects.toThrow('Kitchen order not found.');

        // Same-business bump advances exactly one step.
        const bumped1 = await svc.bumpOrderStatus(orderA.id, A.biz.id);
        expect(bumped1.status).toBe('PREPARING');
        const bumped2 = await svc.bumpOrderStatus(orderA.id, A.biz.id);
        expect(bumped2.status).toBe('READY');
        // Bump on the terminal state converges (idempotent, stays SERVED).
        const bumped3 = await svc.bumpOrderStatus(orderA.id, A.biz.id);
        expect(bumped3.status).toBe('SERVED');
        const bumped4 = await svc.bumpOrderStatus(orderA.id, A.biz.id);
        expect(bumped4.status).toBe('SERVED');
    });

    test('6. invalid status progression is refused: skips, backwards, and unknown values', async () => {
        const { biz, product } = await seedBusiness(db);
        const svc = new RestaurantOpsService(db);
        const order = await mkOrder(biz, product);

        // Skip: NEW → READY.
        await expect(svc.updateOrderStatus(order.id, 'READY', biz.id)).rejects.toThrow('Invalid status transition');
        // Backwards after a legal advance.
        await svc.updateOrderStatus(order.id, 'PREPARING', biz.id);
        await expect(svc.updateOrderStatus(order.id, 'NEW', biz.id)).rejects.toThrow('Invalid status transition');
        // Unknown values.
        await expect(svc.updateOrderStatus(order.id, 'SOMETHING', biz.id)).rejects.toThrow('Invalid kitchen order status');
        await expect(svc.updateItemStatus(order.id, 'x', 'SOMETHING', biz.id)).rejects.toThrow('Invalid kitchen item status');

        // Idempotent re-submit of the current status converges, not errors.
        const again = await svc.updateOrderStatus(order.id, 'PREPARING', biz.id);
        expect(again.status).toBe('PREPARING');
    });

    test('7. repeated/concurrent item mutations converge safely to the shared final state', async () => {
        const { biz, product } = await seedBusiness(db);
        const svc = new RestaurantOpsService(db);
        const order = await mkOrder(biz, product, 3);
        const items = await db.kitchenOrderItem.findMany({ where: { kitchenOrderId: order.id }, orderBy: { createdAt: 'asc' } });

        // Same item, same transition, from two concurrent callers: both
        // converge — the row lands READY once, never corrupts.
        const [r1, r2] = await Promise.allSettled([
            svc.updateItemStatus(order.id, items[0].id, 'PREPARING', biz.id),
            svc.updateItemStatus(order.id, items[0].id, 'PREPARING', biz.id),
        ]);
        expect([r1.status, r2.status]).toEqual(['fulfilled', 'fulfilled']);
        const row = await db.kitchenOrderItem.findUnique({ where: { id: items[0].id } });
        expect(row.status).toBe('PREPARING');

        // Drive every item to READY concurrently; the parent must be READY,
        // with each item exactly READY (no duplicate effects).
        await Promise.allSettled([
            svc.updateItemStatus(order.id, items[0].id, 'PREPARING', biz.id),
            svc.updateItemStatus(order.id, items[1].id, 'PREPARING', biz.id),
            svc.updateItemStatus(order.id, items[2].id, 'PREPARING', biz.id),
        ]);
        await Promise.allSettled([
            svc.updateItemStatus(order.id, items[0].id, 'READY', biz.id),
            svc.updateItemStatus(order.id, items[1].id, 'READY', biz.id),
            svc.updateItemStatus(order.id, items[2].id, 'READY', biz.id),
        ]);
        const parent = await db.kitchenOrder.findUnique({ where: { id: order.id }, include: { items: true } });
        expect(parent.status).toBe('READY');
        expect(parent.items.every(i => i.status === 'READY')).toBe(true);

        // Concurrent SERVED on all items → parent SERVED, all items SERVED.
        await Promise.allSettled([
            svc.updateItemStatus(order.id, items[0].id, 'SERVED', biz.id),
            svc.updateItemStatus(order.id, items[1].id, 'SERVED', biz.id),
            svc.updateItemStatus(order.id, items[2].id, 'SERVED', biz.id),
        ]);
        const final = await db.kitchenOrder.findUnique({ where: { id: order.id }, include: { items: true } });
        expect(final.status).toBe('SERVED');
        expect(final.items.every(i => i.status === 'SERVED')).toBe(true);
    });

    test('8. the KDS board now projects real items and the station view (legacy orderItems reads returned nothing)', async () => {
        const { biz, product } = await seedBusiness(db);
        const svc = new RestaurantOpsService(db);
        await mkOrder(biz, product, 2);

        const board = await svc.getKDSBoard(biz.id);
        expect(board.totalActive).toBe(1);
        expect(board.allOrders[0].items).toHaveLength(2);
        expect(board.allOrders[0].items[0].name).toBe(product.name);
        // Station projection is populated (was permanently empty pre-r32).
        expect(Object.keys(board.byStation)).toContain('HOT');
        expect(board.byStation.HOT[0].stationItems).toHaveLength(2);
    });
});
