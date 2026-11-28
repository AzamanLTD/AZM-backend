// services/stayPaymentService.js
// =============================================================================
// AZAMAN — PAY FOR A HOTEL STAY FROM THE WALLET, HELD UNTIL CHECK-IN.
//
// A retry with the same Idempotency-Key returns the stay it already paid for
// before anything is re-priced (a retry after midnight or after a price
// change still finds its stay). Otherwise, one transaction:
//   1. take the business's booking lock, then the room row (the order walk-ins
//      and room moves use); two guests paying for the same room and dates are
//      serialized, and the second sees the first and is refused, charged
//      nothing;
//   2. re-check the room is free (status, blocks, overlapping active stays);
//   3. create the reservation;
//   4. create the booking escrow and fund it from the guest's wallet (price +
//      Azaman fee debited, price locked, fee realized, ledger posted). Funding
//      a reservation confirms it (bookingEscrowService), so a paid stay is a
//      confirmed booking and the guest has their check-in QR at once;
//   5. commit the wired idempotency claim with the response.
// Any failure (a short balance included) rolls all of it back.
//
// The money is released to the hotel when the guest checks in with their QR
// (reservationLifecycleService.checkInReservation, called by the QR path),
// within the paid-stay window (paidStayPolicy: from 24 hours before the
// check-in day to noon on the check-out day). The price is refunded (the
// Azaman fee is not) if the guest cancels before check-in, if the hotel
// cancels, or if the stay passes that window with no check-in (the no-show
// sweep). Staff cannot check a paid stay in by hand (QR_CHECKIN_REQUIRED),
// and its dates cannot be moved (PAID_DATES_FIXED): cancel and book again.
//
// The price is the server's per-night pricing (hotelPricingService), and the
// guest's approved total (the quote's price + fee) must match it exactly or
// nothing is charged (PRICE_CHANGED).
// =============================================================================

const crypto = require('crypto');
const logger = require('../src/config/logger');
const { Prisma } = require('@prisma/client');
const { startOfUtcDay, findNightlyRates } = require('./hotelPricingService');
const {
    bookingEscrowFee, _createBookingEscrowTx, _fundBookingEscrowTx, notifyBookingFunded,
} = require('./bookingEscrowService');
const { runDoubleCheck } = require('../utils/securityCheck');

const DAY_MS = 24 * 60 * 60 * 1000;
const FUNDED_EXPIRY_DAYS_DEFAULT = 30;
// The escrow outlives the stay: the expiry sweep never refunds a stay that
// has not ended (the no-show sweep decides an un-checked-in stay at its end).
const STAY_ESCROW_GRACE_DAYS = 7;
const MAX_STAY_NIGHTS = 60;
const ACTIVE_RESERVATION_STATUSES = ['PENDING', 'CONFIRMED', 'CHECKED_IN'];
// Money still held for the booking (not yet paid out or refunded).
const HELD_ESCROW_STATUSES = ['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT', 'DISPUTED', 'ADMIN_REVIEW'];
// The capacity trigger's advisory-lock namespace
// (infra/install-reservation-capacity-overlay.js).
const BOOKING_LOCK_NAMESPACE = 91731;

const _err = (code, message, httpStatus = 400) => Object.assign(new Error(message), { code, httpStatus });
const _round6 = (n) => parseFloat(Number(n).toFixed(6));
const _micros = (n) => BigInt(Math.round(Number(n) * 1e6));

// The approved total as exact micro-USDC, or null if it is not an exact
// decimal with at most 6 places (a JSON number must already be exact).
const _approvedMicros = (value) => {
    const text = typeof value === 'number' && Number.isFinite(value)
        ? (Number(value.toFixed(6)) === value ? value.toFixed(6) : null)
        : (typeof value === 'string' ? value.trim() : null);
    if (text == null || !/^\d+(\.\d{1,6})?$/.test(text)) return null;
    const [whole, frac = ''] = text.split('.');
    return BigInt(whole) * 1000000n + BigInt((frac + '000000').slice(0, 6));
};
const _microsText = (m) => `${m / 1000000n}.${(m % 1000000n).toString().padStart(6, '0')}`;

/**
 * Price a stay the way the paid booking will charge it.
 * @returns {{ business, room, checkInDay, checkOutDay, guests, nightly, amountUsdc, feeUsdc, totalUsdc, settings }}
 */
