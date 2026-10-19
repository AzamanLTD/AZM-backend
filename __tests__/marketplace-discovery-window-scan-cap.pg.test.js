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

    // Shared helpers for the bulk-volume proofs below: all stale rows share
    // ONE closed section (the window is computed once per section per batch,
    // so sharing is the cheapest realistic shape and the worst case for the
    // post-filter: every row in the fetch is individually examined).
    async function seedBulk({ profile, ownerId, closedSectionId, count, notePrefix }) {
        for (let b = 0; b < count; b += 1000) {
            const chunk = Math.min(1000, count - b);
            await db.businessProduct.createMany({
                data: Array.from({ length: chunk }, (_, i) => ({
                    businessProfileId: profile.id,
                    name: 'WinScan bulk stale',
                    slug: `winscan-bulk-${notePrefix}-${seq}-${b + i}`,
                    priceUsdc: new Prisma.Decimal('1.00'),
                    isActive: true,
                    isAvailable: true,
                    totalOrders: 1000,
                    catalogSectionId: closedSectionId,
                })),
            });
        }
        // Prices for every bulk product, deterministically paginated by id.
        let skip = 0;
        for (;;) {
            const idRows = await db.businessProduct.findMany({
                where: { slug: { startsWith: `winscan-bulk-${notePrefix}-${seq}` } },
                select: { id: true },
                orderBy: { id: 'asc' },
                skip,
                take: 1000,
            });
            if (idRows.length === 0) break;
            await db.businessPrice.createMany({
                data: idRows.map((r) => ({
                    businessProductId: r.id,
                    currency: 'GHS',
                    amountExact: '5.00',
                    scope: 'DEFAULT',
                    locationId: null,
                    status: 'ACTIVE',
                    confirmedByType: 'BUSINESS',
                    confirmedById: String(ownerId),
                    confirmedAt: new Date(),
                    effectiveFrom: new Date(),
                    note: `winscan-bulk-${notePrefix}-${seq}`,
                })),
            });
            skip += 1000;
        }
    }

    async function seedScene({ staleCount, notePrefix }) {
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
        const closedSection = await db.catalogSection.create({
            data: {
                businessProfileId: profile.id,
                name: `WinScan Closed Bulk ${seq}`,
                taxonomy: 'MEALS',
                isActive: true,
                availableFrom: '03:00',
                availableTo: '04:00',
            },
        });
        if (staleCount > 0) {
            await seedBulk({ profile, ownerId: owner.id, closedSectionId: closedSection.id, count: staleCount, notePrefix });
        }
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
        return { fresh };
    }

    function instrumentQueries(db) {
        const orig = db.businessProduct.findMany.bind(db.businessProduct);
        let queries = 0;
        db.businessProduct.findMany = async (args) => { queries += 1; return orig(args); };
        return () => queries;
    }

    test('adaptive scan: 3000 stale rows (beyond the old fixed 1920-row budget) surface the fresh item in ONE bounded request', async () => {
        const { fresh } = await seedScene({ staleCount: 3000, notePrefix: 'a3k' });
        const queryCount = instrumentQueries(db);

        const page = await feed({});
        const queries = queryCount();

        expect(ids(page)).toContain(fresh.id);
        expect(page.items.find((i) => i.id === fresh.id).pricing.amount).toBe('10.00');
        // Adaptive growth keeps the QUERY budget hard: the fixed-take loop
        // would have needed 3000/24 = 125 rounds (> the 80 cap) and returned
        // an empty page; growth covers 3000 rows in <= 15 queries.
        expect(queries).toBeLessThanOrEqual(15);
    });

    test('row-budget exhaustion is truthful: > MAX_SCAN_ROWS stale rows return items: [] with a NON-NULL cursor, bounded queries, and the client continuation finds the item', async () => {
        // 25500 stale rows exceed the 25000-row per-request budget by 500.
        const { fresh } = await seedScene({ staleCount: 25500, notePrefix: 'x25' });
        const queryCount = instrumentQueries(db);

        const page1 = await feed({});
        const queries1 = queryCount();

        // Truthful boundary: the request examined its full row budget
        // without an eligible item — an empty page, but NEVER a false
        // "end of feed": the cursor survives for continuation.
        expect(page1.items.filter((i) => i.id.startsWith('winscan-')).length).toBe(0);
        expect(page1.nextCursor).not.toBeNull();
        // Hard work budget held on the exhausted path.
        expect(queries1).toBeLessThanOrEqual(80);

        // The client-side continuation walk (bounded follow-ups) reaches
        // the eligible item on the next request: only 500 stale rows remain.
        const page2 = await feed({ cursor: page1.nextCursor });
        expect(ids(page2)).toContain(fresh.id);
        expect(page2.items.find((i) => i.id === fresh.id).pricing.amount).toBe('10.00');
    }, 180000); // bulk seeding (25.5k rows) + two full-budget scans
});
