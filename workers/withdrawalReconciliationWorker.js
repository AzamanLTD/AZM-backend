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
const { resolvePayoutOwner } = require('../services/payoutProviderOwnership');
const fiatLiquidity = require('../src/services/fiatLiquidityService'); // §P.5-D
const { recordReconciliationException } = require('../services/reconciliationExceptionService');
const restrictedObligations = require('../services/restrictedObligationService'); // r17 P0 durable identity
const withdrawalBridge = require('../services/withdrawalBridgeService'); // r18 durable orphan-adoption claim

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
            // provider I/O. DISPATCHING covers rows claimed by the r16c direct
            // dispatch boundary (Withdrawal PENDING -> DISPATCHING before
            // provider I/O). Without all three states, a crash after any claim
            // would leave the customer's funds permanently stranded.
            const stuck = await this.prisma.withdrawal.findMany({
                where: {
                    status: { in: ['PENDING', 'PROCESSING', 'DISPATCHING'] },
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

        // r17 P0 identity guard: a withdrawal that OWNS its own obligation
        // (durable relation sourceEntity='withdrawal', e.g. the wallet
        // reservation path) must never adopt a fiat canonical through this
        // guessed fallback — settlement/reversal would act on another
        // withdrawal's reservation under this row's mirror. Record the
        // miss and let an operator reconcile.
        const ownObligation = await restrictedObligations.findActiveForSource(this.prisma, 'withdrawal', withdrawal.id);
        if (ownObligation) {
            await this._recordException(
                withdrawal,
                'MISSING_TRANSACTION_REFERENCE',
                { userId: withdrawal.userId, amount: String(withdrawal.amount), reason: 'WITHDRAWAL_OWNS_OWN_OBLIGATION_NO_BRIDGE' }
            );
            return { row: null, linked: false };
        }

        const txRowsRaw = await this.prisma.transactionHistory.findMany({
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
            take: 10
        });
        // r17 P0: the guessed match may only adopt a GENUINELY ORPHAN
        // canonical — not one durably linked to another Withdrawal row via
        // the bridge (that would settle/reverse another withdrawal's
        // reservation under this row).
        const txRows = await this._excludeBridgeLinked(txRowsRaw);

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

        // r18: adopting the orphan is a DURABLE OWNERSHIP CLAIM, not a
        // fire-and-forget backfill. A caller that loses the claim to a
        // concurrent mirror NEVER receives the canonical row — the miss is
        // recorded for operator attention and this row converges on the
        // durable bridge state (the winner's) on the next pass.
        const claim = await withdrawalBridge.claimOrphanCanonical(this.prisma, withdrawal.id, txRow.id);
        if (!claim.won) {
            logger.warn({
                withdrawalId: withdrawal.id,
                canonicalId: txRow.id,
                owner: claim.owner,
                reason: claim.reason,
            }, '[WithdrawalReconciliation] orphan canonical claim lost — refusing canonical adoption');
            await this._recordException(
                withdrawal,
                'ORPHAN_ADOPTION_CLAIM_LOST',
                {
                    candidateTransactionId: txRow.id,
                    candidateReference: txRow.txHash,
                    ownerWithdrawalId: claim.owner ?? null,
                    claimReason: claim.reason,
                }
            );
            return { row: null, linked: false };
        }

        return { row: txRow, linked: false };
    }

    /**
     * r17 P0 — drop candidate canonical rows durably linked to ANY Withdrawal
     * row via the transactionHistoryId bridge. The guessed amount±5s
     * fallback may only ever adopt an ORPHAN (pre-bridge legacy) row.
     */
    async _excludeBridgeLinked(candidates) {
        if (!Array.isArray(candidates) || candidates.length === 0) return [];
        if (typeof this.prisma.$queryRawUnsafe !== 'function') return candidates;
        const ids = candidates.map((c) => c.id);
        const linked = await this.prisma.$queryRawUnsafe(
            'SELECT "transactionHistoryId" FROM "Withdrawal" WHERE "transactionHistoryId" = ANY($1::text[])',
            ids
        );
        const linkedSet = new Set((linked || []).map((r) => r.transactionHistoryId));
        return candidates.filter((c) => !linkedSet.has(c.id));
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

        // r15 follow-up (audit P0) + hardening (2026-09-20): resolve the
        // durable owner from ALL authoritative evidence, most-authoritative
        // first: canonical metadata (payoutProvider), then the unique durable
        // dispatch observation (FiatProviderEvent) — the recovery path for a
        // dispatch whose canonical ownership write failed AFTER the provider
        // accepted the money. A known owner is authoritative for this
        // payout: the status query goes to the OWNER ONLY — the
        // PaymentFailoverService honors the hint and never falls through to
        // another rail (a healthy secondary cannot know what the owner did,
        // so its answer may never settle or reverse this provider's payout).
        const ownership = await resolvePayoutOwner(this.prisma, txRow);

        if (ownership.status === 'CONFLICT') {
            // Two different providers hold durable owner evidence for one
            // reference — NEVER pick one. Park for operator review.
            logger.error({ reference, owners: ownership.owners },
                '[WithdrawalReconciliation] OWNERSHIP CONFLICT: multiple durable owner records — parking for operator review');
            await this._recordException(
                withdrawal,
                'PAYOUT_OWNERSHIP_CONFLICT',
                { reference, owners: ownership.owners },
                reference
            );
            return;
        }

        const payoutOwner = ownership.owner || null;

        if (ownership.status === 'UNKNOWN') {
            // No owner evidence at all. Before falling back to the legacy
            // no-hint cross-provider search (correct for GENUINELY-unknown
            // ownership — e.g. pre-r15 legacy rows that never dispatched
            // through evidence-tagged bookkeeping), check the durable
            // exception queue: if this dispatch was ACCEPTED but its owner
            // bookkeeping failed (evidence + ownership writes) or its
            // accepting identity could never be determined (identity
            // unknown / contradictory), the owner exists but is not
            // durably recoverable — cross-rail guessing is
            // exactly what the ownership system forbids. Park instead.
            // ReconciliationException is a raw-SQL entity (no Prisma model).
            const bookkeepingFailures = await this.prisma.$queryRawUnsafe(
                'SELECT "reason" FROM "ReconciliationException" ' +
                'WHERE "reference" = $1 AND "reason" IN (\'POST_DISPATCH_BOOKKEEPING_FAILED\', \'POST_DISPATCH_OWNERSHIP_WRITE_FAILED\', \'DISPATCH_IDENTITY_UNKNOWN\', \'DISPATCH_IDENTITY_CONTRADICTION\') ' +
                'ORDER BY "firstSeenAt" DESC LIMIT 1',
                reference
            );
            const bookkeepingFailure = bookkeepingFailures?.[0] || null;
            if (bookkeepingFailure) {
                logger.error({ reference, exceptionReason: bookkeepingFailure.reason },
                    '[WithdrawalReconciliation] dispatch was accepted but its owner bookkeeping failed durably — NEVER cross-rail guessing, parking');
                await this._recordException(
                    withdrawal,
                    'DISPATCHED_OWNERSHIP_NOT_DURABLE',
                    { reference, bookkeepingFailureReason: bookkeepingFailure.reason },
                    reference
                );
                return;
            }
            // Genuinely unknown ownership (legacy row, no dispatch evidence,
            // no bookkeeping failure): the no-hint cross-provider status
            // search below remains correct.
        }

        let statusResp;
        try {
            statusResp = await this.mtn.getTransferStatus(reference, payoutOwner?.tag);
        } catch (err) {
            await this._recordException(
                withdrawal,
                'PROVIDER_STATUS_UNAVAILABLE',
                { provider: payoutOwner?.canonicalName || 'DISBURSEMENT', error: err.message },
                reference
            );
            logger.warn(`[WithdrawalReconciliation] provider status query failed for ${reference}: ${err.message}`);
            return;
        }

        const remoteStatus = String((statusResp && statusResp.status) || 'PENDING').toUpperCase();
        const providerRef = statusResp?.providerRef || statusResp?.referenceId || statusResp?.transactionId || statusResp?.txId || null;

        // r15 hardening: a KNOWN owner is authoritative — the status
        // answer's own self-identification may never override it. If the
        // answering adapter names a DIFFERENT provider than the durable
        // owner, that is a contradiction, not new information: park for
        // operator review (never settle or reverse on a self-identified
        // identity that disputes the owner record).
        const statusSelfIdentified = statusResp?.provider ? String(statusResp.provider).toUpperCase() : null;
        const ownerCanonicalName = payoutOwner?.canonicalName || null;
        if (statusSelfIdentified && ownerCanonicalName && statusSelfIdentified !== ownerCanonicalName) {
            logger.error({ reference, ownerCanonicalName, statusSelfIdentified },
                '[WithdrawalReconciliation] provider self-identification CONTRADICTS the durable owner — parking for operator review');
            await this._recordException(
                withdrawal,
                'OWNER_SELF_IDENTIFICATION_CONTRADICTION',
                { reference, ownerCanonicalName, statusSelfIdentified, observedStatus: remoteStatus },
                reference
            );
            return;
        }

        // The provider identity carried into durable evidence: the durable
        // owner identity first (authoritative), then the status answer's own
        // provider field (ownerless legacy search — the answering adapter
        // identifies itself), then the legacy poll default.
        const evidenceProvider = ownerCanonicalName || statusSelfIdentified || 'DISBURSEMENT_POLL';

        // §P.5-D OUTBOUND EVIDENCE: the provider's own status answer is a raw
        // provider observation — retained durably like every other, including
        // intermediate PENDING answers, terminal SUCCESS/FAILED answers, and
        // answers that CONTRADICT an earlier callback (distinct dedupKey per
        // observation status; replays converge). If the evidence cannot be
        // persisted, fail closed: no authoritative settlement transition is
        // made this tick; the exception is recorded and the next poll retries.
        try {
            await fiatLiquidity.recordProviderEvent(this.prisma, {
                provider: evidenceProvider,
                rail: 'MOMO',
                direction: 'OUTBOUND',
                status: remoteStatus,
                providerRef,
                dedupKey: `event:payout-outbound:${evidenceProvider}:${reference}:${remoteStatus}`,
                relatedReference: reference,
                raw: { source: 'provider_status_poll', reason: statusResp?.reason || null },
            });
        } catch (evidenceErr) {
            logger.error({ err: evidenceErr, reference },
                '[WithdrawalReconciliation] §P.5-D outbound evidence persistence failed — settlement deferred');
            await this._recordException(
                withdrawal,
                'OUTBOUND_EVIDENCE_PERSISTENCE_FAILED',
                { provider: evidenceProvider, observedStatus: remoteStatus, error: evidenceErr.message },
                reference
            );
            return;
        }

        // r15 follow-up (audit P0): an authoritative ABSENCE is not a
        // settlement attempt — the provider never saw this reference on its
        // rail. The observation above IS the durable evidence; record the
        // ownership/presence conflict for an operator and park. With a known
        // owner this answer contradicts the dispatch acceptance evidence;
        // with unknown ownership every configured rail answered absence, so
        // the dispatch evidence itself is contradicted. NEVER resolve it by
        // inventing a terminal state.
        if (remoteStatus === 'NOT_FOUND') {
            await this._recordException(
                withdrawal,
                'PROVIDER_REFERENCE_NOT_FOUND',
                {
                    provider: evidenceProvider,
                    owner: payoutOwner?.tag || null,
                    ownerCanonicalName: payoutOwner?.canonicalName || null,
                    observedStatus: remoteStatus,
                    response: statusResp,
                },
                reference
            );
            logger.warn(`[WithdrawalReconciliation] ref=${reference} provider ${evidenceProvider} authoritatively reports the reference ABSENT — parked for operator review.`);
            return;
        }

        await recordProviderSettlementAttempt(this.prisma, {
            reference,
            provider: payoutOwner?.canonicalName || statusResp?.provider || 'DISBURSEMENT',
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

        // r15 follow-up (audit P0): UNRESOLVED is an honest "cannot answer"
        // (transport failure or application-level uncertainty on a known
        // owner's rail, or every rail ambiguous with unknown ownership). The
        // payout stays parked with durable evidence — it is never a state to
        // settle or reverse on.
        if (remoteStatus === 'UNKNOWN') {
            await this._recordException(
                withdrawal,
                'PROVIDER_STATUS_UNRESOLVED',
                {
                    provider: evidenceProvider,
                    owner: payoutOwner?.tag || null,
                    ownerCanonicalName: payoutOwner?.canonicalName || null,
                    unresolvedReason: statusResp?.unresolvedReason || null,
                    response: statusResp,
                },
                reference
            );
            logger.warn(`[WithdrawalReconciliation] ref=${reference} status UNRESOLVED (owner=${payoutOwner?.tag || 'unknown'}) — parked with durable evidence.`);
            return;
        }

        if (remoteStatus === 'SUCCESSFUL' || remoteStatus === 'COMPLETED') {
            // Provider success must cross the canonical finance settlement
            // boundary. This is where deferred exit-fee/referral economics are
            // recognized exactly once; directly flipping TransactionHistory
            // bypasses that accounting layer.
            const settlement = await financeService.completeFiatWithdrawal(this.prisma, reference, {
                providerTxId: providerRef
            });
            if (settlement.status !== 'COMPLETED') {
                await this._recordException(
                    withdrawal,
                    'FINANCIAL_SETTLEMENT_CONFLICT',
                    { transactionStatus: settlement.status, providerStatus: remoteStatus },
                    reference
                );
                logger.error(`[WithdrawalReconciliation] ref=${reference} provider SUCCESS conflicts with transaction status ${settlement.status}.`);
                return;
            }

            // SINGLE-WINNER CLAIM: multiple scheduler instances may poll the
            // same provider result. Only the instance that transitions the
            // outer Withdrawal row may emit terminal realtime/notifications.
            const terminalClaim = await this.prisma.withdrawal.updateMany({
                where: {
                    id: withdrawal.id,
                    status: { in: ['PENDING', 'PROCESSING', 'DISPATCHING'] }
                },
                data: { status: 'COMPLETED' }
            });
            if (terminalClaim.count !== 1) {
                logger.info(`[WithdrawalReconciliation] ref=${reference} SUCCESSFUL already terminal; suppressing duplicate effects.`);
                return;
            }

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
                if (result.notReversible || result.status === 'COMPLETED') {
                    await this._recordException(
                        withdrawal,
                        'FINANCIAL_REVERSAL_CONFLICT',
                        { transactionStatus: result.status || 'UNKNOWN', providerStatus: remoteStatus },
                        reference
                    );
                    logger.error(`[WithdrawalReconciliation] ref=${reference} provider FAILURE conflicts with transaction status ${result.status || 'UNKNOWN'}.`);
                    return;
                }

                // SINGLE-WINNER CLAIM: reverseFiatWithdrawal protects the
                // financial mutation; this CAS protects terminal effects on
                // the separate Withdrawal aggregate and its realtime fanout.
                const terminalClaim = await this.prisma.withdrawal.updateMany({
                    where: {
                        id: withdrawal.id,
                        status: { in: ['PENDING', 'PROCESSING', 'DISPATCHING'] }
                    },
                    data: { status: 'FAILED' }
                });
                if (terminalClaim.count !== 1) {
                    logger.info(`[WithdrawalReconciliation] ref=${reference} FAILED already terminal; suppressing duplicate effects.`);
                    return;
                }

                // If another reconciler won the TransactionHistory reversal but
                // crashed before updating Withdrawal, this instance can still
                // claim the terminal Withdrawal row. The canonical refund is
                // deterministic from the immutable transaction amount + fee,
                // so terminal failure payloads never carry an undefined refund.
                const refundedAmount = result.refundedAmount != null
                    ? result.refundedAmount
                    : Number(txRow.amountUsdc) + Number(txRow.feeUsdc);

                logger.warn(`[WithdrawalReconciliation] ref=${reference} REVERSED. user refund: ${refundedAmount} USDC.`);
                if (this.io) {
                    this.io.to(`user_${withdrawal.userId}`).emit('withdrawal_settled', {
                        reference, status: 'FAILED', amount: withdrawal.amount, refunded: refundedAmount
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
                    const refunded = refundedAmount;
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
            { provider: evidenceProvider, status: remoteStatus, response: statusResp },
            reference
        );
        logger.warn(`[WithdrawalReconciliation] ref=${reference} unexpected provider status: ${remoteStatus}.`);
    }
}

module.exports = WithdrawalReconciliationWorker;
