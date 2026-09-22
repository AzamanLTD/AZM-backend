// services/bookingEscrowService.js
// =============================================================================
// AZAMAN — BOOKING ESCROW SERVICE (2026-07-02)
// Shared escrow wiring for Reservations (hotels) and TransitBookings (transit).
// Also provides splitReleaseFundedEscrow — the no-show penalty primitive.
// =============================================================================

const logger = require('../src/config/logger');
const { randomUUID } = require('crypto');
const { runDoubleCheck } = require('../utils/securityCheck');

const BOOKING_ESCROW_FEE_PCT = 0.005;
const MAX_PENALTY_PCT = 0.50;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const _round6 = (n) => parseFloat(Number(n).toFixed(6));

const { Prisma } = require('@prisma/client');
const ledger = require('./ledgerService');
const _exact = (n) => (n instanceof Prisma.Decimal ? n.toFixed(8) : Number(n).toFixed(8));

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
    const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
    const feePct = settings && settings.smartEscrowFeePct != null ? Number(settings.smartEscrowFeePct) : BOOKING_ESCROW_FEE_PCT;
    const feeUsdc = _round6(amount * feePct);
    const reference = randomUUID();
    const expiresAt = new Date(Date.now() + 24 * HOUR_MS);

    // Ticket, escrow, and booking linkage form one logical aggregate. A failure
    // in any write must leave no orphan ticket/escrow or half-linked booking.
    const result = await prisma.$transaction(async (tx) => {
        const ticket = await tx.ticket.create({
            data: {
                creatorId: payerId, counterpartyId: payeeId,
                name: bookingType === 'RESERVATION' ? 'Reservation Chat' : 'Transit Booking Chat',
                type: 'ESCROW', targetAmount: amount, targetCurrency: 'USDC',
                status: 'OPEN', businessProfileId, lastActivityAt: new Date(),
            }
        });

        const escrow = await tx.smartEscrow.create({
            data: {
                ticketId: ticket.id, payerId, payeeId,
                amountUsdc: amount, feeUsdc, status: 'DRAFT',
                deliveryTerms: deliveryTerms || `Booking deposit for ${bookingType}`,
                expiresAt,
            }
        });

        const linked = await tx[model].updateMany({
            where: { id: bookingId, escrowId: null },
            data: { escrowId: escrow.id, ticketId: ticket.id }
        });
        if (linked.count !== 1) {
            const err = new Error(`${bookingType} booking is missing or already linked to an escrow.`);
            err.code = 'BOOKING_ESCROW_LINK_CONFLICT';
            throw err;
        }

        return { ticket, escrow };
    });

    return { escrow: result.escrow, ticket: result.ticket, reference };
};

