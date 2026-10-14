'use strict';
// =============================================================================
// MARKETPLACE MIX P1 — cross-business item discovery: REAL PostgreSQL proofs.
//
// Pins the owner-approved invariants of
// docs/MARKETPLACE_MIX_REDESIGN_2026-10-10.md §3/§4/§8 and the companion GHS
// contract §3.2/§4:
//   • the eligibility exclusion matrix, one test per exclusion — suspended,
//     owner-paused, marketplace-hidden, inactive product, sold-out product,
//     inactive section, closed/invalid section window, inactive branch;
//   • D-5 capability separation: storefrontDisabled does NOT remove
//     marketplace visibility, and isPubliclyDiscoverable=false does (the
//     two capabilities are separate facts);
//   • GHS price authority: only business/admin-confirmed effective rows
//     surface; missing, MIGRATION-drafted, unconfirmed and future-dated
//     prices exclude the item; the feed NEVER 500s on a corrupt price
//     identity (fails closed per identity); no priceUsdc fallback ever;
//   • exact 2dp GHS serialization as a STRING;
//   • category inheritance (product category null → business category),
//     q item search, taxonomy chip filtering (UNMAPPED never surfaces under
//     a specific chip but stays in the general feed);
//   • location truth: city/region filters (all-branch vs branch-scoped),
//     inactive-branch exclusion;
//   • honest capabilities: payableIn is exactly ['USDC'] (no GHS rail),
//     rank.label null (P1 has no calibrated labels), action per category;
//   • pagination: stable cursor walk with no dupes/skips, limit clamping,
//     malformed-cursor 422, first-page cache + explicit invalidation.
// =============================================================================

const { PrismaClient, Prisma } = require('@prisma/client');
const priceService = require('../services/businessPriceService');
const discoveryService = require('../services/marketplace/discoveryService');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

const NOW_MIN = () => {
    const n = new Date();
    return n.getUTCHours() * 60 + n.getUTCMinutes();
};

