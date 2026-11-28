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
    payWith = null,
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
        await runDoubleCheck(prisma, customerId);
        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        walletPay = {
            payeeId,
            feeUsdc: bookingEscrowFee(settings, totalFare).feeUsdc,
            fundedExpiryDays: settings && settings.escrowFundedExpiryDays != null
                ? Number(settings.escrowFundedExpiryDays) : FUNDED_EXPIRY_DAYS_DEFAULT,
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

            // Decrement available seats
            await tx.transitTrip.update({
                where: { id: tripId },
                data: { availableSeats: { decrement: seatIds.length } }
            });

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
                    expiresAt: new Date(Date.now() + walletPay.fundedExpiryDays * 24 * 60 * 60 * 1000),
                });
                const funded = await _fundBookingEscrowTx(tx, {
                    escrowId: escrow.id,
                    payerId: customerId,
                    bookingType: 'TRANSIT',
                    bookingId: b.id,
                    fundedExpiryDays: walletPay.fundedExpiryDays,
                    reference: walletPay.reference,
                });
                booking = await tx.transitBooking.findUnique({ where: { id: b.id } });
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

    // Post-commit and non-authoritative, like every funding path.
    if (response.payment) {
        await notifyBookingFunded(prisma, { bookingType: 'TRANSIT', bookingId: response.booking.id });
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
            && !['CANCELLED', 'DEPARTED', 'COMPLETED'].includes(trip.status),
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
const completeTransitBooking = async (prisma, { bookingId } = {}) => {
    if (!bookingId) throw new TransitCancellationError('BAD_REQUEST', 'bookingId is required.', 400);
    const include = {
        vehicle: { select: { id: true, type: true, make: true, model: true, licensePlate: true, driverName: true } },
        businessProfile: { select: { id: true, businessName: true } },
    };
    return prisma.$transaction(async (tx) => {
        const link = await tx.transitBooking.findUnique({ where: { id: bookingId }, select: { escrowId: true } });
        if (!link) throw new TransitCancellationError('NOT_FOUND', 'Booking not found.', 404);
        const escrowId = link.escrowId ?? null;
        if (escrowId) {
            await tx.$executeRaw`SELECT id FROM "SmartEscrow" WHERE "id" = ${escrowId} FOR UPDATE`;
        }

        const claim = await tx.transitBooking.updateMany({
            where: { id: bookingId, status: 'IN_PROGRESS', escrowId },
            data: { status: 'COMPLETED', dropoffTime: new Date() },
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
        if (escrowId) {
            const escrow = await tx.smartEscrow.findUnique({ where: { id: escrowId } });
            if (escrow && RELEASE_CLAIMABLE.includes(escrow.status)) {
                const reference = randomUUID();
                await _releaseBookingEscrowTx(tx, { escrowId, reference });
                release = { escrowId, amountUsdc: Number(escrow.amountUsdc), reference };
            }
        }

        return {
            success: true,
            alreadyCompleted: false,
            release,
            booking: await tx.transitBooking.findUnique({ where: { id: bookingId }, include }),
        };
    });
};

module.exports = {
    bookSeats, quoteSeats, getTripSeatAvailability, cancelTransitBooking, completeTransitBooking,
    CANCELLABLE_STATUSES, TransitCancellationError, PAY_WITH,
};
