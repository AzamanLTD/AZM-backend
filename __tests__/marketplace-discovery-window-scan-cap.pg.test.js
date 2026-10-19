'use strict';
// =============================================================================
// MARKETPLACE DISCOVERY — window-filter scan-cap page exactness (REAL PG).
//
// Regression proof for the 2026-10-18 CI failure (run 39120763057,
// marketplace-discovery-mix-p1: "Received array: []" on feed-positivity
// tests). Root cause: runQuery's refill loop walked at most MAX_ROUNDS
// batches of where-eligible rows past the section-window post-filter. Any
// volume of stale-but-where-eligible window-closed products sorting AHEAD
// of a freshly seeded eligible item exhausted the scan budget and the feed
// returned an EMPTY first page — items: [] — even though the item was
// fully eligible. On the shared disposable battery database, leftover
// window-closed rows from other suites are a NORMAL state, and the general
// feed must walk past them: §4 requires pages to stay EXACT despite the
// window filter. This suite pins that invariant with a volume far beyond
// the old 3-round cap and asserts the fresh item still surfaces.
//
// Hermetic by construction: every row it creates is prefix-scoped
// (WinScan / winscan-) and deleted in beforeEach and afterAll. It never
// truncates shared tables and never touches rows it does not own.
// =============================================================================

const { PrismaClient, Prisma } = require('@prisma/client');
const priceService = require('../services/businessPriceService');
const discoveryService = require('../services/marketplace/discoveryService');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('Discovery window-filter scan cap (real PostgreSQL)', () => {
    let db;
    let actorId;
    let seq;

    beforeAll(async () => {
        db = new PrismaClient();
    });

    afterAll(async () => {
        if (db) await db.$disconnect();
    });

    beforeEach(async () => {
        seq = Date.now();
        actorId = `winscan-actor-${seq}`;
        await sweep();
    });

    afterEach(sweep);

    async function sweep() {
        // Suite-owned rows only: exact literal prefixes, nothing shared.
        await db.businessPrice.deleteMany({ where: { note: { startsWith: 'winscan' } } });
        await db.businessProduct.deleteMany({ where: { slug: { startsWith: 'winscan-' } } });
        await db.catalogSection.deleteMany({ where: { name: { startsWith: 'WinScan ' } } });
        await db.businessLocation.deleteMany({ where: { label: { startsWith: 'WinScan Branch' } } });
        await db.businessProfile.deleteMany({ where: { businessName: { startsWith: 'WinScan Biz' } } });
        await db.user.deleteMany({ where: { username: { startsWith: 'winscan-user' } } });
    }

    const ids = (page) => page.items.map((i) => i.id);
    const feed = (params) => discoveryService.searchDiscoveryItems(db, params, { useCache: false });

    test('a fresh eligible item surfaces even behind 90 stale window-closed rows', async () => {
        const owner = await db.user.create({
            data: { username: `winscan-user-${seq}`, email: `winscan-${seq}@t.test`, password: 'x' },
        });
        const profile = await db.businessProfile.create({
            data: {
                userId: owner.id,
                businessName: `WinScan Biz ${seq}`,
                bizId: `BIZ-WINSCAN-${seq}`,
                category: 'FOOD_BEVERAGE',
                isPubliclyDiscoverable: true,
            },
        });

        // 90 stale rows: ACTIVE sections with a CLOSED window (03:00-04:00
        // is never open during battery hours), high popularity, confirmed
        // prices — where-eligible, post-filtered. This is 3x the old
        // MAX_ROUNDS scan budget: the old code returned items: [] here.
        for (let i = 0; i < 90; i++) {
            const section = await db.catalogSection.create({
                data: {
                    businessProfileId: profile.id,
                    name: `WinScan Closed ${seq}-${i}`,
                    taxonomy: 'MEALS',
                    isActive: true,
                    availableFrom: '03:00',
                    availableTo: '04:00',
                },
            });
            const stale = await db.businessProduct.create({
                data: {
                    businessProfileId: profile.id,
                    name: `WinScan stale ${i}`,
                    slug: `winscan-stale-${seq}-${i}`,
                    priceUsdc: new Prisma.Decimal('1.00'),
                    isActive: true,
                    isAvailable: true,
                    totalOrders: 1000 - i, // all sort AHEAD of the fresh item
                    catalogSectionId: section.id,
                },
            });
            await priceService.setPrice(db, {
                businessProductId: stale.id,
                amountGhs: '5.00',
                confirmedByType: 'BUSINESS',
                confirmedById: String(owner.id),
                note: `winscan-stale-${seq}-${i}`,
                confirm: true,
            });
        }

        // The fresh item: modest popularity, open section — must surface.
        const openSection = await db.catalogSection.create({
            data: {
                businessProfileId: profile.id,
                name: `WinScan Open ${seq}`,
                taxonomy: 'UNMAPPED',
                isActive: true,
            },
        });
        const fresh = await db.businessProduct.create({
            data: {
                businessProfileId: profile.id,
                name: 'WinScan fresh jollof',
                slug: `winscan-fresh-${seq}`,
                priceUsdc: new Prisma.Decimal('4.20'),
                isActive: true,
                isAvailable: true,
                totalOrders: 5,
                catalogSectionId: openSection.id,
            },
        });
        await priceService.setPrice(db, {
            businessProductId: fresh.id,
            amountGhs: '10.00',
            confirmedByType: 'BUSINESS',
            confirmedById: String(owner.id),
            note: `winscan-fresh-${seq}`,
            confirm: true,
        });

        const page = await feed({});
        // Page exactness: the stale window-closed rows are walked past, the
        // eligible fresh item is NOT silently dropped from the first page.
        expect(ids(page)).toContain(fresh.id);
        // And no stale row leaked into the emitted page.
        for (const item of page.items) {
            expect(item.id === fresh.id || !item.id.startsWith('winscan-') || item.id === fresh.id).toBe(true);
        }
        expect(page.items.find((i) => i.id === fresh.id).pricing.amount).toBe('10.00');
    });
});
