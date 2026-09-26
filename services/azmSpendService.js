// services/azmSpendService.js
// =============================================================================
// AZAMAN — AZM SPEND SERVICE (Phase E2)
//
// Manages all AZM loyalty-point spend mechanics. Every AZM debit flows
// through this service so we have one canonical pipeline with:
//   1. Atomic balance decrement (DB-level CHECK ensures >= 0)
//   2. AzmSpendLog audit row (transparent history for the user)
//   3. Socket emission so the FE updates in real-time
//
const logger = require('../src/config/logger');
// SPEND ACTIONS:
//   FEE_DISCOUNT    → Spend AZM to reduce the 2% fiat withdrawal exit fee
//   AD_BOOST        → Spend AZM for temporary "featured" ad placement (24h)
//
// DESIGN DECISIONS:
//   - debitAzm() throws on insufficient balance (caller must handle)
//   - Atomic: balance check + decrement + log in one $transaction
//   - Socket emission uses 'azm_spend' event for real-time FE updates
//   - Each spend is idempotent via source+dedupKey
// =============================================================================

// ── AZM Spend Costs ──────────────────────────────────────────────────────────
const AZM_COSTS = {
    // Fee discount: spend X AZM to reduce exit fee by Y%
    // Tiers: spend 10 AZM → 25% off, 25 AZM → 50% off, 50 AZM → 100% off (free withdrawal)
    FEE_DISCOUNT_25:   10.0,   // 25% fee reduction
    FEE_DISCOUNT_50:   25.0,   // 50% fee reduction
    FEE_DISCOUNT_100:  50.0,   // 100% fee reduction (free)

    // Ad boost: spend AZM for temporary featured placement
    AD_BOOST_24H:      15.0,   // 24-hour featured placement
    AD_BOOST_72H:      35.0,   // 72-hour featured placement
    AD_BOOST_7D:       80.0,   // 7-day featured placement

    // Card skins (2026-07-06): cosmetic skins for the peer-transfer chat card.
    // 'classic' is free/default and NOT in this map (never purchasable, always owned).
    CARD_SKIN_GOLD:     1.0,
    CARD_SKIN_MIDNIGHT: 1.0,
    CARD_SKIN_EMERALD:  1.0,
    CARD_SKIN_SUNSET:   1.0,
};

// ── Spend source keys ────────────────────────────────────────────────────────
const AZM_SPEND_SOURCES = {
    FEE_DISCOUNT:   'FEE_DISCOUNT',
    AD_BOOST:       'AD_BOOST',
    // Master Sprint (2026-05-27): AZM auction settlement burn.
    // Bidders are NOT debited at bid placement — only the winning top-N
    // get debited at settlement. This avoids stuck refund logic and
    // keeps the auction blind without an escrow column.
    AD_AUCTION_BID: 'AD_AUCTION_BID',
    // Card skins (2026-07-06)
    CARD_SKIN: 'CARD_SKIN',
    GIFT_TIP: 'GIFT_TIP',
    AZM_CONVERSION: 'AZM_CONVERSION',
    // Stake economic atomicity (2026-09-16): principal locked into a Nitro
    // stake. The AZM leaves azmBalance and lives in the AzmStake row until
    // the completed unstake releases it (source STAKE_RELEASE on the reward
    // side). dedupKey is the stake's own id.
    STAKE_LOCK:     'STAKE_LOCK',
};

// ── Fee discount tiers ───────────────────────────────────────────────────────
const FEE_DISCOUNT_TIERS = [
    { id: 'tier_25',  label: '25% Off',  discount: 0.25, cost: AZM_COSTS.FEE_DISCOUNT_25 },
    { id: 'tier_50',  label: '50% Off',  discount: 0.50, cost: AZM_COSTS.FEE_DISCOUNT_50 },
    { id: 'tier_100', label: 'Free',     discount: 1.00, cost: AZM_COSTS.FEE_DISCOUNT_100 },
];

// ── Ad boost durations ───────────────────────────────────────────────────────
const AD_BOOST_OPTIONS = [
    { id: 'boost_24h', label: '24 Hours', durationMs: 24 * 60 * 60 * 1000, cost: AZM_COSTS.AD_BOOST_24H },
    { id: 'boost_72h', label: '3 Days',   durationMs: 72 * 60 * 60 * 1000, cost: AZM_COSTS.AD_BOOST_72H },
    { id: 'boost_7d',  label: '7 Days',   durationMs: 7 * 24 * 60 * 60 * 1000, cost: AZM_COSTS.AD_BOOST_7D },
];

