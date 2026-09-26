// routes/orderTrackingRoutes.js
// =============================================================================
// AZAMAN — Order Tracking Routes (Phase 3)
//
// GET    /api/orders/:orderId/tracking              — get tracking info
// PUT    /api/orders/:orderId/tracking/location     — update courier location (business)
// PUT    /api/orders/:orderId/tracking/eta          — update ETA (business)
// POST   /api/orders/:orderId/tracking/status       — update tracking status (business)
// GET    /api/orders/:orderId/tracking/timeline     — get status timeline
// =============================================================================

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/orderTrackingController');
const { protect } = require('../middleware/authMiddleware');

router.get('/:orderId/tracking', protect, ctrl.getTracking);
router.put('/:orderId/tracking/location', protect, ctrl.updateLocation);
router.put('/:orderId/tracking/eta', protect, ctrl.updateEta);
router.post('/:orderId/tracking/status', protect, ctrl.updateStatus);
router.get('/:orderId/tracking/timeline', protect, ctrl.getTimeline);

module.exports = router;
