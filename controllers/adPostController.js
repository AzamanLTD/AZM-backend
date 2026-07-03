const { createAdPost, removeAdPost, getActiveAds, getFeedAds } = require('../services/businessAdService');
const { kybGate } = require('../middleware/kybGateMiddleware');

exports.create = async (req, res) => {
    try {
        const result = await createAdPost(req.prisma, {
            businessProfileId: req.body.businessProfileId,
            userId: req.user.id,
            templateType: req.body.templateType,
            title: req.body.title,
            bodyText: req.body.bodyText,
            mediaUrl: req.body.mediaUrl,
            ctaLabel: req.body.ctaLabel,
            ctaTarget: req.body.ctaTarget,
            durationHours: req.body.durationHours,
        });
        res.status(201).json(result);
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.remove = async (req, res) => {
    try {
        const result = await removeAdPost(req.prisma, {
            adPostId: req.params.id, userId: req.user.id
        });
        res.json(result);
    } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

exports.active = async (req, res) => {
    try {
        const ads = await getActiveAds(req.prisma, {
            businessProfileId: req.params.businessProfileId,
            limit: req.query.limit
        });
        res.json({ success: true, ads });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

exports.feed = async (req, res) => {
    try {
        const result = await getFeedAds(req.prisma, {
            customerId: req.user.id,
            limit: req.query.limit,
            offset: req.query.offset
        });
        res.json({ success: true, ...result });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};
