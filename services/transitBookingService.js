// services/transitBookingService.js
// =============================================================================
// AZAMAN — TRANSIT SEAT BOOKING SERVICE (2026-07-02)
//
// Handles seat-safe transit booking with DB-level double-booking prevention.
// The @@unique([tripId, seatId]) constraint on TransitBookingSeat makes it
// STRUCTURALLY IMPOSSIBLE to double-book a seat — not just app-checked.
//
// Key operations:
//   - bookSeats: atomically reserve seats on a trip inside a $transaction;
//     with payWith: 'WALLET' the same transaction also creates and funds the
//     booking escrow from the customer's wallet and confirms the booking
//   - quoteSeats: the fare, the booking fee and the total bookSeats would
//     charge, plus the payer's available balance
//   - getTripSeatAvailability: return occupied + available seats
//   - cancelTransitBooking: cancel + refund escrow + free seats
//   - completeTransitBooking: IN_PROGRESS -> COMPLETED + release the escrow
//     to the operator, in one transaction
// =============================================================================

const crypto = require('crypto');
const { randomUUID } = require('crypto');
const logger = require('../src/config/logger');
// r28: the canonical escrow refund economic identity (same idempotency key,
// ledger entry and TransactionHistory row as every other escrow refund).
const {
    _refundBookingEscrowTx, REFUND_CLAIMABLE,
    _releaseBookingEscrowTx, RELEASE_CLAIMABLE,
    _createBookingEscrowTx, _fundBookingEscrowTx,
    bookingEscrowFee, notifyBookingFunded,
} = require('./bookingEscrowService');
const { runDoubleCheck } = require('../utils/securityCheck');

// How a booking may be paid at the moment it is made. Only the wallet today;
// MoMo collection is a separate, later rail.
const PAY_WITH = Object.freeze({ WALLET: 'WALLET' });
const FUNDED_EXPIRY_DAYS_DEFAULT = 30;
// A paid fare stays in escrow at least this long past departure, so the
// operator can complete the trip (and be paid) before any expiry refund.
const COMPLETION_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const UNBOOKABLE_TRIP_STATUSES = ['CANCELLED', 'DEPARTED', 'COMPLETED'];

// The exact total a passenger approved: a plain decimal string (or number)
// with at most 6 decimals, compared as integer micro-units. Anything else
// (arrays, exponents, hex, 7 decimals) is not an approval.
const _microsOf = (value) => {
    // A JSON number counts only if it is already exact at 6 decimals (no
    // silent rounding of 7.0349996 to 7.035000).
    const text = typeof value === 'number' && Number.isFinite(value)
        ? (Number(value.toFixed(6)) === value ? value.toFixed(6) : null)
        : (typeof value === 'string' ? value.trim() : null);
    if (!text || !/^\d+(\.\d{1,6})?$/.test(text)) return null;
    const [whole, frac = ''] = text.split('.');
    return BigInt(whole) * 1000000n + BigInt((frac + '000000').slice(0, 6));
};
const _usdcMicros = (n) => BigInt(Math.round(Number(n) * 1e6));
// The transit no-show grace (workers/reservationNoShowWorker.js): a paid
// passenger cannot be marked a no-show while their boarding code is valid.
const NO_SHOW_GRACE_MS = 75 * 60 * 1000;

// How a paid passenger may be boarded, and when the fare is then released.
//   QR_TOKEN: their own signed code. Released when the trip completes.
//   ID_CHECK: staff checked their AZM-ID and photo ID (transitBoardingService).
//     Released at completion if the passenger confirmed the boarding;
//     otherwise held until departure + ID_CHECK_PAYOUT_HOLD_MS so they can
//     report it ("Not me"), then released by sweepHeldTransitPayouts.
const BOARDED_METHODS = ['QR_TOKEN', 'ID_CHECK'];
const ID_CHECK_PAYOUT_HOLD_MS = 24 * 60 * 60 * 1000;
const _boardingOf = (booking) => {
    const meta = booking && booking.metadata;
    const b = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta.boarding : null;
    return b && typeof b === 'object' ? b : null;
};
const _metaObject = (m) => (m && typeof m === 'object' && !Array.isArray(m) ? m : {});
/**
 * When a paid fare may be released for this boarding (ms), or null.
 * An unconfirmed ID check waits for departure + the hold AND for the hold
 * fixed at boarding (boarding.holdUntil): moving the departure afterwards
 * can never bring the release forward.
 */
const payoutReadyAt = (boarding, departureMs) => {
    if (!boarding || !Number.isFinite(departureMs)) return null;
    if (boarding.method === 'QR_TOKEN') return departureMs;
    if (boarding.method === 'ID_CHECK') {
        if (boarding.passengerConfirmedAt) return departureMs;
        const fixed = Date.parse(boarding.holdUntil);
        return Math.max(departureMs + ID_CHECK_PAYOUT_HOLD_MS, Number.isFinite(fixed) ? fixed : 0);
    }
    return null;
};
const _departureOf = (trip, booking) => {
    const at = (trip && trip.departureAt) || (booking && booking.scheduledAt);
    return at ? new Date(at) : null;
};

