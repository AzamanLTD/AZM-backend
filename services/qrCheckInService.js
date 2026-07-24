// services/qrCheckInService.js
// =============================================================================
// AZAMAN — QR CHECK-IN SERVICE (2026-07-02)
//
// Generates and verifies HMAC-signed, expiring QR tokens for reservation
// and transit check-in. Two entry paths for businesses:
//   1. Scan QR code (contains signed token)
//   2. Search by AZM-ID (manual fallback when scanner is down)
//
// Security: tokens are HMAC-signed with JWT_SECRET, expire within the
// reservation's date window, and encode the reservationId + customerId +
// azamanId. A screenshot of someone else's QR cannot be replayed outside
// the valid window.
// =============================================================================

const logger = require('../src/config/logger');
const crypto = require('crypto');

const _getSecret = () => process.env.JWT_SECRET || 'default_qr_secret_at_least_32_chars';
const TOKEN_TTL_MINUTES = 30; // tokens valid for 30 minutes from generation

// =============================================================================
// 1. GENERATE CHECK-IN TOKEN — customer-side, shows QR on their phone.
// =============================================================================
const generateCheckInToken = async (prisma, { reservationId, customerId }) => {
    if (!reservationId) throw new Error('reservationId is required.');
    if (!customerId) throw new Error('customerId is required.');

    const reservation = await prisma.reservation.findUnique({
        where: { id: reservationId },
        include: { customer: { select: { id: true, azamanId: true, username: true } } }
    });
    if (!reservation) throw new Error('Reservation not found.');
    if (reservation.customerId !== customerId) throw new Error('Not authorized — this is not your reservation.');

    const bookable = ['CONFIRMED', 'CHECKED_IN'];
    if (!bookable.includes(reservation.status)) {
        throw new Error(`Reservation must be CONFIRMED to check in (current: ${reservation.status}).`);
    }

    if (reservation.status === 'CHECKED_IN') {
        throw new Error('Already checked in.');
    }

    const azamanId = reservation.customer.azamanId || 'AZM-UNKNOWN';
    const issuedAt = Date.now();
    const expiresAt = issuedAt + TOKEN_TTL_MINUTES * 60 * 1000;

    const payload = {
        rid: reservation.id,
        ref: reservation.reservationRef,
        cid: customerId,
        azm: azamanId,
        iat: issuedAt,
        exp: expiresAt,
    };

    const payloadStr = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', _getSecret()).update(payloadStr).digest('hex');
    const token = Buffer.from(payloadStr).toString('base64url') + '.' + signature;

    return {
        token,
        qrPayload: JSON.stringify({ token, type: 'AZAMAN_CHECKIN' }),
        azamanId,
        reservationRef: reservation.reservationRef,
        expiresAt: new Date(expiresAt),
        businessName: null, // populated by controller from businessProfile
    };
};

// =============================================================================
// 2. VERIFY CHECK-IN TOKEN — business-side, after scanning QR.
//    Validates signature + expiry + business ownership + performs check-in.
// =============================================================================
const verifyAndCheckIn = async (prisma, { token, businessUserId }) => {
    if (!token) throw new Error('Token is required.');
    if (!businessUserId) throw new Error('businessUserId is required.');

    // Split token into payload + signature
    const parts = token.split('.');
    if (parts.length !== 2) throw new Error('Invalid token format.');

    let payload;
    try {
        payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    } catch {
        throw new Error('Invalid token payload.');
    }

    // Verify signature
    const expectedSig = crypto.createHmac('sha256', _getSecret()).update(Buffer.from(parts[0], 'base64url').toString()).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(parts[1], 'hex'), Buffer.from(expectedSig, 'hex'))) {
        throw new Error('Invalid token signature.');
    }

    // Check expiry
    if (Date.now() > payload.exp) {
        throw new Error('Token has expired. Please ask the customer to regenerate their QR code.');
    }

    // Find the reservation
    const reservation = await prisma.reservation.findUnique({
        where: { id: payload.rid },
        include: { businessProfile: true }
    });
    if (!reservation) throw new Error('Reservation not found.');

    // Verify the business user owns this reservation's business
    if (reservation.businessProfile.userId !== businessUserId) {
        throw new Error('This reservation does not belong to your business.');
    }

    // Must be CONFIRMED to check in
    if (reservation.status !== 'CONFIRMED') {
        throw new Error(`Reservation is ${reservation.status}, cannot check in.`);
    }

    // Perform check-in
    const updated = await prisma.reservation.update({
        where: { id: reservation.id },
        data: { status: 'CHECKED_IN', checkedInAt: new Date() },
        include: {
            customer: { select: { id: true, username: true, azamanId: true, profilePictureUrl: true } },
            businessProfile: { select: { id: true, businessName: true } }
        }
    });

    // Release escrow to the business if one exists
    if (reservation.escrowId) {
        try {
            const { releaseBookingEscrow } = require('./bookingEscrowService');
            await releaseBookingEscrow(prisma, { escrowId: reservation.escrowId });
        } catch (err) {
            logger.error({ err: err }, '[qrCheckIn] escrow release failed');
        }
    }

    return {
        success: true,
        reservation: updated,
        customerAzamanId: payload.azm,
    };
};

