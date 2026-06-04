// workers/withdrawalReconciliationWorker.js
// =============================================================================
// AZAMAN V2 — WITHDRAWAL RECONCILIATION WORKER  (Phase A — Money correctness)
//
// Why this exists
// ---------------
// The MTN MoMo disbursement API is async: initiateTransfer returns 202
// Accepted and the actual settlement (or failure) arrives later as a
// webhook. Webhooks can be lost (network blip, brief outage on our end,
// MTN's end, the carrier in between). Without a reconciliation job a
// stuck PENDING Withdrawal row stays PENDING forever; the user's USDC
// has been debited, the GHS may or may not have actually been delivered.
//
// What this worker does
// ---------------------
// Every RECONCILE_INTERVAL_MS:
//   1. Scan Withdrawal rows with status === 'PENDING' and createdAt
//      older than STALE_AFTER_MS.
//   2. For each, call mtnDisbursementService.getTransferStatus(reference)
//      using the row's matching TransactionHistory.txHash as the MTN
//      X-Reference-Id (set in withdrawalController.fiatWithdrawal).
//   3. SUCCESSFUL  → mark Withdrawal status = 'COMPLETED' (no ledger
//                    change; finance.service already committed the
//                    debit on initiate).
//   4. FAILED      → call financeService.reverseFiatWithdrawal to
//                    atomically refund the user, unwind SystemMasterCrypto
//                    + SystemFiatPool, mark TransactionHistory FAILED,
//                    AND mark the Withdrawal row FAILED.
//   5. PENDING     → leave alone, log, retry on next tick.
//
// Idempotent. Safe to run on multiple instances (unique txHash on
// TransactionHistory plus the @id on Withdrawal mean a duplicate
// reverseFiatWithdrawal returns alreadyReversed=true).
// =============================================================================

const financeService = require('../services/finance.service');

const RECONCILE_INTERVAL_MS = 60_000;     // Scan every 60s.
const STALE_AFTER_MS        = 5 * 60_000; // Only touch rows older than 5min.
const MAX_BATCH_SIZE        = 50;         // Don't hammer MTN on a backlog.

// Phase L2: Large-withdrawal SMS threshold (USDC). Mirrors the same env var
// used in withdrawalController so operator can tune once.
const SMS_LARGE_WITHDRAWAL_THRESHOLD = parseFloat(
    process.env.SMS_LARGE_WITHDRAWAL_THRESHOLD || '100'
);

class WithdrawalReconciliationWorker {
    constructor(prisma, io, mtnDisbursementService, emailService, smsService) {
        this.prisma = prisma;
        this.io = io;
        this.mtn = mtnDisbursementService;
        // emailService is optional — worker still functions without it.
        // When supplied, fiat-settlement and fiat-reversal events trigger a
        // fire-and-forget transactional receipt via setImmediate. Failures
        // are swallowed inside emailService.sendWithdrawalReceipt so a
        // provider hiccup never disrupts the reconcile loop.
        this.email = emailService || null;
        // smsService (Phase L2) is optional — when supplied, large-withdrawal
        // settlements / reversals fire a confirmation SMS to verified phones.
        this.sms = smsService || null;
        this._timer = null;
        this._running = false;
    }

