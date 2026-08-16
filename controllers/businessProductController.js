// controllers/businessProductController.js
// =============================================================================
// AZAMAN — BUSINESS PRODUCT CONTROLLER (2026-06-16)
//
// HTTP layer for the Business Portal product catalogue. Mirrors the conventions
// in businessController.js / escrowController.js:
//   prisma = req.app.get('prisma'); io = req.app.get('socketio');
//   userId = req.user.id;
//   success → { success: true, ... }; error → { success: false, message }.
//
// Ownership is determined purely by the existence of a BusinessProfile for the
// calling user. GET /products/:productId is PUBLIC (no protect middleware).
// =============================================================================

const logger = require('../src/config/logger');
const businessProductService = require('../services/businessProductService');

// ── helpers ───────────────────────────────────────────────────────────────────

/** Load the BusinessProfile owned by the calling user (null if none). */
async function _ownedProfile(prisma, userId) {
    return prisma.businessProfile.findFirst({
        where: { userId },
        select: { id: true, businessName: true, kybStatus: true }
    });
}

/**
 * Resolve which BusinessProfile a write should target.
 * - Normal users: always their own profile (unchanged behavior/security).
 * - ADMIN role only: may pass an explicit `businessProfileId` in the body to
 *   manage/seed another business's catalogue (oversight/support use, same
 *   trust tier as the existing admin suspend/KYB routes). Falls back to the
 *   admin's own profile if no override is given.
 */
async function _resolveTargetProfile(prisma, req) {
    if (req.user.role === 'ADMIN' && req.body.businessProfileId) {
        const profile = await prisma.businessProfile.findFirst({
            where: { id: req.body.businessProfileId },
            select: { id: true, businessName: true, kybStatus: true }
        });
        if (!profile) throw Object.assign(new Error('businessProfileId not found.'), { status: 404 });
        return profile;
    }
    return _ownedProfile(prisma, req.user.id);
}

// =============================================================================
// 1. POST /api/business/products — create a product (owner only).
// =============================================================================
exports.createProduct = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { name, description, priceUsdc, imageUrls, category, catalogSectionId, tags, calorieCount, preparationMins } = req.body;

        if (!name || priceUsdc === undefined || priceUsdc === null) {
            return res.status(400).json({ success: false, message: 'name and priceUsdc are required.' });
        }

        const profile = await _resolveTargetProfile(prisma, req);
        if (!profile) {
            return res.status(403).json({ success: false, message: 'You do not own a business profile.' });
        }

        const product = await businessProductService.createProduct(prisma, {
            businessProfileId: profile.id,
            name,
            description,
            priceUsdc,
            imageUrls,
            category,
            catalogSectionId,
            tags,
            calorieCount,
            preparationMins,
        });

        return res.status(201).json({ success: true, product });
    } catch (err) {
        return res.status(err.status || 400).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 2. GET /api/business/products — list the caller's own products (owner only).
// =============================================================================
exports.listMyProducts = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const profile = await _ownedProfile(prisma, userId);
        if (!profile) {
            return res.status(403).json({ success: false, message: 'You do not own a business profile.' });
        }

        const { isActive, limit, cursor } = req.query;
        let isActiveFilter;
        if (isActive === 'true') isActiveFilter = true;
        else if (isActive === 'false') isActiveFilter = false;

        const result = await businessProductService.listProducts(prisma, {
            businessProfileId: profile.id,
            isActive: isActiveFilter,
            limit,
            cursor
        });

        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 3. GET /api/business/products/:productId — PUBLIC product detail.
// =============================================================================
exports.getProduct = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { productId } = req.params;
        const product = await businessProductService.getProduct(prisma, {
            productId,
            includeBusinessProfile: true
        });
        if (!product) {
            return res.status(404).json({ success: false, message: 'Product not found.' });
        }
        return res.status(200).json({ success: true, product });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 4. PATCH /api/business/products/:productId — update a product (owner only).
// =============================================================================
exports.updateProduct = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { productId } = req.params;
        const profile = await _ownedProfile(prisma, userId);
        if (!profile) {
            return res.status(403).json({ success: false, message: 'You do not own a business profile.' });
        }

        const product = await businessProductService.updateProduct(prisma, {
            productId,
            businessProfileId: profile.id,
            updates: req.body
        });

        return res.status(200).json({ success: true, product });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 5. DELETE /api/business/products/:productId — soft-delete (owner only).
// =============================================================================
exports.deleteProduct = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { productId } = req.params;
        const profile = await _ownedProfile(prisma, userId);
        if (!profile) {
            return res.status(403).json({ success: false, message: 'You do not own a business profile.' });
        }

        const product = await businessProductService.deleteProduct(prisma, {
            productId,
            businessProfileId: profile.id
        });

        return res.status(200).json({ success: true, product, message: 'Product deactivated.' });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// =============================================================================
// PUBLIC — List products by business bizId (for marketplace profile page).
// Returns only active products. No auth required.
// =============================================================================
exports.listProductsByBizId = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { bizId } = req.params;

        // Look up the business profile by bizId
        const biz = await prisma.businessProfile.findFirst({
            where: { bizId },
            select: { id: true, isSuspended: true }
        });

        if (!biz || biz.isSuspended) {
            return res.status(404).json({ success: false, message: 'Business not found.' });
        }

        // Parse pagination params
        const { limit, cursor } = req.query;

        // Reuse the existing listProducts service — it already handles
        // cursor pagination and the take+1 overflow pattern.
        const result = await businessProductService.listProducts(prisma, {
            businessProfileId: biz.id,
            isActive: true,   // public visitors only see active products
            limit,
            cursor
        });

        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        logger.error({ err: err }, '[listProductsByBizId] error');
        return res.status(400).json({ success: false, message: err.message });
    }
};
