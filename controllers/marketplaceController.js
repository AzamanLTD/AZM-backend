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
const logger = require('../src/config/logger');
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
        if (err && err.code && String(err.code).startsWith('QR_SIGNING_KEY')) {
            logger.error({ code: err.code }, '[generateCheckInQR] signing key unavailable');
            return res.status(503).json({ success: false, code: err.code, message: 'QR check-in is temporarily unavailable.' });
        }
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
            // Manual AZM-ID search path: reservations, and the passenger's
            // transit bookings with what staff need for an ID check.
            const boarding = require('../services/transitBoardingService');
            const found = await qrSvc.searchByAzamanId(prisma, {
                azamanId: boarding.normalizeAzamanId(azamanId), businessUserId: req.user.id,
            });
            const result = await boarding.enrichAzamanIdSearch(prisma, { businessUserId: req.user.id, result: found });
            return res.status(200).json({ success: true, ...result });
        } else if (reservationId) {
            // Direct compatibility path delegates to the exact same atomic
            // authority as QR and /api/reservations/:id/checkin.
            const { checkInReservation } = require('../services/reservationLifecycleService');
            const reservation = await checkInReservation(prisma, {
                reservationId,
                businessUserId: req.user.id,
            });
            return res.status(200).json({ success: true, reservation });
        }
        return res.status(400).json({ success: false, message: 'Provide token, azamanId, or reservationId.' });
    } catch (err) {
        if (err && err.code && String(err.code).startsWith('QR_SIGNING_KEY')) {
            logger.error({ code: err.code }, '[businessCheckIn] signing key unavailable');
            return res.status(503).json({ success: false, code: err.code, message: 'QR check-in is temporarily unavailable.' });
        }
        // A refused one-use token is a client conflict, not a bad request body.
        const status = err && err.code === 'QR_TOKEN_ALREADY_USED' ? 409 : 400;
        return res.status(status).json({ success: false, code: err.code, message: err.message });
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
        const { seatIds, passengerNames, customerNote, payWith, expectedTotalUsdc } = req.body;

        const result = await transitSvc.bookSeats(prisma, {
            tripId: req.params.id,
            customerId: req.user.id,
            seatIds,
            passengerNames,
            customerNote,
            payWith: payWith || null,
            expectedTotalUsdc: expectedTotalUsdc ?? null,
            businessProfileId: req.body.businessProfileId,
            // §r42 wired claim (2026-10-01): present only when the caller sent
            // an Idempotency-Key (idempotency authority mounted on the route).
            // The service commits this exact row to COMMITTED INSIDE the
            // booking $transaction — booking and identity commit atomically,
            // closing the crash-after-commit window; a rolled-back transaction
            // leaves no replayable phantom identity.
            financialOperation: res.locals?.financialOperation || null,
        });
        return res.status(201).json(result);
    } catch (err) {
        // Domain refusals (thrown before or inside the booking transaction,
        // which then rolled back) are 4xx with their code, so the RELEASE
        // policy frees the key for a corrected retry. A short balance is 402
        // so the app can offer a top-up. bookSeats swallows its post-commit
        // work, so a committed booking never reaches this branch.
        const status = err.code === 'INSUFFICIENT_BALANCE' ? 402 : (err.httpStatus || 400);
        return res.status(status).json({
            success: false,
            // Our own codes reach the app; Prisma's (P2002 …) stay internal.
            ...(typeof err.code === 'string' && !/^P\d{4}$/.test(err.code) ? { code: err.code } : {}),
            message: err.message,
        });
    }
};

// GET /api/marketplace/transit/trips/:id/quote?seats=1A,1B — read-only quote
// for wallet pay: fare, booking fee, total, the payer's available balance.
exports.quoteTripSeats = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const transitSvc = require('../services/transitBookingService');
        const seatIds = String(req.query.seats || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
        const result = await transitSvc.quoteSeats(prisma, {
            tripId: req.params.id,
            customerId: req.user.id,
            seatIds,
        });
        return res.status(200).json(result);
    } catch (err) {
        return res.status(err.httpStatus || 400).json({ success: false, code: err.code, message: err.message });
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
        return res.status(err.httpStatus || 400).json({ success: false, code: err.code, message: err.message });
    }
};

