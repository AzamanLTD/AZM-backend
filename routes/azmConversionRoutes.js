const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const convController = require('../controllers/azmConversionController');

const protect = authMiddleware.protect;

// §r42.1 wired: the claim commits INSIDE the conversion $transaction, so an
// IN_PROGRESS claim after a 4xx is durable proof of rollback — the key is
// safely releasable (releaseOn4xx). 5xx stays RETAIN (default): a post-
// commit failure must never re-arm a completed redemption.
// AZM points are loyalty value, not cash. Converting them into withdrawable
// USDC (funded from SystemProfitFees) turns a non-cash reward into a monetary
// liability with no asset behind it, so the conversion is refused before any
// state is read or written. Re-enabling it is an owner policy decision that
// needs its own funding and liability model, not a flag.
function refuseAzmCashConversion(req, res) {
    return res.status(409).json({
        success: false,
        code: 'AZM_NOT_CASH',
        message: 'AZM points are rewards and cannot be converted into money. Nothing was changed.',
    });
}

router.post('/',        protect, refuseAzmCashConversion);
router.get('/rate',     protect, convController.getRate);
router.get('/history',  protect, convController.getConversionHistory);

module.exports = router;
module.exports.refuseAzmCashConversion = refuseAzmCashConversion;
