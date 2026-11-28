const logger = require('../src/config/logger');
// controllers/transitController.js
// =============================================================================
// AZAMAN — TRANSIT BOOKING CONTROLLER (B-11, 2026-06-28)
//
// Handles ride-hailing / delivery booking lifecycle: create, list, get,
// cancel, complete. All endpoints are authenticated.
//
// Routes (mounted at /api/transit):
//   POST   /api/transit/bookings          — create a booking
//   GET    /api/transit/bookings          — list caller's bookings
//   GET    /api/transit/bookings/:id      — booking detail
//   PATCH  /api/transit/bookings/:id/status — update status (cancel/complete)
// =============================================================================

const VALID_TRANSITIONS = {
    PENDING:      ['CONFIRMED', 'CANCELLED'],
    // r27: CONFIRMED -> NO_SHOW is business-authoritative only (the 403
    // authority gate above rejects customers before this table is consulted);
    // a funded escrow is split through the canonical worker economics.
    CONFIRMED:    ['IN_PROGRESS', 'CANCELLED', 'NO_SHOW'],
    // r28: IN_PROGRESS is NOT cancellable — this unifies the two
    // contradictory contracts (this table admitted IN_PROGRESS -> CANCELLED
    // while the canonical service only cancels PENDING/CONFIRMED). A ride
    // that already started resolves through completion or dispute, never
    // through cancellation, so a funded escrow can never be dropped out
    // of its real settlement path by a late cancel.
    IN_PROGRESS:  ['COMPLETED'],
    COMPLETED:    [],
    CANCELLED:    [],
    NO_SHOW:      [],
};

function _isValidTransition(current, next) {
    const allowed = VALID_TRANSITIONS[current];
    return allowed && allowed.includes(next);
}

// POST /api/transit/bookings
exports.createBooking = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const {
            businessProfileId, vehicleId, pickupAddress, dropoffAddress,
            pickupLatitude, pickupLongitude, dropoffLatitude, dropoffLongitude,
            scheduledAt, amountUsdc, customerNote, metadata
        } = req.body;

        if (!businessProfileId || !pickupAddress || !dropoffAddress || amountUsdc == null) {
            return res.status(400).json({
                success: false,
                message: 'businessProfileId, pickupAddress, dropoffAddress, and amountUsdc are required.'
            });
        }

        const bizProfile = await prisma.businessProfile.findUnique({
            where: { id: businessProfileId },
            select: { id: true, isSuspended: true }
        });
        if (!bizProfile) {
            return res.status(404).json({ success: false, message: 'Business not found.' });
        }
        if (bizProfile.isSuspended) {
            return res.status(403).json({ success: false, message: 'Business is suspended.' });
        }

        if (vehicleId) {
            const vehicle = await prisma.transitVehicle.findUnique({
                where: { id: vehicleId },
                select: { id: true, businessProfileId: true, isActive: true }
            });
            if (!vehicle || vehicle.businessProfileId !== businessProfileId) {
                return res.status(400).json({ success: false, message: 'Vehicle not found for this business.' });
            }
            if (!vehicle.isActive) {
                return res.status(409).json({ success: false, message: 'Vehicle is not active.' });
            }
        }

        const count = await prisma.transitBooking.count();
        const bookingRef = `TRN-${String(Date.now()).slice(-6)}-${String((count + 1) % 10000).padStart(4, '0')}`;

        const booking = await prisma.transitBooking.create({
            data: {
                businessProfileId,
                vehicleId: vehicleId || null,
                customerId: userId,
                status: 'PENDING',
                pickupAddress,
                dropoffAddress,
                pickupLatitude: pickupLatitude ? parseFloat(pickupLatitude) : null,
                pickupLongitude: pickupLongitude ? parseFloat(pickupLongitude) : null,
                dropoffLatitude: dropoffLatitude ? parseFloat(dropoffLatitude) : null,
                dropoffLongitude: dropoffLongitude ? parseFloat(dropoffLongitude) : null,
                scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
                amountUsdc: parseFloat(amountUsdc),
                customerNote: customerNote || null,
                bookingRef,
                metadata: metadata || null
            },
            include: {
                vehicle: true,
                businessProfile: {
                    select: { id: true, businessName: true, logoUrl: true }
                }
            }
        });

        return res.status(201).json({ success: true, booking });
    } catch (err) {
        logger.error({ err: err }, '[transit.createBooking] error');
        return res.status(500).json({ success: false, message: err.message });
    }
};

