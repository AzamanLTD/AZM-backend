// controllers/businessProductController.js
// =============================================================================
// AZAMAN — BUSINESS PRODUCT CONTROLLER
// =============================================================================

const logger = require('../src/config/logger');
const businessProductService = require('../services/businessProductService');

async function _ownedProfile(prisma, userId) {
    return prisma.businessProfile.findFirst({
        where: { userId },
        select: { id: true, businessName: true, kybStatus: true }
    });
}

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

exports.createProduct = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { name, description, priceUsdc, imageUrls, category, catalogSectionId, tags, calorieCount, preparationMins, variants, modifierGroups, locationId, deliveryTerms, estimatedDelivery, isAvailable } = req.body;
        if (!name || priceUsdc === undefined || priceUsdc === null) return res.status(400).json({ success: false, message: 'name and priceUsdc are required.' });
        const profile = await _resolveTargetProfile(prisma, req);
        if (!profile) return res.status(403).json({ success: false, message: 'You do not own a business profile.' });
        const product = await businessProductService.createProduct(prisma, { businessProfileId: profile.id, name, description, priceUsdc, imageUrls, category, catalogSectionId, tags, calorieCount, preparationMins, variants, modifierGroups, locationId, deliveryTerms, estimatedDelivery, isAvailable });
        return res.status(201).json({ success: true, product });
    } catch (err) { return res.status(err.status || 400).json({ success: false, message: err.message }); }
};

exports.listMyProducts = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const profile = await _ownedProfile(prisma, req.user.id);
        if (!profile) return res.status(403).json({ success: false, message: 'You do not own a business profile.' });
        const { isActive, locationId, limit, cursor } = req.query;
        let isActiveFilter;
        if (isActive === 'true') isActiveFilter = true;
        else if (isActive === 'false') isActiveFilter = false;
        const result = await businessProductService.listProducts(prisma, { businessProfileId: profile.id, isActive: isActiveFilter, locationId: locationId ? String(locationId) : undefined, limit, cursor });
        return res.status(200).json({ success: true, ...result });
    } catch (err) { return res.status(400).json({ success: false, message: err.message }); }
};

exports.getProduct = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const product = await businessProductService.getProduct(prisma, { productId: req.params.productId, includeBusinessProfile: true });
        if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
        return res.status(200).json({ success: true, product });
    } catch (err) { return res.status(400).json({ success: false, message: err.message }); }
};

exports.updateProduct = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const profile = await _ownedProfile(prisma, req.user.id);
        if (!profile) return res.status(403).json({ success: false, message: 'You do not own a business profile.' });
        const product = await businessProductService.updateProduct(prisma, { productId: req.params.productId, businessProfileId: profile.id, updates: req.body });
        return res.status(200).json({ success: true, product });
    } catch (err) { return res.status(400).json({ success: false, message: err.message }); }
};

exports.deleteProduct = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const profile = await _ownedProfile(prisma, req.user.id);
        if (!profile) return res.status(403).json({ success: false, message: 'You do not own a business profile.' });
        const product = await businessProductService.deleteProduct(prisma, { productId: req.params.productId, businessProfileId: profile.id });
        return res.status(200).json({ success: true, product, message: 'Product deactivated.' });
    } catch (err) { return res.status(400).json({ success: false, message: err.message }); }
};

exports.listProductsByBizId = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const biz = await prisma.businessProfile.findFirst({ where: { bizId: req.params.bizId }, select: { id: true, isSuspended: true } });
        if (!biz || biz.isSuspended) return res.status(404).json({ success: false, message: 'Business not found.' });
        const { limit, cursor, locationId } = req.query;
        const result = await businessProductService.listProducts(prisma, { businessProfileId: biz.id, isActive: true, locationId: locationId ? String(locationId) : undefined, limit, cursor });
        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        logger.error({ err: err }, '[listProductsByBizId] error');
        return res.status(400).json({ success: false, message: err.message });
    }
};
