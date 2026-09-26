const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware.js');
const notificationController = require('../controllers/notificationController');

const protect = authMiddleware.protect;
const adminOnly = authMiddleware.adminOnly;

// C-7: rate limit notification endpoints (60 req/min per user)
const rateLimit = require('express-rate-limit');
const notifLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id?.toString() || 'anonymous',
    message: { success: false, message: 'Too many requests. Slow down.' },
});

router.get('/', protect, notifLimiter, notificationController.getNotifications);
router.get('/unread-count', protect, notificationController.getUnreadCount);
router.patch('/:id/read', protect, notifLimiter, notificationController.markAsRead);
router.patch('/read-all', protect, notifLimiter, notificationController.markAllAsRead);

router.post('/trigger/trade-started', protect, adminOnly, notificationController.sendTradeStarted);
router.post('/trigger/dispute-updated', protect, adminOnly, notificationController.sendDisputeUpdated);
router.post('/trigger/deposit-success', protect, adminOnly, notificationController.sendDepositSuccess);
router.post('/trigger/ai-matic-warning', protect, adminOnly, notificationController.sendAiMaticLowWarning);

module.exports = router;
