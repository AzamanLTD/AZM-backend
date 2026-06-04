// workers/tradeWorker.js
// =============================================================================
// AZAMAN V2 — TRADE WORKER (canonical owner of milestones + escrow auto-cancel)
//
// V2 ground rules:
//   - Vendor escrow funds live in `escrowLockedBalance` (V2 ledger split).
//   - Auto-cancel handles both `PENDING` and `PENDING_PAYMENT` trades (the
//     legacy auto-cancel loop in server.js has been removed).
//   - Milestone warning messages use the V2 Conversation/Message schema
//     (lazy-create the trade conversation, write a SYSTEM_URGENCY message).
// =============================================================================

const NotificationService = require('../services/notificationService');

class TradeWorker {
    constructor(prisma, io, tradeSocketService) {
        this.prisma             = prisma;
        this.io                 = io;
        this.tradeSocketService = tradeSocketService;
        this.milestoneInterval  = null;
        this.escrowInterval     = null;
        // Phase N: use the full notification pipeline (DB + socket + FCM)
        this._notificationService = new NotificationService(prisma, io);
    }

    start() {
        this.startMilestoneWorker();
        this.startEscrowAutoReleaseWorker();
        console.log('🔄 Trade workers started (Milestone + Escrow Auto-Cancel)');
    }

    stop() {
        if (this.milestoneInterval) clearInterval(this.milestoneInterval);
        if (this.escrowInterval)    clearInterval(this.escrowInterval);
        console.log('🛑 Trade workers stopped');
    }

    // ── Milestone worker ─────────────────────────────────────────────────────

    startMilestoneWorker(intervalMs = 60_000) {
        this._checkMilestones();
        this.milestoneInterval = setInterval(() => this._checkMilestones(), intervalMs);
    }

    async _checkMilestones() {
        try {
            const now = new Date();
            const activeTrades = await this.prisma.trade.findMany({
                where: {
                    status:        { in: ['PENDING', 'PENDING_PAYMENT'] },
                    tradeStartTime: { lte: now },
                    expiresAt:     { gt: now }
                },
                select: {
                    id: true,
                    tradeStartTime: true,
                    expiresAt: true,
                    milestone33Sent: true,
                    milestone66Sent: true,
                    milestone99Sent: true,
                    userId: true,
                    vendorId: true
                }
            });

            for (const trade of activeTrades) {
                const totalDuration = trade.expiresAt.getTime() - trade.tradeStartTime.getTime();
                if (totalDuration <= 0) continue;

                const elapsed       = now.getTime() - trade.tradeStartTime.getTime();
                const elapsedPct    = (elapsed / totalDuration) * 100;

                const milestones = [
                    { percent: 33, sent: trade.milestone33Sent, field: 'milestone33Sent' },
                    { percent: 66, sent: trade.milestone66Sent, field: 'milestone66Sent' },
                    { percent: 99, sent: trade.milestone99Sent, field: 'milestone99Sent' }
                ];

                for (const m of milestones) {
                    if (!m.sent && elapsedPct >= m.percent) {
                        await this._triggerMilestone(trade, m.percent, m.field);
                    }
                }
            }
        } catch (err) {
            console.error('Milestone worker error:', err.message);
        }
    }

    /**
     * Lazy-fetch (or create) the V2 Conversation row for a trade.
     */
    async _getOrCreateTradeConversation(tx, trade) {
        const tradeIdStr = String(trade.id);
        let conv = await tx.conversation.findUnique({ where: { tradeId: tradeIdStr } });
        if (conv) return conv;

        return tx.conversation.create({
            data: {
                type:    'TRADE',
                tradeId: tradeIdStr,
                participants: {
                    connect: [{ id: trade.userId }, { id: trade.vendorId }]
                }
            }
        });
    }

    async _triggerMilestone(trade, percent, field) {
        const tradeId = trade.id;
        try {
            await this.prisma.$transaction(async (tx) => {
                await tx.trade.update({ where: { id: tradeId }, data: { [field]: true } });

                // V2 Message schema: lazy-create conversation, write SYSTEM_URGENCY message.
                const conversation = await this._getOrCreateTradeConversation(tx, trade);

                await tx.message.create({
                    data: {
                        conversationId: conversation.id,
                        senderId:       null,      // system message
                        tradeId:        tradeId,
                        messageType:    'SYSTEM_URGENCY',
                        content:        `Time warning: trade is ${percent}% through its payment window. Update the vendor or request an extension.`
                    }
                });

                // Phase N: notifications moved post-commit for full pipeline delivery.
            });

            // Phase N: deliver milestone notifications via notificationService (DB + socket + FCM)
            const notifSvc = this._notificationService;
            setImmediate(async () => {
                try {
                    await Promise.all([
                        notifSvc.sendNotification({
                            userId:        trade.userId,
                            title:         'Time Warning',
                            body:          `Trade #${tradeId} is ${percent}% through its payment window.`,
                            category:      'GENERAL',
                            actionPayload: { action: 'OPEN_TRADE', tradeId: String(tradeId) }
                        }),
                        notifSvc.sendNotification({
                            userId:        trade.vendorId,
                            title:         'Time Warning',
                            body:          `Trade #${tradeId} is ${percent}% through its payment window.`,
                            category:      'GENERAL',
                            actionPayload: { action: 'OPEN_TRADE', tradeId: String(tradeId) }
                        })
                    ]);
                } catch (err) {
                    console.error(`[tradeWorker._triggerMilestone] notification non-fatal: ${err.message}`);
                }
            });

            if (this.tradeSocketService?.emitMilestoneWarning) {
                this.tradeSocketService.emitMilestoneWarning(tradeId, percent);
            }
            console.log(`⚠️ Milestone ${percent}% triggered for Trade #${tradeId}`);
        } catch (err) {
            console.error(`Milestone trigger error for Trade #${tradeId}:`, err.message);
        }
    }

