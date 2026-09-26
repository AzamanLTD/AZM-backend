// services/penaltyPolicyService.js
// =============================================================================
// AZAMAN — Booking Penalty Policy Service (Phase 5)
//
// Authoritative settlement for BUSINESS no-shows (the business defaults:
// cancelled trip, closed hotel, etc.):
//   - Full refund to the customer (payer)
//   - Optional penalty claimed from the business stake
//   - Booking terminal transition + canonical audit row
//
// TARGET INVARIANT — ONE authoritative settlement transaction:
//   eligible funded escrow
//     -> atomic escrow claim -> REFUNDED (canonical escrowService primitive)
//     -> payer escrow bucket -> payer available balance
//     -> business stake penalty claim (guarded, if available)
//     -> booking terminal-state transition
//     -> canonical AuditLog row
//     -> COMMIT
//
// No committed customer refund may coexist with a partially-applied no-show
// state. Messaging/provider/realtime effects are POST-COMMIT and
// non-authoritative — a provider outage can never roll back a settlement.
//
// Called by bookingEscrowService.processBusinessNoShow() to avoid the
// circular self-reference that existed before.
// =============================================================================

const logger = require('../src/config/logger');

// 10% of the escrow principal is the maximum business no-show penalty.
// Do not change the economics as part of an integrity fix.
const MAX_PENALTY_PCT = 0.10;

const _round6 = (n) => parseFloat(Number(n).toFixed(6));

// Deterministic penalty: escrow principal * policy percentage. Never negative.
const _calculateBusinessPenalty = (amountUsdc) => {
    const principal = Number(amountUsdc);
    if (!Number.isFinite(principal) || principal <= 0) return 0;
    return _round6(principal * MAX_PENALTY_PCT);
};

// Pre-terminal booking states eligible for a business-no-show transition, and
// the repo's actual terminal status semantics (ReservationStatus /
// TransitBookingStatus in prisma/schema.prisma — do not invent enum values).
const RESERVATION_PRE_TERMINAL = ['PENDING', 'CONFIRMED', 'CHECKED_IN'];
const RESERVATION_TERMINAL = 'CANCELLED_BUSINESS';
const TRANSIT_PRE_TERMINAL = ['PENDING', 'CONFIRMED', 'IN_PROGRESS'];
const TRANSIT_TERMINAL = 'CANCELLED';

/**
 * Process a business no-show: full refund to customer + optional business
 * stake penalty + booking terminal transition + canonical audit — all inside
 * ONE $transaction.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} params
 * @param {string} params.escrowId - The escrow to refund (authoritative link)
 * @param {string} params.bookingType - 'RESERVATION' | 'TRANSIT' (case-insensitive)
 * @param {string} params.bookingId - The booking the escrow belongs to
 * @param {string} params.businessProfileId - The business that no-showed
 * @param {string} params.reason - Why the business no-showed
 */