// ── Card skin catalog ────────────────────────────────────────────────────────
// Matches the Flutter kCardSkins map (widgets/peer_transfer_card.dart).
// 'classic' is always owned/equippable for free and is deliberately excluded
// from this list — it is never purchased, only the default fallback.
const CARD_SKIN_OPTIONS = [
    { id: 'gold',     label: 'Gold',     cost: AZM_COSTS.CARD_SKIN_GOLD },
    { id: 'midnight', label: 'Midnight', cost: AZM_COSTS.CARD_SKIN_MIDNIGHT },
    { id: 'emerald',  label: 'Emerald',  cost: AZM_COSTS.CARD_SKIN_EMERALD },
    { id: 'sunset',   label: 'Sunset',   cost: AZM_COSTS.CARD_SKIN_SUNSET },
];
const FREE_CARD_SKIN = 'classic';
const VALID_CARD_SKIN_IDS = new Set([FREE_CARD_SKIN, ...CARD_SKIN_OPTIONS.map(s => s.id)]);

class AzmSpendService {
    /**
     * @param {object} prisma - Prisma client instance
     * @param {object|null} io - Socket.IO server instance
     */
    constructor(prisma, io = null) {
        this.prisma = prisma;
        this.io = io;
    }

    // =========================================================================
    // CORE: Debit AZM from a user
    // =========================================================================

    /**
     * Debit AZM from a user with full audit trail.
     * THROWS on insufficient balance (caller must catch and return 400).
     *
     * @param {object} params
     * @param {number} params.userId
     * @param {number} params.amount - AZM to debit (must be > 0)
     * @param {string} params.source - Machine key (from AZM_SPEND_SOURCES)
     * @param {string} params.reason - Human-readable description
     * @param {object} [params.metadata] - Optional context
     * @param {string} [params.dedupKey] - Optional idempotency key
     * @returns {Promise<{debited: boolean, newBalance: number, logId: string}>}
     */
    /**
     * Transaction-client primitive for an AZM debit. Runs the ENTIRE debit
     * (validation, dedup lookup, atomic balance claim, AzmSpendLog create)
     * against an ALREADY-OPEN Prisma transaction client — it never opens a
     * transaction of its own. This is what lets a caller commit an AZM spend
     * atomically with its own financial writes.
     *
     * IMPORTANT: performs NO socket emission — the outer transaction may
     * still roll back. Callers emit only after their transaction commits.
     *
     * @param {object} tx - open Prisma transaction client
     * @param {object} params - same shape as debitAzm()
     * @returns {Promise<{debited: boolean, newBalance: number, logId: string}>}
     */
    async _debitAzmWithClient(tx, { userId, amount, source, reason, metadata = null, dedupKey = null }) {
        if (!userId || !amount || amount <= 0 || !source || !reason) {
            throw new Error('Invalid spend parameters.');
        }

        // Idempotency fast path (source + dedupKey => this spend already
        // happened). NOTE: this pre-check is an optimization, NOT the
        // concurrency gate — two racing requests can both miss it. The actual
        // gate is the DB-level @@unique([userId, source, dedupKey]) on
        // AzmSpendLog: a racing duplicate log insert fails the unique index and
        // the WHOLE enclosing transaction (balance decrement included) rolls
        // back. debitAzm() converges the resulting P2002 to the idempotent
        // result; inside a caller-owned transaction (e.g.
        // applyFeeDiscountInTransaction) the P2002 aborts the outer
        // transaction, which is the safe outcome — the caller's own
        // idempotency layer decides the retry.
        if (dedupKey) {
            const existing = await tx.azmSpendLog.findFirst({
                where: {
                    userId,
                    source,
                    OR: [
                        { dedupKey },
                        { metadata: { path: ['dedupKey'], equals: dedupKey } }
                    ]
                }
            });
            if (existing) {
                return { debited: false, newBalance: existing.balanceAfter, logId: existing.id };
            }
        }

        // DB-boundary CAS authorization (#265 pattern): the conditional
        // UPDATE is the ONLY authorization — a racing spend between a read and
        // a write can no longer slip past a stale balance snapshot. Zero
        // affected rows means the live balance was below the amount at the
        // moment of the claim (or the user does not exist); the fresh read
        // below produces the exact historical error contract. The
        // User_azmBalance_nonneg CHECK remains the belt-and-suspenders floor —
        // this CAS guarantees a loser NEVER reaches it, so clients get the
        // clean "Insufficient AZM balance" contract instead of a raw CHECK
        // violation surfaced as a 500.
        const claim = await tx.user.updateMany({
            where: { id: userId, azmBalance: { gte: amount } },
            data: { azmBalance: { decrement: amount } },
        });

        if (claim.count === 0) {
            const user = await tx.user.findUnique({
                where: { id: userId },
                select: { azmBalance: true }
            });
            if (!user) throw new Error('User not found.');
            throw new Error(
                `Insufficient AZM balance. Required: ${amount}, available: ${user.azmBalance.toFixed(1)}`
            );
        }

        // Authoritative post-debit balance inside this transaction — becomes
        // the ledger's balanceAfter.
        const updatedUser = await tx.user.findUnique({
            where: { id: userId },
            select: { azmBalance: true }
        });

        const log = await tx.azmSpendLog.create({
            data: {
                userId,
                amount,
                source,
                reason,
                // Dedicated column claims the dedup identity (DB unique gate);
                // metadata keeps the legacy mirror for backward compatibility.
                dedupKey,
                metadata: dedupKey ? { ...metadata, dedupKey } : metadata,
                balanceAfter: updatedUser.azmBalance
            }
        });

        return { debited: true, newBalance: updatedUser.azmBalance, logId: log.id };
    }

