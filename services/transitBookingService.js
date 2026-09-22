// services/transitBookingService.js
// =============================================================================
// AZAMAN — TRANSIT SEAT BOOKING SERVICE (2026-07-02)
//
// Handles seat-safe transit booking with DB-level double-booking prevention.
// The @@unique([tripId, seatId]) constraint on TransitBookingSeat makes it
// STRUCTURALLY IMPOSSIBLE to double-book a seat — not just app-checked.
//
// Key operations:
//   - bookSeats: atomically reserve seats on a trip inside a $transaction
//   - getTripSeatAvailability: return occupied + available seats
//   - cancelTransitBooking: cancel + refund escrow + free seats
// =============================================================================

const crypto = require('crypto');
const { randomUUID } = require('crypto');
const logger = require('../src/config/logger');
// r28: the canonical escrow refund economic identity (same idempotency key,
// ledger entry and TransactionHistory row as every other escrow refund).
const { _refundBookingEscrowTx, REFUND_CLAIMABLE } = require('./bookingEscrowService');

const _genRef = () => 'TRN-' + crypto.randomBytes(4).toString('hex').toUpperCase();

// =============================================================================
// 1. BOOK SEATS — atomically reserve seats on a trip.
//    The DB unique constraint on [tripId, seatId] is the structural guarantee.
//    If two customers race for the same seat, the loser gets a P2002 error
//    which we catch and convert to a clean "seat already taken" message.
//    Loser's escrow is refunded automatically.
// =============================================================================
const bookSeats = async (prisma, {
    tripId, customerId, seatIds, passengerNames,
    customerNote, businessProfileId
}) => {
    if (!tripId) throw new Error('tripId is required.');
    if (!customerId) throw new Error('customerId is required.');
    if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
        throw new Error('seatIds must be a non-empty array.');
    }

    // 1. Load the trip + vehicle + seat map
    const trip = await prisma.transitTrip.findUnique({
        where: { id: tripId },
        include: {
            vehicle: { include: { seatMap: true } },
            businessProfile: { select: { id: true, userId: true, isSuspended: true } }
        }
    });
    if (!trip) throw new Error('Trip not found.');
    if (trip.status === 'CANCELLED') throw new Error('This trip has been cancelled.');
    if (trip.status === 'DEPARTED' || trip.status === 'COMPLETED') throw new Error('This trip has already departed.');
    if (trip.businessProfile.isSuspended) throw new Error('Business is suspended.');

    // 2. Validate seat IDs against the seat map
    if (!trip.vehicle?.seatMap) {
        throw new Error('This vehicle has no seat map configured.');
    }
    const layout = trip.vehicle.seatMap.layout;
    const validSeatIds = layout.map(s => s.seatId);
    const invalidSeats = seatIds.filter(id => !validSeatIds.includes(id));
    if (invalidSeats.length > 0) {
        throw new Error(`Invalid seat IDs: ${invalidSeats.join(', ')}.`);
    }

    // 3. Check seats aren't already booked (pre-check — the DB constraint is the real guard)
    const alreadyBooked = await prisma.transitBookingSeat.findMany({
        where: { tripId, seatId: { in: seatIds } },
        select: { seatId: true }
    });
    if (alreadyBooked.length > 0) {
        throw new Error(`Seats already booked: ${alreadyBooked.map(s => s.seatId).join(', ')}.`);
    }

    // 4. Check trip has enough available seats
    if (trip.availableSeats < seatIds.length) {
        throw new Error(`Only ${trip.availableSeats} seats available, requested ${seatIds.length}.`);
    }

    // 5. Calculate total fare — tier-aware. Each seat's tier (VIP/STANDARD/ECONOMY),
    //    tagged on the seat map layout, is priced from trip.metadata.tierFares if present,
    //    falling back to the flat trip.fareUsdc for untagged seats or trips with no tier pricing.
    const tierFares = (trip.metadata && trip.metadata.tierFares) || {};
    const seatByIdMap = new Map(layout.map(s => [s.seatId, s]));
    const perSeatFare = seatIds.map(seatId => {
        const seat = seatByIdMap.get(seatId);
        const tier = seat && seat.tier;
        const tierFare = tier && tierFares[tier] != null ? Number(tierFares[tier]) : null;
        return tierFare != null ? tierFare : Number(trip.fareUsdc);
    });
    const totalFare = _round6(perSeatFare.reduce((sum, f) => sum + f, 0));

    // 6. Create the booking + seats atomically
    const bookingRef = _genRef();
    let booking;
    try {
        booking = await prisma.$transaction(async (tx) => {
            // Create the booking
            const b = await tx.transitBooking.create({
                data: {
                    businessProfileId: trip.businessProfileId,
                    vehicleId: trip.vehicleId,
                    customerId,
                    tripId,
                    status: 'PENDING',
                    pickupAddress: trip.origin,
                    dropoffAddress: trip.destination,
                    scheduledAt: trip.departureAt,
                    amountUsdc: totalFare,
                    customerNote: customerNote || null,
                    bookingRef,
                }
            });

            // Create seat assignments — DB unique constraint is the structural guard
            const seatData = seatIds.map((seatId, i) => ({
                bookingId: b.id,
                tripId,
                seatId,
                passengerName: passengerNames?.[i] || null,
            }));
            await tx.transitBookingSeat.createMany({ data: seatData });

            // Decrement available seats
            await tx.transitTrip.update({
                where: { id: tripId },
                data: { availableSeats: { decrement: seatIds.length } }
            });

            return b;
        });
    } catch (err) {
        // P2002 = unique constraint violation — seat was raced by another customer
        if (err.code === 'P2002') {
            throw new Error('One or more seats were just booked by another customer. Please try again.');
        }
        throw err;
    }

    return { success: true, booking, seatIds, totalFare };
};

