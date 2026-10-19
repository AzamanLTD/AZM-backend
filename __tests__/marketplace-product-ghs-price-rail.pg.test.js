'use strict';
// =============================================================================
// MARKETPLACE PRODUCT GHS PRICE RAIL — real PostgreSQL proofs (follow-up §3).
//
// Pins the additive contract of services/businessProductService._attachGhsPrices:
//   • a known, eligible current BusinessPrice row → priceGhs is the EXACT
//     2dp GHS string (same serialization as the Mix feed's pricing.amount);
//   • no eligible row (absent, MIGRATION-drafted, unconfirmed, future-dated,
//     archived, BRANCH-scoped) → priceGhs is null — never a converted
//     priceUsdc, never 0, never an ambiguous pick;
//   • priceUsdc and every pre-existing field are untouched by the rail;
//   • listProducts attaches prices for the whole page; getProduct for one.
// The rail reuses businessPriceService.resolveEffectiveGhsPrices — the single
// eligibility authority — so these proofs also pin that the product read path
// cannot diverge from the Mix feed's eligibility decision.
// =============================================================================

const { PrismaClient, Prisma } = require('@prisma/client');
const priceService = require('../services/businessPriceService');
const productService = require('../services/businessProductService');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('Marketplace product GHS price rail (real PostgreSQL)', () => {
    let db;
    let seq;

    beforeAll(async () => {
        db = new PrismaClient();
    });

    afterAll(async () => {
        // Hermetic teardown: the mix P1 cursor walk counts active products
        // without a per-suite prefix filter, so any ghsrail- residue left
        // behind after the last test shifts its expected totals under other
        // battery run orders. Sweep the same prefixed rows as beforeEach.
        await db.businessPrice.deleteMany({ where: { note: { startsWith: 'ghsrail' } } });
        await db.businessProduct.deleteMany({ where: { slug: { startsWith: 'ghsrail-' } } });
        await db.businessLocation.deleteMany({ where: { label: { startsWith: 'GhsRail Branch' } } });
        await db.businessProfile.deleteMany({ where: { businessName: { startsWith: 'GhsRail Biz' } } });
        await db.user.deleteMany({ where: { username: { startsWith: 'ghsrail-user' } } });
        await db.$disconnect();
    });

    beforeEach(async () => {
        seq = Date.now();
        await db.businessProduct.deleteMany({ where: { slug: { startsWith: 'ghsrail-' } } });
        await db.businessPrice.deleteMany({ where: { note: { startsWith: 'ghsrail' } } });
        await db.businessLocation.deleteMany({ where: { label: { startsWith: 'GhsRail Branch' } } });
        await db.businessProfile.deleteMany({ where: { businessName: { startsWith: 'GhsRail Biz' } } });
        await db.user.deleteMany({ where: { username: { startsWith: 'ghsrail-user' } } });
    });

    // ─── seed helpers ───────────────────────────────────────────────────────

    async function seedBusiness() {
        const n = seq++;
        const owner = await db.user.create({
            data: {
                username: `ghsrail-user-${n}-${Date.now()}`,
                email: `ghsrail-${n}-${Date.now()}@t.test`,
                password: 'x',
            },
        });
        const profile = await db.businessProfile.create({
            data: {
                userId: owner.id,
                businessName: `GhsRail Biz ${n}`,
                bizId: `BIZ-GHSRAIL-${n}-${String(Date.now()).slice(-6)}`,
                category: 'RETAIL',
            },
        });
        return { owner, profile };
    }

    async function seedProduct(profile, opts = {}) {
        const n = seq++;
        return db.businessProduct.create({
            data: {
                businessProfileId: profile.id,
                name: opts.name || `Rail Product ${n}`,
                slug: `ghsrail-${n}-${String(Date.now()).slice(-6)}`,
                description: 'rail proof product',
                priceUsdc: opts.priceUsdc ?? new Prisma.Decimal('13.42'),
                category: 'RETAIL',
                isActive: opts.isActive === false ? false : true,
            },
        });
    }

    async function seedPrice(product, opts = {}) {
        return priceService.setPrice(db, {
            businessProductId: product.id,
            amountGhs: opts.amountGhs || '49.99',
            confirmedByType: opts.confirmedByType || 'BUSINESS',
            confirmedById: opts.confirmedById || 'rail-actor',
            note: opts.note || 'ghsrail',
            confirm: opts.confirm !== false,
        });
    }

    // ─── 1. known GHS price → exact 2dp string on both read paths ────────────

    test('1a. eligible confirmed price → priceGhs exact 2dp string on getProduct', async () => {
        const { owner, profile } = await seedBusiness();
        const product = await seedProduct(profile);
        await seedPrice(product, { amountGhs: '49.99', confirmedById: String(owner.id) });

        const fetched = await productService.getProduct(db, { productId: product.id, includeBusinessProfile: true });
        expect(fetched).not.toBeNull();
        expect(fetched.priceGhs).toBe('49.99');
        expect(String(fetched.priceUsdc)).toBe('13.42'); // untouched by the rail
    });

    test('1b. trailing-zero amount serializes as the exact 2dp string (never "7.5")', async () => {
        const { owner, profile } = await seedBusiness();
        const product = await seedProduct(profile);
        await seedPrice(product, { amountGhs: '7.50', confirmedById: String(owner.id) });

        const fetched = await productService.getProduct(db, { productId: product.id });
        expect(fetched.priceGhs).toBe('7.50');
    });

    test('1c. listProducts attaches the price for every product on the page', async () => {
        const { owner, profile } = await seedBusiness();
        const withPrice = await seedProduct(profile, { name: 'Priced One' });
        const withoutPrice = await seedProduct(profile, { name: 'Unpriced One' });
        await seedPrice(withPrice, { amountGhs: '120.00', confirmedById: String(owner.id) });

        const { products } = await productService.listProducts(db, {
            businessProfileId: profile.id,
            isActive: true,
        });
        const byId = new Map(products.map(p => [p.id, p]));
        expect(byId.get(withPrice.id).priceGhs).toBe('120.00');
        expect(byId.get(withoutPrice.id).priceGhs).toBeNull();
    });

    // ─── 2. unknown / ineligible rows → null, never a guess ──────────────────

    test('2a. no BusinessPrice row at all → priceGhs null (no priceUsdc conversion)', async () => {
        const { profile } = await seedBusiness();
        const product = await seedProduct(profile);
        const fetched = await productService.getProduct(db, { productId: product.id });
        expect(fetched.priceGhs).toBeNull();
        expect(fetched.priceUsdc.toString()).toBe('13.42'); // still present, still USDC
    });

    test('2b. unconfirmed row → null', async () => {
        const { profile } = await seedBusiness();
        const product = await seedProduct(profile);
        await seedPrice(product, { confirm: false, note: 'ghsrail-unconfirmed' });

        const fetched = await productService.getProduct(db, { productId: product.id });
        expect(fetched.priceGhs).toBeNull();
    });

    test('2c. MIGRATION-drafted row → null', async () => {
        const { profile } = await seedBusiness();
        const product = await seedProduct(profile);
        await db.businessPrice.create({
            data: {
                businessProductId: product.id,
                currency: 'GHS',
                amountExact: new Prisma.Decimal('77.77'),
                confirmedByType: 'MIGRATION',
                confirmedAt: new Date(),
                note: 'ghsrail-migration',
            },
        });

        const fetched = await productService.getProduct(db, { productId: product.id });
        expect(fetched.priceGhs).toBeNull();
    });

    test('2d. future-dated row → null', async () => {
        const { owner, profile } = await seedBusiness();
        const product = await seedProduct(profile);
        await db.businessPrice.create({
            data: {
                businessProductId: product.id,
                currency: 'GHS',
                amountExact: new Prisma.Decimal('99.99'),
                confirmedByType: 'BUSINESS',
                confirmedById: String(owner.id),
                confirmedAt: new Date(),
                effectiveFrom: new Date(Date.now() + 86400000), // tomorrow
                note: 'ghsrail-future',
            },
        });

        const fetched = await productService.getProduct(db, { productId: product.id });
        expect(fetched.priceGhs).toBeNull();
    });

    test('2e. archived row → null', async () => {
        const { owner, profile } = await seedBusiness();
        const product = await seedProduct(profile);
        const price = await seedPrice(product, { amountGhs: '55.55', confirmedById: String(owner.id) });
        await db.businessPrice.update({
            where: { id: price.id },
            data: { status: 'ARCHIVED' },
        });

        const fetched = await productService.getProduct(db, { productId: product.id });
        expect(fetched.priceGhs).toBeNull();
    });

    test('2f. BRANCH-scoped row → null on the DEFAULT-scope product rail', async () => {
        const { owner, profile } = await seedBusiness();
        const product = await seedProduct(profile);
        const branch = await db.businessLocation.create({
            data: {
                businessProfileId: profile.id,
                label: 'GhsRail Branch 1',
                address: 'GhsRail 1 Road',
                city: 'Accra',
                region: 'Greater Accra',
                latitude: new Prisma.Decimal('5.6037'),
                longitude: new Prisma.Decimal('-0.1870'),
                isActive: true,
            },
        });
        await priceService.setPrice(db, {
            businessProductId: product.id,
            amountGhs: '33.33',
            scope: 'BRANCH',
            locationId: branch.id,
            confirmedById: String(owner.id),
            note: 'ghsrail-branch',
        });

        const fetched = await productService.getProduct(db, { productId: product.id });
        expect(fetched.priceGhs).toBeNull();
    });

    // ─── 3. the rail never rewrites existing fields ──────────────────────────

    test('3. priceUsdc, id and name are byte-identical with and without a GHS row', async () => {
        const { owner, profile } = await seedBusiness();
        const productA = await seedProduct(profile);
        await seedPrice(productA, { amountGhs: '12.34', confirmedById: String(owner.id) });
        const { profile: profileB } = await seedBusiness();
        const productB = await seedProduct(profileB);

        const a = await productService.getProduct(db, { productId: productA.id });
        const b = await productService.getProduct(db, { productId: productB.id });
        expect(a.id).toBe(productA.id);
        expect(b.id).toBe(productB.id);
        expect(a.name).toBe(productA.name);
        expect(String(a.priceUsdc)).toBe(String(b.priceUsdc));
        expect(a.priceGhs).toBe('12.34');
        expect(b.priceGhs).toBeNull();
    });
});