const priceStay = async (prisma, { bizId, roomId, checkInDate, checkOutDate, partySize, now = Date.now() }) => {
    const checkInDay = startOfUtcDay(checkInDate);
    const checkOutDay = startOfUtcDay(checkOutDate);
    if (!checkInDay || !checkOutDay || checkOutDay <= checkInDay) {
        throw _err('DATES_INVALID', 'Check-out must be after check-in.');
    }
    if (checkInDay < startOfUtcDay(now)) throw _err('DATES_PAST', 'Check-in cannot be in the past.');
    if (Math.round((checkOutDay - checkInDay) / DAY_MS) > MAX_STAY_NIGHTS) {
        throw _err('STAY_TOO_LONG', `A stay can be at most ${MAX_STAY_NIGHTS} nights.`);
    }
    const business = await prisma.businessProfile.findUnique({
        where: { bizId },
        select: { id: true, bizId: true, userId: true, businessName: true, category: true, isSuspended: true, isPausedByOwner: true },
    });
    if (!business || business.isSuspended) throw _err('NOT_FOUND', 'Business not found.', 404);
    if (business.isPausedByOwner) throw _err('HOTEL_PAUSED', 'This hotel is temporarily unavailable for new bookings.', 409);
    if (business.category !== 'HOSPITALITY') throw _err('NOT_A_HOTEL', 'This business is not configured as a hotel.', 409);
    if (!roomId) throw _err('ROOM_REQUIRED', 'roomId is required.');
    const room = await prisma.hotelRoom.findFirst({ where: { id: roomId, businessProfileId: business.id } });
    if (!room) throw _err('NOT_FOUND', 'Room not found.', 404);
    if (room.status !== 'AVAILABLE') throw _err('ROOM_UNAVAILABLE', `Room ${room.roomNumber} is not available.`, 409);
    const guests = Math.max(parseInt(partySize, 10) || 1, 1);
    if (guests > room.capacity) {
        throw _err('TOO_SMALL', `Room ${room.roomNumber} accommodates up to ${room.capacity} guest${room.capacity === 1 ? '' : 's'}.`, 409);
    }
    const nightly = await findNightlyRates(prisma, room, checkInDay, checkOutDay);
    const total = nightly.reduce((sum, n) => sum.add(n.priceUsdc), new Prisma.Decimal(0));
    if (total.lte(0)) throw _err('NO_PRICE', 'Room pricing is not configured.', 409);
    const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
    const amountUsdc = _round6(Number(total));
    const feeUsdc = bookingEscrowFee(settings, amountUsdc).feeUsdc;
    return {
        business, room, checkInDay, checkOutDay, guests, nightly, settings,
        amountUsdc, feeUsdc, totalUsdc: _round6(amountUsdc + feeUsdc),
    };
};

const _paymentOf = (escrow) => ({
    method: 'WALLET',
    escrowId: escrow.id,
    amountUsdc: Number(escrow.amountUsdc),
    feeUsdc: Number(escrow.feeUsdc),
    totalUsdc: _round6(Number(escrow.amountUsdc) + Number(escrow.feeUsdc)),
    heldUntil: 'CHECK_IN',
});

