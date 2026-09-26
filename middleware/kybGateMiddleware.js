// middleware/kybGateMiddleware.js
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

const logger = require('../src/config/logger');
const kybGate = async (req, res, next) => {
    try {
        // Skip if no authenticated user (let auth middleware handle that)
        if (!req.user || !req.user.id) return next();

        // Reuse the request-scoped Prisma client when available so the gate
        // participates in the same DB lifecycle as the rest of the request.
        const prisma = req.app.get('prisma');
        if (!prisma) {
            logger.error('[kybGate] Prisma client unavailable. Failing closed.');
            return res.status(503).json({
                success: false,
                message: 'Business verification is temporarily unavailable. Please try again.',
                code: 'KYB_GATE_UNAVAILABLE',
            });
        }

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
        logger.error({ err }, '[kybGate] Business verification lookup failed; failing closed.');
        return res.status(503).json({
            success: false,
            message: 'Business verification is temporarily unavailable. Please try again.',
            code: 'KYB_GATE_UNAVAILABLE',
        });
    }
};

module.exports = { kybGate };
