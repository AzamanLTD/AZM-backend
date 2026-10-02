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
const hotelCtrl = require('../controllers/hotelMarketplaceController');
const { require2FA } = require('../middleware/require2FA');
const { idempotency } = require('../middleware/idempotency');

// ── QR Check-in ──────────────────────────────────────────────────────────────
router.get('/reservations/:id/checkin-qr', protect, ctrl.generateCheckInQR);
router.post('/business/checkin', protect, ctrl.businessCheckIn);

// ── Public category business detail ──────────────────────────────────────────
// Backwards-compatible marketplace contract consumed by the Flutter vertical
// experiences. Hotel detail includes the authoritative HotelRoom inventory.
router.get('/business/:bizId', hotelCtrl.getBusinessDetail);
router.post('/business/:bizId/reservations', protect, hotelCtrl.createHotelReservation);

// ── Transit Trips + Seat Booking ─────────────────────────────────────────────
router.get('/transit/trips', protect, ctrl.listTransitTrips);
router.get('/transit/trips/:id/seats', protect, ctrl.getTripSeats);
// §r42 WIRING (transit booking identity, 2026-10-01): the shared financial
// idempotency authority gives ONE logical seat-booking intent ONE durable
// identity per (user, endpoint, key) — claim-before-execute, exact replay of
// the committed booking, 409 on same-key/different-intent, exactly one
// booking under concurrency. Without it, a booking that committed while its
// HTTP response was lost turned the customer's same-seat retry into an
// indistinguishable 400 'Seats already booked' (their own committed seats
// vs another customer's) — the reconciliation gap found in the retail
// checkout deep-dive step 5.
//   - failurePolicy RELEASE + releaseOn4xx: the service commits the claim
//     INSIDE the booking $transaction (wired pattern, like convert), so an
//     IN_PROGRESS claim after the response PROVES the transaction rolled
//     back — the key is never poisoned by a failed attempt.
//   - required: false — evidence-named opt-out: legacy app builds (pre
//     identity wiring) send no key; the DB-level TransitBookingSeat
//     @@unique([tripId, seatId]) already prevents duplicate seat claims
//     structurally, so a keyless request keeps today's behavior (the
//     exposure is reconciliation UX only, not duplicate economics).
router.post('/transit/trips/:id/book', protect, require2FA(), idempotency({ failurePolicy: 'RELEASE', releaseOn4xx: true, required: false }), ctrl.bookTripSeats);
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

// POST /api/marketplace/checkin/direct — compatibility alias for the canonical
// business check-in path. The controller enforces business ownership and only
// permits the CONFIRMED → CHECKED_IN transition (and releases escrow safely).
router.post('/checkin/direct', protect, ctrl.businessCheckIn);
