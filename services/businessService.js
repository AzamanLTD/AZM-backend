// services/businessService.js
// =============================================================================
// AZAMAN — Business Accounts Service (2026-06-14)
//
// Pure I/O service. Manages BusinessProfile registration, lookup, search, and
// updates. Registration mints a searchable BIZ-XXXXXXXXX id. There is NO role
// flip — business ownership is determined purely by the existence of a
// BusinessProfile record, so a user can be both a regular user and an owner.
// =============================================================================

const VALID_CATEGORIES = new Set([
    'FREELANCE_SERVICES', 'RETAIL', 'FOOD_BEVERAGE', 'TECHNOLOGY', 'REAL_ESTATE',
    'EDUCATION', 'HEALTH_WELLNESS', 'ENTERTAINMENT', 'LOGISTICS',
    'FINANCIAL_SERVICES', 'OTHER', 'HOSPITALITY' // Workstream D: Prisma-enum parity (see businessSchemas.js note)
]);

// Fields a business owner may self-edit after registration.
const UPDATABLE_FIELDS = new Set([
    'businessName', 'description', 'website', 'logoUrl', 'phoneNumber',
    'contactEmail', 'address', 'country', 'category', 'coverPhotoUrl',
    'adAccentColor', 'offerEscrowProtection', 'offeredCategories'
]);

// WORKSTREAM D — maximum ADDITIONAL offerings a profile may declare. The
// marketplace card renders a handful of icons; 8 is a hard, truthful cap.
const MAX_OFFERED_CATEGORIES = 8;

// Ad appearance customization (2026-07-06): must be a 6-digit hex color
// with leading '#', or null/empty string to clear the override and fall
// back to the category-default tint.
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/** Generate a BIZ-XXXXXXXXX id (literal prefix + 9 digits). */
const _generateBizId = () =>
    'BIZ-' + String(Math.floor(100000000 + Math.random() * 900000000));

/**
 * Retail payment-protection capability is stored inside the existing
 * businessMeta JSON so this additive feature does not require a destructive
 * schema migration. Only the explicit boolean at this namespaced location is
 * authoritative; all other businessMeta content is preserved.
 */
const _escrowProtectionAvailable = (profile) =>
    profile?.businessMeta?.escrowProtection?.enabled === true;

const _withEscrowProtectionCapability = (profile) => {
    if (!profile) return profile;
    return {
        ...profile,
        escrowProtectionAvailable: _escrowProtectionAvailable(profile)
    };
};

// =============================================================================
// 1. REGISTER BUSINESS — create the BusinessProfile (no role change).
// =============================================================================
const registerBusiness = async (prisma, {
    userId, businessName, category, description, website, logoUrl, coverPhotoUrl,
    phoneNumber, contactEmail, address, country, offeredCategories
}) => {
    if (!userId) throw new Error('userId is required.');

    // 1. If the user already owns a business profile, return it (idempotent).
    const existing = await prisma.businessProfile.findFirst({ where: { userId } });
    if (existing) {
        return { businessProfile: _withEscrowProtectionCapability(existing), bizId: existing.bizId, alreadyRegistered: true };
    }

    const cleanName = String(businessName || '').trim();
    if (cleanName.length < 2 || cleanName.length > 100) {
        throw new Error('businessName must be 2–100 chars.');
    }
    const cat = category && VALID_CATEGORIES.has(category) ? category : 'OTHER';

    // 2. Generate a unique bizId, retrying on collision up to 3 times.
    let bizId = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        const candidate = _generateBizId();
        const clash = await prisma.businessProfile.findUnique({ where: { bizId: candidate } });
        if (!clash) { bizId = candidate; break; }
    }
    if (!bizId) throw new Error('Could not generate a unique business ID. Please retry.');

    // 3. Create the BusinessProfile. No role flip — business ownership is
    //    determined solely by the existence of this record.
    // WORKSTREAM D — explicitly declared additional offerings at
    // registration (canonical enum, deduped; Zod already 400s unknowns).
    const offered = Array.isArray(offeredCategories)
        ? offeredCategories.filter((c) => VALID_CATEGORIES.has(c))
        : [];
    const businessProfile = await prisma.businessProfile.create({
        data: {
            userId,
            bizId,
            businessName: cleanName,
            category: cat,
            offeredCategories: [...new Set(offered)],
            description: description ? String(description).slice(0, 500) : null,
            website: website ? String(website).slice(0, 255) : null,
            logoUrl: logoUrl || null,
            coverPhotoUrl: coverPhotoUrl || null,
            phoneNumber: phoneNumber ? String(phoneNumber).slice(0, 20) : null,
            contactEmail: contactEmail ? String(contactEmail).slice(0, 100) : null,
            address: address ? String(address).slice(0, 255) : null,
            country: country ? String(country).slice(0, 2) : null
        }
    });

    return { businessProfile: _withEscrowProtectionCapability(businessProfile), bizId };
};

