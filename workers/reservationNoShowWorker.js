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

const GRACE_PERIOD_MINS = 30; // grace after departure before marking transit no-show

// =============================================================================
// sweepNoShowReservations — finds past-due reservations without check-in.
// =============================================================================
const sweepNoShowReservations = async (prisma) => {
    const now = new Date();

    // Find CONFIRMED reservations where endDatetime has passed and no check-in
    const overdue = await prisma.reservation.findMany({
        where: {
            status: 'CONFIRMED',
            checkedInAt: null,
            endDatetime: { lt: now },
            escrowId: { not: null },
        },
        include: { escrow: true }
    });

    const results = { processed: 0, penalized: 0, errors: 0, details: [] };

    for (const reservation of overdue) {
        try {
            results.processed++;

            // Determine penalty amount
            const penaltyPct = reservation.noShowPenaltyPct
                ? Number(reservation.noShowPenaltyPct) : null;
            const penaltyFlat = reservation.noShowPenaltyUsdc
                ? Number(reservation.noShowPenaltyUsdc) : null;

            // If no penalty is configured, just mark as no-show without charging
            if (!penaltyPct && !penaltyFlat) {
                await prisma.reservation.update({
                    where: { id: reservation.id },
                    data: { status: 'NO_SHOW' }
                });
                results.details.push({ id: reservation.id, action: 'NO_SHOW_NO_PENALTY' });
                continue;
            }

            // Charge penalty via split-release
            const { splitReleaseFundedEscrow } = require('../services/bookingEscrowService');
            const result = await splitReleaseFundedEscrow(prisma, {
                escrowId: reservation.escrowId,
                penaltyPct: penaltyPct,
                penaltyFlatUsdc: penaltyFlat,
                reason: 'Reservation no-show sweep',
                bookingType: 'RESERVATION',
                bookingId: reservation.id,
            });

            results.penalized++;
            results.details.push({
                id: reservation.id,
                action: 'PENALTY_CHARGED',
                penaltyAmount: result.penaltyAmount,
                refundAmount: result.refundAmount,
            });
        } catch (err) {
            results.errors++;
            results.details.push({ id: reservation.id, error: err.message });
            console.error(`[noShowWorker] Reservation ${reservation.id}:`, err.message);
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
        } catch (err) {
            results.errors++;
            results.details.push({ id: booking.id, error: err.message });
            console.error(`[noShowWorker] Transit booking ${booking.id}:`, err.message);
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