// GET /api/transit/bookings
exports.listBookings = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { status, role, cursor } = req.query;
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

        const where = {};
        if (role === 'business') {
            const profile = await prisma.businessProfile.findFirst({ where: { userId }, select: { id: true } });
            if (profile) where.businessProfileId = profile.id;
            else return res.status(200).json({ success: true, bookings: [], hasMore: false });
        } else {
            where.customerId = userId;
        }
        if (status) where.status = String(status).toUpperCase();

        const bookings = await prisma.transitBooking.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: limit + 1,
            include: {
                vehicle: { select: { id: true, type: true, make: true, model: true, licensePlate: true, driverName: true, driverPhone: true } },
                businessProfile: { select: { id: true, businessName: true, logoUrl: true } }
            },
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        });

        const hasMore = bookings.length > limit;
        const slice = hasMore ? bookings.slice(0, limit) : bookings;
        const nextCursor = hasMore ? slice[slice.length - 1].id : null;

        return res.status(200).json({ success: true, bookings: slice, hasMore, nextCursor });
    } catch (err) {
        logger.error({ err: err }, '[transit.listBookings] error');
        return res.status(500).json({ success: false, message: err.message });
    }
};

// GET /api/transit/bookings/:id
exports.getBooking = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { id } = req.params;

        const booking = await prisma.transitBooking.findUnique({
            where: { id },
            include: {
                vehicle: true,
                businessProfile: { select: { id: true, userId: true, businessName: true, logoUrl: true, phoneNumber: true } }
            }
        });

        if (!booking) {
            return res.status(404).json({ success: false, message: 'Booking not found.' });
        }

        const isCustomer = booking.customerId === userId;
        const isOwner = booking.businessProfile.userId === userId;
        if (!isCustomer && !isOwner) {
            return res.status(403).json({ success: false, message: 'Not authorized.' });
        }

        return res.status(200).json({ success: true, booking });
    } catch (err) {
        logger.error({ err: err }, '[transit.getBooking] error');
        return res.status(500).json({ success: false, message: err.message });
    }
};

