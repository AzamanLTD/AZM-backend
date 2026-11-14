// services/qrCheckInService.js
// =============================================================================
// AZAMAN — QR CHECK-IN SERVICE
//
// Generates and verifies HMAC-signed, expiring QR tokens for reservation and
// transit check-in. Two entry paths for businesses:
//   1. Scan QR code (contains a signed token)
//   2. Search by AZM-ID / booking id (manual fallback when the scanner is
//      down) — never carries a token and never trusts a QR string as an id.
//
// SIGNING KEY
// -----------
// Tokens are signed with the DEDICATED QR_CHECKIN_SIGNING_KEY, never with the
// authentication JWT secret. There is no fallback of any kind: if the key is
// absent or carries fewer than 32 bytes of key material, both issuance and
// verification fail closed in every environment, and production refuses to
// boot (server.js). Introducing or rotating the key therefore invalidates
// every token signed before it, which is the intended behaviour: a QR lives at
// most 30 minutes, so the blast radius of a rotation is one token lifetime and
// the customer simply regenerates their code.
//
// TOKEN CONTRACT
// --------------
//   <base64url(JSON payload)>.<64 hex chars of HMAC-SHA256>
//
//   Reservation: typ='RESERVATION_CHECKIN', rid, ref, cid, azm, jti, iat, exp
//   Transit:     typ='TRANSIT_CHECKIN', bid, tid, dep, cid, seats, jti, iat, exp
//
//   exp - iat <= 30 minutes, always. exp is additionally capped by the
//   reservation's end time or by the transit boarding window (+60 min), so a
//   token can never outlive the visit or the gate it authorises.
//
// ONE-USE
// -------
// Both check-in paths claim the record with a CONDITIONAL update (reservation:
// CONFIRMED -> CHECKED_IN through the r29 lifecycle authority; transit booking:
// CONFIRMED -> IN_PROGRESS). PostgreSQL arbitrates concurrent claims on the row
// itself, so exactly one request performs the transition and every later use of
// the same QR is refused. `jti` is generated for correlation and for a future
// durable consumption record, but it is NOT yet a durable one-use ledger: no
// table stores consumed JTIs without a schema change. docs/qr-checkin-security.md
// states exactly what is and is not proven.
// =============================================================================

const crypto = require('crypto');

const KEY_ENV = 'QR_CHECKIN_SIGNING_KEY';
const MIN_KEY_BYTES = 32;
const TOKEN_TTL_MINUTES = 30;
const TOKEN_TTL_MS = TOKEN_TTL_MINUTES * 60 * 1000;
const TRANSIT_WINDOW_MS = 60 * 60 * 1000; // +/- 1h around departure
const SIGNATURE_RE = /^[0-9a-f]{64}$/;

// ── Errors ───────────────────────────────────────────────────────────────────

class QrSigningKeyError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'QrSigningKeyError';
        this.code = code;
    }
}

class QrTokenError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'QrTokenError';
        this.code = code;
    }
}

// ── Signing key ──────────────────────────────────────────────────────────────

/**
 * Validate a candidate signing key without ever echoing its value.
 *
 * Byte length is measured with Buffer.byteLength, not String#length: HMAC
 * consumes bytes, so a 20-character key of 2-byte codepoints must not pass a
 * "32 characters" rule that says nothing about the key material actually used.
 *
 * @param {unknown} value
 * @returns {{ ok: boolean, code?: string, message?: string, bytes?: number }}
 */
const validateSigningKey = (value) => {
    if (typeof value !== 'string' || value.length === 0) {
        return {
            ok: false,
            code: 'QR_SIGNING_KEY_MISSING',
            message: KEY_ENV + ' is not set. QR check-in is disabled until a dedicated signing key is configured.',
        };
    }
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes < MIN_KEY_BYTES) {
        return {
            ok: false,
            code: 'QR_SIGNING_KEY_TOO_SHORT',
            message: KEY_ENV + ' must provide at least ' + MIN_KEY_BYTES + ' bytes of key material (got ' + bytes + '). QR check-in is disabled.',
        };
    }
    return { ok: true, bytes };
};

