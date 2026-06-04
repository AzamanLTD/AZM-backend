// services/azmAuctionService.js
// =============================================================================
// AZAMAN — AZM AUCTION SERVICE  (Master Sprint, 2026-05-27)
//
// Vendors bid AZM (loyalty points) to pin their ad to the top of the P2P
// marketplace. Every 24h at midnight UTC, the top N bidders' AZM is BURNED
// (not refunded) and their ads get `Ad.isBoosted = true` for the next 24h.
//
// Burn-on-win semantics
//   • Bidders are NOT debited at bid placement (keeps the auction blind
//     and avoids stuck refund logic for losers).
//   • Settlement: top N bids get their AZM debited via azmSpendService;
//     losers are marked LOST without any AZM movement.
//   • At settlement, each winning Ad is flagged `isBoosted=true` with
//     `boostExpiresAt = settledAt + 24h`. Existing boosts are extended.
// =============================================================================

const { Prisma } = require('@prisma/client');

const WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINNER_COUNT = 3;

class AzmAuctionService {
    constructor({ prisma, io, azmSpendService, notificationService }) {
        this.prisma = prisma;
        this.io = io;
        this.azmSpendService = azmSpendService;
        this.notificationService = notificationService;
    }

    // =========================================================================
    // CURRENT AUCTION (creation idempotent)
    // =========================================================================

    async ensureOpen() {
        const existing = await this.prisma.azmAuction.findFirst({
            where: { status: 'OPEN', windowEnd: { gt: new Date() } },
        });
        if (existing) return existing;

        // Compute next window (start = now-aligned to next midnight UTC,
        // length = 24h). We use a simple "from-now" model for MVP.
        const now = new Date();
        const windowStart = now;
        const windowEnd = new Date(now.getTime() + WINDOW_MS);
        return this.prisma.azmAuction.create({
            data: {
                windowStart,
                windowEnd,
                status: 'OPEN',
                winnerCount: DEFAULT_WINNER_COUNT,
            },
        });
    }

    async getCurrent() {
        const auction = await this.ensureOpen();
        // Top 10 leaderboard (excluding bid amounts to keep blind — only
        // expose vendor identities + ad ids).
        const bids = await this.prisma.azmAuctionBid.findMany({
            where: { auctionId: auction.id, status: 'ACTIVE' },
            orderBy: { bidAmountAzm: 'desc' },
            take: 10,
            include: {
                vendor: { select: { id: true, username: true } },
                ad: { select: { id: true, paymentMethod: true } },
            },
        });
        return {
            auction,
            // Don't expose bid amounts to consumers — only the count and
            // a "your bid" lookup for the requester via /bid endpoint.
            participantCount: bids.length,
            participants: bids.map((b) => ({
                vendorId: b.vendor.id,
                vendorUsername: b.vendor.username,
                adId: b.ad.id,
                paymentMethod: b.ad.paymentMethod,
            })),
        };
    }

    async getMyBid(vendorId) {
        const auction = await this.ensureOpen();
        const bid = await this.prisma.azmAuctionBid.findUnique({
            where: { auctionId_vendorId: { auctionId: auction.id, vendorId } },
        });
        return { auction, bid };
    }

    // =========================================================================
    // BIDDING
    // =========================================================================

    async placeBid({ vendorId, adId, amountAzm }) {
        const amount = new Prisma.Decimal(amountAzm);
        if (amount.lte(0)) throw new Error('amountAzm must be > 0');

        // Validate ad ownership + active status
        const ad = await this.prisma.ad.findUnique({ where: { id: Number(adId) } });
        if (!ad) throw new Error('Ad not found');
        if (ad.vendorId !== vendorId) throw new Error('Not your ad');
        if (ad.status !== 'ACTIVE') throw new Error('Ad must be active to bid');

        // Validate vendor has the AZM (we don't debit yet — just prevent
        // bids beyond available balance).
        const vendor = await this.prisma.user.findUnique({
            where: { id: vendorId },
            select: { azmBalance: true },
        });
        if (!vendor || new Prisma.Decimal(vendor.azmBalance).lt(amount)) {
            throw new Error('Insufficient AZM balance');
        }

        const auction = await this.ensureOpen();
        if (auction.status !== 'OPEN') throw new Error('Auction is settling');

        const bid = await this.prisma.azmAuctionBid.upsert({
            where: { auctionId_vendorId: { auctionId: auction.id, vendorId } },
            create: {
                auctionId: auction.id,
                vendorId,
                adId: Number(adId),
                bidAmountAzm: amount,
                status: 'ACTIVE',
            },
            update: {
                adId: Number(adId),
                bidAmountAzm: amount,
                status: 'ACTIVE',
            },
        });

        if (this.io) {
            this.io.emit('auction:bid_placed', {
                auctionId: auction.id,
                vendorId,
                adId: Number(adId),
            });
        }
        return bid;
    }

    async withdrawBid({ vendorId }) {
        const auction = await this.ensureOpen();
        if (auction.status !== 'OPEN') throw new Error('Auction is settling');
        await this.prisma.azmAuctionBid.deleteMany({
            where: { auctionId: auction.id, vendorId },
        });
    }

    async history(vendorId, { limit = 20 } = {}) {
        return this.prisma.azmAuctionBid.findMany({
            where: { vendorId },
            orderBy: { createdAt: 'desc' },
            take: Math.min(limit, 100),
            include: {
                auction: { select: { id: true, windowEnd: true, status: true, settledAt: true } },
                ad: { select: { id: true, paymentMethod: true } },
            },
        });
    }

