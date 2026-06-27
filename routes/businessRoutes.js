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
const { validate }      = require('../middleware/validate');
const { businessRegisterSchema, businessUpdateSchema } = require('../services/validation/businessSchemas');

const ctrl        = require('../controllers/businessController');
const productCtrl = require('../controllers/businessProductController');
const orderCtrl   = require('../controllers/businessOrderController');
const kybCtrl     = require('../controllers/businessKybController');
const notifCtrl   = require('../controllers/bizNotificationController');
const locationCtrl = require('../controllers/businessLocationController');
const invoiceCtrl  = require('../controllers/businessInvoiceController');
const catalogCtrl  = require('../controllers/catalogSectionController');

// Business account routes. Zod validate() guards register/profile at the edge,
// mirroring withdrawalRoutes; controllers keep their fallback checks intact.
router.post('/register', protectActive, validate(businessRegisterSchema), ctrl.registerBusiness);
router.get('/subcategories', ctrl.getSubcategories);         // public — category hierarchy
router.get('/search', ctrl.searchBusinesses);                // public
router.get('/me', protect, ctrl.getMyBusiness);
router.patch('/profile', protect, validate(businessUpdateSchema), ctrl.updateBusinessProfile);

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

// =============================================================================
// DISCOVERY SPRINT (2026-06-20) — Locations, Tables, Invoices, Reviews
// All registered BEFORE the /:bizId catch-all below. Single-segment static
// paths (/locations, /invoices, /reviews, /customers/lookup, /search/nearby)
// MUST precede /:bizId or Express would match them as a bizId.
// =============================================================================

// ── LOCATION ROUTES ──────────────────────────────────────────────────────────
router.get('/search/nearby',                          locationCtrl.searchNearby);   // public
router.post('/locations',                  protect, protectActive, locationCtrl.createLocation);
router.get('/locations',                   protect,                locationCtrl.listMyLocations);
router.patch('/locations/:locationId',     protect, protectActive, locationCtrl.updateLocation);
router.delete('/locations/:locationId',    protect, protectActive, locationCtrl.deleteLocation);
router.post('/locations/:locationId/tables', protect, protectActive, locationCtrl.createTable);
router.get('/locations/:locationId/tables',  protect,              locationCtrl.listTables);
router.delete('/tables/:tableId',          protect, protectActive, locationCtrl.deleteTable);
router.get('/:bizId/locations',                       locationCtrl.getPublicLocations); // public
router.get('/:bizId/products',                        productCtrl.listProductsByBizId); // public

// ── INVOICE ROUTES ────────────────────────────────────────────────────────────
router.get('/customers/lookup',            protect,                invoiceCtrl.lookupCustomer);
router.post('/invoices',                   protect, protectActive, invoiceCtrl.createInvoice);
router.get('/invoices',                    protect,                invoiceCtrl.listInvoices);
router.get('/invoices/:invoiceId',         protect,                invoiceCtrl.getInvoice);
router.post('/invoices/:invoiceId/send',   protect, protectActive, invoiceCtrl.sendInvoice);
router.post('/invoices/:invoiceId/void',   protect, protectActive, invoiceCtrl.voidInvoice);
router.post('/invoices/:invoiceId/pay',    protect, protectActive, invoiceCtrl.payInvoice);

// ── REVIEW ROUTES ─────────────────────────────────────────────────────────────
router.post('/reviews',                    protect, protectActive, invoiceCtrl.createReview);
router.get('/:bizId/reviews',                         invoiceCtrl.listReviews);      // public

// ── CATALOG SECTION ROUTES (2026-06-24) ───────────────────────────────────────
// Static /catalog/* paths and the two-segment /:bizId/menu lookup, all declared
// before the /:bizId single-segment catch-all below.
router.get('/:bizId/menu',                     catalogCtrl.getPublicMenu);          // public
router.get('/catalog/sections',                protect, catalogCtrl.listMySections);
router.post('/catalog/sections',               protect, catalogCtrl.createSection);
router.patch('/catalog/sections/:sectionId',   protect, catalogCtrl.updateSection);
router.delete('/catalog/sections/:sectionId',  protect, catalogCtrl.deleteSection);

// Public business profile lookup — MUST be last
router.get('/:bizId', ctrl.getBusinessByBizId);

module.exports = router;