/** Resolve the dedicated key or throw. Never logs, never returns a default. */
const signingKey = () => {
    const verdict = validateSigningKey(process.env[KEY_ENV]);
    if (!verdict.ok) throw new QrSigningKeyError(verdict.code, verdict.message);
    return process.env[KEY_ENV];
};

/** True when QR check-in can sign or verify at all. */
const isConfigured = () => validateSigningKey(process.env[KEY_ENV]).ok;

// ── Token primitives ─────────────────────────────────────────────────────────

const _sign = (payloadStr) => crypto.createHmac('sha256', signingKey()).update(payloadStr).digest('hex');

const _encodeToken = (payload) => {
    const payloadStr = JSON.stringify(payload);
    return Buffer.from(payloadStr).toString('base64url') + '.' + _sign(payloadStr);
};

/**
 * Verify structure, signature, type, lifetime and expiry.
 *
 * The key is resolved FIRST, so a missing key fails closed identically for a
 * well-formed and a malformed token.
 *
 * @param {string} token
 * @param {string} expectedType
 * @param {{ now?: number }} [opts] deterministic clock seam for tests
 * @returns {object} the verified payload
 */
const _verifyToken = (token, expectedType, { now = Date.now() } = {}) => {
    const key = signingKey(); // fail closed before parsing anything

    if (typeof token !== 'string' || token.trim().length === 0) {
        throw new QrTokenError('QR_TOKEN_REQUIRED', 'Token is required.');
    }
    const parts = token.split('.');
    if (parts.length !== 2) throw new QrTokenError('QR_TOKEN_MALFORMED', 'Invalid token format.');

    const body = parts[0];
    const signature = parts[1];
    // Fixed-length hex check BEFORE any Buffer conversion. The HMAC output is
    // 32 bytes, so a 63- or 65-character signature is malformed by definition.
    // Without this guard timingSafeEqual throws a RangeError on unequal buffer
    // lengths and a bad scan becomes an uncontrolled 500.
    if (!SIGNATURE_RE.test(signature)) {
        throw new QrTokenError('QR_TOKEN_MALFORMED', 'Invalid token signature.');
    }

    const payloadStr = Buffer.from(body, 'base64url').toString('utf8');
    let payload;
    try {
        payload = JSON.parse(payloadStr);
    } catch {
        throw new QrTokenError('QR_TOKEN_MALFORMED', 'Invalid token payload.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new QrTokenError('QR_TOKEN_MALFORMED', 'Invalid token payload.');
    }

    const expected = crypto.createHmac('sha256', key).update(payloadStr).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
        throw new QrTokenError('QR_TOKEN_SIGNATURE_INVALID', 'Invalid token signature.');
    }

    if (expectedType && payload.typ !== expectedType) {
        throw new QrTokenError('QR_TOKEN_WRONG_TYPE', 'This QR code is not valid for this check-in.');
    }

    const iat = payload.iat;
    const exp = payload.exp;
    if (!Number.isFinite(iat) || !Number.isFinite(exp)) {
        throw new QrTokenError('QR_TOKEN_MALFORMED', 'Invalid token lifetime.');
    }
    // The 30-minute ceiling is asserted at VERIFY time, not only at issue time:
    // a token whose lifetime was inflated by a future bug, a skewed clock or a
    // hand-rolled signer is refused instead of honoured.
    if (exp - iat > TOKEN_TTL_MS) {
        throw new QrTokenError(
            'QR_TOKEN_TTL_INVALID',
            'QR codes may not be valid for more than ' + TOKEN_TTL_MINUTES + ' minutes.'
        );
    }
    if (now > exp) {
        throw new QrTokenError('QR_TOKEN_EXPIRED', 'Token has expired. Please ask the customer to regenerate their QR code.');
    }
    if (now < iat) {
        throw new QrTokenError('QR_TOKEN_NOT_YET_VALID', 'Token is not valid yet.');
    }

    return payload;
};

