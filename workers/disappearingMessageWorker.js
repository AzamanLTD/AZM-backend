// workers/disappearingMessageWorker.js
// =============================================================================
// AZAMAN — DISAPPEARING MESSAGE SWEEP WORKER (Phase 2)
//
// Periodically hard-deletes messages whose expiresAt has passed.
// Covers all three message tables: Message (trade chat), DirectMessage
// (peer-to-peer), and GroupMessage (group chats).
//
// Runs every 60 seconds. In test mode, does nothing.
// =============================================================================

const logger = require('../src/config/logger');

const INTERVAL_MS = 60 * 1000;

class DisappearingMessageWorker {
    constructor(prisma, { intervalMs = INTERVAL_MS } = {}) {
        this.prisma = prisma;
        this.intervalMs = intervalMs;
        this._running = false;
    }

    async _tick() {
        if (this._running) return;
        this._running = true;

        try {
            const now = new Date();
            let totalDeleted = 0;

            // 1. Trade chat messages (Message)
            // r39/P1 — FINANCIAL MESSAGE LIFECYCLE CONTRACT: a Message that
            // carries a ConversationMoneyTicket is an immutable financial
            // record (transfer / escrow / money-send identity). It is EXCLUDED
            // from the disappearing sweep by predicate here (belt), and the
            // ConversationMoneyTicket_messageId_fkey RESTRICT constraint is
            // the durable backstop (suspenders) — a money-bearing message can
            // never be hard-deleted, even by a future code path that forgets
            // this guard. Direct/group messages never carry money tickets.
            const expiring = await this.prisma.message.findMany({
                where: { expiresAt: { lte: now }, deletedAt: null },
                select: { id: true },
            });
            let tradeDeletedCount = 0;
            if (expiring.length > 0) {
                const expiringIds = expiring.map((m) => m.id);
                const ticketed = await this.prisma.conversationMoneyTicket.findMany({
                    where: { messageId: { in: expiringIds } },
                    select: { messageId: true },
                });
                const ticketedIds = new Set(ticketed.map((t) => t.messageId));
                const deletableIds = expiringIds.filter((id) => !ticketedIds.has(id));
                if (deletableIds.length > 0) {
                    const tradeDeleted = await this.prisma.message.deleteMany({
                        where: { id: { in: deletableIds }, deletedAt: null },
                    });
                    tradeDeletedCount = tradeDeleted.count;
                }
                const skipped = expiringIds.length - deletableIds.length;
                if (skipped > 0) {
                    logger.info(
                        `[DisappearingMessageWorker] Preserved ${skipped} money-bearing message(s) from deletion (financial record).`
                    );
                }
            }
            totalDeleted += tradeDeletedCount;

            // 2. Direct messages (DirectMessage)
            const dmDeleted = await this.prisma.directMessage.deleteMany({
                where: {
                    expiresAt: { lte: now },
                    deletedAt: null,
                },
            });
            totalDeleted += dmDeleted.count;

            // 3. Group messages (GroupMessage)
            const gmDeleted = await this.prisma.groupMessage.deleteMany({
                where: {
                    expiresAt: { lte: now },
                    deletedAt: null,
                },
            });
            totalDeleted += gmDeleted.count;

            if (totalDeleted > 0) {
                logger.info(
                    `[DisappearingMessageWorker] Deleted ${totalDeleted} expired message(s): ` +
                    `trade=${tradeDeletedCount} dm=${dmDeleted.count} group=${gmDeleted.count}`
                );
            }
        } catch (err) {
            logger.error({ err }, '[DisappearingMessageWorker] tick error');
        } finally {
            this._running = false;
        }
    }
}

module.exports = DisappearingMessageWorker;
