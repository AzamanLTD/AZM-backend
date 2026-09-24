// __tests__/r34-route-authority-sweep.test.js
// =============================================================================
// r34 — ROUTE AUTHORITY SWEEP (real PostgreSQL).
//
// Covers the r34 review findings against PR #303's head branch:
//   P0-5  the /employees/:id/status and /employees/:id/role routes are
//         independently declared at module-load time (the registration defect
//         that nested the role route inside the status callback is dead);
//   A     recurring-expense PATCH/DELETE carry the tenant predicate at the
//         mutation boundary (A-vs-B integration proofs);
//   B     promotion PATCH/DELETE and review respond are tenant-constrained
//         (and the promotion PATCH can no longer inject arbitrary fields,
//         including businessProfileId, via a body spread);
//   C     recipe link/unlink prove business ownership of BOTH related objects
//         before mutation, reject malformed quantities, and converge under
//         concurrent duplicate links;
//   D     legacy inventory deduction defends the mutation boundary: a poisoned
//         (cross-business) recipe fails closed with no mutation at all, and a
//         mid-transaction failure rolls back already-decremented ingredients.
// =============================================================================
const express = require('express');
const request = require('supertest');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

jest.mock('../middleware/authMiddleware', () => ({
    // The identity is injected by the harness; the route's own context
    // resolution (requirePermission / getBusinessProfileId) stays REAL.
    protect: (req, _res, next) => {
        req.user = global.__R34_USER;
        next();
    },
}));
jest.mock('../middleware/banGuardMiddleware', () => ({
    protectActive: (_req, _res, next) => next(),
}));

const router = require('../routes/businessOSRoutes');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

let db;
let seq = 0;
const uniq = () => `r34-${Date.now()}-${++seq}`;

function makeApp() {
    const app = express();
    app.use(express.json());
    app.set('prisma', db);
    app.use('/api/business-os', router);
    return app;
}

async function mkUser(prefix) {
    const hash = await bcrypt.hash('TestPass1!secure', 10);
    const id = uniq();
    return db.user.create({
        data: {
            username: `${prefix}_${id}`,
            email: `${id}@test.com`,
            password: hash,
            azamanId: `AZM-${id}`,
            role: 'VENDOR',
        },
    });
}

async function mkBusiness(owner, name) {
    return db.businessProfile.create({
        data: {
            userId: owner.id,
            bizId: `BIZ-${uniq()}`,
            businessName: `${name}`,
            category: 'HOSPITALITY',
            isVerified: true,
            kybStatus: 'VERIFIED',
        },
    });
}

async function mkEmployee(businessProfileId, userId) {
    return db.businessEmployee.create({
        data: {
            businessProfileId,
            userId,
            role: 'STAFF',
            status: 'ACTIVE',
            permissions: ['shifts.view'],
        },
    });
}

function as(user) {
    global.__R34_USER = user ? { id: user.id, username: user.username, role: user.role } : null;
    return makeApp();
}

const api = (app) => request(app);

