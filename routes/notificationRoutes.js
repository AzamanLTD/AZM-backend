const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware.js');
const notificationController = require('../controllers/notificationController');

const protect = authMiddleware.protect;
const adminOnly = authMiddleware.adminOnly;

router.get('/', protect, notificationController.getNotifications);
router.get('/unread-count', protect, notificationController.getUnreadCount);
router.patch('/:id/read', protect, notificationController.markAsRead);
router.patch('/read-all', protect, notificationController.markAllAsRead);

router.post('/trigger/trade-started', protect, adminOnly, notificationController.sendTradeStarted);
router.post('/trigger/dispute-updated', protect, adminOnly, notificationController.sendDisputeUpdated);
router.post('/trigger/deposit-success', protect, adminOnly, notificationController.sendDepositSuccess);
router.post('/trigger/ai-matic-warning', protect, adminOnly, notificationController.sendAiMaticLowWarning);

module.exports = router;
