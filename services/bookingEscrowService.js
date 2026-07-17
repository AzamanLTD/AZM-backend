// services/bookingEscrowService.js
// =============================================================================
// AZAMAN — BOOKING ESCROW SERVICE (2026-07-02)
// Shared escrow wiring for Reservations (hotels) and TransitBookings (transit).
// Also provides splitReleaseFundedEscrow — the no-show penalty primitive.
// =============================================================================

const { randomUUID } = require('crypto');
const { runDoubleCheck } = require('../utils/securityCheck');

const BOOKING_ESCROW_FEE_PCT = 0.005;
const MAX_PENALTY_PCT = 0.50;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const _round6 = (n) => parseFloat(Number(n).toFixed(6));

const _ensureProfitFeesSingleton = async (tx) =>
    tx.systemProfitFees.upsert({ where: { id: 1 }, update: {}, create: { id: 1, balance: 0.0 } });

// 1. CREATE BOOKING ESCROW — DRAFT state, no money moves.
const createBookingEscrow = async (prisma, {
    bookingType, bookingId, payerId, payeeId,
    amountUsdc, businessProfileId, deliveryTerms
}) => {
    if (!bookingType || !['RESERVATION', 'TRANSIT'].includes(bookingType))
        throw new Error('bookingType must be RESERVATION or TRANSIT.');
    if (!bookingId) throw new Error('bookingId is required.');
    if (!payerId || !payeeId) throw new Error('payerId and payeeId are required.');
    const amount = Number(amountUsdc);
    if (!Number.isFinite(amount) || amount <= 0)
        throw new Error('amountUsdc must be a positive number.');
    if (payerId === payeeId) throw new Error('Payer and payee cannot be the same user.');

    const model = bookingType === 'RESERVATION' ? 'reservation' : 'transitBooking';
    const existing = await prisma[model].findUnique({ where: { id: bookingId }, select: { escrowId: true } });
    if (existing?.escrowId) throw new Error(`${bookingType} booking already has an escrow.`);

    const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
    const feePct = settings && settings.smartEscrowFeePct != null ? Number(settings.smartEscrowFeePct) : BOOKING_ESCROW_FEE_PCT;
    const feeUsdc = _round6(amount * feePct);

    const ticket = await prisma.ticket.create({
        data: {
            creatorId: payerId, counterpartyId: payeeId,
            name: bookingType === 'RESERVATION' ? 'Reservation Chat' : 'Transit Booking Chat',
            type: 'ESCROW', targetAmount: amount, targetCurrency: 'USDC',
            status: 'OPEN', businessProfileId, lastActivityAt: new Date(),
        }
    });

    const escrow = await prisma.smartEscrow.create({
        data: {
            ticketId: ticket.id, payerId, payeeId,
            amountUsdc: amount, feeUsdc, status: 'DRAFT',
            deliveryTerms: deliveryTerms || `Booking deposit for ${bookingType}`,
            expiresAt: new Date(Date.now() + 24 * HOUR_MS),
        }
    });

    await prisma[model].update({ where: { id: bookingId }, data: { escrowId: escrow.id, ticketId: ticket.id } });
    return { escrow, ticket };
};

