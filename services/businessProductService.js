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

const UPDATABLE_FIELDS = new Set([
    'name', 'description', 'priceUsdc', 'imageUrls', 'category', 'isActive',
    'catalogSectionId', 'tags', 'calorieCount', 'preparationMins', 'variants',
    'modifierGroups', 'locationId', 'deliveryTerms', 'estimatedDelivery', 'isAvailable'
]);

const _cleanOptionRows = (value, label, max) => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
    if (value.length > max) throw new Error(`${label} max ${max} items.`);
    return value.map((row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new Error(`${label}[${index}] must be an object.`);
        }
        const name = String(row.name ?? '').trim();
        if (name.length < 1 || name.length > 100) {
            throw new Error(`${label}[${index}].name must be 1–100 chars.`);
        }
        const priceDelta = Number(row.priceDelta ?? 0);
        if (!Number.isFinite(priceDelta)) {
            throw new Error(`${label}[${index}].priceDelta must be finite.`);
        }
        return { name, priceDelta };
    });
};

const _cleanModifierGroups = (value) => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error('modifierGroups must be an array.');
    if (value.length > 20) throw new Error('modifierGroups max 20 groups.');
    return value.map((group, index) => {
        if (!group || typeof group !== 'object' || Array.isArray(group)) {
            throw new Error(`modifierGroups[${index}] must be an object.`);
        }
        const name = String(group.name ?? '').trim();
        if (name.length < 1 || name.length > 100) {
            throw new Error(`modifierGroups[${index}].name must be 1–100 chars.`);
        }
        const maxSelection = Number(group.maxSelection ?? 1);
        if (!Number.isInteger(maxSelection) || maxSelection < 1 || maxSelection > 20) {
            throw new Error(`modifierGroups[${index}].maxSelection must be an integer from 1 to 20.`);
        }
        const options = Array.isArray(group.options) ? group.options : [];
        if (options.length > 30) throw new Error(`modifierGroups[${index}].options max 30 items.`);
        return {
            name,
            maxSelection,
            options: options.map((option, optionIndex) => {
                if (!option || typeof option !== 'object' || Array.isArray(option)) {
                    throw new Error(`modifierGroups[${index}].options[${optionIndex}] must be an object.`);
                }
                const optionName = String(option.name ?? '').trim();
                if (optionName.length < 1 || optionName.length > 100) {
                    throw new Error(`modifierGroups[${index}].options[${optionIndex}].name must be 1–100 chars.`);
                }
                const priceDelta = Number(option.priceDelta ?? 0);
                if (!Number.isFinite(priceDelta)) {
                    throw new Error(`modifierGroups[${index}].options[${optionIndex}].priceDelta must be finite.`);
                }
                return { name: optionName, priceDelta };
            }),
        };
    });
};

const _validateFields = ({
    name, description, priceUsdc, imageUrls, category, catalogSectionId, tags,
    calorieCount, preparationMins, variants, modifierGroups, locationId,
    deliveryTerms, estimatedDelivery, isAvailable,
}, { partial }) => {
    const data = {};

    if (name !== undefined || !partial) {
        const clean = String(name || '').trim();
        if (clean.length < 2 || clean.length > 200) throw new Error('name must be 2–200 chars.');
        data.name = clean;
    }

    if (priceUsdc !== undefined || !partial) {
        const price = Number(priceUsdc);
        if (!Number.isFinite(price) || price <= 0) throw new Error('priceUsdc must be a positive finite number.');
        data.priceUsdc = price;
    }

    if (imageUrls !== undefined) {
        if (!Array.isArray(imageUrls) || !imageUrls.every((u) => typeof u === 'string')) {
            throw new Error('imageUrls must be an array of strings.');
        }
        if (imageUrls.length > 10) throw new Error('imageUrls max 10 items.');
        data.imageUrls = imageUrls;
    }

    if (description !== undefined) {
        if (description != null && String(description).length > 1000) throw new Error('description must be max 1000 chars.');
        data.description = description ? String(description) : null;
    }

    if (category !== undefined) {
        if (category != null && !VALID_CATEGORIES.has(category)) {
            throw new Error(`category must be one of: ${[...VALID_CATEGORIES].join(', ')}`);
        }
        data.category = category || null;
    }

    if (catalogSectionId !== undefined) data.catalogSectionId = catalogSectionId ? String(catalogSectionId) : null;
    if (locationId !== undefined) data.locationId = locationId ? String(locationId) : null;

    if (tags !== undefined) {
        if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) {
            throw new Error('tags must be an array of strings.');
        }
        if (tags.length > 30) throw new Error('tags max 30 items.');
        data.tags = tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 30);
    }

    for (const [key, value] of [['calorieCount', calorieCount], ['preparationMins', preparationMins]]) {
        if (value !== undefined) {
            if (value === null || value === '') data[key] = null;
            else {
                const number = Number(value);
                if (!Number.isInteger(number) || number < 0 || number > 100000) {
                    throw new Error(`${key} must be a non-negative integer.`);
                }
                data[key] = number;
            }
        }
    }

    const normalizedVariants = _cleanOptionRows(variants, 'variants', 30);
    if (normalizedVariants !== undefined) data.variants = normalizedVariants;

    const normalizedModifiers = _cleanModifierGroups(modifierGroups);
    if (normalizedModifiers !== undefined) data.modifierGroups = normalizedModifiers;

    if (deliveryTerms !== undefined) {
        if (deliveryTerms != null && String(deliveryTerms).length > 1000) throw new Error('deliveryTerms must be max 1000 chars.');
        data.deliveryTerms = deliveryTerms ? String(deliveryTerms) : null;
    }
    if (estimatedDelivery !== undefined) {
        if (estimatedDelivery != null && String(estimatedDelivery).length > 120) throw new Error('estimatedDelivery must be max 120 chars.');
        data.estimatedDelivery = estimatedDelivery ? String(estimatedDelivery) : null;
    }
    if (isAvailable !== undefined) data.isAvailable = !!isAvailable;

    return data;
};

