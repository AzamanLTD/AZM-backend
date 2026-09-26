// __tests__/r36-recipe-deduction.test.js
// =============================================================================
// r36/P1 — RESTAURANT RECIPE DEDUCTION RAIL (real PostgreSQL, real HTTP).
//
// Historical defects pinned shut:
//   • The deduction followed recipe links across businesses — an order in
//     business A could decrement business B's inventory (cross-tenant write).
//   • The deduction was NOT idempotent: a retried or concurrent double
//     "complete" call deducted the same stock TWICE.
//   • A mid-chain failure (one foreign/missing ingredient) left the earlier
//     ingredients already decremented — partial, unrecoverable writes.
//
// r36 invariants under test:
//   • DEDUCT-ONCE per order: the claim is a conditional update on
//     {id, businessProfileId, inventoryDeductedAt: null}; retries replay the
//     original outcome without touching stock again; concurrent duplicates
//     converge on exactly one deduction.
//   • Tenant predicate at the DB statement: every decrement is scoped to the
//     effective business; a foreign ingredient aborts the WHOLE transaction
//     (full rollback — no partial writes, no foreign writes).
// =============================================================================
const request = require('supertest');
const express = require('express');

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = global.__R36_RC_USER__; next(); },
    adminOnly: (_req, _res, next) => next(),
}));
jest.mock('../middleware/banGuardMiddleware', () => {
    const actual = jest.requireActual('../middleware/banGuardMiddleware');
    return { ...actual, protectActive: (req, _res, next) => { req.user = global.__R36_RC_USER__; next(); } };
});

