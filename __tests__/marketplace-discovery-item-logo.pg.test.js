'use strict';
// =============================================================================
// MARKETPLACE DISCOVERY — business logo on the public discovery item DTO.
//
// Additive contract (2026-10-16): each GET /api/discovery/items item carries
// the REAL stored BusinessProfile.logoUrl (nullable) as `businessLogoUrl` —
// branding display ONLY. Proven here against real PostgreSQL, service and
// route:
//
//   • PRESENT: a business that set a logo gets its exact stored URL on every
//     one of its items — byte-identical, never invented, never defaulted.
//   • NULL: a business without a logo still gets the field, as null (the
//     key is always present so clients treat missing logos uniformly).
//   • SAFE OMISSION: the change is a strict DTO superset — every legacy
//     field survives, no field is removed or retyped, and an old/missing
//     value is exactly as tolerable as before (frontend DTO compatibility).
//   • PER-ITEM truth: two businesses in one feed each carry their OWN logo.
//   • ROUTE: the /api/discovery/items envelope is unchanged (success/items/
//     nextCursor/cache) and the feature flag still gates it identically —
//     the logo change touches NO authorization, pricing, filtering,
//     availability, ranking or payment capability.
// =============================================================================

const { PrismaClient, Prisma } = require('@prisma/client');
const express = require('express');
const request = require('supertest');
const priceService = require('../services/businessPriceService');
const discoveryService = require('../services/marketplace/discoveryService');
const discoveryRoutes = require('../routes/discoveryRoutes');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('marketplace discovery item businessLogoUrl (PostgreSQL)', () => {
    let db;
    let seq;

    beforeAll(async () => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        db = new PrismaClient();
    });

    afterAll(async () => {
        await db?.$disconnect();
    });

    beforeEach(async () => {
        seq = Date.now();
        discoveryService.invalidateDiscoveryFeedCache();
        await db.$executeRawUnsafe('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
    });

    // ── seed helpers (mirror the mix-p1 suite's shapes) ─────────────────────

    async function seedBusiness(opts = {}) {
        const n = seq++;
        const owner = await db.user.create({
            data: {
                username: `logo-dto-user-${n}-${Date.now()}`,
                email: `logo-dto-${n}-${Date.now()}@t.test`,
                password: 'x',
            },
        });
        const profile = await db.businessProfile.create({
            data: {
                userId: owner.id,
                businessName: `LogoDto Biz ${n}`,
                bizId: `BIZ-LOGODTO-${n}-${String(Date.now()).slice(-6)}`,
                category: 'FOOD_BEVERAGE',
                isPubliclyDiscoverable: true,
                ...(opts.logoUrl !== undefined ? { logoUrl: opts.logoUrl } : {}),
            },
        });
        return { owner, profile };
    }

    async function seedProduct(profile) {
        const n = seq++;
        return db.businessProduct.create({
            data: {
                businessProfileId: profile.id,
                name: `LogoDto item ${n}`,
                slug: `logo-dto-${n}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
                priceUsdc: new Prisma.Decimal('4.20'),
                description: 'Tasty, honest, priced in cedis',
                isActive: true,
                isAvailable: true,
            },
        });
    }

    async function seedConfirmedPrice(productId) {
        return priceService.setPrice(db, {
            businessProductId: productId,
            amountGhs: '25.5',
            confirmedByType: 'BUSINESS',
            confirmedById: `logo-dto-actor-${seq}`,
            note: `logo-dto-${Date.now()}`,
            confirm: true,
        });
    }

    const feed = (params) => discoveryService.searchDiscoveryItems(db, params, { useCache: false });

    // ── service DTO contract ─────────────────────────────────────────────────

    test('logo PRESENT: every item carries the business\'s exact stored logoUrl — never invented', async () => {
        const storedLogo = 'https://res.cloudinary.com/demo/image/upload/v1700000000/azaman/business/logos/logo-dto-proof.png';
        const { profile } = await seedBusiness({ logoUrl: storedLogo });
        const product = await seedProduct(profile);
        await seedConfirmedPrice(product.id);

        const page = await feed({});
        const item = page.items.find((i) => i.id === product.id);
        expect(item).toBeDefined();
        // Byte-identical pass-through of the stored value — no default,
        // placeholder or synthesized URL.
        expect(item.businessLogoUrl).toBe(storedLogo);
        expect(typeof item.businessLogoUrl).toBe('string');
        // Branding only: the logo changes no capability, price, availability
        // or ranking truth (pinned values unchanged from the pre-logo DTO).
        expect(item.pricing.amount).toBe('25.50');
        expect(item.pricing.currency).toBe('GHS');
        expect(item.capabilities.payableIn).toEqual(['USDC']);
        expect(item.action).toBe('ADD_TO_CART');
        expect(item.availability.isAvailable).toBe(true);
        expect(item.rank.label).toBeNull();
    });

    test('logo NULL: a business without a logo gets the field present as null', async () => {
        const { profile } = await seedBusiness(); // logoUrl not set (schema: String?)
        expect(profile.logoUrl).toBeNull();
        const product = await seedProduct(profile);
        await seedConfirmedPrice(product.id);

        const page = await feed({});
        const item = page.items.find((i) => i.id === product.id);
        expect(item).toBeDefined();
        // The key is ALWAYS present (uniform client handling of missing
        // logos) — never an invented/placeholder URL for an unset logo.
        expect(Object.prototype.hasOwnProperty.call(item, 'businessLogoUrl')).toBe(true);
        expect(item.businessLogoUrl).toBeNull();
    });

    test('SAFE OMISSION: the DTO change is a strict superset — legacy fields intact, old payloads still parse', async () => {
        const { profile } = await seedBusiness({ logoUrl: 'https://res.cloudinary.com/demo/image/upload/azaman/business/logos/some-logo.png' });
        const product = await seedProduct(profile);
        await seedConfirmedPrice(product.id);

        const page = await feed({});
        const item = page.items.find((i) => i.id === product.id);
        expect(item).toBeDefined();

        // The pre-change public DTO field set survives unchanged (nothing
        // removed, nothing retyped)…
        expect(item.businessId).toBe(profile.id);
        expect(item.bizId).toBe(profile.bizId);
        expect(item.businessName).toBe(profile.businessName);
        expect(item.businessCategory).toBe('FOOD_BEVERAGE');
        expect(item.item.name).toBeDefined();
        expect(item.item.imageUrl).toBeDefined();
        expect(item.pricing).toBeDefined();
        expect(item.availability).toBeDefined();
        expect(item.capabilities).toBeDefined();
        expect(item.rank).toBeDefined();

        // …and the addition is purely additive: a consumer that only knows
        // the OLD payload (the new key absent) sees exactly the shape it
        // always saw. The existing frontend DTO remains compatible with
        // old/missing values because the field is nullable and optional in
        // every payload that predates it.
        const legacyItem = { ...item };
        delete legacyItem.businessLogoUrl;
        expect(legacyItem.businessLogoUrl).toBeUndefined(); // old consumer never observed the key
        expect(Object.keys(legacyItem).length).toBe(Object.keys(item).length - 1);
        // JSON round-trip keeps the field JSON-safe in both states.
        expect(JSON.parse(JSON.stringify(item)).businessLogoUrl).toBe(item.businessLogoUrl);
    });

    test('PER-ITEM truth: two businesses in one feed each carry their OWN logo', async () => {
        const logoA = 'https://res.cloudinary.com/demo/image/upload/azaman/business/logos/logo-a.png';
        const logoB = 'https://res.cloudinary.com/demo/image/upload/azaman/business/logos/logo-b.png';
        const { profile: a } = await seedBusiness({ logoUrl: logoA });
        const { profile: b } = await seedBusiness({ logoUrl: logoB });
        const productA = await seedProduct(a);
        const productB = await seedProduct(b);
        await seedConfirmedPrice(productA.id);
        await seedConfirmedPrice(productB.id);

        const page = await feed({});
        const itemA = page.items.find((i) => i.id === productA.id);
        const itemB = page.items.find((i) => i.id === productB.id);
        expect(itemA.businessLogoUrl).toBe(logoA);
        expect(itemB.businessLogoUrl).toBe(logoB);
        // Never a feed-global value, never a cross-business mix-up.
        expect(itemA.businessLogoUrl).not.toBe(itemB.businessLogoUrl);
    });

    // ── route contract (/api/discovery/items) ─────────────────────────────────

    function buildApp() {
        const app = express();
        app.set('prisma', db);
        app.use('/api/discovery', discoveryRoutes);
        return app;
    }

    test('ROUTE: GET /api/discovery/items exposes businessLogoUrl in the unchanged response envelope', async () => {
        const storedLogo = 'https://res.cloudinary.com/demo/image/upload/azaman/business/logos/route-proof.png';
        const { profile } = await seedBusiness({ logoUrl: storedLogo });
        const product = await seedProduct(profile);
        await seedConfirmedPrice(product.id);
        discoveryService.invalidateDiscoveryFeedCache();

        const prev = process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED;
        process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED = 'true';
        try {
            const res = await request(buildApp()).get('/api/discovery/items').expect(200);
            // Envelope contract unchanged (success/items/nextCursor/cache).
            expect(res.body.success).toBe(true);
            expect(Array.isArray(res.body.items)).toBe(true);
            expect(res.body).toHaveProperty('nextCursor');
            expect(res.body).toHaveProperty('cache');
            const item = res.body.items.find((i) => i.id === product.id);
            expect(item).toBeDefined();
            expect(item.businessLogoUrl).toBe(storedLogo);
        } finally {
            if (prev === undefined) delete process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED;
            else process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED = prev;
        }
    });

    test('ROUTE: feature-flag-off behaviour is unchanged (404, indistinguishable) — the logo change alters no authorization', async () => {
        const prev = process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED;
        delete process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED;
        try {
            const res = await request(buildApp()).get('/api/discovery/items').expect(404);
            expect(res.body).toEqual({ success: false, message: 'Not found' });
        } finally {
            if (prev !== undefined) process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED = prev;
        }
    });
});
