// services/transitTripCancellationService.js
// =============================================================================
// r27 / P0-A — Transactionally authoritative transit trip cancellation.
//
// The old route marked a trip CANCELLED and its active bookings CANCELLED but
// never resolved the funded customer escrows: a customer's locked money stayed
// locked until some later expiry/dispute mechanism. Worse, the route's
// booking update used a non-existent `transitTripId` column, so any
// cancellation with bookings 500'd AFTER the trip was already marked
// CANCELLED (half-completed, non-atomic, funds stranded).
//
// This service guarantees, per booking, in ONE database transaction:
//   • the booking's status claim (PENDING/CONFIRMED/CHECKED_IN → CANCELLED)
//   • the canonical escrow refund (services/bookingEscrowService
//     _refundBookingEscrowTx — same economic identity, ledger entry,
//     TransactionHistory row and idempotency key as every other refund)
//
// Invariants (proven in __tests__/r27-transit-trip-cancellation-escrow.test.js):
//   1. Tenant scope: only the owning business can cancel (findFirst with
//      businessProfileId; mismatch = 404, never a leak).
//   2. Exactly-once economics: the escrow refund is a CAS on the escrow's
//      claimable status (FUNDED/IN_PROGRESS/PENDING_SETTLEMENT → REFUNDED) plus
//      the ledger's idempotency key. Retries and racing cancellations converge.
//   3. No false success: a booking is only reported REFUNDED when its escrow
//      committed REFUNDED and the payer's locked balance was restored in the
//      SAME transaction. Any booking failure rolls back its own booking+refund
//      pair and is reported explicitly; the trip is only flipped to CANCELLED
//      when every eligible booking resolved.
//   4. Recoverable partial failure: a failed booking remains in its prior
//      active state, so a retry of the same route re-resolves it. Retrying
//      after full success performs zero economic mutations.
//   5. Already-finalized escrows (REFUNDED/RELEASED/EXPIRED) never receive a
//      second economic mutation; DISPUTED escrows stay in the dispute
//      channel's custody and are reported distinctly, never as refunded.
//
// The route holds NO refund/ledger logic of its own.
// =============================================================================

const { randomUUID } = require('crypto');
const {
    _refundBookingEscrowTx,
    REFUND_CLAIMABLE,
} = require('./bookingEscrowService');
const logger = require('../src/config/logger');

// NOTE: 'CHECKED_IN' is NOT a TransitBookingStatus enum value — the old route
// filtered on it and PrismaClientValidationError'd on EVERY call before any
// mutation. Check-in state lives in TransitBooking.checkedInAt (on CONFIRMED),
// so PENDING + CONFIRMED is the complete cancellable-active set. IN_PROGRESS
// rides are not cancellable (the ride already started).
const ACTIVE_BOOKING_STATUSES = ['PENDING', 'CONFIRMED'];

// Finalized escrow states that must never be economically mutated again.
const ALREADY_FINALIZED = ['REFUNDED', 'RELEASED', 'EXPIRED'];

const _summary = (outcomes) => {
    const by = (outcome) => outcomes.filter((o) => o.outcome === outcome).length;
    return {
        refunded: by('REFUNDED'),
        cancelledWithoutEscrow: by('CANCELLED_NO_ESCROW'),
        escrowAlreadyFinalized: by('ESCROW_ALREADY_FINALIZED'),
        escrowDisputed: by('ESCROW_DISPUTED'),
        alreadyResolved: by('ALREADY_RESOLVED'),
        failed: by('FAILED'),
    };
};

/**
 * cancelTripWithRefunds — cancel a business transit trip and resolve every
 * funded customer escrow through the canonical refund authority.
 *
 * @param {PrismaClient} prisma
 * @param {object} args
 *   tripId: the trip's id
 *   businessProfileId: the caller's resolved business profile (tenant scope)
 *
 * @returns {object} {
 *   notFound?: true,                                  // trip not in tenant scope
 *   cancelled: boolean,                               // trip reached CANCELLED
 *   tripId, tripStatus,
 *   summary: { refunded, cancelledWithoutEscrow, escrowAlreadyFinalized,
 *              escrowDisputed, alreadyResolved, failed },
 *   bookings: [{ bookingId, customerId, amountUsdc, outcome, escrowStatus,
 *                 refundReference?, error? }],
 * }
 */
