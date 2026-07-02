// controllers/marketplaceController.js
// =============================================================================
// AZAMAN — MARKETPLACE OVERFLOW CONTROLLER (2026-07-02)
//
// New endpoints for the marketplace overhaul:
//   - QR check-in (generate + verify + AZM-ID search)
//   - Transit trip listing + seat availability + seat booking
//   - Review → Story promotion
//   - No-show penalty setting (business portal)
// =============================================================================

// ── QR CHECK-IN ──────────────────────────────────────────────────────────────

// GET /api/marketplace/reservations/:id/checkin-qr
exports.generateCheckInQR = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const qrSvc = require('../services/qrCheckInService');
        const result = await qrSvc.generateCheckInToken(prisma, {
            reservationId: req.params.id,
            customerId: req.user.id,
        });
        // Attach business name for display
        const reservation = await prisma.reservation.findUnique({
            where: { id: req.params.id },
            include: { businessProfile: { select: { businessName: true, logoUrl: true } } }
        });
        result.businessName = reservation?.businessProfile?.businessName;
        result.businessLogoUrl = reservation?.businessProfile?.logoUrl;
        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// POST /api/marketplace/business/checkin — business scans QR or searches by AZM-ID
exports.businessCheckIn = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const qrSvc = require('../services/qrCheckInService');
        const { token, azamanId, reservationId } = req.body;

        if (token) {
            // QR scan path
            const result = await qrSvc.verifyAndCheckIn(prisma, {
                token, businessUserId: req.user.id,
            });
            return res.status(200).json(result);
        } else if (azamanId) {
            // Manual AZM-ID search path
            const result = await qrSvc.searchByAzamanId(prisma, {
                azamanId, businessUserId: req.user.id,
            });
            return res.status(200).json({ success: true, ...result });
        } else if (reservationId) {
            // Direct reservation check-in (from search results)
            const result = await qrSvc.verifyAndCheckIn(prisma, {
                token: null, businessUserId: req.user.id,
            }).catch(() => null);

            // Direct check-in without token
            const reservation = await prisma.reservation.findUnique({
                where: { id: reservationId },
                include: { businessProfile: true }
            });
            if (!reservation) return res.status(404).json({ success: false, message: 'Reservation not found.' });
            if (reservation.businessProfile.userId !== req.user.id)
                return res.status(403).json({ success: false, message: 'Not your business.' });
            if (reservation.status !== 'CONFIRMED')
                return res.status(409).json({ success: false, message: `Reservation is ${reservation.status}.` });

            const updated = await prisma.reservation.update({
                where: { id: reservationId },
                data: { status: 'CHECKED_IN', checkedInAt: new Date() }
            });

            // Release escrow if exists
            if (reservation.escrowId) {
                try {
                    const { releaseBookingEscrow } = require('../services/bookingEscrowService');
                    await releaseBookingEscrow(prisma, { escrowId: reservation.escrowId });
                } catch (e) { console.error('[checkIn] escrow release:', e.message); }
            }

            return res.status(200).json({ success: true, reservation: updated });
        }
        return res.status(400).json({ success: false, message: 'Provide token, azamanId, or reservationId.' });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// ── TRANSIT TRIPS + SEAT BOOKING ─────────────────────────────────────────────

// GET /api/marketplace/transit/trips — list trips for a business
exports.listTransitTrips = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { businessProfileId, status } = req.query;
        const where = {};
        if (businessProfileId) where.businessProfileId = businessProfileId;
        if (status) where.status = status;
        else where.status = { notIn: ['CANCELLED', 'COMPLETED'] };

        const trips = await prisma.transitTrip.findMany({
            where,
            orderBy: { departureAt: 'asc' },
            take: 50,
            include: {
                vehicle: { select: { id: true, type: true, make: true, model: true, imageUrl: true, driverName: true, driverPhotoUrl: true } },
                _count: { select: { bookings: true } }
            }
        });
        return res.status(200).json({ success: true, trips });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

// GET /api/marketplace/transit/trips/:id/seats — seat availability for a trip
exports.getTripSeats = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const transitSvc = require('../services/transitBookingService');
        const result = await transitSvc.getTripSeatAvailability(prisma, { tripId: req.params.id });
        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// POST /api/marketplace/transit/trips/:id/book — book seats on a trip
exports.bookTripSeats = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const transitSvc = require('../services/transitBookingService');
        const { seatIds, passengerNames, customerNote } = req.body;

        const result = await transitSvc.bookSeats(prisma, {
            tripId: req.params.id,
            customerId: req.user.id,
            seatIds,
            passengerNames,
            customerNote,
            businessProfileId: req.body.businessProfileId,
        });
        return res.status(201).json(result);
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// POST /api/marketplace/transit/bookings/:id/checkin — transit check-in
exports.transitCheckIn = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const qrSvc = require('../services/qrCheckInService');
        const result = await qrSvc.transitCheckIn(prisma, {
            bookingId: req.params.id,
            businessUserId: req.user.id,
        });
        return res.status(200).json(result);
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// DELETE /api/marketplace/transit/bookings/:id — cancel transit booking
exports.cancelTransitBooking = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const transitSvc = require('../services/transitBookingService');
        const result = await transitSvc.cancelTransitBooking(prisma, { bookingId: req.params.id });
        return res.status(200).json(result);
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// ── REVIEW → STORY ───────────────────────────────────────────────────────────

