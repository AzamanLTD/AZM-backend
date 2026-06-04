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
//      c. Otherwise → dispatch via mtnDisbursementService, mark PROCESSING
//   6. Emit admin_alert socket events for flagged withdrawals
//
// Manual trigger:
//   POST /api/admin/payouts/batch-process invokes processNow() directly.
// =============================================================================

const { randomUUID } = require('crypto');

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
        console.log('[PayoutBatchWorker] starting (interval configured via GlobalSettings.autoPayoutIntervalMs).');
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

        // If not forced, respect the enabled flag
        if (!force && !settings.autoPayoutEnabled) {
            return {
                success: false,
                message: 'Auto-payout is disabled. Pass force=true to override.',
                autoPayoutEnabled: false
            };
        }

        return await this._processBatch(settings, { isManualTrigger: true });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: Scheduling
    // ─────────────────────────────────────────────────────────────────────────

    _scheduleNext(delayMs) {
        this._timer = setTimeout(async () => {
            await this._tick().catch(err => {
                console.error('[PayoutBatchWorker] tick error:', err.message);
            });
            // Re-read interval from settings for next tick
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

            // Cache interval for scheduling
            this._lastIntervalMs = settings.autoPayoutIntervalMs || DEFAULT_INTERVAL_MS;

            // Check master switch
            if (!settings.autoPayoutEnabled) {
                if (this._lastEnabledState !== false) {
                    console.log('[PayoutBatchWorker] auto-payout DISABLED — sleeping.');
                    this._lastEnabledState = false;
                }
                return;
            }

            if (this._lastEnabledState !== true) {
                console.log('[PayoutBatchWorker] auto-payout ENABLED — processing.');
                this._lastEnabledState = true;
            }

            await this._processBatch(settings, { isManualTrigger: false });
        } finally {
            this._running = false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: Core batch logic
    // ─────────────────────────────────────────────────────────────────────────

    async _processBatch(settings, { isManualTrigger = false } = {}) {
        const maxAmount = Number(settings.autoPayoutMaxAmountUsdc) || 200;
        const threshold = Number(settings.autoPayoutThresholdUsdc) || 500;

        // 1. Read fiat pool balance
        const fiatPool = await this.prisma.systemFiatPool.findUnique({ where: { id: 1 } });
        const poolBalance = fiatPool ? Number(fiatPool.balance) : 0;

        // 2. Get live rate for GHS conversion
        const globalSettings = await this.prisma.globalSettings.findUnique({ where: { id: 1 } });
        const liveRate = globalSettings ? Number(globalSettings.liveRetailRate) : 12.5;

        // 3. Scan PENDING fiat withdrawals (not already flagged)
        const pendingWithdrawals = await this.prisma.withdrawal.findMany({
            where: {
                status: 'PENDING',
                // Only fiat/MoMo withdrawals (not crypto)
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

            // Gate A: Amount exceeds auto-approve threshold
            if (amount > maxAmount) {
                await this._flagForManualReview(withdrawal, 'AMOUNT_EXCEEDS_THRESHOLD', {
                    amount,
                    maxAmount,
                    message: `Withdrawal $${amount} exceeds auto-approve max ($${maxAmount})`
                });
                results.flaggedManualReview.push({
                    id: withdrawal.id,
                    reason: 'AMOUNT_EXCEEDS_THRESHOLD',
                    amount
                });
                continue;
            }

            // Gate B: Pool has insufficient liquidity
            if (runningPoolBalance < threshold || runningPoolBalance < amount) {
                await this._flagForManualReview(withdrawal, 'INSUFFICIENT_POOL_LIQUIDITY', {
                    amount,
                    poolBalance: runningPoolBalance,
                    threshold,
                    message: `Fiat pool ($${runningPoolBalance.toFixed(2)}) below threshold ($${threshold}) or insufficient for $${amount}`
                });
                results.flaggedManualReview.push({
                    id: withdrawal.id,
                    reason: 'INSUFFICIENT_POOL_LIQUIDITY',
                    amount,
                    poolBalance: runningPoolBalance
                });
                continue;
            }

            // Gate C: Recipient phone required for MoMo dispatch
            const recipientPhone = withdrawal.destination;
            if (!recipientPhone || recipientPhone === 'OLD_RECORD') {
                await this._flagForManualReview(withdrawal, 'MISSING_RECIPIENT_PHONE', {
                    amount,
                    message: 'No recipient phone number on withdrawal record'
                });
                results.flaggedManualReview.push({
                    id: withdrawal.id,
                    reason: 'MISSING_RECIPIENT_PHONE',
                    amount
                });
                continue;
            }

            // All gates passed — dispatch via MTN MoMo
            try {
                const amountGhs = parseFloat((amount * liveRate).toFixed(2));
                const referenceId = randomUUID();

                const dispatchResult = await this.mtn.initiateTransfer({
                    referenceId,
                    amountGhs,
                    recipientPhone,
                    externalId: `auto_payout_${withdrawal.id}`,
                    payerMessage: 'Azaman withdrawal',
                    payeeNote: `Payout #${withdrawal.id}`
                });

                // Mark as PROCESSING (reconciliation worker will poll for final status)
                await this.prisma.withdrawal.update({
                    where: { id: withdrawal.id },
                    data: { status: 'PROCESSING' }
                });

                // Write the TransactionHistory row with the MTN reference so
                // reconciliation worker can find it
                await this.prisma.transactionHistory.create({
                    data: {
                        userId: withdrawal.userId,
                        type: 'WITHDRAWAL_FIAT',
                        amountUsdc: amount,
                        feeUsdc: 0, // Fee was already captured at creation time
                        txHash: referenceId,
                        status: 'COMPLETED'
                    }
                });

                // Optimistically decrement running pool balance
                runningPoolBalance -= amount;

                results.processed.push({
                    id: withdrawal.id,
                    amount,
                    amountGhs,
                    referenceId,
                    mtnStatus: dispatchResult.status
                });

                console.log(`[PayoutBatchWorker] dispatched withdrawal #${withdrawal.id}: $${amount} → GHS ${amountGhs} (ref: ${referenceId})`);

            } catch (dispatchErr) {
                console.error(`[PayoutBatchWorker] MTN dispatch failed for withdrawal #${withdrawal.id}:`, dispatchErr.message);

                // Flag for manual review on dispatch failure
                await this._flagForManualReview(withdrawal, 'MTN_DISPATCH_FAILED', {
                    amount,
                    error: dispatchErr.message,
                    message: `MTN dispatch failed: ${dispatchErr.message}`
                });
                results.flaggedManualReview.push({
                    id: withdrawal.id,
                    reason: 'MTN_DISPATCH_FAILED',
                    amount,
                    error: dispatchErr.message
                });
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

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: Flag a withdrawal for manual review
    // ─────────────────────────────────────────────────────────────────────────

    async _flagForManualReview(withdrawal, reason, metadata = {}) {
        try {
            await this.prisma.withdrawal.update({
                where: { id: withdrawal.id },
                data: { status: 'NEEDS_MANUAL_REVIEW' }
            });

            // Notify the user their withdrawal needs extra time
            if (this.notificationService) {
                await this.notificationService.sendNotification({
                    userId: withdrawal.userId,
                    title: 'Withdrawal Under Review',
                    message: 'Your withdrawal is being reviewed by our team. This usually takes less than 24 hours.',
                    type: 'WITHDRAWAL_REVIEW',
                    category: 'GENERAL'
                }).catch(() => {}); // non-fatal
            }

            console.log(`[PayoutBatchWorker] flagged withdrawal #${withdrawal.id} → NEEDS_MANUAL_REVIEW (${reason})`);
        } catch (err) {
            console.error(`[PayoutBatchWorker] failed to flag withdrawal #${withdrawal.id}:`, err.message);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: Read settings
    // ─────────────────────────────────────────────────────────────────────────

    async _getSettings() {
        try {
            return await this.prisma.globalSettings.findUnique({ where: { id: 1 } });
        } catch (err) {
            console.error('[PayoutBatchWorker] failed to read GlobalSettings:', err.message);
            return null;
        }
    }
}

module.exports = PayoutBatchWorker;
