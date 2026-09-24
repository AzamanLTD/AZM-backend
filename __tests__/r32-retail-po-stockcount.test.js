// __tests__/r32-retail-po-stockcount.test.js
// =============================================================================
// r32 audit items G + H — RETAIL PO RECEIVE-ONCE + STOCK-COUNT RECONCILE-ONCE
// (real PostgreSQL, real HTTP routes, real requirePermission chain).
//
// Historical defects:
//   • PATCH purchase-order accepted ANY status string with no transition
//     table, and ran the stock increment on every PATCH carrying
//     status 'RECEIVED' — receiving twice minted stock twice, and
//     RECEIVED → SUBMITTED → RECEIVED cycled forever;
//   • the stock increment was a non-atomic read-modify-write outside the
//     status flip, so concurrent receives double-applied;
//   • PO creation accepted foreign supplierId and productIds;
//   • stock-count items could be re-counted after reconciliation, and the
//     reconcile was a non-atomic check-then-write.
//
// Fixed contract:
//   • RECEIVED/CANCELLED are TERMINAL; transitions follow a table;
//   • the receive CAS-flips a non-RECEIVED PO inside a transaction whose
//     stock increments are atomic statements scoped to the business;
//   • a reconciled count accepts no further item writes, and reconciliation
//     applies exactly once under concurrency.
// =============================================================================
const request = require('supertest');
const express = require('express');

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = global.__R32_USER__; next(); },
    adminOnly: (_req, _res, next) => next(),
}));

jest.mock('../middleware/banGuardMiddleware', () => {
    const actual = jest.requireActual('../middleware/banGuardMiddleware');
    return { ...actual, protectActive: (_req, _res, next) => next() };
});

