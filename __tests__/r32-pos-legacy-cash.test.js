// __tests__/r32-pos-legacy-cash.test.js
// =============================================================================
// r32 audit item I — LEGACY POS CASH ROUTES (real PostgreSQL, real HTTP,
// real middleware chain; both routers mounted in src/routes/index.js order).
//
// Historical defects in the legacy inline /pos/order and /pos/cash-sale:
//   • idempotency lookup was NOT scoped to the business — ANY business's key
//     returned that business's order to a caller;
//   • AZM debit was a non-atomic read-modify-write (concurrent orders
//     double-spent the balance);
//   • order + ledger were written outside a transaction, with the ledger
//     failure swallowed (silent ledger drift);
//   • cash-sale took the tax from the client-supplied taxTotal ratio;
//   • the legacy /pos/order inline copy drifted from the canonical
//     PosOrderService while being unreachable (shadowed by the unified route).
//
// Fixed contract:
//   • the dead inline /pos/order is REMOVED; POST /pos/order is served only
//     by routes/businessOSPosRoutes.js (canonical service);
//   • /pos/cash-sale delegates to the canonical PosOrderService (CASH path)
//     keeping the legacy request/response envelope;
//   • the service accepts a VALIDATED tipAmount: bounded, non-negative,
//     part of the idempotency fingerprint and the ledger metadata;
//   • every settlement is one serializable transaction: inventory, balance
//     debit, order, and ledger commit or roll back together.
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
const businessOSRoutes = require('../routes/businessOSRoutes');      // legacy + everything else
const businessOSPosRoutes = require('../routes/businessOSPosRoutes'); // canonical /pos/order (mounted FIRST)
const { seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r32 I — legacy POS cash routes over the canonical service', () => {
    let db;
    let app;
    let A, B;
    let seq = 0;

    const buildApp = () => {
        const a = express();
        a.use(express.json());
        a.set('prisma', db);
        a.set('logger', { error: () => {}, warn: () => {} });
        // Mirror src/routes/index.js mount order: unified POS router first.
        a.use('/api/business-os', businessOSPosRoutes);
        a.use('/api/business-os', businessOSRoutes);
        return a;
    };

    const asUser = (user) => { global.__R32_USER__ = user ? { id: user.id } : null; };

    const cashSale = (body) => request(app).post('/api/business-os/pos/cash-sale').send(body);
    const unifiedOrder = (body) => request(app).post('/api/business-os/pos/order').send(body);

    const saleBody = (product, extra = {}) => ({
        items: [{ productId: product.id, quantity: 2 }],
        cashReceived: 1000,
        idempotencyKey: `key-${++seq}`,
        ...extra,
    });

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
        app = buildApp();
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => {
        global.__R32_USER__ = null;
        await db.$executeRawUnsafe('TRUNCATE TABLE "BusinessLedgerEntry", "BusinessOrderItem", "BusinessOrder", "AzmSpendLog", "BusinessTaxPreset", "RecipeIngredient", "InventoryItem", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE');
    });

    beforeEach(async () => {
        A = await seedBusiness(db);
        B = await seedBusiness(db);
        asUser(A.owner);
        // The canonical service enforces stock — give the seeds inventory.
        await db.businessProduct.update({ where: { id: A.product.id }, data: { stockQty: 100 } });
        await db.businessProduct.update({ where: { id: B.product.id }, data: { stockQty: 100 } });

        // Authoritative 2.5% tax preset for business A.
        await db.businessTaxPreset.create({
            data: { businessProfileId: A.biz.id, name: 'VAT', type: 'PERCENTAGE', value: 2.5, isDefault: true },
        });
    });

    test('1. cash-sale settles through the canonical service: server-derived price, preset tax, atomic ledger', async () => {
        const res = await cashSale(saleBody(A.product, { tipAmount: 1, subtotal: 9999, taxTotal: 9999 }));
        expect(res.status).toBe(201);
        const { order, computedSubtotal, computedTax, computedGrand, change } = res.body;

        // Client-supplied subtotal/taxTotal are IGNORED — totals re-derived.
        expect(Number(computedSubtotal)).toBe(100);          // 50.0 × 2
        expect(Number(computedTax)).toBeCloseTo(2.5, 6);     // 2.5% preset
        expect(Number(computedGrand)).toBeCloseTo(103.5, 6); // + 1 tip
        expect(Number(order.amountUsdc)).toBeCloseTo(103.5, 6);
        expect(change).toBeCloseTo(1000 - 103.5, 6);

        // The ledger entry exists and carries the authoritative amounts.
        const ledger = await db.businessLedgerEntry.findFirst({
            where: { sourceType: 'POS_SALE', sourceId: order.id },
        });
        expect(ledger).toBeTruthy();
        expect(Number(ledger.amount)).toBeCloseTo(103.5, 6);
        expect(ledger.metadata.tipAmount).toBe(1);
    });

    test('2. idempotency: the same key replays the same order exactly once', async () => {
        const body = saleBody(A.product);
        const first = await cashSale(body);
        expect(first.status).toBe(201);

        const replay = await cashSale(body);
        expect(replay.status).toBe(200);
        expect(replay.body.message).toBe('Duplicate (idempotent)');
        expect(replay.body.order.id).toBe(first.body.order.id);

        const count = await db.businessOrder.count({ where: { idempotencyKey: body.idempotencyKey } });
        expect(count).toBe(1);
    });

    test('3. a foreign business cannot replay another business\'s idempotency key', async () => {
        const body = saleBody(A.product);
        expect((await cashSale(body)).status).toBe(201);

        asUser(B.owner);
        const foreign = await cashSale({ ...body, items: [{ productId: B.product.id, quantity: 1 }] });
        expect(foreign.status).toBe(400);
        expect(foreign.body.message).toContain('another business');
    });

    test('4. one key cannot be replayed with a different tip (fingerprint binding)', async () => {
        const body = saleBody(A.product, { tipAmount: 1 });
        expect((await cashSale(body)).status).toBe(201);

        const altered = await cashSale({ ...body, tipAmount: 50 });
        expect(altered.status).toBe(400);
        expect(altered.body.message).toContain('different POS request');

        const count = await db.businessOrder.count({ where: { idempotencyKey: body.idempotencyKey } });
        expect(count).toBe(1); // no second order was created
    });

    test('5. insufficient cash, invalid tip, and foreign products are refused', async () => {
        const short = await cashSale(saleBody(A.product, { cashReceived: 1 }));
        expect(short.status).toBe(400);
        expect(short.body.message).toBe('Insufficient cash received.');

        const badTip = await cashSale(saleBody(A.product, { tipAmount: -5 }));
        expect(badTip.status).toBe(400);
        expect(badTip.body.message).toBe('Invalid tip amount.');

        const foreignProduct = await cashSale(saleBody(B.product));
        expect(foreignProduct.status).toBe(400);
        expect(foreignProduct.body.message).toContain('Invalid or unavailable');
    });

    test('6. the unified /pos/order route still settles atomically (AZM path)', async () => {
        await db.user.update({ where: { id: A.owner.id }, data: { azmBalance: 200 } });
        const res = await unifiedOrder({
            items: [{ productId: A.product.id, quantity: 2 }],
            paymentMethod: 'AZM',
            idempotencyKey: `azm-${++seq}`,
        });
        expect(res.status).toBe(201);
        expect(res.body.computedGrand).toBeCloseTo(102.5, 6);

        const after = await db.user.findUnique({ where: { id: A.owner.id }, select: { azmBalance: true } });
        expect(Number(after.azmBalance)).toBeCloseTo(200 - 102.5, 6);

        const spendLog = await db.azmSpendLog.findFirst({ where: { userId: A.owner.id, source: 'POS_SALE' } });
        expect(spendLog).toBeTruthy();
        expect(Number(spendLog.amount)).toBeCloseTo(102.5, 6);

        const ledger = await db.businessLedgerEntry.findFirst({ where: { sourceType: 'POS_SALE' } });
        expect(ledger).toBeTruthy(); // same transaction, no drift
    });

    test('7. an AZM order that cannot be covered is refused atomically (no partial writes)', async () => {
        await db.user.update({ where: { id: A.owner.id }, data: { azmBalance: 1 } });
        const res = await unifiedOrder({
            items: [{ productId: A.product.id, quantity: 1 }],
            paymentMethod: 'AZM',
            idempotencyKey: `azm-${++seq}`,
        });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Insufficient AZM balance.');

        expect(await db.businessOrder.count()).toBe(0);
        expect(await db.businessLedgerEntry.count({ where: { sourceType: 'POS_SALE' } })).toBe(0);
        expect(await db.azmSpendLog.count({ where: { source: 'POS_SALE' } })).toBe(0);
        const after = await db.user.findUnique({ where: { id: A.owner.id }, select: { azmBalance: true } });
        expect(Number(after.azmBalance)).toBe(1); // balance untouched
    });
});
