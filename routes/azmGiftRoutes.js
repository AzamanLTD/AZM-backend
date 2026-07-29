const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { idempotency } = require('../middleware/idempotency');
const azmGiftController = require('../controllers/azmGiftController');

const protect = authMiddleware.protect;

router.post('/send',     protect, idempotency(), azmGiftController.sendGift);
router.get('/received',  protect, azmGiftController.getReceivedGifts);
router.get('/sent',      protect, azmGiftController.getSentGifts);
router.get('/stats',     protect, azmGiftController.getGiftStats);

module.exports = router;