// DELETE /api/marketplace/transit/bookings/:id — cancel transit booking
exports.cancelTransitBooking = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const transitSvc = require('../services/transitBookingService');
        const result = await transitSvc.cancelTransitBooking(prisma, {
            bookingId: req.params.id,
            cancelledBy: req.user.id,
        });
        return res.status(200).json(result);
    } catch (err) {
        const code = err.message.includes('Not authorized') ? 403 : 400;
        return res.status(code).json({ success: false, message: err.message });
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

        const profile = await prisma.businessProfile.findFirst({ where: { userId } });
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

            // A paid booking's no-show terms are fixed when it is paid. Setting
            // a penalty afterwards would let the operator collect the fare by
            // marking a no-show, without the passenger's QR boarding.
            const { isPaidTransitBooking } = require('../services/qrCheckInService');
            if (await isPaidTransitBooking(prisma, b)) {
                return res.status(409).json({
                    success: false,
                    code: 'PENALTY_LOCKED',
                    message: 'A paid booking\'s no-show terms cannot be changed.',
                });
            }
            // The flat penalty is capped like the percentage.
            if (noShowPenaltyUsdc != null
                && (Number(noShowPenaltyUsdc) < 0 || Number(noShowPenaltyUsdc) > MAX_PENALTY_PCT * Number(b.amountUsdc))) {
                return res.status(400).json({
                    success: false,
                    message: `Penalty cannot exceed ${MAX_PENALTY_PCT * 100}% of the fare.`,
                });
            }

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
        const profile = await prisma.businessProfile.findFirst({ where: { userId } });
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

// GET /api/marketplace/business/trips — list the CALLING business's own trips
// (distinct from listTransitTrips above, which is the customer-facing browse
// endpoint and requires an explicit businessProfileId query param — this one
// scopes automatically to the authenticated business owner).
exports.listMyTransitTrips = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const profile = await prisma.businessProfile.findFirst({ where: { userId } });
        if (!profile) return res.status(404).json({ success: false, message: 'Business profile not found.' });

        const { status } = req.query;
        const where = { businessProfileId: profile.id };
        if (status) where.status = status;

        const trips = await prisma.transitTrip.findMany({
            where,
            orderBy: { departureAt: 'asc' },
            take: 100,
            include: {
                vehicle: { select: { id: true, type: true, make: true, model: true, imageUrl: true, licensePlate: true, capacity: true, driverName: true, driverPhotoUrl: true } },
                _count: { select: { bookings: true, seats: true } }
            }
        });
        return res.status(200).json({ success: true, trips });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

// PATCH /api/marketplace/business/trips/:id — update a trip's schedule/fare/status.
// vehicleId is intentionally immutable after creation (the seat map + any
// existing bookings are keyed off the original vehicle's layout).
exports.updateTransitTrip = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { id } = req.params;
        const profile = await prisma.businessProfile.findFirst({ where: { userId } });
        if (!profile) return res.status(404).json({ success: false, message: 'Business profile not found.' });

        const trip = await prisma.transitTrip.findUnique({ where: { id } });
        if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });
        if (trip.businessProfileId !== profile.id)
            return res.status(403).json({ success: false, message: 'This trip does not belong to your business.' });

        const { routeName, origin, destination, departureAt, arrivalAt, fareUsdc, status } = req.body;
        // Cancelling a trip refunds its paid bookings: route it through the
        // canonical cancellation (never a bare status write, which stranded
        // every funded escrow on a CANCELLED trip).
        const normalizedStatus = status !== undefined ? String(status).trim().toUpperCase() : undefined;
        const cancelling = normalizedStatus === 'CANCELLED';
        const data = {};
        if (routeName !== undefined) data.routeName = routeName;
        if (origin !== undefined) data.origin = origin;
        if (destination !== undefined) data.destination = destination;
        if (departureAt !== undefined) data.departureAt = new Date(departureAt);
        if (arrivalAt !== undefined) data.arrivalAt = arrivalAt ? new Date(arrivalAt) : null;
        if (fareUsdc !== undefined) data.fareUsdc = parseFloat(fareUsdc);
        if (normalizedStatus !== undefined && !cancelling) data.status = normalizedStatus;

        // The trip write and its bookings' reschedule commit together: a
        // departure in the body always re-syncs the bookings and paid escrows
        // (idempotent), so a failed attempt is simply retried.
        const { _rescheduleTripBookingsTx } = require('../services/transitBookingService');
        let updated = Object.keys(data).length > 0
            ? await prisma.$transaction(async (tx) => {
                const t = await tx.transitTrip.update({ where: { id }, data });
                if (data.departureAt) {
                    await _rescheduleTripBookingsTx(tx, { tripId: id, departureAt: data.departureAt });
                }
                return t;
            })
            : trip;
        if (cancelling) {
            const { cancelTripWithRefunds } = require('../services/transitTripCancellationService');
            const result = await cancelTripWithRefunds(prisma, { tripId: id, businessProfileId: profile.id });
            updated = await prisma.transitTrip.findUnique({ where: { id } });
            if (!result.cancelled || result.summary.failed > 0) {
                return res.status(409).json({
                    success: false,
                    code: 'TRIP_CANCELLATION_INCOMPLETE',
                    message: 'Some bookings could not be refunded yet. Retry is safe: unresolved bookings are reprocessed.',
                    trip: updated,
                    summary: result.summary,
                });
            }
            return res.status(200).json({ success: true, trip: updated, summary: result.summary });
        }
        return res.status(200).json({ success: true, trip: updated });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