// =============================================================================
// 1. GENERATE CHECK-IN TOKEN — customer-side, shows QR on their phone.
// =============================================================================
const generateCheckInToken = async (prisma, { reservationId, customerId, now = Date.now() }) => {
    if (!reservationId) throw new Error('reservationId is required.');
    if (!customerId) throw new Error('customerId is required.');
    signingKey(); // fail closed before touching the database

    const reservation = await prisma.reservation.findUnique({
        where: { id: reservationId },
        include: { customer: { select: { id: true, azamanId: true, username: true } } }
    });
    if (!reservation) throw new Error('Reservation not found.');
    if (reservation.customerId !== customerId) throw new Error('Not authorized — this is not your reservation.');

    if (reservation.status === 'CHECKED_IN') {
        throw new Error('Already checked in.');
    }
    if (reservation.status !== 'CONFIRMED') {
        throw new Error(`Reservation must be CONFIRMED to check in (current: ${reservation.status}).`);
    }

    const windowEnd = reservation.endDatetime ? new Date(reservation.endDatetime).getTime() : null;
    if (windowEnd !== null && now > windowEnd) {
        throw new Error('This reservation has already ended — check-in is closed.');
    }

    // exp never exceeds 30 minutes and never outlives the reservation itself.
    const expiresAt = windowEnd !== null
        ? Math.min(now + TOKEN_TTL_MS, windowEnd)
        : now + TOKEN_TTL_MS;

    const azamanId = reservation.customer.azamanId || 'AZM-UNKNOWN';
    const payload = {
        typ: 'RESERVATION_CHECKIN',
        rid: reservation.id,
        ref: reservation.reservationRef,
        cid: customerId,
        azm: azamanId,
        jti: crypto.randomUUID(),
        iat: now,
        exp: expiresAt,
    };

    const token = _encodeToken(payload);

    return {
        token,
        jti: payload.jti,
        qrPayload: JSON.stringify({ token, type: 'AZAMAN_CHECKIN' }),
        azamanId,
        reservationRef: reservation.reservationRef,
        expiresAt: new Date(expiresAt),
        businessName: null, // populated by controller from businessProfile
    };
};

// =============================================================================
// 2. VERIFY CHECK-IN TOKEN — business-side, after scanning the QR.
//    Validates signature + lifetime + expiry + bindings + business ownership,
//    then performs a ONE-USE check-in through the r29 lifecycle authority.
// =============================================================================
const verifyAndCheckIn = async (prisma, { token, businessUserId, now = Date.now() }) => {
    if (!businessUserId) throw new Error('businessUserId is required.');

    const payload = _verifyToken(token, 'RESERVATION_CHECKIN', { now });
    if (!payload.rid || !payload.cid) {
        throw new QrTokenError('QR_TOKEN_MALFORMED', 'Invalid token payload.');
    }

    const reservation = await prisma.reservation.findUnique({
        where: { id: payload.rid },
        include: { businessProfile: true }
    });
    if (!reservation) throw new Error('Reservation not found.');

    if (!reservation.businessProfile || reservation.businessProfile.userId !== businessUserId) {
        throw new Error('This reservation does not belong to your business.');
    }
    if (reservation.customerId !== payload.cid) {
        throw new Error('Token customer does not match reservation.');
    }
    if (payload.ref && reservation.reservationRef !== payload.ref) {
        throw new Error('Token does not match this reservation.');
    }
    if (reservation.endDatetime && now > new Date(reservation.endDatetime).getTime()) {
        throw new Error('This reservation has already ended — check-in is closed.');
    }
    if (reservation.status === 'CHECKED_IN') {
        // A one-use QR is refused on reuse. The convergent/idempotent behaviour
        // stays available to the manual path only.
        throw new QrTokenError(
            'QR_TOKEN_ALREADY_USED',
            'This QR code has already been used to check in. Ask the customer to show a new one.'
        );
    }
    if (reservation.status !== 'CONFIRMED') {
        throw new Error(`Reservation is ${reservation.status}, cannot check in.`);
    }

    // r29: QR and direct check-in share the same atomic lifecycle boundary.
    // requireFreshClaim makes the QR path strict: the loser of a concurrent
    // pair is refused instead of being converged into a success.
    const { checkInReservation } = require('./reservationLifecycleService');
    try {
        await checkInReservation(prisma, {
            reservationId: reservation.id,
            businessUserId,
            requireFreshClaim: true,
        });
    } catch (err) {
        if (err && err.code === 'RESERVATION_ALREADY_CHECKED_IN') {
            throw new QrTokenError(
                'QR_TOKEN_ALREADY_USED',
                'This QR code has already been used to check in. Ask the customer to show a new one.'
            );
        }
        throw err;
    }

    const updated = await prisma.reservation.findUnique({
        where: { id: reservation.id },
        include: {
            customer: { select: { id: true, username: true, azamanId: true, profilePictureUrl: true } },
            businessProfile: { select: { id: true, businessName: true } }
        }
    });

    return { success: true, reservation: updated, customerAzamanId: payload.azm, jti: payload.jti };
};