    // ── Escrow auto-cancel worker ────────────────────────────────────────────

    startEscrowAutoReleaseWorker(intervalMs = 30_000) {
        this._checkEscrowAutoRelease();
        this.escrowInterval = setInterval(() => this._checkEscrowAutoRelease(), intervalMs);
    }

    async _checkEscrowAutoRelease() {
        try {
            const now = new Date();
            const expiredTrades = await this.prisma.trade.findMany({
                where: {
                    status:    { in: ['PENDING', 'PENDING_PAYMENT'] },
                    expiresAt: { lt: now }
                },
                select: {
                    id: true,
                    type: true,
                    vendorId: true,
                    userId: true,
                    amountCrypto: true,
                    amountFiat: true
                }
            });

            if (expiredTrades.length === 0) return;
            for (const trade of expiredTrades) await this._autoCancelTrade(trade);
        } catch (err) {
            console.error('Escrow auto-release worker error:', err.message);
        }
    }

    async _autoCancelTrade(trade) {
        try {
            await this.prisma.$transaction(async (tx) => {
                // Phase H9 BUGFIX (2026-05-27): atomic conditional flip.
                // The expiredTrades scan above happens OUTSIDE this
                // transaction. Two consecutive worker ticks (or a
                // worker tick racing with the buyer's manual cancel)
                // could both pick up the same trade and both refund
                // the escrow. Claim the row FIRST inside the tx with
                // a status precondition; if it's no longer pending,
                // someone else already handled it and we abort cleanly.
                const claimed = await tx.trade.updateMany({
                    where: {
                        id: trade.id,
                        status: { in: ['PENDING', 'PENDING_PAYMENT'] }
                    },
                    data: { status: 'AUTO_CANCELLED' }
                });
                if (claimed.count === 0) {
                    throw new Error('TRADE_ALREADY_FINALIZED');
                }

                if (trade.type === 'SELL') {
                    // Vendor's escrow goes back to their unallocated balance.
                    await tx.user.update({
                        where: { id: trade.vendorId },
                        data: {
                            escrowLockedBalance:      { decrement: trade.amountCrypto },
                            vendorUnallocatedBalance: { increment: trade.amountCrypto }
                        }
                    });
                } else {
                    // BUY ad: refund user's escrowed USDC back to their
                    // availableBalance. Phase F: escrow is amountCrypto (USDC).
                    await tx.user.update({
                        where: { id: trade.userId },
                        data: {
                            escrowLockedBalance: { decrement: trade.amountCrypto },
                            availableBalance:    { increment: trade.amountCrypto }
                        }
                    });
                }

                // Trade was already stamped AUTO_CANCELLED at the top of
                // this transaction (atomic conditional flip).

                // Phase N: notifications moved post-commit for full pipeline delivery.
            });

            this.io.to(`trade_${trade.id}`).emit('trade_update', {
                tradeId: trade.id,
                status:  'AUTO_CANCELLED',
                message: 'Trade expired automatically. Escrow funds returned.'
            });

            // Phase N: deliver auto-cancel notifications via notificationService (DB + socket + FCM)
            const notifSvc = this._notificationService;
            setImmediate(async () => {
                try {
                    await Promise.all([
                        notifSvc.sendNotification({
                            userId:        trade.userId,
                            title:         'Trade Auto-Cancelled',
                            body:          `Trade #${trade.id} expired and was automatically cancelled.`,
                            category:      'GENERAL',
                            actionPayload: { action: 'OPEN_TRADE', tradeId: String(trade.id) }
                        }),
                        notifSvc.sendNotification({
                            userId:        trade.vendorId,
                            title:         'Trade Auto-Cancelled',
                            body:          `Trade #${trade.id} expired. Escrow funds returned.`,
                            category:      'GENERAL',
                            actionPayload: { action: 'OPEN_TRADE', tradeId: String(trade.id) }
                        })
                    ]);
                } catch (err) {
                    console.error(`[tradeWorker._autoCancelTrade] notification non-fatal: ${err.message}`);
                }
            });

            console.log(`🔄 Trade #${trade.id} auto-cancelled. Escrow returned: ${trade.amountCrypto} USDC.`);

            // Phase P1: auto-process queue — slot opened on this trade's ad
            setImmediate(async () => {
                try {
                    const fullTrade = await this.prisma.trade.findUnique({
                        where: { id: trade.id },
                        select: { adId: true }
                    });
                    if (fullTrade?.adId) {
                        const { processNextInQueue } = require('../controllers/queueController');
                        await processNextInQueue(fullTrade.adId, { prisma: this.prisma, io: this.io });
                    }
                } catch (queueErr) {
                    console.error(`[tradeWorker] queue auto-process error tradeId=${trade.id}: ${queueErr.message}`);
                }
            });
        } catch (err) {
            // Phase H9: race with another worker tick or buyer-cancel.
            // Already-handled trades are not an error condition.
            if (err.message === 'TRADE_ALREADY_FINALIZED') {
                console.log(`[tradeWorker] Trade #${trade.id} already finalized — skipping auto-cancel.`);
                return;
            }
            console.error(`Auto-cancel error for Trade #${trade.id}:`, err.message);
        }
    }
}

module.exports = TradeWorker;
