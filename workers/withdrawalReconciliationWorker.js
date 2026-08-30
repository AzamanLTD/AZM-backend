// workers/withdrawalReconciliationWorker.js
// =============================================================================
// AZAMAN V2 — WITHDRAWAL RECONCILIATION WORKER
//
// Provider settlement is authoritative for the customer-facing transaction
// state. The finance reservation creates TransactionHistory as PENDING; this
// worker advances it to COMPLETED only after the provider reports success, or
// reverses it on a provider failure. This keeps REST status, realtime status,
// the admin Withdrawal row, and the financial ledger on one lifecycle.
// =============================================================================

const logger = require('../src/config/logger');
const financeService = require('../services/finance.service');
const { recordProviderSettlementAttempt } = require('../services/providerSettlementAttemptService');

const RECONCILE_INTERVAL_MS = 30_000;
const STALE_AFTER_MS        = 30_000;
const MAX_BATCH_SIZE        = 50;

const SMS_LARGE_WITHDRAWAL_THRESHOLD = parseFloat(
    process.env.SMS_LARGE_WITHDRAWAL_THRESHOLD || '100'
);

class WithdrawalReconciliationWorker {
    constructor(prisma, io, mtnDisbursementService, emailService, smsService) {
        this.prisma = prisma;
        this.io = io;
        this.mtn = mtnDisbursementService;
        this.email = emailService || null;
        this.sms = smsService || null;
        this._timer = null;
        this._running = false;
    }