    /**
     * Public standalone debit: same behavior as before (own $transaction,
     * post-commit socket emission). Now a thin wrapper over the shared
     * _debitAzmWithClient primitive so all AZM debits share one pipeline.
     */
    async debitAzm({ userId, amount, source, reason, metadata = null, dedupKey = null }) {
        let result;
        try {
            result = await this.prisma.$transaction(async (tx) =>
                this._debitAzmWithClient(tx, { userId, amount, source, reason, metadata, dedupKey })
            );
        } catch (err) {
            // Concurrency gate tripped: this racing request LOST the DB unique
            // race, so the transaction — balance decrement included — rolled
            // back. Converge to the exact idempotent result a sequential replay
            // would have returned; a raw P2002 never surfaces to clients, and
            // azm_spend is never emitted for a losing/replay call.
            if (dedupKey && err?.code === 'P2002') {
                const winner = await this.prisma.azmSpendLog.findFirst({
                    where: {
                        userId,
                        source,
                        OR: [
                            { dedupKey },
                            { metadata: { path: ['dedupKey'], equals: dedupKey } }
                        ]
                    }
                });
                if (winner) {
                    return { debited: false, newBalance: winner.balanceAfter, logId: winner.id };
                }
            }
            throw err;
        }

        // Emit socket event for real-time FE update (post-commit only)
        if (result.debited) {
            this._emitSpendUpdate(userId, result.newBalance, amount, source, reason);
        }

        return result;
    }

    // =========================================================================
    // FEE DISCOUNT — Spend AZM to reduce withdrawal exit fee
    // =========================================================================

    /**
     * Apply a fee discount to a withdrawal.
     * Returns the discount multiplier (0.25, 0.50, or 1.00) that the caller
     * should apply to the exit fee.
     *
     * @param {number} userId
     * @param {string} tierId - 'tier_25' | 'tier_50' | 'tier_100'
     * @param {string} [withdrawalRef] - Optional reference for dedup
     * @returns {Promise<{discount: number, azmSpent: number, newBalance: number}>}
     */
    async applyFeeDiscount(userId, tierId, withdrawalRef = null) {
        const tier = FEE_DISCOUNT_TIERS.find(t => t.id === tierId);
        if (!tier) throw new Error(`Invalid fee discount tier: ${tierId}`);

        const result = await this.debitAzm({
            userId,
            amount: tier.cost,
            source: AZM_SPEND_SOURCES.FEE_DISCOUNT,
            reason: `${tier.label} fee discount on withdrawal (-${tier.cost} AZM)`,
            metadata: { tierId, discount: tier.discount, withdrawalRef },
            dedupKey: withdrawalRef ? `fee_discount_${withdrawalRef}` : null
        });

        return {
            discount: tier.discount,
            azmSpent: tier.cost,
            newBalance: result.newBalance
        };
    }