// 2. FUND BOOKING ESCROW — payer locks USDC.
const fundBookingEscrow = async (prisma, { escrowId, payerId, bookingType, bookingId }) => {
    await runDoubleCheck(prisma, payerId);

    const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
    const fundedExpiryDays = settings && settings.escrowFundedExpiryDays != null ? Number(settings.escrowFundedExpiryDays) : 30;
    const reference = randomUUID();

    // The escrow row is claimed inside the transaction and the payer balance is
    // decremented with a conditional predicate. This prevents two escrows from
    // both spending the same available USDC and prevents two fund requests for
    // one booking from both producing financial effects.
    const result = await prisma.$transaction(async (tx) => {
        const escrow = await tx.smartEscrow.findUnique({ where: { id: escrowId }, include: { ticket: true } });
        if (!escrow) throw new Error('Escrow not found.');
        if (escrow.payerId !== payerId) throw new Error('Only the payer can fund this escrow.');
        if (escrow.status !== 'DRAFT') throw new Error(`Escrow cannot be funded from status ${escrow.status}.`);

        // r25 P0 — ATOMIC FUNDING CLAIM FIRST (authority before money): the
        // DRAFT→FUNDED transition is claimed by an exact-lifecycle CAS before
        // any financial mutation. A racing fund/cancel that loses NEVER moves
        // money. (The stale-read checks above are fast-fail conveniences.)
        const claim = await tx.smartEscrow.updateMany({
            where: { id: escrowId, status: 'DRAFT', payerId },
            data: {
                status: 'FUNDED',
                fundedAt: new Date(),
                expiresAt: new Date(Date.now() + fundedExpiryDays * DAY_MS),
                fundTxHash: reference
            }
        });
        if (claim.count !== 1) {
            const current = await tx.smartEscrow.findUnique({ where: { id: escrowId }, select: { status: true } });
            const err = new Error(`Escrow cannot be funded from status ${current?.status || 'UNKNOWN'}.`);
            err.code = current?.status === 'FUNDED' ? 'ESCROW_ALREADY_FUNDED' : 'ESCROW_STATE_CHANGED';
            throw err;
        }

        const amount = Number(escrow.amountUsdc);
        const fee = Number(escrow.feeUsdc);
        const total = _round6(amount + fee);

        const payer = await tx.user.findUnique({ where: { id: payerId }, select: { availableBalance: true } });
        if (!payer) throw new Error('Payer not found.');

        const debit = await tx.user.updateMany({
            where: { id: payerId, availableBalance: { gte: total } },
            data: { availableBalance: { decrement: total } }
        });
        if (debit.count !== 1) {
            const err = new Error(
                `Insufficient balance. Required: ${total} USDC (amount + fee), ` +
                `available: ${Number(payer.availableBalance).toFixed(6)} USDC.`
            );
            err.code = 'INSUFFICIENT_BALANCE';
            throw err;
        }

        await tx.user.update({ where: { id: payerId }, data: { escrowLockedBalance: { increment: amount } } });
        await _ensureProfitFeesSingleton(tx);
        await tx.systemProfitFees.update({ where: { id: 1 }, data: { balance: { increment: fee } } });

        // §P.4 AUTHORITATIVE LEDGER — same transaction, fail-closed, same
        // economic identity as the ticket escrow fund path (this escrow row
        // can only ever be funded once):
        //   D user:{payer}:liability  (principal + fee)
        //   C escrow:{escrowId}:locked (principal)
        //   C revenue:fees            (fee realized at lock)
        const posting = await ledger.post(tx, {
            idempotencyKey: `ledger:escrow:fund:${escrowId}`,
            entryType: 'ESCROW_LOCK',
            description: 'Booking escrow funded — principal locked, fee realized',
            reference,
            userId: payerId,
            relatedEntity: 'smartEscrow',
            relatedEntityId: escrowId,
            metadata: { bookingType: bookingType || null, bookingId: bookingId ?? null },
            lines: [
                { account: `user:${payerId}:liability`, debit: _exact(total) },
                { account: `escrow:escrow-${escrowId}:locked`, credit: _exact(amount) },
                { account: 'revenue:fees', credit: _exact(fee) },
            ],
        });

        // r25 P0: an exact ledger replay inside an operation that JUST won
        // its own durable state claim is contradictory evidence — abort.
        // NEVER let a replayed ledger identity permit a second economic
        // mutation (the claim above would already have refused the double
        // fund; this makes the invariant explicit and fail-closed).
        if (posting.replayed) {
            const err = new Error('Ledger funding identity already committed — refusing a second economic mutation.');
            err.code = 'LEDGER_REPLAY_IN_CLAIMED_OPERATION';
            throw err;
        }

        // At this point all financial mutations are in the same transaction as
        // the escrow state transition and transaction-history/profit records.
        await tx.transactionHistory.create({
            data: {
                userId: payerId, type: 'TICKET_ESCROW_FUND',
                amountUsdc: -amount, feeUsdc: fee, txHash: reference, status: 'COMPLETED'
            }
        });

        if (fee > 0) {
            await tx.adminProfitLog.create({
                data: { amountUsdc: fee, source: 'SMART_ESCROW_FEE', relatedTxId: `booking_fee_${escrow.ticketId}_${reference}` }
            });
        }

        // Booking confirmation is part of the same business transaction. We use
        // updateMany so an already-confirmed booking is a harmless convergence no-op.
        if (bookingType === 'RESERVATION' && bookingId) {
            await tx.reservation.updateMany({
                where: { id: bookingId, status: 'PENDING' },
                data: { status: 'CONFIRMED', confirmedAt: new Date() }
            });
        } else if (bookingType === 'TRANSIT' && bookingId) {
            await tx.transitBooking.updateMany({
                where: { id: bookingId, status: 'PENDING' },
                data: { status: 'CONFIRMED' }
            });
        }

        return {
            escrow: await tx.smartEscrow.findUnique({ where: { id: escrowId } }),
            amount,
            fee,
            ticketId: escrow.ticketId
        };
    });

    // Notifications are deliberately post-commit and non-authoritative. A
    // provider outage must never roll back a completed financial mutation.
    const _messagingChannelsService = require('./messagingChannels');

    if (bookingType === 'RESERVATION' && bookingId) {
        const res = await prisma.reservation.findUnique({ where: { id: bookingId }, include: { user: true } });
        if (res?.status === 'CONFIRMED' && res.user?.phoneNumber) {
            _messagingChannelsService.notifyBookingConfirmed(res.businessProfileId, res.user.phoneNumber, res.id, res.reservationTime).catch(err => logger.error('[MessagingChannels] Error:', err));
        }
    } else if (bookingType === 'TRANSIT' && bookingId) {
        const tb = await prisma.transitBooking.findUnique({ where: { id: bookingId }, include: { user: true, trip: true } });
        if (tb?.status === 'CONFIRMED' && tb.user?.phoneNumber) {
            _messagingChannelsService.notifyBookingConfirmed(tb.trip?.businessProfileId || tb.businessProfileId, tb.user.phoneNumber, tb.id, tb.trip?.scheduledDeparture || new Date()).catch(err => logger.error('[MessagingChannels] Error:', err));
        }
    }

    return { success: true, escrow: result.escrow, reference };
};