const _resolveSection = async (prisma, businessProfileId, catalogSectionId) => {
    if (!catalogSectionId) return null;
    const section = await prisma.catalogSection.findUnique({
        where: { id: catalogSectionId },
        select: { id: true, businessProfileId: true },
    });
    return section && section.businessProfileId === businessProfileId ? section.id : null;
};

const _resolveLocation = async (prisma, businessProfileId, locationId) => {
    if (!locationId) return null;
    const location = await prisma.businessLocation.findUnique({
        where: { id: locationId },
        select: { id: true, businessProfileId: true },
    });
    return location && location.businessProfileId === businessProfileId ? location.id : null;
};

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

const createProduct = async (prisma, {
    businessProfileId, name, description, priceUsdc, imageUrls, category,
    catalogSectionId, tags, calorieCount, preparationMins, variants,
    modifierGroups, locationId, deliveryTerms, estimatedDelivery, isAvailable,
}) => {
    if (!businessProfileId) throw new Error('businessProfileId is required.');

    const profile = await prisma.businessProfile.findUnique({
        where: { id: businessProfileId },
        select: { id: true, businessName: true },
    });
    if (!profile) throw new Error('Business profile not found.');

    const data = _validateFields(
        {
            name, description, priceUsdc, imageUrls, category, catalogSectionId,
            tags, calorieCount, preparationMins, variants, modifierGroups,
            locationId, deliveryTerms, estimatedDelivery, isAvailable,
        },
        { partial: false },
    );
    const slug = await _generateSlug(prisma, profile.businessName, data.name);

    const resolvedSectionId = await _resolveSection(prisma, businessProfileId, data.catalogSectionId);
    const resolvedLocationId = await _resolveLocation(prisma, businessProfileId, data.locationId);

    return prisma.businessProduct.create({
        data: {
            businessProfileId,
            name: data.name,
            description: data.description ?? null,
            priceUsdc: data.priceUsdc,
            imageUrls: data.imageUrls ?? [],
            category: data.category ?? null,
            slug,
            catalogSectionId: resolvedSectionId,
            tags: data.tags ?? [],
            calorieCount: data.calorieCount ?? null,
            preparationMins: data.preparationMins ?? null,
            variants: data.variants ?? [],
            modifierGroups: data.modifierGroups ?? [],
            locationId: resolvedLocationId,
            deliveryTerms: data.deliveryTerms ?? null,
            estimatedDelivery: data.estimatedDelivery ?? null,
            isAvailable: data.isAvailable !== false,
        },
    });
};

const updateProduct = async (prisma, { productId, businessProfileId, updates }) => {
    if (!productId) throw new Error('productId is required.');

    const product = await prisma.businessProduct.findUnique({
        where: { id: productId },
        include: { businessProfile: { select: { businessName: true } } },
    });
    if (!product) throw new Error('Product not found.');
    if (product.businessProfileId !== businessProfileId) throw new Error('You do not own this product.');

    const filtered = {};
    for (const [key, value] of Object.entries(updates || {})) {
        if (UPDATABLE_FIELDS.has(key)) filtered[key] = value;
    }

    const data = _validateFields(filtered, { partial: true });

    if ('catalogSectionId' in data) data.catalogSectionId = await _resolveSection(prisma, businessProfileId, data.catalogSectionId);
    if ('locationId' in data) data.locationId = await _resolveLocation(prisma, businessProfileId, data.locationId);
    if ('isActive' in filtered) data.isActive = !!filtered.isActive;

    if (data.name && data.name !== product.name) {
        data.slug = await _generateSlug(prisma, product.businessProfile.businessName, data.name);
    }

    if (Object.keys(data).length === 0) throw new Error('No valid fields to update.');

    return prisma.businessProduct.update({ where: { id: productId }, data });
};

const listProducts = async (prisma, { businessProfileId, isActive, limit, cursor }) => {
    const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const where = { businessProfileId };
    if (typeof isActive === 'boolean') where.isActive = isActive;

    const rows = await prisma.businessProduct.findMany({
        where,
        take: take + 1,
        orderBy: { createdAt: 'desc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > take;
    const products = hasMore ? rows.slice(0, take) : rows;
    const nextCursor = hasMore ? products[products.length - 1].id : null;
    return { products, hasMore, nextCursor };
};

const getProduct = async (prisma, { productId, includeBusinessProfile }) =>
    prisma.businessProduct.findUnique({
        where: { id: productId },
        ...(includeBusinessProfile
            ? {
                include: {
                    businessProfile: {
                        select: { bizId: true, businessName: true, isVerified: true, kybStatus: true },
                    },
                },
            }
            : {}),
    });

const deleteProduct = async (prisma, { productId, businessProfileId }) => {
    if (!productId) throw new Error('productId is required.');

    const product = await prisma.businessProduct.findUnique({
        where: { id: productId },
        select: { id: true, businessProfileId: true },
    });
    if (!product) throw new Error('Product not found.');
    if (product.businessProfileId !== businessProfileId) throw new Error('You do not own this product.');

    const activeOrders = await prisma.businessOrder.count({
        where: { productId, status: { notIn: ['COMPLETED', 'REFUNDED', 'CANCELLED'] } },
    });
    if (activeOrders > 0) throw new Error('Cannot delete a product with active orders. Mark it inactive instead.');

    return prisma.businessProduct.update({ where: { id: productId }, data: { isActive: false } });
};

module.exports = {
    createProduct,
    updateProduct,
    listProducts,
    getProduct,
    deleteProduct,
};