const cancelTripWithRefunds = async (prisma, { tripId, businessProfileId }) => {
    // Tenant-scoped load. Eligible bookings: still active, OR already
    // CANCELLED with a still-claimable escrow (legacy stranding recovery —
    // the old route could cancel a booking while leaving its escrow funded).
    const trip = await prisma.transitTrip.findFirst({
        where: { id: tripId, businessProfileId },
        include: {
            bookings: {
                where: {
                    OR: [
                        { status: { in: ACTIVE_BOOKING_STATUSES } },
                        { status: 'CANCELLED', escrow: { status: { in: REFUND_CLAIMABLE } } },
                    ],
                },
                include: { escrow: true },
            },
        },
    });
    if (!trip) {
        return { notFound: true };
    }

    const outcomes = [];

    for (const booking of trip.bookings) {
        const entry = {
            bookingId: booking.id,
            customerId: booking.customerId,
            amountUsdc: Number(booking.amountUsdc),
        };
        try {
            const result = await prisma.$transaction(async (tx) => {
                // 1. Claim the booking (guarded, idempotent). count 0 means a
                //    racing actor (worker/another cancellation) already moved
                //    it out of the active set.
                const claim = await tx.transitBooking.updateMany({
                    where: { id: booking.id, status: { in: ACTIVE_BOOKING_STATUSES } },
                    data: { status: 'CANCELLED' },
                });

                // 2. Resolve the escrow, if any, through the canonical refund.
                //    Re-read inside the tx: the load above is advisory only.
                if (booking.escrowId) {
                    const escrow = await tx.smartEscrow.findUnique({ where: { id: booking.escrowId } });
                    if (escrow && REFUND_CLAIMABLE.includes(escrow.status)) {
                        const reference = randomUUID();
                        await _refundBookingEscrowTx(tx, { escrowId: escrow.id, reference });
                        return { outcome: 'REFUNDED', escrowStatus: 'REFUNDED', refundReference: reference };
                    }
                    if (escrow && escrow.status === 'DISPUTED') {
                        // Dispute resolution owns the money; never mutate it
                        // here. Booking cancellation still removes the
                        // booking from the no-show worker's CONFIRMED set.
                        return { outcome: 'ESCROW_DISPUTED', escrowStatus: 'DISPUTED' };
                    }
                    if (escrow && ALREADY_FINALIZED.includes(escrow.status)) {
                        // Already resolved by the canonical contract (prior
                        // refund/release/expiry). No second economic mutation.
                        return {
                            outcome: claim.count === 1 ? 'ESCROW_ALREADY_FINALIZED' : 'ALREADY_RESOLVED',
                            escrowStatus: escrow.status,
                        };
                    }
                    if (escrow) {
                        // DRAFT (never funded) or any unexpected state: no
                        // money is locked, so cancellation is safe, but the
                        // state is surfaced rather than silently dropped.
                        return { outcome: 'CANCELLED_NO_ESCROW', escrowStatus: escrow.status };
                    }
                    return { outcome: 'CANCELLED_NO_ESCROW', escrowStatus: null };
                }
                return claim.count === 1
                    ? { outcome: 'CANCELLED_NO_ESCROW', escrowStatus: null }
                    : { outcome: 'ALREADY_RESOLVED', escrowStatus: null };
            });
            outcomes.push({ ...entry, ...result });
        } catch (err) {
            // The whole booking+refund pair rolled back: the booking stays in
            // its prior active state, recoverable by retrying this same route.
            logger.error({ err: err.message, bookingId: booking.id },
                '[transitTripCancellation] booking cancellation rolled back');
            outcomes.push({ ...entry, outcome: 'FAILED', error: err.message });
        }
    }

    const summary = _summary(outcomes);

    // 3. Flip the trip to CANCELLED only when every eligible booking resolved.
    //    CAS-guarded: a racing cancellation that already flipped the trip is
    //    the same terminal state, and a partial failure leaves the trip active
    //    so the operation is honestly retryable.
    if (summary.failed === 0) {
        await prisma.transitTrip.updateMany({
            where: { id: tripId, status: { not: 'CANCELLED' } },
            data: { status: 'CANCELLED' },
        });
    }

    const tripAfter = await prisma.transitTrip.findUnique({ where: { id: tripId }, select: { status: true } });

    return {
        cancelled: tripAfter?.status === 'CANCELLED',
        tripId,
        tripStatus: tripAfter?.status,
        summary,
        bookings: outcomes,
    };
};

module.exports = {
    cancelTripWithRefunds,
    ACTIVE_BOOKING_STATUSES,
    REFUND_CLAIMABLE,
};