// 3. RELEASE BOOKING ESCROW — Full release to business on check-in/completion.
const releaseBookingEscrow = async (prisma, { escrowId }) => {
    const claimable = ['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'];
    const reference = randomUUID();

    const updated = await prisma.$transaction(async (tx) => {
        const escrow = await tx.smartEscrow.findUnique({ where: { id: escrowId } });
        if (!escrow) throw new Error('Escrow not found.');
        const amount = Number(escrow.amountUsdc);

        const claim = await tx.smartEscrow.updateMany({
            where: { id: escrowId, status: { in: claimable } },
            data: { status: 'SETTLED', settledAt: new Date(), releaseTxHash: reference }
        });
        if (claim.count === 0) throw new Error('ESCROW_ALREADY_FINALIZED');

        // Guarded, atomic bucket drain: the payer's escrowLockedBalance is
        // debited only if it still holds the full principal — a short bucket
        // fails the whole release instead of going negative.
        const debit = await tx.user.updateMany({
            where: { id: escrow.payerId, escrowLockedBalance: { gte: amount } },
            data: { escrowLockedBalance: { decrement: amount } }
        });
        if (debit.count !== 1) throw new Error('ESCROW_BALANCE_INSUFFICIENT');
        await tx.user.update({ where: { id: escrow.payeeId }, data: { availableBalance: { increment: amount } } });

        // §P.4 AUTHORITATIVE LEDGER — same economic identity as the ticket
        // escrow release (single status claim guarantees a single winner):
        //   D escrow:{id}:locked / C user:{payee}:liability
        await ledger.post(tx, {
            idempotencyKey: `ledger:escrow:release:${escrowId}:SETTLED`,
            entryType: 'ESCROW_RELEASE',
            description: 'Booking escrow released to payee on settlement',
            reference,
            userId: escrow.payeeId,
            relatedEntity: 'smartEscrow',
            relatedEntityId: escrowId,
            lines: [
                { account: `escrow:escrow-${escrowId}:locked`, debit: _exact(amount) },
                { account: `user:${escrow.payeeId}:liability`, credit: _exact(amount) },
            ],
        });
        await tx.transactionHistory.create({
            data: { userId: escrow.payeeId, type: 'TICKET_ESCROW_RELEASE', amountUsdc: amount, feeUsdc: 0, txHash: reference, status: 'COMPLETED' }
        });
        return await tx.smartEscrow.findUnique({ where: { id: escrowId } });
    });
    return { success: true, escrow: updated, reference };
};

