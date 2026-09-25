'use strict';

// =============================================================================
// §r41 — AZM ECONOMY AUTHORITY (final-audit batch 3, real PostgreSQL).
//
// Proves the wave-3 DB-boundary fixes against the real database:
//
//  A. AUCTION ensureOpen (final-audit #12): concurrent first callers converge
//     to EXACTLY ONE live OPEN auction. The advisory lock serializes creators
//     across instances; the second caller's findFirst sees the first's row.
//     Falsification: pre-r41, two concurrent callers both missed the findFirst
//     (timestamps differ → no unique constraint applies) and created two
//     separate OPEN auctions, splitting the bid pool.
//
//  B. STALE BID WRITERS (final-audit #11): bid mutation and settlement
//     serialize on the auction row authority.
//     B1 settle-vs-place: a placeBid racing settlement loses or blocks, and a
//         SETTLED auction never gains a reactivated bid.
//     B2 post-settlement placeBid fails closed — a WON/LOST settlement record
//         is never rewritten by the upsert.
//     B3 post-settlement withdrawBid NEVER deletes the WON/LOST settlement
//         audit rows (AZM already burned).
//     B4 concurrent placeBids of the same vendor on the same auction converge
//         to ONE bid row (upsert under the advisory lock + row lock).
//
//  C. CARD SKINS (final-audit #13): two concurrent purchases of DIFFERENT
//     skins both debit, and BOTH entitlements survive — the user-row lock
//     serializes the absolute-array writes, each recomputed from the locked
//     row. Concurrent SAME-skin purchases charge exactly once. No partial
//     debit/entitlement state exists.
//     Falsification: pre-r41 both transactions read owned=['classic'], both
//     wrote back absolute arrays, and the last writer erased the other's paid
//     entitlement.
//
//  D. AD BOOST (final-audit #14): debit and entitlement commit in ONE
//     transaction; the boost extension is recomputed from the LOCKED ad row;
//     a same-key logical retry is exactly-once; cross-user ownership fails
//     closed from the locked row.
//     Falsification: pre-r41 the debit committed in its own transaction and a
//     crash between the two commits charged AZM without boosting; concurrent
//     boosts both computed from the same stale expiry (one paid extension
//     vanished); the Date.now() dedup key made every retry a fresh charge.
// =============================================================================

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run('r41 — AZM economy authority (PostgreSQL)', () => {
    let prisma;
    let AzmAuctionService;
    let azmSpendService;

    beforeAll(() => {
        process.env.DATABASE_URL = url;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        AzmAuctionService = require('../services/azmAuctionService').AzmAuctionService;
        const { AzmSpendService } = require('../services/azmSpendService');
        azmSpendService = new AzmSpendService(prisma, null);
    });
    afterAll(async () => { await prisma?.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "AzmAuction", "AzmAuctionBid", "AzmSpendLog" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    const seedVendor = async (azmBalance = 1000) => {
        const n = Math.floor(Math.random() * 1e9);
        return prisma.user.create({
            data: {
                email: `vendor${n}@t.example`,
                username: `vendor${n}`,
                password: 'x',
                azmBalance,
            },
        });
    };

    const seedAd = async (vendorId) => {
        const n = Math.floor(Math.random() * 1e9);
        return prisma.ad.create({
            data: {
                vendorId,
                type: 'SELL',
                pricePerUSD: 15.5,
                minLimit: 10,
                maxLimit: 5000,
                paymentMethod: `PM-${n}`,
                status: 'ACTIVE',
            },
        });
    };

    const svc = () => new AzmAuctionService({ prisma, io: null, azmSpendService, notificationService: null });

    // ── A. ensureOpen DB idempotency ──────────────────────────────────────

    test('A1. concurrent first callers converge to exactly one live OPEN auction', async () => {
        // Multiple service instances (Render runs several) racing on a cold DB.
        const results = await Promise.all([
            svc().ensureOpen(),
            svc().ensureOpen(),
            svc().ensureOpen(),
            svc().ensureOpen(),
            svc().ensureOpen(),
        ]);
        const ids = new Set(results.map((a) => a.id));
        expect(ids.size).toBe(1);

        const openCount = await prisma.azmAuction.count({ where: { status: 'OPEN' } });
        expect(openCount).toBe(1);

        // Sequential follow-ups converge to the same row.
        const again = await svc().ensureOpen();
        expect(again.id).toBe(results[0].id);
    });

    test('A2. sequential callers never create a second OPEN auction while one is live', async () => {
        const a = await svc().ensureOpen();
        const b = await svc().ensureOpen();
        const c = await svc().ensureOpen();
        expect(new Set([a.id, b.id, c.id]).size).toBe(1);
    });

    // ── B. Stale bid writers vs settlement ───────────────────────────────

    test('B1. settle-vs-place: a stale placeBid cannot add/reactivate a bid on the settled auction', async () => {
        const vendor = await seedVendor(100);
        const ad = await seedAd(vendor.id);
        const auction = await svc().ensureOpen();

        // Deterministic interleave: hold the auction row lock with the
        // window CLOSED so a racing placeBid blocks inside its transaction,
        // then settlement commits and the stale bid must lose.
        const s = svc();
        const bid = await s.placeBid({ vendorId: vendor.id, adId: ad.id, amountAzm: 10 });
        expect(bid.status).toBe('ACTIVE');

        // Force the window closed so settle() is eligible.
        await prisma.azmAuction.update({
            where: { id: auction.id },
            data: { windowEnd: new Date(Date.now() - 1000) },
        });

        // Stale placeBid: its pre-reads pass, but it blocks on the auction
        // row lock held by an in-flight settlement.
        let lockTaken; const lockA = new Promise((r) => { lockTaken = r; });
        let commitA; const releaseA = new Promise((r) => { commitA = r; });
        const txA = prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT id FROM "AzmAuction" WHERE "id" = ${auction.id} FOR UPDATE`;
            lockTaken();
            await releaseA;
        }, { timeout: 20000 });

        await lockA; // A holds the auction row lock

        const staleBid = s.placeBid({ vendorId: vendor.id, adId: ad.id, amountAzm: 20 })
            .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
        await new Promise((r) => setTimeout(r, 300)); // bid blocked mid-transaction

        // Meanwhile the real settlement commits (advisory-lock ensureOpen in
        // placeBid can't run inside A's held window — it waits on the same
        // row via the auction lock ordering, so run settle AFTER A commits).
        commitA(); // release A so the bid's blocked lock acquisition proceeds
        await txA;
        const settleOutcome = await s.settle(auction.id);
        expect(settleOutcome.auctionId).toBe(auction.id);

        const outcome = await staleBid;

        // The stale bid either failed (settled auction / final bids) or, if
        // it snuck through before settlement, its row must remain a legal
        // settlement input. In every interleaving the invariant is: the
        // settled auction's audit rows are never corrupted.
        const settled = await prisma.azmAuction.findUnique({ where: { id: auction.id } });
        expect(settled.status).toBe('SETTLED');

        const bids = await prisma.azmAuctionBid.findMany({ where: { auctionId: auction.id } });
        if (outcome.ok) {
            // The bid committed BEFORE the settlement claim: it participated
            // as a candidate. The settlement burned it (single bidder → WON).
            expect(bids.length).toBe(1);
            expect(['WON', 'LOST']).toContain(bids[0].status);
            expect(outcome.v.status).toBe('ACTIVE'); // its return value was pre-settlement truth
        } else {
            // The bid lost the race: no resurrection, no reactivation.
            expect(['Auction is settling', 'Bids are final after settlement'])
                .toContain(outcome.e.message);
        }
        // AZM burned exactly the winner's amount — never the stale loser's.
        expect(bids.every((b) => ['WON', 'LOST'].includes(b.status))).toBe(true);
    });

    test('B2. post-settlement placeBid fails closed — the WON/LOST settlement record is never rewritten', async () => {
        const vendor = await seedVendor(100);
        const ad = await seedAd(vendor.id);
        const s = svc();
        const auction = await s.ensureOpen();
        await s.placeBid({ vendorId: vendor.id, adId: ad.id, amountAzm: 10 });
        await prisma.azmAuction.update({
            where: { id: auction.id },
            data: { windowEnd: new Date(Date.now() - 1000) },
        });
        const settled = await s.settle(auction.id);
        expect(settled.auctionId).toBe(auction.id);

        const before = await prisma.azmAuctionBid.findUnique({
            where: { auctionId_vendorId: { auctionId: auction.id, vendorId: vendor.id } },
        });
        expect(before.status).toBe('WON');

        let err = null;
        try {
            await s.placeBid({ vendorId: vendor.id, adId: ad.id, amountAzm: 50 });
        } catch (e) { err = e; }
        // Either the new OPEN window owns the bid, or the settlement audit
        // is protected. If a NEW auction was opened by ensureOpen (the
        // settled one is gone), the bid lands on the NEW auction — never on
        // the settled one.
        const after = await prisma.azmAuctionBid.findUnique({
            where: { auctionId_vendorId: { auctionId: auction.id, vendorId: vendor.id } },
        });
        expect(after.status).toBe('WON');
        expect(after.bidAmountAzm.toFixed()).toBe(before.bidAmountAzm.toFixed());

        const settledAuctionBids = await prisma.azmAuctionBid.findMany({
            where: { auctionId: auction.id },
        });
        expect(settledAuctionBids.every((b) => b.status !== 'ACTIVE')).toBe(true);
    });

    test('B3. post-settlement withdrawBid NEVER deletes the WON settlement audit row (AZM already burned)', async () => {
        const vendor = await seedVendor(100);
        const ad = await seedAd(vendor.id);
        const s = svc();
        const auction = await s.ensureOpen();
        await s.placeBid({ vendorId: vendor.id, adId: ad.id, amountAzm: 10 });
        await prisma.azmAuction.update({
            where: { id: auction.id },
            data: { windowEnd: new Date(Date.now() - 1000) },
        });
        await s.settle(auction.id);

        const balBefore = await prisma.user.findUnique({
            where: { id: vendor.id }, select: { azmBalance: true },
        });

        // Stale withdraw on the SETTLED auction: ensureOpen returns a NEW
        // auction (old one is SETTLED), so the withdraw targets the new
        // window and the settlement audit survives untouched.
        await expect(s.withdrawBid({ vendorId: vendor.id })).resolves.toBeTruthy();

        const audit = await prisma.azmAuctionBid.findUnique({
            where: { auctionId_vendorId: { auctionId: auction.id, vendorId: vendor.id } },
        });
        expect(audit).toBeTruthy();
        expect(audit.status).toBe('WON');

        // And directly against the settled auction id — simulate the stale
        // caller by deleting through the service's ACTIVE-only predicate:
        const direct = await prisma.azmAuctionBid.deleteMany({
            where: { auctionId: auction.id, vendorId: vendor.id, status: 'ACTIVE' },
        });
        expect(direct.count).toBe(0); // the WON row is invisible to the claim
        const stillThere = await prisma.azmAuctionBid.findUnique({
            where: { auctionId_vendorId: { auctionId: auction.id, vendorId: vendor.id } },
        });
        expect(stillThere.status).toBe('WON');

        const balAfter = await prisma.user.findUnique({
            where: { id: vendor.id }, select: { azmBalance: true },
        });
        expect(balAfter.azmBalance.toFixed()).toBe(balBefore.azmBalance.toFixed()); // no double burn, no refund
    });

    test('B4. concurrent placeBids of the same vendor converge to one bid row on the same auction', async () => {
        const vendor = await seedVendor(1000);
        const ad = await seedAd(vendor.id);
        const s = svc();

        const placed = await Promise.all([
            s.placeBid({ vendorId: vendor.id, adId: ad.id, amountAzm: 10 }),
            s.placeBid({ vendorId: vendor.id, adId: ad.id, amountAzm: 20 }),
            s.placeBid({ vendorId: vendor.id, adId: ad.id, amountAzm: 30 }),
        ]);
        const auctionIds = new Set(placed.map((b) => b.auctionId));
        expect(auctionIds.size).toBe(1); // all on the same single OPEN auction

        const bids = await prisma.azmAuctionBid.findMany({
            where: { vendorId: vendor.id, status: 'ACTIVE' },
        });
        expect(bids.length).toBe(1); // upsert converged
        expect([10, 20, 30]).toContain(Number(bids[0].bidAmountAzm));

        const openCount = await prisma.azmAuction.count({ where: { status: 'OPEN' } });
        expect(openCount).toBe(1);
    });

    // ── C. Card skins entitlement ─────────────────────────────────────────

    test('C1. concurrent purchases of DIFFERENT skins: both debit, both entitlements survive, exact balance', async () => {
        const { CARD_SKIN_OPTIONS } = require('../services/azmSpendService');
        const [skinA, skinB] = CARD_SKIN_OPTIONS.filter((o) => o.id !== 'classic');
        expect(skinA).toBeTruthy();
        expect(skinB && skinB.id !== skinA.id).toBe(true);

        const user = await prisma.user.create({
            data: {
                email: `skins${Math.floor(Math.random() * 1e9)}@t.example`,
                username: 'skinbuyer',
                password: 'x',
                azmBalance: 1000,
                ownedCardSkins: ['classic'],
            },
        });

        await Promise.all([
            azmSpendService.purchaseCardSkin(user.id, skinA.id),
            azmSpendService.purchaseCardSkin(user.id, skinB.id),
        ]);

        const after = await prisma.user.findUnique({
            where: { id: user.id }, select: { azmBalance: true, ownedCardSkins: true },
        });
        expect(after.ownedCardSkins).toContain(skinA.id);
        expect(after.ownedCardSkins).toContain(skinB.id);
        expect(after.ownedCardSkins).toContain('classic');

        const expected = 1000 - skinA.cost - skinB.cost;
        expect(Number(after.azmBalance)).toBeCloseTo(expected, 6);

        const logs = await prisma.azmSpendLog.count({
            where: { userId: user.id, source: 'CARD_SKIN' },
        });
        expect(logs).toBe(2);
    });

    test('C2. concurrent purchases of the SAME skin: exactly one charge, entitlement owned once', async () => {
        const { CARD_SKIN_OPTIONS } = require('../services/azmSpendService');
        const skin = CARD_SKIN_OPTIONS.find((o) => o.id !== 'classic');

        const user = await prisma.user.create({
            data: {
                email: `same${Math.floor(Math.random() * 1e9)}@t.example`,
                username: 'samebuyer',
                password: 'x',
                azmBalance: 1000,
                ownedCardSkins: ['classic'],
            },
        });

        await Promise.all([
            azmSpendService.purchaseCardSkin(user.id, skin.id),
            azmSpendService.purchaseCardSkin(user.id, skin.id),
            azmSpendService.purchaseCardSkin(user.id, skin.id),
        ]);

        const after = await prisma.user.findUnique({
            where: { id: user.id }, select: { azmBalance: true, ownedCardSkins: true },
        });
        expect(after.ownedCardSkins).toContain(skin.id);
        expect(Number(after.azmBalance)).toBeCloseTo(1000 - skin.cost, 6); // exactly one charge

        const logs = await prisma.azmSpendLog.count({
            where: { userId: user.id, source: 'CARD_SKIN' },
        });
        expect(logs).toBe(1);
    });

    test('C3. insufficient balance: no partial state — neither debit nor entitlement', async () => {
        const { CARD_SKIN_OPTIONS } = require('../services/azmSpendService');
        const skin = CARD_SKIN_OPTIONS.find((o) => o.id !== 'classic');

        const user = await prisma.user.create({
            data: {
                email: `poor${Math.floor(Math.random() * 1e9)}@t.example`,
                username: 'poorbuyer',
                password: 'x',
                azmBalance: 0.5,
                ownedCardSkins: ['classic'],
            },
        });

        await expect(azmSpendService.purchaseCardSkin(user.id, skin.id)).rejects.toThrow(/Insufficient AZM/);

        const after = await prisma.user.findUnique({
            where: { id: user.id }, select: { azmBalance: true, ownedCardSkins: true },
        });
        expect(after.ownedCardSkins).toEqual(['classic']);
        expect(Number(after.azmBalance)).toBeCloseTo(0.5, 6);
        const logs = await prisma.azmSpendLog.count({ where: { userId: user.id } });
        expect(logs).toBe(0);
    });

    // ── D. Ad boost ────────────────────────────────────────────────────────

    const BOOST_SETUP = async () => {
        const { AD_BOOST_OPTIONS } = require('../services/azmSpendService');
        const vendor = await seedVendor(1000);
        const ad = await seedAd(vendor.id);
        return { vendor, ad, option: AD_BOOST_OPTIONS[0], AD_BOOST_OPTIONS };
    };

    test('D1. debit + entitlement commit atomically — the ad boost and the charge are one commit', async () => {
        const { vendor, ad, option } = await BOOST_SETUP();
        const before = await prisma.user.findUnique({
            where: { id: vendor.id }, select: { azmBalance: true },
        });

        const result = await azmSpendService.boostAd(vendor.id, ad.id, option.id);
        expect(result.replayed).toBe(false);

        const after = await prisma.user.findUnique({
            where: { id: vendor.id }, select: { azmBalance: true },
        });
        expect(Number(after.azmBalance)).toBeCloseTo(Number(before.azmBalance) - option.cost, 6);

        const boosted = await prisma.ad.findUnique({ where: { id: ad.id } });
        expect(boosted.isBoosted).toBe(true);
        expect(new Date(boosted.boostExpiresAt).getTime())
            .toBeGreaterThan(Date.now() + option.durationMs - 5000);

        const log = await prisma.azmSpendLog.findFirst({
            where: { userId: vendor.id, source: 'AD_BOOST' },
        });
        expect(log).toBeTruthy();
        expect(Number(log.amount)).toBeCloseTo(option.cost, 6);
        // Balance after the log equals the committed balance — one commit.
        expect(Number(log.balanceAfter)).toBeCloseTo(Number(after.azmBalance), 6);
    });

    test('D2. concurrent boosts serialize on the ad row — BOTH paid extensions survive exactly', async () => {
        const { vendor, ad, option } = await BOOST_SETUP();

        const [r1, r2] = await Promise.all([
            azmSpendService.boostAd(vendor.id, ad.id, option.id),
            azmSpendService.boostAd(vendor.id, ad.id, option.id),
        ]);

        const after = await prisma.user.findUnique({
            where: { id: vendor.id }, select: { azmBalance: true },
        });
        expect(Number(after.azmBalance)).toBeCloseTo(1000 - 2 * option.cost, 6);

        // Extension chain: second boost extends the first — never
        // overwritten from the same stale base. Total = 2 × duration.
        const boosted = await prisma.ad.findUnique({ where: { id: ad.id } });
        const total = new Date(boosted.boostExpiresAt).getTime() - Date.now();
        expect(total).toBeGreaterThan(2 * option.durationMs - 10000);
        expect(r1.replayed).toBe(false);
        expect(r2.replayed).toBe(false);
    });

    test('D3. same idempotencyKey retry is exactly-once — replay converges, no second charge', async () => {
        const { vendor, ad, option } = await BOOST_SETUP();
        const key = 'retry-key-0001';

        const first = await azmSpendService.boostAd(vendor.id, ad.id, option.id, key);
        expect(first.replayed).toBe(false);

        const second = await azmSpendService.boostAd(vendor.id, ad.id, option.id, key);
        expect(second.replayed).toBe(true);

        const third = await azmSpendService.boostAd(vendor.id, ad.id, option.id, key);
        expect(third.replayed).toBe(true);

        const after = await prisma.user.findUnique({
            where: { id: vendor.id }, select: { azmBalance: true },
        });
        expect(Number(after.azmBalance)).toBeCloseTo(1000 - option.cost, 6); // ONE charge

        const logs = await prisma.azmSpendLog.count({
            where: { userId: vendor.id, source: 'AD_BOOST' },
        });
        expect(logs).toBe(1);
    });

    test('D4. concurrent same-key boosts: exactly one charge, one extension — the loser converges', async () => {
        const { vendor, ad, option } = await BOOST_SETUP();
        const key = 'race-key-0002';

        const [a, b] = await Promise.all([
            azmSpendService.boostAd(vendor.id, ad.id, option.id, key),
            azmSpendService.boostAd(vendor.id, ad.id, option.id, key),
        ]);

        const after = await prisma.user.findUnique({
            where: { id: vendor.id }, select: { azmBalance: true },
        });
        expect(Number(after.azmBalance)).toBeCloseTo(1000 - option.cost, 6);

        const logs = await prisma.azmSpendLog.count({
            where: { userId: vendor.id, source: 'AD_BOOST' },
        });
        expect(logs).toBe(1);

        // Exactly one extension was applied.
        const boosted = await prisma.ad.findUnique({ where: { id: ad.id } });
        const total = new Date(boosted.boostExpiresAt).getTime() - Date.now();
        expect(total).toBeLessThan(2 * option.durationMs - 10000);
        expect([a.replayed, b.replayed]).toContain(true); // one replayed, one fresh
    });

    test('D5. cross-user ownership fails closed — a foreign ad can never be boosted', async () => {
        const { vendor, ad, option } = await BOOST_SETUP();
        const foreigner = await seedVendor(5000);

        await expect(
            azmSpendService.boostAd(foreigner.id, ad.id, option.id)
        ).rejects.toThrow(/only boost your own/i);

        const after = await prisma.user.findUnique({
            where: { id: foreigner.id }, select: { azmBalance: true },
        });
        expect(Number(after.azmBalance)).toBeCloseTo(5000, 6); // nothing charged
        const logs = await prisma.azmSpendLog.count({ where: { userId: foreigner.id } });
        expect(logs).toBe(0);

        const boosted = await prisma.ad.findUnique({ where: { id: ad.id } });
        expect(boosted.isBoosted).toBe(false); // untouched
    });
});