run('r34 — route authority sweep (real PostgreSQL)', () => {
    let ownerA, ownerB, businessA, businessB, noBizUser, empA;

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        db = new PrismaClient();
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(async () => {
        global.__R34_USER = null;
        await db.$executeRawUnsafe(
            'TRUNCATE TABLE "Shift", "BusinessEmployee", "RecurringExpenseTemplate", "BusinessPromotion", "BusinessReview", "BusinessOrder", "RecipeIngredient", "InventoryItem", "BusinessProduct", "BusinessProfile", "User" RESTART IDENTITY CASCADE'
        );
    });

    beforeEach(async () => {
        ownerA = await mkUser('ownA');
        ownerB = await mkUser('ownB');
        noBizUser = await mkUser('noBiz');
        businessA = await mkBusiness(ownerA, 'Sweep Biz A');
        businessB = await mkBusiness(ownerB, 'Sweep Biz B');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // P0-5 — route registration defect
    // ═══════════════════════════════════════════════════════════════════════
    test('P0-5a: both employee authority routes are registered at module load, exactly once each', () => {
        const paths = router.stack
            .filter((l) => l.route)
            .map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
        const status = paths.filter((p) => p === 'patch /employees/:id/status');
        const role = paths.filter((p) => p === 'patch /employees/:id/role');
        expect(status).toHaveLength(1);
        expect(role).toHaveLength(1);
    });

    test('P0-5b: status calls never (re)register the role route — both endpoints work independently on a fresh app', async () => {
        const empUser = await mkUser('empU');
        empA = await mkEmployee(businessA.id, empUser.id);

        // Status endpoint works on a fresh app (no prior role call).
        const app = as(ownerA);
        const layerCount = () => router.stack.filter((l) => l.route?.path === '/employees/:id/role').length;
        expect(layerCount()).toBe(1);

        const s1 = await api(app).patch(`/api/business-os/employees/${empA.id}/status`).send({ status: 'SUSPENDED' });
        expect(s1.status).toBe(200);
        expect(s1.body.employee.status).toBe('SUSPENDED');

        const s2 = await api(app).patch(`/api/business-os/employees/${empA.id}/status`).send({ status: 'ACTIVE' });
        expect(s2.status).toBe(200);
        expect(s2.body.employee.status).toBe('ACTIVE');

        // Repeated status calls did not re-register the role route.
        expect(layerCount()).toBe(1);

        // Role endpoint responds independently (no prior role call needed on
        // this or any fresh process — proven by the module-load test above).
        const r1 = await api(as(ownerA)).patch(`/api/business-os/employees/${empA.id}/role`).send({ role: 'MANAGER' });
        expect(r1.status).toBe(200);
        expect(r1.body.employee.role).toBe('MANAGER');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // A — recurring expense templates
    // ═══════════════════════════════════════════════════════════════════════
    test('A1: owner A can update and delete its own recurring template', async () => {
        const t = await db.recurringExpenseTemplate.create({
            data: { businessProfileId: businessA.id, name: 'Rent', category: 'FACILITIES', amount: 120, frequency: 'MONTHLY', dayOfMonth: 1 },
        });
        const app = as(ownerA);
        const upd = await api(app).patch(`/api/business-os/finance/recurring/${t.id}`).send({ name: 'Rent 2026', amount: '130.50' });
        expect(upd.status).toBe(200);
        expect(upd.body.data.name).toBe('Rent 2026');
        expect(Number(upd.body.data.amount)).toBe(130.5);

        const del = await api(app).delete(`/api/business-os/finance/recurring/${t.id}`);
        expect(del.status).toBe(200);
        expect(await db.recurringExpenseTemplate.findUnique({ where: { id: t.id } })).toBeNull();
    });

    test('A2: owner A cannot update/delete business B templates — fails closed, B untouched', async () => {
        const tB = await db.recurringExpenseTemplate.create({
            data: { businessProfileId: businessB.id, name: 'B Rent', category: 'FACILITIES', amount: 99, frequency: 'WEEKLY', dayOfWeek: 1 },
        });
        const app = as(ownerA);

        const upd = await api(app).patch(`/api/business-os/finance/recurring/${tB.id}`).send({ name: 'HACKED' });
        expect(upd.status).toBe(404);
        const afterPatch = await db.recurringExpenseTemplate.findUnique({ where: { id: tB.id } });
        expect(afterPatch.name).toBe('B Rent');

        const del = await api(app).delete(`/api/business-os/finance/recurring/${tB.id}`);
        expect(del.status).toBe(404);
        expect(await db.recurringExpenseTemplate.findUnique({ where: { id: tB.id } })).not.toBeNull();

        const unknown = await api(app).delete('/api/business-os/finance/recurring/does-not-exist');
        expect(unknown.status).toBe(404);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // B — promotions + review respond
    // ═══════════════════════════════════════════════════════════════════════
    test('B1: promotion PATCH/DELETE are tenant-constrained and reject field injection', async () => {
        const pA = await db.businessPromotion.create({
            data: { businessProfileId: businessA.id, name: 'A Sale', discountType: 'PERCENT', discountValue: 10, scope: 'ORDER', startDate: new Date(), endDate: new Date(Date.now() + 86400000) },
        });
        const pB = await db.businessPromotion.create({
            data: { businessProfileId: businessB.id, name: 'B Sale', discountType: 'PERCENT', discountValue: 20, scope: 'ORDER', startDate: new Date(), endDate: new Date(Date.now() + 86400000) },
        });
        const app = as(ownerA);

        // Own promotion updates fine; a businessProfileId injection attempt
        // must not move the promotion to business B.
        const upd = await api(app).patch(`/api/business-os/marketing/promotions/${pA.id}`)
            .send({ name: 'A Sale v2', discountValue: '15', businessProfileId: businessB.id, usageCount: 999 });
        expect(upd.status).toBe(200);
        const moved = await db.businessPromotion.findUnique({ where: { id: pA.id } });
        expect(moved.businessProfileId).toBe(businessA.id);
        expect(moved.name).toBe('A Sale v2');
        expect(moved.usageCount).toBe(0); // not whitelisted — ignored

        // Foreign promotion: PATCH and DELETE both fail closed.
        const updB = await api(app).patch(`/api/business-os/marketing/promotions/${pB.id}`).send({ name: 'HACKED' });
        expect(updB.status).toBe(404);
        const delB = await api(app).delete(`/api/business-os/marketing/promotions/${pB.id}`);
        expect(delB.status).toBe(404);
        const bRow = await db.businessPromotion.findUnique({ where: { id: pB.id } });
        expect(bRow.isActive).toBe(true);
        expect(bRow.name).toBe('B Sale');

        // Own promotion soft-deletes.
        const delA = await api(app).delete(`/api/business-os/marketing/promotions/${pA.id}`);
        expect(delA.status).toBe(200);
        expect((await db.businessPromotion.findUnique({ where: { id: pA.id } })).isActive).toBe(false);
    });

    test('B2: review respond is tenant-constrained', async () => {
        const reviewer = await mkUser('rev');
        const rA = await db.businessReview.create({
            data: { businessProfileId: businessA.id, reviewerId: reviewer.id, rating: 5, sourceType: 'ORDER' },
        });
        const rB = await db.businessReview.create({
            data: { businessProfileId: businessB.id, reviewerId: reviewer.id, rating: 3, sourceType: 'ORDER' },
        });
        const app = as(ownerA);

        const own = await api(app).post(`/api/business-os/marketing/reviews/${rA.id}/respond`).send({ response: 'Thank you!' });
        expect(own.status).toBe(200);
        expect(own.body.data.businessResponse).toBe('Thank you!');

        const foreign = await api(app).post(`/api/business-os/marketing/reviews/${rB.id}/respond`).send({ response: 'HACKED' });
        expect(foreign.status).toBe(404);
        const bRow = await db.businessReview.findUnique({ where: { id: rB.id } });
        expect(bRow.businessResponse).toBeNull();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // C — recipe link authority
    // ═══════════════════════════════════════════════════════════════════════
    async function mkRecipeWorld() {
        const productA = await db.businessProduct.create({
            data: { businessProfileId: businessA.id, name: `Jollof ${uniq()}`, priceUsdc: 20, slug: `sl-a-${uniq()}` },
        });
        const productB = await db.businessProduct.create({
            data: { businessProfileId: businessB.id, name: `Banku ${uniq()}`, priceUsdc: 15, slug: `sl-b-${uniq()}` },
        });
        const itemA = await db.inventoryItem.create({
            data: { businessProfileId: businessA.id, name: `Rice ${uniq()}`, unit: 'kg', currentStock: 100, minimumStock: 0, costPerUnit: 2.5 },
        });
        const itemB = await db.inventoryItem.create({
            data: { businessProfileId: businessB.id, name: `Corn ${uniq()}`, unit: 'kg', currentStock: 50, minimumStock: 0, costPerUnit: 1.5 },
        });
        return { productA, productB, itemA, itemB };
    }

    test('C1: same-business link succeeds; foreign product and foreign item both fail closed', async () => {
        const { productA, productB, itemA, itemB } = await mkRecipeWorld();
        const app = as(ownerA);

        const ok = await api(app).post(`/api/business-os/restaurant/recipes/${productA.id}/link`)
            .send({ inventoryItemId: itemA.id, quantityRequired: '0.5' });
        expect(ok.status).toBe(200);
        expect(ok.body.link.quantityRequired).toBe(0.5);

        const foreignProduct = await api(app).post(`/api/business-os/restaurant/recipes/${productB.id}/link`)
            .send({ inventoryItemId: itemA.id, quantityRequired: 1 });
        expect(foreignProduct.status).toBe(404);
        expect(await db.recipeIngredient.findFirst({ where: { productId: productB.id } })).toBeNull();

        const foreignItem = await api(app).post(`/api/business-os/restaurant/recipes/${productA.id}/link`)
            .send({ inventoryItemId: itemB.id, quantityRequired: 1 });
        expect(foreignItem.status).toBe(404);
        expect(await db.recipeIngredient.findFirst({ where: { inventoryItemId: itemB.id } })).toBeNull();
    });

    test('C2: malformed quantities are rejected explicitly', async () => {
        const { productA, itemA } = await mkRecipeWorld();
        const app = as(ownerA);
        for (const bad of [0, -1, NaN, Infinity, 'abc', 1.123456789, { v: 1 }]) {
            const r = await api(app).post(`/api/business-os/restaurant/recipes/${productA.id}/link`)
                .send({ inventoryItemId: itemA.id, quantityRequired: bad });
            expect(r.status).toBe(400);
        }
        expect(await db.recipeIngredient.findFirst({ where: { productId: productA.id } })).toBeNull();
    });

    test('C3: unlink is tenant-safe — foreign links cannot be deleted; own links can', async () => {
        const { productA, itemA } = await mkRecipeWorld();
        // B's own product/item/link, untouchable from A.
        const productB = await db.businessProduct.create({
            data: { businessProfileId: businessB.id, name: `Banku2 ${uniq()}`, priceUsdc: 15, slug: `sl-b2-${uniq()}` },
        });
        const itemB = await db.inventoryItem.create({
            data: { businessProfileId: businessB.id, name: `Corn2 ${uniq()}`, unit: 'kg', currentStock: 50, minimumStock: 0, costPerUnit: 1.5 },
        });
        await db.recipeIngredient.create({ data: { productId: productB.id, inventoryItemId: itemB.id, quantityRequired: 2 } });
        const app = as(ownerA);

        const foreign = await api(app).delete(`/api/business-os/restaurant/recipes/${productB.id}/link/${itemB.id}`);
        expect(foreign.status).toBe(404);
        expect(await db.recipeIngredient.findFirst({ where: { productId: productB.id } })).not.toBeNull();

        // A creates and then deletes its own link.
        await db.recipeIngredient.create({ data: { productId: productA.id, inventoryItemId: itemA.id, quantityRequired: 1 } });
        const own = await api(app).delete(`/api/business-os/restaurant/recipes/${productA.id}/link/${itemA.id}`);
        expect(own.status).toBe(200);
        expect(await db.recipeIngredient.findFirst({ where: { productId: productA.id } })).toBeNull();
    });

    test('C4: concurrent duplicate link requests converge on one row', async () => {
        const { productA, itemA } = await mkRecipeWorld();
        const app = as(ownerA);
        const results = await Promise.all([
            api(app).post(`/api/business-os/restaurant/recipes/${productA.id}/link`).send({ inventoryItemId: itemA.id, quantityRequired: 1 }),
            api(app).post(`/api/business-os/restaurant/recipes/${productA.id}/link`).send({ inventoryItemId: itemA.id, quantityRequired: 1 }),
            api(app).post(`/api/business-os/restaurant/recipes/${productA.id}/link`).send({ inventoryItemId: itemA.id, quantityRequired: 1 }),
        ]);
        results.forEach((r) => expect(r.status).toBe(200));
        const links = await db.recipeIngredient.findMany({ where: { productId: productA.id } });
        expect(links).toHaveLength(1);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // D — inventory deduction defends the downstream authority
    // ═══════════════════════════════════════════════════════════════════════
    async function mkDeductWorld() {
        const customer = await mkUser('cust');
        const productA = await db.businessProduct.create({
            data: { businessProfileId: businessA.id, name: `Waakye ${uniq()}`, priceUsdc: 25, slug: `sl-d-${uniq()}` },
        });
        const itemA = await db.inventoryItem.create({
            data: { businessProfileId: businessA.id, name: `Beans ${uniq()}`, unit: 'kg', currentStock: 100, minimumStock: 0, costPerUnit: 3 },
        });
        const order = await db.businessOrder.create({
            data: {
                businessProfileId: businessA.id, customerId: customer.id, productId: productA.id,
                orderRef: `ORD-${uniq()}`, title: 'Waakye plate', amountUsdc: 25, status: 'PAID',
            },
        });
        return { customer, productA, itemA, order };
    }

    test('D1: poisoned cross-business recipe fails closed with zero mutation', async () => {
        const { productA, itemA, order } = await mkDeductWorld();
        const itemB = await db.inventoryItem.create({
            data: { businessProfileId: businessB.id, name: `Foreign Spice ${uniq()}`, unit: 'kg', currentStock: 40, minimumStock: 0, costPerUnit: 1 },
        });
        await db.recipeIngredient.create({ data: { productId: productA.id, inventoryItemId: itemA.id, quantityRequired: 0.5 } });
        // Historical poisoning: a cross-business link created outside the
        // (now hardened) link route.
        await db.recipeIngredient.create({ data: { productId: productA.id, inventoryItemId: itemB.id, quantityRequired: 0.2 } });

        const res = await api(as(ownerA)).post(`/api/business-os/restaurant/inventory/deduct/${order.id}`);
        expect(res.status).toBe(409);

        // NO mutation happened — neither this business's item nor the
        // foreign business's item moved.
        expect((await db.inventoryItem.findUnique({ where: { id: itemA.id } })).currentStock).toBe(100);
        expect((await db.inventoryItem.findUnique({ where: { id: itemB.id } })).currentStock).toBe(40);
    });

    test('D2: normal same-business deduction decrements every ingredient', async () => {
        const { productA, itemA, order } = await mkDeductWorld();
        const itemA2 = await db.inventoryItem.create({
            data: { businessProfileId: businessA.id, name: `Gari ${uniq()}`, unit: 'kg', currentStock: 60, minimumStock: 0, costPerUnit: 1 },
        });
        await db.recipeIngredient.create({ data: { productId: productA.id, inventoryItemId: itemA.id, quantityRequired: 0.5 } });
        await db.recipeIngredient.create({ data: { productId: productA.id, inventoryItemId: itemA2.id, quantityRequired: 0.25 } });

        const res = await api(as(ownerA)).post(`/api/business-os/restaurant/inventory/deduct/${order.id}`);
        expect(res.status).toBe(200);
        // orders have no quantity column: the handler's qty defaults to 1
        expect((await db.inventoryItem.findUnique({ where: { id: itemA.id } })).currentStock).toBe(99.5);
        expect((await db.inventoryItem.findUnique({ where: { id: itemA2.id } })).currentStock).toBe(59.75);
    });

    test('D3: a mid-transaction failure rolls back already-decremented ingredients', async () => {
        const { productA, itemA, order } = await mkDeductWorld();
        const itemBad = await db.inventoryItem.create({
            data: { businessProfileId: businessA.id, name: `Rotten ${uniq()}`, unit: 'kg', currentStock: 10, minimumStock: 0, costPerUnit: 1 },
        });
        await db.recipeIngredient.create({ data: { productId: productA.id, inventoryItemId: itemA.id, quantityRequired: 0.5 } });
        const badLink = await db.recipeIngredient.create({ data: { productId: productA.id, inventoryItemId: itemBad.id, quantityRequired: 1 } });
        // Direct historical corruption (pre-dating the r34 quantity guard):
        // a NaN requirement makes the SECOND decrement throw inside the
        // transaction — after the FIRST decrement already succeeded.
        await db.$executeRawUnsafe(`UPDATE "RecipeIngredient" SET "quantityRequired" = 'NaN'::float8 WHERE id = '${badLink.id}'`);

        const res = await api(as(ownerA)).post(`/api/business-os/restaurant/inventory/deduct/${order.id}`);
        expect(res.status).toBe(400);

        // The first ingredient's decrement was rolled back with the
        // transaction: stock is exactly where it started.
        expect((await db.inventoryItem.findUnique({ where: { id: itemA.id } })).currentStock).toBe(100);
        expect((await db.inventoryItem.findUnique({ where: { id: itemBad.id } })).currentStock).toBe(10);
    });

    test('D4: deduction for a foreign business order fails closed', async () => {
        const { productA, itemA, order } = await mkDeductWorld();
        const orderB = await db.businessOrder.create({
            data: {
                businessProfileId: businessB.id, customerId: order.customerId, productId: productA.id,
                orderRef: `ORD-${uniq()}`, title: 'Foreign order', amountUsdc: 25, status: 'PAID',
            },
        });
        await db.recipeIngredient.create({ data: { productId: productA.id, inventoryItemId: itemA.id, quantityRequired: 1 } });

        // B's order, but the recipe links A's item: the poisoned-recipe
        // guard fails closed with 409 (no mutation).
        const resB = await api(as(ownerB)).post(`/api/business-os/restaurant/inventory/deduct/${orderB.id}`);
        expect(resB.status).toBe(409);
        expect((await db.inventoryItem.findUnique({ where: { id: itemA.id } })).currentStock).toBe(100);

        // A cannot even see B's order: tenant-scoped 404, no mutation.
        const resA = await api(as(ownerA)).post(`/api/business-os/restaurant/inventory/deduct/${orderB.id}`);
        expect(resA.status).toBe(404);
        expect((await db.inventoryItem.findUnique({ where: { id: itemA.id } })).currentStock).toBe(100);
    });
});
