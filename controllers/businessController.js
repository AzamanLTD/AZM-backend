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
            phoneNumber, contactEmail, address, country, logoUrl, coverPhotoUrl
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
            description, website, logoUrl, coverPhotoUrl,
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
        const { q, category, verified, limit, cursor, subcategory, priceRange, minRating, sort } = req.query;
        const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

        const rows = await businessService.searchBusinesses(prisma, {
            query: q ? String(q).trim() : null,
            category: category || null,
            verified: verified === 'true',
            limit: take,
            cursor: cursor || null,
            subcategory: subcategory || null,
            priceRange: priceRange || null,
            minRating: minRating || null,
            sort: sort || null
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

// =============================================================================
// 6. GET /api/business/subcategories?parentWire=FOOD_BEVERAGE
// Public — returns the marketplace category hierarchy for drill-down UI.
// =============================================================================
exports.getSubcategories = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { parentWire } = req.query;
        const subcategories = await businessService.getSubcategories(prisma, {
            parentWire: parentWire || null
        });
        return res.status(200).json({ success: true, subcategories });
    } catch (err) {
        console.error('[getSubcategories] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// =============================================================================
// B-13: TRANSIT VEHICLE MANAGEMENT
// =============================================================================

// GET /api/business/vehicles — list the business owner's fleet
exports.listVehicles = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const profile = await prisma.businessProfile.findUnique({
            where: { userId: req.user.id },
            select: { id: true }
        });
        if (!profile) return res.status(404).json({ success: false, message: 'No business profile.' });

        const vehicles = await prisma.transitVehicle.findMany({
            where: { businessProfileId: profile.id },
            orderBy: { createdAt: 'desc' }
        });

        return res.status(200).json({ success: true, vehicles });
    } catch (err) {
        console.error('[listVehicles] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// POST /api/business/vehicles — add a vehicle to the fleet
exports.createVehicle = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const profile = await prisma.businessProfile.findUnique({
            where: { userId: req.user.id },
            select: { id: true, isSuspended: true }
        });
        if (!profile) return res.status(404).json({ success: false, message: 'No business profile.' });
        if (profile.isSuspended) return res.status(403).json({ success: false, message: 'Business is suspended.' });

        const { type, make, model, year, color, licensePlate, capacity, imageUrl, driverName, driverPhone, driverPhotoUrl, metadata } = req.body;

        if (!type) return res.status(400).json({ success: false, message: 'type is required (CAR, VAN, TRUCK, MOTORCYCLE, BICYCLE, SCOOTER).' });

        const vehicle = await prisma.transitVehicle.create({
            data: {
                businessProfileId: profile.id,
                type: String(type).toUpperCase(),
                make: make || null,
                model: model || null,
                year: year ? parseInt(year, 10) : null,
                color: color || null,
                licensePlate: licensePlate || null,
                capacity: typeof capacity === 'number' ? capacity : 4,
                imageUrl: imageUrl || null,
                isActive: true,
                driverName: driverName || null,
                driverPhone: driverPhone || null,
                driverPhotoUrl: driverPhotoUrl || null,
                metadata: metadata || null
            }
        });

        return res.status(201).json({ success: true, vehicle });
    } catch (err) {
        console.error('[createVehicle] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// PATCH /api/business/vehicles/:vehicleId — update vehicle details
exports.updateVehicle = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const profile = await prisma.businessProfile.findUnique({
            where: { userId: req.user.id },
            select: { id: true }
        });
        if (!profile) return res.status(404).json({ success: false, message: 'No business profile.' });

        const { vehicleId } = req.params;
        const existing = await prisma.transitVehicle.findUnique({
            where: { id: vehicleId },
            select: { id: true, businessProfileId: true }
        });
        if (!existing || existing.businessProfileId !== profile.id) {
            return res.status(404).json({ success: false, message: 'Vehicle not found.' });
        }

        const { type, make, model, year, color, licensePlate, capacity, imageUrl, isActive, driverName, driverPhone, driverPhotoUrl, metadata } = req.body;

        const data = {};
        if (type !== undefined) data.type = String(type).toUpperCase();
        if (make !== undefined) data.make = make;
        if (model !== undefined) data.model = model;
        if (year !== undefined) data.year = parseInt(year, 10);
        if (color !== undefined) data.color = color;
        if (licensePlate !== undefined) data.licensePlate = licensePlate;
        if (capacity !== undefined) data.capacity = capacity;
        if (imageUrl !== undefined) data.imageUrl = imageUrl;
        if (isActive !== undefined) data.isActive = isActive;
        if (driverName !== undefined) data.driverName = driverName;
        if (driverPhone !== undefined) data.driverPhone = driverPhone;
        if (driverPhotoUrl !== undefined) data.driverPhotoUrl = driverPhotoUrl;
        if (metadata !== undefined) data.metadata = metadata;

        const vehicle = await prisma.transitVehicle.update({
            where: { id: vehicleId },
            data
        });

        return res.status(200).json({ success: true, vehicle });
    } catch (err) {
        console.error('[updateVehicle] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// DELETE /api/business/vehicles/:vehicleId — remove a vehicle from the fleet
exports.deleteVehicle = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const profile = await prisma.businessProfile.findUnique({
            where: { userId: req.user.id },
            select: { id: true }
        });
        if (!profile) return res.status(404).json({ success: false, message: 'No business profile.' });

        const { vehicleId } = req.params;
        const existing = await prisma.transitVehicle.findUnique({
            where: { id: vehicleId },
            select: { id: true, businessProfileId: true }
        });
        if (!existing || existing.businessProfileId !== profile.id) {
            return res.status(404).json({ success: false, message: 'Vehicle not found.' });
        }

        await prisma.transitVehicle.update({
            where: { id: vehicleId },
            data: { isActive: false }
        });

        return res.status(200).json({ success: true, message: 'Vehicle deactivated.' });
    } catch (err) {
        console.error('[deleteVehicle] error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};
