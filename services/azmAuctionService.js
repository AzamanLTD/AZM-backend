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

const logger = require('../src/config/logger');
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

    // §r41 — DB-IDEMPOTENT OPEN-AUCTION AUTHORITY (final-audit #12).
    //
    // Pre-r41: findFirst(OPEN + future) → create(OPEN, from-now window).
    // Two instances (Render runs more than one) could BOTH see nothing and
    // create separate OPEN auctions — their from-now timestamps differ, so
    // no unique constraint can stop it. Fix: a PostgreSQL advisory lock
    // serializes all ensure-open creators across instances; inside the lock
    // the findFirst is authoritative. No in-process mutex (useless across
    // instances); the lock is transaction-scoped and releases itself.
    //
    // Stable lock key for azm-auction ensure-open. Keep constant forever —
    // changing it orphans in-flight holders.
    static ENSURE_OPEN_LOCK_KEY = 94173001;

    async ensureOpen() {
        return this.prisma.$transaction((tx) => this._ensureOpenTx(tx), {
            timeout: 15000,
        });
    }

    async _ensureOpenTx(tx) {
        // Advisory lock: concurrent first callers serialize; the second
        // re-checks and converges to the first caller's auction.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AzmAuctionService.ENSURE_OPEN_LOCK_KEY})`;

        const existing = await tx.azmAuction.findFirst({
            where: { status: 'OPEN', windowEnd: { gt: new Date() } },
        });
        if (existing) return existing;

        // Compute next window (start = now, length = 24h — the documented
        // from-now MVP model; the advisory lock is what makes it safe).
        const now = new Date();
        return tx.azmAuction.create({
            data: {
                windowStart: now,
                windowEnd: new Date(now.getTime() + WINDOW_MS),
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

        // §r41 — BID AUTHORITY (final-audit #11).
        //
        // Pre-r41: a stale placeBid ran after settlement and its
        // status-blind upsert reactivated a WON/LOST settlement record on a
        // SETTLED auction (resurrecting a burned-rank bid). Fix: ONE
        // transaction that (a) ensures the open auction under the advisory
        // lock, (b) takes the auction ROW lock — the same row settle()'s
        // claim-update writes, so bid mutation and settlement serialize on
        // the auction authority — and (c) re-verifies OPEN from the LOCKED
        // row, the committed truth, not the stale pre-read. A WON/LOST bid
        // is settlement audit and can never be rewritten.
        const bid = await this.prisma.$transaction(async (tx) => {
            const auction = await this._ensureOpenTx(tx);
            await tx.$executeRaw`SELECT id FROM "AzmAuction" WHERE "id" = ${auction.id} FOR UPDATE`;
            const locked = await tx.azmAuction.findUnique({ where: { id: auction.id } });
            if (!locked || locked.status !== 'OPEN' || new Date(locked.windowEnd) <= new Date()) {
                throw new Error('Auction is settling');
            }

            const existing = await tx.azmAuctionBid.findUnique({
                where: { auctionId_vendorId: { auctionId: auction.id, vendorId } },
            });
            if (existing && existing.status !== 'ACTIVE') {
                // Settlement audit (WON/LOST) is terminal — never rewritten,
                // never reactivated. Post-settlement bids fail closed.
                throw new Error('Bids are final after settlement');
            }

            return tx.azmAuctionBid.upsert({
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
        }, { timeout: 15000 });

        if (this.io) {
            this.io.emit('auction:bid_placed', {
                auctionId: bid.auctionId,
                vendorId,
                adId: Number(adId),
            });
        }
        return bid;
    }

    async withdrawBid({ vendorId }) {
        // §r41 — WITHDRAW AUTHORITY (final-audit #11). Same auction-row
        // serialization as placeBid; the delete is ACTIVE-only so a stale
        // withdrawal can NEVER delete a WON/LOST settlement record after
        // AZM was already burned.
        const result = await this.prisma.$transaction(async (tx) => {
            const auction = await this._ensureOpenTx(tx);
            await tx.$executeRaw`SELECT id FROM "AzmAuction" WHERE "id" = ${auction.id} FOR UPDATE`;
            const locked = await tx.azmAuction.findUnique({ where: { id: auction.id } });
            if (!locked || locked.status !== 'OPEN' || new Date(locked.windowEnd) <= new Date()) {
                throw new Error('Auction is settling');
            }
            // ACTIVE-only claim: count 0 converges (nothing to withdraw).
            return tx.azmAuctionBid.deleteMany({
                where: { auctionId: auction.id, vendorId, status: 'ACTIVE' },
            });
        }, { timeout: 15000 });
        return result;
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
        // Pre-flight read only — the authoritative claim happens inside
        // the settlement transaction. A committed SETTLED replay converges
        // to the existing idempotent skip and can never reburn.
        const auction = await this.prisma.azmAuction.findUnique({ where: { id: auctionId } });
        if (!auction) throw new Error('Auction not found');
        if (auction.status === 'SETTLED') return { skipped: true, reason: 'not open' };
        if (new Date() < auction.windowEnd) return { skipped: true, reason: 'window not closed' };

        // ONE authoritative settlement transaction: OPEN -> SETTLING ->
        // SETTLED commit together, so a committed SETTLING cannot exist (a
        // crash rolls back to the retryable state and the worker retries),
        // and a concurrent worker loses the claim and converges to the skip.
        let outcome;
        try {
            outcome = await this.prisma.$transaction(async (tx) => {
                // Atomic claim. OPEN is the normal path; SETTLING is the
                // legacy-crash recovery path — a committed SETTLING row is
                // pre-atomic debris and is safe to re-claim (the auction-win
                // dedup keys make replay burn-free); an in-flight SETTLING
                // is uncommitted/invisible, so concurrent workers serialize.
                const claimed = await tx.azmAuction.updateMany({
                    where: {
                        id: auctionId,
                        status: { in: ['OPEN', 'SETTLING'] },
                        windowEnd: { lte: new Date() },
                    },
                    data: { status: 'SETTLING' },
                });
                if (claimed.count === 0) return { skipped: true, reason: 'not open' };

                const locked = await tx.azmAuction.findUnique({ where: { id: auctionId } });
                const winnerCount = locked.winnerCount || DEFAULT_WINNER_COUNT;

                // Legacy-crash recovery inputs. The pre-#255 implementation
                // committed per-winner state (spend log + WON bid + boosted
                // ad) BEFORE the auction itself was marked SETTLED, so a
                // committed SETTLING row can contain already-committed WON
                // winners. Those winners keep their committed ranks and are
                // never reburned; the remaining slots are filled from the
                // same deterministic ranking an uninterrupted settlement
                // would have produced.
                const committedBids = await tx.azmAuctionBid.findMany({
                    where: { auctionId, status: 'WON' },
                });
                if (committedBids.length > winnerCount) {
                    throw new Error(
                        `Legacy debris on auction ${auctionId}: ${committedBids.length} committed WON bids exceed winnerCount ${winnerCount} — refusing to invent a settlement`
                    );
                }
                const committed = [];
                const committedRanks = new Set();
                for (const bid of committedBids) {
                    // Robustness rule: a WON legacy bid is a financially
                    // committed winner ONLY when its deterministic
                    // AD_AUCTION_BID spend identity exists. If the invariant
                    // cannot be established safely, fail closed rather than
                    // inventing a burn or a winner.
                    const log = await tx.azmSpendLog.findFirst({
                        where: {
                            userId: bid.vendorId,
                            source: 'AD_AUCTION_BID',
                            OR: [
                                { dedupKey: `auction-win-${auctionId}-${bid.vendorId}` },
                                { metadata: { path: ['dedupKey'], equals: `auction-win-${auctionId}-${bid.vendorId}` } },
                            ],
                        },
                    });
                    if (!log) {
                        throw new Error(
                            `Legacy WON bid ${bid.id} on auction ${auctionId} has no committed auction-win spend identity — refusing to invent a burn`
                        );
                    }
                    const rank = Number(bid.rank);
                    if (!Number.isInteger(rank) || rank < 1 || rank > winnerCount || committedRanks.has(rank)) {
                        throw new Error(
                            `Legacy WON bid ${bid.id} on auction ${auctionId} has no establishable rank — refusing to invent a ranking`
                        );
                    }
                    committedRanks.add(rank);
                    // Exactly-once notifications: the pre-#255 code
                    // notified each winner at its own commit, so a
                    // committed winner may already hold its "Auction Won"
                    // notification; recovery must not duplicate it.
                    const alreadyNotified = await tx.notification.findFirst({
                        where: {
                            userId: bid.vendorId,
                            category: 'AUCTION',
                            AND: [
                                { actionPayload: { path: ['auctionId'], equals: auctionId } },
                                { actionPayload: { path: ['adId'], equals: bid.adId } },
                            ],
                        },
                    });
                    committed.push({ bid, log, rank, notified: Boolean(alreadyNotified) });
                }

                // Authoritative winner selection INSIDE the transaction.
                // Committed winners occupy their original ranks; only the
                // remaining slots are filled, from the deterministic
                // original ranking order — a recovery can therefore never
                // produce more than winnerCount total winners.
                const candidates = await tx.azmAuctionBid.findMany({
                    where: { auctionId, status: 'ACTIVE' },
                    orderBy: [{ bidAmountAzm: 'desc' }, { createdAt: 'asc' }],
                });
                const freeRanks = [];
                for (let r = 1; r <= winnerCount; r++) if (!committedRanks.has(r)) freeRanks.push(r);
                const selected = candidates.slice(0, freeRanks.length);
                const losers = candidates.slice(freeRanks.length);

                // Fail closed on inconsistent debris: an ACTIVE bid whose
                // auction-win spend identity already exists but which does
                // NOT make the recovered winner set would be marked LOST
                // while its AZM already left the balance — refuse.
                if (losers.length > 0) {
                    const loserKeys = losers.map((b) => `auction-win-${auctionId}-${b.vendorId}`);
                    const burnedLosers = await tx.azmSpendLog.findMany({
                        where: { source: 'AD_AUCTION_BID', dedupKey: { in: loserKeys } },
                        select: { dedupKey: true },
                    });
                    if (burnedLosers.length > 0) {
                        throw new Error(
                            `Legacy auction ${auctionId} has burned non-winner bids (${burnedLosers.map((l) => l.dedupKey).join(', ')}) — refusing to settle inconsistently`
                        );
                    }
                }

                const settledAt = new Date();
                const boostUntil = new Date(settledAt.getTime() + WINDOW_MS);
                let totalBurned = new Prisma.Decimal(0);

                // Already-committed winners: never reburned, never re-ranked,
                // but their committed burn still counts toward totalAzmBurned.
                for (const c of committed) {
                    totalBurned = totalBurned.plus(c.log.amount);
                }

                const newWinners = [];
                for (let i = 0; i < selected.length; i++) {
                    const winner = selected[i];
                    const rank = freeRanks[i];

                    // Financial mutation FIRST, via the single AZM spend
                    // authority, transaction-scoped. The deterministic
                    // auction-win dedup key is DB-enforced exactly-once by
                    // PR #254's unique invariant. A debit failure (e.g.
                    // insufficient balance) aborts the WHOLE settlement —
                    // fail-closed: no WON bid, no boost, no burn, auction
                    // left retryable. A replay (the spend identity was
                    // already committed inside the legacy crash window)
                    // stays burn-free but still reconciles into WON.
                    await this.azmSpendService._debitAzmWithClient(tx, {
                        userId: winner.vendorId,
                        amount: Number(winner.bidAmountAzm),
                        source: 'AD_AUCTION_BID',
                        reason: `AZM auction win — rank ${rank} (24h boost)`,
                        metadata: { auctionId, adId: winner.adId, rank },
                        dedupKey: `auction-win-${auctionId}-${winner.vendorId}`,
                    });

                    // Only after the debit succeeds may the bid become
                    // WON and the ad boosted — same transaction.
                    await tx.azmAuctionBid.update({
                        where: { id: winner.id },
                        data: {
                            status: 'WON',
                            rank,
                            azmBurned: winner.bidAmountAzm,
                            boostedUntil: boostUntil,
                        },
                    });
                    await tx.ad.update({
                        where: { id: winner.adId },
                        data: {
                            isBoosted: true,
                            boostExpiresAt: boostUntil,
                        },
                    });

                    // The winner's debit counts toward totalAzmBurned whether
                    // it just committed (debited) or was already committed by
                    // the legacy crash window (replay) — exactly-once either
                    // way via the unique spend identity, never double-counted.
                    totalBurned = totalBurned.plus(winner.bidAmountAzm);
                    newWinners.push({ bid: winner, rank });
                }

                if (losers.length > 0) {
                    await tx.azmAuctionBid.updateMany({
                        where: { id: { in: losers.map((b) => b.id) } },
                        data: { status: 'LOST' },
                    });
                }

                const leaderboard = [
                    ...committed.map((c) => ({
                        rank: c.rank,
                        vendorId: c.bid.vendorId,
                        adId: c.bid.adId,
                        bidAmountAzm: Number(c.bid.bidAmountAzm),
                    })),
                    ...newWinners.map((w) => ({
                        rank: w.rank,
                        vendorId: w.bid.vendorId,
                        adId: w.bid.adId,
                        bidAmountAzm: Number(w.bid.bidAmountAzm),
                    })),
                ].sort((a, b) => a.rank - b.rank);

                // Terminal state in the SAME transaction.
                await tx.azmAuction.update({
                    where: { id: auctionId },
                    data: {
                        status: 'SETTLED',
                        settledAt,
                        totalAzmBurned: totalBurned,
                        leaderboard,
                    },
                });

                return {
                    winners: leaderboard,
                    // Exactly-once notification set: newly committed winners
                    // always notify; committed legacy winners only if the
                    // pre-#255 crash window closed before their notification.
                    winnersToNotify: [
                        ...newWinners.map((w) => ({
                            vendorId: w.bid.vendorId,
                            adId: w.bid.adId,
                            rank: w.rank,
                            bidAmountAzm: Number(w.bid.bidAmountAzm),
                        })),
                        ...committed
                            .filter((c) => !c.notified)
                            .map((c) => ({
                                vendorId: c.bid.vendorId,
                                adId: c.bid.adId,
                                rank: c.rank,
                                bidAmountAzm: Number(c.bid.bidAmountAzm),
                            })),
                    ],
                    losers: losers.map((l) => l.vendorId),
                    totalBurned,
                };
            }, { timeout: 30000 });
        } catch (err) {
            // A rolled-back settlement leaves bids, ads and AZM unchanged,
            // and NO notification has been sent (those are post-commit
            // only). Durable observability for the operator, then rethrow.
            logger.error(
                { err: err, auctionId },
                '[azmAuctionService.settle] settlement rolled back — auction stays retryable/OPEN'
            );
            throw err;
        }
        if (outcome.skipped) return outcome;

        // Realtime side effects ONLY after the transaction has committed.
        const notify = (userId, title, body, actionPayload) =>
            this.notificationService?.sendNotification({ userId, title, body, category: 'AUCTION', actionPayload })
                .catch(() => {});
        for (const w of outcome.winnersToNotify) {
            notify(
                w.vendorId,
                `🎯 Auction Won — Rank ${w.rank}`,
                `Your ad is BOOSTED for 24h. ${w.bidAmountAzm.toFixed(2)} AZM burned.`,
                { action: 'OPEN_AUCTION', auctionId, adId: w.adId, rank: w.rank }
            );
        }
        for (const vendorId of outcome.losers) {
            notify(
                vendorId,
                'Auction — Outbid',
                'Your bid did not make the top 3. No AZM was burned. Try again in the next window.',
                { action: 'OPEN_AUCTION', auctionId }
            );
        }
        if (this.io) {
            this.io.emit('auction:settled', {
                auctionId,
                winners: outcome.winners,
                totalBurned: Number(outcome.totalBurned.toFixed(2)),
            });
        }

        return {
            auctionId,
            winners: outcome.winners.length,
            totalBurned: Number(outcome.totalBurned.toFixed(2)),
        };
    }
}

module.exports = { AzmAuctionService, WINDOW_MS };
