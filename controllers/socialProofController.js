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
        const business = await prisma.businessProfile.findUnique({
            where: { id: businessProfileId },
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
        // Unknown IDs are simply absent from the result (honest zeros);
        // the single-business route is the one that distinguishes 404.
        const proofs = await getSocialProofBatch(prisma, {
            viewerId: req.user.id,
            businessProfileIds: ids,
        });
        return res.status(200).json({ success: true, proofs });
    } catch (err) {
        return res.status(err.status || 500).json({
            success: false, code: err.code || 'INTERNAL_ERROR',
            message: err.message,
        });
    }
};
