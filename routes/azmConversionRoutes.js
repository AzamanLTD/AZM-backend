const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { idempotency } = require('../middleware/idempotency');
const convController = require('../controllers/azmConversionController');

const protect = authMiddleware.protect;

// §r42.1 wired: the claim commits INSIDE the conversion $transaction, so an
// IN_PROGRESS claim after a 4xx is durable proof of rollback — the key is
// safely releasable (releaseOn4xx). 5xx stays RETAIN (default): a post-
// commit failure must never re-arm a completed redemption.
router.post('/',        protect, idempotency({ releaseOn4xx: true }), convController.convertAzmToUsdc);
router.get('/rate',     protect, convController.getRate);
router.get('/history',  protect, convController.getConversionHistory);

module.exports = router;