// DELETE /api/marketplace/business/trips/:id — remove a trip that has no bookings.
// Trips with existing bookings must be cancelled (status=CANCELLED) instead of
// deleted, so paying customers' bookings/escrow are never silently destroyed.
exports.deleteTransitTrip = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { id } = req.params;
        const profile = await prisma.businessProfile.findFirst({ where: { userId } });
        if (!profile) return res.status(404).json({ success: false, message: 'Business profile not found.' });

        const trip = await prisma.transitTrip.findUnique({
            where: { id },
            include: { _count: { select: { seats: true } } }
        });
        if (!trip) return res.status(404).json({ success: false, message: 'Trip not found.' });
        if (trip.businessProfileId !== profile.id)
            return res.status(403).json({ success: false, message: 'This trip does not belong to your business.' });
        if (trip._count.seats > 0) {
            return res.status(400).json({ success: false, message: 'This trip has existing bookings — cancel it instead of deleting.' });
        }

        await prisma.transitTrip.delete({ where: { id } });
        return res.status(200).json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

// POST /api/marketplace/business/seat-map — create or update a vehicle's seat map
exports.setSeatMap = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const profile = await prisma.businessProfile.findFirst({ where: { userId } });
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


// ── generateTransitCheckInQR ──────────────────────────────────────────────
exports.generateTransitCheckInQR = async (req, res) => {
    const prisma = req.prisma || req.app.get('prisma');
    try {
        const { bookingId } = req.params;
        const { generateTransitCheckInToken } = require('../services/qrCheckInService');
        const result = await generateTransitCheckInToken(prisma, {
            bookingId, customerId: req.user.id
        });
        res.json({ success: true, ...result });
    } catch (err) {
        if (err && err.code && String(err.code).startsWith('QR_SIGNING_KEY')) {
            logger.error({ code: err.code }, '[generateTransitCheckInQR] signing key unavailable');
            return res.status(503).json({ success: false, code: err.code, message: 'QR check-in is temporarily unavailable.' });
        }
        logger.error({ err: err }, '[generateTransitCheckInQR]');
        res.status(400).json({ success: false, message: err.message });
    }
};

// ── transitBoarding ────────────────────────────────────────────────────────
// verifyTransitTokenAndBoard did not exist on the service, so this handler
// threw a TypeError on every scan. It now verifies the signed token.
exports.transitBoarding = async (req, res) => {
    const prisma = req.prisma || req.app.get('prisma');
    try {
        const token = req.body.token || req.body.code;
        const { verifyTransitTokenAndBoard } = require('../services/qrCheckInService');
        const result = await verifyTransitTokenAndBoard(prisma, {
            token, businessUserId: req.user.id
        });
        res.json(result);
    } catch (err) {
        if (err && err.code && String(err.code).startsWith('QR_SIGNING_KEY')) {
            logger.error({ code: err.code }, '[transitBoarding] signing key unavailable');
            return res.status(503).json({ success: false, code: err.code, message: 'QR check-in is temporarily unavailable.' });
        }
        logger.error({ err: err }, '[transitBoarding]');
        res.status(400).json({ success: false, code: err.code, message: err.message });
    }
};

// ── getCustomerTrustScore ──────────────────────────────────────────────────
exports.getCustomerTrustScore = async (req, res) => {
    try {
        const { azamanId } = req.params;
        const customer = await req.prisma.user.findFirst({
            where: { azamanId },
            select: { id: true }
        });
        if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });

        const { getTrustScore } = require('../services/customerTrustScoreService');
        const score = await getTrustScore(req.prisma, customer.id);
        res.json({ success: true, ...score });
    } catch (err) {
        logger.error({ err: err }, '[getCustomerTrustScore]');
        res.status(500).json({ success: false, message: err.message });
    }
};