    // =========================================================================
    // FEE DISCOUNT (TRANSACTION-AWARE)
    // =========================================================================

    /**
     * Apply a fee discount INSIDE a caller-owned Prisma transaction. Used by
     * the fiat withdrawal flow so the AZM fee-discount debit commits (or
     * rolls back) atomically with the withdrawal reservation itself.
     *
     * Performs NO socket emission — the outer transaction may still roll
     * back. The caller emits the azm_spend event exactly once AFTER the
     * outer transaction commits (see emitFeeDiscountSpend below).
     *
     * The tier catalog (FEE_DISCOUNT_TIERS) remains the single source of
     * truth for cost/discount; the deterministic dedup key
     * `fee_discount_<withdrawalRef>` identifies this exact spend for reversal.
     *
     * @param {object} tx - open Prisma transaction client
     * @param {number} userId
     * @param {string} tierId - 'tier_25' | 'tier_50' | 'tier_100'
     * @param {string} withdrawalRef - withdrawal reference (required for dedup)
     * @returns {Promise<{discount, tierId, azmSpent, newBalance, debited, logId}>}
     */
    async applyFeeDiscountInTransaction(tx, userId, tierId, withdrawalRef) {
        if (!tx) throw new Error('applyFeeDiscountInTransaction requires an open transaction client.');
        if (!withdrawalRef) throw new Error('applyFeeDiscountInTransaction requires a withdrawal reference.');

        const tier = FEE_DISCOUNT_TIERS.find(t => t.id === tierId);
        if (!tier) throw new Error(`Invalid fee discount tier: ${tierId}`);

        let result;
        try {
            result = await this._debitAzmWithClient(tx, {
                userId,
                amount: tier.cost,
                source: AZM_SPEND_SOURCES.FEE_DISCOUNT,
                reason: `${tier.label} fee discount on withdrawal (-${tier.cost} AZM)`,
                metadata: { tierId, discount: tier.discount, withdrawalRef },
                dedupKey: `fee_discount_${withdrawalRef}`
            });
        } catch (err) {
            // Keep the standalone AZM_SPEND_FAILED contract for the controller.
            if (err.message.includes('Insufficient AZM balance') || err.message === 'User not found.') {
                err.code = 'AZM_SPEND_FAILED';
            }
            throw err;
        }

        return {
            discount: tier.discount,
            tierId: tier.id,
            azmSpent: tier.cost,
            newBalance: result.newBalance,
            debited: result.debited,
            logId: result.logId
        };
    }

    /**
     * Small public post-commit wrapper: emits the existing azm_spend realtime
     * update for a fee-discount debit that has ALREADY committed inside the
     * caller's transaction. Never call this before the outer commit.
     */
    emitFeeDiscountSpend(userId, newBalance, azmSpent, reason) {
        this._emitSpendUpdate(userId, newBalance, azmSpent, AZM_SPEND_SOURCES.FEE_DISCOUNT, reason);
    }

    // =========================================================================
    // AD BOOST — Spend AZM for temporary featured ad placement
    // =========================================================================

