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

const logger = require('../src/config/logger');
const crypto = require('crypto');

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
// 3. CANCEL TRANSIT BOOKING — cancel + refund escrow + free seats.
// =============================================================================
const cancelTransitBooking = async (prisma, { bookingId, cancelledBy }) => {
    const booking = await prisma.transitBooking.findUnique({
        where: { id: bookingId },
        include: { seats: true, trip: true, businessProfile: { select: { userId: true } } }
    });
    if (!booking) throw new Error('Booking not found.');

    // Authorization: only the booking customer or the business owner can cancel
    const isOwner = booking.businessProfile?.userId === cancelledBy;
    const isCustomer = booking.customerId === cancelledBy;
    if (!isOwner && !isCustomer) {
        throw new Error('Not authorized to cancel this booking.');
    }

    const cancellable = ['PENDING', 'CONFIRMED'];
    if (!cancellable.includes(booking.status)) {
        throw new Error(`Cannot cancel a booking with status ${booking.status}.`);
    }

    // Free the seats + cancel the booking atomically
    await prisma.$transaction(async (tx) => {
        // Delete seat assignments (frees them for others)
        if (booking.seats.length > 0) {
            await tx.transitBookingSeat.deleteMany({ where: { bookingId } });
        }

        // Increment available seats on the trip
        if (booking.tripId && booking.seats.length > 0) {
            await tx.transitTrip.update({
                where: { id: booking.tripId },
                data: { availableSeats: { increment: booking.seats.length } }
            });
        }

        // Cancel the booking
        await tx.transitBooking.update({
            where: { id: bookingId },
            data: { status: 'CANCELLED' }
        });
    });

    // Refund escrow if one exists
    let refundResult = null;
    if (booking.escrowId) {
        try {
            const { refundBookingEscrow } = require('./bookingEscrowService');
            refundResult = await refundBookingEscrow(prisma, { escrowId: booking.escrowId });
        } catch (err) {
            logger.error({ err: err }, '[transitBookingService.cancel] escrow refund failed');
        }
    }

    return { success: true, bookingId, refund: refundResult };
};

const _round6 = (n) => parseFloat(Number(n).toFixed(6));

module.exports = { bookSeats, getTripSeatAvailability, cancelTransitBooking };