// 2. FUND BOOKING ESCROW — payer locks USDC.
const fundBookingEscrow = async (prisma, { escrowId, payerId, bookingType, bookingId }) => {
    const escrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId }, include: { ticket: true } });
    if (!escrow) throw new Error('Escrow not found.');
    if (escrow.status !== 'DRAFT') throw new Error(`Escrow cannot be funded from status ${escrow.status}.`);
    if (escrow.payerId !== payerId) throw new Error('Only the payer can fund this escrow.');

    await runDoubleCheck(prisma, payerId);

    const amount = Number(escrow.amountUsdc);
    const fee = Number(escrow.feeUsdc);
    const total = _round6(amount + fee);

    const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
    const fundedExpiryDays = settings && settings.escrowFundedExpiryDays != null ? Number(settings.escrowFundedExpiryDays) : 30;
    const reference = randomUUID();

    const updatedEscrow = await prisma.$transaction(async (tx) => {
        const payer = await tx.user.findUnique({ where: { id: payerId }, select: { availableBalance: true } });
        if (!payer) throw new Error('Payer not found.');
        if (Number(payer.availableBalance) < total)
            throw new Error(`Insufficient balance. Required: ${total}, available: ${Number(payer.availableBalance).toFixed(6)}.`);

        await tx.user.update({ where: { id: payerId }, data: { availableBalance: { decrement: total } } });
        await tx.user.update({ where: { id: payerId }, data: { escrowLockedBalance: { increment: amount } } });

        await _ensureProfitFeesSingleton(tx);
        await tx.systemProfitFees.update({ where: { id: 1 }, data: { balance: { increment: fee } } });

        const updated = await tx.smartEscrow.update({
            where: { id: escrowId },
            data: { status: 'FUNDED', fundedAt: new Date(), expiresAt: new Date(Date.now() + fundedExpiryDays * DAY_MS), fundTxHash: reference }
        });

        await tx.transactionHistory.create({
            data: { userId: payerId, type: 'TICKET_ESCROW_FUND', amountUsdc: -amount, feeUsdc: fee, txHash: reference, status: 'COMPLETED' }
        });

        if (fee > 0) {
            await tx.adminProfitLog.create({
                data: { amountUsdc: fee, source: 'SMART_ESCROW_FEE', relatedTxId: `booking_fee_${escrow.ticketId}_${reference}` }
            });
        }
        return updated;
    });

    const _messagingChannelsService = require('./messagingChannels');

    if (bookingType === 'RESERVATION' && bookingId) {
        const resCount = await prisma.reservation.updateMany({ where: { id: bookingId, status: 'PENDING' }, data: { status: 'CONFIRMED', confirmedAt: new Date() } });
        if (resCount.count > 0) {
            const res = await prisma.reservation.findUnique({ where: { id: bookingId }, include: { user: true } });
            if (res && res.user?.phoneNumber) {
                _messagingChannelsService.notifyBookingConfirmed(res.businessProfileId, res.user.phoneNumber, res.id, res.reservationTime).catch(err => console.error('[MessagingChannels] Error:', err));
            }
        }
    } else if (bookingType === 'TRANSIT' && bookingId) {
        const tbCount = await prisma.transitBooking.updateMany({ where: { id: bookingId, status: 'PENDING' }, data: { status: 'CONFIRMED' } });
        if (tbCount.count > 0) {
            const tb = await prisma.transitBooking.findUnique({ where: { id: bookingId }, include: { user: true, trip: true } });
            if (tb && tb.user?.phoneNumber) {
                _messagingChannelsService.notifyBookingConfirmed(tb.trip?.businessProfileId || tb.businessProfileId, tb.user.phoneNumber, tb.id, tb.trip?.scheduledDeparture || new Date()).catch(err => console.error('[MessagingChannels] Error:', err));
            }
        }
    }

    return { success: true, escrow: updatedEscrow, reference };
};

// 3. RELEASE BOOKING ESCROW — Full release to business on check-in/completion.
const releaseBookingEscrow = async (prisma, { escrowId }) => {
    const escrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
    if (!escrow) throw new Error('Escrow not found.');
    const amount = Number(escrow.amountUsdc);
    const claimable = ['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'];
    const reference = randomUUID();

    const updated = await prisma.$transaction(async (tx) => {
        const claim = await tx.smartEscrow.updateMany({
            where: { id: escrowId, status: { in: claimable } },
            data: { status: 'SETTLED', settledAt: new Date(), releaseTxHash: reference }
        });
        if (claim.count === 0) throw new Error('ESCROW_ALREADY_FINALIZED');

        await tx.user.update({ where: { id: escrow.payerId }, data: { escrowLockedBalance: { decrement: amount } } });
        await tx.user.update({ where: { id: escrow.payeeId }, data: { availableBalance: { increment: amount } } });
        await tx.transactionHistory.create({
            data: { userId: escrow.payeeId, type: 'TICKET_ESCROW_RELEASE', amountUsdc: amount, feeUsdc: 0, txHash: reference, status: 'COMPLETED' }
        });
        return await tx.smartEscrow.findUnique({ where: { id: escrowId } });
    });
    return { success: true, escrow: updated, reference };
};

// 4. REFUND BOOKING ESCROW — Full refund to customer on cancellation.
const refundBookingEscrow = async (prisma, { escrowId }) => {
    const escrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
    if (!escrow) throw new Error('Escrow not found.');
    const amount = Number(escrow.amountUsdc);
    const claimable = ['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'];
    const reference = randomUUID();

    const updated = await prisma.$transaction(async (tx) => {
        const claim = await tx.smartEscrow.updateMany({
            where: { id: escrowId, status: { in: claimable } },
            data: { status: 'REFUNDED', refundedAt: new Date(), refundTxHash: reference }
        });
        if (claim.count === 0) throw new Error('ESCROW_ALREADY_FINALIZED');

        await tx.user.update({ where: { id: escrow.payerId }, data: { escrowLockedBalance: { decrement: amount }, availableBalance: { increment: amount } } });
        await tx.transactionHistory.create({
            data: { userId: escrow.payerId, type: 'TICKET_ESCROW_REFUND', amountUsdc: amount, feeUsdc: 0, txHash: reference, status: 'COMPLETED' }
        });
        return await tx.smartEscrow.findUnique({ where: { id: escrowId } });
    });
    return { success: true, escrow: updated, reference };
};

