const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/dineInController');
const { kybGate } = require('../middleware/kybGateMiddleware');
const { require2FA } = require('../middleware/require2FA');
const { requirePermission } = require('../middleware/requirePermission');

const dineInManage = requirePermission('restaurant.dinein.manage');

// Business-side. These operations mutate/read the business's dine-in surface and
// therefore require the canonical restaurant dine-in permission in addition to
// authentication and KYB status.
router.post('/tabs',                  protect, kybGate, dineInManage, ctrl.openTab);
router.post('/tabs/:tabId/items',     protect, kybGate, dineInManage, ctrl.addItem);
router.post('/tabs/:tabId/finalize',  protect, kybGate, dineInManage, ctrl.finalizeTab);
router.get('/tabs',                   protect, kybGate, dineInManage, ctrl.getOpenTabs);
router.post('/tabs/:tabId/default',   protect, kybGate, dineInManage, ctrl.reportDefault);

// Business guest lookup must also remain inside the business's dine-in
// permission boundary; otherwise any authenticated KYB business user could
// enumerate customers previously associated with a business.
router.get('/guests',                 protect, kybGate, dineInManage, ctrl.getGuests);
router.get('/guests/search',          protect, kybGate, dineInManage, ctrl.searchGuests);

// Customer-side. This deliberately uses a distinct path from the KYB-gated
// business item endpoint so a customer can never be granted business access
// merely by reaching the same URL.
router.post('/tabs/:tabId/customer-items', protect, ctrl.addCustomerItem);
router.get('/tabs/:tabId',                 protect, ctrl.getTab);
router.post('/tabs/:tabId/pay',            protect, require2FA(), ctrl.confirmAndPay);

module.exports = router;
