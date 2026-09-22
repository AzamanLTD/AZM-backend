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

    // Find CONFIRMED transit bookings where scheduledAt + grace has passed
    const overdue = await prisma.transitBooking.findMany({
        where: {
            status: 'CONFIRMED',
            checkedInAt: null,
            scheduledAt: { lt: graceThreshold },
            escrowId: { not: null },
        },
        include: { escrow: true }
    });

    const results = { processed: 0, penalized: 0, errors: 0, details: [] };

    for (const booking of overdue) {
        try {
            results.processed++;

            const penaltyPct = booking.noShowPenaltyPct ? Number(booking.noShowPenaltyPct) : null;
            const penaltyFlat = booking.noShowPenaltyUsdc ? Number(booking.noShowPenaltyUsdc) : null;

            if (!penaltyPct && !penaltyFlat) {
                await prisma.transitBooking.update({
                    where: { id: booking.id },
                    data: { status: 'NO_SHOW' }
                });
                results.details.push({ id: booking.id, action: 'NO_SHOW_NO_PENALTY' });
                continue;
            }

            const { splitReleaseFundedEscrow } = require('../services/bookingEscrowService');
            const result = await splitReleaseFundedEscrow(prisma, {
                escrowId: booking.escrowId,
                penaltyPct: penaltyPct,
                penaltyFlatUsdc: penaltyFlat,
                reason: 'Transit no-show sweep',
                bookingType: 'TRANSIT',
                bookingId: booking.id,
            });

            results.penalized++;
            results.details.push({
                id: booking.id,
                action: 'PENALTY_CHARGED',
                penaltyAmount: result.penaltyAmount,
                refundAmount: result.refundAmount,
            });

            // MARKETPLACE v2: Update customer trust score
            try {
                const { recordBookingOutcome } = require('../services/customerTrustScoreService');
                await recordBookingOutcome(prisma, {
                    customerId: booking.customerId || (await prisma.transitBooking.findUnique({ where: { id: booking.id }, select: { customerId: true } })).customerId,
                    outcome: 'NO_SHOW'
                });
            } catch (e) {
                logger.error(`[noShowWorker] Trust score update failed for transit booking ${booking.id}:`, e.message);
            }
        } catch (err) {
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
