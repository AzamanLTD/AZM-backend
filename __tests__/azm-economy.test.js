// __tests__/azm-economy.test.js
// =============================================================================
// AZM Token Economy integration tests
//
// Covers:
//   A. debitAzm: atomically decrements azmBalance and writes an AzmSpendLog
//   B. debitAzm: insufficient balance throws, no partial debit
//   C. debitAzm: duplicate dedupKey is a no-op (idempotent)
//   D. boostAd: deducts AZM, sets Ad.isBoosted=true + boostExpiresAt
//   E. boostAd: vendor with insufficient AZM cannot boost
//   F. auction settle: top N bidders burned, non-winners untouched, winning Ads
//      flipped to isBoosted, auction status → SETTLED
//
// Adapted to the ACTUAL services (verified, NOT the design-doc shapes):
//   • azmSpendService exports { AzmSpendService }; new AzmSpendService(prisma).
//     debitAzm({ userId, amount, source, reason, dedupKey }) → throws on
//     insufficient, returns { debited:false, newBalance } on a dedup hit.
//   • azmAuctionService exports { AzmAuctionService }; its constructor takes a
//     SINGLE OBJECT: new AzmAuctionService({ prisma, azmSpendService }) — NOT
//     positional (prisma, spendSvc).
//   • settle() requires the auction to be OPEN with windowEnd already past; it
//     reads winnerCount off the auction row and burns the top-N ACTIVE bids.
//   • There is NO AzmEarnLog table — the reward-audit table is AzmRewardLog, so
//     the afterEach TRUNCATE lists AzmRewardLog (truncating a missing table
//     would throw and break teardown).
//
// SKIPS unless TEST_DATABASE_URL is set.
// =============================================================================
const { seedAzmBalance } = require('./helpers/factories');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[azm-economy.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('AZM token economy', () => {
    let prisma, AzmSpendService, AzmAuctionService;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV     = 'test';
        process.env.JWT_SECRET   = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma            = new PrismaClient();
        AzmSpendService   = require('../services/azmSpendService').AzmSpendService;
        AzmAuctionService = require('../services/azmAuctionService').AzmAuctionService;
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User","Ad","AzmRewardLog","AzmSpendLog","AzmAuction",' +
            '"AzmAuctionBid","TransactionHistory" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    async function seedAd(vendorId) {
        return prisma.ad.create({
            data: {
                vendorId,
                type: 'SELL',
                crypto: 'USDT',
                pricePerUSD: 15.5,
                minLimit: 50,
                maxLimit: 5000,
                paymentMethod: 'ZELLE',
                status: 'ACTIVE',
                isBoosted: false,
            },
        });
    }

    // ── A. debitAzm happy path ─────────────────────────────────────────────────
    test('A: debitAzm decrements azmBalance and writes AzmSpendLog', async () => {
        const { id: userId } = await seedAzmBalance(prisma, 200);
        const svc = new AzmSpendService(prisma);

        const result = await svc.debitAzm({
            userId,
            amount: 50,
            source: 'FEE_DISCOUNT',
            reason: 'Test debit',
        });
        expect(Number(result.newBalance)).toBeCloseTo(150, 1);

        const user = await prisma.user.findUnique({ where: { id: userId } });
        expect(Number(user.azmBalance)).toBeCloseTo(150, 1);

        const log = await prisma.azmSpendLog.findFirst({ where: { userId } });
        expect(log).not.toBeNull();
        expect(Number(log.amount)).toBe(50);
    });

    // ── B. Insufficient AZM ────────────────────────────────────────────────────
    test('B: debitAzm throws on insufficient balance — no partial debit', async () => {
        const { id: userId } = await seedAzmBalance(prisma, 10);
        const svc = new AzmSpendService(prisma);

        await expect(
            svc.debitAzm({ userId, amount: 500, source: 'FEE_DISCOUNT', reason: 'Test' })
        ).rejects.toThrow(/insufficient/i);

        const user = await prisma.user.findUnique({ where: { id: userId } });
        expect(Number(user.azmBalance)).toBe(10); // unchanged
    });

    // ── C. Deduplication key ────────────────────────────────────────────────────
    test('C: debitAzm with same dedupKey is idempotent (no double-debit)', async () => {
        const { id: userId } = await seedAzmBalance(prisma, 300);
        const svc = new AzmSpendService(prisma);
        const key = `dedup_test_${userId}`;

        await svc.debitAzm({ userId, amount: 100, source: 'AD_BOOST', reason: 'First', dedupKey: key });
        const balAfterFirst = Number((await prisma.user.findUnique({ where: { id: userId } })).azmBalance);

        // Second call with the same key — must be a no-op.
        await svc.debitAzm({ userId, amount: 100, source: 'AD_BOOST', reason: 'Second', dedupKey: key });
        const balAfterSecond = Number((await prisma.user.findUnique({ where: { id: userId } })).azmBalance);

        expect(balAfterSecond).toBe(balAfterFirst);
    });

    // ── D. boostAd: debits AZM and sets isBoosted ─────────────────────────────
    test('D: boostAd deducts AZM and sets Ad.isBoosted + boostExpiresAt', async () => {
        const vendor = await seedAzmBalance(prisma, 500, { role: 'VENDOR' });
        const ad = await seedAd(vendor.id);
        const svc = new AzmSpendService(prisma);

        const result = await svc.boostAd(vendor.id, ad.id, 'boost_24h');
        expect(result.boostExpiresAt).toBeDefined();
        expect(new Date(result.boostExpiresAt).getTime()).toBeGreaterThan(Date.now());

        const updatedAd = await prisma.ad.findUnique({ where: { id: ad.id } });
        expect(updatedAd.isBoosted).toBe(true);
        expect(updatedAd.boostExpiresAt).not.toBeNull();

        const updatedUser = await prisma.user.findUnique({ where: { id: vendor.id } });
        expect(Number(updatedUser.azmBalance)).toBeLessThan(500);
    });

    // ── E. boostAd: insufficient AZM ──────────────────────────────────────────
    test('E: boostAd throws when vendor has insufficient AZM', async () => {
        const vendor = await seedAzmBalance(prisma, 1, { role: 'VENDOR' }); // nearly empty
        const ad = await seedAd(vendor.id);
        const svc = new AzmSpendService(prisma);

        await expect(svc.boostAd(vendor.id, ad.id, 'boost_24h')).rejects.toThrow();

        const updatedAd = await prisma.ad.findUnique({ where: { id: ad.id } });
        expect(updatedAd.isBoosted).toBe(false);
    });

    // ── F. Auction settle: top N burned, non-winners untouched ────────────────
    test('F: settle burns top bidders and sets isBoosted on their ads', async () => {
        // 4 vendors; top 3 (by bid amount) win. Each pair is [azmBalance, bidAzm].
        const bids = [];
        for (const [azm, bidAzm] of [[400, 300], [350, 250], [300, 200], [250, 150]]) {
            const v  = await seedAzmBalance(prisma, azm, { role: 'VENDOR' });
            const ad = await seedAd(v.id);
            bids.push({ vendor: v, ad, bidAzm });
        }

        // An auction window that has just closed.
        const now = Date.now();
        const auction = await prisma.azmAuction.create({
            data: {
                status:      'OPEN',
                windowStart: new Date(now - 86400000),
                windowEnd:   new Date(now - 1000), // just ended
                winnerCount: 3,
            },
        });

        for (const b of bids) {
            await prisma.azmAuctionBid.create({
                data: {
                    auctionId:    auction.id,
                    vendorId:     b.vendor.id,
                    adId:         b.ad.id,
                    bidAmountAzm: b.bidAzm,
                    status:       'ACTIVE',
                },
            });
        }

        const spendSvc = new AzmSpendService(prisma);
        const aucSvc   = new AzmAuctionService({ prisma, azmSpendService: spendSvc });

        await aucSvc.settle(auction.id);

        // Top 3 vendors: AZM burned + their ad boosted.
        for (const b of bids.slice(0, 3)) {
            const u = await prisma.user.findUnique({ where: { id: b.vendor.id } });
            expect(Number(u.azmBalance)).toBeLessThan(b.vendor.azmBalance);
            const ad = await prisma.ad.findUnique({ where: { id: b.ad.id } });
            expect(ad.isBoosted).toBe(true);
        }

        // 4th bidder (loser) keeps their AZM.
        const loser = bids[3];
        const loserUser = await prisma.user.findUnique({ where: { id: loser.vendor.id } });
        expect(Number(loserUser.azmBalance)).toBe(loser.vendor.azmBalance);

        // Auction is SETTLED.
        const settled = await prisma.azmAuction.findUnique({ where: { id: auction.id } });
        expect(settled.status).toBe('SETTLED');
    });
});