// =============================================================================
// 2. GET BUSINESS PROFILE — by bizId OR userId.
// =============================================================================
const getBusinessProfile = async (prisma, { bizId, userId }) => {
    if (!bizId && !userId) throw new Error('Either bizId or userId is required.');
    const profile = await prisma.businessProfile.findFirst({
        where: bizId ? { bizId } : { userId },
        include: {
            user: {
                select: {
                    id: true, username: true, profilePictureUrl: true,
                    azamanId: true, kycStatus: true
                }
            }
        }
    });
    return _withEscrowProtectionCapability(profile);
};

// =============================================================================
// 3. SEARCH BUSINESSES — name / bizId / description, optional filters.
// =============================================================================
const searchBusinesses = async (prisma, { query, category, verified, limit, cursor, subcategory, priceRange, minRating, sort }) => {
    const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

    // Names that must never appear in the public marketplace feed (test/seed accounts).
    const EXCLUDED_NAMES = ['test portal biz', 'azaman', 'test chop bar', 'az-qa transit test co'];
    const where = {
        isSuspended: false, // CRITICAL: never show suspended businesses publicly
        isPausedByOwner: false, // owner-paused businesses are not discoverable (order/booking attempts are refused; search must not surface them either)
        NOT: {
            businessName: {
                in: EXCLUDED_NAMES,
                mode: 'insensitive',
            },
        },
    };
    if (query) {
        where.OR = [
            { businessName: { contains: query, mode: 'insensitive' } },
            { bizId: { contains: query, mode: 'insensitive' } },
            { description: { contains: query, mode: 'insensitive' } }
        ];
    }
    if (category && VALID_CATEGORIES.has(category)) where.category = category;
    // Marketplace hierarchy drill-down (2026-06-24) — additive filters.
    if (subcategory) where.subcategory = subcategory;
    if (priceRange) {
        const pr = parseInt(priceRange, 10);
        if (!isNaN(pr)) where.priceRange = pr;
    }
    if (verified === true) where.isVerified = true;
    // averageRating is a Decimal; Prisma handles gte comparison.
    if (minRating && !isNaN(parseFloat(minRating))) {
        where.averageRating = { gte: parseFloat(minRating) };
    }

    const useTrending = sort === 'trending';
    const rows = await prisma.businessProfile.findMany({
        where,
        take: take + 1,
        orderBy: useTrending ? { averageRating: 'desc' } : { totalEscrows: 'desc' },
        include: {
            user: { select: { id: true, username: true, profilePictureUrl: true } }
        },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });

    if (useTrending) {
        const logger = require('../src/config/logger');
        const { discoveryScore } = require('../utils/ranking');
        rows.sort((a, b) => discoveryScore(b) - discoveryScore(a));
    }

    // B-12: attach min product price from BusinessProduct
    if (rows.length > 0) {
        const bizIds = rows.map((r) => r.id);
        const products = await prisma.businessProduct.groupBy({
            by: ['businessProfileId'],
            where: { businessProfileId: { in: bizIds }, isActive: true },
            _min: { priceUsdc: true },
        });
        const priceMap = {};
        for (const p of products) {
            priceMap[p.businessProfileId] = p._min.priceUsdc;
        }
        for (const row of rows) {
            row.minProductPrice = priceMap[row.id] ?? null;
        }
    }

    return rows.map(_withEscrowProtectionCapability);
};