// =============================================================================
// 2. GET TRIP SEAT AVAILABILITY — returns occupied + available seats.
// =============================================================================
const getTripSeatAvailability = async (prisma, { tripId }) => {
    const trip = await prisma.transitTrip.findUnique({
        where: { id: tripId },
        include: { vehicle: { include: { seatMap: true } } }
    });
    if (!trip) throw new Error('Trip not found.');
    if (!trip.vehicle?.seatMap) {
        return { tripId, seats: [], availableCount: 0, totalSeats: 0 };
    }

    const layout = trip.vehicle.seatMap.layout;
    const bookedSeats = await prisma.transitBookingSeat.findMany({
        where: {
            tripId,
            booking: { status: { notIn: ['CANCELLED', 'NO_SHOW'] } }
        },
        select: { seatId: true }
    });
    const bookedSet = new Set(bookedSeats.map(s => s.seatId));
    const tierFares = (trip.metadata && trip.metadata.tierFares) || {};

    const seats = layout.map(seat => ({
        ...seat,
        status: bookedSet.has(seat.seatId) ? 'OCCUPIED' : 'AVAILABLE',
        fare: seat.tier && tierFares[seat.tier] != null ? Number(tierFares[seat.tier]) : Number(trip.fareUsdc),
    }));

    return {
        tripId,
        seats,
        availableCount: seats.filter(s => s.status === 'AVAILABLE').length,
        totalSeats: layout.length,
        tripStatus: trip.status,
        fareUsdc: trip.fareUsdc,
        tierFares,
    };
};

// =============================================================================
// 3. CANCEL TRANSIT BOOKING — the canonical, transactionally authoritative
//    transit booking cancellation (r28 / P0-C).
//
// Every legacy cancellation entry point now funnels here:
//   • DELETE /api/marketplace/transit/bookings/:id
//   • PATCH /api/transit/bookings/:id/status (status=CANCELLED)
//
// In ONE database transaction it atomically:
//   1. CAS-claims the booking out of the authoritative cancellable set
//      (PENDING | CONFIRMED) — a racing cancellation/no-show that moved the
//      booking first makes this claim lose, deterministically.
//   2. Releases the booking's seat assignments and restores the trip's
//      availableSeats.
//   3. Resolves the booking's escrow through the canonical r27 refund
//      economic identity (_refundBookingEscrowTx): escrow → REFUNDED, payer's
//      escrowLockedBalance drained back into availableBalance, ledger entry +
//      TransactionHistory posted, all in the same transaction.
//
// Failure honesty (the old implementation cancelled the booking + freed the
// seats in one transaction, then ran the refund AFTERWARDS and swallowed its
// errors — a textbook stranded-funds/false-success pattern): any refund or
// ledger failure now rolls back the ENTIRE operation. The booking stays in its
// prior state, seats and capacity are untouched, the escrow keeps its money,
// and the caller gets an explicit error.
//
// Disputed escrows stay in the dispute channel's custody (never economically
// mutated here); already-finalized escrows (REFUNDED/RELEASED/EXPIRED)
// receive no second economic mutation.
// =============================================================================

// The single authoritative cancellable set. NOTE: this intentionally unifies
// two contradictory contracts that previously coexisted — the controller's
// transition table admitted IN_PROGRESS -> CANCELLED while this service only
// cancelled PENDING/CONFIRMED. IN_PROGRESS rides are NOT cancellable (the
// ride already started); a funded IN_PROGRESS escrow resolves through the
// driver-completion or dispute path, never through cancellation.
const CANCELLABLE_STATUSES = ['PENDING', 'CONFIRMED'];
const ALREADY_FINALIZED_ESCROWS = ['REFUNDED', 'RELEASED', 'EXPIRED'];

