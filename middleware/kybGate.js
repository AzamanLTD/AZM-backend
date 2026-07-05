// middleware/kybGate.js
// =============================================================================
// AZAMAN — KYB GATE MIDDLEWARE (2026-07-03)
// Blocks marketplace activity for unverified businesses.
// A business with kybStatus !== 'VERIFIED' cannot:
//   - Post ads
//   - Receive bookings/reservations
//   - Create dine-in tabs
//   - Post showcase media
//
// This is a HARD 403 block, not a cosmetic badge.
// =============================================================================

const kybGate = async (req, res, next) => {
    try {
        // Skip if no authenticated user (let auth middleware handle that)
        if (!req.user || !req.user.id) return next();

        // Look up the user's business profile
        const { PrismaClient } = require('@prisma/client');
        const prisma = req.app.get('prisma') || new PrismaClient();

        const business = await prisma.businessProfile.findFirst({
            where: { userId: req.user.id },
            select: { id: true, kybStatus: true, isSuspended: true },
        });

        // If no business profile, this user isn't a business owner — skip
        if (!business) return next();

        // If suspended, block everything
        if (business.isSuspended) {
            return res.status(403).json({
                success: false,
                message: 'Your business is suspended. Contact support.',
                code: 'BUSINESS_SUSPENDED',
            });
        }

        // If KYB not verified, block marketplace activity
        if (business.kybStatus !== 'VERIFIED') {
            return res.status(403).json({
                success: false,
                message: 'KYB verification required before posting on the marketplace.',
                code: 'KYB_REQUIRED',
                kybStatus: business.kybStatus,
            });
        }

        // Attach business profile to request for downstream use
        req.businessProfile = business;
        next();
    } catch (err) {
        console.error('[kybGate]', err.message);
        // On error, fail open (let the request proceed) — don't block legit traffic
        // due to an internal error. Log it for investigation.
        next();
    }
};

module.exports = kybGate;