const bookPaidStay = async (prisma, {
    bizId, roomId, customerId, checkInDate, checkOutDate, partySize, customerNotes,
    expectedTotalUsdc, clientRequestKey, financialOperation = null, now = Date.now(),
}) => {
    if (!customerId) throw _err('BAD_REQUEST', 'customerId is required.');
    if (!clientRequestKey || typeof clientRequestKey !== 'string' || clientRequestKey.length > 128) {
        throw _err('IDEMPOTENCY_KEY_REQUIRED', 'Paying requires an Idempotency-Key header (at most 128 characters).');
    }
    if (expectedTotalUsdc == null || expectedTotalUsdc === '') {
        throw _err('EXPECTED_TOTAL_REQUIRED', 'Send the total you are paying (from the quote).');
    }
    const approved = _approvedMicros(expectedTotalUsdc);
    if (approved == null) throw _err('EXPECTED_TOTAL_INVALID', 'The total must be a decimal amount with at most 6 decimals.');

    // The request's identity: everything the guest asked for, with the total
    // they approved (on the first request that is exactly the server price).
    const notes = customerNotes ? String(customerNotes).slice(0, 500) : null;
    const guests = Math.max(parseInt(partySize, 10) || 1, 1);
    const startDay = startOfUtcDay(checkInDate);
    const endDay = startOfUtcDay(checkOutDate);
    const fingerprintFor = (businessProfileId) => crypto.createHash('sha256').update(JSON.stringify({
        kind: 'PAID_STAY', businessProfileId, customerId, roomId: String(roomId || ''),
        start: startDay.toISOString(), end: endDay.toISOString(), guests,
        total: _microsText(approved), notes,
    })).digest('hex');

    // A retried request (same key) returns the stay it already paid for.
    const replay = async ({ businessProfileId, fingerprint }) => {
        const existing = await prisma.reservation.findUnique({
            where: { businessProfileId_customerId_clientRequestKey: { businessProfileId, customerId, clientRequestKey } },
            include: { escrow: true },
        });
        if (!existing) return null;
        if (existing.requestFingerprint !== fingerprint) {
            throw _err('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different stay.', 409);
        }
        const { escrow: included, ...reservation } = existing;
        const escrow = included || (existing.escrowId
            ? await prisma.smartEscrow.findUnique({ where: { id: existing.escrowId } })
            : null);
        return { success: true, reservation, payment: escrow ? _paymentOf(escrow) : null, replayed: true };
    };

    // Replay before pricing: a retry after midnight (check-in now "past") or
    // after the hotel changed its price must find the stay it paid for, not
    // answer "Nothing was charged".
    if (startDay && endDay) {
        const known = await prisma.businessProfile.findUnique({ where: { bizId }, select: { id: true } });
        if (known) {
            const earlier = await replay({ businessProfileId: known.id, fingerprint: fingerprintFor(known.id) });
            if (earlier) return earlier;
        }
    }

    const p = await priceStay(prisma, { bizId, roomId, checkInDate, checkOutDate, partySize, now });
    if (!p.business.userId) throw _err('PAYEE_UNAVAILABLE', 'This hotel cannot receive payments yet.', 409);
    if (p.business.userId === customerId) throw _err('SELF_PAYMENT', 'You cannot pay for a stay at your own hotel.', 409);
    if (approved !== _micros(p.totalUsdc)) {
        throw _err('PRICE_CHANGED', `The price changed: the total is now ${p.totalUsdc.toFixed(6)} USDC. Nothing was charged.`, 409);
    }
    const identity = { businessProfileId: p.business.id, fingerprint: fingerprintFor(p.business.id) };

    await runDoubleCheck(prisma, customerId);
    const fundedExpiryDays = p.settings && p.settings.escrowFundedExpiryDays != null
        ? Number(p.settings.escrowFundedExpiryDays) : FUNDED_EXPIRY_DAYS_DEFAULT;
    const fundedExpiresAt = new Date(Math.max(
        now + fundedExpiryDays * DAY_MS,
        p.checkOutDay.getTime() + STAY_ESCROW_GRACE_DAYS * DAY_MS,
    ));
    const reference = crypto.randomUUID();
    const reservationRef = 'RES-' + crypto.randomBytes(4).toString('hex').toUpperCase();

    let response;
    try {
        response = await prisma.$transaction(async (tx) => {
            // 1-2. The business's booking lock first (the key the capacity
            // trigger takes on insert), then the room row: the order walk-ins
            // and room moves take them in (hotelOpsService), so the two
            // cannot deadlock. Then: the room is still free for these dates.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${p.business.id}::text, ${BOOKING_LOCK_NAMESPACE}::bigint))`;
            await tx.$executeRaw`SELECT id FROM "HotelRoom" WHERE "id" = ${p.room.id} FOR UPDATE`;
            const room = await tx.hotelRoom.findUnique({ where: { id: p.room.id }, select: { status: true } });
            if (!room || room.status !== 'AVAILABLE') {
                throw _err('ROOM_UNAVAILABLE', 'This room is no longer available. Nothing was charged.', 409);
            }
            const block = await tx.hotelRoomBlock.findFirst({
                where: { roomId: p.room.id, startDate: { lt: p.checkOutDay }, endDate: { gt: p.checkInDay } },
                select: { id: true },
            });
            if (block) throw _err('BLOCKED', 'The room is closed for those dates. Nothing was charged.', 409);
            const taken = await tx.reservation.findFirst({
                where: {
                    businessProfileId: p.business.id,
                    serviceItemId: p.room.id,
                    status: { in: ACTIVE_RESERVATION_STATUSES },
                    startDatetime: { lt: p.checkOutDay },
                    endDatetime: { gt: p.checkInDay },
                },
                select: { id: true },
            });
            if (taken) throw _err('BOOKED', 'This room was just booked for those dates. Nothing was charged.', 409);

            // 3. The reservation.
            const created = await tx.reservation.create({
                data: {
                    reservationRef,
                    clientRequestKey,
                    requestFingerprint: identity.fingerprint,
                    businessProfileId: p.business.id,
                    locationId: p.room.locationId || null,
                    customerId,
                    serviceItemId: p.room.id,
                    startDatetime: p.checkInDay,
                    endDatetime: p.checkOutDay,
                    partySize: p.guests,
                    amountUsdc: p.amountUsdc,
                    depositUsdc: 0,
                    customerNotes: notes,
                    status: 'PENDING',
                    // Check-in window and no-show timing (paidStayPolicy).
                    metadata: { paidStay: true, channel: 'APP' },
                },
            });

            // 4. Pay: escrow created, funded from the wallet, stay confirmed.
            const { escrow } = await _createBookingEscrowTx(tx, {
                bookingType: 'RESERVATION',
                bookingId: created.id,
                payerId: customerId,
                payeeId: p.business.userId,
                amount: p.amountUsdc,
                feeUsdc: p.feeUsdc,
                businessProfileId: p.business.id,
                deliveryTerms: `Stay ${reservationRef}: room ${p.room.roomNumber}, `
                    + `${p.checkInDay.toISOString().slice(0, 10)} to ${p.checkOutDay.toISOString().slice(0, 10)}`,
                expiresAt: fundedExpiresAt,
            });
            await _fundBookingEscrowTx(tx, {
                escrowId: escrow.id,
                payerId: customerId,
                bookingType: 'RESERVATION',
                bookingId: created.id,
                fundedExpiryDays,
                fundedExpiresAt,
                reference,
            });
            const reservation = await tx.reservation.findUnique({ where: { id: created.id } });
            const funded = await tx.smartEscrow.findUnique({ where: { id: escrow.id } });
            const out = {
                success: true,
                reservation,
                payment: { ..._paymentOf(funded), reference },
                nights: p.nightly.length,
            };

            // 5. The wired idempotency claim commits with the stay.
            if (financialOperation) {
                const committed = await tx.financialOperation.updateMany({
                    where: { id: financialOperation.id, status: 'IN_PROGRESS' },
                    data: { status: 'COMMITTED', statusCode: 201, responseBody: JSON.stringify(out) },
                });
                if (committed.count !== 1) {
                    throw Object.assign(new Error('Idempotency operation state conflict.'), { code: 'IDEMPOTENCY_STATE_CONFLICT' });
                }
            }
            return out;
        });
    } catch (err) {
        // The same key raced in: converge on the committed stay.
        if (err && err.code === 'P2002') {
            const converged = await replay(identity);
            if (converged) return converged;
        }
        throw err;
    }

    // Post-commit and best effort: the money has moved.
    try {
        await notifyBookingFunded(prisma, { bookingType: 'RESERVATION', bookingId: response.reservation.id });
    } catch (err) {
        logger.warn({ err: err && err.message, reservationId: response.reservation.id }, '[stayPayment] post-commit notice failed');
    }
    // The hotel's integrations hear of it like any new reservation.
    try {
        const { emitWebhookEvent } = require('./webhookEmitter');
        const r = response.reservation;
        Promise.resolve(emitWebhookEvent(p.business.id, 'reservation.created', {
            reservationId: r.id,
            reservationRef: r.reservationRef,
            customerId,
            startDatetime: p.checkInDay.toISOString(),
            endDatetime: p.checkOutDay.toISOString(),
            partySize: p.guests,
            amountUsdc: r.amountUsdc,
            paid: true,
            escrowId: response.payment.escrowId,
        })).catch(() => {});
    } catch (_) { /* best effort */ }
    return response;
};

