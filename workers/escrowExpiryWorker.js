// =============================================================================
// AZAMAN — SMART ESCROW EXPIRY WORKER (2026-06-14)
//
// Follows the class-worker pattern of workers/porExpirySweep.js and
// workers/payoutBatchWorker.js (constructor deps + start()/stop() + guarded
// _tick). Runs every 30 minutes.
//
// Per tick:
//   1. EXPIRE UNFUNDED  — DRAFT escrows past expiresAt → EXPIRED, parent ticket
//      CANCELLED, SYSTEM message injected. No money has moved.
//   2. WARN INACTIVE    — FUNDED escrows whose updatedAt is older than
//      (FUNDED window - 5 days) and not yet warned → push both parties, stamp
//      warningSentAt.
//   3. EXPIRE INACTIVE  — FUNDED escrows past expiresAt → refund payer via
//      escrowService._refundEscrow(..., 'EXPIRED'), SYSTEM message, close ticket.
//      The canonical refund service owns the post-commit escrow_refunded event.
// =============================================================================

const logger = require('../src/config/logger');
const escrowService = require('../services/escrowService');

const THIRTY_MIN_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WARN_BEFORE_DAYS = 5; // warn 5 days before a FUNDED escrow expires

class EscrowExpiryWorker {
    constructor(prisma, io, notificationService, {
        intervalMs = THIRTY_MIN_MS,
        emitBalanceUpdate = null
    } = {}) {
        this.prisma = prisma;
        this.io = io || null;
        this.notificationService = notificationService || null;
        this.emitBalanceUpdate = typeof emitBalanceUpdate === 'function'
            ? emitBalanceUpdate
            : null;
        this.intervalMs = intervalMs;
        this.interval = null;
        this._running = false;
    }

