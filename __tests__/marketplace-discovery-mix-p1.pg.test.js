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
                ...(opts.variants ? { variants: opts.variants } : {}),
                ...(opts.modifierGroups ? { modifierGroups: opts.modifierGroups } : {}),
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
    // ─── 8. review-correction pass (2026-10-14): cursor safety ─────────────

    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

    test('cursor: crafted out-of-Date-range epoch is rejected before the query — 422, never 500 (route level)', async () => {
        const request = require('supertest');
        const express = require('express');
        const discoveryRouter = require('../routes/discoveryRoutes');
        const prev = process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED;
        const app = express();
        app.set('prisma', db);
        app.use('/api/discovery', discoveryRouter);
        try {
            process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED = 'true';
            const crafted = b64({ v: 1, o: 0, c: 99999999999999999, i: 'x' });
            const res = await request(app).get(`/api/discovery/items?cursor=${encodeURIComponent(crafted)}`);
            expect(res.status).toBe(422);
            expect(res.body.success).toBe(false);
            expect(res.body.field).toBe('cursor');
        } finally {
            if (prev === undefined) delete process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED;
            else process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED = prev;
        }
    });

    test('cursor: invalid keys decode to null — every crafted shape (unit level)', () => {
        const { decodeCursor } = discoveryService._internal;
        expect(decodeCursor(b64({ v: 1, o: 0, c: 99999999999999999, i: 'x' }))).toBeNull(); // beyond Date range
        expect(decodeCursor(b64({ v: 1, o: 0, c: 8640000000000000, i: 'x' }))).toBeNull(); // == ECMAScript bound
        expect(decodeCursor(b64({ v: 1, o: 0, c: -8640000000000000, i: 'x' }))).toBeNull();
        expect(decodeCursor(b64({ v: 1, o: -1, c: 0, i: 'x' }))).toBeNull(); // negative count
        expect(decodeCursor(b64({ v: 1, o: 1.5, c: 0, i: 'x' }))).toBeNull(); // non-integer count
        expect(decodeCursor(b64({ v: 1, o: 9007199254740993, c: 0, i: 'x' }))).toBeNull(); // > MAX_SAFE_INTEGER
        expect(decodeCursor(b64({ v: 1, o: 0, c: 0, i: '' }))).toBeNull(); // empty id
        expect(decodeCursor(b64({ v: 1, o: 0, c: 0, i: 'x'.repeat(65) }))).toBeNull(); // oversized id
        expect(decodeCursor(b64({ v: 2, o: 0, c: 0, i: 'x' }))).toBeNull(); // wrong version
        expect(decodeCursor('not-base64!!!')).toBeNull();
        expect(decodeCursor(null)).toBeNull();
        expect('x'.repeat(5000)).not.toHaveLength(0);
        expect(decodeCursor('x'.repeat(5000))).toBeNull(); // oversized raw envelope
        // valid cursor still decodes
        const row = { totalOrders: 7, createdAt: new Date('2026-01-01T00:00:00.000Z'), id: 'abc' };
        const dec = decodeCursor(discoveryService._internal.encodeCursor(row));
        expect(dec).toEqual({ totalOrders: 7, createdAt: row.createdAt, id: 'abc' });
    });

    test('cursor: oversized raw cursor rejected 422 at parse, before any DB work', async () => {
        await expect(feed({ cursor: 'y'.repeat(4097) })).rejects.toMatchObject({
            name: 'DiscoveryParamError', field: 'cursor',
        });
    });

    test('cursor: valid pagination still walks cleanly after the hardening', async () => {
        const { profile } = await seedBusiness();
        const token = `walktoken${seq}`;
        const made = [];
        for (let i = 0; i < 4; i++) {
            // q-scoped so shared-test-DB leftovers from other suites can
            // never outrank these rows in the ordering (isolation honesty).
            const prod = await seedProduct(profile, { totalOrders: 10 + i, description: token });
            await setConfirmedPrice(prod.id, '10.00');
            made.push(prod.id);
        }
        const p1 = await feed({ limit: '2', q: token });
        expect(p1.items.length).toBe(2);
        expect(p1.nextCursor).toBeTruthy();
        // ordering: totalOrders DESC → the walk visits made[3], made[2], then
        // made[1], made[0].
        expect(ids(p1)).toEqual([made[3], made[2]]);
        const p2 = await feed({ limit: '2', q: token, cursor: p1.nextCursor });
        expect(ids(p2)).toEqual([made[1], made[0]]);
        expect(p2.nextCursor).toBeNull();
    });

    // ─── 9. review-correction pass: variant/modifier GHS truth (read-time) ─

    test('variant GHS: valid deltas are canonically reserialized as exact 2dp strings', async () => {
        const { profile } = await seedBusiness();
        const good = await seedProduct(profile, {
            totalOrders: 50,
            variants: [
                { name: 'Size', required: true, options: [
                    { name: 'Small', priceDelta: 0, priceDeltaGhs: '0' },
                    { name: 'Medium', priceDelta: 1, priceDeltaGhs: '5' },
                    { name: 'Large', priceDelta: 2, priceDeltaGhs: '5.0' },
                ] },
            ],
            modifierGroups: [
                { name: 'Extras', required: false, maxSelection: 3, options: [
                    { name: 'Cheese', priceDelta: 0.5, priceDeltaGhs: '-1.5' },
                ] },
            ],
        });
        await setConfirmedPrice(good.id, '25.00');

        const page = await feed({});
        const item = page.items.find((i) => i.id === good.id);
        expect(item).toBeDefined();
        expect(item.variants[0].options.map((o) => o.priceDeltaGhs)).toEqual(['0.00', '5.00', '5.00']);
        expect(item.modifierGroups[0].options[0].priceDeltaGhs).toBe('-1.50');
        // USDC deltas pass through independently, never converted
        expect(item.variants[0].options[1].priceDelta).toBe(1);
    });

    test('variant GHS: unit-level serialization enforces typing and 2dp precision', () => {
        const { serializeVariantGhs } = discoveryService._internal;
        const base = '25.00';
        // valid: canonicalized exactly
        const out = serializeVariantGhs(
            [{ name: 'Size', options: [{ name: 'L', priceDeltaGhs: '5' }] }],
            [],
            base,
        );
        expect(out.variants[0].options[0].priceDeltaGhs).toBe('5.00');
        // sub-pesewa precision → corrupt
        expect(() => serializeVariantGhs(
            [{ name: 'Size', options: [{ name: 'L', priceDeltaGhs: '1.005' }] }], [], base))
            .toThrow(priceService.BusinessPriceError);
        // JSON number type (contract is a STRING) → corrupt
        expect(() => serializeVariantGhs(
            [{ name: 'Size', options: [{ name: 'L', priceDeltaGhs: 5 }] }], [], base))
            .toThrow(priceService.BusinessPriceError);
        // garbage → corrupt
        expect(() => serializeVariantGhs(
            [{ name: 'Size', options: [{ name: 'L', priceDeltaGhs: 'free!' }] }], [], base))
            .toThrow(priceService.BusinessPriceError);
        // non-positive worst-case final price → corrupt
        expect(() => serializeVariantGhs(
            [{ name: 'Size', options: [{ name: 'L', priceDeltaGhs: '-25.00' }] }], [], base))
            .toThrow(priceService.BusinessPriceError);
        // no variant data at all → null (unchanged DTO surface)
        expect(serializeVariantGhs([], [], base)).toBeNull();
    });

    test('variant GHS: corrupt configurations are excluded from the feed (fail closed per identity, never a 500)', async () => {
        const { profile } = await seedBusiness();
        const healthy = await seedProduct(profile, { totalOrders: 100, variants: [
            { name: 'Size', options: [{ name: 'L', priceDeltaGhs: '5.00' }] },
        ] });
        await setConfirmedPrice(healthy.id, '25.00');
        const subPesewa = await seedProduct(profile, { totalOrders: 90, variants: [
            { name: 'Size', options: [{ name: 'L', priceDeltaGhs: '1.005' }] },
        ] });
        await setConfirmedPrice(subPesewa.id, '25.00');
        const wrongType = await seedProduct(profile, { totalOrders: 80, variants: [
            { name: 'Size', options: [{ name: 'L', priceDeltaGhs: 7 }] }, // JSON number
        ] });
        await setConfirmedPrice(wrongType.id, '25.00');
        const nonPositive = await seedProduct(profile, { totalOrders: 70, variants: [
            { name: 'Size', options: [{ name: 'L', priceDeltaGhs: '-30.00' }] }, // 25.00 - 30.00 <= 0
        ] });
        await setConfirmedPrice(nonPositive.id, '25.00');

        const page = await feed({});
        const got = ids(page);
        expect(got).toContain(healthy.id);
        expect(got).not.toContain(subPesewa.id);
        expect(got).not.toContain(wrongType.id);
        expect(got).not.toContain(nonPositive.id);
        // the feed stays a clean 200 with the healthy item; no partial DTO
        expect(page.items.find((i) => i.id === healthy.id).variants[0].options[0].priceDeltaGhs).toBe('5.00');
    });

    // ─── 10. review-correction pass: repeatable taxonomy contract ──────────

    test('taxonomy: repeatable params OR together; single + repeated + dedupe are deterministic', async () => {
        const { profile } = await seedBusiness();
        const meals = await seedSection(profile, { name: 'Main Course', taxonomy: 'MEALS' });
        const drinks = await seedSection(profile, { name: 'Drinks', taxonomy: 'DRINKS' });
        const desserts = await seedSection(profile, { name: 'Desserts', taxonomy: 'DESSERTS' });
        const mealItem = await seedProduct(profile, { sectionId: meals.id, totalOrders: 30 });
        const drinkItem = await seedProduct(profile, { sectionId: drinks.id, totalOrders: 20 });
        const dessertItem = await seedProduct(profile, { sectionId: desserts.id, totalOrders: 10 });
        for (const p of [mealItem, drinkItem, dessertItem]) await setConfirmedPrice(p.id, '10.00');

        const both = await feed({ taxonomy: ['MEALS', 'DRINKS'] });
        expect(ids(both).sort()).toEqual([drinkItem.id, mealItem.id].sort());

        const single = await feed({ taxonomy: 'MEALS' });
        expect(ids(single)).toEqual([mealItem.id]);

        const deduped = await feed({ taxonomy: ['MEALS', 'MEALS'] });
        expect(ids(deduped)).toEqual([mealItem.id]);

        // no taxonomy → general feed still surfaces every section (incl. UNMAPPED)
        const general = await feed({});
        expect(ids(general)).toEqual(expect.arrayContaining([mealItem.id, drinkItem.id, dessertItem.id]));
    });

    test('taxonomy: UNMAPPED cannot be requested as a chip — 422, stays in the general feed', async () => {
        const { profile } = await seedBusiness();
        const unmapped = await seedSection(profile, { name: 'House Special', taxonomy: 'UNMAPPED' });
        const item = await seedProduct(profile, { sectionId: unmapped.id, totalOrders: 5 });
        await setConfirmedPrice(item.id, '10.00');

        const general = await feed({});
        expect(ids(general)).toContain(item.id); // general feed: yes
        await expect(feed({ taxonomy: 'UNMAPPED' })).rejects.toMatchObject({
            name: 'DiscoveryParamError', field: 'taxonomy',
        });
        await expect(feed({ taxonomy: ['MEALS', 'UNMAPPED'] })).rejects.toMatchObject({
            field: 'taxonomy',
        });
    });

    test('taxonomy: unknown, inactive and over-limit chips are 422s, never silent empty feeds', async () => {
        await expect(feed({ taxonomy: 'NOT_A_CHIP' })).rejects.toMatchObject({ field: 'taxonomy' });
        // comma-list inside one value is NOT silently split — it is an unknown id
        await expect(feed({ taxonomy: 'MEALS,DRINKS' })).rejects.toMatchObject({ field: 'taxonomy' });
        // inactive chip
        await db.catalogSectionTaxonomy.update({ where: { id: 'DRINKS' }, data: { isActive: false } });
        try {
            await expect(feed({ taxonomy: 'DRINKS' })).rejects.toMatchObject({ field: 'taxonomy' });
        } finally {
            await db.catalogSectionTaxonomy.update({ where: { id: 'DRINKS' }, data: { isActive: true } });
        }
        // > MAX chips (10) rejected before any DB validation
        const eleven = ['MEALS', 'STARTERS', 'SIDES', 'DRINKS', 'DESSERTS', 'ROOMS', 'RIDES', 'RETAIL_ITEMS', 'SERVICES', 'UNMAPPED', 'MEALS'];
        await expect(feed({ taxonomy: eleven })).rejects.toMatchObject({ field: 'taxonomy' });
    });

    test('taxonomy: route passes repeated query params through as an array (supertest)', async () => {
        const request = require('supertest');
        const express = require('express');
        const discoveryRouter = require('../routes/discoveryRoutes');
        const prev = process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED;
        const app = express();
        app.set('prisma', db);
        app.use('/api/discovery', discoveryRouter);
        try {
            process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED = 'true';
            const okRes = await request(app).get('/api/discovery/items?taxonomy=MEALS&taxonomy=DRINKS');
            expect(okRes.status).toBe(200);
            expect(okRes.body.success).toBe(true);
            const badRes = await request(app).get('/api/discovery/items?taxonomy=UNMAPPED');
            expect(badRes.status).toBe(422);
            expect(badRes.body.field).toBe('taxonomy');
        } finally {
            if (prev === undefined) delete process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED;
            else process.env.AZM_MARKETPLACE_DISCOVERY_ENABLED = prev;
        }
    });

    // ─── 11. review-correction pass: installer index safety ────────────────

    test('installer: indexes exist and are VALID (concurrent build), and replay is idempotent', async () => {
        const { installMarketplaceDiscoveryOverlay } = require('../infra/install-marketplace-discovery-overlay');
        const first = await installMarketplaceDiscoveryOverlay(db);
        expect(first.indexesCreated + first.indexesRebuilt + first.indexesKept).toBe(3);

        const states = await db.$queryRawUnsafe(
            `SELECT c.relname AS name, i.indisvalid AS valid
               FROM pg_index i
               JOIN pg_class c ON c.oid = i.indexrelid
              WHERE c.relname IN ('business_product_discovery', 'business_product_section_active', 'business_profile_eligible')`
        );
        expect(states.length).toBe(3);
        for (const row of states) expect(row.valid).toBe(true);

        const replay = await installMarketplaceDiscoveryOverlay(db);
        expect(replay.indexesKept).toBe(3); // no rebuild churn on a healthy DB
    });

    test('installer: a failed concurrent build (indisvalid=false) is detected, dropped and rebuilt', async () => {
        const { installMarketplaceDiscoveryOverlay } = require('../infra/install-marketplace-discovery-overlay');
        // Simulate a failed CREATE INDEX CONCURRENTLY: the index exists but is INVALID.
        await db.$executeRawUnsafe(
            `UPDATE pg_index SET indisvalid = false
              WHERE indexrelid = (SELECT oid FROM pg_class WHERE relname = 'business_product_discovery')`
        );
        const result = await installMarketplaceDiscoveryOverlay(db);
        expect(result.indexesRebuilt).toBe(1);
        const rows = await db.$queryRawUnsafe(
            `SELECT i.indisvalid AS valid FROM pg_index i
               JOIN pg_class c ON c.oid = i.indexrelid
              WHERE c.relname = 'business_product_discovery'`
        );
        expect(rows[0].valid).toBe(true);
    });
    // ─── 12. review-correction pass: variant storage-SHAPE truth ───────────
    //
    // The variants/modifierGroups JSON columns hold several legitimate
    // storage shapes (businessProductService flat rows, grouped arrays with
    // options|values, legacy object-keyed configs, modifier legacy keys).
    // These tests pin the DTO for EVERY shape using rows shaped exactly like
    // the sanctioned writers produce, and prove fail-closed behavior for
    // corrupt deltas in each shape. They FAIL against the pre-correction
    // serializer (flat rows lost their options; object-keyed configs were
    // silently nulled).

    test('shapes: FLAT businessProductService rows (real write path) fold into one Size group, every option preserved', async () => {
        const businessProductService = require('../services/businessProductService');
        const { profile } = await seedBusiness();
        const token = `shapetoken${seq}`;
        const flat = await businessProductService.createProduct(db, {
            businessProfileId: profile.id,
            name: `MixP1 flat service item ${seq}`,
            description: token,
            priceUsdc: 4.20,
            variants: [
                { name: 'Small', priceDelta: 0 },
                { name: 'Medium', priceDelta: 1.5 },
                { name: 'Large', priceDelta: 2.25 },
            ],
            modifierGroups: [{
                name: 'Extras',
                maxSelection: 2,
                options: [
                    { name: 'Cheese', priceDelta: 0.5 },
                    { name: 'Bacon', priceDelta: 1 },
                ],
            }],
        });
        await setConfirmedPrice(flat.id, '25.00');

        const page = await feed({ q: token });
        const item = page.items.find((i) => i.id === flat.id);
        expect(item).toBeDefined();
        expect(item.variants).toEqual([
            {
                name: 'Size',
                required: true,
                options: [
                    { name: 'Small', priceDelta: 0 },
                    { name: 'Medium', priceDelta: 1.5 },
                    { name: 'Large', priceDelta: 2.25 },
                ],
            },
        ]);
        // modifierGroups from the sanctioned writer: required is true ONLY
        // when explicit — this row has none, so required: false.
        expect(item.modifierGroups).toEqual([
            {
                name: 'Extras',
                required: false,
                maxSelection: 2,
                options: [
                    { name: 'Cheese', priceDelta: 0.5 },
                    { name: 'Bacon', priceDelta: 1 },
                ],
            },
        ]);
    });

    test('shapes: flat rows carrying priceDeltaGhs (direct-DB legacy rows) — canonical 2dp strings, USDC deltas untouched', async () => {
        const { profile } = await seedBusiness();
        const token = `shapeflat${seq}`;
        const prod = await seedProduct(profile, {
            description: token, totalOrders: 60, variants: [
                { name: 'Small', priceDelta: 0, priceDeltaGhs: '0' },
                { name: 'Medium', priceDelta: 1.5, priceDeltaGhs: '5' },
                { name: 'Large', priceDelta: 2.25, priceDeltaGhs: '-1.5' },
            ],
        });
        await setConfirmedPrice(prod.id, '25.00');

        const page = await feed({ q: token });
        const item = page.items.find((i) => i.id === prod.id);
        expect(item).toBeDefined();
        expect(item.variants).toEqual([{
            name: 'Size', required: true,
            options: [
                { name: 'Small', priceDelta: 0, priceDeltaGhs: '0.00' },
                { name: 'Medium', priceDelta: 1.5, priceDeltaGhs: '5.00' },
                { name: 'Large', priceDelta: 2.25, priceDeltaGhs: '-1.50' },
            ],
        }]);
    });

    test('shapes: GROUPED rows with options AND values keys both surface (values treated identically to options)', async () => {
        const { profile } = await seedBusiness();
        const token = `shapegrp${seq}`;
        const prod = await seedProduct(profile, {
            description: token, totalOrders: 55, variants: [
                { name: 'Size', required: true, options: [
                    { name: 'Regular', priceDelta: 0, priceDeltaGhs: '0' },
                ] },
                { name: 'Color', values: [
                    { name: 'Red', priceDelta: 0.5, priceDeltaGhs: '2.5' },
                ] },
            ],
        });
        await setConfirmedPrice(prod.id, '25.00');

        const page = await feed({ q: token });
        const item = page.items.find((i) => i.id === prod.id);
        expect(item).toBeDefined();
        expect(item.variants).toEqual([
            { name: 'Size', required: true, options: [{ name: 'Regular', priceDelta: 0, priceDeltaGhs: '0.00' }] },
            { name: 'Color', required: true, options: [{ name: 'Red', priceDelta: 0.5, priceDeltaGhs: '2.50' }] },
        ]);
    });

    test('shapes: LEGACY object-keyed variant configs become required groups (the shape the old serializer silently nulled)', async () => {
        const { profile } = await seedBusiness();
        const token = `shapeobj${seq}`;
        const prod = await seedProduct(profile, {
            description: token, totalOrders: 50, variants: {
                Size: [
                    { name: 'Regular', priceDelta: 0, priceDeltaGhs: '0' },
                    { name: 'Large', priceDelta: 1, priceDeltaGhs: '2.5' },
                ],
                'Spice level': [
                    { name: 'Mild', priceDelta: 0 },
                ],
            },
        });
        await setConfirmedPrice(prod.id, '25.00');

        const page = await feed({ q: token });
        const item = page.items.find((i) => i.id === prod.id);
        expect(item).toBeDefined();
        expect(item.variants).toEqual([
            {
                name: 'Size', required: true,
                options: [
                    { name: 'Regular', priceDelta: 0, priceDeltaGhs: '0.00' },
                    { name: 'Large', priceDelta: 1, priceDeltaGhs: '2.50' },
                ],
            },
            { name: 'Spice level', required: true, options: [{ name: 'Mild', priceDelta: 0 }] },
        ]);
    });

    test('shapes: modifier legacy keys (max, values) and explicit required semantics are preserved', async () => {
        const { profile } = await seedBusiness();
        const token = `shapemod${seq}`;
        const prod = await seedProduct(profile, {
            description: token, totalOrders: 45, modifierGroups: [
                { name: 'Extras', max: 2, values: [
                    { name: 'Cheese', priceDelta: 0.5, priceDeltaGhs: '-1.5' },
                ] },
                { name: 'Drinks', required: true, options: [
                    { name: 'Cola', priceDelta: 1 },
                ] },
            ],
        });
        await setConfirmedPrice(prod.id, '25.00');

        const page = await feed({ q: token });
        const item = page.items.find((i) => i.id === prod.id);
        expect(item).toBeDefined();
        expect(item.modifierGroups).toEqual([
            {
                name: 'Extras', required: false, maxSelection: 2,
                options: [{ name: 'Cheese', priceDelta: 0.5, priceDeltaGhs: '-1.50' }],
            },
            {
                name: 'Drinks', required: true, maxSelection: 1,
                options: [{ name: 'Cola', priceDelta: 1 }],
            },
        ]);
    });

    test('shapes: a priceDeltaGhs at the GROUP ROOT is an UNSUPPORTED shape — rejected in every form, never served', async () => {
        const { profile } = await seedBusiness();
        const token = `shaperoot${seq}`;
        const healthy = await seedProduct(profile, {
            description: token, totalOrders: 100, variants: [
                { name: 'Size', options: [{ name: 'Regular', priceDelta: 0, priceDeltaGhs: '1' }] },
            ],
        });
        await setConfirmedPrice(healthy.id, '25.00');
        // The approved contract defines GHS deltas on OPTIONS only; a root
        // delta has no pricing semantics and no bounds check, so it is
        // rejected regardless of how well-formed it is — including the exact
        // out-of-range decimal string the review called out.
        const cases = [
            { variants: [{ name: 'Size', priceDeltaGhs: '2.5', options: [{ name: 'Regular', priceDelta: 0 }] }] }, // well-formed, in range
            { variants: [{ name: 'Size', priceDeltaGhs: '100000.01', options: [{ name: 'Regular', priceDelta: 0 }] }] }, // out-of-range bounds escape
            { variants: [{ name: 'Size', priceDeltaGhs: 5, options: [{ name: 'Regular', priceDelta: 0 }] }] }, // JSON number
            { modifierGroups: [{ name: 'Extras', priceDeltaGhs: '1.005', options: [{ name: 'Cheese', priceDelta: 0 }] }] }, // sub-pesewa at modifier root
        ];
        const bad = [];
        for (const [i, extra] of cases.entries()) {
            const prod = await seedProduct(profile, { description: token, totalOrders: 90 - i, ...extra });
            await setConfirmedPrice(prod.id, '25.00');
            bad.push(prod.id);
        }

        const page = await feed({ q: token });
        const got = ids(page);
        expect(got).toContain(healthy.id);
        for (const id of bad) expect(got).not.toContain(id);
        // the healthy item's OPTION-level delta is still canonicalized
        const served = page.items.find((it) => it.id === healthy.id);
        expect(served.variants[0].options[0].priceDeltaGhs).toBe('1.00');
        // no served DTO ever carries a group-root priceDeltaGhs
        for (const it of page.items) {
            for (const g of (it.variants ?? []).concat(it.modifierGroups ?? [])) {
                expect(Object.prototype.hasOwnProperty.call(g, 'priceDeltaGhs')).toBe(false);
            }
        }
    });

    test('shapes: a GENUINELY MIXED flat+grouped array never silently loses flat options — the item fails closed', async () => {
        const { profile } = await seedBusiness();
        const token = `shapemixed${seq}`;
        const healthy = await seedProduct(profile, {
            description: token, totalOrders: 100, variants: [
                { name: 'Size', options: [{ name: 'Regular', priceDelta: 0 }] },
            ],
        });
        await setConfirmedPrice(healthy.id, '25.00');
        // The legacy normalizer reads a mixed array as grouped and turns each
        // flat row into an empty group — losing the option, its USDC
        // priceDelta and any GHS delta. The feed refuses to publish that.
        const cases = [
            [
                { name: 'Small', priceDelta: 0 },
                { name: 'Color', options: [{ name: 'Red', priceDelta: 0.5 }] },
            ],
            [
                { name: 'Small', priceDelta: 0, priceDeltaGhs: '1' },
                { name: 'Color', values: [{ name: 'Red', priceDelta: 0.5 }] },
            ],
        ];
        const bad = [];
        for (const [i, variants] of cases.entries()) {
            const prod = await seedProduct(profile, { description: token, totalOrders: 90 - i, variants });
            await setConfirmedPrice(prod.id, '25.00');
            bad.push(prod.id);
        }

        const page = await feed({ q: token });
        const got = ids(page);
        expect(got).toContain(healthy.id);
        for (const id of bad) expect(got).not.toContain(id);
        // healthy grouped DTO is intact
        const served = page.items.find((it) => it.id === healthy.id);
        expect(served.variants).toEqual([
            { name: 'Size', required: true, options: [{ name: 'Regular', priceDelta: 0 }] },
        ]);
    });

    test('shapes: INVALID option-level deltas exclude the item in EVERY storage shape (flat, grouped, object-keyed)', async () => {
        const { profile } = await seedBusiness();
        const token = `shapeoptbad${seq}`;
        const healthy = await seedProduct(profile, {
            description: token, totalOrders: 100, variants: [
                { name: 'Size', options: [{ name: 'Regular', priceDelta: 0, priceDeltaGhs: '1' }] },
            ],
        });
        await setConfirmedPrice(healthy.id, '25.00');

        const cases = [
            // flat row with a JSON-number delta
            [{ name: 'Small', priceDelta: 0 }, { name: 'Large', priceDelta: 2, priceDeltaGhs: 7 }],
            // grouped options with sub-pesewa precision
            [{ name: 'Size', options: [{ name: 'Large', priceDelta: 1, priceDeltaGhs: '1.005' }] }],
            // legacy object-keyed config with garbage
            { Size: [{ name: 'Large', priceDelta: 1, priceDeltaGhs: 'free!' }] },
            // values-keyed grouped row with a non-positive worst case
            [{ name: 'Size', values: [{ name: 'Large', priceDelta: 2, priceDeltaGhs: '-30.00' }] }],
        ];
        const bad = [];
        for (const [i, variants] of cases.entries()) {
            const prod = await seedProduct(profile, { description: token, totalOrders: 90 - i, variants });
            await setConfirmedPrice(prod.id, '25.00');
            bad.push(prod.id);
        }

        const page = await feed({ q: token });
        const got = ids(page);
        expect(got).toContain(healthy.id);
        for (const id of bad) expect(got).not.toContain(id);
    });

    test('shapes: an UNNAMED option carrying a priceDeltaGhs is never silently dropped — the item fails closed', async () => {
        const { profile } = await seedBusiness();
        const token = `shapedropped${seq}`;
        const healthy = await seedProduct(profile, {
            description: token, totalOrders: 100, variants: [
                { name: 'Size', options: [{ name: 'Regular', priceDelta: 0 }] },
            ],
        });
        await setConfirmedPrice(healthy.id, '25.00');
        const droppedDelta = await seedProduct(profile, {
            description: token, totalOrders: 90, variants: [
                { name: 'Size', options: [
                    { name: '', priceDeltaGhs: '1.00' }, // nameless → legacy drops the option; carries a delta → corrupt
                    { name: 'Large', priceDelta: 1 },
                ] },
            ],
        });
        await setConfirmedPrice(droppedDelta.id, '25.00');

        const page = await feed({ q: token });
        const got = ids(page);
        expect(got).toContain(healthy.id);
        expect(got).not.toContain(droppedDelta.id);
    });
});
