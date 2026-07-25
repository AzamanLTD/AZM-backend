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
            const tradeDeleted = await this.prisma.message.deleteMany({
                where: {
                    expiresAt: { lte: now },
                    deletedAt: null,
                },
            });
            totalDeleted += tradeDeleted.count;

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
                    `trade=${tradeDeleted.count} dm=${dmDeleted.count} group=${gmDeleted.count}`
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