    start() {
        if (this.interval) return;
        logger.info(`[EscrowExpiryWorker] scheduled (every ${this.intervalMs / 1000}s)`);
        // First sweep shortly after boot to catch anything that lapsed while down.
        setTimeout(() => this._tick().catch((err) => logger.error({ err: err }, '[EscrowExpiryWorker] initial tick')), 45_000);
        this.interval = setInterval(
            () => this._tick().catch((err) => logger.error({ err: err }, '[EscrowExpiryWorker] tick')),
            this.intervalMs
        );
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    async _tick() {
        if (this._running) return;
        this._running = true;
        try {
            const now = new Date();
            await this._expireUnfunded(now);
            await this._warnInactiveFunded(now);
            await this._expireInactiveFunded(now);
            await this._releaseDeliveredOrders(now);
        } finally {
            this._running = false;
        }
    }

    // ── 1. DRAFT past expiry → EXPIRED + ticket CANCELLED ─────────────────────
    async _expireUnfunded(now) {
        const drafts = await this.prisma.smartEscrow.findMany({
            where: { status: 'DRAFT', expiresAt: { lt: now } },
            include: { ticket: { select: { id: true, status: true, creatorId: true, counterpartyId: true } } }
        });

        for (const escrow of drafts) {
            try {
                // §r41 — AUTHORITATIVE DRAFT CLAIM (final-audit: stale unfunded
                // expiry worker). The scan above is a stale snapshot; a racing
                // fundEscrow() can commit DRAFT → FUNDED (locking real money)
                // between the scan and this write. The expiry is therefore a
                // DB-boundary conditional claim — only a still-DRAFT,
                // still-expired escrow can be expired:
                //   funding wins → this claim loses (count=0) and the worker
                //     does NOTHING: no EXPIRED overwrite, no ticket cancel,
                //     no system message — the funded escrow lives on;
                //   expiry wins → fundEscrow's own DRAFT claim loses and
                //     never moves money. Either ordering strands no funds.
                const won = await this.prisma.$transaction(async (tx) => {
                    const claim = await tx.smartEscrow.updateMany({
                        where: { id: escrow.id, status: 'DRAFT', expiresAt: { lt: now } },
                        data: { status: 'EXPIRED' }
                    });
                    if (claim.count === 0) return false;
                    // A store order whose payment hold lapsed unpaid is
                    // cancelled in the same commit (it was never paid, so
                    // nothing is refunded; the order no longer offers Pay).
                    if (tx.businessOrder && typeof tx.businessOrder.updateMany === 'function') {
                        await tx.businessOrder.updateMany({
                            where: { escrowId: escrow.id, status: 'AWAITING_PAYMENT' },
                            data: { status: 'CANCELLED', cancelledAt: now }
                        });
                    }
                    if (escrow.ticket && escrow.ticket.status !== 'CANCELLED') {
                        await tx.ticket.update({
                            where: { id: escrow.ticket.id },
                            data: { status: 'CANCELLED', cancelledAt: now, lastActivityAt: now }
                        });
                    }
                    return true;
                });
                if (!won) {
                    logger.info(`[EscrowExpiryWorker] skip ${escrow.id} — no longer an expired DRAFT (funded/processed concurrently)`);
                    continue;
                }
                if (escrow.ticket) {
                    await this._injectSystem(escrow.ticket,
                        '⏱️ Escrow expired — funds were never locked. This ticket has been closed.',
                        { event: 'ESCROW_EXPIRED_UNFUNDED', escrowId: escrow.id });
                }
                logger.info(`[EscrowExpiryWorker] expired unfunded escrow ${escrow.id}`);
            } catch (err) {
                logger.error(`[EscrowExpiryWorker] expire-unfunded ${escrow.id} failed:`, err.message);
            }
        }
    }

    // ── 2. FUNDED nearing expiry → push warning once ──────────────────────────
    async _warnInactiveFunded(now) {
        const inactiveCutoff = new Date(now.getTime() - WARN_BEFORE_DAYS * DAY_MS);
        const candidates = await this.prisma.smartEscrow.findMany({
            where: {
                status: 'FUNDED',
                warningSentAt: null,
                expiresAt: { lt: new Date(now.getTime() + WARN_BEFORE_DAYS * DAY_MS), gt: now },
                updatedAt: { lt: inactiveCutoff }
            },
            select: { id: true, payerId: true, payeeId: true }
        });

        for (const escrow of candidates) {
            try {
                await this.prisma.smartEscrow.update({
                    where: { id: escrow.id },
                    data: { warningSentAt: now }
                });
                if (this.notificationService) {
                    for (const userId of [escrow.payerId, escrow.payeeId]) {
                        await this.notificationService.sendNotification({
                            userId,
                            title: 'Escrow expiring soon',
                            body: 'Your escrow is expiring in 5 days. Resolve the deal or it will be auto-refunded.',
                            category: 'GENERAL',
                            actionPayload: { action: 'OPEN_ESCROW', escrowId: escrow.id }
                        }).catch(() => {});
                    }
                }
            } catch (err) {
                logger.error(`[EscrowExpiryWorker] warn ${escrow.id} failed:`, err.message);
            }
        }
    }

    // ── 3. FUNDED past expiry → refund payer, EXPIRED, close ticket ───────────
    async _expireInactiveFunded(now) {
        const expired = await this.prisma.smartEscrow.findMany({
            where: { status: 'FUNDED', expiresAt: { lt: now } },
            include: { ticket: { select: { id: true, status: true, creatorId: true, counterpartyId: true } } }
        });

        for (const escrow of expired) {
            try {
                // A transit fare whose passenger was boarded (their QR, or an
                // ID check they never reported) was carried: complete the
                // booking if the operator forgot to, and release the fare
                // instead of refunding. Both service calls re-check boarding,
                // departure and the escrow inside their own transactions; a
                // reported (DISPUTED) escrow is not FUNDED, so never here.
                const boarded = await this.prisma.transitBooking.findFirst({
                    where: { escrowId: escrow.id, status: { in: ['IN_PROGRESS', 'COMPLETED'] } },
                    select: { id: true, status: true, metadata: true },
                });
                const boardedBy = boarded && boarded.metadata && boarded.metadata.boarding
                    ? boarded.metadata.boarding.method : null;
                if (boarded && (boardedBy === 'QR_TOKEN' || boardedBy === 'ID_CHECK')) {
                    const { completeTransitBooking, releaseHeldTransitPayout } = require('../services/transitBookingService');
                    try {
                        if (boarded.status === 'IN_PROGRESS') {
                            await completeTransitBooking(this.prisma, { bookingId: boarded.id, now: now.getTime() });
                        }
                        // A completed ID check whose fare was held is released
                        // here too (no-op when completion already released it).
                        await releaseHeldTransitPayout(this.prisma, { bookingId: boarded.id, now: now.getTime() });
                        logger.info({ escrowId: escrow.id, bookingId: boarded.id, boardedBy },
                            '[EscrowExpiryWorker] completed a boarded transit booking at escrow expiry');
                        continue;
                    } catch (err) {
                        logger.error({ err: err.message, escrowId: escrow.id, bookingId: boarded.id },
                            '[EscrowExpiryWorker] auto-completion failed; leaving the escrow for the next tick');
                        continue;
                    }
                }

                // A store order that was handed over is paid out by the
                // release after delivery (72h), never refunded here: if the
                // store-side flag was not recorded at hand-over, the escrow
                // is still FUNDED and would otherwise land in this sweep.
                if (this.prisma.businessOrder) {
                    const handedOver = await this.prisma.businessOrder.findFirst({
                        where: { escrowId: escrow.id, status: 'DELIVERED' },
                        select: { id: true },
                    });
                    if (handedOver) {
                        logger.info({ escrowId: escrow.id, orderId: handedOver.id },
                            '[EscrowExpiryWorker] skip refund: the order was handed over (released after delivery)');
                        continue;
                    }
                }

                // Refund the payer and stamp EXPIRED (transactional inside service).
                const refunded = await escrowService._refundEscrow(this.prisma, escrow.id, 'EXPIRED');

                // Balance convergence remains here because this worker already
                // owns the existing canonical balance emitter wiring. The
                // escrow_refunded event itself is emitted by _refundEscrow after
                // its atomic transaction commits.
                await this._emitRefundConvergence(refunded, {
                    payerId: escrow.payerId,
                    payeeId: escrow.payeeId,
                    ticketId: escrow.ticketId
                });

                if (escrow.ticket && escrow.ticket.status === 'OPEN') {
                    await this.prisma.ticket.update({
                        where: { id: escrow.ticket.id },
                        data: { status: 'CANCELLED', cancelledAt: now, lastActivityAt: now }
                    });
                }
                if (escrow.ticket) {
                    await this._injectSystem(escrow.ticket,
                        '⏱️ Escrow expired after 30 days of inactivity — locked funds were refunded to the payer. This ticket has been closed.',
                        { event: 'ESCROW_EXPIRED_FUNDED', escrowId: escrow.id });
                }
                logger.info(`[EscrowExpiryWorker] expired+refunded funded escrow ${escrow.id}`);
            } catch (err) {
                logger.error(`[EscrowExpiryWorker] expire-funded ${escrow.id} failed:`, err.message);
            }
        }
    }

    // ── 4. Store orders handed over, unanswered past the window → pay store ──
    async _releaseDeliveredOrders(now) {
        const bizOrderService = require('../services/businessOrderService');
        let result;
        try {
            result = await bizOrderService.releaseDeliveredOrders(this.prisma, { now: now.getTime() });
        } catch (err) {
            logger.error({ err: err && err.message }, '[EscrowExpiryWorker] release after delivery failed');
            return;
        }
        if (!this.notificationService || result.releasedOrders.length === 0) return;
        for (const orderId of result.releasedOrders) {
            try {
                const order = await this.prisma.businessOrder.findUnique({
                    where: { id: orderId },
                    select: { id: true, orderRef: true, customerId: true, businessProfile: { select: { userId: true, businessName: true } } },
                });
                if (!order) continue;
                await this.notificationService.sendNotification({
                    userId: order.customerId,
                    title: 'Order complete',
                    body: `No problem was reported for ${order.orderRef}, so ${order.businessProfile ? order.businessProfile.businessName : 'the store'} has been paid.`,
                    category: 'MONEY',
                    actionPayload: { route: '/my-orders', orderId: order.id },
                }).catch(() => {});
                if (order.businessProfile) {
                    await this.notificationService.sendNotification({
                        userId: order.businessProfile.userId,
                        title: 'Payment released',
                        body: `${order.orderRef}: the buyer's confirmation window has passed. The payment is in your balance.`,
                        category: 'MONEY',
                        actionPayload: { action: 'OPEN_WALLET' },
                    }).catch(() => {});
                }
            } catch (err) {
                logger.warn({ err: err && err.message, orderId }, '[EscrowExpiryWorker] release notice failed');
            }
        }
    }

    async _emitRefundConvergence(escrow, { payerId }) {
        if (!escrow || !this.emitBalanceUpdate) return;
        await this.emitBalanceUpdate(payerId);
    }

    // ── helper: inject a SYSTEM TicketMessage + fan out ───────────────────────
    async _injectSystem(ticket, content, metadata = {}) {
        try {
            const message = await this.prisma.ticketMessage.create({
                data: {
                    ticketId: ticket.id,
                    senderId: ticket.creatorId,
                    type: 'SYSTEM',
                    content,
                    metadata: { system: true, ...metadata }
                }
            });
            if (this.io) {
                const payload = { ...message, ticketId: ticket.id };
                this.io.to(`ticket_${ticket.id}`).emit('ticket_message', payload);
                this.io.to(`user_${ticket.creatorId}`).emit('ticket_message', payload);
                this.io.to(`user_${ticket.counterpartyId}`).emit('ticket_message', payload);
            }
        } catch (err) {
            logger.error({ err: err }, '[EscrowExpiryWorker._injectSystem] error');
        }
    }
}

module.exports = EscrowExpiryWorker;
