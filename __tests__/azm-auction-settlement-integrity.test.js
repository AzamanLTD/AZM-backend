// __tests__/azm-auction-settlement-integrity.test.js
// =============================================================================
// AZM auction settlement integrity — real-PostgreSQL suite. Guards the
// atomic settle(): tx-scoped debits, WON/boost/LOST/SETTLED in ONE
// transaction, post-commit side effects only, fail-closed rollback keeps the
// auction retryable. Real Promise.all() vs live Postgres.
// =============================================================================
const { seedAzmBalance } = require('./helpers/factories');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[azm-auction-integrity] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('AZM auction settlement integrity (real PostgreSQL)', () => {
    let prisma, AzmSpendService, AzmAuctionService;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV     = 'test';
        process.env.JWT_SECRET   = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient }   = require('@prisma/client');
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

    const balance = async (userId) =>
        Number((await prisma.user.findUnique({ where: { id: userId }, select: { azmBalance: true } })).azmBalance);

    function makeSides() {
        const emissions = [];
        const notifications = [];
        const io = { emit: (event, payload) => emissions.push({ event, payload }) };
        const notificationService = {
            sendNotification: (n) => { notifications.push(n); return Promise.resolve(); }
        };
        const spendSvc = new AzmSpendService(prisma, io);
        const svc = new AzmAuctionService({ prisma, io, azmSpendService: spendSvc, notificationService });
        return { svc, emissions, notifications };
    }

    async function seedScenario({ winnerCount = 3, bids = [[200, 100]], status = 'OPEN', offsetMs = 0 } = {}) {
        const past = new Date(Date.now() - 60 * 1000 - offsetMs);
        const auction = await prisma.azmAuction.create({
            data: {
                windowStart: new Date(past.getTime() - 24 * 3600 * 1000),
                windowEnd: past, status, winnerCount,
            },
        });
        const bidders = [];
        for (const [bal, bid] of bids) {
            const { id: vendorId } = await seedAzmBalance(prisma, bal);
            const ad = await prisma.ad.create({
                data: {
                    vendorId, type: 'SELL', crypto: 'USDT', pricePerUSD: 15.5,
                    minLimit: 50, maxLimit: 5000, paymentMethod: 'ZELLE',
                    status: 'ACTIVE', isBoosted: false,
                },
            });
            await prisma.azmAuctionBid.create({
                data: { auctionId: auction.id, vendorId, adId: ad.id, bidAmountAzm: bid, status: 'ACTIVE' },
            });
            bidders.push({ vendorId, adId: ad.id, bidAmount: bid, balance: bal });
        }
        return { auction, bidders };
    }

    test('1: successful settlement debits winners exactly once atomically', async () => {
        const { auction, bidders } = await seedScenario({
            bids: [[200, 100], [200, 80], [200, 60], [200, 40]]
        });
        const { svc, emissions, notifications } = makeSides();

        const res = await svc.settle(auction.id);
        expect(res).toMatchObject({ auctionId: auction.id, winners: 3, totalBurned: 240 });

        const bids = await prisma.azmAuctionBid.findMany({ where: { auctionId: auction.id }, orderBy: { rank: 'asc' } });
        expect(bids.filter((b) => b.status === 'WON')).toHaveLength(3);
        expect(bids.filter((b) => b.status === 'LOST')).toHaveLength(1);
        const settled = await prisma.azmAuction.findUnique({ where: { id: auction.id } });
        expect(settled).toMatchObject({ status: 'SETTLED' });
        expect(Number(settled.totalAzmBurned)).toBe(240);
        expect(settled.leaderboard).toHaveLength(3);

        expect(await prisma.azmSpendLog.count({ where: { source: 'AD_AUCTION_BID' } })).toBe(3);
        for (const b of bidders.slice(0, 3)) {
            expect(await balance(b.vendorId)).toBe(200 - b.bidAmount);
            expect((await prisma.ad.findUnique({ where: { id: b.adId } })).isBoosted).toBe(true);
        }
        expect(await balance(bidders[3].vendorId)).toBe(200);
        expect((await prisma.ad.findUnique({ where: { id: bidders[3].adId } })).isBoosted).toBe(false);

        expect(emissions.filter((e) => e.event === 'auction:settled')).toHaveLength(1);
        expect(notifications.filter((n) => n.title.includes('Won'))).toHaveLength(3);
        expect(notifications.filter((n) => n.title.includes('Outbid'))).toHaveLength(1);
    });

    test('2: two simultaneous settle() calls commit exactly one settlement', async () => {
        const { auction, bidders } = await seedScenario({ bids: [[200, 100], [200, 80]] });
        const { svc } = makeSides();

        const [a, b] = await Promise.all([svc.settle(auction.id), svc.settle(auction.id)]);
        expect(a.skipped).not.toEqual(b.skipped); // exactly one settlement committed

        expect(await prisma.azmSpendLog.count({ where: { source: 'AD_AUCTION_BID' } })).toBe(2);
        expect(await prisma.azmAuctionBid.count({ where: { auctionId: auction.id, status: 'WON' } })).toBe(2);
        expect(await balance(bidders[0].vendorId)).toBe(100);
        expect(await balance(bidders[1].vendorId)).toBe(120);
        expect((await prisma.azmAuction.findUnique({ where: { id: auction.id } })).status).toBe('SETTLED');
    });

    test('3: insufficient winner balance rolls the whole settlement back, auction stays recoverable', async () => {
        const { auction, bidders } = await seedScenario({
            bids: [[200, 100], [10, 80], [200, 40]] // bidder 2 cannot cover its bid
        });
        const { svc, emissions, notifications } = makeSides();

        await expect(svc.settle(auction.id)).rejects.toThrow(/Insufficient AZM balance/);

        expect((await prisma.azmAuction.findUnique({ where: { id: auction.id } })).status).toBe('OPEN');
        expect(await prisma.azmSpendLog.count({ where: { source: 'AD_AUCTION_BID' } })).toBe(0);
        expect(await prisma.azmAuctionBid.count({ where: { status: 'WON' } })).toBe(0);
        for (const [i, exp] of [[0, 200], [1, 10], [2, 200]]) {
            expect(await balance(bidders[i].vendorId)).toBe(exp);
            expect((await prisma.ad.findUnique({ where: { id: bidders[i].adId } })).isBoosted).toBe(false);
        }
        expect(emissions).toHaveLength(0);
        expect(notifications).toHaveLength(0);

        await prisma.user.update({ where: { id: bidders[1].vendorId }, data: { azmBalance: 200 } });
        const res = await svc.settle(auction.id);
        expect(res).toMatchObject({ winners: 3, totalBurned: 220 });
        expect((await prisma.azmAuction.findUnique({ where: { id: auction.id } })).status).toBe('SETTLED');
    });

    test('4: downstream failure after a winner debit restores the first winner and allows retry', async () => {
        const { auction, bidders } = await seedScenario({ bids: [[200, 100], [5, 80]] });
        const { svc } = makeSides();

        await expect(svc.settle(auction.id)).rejects.toThrow();

        expect(await balance(bidders[0].vendorId)).toBe(200);
        expect(await prisma.azmAuctionBid.count({ where: { status: 'WON' } })).toBe(0);
        expect(await prisma.azmSpendLog.count({ where: { source: 'AD_AUCTION_BID' } })).toBe(0);
        expect((await prisma.ad.findUnique({ where: { id: bidders[0].adId } })).isBoosted).toBe(false);
        expect((await prisma.azmAuction.findUnique({ where: { id: auction.id } })).status).toBe('OPEN');

        // Retry succeeds once the failing condition clears.
        await prisma.azmAuctionBid.deleteMany({ where: { auctionId: auction.id, vendorId: bidders[1].vendorId } });
        const res = await svc.settle(auction.id);
        expect(res.winners).toBe(1);
        expect(await balance(bidders[0].vendorId)).toBe(100);
    });

    test('5+9: replaying a settled auction never reburns or renotifies', async () => {
        const { auction, bidders } = await seedScenario({ bids: [[200, 100], [200, 80]] });
        const { svc } = makeSides();

        await svc.settle(auction.id);
        const replay = await svc.settle(auction.id);
        expect(replay).toEqual({ skipped: true, reason: 'not open' });

        expect(await prisma.azmSpendLog.count({ where: { source: 'AD_AUCTION_BID' } })).toBe(2);
        expect(await balance(bidders[0].vendorId)).toBe(100);
        expect(await balance(bidders[1].vendorId)).toBe(120);
    });

    test('6: a legacy stranded SETTLING auction is recoverable without reburning claimed winners', async () => {
        const { auction, bidders } = await seedScenario({ bids: [[200, 100], [200, 80]] });

        await prisma.azmAuction.update({ where: { id: auction.id }, data: { status: 'SETTLING' } });
        const spendSvc = new AzmSpendService(prisma, { emit: () => {} });
        await spendSvc.debitAzm({
            userId: bidders[0].vendorId, amount: 100, source: 'AD_AUCTION_BID',
            reason: 'legacy partial burn', metadata: { auctionId: auction.id },
            dedupKey: `auction-win-${auction.id}-${bidders[0].vendorId}`,
        });
        expect(await balance(bidders[0].vendorId)).toBe(100);

        const { svc } = makeSides();
        await svc.settle(auction.id);

        expect(await balance(bidders[0].vendorId)).toBe(100);
        expect(await balance(bidders[1].vendorId)).toBe(120);
        expect(await prisma.azmSpendLog.count({ where: { source: 'AD_AUCTION_BID', dedupKey: `auction-win-${auction.id}-${bidders[0].vendorId}` } })).toBe(1);
        expect((await prisma.azmAuction.findUnique({ where: { id: auction.id } })).status).toBe('SETTLED');
    });

    test('7: rank ordering is highest-bid-first with earliest-bid tiebreak', async () => {
        const { auction, bidders } = await seedScenario({
            winnerCount: 2, bids: [[500, 100], [500, 60], [500, 80]]
        });
        const { svc } = makeSides();

        expect((await svc.settle(auction.id)).winners).toBe(2);

        const won = await prisma.azmAuctionBid.findMany({ where: { auctionId: auction.id, status: 'WON' }, orderBy: { rank: 'asc' } });
        expect(won.map((b) => b.vendorId)).toEqual([bidders[0].vendorId, bidders[2].vendorId]);
        expect(won.map((b) => b.rank)).toEqual([1, 2]);
        expect((await prisma.azmAuctionBid.findFirst({ where: { auctionId: auction.id, status: 'LOST' } })).vendorId)
            .toBe(bidders[1].vendorId);
    });

    test('8: an auction with no bids settles with an empty leaderboard and zero burn', async () => {
        const { auction } = await seedScenario({ bids: [] });
        const { svc, emissions } = makeSides();

        expect(await svc.settle(auction.id)).toMatchObject({ winners: 0, totalBurned: 0 });
        const settled = await prisma.azmAuction.findUnique({ where: { id: auction.id } });
        expect(settled).toMatchObject({ status: 'SETTLED' });
        expect(settled.leaderboard).toHaveLength(0);
        expect(emissions[0].event).toBe('auction:settled');
    });

    test('10: settlement only mutates bids of its own auction', async () => {
        const { auction: auctionA, bidders } = await seedScenario({ bids: [[200, 100]] });
        const { auction: auctionB } = await seedScenario({ offsetMs: 30 * 1000, bids: [[200, 80]] });
        const { svc } = makeSides();

        expect((await svc.settle(auctionA.id)).winners).toBe(1);

        expect(await prisma.azmAuctionBid.count({ where: { auctionId: auctionA.id, status: 'WON' } })).toBe(1);
        const bBid = await prisma.azmAuctionBid.findFirst({ where: { auctionId: auctionB.id } });
        expect(bBid.status).toBe('ACTIVE'); // untouched
        expect((await prisma.azmAuction.findUnique({ where: { id: auctionB.id } })).status).toBe('OPEN');
        expect(await balance(bidders[0].vendorId)).toBe(100);
        expect(await balance(bBid.vendorId)).toBe(200); // the other auction's bidder
    });
});
