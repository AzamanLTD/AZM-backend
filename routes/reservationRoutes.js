// routes/reservationRoutes.js
// Mounted at /api/reservations
const router = require('express').Router();
const { protect }       = require('../middleware/authMiddleware');
const { protectActive } = require('../middleware/banGuardMiddleware');
const ctrl              = require('../controllers/reservationController');

// Public
router.get('/availability',             ctrl.getAvailability);

// Customer
router.post('/',                        protectActive, ctrl.createReservation);
router.get('/me',                       protect,       ctrl.listMyReservations);
router.get('/:reservationId',           protect,       ctrl.getReservation);
router.patch('/:reservationId/cancel',  protectActive, ctrl.cancelReservation);

// Business owner
router.get('/business/:bizId',          protect,       ctrl.listBusinessReservations);
router.patch('/:reservationId/confirm', protect,       ctrl.confirmReservation);
router.patch('/:reservationId/checkin', protect,       ctrl.checkInReservation);
router.patch('/:reservationId/checkout',protect,       ctrl.checkOutReservation);

module.exports = router;

// ── Counter-Propose (NEW) ────────────────────────────────────────────────────
router.post('/:id/counter-propose', protect, ctrl.counterProposeReservation);
router.post('/:id/accept-counter', protect, ctrl.acceptCounterProposal);