const _bookingError = (code, message, httpStatus = 400) =>
    Object.assign(new Error(message), { code, httpStatus });

// Tier-aware seat pricing, shared by bookSeats and quoteSeats so a quote and
// the booking it describes always charge the same. Each seat's tier
// (VIP/STANDARD/ECONOMY), tagged on the seat map layout, is priced from
// trip.metadata.tierFares if present, falling back to the flat trip.fareUsdc.
const _priceSeats = (trip, seatIds) => {
    const layout = trip.vehicle.seatMap.layout;
    const tierFares = (trip.metadata && trip.metadata.tierFares) || {};
    const seatByIdMap = new Map(layout.map(s => [s.seatId, s]));
    const perSeatFare = seatIds.map(seatId => {
        const seat = seatByIdMap.get(seatId);
        const tier = seat && seat.tier;
        const tierFare = tier && tierFares[tier] != null ? Number(tierFares[tier]) : null;
        return tierFare != null ? tierFare : Number(trip.fareUsdc);
    });
    return _round6(perSeatFare.reduce((sum, f) => sum + f, 0));
};

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
    customerNote, businessProfileId, financialOperation = null,
    payWith = null, expectedTotalUsdc = null,
}) => {
    if (payWith != null && payWith !== PAY_WITH.WALLET) {
        throw _bookingError('UNSUPPORTED_PAYMENT_METHOD', `Unsupported payment method: ${payWith}.`);
    }
    const payByWallet = payWith === PAY_WITH.WALLET;
    if (!tripId) throw new Error('tripId is required.');
    if (!customerId) throw new Error('customerId is required.');
    if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
        throw new Error('seatIds must be a non-empty array.');
    }
    if (new Set(seatIds).size !== seatIds.length) {
        throw _bookingError('DUPLICATE_SEATS', 'Each seat can be chosen once.');
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

    // 5. Calculate total fare — tier-aware (see _priceSeats).
    const totalFare = _priceSeats(trip, seatIds);

    // 5b. Wallet pay: the operator is paid through a booking escrow (locked at
    //     booking, released to them when the trip completes). The fee comes
    //     from the same function the quote uses. The pre-flight ledger audit
    //     runs before the transaction, as on every other funding path.
    let walletPay = null;
    if (payByWallet) {
        const payeeId = trip.businessProfile.userId;
        if (!payeeId) throw _bookingError('PAYEE_UNAVAILABLE', 'This operator cannot receive payments yet.', 409);
        if (payeeId === customerId) {
            throw _bookingError('SELF_PAYMENT', 'You cannot pay for seats on your own trip.', 409);
        }
        if (!(totalFare > 0)) throw _bookingError('NOTHING_TO_PAY', 'This trip has no fare to pay.', 409);
        const departure = _departureOf(trip);
        if (departure && departure.getTime() <= Date.now()) {
            throw _bookingError('TRIP_DEPARTED', 'This trip has already left.', 409);
        }
        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        const feeUsdc = bookingEscrowFee(settings, totalFare).feeUsdc;
        // The passenger approved an exact total (the quote). The fare and the
        // fee are read now and charged as read; if either changed since the
        // quote, refuse instead of charging a different amount under the
        // same approval. Pre-transaction: nothing has been claimed.
        if (expectedTotalUsdc == null || expectedTotalUsdc === '') {
            throw _bookingError('EXPECTED_TOTAL_REQUIRED', 'Send the total you are paying (from the quote).');
        }
        const approved = _microsOf(expectedTotalUsdc);
        if (approved == null) {
            throw _bookingError('EXPECTED_TOTAL_INVALID', 'The total must be a decimal amount with at most 6 decimals.');
        }
        const total = _round6(totalFare + feeUsdc);
        if (approved !== _usdcMicros(total)) {
            throw _bookingError(
                'PRICE_CHANGED',
                `The price changed: the total is now ${total.toFixed(6)} USDC. Nothing was charged.`,
                409
            );
        }
        await runDoubleCheck(prisma, customerId);
        const fundedExpiryDays = settings && settings.escrowFundedExpiryDays != null
            ? Number(settings.escrowFundedExpiryDays) : FUNDED_EXPIRY_DAYS_DEFAULT;
        // The escrow must outlive the trip: the later of the platform's funded
        // window and departure + the completion grace. Otherwise the generic
        // escrow expiry sweep refunds a booking made far ahead while it is
        // still CONFIRMED, and the operator is never paid.
        const fundedExpiresAt = new Date(Math.max(
            Date.now() + fundedExpiryDays * DAY_MS,
            (departure ? departure.getTime() : Date.now()) + COMPLETION_GRACE_DAYS * DAY_MS,
        ));
        walletPay = {
            payeeId,
            feeUsdc,
            fundedExpiryDays,
            fundedExpiresAt,
            reference: randomUUID(),
        };
    }

    // 6. Create the booking + seats atomically
    const bookingRef = _genRef();
    // The $transaction returns the COMPLETE wire response (built in-tx so the
    // committed claim's responseBody is byte-identical to what the controller
    // res.json()s).
    let response;
    try {
        response = await prisma.$transaction(async (tx) => {
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

            // Decrement available seats — conditional, so a trip cancelled
            // (or departed) since the read above, or one without the seats,
            // refuses the booking inside the transaction: a paid booking can
            // never commit onto a cancelled trip.
            const capacity = await tx.transitTrip.updateMany({
                where: {
                    id: tripId,
                    status: { notIn: UNBOOKABLE_TRIP_STATUSES },
                    availableSeats: { gte: seatIds.length },
                    // The departure this booking was priced and scheduled
                    // against: a trip postponed since the read refuses it
                    // (the booking would carry the old time and escrow expiry).
                    departureAt: trip.departureAt,
                },
                data: { availableSeats: { decrement: seatIds.length } }
            });
            if (capacity.count !== 1) {
                throw _bookingError('TRIP_UNAVAILABLE', 'This trip is no longer taking bookings, or the seats are gone.', 409);
            }

            // Wallet pay, in this same transaction: create the booking
            // escrow, fund it from the customer's wallet (debit fare + fee,
            // lock the fare, realize the fee, post the ledger) and confirm the
            // booking. Any failure (insufficient balance included) rolls back
            // the seats and the booking too: there is never a half-paid
            // booking or a stray unpaid hold.
            let booking = b;
            let payment;
            if (walletPay) {
                const { escrow } = await _createBookingEscrowTx(tx, {
                    bookingType: 'TRANSIT',
                    bookingId: b.id,
                    payerId: customerId,
                    payeeId: walletPay.payeeId,
                    amount: totalFare,
                    feeUsdc: walletPay.feeUsdc,
                    businessProfileId: trip.businessProfileId,
                    deliveryTerms: `Transit seats ${seatIds.join(', ')} on ${bookingRef}`,
                    expiresAt: walletPay.fundedExpiresAt,
                });
                const funded = await _fundBookingEscrowTx(tx, {
                    escrowId: escrow.id,
                    payerId: customerId,
                    bookingType: 'TRANSIT',
                    bookingId: b.id,
                    fundedExpiryDays: walletPay.fundedExpiryDays,
                    fundedExpiresAt: walletPay.fundedExpiresAt,
                    reference: walletPay.reference,
                });
                // The booking records the fee it was charged.
                booking = await tx.transitBooking.update({
                    where: { id: b.id },
                    data: { feeUsdc: funded.fee },
                });
                payment = {
                    method: PAY_WITH.WALLET,
                    escrowId: escrow.id,
                    amountUsdc: funded.amount,
                    feeUsdc: funded.fee,
                    totalUsdc: _round6(funded.amount + funded.fee),
                    reference: walletPay.reference,
                };
            }

            // §r42 WIRED CLAIM (transit booking identity, 2026-10-01): the
            // durable idempotency identity commits WITH the booking, inside
            // the SAME transaction. Booking committed ⇒ claim COMMITTED
            // (replay returns this exact response); transaction rolled back
            // ⇒ the claim never becomes replayable (no phantom identity).
            // The stored responseBody is the serialized WIRE text of the
            // object the controller res.json()s — the replay is byte-identical
            // (key order preserved; Prisma Decimal via toJSON → string).
            const response = payment
                ? { success: true, booking, seatIds, totalFare, payment }
                : { success: true, booking, seatIds, totalFare };
            if (financialOperation) {
                const committed = await tx.financialOperation.updateMany({
                    where: { id: financialOperation.id, status: 'IN_PROGRESS' },
                    data: {
                        status: 'COMMITTED',
                        statusCode: 201,
                        responseBody: JSON.stringify(response),
                    },
                });
                if (committed.count !== 1) {
                    // The claim is not ours to complete — treat as an
                    // operation-state conflict and roll the booking back.
                    const err = new Error('Idempotency operation state conflict.');
                    err.code = 'IDEMPOTENCY_STATE_CONFLICT';
                    throw err;
                }
            }

            return response;
        });
    } catch (err) {
        // P2002 = unique constraint violation — seat was raced by another customer
        if (err.code === 'P2002') {
            throw new Error('One or more seats were just booked by another customer. Please try again.');
        }
        throw err;
    }

    // Post-commit and non-authoritative, like every funding path. The money
    // has moved: nothing here may turn the committed booking into an error.
    if (response.payment) {
        try {
            await notifyBookingFunded(prisma, { bookingType: 'TRANSIT', bookingId: response.booking.id });
        } catch (err) {
            logger.warn({ err: err.message, bookingId: response.booking.id },
                '[transitBooking] post-commit confirmation notice failed');
        }
    }

    // Built inside the transaction (byte-identical to the stored claim
    // responseBody when the request was keyed).
    return response;
};