// =============================================================================
// GET SUBCATEGORIES — public lookup for the category drill-down UI.
// Returns all active subcategories for a given parentWire, or all if omitted.
// =============================================================================
const getSubcategories = async (prisma, { parentWire } = {}) => {
    const where = { isActive: true };
    if (parentWire) where.parentWire = parentWire;
    return prisma.businessSubcategory.findMany({
        where,
        orderBy: [{ parentWire: 'asc' }, { displayOrder: 'asc' }]
    });
};

// =============================================================================
// 4. UPDATE BUSINESS PROFILE — owner-only, whitelisted fields.
// =============================================================================
const updateBusinessProfile = async (prisma, { userId, updates }) => {
    const profile = await prisma.businessProfile.findFirst({ where: { userId } });
    if (!profile) throw new Error('No business profile found for this user.');

    const data = {};
    for (const [key, value] of Object.entries(updates || {})) {
        if (!UPDATABLE_FIELDS.has(key)) continue;
        if (key === 'category') {
            if (VALID_CATEGORIES.has(value)) data.category = value;
            continue;
        }
        if (key === 'businessName') {
            const clean = String(value || '').trim();
            if (clean.length < 2 || clean.length > 100) {
                throw new Error('businessName must be 2–100 chars.');
            }
            data.businessName = clean;
            continue;
        }
        if (key === 'adAccentColor') {
            if (value === null || value === '') {
                data.adAccentColor = null; // explicit clear -> revert to category tint
                continue;
            }
            if (!HEX_COLOR_RE.test(value)) {
                throw new Error('adAccentColor must be a 6-digit hex color like "#FFAA00".');
            }
            data.adAccentColor = value;
            continue;
        }
        if (key === 'offeredCategories') {
            // Canonical-enum validated, deduped, capped. Unknown categories
            // 400 (this field is OUR contract — nothing silently dropped).
            // An empty array clears the offerings; that is a valid state.
            if (!Array.isArray(value)) {
                throw new Error('offeredCategories must be an array of category names.');
            }
            if (value.length > MAX_OFFERED_CATEGORIES) {
                throw new Error(`offeredCategories must contain at most ${MAX_OFFERED_CATEGORIES} categories.`);
            }
            const deduped = [];
            for (const entry of value) {
                if (!VALID_CATEGORIES.has(entry)) {
                    throw new Error(`offeredCategories contains an unknown category: ${entry}`);
                }
                if (!deduped.includes(entry)) deduped.push(entry);
            }
            data.offeredCategories = deduped;
            continue;
        }
        if (key === 'offerEscrowProtection') {
            if (typeof value !== 'boolean') {
                throw new Error('offerEscrowProtection must be a boolean.');
            }
            const existingMeta = profile.businessMeta && typeof profile.businessMeta === 'object'
                ? profile.businessMeta
                : {};
            data.businessMeta = {
                ...existingMeta,
                escrowProtection: {
                    ...(existingMeta.escrowProtection && typeof existingMeta.escrowProtection === 'object'
                        ? existingMeta.escrowProtection
                        : {}),
                    enabled: value
                }
            };
            continue;
        }
        data[key] = value;
    }

    if (Object.keys(data).length === 0) {
        throw new Error('No valid fields to update.');
    }

    // PRE-EXISTING DEFECT FIX (Workstream D, found by the first real-Postgres
    // proof of this path): `where: { userId }` was NEVER a valid Prisma unique
    // selector (userId is indexed, not unique), so every real PATCH /profile
    // call 500'd at client validation — the mock-prisma suites could not see
    // it. The profile row is already resolved above; target its primary key.
    const updated = await prisma.businessProfile.update({ where: { id: profile.id }, data });
    return _withEscrowProtectionCapability(updated);
};

module.exports = {
    registerBusiness,
    getBusinessProfile,
    searchBusinesses,
    getSubcategories,
    updateBusinessProfile,
    VALID_CATEGORIES
};
