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

// WORKSTREAM D — STRICT contract for the additional-offerings list.
//   • unknown categories are REJECTED (never silently filtered — this
//     field is OUR contract and a silent drop would mask a client bug);
//   • duplicate entries are deduped, first declaration order kept;
//   • the empty list is a valid state (no additional offerings);
//   • the PRIMARY category is never allowed inside the list: this field
//     means ADDITIONAL offerings, not a second place to repeat the
// Typed validation error for the register/update paths. Controllers use
// `err.statusCode` / `err.name` to map these DELIBERATELY to HTTP 400 — a
// plain message-regex classifier silently misses new validation messages
// (exactly how the primary/offering overlap error leaked out as a 500).
class ProfileValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ProfileValidationError';
        this.statusCode = 400;
    }
}

//     primary. The caller passes the FINAL intended primary category
//     once known (final-profile validation, not key-order validation).
function _validateOfferedCategories(value, primaryCategory) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        throw new ProfileValidationError('offeredCategories must be an array of category names.');
    }
    if (value.length > MAX_OFFERED_CATEGORIES) {
        throw new ProfileValidationError(`offeredCategories must contain at most ${MAX_OFFERED_CATEGORIES} categories.`);
    }
    const deduped = [];
    for (const entry of value) {
        if (!VALID_CATEGORIES.has(entry)) {
            throw new ProfileValidationError(`offeredCategories contains an unknown category: ${entry}`);
        }
        if (!deduped.includes(entry)) deduped.push(entry);
    }
    if (primaryCategory && deduped.includes(primaryCategory)) {
        throw new ProfileValidationError(
            `offeredCategories must not repeat the primary category (${primaryCategory}); it lists only ADDITIONAL offerings.`);
    }
    return deduped;
}

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
        throw new ProfileValidationError('businessName must be 2–100 chars.');
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
    // WORKSTREAM D — STRICT: unknown categories REJECT the whole
    // registration (never a silent drop); deduped; never repeats the
    // effective primary category; [] is a valid no-offerings state.
    const offered = _validateOfferedCategories(offeredCategories, cat);
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
const searchBusinesses = async (prisma, { query, category, verified, limit, cursor, subcategory, priceRange, minRating, sort, viewerId }) => {
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

    // Backend D — RANKING EFFECT: for an authenticated viewer, businesses
    // they suppressed with "Show less like this" are DEMOTED to the end of
    // the page (one batched query; relative order preserved in both
    // groups). Demotion only: the business is never removed, hidden or
    // altered — hard eligibility/suspension filters above still apply, and
    // the caller can still open the profile or follow/bookmark it freely.
    if (viewerId != null && rows.length > 0) {
        const RecommendationFeedbackService = require('./marketplace/recommendationFeedbackService');
        const svc = new RecommendationFeedbackService(prisma);
        const suppressed = await svc.getSuppressedIds(viewerId, rows.map(r => r.id));
        if (suppressed.size > 0) {
            const demoted = svc.demoteSuppressed(rows, suppressed);
            rows.length = 0;
            rows.push(...demoted);
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
    // CONCURRENCY CONTRACT (review pass on 46d0b5d): two concurrent PATCHes
    // can each read the OLD row, each pass the final-profile validation,
    // and each commit its own column — leaving the stored profile with
    // its primary category repeated in the offerings. The read, the
    // validation and the write now run inside ONE transaction with the
    // profile row locked FOR UPDATE: the second concurrent PATCH blocks
    // on the row lock and, when it wakes up, re-reads the freshly
    // committed state and validates against THAT. Whichever order the
    // two requests serialize in, the invariant holds on every commit.
    return prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw`
            SELECT id FROM "BusinessProfile"
            WHERE "userId" = ${userId}
            LIMIT 1
            FOR UPDATE`;
        if (!locked || locked.length === 0) {
            throw new ProfileValidationError('No business profile found for this user.');
        }
        const profile = await tx.businessProfile.findUnique({ where: { id: locked[0].id } });
        if (!profile) throw new ProfileValidationError('No business profile found for this user.');

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
                    throw new ProfileValidationError('businessName must be 2–100 chars.');
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
                    throw new ProfileValidationError('adAccentColor must be a 6-digit hex color like "#FFAA00".');
                }
                data.adAccentColor = value;
                continue;
            }
            if (key === 'offeredCategories') {
                // Canonical-enum validated, deduped, capped. Unknown categories
                // 400 (this field is OUR contract — nothing silently dropped).
                // An empty array clears the offerings; that is a valid state.
                // NOTE: the primary-duplicate rule is enforced AFTER the loop
                // against the FINAL intended category, so it holds even when
                // the same request also changes `category` (key-order-proof).
                data.offeredCategories = _validateOfferedCategories(value);
                continue;
            }
            if (key === 'offerEscrowProtection') {
                if (typeof value !== 'boolean') {
                    throw new ProfileValidationError('offerEscrowProtection must be a boolean.');
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
            throw new ProfileValidationError('No valid fields to update.');
        }

        // WORKSTREAM D — FINAL-PROFILE validation: the FINAL offered list must
        // not repeat the FINAL primary category — checked on EVERY PATCH, not
        // only when this request happens to submit offerings. A PATCH that
        // changes ONLY the primary category to a value already sitting in the
        // stored offerings must be rejected too, otherwise the update would
        // silently produce a profile whose own category is listed as an
        // "additional" offering. Deliberately AFTER the key loop so the check
        // is independent of JSON key order (category-then-offerings and
        // offerings-then-category behave identically). Omission preserves the
        // existing list; explicit null already resolved to [] above.
        const finalCategory = data.category ?? profile.category;
        const finalOfferings = data.offeredCategories !== undefined
            ? data.offeredCategories
            : (profile.offeredCategories || []);
        if (finalOfferings.includes(finalCategory)) {
            throw new ProfileValidationError(
                `offeredCategories must not repeat the primary category (${finalCategory}); it lists only ADDITIONAL offerings.`);
        }

        // PRE-EXISTING DEFECT FIX (Workstream D, found by the first real-Postgres
        // proof of this path): `where: { userId }` was NEVER a valid Prisma unique
        // selector (userId is indexed, not unique), so every real PATCH /profile
        // call 500'd at client validation — the mock-prisma suites could not see
        // it. The profile row is already resolved above; target its primary key.

        const updated = await tx.businessProfile.update({ where: { id: profile.id }, data });
        return _withEscrowProtectionCapability(updated);
    });
};

module.exports = {
    ProfileValidationError,
    registerBusiness,
    getBusinessProfile,
    searchBusinesses,
    getSubcategories,
    updateBusinessProfile,
    VALID_CATEGORIES
};
