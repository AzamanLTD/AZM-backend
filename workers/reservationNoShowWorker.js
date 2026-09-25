// workers/reservationNoShowWorker.js
// =============================================================================
// AZAMAN — NO-SHOW SWEEP WORKER (2026-07-02)
//
// Runs on a schedule (node-cron) to find reservations and transit bookings
// where the check-in window has passed and the customer never showed up.
// Charges the penalty via splitReleaseFundedEscrow and transitions to NO_SHOW.
//
// For reservations: the no-show window is endDatetime (the reservation period
//   has fully elapsed with no check-in).
// For transit bookings: the no-show window is scheduledAt + grace period
//   (default 30 minutes after departure, no check-in).
// =============================================================================

const logger = require('../src/config/logger');
const GRACE_PERIOD_MINS = 30; // grace after departure before marking transit no-show

// =============================================================================
// sweepNoShowReservations — finds past-due reservations without check-in.
// =============================================================================
const sweepNoShowReservations = async (prisma) => {
    const now = new Date();
    // Include both escrow-backed and unescrowed bookings. The lifecycle
    // authority decides whether to refund/split/expire or transition only.
    const overdue = await prisma.reservation.findMany({
        where: { status: 'CONFIRMED', checkedInAt: null, endDatetime: { lt: now } },
        include: { escrow: true }
    });

    const results = { processed: 0, penalized: 0, errors: 0, details: [] };
    const { markNoShowReservation } = require('../services/reservationLifecycleService');

    for (const reservation of overdue) {
        try {
            results.processed++;
            const updated = await markNoShowReservation(prisma, {
                reservationId: reservation.id,
                worker: true,
            });
            const penaltyAmount = Number(updated.penaltyAmountUsdc || 0);
            if (penaltyAmount > 0) results.penalized++;
            results.details.push({
                id: reservation.id,
                action: penaltyAmount > 0 ? 'PENALTY_CHARGED' : 'NO_SHOW_NO_PENALTY',
                penaltyAmount,
                refundAmount: reservation.escrow
                    ? Number(reservation.escrow.amountUsdc) - penaltyAmount
                    : 0,
            });

            // Trust scoring is post-commit/non-authoritative. A scoring outage
            // cannot roll back or misreport the financial lifecycle outcome.
            try {
                const { recordBookingOutcome } = require('../services/customerTrustScoreService');
                await recordBookingOutcome(prisma, { customerId: reservation.customerId, outcome: 'NO_SHOW' });
            } catch (e) {
                logger.error(`[noShowWorker] Trust score update failed for reservation ${reservation.id}:`, e.message);
            }
        } catch (err) {
            results.errors++;
            results.details.push({ id: reservation.id, error: err.message, code: err.code || null });
            logger.error(`[noShowWorker] Reservation ${reservation.id}:`, err.message);
        }
    }
    return results;
};