class TransitCancellationError extends Error {
    constructor(code, message, httpStatus) {
        super(message);
        this.name = 'TransitCancellationError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

const cancelTransitBooking = async (prisma, { bookingId, cancelledBy, note } = {}) => {
    if (!bookingId) throw new TransitCancellationError('BAD_REQUEST', 'bookingId is required.', 400);

    const booking = await prisma.transitBooking.findUnique({
        where: { id: bookingId },
        include: {
            seats: true,
            businessProfile: { select: { userId: true } },
        },
    });
    if (!booking) {
        throw new TransitCancellationError('NOT_FOUND', 'Booking not found.', 404);
    }

    // Authorization: only the booking customer or the business owner can cancel.
    const isOwner = booking.businessProfile?.userId === cancelledBy;
    const isCustomer = booking.customerId === cancelledBy;
    if (!isOwner && !isCustomer) {
        throw new TransitCancellationError('FORBIDDEN', 'Not authorized to cancel this booking.', 403);
    }

    return prisma.$transaction(async (tx) => {
        // 1. CAS claim from the authoritative cancellable set. count 0 means a
        //    racing actor already moved the booking — re-read and converge.
        const claim = await tx.transitBooking.updateMany({
            where: { id: bookingId, status: { in: CANCELLABLE_STATUSES } },
            data: {
                status: 'CANCELLED',
                ...(note != null ? { driverNote: note } : {}),
            },
        });

        if (claim.count === 0) {
            const current = await tx.transitBooking.findUnique({
                where: { id: bookingId },
                select: { status: true },
            });
            if (current?.status === 'CANCELLED') {
                // Idempotent convergence: another cancellation already won.
                // Observe the resolved state — ZERO economic mutations here.
                return {
                    success: true,
                    alreadyCancelled: true,
                    bookingId,
                    refund: null,
                    booking: await tx.transitBooking.findUnique({
                        where: { id: bookingId },
                        include: {
                            vehicle: { select: { id: true, type: true, make: true, model: true, licensePlate: true, driverName: true } },
                            businessProfile: { select: { id: true, businessName: true } },
                        },
                    }),
                };
            }
            throw new TransitCancellationError(
                'NOT_CANCELLABLE',
                `Cannot cancel a booking with status ${current?.status}.`,
                409
            );
        }

        // 2. Seat release + capacity restore — only the claim winner reaches
        //    here, in the same transaction as the booking claim.
        if (booking.seats.length > 0) {
            await tx.transitBookingSeat.deleteMany({ where: { bookingId } });
            if (booking.tripId) {
                await tx.transitTrip.update({
                    where: { id: booking.tripId },
                    data: { availableSeats: { increment: booking.seats.length } },
                });
            }
        }

        // 3. Escrow resolution through the canonical refund economic identity
        //    (same tx). Any refund/ledger failure rolls back EVERYTHING above.
        let refund = null;
        if (booking.escrowId) {
            const escrow = await tx.smartEscrow.findUnique({ where: { id: booking.escrowId } });
            if (escrow && REFUND_CLAIMABLE.includes(escrow.status)) {
                const reference = randomUUID();
                await _refundBookingEscrowTx(tx, { escrowId: escrow.id, reference });
                refund = { outcome: 'REFUNDED', reference, amountUsdc: Number(escrow.amountUsdc) };
            } else if (escrow && escrow.status === 'DISPUTED') {
                // The dispute channel owns the money — never mutate it here.
                // Cancelling still removes the booking from the no-show
                // worker's CONFIRMED candidate set.
                refund = { outcome: 'ESCROW_DISPUTED' };
            } else if (escrow && ALREADY_FINALIZED_ESCROWS.includes(escrow.status)) {
                // Already resolved through the canonical contract — no second
                // economic mutation, honestly reported.
                refund = { outcome: 'ESCROW_ALREADY_FINALIZED', escrowStatus: escrow.status };
            } else if (escrow) {
                // DRAFT — escrow created but never funded; nothing is locked.
                refund = { outcome: 'NO_FUNDS', escrowStatus: escrow.status };
            }
        }

        return {
            success: true,
            alreadyCancelled: false,
            bookingId,
            refund,
            booking: await tx.transitBooking.findUnique({
                where: { id: bookingId },
                include: {
                    vehicle: { select: { id: true, type: true, make: true, model: true, licensePlate: true, driverName: true } },
                    businessProfile: { select: { id: true, businessName: true } },
                },
            }),
        };
    });
};

const _round6 = (n) => parseFloat(Number(n).toFixed(6));

module.exports = { bookSeats, getTripSeatAvailability, cancelTransitBooking, CANCELLABLE_STATUSES, TransitCancellationError };