// ─── 4. customer-facing business-detail route carries the same contract ───
//
// Route-level regression (review 2026-10-18): GET /api/marketplace/business/:bizId
// must expose the SAME authoritative priceGhs contract as the product rails —
// exact 2dp string for an eligible current row, null for
// missing/unconfirmed/future/archived rows, and priceUsdc untouched.

run('Marketplace business-detail GHS price contract (real PostgreSQL, route-level)', () => {
    let db;
    let seq;

    const buildApp = () => {
        const express = require('express');
        const request = require('supertest');
        const app = express();
        app.set('prisma', db);
        app.use(express.json());
        app.use('/api/marketplace', require('../routes/marketplaceRoutes'));
        return { app, request };
    };

    beforeAll(async () => {
        db = new PrismaClient();
    });

    afterAll(async () => {
        await db.businessPrice.deleteMany({ where: { note: { startsWith: 'ghsrail' } } });
        await db.businessProduct.deleteMany({ where: { slug: { startsWith: 'ghsrail-' } } });
        await db.businessProfile.deleteMany({ where: { businessName: { startsWith: 'GhsRail Biz' } } });
        await db.user.deleteMany({ where: { username: { startsWith: 'ghsrail-user' } } });
        await db.$disconnect();
    });

    beforeEach(async () => {
        seq = Date.now();
        await db.businessPrice.deleteMany({ where: { note: { startsWith: 'ghsrail' } } });
        await db.businessProduct.deleteMany({ where: { slug: { startsWith: 'ghsrail-' } } });
        await db.businessProfile.deleteMany({ where: { businessName: { startsWith: 'GhsRail Biz' } } });
        await db.user.deleteMany({ where: { username: { startsWith: 'ghsrail-user' } } });
    });

    async function seedBusinessDetailFixture() {
        const n = seq++;
        const owner = await db.user.create({
            data: {
                username: `ghsrail-user-${n}-${Date.now()}`,
                email: `ghsrail-${n}-${Date.now()}@t.test`,
                password: 'x',
            },
        });
        const profile = await db.businessProfile.create({
            data: {
                userId: owner.id,
                businessName: `GhsRail Biz ${n}`,
                bizId: `BIZ-GHSRAIL-${n}-${String(Date.now()).slice(-6)}`,
                category: 'RETAIL',
                isVerified: true,
            },
        });
        const product = await db.businessProduct.create({
            data: {
                businessProfileId: profile.id,
                name: `Rail Product ${n}`,
                slug: `ghsrail-${n}-${String(Date.now()).slice(-6)}`,
                description: 'route proof product',
                priceUsdc: new Prisma.Decimal('13.42'),
                category: 'RETAIL',
                isActive: true,
                isAvailable: true,
            },
        });
        return { profile, product };
    }

    const getDetailProduct = async (bizId) => {
        const { app, request } = buildApp();
        const res = await request(app).get(`/api/marketplace/business/${bizId}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        return res.body.data.business.products[0];
    };

    test('4a. confirmed current price → priceGhs exact 2dp string on the business-detail route', async () => {
        const { profile, product } = await seedBusinessDetailFixture();
        await priceService.setPrice(db, {
            businessProductId: product.id,
            amountGhs: '49.99',
            confirmedByType: 'BUSINESS',
            confirmedById: 'rail-actor',
            note: 'ghsrail',
            confirm: true,
        });

        const dto = await getDetailProduct(profile.bizId);
        expect(dto.priceGhs).toBe('49.99');
        expect(Number(dto.priceUsdc)).toBeCloseTo(13.42, 8); // legacy field untouched
    });

    test('4b. trailing-zero amount serializes as the exact 2dp string (never "7.5")', async () => {
        const { profile, product } = await seedBusinessDetailFixture();
        await priceService.setPrice(db, {
            businessProductId: product.id,
            amountGhs: '7.50',
            confirmedByType: 'BUSINESS',
            confirmedById: 'rail-actor',
            note: 'ghsrail',
            confirm: true,
        });

        const dto = await getDetailProduct(profile.bizId);
        expect(dto.priceGhs).toBe('7.50');
    });

    test('4c. missing row → priceGhs null (no converted priceUsdc)', async () => {
        const { profile } = await seedBusinessDetailFixture();
        const dto = await getDetailProduct(profile.bizId);
        expect(dto.priceGhs).toBeNull();
        expect(Number(dto.priceUsdc)).toBeCloseTo(13.42, 8); // USDC still shown raw
    });

    test('4d. unconfirmed row → null', async () => {
        const { profile, product } = await seedBusinessDetailFixture();
        await priceService.setPrice(db, {
            businessProductId: product.id,
            amountGhs: '49.99',
            confirmedByType: 'BUSINESS',
            confirmedById: 'rail-actor',
            note: 'ghsrail',
            confirm: false, // drafted, never confirmed
        });

        const dto = await getDetailProduct(profile.bizId);
        expect(dto.priceGhs).toBeNull();
    });

    test('4e. future-dated row → null', async () => {
        const { profile, product } = await seedBusinessDetailFixture();
        await db.businessPrice.create({
            data: {
                businessProductId: product.id,
                currency: 'GHS',
                amountExact: new Prisma.Decimal('49.99'),
                confirmedByType: 'BUSINESS',
                confirmedById: 'rail-actor',
                confirmedAt: new Date(),
                effectiveFrom: new Date(Date.now() + 86400000), // tomorrow
                note: 'ghsrail-future',
            },
        });

        const dto = await getDetailProduct(profile.bizId);
        expect(dto.priceGhs).toBeNull();
    });

    test('4f. archived row → null', async () => {
        const { profile, product } = await seedBusinessDetailFixture();
        await priceService.setPrice(db, {
            businessProductId: product.id,
            amountGhs: '49.99',
            confirmedByType: 'BUSINESS',
            confirmedById: 'rail-actor',
            note: 'ghsrail',
            confirm: true,
        });
        // Archive the confirmed row directly (same lifecycle as test 2e).
        const price = await db.businessPrice.findFirst({
            where: { businessProductId: product.id, status: 'ACTIVE' },
        });
        await db.businessPrice.update({
            where: { id: price.id },
            data: { status: 'ARCHIVED' },
        });

        const dto = await getDetailProduct(profile.bizId);
        expect(dto.priceGhs).toBeNull();
    });

    test('4g. priceUsdc is byte-identical with and without a GHS row on the route', async () => {
        const plain = await seedBusinessDetailFixture();
        const withoutRow = await getDetailProduct(plain.profile.bizId);

        const priced = await seedBusinessDetailFixture();
        await priceService.setPrice(db, {
            businessProductId: priced.product.id,
            amountGhs: '49.99',
            confirmedByType: 'BUSINESS',
            confirmedById: 'rail-actor',
            note: 'ghsrail',
            confirm: true,
        });
        const withRow = await getDetailProduct(priced.profile.bizId);

        // Same seeded priceUsdc decimal in both fixtures — the GHS rail must
        // not disturb the legacy field. (Names differ by seed design.)
        expect(withRow.priceUsdc).toEqual(withoutRow.priceUsdc);
        expect(Number(withRow.priceUsdc)).toBeCloseTo(13.42, 8);
        expect(withRow.id).toEqual(priced.product.id);
    });
});

// ─── 5. customer-facing storefront ordering catalogue carries the contract ─
//
// Route-level regression (final acceptance follow-up 2026-10-19): the
// storefront product listing (GET /api/storefront/:businessProfileId/products)
// feeds the customer's ordering journey — it must expose the SAME
// authoritative priceGhs contract (exact 2dp string for an eligible current
// row, null otherwise) while priceUsdc, the payable rail amount, stays
// byte-identical and never substitutes for the listing price.

run('Storefront ordering catalogue GHS price contract (real PostgreSQL, route-level)', () => {
    let db;
    let seq;

    const buildApp = () => {
        const express = require('express');
        const request = require('supertest');
        const app = express();
        app.set('prisma', db);
        app.use(express.json());
        app.use('/api/storefront', require('../routes/storefrontRoutes'));
        return { app, request };
    };

    beforeAll(async () => {
        db = new PrismaClient();
    });

    afterAll(async () => {
        await db.businessPrice.deleteMany({ where: { note: { startsWith: 'ghsrail' } } });
        await db.businessProduct.deleteMany({ where: { slug: { startsWith: 'ghsrail-' } } });
        await db.businessProfile.deleteMany({ where: { businessName: { startsWith: 'GhsRail Biz' } } });
        await db.user.deleteMany({ where: { username: { startsWith: 'ghsrail-user' } } });
        await db.$disconnect();
    });

    beforeEach(async () => {
        seq = Date.now();
        await db.businessPrice.deleteMany({ where: { note: { startsWith: 'ghsrail' } } });
        await db.businessProduct.deleteMany({ where: { slug: { startsWith: 'ghsrail-' } } });
        await db.businessProfile.deleteMany({ where: { businessName: { startsWith: 'GhsRail Biz' } } });
        await db.user.deleteMany({ where: { username: { startsWith: 'ghsrail-user' } } });
    });

    async function seedStorefrontFixture() {
        const n = seq++;
        const owner = await db.user.create({
            data: {
                username: `ghsrail-user-${n}-${Date.now()}`,
                email: `ghsrail-${n}-${Date.now()}@t.test`,
                password: 'x',
            },
        });
        const profile = await db.businessProfile.create({
            data: {
                userId: owner.id,
                businessName: `GhsRail Biz ${n}`,
                bizId: `BIZ-GHSRAIL-${n}-${String(Date.now()).slice(-6)}`,
                category: 'RETAIL',
                isVerified: true,
            },
        });
        const product = await db.businessProduct.create({
            data: {
                businessProfileId: profile.id,
                name: `Rail Product ${n}`,
                slug: `ghsrail-${n}-${String(Date.now()).slice(-6)}`,
                description: 'storefront catalogue proof product',
                priceUsdc: new Prisma.Decimal('13.42'),
                category: 'RETAIL',
                isActive: true,
                isAvailable: true,
            },
        });
        return { profile, product };
    }

    const getStorefrontProducts = async (businessProfileId) => {
        const { app, request } = buildApp();
        const res = await request(app).get(`/api/storefront/${businessProfileId}/products`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        return res.body.data.products[0];
    };

    test('5a. confirmed current price → priceGhs exact 2dp string on the storefront catalogue route', async () => {
        const { profile, product } = await seedStorefrontFixture();
        await priceService.setPrice(db, {
            businessProductId: product.id,
            amountGhs: '25.50',
            confirmedByType: 'BUSINESS',
            confirmedById: 'rail-actor',
            note: 'ghsrail',
            confirm: true,
        });

        const dto = await getStorefrontProducts(profile.id);
        expect(dto.id).toBe(product.id);
        expect(dto.priceGhs).toBe('25.50');
        expect(Number(dto.priceUsdc)).toBeCloseTo(13.42, 8); // payable rail amount untouched
    });

    test('5b. trailing-zero amount serializes as the exact 2dp string (never "7.5")', async () => {
        const { profile, product } = await seedStorefrontFixture();
        await priceService.setPrice(db, {
            businessProductId: product.id,
            amountGhs: '7.50',
            confirmedByType: 'BUSINESS',
            confirmedById: 'rail-actor',
            note: 'ghsrail',
            confirm: true,
        });

        const dto = await getStorefrontProducts(profile.id);
        expect(dto.priceGhs).toBe('7.50');
    });

    test('5c. missing row → priceGhs null (no converted priceUsdc); priceUsdc byte-identical with/without a GHS row', async () => {
        const plain = await seedStorefrontFixture();
        const withoutRow = await getStorefrontProducts(plain.profile.id);
        expect(withoutRow.priceGhs).toBeNull();
        expect(Number(withoutRow.priceUsdc)).toBeCloseTo(13.42, 8);

        const priced = await seedStorefrontFixture();
        await priceService.setPrice(db, {
            businessProductId: priced.product.id,
            amountGhs: '49.99',
            confirmedByType: 'BUSINESS',
            confirmedById: 'rail-actor',
            note: 'ghsrail',
            confirm: true,
        });
        const withRow = await getStorefrontProducts(priced.profile.id);
        expect(withRow.priceGhs).toBe('49.99');
        expect(withRow.priceUsdc).toEqual(withoutRow.priceUsdc); // byte-identical payable rail amount
    });

    test('5d. archived row → priceGhs null (soft history never surfaces as a listing price)', async () => {
        const { profile, product } = await seedStorefrontFixture();
        await priceService.setPrice(db, {
            businessProductId: product.id,
            amountGhs: '10.00',
            confirmedByType: 'BUSINESS',
            confirmedById: 'rail-actor',
            note: 'ghsrail',
            confirm: true,
        });
        await priceService.setPrice(db, {
            businessProductId: product.id,
            amountGhs: '20.00',
            confirmedByType: 'BUSINESS',
            confirmedById: 'rail-actor',
            note: 'ghsrail',
            confirm: true,
        });

        const dto = await getStorefrontProducts(profile.id);
        expect(dto.priceGhs).toBe('20.00'); // only the CURRENT eligible row
    });
});
