// workers/susuWorker.js
// =============================================================================
// AZAMAN — SUSU WORKER  (Master Sprint, 2026-05-27)
//
// Sweeps SusuCycle rows whose collectionDate has passed and whose status
// is still PENDING. Calls susuService.processCycle for atomic deduction +
// payout. Default handler writes voucher trust-score penalties (Voucher
// Accountability mandate).
// =============================================================================
const logger = require('../src/config/logger');

class SusuWorker {
    constructor(prisma, susuService) {
        this.prisma = prisma;
        this.susuService = susuService;
        this.interval = null;
    }

    start(intervalMs = 5 * 60 * 1000) {
        logger.info('[SusuWorker] Started — sweeping every 5 minutes');
        this._tick();
        this.interval = setInterval(() => this._tick(), intervalMs);
    }

    stop() {
        if (this.interval) clearInterval(this.interval);
    }

    async _tick() {
        try {
            const now = new Date();
            // Skip cycles whose parent SusuGroup is on the V2 code path
            // (contractVersion is non-null) — those are owned by
            // SusuCycleSchedulerV2. Legacy SusuGroups (created by the
            // pre-Phase-3 GroupChat-keyed flow) keep using this worker.
            const due = await this.prisma.susuCycle.findMany({
                where: {
                    status: 'PENDING',
                    collectionDate: { lte: now },
                    susu: { contractVersion: null },
                },
                take: 25,
                orderBy: { collectionDate: 'asc' },
            });
            for (const cycle of due) {
                try {
                    await this.susuService.processCycle(cycle.id);
                } catch (err) {
                    logger.error(`[SusuWorker] cycle ${cycle.id} failed:`, err.message);
                }
            }
        } catch (err) {
            logger.error({ err: err }, '[SusuWorker.tick]');
        }
    }
}

module.exports = SusuWorker;