/** True when the reservation's price is held in a funded escrow. */
const isPaidReservation = async (prisma, reservationId) => {
    const r = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { escrowId: true } });
    if (!r || !r.escrowId) return false;
    const e = await prisma.smartEscrow.findUnique({ where: { id: r.escrowId }, select: { status: true } });
    return !!e && ['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'].includes(e.status);
};

/**
 * Inside a transaction: refuse to move the dates of a booking whose money is
 * held (a paid stay, a funded deposit). Its price, its escrow's expiry and
 * its no-show timing were all fixed for the dates it was paid for. The
 * reservation row is locked first, so a payment cannot land in between.
 */
const assertDatesMovableTx = async (tx, reservationId) => {
    await tx.$executeRaw`SELECT id FROM "Reservation" WHERE "id" = ${reservationId} FOR UPDATE`;
    const r = await tx.reservation.findUnique({ where: { id: reservationId }, select: { escrowId: true } });
    if (!r || !r.escrowId) return;
    const e = await tx.smartEscrow.findUnique({ where: { id: r.escrowId }, select: { status: true } });
    if (e && HELD_ESCROW_STATUSES.includes(e.status)) {
        throw _err(
            'PAID_DATES_FIXED',
            "This booking is paid in Azaman, so its dates can't be moved. Cancel it (the guest gets the price back) and book the new dates.",
            409,
        );
    }
};

const qrCheckInRequiredError = () => _err(
    'QR_CHECKIN_REQUIRED',
    "This stay is paid in Azaman. Scan the guest's check-in QR to check them in.",
    409,
);

module.exports = {
    priceStay, bookPaidStay, isPaidReservation, qrCheckInRequiredError, assertDatesMovableTx,
    STAY_ESCROW_GRACE_DAYS, MAX_STAY_NIGHTS, HELD_ESCROW_STATUSES,
};
