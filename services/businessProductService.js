// services/businessProductService.js
// =============================================================================
// AZAMAN — Business Product Service (2026-06-16)
//
// Pure I/O service. Manages BusinessProduct CRUD for the Business Portal.
// No req/res, no $transaction blocks (products carry no balances). Mirrors the
// validation/shape conventions of services/businessService.js.
//
// Products are soft-deleted only (isActive=false) — never hard-deleted — so
// historical orders keep their product reference intact.
// =============================================================================

const VALID_CATEGORIES = new Set([
    'FREELANCE_SERVICES', 'RETAIL', 'FOOD_BEVERAGE', 'TECHNOLOGY', 'REAL_ESTATE',
    'EDUCATION', 'HEALTH_WELLNESS', 'ENTERTAINMENT', 'LOGISTICS',
    'FINANCIAL_SERVICES', 'OTHER'
]);

// Fields a business owner may set via updateProduct.
const UPDATABLE_FIELDS = new Set([
    'name', 'description', 'priceUsdc', 'imageUrls', 'category', 'isActive'
]);

// ── private helpers ───────────────────────────────────────────────────────────

/** Generate a unique slug from businessName + productName, suffixing on clash. */
const _generateSlug = async (prisma, businessName, productName) => {
    const base = `${businessName}-${productName}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    for (let suffix = 0; suffix <= 99; suffix++) {
        const candidate = suffix === 0 ? base : `${base}-${suffix}`;
        const clash = await prisma.businessProduct.findUnique({ where: { slug: candidate } });
        if (!clash) return candidate;
    }
    throw new Error('Could not generate a unique product slug. Please retry.');
};

/**
 * Validate + normalise a field bag shared by create and update. Returns a clean
 * object containing only the provided, valid fields. Throws on invalid values.
 */
const _validateFields = ({ name, description, priceUsdc, imageUrls, category }, { partial }) => {
    const data = {};

    if (name !== undefined || !partial) {
        const clean = String(name || '').trim();
        if (clean.length < 2 || clean.length > 200) {
            throw new Error('name must be 2–200 chars.');
        }
        data.name = clean;
    }

    if (priceUsdc !== undefined || !partial) {
        const price = Number(priceUsdc);
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error('priceUsdc must be a positive finite number.');
        }
        data.priceUsdc = price;
    }

    if (imageUrls !== undefined) {
        if (!Array.isArray(imageUrls) || !imageUrls.every((u) => typeof u === 'string')) {
            throw new Error('imageUrls must be an array of strings.');
        }
        if (imageUrls.length > 10) {
            throw new Error('imageUrls max 10 items.');
        }
        data.imageUrls = imageUrls;
    }

    if (description !== undefined) {
        if (description != null && String(description).length > 1000) {
            throw new Error('description must be max 1000 chars.');
        }
        data.description = description ? String(description) : null;
    }

    if (category !== undefined) {
        if (category != null && !VALID_CATEGORIES.has(category)) {
            throw new Error(`category must be one of: ${[...VALID_CATEGORIES].join(', ')}`);
        }
        data.category = category || null;
    }

    return data;
};

// =============================================================================
// 1. CREATE PRODUCT
// =============================================================================
const createProduct = async (prisma, { businessProfileId, name, description, priceUsdc, imageUrls, category }) => {
    if (!businessProfileId) throw new Error('businessProfileId is required.');

    const profile = await prisma.businessProfile.findUnique({
        where: { id: businessProfileId },
        select: { id: true, businessName: true }
    });
    if (!profile) throw new Error('Business profile not found.');

    const data = _validateFields({ name, description, priceUsdc, imageUrls, category }, { partial: false });
    const slug = await _generateSlug(prisma, profile.businessName, data.name);

    return prisma.businessProduct.create({
        data: {
            businessProfileId,
            name: data.name,
            description: data.description ?? (description ? String(description) : null),
            priceUsdc: data.priceUsdc,
            imageUrls: data.imageUrls ?? (Array.isArray(imageUrls) ? imageUrls : null),
            category: data.category ?? (category && VALID_CATEGORIES.has(category) ? category : null),
            slug
        }
    });
};

// =============================================================================
// 2. UPDATE PRODUCT — whitelisted fields, owner-scoped. Regenerates slug on
//    name change.
// =============================================================================
const updateProduct = async (prisma, { productId, businessProfileId, updates }) => {
    if (!productId) throw new Error('productId is required.');

    const product = await prisma.businessProduct.findUnique({
        where: { id: productId },
        include: { businessProfile: { select: { businessName: true } } }
    });
    if (!product) throw new Error('Product not found.');
    if (product.businessProfileId !== businessProfileId) {
        throw new Error('You do not own this product.');
    }

    // Keep only whitelisted keys before validating.
    const filtered = {};
    for (const [key, value] of Object.entries(updates || {})) {
        if (UPDATABLE_FIELDS.has(key)) filtered[key] = value;
    }

    const data = _validateFields(filtered, { partial: true });

    if ('isActive' in filtered) {
        data.isActive = !!filtered.isActive;
    }

    // Regenerate slug when the name changes.
    if (data.name && data.name !== product.name) {
        data.slug = await _generateSlug(prisma, product.businessProfile.businessName, data.name);
    }

    if (Object.keys(data).length === 0) {
        throw new Error('No valid fields to update.');
    }

    return prisma.businessProduct.update({ where: { id: productId }, data });
};

// =============================================================================
// 3. LIST PRODUCTS — cursor pagination by id.
// =============================================================================
const listProducts = async (prisma, { businessProfileId, isActive, limit, cursor }) => {
    const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

    const where = { businessProfileId };
    if (typeof isActive === 'boolean') where.isActive = isActive;

    const rows = await prisma.businessProduct.findMany({
        where,
        take: take + 1,
        orderBy: { createdAt: 'desc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });

    const hasMore = rows.length > take;
    const products = hasMore ? rows.slice(0, take) : rows;
    const nextCursor = hasMore ? products[products.length - 1].id : null;

    return { products, hasMore, nextCursor };
};

// =============================================================================
// 4. GET PRODUCT — optionally include a slim business profile projection.
// =============================================================================
const getProduct = async (prisma, { productId, includeBusinessProfile }) =>
    prisma.businessProduct.findUnique({
        where: { id: productId },
        ...(includeBusinessProfile
            ? {
                include: {
                    businessProfile: {
                        select: { bizId: true, businessName: true, isVerified: true, kybStatus: true }
                    }
                }
            }
            : {})
    });

// =============================================================================
// 5. DELETE PRODUCT — soft delete (isActive=false). Blocked if active orders.
// =============================================================================
const deleteProduct = async (prisma, { productId, businessProfileId }) => {
    if (!productId) throw new Error('productId is required.');

    const product = await prisma.businessProduct.findUnique({
        where: { id: productId },
        select: { id: true, businessProfileId: true }
    });
    if (!product) throw new Error('Product not found.');
    if (product.businessProfileId !== businessProfileId) {
        throw new Error('You do not own this product.');
    }

    const activeOrders = await prisma.businessOrder.count({
        where: {
            productId,
            status: { notIn: ['COMPLETED', 'REFUNDED', 'CANCELLED'] }
        }
    });
    if (activeOrders > 0) {
        throw new Error('Cannot delete a product with active orders. Mark it inactive instead.');
    }

    return prisma.businessProduct.update({
        where: { id: productId },
        data: { isActive: false }
    });
};

module.exports = {
    createProduct,
    updateProduct,
    listProducts,
    getProduct,
    deleteProduct
};
