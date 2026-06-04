// controllers/adminFeeProfileController.js
// =============================================================================
// AZAMAN V2 — ADMIN FEE PROFILE CONTROLLER (Phase Q1)
//
// CRUD for fee profiles. All endpoints require admin role.
// Fee profiles control: platform fee %, admin/vendor split %, exit fee %.
// =============================================================================

const { resolveFeeProfile } = require('../services/feeProfileService');

/**
 * GET /api/admin/fee-profiles
 * List all fee profiles (paginated, ordered by priority DESC).
 */
exports.listFeeProfiles = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { includeInactive } = req.query;

        const whereClause = {};
        if (includeInactive !== 'true') {
            whereClause.isActive = true;
        }

        const profiles = await prisma.adminFeeProfile.findMany({
            where: whereClause,
            orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }]
        });

        res.status(200).json({ success: true, profiles });
    } catch (error) {
        console.error('[AdminFeeProfile] listFeeProfiles error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * POST /api/admin/fee-profiles
 * Create a new fee profile.
 */
exports.createFeeProfile = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const {
            name, targetScope, targetValue,
            platformFeePct, adminSplitPct, vendorSplitPct, exitFeePct,
            priority, validFrom, validUntil
        } = req.body;

        // Validation
        if (!name || !targetScope) {
            return res.status(400).json({ success: false, message: 'name and targetScope are required.' });
        }

        const pFee = parseFloat(platformFeePct);
        const aSplit = parseFloat(adminSplitPct);
        const vSplit = parseFloat(vendorSplitPct);
        const eFee = parseFloat(exitFeePct ?? platformFeePct);

        if (isNaN(pFee) || pFee < 0 || pFee > 1) {
            return res.status(400).json({ success: false, message: 'platformFeePct must be between 0 and 1.' });
        }
        if (isNaN(aSplit) || isNaN(vSplit) || Math.abs(aSplit + vSplit - 1.0) > 0.001) {
            return res.status(400).json({ success: false, message: 'adminSplitPct + vendorSplitPct must equal 1.0.' });
        }

        const validScopes = ['ALL', 'VENDOR_TIER', 'USER_TIER', 'INFLUENCER_REFERRAL', 'HOLIDAY', 'CUSTOM'];
        if (!validScopes.includes(targetScope)) {
            return res.status(400).json({
                success: false,
                message: `targetScope must be one of: ${validScopes.join(', ')}`
            });
        }

        const profile = await prisma.adminFeeProfile.create({
            data: {
                name,
                targetScope,
                targetValue: targetValue || null,
                platformFeePct: pFee,
                adminSplitPct: aSplit,
                vendorSplitPct: vSplit,
                exitFeePct: isNaN(eFee) ? pFee : eFee,
                priority: parseInt(priority, 10) || 0,
                isActive: true,
                validFrom: validFrom ? new Date(validFrom) : null,
                validUntil: validUntil ? new Date(validUntil) : null,
                createdBy: req.user.id
            }
        });

        res.status(201).json({ success: true, message: 'Fee profile created.', profile });
    } catch (error) {
        console.error('[AdminFeeProfile] createFeeProfile error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * PUT /api/admin/fee-profiles/:id
 * Update an existing fee profile.
 */
exports.updateFeeProfile = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { id } = req.params;
        const existing = await prisma.adminFeeProfile.findUnique({ where: { id } });
        if (!existing) {
            return res.status(404).json({ success: false, message: 'Fee profile not found.' });
        }

        const {
            name, targetScope, targetValue,
            platformFeePct, adminSplitPct, vendorSplitPct, exitFeePct,
            priority, isActive, validFrom, validUntil
        } = req.body;

        const updateData = {};
        if (name !== undefined) updateData.name = name;
        if (targetScope !== undefined) updateData.targetScope = targetScope;
        if (targetValue !== undefined) updateData.targetValue = targetValue;
        if (priority !== undefined) updateData.priority = parseInt(priority, 10);
        if (isActive !== undefined) updateData.isActive = Boolean(isActive);
        if (validFrom !== undefined) updateData.validFrom = validFrom ? new Date(validFrom) : null;
        if (validUntil !== undefined) updateData.validUntil = validUntil ? new Date(validUntil) : null;

        if (platformFeePct !== undefined) {
            const pFee = parseFloat(platformFeePct);
            if (isNaN(pFee) || pFee < 0 || pFee > 1) {
                return res.status(400).json({ success: false, message: 'platformFeePct must be between 0 and 1.' });
            }
            updateData.platformFeePct = pFee;
        }
        if (adminSplitPct !== undefined && vendorSplitPct !== undefined) {
            const aSplit = parseFloat(adminSplitPct);
            const vSplit = parseFloat(vendorSplitPct);
            if (Math.abs(aSplit + vSplit - 1.0) > 0.001) {
                return res.status(400).json({ success: false, message: 'adminSplitPct + vendorSplitPct must equal 1.0.' });
            }
            updateData.adminSplitPct = aSplit;
            updateData.vendorSplitPct = vSplit;
        }
        if (exitFeePct !== undefined) {
            const eFee = parseFloat(exitFeePct);
            if (isNaN(eFee) || eFee < 0 || eFee > 1) {
                return res.status(400).json({ success: false, message: 'exitFeePct must be between 0 and 1.' });
            }
            updateData.exitFeePct = eFee;
        }

        const updated = await prisma.adminFeeProfile.update({
            where: { id },
            data: updateData
        });

        res.status(200).json({ success: true, message: 'Fee profile updated.', profile: updated });
    } catch (error) {
        console.error('[AdminFeeProfile] updateFeeProfile error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * DELETE /api/admin/fee-profiles/:id
 * Soft-deactivate a profile (never hard-delete — audit trail).
 * The system default (id='default-fee-profile') cannot be deactivated.
 */
exports.deactivateFeeProfile = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { id } = req.params;

        if (id === 'default-fee-profile') {
            return res.status(400).json({
                success: false,
                message: 'Cannot deactivate the system default fee profile.'
            });
        }

        const existing = await prisma.adminFeeProfile.findUnique({ where: { id } });
        if (!existing) {
            return res.status(404).json({ success: false, message: 'Fee profile not found.' });
        }

        await prisma.adminFeeProfile.update({
            where: { id },
            data: { isActive: false }
        });

        res.status(200).json({ success: true, message: 'Fee profile deactivated.' });
    } catch (error) {
        console.error('[AdminFeeProfile] deactivateFeeProfile error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * GET /api/admin/fee-profiles/resolve
 * Test endpoint: resolve which profile would apply for a given trade context.
 * Query params: vendorId, buyerId, amountCrypto
 */
exports.resolveProfile = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { vendorId, buyerId, amountCrypto } = req.query;

        const profile = await resolveFeeProfile(prisma, {
            vendorId: vendorId ? parseInt(vendorId, 10) : undefined,
            buyerId: buyerId ? parseInt(buyerId, 10) : undefined,
            amountCrypto: amountCrypto ? parseFloat(amountCrypto) : undefined
        });

        res.status(200).json({ success: true, resolvedProfile: profile });
    } catch (error) {
        console.error('[AdminFeeProfile] resolveProfile error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};
