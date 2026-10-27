// controllers/socialProofController.js
// =============================================================================
// Business social-proof aggregates (marketplace personalisation, Backend C).
// Personalised data — every route requires authentication; the viewer is
// always resolved from the token at the route boundary.
// =============================================================================

const { getSocialProof, getSocialProofBatch } = require('../services/marketplace/businessSocialProofService');

const MAX_BATCH = 50;

exports.getForBusiness = async (req, res) => {
    try {
        const prisma = req.prisma;
        const businessProfileId = req.params.businessProfileId;
        if (!businessProfileId || typeof businessProfileId !== 'string') {
            return res.status(400).json({
                success: false, code: 'VALIDATION_ERROR',
                message: 'A businessProfileId is required.',
            });
        }
        // PUBLIC VISIBILITY BOUNDARY (review reconciliation): a business
        // hidden from the public discovery feed (suspended, owner-paused, or
        // not publicly discoverable) is served 404 here too — the same
        // eligibility contract as the public discovery feed. The social
        // proof of a hidden business is not readable while it is hidden.
        const business = await prisma.businessProfile.findFirst({
            where: {
                id: businessProfileId,
                isSuspended: false,
                isPausedByOwner: false,
                isPubliclyDiscoverable: true,
            },
            select: { id: true },
        });
        if (!business) {
            return res.status(404).json({
                success: false, code: 'BUSINESS_NOT_FOUND',
                message: 'Business not found.',
            });
        }
        const proof = await getSocialProof(prisma, {
            viewerId: req.user.id,
            businessProfileId,
        });
        return res.status(200).json({ success: true, businessProfileId, ...proof });
    } catch (err) {
        return res.status(err.status || 500).json({
            success: false, code: err.code || 'INTERNAL_ERROR',
            message: err.message,
        });
    }
};

exports.getForBusinesses = async (req, res) => {
    try {
        const prisma = req.prisma;
        const ids = req.body.businessProfileIds;
        if (!Array.isArray(ids) || ids.length === 0 ||
            ids.some(i => typeof i !== 'string') || ids.length > MAX_BATCH) {
            return res.status(400).json({
                success: false, code: 'VALIDATION_ERROR',
                message: `businessProfileIds must be a non-empty array of strings (max ${MAX_BATCH}).`,
            });
        }
        // Unknown AND publicly-invisible IDs are simply absent from the
        // result (honest zeros) — the same eligibility contract as the
        // single-business route and the public discovery feed; the
        // single-business route is the one that distinguishes 404.
        const visible = await prisma.businessProfile.findMany({
            where: {
                id: { in: ids },
                isSuspended: false,
                isPausedByOwner: false,
                isPubliclyDiscoverable: true,
            },
            select: { id: true },
        });
        const proofs = await getSocialProofBatch(prisma, {
            viewerId: req.user.id,
            businessProfileIds: visible.map(b => b.id),
        });
        // Preserve the honest-zeros contract for every REQUESTED id:
        // unknown and publicly-invisible businesses read as zeros (no
        // personal aggregates), never as a distinguishable error.
        for (const id of ids) {
            if (!proofs[id]) {
                proofs[id] = { friendsFollowingCount: 0, friendsOfFriendsFollowingCount: 0 };
            }
        }
        return res.status(200).json({ success: true, proofs });
    } catch (err) {
        return res.status(err.status || 500).json({
            success: false, code: err.code || 'INTERNAL_ERROR',
            message: err.message,
        });
    }
};
