// workers/custodyRecoveryWorker.js
// =============================================================================
// r22 I — DEDICATED CUSTODY RECOVERY WORKER (P0)
//
// Customer crypto withdrawals may not wait an hour for the on-chain sweep
// worker to notice a crash window. This worker owns the dedicated recovery
// cadence for the custody execution state machine:
//
//   stale RESERVING rows        (fail+refund / canonical re-submission)
//   SUBMITTED crash windows     (provider pending evidence — never a retry)
//   RECONCILIATION_REQUIRED     (classified convergence or human escalation)
//   SIGNING/BROADCAST           (existing advanceExecution authority)
//
// Properties (inherited from the recovery service, enforced on real
// PostgreSQL): idempotent, concurrency-safe (every transition is a
// conditional single-winner CAS), distributed-safe (duplicate ticks converge;
// money paths are exactly-once), bounded (per-pass limit), observable
// (structured logs + per-action results), and independent of whether any
// deposit addresses happen to need a sweep.
//
// The cadence is owned by the existing BullMQ scheduler abstraction
// (src/workers/index.js: `register('custody-recovery', ...)`) — BullMQ
// distributed mode or the Redis-off single-instance fallback, exactly like
// every other financial worker. No second scheduler implementation.
// =============================================================================

const logger = require('../src/config/logger');

class CustodyRecoveryWorker {
    constructor(prisma, io = null) {
        this.prisma = prisma;
        this.io = io;
        this._running = false;
    }

    async _tick() {
        if (this._running) return null; // bounded: one pass per process at a time
        this._running = true;
        try {
            const recovery = require('../services/custodyRecoveryService');
            const results = await recovery.runRecoveryPass(this.prisma);
            this._emitOpsSignals(results);
            return results;
        } catch (err) {
            if (err && err.errorClass !== 'CONFIGURATION_ERROR') {
                logger.warn({ err: err.message }, '[CustodyRecoveryWorker] recovery pass failed');
            }
            return null;
        } finally {
            this._running = false;
        }
    }

    // Observability: quarantines and refunds are surfaced to admins in real
    // time; routine advancement stays in the structured logs.
    _emitOpsSignals(results) {
        if (!this.io || !results) return;
        const quarantineActions = new Set([
            'QUARANTINED', 'QUARANTINED_AMBIGUOUS', 'QUARANTINED_NO_MATCH',
        ]);
        const refundActions = new Set(['FAILED_REFUNDED', 'REVERT_REFUNDED']);
        for (const bucket of ['reserving', 'submitted', 'reconciliations']) {
            for (const r of results[bucket] || []) {
                if (quarantineActions.has(r.action)) {
                    this.io.emit('admin_alert', {
                        type: 'CUSTODY_EXECUTION_QUARANTINED',
                        executionId: r.executionId,
                        status: r.status,
                        detail: 'Custody execution quarantined — durable provider evidence recorded; human reconciliation required before any refund or retry.',
                        timestamp: new Date().toISOString(),
                    });
                }
                if (refundActions.has(r.action)) {
                    this.io.emit('admin_alert', {
                        type: 'CUSTODY_EXECUTION_REFUNDED',
                        executionId: r.executionId,
                        status: r.status,
                        detail: 'Custody execution converged to a definitive failure with an exactly-once customer refund.',
                        timestamp: new Date().toISOString(),
                    });
                }
            }
        }
    }
}

module.exports = CustodyRecoveryWorker;