// 5. SPLIT-RELEASE FUNDED ESCROW — The no-show penalty primitive.
const splitReleaseFundedEscrow = async (prisma, {
    escrowId, penaltyPct, penaltyFlatUsdc, reason, bookingType, bookingId
}) => {
    const escrow = await prisma.smartEscrow.findUnique({ where: { id: escrowId } });
    if (!escrow) throw new Error('Escrow not found.');
    const claimable = ['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'];
    if (!claimable.includes(escrow.status)) throw new Error(`Cannot split-release an escrow in status ${escrow.status}.`);

    const principal = Number(escrow.amountUsdc);
    let penaltyAmount;
    if (penaltyFlatUsdc != null && penaltyFlatUsdc > 0) {
        penaltyAmount = Math.min(Number(penaltyFlatUsdc), principal);
    } else if (penaltyPct != null && penaltyPct > 0) {
        const cappedPct = Math.min(Number(penaltyPct), MAX_PENALTY_PCT);
        penaltyAmount = _round6(principal * cappedPct);
    } else {
        throw new Error('Either penaltyPct or penaltyFlatUsdc must be a positive value.');
    }
    penaltyAmount = Math.min(penaltyAmount, principal);
    const refundAmount = _round6(principal - penaltyAmount);

    const releaseRef = randomUUID();
    const refundRef = randomUUID();

    const result = await prisma.$transaction(async (tx) => {
        const claim = await tx.smartEscrow.updateMany({
            where: { id: escrowId, status: { in: claimable } },
            data: { status: 'RELEASED', settledAt: new Date(), releaseTxHash: releaseRef, refundTxHash: refundRef }
        });
        if (claim.count === 0) throw new Error('ESCROW_ALREADY_FINALIZED');

        await tx.user.update({ where: { id: escrow.payerId }, data: { escrowLockedBalance: { decrement: principal } } });

        if (penaltyAmount > 0) {
            await tx.user.update({ where: { id: escrow.payeeId }, data: { availableBalance: { increment: penaltyAmount } } });
            await tx.transactionHistory.create({
                data: { userId: escrow.payeeId, type: 'TICKET_ESCROW_RELEASE', amountUsdc: penaltyAmount, feeUsdc: 0, txHash: releaseRef, status: 'COMPLETED' }
            });
        }
        if (refundAmount > 0) {
            await tx.user.update({ where: { id: escrow.payerId }, data: { availableBalance: { increment: refundAmount } } });
            await tx.transactionHistory.create({
                data: { userId: escrow.payerId, type: 'TICKET_ESCROW_REFUND', amountUsdc: refundAmount, feeUsdc: 0, txHash: refundRef, status: 'COMPLETED' }
            });
        }
        return { escrow: await tx.smartEscrow.findUnique({ where: { id: escrowId } }), penaltyAmount, refundAmount };
    });

    if (bookingType === 'RESERVATION' && bookingId) {
        await prisma.reservation.update({ where: { id: bookingId }, data: { status: 'NO_SHOW', penaltyChargedAt: new Date(), penaltyAmountUsdc: result.penaltyAmount } });
    } else if (bookingType === 'TRANSIT' && bookingId) {
        await prisma.transitBooking.update({ where: { id: bookingId }, data: { status: 'NO_SHOW', penaltyChargedAt: new Date(), penaltyAmountUsdc: result.penaltyAmount } });
    }

    return { success: true, escrow: result.escrow, penaltyAmount: result.penaltyAmount, refundAmount: result.refundAmount, reference: releaseRef };
};

// 6. PROCESS BUSINESS NO-SHOW — when the business defaults (cancelled trip,
//    closed hotel, etc.). Full refund to customer + optional business penalty.
//    This is the bidirectional penalty from master spec PART 5.4.
const processBusinessNoShow = async (prisma, {
    escrowId, bookingType, bookingId, businessProfileId, reason
}) => {
    const { processBusinessNoShow: _processBusinessNoShow } = require('./penaltyPolicyService');
    return _processBusinessNoShow(prisma, {
        escrowId, bookingType, bookingId, businessProfileId, reason
    });
};

module.exports = {
    createBookingEscrow, fundBookingEscrow, releaseBookingEscrow,
    refundBookingEscrow, splitReleaseFundedEscrow, processBusinessNoShow,
    MAX_PENALTY_PCT, BOOKING_ESCROW_FEE_PCT
};
