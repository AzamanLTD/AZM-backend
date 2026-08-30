// =============================================================================
// AZAMAN — FIAT PROVIDER SETTLEMENT SERVICE
//
// Provider callbacks are the first authoritative external settlement signal.
// This module owns the narrow state transition from our internal reservation
// (PENDING) to the provider-settled terminal state (COMPLETED/FAILED).
//
// The reconciliation worker remains a recovery mechanism for callbacks that
// arrive late or are lost; it must not be the normal path for a provider that
// has already called us.
// =============================================================================

const financeService = require('./finance.service');
const { recordProviderSettlementAttempt } = require('./providerSettlementAttemptService');

const settleFiatWithdrawal = async (prisma, {
    reference,
    status,
    provider = 'MTN_MOMO_DISBURSEMENT',
    providerTxId = null,
    reason = null
}) => {
    if (!reference) throw new Error('[fiatSettlement] reference is required.');
    if (!['SUCCESSFUL', 'FAILED'].includes(status)) {
        throw new Error(`[fiatSettlement] unsupported terminal status: ${status}`);
    }

    const original = await prisma.transactionHistory.findUnique({
        where: { txHash: reference }
    });

    if (!original) {
        const error = new Error(`[fiatSettlement] Unknown reference: ${reference}`);
        error.code = 'UNKNOWN_REFERENCE';
        throw error;
    }
    if (original.type !== 'WITHDRAWAL_FIAT') {
        const error = new Error(`[fiatSettlement] ${reference} is not a fiat withdrawal.`);
        error.code = 'WRONG_TRANSACTION_TYPE';
        throw error;
    }

    // Durable external identity is recorded independently of the ledger state.
    // This means duplicate/late callbacks can always be correlated to the same
    // provider attempt without user+amount+timestamp heuristics.
    await recordProviderSettlementAttempt(prisma, {
        reference,
        provider,
        providerReference: reference,
        providerTransactionId: providerTxId,
        status: status === 'SUCCESSFUL' ? 'COMPLETED' : 'FAILED',
        failureReason: status === 'FAILED' ? reason : null
    });

    // SUCCESSFUL: atomically claim only PENDING rows. A duplicate callback is
    // therefore harmless, and a late SUCCESS cannot resurrect a FAILED row.
    if (status === 'SUCCESSFUL') {
        const claim = await prisma.transactionHistory.updateMany({
            where: {
                txHash: reference,
                status: 'PENDING'
            },
            data: {
                status: 'COMPLETED',
                ...(providerTxId ? { providerRef: String(providerTxId) } : {})
            }
        });

        if (claim.count === 1) {
            const transaction = await prisma.transactionHistory.findUnique({
                where: { txHash: reference }
            });
            return {
                reference,
                userId: original.userId,
                status: 'COMPLETED',
                changed: true,
                providerTxId: providerTxId || transaction?.providerRef || null,
                transaction
            };
        }

        // The row may already be COMPLETED from a duplicate callback or an
        // older provider path. Preserve terminal state and enrich providerRef
        // only when it has not been recorded yet.
        const current = await prisma.transactionHistory.findUnique({
            where: { txHash: reference }
        });
        if (current?.status === 'COMPLETED' && providerTxId && !current.providerRef) {
            const transaction = await prisma.transactionHistory.update({
                where: { txHash: reference },
                data: { providerRef: String(providerTxId) }
            });
            return {
                reference,
                userId: current.userId,
                status: 'COMPLETED',
                changed: false,
                providerTxId: transaction.providerRef,
                transaction
            };
        }

        return {
            reference,
            userId: current?.userId || original.userId,
            status: current?.status || original.status,
            changed: false,
            providerTxId: providerTxId || current?.providerRef || null,
            transaction: current
        };
    }

    // FAILED: only a still-pending reservation is eligible for provider
    // reversal. This prevents a contradictory late FAILED callback from
    // refunding a withdrawal that has already been authoritatively completed.
    if (original.status === 'FAILED') {
        return {
            reference,
            userId: original.userId,
            status: 'FAILED',
            changed: false,
            alreadyReversed: true,
            providerTxId: providerTxId || original.providerRef || null,
            transaction: original
        };
    }

    if (original.status === 'COMPLETED') {
        return {
            reference,
            userId: original.userId,
            status: 'COMPLETED',
            changed: false,
            conflictingTerminalCallback: true,
            providerTxId: providerTxId || original.providerRef || null,
            transaction: original
        };
    }

    if (original.status !== 'PENDING') {
        return {
            reference,
            userId: original.userId,
            status: original.status,
            changed: false,
            providerTxId: providerTxId || original.providerRef || null,
            transaction: original
        };
    }

    const reversal = await financeService.reverseFiatWithdrawal(prisma, reference, {
        reason: reason || 'Provider reported FAILED settlement.'
    });

    // Keep the provider transaction identifier on the canonical ledger row.
    // reverseFiatWithdrawal deliberately owns the financial refund; this update
    // only enriches the already-terminal audit record.
    let transaction = await prisma.transactionHistory.findUnique({
        where: { txHash: reference }
    });
    if (transaction && providerTxId && !transaction.providerRef) {
        transaction = await prisma.transactionHistory.update({
            where: { txHash: reference },
            data: { providerRef: String(providerTxId) }
        });
    }

    return {
        reference,
        userId: reversal.userId || original.userId,
        status: 'FAILED',
        changed: !reversal.alreadyReversed,
        alreadyReversed: Boolean(reversal.alreadyReversed),
        providerTxId: providerTxId || transaction?.providerRef || null,
        reversal,
        transaction
    };
};

module.exports = { settleFiatWithdrawal };
