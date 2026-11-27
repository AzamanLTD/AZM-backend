// routes/smartRouteRoutes.js
const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/smartRouteController');
const { protect } = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const { requireKyc } = require('../middleware/requireKyc');
const { require2FA } = require('../middleware/require2FA');

// Smart Routes that move money AWAY from the user (a MoMo withdrawal, a
// transfer to someone else) carry the same identity and second-factor gates
// as the manual routes they automate: /api/withdraw/fiat and
// /api/friends/transfer/send. Without them a session alone could schedule,
// redirect, re-enable or fire a payout. Same-user moves (savings, vault) keep
// the session-only gate.
//
// The gate covers every call that can start or change such a payout: create,
// update (which can redirect the destination), resume (which re-arms the
// schedule) and run-now. Pause, cancel and delete only reduce money movement.
const MONEY_OUT_KYC_ACTION = Object.freeze({
    WITHDRAW_MOMO: 'withdraw',
    INTERNAL_TRANSFER: 'p2p',
});

async function smartRouteMoneyGate(req, res, next) {
    let action = req.body && req.body.action;
    if (req.params && req.params.id) {
        let route;
        try {
            route = await req.app.get('prisma').smartRoute.findUnique({
                where: { id: req.params.id },
                select: { userId: true, action: true },
            });
        } catch (err) {
            logger.error({ err }, '[smartRouteMoneyGate] route lookup failed');
            return res.status(503).json({ success: false, message: 'Smart Route check unavailable. Nothing was changed.' });
        }
        if (!route || route.userId !== req.user.id) {
            return res.status(404).json({ success: false, message: 'Route not found' });
        }
        action = route.action;
    }
    const kycAction = MONEY_OUT_KYC_ACTION[action];
    if (!kycAction) return next();
    return requireKyc(kycAction)(req, res, (err) => {
        if (err) return next(err);
        return require2FA()(req, res, next);
    });
}

router.post('/',           protectActive, smartRouteMoneyGate, ctrl.create);
router.get('/',            protect,       ctrl.list);
router.get('/:id',         protect,       ctrl.getDetail);
router.patch('/:id',       protectActive, smartRouteMoneyGate, ctrl.update);
router.post('/:id/pause',  protectActive, ctrl.pause);
router.post('/:id/resume', protectActive, smartRouteMoneyGate, ctrl.resume);
router.delete('/:id',      protectActive, ctrl.cancel);
router.post('/:id/run-now',protectActive, smartRouteMoneyGate, ctrl.runNow);

module.exports = router;
module.exports.smartRouteMoneyGate = smartRouteMoneyGate;
module.exports.MONEY_OUT_KYC_ACTION = MONEY_OUT_KYC_ACTION;
