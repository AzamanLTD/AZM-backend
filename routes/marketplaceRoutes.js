// routes/marketplaceRoutes.js
// =============================================================================
// AZAMAN — MARKETPLACE OVERHAUL ROUTES (2026-07-02)
// New endpoints for QR check-in, transit trips/seat booking, review→story,
// no-show penalty policy, and transit trip/seat-map management.
// =============================================================================

const logger = require('../src/config/logger');
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/marketplaceController');
const { require2FA } = require('../middleware/require2FA');

// ── QR Check-in ──────────────────────────────────────────────────────────────
router.get('/reservations/:id/checkin-qr', protect, ctrl.generateCheckInQR);
router.post('/business/checkin', protect, ctrl.businessCheckIn);

// ── Transit Trips + Seat Booking ─────────────────────────────────────────────
router.get('/transit/trips', protect, ctrl.listTransitTrips);
router.get('/transit/trips/:id/seats', protect, ctrl.getTripSeats);
router.post('/transit/trips/:id/book', protect, require2FA(), ctrl.bookTripSeats);
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

// ── MISSING ROUTES (found by route-checker) ─────────────────────────────────
// These checkin endpoints are called by the frontend but had no backend route.

// POST /api/marketplace/checkin/verify — verify a QR token for check-in
router.post('/checkin/verify', protect, async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const qrSvc = require('../services/qrCheckInService');
        const { token } = req.body;
        if (!token) return res.status(400).json({ success: false, message: 'Token required' });

        const result = await qrSvc.verifyAndCheckIn(prisma, {
            token, businessUserId: req.user.id,
        });
        res.json(result);
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

// GET /api/marketplace/checkin/search — search customer by AZM ID for check-in
router.get('/checkin/search', protect, async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const qrSvc = require('../services/qrCheckInService');
        const { azamanId } = req.query;
        if (!azamanId) return res.status(400).json({ success: false, message: 'azamanId required' });

        const result = await qrSvc.searchByAzamanId(prisma, {
            azamanId, businessUserId: req.user.id,
        });
        res.json(result);
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

// POST /api/marketplace/checkin/direct — direct check-in by reservation ID
router.post('/checkin/direct', protect, async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const { reservationId } = req.body;
        if (!reservationId) return res.status(400).json({ success: false, message: 'reservationId required' });

        const reservation = await prisma.reservation.findFirst({
            where: { id: reservationId },
        });
        if (!reservation) return res.status(404).json({ success: false, message: 'Reservation not found' });

        const updated = await prisma.reservation.update({
            where: { id: reservationId },
            data: { status: 'CHECKED_IN' },
        });

        res.json({ success: true, reservation: updated });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

