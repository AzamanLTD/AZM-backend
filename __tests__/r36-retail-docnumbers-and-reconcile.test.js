// __tests__/r36-retail-docnumbers-and-reconcile.test.js
// =============================================================================
// r36/P1 — RETAIL RAIL: business-local document numbers + all-or-nothing
// stock reconciliation (real PostgreSQL, real HTTP).
//
// Historical defects pinned shut:
//   • poNumber was globally unique while being generated per business
//     (count+1): the FIRST purchase order of two different businesses both
//     generated PO-00001 and one creation failed. Same for stock counts.
//   • Generation used a count-based read-then-write: two concurrent creations
//     in ONE business read the same count and collided.
//   • Reconciliation applied stock with updateMany that silently matched 0
//     rows when a counted product had been deleted — the count then closed
//     with PARTIAL stock application and no error.
//
// r36 invariants under test:
//   • (businessProfileId, docNumber) composite uniqueness; the sequence is a
//     durable DocumentNumberSequence row incremented atomically INSIDE the
//     creation transaction.
//   • Numbers are never reused after document deletion (audit-friendly).
//   • Reconcile is ALL-OR-NOTHING: every counted item must resolve to exactly
//     one business-scoped product write or the whole transaction rolls back —
//     the count stays OPEN and NO stock changes.
// =============================================================================
const request = require('supertest');
const express = require('express');

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = global.__R36_RT_USER__; next(); },
    adminOnly: (_req, _res, next) => next(),
}));
jest.mock('../middleware/banGuardMiddleware', () => {
    const actual = jest.requireActual('../middleware/banGuardMiddleware');
    return { ...actual, protectActive: (req, _res, next) => { req.user = global.__R36_RT_USER__; next(); } };
});

