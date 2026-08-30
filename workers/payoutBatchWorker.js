// workers/payoutBatchWorker.js
// =============================================================================
// AZAMAN V2 — PAYOUT BATCH WORKER  (Phase Q8 — Admin Autonomous Payouts)
//
// Purpose
// -------
// Automatically processes PENDING fiat withdrawals when:
//   1. Auto-payout is ENABLED in GlobalSettings (master switch)
//   2. SystemFiatPool has sufficient liquidity (>= autoPayoutThresholdUsdc)
//   3. Individual withdrawal amount <= autoPayoutMaxAmountUsdc
//
// Withdrawals that FAIL any gate are flagged as NEEDS_MANUAL_REVIEW so
// admins can see them in a dedicated War Room section.
//
// This worker does NOT replace withdrawalReconciliationWorker — that one
// handles MTN settlement status polling. This worker handles the DECISION
// of whether to auto-dispatch vs. flag for manual admin action.
//
// Flow per tick:
//   1. Read GlobalSettings for auto-payout config
//   2. If disabled, skip (log once per disable→enable transition)
//   3. Read SystemFiatPool balance
//   4. Scan PENDING withdrawals (payoutMethod containing 'MOMO' or fiat)
//   5. For each:
//      a. If amount > autoPayoutMaxAmountUsdc → mark NEEDS_MANUAL_REVIEW
//      b. If pool < amount → mark NEEDS_MANUAL_REVIEW (pool exhausted)
//      c. Resolve the canonical PENDING TransactionHistory row first.
//      d. Dispatch using that row's existing txHash as the provider reference.
//      e. Mark PROCESSING; reconciliation owns the final transition.
//   6. Emit admin_alert socket events for flagged withdrawals
//
// IMPORTANT: The finance withdrawal flow already creates the canonical
// TransactionHistory row and reserves the user's funds. Auto-payout must never
// create a second financial history row or invent a second provider reference;
// doing so can make reconciliation ambiguous and can double-refund failures.
// =============================================================================

const logger = require('../src/config/logger');

const DEFAULT_INTERVAL_MS = 120_000;  // 2 minutes
const MAX_BATCH_SIZE      = 25;       // Don't overwhelm MTN in one tick

class PayoutBatchWorker {
    constructor(prisma, io, mtnDisbursementService, notificationService) {
        this.prisma = prisma;
        this.io = io;
        this.mtn = mtnDisbursementService;
        this.notificationService = notificationService;
        this._timer = null;
        this._running = false;
        this._lastEnabledState = null; // Track state transitions for logging
    }

    start() {
        if (this._timer) return;
        logger.info('[PayoutBatchWorker] starting (interval configured via GlobalSettings.autoPayoutIntervalMs).');
        // Initial tick after 10s (let other services boot), then read interval from DB
        this._scheduleNext(10_000);
    }

