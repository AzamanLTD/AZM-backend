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
