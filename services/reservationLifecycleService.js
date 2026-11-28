// services/reservationLifecycleService.js
// =============================================================================
// r29 P0 — authoritative Reservation lifecycle/economic boundary.
//
// Every terminal lifecycle operation claims the escrow first (when present)
// and the Reservation second, inside ONE PostgreSQL transaction. All competing
// operations use this order, so cancellation/check-in/no-show cannot deadlock
// through inverted locks and exactly one economic fact can win.
// =============================================================================

const { REFUND_CAUSE, refundsFeeNow } = require('./feeRefundPolicy');
const { isPaidStay, noShowCutoff } = require('./paidStayPolicy');
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


const runConvergent = async (prisma, reservationId, targetStatus, work, { onConverge = null } = {}) => {
    try {
        return await prisma.$transaction(work);
    } catch (err) {
        // A same-operation contender can read the old aggregate before
        // blocking on the winner's escrow row. Converge from the committed
        // reservation fact after rollback; different terminal facts conflict.
        if (['ESCROW_ALREADY_FINALIZED', 'ESCROW_STATE_CONFLICT', 'RESERVATION_STATE_CONFLICT'].includes(err.code)) {
            const current = await prisma.reservation.findUnique({ where: { id: reservationId } });
            if (current?.status === targetStatus) {
                // r29: convergence is right for an idempotent retry and wrong
                // for a one-use credential. The caller decides which it is;
                // the default (null) keeps every existing path unchanged.
                if (onConverge) return onConverge(current);
                return current;
            }
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
            await _refundBookingEscrowTx(tx, {
                escrowId: escrow.id,
                reference: randomUUID(),
                refundFee: await refundsFeeNow(tx, REFUND_CAUSE.CUSTOMER_CANCELLED),
            });
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

// The hotel cancels a stay it cannot honour (or declines a request): a paid
// stay is refunded in the same transaction as the claim, the Azaman fee
// included (feeRefundPolicy: the business cancelled).
//
// unansweredAsOf (the request-expiry sweep): close it only while it is still
// an unanswered request at that moment (PENDING, and started or 72h old),
// re-checked in the claim's own conditional UPDATE, so a business confirming
// (or a guest's deposit confirming it) at the same instant wins and the
// refund rolls back with the refused claim.
const REQUEST_ANSWER_WINDOW_MS = 72 * 60 * 60 * 1000;
const _unansweredWhere = (asOf) => ({
    OR: [
        { startDatetime: { lte: asOf } },
        { createdAt: { lte: new Date(asOf.getTime() - REQUEST_ANSWER_WINDOW_MS) } },
    ],
});
const _isUnanswered = (r, asOf) => r.status === 'PENDING'
    && ((r.startDatetime && new Date(r.startDatetime) <= asOf)
        || (r.createdAt && new Date(r.createdAt).getTime() <= asOf.getTime() - REQUEST_ANSWER_WINDOW_MS));

const businessCancelReservation = async (prisma, { reservationId, businessProfileId, reason = null, unansweredAsOf = null }) =>
    runConvergent(prisma, reservationId, 'CANCELLED_BUSINESS', async (tx) => {
        const reservation = await loadAggregate(tx, reservationId);
        if (!reservation || reservation.businessProfileId !== businessProfileId) {
            throw fail('RESERVATION_NOT_FOUND', 'Reservation not found.');
        }
        if (reservation.status === 'CANCELLED_BUSINESS') return reservation;
        if (unansweredAsOf && !_isUnanswered(reservation, unansweredAsOf)) {
            throw fail('RESERVATION_ANSWERED', 'This request was answered or changed; it is not expired.');
        }
        if (!['PENDING', 'CONFIRMED'].includes(reservation.status)) {
            throw fail('RESERVATION_NOT_CANCELLABLE', `Cannot cancel a reservation with status ${reservation.status}.`);
        }
        const escrow = reservation.escrow;
        if (escrow && CUSTODY_STATES.has(escrow.status)) {
            throw fail('ESCROW_IN_DISPUTE', 'Reservation funds are in dispute custody.');
        }
        // An expired request did not take place (REFUND_CAUSE.EXPIRED);
        // otherwise the business cancelled. Both give the fee back by
        // default; each is set separately in the Fee Lab.
        if (escrow && REFUND_CLAIMABLE.includes(escrow.status)) {
            await _refundBookingEscrowTx(tx, {
                escrowId: escrow.id,
                reference: randomUUID(),
                refundFee: await refundsFeeNow(tx, unansweredAsOf ? REFUND_CAUSE.EXPIRED : REFUND_CAUSE.BUSINESS_CANCELLED),
            });
        } else if (escrow?.status === 'DRAFT') {
            await expireDraftEscrow(tx, escrow);
        } else if (escrow && !['REFUNDED', 'EXPIRED'].includes(escrow.status)) {
            throw fail('ESCROW_ECONOMIC_CONFLICT', `Escrow is already ${escrow.status}.`);
        }
        return claimReservation(tx, {
            reservationId,
            from: unansweredAsOf ? ['PENDING'] : ['PENDING', 'CONFIRMED'],
            where: unansweredAsOf ? _unansweredWhere(unansweredAsOf) : {},
            data: {
                status: 'CANCELLED_BUSINESS',
                cancelledAt: new Date(),
                ...(reason ? { businessNotes: String(reason).slice(0, 500) } : {}),
            },
        });
    });

// method: 'QR' (the guest's own QR, qrCheckInService) or 'MANUAL' (staff by
// hand). A reservation whose money is held in Azaman (a paid stay, a funded
// deposit) never checks in by hand: its check-in is what pays the business,
// so it takes the guest's QR, or an ID check (stayCheckInService, which holds
// the money until the guest confirms). The rule lives here so no caller can
// skip it.
const checkInReservation = async (prisma, { reservationId, businessUserId, requireFreshClaim = false, method = 'MANUAL' }) => {
    // A QR token is a ONE-USE credential; a staff retry on the same reservation
    // is not. `requireFreshClaim` keeps the convergent default for the manual
    // path and makes the token path refuse any use that did not itself perform
    // the transition. PostgreSQL arbitrates the race inside claimReservation's
    // conditional UPDATE, so exactly one caller can claim.
    const refuseIfConverged = requireFreshClaim
        ? () => { throw fail('RESERVATION_ALREADY_CHECKED_IN', 'This reservation has already been checked in.'); }
        : null;
    return runConvergent(prisma, reservationId, 'CHECKED_IN', async (tx) => {
        const reservation = await loadAggregate(tx, reservationId);
        if (!reservation || reservation.businessProfile?.userId !== businessUserId) {
            throw fail('RESERVATION_NOT_FOUND', 'Reservation not found.');
        }
        if (reservation.status === 'CHECKED_IN') {
            if (requireFreshClaim) {
                throw fail('RESERVATION_ALREADY_CHECKED_IN', 'This reservation has already been checked in.');
            }
            return reservation;
        }
        if (reservation.status !== 'CONFIRMED') {
            throw fail('RESERVATION_NOT_CHECKIN_READY', `Reservation is ${reservation.status}, cannot check in.`);
        }

        const escrow = reservation.escrow;
        if (escrow && CUSTODY_STATES.has(escrow.status)) {
            throw fail('ESCROW_IN_DISPUTE', 'Reservation funds are in dispute custody.');
        }
        if (method !== 'QR' && escrow && RELEASE_CLAIMABLE.includes(escrow.status)) {
            throw fail('QR_CHECKIN_REQUIRED', "This stay is paid in Azaman. Scan the guest's check-in QR, or check them in by ID check.");
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
    }, { onConverge: refuseIfConverged });
};

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
        // A stay paid in the app stays open for a late arrival until noon on
        // the check-out day (paidStayPolicy); any other reservation is a
        // no-show from its end.
        const cutoff = noShowCutoff(reservation);
        if (reservation.checkedInAt || reservation.endDatetime >= cutoff) {
            throw fail('RESERVATION_NOT_NO_SHOW_READY', isPaidStay(reservation)
                ? 'A paid stay can be marked no-show from noon on its check-out day.'
                : 'Reservation cannot be marked no-show before its end time.');
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
                        endDatetime: { lt: cutoff },
                    },
                });
                return tx.reservation.findUnique({ where: { id: reservationId } });
            }
            await _refundBookingEscrowTx(tx, {
                escrowId: escrow.id,
                reference: randomUUID(),
                refundFee: await refundsFeeNow(tx, REFUND_CAUSE.NO_SHOW),
            });
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
                endDatetime: { lt: cutoff },
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
    REQUEST_ANSWER_WINDOW_MS,
    confirmReservation,
    cancelReservation,
    businessCancelReservation,
    checkInReservation,
    checkOutReservation,
    markNoShowReservation,
};
