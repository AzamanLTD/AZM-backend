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
    'FINANCIAL_SERVICES', 'OTHER'
]);

// Fields a business owner may self-edit after registration.
const UPDATABLE_FIELDS = new Set([
    'businessName', 'description', 'website', 'logoUrl', 'phoneNumber',
    'contactEmail', 'address', 'country', 'category'
]);

/** Generate a BIZ-XXXXXXXXX id (literal prefix + 9 digits). */
const _generateBizId = () =>
    'BIZ-' + String(Math.floor(100000000 + Math.random() * 900000000));

// =============================================================================
// 1. REGISTER BUSINESS — create the BusinessProfile (no role change).
// =============================================================================
const registerBusiness = async (prisma, {
    userId, businessName, category, description, website, logoUrl,
    phoneNumber, contactEmail, address, country
}) => {
    if (!userId) throw new Error('userId is required.');

    // 1. If the user already owns a business profile, return it (idempotent).
    const existing = await prisma.businessProfile.findUnique({ where: { userId } });
    if (existing) {
        return { businessProfile: existing, bizId: existing.bizId, alreadyRegistered: true };
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
    const businessProfile = await prisma.businessProfile.create({
        data: {
            userId,
            bizId,
            businessName: cleanName,
            category: cat,
            description: description ? String(description).slice(0, 500) : null,
            website: website ? String(website).slice(0, 255) : null,
            logoUrl: logoUrl || null,
            phoneNumber: phoneNumber ? String(phoneNumber).slice(0, 20) : null,
            contactEmail: contactEmail ? String(contactEmail).slice(0, 100) : null,
            address: address ? String(address).slice(0, 255) : null,
            country: country ? String(country).slice(0, 2) : null
        }
    });

    return { businessProfile, bizId };
};

// =============================================================================
// 2. GET BUSINESS PROFILE — by bizId OR userId.
// =============================================================================
const getBusinessProfile = async (prisma, { bizId, userId }) => {
    if (!bizId && !userId) throw new Error('Either bizId or userId is required.');
    return prisma.businessProfile.findFirst({
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
};

// =============================================================================
// 3. SEARCH BUSINESSES — name / bizId / description, optional filters.
// =============================================================================
const searchBusinesses = async (prisma, { query, category, verified, limit, cursor }) => {
    const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

    const where = { isSuspended: false }; // CRITICAL: never show suspended businesses publicly
    if (query) {
        where.OR = [
            { businessName: { contains: query, mode: 'insensitive' } },
            { bizId: { contains: query, mode: 'insensitive' } },
            { description: { contains: query, mode: 'insensitive' } }
        ];
    }
    if (category && VALID_CATEGORIES.has(category)) where.category = category;
    if (verified === true) where.isVerified = true;

    return prisma.businessProfile.findMany({
        where,
        take: take + 1,
        orderBy: { totalEscrows: 'desc' },
        include: {
            user: { select: { id: true, username: true, profilePictureUrl: true } }
        },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
};

// =============================================================================
// 4. UPDATE BUSINESS PROFILE — owner-only, whitelisted fields.
// =============================================================================
const updateBusinessProfile = async (prisma, { userId, updates }) => {
    const profile = await prisma.businessProfile.findUnique({ where: { userId } });
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
        data[key] = value;
    }

    if (Object.keys(data).length === 0) {
        throw new Error('No valid fields to update.');
    }

    return prisma.businessProfile.update({ where: { userId }, data });
};

module.exports = {
    registerBusiness,
    getBusinessProfile,
    searchBusinesses,
    updateBusinessProfile,
    VALID_CATEGORIES
};