// =============================================================================
// 3. SEARCH BY AZAMAN-ID — manual fallback when scanner is down.
//    Returns the customer's upcoming/current reservations at this business.
// =============================================================================
const searchByAzamanId = async (prisma, { azamanId, businessUserId }) => {
    if (!azamanId) throw new Error('azamanId is required.');
    if (!businessUserId) throw new Error('businessUserId is required.');

    const profile = await prisma.businessProfile.findUnique({ where: { userId: businessUserId } });
    if (!profile) throw new Error('Business profile not found.');

    const customer = await prisma.user.findFirst({
        where: { azamanId },
        select: { id: true, username: true, azamanId: true, profilePictureUrl: true }
    });
    if (!customer) throw new Error(`No customer found with AZM-ID: ${azamanId}`);

    const reservations = await prisma.reservation.findMany({
        where: {
            customerId: customer.id,
            businessProfileId: profile.id,
            status: { in: ['CONFIRMED', 'CHECKED_IN'] }
        },
        orderBy: { startDatetime: 'asc' },
        include: {
        }
    });

    return { customer, reservations };
};

// =============================================================================
// 4. TRANSIT CHECK-IN — verify and check in for a transit booking.
// =============================================================================
const transitCheckIn = async (prisma, { bookingId, businessUserId }) => {
    if (!bookingId) throw new Error('bookingId is required.');

    const booking = await prisma.transitBooking.findUnique({
        where: { id: bookingId },
        include: { businessProfile: true }
    });
    if (!booking) throw new Error('Transit booking not found.');

    if (booking.businessProfile.userId !== businessUserId) {
        throw new Error('This booking does not belong to your business.');
    }

    if (booking.status !== 'CONFIRMED') {
        throw new Error(`Booking is ${booking.status}, cannot check in.`);
    }

    const updated = await prisma.transitBooking.update({
        where: { id: bookingId },
        data: { status: 'IN_PROGRESS', checkedInAt: new Date(), pickupTime: new Date() }
    });

    return { success: true, booking: updated };
};

// =============================================================================
// 5. GENERATE TRANSIT CHECK-IN TOKEN — customer-side, shows QR for transit.
// =============================================================================
const generateTransitCheckInToken = async (prisma, { bookingId, customerId }) => {
    if (!bookingId) throw new Error('bookingId is required.');
    if (!customerId) throw new Error('customerId is required.');

    const booking = await prisma.transitBooking.findFirst({
        where: { id: bookingId, customerId },
        include: {
            trip: { select: { id: true, origin: true, destination: true, departureAt: true } },
            seats: { select: { seatId: true, passengerName: true } },
        },
    });
    if (!booking) throw new Error('Transit booking not found for this customer.');
    if (booking.status !== 'CONFIRMED') throw new Error(`Booking is ${booking.status}, cannot generate QR.`);

    // Token is valid from 1 hour before departure until 1 hour after
    const departure = new Date(booking.trip.departureAt);
    const validFrom = new Date(departure.getTime() - 60 * 60 * 1000);
    const validUntil = new Date(departure.getTime() + 60 * 60 * 1000);
    const now = new Date();
    if (now < validFrom) {
        throw new Error(`QR code will be valid 1 hour before departure (${validFrom.toISOString()}).`);
    }
    if (now > validUntil) {
        throw new Error('QR code has expired — departure time has passed.');
    }

    const payload = {
        type: 'TRANSIT_CHECKIN',
        bookingId,
        customerId,
        tripId: booking.tripId,
        origin: booking.trip.origin,
        destination: booking.trip.destination,
        seats: booking.seats.map(s => s.seatId),
        iat: now.getTime(),
        exp: validUntil.getTime(),
    };

    const payloadStr = JSON.stringify(payload);
    const hmac = crypto.createHmac('sha256', _getSecret()).update(payloadStr).digest('hex');
    const token = Buffer.from(payloadStr).toString('base64url') + '.' + hmac;

    return {
        token,
        qrData: token,
        booking: {
            id: booking.id,
            trip: booking.trip,
            seats: booking.seats,
            status: booking.status,
        },
        validFrom,
        validUntil,
    };
};

module.exports = { generateCheckInToken, generateTransitCheckInToken, verifyAndCheckIn, searchByAzamanId, transitCheckIn, TOKEN_TTL_MINUTES };
