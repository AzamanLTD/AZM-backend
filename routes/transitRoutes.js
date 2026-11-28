// routes/transitRoutes.js
// =============================================================================
// AZAMAN — TRANSIT ROUTES (B-11, 2026-06-28)
// Mounted at /api/transit. All endpoints are authenticated.
// =============================================================================

const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const transitController = require('../controllers/transitController');
const { protect } = require('../middleware/authMiddleware');

// Booking lifecycle
router.post('/bookings', protect, transitController.createBooking);
router.get('/bookings', protect, transitController.listBookings);
router.get('/bookings/:id', protect, transitController.getBooking);
router.patch('/bookings/:id/status', protect, transitController.updateBookingStatus);

// ── Transit QR Check-in (NEW) ──────────────────────────────────────────────────
router.get('/bookings/:id/checkin-qr', protect, transitController.generateTransitCheckInQR);
router.post('/boarding', protect, transitController.transitBoarding);

// ── Boarding by ID check (beside the QR), manifest, the passenger's answer ──
router.get('/trips/:id/manifest', protect, transitController.tripManifest);
router.post('/bookings/:id/board-by-id', protect, transitController.boardById);
router.post('/bookings/:id/boarding/confirm', protect, transitController.confirmBoarding);
router.post('/bookings/:id/boarding/report', protect, transitController.reportBoarding);
router.get('/boarding-policy', protect, transitController.getBoardingPolicy);
router.put('/boarding-policy', protect, transitController.setBoardingPolicy);

module.exports = router;
