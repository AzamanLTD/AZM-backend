const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/dineInController');

// Business-side
router.post('/tabs',                  protect, ctrl.openTab);
router.post('/tabs/:tabId/items',     protect, ctrl.addItem);
router.post('/tabs/:tabId/finalize',  protect, ctrl.finalizeTab);
router.get('/tabs',                   protect, ctrl.getOpenTabs);
router.post('/tabs/:tabId/default',   protect, ctrl.reportDefault);

// Customer-side
router.get('/tabs/:tabId',            protect, ctrl.getTab);
router.post('/tabs/:tabId/pay',       protect, ctrl.confirmAndPay);

module.exports = router;