// =============================================================================
// 3. SEARCH BY AZAMAN-ID — manual fallback when the scanner is down.
// =============================================================================
const searchByAzamanId = async (prisma, { azamanId, businessUserId }) => {
    if (!azamanId) throw new Error('azamanId is required.');
    if (!businessUserId) throw new Error('businessUserId is required.');

    const profile = await prisma.businessProfile.findFirst({ where: { userId: businessUserId } });
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
        include: {}
    });

    return { customer, reservations };
};

// =============================================================================
// 4. TRANSIT — manual check-in by booking id (staff fallback, no token).
//    Business-scoped and conditionally claimed; never trusts a QR string.
// =============================================================================
const transitCheckIn = async (prisma, { bookingId, businessUserId }) => {
    if (!bookingId) throw new Error('bookingId is required.');
    if (!businessUserId) throw new Error('businessUserId is required.');
    if (typeof bookingId !== 'string' || /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/.test(bookingId)) {
        // A QR token is not an id. Refuse explicitly instead of handing the
        // token to the database and reporting "booking not found".
        throw new Error('This endpoint checks in by booking id. Scan the QR code through the boarding endpoint.');
    }

    const booking = await prisma.transitBooking.findUnique({
        where: { id: bookingId },
        include: { businessProfile: true }
    });
    if (!booking) throw new Error('Transit booking not found.');
    if (!booking.businessProfile || booking.businessProfile.userId !== businessUserId) {
        throw new Error('This booking does not belong to your business.');
    }
    if (booking.status !== 'CONFIRMED') {
        throw new Error(`Booking is ${booking.status}, cannot check in.`);
    }

    const claimed = await prisma.transitBooking.updateMany({
        where: { id: bookingId, status: 'CONFIRMED' },
        data: { status: 'IN_PROGRESS', checkedInAt: new Date() },
    });
    if (claimed.count !== 1) {
        const current = await prisma.transitBooking.findUnique({ where: { id: bookingId }, select: { status: true } });
        throw new Error(`Booking is ${current ? current.status : 'UNKNOWN'}, cannot check in.`);
    }

    const updated = await prisma.transitBooking.findUnique({ where: { id: bookingId } });
    return { success: true, booking: updated };
};

// =============================================================================
// 5. GENERATE TRANSIT CHECK-IN TOKEN — customer-side, shows QR for transit.
// =============================================================================
const generateTransitCheckInToken = async (prisma, { bookingId, customerId, now = Date.now() }) => {
    if (!bookingId) throw new Error('bookingId is required.');
    if (!customerId) throw new Error('customerId is required.');
    signingKey(); // fail closed before touching the database

    const booking = await prisma.transitBooking.findFirst({
        where: { id: bookingId, customerId },
        include: {
            trip: { select: { id: true, origin: true, destination: true, departureAt: true } },
            seats: { select: { seatId: true, passengerName: true } },
        },
    });
    if (!booking) throw new Error('Transit booking not found for this customer.');
    if (booking.status !== 'CONFIRMED') throw new Error(`Booking is ${booking.status}, cannot generate QR.`);
    if (!booking.trip || !booking.trip.departureAt) {
        throw new Error('This booking is not attached to a scheduled trip, so there is no boarding window.');
    }

    const departure = new Date(booking.trip.departureAt).getTime();
    const validFrom = departure - TRANSIT_WINDOW_MS;
    const validUntil = departure + TRANSIT_WINDOW_MS;
    if (now < validFrom) {
        throw new Error(`QR code will be valid 1 hour before departure (${new Date(validFrom).toISOString()}).`);
    }
    if (now > validUntil) {
        throw new Error('QR code has expired — the boarding window has closed.');
    }

    // Never longer than the boarding window, never longer than 30 minutes.
    const exp = Math.min(now + TOKEN_TTL_MS, validUntil);

    const payload = {
        typ: 'TRANSIT_CHECKIN',
        bid: booking.id,
        tid: booking.tripId,
        dep: departure,
        cid: customerId,
        seats: booking.seats.map((s) => s.seatId),
        jti: crypto.randomUUID(),
        iat: now,
        exp,
    };

    const token = _encodeToken(payload);

    return {
        token,
        jti: payload.jti,
        qrData: token,
        qrPayload: JSON.stringify({ token, type: 'AZAMAN_TRANSIT_CHECKIN' }),
        booking: {
            id: booking.id,
            trip: booking.trip,
            seats: booking.seats,
            status: booking.status,
        },
        validFrom: new Date(validFrom),
        validUntil: new Date(validUntil),
        expiresAt: new Date(exp),
    };
};