// 4. REFUND BOOKING ESCROW — Full refund to customer on cancellation.
const refundBookingEscrow = async (prisma, { escrowId }) => {
    const claimable = ['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'];
    const reference = randomUUID();

    const updated = await prisma.$transaction(async (tx) => {
        const escrow = await tx.smartEscrow.findUnique({ where: { id: escrowId } });
        if (!escrow) throw new Error('Escrow not found.');
        const amount = Number(escrow.amountUsdc);

        const claim = await tx.smartEscrow.updateMany({
            where: { id: escrowId, status: { in: claimable } },
            data: { status: 'REFUNDED', refundedAt: new Date(), refundTxHash: reference }
        });
        if (claim.count === 0) throw new Error('ESCROW_ALREADY_FINALIZED');

        // Guarded, atomic refund: the locked principal moves back to the
        // payer's available balance in ONE conditional statement — a short
        // bucket can never go negative and never credits the payer.
        const debit = await tx.user.updateMany({
            where: { id: escrow.payerId, escrowLockedBalance: { gte: amount } },
            data: { escrowLockedBalance: { decrement: amount }, availableBalance: { increment: amount } }
        });
        if (debit.count !== 1) throw new Error('ESCROW_BALANCE_INSUFFICIENT');

        // §P.4 AUTHORITATIVE LEDGER — same economic identity as the ticket
        // escrow refund:
        //   D escrow:{id}:locked / C user:{payer}:liability
        await ledger.post(tx, {
            idempotencyKey: `ledger:escrow:refund:${escrowId}:REFUNDED`,
            entryType: 'ESCROW_REFUND',
            description: 'Booking escrow refunded to payer on cancellation',
            reference,
            userId: escrow.payerId,
            relatedEntity: 'smartEscrow',
            relatedEntityId: escrowId,
            lines: [
                { account: `escrow:escrow-${escrowId}:locked`, debit: _exact(amount) },
                { account: `user:${escrow.payerId}:liability`, credit: _exact(amount) },
            ],
        });
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
    const claimable = ['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'];

    const penaltyConfig = () => {
        let penaltyAmount;
        const source = penaltyFlatUsdc != null && penaltyFlatUsdc > 0 ? 'flat' : 'pct';
        if (source === 'flat') return { source, value: Number(penaltyFlatUsdc) };
        if (penaltyPct != null && penaltyPct > 0) {
            return { source, value: Math.min(Number(penaltyPct), MAX_PENALTY_PCT) };
        }
        throw new Error('Either penaltyPct or penaltyFlatUsdc must be a positive value.');
    };
    const config = penaltyConfig();
    const releaseRef = randomUUID();
    const refundRef = randomUUID();

    const result = await prisma.$transaction(async (tx) => {
        const escrow = await tx.smartEscrow.findUnique({ where: { id: escrowId } });
        if (!escrow) throw new Error('Escrow not found.');

        const principal = Number(escrow.amountUsdc);
        const penaltyAmountRaw = config.source === 'flat'
            ? Math.min(config.value, principal)
            : _round6(principal * config.value);
        const penaltyAmount = Math.min(_round6(penaltyAmountRaw), principal);
        const refundAmount = _round6(principal - penaltyAmount);

        const claim = await tx.smartEscrow.updateMany({
            where: { id: escrowId, status: { in: claimable } },
            data: { status: 'RELEASED', settledAt: new Date(), releaseTxHash: releaseRef, refundTxHash: refundRef }
        });
        if (claim.count === 0) throw new Error('ESCROW_ALREADY_FINALIZED');

        // Guarded, atomic principal drain — the full principal leaves the
        // payer's escrow bucket only if the bucket still holds it.
        const debit = await tx.user.updateMany({
            where: { id: escrow.payerId, escrowLockedBalance: { gte: principal } },
            data: { escrowLockedBalance: { decrement: principal } }
        });
        if (debit.count !== 1) throw new Error('ESCROW_BALANCE_INSUFFICIENT');

        // §P.4 AUTHORITATIVE LEDGER — no-show penalty split, one balanced
        // posting in the same transaction. The penalty and refund shares sum
        // to the principal exactly, so no rounding dust can remain:
        //   D escrow:{id}:locked      (full principal leaves escrow holding)
        //   C user:{payee}:liability  (penalty share)
        //   C user:{payer}:liability  (refund share)
        // Zero-share lines are omitted (a zero-value line would be rejected).
        const splitLines = [
            { account: `escrow:escrow-${escrowId}:locked`, debit: _exact(principal) },
        ];
        if (penaltyAmount > 0) splitLines.push({ account: `user:${escrow.payeeId}:liability`, credit: _exact(penaltyAmount) });
        if (refundAmount > 0) splitLines.push({ account: `user:${escrow.payerId}:liability`, credit: _exact(refundAmount) });
        await ledger.post(tx, {
            idempotencyKey: `ledger:escrow:split-release:${escrowId}`,
            entryType: 'ESCROW_RELEASE',
            description: `No-show penalty split — ${_exact(penaltyAmount)} penalty to payee, ${_exact(refundAmount)} refunded to payer`,
            reference: releaseRef,
            userId: escrow.payerId,
            relatedEntity: 'smartEscrow',
            relatedEntityId: escrowId,
            metadata: { reason: reason || null, penaltyAmount, refundAmount, bookingType: bookingType || null, bookingId: bookingId ?? null },
            lines: splitLines,
        });

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

        if (bookingType === 'RESERVATION' && bookingId) {
            await tx.reservation.updateMany({
                where: { id: bookingId },
                data: { status: 'NO_SHOW', penaltyChargedAt: new Date(), penaltyAmountUsdc: penaltyAmount }
            });
        } else if (bookingType === 'TRANSIT' && bookingId) {
            await tx.transitBooking.updateMany({
                where: { id: bookingId },
                data: { status: 'NO_SHOW', penaltyChargedAt: new Date(), penaltyAmountUsdc: penaltyAmount }
            });
        }

        return {
            escrow: await tx.smartEscrow.findUnique({ where: { id: escrowId } }),
            penaltyAmount,
            refundAmount
        };
    });

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