    /**
     * Public top-N boosted ads for the marketplace "Promoted" section.
     * Returns the actual Ad rows so the FE can render them inline.
     */
    async getPromotedAds() {
        const ads = await this.prisma.ad.findMany({
            where: {
                isBoosted: true,
                status: 'ACTIVE',
                boostExpiresAt: { gt: new Date() },
            },
            orderBy: { boostExpiresAt: 'desc' },
            take: 3,
        });
        return ads;
    }

    // =========================================================================
    // SETTLEMENT (called by azmAuctionWorker)
    // =========================================================================

    /**
     * Lock the auction, pick top N, burn their AZM, flip Ad.isBoosted on
     * those ads, write leaderboard snapshot, mark SETTLED.
     */
    async settle(auctionId) {
        // Pre-flight: only OPEN auctions in their settlement window.
        const auction = await this.prisma.azmAuction.findUnique({ where: { id: auctionId } });
        if (!auction) throw new Error('Auction not found');
        if (auction.status !== 'OPEN') return { skipped: true, reason: 'not open' };
        if (new Date() < auction.windowEnd) return { skipped: true, reason: 'window not closed' };

        // Lock: status SETTLING (idempotent if a parallel tick beat us)
        const locked = await this.prisma.azmAuction.update({
            where: { id: auctionId },
            data: { status: 'SETTLING' },
        });

        const winnerCount = locked.winnerCount || DEFAULT_WINNER_COUNT;

        // Pull top-K bids by amount, tiebreak by createdAt asc.
        const top = await this.prisma.azmAuctionBid.findMany({
            where: { auctionId, status: 'ACTIVE' },
            orderBy: [{ bidAmountAzm: 'desc' }, { createdAt: 'asc' }],
            take: winnerCount,
        });

        const losers = await this.prisma.azmAuctionBid.findMany({
            where: { auctionId, status: 'ACTIVE', NOT: { id: { in: top.map((b) => b.id) } } },
        });

        const settledAt = new Date();
        const boostUntil = new Date(settledAt.getTime() + WINDOW_MS);
        let totalBurned = new Prisma.Decimal(0);

        for (let i = 0; i < top.length; i++) {
            const winner = top[i];
            const rank = i + 1;
            // Burn AZM via spend service (audit trail, balance update, socket)
            try {
                await this.azmSpendService.debitAzm({
                    userId: winner.vendorId,
                    amount: Number(winner.bidAmountAzm),
                    source: 'AD_AUCTION_BID',
                    reason: `AZM auction win — rank ${rank} (24h boost)`,
                    metadata: {
                        auctionId,
                        adId: winner.adId,
                        rank,
                    },
                    dedupKey: `auction-win-${auctionId}-${winner.vendorId}`,
                });
            } catch (err) {
                console.error('[azmAuctionService.settle] AZM debit failed:', err.message);
            }

            // Mark bid + boost ad
            await this.prisma.$transaction([
                this.prisma.azmAuctionBid.update({
                    where: { id: winner.id },
                    data: {
                        status: 'WON',
                        rank,
                        azmBurned: winner.bidAmountAzm,
                        boostedUntil: boostUntil,
                    },
                }),
                this.prisma.ad.update({
                    where: { id: winner.adId },
                    data: {
                        isBoosted: true,
                        boostExpiresAt: boostUntil,
                    },
                }),
            ]);
            totalBurned = totalBurned.plus(winner.bidAmountAzm);

            this.notificationService
                ?.sendNotification({
                    userId: winner.vendorId,
                    title: `🎯 Auction Won — Rank ${rank}`,
                    body: `Your ad is BOOSTED for 24h. ${Number(winner.bidAmountAzm).toFixed(2)} AZM burned.`,
                    category: 'AUCTION',
                    actionPayload: {
                        action: 'OPEN_AUCTION',
                        auctionId,
                        adId: winner.adId,
                        rank,
                    },
                })
                .catch(() => {});
        }

        // Mark losers
        if (losers.length > 0) {
            await this.prisma.azmAuctionBid.updateMany({
                where: { id: { in: losers.map((b) => b.id) } },
                data: { status: 'LOST' },
            });
            for (const l of losers) {
                this.notificationService
                    ?.sendNotification({
                        userId: l.vendorId,
                        title: 'Auction — Outbid',
                        body: 'Your bid did not make the top 3. No AZM was burned. Try again in the next window.',
                        category: 'AUCTION',
                        actionPayload: { action: 'OPEN_AUCTION', auctionId },
                    })
                    .catch(() => {});
            }
        }

        // Write leaderboard snapshot + mark SETTLED
        const leaderboard = top.map((b, i) => ({
            rank: i + 1,
            vendorId: b.vendorId,
            adId: b.adId,
            bidAmountAzm: Number(b.bidAmountAzm),
        }));
        await this.prisma.azmAuction.update({
            where: { id: auctionId },
            data: {
                status: 'SETTLED',
                settledAt,
                totalAzmBurned: totalBurned,
                leaderboard,
            },
        });

        if (this.io) {
            this.io.emit('auction:settled', {
                auctionId,
                winners: leaderboard,
                totalBurned: Number(totalBurned.toFixed(2)),
            });
        }

        return {
            auctionId,
            winners: leaderboard.length,
            totalBurned: Number(totalBurned.toFixed(2)),
        };
    }
}

module.exports = { AzmAuctionService, WINDOW_MS };
