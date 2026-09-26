// services/vendorBadgeService.js
// =============================================================================
// AZAMAN — VENDOR VERIFICATION BADGES (Phase Q13)
//
// Computes trust-signal badges for vendors based on their live stats.
// No new schema — all data comes from existing User + Trade fields.
//
// Badge Types:
//   VERIFIED_VENDOR  — KYC status is VERIFIED
//   TOP_TRADER       — tradesCompleted >= 100
//   FAST_RELEASE     — average completion time < 5 minutes
//   ZERO_DISPUTES    — 0 disputed trades lifetime
//   HIGH_VOLUME      — totalVolumeUsdc >= 10,000
//   TRUSTED_SELLER   — completionRate >= 98% AND tradesCompleted >= 20
//
// Usage:
//   const badges = await computeVendorBadges(prisma, vendorId);
//   // Returns: [{ id, name, icon, description, earned }]
// =============================================================================

// ── Badge Definitions ────────────────────────────────────────────────────────

const BADGE_DEFINITIONS = [
    {
        id: 'VERIFIED_VENDOR',
        name: 'Verified Vendor',
        icon: 'verified',
        description: 'Identity verified via KYC',
        color: '#02C076',
    },
    {
        id: 'TOP_TRADER',
        name: 'Top Trader',
        icon: 'trending_up',
        description: '100+ completed trades',
        color: '#FFD700',
    },
    {
        id: 'FAST_RELEASE',
        name: 'Fast Release',
        icon: 'bolt',
        description: 'Average release time under 5 minutes',
        color: '#FF6B35',
    },
    {
        id: 'ZERO_DISPUTES',
        name: 'Zero Disputes',
        icon: 'shield',
        description: 'No disputed trades',
        color: '#4CAF50',
    },
    {
        id: 'HIGH_VOLUME',
        name: 'High Volume',
        icon: 'diamond',
        description: '$10,000+ lifetime volume',
        color: '#9C27B0',
    },
    {
        id: 'TRUSTED_SELLER',
        name: 'Trusted Seller',
        icon: 'star',
        description: '98%+ completion rate with 20+ trades',
        color: '#2196F3',
    },
];

// ── Badge Computation ────────────────────────────────────────────────────────

/**
 * Compute all earned verification badges for a vendor.
 *
 * @param {PrismaClient} prisma
 * @param {number} vendorId
 * @returns {Promise<Array>} Array of badge objects with { id, name, icon, description, color, earned: true }
 */
async function computeVendorBadges(prisma, vendorId) {
    // Fetch vendor stats in one query
    const vendor = await prisma.user.findUnique({
        where: { id: vendorId },
        select: {
            kycStatus: true,
            tradesCompleted: true,
            totalVolumeUsdc: true,
            completionRate: true,
            role: true,
        },
    });

    if (!vendor || vendor.role === 'USER') {
        return [];
    }

    // Count disputes for this vendor (trades where they were vendor + status DISPUTED)
    const [disputeCount, avgCompletionTime] = await Promise.all([
        prisma.trade.count({
            where: {
                vendorId,
                status: 'DISPUTED',
            },
        }),
        // Calculate average completion time (completedAt - tradeStartTime) for completed trades
        prisma.trade.findMany({
            where: {
                vendorId,
                status: 'COMPLETED',
                completedAt: { not: null },
            },
            select: {
                tradeStartTime: true,
                completedAt: true,
            },
            take: 50, // Sample last 50 trades for avg
            orderBy: { completedAt: 'desc' },
        }),
    ]);

    // Compute average release time in minutes
    let avgReleaseMinutes = Infinity;
    if (avgCompletionTime.length > 0) {
        const totalMs = avgCompletionTime.reduce((sum, t) => {
            if (t.completedAt && t.tradeStartTime) {
                return sum + (new Date(t.completedAt) - new Date(t.tradeStartTime));
            }
            return sum;
        }, 0);
        avgReleaseMinutes = totalMs / avgCompletionTime.length / 60000;
    }

    // Evaluate each badge
    const earnedBadges = [];

    // 1. VERIFIED_VENDOR — KYC passed
    if (vendor.kycStatus === 'VERIFIED') {
        earnedBadges.push(BADGE_DEFINITIONS.find(b => b.id === 'VERIFIED_VENDOR'));
    }

    // 2. TOP_TRADER — 100+ trades
    if (vendor.tradesCompleted >= 100) {
        earnedBadges.push(BADGE_DEFINITIONS.find(b => b.id === 'TOP_TRADER'));
    }

    // 3. FAST_RELEASE — avg < 5 min (only if they have completed trades)
    if (avgCompletionTime.length >= 5 && avgReleaseMinutes < 5) {
        earnedBadges.push(BADGE_DEFINITIONS.find(b => b.id === 'FAST_RELEASE'));
    }

    // 4. ZERO_DISPUTES — no disputes
    if (disputeCount === 0 && vendor.tradesCompleted >= 5) {
        earnedBadges.push(BADGE_DEFINITIONS.find(b => b.id === 'ZERO_DISPUTES'));
    }

    // 5. HIGH_VOLUME — $10k+ volume
    if (Number(vendor.totalVolumeUsdc) >= 10000) {
        earnedBadges.push(BADGE_DEFINITIONS.find(b => b.id === 'HIGH_VOLUME'));
    }

    // 6. TRUSTED_SELLER — 98%+ completion + 20+ trades
    if (Number(vendor.completionRate) >= 98 && vendor.tradesCompleted >= 20) {
        earnedBadges.push(BADGE_DEFINITIONS.find(b => b.id === 'TRUSTED_SELLER'));
    }

    return earnedBadges.filter(Boolean).map(b => ({ ...b, earned: true }));
}

/**
 * Get all badge definitions (for FE display of unearned badges).
 */
function getAllBadgeDefinitions() {
    return BADGE_DEFINITIONS;
}

module.exports = {
    computeVendorBadges,
    getAllBadgeDefinitions,
    BADGE_DEFINITIONS,
};