    start() {
        if (this._timer) return;
        if (!this.mtn) {
            logger.warn('[WithdrawalReconciliation] disbursement service not bound — worker disabled.');
            return;
        }
        logger.info(`[WithdrawalReconciliation] starting (every ${RECONCILE_INTERVAL_MS / 1000}s, stale > ${STALE_AFTER_MS / 1000}s).`);
        this._timer = setInterval(() => this._tick().catch((e) => {
            logger.error({ err: e }, '[WithdrawalReconciliation] tick crash');
        }), RECONCILE_INTERVAL_MS);
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    async _tick() {
        if (this._running) return;
        this._running = true;
        try {
            const cutoff = new Date(Date.now() - STALE_AFTER_MS);
            const stuck = await this.prisma.withdrawal.findMany({
                where: { status: 'PENDING', createdAt: { lt: cutoff } },
                include: {
                    user: { select: { id: true, email: true, username: true, phoneNumber: true, phoneVerified: true } }
                },
                orderBy: { createdAt: 'asc' },
                take: MAX_BATCH_SIZE
            });
            if (stuck.length === 0) return;
            logger.info(`[WithdrawalReconciliation] reconciling ${stuck.length} pending withdrawal(s).`);
            for (const w of stuck) {
                await this._reconcileOne(w).catch((err) => {
                    logger.error(`[WithdrawalReconciliation] row id=${w.id} reconcile error:`, err.message);
                });
            }
        } finally {
            this._running = false;
        }
    }

    async _reconcileOne(withdrawal) {
        // Legacy Withdrawal rows predate an explicit reference column. Until
        // that mirror is migrated, the canonical TransactionHistory row is the
        // recovery correlation source. Once found, the provider attempt itself
        // is persisted explicitly and becomes the durable external identity.
        const txRow = await this.prisma.transactionHistory.findFirst({
            where: {
                userId: withdrawal.userId,
                type: 'WITHDRAWAL_FIAT',
                amountUsdc: withdrawal.amount,
                createdAt: {
                    gte: new Date(withdrawal.createdAt.getTime() - 5_000),
                    lte: new Date(withdrawal.createdAt.getTime() + 5_000)
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        if (!txRow || !txRow.txHash) {
            logger.warn(`[WithdrawalReconciliation] row id=${withdrawal.id}: no matching TransactionHistory reference — skipping.`);
            return;
        }

        const reference = txRow.txHash;
        let statusResp;
        try {
            statusResp = await this.mtn.getTransferStatus(reference);
        } catch (err) {
            logger.warn(`[WithdrawalReconciliation] provider status query failed for ${reference}: ${err.message}`);
            return;
        }

        const remoteStatus = String((statusResp && statusResp.status) || 'PENDING').toUpperCase();
        const providerRef = statusResp?.providerRef || statusResp?.referenceId || statusResp?.transactionId || statusResp?.txId || null;

        await recordProviderSettlementAttempt(this.prisma, {
            reference,
            provider: 'MTN_MOMO_DISBURSEMENT',
            providerReference: reference,
            providerTransactionId: providerRef,
            status: ['SUCCESSFUL', 'COMPLETED'].includes(remoteStatus)
                ? 'COMPLETED'
                : ['FAILED', 'REJECTED'].includes(remoteStatus) ? 'FAILED' : 'PENDING',
            failureReason: ['FAILED', 'REJECTED'].includes(remoteStatus)
                ? (statusResp.reason || 'provider_async_failure')
                : null
        });

        if (remoteStatus === 'PENDING' || remoteStatus === 'PROCESSING') return;

        if (remoteStatus === 'SUCCESSFUL' || remoteStatus === 'COMPLETED') {
            // Advance the canonical ledger status and provider correlation in
            // one conditional write. Replayed ticks become harmless no-ops.
            await this.prisma.transactionHistory.updateMany({
                where: { id: txRow.id, status: 'PENDING' },
                data: {
                    status: 'COMPLETED',
                    ...(providerRef ? { providerRef: String(providerRef) } : {})
                }
            });
            await this.prisma.withdrawal.update({
                where: { id: withdrawal.id },
                data: { status: 'COMPLETED' }
            });

            logger.info(`[WithdrawalReconciliation] ref=${reference} settled SUCCESSFUL.`);
            if (this.io) {
                this.io.to(`user_${withdrawal.userId}`).emit('withdrawal_settled', {
                    reference,
                    status: 'COMPLETED',
                    amount: withdrawal.amount,
                    providerTxId: providerRef
                });
            }
            if (this.email && withdrawal.user?.email) {
                const recipient = withdrawal.user;
                const amount = withdrawal.amount;
                const dest = withdrawal.destination;
                setImmediate(() => this.email.sendWithdrawalReceipt(recipient, {
                    kind: 'fiat_success', amount, currency: 'USDC', reference, destination: dest
                }).catch(() => {}));
            }
            if (this.sms && withdrawal.user?.phoneNumber && withdrawal.user.phoneVerified
                && withdrawal.amount >= SMS_LARGE_WITHDRAWAL_THRESHOLD) {
                const ph = withdrawal.user.phoneNumber;
                const amt = withdrawal.amount;
                const dest = withdrawal.destination;
                setImmediate(() => this.sms.sendWithdrawalConfirmation(ph, {
                    kind: 'fiat_settled', amount: amt, destination: dest, reference
                }).catch(() => {}));
            }
            return;
        }

        if (remoteStatus === 'FAILED' || remoteStatus === 'REJECTED') {
            try {
                if (providerRef) {
                    await this.prisma.transactionHistory.updateMany({
                        where: { id: txRow.id, status: 'PENDING' },
                        data: { providerRef: String(providerRef) }
                    });
                }
                const result = await financeService.reverseFiatWithdrawal(this.prisma, reference, {
                    reason: `provider_async_failure: ${statusResp.reason || 'unspecified'}`
                });
                await this.prisma.withdrawal.update({
                    where: { id: withdrawal.id },
                    data: { status: 'FAILED' }
                });
                logger.warn(`[WithdrawalReconciliation] ref=${reference} REVERSED. user refund: ${result.refundedAmount} USDC.`);
                if (this.io) {
                    this.io.to(`user_${withdrawal.userId}`).emit('withdrawal_settled', {
                        reference, status: 'FAILED', amount: withdrawal.amount, refunded: result.refundedAmount
                    });
                    this.io.emit('admin_alert', {
                        type: 'WITHDRAWAL_AUTO_REVERSED', reference, userId: withdrawal.userId,
                        amountUsdc: withdrawal.amount,
                        reason: statusResp.reason || 'provider_async_failure',
                        timestamp: new Date().toISOString()
                    });
                }
                if (this.email && withdrawal.user?.email) {
                    const recipient = withdrawal.user;
                    const amount = withdrawal.amount;
                    const refunded = result.refundedAmount;
                    const reasonStr = statusResp.reason || 'The MoMo gateway rejected the disbursement.';
                    setImmediate(() => this.email.sendWithdrawalReceipt(recipient, {
                        kind: 'fiat_failure', amount, currency: 'USDC', reference,
                        refundedAmount: refunded, reason: reasonStr
                    }).catch(() => {}));
                }
                if (this.sms && withdrawal.user?.phoneNumber && withdrawal.user.phoneVerified
                    && withdrawal.amount >= SMS_LARGE_WITHDRAWAL_THRESHOLD) {
                    const ph = withdrawal.user.phoneNumber;
                    const amt = withdrawal.amount;
                    const reasonStr = statusResp.reason || 'MoMo gateway rejected the disbursement.';
                    setImmediate(() => this.sms.sendWithdrawalConfirmation(ph, {
                        kind: 'fiat_refunded', amount: amt, reason: reasonStr
                    }).catch(() => {}));
                }
            } catch (revErr) {
                logger.error(`[WithdrawalReconciliation] CRITICAL: reverseFiatWithdrawal failed for ${reference}:`, revErr.message);
                if (this.io) {
                    this.io.emit('admin_alert', {
                        type: 'WITHDRAWAL_REVERSAL_FAILED', reference, userId: withdrawal.userId,
                        amountUsdc: withdrawal.amount,
                        mtnReason: statusResp.reason || null,
                        reverseError: revErr.message,
                        timestamp: new Date().toISOString()
                    });
                }
            }
            return;
        }

        logger.warn(`[WithdrawalReconciliation] ref=${reference} unexpected provider status: ${remoteStatus}.`);
    }
}

module.exports = WithdrawalReconciliationWorker;
