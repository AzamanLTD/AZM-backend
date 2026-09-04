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

const enrichProviderReference = async (prisma, reference, currentTransaction, providerTxId) => {
    if (!providerTxId || currentTransaction?.providerRef) return currentTransaction;

    const latest = await prisma.transactionHistory.findUnique({
        where: { txHash: reference }
    });
    if (!latest || latest.providerRef) return latest || currentTransaction;

    return prisma.transactionHistory.update({
        where: { txHash: reference },
        data: { providerRef: String(providerTxId) }
    });
};

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

    await recordProviderSettlementAttempt(prisma, {
        reference,
        provider,
        providerReference: reference,
        providerTransactionId: providerTxId,
        status: status === 'SUCCESSFUL' ? 'COMPLETED' : 'FAILED',
        failureReason: status === 'FAILED' ? reason : null
    });

    if (status === 'SUCCESSFUL') {
        const result = await financeService.completeFiatWithdrawal(prisma, reference, {
            providerTxId
        });

        // A SUCCESSFUL callback may be a duplicate for a row that was already
        // completed by an earlier callback/reconciliation. In that case the
        // economics boundary correctly does nothing; we can still persist the
        // provider transaction reference as harmless idempotent metadata.
        const transaction = await enrichProviderReference(
            prisma,
            reference,
            result.transaction,
            providerTxId
        );

        return {
            ...result,
            providerTxId: transaction?.providerRef || result.providerTxId || providerTxId || null,
            transaction
        };
    }

    // FAILED: only a still-pending reservation is eligible for provider
    // reversal. This prevents a contradictory late FAILED callback from
    // refunding a withdrawal that has already been authoritatively completed.
    if (original.status === 'FAILED') {
        const transaction = await enrichProviderReference(
            prisma,
            reference,
            original,
            providerTxId
        );
        return {
            reference,
            userId: original.userId,
            status: 'FAILED',
            changed: false,
            alreadyReversed: true,
            providerTxId: transaction?.providerRef || providerTxId || null,
            transaction
        };
    }

    if (original.status === 'COMPLETED') {
        const transaction = await enrichProviderReference(
            prisma,
            reference,
            original,
            providerTxId
        );
        return {
            reference,
            userId: original.userId,
            status: 'COMPLETED',
            changed: false,
            conflictingTerminalCallback: true,
            providerTxId: transaction?.providerRef || providerTxId || null,
            transaction
        };
    }

    if (original.status !== 'PENDING') {
        const transaction = await enrichProviderReference(
            prisma,
            reference,
            original,
            providerTxId
        );
        return {
            reference,
            userId: original.userId,
            status: original.status,
            changed: false,
            providerTxId: transaction?.providerRef || providerTxId || null,
            transaction
        };
    }

    const reversal = await financeService.reverseFiatWithdrawal(prisma, reference, {
        reason: reason || 'Provider reported FAILED settlement.'
    });

    let transaction = await prisma.transactionHistory.findUnique({
        where: { txHash: reference }
    });
    transaction = await enrichProviderReference(prisma, reference, transaction, providerTxId);

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