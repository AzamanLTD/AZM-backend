// controllers/adminFeeLabController.js
// =============================================================================
// Admin Fee Lab (services/feeLabService.js):
//   GET  /api/admin/fee-lab?period=30d     catalog, live values, booked revenue,
//                                          volumes                 (fees.manage)
//   GET  /api/admin/fee-lab/history        recent publishes        (fees.manage)
//   POST /api/admin/fee-lab/publish        { changes, reason } + second factor
//                                                                  (fees.manage)
// =============================================================================

const logger = require('../src/config/logger');
const feeLab = require('../services/feeLabService');

const _prisma = (req) => req.app.get('prisma');

const _refuse = (res, err) => res.status(err.httpStatus || 400).json({
    success: false, code: err.code, message: err.message, ...(err.detail !== undefined ? { detail: err.detail } : {}),
});

exports.getOverview = async (req, res) => {
    try {
        const data = await feeLab.getOverview(_prisma(req), { period: req.query.period || '30d' });
        return res.status(200).json({ success: true, data });
    } catch (err) {
        if (err instanceof feeLab.FeeLabError) return _refuse(res, err);
        logger.error({ err: err && err.message }, '[feeLab] overview failed');
        return res.status(500).json({ success: false, code: 'FEE_LAB_UNAVAILABLE', message: 'The Fee Lab could not load. Try again.' });
    }
};

exports.getHistory = async (req, res) => {
    try {
        const data = await feeLab.history(_prisma(req), { limit: req.query.limit });
        return res.status(200).json({ success: true, data });
    } catch (err) {
        logger.error({ err: err && err.message }, '[feeLab] history failed');
        return res.status(500).json({ success: false, code: 'FEE_LAB_UNAVAILABLE', message: 'Publish history could not load.' });
    }
};

// Runs before require2FA: a request that would be refused anyway is refused
// without spending the admin's code.
exports.precheckPublish = (req, res, next) => {
    try {
        feeLab.precheck(req.body || {});
        return next();
    } catch (err) {
        if (err instanceof feeLab.FeeLabError) return _refuse(res, err);
        return next(err);
    }
};

exports.publish = async (req, res) => {
    try {
        const { changes, reason } = req.body || {};
        const data = await feeLab.publish(_prisma(req), {
            changes,
            reason,
            adminId: req.user && req.user.id,
            adminName: (req.user && req.user.username) || null,
            ipAddress: req.ip || null,
        });
        return res.status(200).json({ success: true, data });
    } catch (err) {
        if (err instanceof feeLab.FeeLabError) return _refuse(res, err);
        // The transaction may or may not have committed: never claim either.
        logger.error({ err: err && err.message }, '[feeLab] publish failed');
        return res.status(500).json({
            success: false,
            code: 'FEE_LAB_PUBLISH_UNCONFIRMED',
            message: 'The publish could not be confirmed. Reload the Fee Lab and check the live values and history before trying again.',
        });
    }
};
