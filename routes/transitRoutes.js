// routes/transitRoutes.js
// =============================================================================
// AZAMAN — TRANSIT ROUTES (B-11, 2026-06-28)
// Mounted at /api/transit. All endpoints are authenticated.
// =============================================================================

const express = require('express');
const router = express.Router();
const transitController = require('../controllers/transitController');
const { protect } = require('../middleware/authMiddleware');

// Booking lifecycle
router.post('/bookings', protect, transitController.createBooking);
router.get('/bookings', protect, transitController.listBookings);
router.get('/bookings/:id', protect, transitController.getBooking);
router.patch('/bookings/:id/status', protect, transitController.updateBookingStatus);

module.exports = router;
