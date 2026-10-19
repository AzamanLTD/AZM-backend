// Read-your-write clock-domain regression (CI run 39007452456 flake).
// =============================================================================
// ROOT CAUSE (verified empirically 2026-10-17): setPrice relied on the DB-side
// DEFAULT CURRENT_TIMESTAMP for BusinessPrice.effectiveFrom, while every
// eligibility consumer compares effectiveFrom against the APPLICATION clock
// (`new Date()`): eligibleCurrentGhsPriceWhere (the discovery candidate
// predicate) and selectEligiblePriceRows (the single + batch resolvers). When
// the database clock runs ahead of the app clock — measured 1..77ms skew on
// the CI runner's service container and on a local embedded Postgres — a price
// written "now" is read back as scheduled in the FUTURE for that skew window
// and the just-confirmed price is INVISIBLE. CI observed this as
// marketplace-discovery-mix-p1.pg.test.js "cursor: valid pagination still
// walks cleanly" flaking: the final-seeded product dropped off page 1
// (received [made[2], made[1]] vs expected [made[3], made[2]]).
//
// The fix stamps effectiveFrom from the app clock inside setPrice, so
// write-then-read is monotonic within one clock domain. This suite pins that
// contract at all three consumer surfaces, IMMEDIATELY after the write, with
// no sleeps: any reintroduction of a DB-clock (or other forward-running)
// effectiveFrom stamp breaks these assertions exactly the way CI flaked.

const { PrismaClient, Prisma } = require('@prisma/client');
const priceService = require('../services/businessPriceService');
const discoveryService = require('../services/marketplace/discoveryService');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('BusinessPrice read-your-write clock domain (real PostgreSQL)', () => {
    let db;

    beforeAll(async () => {
        db = new PrismaClient();
    });

    afterAll(async () => {
        await db.businessPrice.deleteMany({
            where: { note: { startsWith: 'ryw-cleantest' } },
        });
        await db.businessProduct.deleteMany({
            where: { slug: { startsWith: 'ryw-cleantest-' } },
        });
        await db.businessProfile.deleteMany({
            where: { businessName: { startsWith: 'RYW Clock Biz' } },
        });
        await db.user.deleteMany({
            where: { username: { startsWith: 'ryw-cleantest-user' } },
        });
        await db.$disconnect();
    });

    let seq;
    beforeEach(async () => {
        seq = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        discoveryService.invalidateDiscoveryFeedCache();
    });

    async function seedBusiness() {
        const owner = await db.user.create({
            data: {
                username: `ryw-cleantest-user-${seq}`,
                email: `ryw-cleantest-${seq}@t.test`,
                password: 'x',
            },
        });
        const profile = await db.businessProfile.create({
            data: {
                userId: owner.id,
                businessName: `RYW Clock Biz ${seq}`,
                bizId: `BIZ-RYW-${seq}`,
                category: 'FOOD_BEVERAGE',
            },
        });
        return profile;
    }

    async function seedProduct(profile) {
        return db.businessProduct.create({
            data: {
                businessProfileId: profile.id,
                name: `ryw cleantest item ${seq}`,
                slug: `ryw-cleantest-${seq}`,
                priceUsdc: new Prisma.Decimal('4.20'),
                description: `ryw-cleantest ${seq}`,
                isActive: true,
                isAvailable: true,
            },
        });
    }

    test('a price set NOW is immediately eligible — no future-dated window after the write', async () => {
        const profile = await seedBusiness();
        const product = await seedProduct(profile);

        // The write under test: setPrice stamps effectiveFrom itself.
        const tBefore = Date.now();
        await priceService.setPrice(db, {
            businessProductId: product.id,
            amountGhs: '10.00',
            confirmedByType: 'BUSINESS',
            confirmedById: `ryw-cleantest-actor-${seq}`,
            note: `ryw-cleantest-${seq}`,
            confirm: true,
        });
        const tAfter = Date.now();

        const price = await db.businessPrice.findFirst({
            where: { businessProductId: product.id },
        });
        expect(price).not.toBeNull();
        // effectiveFrom must come from the app clock's write window — never
        // from a clock that can run ahead of the reader.
        expect(price.effectiveFrom.getTime()).toBeGreaterThanOrEqual(tBefore);
        expect(price.effectiveFrom.getTime()).toBeLessThanOrEqual(tAfter);
        // The durable statement of the contract, independent of any fix
        // mechanism: at read time the row is not future-dated.
        expect(price.effectiveFrom.getTime()).toBeLessThanOrEqual(Date.now());
    });

    test('the discovery candidate predicate sees the just-written price (no sleep, no retry)', async () => {
        const profile = await seedBusiness();
        const product = await seedProduct(profile);
        await priceService.setPrice(db, {
            businessProductId: product.id,
            amountGhs: '10.00',
            confirmedByType: 'BUSINESS',
            confirmedById: `ryw-cleantest-actor-${seq}`,
            note: `ryw-cleantest-${seq}`,
            confirm: true,
        });

        // Same predicate shape the discovery candidate query applies.
        const visibleCount = await db.businessProduct.count({
            where: {
                id: product.id,
                isActive: true,
                isAvailable: true,
                prices: { some: priceService.eligibleCurrentGhsPriceWhere() },
            },
        });
        expect(visibleCount).toBe(1);

        // End-to-end surface: the feed itself surfaces the product NOW.
        const page = await discoveryService.searchDiscoveryItems(
            db,
            { q: `ryw-cleantest ${seq}` },
            { useCache: false }
        );
        expect(page.items.map((i) => i.id)).toContain(product.id);
    });

    test('the resolver and the batch resolver both resolve the just-written price', async () => {
        const profile = await seedBusiness();
        const product = await seedProduct(profile);
        await priceService.setPrice(db, {
            businessProductId: product.id,
            amountGhs: '10.00',
            confirmedByType: 'BUSINESS',
            confirmedById: `ryw-cleantest-actor-${seq}`,
            note: `ryw-cleantest-${seq}`,
            confirm: true,
        });

        const single = await priceService.resolveEffectiveGhsPrice(db, product.id);
        expect(single).not.toBeNull();

        const batchMap = await priceService.resolveEffectiveGhsPrices(db, [product.id]);
        expect(batchMap.get(product.id)).not.toBeNull();
    });
});