// PATCH /api/transit/bookings/:id/status
exports.updateBookingStatus = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    try {
        const userId = req.user.id;
        const { id } = req.params;
        const { status, driverNote } = req.body;

        if (!status) {
            return res.status(400).json({ success: false, message: 'status is required.' });
        }

        const nextStatus = String(status).toUpperCase();
        const booking = await prisma.transitBooking.findUnique({
            where: { id },
            include: { businessProfile: { select: { id: true, userId: true } } }
        });

        if (!booking) {
            return res.status(404).json({ success: false, message: 'Booking not found.' });
        }

        const isCustomer = booking.customerId === userId;
        const isOwner = booking.businessProfile.userId === userId;
        if (!isCustomer && !isOwner) {
            return res.status(403).json({ success: false, message: 'Not authorized.' });
        }

        // r27/P0-B: NO_SHOW is business/operator/worker-authoritative. A
        // customer may only CANCEL their own booking (per the existing
        // cancellation contract). Customer-set NO_SHOW used to remove a
        // CONFIRMED booking from the no-show worker's candidate set BEFORE
        // the worker could execute the penalty/refund economics.
        if (!isOwner && nextStatus !== 'CANCELLED') {
            return res.status(403).json({ success: false, message: 'Only the business can update to this status.' });
        }
        if (!_isValidTransition(booking.status, nextStatus)) {
            return res.status(409).json({
                success: false,
                message: `Cannot transition from ${booking.status} to ${nextStatus}.`
            });
        }

        // r28 / P0-C: CANCELLED is delegated to the canonical transactional
        // cancellation service — booking claim, seat release, capacity
        // restore, escrow refund, ledger and TransactionHistory all commit
        // together, or nothing does. This controller never mutates a booking
        // to CANCELLED directly (the old direct update refunded nothing,
        // freed no seats and restored no capacity while reporting success).
        if (nextStatus === 'CANCELLED') {
            const { cancelTransitBooking } = require('../services/transitBookingService');
            try {
                const result = await cancelTransitBooking(prisma, {
                    bookingId: booking.id,
                    cancelledBy: userId,
                    note: driverNote,
                });
                if (io) {
                    io.to(`user_${booking.customerId}`).emit('transit_booking_update', result.booking);
                    if (booking.businessProfile.userId !== booking.customerId) {
                        io.to(`user_${booking.businessProfile.userId}`).emit('transit_booking_update', result.booking);
                    }
                }
                return res.status(200).json({
                    success: true,
                    booking: result.booking,
                    refund: result.refund,
                    alreadyCancelled: result.alreadyCancelled,
                });
            } catch (err) {
                if (err.httpStatus) {
                    return res.status(err.httpStatus).json({ success: false, message: err.message });
                }
                // Refund/ledger failure: the whole operation rolled back —
                // never a false success. Surface the honest error.
                logger.error({ err: err.message }, '[transit.updateBookingStatus] canonical cancellation failed');
                return res.status(500).json({ success: false, message: 'Cancellation failed and was fully rolled back; no state changed. Retry is safe.' });
            }
        }

        // r27: business-initiated NO_SHOW must not diverge economically from
        // the worker's canonical path — a plain status flip here would leave a
        // funded escrow stranded outside every sweep's candidate set. Route
        // it through the same penalty/refund split the worker performs.
        if (nextStatus === 'NO_SHOW' && booking.escrowId) {
            const { splitReleaseFundedEscrow } = require('../services/bookingEscrowService');
            const escrow = await prisma.smartEscrow.findUnique({ where: { id: booking.escrowId } });
            const claimable = ['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'];
            if (escrow && claimable.includes(escrow.status)) {
                const penaltyPct = booking.noShowPenaltyPct ? Number(booking.noShowPenaltyPct) : null;
                const penaltyFlat = booking.noShowPenaltyUsdc ? Number(booking.noShowPenaltyUsdc) : null;
                if (penaltyPct || penaltyFlat) {
                    await splitReleaseFundedEscrow(prisma, {
                        escrowId: booking.escrowId,
                        penaltyPct,
                        penaltyFlatUsdc: penaltyFlat,
                        reason: 'Business-initiated transit no-show',
                        bookingType: 'TRANSIT',
                        bookingId: booking.id,
                    });
                    // splitReleaseFundedEscrow atomically moved the booking to
                    // NO_SHOW with the penalty applied — re-read and return.
                    const splitUpdated = await prisma.transitBooking.findUnique({
                        where: { id: booking.id },
                        include: {
                            vehicle: { select: { id: true, type: true, make: true, model: true, licensePlate: true, driverName: true } },
                            businessProfile: { select: { id: true, businessName: true } }
                        }
                    });
                    if (io) {
                        io.to(`user_${booking.customerId}`).emit('transit_booking_update', splitUpdated);
                        if (booking.businessProfile.userId !== booking.customerId) {
                            io.to(`user_${booking.businessProfile.userId}`).emit('transit_booking_update', splitUpdated);
                        }
                    }
                    return res.status(200).json({ success: true, booking: splitUpdated });
                }
            }
        }

        const updateData = { status: nextStatus };
        if (nextStatus === 'CONFIRMED' && !booking.pickupTime) {
            updateData.pickupTime = new Date();
        }
        if (nextStatus === 'COMPLETED') {
            updateData.dropoffTime = new Date();
        }
        if (nextStatus === 'NO_SHOW') {
            updateData.driverNote = driverNote || null;
        }

        const updated = await prisma.transitBooking.update({
            where: { id },
            data: updateData,
            include: {
                vehicle: { select: { id: true, type: true, make: true, model: true, licensePlate: true, driverName: true } },
                businessProfile: { select: { id: true, businessName: true } }
            }
        });

        // Real-time notification to both parties
        if (io) {
            io.to(`user_${booking.customerId}`).emit('transit_booking_update', updated);
            if (booking.businessProfile.userId !== booking.customerId) {
                io.to(`user_${booking.businessProfile.userId}`).emit('transit_booking_update', updated);
            }
        }

        return res.status(200).json({ success: true, booking: updated });
    } catch (err) {
        logger.error({ err: err }, '[transit.updateBookingStatus] error');
        return res.status(500).json({ success: false, message: err.message });
    }
};

