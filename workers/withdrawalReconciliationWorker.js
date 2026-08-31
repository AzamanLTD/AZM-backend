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
const { recordReconciliationException } = require('../services/reconciliationExceptionService');

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
            // PENDING covers manual/legacy withdrawals that have not yet been
            // dispatched. PROCESSING covers auto-payout rows claimed before
            // provider I/O. Without both states, an auto-payout crash after the
            // claim would leave the customer's funds permanently stranded.
            const stuck = await this.prisma.withdrawal.findMany({
                where: {
                    status: { in: ['PENDING', 'PROCESSING'] },
                    createdAt: { lt: cutoff }
                },
                include: {
                    user: { select: { id: true, email: true, username: true, phoneNumber: true, phoneVerified: true } }
                },
                orderBy: { createdAt: 'asc' },
                take: MAX_BATCH_SIZE
            });
            if (stuck.length === 0) return;
            logger.info(`[WithdrawalReconciliation] reconciling ${stuck.length} pending/processing withdrawal(s).`);
            for (const w of stuck) {
                await this._reconcileOne(w).catch((err) => {
                    logger.error(`[WithdrawalReconciliation] row id=${w.id} reconcile error:`, err.message);
                });
            }
        } finally {
            this._running = false;
        }
    }

    async _recordException(withdrawal, reason, details = null, reference = null) {
        try {
            await recordReconciliationException(this.prisma, {
                entityType: 'WITHDRAWAL',
                entityId: String(withdrawal.id),
                reference,
                reason,
                details
            });
        } catch (exceptionError) {
            logger.error({ err: exceptionError, withdrawalId: withdrawal.id, reason },
                '[WithdrawalReconciliation] failed to persist reconciliation exception');
        }
    }

    async _findCanonicalTransaction(withdrawal) {
        if (typeof this.prisma.$queryRawUnsafe === 'function') {
            const linkedRows = await this.prisma.$queryRawUnsafe(
                'SELECT "transactionHistoryId" FROM "Withdrawal" WHERE "id" = $1 LIMIT 1',
                withdrawal.id
            );
            const linkedId = linkedRows?.[0]?.transactionHistoryId;
            if (linkedId) {
                const linked = await this.prisma.transactionHistory.findUnique({ where: { id: linkedId } });
                if (linked) return { row: linked, linked: true };

                await this._recordException(
                    withdrawal,
                    'LINKED_TRANSACTION_NOT_FOUND',
                    { transactionHistoryId: String(linkedId) }
                );
                return { row: null, linked: true };
            }
        }

        const txRows = await this.prisma.transactionHistory.findMany({
            where: {
                userId: withdrawal.userId,
                type: 'WITHDRAWAL_FIAT',
                amountUsdc: withdrawal.amount,
                createdAt: {
                    gte: new Date(withdrawal.createdAt.getTime() - 5_000),
                    lte: new Date(withdrawal.createdAt.getTime() + 5_000)
                }
            },
            orderBy: { createdAt: 'desc' },
            take: 2
        });

        if (txRows.length === 0) {
            await this._recordException(
                withdrawal,
                'MISSING_TRANSACTION_REFERENCE',
                { userId: withdrawal.userId, amount: String(withdrawal.amount), createdAt: withdrawal.createdAt.toISOString() }
            );
            return { row: null, linked: false };
        }

        if (txRows.length > 1) {
            await this._recordException(
                withdrawal,
                'AMBIGUOUS_TRANSACTION_REFERENCE',
                { candidateTransactionIds: txRows.map((row) => row.id), candidateReferences: txRows.map((row) => row.txHash).filter(Boolean) }
            );
            return { row: null, linked: false };
        }

        const txRow = txRows[0];
        if (!txRow.txHash) {
            await this._recordException(
                withdrawal,
                'TRANSACTION_MISSING_REFERENCE',
                { transactionId: txRow.id }
            );
            return { row: null, linked: false };
        }

        if (typeof this.prisma.$executeRawUnsafe === 'function') {
            await this.prisma.$executeRawUnsafe(
                'UPDATE "Withdrawal" SET "transactionHistoryId" = $1 WHERE "id" = $2 AND "transactionHistoryId" IS NULL',
                txRow.id,
                withdrawal.id
            );
        }

        return { row: txRow, linked: false };
    }

    async _reconcileOne(withdrawal) {
        const canonical = await this._findCanonicalTransaction(withdrawal);
        const txRow = canonical.row;
        if (!txRow) return;

        if (!txRow.txHash) {
            await this._recordException(
                withdrawal,
                'TRANSACTION_MISSING_REFERENCE',
                { transactionId: txRow.id }
            );
            return;
        }

        const reference = txRow.txHash;
        let statusResp;
        try {
            statusResp = await this.mtn.getTransferStatus(reference);
        } catch (err) {
            await this._recordException(
                withdrawal,
                'PROVIDER_STATUS_UNAVAILABLE',
                { provider: 'DISBURSEMENT', error: err.message },
                reference
            );
            logger.warn(`[WithdrawalReconciliation] provider status query failed for ${reference}: ${err.message}`);
            return;
        }

        const remoteStatus = String((statusResp && statusResp.status) || 'PENDING').toUpperCase();
        const providerRef = statusResp?.providerRef || statusResp?.referenceId || statusResp?.transactionId || statusResp?.txId || null;

        await recordProviderSettlementAttempt(this.prisma, {
            reference,
            provider: statusResp?.provider || 'DISBURSEMENT',
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
                await this._recordException(
                    withdrawal,
                    'REVERSAL_FAILED',
                    { error: revErr.message, providerReason: statusResp.reason || null },
                    reference
                );
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

        await this._recordException(
            withdrawal,
            'UNEXPECTED_PROVIDER_STATUS',
            { provider: statusResp?.provider || 'DISBURSEMENT', status: remoteStatus, response: statusResp },
            reference
        );
        logger.warn(`[WithdrawalReconciliation] ref=${reference} unexpected provider status: ${remoteStatus}.`);
    }
}

module.exports = WithdrawalReconciliationWorker;
