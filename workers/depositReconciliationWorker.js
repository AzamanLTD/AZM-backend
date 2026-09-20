// workers/depositReconciliationWorker.js
// =============================================================================
// AZAMAN V2 — DEPOSIT RECONCILIATION WORKER (r15 R15-B)
//
// Moolre guidance: ONE durable external reference per business action; after
// an uncertain response the SAME reference is reused and the operation stays
// pending until status/callback resolves the outcome. This worker is the
// durable status half of that contract for MOOLRE_MOMO_COLLECTION deposits:
//
//   * scans stale PENDING Moolre deposits,
//   * queries the provider status under the SAME externalRef,
//   * settles exactly once through the shared settlement core (identical
//     transaction to the mounted webhook) when the provider reports success,
//   * fails the deposit exactly once (database CAS) when the provider
//     definitively reports failure,
//   * leaves everything else pending — an uncertain status lookup is
//     "unresolved", never "failed", and NO second instruction is ever issued.
//
// The mounted P01 webhook remains the primary settlement surface; this worker
// repairs the missed-callback / ambiguous-initiation window. Exactly-once is
// enforced by the TransactionHistory CAS claim inside the shared core, so the
// two surfaces can never double-settle.
// =============================================================================

const logger = require('../src/config/logger');
const { resolvePendingDeposit } = require('../src/services/moolreCollectionRecoveryService');

const RECONCILE_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 60_000; // a deposit pending past this window may have a missed callback
const MAX_BATCH_SIZE = 50;

class DepositReconciliationWorker {
    constructor(prisma, moolreCollectionService, notificationService) {
        this.prisma = prisma;
        this.moolre = moolreCollectionService || null;
        this.notificationService = notificationService || null;
        this._timer = null;
        this._running = false;
    }

    start() {
        if (this._timer) return;
        if (!this.moolre) {
            logger.warn('[DepositReconciliation] Moolre collection service not bound — worker disabled.');
            return;
        }
        logger.info(`[DepositReconciliation] starting (every ${RECONCILE_INTERVAL_MS / 1000}s, stale > ${STALE_AFTER_MS / 1000}s).`);
        this._timer = setInterval(() => this._tick().catch((e) => {
            logger.error({ err: e }, '[DepositReconciliation] tick crash');
        }), RECONCILE_INTERVAL_MS);
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    async _tick() {
        if (this._running) return; // overlap guard — ticks never pile up
        this._running = true;
        try {
            const cutoff = new Date(Date.now() - STALE_AFTER_MS);
            const stale = await this.prisma.transactionHistory.findMany({
                where: {
                    type: 'DEPOSIT_FIAT',
                    status: 'PENDING',
                    updatedAt: { lt: cutoff },
                    metadata: { path: ['selectedRoute'], equals: 'MOOLRE_MOMO_COLLECTION' },
                },
                select: { id: true, txHash: true },
                orderBy: { updatedAt: 'asc' },
                take: MAX_BATCH_SIZE,
            });
            for (const row of stale) {
                try {
                    const out = await resolvePendingDeposit({
                        prisma: this.prisma,
                        moolre: this.moolre,
                        transactionHistoryId: row.id,
                    });
                    if (out.outcome === 'SETTLED') {
                        logger.info({ reference: row.txHash }, '[DepositReconciliation] deposit settled by status query');
                        await this._notifySettled(out.result);
                    } else if (out.outcome === 'FAILED') {
                        logger.info({ reference: row.txHash }, '[DepositReconciliation] deposit failed by provider status');
                        await this._notifyFailed(row.txHash);
                    } else if (out.outcome === 'NOT_MOOLRE_SURFACE' || out.outcome === 'STILL_PENDING' || out.outcome === 'STATUS_UNAVAILABLE') {
                        // unresolved by design — the next pass retries
                    } else {
                        logger.debug({ reference: row.txHash, outcome: out.outcome },
                            '[DepositReconciliation] pass complete');
                    }
                } catch (err) {
                    // ONE poisoned deposit must never stall the batch — the
                    // error is logged and the row remains PENDING for the
                    // next pass / ops triage (contradictions are already
                    // quarantined durably by the recovery service).
                    logger.error({ err, reference: row.txHash }, '[DepositReconciliation] recovery pass failed');
                }
            }
        } finally {
            this._running = false;
        }
    }

    async _notifySettled(result) {
        if (!this.notificationService || !result?.updatedTx) return;
        try {
            await this.notificationService.sendNotification({
                userId: result.updatedTx.userId,
                title: 'Deposit Confirmed',
                body: `Your deposit ${result.updatedTx.txHash} was confirmed by the provider.`,
                category: 'GENERAL',
                actionPayload: { action: 'OPEN_WALLET', reference: result.updatedTx.txHash },
            });
        } catch (err) {
            logger.error({ err }, '[DepositReconciliation] settled-notification failed (non-blocking)');
        }
    }

    async _notifyFailed(reference) {
        if (!this.notificationService) return;
        try {
            const row = await this.prisma.transactionHistory.findUnique({ where: { txHash: reference } });
            if (!row) return;
            await this.notificationService.sendNotification({
                userId: row.userId,
                title: 'Deposit Unsuccessful',
                body: 'Your mobile-money deposit could not be completed. No amount was deducted from your wallet balance.',
                category: 'GENERAL',
                actionPayload: { action: 'OPEN_WALLET', reference },
            });
        } catch (err) {
            logger.error({ err }, '[DepositReconciliation] failed-notification error (non-blocking)');
        }
    }
}

module.exports = DepositReconciliationWorker;
