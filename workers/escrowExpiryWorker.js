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
//      escrowService._refundEscrow(..., 'EXPIRED'), SYSTEM message, close ticket,
//      and emit canonical realtime convergence signals.
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
                await this.prisma.$transaction(async (tx) => {
                    await tx.smartEscrow.update({
                        where: { id: escrow.id },
                        data: { status: 'EXPIRED' }
                    });
                    if (escrow.ticket && escrow.ticket.status !== 'CANCELLED') {
                        await tx.ticket.update({
                            where: { id: escrow.ticket.id },
                            data: { status: 'CANCELLED', cancelledAt: now, lastActivityAt: now }
                        });
                    }
                });
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
                // Refund the payer and stamp EXPIRED (transactional inside service).
                const refunded = await escrowService._refundEscrow(this.prisma, escrow.id, 'EXPIRED');

                // The financial transaction has committed. Realtime delivery is
                // deliberately a convergence signal: clients must refetch their
                // canonical escrow/balance state instead of trusting this payload.
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

    async _emitRefundConvergence(escrow, { payerId, payeeId, ticketId }) {
        if (!this.io || !escrow) return;
        const payload = {
            escrowId: escrow.id,
            ticketId: ticketId || escrow.ticketId,
            status: escrow.status,
            amountUsdc: escrow.amountUsdc,
            payerId,
            payeeId,
            reason: 'EXPIRY'
        };

        // Both participants need to converge their escrow/order projections.
        for (const userId of [payerId, payeeId]) {
            this.io.to(`user_${userId}`).emit('escrow_refunded', payload);
        }

        // Reuse the platform-wide canonical balance emitter so every financial
        // mutation uses the same private balance-room contract and payload shape.
        // It runs only after _refundEscrow has committed successfully.
        if (this.emitBalanceUpdate) {
            await this.emitBalanceUpdate(payerId);
        }

        // Admin is a governance projection and should converge on the same
        // terminal financial transition without receiving private balance data.
        this.io.to('admin_spy_room').emit('escrow_refunded', payload);
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