const { PrismaClient } = require('@prisma/client');
const businessOSRoutes = require('../routes/businessOSRoutes');
const { seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r32 G+H — retail PO receive-once and stock-count reconcile-once', () => {
    let db;
    let app;
    let A, B;
    let supplierA, productA2;
    let seq = 0;

    const buildApp = () => {
        const a = express();
        a.use(express.json());
        a.set('prisma', db);
        a.set('logger', { error: () => {} });
        a.use('/api/business-os', businessOSRoutes);
        return a;
    };

    const asUser = (user) => { global.__R32_USER__ = user ? { id: user.id } : null; };

    const createPO = (body) => request(app).post('/api/business-os/retail/purchase-orders').send(body);
    const patchPO = (id, body) => request(app).patch(`/api/business-os/retail/purchase-orders/${id}`).send(body);
    const createCount = () => request(app).post('/api/business-os/retail/stock-counts').send({});
    const patchCountItem = (cid, iid, body) => request(app)
        .patch(`/api/business-os/retail/stock-counts/${cid}/items/${iid}`).send(body);
    const reconcile = (id) => request(app).post(`/api/business-os/retail/stock-counts/${id}/reconcile`);

    const stockOf = async (id) => (await db.businessProduct.findUnique({ where: { id }, select: { stockQty: true } })).stockQty;

    const mkPOBody = (biz, product, supplier, qty = 10) => ({
        supplierId: supplier.id,
        items: [{ productId: product.id, productName: product.name, quantity: qty, unitCost: 2 }],
    });

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        app = buildApp();
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => {
        global.__R32_USER__ = null;
        await db.$executeRawUnsafe('TRUNCATE TABLE "StockCountItem", "StockCount", "PurchaseOrderItem", "PurchaseOrder", "Supplier", "BusinessProduct", "BusinessLocation", "TransactionHistory", "BusinessProfile", "User" RESTART IDENTITY CASCADE');
    });

    beforeEach(async () => {
        A = await seedBusiness(db);
        B = await seedBusiness(db);
        asUser(A.owner);
        // Both businesses get a supplier + a second stock-tracked product.
        supplierA = await db.supplier.create({ data: { businessProfileId: A.biz.id, name: 'Supplier A' } });
        productA2 = await db.businessProduct.create({
            data: { businessProfileId: A.biz.id, name: `Product A2 ${++seq}`, priceUsdc: 5, slug: `a2-${seq}`, stockQty: 100 },
        });
        await db.supplier.create({ data: { businessProfileId: B.biz.id, name: 'Supplier B' } });
    });

    // ── Item G: purchase orders ────────────────────────────────────────────

    test('1. receive applies the stock increment exactly once; re-receive is refused and mints nothing', async () => {
        await db.businessProduct.update({ where: { id: productA2.id }, data: { stockQty: 100 } });
        const po = (await createPO(mkPOBody(A.biz, productA2, supplierA, 10))).body.purchaseOrder;

        const first = await patchPO(po.id, { status: 'RECEIVED' });
        expect(first.status).toBe(200);
        expect(first.body.purchaseOrder.status).toBe('RECEIVED');
        expect(await stockOf(productA2.id)).toBe(110);

        const second = await patchPO(po.id, { status: 'RECEIVED' });
        expect(second.status).toBe(400);
        expect(second.body.message).toBe('Purchase order already received.');
        expect(await stockOf(productA2.id)).toBe(110); // no double mint
    });

    test('2. RECEIVED is terminal — flipping back to SUBMITTED is refused, so the receive cycle cannot repeat', async () => {
        const po = (await createPO(mkPOBody(A.biz, productA2, supplierA, 5))).body.purchaseOrder;
        expect((await patchPO(po.id, { status: 'RECEIVED' })).status).toBe(200);

        const back = await patchPO(po.id, { status: 'SUBMITTED' });
        expect(back.status).toBe(400);
        expect(back.body.message).toContain('Cannot move purchase order');

        const reReceive = await patchPO(po.id, { status: 'RECEIVED' });
        expect(reReceive.status).toBe(400);
        expect(await stockOf(productA2.id)).toBe(105);
    });

    test('3. concurrent receives converge on exactly one stock application', async () => {
        await db.businessProduct.update({ where: { id: productA2.id }, data: { stockQty: 0 } });
        const po = (await createPO(mkPOBody(A.biz, productA2, supplierA, 7))).body.purchaseOrder;

        const [r1, r2] = await Promise.all([
            patchPO(po.id, { status: 'RECEIVED' }),
            patchPO(po.id, { status: 'RECEIVED' }),
        ]);
        const successes = [r1, r2].filter(r => r.status === 200).length;
        expect(successes).toBe(1);
        expect(await stockOf(productA2.id)).toBe(7); // applied once
    });

    test('4. unknown statuses are refused; notes-only PATCH does not touch stock', async () => {
        const po = (await createPO(mkPOBody(A.biz, productA2, supplierA, 3))).body.purchaseOrder;

        const bad = await patchPO(po.id, { status: 'HACKED' });
        expect(bad.status).toBe(400);
        expect(bad.body.message).toContain('Unknown purchase order status');

        const notesOnly = await patchPO(po.id, { notes: 'arrival delayed' });
        expect(notesOnly.status).toBe(200);
        expect(notesOnly.body.purchaseOrder.status).toBe('SUBMITTED');
        expect(await stockOf(productA2.id)).toBe(100); // untouched
    });

    test('5. PO creation rejects a foreign supplier and foreign products', async () => {
        const supplierB = await db.supplier.findFirst({ where: { businessProfileId: B.biz.id } });
        const foreignSupplier = await createPO(mkPOBody(A.biz, productA2, supplierB));
        expect(foreignSupplier.status).toBe(400);
        expect(foreignSupplier.body.message).toBe('Supplier not found.');

        const foreignProduct = await createPO(mkPOBody(A.biz, B.product, supplierA));
        expect(foreignProduct.status).toBe(400);
        expect(foreignProduct.body.message).toContain('do not belong to this business');
    });

    test('6. a foreign business cannot receive or mutate another business\'s PO', async () => {
        await db.businessProduct.update({ where: { id: productA2.id }, data: { stockQty: 50 } });
        const po = (await createPO(mkPOBody(A.biz, productA2, supplierA, 4))).body.purchaseOrder;

        asUser(B.owner);
        expect((await patchPO(po.id, { status: 'RECEIVED' })).status).toBe(404);
        expect((await patchPO(po.id, { status: 'CANCELLED' })).status).toBe(404);

        // A's PO is untouched and A can still receive it.
        expect(await stockOf(productA2.id)).toBe(50);
        asUser(A.owner);
        expect((await patchPO(po.id, { status: 'RECEIVED' })).status).toBe(200);
        expect(await stockOf(productA2.id)).toBe(54);
    });

    // ── Item H: stock counts ────────────────────────────────────────────────

    test('7. reconcile applies counted quantities once; a second reconcile is refused', async () => {
        await db.businessProduct.update({ where: { id: productA2.id }, data: { stockQty: 100 } });
        const count = (await createCount()).body.stockCount;
        const item = count.items.find(i => i.productId === productA2.id);
        expect(item).toBeTruthy();
        expect(item.systemQty).toBe(100);

        const record = await patchCountItem(count.id, item.id, { countedQty: 97 });
        expect(record.status).toBe(200);
        expect(record.body.item.discrepancy).toBe(-3);

        const first = await reconcile(count.id);
        expect(first.status).toBe(200);
        expect(first.body.stockCount.status).toBe('RECONCILED');
        expect(await stockOf(productA2.id)).toBe(97);

        const second = await reconcile(count.id);
        expect(second.status).toBe(400);
        expect(second.body.message).toBe('Already reconciled.');
        expect(await stockOf(productA2.id)).toBe(97);
    });

    test('8. items cannot be re-counted after reconciliation', async () => {
        const count = (await createCount()).body.stockCount;
        const item = count.items.find(i => i.productId === productA2.id);

        expect((await patchCountItem(count.id, item.id, { countedQty: 90 })).status).toBe(200);
        expect((await reconcile(count.id)).status).toBe(200);

        const late = await patchCountItem(count.id, item.id, { countedQty: 42 });
        expect(late.status).toBe(400);
        expect(late.body.message).toContain('already been reconciled');
        expect(await stockOf(productA2.id)).toBe(90); // applied value stands
    });

    test('9. concurrent reconciles converge on one application', async () => {
        const count = (await createCount()).body.stockCount;
        const item = count.items.find(i => i.productId === productA2.id);
        await patchCountItem(count.id, item.id, { countedQty: 88 });

        const [r1, r2] = await Promise.all([reconcile(count.id), reconcile(count.id)]);
        const successes = [r1, r2].filter(r => r.status === 200).length;
        expect(successes).toBe(1);
        expect(await stockOf(productA2.id)).toBe(88);

        const row = await db.stockCount.findUnique({ where: { id: count.id } });
        expect(row.status).toBe('RECONCILED');
        expect(row.reconciledAt).toBeTruthy();
    });

    test('10. a foreign stock count id is a plain 404 for every operation', async () => {
        const countA = (await createCount()).body.stockCount;
        const itemA = countA.items.find(i => i.productId === productA2.id);

        asUser(B.owner);
        expect((await patchCountItem(countA.id, itemA.id, { countedQty: 1 })).status).toBe(404);
        expect((await reconcile(countA.id)).status).toBe(404);

        asUser(A.owner);
        expect((await patchCountItem(countA.id, itemA.id, { countedQty: 96 })).status).toBe(200);
        expect((await reconcile(countA.id)).status).toBe(200);
        expect(await stockOf(productA2.id)).toBe(96);
    });
});