    stop() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }

    /**
     * Public method for manual trigger from admin endpoint.
     * Runs one batch cycle regardless of the autoPayoutEnabled flag.
     * Returns a summary of what was processed/flagged.
     */
    async processNow({ force = false } = {}) {
        const settings = await this._getSettings();
        if (!settings) {
            return { success: false, message: 'GlobalSettings not found.' };
        }

        if (!force && !settings.autoPayoutEnabled) {
            return {
                success: false,
                message: 'Auto-payout is disabled. Pass force=true to override.',
                autoPayoutEnabled: false
            };
        }

        return await this._processBatch(settings, { isManualTrigger: true });
    }

    _scheduleNext(delayMs) {
        this._timer = setTimeout(async () => {
            await this._tick().catch(err => {
                logger.error({ err: err }, '[PayoutBatchWorker] tick error');
            });
            const nextDelay = this._lastIntervalMs || DEFAULT_INTERVAL_MS;
            this._scheduleNext(nextDelay);
        }, delayMs);
    }

    async _tick() {
        if (this._running) return;
        this._running = true;

        try {
            const settings = await this._getSettings();
            if (!settings) return;

            this._lastIntervalMs = settings.autoPayoutIntervalMs || DEFAULT_INTERVAL_MS;

            if (!settings.autoPayoutEnabled) {
                if (this._lastEnabledState !== false) {
                    logger.info('[PayoutBatchWorker] auto-payout DISABLED — sleeping.');
                    this._lastEnabledState = false;
                }
                return;
            }

            if (this._lastEnabledState !== true) {
                logger.info('[PayoutBatchWorker] auto-payout ENABLED — processing.');
                this._lastEnabledState = true;
            }

            await this._processBatch(settings, { isManualTrigger: false });
        } finally {
            this._running = false;
        }
    }

    /**
     * Resolve the transaction already created by financeService.processFiatWithdrawal.
     * Prefer the durable Withdrawal.transactionHistoryId bridge when the additive
     * migration exists. Fall back only when exactly one PENDING fiat transaction
     * matches the withdrawal identity. Ambiguity is never auto-dispatched.
     */
    async _findCanonicalTransaction(withdrawal) {
        if (typeof this.prisma.$queryRawUnsafe === 'function') {
            try {
                const linkedRows = await this.prisma.$queryRawUnsafe(
                    'SELECT "transactionHistoryId" FROM "Withdrawal" WHERE "id" = $1 LIMIT 1',
                    withdrawal.id
                );
                const linkedId = linkedRows?.[0]?.transactionHistoryId;
                if (linkedId) {
                    const linked = await this.prisma.transactionHistory.findUnique({ where: { id: linkedId } });
                    if (linked) return { row: linked, ambiguous: false };
                }
            } catch (err) {
                logger.warn({ err, withdrawalId: withdrawal.id }, '[PayoutBatchWorker] durable transaction link unavailable');
            }
        }

        const createdAt = withdrawal.createdAt instanceof Date
            ? withdrawal.createdAt
            : new Date(withdrawal.createdAt);
        if (Number.isNaN(createdAt.getTime())) {
            return { row: null, ambiguous: false };
        }

        const txRows = await this.prisma.transactionHistory.findMany({
            where: {
                userId: withdrawal.userId,
                type: 'WITHDRAWAL_FIAT',
                amountUsdc: withdrawal.amount,
                status: 'PENDING',
                createdAt: {
                    gte: new Date(createdAt.getTime() - 5_000),
                    lte: new Date(createdAt.getTime() + 5_000)
                }
            },
            orderBy: { createdAt: 'desc' },
            take: 2
        });

        if (txRows.length !== 1 || !txRows[0]?.txHash) {
            return { row: null, ambiguous: txRows.length > 1 };
        }

        return { row: txRows[0], ambiguous: false };
    }

    async _processBatch(settings, { isManualTrigger = false } = {}) {
        const maxAmount = Number(settings.autoPayoutMaxAmountUsdc) || 200;
        const threshold = Number(settings.autoPayoutThresholdUsdc) || 500;

        const fiatPool = await this.prisma.systemFiatPool.findUnique({ where: { id: 1 } });
        const poolBalance = fiatPool ? Number(fiatPool.balance) : 0;

        const globalSettings = await this.prisma.globalSettings.findUnique({ where: { id: 1 } });
        const liveRate = globalSettings ? Number(globalSettings.liveRetailRate) : 12.5;

        const pendingWithdrawals = await this.prisma.withdrawal.findMany({
            where: {
                status: 'PENDING',
                OR: [
                    { payoutMethod: { contains: 'MOMO' } },
                    { payoutMethod: { contains: 'momo' } },
                    { payoutMethod: 'MTN_MOMO' },
                    { payoutMethod: 'MOBILE_MONEY' },
                    { payoutMethod: 'FIAT' }
                ]
            },
            include: {
                user: {
                    select: { id: true, username: true, email: true, phoneNumber: true }
                }
            },
            orderBy: { createdAt: 'asc' },
            take: MAX_BATCH_SIZE
        });

        if (pendingWithdrawals.length === 0) {
            return {
                success: true,
                message: 'No pending fiat withdrawals to process.',
                processed: 0,
                flagged: 0,
                poolBalance
            };
        }

        const results = {
            processed: [],
            flaggedManualReview: [],
            errors: []
        };

        let runningPoolBalance = poolBalance;

        for (const withdrawal of pendingWithdrawals) {
            const amount = Number(withdrawal.amount);

            if (amount > maxAmount) {
                await this._flagForManualReview(withdrawal, 'AMOUNT_EXCEEDS_THRESHOLD', {
                    amount,
                    maxAmount,
                    message: `Withdrawal $${amount} exceeds auto-approve max ($${maxAmount})`
                });
                results.flaggedManualReview.push({ id: withdrawal.id, reason: 'AMOUNT_EXCEEDS_THRESHOLD', amount });
                continue;
            }

            if (runningPoolBalance < threshold || runningPoolBalance < amount) {
                await this._flagForManualReview(withdrawal, 'INSUFFICIENT_POOL_LIQUIDITY', {
                    amount,
                    poolBalance: runningPoolBalance,
                    threshold,
                    message: `Fiat pool ($${runningPoolBalance.toFixed(2)}) below threshold ($${threshold}) or insufficient for $${amount}`
                });
                results.flaggedManualReview.push({ id: withdrawal.id, reason: 'INSUFFICIENT_POOL_LIQUIDITY', amount, poolBalance: runningPoolBalance });
                continue;
            }

            const canonical = await this._findCanonicalTransaction(withdrawal);
            if (!canonical.row) {
                const reason = canonical.ambiguous
                    ? 'AMBIGUOUS_TRANSACTION_REFERENCE'
                    : 'MISSING_TRANSACTION_REFERENCE';
                await this._flagForManualReview(withdrawal, reason, {
                    amount,
                    message: 'Auto-payout refused because the canonical pending withdrawal transaction could not be identified uniquely.'
                });
                results.flaggedManualReview.push({ id: withdrawal.id, reason, amount });
                continue;
            }

            const recipientPhone = withdrawal.destination;
            if (!recipientPhone || recipientPhone === 'OLD_RECORD') {
                await this._flagForManualReview(withdrawal, 'MISSING_RECIPIENT_PHONE', {
                    amount,
                    message: 'No recipient phone number on withdrawal record'
                });
                results.flaggedManualReview.push({ id: withdrawal.id, reason: 'MISSING_RECIPIENT_PHONE', amount });
                continue;
            }

            try {
                const amountGhs = parseFloat((amount * liveRate).toFixed(2));
                const referenceId = String(canonical.row.txHash);

                const dispatchResult = await this.mtn.initiateTransfer({
                    referenceId,
                    amountGhs,
                    recipientPhone,
                    externalId: `auto_payout_${withdrawal.id}`,
                    payerMessage: 'Azaman withdrawal',
                    payeeNote: `Payout #${withdrawal.id}`
                });

                await this.prisma.withdrawal.update({
                    where: { id: withdrawal.id },
                    data: { status: 'PROCESSING' }
                });

                runningPoolBalance -= amount;

                results.processed.push({
                    id: withdrawal.id,
                    amount,
                    amountGhs,
                    referenceId,
                    mtnStatus: dispatchResult.status
                });

                logger.info(`[PayoutBatchWorker] dispatched withdrawal #${withdrawal.id}: $${amount} → GHS ${amountGhs} (ref: ${referenceId})`);
            } catch (dispatchErr) {
                logger.error(`[PayoutBatchWorker] MTN dispatch failed for withdrawal #${withdrawal.id}:`, dispatchErr.message);
                await this._flagForManualReview(withdrawal, 'MTN_DISPATCH_FAILED', {
                    amount,
                    error: dispatchErr.message,
                    message: `MTN dispatch failed: ${dispatchErr.message}`
                });
                results.flaggedManualReview.push({ id: withdrawal.id, reason: 'MTN_DISPATCH_FAILED', amount, error: dispatchErr.message });
            }
        }

        const summary = {
            success: true,
            message: `Batch complete: ${results.processed.length} dispatched, ${results.flaggedManualReview.length} flagged for review.`,
            processed: results.processed.length,
            flagged: results.flaggedManualReview.length,
            poolBalance: runningPoolBalance,
            details: isManualTrigger ? results : undefined
        };

        if (results.flaggedManualReview.length > 0 && this.io) {
            this.io.emit('admin_alert', {
                type: 'PAYOUTS_NEED_MANUAL_REVIEW',
                count: results.flaggedManualReview.length,
                items: results.flaggedManualReview,
                timestamp: new Date().toISOString()
            });
        }

        return summary;
    }

    async _flagForManualReview(withdrawal, reason, metadata = {}) {
        try {
            await this.prisma.withdrawal.update({
                where: { id: withdrawal.id },
                data: { status: 'NEEDS_MANUAL_REVIEW' }
            });

            if (this.notificationService) {
                await this.notificationService.sendNotification({
                    userId: withdrawal.userId,
                    title: 'Withdrawal Under Review',
                    message: 'Your withdrawal is being reviewed by our team. This usually takes less than 24 hours.',
                    type: 'WITHDRAWAL_REVIEW',
                    category: 'GENERAL'
                }).catch(() => {});
            }

            logger.info(`[PayoutBatchWorker] flagged withdrawal #${withdrawal.id} → NEEDS_MANUAL_REVIEW (${reason})`);
        } catch (err) {
            logger.error(`[PayoutBatchWorker] failed to flag withdrawal #${withdrawal.id}:`, err.message);
        }
    }

    async _getSettings() {
        try {
            return await this.prisma.globalSettings.findUnique({ where: { id: 1 } });
        } catch (err) {
            logger.error({ err: err }, '[PayoutBatchWorker] failed to read GlobalSettings');
            return null;
        }
    }
}

module.exports = PayoutBatchWorker;
