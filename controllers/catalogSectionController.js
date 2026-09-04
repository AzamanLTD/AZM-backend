// controllers/catalogSectionController.js
// CATALOG SECTIONS — Menu/product grouping (2026-06-24)
// Owner-facing: CRUD for their own catalog sections.
// Public-facing: GET sections + products for a business profile.

// ── Owner: create section ─────────────────────────────────────────────────────
/**
 * Resolve which BusinessProfile a write should target.
 * - Normal users: always their own profile (unchanged behavior/security).
 * - ADMIN role only: may pass an explicit `businessProfileId` in the body to
const logger = require('../src/config/logger');
 *   manage/seed another business's catalogue (oversight/support use, same
 *   trust tier as the existing admin suspend/KYB routes).
 */
async function _resolveTargetProfile(prisma, req) {
    if (req.user.role === 'ADMIN' && req.body.businessProfileId) {
        return prisma.businessProfile.findUnique({ where: { id: req.body.businessProfileId } });
    }
    return prisma.businessProfile.findFirst({ where: { userId: req.user.id } });
}

exports.createSection = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const profile = await _resolveTargetProfile(prisma, req);
        if (!profile) return res.status(404).json({ success: false, message: 'Business profile not found.' });

        const { name, description, displayOrder, availableFrom, availableTo, imageUrl, locationId } = req.body;
        if (!name || !String(name).trim())
            return res.status(400).json({ success: false, message: 'Section name is required.' });

        const section = await prisma.catalogSection.create({
            data: {
                businessProfileId: profile.id,
                name:              String(name).trim().slice(0, 100),
                description:       description ? String(description).trim().slice(0, 300) : null,
                displayOrder:      parseInt(displayOrder, 10) || 0,
                availableFrom:     availableFrom || null,
                availableTo:       availableTo   || null,
                imageUrl:          imageUrl      || null,
                locationId:        locationId    || null,
            },
        });
        return res.status(201).json({ success: true, section });
    } catch (err) {
        logger.error({ err: err }, '[createSection]');
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── Owner: list own sections ───────────────────────────────────────────────────
exports.listMySections = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const profile = await prisma.businessProfile.findFirst({ where: { userId: req.user.id } });
        if (!profile) return res.status(404).json({ success: false, message: 'Business profile not found.' });

        const sections = await prisma.catalogSection.findMany({
            where:   { businessProfileId: profile.id, isActive: true },
            orderBy: { displayOrder: 'asc' },
            include: {
                products: {
                    where:   { isActive: true, isAvailable: true },
                    orderBy: { totalOrders: 'desc' },
                },
            },
        });
        return res.status(200).json({ success: true, sections });
    } catch (err) {
        logger.error({ err: err }, '[listMySections]');
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── Owner: update section ─────────────────────────────────────────────────────
exports.updateSection = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const profile = await prisma.businessProfile.findFirst({ where: { userId: req.user.id } });
        if (!profile) return res.status(404).json({ success: false, message: 'Business profile not found.' });

        const { sectionId } = req.params;
        const existing = await prisma.catalogSection.findUnique({ where: { id: sectionId } });
        if (!existing || existing.businessProfileId !== profile.id)
            return res.status(404).json({ success: false, message: 'Section not found.' });

        const ALLOWED = ['name', 'description', 'displayOrder', 'availableFrom', 'availableTo', 'imageUrl', 'isActive'];
        const data = {};
        for (const [k, v] of Object.entries(req.body)) {
            if (ALLOWED.includes(k)) data[k] = v;
        }
        if (data.name) data.name = String(data.name).trim().slice(0, 100);

        const section = await prisma.catalogSection.update({ where: { id: sectionId }, data });
        return res.status(200).json({ success: true, section });
    } catch (err) {
        logger.error({ err: err }, '[updateSection]');
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── Owner: delete section (soft) ──────────────────────────────────────────────
exports.deleteSection = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const profile = await prisma.businessProfile.findFirst({ where: { userId: req.user.id } });
        if (!profile) return res.status(404).json({ success: false, message: 'Business profile not found.' });

        const { sectionId } = req.params;
        const existing = await prisma.catalogSection.findUnique({ where: { id: sectionId } });
        if (!existing || existing.businessProfileId !== profile.id)
            return res.status(404).json({ success: false, message: 'Section not found.' });

        // Soft-delete: unlink products from this section, then deactivate the section
        await prisma.$transaction([
            prisma.businessProduct.updateMany({
                where: { catalogSectionId: sectionId },
                data:  { catalogSectionId: null },
            }),
            prisma.catalogSection.update({
                where: { id: sectionId },
                data:  { isActive: false },
            }),
        ]);
        return res.status(200).json({ success: true, message: 'Section removed.' });
    } catch (err) {
        logger.error({ err: err }, '[deleteSection]');
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── Public: get sections + products for a business ───────────────────────────
exports.getPublicMenu = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { bizId } = req.params;
        const requestedLocationId = req.query?.locationId ? String(req.query.locationId).trim() : null;
        const profile = await prisma.businessProfile.findUnique({
            where:  { bizId },
            select: { id: true, isSuspended: true },
        });
        if (!profile || profile.isSuspended)
            return res.status(404).json({ success: false, message: 'Business not found.' });

        if (requestedLocationId) {
            const location = await prisma.businessLocation.findFirst({
                where: { id: requestedLocationId, businessProfileId: profile.id, isActive: true },
                select: { id: true, label: true },
            });
            if (!location) {
                return res.status(404).json({ success: false, message: 'Business location not found.' });
            }
        }

        const locationFilter = requestedLocationId
            ? { OR: [{ locationId: null }, { locationId: requestedLocationId }] }
            : {};

        const sections = await prisma.catalogSection.findMany({
            where:   { businessProfileId: profile.id, isActive: true, ...locationFilter },
            orderBy: { displayOrder: 'asc' },
            include: {
                products: {
                    where: { isActive: true, isAvailable: true, ...locationFilter },
                    // BusinessProduct has no displayOrder — sort by popularity
                    orderBy: { totalOrders: 'desc' },
                },
            },
        });

        // Products not assigned to any section
        const uncategorised = await prisma.businessProduct.findMany({
            where:   { businessProfileId: profile.id, isActive: true, isAvailable: true, catalogSectionId: null, ...locationFilter },
            orderBy: { totalOrders: 'desc' },
        });

        return res.status(200).json({
            success: true,
            locationId: requestedLocationId,
            sections,
            uncategorised,
        });
    } catch (err) {
        logger.error({ err: err }, '[getPublicMenu]');
        return res.status(500).json({ success: false, message: err.message });
    }
};