    /**
     * Boost an ad for a specified duration.
     * Sets isBoosted=true and boostExpiresAt on the ad.
     *
     * @param {number} userId - Must be the ad's vendor
     * @param {number} adId
     * @param {string} boostId - 'boost_24h' | 'boost_72h' | 'boost_7d'
     * @returns {Promise<{azmSpent: number, boostExpiresAt: string, newBalance: number}>}
     */
    /**
     * Boost an ad with AZM — ONE transaction (final-audit #14).
     *
     * RETRY CONTRACT:
     *   • WITHOUT idempotencyKey: every call is a DISTINCT purchase — a
     *     client retry re-charges. This is the explicit pre-r41 behavior,
     *     now documented instead of accidental (the old dedup key embedded
     *     Date.now(), so no retry was ever idempotent anyway).
     *   • WITH a client-supplied idempotencyKey (per logical purchase, e.g.
     *     a UUID held through retries): the spend identity
     *     ad_boost_{adId}_{boostId}_{key} is DB-enforced exactly-once by the
     *     AzmSpendLog unique invariant — a replay converges to the original
     *     purchase's result, and an in-flight racing duplicate rolls back
     *     whole (P2002) and converges to the winner's committed state.
     *
     * AUTHORITY: the ad row lock (FOR UPDATE) serializes concurrent boosts;
     * ownership and the boost extension are recomputed from the LOCKED row,
     * never the stale pre-read. Debit + entitlement commit in the SAME
     * transaction, so no crash window can charge AZM without applying the
     * boost.
     */
    async boostAd(userId, adId, boostId, idempotencyKey = null) {
        const option = AD_BOOST_OPTIONS.find(o => o.id === boostId);
        if (!option) throw new Error(`Invalid boost option: ${boostId}`);

        const dedupKey = idempotencyKey
            ? `ad_boost_${adId}_${boostId}_${idempotencyKey}`
            : null;

        // Fast-fail pre-read (ownership/active) — convenience only; the
        // authoritative checks run on the LOCKED row inside the transaction.
        const preAd = await this.prisma.ad.findUnique({
            where: { id: adId },
            select: { vendorId: true, status: true }
        });
        if (!preAd) throw new Error('Ad not found.');
        if (preAd.vendorId !== userId) throw new Error('You can only boost your own ads.');
        if (preAd.status !== 'ACTIVE') throw new Error('Only active ads can be boosted.');

        try {
            const result = await this.prisma.$transaction(async (tx) => {
                // §r41 — AD-ROW SERIALIZATION: concurrent boosts of the same
                // ad serialize behind the row lock; the extension is
                // recomputed from the LOCKED row so a paid extension can
                // never silently disappear.
                await tx.$executeRaw`SELECT id FROM "Ad" WHERE "id" = ${adId} FOR UPDATE`;
                const ad = await tx.ad.findUnique({
                    where: { id: adId },
                    select: { id: true, vendorId: true, status: true, isBoosted: true, boostExpiresAt: true }
                });

                // Fail-closed cross-user ownership on the locked row.
                if (!ad) throw new Error('Ad not found.');
                if (ad.vendorId !== userId) throw new Error('You can only boost your own ads.');
                if (ad.status !== 'ACTIVE') throw new Error('Only active ads can be boosted.');

                // Authoritative expiry from the LOCKED row: extend a live
                // boost, else start from now.
                const now = new Date();
                let boostStart = now;
                if (ad.isBoosted && ad.boostExpiresAt && new Date(ad.boostExpiresAt) > now) {
                    boostStart = new Date(ad.boostExpiresAt);
                }
                const boostExpiresAt = new Date(boostStart.getTime() + option.durationMs);

                // Debit + entitlement in the SAME transaction. A debit
                // failure rolls back the boost; an entitlement failure rolls
                // back the debit. A racing duplicate dedup key (P2002) rolls
                // back the whole thing.
                const debit = await this._debitAzmWithClient(tx, {
                    userId,
                    amount: option.cost,
                    source: AZM_SPEND_SOURCES.AD_BOOST,
                    reason: `Ad #${adId} boosted for ${option.label} (-${option.cost} AZM)`,
                    metadata: { adId, boostId, durationMs: option.durationMs },
                    dedupKey
                });

                // Replay of the same logical purchase: the committed boost
                // state IS the answer — re-derive the expiry from the locked
                // row (already committed by the winner) and return it
                // without a second charge or a second extension.
                if (dedupKey && debit.debited === false) {
                    return {
                        replayed: true,
                        boostExpiresAt: ad.boostExpiresAt.toISOString(),
                        newBalance: debit.newBalance
                    };
                }

                await tx.ad.update({
                    where: { id: adId },
                    data: { isBoosted: true, boostExpiresAt }
                });

                return {
                    replayed: false,
                    boostExpiresAt: boostExpiresAt.toISOString(),
                    newBalance: debit.newBalance
                };
            }, { timeout: 15000 });

            if (!result.replayed) {
                this._emitSpendUpdate(userId, result.newBalance, option.cost, AZM_SPEND_SOURCES.AD_BOOST, `Ad #${adId} boosted`);
            }
            return result;
        } catch (err) {
            // In-flight racing duplicate: this caller LOST the DB unique race,
            // so the whole transaction (debit + boost) rolled back. Converge
            // to the winner's committed state — the idempotent result a
            // sequential replay of the same logical purchase would return.
            if (dedupKey && err?.code === 'P2002') {
                const winner = await this.prisma.azmSpendLog.findFirst({
                    where: {
                        userId,
                        source: AZM_SPEND_SOURCES.AD_BOOST,
                        OR: [
                            { dedupKey },
                            { metadata: { path: ['dedupKey'], equals: dedupKey } }
                        ]
                    }
                });
                if (winner) {
                    const ad = await this.prisma.ad.findUnique({
                        where: { id: adId },
                        select: { boostExpiresAt: true }
                    });
                    return {
                        replayed: true,
                        boostExpiresAt: (ad?.boostExpiresAt || winner.createdAt).toISOString(),
                        newBalance: winner.balanceAfter
                    };
                }
            }
            throw err;
        }
    }

