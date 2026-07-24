// services/feeProfileService.js
// =============================================================================
// AZAMAN V2 — FEE PROFILE RESOLUTION SERVICE (Phase Q1)
//
// Resolves the active fee profile for a given trade context. The admin can
// create profiles targeting specific scopes (ALL, VENDOR_TIER, INFLUENCER_REFERRAL,
// HOLIDAY, CUSTOM). The highest-priority active profile matching the trade
// context wins. Falls back to system default (priority 0) if none match.
//
// Usage:
const logger = require('../src/config/logger');
//   const { resolveFeeProfile } = require('./feeProfileService');
//   const profile = await resolveFeeProfile(prisma, { vendorId, buyerId, amountCrypto });
//   // profile.platformFeePct, profile.adminSplitPct, profile.vendorSplitPct, profile.exitFeePct
// =============================================================================

/**
 * Resolve the best-matching active fee profile for a trade.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ vendorId?: number, buyerId?: number, amountCrypto?: number }} context
 * @returns {Promise<{ platformFeePct: number, adminSplitPct: number, vendorSplitPct: number, exitFeePct: number, profileId: string, profileName: string }>}
 */
async function resolveFeeProfile(prisma, { vendorId, buyerId, amountCrypto } = {}) {
    const now = new Date();

    // 1. Fetch all active profiles, ordered by priority DESC
    let profiles = [];
    try {
        profiles = await prisma.adminFeeProfile.findMany({
            where: {
                isActive: true,
                OR: [
                    { validFrom: null },
                    { validFrom: { lte: now } }
                ]
            },
            orderBy: { priority: 'desc' }
        });
    } catch (e) {
        // Table might not exist yet (pre-migration) — return defaults gracefully
        logger.warn('[feeProfileService] AdminFeeProfile query failed (table may not exist):', e.message);
        return {
            platformFeePct: 0,
            adminSplitPct: 0,
            vendorSplitPct: 0,
            exitFeePct: 0,
            profileId: 'fallback-to-global-settings',
            profileName: 'Global Settings Fallback'
        };
    }

    // 2. Filter to those within their validity window
    const validProfiles = profiles.filter(p => {
        if (p.validUntil && new Date(p.validUntil) < now) return false;
        return true;
    });

    // --- Phase ADMIN-CONTROL-2 FIX 4: PRE-FETCH vendor and buyer ONCE — eliminates N+1 ---
    let vendor = null, buyer = null;
    if (vendorId) {
        vendor = await prisma.user.findUnique({
            where: { id: vendorId },
            select: { vendorLevel: true, tradesCompleted: true, referredByCode: true, withdrawalRiskTier: true }
        });
    }
    if (buyerId) {
        buyer = await prisma.user.findUnique({
            where: { id: buyerId },
            select: { tradesCompleted: true, referredByCode: true, withdrawalRiskTier: true }
        });
    }

    // 3. Try to match scoped profiles against the trade context
    let bestMatch = null;

    for (const profile of validProfiles) {
        const matched = _matchesContextSync(profile, { vendorId, buyerId, amountCrypto, vendor, buyer });
        if (matched) {
            bestMatch = profile;
            break; // highest priority first, so first match wins
        }
    }

    // 4. If no scoped profile matched, fall back to the ALL scope default
    if (!bestMatch) {
        bestMatch = validProfiles.find(p => p.targetScope === 'ALL') || null;
    }

    // 5. If still nothing (DB is empty), return zeros so caller uses GlobalSettings
    if (!bestMatch) {
        return {
            platformFeePct: 0,
            adminSplitPct: 0,
            vendorSplitPct: 0,
            exitFeePct: 0,
            profileId: 'no-profile-matched',
            profileName: 'No Profile (using GlobalSettings)'
        };
    }

    return {
        platformFeePct: Number(bestMatch.platformFeePct),
        adminSplitPct: Number(bestMatch.adminSplitPct),
        vendorSplitPct: Number(bestMatch.vendorSplitPct),
        exitFeePct: Number(bestMatch.exitFeePct),
        profileId: bestMatch.id,
        profileName: bestMatch.name
    };
}

/**
 * Phase ADMIN-CONTROL-2 FIX 4: Synchronous context matcher — no DB calls inside.
 * Uses pre-fetched vendor and buyer objects passed from resolveFeeProfile.
 */
function _matchesContextSync(profile, { vendorId, buyerId, vendor, buyer }) {
    switch (profile.targetScope) {
        case 'ALL':
            return true;

        case 'VENDOR_TIER': {
            if (!vendor || !profile.targetValue) return false;
            const tv = profile.targetValue.toUpperCase();
            if (tv === 'GOLD' && (vendor.vendorLevel >= 5 || vendor.tradesCompleted >= 100)) return true;
            if (tv === 'SILVER' && (vendor.vendorLevel >= 3 || vendor.tradesCompleted >= 50)) return true;
            if (tv === 'BRONZE' && (vendor.vendorLevel >= 1 || vendor.tradesCompleted >= 10)) return true;
            const numLevel = parseInt(tv, 10);
            if (!isNaN(numLevel) && vendor.vendorLevel >= numLevel) return true;
            return false;
        }

        case 'USER_TIER': {
            if (!buyer || !profile.targetValue) return false;
            const threshold = parseInt(profile.targetValue, 10);
            if (!isNaN(threshold) && buyer.tradesCompleted >= threshold) return true;
            return false;
        }

        case 'INFLUENCER_REFERRAL': {
            if (!buyer || !profile.targetValue) return false;
            return buyer.referredByCode === profile.targetValue;
        }

        case 'HOLIDAY':
            // Holiday profiles match everyone — their time window is the gate
            return true;

        case 'CUSTOM': {
            // Custom profiles target specific user IDs (comma-separated in targetValue)
            if (!profile.targetValue) return false;
            const targetIds = profile.targetValue.split(',').map(s => parseInt(s.trim(), 10));
            if (vendorId && targetIds.includes(vendorId)) return true;
            if (buyerId && targetIds.includes(buyerId)) return true;
            return false;
        }

        default:
            return false;
    }
}

/**
 * Resolve exit fee profile for a withdrawal context (user-only, no vendor).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ userId: number }} context
 * @returns {Promise<{ exitFeePct: number, profileId: string, profileName: string }>}
 */
async function resolveExitFeeProfile(prisma, { userId }) {
    const result = await resolveFeeProfile(prisma, { buyerId: userId });
    return {
        exitFeePct: result.exitFeePct,
        profileId: result.profileId,
        profileName: result.profileName
    };
}

module.exports = { resolveFeeProfile, resolveExitFeeProfile };