    start() {
        if (this._timer) return;
        if (!this.mtn) {
            console.warn('[WithdrawalReconciliation] mtnDisbursementService not bound — worker disabled.');
            return;
        }
        console.log(`[WithdrawalReconciliation] starting (every ${RECONCILE_INTERVAL_MS / 1000}s, stale > ${STALE_AFTER_MS / 60000}min).`);
        this._timer = setInterval(() => this._tick().catch((e) => {
            console.error('[WithdrawalReconciliation] tick crash:', e.message);
        }), RECONCILE_INTERVAL_MS);
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    async _tick() {
        if (this._running) return; // No overlap.
        this._running = true;

        try {
            const cutoff = new Date(Date.now() - STALE_AFTER_MS);
            const stuck = await this.prisma.withdrawal.findMany({
                where: {
                    status: 'PENDING',
                    createdAt: { lt: cutoff }
                },
                // Phase L1: pull email + username so the settlement receipt
                // can render the recipient's row without a second DB hit.
                // Phase L2: adds phoneNumber + phoneVerified for SMS gating.
                include: {
                    user: { select: { id: true, email: true, username: true, phoneNumber: true, phoneVerified: true } }
                },
                orderBy: { createdAt: 'asc' },
                take: MAX_BATCH_SIZE
            });

            if (stuck.length === 0) return;

            console.log(`[WithdrawalReconciliation] reconciling ${stuck.length} stale PENDING withdrawal(s).`);

            for (const w of stuck) {
                await this._reconcileOne(w).catch((err) => {
                    console.error(`[WithdrawalReconciliation] row id=${w.id} reconcile error:`, err.message);
                });
            }
        } finally {
            this._running = false;
        }
    }

    async _reconcileOne(withdrawal) {
        // The Withdrawal row does not store the MTN reference directly,
        // but it shares a 1:1 relationship with the canonical
        // TransactionHistory row written by financeService inside the
        // same wall-clock window (same userId + WITHDRAWAL_FIAT type).
        const txRow = await this.prisma.transactionHistory.findFirst({
            where: {
                userId: withdrawal.userId,
                type:   'WITHDRAWAL_FIAT',
                amountUsdc: withdrawal.amount,
                createdAt: {
                    gte: new Date(withdrawal.createdAt.getTime() - 5_000),
                    lte: new Date(withdrawal.createdAt.getTime() + 5_000)
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        if (!txRow || !txRow.txHash) {
            console.warn(`[WithdrawalReconciliation] row id=${withdrawal.id}: no matching TransactionHistory.txHash — skipping.`);
            return;
        }

        const reference = txRow.txHash;
        let statusResp;
        try {
            statusResp = await this.mtn.getTransferStatus(reference);
        } catch (err) {
            console.warn(`[WithdrawalReconciliation] MTN status query failed for ${reference}: ${err.message}`);
            return;
        }

        const remoteStatus = (statusResp && statusResp.status) || 'PENDING';
        if (remoteStatus === 'PENDING') {
            // Still in flight on MTN's side. Try again next tick.
            return;
        }

        if (remoteStatus === 'SUCCESSFUL' || remoteStatus === 'COMPLETED') {
            await this.prisma.withdrawal.update({
                where: { id: withdrawal.id },
                data:  { status: 'COMPLETED' }
            });
            // The TransactionHistory row was already COMPLETED by the
            // initial finance.service.processFiatWithdrawal commit; no
            // ledger change needed here.
            console.log(`[WithdrawalReconciliation] ref=${reference} settled SUCCESSFUL.`);
            if (this.io) {
                this.io.to(`user_${withdrawal.userId}`).emit('withdrawal_settled', {
                    reference, status: 'COMPLETED', amount: withdrawal.amount
                });
            }
            // Phase L1: transactional receipt (fire-and-forget).
            // setImmediate detaches from the reconcile loop; emailService
            // catches all errors internally so the worker is never disrupted.
            if (this.email && withdrawal.user && withdrawal.user.email) {
                const recipient = withdrawal.user;
                const amount    = withdrawal.amount;
                const dest      = withdrawal.destination;
                setImmediate(() => {
                    this.email.sendWithdrawalReceipt(recipient, {
                        kind:        'fiat_success',
                        amount,
                        currency:    'USDC',
                        reference,
                        destination: dest
                    }).catch(() => { /* swallowed inside service; defense-in-depth */ });
                });
            }
            // Phase L2: settlement SMS (fire-and-forget, verified phone + large amount).
            if (this.sms && withdrawal.user && withdrawal.user.phoneNumber && withdrawal.user.phoneVerified
                && withdrawal.amount >= SMS_LARGE_WITHDRAWAL_THRESHOLD) {
                const ph   = withdrawal.user.phoneNumber;
                const amt  = withdrawal.amount;
                const dest = withdrawal.destination;
                setImmediate(() => {
                    this.sms.sendWithdrawalConfirmation(ph, {
                        kind:        'fiat_settled',
                        amount:      amt,
                        destination: dest,
                        reference
                    }).catch(() => {});
                });
            }
            return;
        }

        if (remoteStatus === 'FAILED' || remoteStatus === 'REJECTED') {
            // Reverse the ledger and mark Withdrawal FAILED.
            try {
                const result = await financeService.reverseFiatWithdrawal(this.prisma, reference, {
                    reason: `mtn_async_failure: ${statusResp.reason || 'unspecified'}`
                });
                await this.prisma.withdrawal.update({
                    where: { id: withdrawal.id },
                    data:  { status: 'FAILED' }
                });
                console.warn(`[WithdrawalReconciliation] ref=${reference} REVERSED. user refund: ${result.refundedAmount} USDC.`);
                if (this.io) {
                    this.io.to(`user_${withdrawal.userId}`).emit('withdrawal_settled', {
                        reference,
                        status: 'FAILED',
                        amount: withdrawal.amount,
                        refunded: result.refundedAmount
                    });
                    this.io.emit('admin_alert', {
                        type:        'WITHDRAWAL_AUTO_REVERSED',
                        reference,
                        userId:      withdrawal.userId,
                        amountUsdc:  withdrawal.amount,
                        reason:      statusResp.reason || 'mtn_async_failure',
                        timestamp:   new Date().toISOString()
                    });
                }
                // Phase L1: refund-notice receipt (fire-and-forget).
                // Only fired on the success-of-reversal path. If reversal
                // failed (catch below) we do NOT email the user — admin
                // alert takes over because the system is in an inconsistent
                // state and a human needs to handle it.
                if (this.email && withdrawal.user && withdrawal.user.email) {
                    const recipient = withdrawal.user;
                    const amount    = withdrawal.amount;
                    const refunded  = result.refundedAmount;
                    const reasonStr = statusResp.reason || 'The MoMo gateway rejected the disbursement.';
                    setImmediate(() => {
                        this.email.sendWithdrawalReceipt(recipient, {
                            kind:           'fiat_failure',
                            amount,
                            currency:       'USDC',
                            reference,
                            refundedAmount: refunded,
                            reason:         reasonStr
                        }).catch(() => { /* swallowed inside service */ });
                    });
                }
                // Phase L2: refund SMS (fire-and-forget, reversal success + verified phone + threshold).
                if (this.sms && withdrawal.user && withdrawal.user.phoneNumber && withdrawal.user.phoneVerified
                    && withdrawal.amount >= SMS_LARGE_WITHDRAWAL_THRESHOLD) {
                    const ph        = withdrawal.user.phoneNumber;
                    const amt       = withdrawal.amount;
                    const reasonStr = statusResp.reason || 'MoMo gateway rejected the disbursement.';
                    setImmediate(() => {
                        this.sms.sendWithdrawalConfirmation(ph, {
                            kind:   'fiat_refunded',
                            amount: amt,
                            reason: reasonStr
                        }).catch(() => {});
                    });
                }
            } catch (revErr) {
                // Reversal failed — escalate to admin and leave the row
                // as-is so a human investigates.
                console.error(`[WithdrawalReconciliation] CRITICAL: reverseFiatWithdrawal failed for ${reference}:`, revErr.message);
                if (this.io) {
                    this.io.emit('admin_alert', {
                        type:         'WITHDRAWAL_REVERSAL_FAILED',
                        reference,
                        userId:       withdrawal.userId,
                        amountUsdc:   withdrawal.amount,
                        mtnReason:    statusResp.reason || null,
                        reverseError: revErr.message,
                        timestamp:    new Date().toISOString()
                    });
                }
            }
            return;
        }

        console.warn(`[WithdrawalReconciliation] ref=${reference} unexpected MTN status: ${remoteStatus}.`);
    }
}

module.exports = WithdrawalReconciliationWorker;
