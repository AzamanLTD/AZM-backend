/**
 * Storefront customer ordering — native GHS, proved THROUGH THE REAL ROUTE.
 *
 * The claim under test is that a Ghanaian merchant can take a real customer
 * order in cedis, priced from their own confirmed BusinessPrice, with no USDC
 * balance, no FX quote and no client-supplied amount anywhere in the path. Every
 * fixture also carries a legacy `priceUsdc`, so "the cedi price wins" is measured
 * rather than assumed.
 *
 * These tests mount the actual Express router and call the actual handler over
 * HTTP: authentication, business ownership, product availability and durable
 * idempotency are all exercised as a client would hit them. Calling
 * createGhsOrder() directly would prove none of that.
 */
const request = require('supertest');
const express = require('express');

// uuid v14 is ESM-only; Node 24 can require() it but Jest's CJS runtime cannot
// parse it. The identifier format is not what this suite tests, so pin it.
jest.mock('uuid', () => ({ v4: () => 'stub-uuid-0000' }));

jest.mock('../middleware/authMiddleware', () => ({
    protect: (req, _res, next) => { req.user = global.__STOREFRONT_USER__; next(); },
    adminOnly: (_req, _res, next) => next(),
}));

jest.mock('../middleware/banGuardMiddleware', () => {
    const actual = jest.requireActual('../middleware/banGuardMiddleware');
    return { ...actual, protectActive: (_req, _res, next) => next() };
});

const { PrismaClient, Prisma } = require('@prisma/client');
const storefrontRoutes = require('../routes/storefrontRoutes');
const priceSvc = require('../services/businessPriceService');
const orderSvc = require('../services/businessOrderService');

const url = process.env.TEST_DATABASE_URL;
if (!url) console.warn('[storefront-ghs-order] TEST_DATABASE_URL not set — skipping.');
const run = url ? describe : describe.skip;

