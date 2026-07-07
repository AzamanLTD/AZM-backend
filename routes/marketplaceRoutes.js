// routes/marketplaceRoutes.js
// =============================================================================
// AZAMAN — MARKETPLACE OVERHAUL ROUTES (2026-07-02)
// New endpoints for QR check-in, transit trips/seat booking, review→story,
// no-show penalty policy, and transit trip/seat-map management.
// =============================================================================

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/marketplaceController');

// ── QR Check-in ──────────────────────────────────────────────────────────────
router.get('/reservations/:id/checkin-qr', protect, ctrl.generateCheckInQR);
router.post('/business/checkin', protect, ctrl.businessCheckIn);

// ── Transit Trips + Seat Booking ─────────────────────────────────────────────
router.get('/transit/trips', protect, ctrl.listTransitTrips);
router.get('/transit/trips/:id/seats', protect, ctrl.getTripSeats);
router.post('/transit/trips/:id/book', protect, ctrl.bookTripSeats);
router.post('/transit/bookings/:id/checkin', protect, ctrl.transitCheckIn);
router.delete('/transit/bookings/:id', protect, ctrl.cancelTransitBooking);

// ── Review → Story ───────────────────────────────────────────────────────────
router.post('/reviews/:id/share-story', protect, ctrl.promoteReviewToStory);
router.get('/business/:id/stories', protect, ctrl.getBusinessStories);

// ── No-show Penalty Policy (business portal) ─────────────────────────────────
router.patch('/business/penalty-policy', protect, ctrl.setPenaltyPolicy);

// ── Transit Trip + Seat Map Management (business portal) ─────────────────────
router.get('/business/trips', protect, ctrl.listMyTransitTrips);
router.post('/business/trips', protect, ctrl.createTransitTrip);
router.patch('/business/trips/:id', protect, ctrl.updateTransitTrip);
router.delete('/business/trips/:id', protect, ctrl.deleteTransitTrip);
router.post('/business/seat-map', protect, ctrl.setSeatMap);

module.exports = router;

// ── Transit QR Check-in (NEW) ──────────────────────────────────────────────────
router.get('/transit/bookings/:id/checkin-qr', protect, ctrl.generateTransitCheckInQR);
router.post('/transit/boarding', protect, ctrl.transitBoarding);

// ── Customer Trust Score (NEW) ───────────────────────────────────────────────
router.get('/trust-score/:azamanId', protect, ctrl.getCustomerTrustScore);
