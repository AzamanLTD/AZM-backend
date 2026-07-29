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
    async debitAzm({ userId, amount, source, reason, metadata = null, dedupKey = null }) {
        if (!userId || !amount || amount <= 0 || !source || !reason) {
            throw new Error('Invalid spend parameters.');
        }

        // Idempotency check
        if (dedupKey) {
            const existing = await this.prisma.azmSpendLog.findFirst({
                where: {
                    userId,
                    source,
                    metadata: { path: ['dedupKey'], equals: dedupKey }
                }
            });
            if (existing) {
                return { debited: false, newBalance: existing.balanceAfter, logId: existing.id };
            }
        }

        // Atomic: check balance + decrement + log in one transaction
        const result = await this.prisma.$transaction(async (tx) => {
            const user = await tx.user.findUnique({
                where: { id: userId },
                select: { azmBalance: true }
            });

            if (!user) throw new Error('User not found.');
            if (user.azmBalance < amount) {
                throw new Error(
                    `Insufficient AZM balance. Required: ${amount}, available: ${user.azmBalance.toFixed(1)}`
                );
            }

            const updatedUser = await tx.user.update({
                where: { id: userId },
                data: { azmBalance: { decrement: amount } },
                select: { azmBalance: true }
            });

            const log = await tx.azmSpendLog.create({
                data: {
                    userId,
                    amount,
                    source,
                    reason,
                    metadata: dedupKey ? { ...metadata, dedupKey } : metadata,
                    balanceAfter: updatedUser.azmBalance
                }
            });

            return { newBalance: updatedUser.azmBalance, logId: log.id };
        });

        // Emit socket event for real-time FE update
        this._emitSpendUpdate(userId, result.newBalance, amount, source, reason);

        return { debited: true, ...result };
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
    async boostAd(userId, adId, boostId) {
        const option = AD_BOOST_OPTIONS.find(o => o.id === boostId);
        if (!option) throw new Error(`Invalid boost option: ${boostId}`);

        // Verify the ad belongs to this user and is active
        const ad = await this.prisma.ad.findUnique({
            where: { id: adId },
            select: { id: true, vendorId: true, status: true, isBoosted: true, boostExpiresAt: true }
        });

        if (!ad) throw new Error('Ad not found.');
        if (ad.vendorId !== userId) throw new Error('You can only boost your own ads.');
        if (ad.status !== 'ACTIVE') throw new Error('Only active ads can be boosted.');

        // If already boosted and not expired, extend from current expiry
        const now = new Date();
        let boostStart = now;
        if (ad.isBoosted && ad.boostExpiresAt && new Date(ad.boostExpiresAt) > now) {
            boostStart = new Date(ad.boostExpiresAt); // Extend from current expiry
        }
        const boostExpiresAt = new Date(boostStart.getTime() + option.durationMs);

        // Debit AZM
        const result = await this.debitAzm({
            userId,
            amount: option.cost,
            source: AZM_SPEND_SOURCES.AD_BOOST,
            reason: `Ad #${adId} boosted for ${option.label} (-${option.cost} AZM)`,
            metadata: { adId, boostId, durationMs: option.durationMs },
            dedupKey: `ad_boost_${adId}_${boostId}_${Date.now()}`
        });

        // Update the ad with boost status
        await this.prisma.ad.update({
            where: { id: adId },
            data: {
                isBoosted: true,
                boostExpiresAt
            }
        });

        return {
            azmSpent: option.cost,
            boostExpiresAt: boostExpiresAt.toISOString(),
            newBalance: result.newBalance
        };
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
        const result = await this.prisma.$transaction(async (tx) => {
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