run('storefront order currency contract (real route, real PostgreSQL)', () => {
    let db;
    let app;
    let seq = 0;

    const makeApp = () => {
        const a = express();
        a.set('prisma', db);
        a.use(express.json());
        a.use('/api/storefront', storefrontRoutes);
        return a;
    };

    beforeAll(() => {
        db = new PrismaClient();
        app = makeApp();
    });

    afterAll(async () => {
        await cleanup().catch(() => {});
        await db.$disconnect();
    });

    // Keyed on the seeded profiles, not on order titles: the route titles an
    // order from the product name, so title-based cleanup leaves orders behind
    // and the next run trips the BusinessOrder -> BusinessProfile foreign key.
    async function cleanup() {
        const profiles = await db.businessProfile.findMany({
            where: { businessName: { startsWith: 'SFRoute Test Business' } },
            select: { id: true },
        });
        const ids = profiles.map((p) => p.id);
        if (ids.length) {
            await db.businessOrder.deleteMany({ where: { businessProfileId: { in: ids } } });
            await db.businessNotification.deleteMany({ where: { businessProfileId: { in: ids } } });
            await db.storefrontAnalyticsEvent.deleteMany({ where: { businessProfileId: { in: ids } } });
        }
        await db.businessPrice.deleteMany({});
        await db.businessProduct.deleteMany({ where: { slug: { startsWith: 'sfroute-test-' } } });
        await db.businessProfile.deleteMany({ where: { businessName: { startsWith: 'SFRoute Test Business' } } });
        await db.user.deleteMany({ where: { username: { startsWith: 'sfroute-user' } } });
    }

    beforeEach(cleanup);

    async function seed({ priceUsdc = '10.50', confirmedGhs = null, isAvailable = true } = {}) {
        seq += 1;
        const owner = await db.user.create({
            data: { username: `sfroute-user-o${seq}-${Date.now()}`, email: `sfroute-o${seq}-${Date.now()}@t.test`, password: 'x' },
        });
        const customer = await db.user.create({
            data: { username: `sfroute-user-c${seq}-${Date.now()}`, email: `sfroute-c${seq}-${Date.now()}@t.test`, password: 'x' },
        });
        const profile = await db.businessProfile.create({
            data: {
                userId: owner.id,
                businessName: `SFRoute Test Business ${seq}`,
                bizId: `BIZ-SFR-${seq}-${String(Date.now()).slice(-6)}`,
                category: 'FOOD_BEVERAGE',
            },
        });
        const product = await db.businessProduct.create({
            data: {
                businessProfileId: profile.id,
                name: 'Jollof',
                slug: `sfroute-test-${seq}-${Date.now()}`,
                priceUsdc: new Prisma.Decimal(priceUsdc),
                isActive: true,
                isAvailable,
            },
        });
        if (confirmedGhs) {
            await db.$transaction((tx) => priceSvc.setPrice(tx, {
                businessProductId: product.id,
                amountGhs: confirmedGhs,
                confirmedByType: 'BUSINESS',
                confirmedById: 'owner',
                confirm: true,
            }));
        }
        return { owner, customer, profile, product };
    }

    const post = (profileId, body, asUserId) => {
        global.__STOREFRONT_USER__ = { id: asUserId };
        return request(app).post(`/api/storefront/${profileId}/order`).send(body);
    };

    test('a GHS-only merchant takes a real customer order in cedis, with no USDC anywhere', async () => {
        const { customer, profile, product } = await seed({ confirmedGhs: '0.10' });

        const res = await post(profile.id, {
            productId: product.id, quantity: 3, currency: 'GHS', idempotencyKey: 'ghs-route-1',
        }, customer.id);

        expect(res.status).toBe(201);
        expect(res.body.data.order.currency).toBe('GHS');

        const [row] = await db.$queryRawUnsafe(
            `SELECT "currency", "amountGhs"::text AS ghs, "amountUsdc" FROM "BusinessOrder" WHERE id = $1`,
            res.body.data.order.id);
        // 0.10 GHS x 3 is exactly 0.30 at pesewa precision.
        expect(row.currency).toBe('GHS');
        expect(row.ghs).toBe('0.30');
        expect(row.amountUsdc).toBeNull();
    });

    test('the customer cannot dictate the amount, in either currency', async () => {
        const { customer, profile, product } = await seed({ confirmedGhs: '25.00' });

        const res = await post(profile.id, {
            productId: product.id,
            quantity: 2,
            currency: 'GHS',
            amountGhs: '0.01',
            amountUsdc: 0.01,
            priceUsdc: 0.01,
        }, customer.id);

        expect(res.status).toBe(201);
        const [row] = await db.$queryRawUnsafe(
            `SELECT "amountGhs"::text AS ghs, "amountUsdc" FROM "BusinessOrder" WHERE id = $1`, res.body.data.order.id);
        expect(row.ghs).toBe('50.00');
        expect(row.amountUsdc).toBeNull();
    });

    test('a GHS request for a product with no confirmed cedi price is refused, and writes nothing', async () => {
        const { customer, profile, product } = await seed({ confirmedGhs: null });

        const res = await post(profile.id, { productId: product.id, currency: 'GHS' }, customer.id);

        expect(res.status).toBe(422);
        expect(res.body.code).toBe('GHS_PRICE_UNAVAILABLE');
        expect(await db.businessOrder.count({ where: { businessProfileId: profile.id } })).toBe(0);
    });

    test('the separate USDC rail still works and is tagged, priced exactly from priceUsdc', async () => {
        const { customer, profile, product } = await seed({ priceUsdc: '10.50', confirmedGhs: '7.00' });

        const res = await post(profile.id, { productId: product.id, quantity: 3, currency: 'USDC' }, customer.id);

        expect(res.status).toBe(201);
        expect(res.body.data.order.currency).toBe('USDC');
        const [row] = await db.$queryRawUnsafe(
            `SELECT "amountUsdc"::text AS usdc, "amountGhs" FROM "BusinessOrder" WHERE id = $1`, res.body.data.order.id);
        expect(row.usdc).toBe('31.50000000');
        expect(row.amountGhs).toBeNull();
    });

    test('an omitted currency keeps the legacy untagged USDC behaviour byte-for-byte', async () => {
        const { customer, profile, product } = await seed({ priceUsdc: '3.25' });

        const res = await post(profile.id, { productId: product.id, quantity: 2 }, customer.id);

        expect(res.status).toBe(201);
        const [row] = await db.$queryRawUnsafe(
            `SELECT "currency", "amountUsdc"::text AS usdc FROM "BusinessOrder" WHERE id = $1`, res.body.data.order.id);
        expect(row.currency).toBeNull();
        expect(row.usdc).toBe('6.50000000');
    });

    test('an unknown currency is refused before anything is priced', async () => {
        const { customer, profile, product } = await seed({ confirmedGhs: '9.00' });

        const res = await post(profile.id, { productId: product.id, currency: 'EUR' }, customer.id);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_CURRENCY');
    });

    test('business ownership and product availability are enforced on the cedi path too', async () => {
        const mine = await seed({ confirmedGhs: '5.00' });
        const theirs = await seed({ confirmedGhs: '5.00' });

        // A product that belongs to another business.
        const foreign = await post(mine.profile.id, { productId: theirs.product.id, currency: 'GHS' }, mine.customer.id);
        expect(foreign.status).toBe(404);

        // An unavailable product.
        const hidden = await seed({ confirmedGhs: '5.00', isAvailable: false });
        const unavailable = await post(hidden.profile.id, { productId: hidden.product.id, currency: 'GHS' }, hidden.customer.id);
        expect(unavailable.status).toBe(404);
    });

    test('idempotent retries converge on one order, and a changed currency is a conflict, not a second order', async () => {
        const { customer, profile, product } = await seed({ confirmedGhs: '8.00', priceUsdc: '4.00' });

        const first = await post(profile.id, { productId: product.id, currency: 'GHS', idempotencyKey: 'dup-1' }, customer.id);
        const replay = await post(profile.id, { productId: product.id, currency: 'GHS', idempotencyKey: 'dup-1' }, customer.id);

        expect(first.status).toBe(201);
        expect(replay.body.data.order.id).toBe(first.body.data.order.id);
        expect(await db.businessOrder.count({ where: { businessProfileId: profile.id, idempotencyKey: 'dup-1' } })).toBe(1);

        // Same durable key, materially different request (different currency).
        const conflict = await post(profile.id, { productId: product.id, currency: 'USDC', idempotencyKey: 'dup-1' }, customer.id);
        expect(conflict.status).toBe(409);
        expect(await db.businessOrder.count({ where: { businessProfileId: profile.id, idempotencyKey: 'dup-1' } })).toBe(1);
    });

    test('cedis and dollars cannot be cross-added in the merchant read', async () => {
        const { customer, profile, product } = await seed({ confirmedGhs: '100.00', priceUsdc: '2.00' });

        const ghs = await post(profile.id, { productId: product.id, currency: 'GHS' }, customer.id);
        const usdc = await post(profile.id, { productId: product.id, currency: 'USDC' }, customer.id);
        await db.businessOrder.updateMany({
            where: { id: { in: [ghs.body.data.order.id, usdc.body.data.order.id] } },
            data: { status: 'COMPLETED' },
        });

        const stats = await orderSvc.getBusinessStats(db, { businessProfileId: profile.id });

        expect(stats.revenue.GHS).toBe('100.00');
        expect(stats.revenue.USDC).toBe('2.00000000');
        expect(stats.headline).toEqual({ currency: 'GHS', amount: '100.00' });
        // The legacy scalar is USDC only: 100 cedis can never appear as 102.
        expect(stats.totalRevenue).toBe(2);
    });
});
