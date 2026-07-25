const logger = require('../src/config/logger');
const showcaseService = require('../services/businessShowcaseService');

exports.add = async (req, res) => {
    try {
        const item = await showcaseService.addShowcaseMedia(req.prisma, {
            businessProfileId: req.body.businessProfileId,
            userId: req.user.id,
            mediaUrl: req.body.mediaUrl,
            mediaType: req.body.mediaType,
            thumbnailUrl: req.body.thumbnailUrl,
            caption: req.body.caption,
        });
        res.status(201).json({ success: true, item });
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.list = async (req, res) => {
    try {
        const items = await showcaseService.getShowcase(req.prisma, req.params.businessProfileId);
        res.json({ success: true, items });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.update = async (req, res) => {
    try {
        const item = await showcaseService.updateShowcaseItem(req.prisma, {
            showcaseId: req.params.id,
            userId: req.user.id,
            caption: req.body.caption,
            displayOrder: req.body.displayOrder,
            isActive: req.body.isActive,
        });
        res.json({ success: true, item });
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.delete = async (req, res) => {
    try {
        const result = await showcaseService.deleteShowcaseItem(req.prisma, {
            showcaseId: req.params.id, userId: req.user.id
        });
        res.json(result);
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.reorder = async (req, res) => {
    try {
        const result = await showcaseService.reorderShowcase(req.prisma, {
            userId: req.user.id,
            orderedIds: req.body.orderedIds,
        });
        res.json(result);
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

// ── Storefront Version History ──────────────────────────────────────────────

exports.publishVersion = async (req, res) => {
    try {
        const { businessProfileId } = req.params;
        const { label } = req.body;

        // Snapshot all current active showcase slides
        const slides = await req.prisma.businessShowcase.findMany({
            where: { businessProfileId, isActive: true },
            orderBy: { displayOrder: 'asc' },
        });

        if (slides.length === 0) {
            return res.status(400).json({ success: false, message: 'No active slides to publish' });
        }

        const snapshot = slides.map(s => ({
            mediaUrl: s.mediaUrl,
            mediaType: s.mediaType,
            thumbnailUrl: s.thumbnailUrl,
            caption: s.caption,
            displayOrder: s.displayOrder,
            isActive: s.isActive,
        }));

        const version = await req.prisma.storefrontVersion.create({
            data: {
                businessProfileId,
                snapshot,
                label: label || null,
                publishedBy: req.user.id,
            },
        });

        res.status(201).json({ success: true, version });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.listVersions = async (req, res) => {
    try {
        const { businessProfileId } = req.params;
        const versions = await req.prisma.storefrontVersion.findMany({
            where: { businessProfileId },
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: {
                id: true,
                label: true,
                publishedBy: true,
                createdAt: true,
                _count: { select: {} },
            },
        });

        // Get slide count for each version from the snapshot
        const fullVersions = await req.prisma.storefrontVersion.findMany({
            where: { businessProfileId },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });

        const result = fullVersions.map(v => ({
            id: v.id,
            label: v.label,
            publishedBy: v.publishedBy,
            createdAt: v.createdAt,
            slideCount: Array.isArray(v.snapshot) ? v.snapshot.length : 0,
        }));

        res.json({ success: true, versions: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.revertToVersion = async (req, res) => {
    try {
        const { businessProfileId, versionId } = req.params;

        const version = await req.prisma.storefrontVersion.findFirst({
            where: { id: versionId, businessProfileId },
        });

        if (!version) {
            return res.status(404).json({ success: false, message: 'Version not found' });
        }

        const snapshot = Array.isArray(version.snapshot) ? version.snapshot : [];

        // Delete all current slides for this business
        await req.prisma.businessShowcase.deleteMany({ where: { businessProfileId } });

        // Recreate slides from the snapshot
        if (snapshot.length > 0) {
            await req.prisma.businessShowcase.createMany({
                data: snapshot.map(s => ({
                    businessProfileId,
                    mediaUrl: s.mediaUrl,
                    mediaType: s.mediaType || 'IMAGE',
                    thumbnailUrl: s.thumbnailUrl || null,
                    caption: s.caption || null,
                    displayOrder: s.displayOrder || 0,
                    isActive: s.isActive !== undefined ? s.isActive : true,
                })),
            });
        }

        // Create a new version entry for this revert action
        await req.prisma.storefrontVersion.create({
            data: {
                businessProfileId,
                snapshot,
                label: `Reverted to ${new Date(version.createdAt).toLocaleString()}`,
                publishedBy: req.user.id,
            },
        });

        res.json({ success: true, message: 'Storefront reverted successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
