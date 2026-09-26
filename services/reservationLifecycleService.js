// services/reservationLifecycleService.js
// =============================================================================
// r29 P0 — authoritative Reservation lifecycle/economic boundary.
//
// Every terminal lifecycle operation claims the escrow first (when present)
// and the Reservation second, inside ONE PostgreSQL transaction. All competing
// operations use this order, so cancellation/check-in/no-show cannot deadlock
// through inverted locks and exactly one economic fact can win.
// =============================================================================

const { randomUUID } = require('crypto');
const {
    _refundBookingEscrowTx,
    _releaseBookingEscrowTx,
    _splitReleaseFundedEscrowTx,
    REFUND_CLAIMABLE,
    RELEASE_CLAIMABLE,
} = require('./bookingEscrowService');

const CUSTODY_STATES = new Set(['DISPUTED', 'ADMIN_REVIEW']);
const fail = (code, message = code) => {
    const err = new Error(message);
    err.code = code;
    return err;
};

const loadAggregate = (tx, reservationId) => tx.reservation.findUnique({
    where: { id: reservationId },
    include: { escrow: true, businessProfile: true },
});

const claimReservation = async (tx, { reservationId, from, where = {}, data }) => {
    const claimed = await tx.reservation.updateMany({
        where: { id: reservationId, status: { in: from }, ...where },
        data,
    });
    if (claimed.count !== 1) throw fail('RESERVATION_STATE_CONFLICT');
    return tx.reservation.findUnique({ where: { id: reservationId } });
};

const expireDraftEscrow = async (tx, escrow) => {
    if (!escrow || escrow.status !== 'DRAFT') return;
    const claim = await tx.smartEscrow.updateMany({
        where: { id: escrow.id, status: 'DRAFT' },
        data: { status: 'EXPIRED' },
    });
    if (claim.count !== 1) throw fail('ESCROW_STATE_CONFLICT');
};


const runConvergent = async (prisma, reservationId, targetStatus, work) => {
    try {
        return await prisma.$transaction(work);
    } catch (err) {
        // A same-operation contender can read the old aggregate before
        // blocking on the winner's escrow row. Converge from the committed
        // reservation fact after rollback; different terminal facts conflict.
        if (['ESCROW_ALREADY_FINALIZED', 'ESCROW_STATE_CONFLICT', 'RESERVATION_STATE_CONFLICT'].includes(err.code)) {
            const current = await prisma.reservation.findUnique({ where: { id: reservationId } });
            if (current?.status === targetStatus) return current;
        }
        throw err;
    }
};


const confirmReservation = async (prisma, { reservationId, businessProfileId, businessNotes = null }) => {
    const confirmedAt = new Date();
    return prisma.$transaction(async (tx) => {
        const claimed = await tx.reservation.updateMany({
            where: {
                id: reservationId,
                businessProfileId,
                status: 'PENDING',
            },
            data: {
                status: 'CONFIRMED',
                confirmedAt,
                businessNotes,
            },
        });

        if (claimed.count !== 1) {
            const current = await tx.reservation.findUnique({
                where: { id: reservationId },
                select: { businessProfileId: true, status: true },
            });
            if (!current || current.businessProfileId !== businessProfileId) {
                throw fail('RESERVATION_NOT_FOUND', 'Reservation not found.');
            }
            throw fail('RESERVATION_CONFIRM_CONFLICT', `Reservation is already ${current.status}.`);
        }

        return tx.reservation.findUnique({ where: { id: reservationId } });
    });
};

const cancelReservation = async (prisma, { reservationId, customerId }) =>
    runConvergent(prisma, reservationId, 'CANCELLED_CUSTOMER', async (tx) => {
        const reservation = await loadAggregate(tx, reservationId);
        if (!reservation || reservation.customerId !== customerId) {
            throw fail('RESERVATION_NOT_FOUND', 'Reservation not found.');
        }
        if (reservation.status === 'CANCELLED_CUSTOMER') return reservation;
        if (!['PENDING', 'CONFIRMED'].includes(reservation.status)) {
            throw fail('RESERVATION_NOT_CANCELLABLE', `Cannot cancel a reservation with status ${reservation.status}.`);
        }

        const escrow = reservation.escrow;
        if (escrow && CUSTODY_STATES.has(escrow.status)) {
            throw fail('ESCROW_IN_DISPUTE', 'Reservation funds are in dispute custody.');
        }
        if (escrow && REFUND_CLAIMABLE.includes(escrow.status)) {
            await _refundBookingEscrowTx(tx, { escrowId: escrow.id, reference: randomUUID() });
        } else if (escrow?.status === 'DRAFT') {
            await expireDraftEscrow(tx, escrow);
        } else if (escrow && !['REFUNDED', 'EXPIRED'].includes(escrow.status)) {
            throw fail('ESCROW_ECONOMIC_CONFLICT', `Escrow is already ${escrow.status}.`);
        }

        return claimReservation(tx, {
            reservationId,
            from: ['PENDING', 'CONFIRMED'],
            data: { status: 'CANCELLED_CUSTOMER', cancelledAt: new Date() },
        });
    });

