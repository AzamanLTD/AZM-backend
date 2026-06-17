// routes/businessRoutes.js
// =============================================================================
// AZAMAN — BUSINESS PORTAL ROUTES (2026-06-14, extended 2026-06-16)
// Mounted at /api/business.
//
// ORDERING IS CRITICAL in Express. Static paths must be declared BEFORE
// parameterised paths:
//   • orders/stats        BEFORE orders/:orderId
//   • kyb/* and products/* BEFORE /:bizId
//   • my-orders           BEFORE /:bizId
//   • /:bizId             MUST be last (it captures any single segment)
// =============================================================================

const router = require('express').Router();
const { protect }       = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');

const ctrl        = require('../controllers/businessController');
const productCtrl = require('../controllers/businessProductController');
const orderCtrl   = require('../controllers/businessOrderController');
const kybCtrl     = require('../controllers/businessKybController');
const notifCtrl   = require('../controllers/bizNotificationController');

// Existing business account routes (unchanged)
router.post('/register', protectActive, ctrl.registerBusiness);
router.get('/search', ctrl.searchBusinesses);                // public
router.get('/me', protect, ctrl.getMyBusiness);
router.patch('/profile', protect, ctrl.updateBusinessProfile);

// KYB routes (before /:bizId)
router.post('/kyb/submit',  protect, kybCtrl.submitKybDocuments);
router.get('/kyb/status',   protect, kybCtrl.getKybStatus);

// Product routes
router.get('/products',               protect, productCtrl.listMyProducts);
router.post('/products',              protect, productCtrl.createProduct);
router.get('/products/:productId',             productCtrl.getProduct);   // PUBLIC
router.patch('/products/:productId',  protect, productCtrl.updateProduct);
router.delete('/products/:productId', protect, productCtrl.deleteProduct);

// Order routes — stats BEFORE /:orderId
router.get('/orders/stats',                 protect, orderCtrl.getBusinessStats);
router.get('/orders',                       protect, orderCtrl.listBusinessOrders);
router.get('/orders/:orderId',              protect, orderCtrl.getOrder);
router.patch('/orders/:orderId/delivered',  protect, orderCtrl.markDelivered);

// Customer order history (any authenticated user)
router.get('/my-orders', protect, orderCtrl.listMyOrders);

// Notification feed (owner only) — static paths before /:bizId
router.get('/notifications',              protect, notifCtrl.getNotifications);
router.get('/notifications/unread-count', protect, notifCtrl.getUnreadCount);
router.post('/notifications/read-all',    protect, notifCtrl.markAllAsRead);
router.post('/notifications/read/:id',    protect, notifCtrl.markAsRead);

// Public business profile lookup — MUST be last
router.get('/:bizId', ctrl.getBusinessByBizId);

module.exports = router;
