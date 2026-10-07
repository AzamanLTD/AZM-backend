const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { idempotency } = require('../middleware/idempotency');
const azmGiftController = require('../controllers/azmGiftController');

const protect = authMiddleware.protect;

// §r42.1 wired: the claim commits INSIDE the gift transfer $transaction, so
// an IN_PROGRESS claim after a 4xx is durable proof of rollback — the key
// is safely releasable (releaseOn4xx). 5xx stays RETAIN (default): a
// post-commit failure must never re-arm a committed transfer.
router.post('/send',     protect, idempotency({ releaseOn4xx: true }), azmGiftController.sendGift);
router.get('/received',  protect, azmGiftController.getReceivedGifts);
router.get('/sent',      protect, azmGiftController.getSentGifts);
router.get('/stats',     protect, azmGiftController.getGiftStats);

module.exports = router;
