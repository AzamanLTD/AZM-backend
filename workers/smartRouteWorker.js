// workers/smartRouteWorker.js
// =============================================================================
// AZAMAN — SMART ROUTE WORKER  (Master Sprint, 2026-05-27)
//
// Scans SmartRoute.status = 'ACTIVE' AND nextRunAt <= now. Calls
// smartRouteService.runOnce(...) for each, which handles balance
// deduction, action dispatch, and nextRunAt advancement.
// =============================================================================
const logger = require('../src/config/logger');

class SmartRouteWorker {
    constructor(prisma, smartRouteService) {
        this.prisma = prisma;
        this.smartRouteService = smartRouteService;
        this.interval = null;
    }

    start(intervalMs = 5 * 60 * 1000) {
        logger.info('[SmartRouteWorker] Started — sweeping every 5 minutes');
        this._tick();
        this.interval = setInterval(() => this._tick(), intervalMs);
    }

    stop() {
        if (this.interval) clearInterval(this.interval);
    }

    async _tick() {
        try {
            const now = new Date();
            const due = await this.prisma.smartRoute.findMany({
                where: { status: 'ACTIVE', nextRunAt: { lte: now } },
                take: 50,
                orderBy: { nextRunAt: 'asc' },
            });
            for (const route of due) {
                try {
                    await this.smartRouteService.runOnce(route.id);
                } catch (err) {
                    logger.error(`[SmartRouteWorker] route ${route.id} failed:`, err.message);
                }
            }
            // r16 P0-A: crash recovery — re-drive runs whose financial
            // transaction rolled back with the process (finalization is
            // in-transaction with the money, so a stale PENDING run never
            // moved funds and re-driving it is exactly-once safe).
            if (typeof this.smartRouteService.recoverStalePendingRuns === 'function') {
                const recovered = await this.smartRouteService.recoverStalePendingRuns();
                if (recovered.length > 0) {
                    logger.info(`[SmartRouteWorker] recovered ${recovered.length} interrupted run(s)`);
                }
            }
        } catch (err) {
            logger.error({ err: err }, '[SmartRouteWorker.tick]');
        }
    }
}

module.exports = SmartRouteWorker;
