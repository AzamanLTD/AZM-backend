// controllers/businessController.js
// =============================================================================
// AZAMAN — BUSINESS ACCOUNTS CONTROLLER (2026-06-14)
//
// HTTP layer for business registration, lookup, search, and profile updates.
// Mirrors the conventions in ticketController.js / friendController.js:
//   prisma = req.app.get('prisma'); userId = req.user.id;
//   success → { success: true, ... }; error → { success: false, message }.
// =============================================================================

const businessService = require('../services/businessService');

// =============================================================================
// 1. POST /api/business/register — register the calling user as a business.
// =============================================================================
exports.registerBusiness = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const {
            businessName, category, description, website,
            phoneNumber, contactEmail, address, country, logoUrl
        } = req.body;

        const cleanName = String(businessName || '').trim();
        if (cleanName.length < 2 || cleanName.length > 100) {
            return res.status(400).json({ success: false, message: 'businessName must be 2–100 chars.' });
        }
        if (category && !businessService.VALID_CATEGORIES.has(category)) {
            return res.status(400).json({
                success: false,
                message: `category must be one of: ${[...businessService.VALID_CATEGORIES].join(', ')}`
            });
        }
        if (description && String(description).length > 500) {
            return res.status(400).json({ success: false, message: 'description must be max 500 chars.' });
        }

        const result = await businessService.registerBusiness(prisma, {
            userId,
            businessName: cleanName,
            category: category || 'OTHER',
            description, website, logoUrl,
            phoneNumber, contactEmail, address, country
        });

        return res.status(201).json({
            success: true,
            businessProfile: result.businessProfile,
            alreadyRegistered: !!result.alreadyRegistered
        });
    } catch (err) {
        console.error('[registerBusiness] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 2. GET /api/business/:bizId — PUBLIC lookup by BIZ id.
// =============================================================================
exports.getBusinessByBizId = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { bizId } = req.params;
        const business = await businessService.getBusinessProfile(prisma, { bizId });
        if (!business) {
            return res.status(404).json({ success: false, message: 'Business not found.' });
        }
        if (business.isSuspended) {
            return res.status(404).json({ success: false, message: 'Business not found.' });
        }
        return res.status(200).json({ success: true, business });
    } catch (err) {
        console.error('[getBusinessByBizId] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 3. GET /api/business/search — PUBLIC search.
// =============================================================================
exports.searchBusinesses = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { q, category, verified, limit, cursor } = req.query;
        const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

        const rows = await businessService.searchBusinesses(prisma, {
            query: q ? String(q).trim() : null,
            category: category || null,
            verified: verified === 'true',
            limit: take,
            cursor: cursor || null
        });

        const hasMore = rows.length > take;
        const businesses = hasMore ? rows.slice(0, take) : rows;
        const nextCursor = hasMore ? businesses[businesses.length - 1].id : null;

        return res.status(200).json({ success: true, businesses, hasMore, nextCursor });
    } catch (err) {
        console.error('[searchBusinesses] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 4. PATCH /api/business/profile — owner updates whitelisted fields.
// =============================================================================
exports.updateBusinessProfile = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const updates = req.body || {};
        const businessProfile = await businessService.updateBusinessProfile(prisma, { userId, updates });
        return res.status(200).json({ success: true, businessProfile });
    } catch (err) {
        console.error('[updateBusinessProfile] error:', err.message);
        const code = /no business profile|no valid fields|must be/i.test(err.message) ? 400 : 500;
        return res.status(code).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 5. GET /api/business/me — calling user's own business profile.
// =============================================================================
exports.getMyBusiness = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const business = await businessService.getBusinessProfile(prisma, { userId });
        if (!business) {
            return res.status(404).json({ success: false, message: 'You have no business profile.' });
        }
        return res.status(200).json({ success: true, business });
    } catch (err) {
        console.error('[getMyBusiness] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};
