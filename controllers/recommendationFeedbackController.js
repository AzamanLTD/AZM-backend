// controllers/recommendationFeedbackController.js
// "Show less like this" (Backend D). Owner-scoped: userId always comes from
// req.user (protect); feedback is private to the caller.
const RecommendationFeedbackService = require('../services/marketplace/recommendationFeedbackService');

exports.applyShowLess = async (req, res) => {
    try {
        const svc = new RecommendationFeedbackService(req.prisma);
        const { alreadyApplied, appliedAt } = await svc.applyShowLess(
            req.user.id, req.body.businessProfileId);
        res.status(alreadyApplied ? 200 : 201).json({
            success: true, state: 'SHOW_LESS', alreadyApplied, appliedAt,
        });
    } catch (err) {
        res.status(err.status || 500).json({
            success: false, code: err.code || 'INTERNAL_ERROR', message: err.message });
    }
};

exports.undoShowLess = async (req, res) => {
    try {
        const svc = new RecommendationFeedbackService(req.prisma);
        const { removed } = await svc.undoShowLess(
            req.user.id, req.params.businessProfileId);
        res.json({ success: true, state: 'NONE', removed });
    } catch (err) {
        res.status(err.status || 500).json({
            success: false, code: err.code || 'INTERNAL_ERROR', message: err.message });
    }
};

exports.checkSuppressed = async (req, res) => {
    try {
        const svc = new RecommendationFeedbackService(req.prisma);
        const applied = await svc.isSuppressed(req.user.id, req.params.businessProfileId);
        res.json({ success: true, applied });
    } catch (err) {
        res.status(err.status || 500).json({
            success: false, code: err.code || 'INTERNAL_ERROR', message: err.message });
    }
};

exports.mySuppressed = async (req, res) => {
    try {
        const svc = new RecommendationFeedbackService(req.prisma);
        const { total, suppressed } = await svc.listSuppressed(req.user.id, {
            limit: req.query.limit, offset: req.query.offset });
        res.json({ success: true, total, suppressed });
    } catch (err) {
        res.status(err.status || 500).json({
            success: false, code: err.code || 'INTERNAL_ERROR', message: err.message });
    }
};