// GET /api/transit/bookings/:id/checkin-qr
// The service contract is (prisma, { bookingId, customerId }). The previous
// call passed (bookingId, userId) and therefore threw "bookingId is required"
// on every request: this route could never issue a QR.
exports.generateTransitCheckInQR = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const bookingId = req.params.id;
        const svc = require('../services/qrCheckInService');

        const booking = await prisma.transitBooking.findUnique({ where: { id: bookingId } });
        if (!booking) {
            return res.status(404).json({ success: false, message: 'Booking not found.' });
        }
        if (booking.customerId !== userId) {
            return res.status(403).json({ success: false, message: 'Not authorized.' });
        }
        if (booking.status !== 'CONFIRMED') {
            // A QR only exists to claim the CONFIRMED -> IN_PROGRESS transition,
            // so issuing one for any other state would be a dead code.
            return res.status(409).json({
                success: false,
                message: `Booking must be CONFIRMED to generate QR (current: ${booking.status}).`,
            });
        }

        const tokenData = await svc.generateTransitCheckInToken(prisma, { bookingId, customerId: userId });
        return res.status(200).json({ success: true, ...tokenData });
    } catch (err) {
        if (err && err.code && String(err.code).startsWith('QR_SIGNING_KEY')) {
            // Fail closed as an availability problem, not a client error, and
            // never echo the key or its value.
            logger.error({ code: err.code }, '[transit.generateTransitCheckInQR] signing key unavailable');
            return res.status(503).json({ success: false, code: err.code, message: 'QR check-in is temporarily unavailable.' });
        }
        logger.error({ err: err }, '[transit.generateTransitCheckInQR] error');
        return res.status(400).json({ success: false, message: err.message });
    }
};

// POST /api/transit/boarding
// The QR string is a SIGNED TOKEN, never a booking id. The previous call
// handed it to transitCheckIn as if it were one, so the signature, the
// expiry, the customer binding and the business binding were all bypassed.
exports.transitBoarding = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const token = req.body.token || req.body.code; // `code` kept for older clients
        if (!token) {
            return res.status(400).json({ success: false, message: 'QR code is required.' });
        }

        const svc = require('../services/qrCheckInService');
        const result = await svc.verifyTransitTokenAndBoard(prisma, { token, businessUserId: userId });
        return res.status(200).json(result);
    } catch (err) {
        if (err && err.code && String(err.code).startsWith('QR_SIGNING_KEY')) {
            logger.error({ code: err.code }, '[transit.transitBoarding] signing key unavailable');
            return res.status(503).json({ success: false, code: err.code, message: 'QR check-in is temporarily unavailable.' });
        }
        if (err && err.name === 'QrTokenError') {
            // A rejected token is a client problem; it must not surface as 500.
            // A token that was already consumed is a conflict, not a bad
            // request: the caller's QR was valid, the booking just moved on.
            const status = err.code === 'QR_TOKEN_ALREADY_USED' ? 409 : 400;
            return res.status(status).json({ success: false, code: err.code, message: err.message });
        }
        logger.error({ err: err }, '[transit.transitBoarding] error');
        return res.status(400).json({ success: false, message: err.message });
    }
};