function hhmm(mins) {
    const m = ((mins % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

run('Marketplace Mix P1 discovery (real PostgreSQL)', () => {
    let db;
    let actorId;
    let seq;

    beforeAll(async () => {
        db = new PrismaClient();
    });

    afterAll(async () => {
        await db.$disconnect();
    });

    beforeEach(async () => {
        seq = Date.now();
        actorId = `mix-p1-actor-${seq}`;
        discoveryService.invalidateDiscoveryFeedCache();
        await db.catalogSection.deleteMany({ where: { name: { startsWith: 'MixP1 ' } } });
        await db.businessProduct.deleteMany({ where: { slug: { startsWith: 'mix-p1-' } } });
        await db.businessPrice.deleteMany({ where: { note: { startsWith: 'mix-p1' } } });
        await db.businessLocation.deleteMany({ where: { label: { startsWith: 'MixP1 Branch' } } });
        await db.businessProfile.deleteMany({ where: { businessName: { startsWith: 'MixP1 Biz' } } });
        await db.user.deleteMany({ where: { username: { startsWith: 'mix-p1-user' } } });
    });

    // ─── seed helpers ───────────────────────────────────────────────────────

    async function seedBusiness(opts = {}) {
        const n = seq++;
        const owner = await db.user.create({
            data: {
                username: `mix-p1-user-${n}-${Date.now()}`,
                email: `mix-p1-${n}-${Date.now()}@t.test`,
                password: 'x',
            },
        });
        const profile = await db.businessProfile.create({
            data: {
                userId: owner.id,
                businessName: `MixP1 Biz ${n}`,
                bizId: `BIZ-MIXP1-${n}-${String(Date.now()).slice(-6)}`,
                category: opts.category || 'FOOD_BEVERAGE',
                isSuspended: opts.suspended || false,
                isPausedByOwner: opts.paused || false,
                isPubliclyDiscoverable: opts.hidden === true ? false : true,
                storefrontDisabled: opts.storefrontDisabled || false,
            },
        });
        return { owner, profile };
    }

    async function seedBranch(profile, opts = {}) {
        const n = seq++;
        return db.businessLocation.create({
            data: {
                businessProfileId: profile.id,
                label: `MixP1 Branch ${n}`,
                address: `MixP1 ${n} Road`,
                city: opts.city || 'Accra',
                region: opts.region || 'Greater Accra',
                latitude: new Prisma.Decimal('5.6037'),
                longitude: new Prisma.Decimal('-0.1870'),
                isActive: opts.isActive === false ? false : true,
            },
        });
    }

    async function seedSection(profile, opts = {}) {
        const n = seq++;
        return db.catalogSection.create({
            data: {
                businessProfileId: profile.id,
                name: `MixP1 ${opts.name || 'Main Course'} ${n}`,
                taxonomy: opts.taxonomy || 'UNMAPPED',
                isActive: opts.isActive === false ? false : true,
                ...(opts.window ? { availableFrom: opts.window.from, availableTo: opts.window.to } : {}),
            },
        });
    }

    async function seedProduct(profile, opts = {}) {
        const n = seq++;
        return db.businessProduct.create({
            data: {
                businessProfileId: profile.id,
                name: opts.name || `MixP1 item ${n}`,
                slug: `mix-p1-${n}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
                priceUsdc: new Prisma.Decimal('4.20'),
                description: opts.description || 'Tasty, honest, priced in cedis',
                ...(opts.category !== undefined ? { category: opts.category } : {}),
                isActive: opts.inactive === true ? false : true,
                isAvailable: opts.soldOut === true ? false : true,
                totalOrders: opts.totalOrders || 0,
                ...(opts.sectionId ? { catalogSectionId: opts.sectionId } : {}),
                ...(opts.locationId ? { locationId: opts.locationId } : {}),
                ...(opts.deliveryTerms ? { deliveryTerms: opts.deliveryTerms } : {}),
                ...(opts.preparationMins ? { preparationMins: opts.preparationMins } : {}),
                ...(opts.imageUrls ? { imageUrls: opts.imageUrls } : {}),
            },
        });
    }

    async function setConfirmedPrice(productId, amountGhs, opts = {}) {
        const row = await priceService.setPrice(db, {
            businessProductId: productId,
            amountGhs,
            confirmedByType: opts.confirmedByType || 'BUSINESS',
            confirmedById: opts.confirmedById || actorId,
            note: opts.note || `mix-p1-${Date.now()}`,
            confirm: opts.confirm !== false,
        });
        return row;
    }

    const feed = (params) => discoveryService.searchDiscoveryItems(db, params, { useCache: false });
    const ids = (page) => page.items.map((i) => i.id);

    // ─── 1. eligibility exclusion matrix ────────────────────────────────────

    test('eligible item surfaces with exact 2dp GHS string, honest capabilities', async () => {
        const { profile } = await seedBusiness();
        const product = await seedProduct(profile, { deliveryTerms: 'Same day delivery', preparationMins: 20 });
        await setConfirmedPrice(product.id, '25.5');

        const page = await feed({});
        const item = page.items.find((i) => i.id === product.id);
        expect(item).toBeDefined();
        expect(item.pricing.amount).toBe('25.50');
        expect(item.pricing.currency).toBe('GHS');
        expect(item.pricing.displayCurrency).toBe('GHS');
        expect(item.pricing.hasUsdcListPrice).toBe(true);
        expect(item.capabilities.payableIn).toEqual(['USDC']);
        expect(item.capabilities.dineIn).toBe(false);
        expect(item.capabilities.deliverable).toBe(true);
        expect(item.action).toBe('ADD_TO_CART');
        expect(item.rank.label).toBeNull();
        expect(item.availability.isAvailable).toBe(true);
        expect(item.availability.preparationMins).toBe(20);
        // public DTO: no owner/internal fields ever
        const flat = JSON.stringify(item).toLowerCase();
        expect(flat).not.toContain('userid');
        expect(flat).not.toContain('costprice');
        expect(flat).not.toContain('supplierid');
        expect(flat).not.toContain('totalrevenue');
    });

    test('suspended business is excluded', async () => {
        const { profile } = await seedBusiness({ suspended: true });
        const product = await seedProduct(profile);
        await setConfirmedPrice(product.id, '10.00');
        expect(ids(await feed({}))).not.toContain(product.id);
    });

    test('owner-paused business is excluded (B-1)', async () => {
        const { profile } = await seedBusiness({ paused: true });
        const product = await seedProduct(profile);
        await setConfirmedPrice(product.id, '10.00');
        expect(ids(await feed({}))).not.toContain(product.id);
    });

    test('marketplace-hidden business is excluded (D-5 marketplace-visibility flag)', async () => {
        const { profile } = await seedBusiness({ hidden: true });
        const product = await seedProduct(profile);
        await setConfirmedPrice(product.id, '10.00');
        expect(ids(await feed({}))).not.toContain(product.id);
    });

    test('D-5 capability separation: storefrontDisabled does NOT remove marketplace visibility', async () => {
        const { profile } = await seedBusiness({ storefrontDisabled: true });
        const product = await seedProduct(profile);
        await setConfirmedPrice(product.id, '10.00');
        expect(ids(await feed({}))).toContain(product.id);
    });

    test('inactive (soft-deleted) product is excluded', async () => {
        const { profile } = await seedBusiness();
        const product = await seedProduct(profile, { inactive: true });
        await setConfirmedPrice(product.id, '10.00');
        expect(ids(await feed({}))).not.toContain(product.id);
    });

    test('sold-out (isAvailable=false) product is excluded', async () => {
        const { profile } = await seedBusiness();
        const product = await seedProduct(profile, { soldOut: true });
        await setConfirmedPrice(product.id, '10.00');
        expect(ids(await feed({}))).not.toContain(product.id);
    });

    test('inactive section is excluded; sectionless items stay discoverable', async () => {
        const { profile } = await seedBusiness();
        const deadSection = await seedSection(profile, { isActive: false });
        const withDeadSection = await seedProduct(profile, { sectionId: deadSection.id });
        await setConfirmedPrice(withDeadSection.id, '10.00');

        const sectionless = await seedProduct(profile, {});
        await setConfirmedPrice(sectionless.id, '11.00');

        const page = await feed({});
        expect(ids(page)).not.toContain(withDeadSection.id);
        expect(ids(page)).toContain(sectionless.id);
        const item = page.items.find((i) => i.id === sectionless.id);
        expect(item.section).toBeNull();
        expect(item.availability.sectionWindowOpen).toBe(true);
    });

    test('closed section window excludes the item; open window surfaces it', async () => {
        const { profile } = await seedBusiness();
        const now = NOW_MIN();
        const closedSection = await seedSection(profile, {
            taxonomy: 'MEALS',
            window: { from: hhmm(now + 30), to: hhmm(now + 60) },
        });
        const openSection = await seedSection(profile, {
            taxonomy: 'MEALS',
            window: { from: hhmm(now - 30), to: hhmm(now + 30) },
        });
        const closedItem = await seedProduct(profile, { sectionId: closedSection.id });
        const openItem = await seedProduct(profile, { sectionId: openSection.id });
        await setConfirmedPrice(closedItem.id, '10.00');
        await setConfirmedPrice(openItem.id, '12.00');

        const page = await feed({});
        expect(ids(page)).not.toContain(closedItem.id);
        expect(ids(page)).toContain(openItem.id);
        const item = page.items.find((i) => i.id === openItem.id);
        expect(item.availability.sectionWindowOpen).toBe(true);
        expect(item.section.taxonomy).toBe('MEALS');
    });

    test('overnight wrap window is honored (e.g. 22:00-02:00)', async () => {
        const { profile } = await seedBusiness();
        const section = await seedSection(profile, {
            taxonomy: 'MEALS',
            window: { from: hhmm(NOW_MIN() - 10), to: hhmm(NOW_MIN() + 10) },
        });
        const product = await seedProduct(profile, { sectionId: section.id });
        await setConfirmedPrice(product.id, '10.00');
        // window spans now (from = now-10 wraps when now<10, to = now+10 wraps
        // when now>1430) — in both wrap cases the evaluator must treat it open
        const page = await feed({});
        expect(ids(page)).toContain(product.id);
    });

    test('malformed section window fails CLOSED (never silently widening)', async () => {
        const { profile } = await seedBusiness();
        const section = await seedSection(profile, {
            taxonomy: 'MEALS',
            window: { from: '25:99', to: null },
        });
        const product = await seedProduct(profile, { sectionId: section.id });
        await setConfirmedPrice(product.id, '10.00');
        expect(ids(await feed({}))).not.toContain(product.id);
    });

    test('branch-scoped product on an inactive branch is excluded', async () => {
        const { profile } = await seedBusiness();
        const deadBranch = await seedBranch(profile, { isActive: false });
        const liveBranch = await seedBranch(profile, {});
        const deadItem = await seedProduct(profile, { locationId: deadBranch.id });
        const liveItem = await seedProduct(profile, { locationId: liveBranch.id });
        await setConfirmedPrice(deadItem.id, '10.00');
        await setConfirmedPrice(liveItem.id, '13.00');

        const page = await feed({});
        expect(ids(page)).not.toContain(deadItem.id);
        expect(ids(page)).toContain(liveItem.id);
        const item = page.items.find((i) => i.id === liveItem.id);
        expect(item.location.locationId).toBe(liveBranch.id);
        expect(item.location.distanceKm).toBeNull(); // D-6: geo deferred — no fabricated distance
    });

    // ─── 2. GHS price authority ──────────────────────────────────────────────

    test('no GHS price row → excluded (never priceUsdc fallback, never an estimate)', async () => {
        const { profile } = await seedBusiness();
        const product = await seedProduct(profile); // priceUsdc 4.20 exists
        const page = await feed({});
        expect(ids(page)).not.toContain(product.id);
        // and the USDC figure never appears as a price anywhere in the feed
        expect(JSON.stringify(page)).not.toContain('4.2');
    });

    test('MIGRATION-drafted unconfirmed price never confers eligibility', async () => {
        const { profile } = await seedBusiness();
        const product = await seedProduct(profile);
        await setConfirmedPrice(product.id, '10.00', { confirmedByType: 'MIGRATION', confirm: false });
        expect(ids(await feed({}))).not.toContain(product.id);
    });

    test('BUSINESS-confirmed unconfirmed row (confirmedAt null) never confers eligibility', async () => {
        const { profile } = await seedBusiness();
        const product = await seedProduct(profile);
        await setConfirmedPrice(product.id, '10.00', { confirm: false });
        expect(ids(await feed({}))).not.toContain(product.id);
    });

    test('P2 worklist confirmation makes the item eligible', async () => {
        const { profile } = await seedBusiness();
        const product = await seedProduct(profile);
        const row = await setConfirmedPrice(product.id, '10.00', { confirm: false });
        await priceService.confirmPrice(db, { priceId: row.id, confirmedByType: 'BUSINESS', confirmedById: actorId });
        expect(ids(await feed({}))).toContain(product.id);
    });

    test('future-dated current price fails closed: item excluded, feed does NOT 500', async () => {
        const { profile } = await seedBusiness();
        const product = await seedProduct(profile);
        // raw write (setPrice stamps now); confirmed but effective in the future
        await db.businessPrice.create({
            data: {
                businessProductId: product.id,
                currency: 'GHS',
                amountExact: new Prisma.Decimal('99.99'),
                scope: 'DEFAULT',
                status: 'ACTIVE',
                confirmedByType: 'BUSINESS',
                confirmedById: actorId,
                confirmedAt: new Date(),
                effectiveFrom: new Date(Date.now() + 86400000),
                note: `mix-p1-future-${Date.now()}`,
            },
        });
        // the single-product resolver THROWS on this corrupt state; the feed
        // fails closed per identity instead — no throw, no exposure
        const page = await feed({});
        expect(ids(page)).not.toContain(product.id);
    });

    test('malformed price identity (DEFAULT scope with a location) is DB-blocked', async () => {
        const { profile } = await seedBusiness();
        const branch = await seedBranch(profile);
        const product = await seedProduct(profile);
        await expect(db.businessPrice.create({
            data: {
                businessProductId: product.id,
                currency: 'GHS',
                amountExact: new Prisma.Decimal('10.00'),
                scope: 'DEFAULT',
                locationId: branch.id, // illegal: DEFAULT requires NULL location
                status: 'ACTIVE',
                confirmedByType: 'BUSINESS',
                confirmedById: actorId,
                confirmedAt: new Date(),
                note: `mix-p1-malformed-${Date.now()}`,
            },
        })).rejects.toThrow();
    });

    test('exact GHS serialization: sub-pesewa rejected at write, 2dp strings at read', async () => {
        const { profile } = await seedBusiness();
        const product = await seedProduct(profile);
        await expect(setConfirmedPrice(product.id, '10.001')).rejects.toThrow();

        await setConfirmedPrice(product.id, '1234.5');
        const page = await feed({});
        const item = page.items.find((i) => i.id === product.id);
        expect(item.pricing.amount).toBe('1234.50');
        expect(item.pricing.amount).toMatch(/^\d+\.\d{2}$/);
        expect(typeof item.pricing.amount).toBe('string');
    });

    // ─── 3. category, q, taxonomy filtering ──────────────────────────────────

    test('category filter matches product category AND inherited business category', async () => {
        const { profile: foodBiz } = await seedBusiness({ category: 'FOOD_BEVERAGE' });
        const explicit = await seedProduct(foodBiz, { category: 'RETAIL' });
        const inherited = await seedProduct(foodBiz, { category: null });
        await setConfirmedPrice(explicit.id, '10.00');
        await setConfirmedPrice(inherited.id, '11.00');

        const foodPage = await feed({ category: 'FOOD_BEVERAGE' });
        expect(ids(foodPage)).toContain(inherited.id);   // inherited from profile
        expect(ids(foodPage)).not.toContain(explicit.id); // product's own wins

        const retailPage = await feed({ category: 'RETAIL' });
        expect(ids(retailPage)).toContain(explicit.id);
        expect(ids(retailPage)).not.toContain(inherited.id);

        const all = await feed({});
        expect(ids(all)).toContain(explicit.id);
        expect(ids(all)).toContain(inherited.id);
    });

    test('q searches item names and descriptions, case-insensitively', async () => {
        const { profile } = await seedBusiness();
        const jollof = await seedProduct(profile, { name: 'Jollof Rice Supreme', description: 'smoky party rice' });
        const waakye = await seedProduct(profile, { name: 'Waakye Deluxe', description: 'fully loaded' });
        await setConfirmedPrice(jollof.id, '20.00');
        await setConfirmedPrice(waakye.id, '18.00');

        expect(ids(await feed({ q: 'jollof' }))).toContain(jollof.id);
        expect(ids(await feed({ q: 'SMOKY' }))).toContain(jollof.id);
        expect(ids(await feed({ q: 'zzznomatchzzz' }))).toEqual([]);
    });

    test('taxonomy chip filters sections; UNMAPPED stays in the general feed only', async () => {
        const { profile } = await seedBusiness();
        const meals = await seedSection(profile, { taxonomy: 'MEALS', name: 'Main Course' });
        const unmapped = await seedSection(profile, { taxonomy: 'UNMAPPED', name: 'House Specials' });
        const mealItem = await seedProduct(profile, { sectionId: meals.id });
        const unmappedItem = await seedProduct(profile, { sectionId: unmapped.id });
        await setConfirmedPrice(mealItem.id, '22.00');
        await setConfirmedPrice(unmappedItem.id, '23.00');

        const mealsFeed = await feed({ taxonomy: 'MEALS' });
        expect(ids(mealsFeed)).toContain(mealItem.id);
        expect(ids(mealsFeed)).not.toContain(unmappedItem.id);

        const general = await feed({});
        expect(ids(general)).toContain(unmappedItem.id); // general feed keeps UNMAPPED
        expect(ids(general)).toContain(mealItem.id);

        const item = general.items.find((i) => i.id === unmappedItem.id);
        expect(item.section.taxonomy).toBe('UNMAPPED');
    });

    test('unknown taxonomy chip is a 422 (field: taxonomy), never a silent empty feed', async () => {
        await expect(feed({ taxonomy: 'SIDES_X' })).rejects.toMatchObject({ field: 'taxonomy' });
    });

    test('unknown category is a 422 (field: category)', async () => {
        await expect(feed({ category: 'NOT_A_CATEGORY' })).rejects.toMatchObject({ field: 'category' });
    });

    // ─── 4. location filters (D-6 v1: city/region strings) ────────────────────

    test('city filter matches all-branch items via ANY active branch and branch-scoped via its own', async () => {
        const { profile } = await seedBusiness();
        await seedBranch(profile, { city: 'Accra' });
        await seedBranch(profile, { city: 'Kumasi' });
        const accraBranch = await seedBranch(profile, { city: 'Accra', region: 'Greater Accra' });
        const allBranchItem = await seedProduct(profile, {}); // locationId null
        const accraItem = await seedProduct(profile, { locationId: accraBranch.id });
        await setConfirmedPrice(allBranchItem.id, '10.00');
        await setConfirmedPrice(accraItem.id, '14.00');

        const accraFeed = await feed({ city: 'accra' }); // insensitive match
        expect(ids(accraFeed)).toContain(allBranchItem.id);
        expect(ids(accraFeed)).toContain(accraItem.id);

        const kumasiFeed = await feed({ city: 'Kumasi' });
        expect(ids(kumasiFeed)).toContain(allBranchItem.id); // has a Kumasi branch
        expect(ids(kumasiFeed)).not.toContain(accraItem.id); // its own branch isn't Kumasi

        const regionFeed = await feed({ region: 'Greater Accra' });
        expect(ids(regionFeed)).toContain(accraItem.id);
    });

    test('a business with no branch in the filtered city is excluded', async () => {
        const { profile: accraBiz } = await seedBusiness();
        const accraItem = await seedProduct(accraBiz);
        await setConfirmedPrice(accraItem.id, '10.00');
        await seedBranch(accraBiz, { city: 'Accra' });

        const tamaleFeed = await feed({ city: 'Tamale' });
        expect(ids(tamaleFeed)).not.toContain(accraItem.id);
    });

    // ─── 5. actions per category ─────────────────────────────────────────────

    test('action/capability truth: HOSPITALITY books, LOGISTICS views seats, RETAIL carts', async () => {
        const { profile: hotel } = await seedBusiness({ category: 'HOSPITALITY' });
        const hotelItem = await seedProduct(hotel);
        await setConfirmedPrice(hotelItem.id, '300.00');

        const { profile: transit } = await seedBusiness({ category: 'LOGISTICS' });
        const rideItem = await seedProduct(transit);
        await setConfirmedPrice(rideItem.id, '45.00');

        const page = await feed({});
        const hotelDto = page.items.find((i) => i.id === hotelItem.id);
        const rideDto = page.items.find((i) => i.id === rideItem.id);
        expect(hotelDto.action).toBe('BOOK');
        expect(hotelDto.capabilities.bookable).toBe(true);
        expect(rideDto.action).toBe('VIEW_SEATS');
        expect(rideDto.capabilities.payableIn).toEqual(['USDC']); // listing currency ≠ payment claim
    });

    // ─── 6. pagination + cursor stability ───────────────────────────────────

    async function seedMany(count) {
        const { profile } = await seedBusiness();
        const created = [];
        for (let i = 0; i < count; i++) {
            const product = await seedProduct(profile, { totalOrders: i });
            await setConfirmedPrice(product.id, '10.00');
            created.push(product.id);
        }
        return created;
    }

    test('stable cursor walk: no dupes, no skips, exhaustion stops cleanly', async () => {
        const created = await seedMany(60);
        const seen = [];
        let cursor = null;
        let pages = 0;
        for (;;) {
            const page = await feed(cursor ? { cursor } : {});
            expect(page.items.length).toBeLessThanOrEqual(24);
            seen.push(...ids(page));
            pages += 1;
            if (!page.nextCursor) break;
            cursor = page.nextCursor;
            expect(pages).toBeLessThan(10);
        }
        expect(seen.length).toBe(60);
        expect(new Set(seen).size).toBe(60); // no dupes
        // engagement ordering (P1 fallback w7): totalOrders desc
        const byId = new Map(seen.map((id, idx) => [id, idx]));
        expect([...created].every((id) => byId.has(id))).toBe(true);
        expect(seen).toEqual(created.slice().reverse()); // 59..0
    });

    test('limit is clamped to 1..50 with default 24; out-of-range is a 422', async () => {
        await expect(feed({ limit: '0' })).rejects.toMatchObject({ field: 'limit' });
        await expect(feed({ limit: '51' })).rejects.toMatchObject({ field: 'limit' });
        const page = await feed({ limit: '5' });
        expect(page.items.length).toBeLessThanOrEqual(5);
        const def = await feed({});
        expect(def.items.length).toBeLessThanOrEqual(24);
    });

    test('malformed or version-mismatched cursor is a 422', async () => {
        await expect(feed({ cursor: 'garbage!!!' })).rejects.toMatchObject({ field: 'cursor' });
        const bad = Buffer.from(JSON.stringify({ v: 99, o: 1, c: 1, i: 'x' })).toString('base64url');
        await expect(feed({ cursor: bad })).rejects.toMatchObject({ field: 'cursor' });
    });

    test('cursor pages are never cached; identical first pages are (TTL 60s) with explicit invalidation', async () => {
        const { profile } = await seedBusiness();
        const first = await seedProduct(profile, { name: 'Cached item' });
        await setConfirmedPrice(first.id, '10.00');

        const p1 = await discoveryService.searchDiscoveryItems(db, {});
        expect(ids(p1)).toContain(first.id);

        const second = await seedProduct(profile, { name: 'Added later' });
        await setConfirmedPrice(second.id, '10.00');

        const p2 = await discoveryService.searchDiscoveryItems(db, {});
        expect(ids(p2)).not.toContain(second.id); // cached first page

        discoveryService.invalidateDiscoveryFeedCache();
        const p3 = await discoveryService.searchDiscoveryItems(db, {});
        expect(ids(p3)).toContain(second.id); // fresh after invalidation
    });

    test('window-closed items do not corrupt pagination: pages fill from eligible items only', async () => {
        const { profile } = await seedBusiness();
        const now = NOW_MIN();
        const closed = await seedSection(profile, { window: { from: hhmm(now + 30), to: hhmm(now + 60) } });
        const eligible = [];
        for (let i = 0; i < 10; i++) {
            const c = await seedProduct(profile, { sectionId: closed.id, totalOrders: 100 + i });
            await setConfirmedPrice(c.id, '10.00');
        }
        for (let i = 0; i < 6; i++) {
            const e = await seedProduct(profile, { totalOrders: i });
            await setConfirmedPrice(e.id, '10.00');
            eligible.push(e.id);
        }
        const page = await feed({ limit: '5' });
        expect(page.items.length).toBe(5); // page fills despite closed-window items
        expect(ids(page).every((id) => eligible.includes(id))).toBe(true);
    });

    // ─── 7. route-level flag behavior ───────────────────────────────────────

    test('route: disabled flag → 404; enabled → serves the feed + 422 shape', async () => {
        const request = require('supertest');
        const express = require('express');
        const discoveryRouter = require('../routes/discoveryRoutes');
        const prev = process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED;

        const buildApp = () => {
            const app = express();
            app.set('prisma', db);
            app.use('/api/discovery', discoveryRouter);
            return app;
        };

        try {
            process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED = 'false';
            const disabledRes = await request(buildApp()).get('/api/discovery/items');
            expect(disabledRes.status).toBe(404);
            expect(disabledRes.body.success).toBe(false);

            process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED = 'true';
            const okRes = await request(buildApp()).get('/api/discovery/items');
            expect(okRes.status).toBe(200);
            expect(okRes.body.success).toBe(true);
            expect(Array.isArray(okRes.body.items)).toBe(true);
            expect(typeof okRes.body.nextCursor).toBe(typeof null);

            const badRes = await request(buildApp()).get('/api/discovery/items?category=BOGUS');
            expect(badRes.status).toBe(422);
            expect(badRes.body.field).toBe('category');
        } finally {
            if (prev === undefined) delete process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED;
            else process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED = prev;
        }
    });
});
