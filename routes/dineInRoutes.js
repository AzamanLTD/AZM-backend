const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/dineInController');
const { kybGate } = require('../middleware/kybGateMiddleware');
const { require2FA } = require('../middleware/require2FA');

// Business-side
router.post('/tabs',                  protect, kybGate, ctrl.openTab);
router.post('/tabs/:tabId/items',     protect, kybGate, ctrl.addItem);
router.post('/tabs/:tabId/finalize',  protect, kybGate, ctrl.finalizeTab);
router.get('/tabs',                   protect, kybGate, ctrl.getOpenTabs);
router.post('/tabs/:tabId/default',   protect, kybGate, ctrl.reportDefault);

// Guests
router.get('/guests',                 protect, kybGate, ctrl.getGuests);
router.get('/guests/search',          protect, kybGate, ctrl.searchGuests);

// Customer-side. This deliberately uses a distinct path from the KYB-gated
// business item endpoint so a customer can never be granted business access
// merely by reaching the same URL.
router.post('/tabs/:tabId/customer-items', protect, ctrl.addCustomerItem);
router.get('/tabs/:tabId',                 protect, ctrl.getTab);
router.post('/tabs/:tabId/pay',            protect, require2FA(), ctrl.confirmAndPay);

module.exports = router;