// =============================================================================
// 1b. QUOTE SEATS — what bookSeats(payWith: WALLET) would charge, read-only.
//     Same validation, same pricing (_priceSeats), same fee function
//     (bookingEscrowFee). Moves nothing and holds nothing.
// =============================================================================
const quoteSeats = async (prisma, { tripId, customerId, seatIds }) => {
    if (!tripId) throw _bookingError('BAD_REQUEST', 'tripId is required.');
    if (!Array.isArray(seatIds) || seatIds.length === 0) {
        throw _bookingError('BAD_REQUEST', 'seatIds must be a non-empty array.');
    }
    if (new Set(seatIds).size !== seatIds.length) {
        throw _bookingError('DUPLICATE_SEATS', 'Each seat can be chosen once.');
    }
    const trip = await prisma.transitTrip.findUnique({
        where: { id: tripId },
        include: {
            vehicle: { include: { seatMap: true } },
            businessProfile: { select: { id: true, userId: true, isSuspended: true } },
        },
    });
    if (!trip) throw _bookingError('NOT_FOUND', 'Trip not found.', 404);
    if (!trip.vehicle?.seatMap) throw _bookingError('NO_SEAT_MAP', 'This vehicle has no seat map configured.', 409);
    const validSeatIds = new Set(trip.vehicle.seatMap.layout.map(s => s.seatId));
    const invalid = seatIds.filter(id => !validSeatIds.has(id));
    if (invalid.length > 0) throw _bookingError('BAD_SEATS', `Invalid seat IDs: ${invalid.join(', ')}.`);

    const fareUsdc = _priceSeats(trip, seatIds);
    const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
    const { feePct, feeUsdc } = bookingEscrowFee(settings, fareUsdc);
    const payer = await prisma.user.findUnique({ where: { id: customerId }, select: { availableBalance: true } });
    const availableUsdc = payer ? Number(payer.availableBalance) : 0;
    const totalUsdc = _round6(fareUsdc + feeUsdc);
    return {
        success: true,
        tripId,
        seatIds,
        currency: 'USDC',
        fareUsdc,
        feeUsdc,
        feePct,
        totalUsdc,
        availableUsdc,
        canPay: availableUsdc >= totalUsdc
            && trip.businessProfile.userId !== customerId
            && !trip.businessProfile.isSuspended
            && !UNBOOKABLE_TRIP_STATUSES.includes(trip.status)
            && !(_departureOf(trip) && _departureOf(trip).getTime() <= Date.now())
            && trip.availableSeats >= seatIds.length,
    };
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

const cancelTransitBooking = async (prisma, { bookingId, cancelledBy, note, onlyFromStatuses = null } = {}) => {
    if (!bookingId) throw new TransitCancellationError('BAD_REQUEST', 'bookingId is required.', 400);
    // A caller that must only cancel bookings in a narrower state (the 15-min
    // expiry worker: PENDING only) pins it here. Without the pin, a booking
    // paid between the worker's read and this claim (PENDING -> CONFIRMED)
    // would be cancelled and refunded: the passenger loses the seat they
    // just paid for.
    const claimable = onlyFromStatuses
        ? CANCELLABLE_STATUSES.filter(s => onlyFromStatuses.includes(s))
        : CANCELLABLE_STATUSES;

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
        // 0. §r41.audit-followup — SHARED AUTHORITATIVE LOCK ORDER: every
        //    escrow-backed transit lifecycle operation (escrow funding, the
        //    no-show sweep's refund/split-release/DRAFT expiry, business
        //    no-show settlement) takes the ESCROW row lock first, then the
        //    booking row. Cancellation previously claimed the booking row
        //    first and only touched the escrow afterwards — the exact
        //    inverted order against the no-show sweep, an AB-BA deadlock
        //    pair on the two hot rows. Lock the escrow row FIRST so every
        //    competing lifecycle operation serializes through the same
        //    escrow authority; the booking CAS below then runs strictly
        //    after the escrow is pinned.
        //
        //    The escrowId is re-read INSIDE the transaction: the pre-read
        //    `booking.escrowId` can be stale if an escrow was linked between
        //    the authorization read and this claim — cancelling against a
        //    stale null escrowId would strand a funded escrow on a CANCELLED
        //    booking.
        // §r41 third-pass review — LINKAGE-PINNED CAS + bounded re-pin loop.
        //
        // The READ COMMITTED hazard: a fresh link read can observe escrowId =
        // null while a createBookingEscrow holds the booking row with an
        // uncommitted escrowId link. The cancellation's booking CAS then
        // BLOCKS on that row, wakes when the link commits, and PostgreSQL
        // legally re-evaluates the CAS WHERE against the NEW committed row
        // version (EvalPlanQual) — status is still PENDING, so the old CAS
        // won the booking while the JavaScript-side escrowId stayed null:
        // CANCELLED booking with a silently unreported, still-attached
        // escrow (a FUNDED link would strand customer money).
        //
        // Structural fix: the pinned escrowId is part of the CAS identity —
        // `where: { id, status in CANCELLABLE, escrowId: pinned }`. Under
        // re-evaluation the raced link (escrowId null -> E) fails the
        // predicate and the CAS loses. Because linkage is strictly one-way
        // (the create/link path requires escrowId: null), the CAS WINNER's
        // pinned escrowId is provably the FINAL linkage.
        //
        // On a linkage-raced loss the claim held NOTHING (a failed
        // re-evaluation releases the row, and the pinned-null variant never
        // took an escrow lock), so re-pinning — read link, lock escrow FIRST,
        // CAS again — is deadlock-free by construction: while we hold the
        // escrow row, no competing lifecycle writer can hold the booking row
        // (they all need the escrow first). Bounded; the one-way linkage makes
        // more than one retry unreachable in practice.
        const MAX_LINKAGE_PIN_ATTEMPTS = 3;
        let escrowId = null;
        let claim = null;
        for (let attempt = 1; ; attempt++) {
            const freshLink = await tx.transitBooking.findUnique({
                where: { id: bookingId },
                select: { escrowId: true },
            });
            escrowId = freshLink?.escrowId ?? null;
            if (escrowId) {
                await tx.$executeRaw`SELECT id FROM "SmartEscrow" WHERE "id" = ${escrowId} FOR UPDATE`;
            }

            // 1. CAS claim from the authoritative cancellable set, WITH the
            //    pinned linkage in the predicate. count 0 means a racing actor
            //    moved the booking OR the linkage raced a create/link —
            //    re-read, converge, or re-pin.
            claim = await tx.transitBooking.updateMany({
                where: { id: bookingId, status: { in: claimable }, escrowId },
                data: {
                    status: 'CANCELLED',
                    ...(note != null ? { driverNote: note } : {}),
                },
            });

            if (claim.count === 1) break; // authoritative winner

            const current = await tx.transitBooking.findUnique({
                where: { id: bookingId },
                select: { status: true, escrowId: true },
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
            const linkageRaced = claimable.includes(current?.status)
                && (current?.escrowId ?? null) !== escrowId;
            if (linkageRaced && attempt < MAX_LINKAGE_PIN_ATTEMPTS) {
                // A create/link committed a fresh escrow between the pin read
                // and this CAS. Nothing is held — re-pin through the shared
                // escrow-first order and claim again.
                continue;
            }
            if (linkageRaced) {
                throw new TransitCancellationError(
                    'LINKAGE_CONFLICT',
                    'Booking escrow linkage changed while cancelling. Retry.',
                    409
                );
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
        //    Uses the FRESH escrowId pinned in step 0 — never the stale
        //    pre-read link.
        let refund = null;
        if (escrowId) {
            const escrow = await tx.smartEscrow.findUnique({ where: { id: escrowId } });
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

// =============================================================================
// 4. COMPLETE TRANSIT BOOKING — IN_PROGRESS -> COMPLETED, and the booking
//    escrow (a wallet-paid fare) released to the operator, in ONE
//    transaction. A plain status flip here used to leave a funded escrow
//    locked until the escrow expiry worker refunded the passenger 30 days
//    later: the operator was never paid for a completed trip.
//
//    Same authority as cancellation: the ESCROW row is locked first, then
//    the booking is claimed with the pinned linkage in the CAS, so this
//    serializes with every other escrow-backed lifecycle operation.
// =============================================================================
const completeTransitBooking = async (prisma, { bookingId, now = Date.now() } = {}) => {
    if (!bookingId) throw new TransitCancellationError('BAD_REQUEST', 'bookingId is required.', 400);
    const include = {
        vehicle: { select: { id: true, type: true, make: true, model: true, licensePlate: true, driverName: true } },
        businessProfile: { select: { id: true, businessName: true } },
    };
    return prisma.$transaction(async (tx) => {
        const pre = await tx.transitBooking.findUnique({ where: { id: bookingId }, select: { escrowId: true } });
        if (!pre) throw new TransitCancellationError('NOT_FOUND', 'Booking not found.', 404);
        const escrowId = pre.escrowId ?? null;
        if (escrowId) {
            await tx.$executeRaw`SELECT id FROM "SmartEscrow" WHERE "id" = ${escrowId} FOR UPDATE`;
        }
        // Read the booking AFTER the escrow lock: a passenger confirmation
        // (which takes the same lock) that committed while this waited is
        // seen, and its metadata is not overwritten.
        const link = await tx.transitBooking.findUnique({
            where: { id: bookingId },
            select: { escrowId: true, scheduledAt: true, tripId: true, status: true, metadata: true },
        });
        if (!link) throw new TransitCancellationError('NOT_FOUND', 'Booking not found.', 404);

        // A paid fare is released only to a passenger boarded by their own QR
        // or by a staff ID check (transitBoardingService), and only once the
        // trip has actually left. Manual boarding of a paid booking is
        // refused upstream; this is the last guard, before anything changes.
        const held = escrowId
            ? await tx.smartEscrow.findUnique({ where: { id: escrowId }, select: { status: true } })
            : null;
        const paid = !!held && RELEASE_CLAIMABLE.includes(held.status);
        let holdUntil = null;
        if (paid && link.status !== 'COMPLETED') {
            const boarding = _boardingOf(link);
            if (!boarding || !BOARDED_METHODS.includes(boarding.method)) {
                throw new TransitCancellationError(
                    'QR_BOARDING_REQUIRED',
                    'A paid trip completes only for a passenger boarded by their QR code or an ID check.',
                    409
                );
            }
            const trip = link.tripId
                ? await tx.transitTrip.findUnique({ where: { id: link.tripId }, select: { departureAt: true } })
                : null;
            const departure = _departureOf(trip, link);
            if (!departure || departure.getTime() > now) {
                throw new TransitCancellationError(
                    'TOO_EARLY',
                    'A paid trip can be completed only after it departs.',
                    409
                );
            }
            // An unconfirmed ID check: the trip completes, the fare waits
            // out the passenger's window to report it.
            const readyAt = payoutReadyAt(boarding, departure.getTime());
            if (readyAt > now) holdUntil = new Date(readyAt);
        }

        const data = { status: 'COMPLETED', dropoffTime: new Date(now) };
        if (holdUntil) {
            const meta = _metaObject(link.metadata);
            data.metadata = {
                ...meta,
                payout: { ..._metaObject(meta.payout), heldUntil: holdUntil.toISOString(), reason: 'ID_CHECK_UNCONFIRMED' },
            };
        }
        const claim = await tx.transitBooking.updateMany({
            where: { id: bookingId, status: 'IN_PROGRESS', escrowId },
            data,
        });
        if (claim.count !== 1) {
            const current = await tx.transitBooking.findUnique({ where: { id: bookingId }, select: { status: true } });
            if (current?.status === 'COMPLETED') {
                // Idempotent convergence: already completed — no economics.
                return {
                    success: true,
                    alreadyCompleted: true,
                    release: null,
                    booking: await tx.transitBooking.findUnique({ where: { id: bookingId }, include }),
                };
            }
            throw new TransitCancellationError(
                'NOT_COMPLETABLE',
                `Cannot complete a booking with status ${current?.status}.`,
                409
            );
        }

        let release = null;
        let escrowNotReleased = null;
        const payoutHeld = holdUntil ? { escrowId, until: holdUntil } : null;
        if (escrowId && !holdUntil) {
            const escrow = await tx.smartEscrow.findUnique({ where: { id: escrowId } });
            if (escrow && RELEASE_CLAIMABLE.includes(escrow.status)) {
                const reference = randomUUID();
                await _releaseBookingEscrowTx(tx, { escrowId, reference });
                release = { escrowId, amountUsdc: Number(escrow.amountUsdc), reference };
            } else if (escrow && escrow.status !== 'DRAFT') {
                // Refunded, expired or in dispute: the trip is complete but
                // the fare was not released here. Said, never a silent success.
                escrowNotReleased = { escrowId, escrowStatus: escrow.status };
                logger.warn({ bookingId, escrowId, escrowStatus: escrow.status },
                    '[transitBooking] completed with an escrow that cannot be released');
            }
        }

        return {
            success: true,
            alreadyCompleted: false,
            release,
            escrowNotReleased,
            payoutHeld,
            booking: await tx.transitBooking.findUnique({ where: { id: bookingId }, include }),
        };
    });
};

// =============================================================================
// 4b. HELD PAYOUT — release a completed booking's fare once its boarding
//     allows it (an ID check the passenger confirmed, or whose report window
//     has passed). Never releases a disputed, refunded or settled escrow.
//     `_releaseHeldPayoutTx` runs with the escrow row lock already held.
// =============================================================================
const _releaseHeldPayoutTx = async (tx, { bookingId, escrowId, now = Date.now() }) => {
    const b = await tx.transitBooking.findUnique({
        where: { id: bookingId },
        select: { status: true, escrowId: true, metadata: true, tripId: true, scheduledAt: true },
    });
    if (!b || b.status !== 'COMPLETED' || (b.escrowId ?? null) !== escrowId) {
        return { released: false, reason: 'NOT_COMPLETED' };
    }
    const boarding = _boardingOf(b);
    const trip = b.tripId
        ? await tx.transitTrip.findUnique({ where: { id: b.tripId }, select: { departureAt: true } })
        : null;
    const departure = _departureOf(trip, b);
    const readyAt = departure ? payoutReadyAt(boarding, departure.getTime()) : null;
    if (readyAt == null) return { released: false, reason: 'NOT_BOARDED' };
    if (now < readyAt) return { released: false, reason: 'HELD', heldUntil: new Date(readyAt) };

    const escrow = await tx.smartEscrow.findUnique({ where: { id: escrowId } });
    if (!escrow || !RELEASE_CLAIMABLE.includes(escrow.status)) {
        return { released: false, reason: `ESCROW_${escrow ? escrow.status : 'MISSING'}` };
    }
    const reference = randomUUID();
    await _releaseBookingEscrowTx(tx, { escrowId, reference });
    const meta = _metaObject(b.metadata);
    await tx.transitBooking.update({
        where: { id: bookingId },
        data: { metadata: { ...meta, payout: { ..._metaObject(meta.payout), releasedAt: new Date(now).toISOString() } } },
    });
    return { released: true, release: { escrowId, amountUsdc: Number(escrow.amountUsdc), reference } };
};

const releaseHeldTransitPayout = async (prisma, { bookingId, now = Date.now() } = {}) => {
    if (!bookingId) throw new TransitCancellationError('BAD_REQUEST', 'bookingId is required.', 400);
    return prisma.$transaction(async (tx) => {
        const pre = await tx.transitBooking.findUnique({ where: { id: bookingId }, select: { escrowId: true } });
        if (!pre) throw new TransitCancellationError('NOT_FOUND', 'Booking not found.', 404);
        if (!pre.escrowId) return { released: false, reason: 'NO_ESCROW' };
        await tx.$executeRaw`SELECT id FROM "SmartEscrow" WHERE "id" = ${pre.escrowId} FOR UPDATE`;
        return _releaseHeldPayoutTx(tx, { bookingId, escrowId: pre.escrowId, now });
    });
};

// Hourly (no-show sweep): completed, paid bookings whose fare is still held
// and whose departure is at least the hold ago. A disputed escrow is not
// claimable, so a passenger's report keeps the fare for dispute review.
// Pages through the candidates (a row still held, e.g. boarded after
// departure, stays a candidate and must not starve the rows behind it).
const sweepHeldTransitPayouts = async (prisma, { now = Date.now(), limit = 100, maxPages = 10 } = {}) => {
    const out = { checked: 0, released: 0, held: 0, failed: 0 };
    const seen = new Set();
    for (let page = 0; page < maxPages; page += 1) {
        // Rows handled this run are excluded by id: a released row leaves the
        // filter, so a cursor on it would skip the row after it.
        const due = await prisma.transitBooking.findMany({
            where: {
                status: 'COMPLETED',
                escrowId: { not: null },
                scheduledAt: { lte: new Date(now - ID_CHECK_PAYOUT_HOLD_MS) },
                escrow: { is: { status: { in: RELEASE_CLAIMABLE } } },
                ...(seen.size > 0 ? { id: { notIn: [...seen] } } : {}),
            },
            select: { id: true },
            orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
            take: limit,
        });
        const fresh = due.filter((b) => !seen.has(b.id));
        for (const b of fresh) {
            seen.add(b.id);
            out.checked += 1;
            try {
                const r = await releaseHeldTransitPayout(prisma, { bookingId: b.id, now });
                if (r.released) out.released += 1;
                else out.held += 1;
            } catch (err) {
                out.failed += 1;
                logger.error({ err: err.message, bookingId: b.id }, '[transitBooking] held payout release failed');
            }
        }
        if (due.length < limit || fresh.length === 0) break;
    }
    return out;
};

// =============================================================================
// 5. NO-SHOW WITHOUT A PENALTY — CONFIRMED -> NO_SHOW and the funded fare
//    refunded to the passenger, in ONE transaction (the business-initiated
//    twin of the no-show worker's NO_SHOW_NO_PENALTY branch). A plain status
//    flip left the escrow FUNDED outside every sweep until the 30-day expiry.
//    Same escrow-first lock order and linkage-pinned CAS as cancellation.
// =============================================================================
const noShowTransitBookingWithRefund = async (prisma, { bookingId, driverNote = null, now = Date.now() } = {}) => {
    if (!bookingId) throw new TransitCancellationError('BAD_REQUEST', 'bookingId is required.', 400);
    const include = {
        vehicle: { select: { id: true, type: true, make: true, model: true, licensePlate: true, driverName: true } },
        businessProfile: { select: { id: true, businessName: true } },
    };
    return prisma.$transaction(async (tx) => {
        const link = await tx.transitBooking.findUnique({
            where: { id: bookingId },
            select: { escrowId: true, scheduledAt: true, tripId: true },
        });
        if (!link) throw new TransitCancellationError('NOT_FOUND', 'Booking not found.', 404);
        const escrowId = link.escrowId ?? null;
        if (escrowId) {
            await tx.$executeRaw`SELECT id FROM "SmartEscrow" WHERE "id" = ${escrowId} FOR UPDATE`;
        }
        await assertNoShowWindowClosed(tx, link, now);
        const claim = await tx.transitBooking.updateMany({
            where: { id: bookingId, status: 'CONFIRMED', escrowId },
            // A missing note keeps whatever note the booking already has.
            data: driverNote != null ? { status: 'NO_SHOW', driverNote } : { status: 'NO_SHOW' },
        });
        if (claim.count !== 1) {
            const current = await tx.transitBooking.findUnique({ where: { id: bookingId }, select: { status: true } });
            if (current?.status === 'NO_SHOW') {
                return { success: true, alreadyNoShow: true, refund: null,
                    booking: await tx.transitBooking.findUnique({ where: { id: bookingId }, include }) };
            }
            throw new TransitCancellationError(
                'NOT_NO_SHOWABLE',
                `Cannot mark a booking with status ${current?.status} as a no-show.`,
                409
            );
        }
        let refund = null;
        if (escrowId) {
            const escrow = await tx.smartEscrow.findUnique({ where: { id: escrowId } });
            if (escrow && REFUND_CLAIMABLE.includes(escrow.status)) {
                const reference = randomUUID();
                await _refundBookingEscrowTx(tx, { escrowId, reference });
                refund = { escrowId, amountUsdc: Number(escrow.amountUsdc), reference };
            }
        }
        return {
            success: true,
            alreadyNoShow: false,
            refund,
            booking: await tx.transitBooking.findUnique({ where: { id: bookingId }, include }),
        };
    });
};

// =============================================================================
// No-show timing for a paid booking: only once the boarding window has
// closed (departure + the sweep's grace). Before that the passenger can still
// board with a valid code, and a no-show would refund or penalize them early.
// =============================================================================
const assertNoShowWindowClosed = async (db, booking, now = Date.now()) => {
    const trip = booking.tripId
        ? await db.transitTrip.findUnique({ where: { id: booking.tripId }, select: { departureAt: true } })
        : null;
    const departure = _departureOf(trip, booking);
    if (!departure || now < departure.getTime() + NO_SHOW_GRACE_MS) {
        throw new TransitCancellationError(
            'TOO_EARLY',
            'A paid passenger can be marked a no-show only after the boarding window closes.',
            409
        );
    }
};

// =============================================================================
// 6. RESCHEDULE — a trip's departure moved (PATCH, or IROPS reassignment).
//    The bookings and their escrows follow it: active bookings take the new
//    scheduledAt (the no-show sweep reads it), and a paid fare's escrow is
//    extended to at least the new departure + the completion grace (so a
//    postponed trip is never refunded by the expiry sweep before it runs).
// =============================================================================
// Transaction core: callers that move a trip's departure run this in the SAME
// transaction as the trip write, so the trip and its bookings can never
// disagree (and a failed reschedule rolls the trip write back, retryable).
// Idempotent: running it again with the same departure changes nothing.
const _rescheduleTripBookingsTx = async (tx, { tripId, departureAt }) => {
    if (!tripId || !departureAt) return { rescheduled: 0, extended: 0 };
    const at = new Date(departureAt);
    const active = ['PENDING', 'CONFIRMED', 'IN_PROGRESS'];
    {
        const moved = await tx.transitBooking.updateMany({
            where: { tripId, status: { in: active } },
            data: { scheduledAt: at },
        });
        const paid = await tx.transitBooking.findMany({
            where: { tripId, status: { in: active }, escrowId: { not: null } },
            select: { escrowId: true },
        });
        let extended = 0;
        if (paid.length > 0) {
            const until = new Date(at.getTime() + COMPLETION_GRACE_DAYS * DAY_MS);
            const res = await tx.smartEscrow.updateMany({
                where: {
                    id: { in: paid.map(b => b.escrowId) },
                    status: { in: RELEASE_CLAIMABLE },
                    expiresAt: { lt: until },
                },
                data: { expiresAt: until },
            });
            extended = res.count;
        }
        return { rescheduled: moved.count, extended };
    }
};

const rescheduleTripBookings = async (prisma, args) =>
    prisma.$transaction((tx) => _rescheduleTripBookingsTx(tx, args));

module.exports = {
    bookSeats, quoteSeats, getTripSeatAvailability, cancelTransitBooking, completeTransitBooking,
    noShowTransitBookingWithRefund, COMPLETION_GRACE_DAYS,
    rescheduleTripBookings, _rescheduleTripBookingsTx, assertNoShowWindowClosed, NO_SHOW_GRACE_MS,
    BOARDED_METHODS, ID_CHECK_PAYOUT_HOLD_MS, payoutReadyAt,
    releaseHeldTransitPayout, _releaseHeldPayoutTx, sweepHeldTransitPayouts,
    CANCELLABLE_STATUSES, TransitCancellationError, PAY_WITH,
};