const { PrismaClient } = require('@prisma/client');
const businessOSRoutes = require('../routes/businessOSRoutes');
const { seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r36/P1 — retail: business-local doc numbers + all-or-nothing reconcile', () => {
    let db;
    let app;
    let A, B;
    let supplierA, supplierB;

    const asUser = (user) => { global.__R36_RT_USER__ = user ? { id: user.id } : null; };
    const mkPo = (biz, supplier, body) => request(app)
        .post('/api/business-os/retail/purchase-orders')
        .send(Object.assign({ supplierId: supplier.id, items: [{ productName: 'Widget', quantity: 2, unitCost: 5 }] }, body));
    const mkCount = (body) => request(app).post('/api/business-os/retail/stock-counts').send(body || {});
    const reconcile = (id) => request(app).post(`/api/business-os/retail/stock-counts/${id}/reconcile`).send({});
    const countItem = (countId, itemId, countedQty) => request(app)
        .patch(`/api/business-os/retail/stock-counts/${countId}/items/${itemId}`).send({ countedQty });

    const mkProduct = async (biz, name, stockQty) => db.businessProduct.create({
        data: { businessProfileId: biz.id, name, slug: `sl-${name}-${Date.now()}-${Math.floor(Math.random()*1e6)}`, priceUsdc: 5, isActive: true, stockQty },
    });

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        app = express();
        app.use(express.json());
        app.set('prisma', db);
        app.use('/api/business-os', businessOSRoutes);
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => {
        global.__R36_RT_USER__ = null;
        await db.$executeRawUnsafe('TRUNCATE TABLE "StockCountItem", "StockCount", "PurchaseOrderItem", "PurchaseOrder", "DocumentNumberSequence", "Supplier", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE');
    });
    beforeEach(async () => {
        A = await seedBusiness(db);
        B = await seedBusiness(db);
        asUser(A.owner);
        supplierA = await db.supplier.create({ data: { businessProfileId: A.biz.id, name: 'Supplier A' } });
        supplierB = await db.supplier.create({ data: { businessProfileId: B.biz.id, name: 'Supplier B' } });
    });

    describe('business-local document numbers', () => {
        test('CROSS-BUSINESS COLLISION IS CLOSED: both businesses get their own PO-00001', async () => {
            const resA = await mkPo(A.biz, supplierA);
            expect(resA.status).toBe(200);
            expect(resA.body.purchaseOrder.poNumber).toBe('PO-00001');

            asUser(B.owner);
            const resB = await mkPo(B.biz, supplierB);
            expect(resB.status).toBe(200);
            expect(resB.body.purchaseOrder.poNumber).toBe('PO-00001');
        });

        test('sequential creation inside ONE business increments monotonically', async () => {
            for (let i = 1; i <= 3; i++) {
                const res = await mkPo(A.biz, supplierA);
                expect(res.status).toBe(200);
                expect(res.body.purchaseOrder.poNumber).toBe(`PO-${String(i).padStart(5, '0')}`);
            }
        });

        test('CONCURRENT creation in one business: all succeed, all numbers distinct', async () => {
            const results = await Promise.all([
                mkPo(A.biz, supplierA), mkPo(A.biz, supplierA), mkPo(A.biz, supplierA),
                mkPo(A.biz, supplierA), mkPo(A.biz, supplierA),
            ]);
            const numbers = results.map((r) => {
                expect(r.status).toBe(200);
                return r.body.purchaseOrder.poNumber;
            });
            expect(new Set(numbers).size).toBe(5);
            const all = await db.purchaseOrder.findMany({ where: { businessProfileId: A.biz.id } });
            expect(all.length).toBe(5);
        });

        test('numbers are NEVER reused after deletion', async () => {
            const first = await mkPo(A.biz, supplierA);
            expect(first.body.purchaseOrder.poNumber).toBe('PO-00001');
            await db.purchaseOrder.delete({ where: { id: first.body.purchaseOrder.id } });

            const second = await mkPo(A.biz, supplierA);
            expect(second.status).toBe(200);
            expect(second.body.purchaseOrder.poNumber).toBe('PO-00002');
        });

        test('stock counts have their own SC- sequence, independent from POs', async () => {
            await mkPo(A.biz, supplierA);
            const sc = await mkCount();
            expect(sc.status).toBe(200);
            expect(sc.body.stockCount.countNumber).toBe('SC-00001');
            await mkPo(A.biz, supplierA);
            const sc2 = await mkCount();
            expect(sc2.body.stockCount.countNumber).toBe('SC-00002');
        });

        test('the composite unique index is the database backstop', async () => {
            await mkPo(A.biz, supplierA);
            await expect(db.purchaseOrder.create({
                data: {
                    businessProfileId: A.biz.id, poNumber: 'PO-00001',
                    supplierId: supplierA.id, status: 'SUBMITTED', totalCost: 0, createdById: A.owner.id,
                },
            })).rejects.toMatchObject({ code: 'P2002' });
        });
    });

    describe('all-or-nothing stock reconciliation', () => {
        test('happy path: counted quantities are applied and the count closes', async () => {
            const p1 = await mkProduct(A.biz, 'Flour', 100);
            const p2 = await mkProduct(A.biz, 'Sugar', 50);
            const sc = await mkCount();
            const scId = sc.body.stockCount.id;
            const items = await db.stockCountItem.findMany({ where: { stockCountId: scId } });
            // 2 products created here + the seedBusiness factory product (stockQty default 0)
            expect(items.length).toBe(3);

            const it1 = items.find((i) => i.productId === p1.id);
            const it2 = items.find((i) => i.productId === p2.id);
            expect((await countItem(scId, it1.id, 90)).status).toBe(200);
            expect((await countItem(scId, it2.id, 55)).status).toBe(200);

            const rec = await reconcile(scId);
            expect(rec.status).toBe(200);
            expect(rec.body.stockCount.status).toBe('RECONCILED');
            expect((await db.businessProduct.findUnique({ where: { id: p1.id } })).stockQty).toBe(90);
            expect((await db.businessProduct.findUnique({ where: { id: p2.id } })).stockQty).toBe(55);
        });

        test('DELETED PRODUCT MID-COUNT: the whole reconcile aborts — count stays OPEN, NO stock changed', async () => {
            const p1 = await mkProduct(A.biz, 'Keep', 100);
            const p2 = await mkProduct(A.biz, 'Doomed', 50);
            const sc = await mkCount();
            const scId = sc.body.stockCount.id;
            const items = await db.stockCountItem.findMany({ where: { stockCountId: scId } });
            const it1 = items.find((i) => i.productId === p1.id);
            const it2 = items.find((i) => i.productId === p2.id);
            await countItem(scId, it1.id, 90);
            await countItem(scId, it2.id, 60);

            // The product is deleted AFTER the count was opened.
            await db.businessProduct.delete({ where: { id: p2.id } });

            const rec = await reconcile(scId);
            expect(rec.status).toBe(400);
            expect(rec.body.message).toMatch(/no longer belongs|no stock changes/i);

            // ALL-OR-NOTHING: the surviving product was NOT touched, count OPEN.
            expect((await db.businessProduct.findUnique({ where: { id: p1.id } })).stockQty).toBe(100);
            const row = await db.stockCount.findUnique({ where: { id: scId } });
            expect(row.status).toBe('OPEN');
        });

        test('concurrent reconciles converge on ONE application', async () => {
            const p1 = await mkProduct(A.biz, 'Solo', 100);
            const sc = await mkCount();
            const scId = sc.body.stockCount.id;
            const items = await db.stockCountItem.findMany({ where: { stockCountId: scId } });
            const it1 = items.find((i) => i.productId === p1.id);
            await countItem(scId, it1.id, 42);

            const results = await Promise.all([reconcile(scId), reconcile(scId)]);
            const statuses = results.map((r) => r.status).sort();
            expect(statuses[0]).toBe(200);
            expect(statuses[1]).toBeGreaterThanOrEqual(400);
            expect((await db.businessProduct.findUnique({ where: { id: p1.id } })).stockQty).toBe(42);
            expect((await db.stockCount.findUnique({ where: { id: scId } })).status).toBe('RECONCILED');
        });

        test('reconcile of another business count → 404', async () => {
            await mkProduct(B.biz, 'Foreign', 10);
            asUser(B.owner);
            const sc = await mkCount();
            const scId = sc.body.stockCount.id;
            asUser(A.owner);
            expect((await reconcile(scId)).status).toBe(404);
            expect((await db.stockCount.findUnique({ where: { id: scId } })).status).toBe('OPEN');
        });
    });
});
