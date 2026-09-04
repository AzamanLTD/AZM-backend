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

// Provider references are mutable only while a withdrawal is still in its
// reservation lifecycle. Once a terminal state has a provider reference, a
// later callback must never overwrite it: contradictory callbacks are evidence
// to retain, not an instruction to rewrite the authoritative settlement record.
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
        // The finance service owns the authoritative PENDING -> COMPLETED
        // transition and its economics. For an already-COMPLETED record, the
        // call is intentionally a no-op; a missing provider reference can then
        // be filled once, without touching balances or economics. For a FAILED
        // terminal record, do not mutate the stored provider reference even if
        // it is absent: the late SUCCESS is contradictory evidence and must not
        // turn into a new authoritative provider identity.
        const result = await financeService.completeFiatWithdrawal(prisma, reference, {
            providerTxId
        });

        let transaction = result.transaction;
        if (original.status === 'COMPLETED') {
            transaction = await enrichProviderReference(
                prisma,
                reference,
                result.transaction,
                providerTxId
            );
        }

        return {
            ...result,
            providerTxId: providerTxId || result.providerTxId || transaction?.providerRef || null,
            transaction
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

    // A PENDING provider result may add its external identity once. Persist it
    // before the reversal so the callback remains auditable even if the mocked
    // or real reversal path re-reads the transaction after changing status.
    let transaction = original;
    if (providerTxId && !original.providerRef) {
        transaction = await prisma.transactionHistory.update({
            where: { txHash: reference },
            data: { providerRef: String(providerTxId) }
        });
    }

    const reversal = await financeService.reverseFiatWithdrawal(prisma, reference, {
        reason: reason || 'Provider reported FAILED settlement.'
    });

    const latest = await prisma.transactionHistory.findUnique({
        where: { txHash: reference }
    });
    transaction = latest || transaction;

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