    // =========================================================================
    // QUERY: Get available spend options
    // =========================================================================

    /**
     * Get available spend options with user's current balance context.
     * @param {number} userId
     */
    async getSpendOptions(userId) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { azmBalance: true }
        });

        const balance = user?.azmBalance || 0;

        return {
            currentBalance: balance,
            feeDiscounts: FEE_DISCOUNT_TIERS.map(t => ({
                ...t,
                affordable: balance >= t.cost
            })),
            adBoosts: AD_BOOST_OPTIONS.map(o => ({
                ...o,
                affordable: balance >= o.cost
            }))
        };
    }

    /**
     * Get spend history (paginated).
     * @param {number} userId
     * @param {object} opts
     */
    async getSpendHistory(userId, { cursor, limit = 20, source } = {}) {
        const where = { userId };
        if (source) where.source = source;

        const take = Math.min(limit, 100);
        const findArgs = {
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: take + 1,
            select: {
                id: true,
                amount: true,
                reason: true,
                source: true,
                metadata: true,
                balanceAfter: true,
                createdAt: true
            }
        };

        if (cursor) {
            findArgs.cursor = { id: cursor };
            findArgs.skip = 1;
        }

        const rows = await this.prisma.azmSpendLog.findMany(findArgs);
        const hasMore = rows.length > take;
        const spends = hasMore ? rows.slice(0, take) : rows;
        const nextCursor = hasMore ? spends[spends.length - 1].id : null;

        return { spends, nextCursor, hasMore };
    }

    // =========================================================================
    // CARD SKINS — purchase & equip cosmetic peer-transfer card skins
    // =========================================================================

    /**
     * Purchase a card skin with AZM. Idempotent — re-purchasing an already-
     * owned skin is a no-op (no double charge) and returns immediately.
     *
     * @param {number} userId
     * @param {string} skinId - one of CARD_SKIN_OPTIONS ids (not 'classic')
     * @returns {Promise<{purchased: boolean, ownedCardSkins: string[], newBalance: number}>}
     */
    async purchaseCardSkin(userId, skinId) {
        const option = CARD_SKIN_OPTIONS.find(s => s.id === skinId);
        if (!option) throw new Error(`Invalid card skin: ${skinId}`);

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { ownedCardSkins: true, azmBalance: true }
        });
        if (!user) throw new Error('User not found.');

        // Already owned — idempotent no-op, no double charge.
        if (user.ownedCardSkins.includes(skinId)) {
            return {
                purchased: false,
                ownedCardSkins: user.ownedCardSkins,
                newBalance: Number(user.azmBalance)
            };
        }

        // Atomic: debit AZM + append to ownedCardSkins in one transaction.
        // §r41 — USER-ROW SERIALIZATION (final-audit #13): pre-r41 the
        // array was rebuilt from an UNLOCKED read and written as an absolute
        // replacement — two concurrent purchases of different skins both
        // debited, and the last absolute-array writer erased the other's
        // paid entitlement. Fix: take the user row lock first, then
        // recompute from the LOCKED row. Concurrent purchases (different or
        // same skin) serialize behind the lock; the debit + array write
        // commit as one statement from locked-row truth.
        const result = await this.prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT id FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
            const fresh = await tx.user.findUnique({
                where: { id: userId },
                select: { azmBalance: true, ownedCardSkins: true }
            });
            if (!fresh) throw new Error('User not found.');
            if (fresh.ownedCardSkins.includes(skinId)) {
                return { alreadyOwned: true, ownedCardSkins: fresh.ownedCardSkins, newBalance: fresh.azmBalance };
            }
            if (Number(fresh.azmBalance) < option.cost) {
                throw new Error(
                    `Insufficient AZM balance. Required: ${option.cost}, available: ${Number(fresh.azmBalance).toFixed(1)}`
                );
            }

            const ownedCardSkins = [...fresh.ownedCardSkins, skinId];
            const updatedUser = await tx.user.update({
                where: { id: userId },
                data: {
                    azmBalance: { decrement: option.cost },
                    ownedCardSkins
                },
                select: { azmBalance: true, ownedCardSkins: true }
            });

            await tx.azmSpendLog.create({
                data: {
                    userId,
                    amount: option.cost,
                    source: AZM_SPEND_SOURCES.CARD_SKIN,
                    reason: `Purchased "${option.label}" card skin (-${option.cost} AZM)`,
                    metadata: { skinId },
                    balanceAfter: updatedUser.azmBalance
                }
            });

            return { alreadyOwned: false, ownedCardSkins: updatedUser.ownedCardSkins, newBalance: updatedUser.azmBalance };
        });

        if (result.alreadyOwned) {
            return { purchased: false, ownedCardSkins: result.ownedCardSkins, newBalance: Number(result.newBalance) };
        }

        this._emitSpendUpdate(userId, result.newBalance, option.cost, AZM_SPEND_SOURCES.CARD_SKIN, `Purchased "${option.label}" card skin`);

        return { purchased: true, ownedCardSkins: result.ownedCardSkins, newBalance: Number(result.newBalance) };
    }

    /**
     * Equip an owned card skin (or 'classic', always allowed). Free — no AZM cost.
     * Throws if the user doesn't own the requested skin.
     *
     * @param {number} userId
     * @param {string} skinId
     * @returns {Promise<{equippedCardSkin: string}>}
     */
    async equipCardSkin(userId, skinId) {
        if (!VALID_CARD_SKIN_IDS.has(skinId)) {
            throw new Error(`Invalid card skin: ${skinId}`);
        }

        if (skinId !== FREE_CARD_SKIN) {
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: { ownedCardSkins: true }
            });
            if (!user) throw new Error('User not found.');
            if (!user.ownedCardSkins.includes(skinId)) {
                throw new Error('You do not own this card skin yet.');
            }
        }

        const updated = await this.prisma.user.update({
            where: { id: userId },
            data: { equippedCardSkin: skinId },
            select: { equippedCardSkin: true }
        });

        return { equippedCardSkin: updated.equippedCardSkin };
    }

    /**
     * Get the card skin catalog with per-user ownership/equipped state.
     * @param {number} userId
     */
    async getCardSkinCatalog(userId) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { ownedCardSkins: true, equippedCardSkin: true, azmBalance: true }
        });
        if (!user) throw new Error('User not found.');

        const skins = [
            { id: FREE_CARD_SKIN, label: 'Classic', cost: 0, owned: true },
            ...CARD_SKIN_OPTIONS.map(s => ({
                ...s,
                owned: user.ownedCardSkins.includes(s.id),
                affordable: Number(user.azmBalance) >= s.cost
            }))
        ];

        return { skins, equippedCardSkin: user.equippedCardSkin, azmBalance: Number(user.azmBalance) };
    }

    // =========================================================================
    // INTERNAL: Socket emission
    // =========================================================================

    _emitSpendUpdate(userId, newAzmBalance, azmSpent, source, reason) {
        if (!this.io) return;
        try {
            this.io.to(`user_${userId}`).emit('azm_spend', {
                azmBalance: newAzmBalance,
                spent: azmSpent,
                source,
                reason,
                timestamp: new Date().toISOString()
            });
        } catch (err) {
            logger.error({ err: err }, '[AzmSpendService._emitSpendUpdate] socket error');
        }
    }
}

module.exports = { AzmSpendService, AZM_COSTS, AZM_SPEND_SOURCES, FEE_DISCOUNT_TIERS, AD_BOOST_OPTIONS, CARD_SKIN_OPTIONS, VALID_CARD_SKIN_IDS, FREE_CARD_SKIN };