// POST /api/marketplace/reviews/:id/share-story — promote review to story
exports.promoteReviewToStory = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const reviewSvc = require('../services/reviewStoryService');
        const result = await reviewSvc.promoteReviewToStory(prisma, {
            reviewId: req.params.id,
            userId: req.user.id,
        });
        return res.status(201).json(result);
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// GET /api/marketplace/business/:id/stories — business stories (viral loop)
exports.getBusinessStories = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const reviewSvc = require('../services/reviewStoryService');
        const stories = await reviewSvc.getBusinessStories(prisma, { businessProfileId: req.params.id });
        return res.status(200).json({ success: true, stories });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// ── NO-SHOW PENALTY SETTING (business portal) ────────────────────────────────

// PATCH /api/marketplace/business/penalty-policy — set no-show penalty for a reservation or transit booking
exports.setPenaltyPolicy = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { reservationId, transitBookingId, noShowPenaltyPct, noShowPenaltyUsdc } = req.body;

        if (!reservationId && !transitBookingId) {
            return res.status(400).json({ success: false, message: 'reservationId or transitBookingId is required.' });
        }
        if (noShowPenaltyPct == null && noShowPenaltyUsdc == null) {
            return res.status(400).json({ success: false, message: 'noShowPenaltyPct or noShowPenaltyUsdc is required.' });
        }

        // Enforce platform cap
        const { MAX_PENALTY_PCT } = require('../services/bookingEscrowService');
        if (noShowPenaltyPct != null && Number(noShowPenaltyPct) > MAX_PENALTY_PCT) {
            return res.status(400).json({ success: false, message: `Penalty cannot exceed ${MAX_PENALTY_PCT * 100}% of the deposit.` });
        }

        const profile = await prisma.businessProfile.findUnique({ where: { userId } });
        if (!profile) return res.status(404).json({ success: false, message: 'Business profile not found.' });

        if (reservationId) {
            const r = await prisma.reservation.findUnique({ where: { id: reservationId } });
            if (!r || r.businessProfileId !== profile.id)
                return res.status(403).json({ success: false, message: 'Not your reservation.' });

            const updated = await prisma.reservation.update({
                where: { id: reservationId },
                data: { noShowPenaltyPct: noShowPenaltyPct || null, noShowPenaltyUsdc: noShowPenaltyUsdc || null }
            });
            return res.status(200).json({ success: true, reservation: updated });
        } else {
            const b = await prisma.transitBooking.findUnique({ where: { id: transitBookingId } });
            if (!b || b.businessProfileId !== profile.id)
                return res.status(403).json({ success: false, message: 'Not your booking.' });

            const updated = await prisma.transitBooking.update({
                where: { id: transitBookingId },
                data: { noShowPenaltyPct: noShowPenaltyPct || null, noShowPenaltyUsdc: noShowPenaltyUsdc || null }
            });
            return res.status(200).json({ success: true, transitBooking: updated });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── TRANSIT TRIP MANAGEMENT (business portal) ────────────────────────────────

// POST /api/marketplace/business/trips — create a scheduled trip
exports.createTransitTrip = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const profile = await prisma.businessProfile.findUnique({ where: { userId } });
        if (!profile) return res.status(404).json({ success: false, message: 'Business profile not found.' });

        const { vehicleId, routeName, origin, destination, departureAt, arrivalAt, fareUsdc } = req.body;
        if (!vehicleId || !routeName || !origin || !destination || !departureAt || !fareUsdc) {
            return res.status(400).json({ success: false, message: 'Missing required fields.' });
        }

        const vehicle = await prisma.transitVehicle.findUnique({ where: { id: vehicleId } });
        if (!vehicle || vehicle.businessProfileId !== profile.id)
            return res.status(403).json({ success: false, message: 'Vehicle not found for this business.' });

        // Get seat count from seat map
        const seatMap = await prisma.transitSeatMap.findUnique({ where: { vehicleId } });
        const availableSeats = seatMap ? seatMap.layout.length : vehicle.capacity;

        const trip = await prisma.transitTrip.create({
            data: {
                businessProfileId: profile.id, vehicleId,
                routeName, origin, destination,
                departureAt: new Date(departureAt),
                arrivalAt: arrivalAt ? new Date(arrivalAt) : null,
                fareUsdc: parseFloat(fareUsdc),
                availableSeats,
            }
        });
        return res.status(201).json({ success: true, trip });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

// POST /api/marketplace/business/seat-map — create or update a vehicle's seat map
exports.setSeatMap = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const profile = await prisma.businessProfile.findUnique({ where: { userId } });
        if (!profile) return res.status(404).json({ success: false, message: 'Business profile not found.' });

        const { vehicleId, layout, rows, cols } = req.body;
        if (!vehicleId || !layout || !rows || !cols) {
            return res.status(400).json({ success: false, message: 'vehicleId, layout, rows, cols are required.' });
        }

        const vehicle = await prisma.transitVehicle.findUnique({ where: { id: vehicleId } });
        if (!vehicle || vehicle.businessProfileId !== profile.id)
            return res.status(403).json({ success: false, message: 'Vehicle not found for this business.' });

        const seatMap = await prisma.transitSeatMap.upsert({
            where: { vehicleId },
            update: { layout, rows, cols },
            create: { vehicleId, layout, rows, cols },
        });

        return res.status(200).json({ success: true, seatMap });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

Routes Source
routes/marketplaceRoutes.js
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
router.post('/business/trips', protect, ctrl.createTransitTrip);
router.post('/business/seat-map', protect, ctrl.setSeatMap);

module.exports = router;