async function processBusinessNoShow(prisma, {
    escrowId,
    bookingType,
    bookingId,
    businessProfileId,
    reason,
}) {
    const type = String(bookingType || '').toUpperCase();
    if (!['RESERVATION', 'TRANSIT'].includes(type)) {
        throw new Error('bookingType must be RESERVATION or TRANSIT.');
    }
    // Required lazily: bookingEscrowService requires this module, so a
    // module-level require would create a require cycle.
    const escrowService = require('./escrowService');

    logger.info({ escrowId, bookingType: type, bookingId, businessProfileId, reason },
        '[penaltyPolicy] processing business no-show');

    const result = await prisma.$transaction(async (tx) => {
        // 0. Authoritative escrow read INSIDE the settlement transaction.
        const escrow = await tx.smartEscrow.findUnique({
            where: { id: escrowId }
        });
        if (!escrow) {
            throw new Error('Escrow not found.');
        }

        // IDEMPOTENT CONVERGENCE: a replay AFTER a committed settlement
        // returns the already-committed canonical state and moves nothing.
        if (!['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'].includes(escrow.status)) {
            if (escrow.status === 'REFUNDED') {
                return { alreadyProcessed: true, escrow };
            }
            throw new Error(
                `Escrow cannot be processed for business no-show from status ${escrow.status}.`
            );
        }

        // 0b. BOOKING OWNERSHIP / INPUT INTEGRITY: caller-supplied IDs are
        // identifiers, NOT authorization. The escrow-linked booking is the
        // source of truth — an unrelated bookingId or businessProfileId must
        // never drive a financial mutation.
        let booking = null;
        if (bookingId) {
            booking = type === 'RESERVATION'
                ? await tx.reservation.findUnique({ where: { id: bookingId } })
                : await tx.transitBooking.findUnique({ where: { id: bookingId } });

            if (!booking) {
                throw new Error(`${type} booking not found.`);
            }
            if (booking.escrowId !== escrow.id) {
                const err = new Error(
                    `BOOKING_ESCROW_MISMATCH: booking ${bookingId} is not linked to escrow ${escrow.id}.`
                );
                err.code = 'BOOKING_ESCROW_MISMATCH';
                throw err;
            }
            if (businessProfileId && booking.businessProfileId !== businessProfileId) {
                const err = new Error(
                    `BUSINESS_MISMATCH: booking ${bookingId} does not belong to business ${businessProfileId}.`
                );
                err.code = 'BUSINESS_MISMATCH';
                throw err;
            }
        }

        const businessPenalty = _calculateBusinessPenalty(escrow.amountUsdc);

        // 1. Canonical escrow financial mutation — SAME transaction client.
        // escrowService owns escrow money movement; this service must never
        // reimplement it.
        const refundedEscrow = await escrowService._refundEscrowTx(tx, escrow, 'REFUNDED');

        // 2. Business stake penalty is an ATOMIC claim. Never read stake,
        // compare in JS, then unconditionally decrement. The WHERE clause
        // guards the bucket, so the stake can never go below zero — even on
        // databases without CHECK constraints.
        //    count === 1 -> penalty applied (legitimate deterministic outcome)
        //    count === 0 -> insufficient stake: refund still commits,
        //                   penaltyApplied=false recorded in the audit row
        //    thrown DB error -> the WHOLE settlement rolls back (an
        //                   unexpected failure is never swallowed after the claim)
        let penaltyApplied = false;
        if (businessPenalty > 0 && businessProfileId) {
            const penaltyClaim = await tx.businessProfile.updateMany({
                where: {
                    id: businessProfileId,
                    stakeBalance: { gte: businessPenalty }
                },
                data: {
                    stakeBalance: { decrement: businessPenalty }
                }
            });
            penaltyApplied = penaltyClaim.count === 1;
        }

        // 3. Booking terminal transition — conditional and idempotent. A
        // second invocation can never rewrite an already-terminal booking.
        if (bookingId) {
            const [preTerminal, terminal] = type === 'RESERVATION'
                ? [RESERVATION_PRE_TERMINAL, RESERVATION_TERMINAL]
                : [TRANSIT_PRE_TERMINAL, TRANSIT_TERMINAL];

            const terminalData = terminal === RESERVATION_TERMINAL
                ? {
                    status: terminal,
                    cancelledAt: new Date(),
                    penaltyChargedAt: new Date(),
                    penaltyAmountUsdc: penaltyApplied ? businessPenalty : 0
                }
                : {
                    status: terminal,
                    penaltyChargedAt: new Date(),
                    penaltyAmountUsdc: penaltyApplied ? businessPenalty : 0
                };

            const transitioned = type === 'RESERVATION'
                ? await tx.reservation.updateMany({
                    where: { id: bookingId, status: { in: preTerminal } },
                    data: terminalData
                })
                : await tx.transitBooking.updateMany({
                    where: { id: bookingId, status: { in: preTerminal } },
                    data: terminalData
                });

            if (transitioned.count === 0 && booking.status !== terminal) {
                // The booking cannot reach the business-no-show terminal state.
                // The settlement has NOT committed — refund, stake penalty and
                // audit all roll back; no committed refund may coexist with a
                // stuck booking.
                const err = new Error(
                    `BOOKING_NOT_TRANSITIONABLE: ${type} booking cannot transition to ` +
                    `${terminal} from status ${booking.status}.`
                );
                err.code = 'BOOKING_NOT_TRANSITIONABLE';
                throw err;
            }
        }

        // 4. Audit is authoritative evidence — it belongs INSIDE the same
        // transaction, with the repository's REAL AuditLog field contract:
        // actorId / action / targetType / targetId / metadata / ipAddress.
        await tx.auditLog.create({
            data: {
                actorId: null,
                action: 'BUSINESS_NO_SHOW',
                targetType: type,
                targetId: bookingId || escrow.id,
                metadata: {
                    businessProfileId,
                    escrowId,
                    reason,
                    refundAmount: Number(escrow.amountUsdc),
                    penaltyAmount: businessPenalty,
                    penaltyApplied,
                    penaltyPct: MAX_PENALTY_PCT
                }
            }
        });

        return {
            escrow: refundedEscrow,
            penaltyApplied,
            penaltyAmount: businessPenalty
        };
    });

    // ONLY AFTER COMMIT — non-authoritative convergence effects. A failure
    // here can never roll back the settlement.
    if (result.alreadyProcessed) {
        logger.info({ escrowId },
            '[penaltyPolicy] business no-show already settled — converged without mutation');
        return {
            refunded: true,
            alreadyProcessed: true,
            penaltyApplied: false,
            penaltyAmount: 0,
            refundResult: { escrow: result.escrow }
        };
    }

    logger.info({
        escrowId, businessProfileId,
        penaltyApplied: result.penaltyApplied, penaltyAmount: result.penaltyAmount
    }, '[penaltyPolicy] business no-show settlement committed');

    return {
        refunded: true,
        alreadyProcessed: false,
        penaltyApplied: result.penaltyApplied,
        penaltyAmount: result.penaltyAmount,
        refundResult: { escrow: result.escrow }
    };
}

module.exports = { processBusinessNoShow, MAX_PENALTY_PCT };