const { PrismaClient } = require('@prisma/client');
const businessOSRoutes = require('../routes/businessOSRoutes');
const { seedBusiness, seedUser } = require('./helpers/factories');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r36/P1 — restaurant recipe deduction rail', () => {
    let db;
    let app;
    let A, B;
    let cust;
    let itemA, itemB;
    let productA;

    const asUser = (user) => { global.__R36_RC_USER__ = user ? { id: user.id } : null; };
    const deduct = (orderId) => request(app).post(`/api/business-os/restaurant/inventory/deduct/${orderId}`).send({});

    const mkItem = (biz, name, stock) => db.inventoryItem.create({
        data: { businessProfileId: biz.id, name, unit: 'kg', currentStock: stock, costPerUnit: 10 },
    });
    // Legacy single-item orders carry NO quantity field — the deduction
    // route's per-order quantity is 1 (order.quantity || 1).
    const mkOrder = async (biz, product) => db.businessOrder.create({
        data: {
            businessProfileId: biz.id, customerId: cust.id, productId: product.id,
            orderRef: `ORD-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
            title: 'Meal', amountUsdc: 20,
        },
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
        global.__R36_RC_USER__ = null;
        await db.$executeRawUnsafe('TRUNCATE TABLE "RecipeIngredient", "InventoryItem", "BusinessOrder", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE');
    });
    beforeEach(async () => {
        A = await seedBusiness(db);
        B = await seedBusiness(db);
        cust = await seedUser(db);
        asUser(A.owner);

        itemA = await mkItem(A.biz, 'Beef', 100);
        itemB = await mkItem(B.biz, 'Foreign Beef', 100);

        productA = await db.businessProduct.create({
            data: {
                businessProfileId: A.biz.id, name: 'Burger', slug: `burger-${Date.now()}`,
                priceUsdc: 20, isActive: true,
                recipeIngredients: {
                    create: [
                        { inventoryItemId: itemA.id, quantityRequired: 0.5 },
                        { inventoryItemId: itemB.id, quantityRequired: 0.25 }, // poisoned cross-business link
                    ],
                },
            },
        });
    });

    test('CROSS-BUSINESS recipe link: deduction fails closed, NO stock moves in either business', async () => {
        const order = await mkOrder(A.biz, productA);
        const res = await deduct(order.id);
        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(/invalid for this business/i);

        expect((await db.inventoryItem.findUnique({ where: { id: itemA.id } })).currentStock).toBe(100);
        expect((await db.inventoryItem.findUnique({ where: { id: itemB.id } })).currentStock).toBe(100);
        // No per-order claim was left behind either.
        expect((await db.businessOrder.findUnique({ where: { id: order.id } })).inventoryDeductedAt).toBeNull();
    });

    test('happy path: clean recipe deducts exactly the implied quantities', async () => {
        const item2 = await mkItem(A.biz, 'Bun', 200);
        const product = await db.businessProduct.create({
            data: {
                businessProfileId: A.biz.id, name: 'Clean Burger', slug: `cb-${Date.now()}`,
                priceUsdc: 20, isActive: true,
                recipeIngredients: {
                    create: [
                        { inventoryItemId: itemA.id, quantityRequired: 0.5 },
                        { inventoryItemId: item2.id, quantityRequired: 2 },
                    ],
                },
            },
        });
        const order = await mkOrder(A.biz, product);
        const res = await deduct(order.id);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.replay).toBeFalsy();
        expect((await db.inventoryItem.findUnique({ where: { id: itemA.id } })).currentStock).toBe(99.5); // 100 - 0.5*1
        expect((await db.inventoryItem.findUnique({ where: { id: item2.id } })).currentStock).toBe(198); // 200 - 2*1
    });

    test('DEDUCT-ONCE: a retry replays the outcome without a second deduction', async () => {
        const product = await db.businessProduct.create({
            data: {
                businessProfileId: A.biz.id, name: 'Solo Burger', slug: `sb-${Date.now()}`,
                priceUsdc: 20, isActive: true,
                recipeIngredients: { create: [{ inventoryItemId: itemA.id, quantityRequired: 1 }] },
            },
        });
        const order = await mkOrder(A.biz, product);

        const first = await deduct(order.id);
        expect(first.status).toBe(200);
        expect(first.body.replay).toBeFalsy();
        expect((await db.inventoryItem.findUnique({ where: { id: itemA.id } })).currentStock).toBe(99);

        const retry = await deduct(order.id);
        expect(retry.status).toBe(200);
        expect(retry.body.replay).toBe(true);
        expect(retry.body.message).toMatch(/already deducted/i);
        expect((await db.inventoryItem.findUnique({ where: { id: itemA.id } })).currentStock).toBe(99);
    });

    test('CONCURRENT duplicates converge on ONE deduction', async () => {
        const product = await db.businessProduct.create({
            data: {
                businessProfileId: A.biz.id, name: 'Race Burger', slug: `rb-${Date.now()}`,
                priceUsdc: 20, isActive: true,
                recipeIngredients: { create: [{ inventoryItemId: itemA.id, quantityRequired: 1 }] },
            },
        });
        const order = await mkOrder(A.biz, product);
        const results = await Promise.all([deduct(order.id), deduct(order.id), deduct(order.id)]);
        for (const r of results) {
            expect(r.status).toBe(200);
        }
        const replays = results.filter((r) => r.body.replay === true).length;
        const primaries = results.filter((r) => r.body.replay !== true).length;
        expect(primaries).toBe(1);
        expect(replays).toBe(2);
        expect((await db.inventoryItem.findUnique({ where: { id: itemA.id } })).currentStock).toBe(99);
    });

    test('mid-chain foreign ingredient (r34/D legacy guard) still rolls back EVERYTHING', async () => {
        // Simulate a poisoned link that bypassed the pre-check ordering:
        // the aggregate pre-check catches it here, but if it ever slips
        // through, the statement-level predicate must still abort the chain.
        const item2 = await mkItem(A.biz, 'Cheese', 50);
        const product = await db.businessProduct.create({
            data: {
                businessProfileId: A.biz.id, name: 'Poison Burger', slug: `pb-${Date.now()}`,
                priceUsdc: 20, isActive: true,
                recipeIngredients: {
                    create: [
                        { inventoryItemId: item2.id, quantityRequired: 1 },
                        { inventoryItemId: itemB.id, quantityRequired: 1 },
                    ],
                },
            },
        });
        const order = await mkOrder(A.biz, product);
        const res = await deduct(order.id);
        expect(res.status).toBe(409);
        expect((await db.inventoryItem.findUnique({ where: { id: item2.id } })).currentStock).toBe(50);
        expect((await db.inventoryItem.findUnique({ where: { id: itemB.id } })).currentStock).toBe(100);
        expect((await db.businessOrder.findUnique({ where: { id: order.id } })).inventoryDeductedAt).toBeNull();
    });

    test('an order of ANOTHER business → 404, no deduction', async () => {
        asUser(B.owner);
        const order = await mkOrder(A.biz, productA, 1); // A's order
        const res = await deduct(order.id);
        expect(res.status).toBe(404);
    });
});