// =============================================================================
// sweepNoShowTransitBookings — finds past-due transit bookings without check-in.
// =============================================================================
const sweepNoShowTransitBookings = async (prisma) => {
    const now = new Date();
    const graceThreshold = new Date(now.getTime() - GRACE_PERIOD_MINS * 60 * 1000);

    // Find CONFIRMED transit bookings where scheduledAt + grace has passed.
    // §r41 — unescrowed bookings are swept too (the scan no longer requires
    // escrowId): the escrow authority below decides per-booking whether to
    // split-release, refund, expire or transition only. The scan is just a
    // stale candidate set — every decision is a claim in the transaction.
    const overdue = await prisma.transitBooking.findMany({
        where: {
            status: 'CONFIRMED',
            checkedInAt: null,
            scheduledAt: { lt: graceThreshold },
        },
        include: { escrow: true }
    });

    const results = { processed: 0, penalized: 0, errors: 0, details: [] };

    const {
        _refundBookingEscrowTx, _splitReleaseFundedEscrowTx, REFUND_CLAIMABLE,
    } = require('../services/bookingEscrowService');
    const { randomUUID } = require('crypto');
    // Same dispute-custody definition as the reservation lifecycle: funds in
    // an active dispute are never touched by a no-show sweep.
    const CUSTODY_STATES = new Set(['DISPUTED', 'ADMIN_REVIEW']);

    for (const booking of overdue) {
        try {
            results.processed++;

            // §r41 — CONVERGENT NO-SHOW TRANSITION (final-audit: stranded
            // escrow). The old code had two defects: the no-penalty branch
            // wrote booking NO_SHOW and left the attached FUNDED escrow
            // locked forever (customer funds never refunded), and both
            // branches wrote from a stale scan without a claim, so a racing
            // cancellation could be overwritten to NO_SHOW after its refund
            // had already committed. The whole transition — escrow economics
            // AND booking status — now happens in ONE transaction with fresh
            // reads and conditional claims; a cancellation that won first
            // simply converges to CANCELLED and this sweep does nothing.
            // §r41 third-pass — one bounded reprocess when the claim lost to
            // a raced escrow linkage (the linkage is strictly one-way, so a
            // single retry observes the final linkage; the bound is a safety
            // valve, not a correctness timer).
            let outcome = null;
            for (let sweepAttempt = 1; sweepAttempt <= 2; sweepAttempt++) {
                outcome = await prisma.$transaction(async (tx) => {
                    const fresh = await tx.transitBooking.findUnique({
                        where: { id: booking.id },
                        include: { escrow: true },
                    });
                    if (!fresh) return { action: 'SKIPPED_GONE' };
                    if (fresh.status === 'NO_SHOW') return { action: 'ALREADY_NO_SHOW' };
                    if (fresh.status !== 'CONFIRMED') {
                        return { action: 'SKIPPED_STATUS', status: fresh.status };
                    }

                    const escrow = fresh.escrow;
                    const penaltyPct = fresh.noShowPenaltyPct != null ? Number(fresh.noShowPenaltyPct) : null;
                    const penaltyFlatUsdc = fresh.noShowPenaltyUsdc != null ? Number(fresh.noShowPenaltyUsdc) : null;
                    const hasPenalty = (penaltyPct != null && penaltyPct > 0) || (penaltyFlatUsdc != null && penaltyFlatUsdc > 0);

                    if (escrow && CUSTODY_STATES.has(escrow.status)) {
                        // Funds are in dispute custody — a human owns this escrow.
                        // Record and leave both rows untouched; the dispute
                        // resolution owns the economics.
                        return { action: 'ESCROW_IN_DISPUTE', escrowStatus: escrow.status };
                    }

                    let escrowEconomicsExecuted = false;
                    let penaltyAmount = 0;
                    if (escrow && REFUND_CLAIMABLE.includes(escrow.status)) {
                        if (hasPenalty) {
                            // Atomic split-release: escrow RELEASED + balances +
                            // ledger + booking NO_SHOW claim (CONFIRMED-only)
                            // all commit together or roll back together.
                            const split = await _splitReleaseFundedEscrowTx(tx, {
                                escrowId: escrow.id,
                                penaltyPct,
                                penaltyFlatUsdc,
                                reason: 'Transit no-show sweep',
                                bookingType: 'TRANSIT',
                                bookingId: fresh.id,
                                releaseRef: randomUUID(),
                                refundRef: randomUUID(),
                            });
                            return {
                                action: 'PENALTY_CHARGED',
                                penaltyAmount: split.penaltyAmount,
                                refundAmount: split.refundAmount,
                                customerId: fresh.customerId,
                            };
                        }
                        // No penalty: the FULL refund is part of the same atomic
                        // transition — the escrow can never be stranded FUNDED.
                        await _refundBookingEscrowTx(tx, { escrowId: escrow.id, reference: randomUUID() });
                        escrowEconomicsExecuted = true;
                    } else if (escrow && escrow.status === 'DRAFT') {
                        // Unfunded escrow: expire it in the same transaction.
                        const expired = await tx.smartEscrow.updateMany({
                            where: { id: escrow.id, status: 'DRAFT' },
                            data: { status: 'EXPIRED' },
                        });
                        if (expired.count !== 1) return { action: 'ESCROW_STATE_CONFLICT', escrowStatus: escrow.status };
                        escrowEconomicsExecuted = true;
                    } else if (escrow && !['REFUNDED', 'EXPIRED'].includes(escrow.status)) {
                        // SETTLED/RELEASED and friends: economics already moved
                        // by another authority — never overwrite, flag for humans.
                        return { action: 'ESCROW_ECONOMIC_CONFLICT', escrowStatus: escrow.status };
                    }

                    // Booking transition is a conditional claim on the still-true
                    // no-show pre-state (racing check-in/cancellation loses nothing).
                    // §r41 third-pass review — LINKAGE-PINNED CLAIM: the pinned
                    // escrowId (null when this tx saw no escrow) is part of the
                    // CAS identity. A create/link or funding that commits between
                    // the fresh read above and this claim changes the booking's
                    // escrowId; PostgreSQL's EvalPlanQual re-evaluation against
                    // the newly committed row then FAILS this predicate instead of
                    // silently winning NO_SHOW with a stale null escrowId — which
                    // would strand a FUNDED escrow on a NO_SHOW booking. Because
                    // linkage is strictly one-way (escrowId: null -> E), the claim
                    // winner's pinned escrowId is provably the FINAL linkage.
                    const pinnedEscrowId = fresh.escrowId ?? null;
                    const claim = await tx.transitBooking.updateMany({
                        where: {
                            id: fresh.id,
                            status: 'CONFIRMED',
                            checkedInAt: null,
                            scheduledAt: { lt: graceThreshold },
                            escrowId: pinnedEscrowId,
                        },
                        data: {
                            status: 'NO_SHOW',
                            penaltyChargedAt: hasPenalty ? new Date() : null,
                            penaltyAmountUsdc: hasPenalty ? penaltyAmount : null,
                        },
                    });
                    if (claim.count !== 1) {
                        const now2 = await tx.transitBooking.findUnique({
                            where: { id: fresh.id },
                            select: { status: true, escrowId: true },
                        });
                        const linkageRaced = now2?.status === 'CONFIRMED'
                            && (now2?.escrowId ?? null) !== pinnedEscrowId;
                        if (linkageRaced) {
                            // pinnedEscrowId was null (an escrow-linked claim
                            // cannot lose to a linkage change — one-way linkage),
                            // so THIS tx executed NO escrow economics. Tell the
                            // per-booking loop to re-read and reprocess once
                            // through the escrow-first authority.
                            return { action: 'RETRY_LINKAGE' };
                        }
                        // The booking lost to a racing lifecycle actor (check-in,
                        // cancellation, completion). If THIS tx executed escrow
                        // economics (refund / split-release / DRAFT expiry above),
                        // returning would COMMIT that economics without the
                        // NO_SHOW transition — a stranded-funds defect. THROW so
                        // the whole transaction rolls back; the racing actor owns
                        // the booking and its escrow truth.
                        if (escrowEconomicsExecuted) {
                            const err = new Error('Booking no-show claim lost after escrow economics — rolled back');
                            err.code = 'SWEEP_CLAIM_LOST_ROLLED_BACK';
                            throw err;
                        }
                        return { action: 'CLAIM_LOST' };
                    }
                    return {
                        action: 'NO_SHOW_NO_PENALTY',
                        refundAmount: escrow ? Number(escrow.amountUsdc) : 0,
                        customerId: fresh.customerId,
                    };
                });

            if (outcome.action !== 'RETRY_LINKAGE' || sweepAttempt === 2) break;
            }
            if (outcome.action === 'PENALTY_CHARGED') {
                results.penalized++;
                results.details.push({
                    id: booking.id,
                    action: outcome.action,
                    penaltyAmount: outcome.penaltyAmount,
                    refundAmount: outcome.refundAmount,
                });
            } else if (outcome.action === 'ALREADY_NO_SHOW'
                    || outcome.action === 'SKIPPED_GONE'
                    || outcome.action === 'SKIPPED_STATUS'
                    || outcome.action === 'CLAIM_LOST'
                    || outcome.action === 'ESCROW_IN_DISPUTE'
                    || outcome.action === 'ESCROW_STATE_CONFLICT') {
                // Convergent no-ops and transient custody — the row's real
                // owner won; nothing to report as an error.
                results.details.push({ id: booking.id, action: outcome.action, status: outcome.status, escrowStatus: outcome.escrowStatus });
            } else if (outcome.action === 'ESCROW_ECONOMIC_CONFLICT') {
                results.errors++;
                results.details.push({ id: booking.id, action: outcome.action, escrowStatus: outcome.escrowStatus });
                logger.error(`[noShowWorker] Transit booking ${booking.id}: escrow already ${outcome.escrowStatus} — no-show transition skipped, needs review`);
            } else {
                results.details.push({ id: booking.id, action: outcome.action, refundAmount: outcome.refundAmount });
            }

            // MARKETPLACE v2: Update customer trust score (only when the
            // booking actually reached NO_SHOW this sweep).
            if (outcome.action === 'PENALTY_CHARGED' || outcome.action === 'NO_SHOW_NO_PENALTY') {
                try {
                    const { recordBookingOutcome } = require('../services/customerTrustScoreService');
                    await recordBookingOutcome(prisma, {
                        customerId: outcome.customerId || (await prisma.transitBooking.findUnique({ where: { id: booking.id }, select: { customerId: true } })).customerId,
                        outcome: 'NO_SHOW'
                    });
                } catch (e) {
                    logger.error(`[noShowWorker] Trust score update failed for transit booking ${booking.id}:`, e.message);
                }
            }
        } catch (err) {
            // A racing actor (cancellation, dispute resolution, manual refund)
            // won the escrow's claim between the scan and this sweep's own
            // claims — the transaction rolled back and nothing was written.
            // Converge on the committed booking fact instead of reporting a
            // phantom error: the row's real owner keeps authority.
            if (err && err.code === 'SWEEP_CLAIM_LOST_ROLLED_BACK') {
                // Convergent rollback: a racing actor (check-in, cancellation,
                // completion) owns the booking, and this sweep's escrow
                // economics rolled back whole. Nothing was written — report
                // the same honest no-op as CLAIM_LOST, not a system error.
                results.details.push({ id: booking.id, action: 'CLAIM_LOST' });
                continue;
            }
            if (err && (err.code === 'ESCROW_ALREADY_FINALIZED' || err.code === 'ESCROW_STATE_CONFLICT')) {
                const current = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
                results.details.push({
                    id: booking.id,
                    action: current?.status === 'NO_SHOW' ? 'ALREADY_NO_SHOW' : 'SKIPPED_STATUS',
                    status: current?.status || 'GONE',
                });
                continue;
            }
            results.errors++;
            results.details.push({ id: booking.id, error: err.message });
            logger.error(`[noShowWorker] Transit booking ${booking.id}:`, err.message);
        }
    }

    return results;
};

// =============================================================================
// sweepAll — convenience function to run both sweeps.
// =============================================================================
const sweepAll = async (prisma) => {
    const reservationResults = await sweepNoShowReservations(prisma);
    const transitResults = await sweepNoShowTransitBookings(prisma);
    return { reservations: reservationResults, transit: transitResults };
};

module.exports = { sweepNoShowReservations, sweepNoShowTransitBookings, sweepAll, GRACE_PERIOD_MINS };