const checkInReservation = async (prisma, { reservationId, businessUserId }) =>
    runConvergent(prisma, reservationId, 'CHECKED_IN', async (tx) => {
        const reservation = await loadAggregate(tx, reservationId);
        if (!reservation || reservation.businessProfile?.userId !== businessUserId) {
            throw fail('RESERVATION_NOT_FOUND', 'Reservation not found.');
        }
        if (reservation.status === 'CHECKED_IN') return reservation;
        if (reservation.status !== 'CONFIRMED') {
            throw fail('RESERVATION_NOT_CHECKIN_READY', `Reservation is ${reservation.status}, cannot check in.`);
        }

        const escrow = reservation.escrow;
        if (escrow && CUSTODY_STATES.has(escrow.status)) {
            throw fail('ESCROW_IN_DISPUTE', 'Reservation funds are in dispute custody.');
        }
        if (escrow && RELEASE_CLAIMABLE.includes(escrow.status)) {
            await _releaseBookingEscrowTx(tx, { escrowId: escrow.id, reference: randomUUID() });
        } else if (escrow?.status === 'DRAFT') {
            await expireDraftEscrow(tx, escrow);
        } else if (escrow && !['SETTLED', 'EXPIRED'].includes(escrow.status)) {
            throw fail('ESCROW_ECONOMIC_CONFLICT', `Escrow is already ${escrow.status}.`);
        }

        return claimReservation(tx, {
            reservationId,
            from: ['CONFIRMED'],
            data: { status: 'CHECKED_IN', checkedInAt: new Date() },
        });
    });

const markNoShowReservation = async (prisma, { reservationId, businessUserId = null, worker = false }) =>
    runConvergent(prisma, reservationId, 'NO_SHOW', async (tx) => {
        const reservation = await loadAggregate(tx, reservationId);
        if (!reservation) throw fail('RESERVATION_NOT_FOUND', 'Reservation not found.');
        if (!worker && reservation.businessProfile?.userId !== businessUserId) {
            throw fail('RESERVATION_NOT_FOUND', 'Reservation not found.');
        }
        if (reservation.status === 'NO_SHOW') return reservation;
        if (reservation.status !== 'CONFIRMED') {
            throw fail('RESERVATION_NOT_NO_SHOW_READY', `Reservation is ${reservation.status}, cannot mark no-show.`);
        }
        if (reservation.checkedInAt || reservation.endDatetime >= new Date()) {
            throw fail('RESERVATION_NOT_NO_SHOW_READY', 'Reservation cannot be marked no-show before its end time.');
        }

        const escrow = reservation.escrow;
        if (escrow && CUSTODY_STATES.has(escrow.status)) {
            throw fail('ESCROW_IN_DISPUTE', 'Reservation funds remain in dispute custody.');
        }

        const penaltyPct = reservation.noShowPenaltyPct != null ? Number(reservation.noShowPenaltyPct) : null;
        const penaltyFlatUsdc = reservation.noShowPenaltyUsdc != null ? Number(reservation.noShowPenaltyUsdc) : null;
        const hasPenalty = (penaltyPct != null && penaltyPct > 0) || (penaltyFlatUsdc != null && penaltyFlatUsdc > 0);

        if (escrow && REFUND_CLAIMABLE.includes(escrow.status)) {
            if (hasPenalty) {
                await _splitReleaseFundedEscrowTx(tx, {
                    escrowId: escrow.id,
                    penaltyPct,
                    penaltyFlatUsdc,
                    reason: worker ? 'Reservation no-show sweep' : 'Business marked reservation no-show',
                    bookingType: 'RESERVATION',
                    bookingId: reservation.id,
                    releaseRef: randomUUID(),
                    refundRef: randomUUID(),
                    reservationClaimWhere: {
                        checkedInAt: null,
                        endDatetime: { lt: new Date() },
                    },
                });
                return tx.reservation.findUnique({ where: { id: reservationId } });
            }
            await _refundBookingEscrowTx(tx, { escrowId: escrow.id, reference: randomUUID() });
        } else if (escrow?.status === 'DRAFT') {
            await expireDraftEscrow(tx, escrow);
        } else if (escrow && !['REFUNDED', 'EXPIRED'].includes(escrow.status)) {
            throw fail('ESCROW_ECONOMIC_CONFLICT', `Escrow is already ${escrow.status}.`);
        }

        return claimReservation(tx, {
            reservationId,
            from: ['CONFIRMED'],
            where: {
                checkedInAt: null,
                endDatetime: { lt: new Date() },
            },
            data: {
                status: 'NO_SHOW',
                penaltyChargedAt: hasPenalty ? new Date() : null,
                penaltyAmountUsdc: hasPenalty ? 0 : null,
            },
        });
    });

const checkOutReservation = async (prisma, { reservationId, businessUserId }) =>
    runConvergent(prisma, reservationId, 'CHECKED_OUT', async (tx) => {
        const reservation = await loadAggregate(tx, reservationId);
        if (!reservation || reservation.businessProfile?.userId !== businessUserId) {
            throw fail('RESERVATION_NOT_FOUND', 'Reservation not found.');
        }
        if (reservation.status === 'CHECKED_OUT') return reservation;
        if (reservation.status !== 'CHECKED_IN') {
            throw fail('RESERVATION_NOT_CHECKOUT_READY', `Reservation is ${reservation.status}, cannot check out.`);
        }
        return claimReservation(tx, {
            reservationId,
            from: ['CHECKED_IN'],
            data: { status: 'CHECKED_OUT', checkedOutAt: new Date() },
        });
    });

module.exports = {
    confirmReservation,
    cancelReservation,
    checkInReservation,
    checkOutReservation,
    markNoShowReservation,
};
