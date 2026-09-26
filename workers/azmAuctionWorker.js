// workers/azmAuctionWorker.js
// =============================================================================
// AZAMAN — AZM AUCTION WORKER  (Master Sprint, 2026-05-27)
//
// Two responsibilities:
//   1. Keep an OPEN auction available at all times — calls
//      azmAuctionService.ensureOpen() each tick. Idempotent.
//   2. Settle any OPEN auctions whose windowEnd has passed.
//
// Tick interval: 1 minute. Settlement burns winners' AZM, flips
const logger = require('../src/config/logger');
// Ad.isBoosted, writes leaderboard, fires socket "auction:settled".
// =============================================================================

class AzmAuctionWorker {
    constructor(prisma, azmAuctionService) {
        this.prisma = prisma;
        this.azmAuctionService = azmAuctionService;
        this.interval = null;
    }

    start(intervalMs = 60 * 1000) {
        logger.info('[AzmAuctionWorker] Started — ticking every 60 seconds');
        this._tick();
        this.interval = setInterval(() => this._tick(), intervalMs);
    }

    stop() {
        if (this.interval) clearInterval(this.interval);
    }

    async _tick() {
        try {
            // Ensure an open auction exists for the current window
            await this.azmAuctionService.ensureOpen();

            // Find any OPEN auctions whose window has closed → settle them
            const due = await this.prisma.azmAuction.findMany({
                where: {
                    status: 'OPEN',
                    windowEnd: { lte: new Date() },
                },
                take: 5,
            });
            for (const auc of due) {
                try {
                    await this.azmAuctionService.settle(auc.id);
                } catch (err) {
                    logger.error(`[AzmAuctionWorker] settle failed ${auc.id}:`, err.message);
                }
            }
        } catch (err) {
            logger.error({ err: err }, '[AzmAuctionWorker.tick]');
        }
    }
}

module.exports = AzmAuctionWorker;