// =============================================================================
// 6. VERIFY TRANSIT TOKEN AND BOARD — business-side QR path.
// =============================================================================
const verifyTransitTokenAndBoard = async (prisma, { token, businessUserId, now = Date.now() }) => {
    if (!businessUserId) throw new Error('businessUserId is required.');

    const payload = _verifyToken(token, 'TRANSIT_CHECKIN', { now });
    if (!payload.bid || !payload.cid || !Number.isFinite(payload.dep)) {
        throw new QrTokenError('QR_TOKEN_MALFORMED', 'Invalid token payload.');
    }

    const validFrom = payload.dep - TRANSIT_WINDOW_MS;
    const validUntil = payload.dep + TRANSIT_WINDOW_MS;
    if (now < validFrom) {
        throw new QrTokenError('QR_TOKEN_NOT_YET_VALID', 'Boarding has not opened for this trip yet.');
    }
    if (now > validUntil) {
        throw new QrTokenError('QR_TOKEN_WINDOW_CLOSED', 'The boarding window for this trip has closed.');
    }

    const booking = await prisma.transitBooking.findUnique({
        where: { id: payload.bid },
        include: { businessProfile: true }
    });
    if (!booking) throw new Error('Transit booking not found.');
    if (!booking.businessProfile || booking.businessProfile.userId !== businessUserId) {
        throw new Error('This booking does not belong to your business.');
    }
    if (booking.customerId !== payload.cid) {
        throw new Error('Token customer does not match booking.');
    }
    if (booking.tripId !== payload.tid) {
        throw new Error('Token does not match this booking trip.');
    }
    if (booking.status === 'IN_PROGRESS') {
        throw new QrTokenError(
            'QR_TOKEN_ALREADY_USED',
            'This QR code has already been used to board. Ask the customer to show a new one.'
        );
    }
    if (booking.status !== 'CONFIRMED') {
        throw new Error(`Booking is ${booking.status}, cannot check in.`);
    }

    // Conditional claim: PostgreSQL's row lock arbitrates two concurrent scans.
    const claimed = await prisma.transitBooking.updateMany({
        where: { id: booking.id, status: 'CONFIRMED' },
        data: { status: 'IN_PROGRESS', checkedInAt: new Date(now), pickupTime: new Date(now) },
    });
    if (claimed.count !== 1) {
        const current = await prisma.transitBooking.findUnique({
            where: { id: booking.id },
            select: { status: true },
        });
        if (current && current.status === 'IN_PROGRESS') {
            throw new QrTokenError(
                'QR_TOKEN_ALREADY_USED',
                'This QR code has already been used to board. Ask the customer to show a new one.'
            );
        }
        throw new Error(`Booking is ${current ? current.status : 'UNKNOWN'}, cannot check in.`);
    }

    const updated = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
    return { success: true, booking: updated, jti: payload.jti };
};

module.exports = {
    generateCheckInToken,
    generateTransitCheckInToken,
    verifyAndCheckIn,
    verifyTransitTokenAndBoard,
    searchByAzamanId,
    transitCheckIn,
    validateSigningKey,
    isConfigured,
    QrSigningKeyError,
    QrTokenError,
    TOKEN_TTL_MINUTES,
    MIN_KEY_BYTES,
    KEY_ENV,
};
