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

const { PrismaClient, Prisma } = require('@prisma/client');
const businessOSRoutes = require('../routes/businessOSRoutes');      // legacy + everything else
const businessOSPosRoutes = require('../routes/businessOSPosRoutes'); // canonical /pos/order (mounted FIRST)
const { seedBusiness } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

// =============================================================================
// WP-POS-C0 — this suite used to assert that POS sales SETTLE through the
// canonical service. They no longer can: PosOrderService refuses every new
// order until a truthful order-currency contract exists. The route-level
// contract this suite now proves is:
//   • both POS entry points refuse a new sale with POS_SETTLEMENT_NOT_ENABLED;
//   • a sale that was committed BEFORE containment still replays, including
//     through the legacy alias;
//   • the business-scoped key and the intent fingerprint still guard replay;
//   • pre-economic validation (tips, money shape) still answers 400 while
//     anything that needs pricing now stops at the containment refusal;
//   • nothing is written by a refusal.
// =============================================================================

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

    /** An order committed before containment, seeded directly. */
    const seedCommitted = async ({ idempotencyKey, amount = 103.5, storedFingerprint = undefined } = {}) => {
        const orderRef = `POS-SEED-${++seq}`;
        const order = await db.businessOrder.create({
            data: {
                businessProfileId: A.biz.id,
                customerId: A.owner.id,
                status: 'COMPLETED',
                orderRef,
                title: 'POS Sale (CASH)',
                amountUsdc: new Prisma.Decimal(amount),
                paymentMethod: 'CASH',
                idempotencyKey,
                cashReceived: new Prisma.Decimal(1000),
                cashChange: new Prisma.Decimal(1000 - amount),
                completedAt: new Date(),
            },
        });
        await db.businessLedgerEntry.create({
            data: {
                businessProfileId: A.biz.id,
                type: 'INCOME',
                category: 'SALES',
                description: `POS Sale (${orderRef})`,
                amount: new Prisma.Decimal(amount),
                sourceType: 'POS_SALE',
                sourceId: order.id,
                metadata: { orderRef, paymentMethod: 'CASH', tipAmount: '1.00000000', ...(storedFingerprint ? { posIdempotencyFingerprint: storedFingerprint } : {}) },
            },
        });
        return order;
    };

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

    test('1. the legacy cash-sale alias refuses a new sale before any economic write', async () => {
        const res = await cashSale(saleBody(A.product, { tipAmount: 1, subtotal: 9999, taxTotal: 9999 }));

        expect(res.status).toBe(422);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe('POS_SETTLEMENT_NOT_ENABLED');
        expect(res.body.order).toBeUndefined();

        // Client-supplied subtotal/taxTotal are irrelevant: nothing was priced.
        expect(await db.businessOrder.count()).toBe(0);
        expect(await db.businessLedgerEntry.count()).toBe(0);
        const product = await db.businessProduct.findUnique({ where: { id: A.product.id }, select: { stockQty: true } });
        expect(Number(product.stockQty)).toBe(100);
    });

    test('2. idempotency: a committed order replays through the legacy alias', async () => {
        const key = `replay-${++seq}`;
        const committed = await seedCommitted({ idempotencyKey: key });

        const replay = await cashSale({ items: [{ productId: A.product.id, quantity: 2 }], cashReceived: 1000, idempotencyKey: key });
        expect(replay.status).toBe(200);
        expect(replay.body.message).toBe('Duplicate (idempotent)');
        expect(replay.body.order.id).toBe(committed.id);
        expect(replay.body.order.orderRef).toBe(committed.orderRef);

        // A replay creates nothing new.
        expect(await db.businessOrder.count({ where: { idempotencyKey: key } })).toBe(1);
        expect(await db.businessLedgerEntry.count()).toBe(1);
    });

    test("3. a foreign business cannot replay another business's idempotency key", async () => {
        const key = `foreign-${++seq}`;
        await seedCommitted({ idempotencyKey: key });

        asUser(B.owner);
        const foreign = await cashSale({ items: [{ productId: B.product.id, quantity: 1 }], cashReceived: 1000, idempotencyKey: key });
        expect(foreign.status).toBe(400);
        expect(foreign.body.message).toContain('another business');
        expect(foreign.body.code).toBe('POS_VALIDATION_ERROR');
    });

    test('4. one key cannot be replayed with a different tip (fingerprint binding)', async () => {
        const key = `fingerprint-${++seq}`;
        await seedCommitted({ idempotencyKey: key, storedFingerprint: 'a-fingerprint-from-a-different-intent' });

        const altered = await cashSale({ items: [{ productId: A.product.id, quantity: 2 }], cashReceived: 1000, idempotencyKey: key, tipAmount: 50 });
        expect(altered.status).toBe(400);
        expect(altered.body.message).toContain('different POS request');

        expect(await db.businessOrder.count({ where: { idempotencyKey: key } })).toBe(1);
    });

    test('5. pre-economic validation still answers 400; anything needing pricing stops at containment', async () => {
        // Pre-economic: the tip and money shape are validated BEFORE the gate.
        const badTip = await cashSale(saleBody(A.product, { tipAmount: -5 }));
        expect(badTip.status).toBe(400);
        expect(badTip.body.message).toBe('Invalid tip amount.');
        expect(badTip.body.code).toBe('POS_VALIDATION_ERROR');

        const padded = await cashSale(saleBody(A.product, { cashReceived: ' 100 ' }));
        expect(padded.status).toBe(400);
        expect(padded.body.code).toBe('POS_VALIDATION_ERROR');

        // Post-economic-context: cash sufficiency and catalog scoping need a
        // priced order, which cannot exist, so the refusal (not those errors)
        // is the answer — and it is NOT misreported as a validation problem.
        const short = await cashSale(saleBody(A.product, { cashReceived: 1 }));
        expect(short.status).toBe(422);
        expect(short.body.code).toBe('POS_SETTLEMENT_NOT_ENABLED');
        expect(short.body.message).not.toContain('Insufficient cash');

        const foreignProduct = await cashSale(saleBody(B.product));
        expect(foreignProduct.status).toBe(422);
        expect(foreignProduct.body.code).toBe('POS_SETTLEMENT_NOT_ENABLED');
        expect(foreignProduct.body.message).not.toContain('Invalid or unavailable');
    });

    test('6. the unified /pos/order route refuses AZM instead of spending the cashier balance', async () => {
        await db.user.update({ where: { id: A.owner.id }, data: { azmBalance: 200 } });

        const res = await unifiedOrder({
            items: [{ productId: A.product.id, quantity: 2 }],
            paymentMethod: 'AZM',
            azmAmount: 102.5,
            idempotencyKey: `azm-${++seq}`,
        });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('POS_PAYMENT_METHOD_UNSUPPORTED');
        expect(res.body.message).toContain('AZM is loyalty value');

        const after = await db.user.findUnique({ where: { id: A.owner.id }, select: { azmBalance: true } });
        expect(Number(after.azmBalance)).toBe(200); // the cashier paid nothing
        expect(await db.azmSpendLog.count({ where: { source: 'POS_SALE' } })).toBe(0);
        expect(await db.businessLedgerEntry.count()).toBe(0);
        expect(await db.businessOrder.count()).toBe(0);
    });

    test('7. an AZM order that cannot be covered is refused with no partial writes', async () => {
        await db.user.update({ where: { id: A.owner.id }, data: { azmBalance: 1 } });
        const res = await unifiedOrder({
            items: [{ productId: A.product.id, quantity: 1 }],
            paymentMethod: 'AZM',
            azmAmount: 1,
            idempotencyKey: `azm-${++seq}`,
        });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('POS_PAYMENT_METHOD_UNSUPPORTED');

        expect(await db.businessOrder.count()).toBe(0);
        expect(await db.businessLedgerEntry.count({ where: { sourceType: 'POS_SALE' } })).toBe(0);
        expect(await db.azmSpendLog.count({ where: { source: 'POS_SALE' } })).toBe(0);
        const after = await db.user.findUnique({ where: { id: A.owner.id }, select: { azmBalance: true } });
        expect(Number(after.azmBalance)).toBe(1);
    });
});
