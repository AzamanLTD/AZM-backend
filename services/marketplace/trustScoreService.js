// services/marketplace/trustScoreService.js
// =============================================================================
// AZAMAN — CUSTOMER TRUST SCORE SERVICE (2026-07-03)
// Tracks repeat no-show behavior. Surfaces trust level to businesses
// during check-in so they can decide whether to accept walk-ins.
//
// Trust levels:
//   EXCELLENT — 0 no-shows, 5+ bookings
//   GOOD — 0-1 no-shows (default for new users)
//   CAUTION — 2-3 no-shows or 20%+ no-show rate
//   RISK — 4+ no-shows or 30%+ no-show rate
// =============================================================================

class TrustScoreService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    /**
     * Get or create a trust score for a user.
     */
    async getOrCreateScore(userId) {
        return this.prisma.customerTrustScore.upsert({
            where: { customerId: userId },
            update: {},
            create: { customerId: userId, trustLevel: 'GOOD' },
        });
    }

    /**
     * Record a completed booking (increments totalBookings, recalculates level).
     */
    async recordCompletedBooking(userId) {
        const score = await this.getOrCreateScore(userId);
        const updated = await this.prisma.customerTrustScore.update({
            where: { customerId: userId },
            data: { totalBookings: score.totalBookings + 1 },
        });
        return this._recalculateLevel(updated);
    }

    /**
     * Record a no-show (increments noShowCount, recalculates level).
     */
    async recordNoShow(userId) {
        const score = await this.getOrCreateScore(userId);
        const updated = await this.prisma.customerTrustScore.update({
            where: { customerId: userId },
            data: { noShowCount: score.noShowCount + 1 },
        });
        return this._recalculateLevel(updated);
    }

    /**
     * Recalculate trust level based on no-show rate and absolute counts.
     * @param {object} score - The current CustomerTrustScore record
     * @returns {Promise<object>} Updated score with new trustLevel
     * @private
     */
    async _recalculateLevel(score) {
        let level = 'GOOD';
        const total = score.totalBookings;
        const noShows = score.noShowCount;
        const rate = total > 0 ? noShows / total : 0;

        // EXCELLENT: 5+ bookings with zero no-shows
        if (total >= 5 && noShows === 0) {
            level = 'EXCELLENT';
        // RISK: 4+ absolute no-shows, OR high rate (>=40%) with 10+ bookings
        } else if (noShows >= 4 || (total >= 10 && rate >= 0.40)) {
            level = 'RISK';
        // CAUTION: 2+ no-shows, OR 20%+ rate with 5+ bookings
        } else if (noShows >= 2 || (total >= 5 && rate >= 0.20)) {
            level = 'CAUTION';
        }

        if (level !== score.trustLevel) {
            return this.prisma.customerTrustScore.update({
                where: { customerId: score.customerId },
                data: { trustLevel: level, noShowRate: rate },
            });
        }
        
        if (rate !== parseFloat(score.noShowRate)) {
             return this.prisma.customerTrustScore.update({
                where: { customerId: score.customerId },
                data: { noShowRate: rate },
            });
        }
        return score;
    }

    /**
     * Get the trust level for a user (for business check-in display).
     */
    async getTrustLevel(userId) {
        const score = await this.getOrCreateScore(userId);
        return {
            trustLevel: score.trustLevel,
            totalBookings: score.totalBookings,
            noShowCount: score.noShowCount,
            lateCancelCount: score.lateCancelCount,
        };
    }
}

module.exports = TrustScoreService;
