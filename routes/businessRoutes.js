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
router.get('/invoices/lookup/:azmId',      protect,                invoiceCtrl.lookupByAzmId);
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

// ── TRANSIT VEHICLE ROUTES (B-13, 2026-06-28) ─────────────────────────────────
// Business owners manage their fleet vehicles for ride-hailing/delivery.
router.get('/vehicles',                        protect,                ctrl.listVehicles);
router.post('/vehicles',                       protect, protectActive, ctrl.createVehicle);
router.patch('/vehicles/:vehicleId',           protect, protectActive, ctrl.updateVehicle);
router.delete('/vehicles/:vehicleId',          protect, protectActive, ctrl.deleteVehicle);

// ── MISSING ROUTES (found by route-checker) ─────────────────────────────────
// These endpoints are called by the frontend but had no backend route.

// GET /api/business/reservations/stats
router.get('/reservations/stats', protect, async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const bpId = req.user.businessProfileId;
        if (!bpId) return res.status(400).json({ success: false, message: 'No business profile' });

        const [total, pending, confirmed, cancelled, checkedIn, completed, noShow] = await Promise.all([
            prisma.reservation.count({ where: { businessProfileId: bpId } }),
            prisma.reservation.count({ where: { businessProfileId: bpId, status: 'PENDING' } }),
            prisma.reservation.count({ where: { businessProfileId: bpId, status: 'CONFIRMED' } }),
            prisma.reservation.count({ where: { businessProfileId: bpId, status: 'CANCELLED' } }),
            prisma.reservation.count({ where: { businessProfileId: bpId, status: 'CHECKED_IN' } }),
            prisma.reservation.count({ where: { businessProfileId: bpId, status: 'COMPLETED' } }),
            prisma.reservation.count({ where: { businessProfileId: bpId, status: 'NO_SHOW' } }),
        ]);

        res.json({ total, pending, confirmed, cancelled, checkedIn, completed, noShow });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/business/checkin/stats
router.get('/checkin/stats', protect, async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const bpId = req.user.businessProfileId;
        if (!bpId) return res.status(400).json({ success: false, message: 'No business profile' });

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const [todayCount, weekCount, monthCount] = await Promise.all([
            prisma.reservation.count({ where: { businessProfileId: bpId, status: 'CHECKED_IN', createdAt: { gte: today } } }),
            prisma.reservation.count({ where: { businessProfileId: bpId, status: 'CHECKED_IN', createdAt: { gte: new Date(Date.now() - 7 * 864e5) } } }),
            prisma.reservation.count({ where: { businessProfileId: bpId, status: 'CHECKED_IN', createdAt: { gte: new Date(Date.now() - 30 * 864e5) } } }),
        ]);

        res.json({ today: todayCount, week: weekCount, month: monthCount });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/business/checkin/recent
router.get('/checkin/recent', protect, async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const bpId = req.user.businessProfileId;
        if (!bpId) return res.status(400).json({ success: false, message: 'No business profile' });

        const limit = parseInt(req.query.limit) || 20;
        const skip = parseInt(req.query.skip) || 0;

        const recent = await prisma.reservation.findMany({
            where: { businessProfileId: bpId, status: 'CHECKED_IN' },
            orderBy: { updatedAt: 'desc' },
            take: limit,
            skip,
            select: { id: true, reservationRef: true, customerId: true, startDatetime: true, partySize: true, amountUsdc: true, updatedAt: true },
        });

        res.json(recent);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/business/reviews/stats
router.get('/reviews/stats', protect, async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const bpId = req.user.businessProfileId;
        if (!bpId) return res.status(400).json({ success: false, message: 'No business profile' });

        const reviews = await prisma.businessReview.findMany({
            where: { businessProfileId: bpId },
            select: { rating: true },
        });

        const total = reviews.length;
        const avg = total > 0 ? (reviews.reduce((s, r) => s + (r.rating || 0), 0) / total) : 0;
        const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
        reviews.forEach(r => { if (r.rating >= 1 && r.rating <= 5) distribution[r.rating]++; });

        res.json({ total, average: +avg.toFixed(2), distribution });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/business/marketplace/stats
router.get('/marketplace/stats', protect, async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const bpId = req.user.businessProfileId;
        if (!bpId) return res.status(400).json({ success: false, message: 'No business profile' });

        const [orders, products, reviews, revenue] = await Promise.all([
            prisma.businessOrder.count({ where: { businessProfileId: bpId } }),
            prisma.businessProduct.count({ where: { businessProfileId: bpId } }),
            prisma.businessReview.count({ where: { businessProfileId: bpId } }),
            prisma.businessOrder.aggregate({ where: { businessProfileId: bpId, status: 'COMPLETED' }, _sum: { amountUsdc: true } }),
        ]);

        res.json({ orders, products, reviews, revenue: +((revenue._sum.amountUsdc || 0).toString()) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/business/transit/trips
router.get('/transit/trips', protect, async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const bpId = req.user.businessProfileId;
        if (!bpId) return res.status(400).json({ success: false, message: 'No business profile' });

        const trips = await prisma.transitTrip.findMany({
            where: { businessProfileId: bpId },
            orderBy: { departureAt: 'desc' },
            take: 100,
        });
        res.json(trips);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});


// Public business profile lookup — MUST be last
router.get('/:bizId', ctrl.getBusinessByBizId);

module.exports = router;
