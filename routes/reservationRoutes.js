// routes/reservationRoutes.js
// Mounted at /api/reservations
const logger = require('../src/config/logger');
const router = require('express').Router();
const { protect }       = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const ctrl              = require('../controllers/reservationController');

// Public
router.get('/availability',             ctrl.getAvailability);

// Customer
router.post('/',                        protectActive, ctrl.createReservation);
router.get('/me',                       protect,       ctrl.listMyReservations);
// The business's check-in setting (may staff check guests in by ID?).
// Before '/:reservationId' and '/business/:bizId', which would match it.
router.get('/policy/checkin',          protect,       ctrl.getCheckInPolicy);
router.put('/policy/checkin',          protectActive, ctrl.setCheckInPolicy);
router.get('/:reservationId',           protect,       ctrl.getReservation);
router.patch('/:reservationId/cancel',  protectActive, ctrl.cancelReservation);

// Business owner
router.get('/business/:bizId',          protect,       ctrl.listBusinessReservations);
router.patch('/:reservationId/confirm', protect,       ctrl.confirmReservation);
router.patch('/:reservationId/checkin', protect,       ctrl.checkInReservation);
// Check-in by ID check (front desk, when the guest's QR cannot be scanned),
// and the guest's answer to it.
router.post('/:reservationId/checkin-by-id',     protectActive, ctrl.checkInById);
router.post('/:reservationId/checkin/confirm',   protect,       ctrl.confirmIdCheckIn);
router.post('/:reservationId/checkin/report',    protect,       ctrl.reportIdCheckIn);
router.patch('/:reservationId/decline', protect,       ctrl.declineReservation);
router.patch('/:reservationId/checkout',protect,       ctrl.checkOutReservation);
router.patch('/:reservationId/no-show', protect,    ctrl.markNoShowReservation);

module.exports = router;

// ── Counter-Propose (NEW) ────────────────────────────────────────────────────
router.post('/:id/counter-propose', protect, ctrl.counterProposeReservation);
router.post('/:id/accept-counter', protect, ctrl.acceptCounterProposal);
