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
const fiatLiquidity = require('../src/services/fiatLiquidityService');
const { bindOutboundSettlementEvidence } = require('./outboundSettlementEvidence'); // r20 P0
const {
    recordReconciliationExceptionLoud,
} = require('./reconciliationExceptionService'); // r20 P0 durable park

// Provider references are mutable only while a withdrawal is still in its
// reservation lifecycle. Once a terminal state has a provider reference, a
// later callback must never overwrite it: contradictory callbacks are evidence
// to retain, not an instruction to rewrite the authoritative settlement record.
// r15 R15-E: enrichment is an atomic CAS claim. The previous
// read-check-write raced: two concurrent callbacks both observing
// providerRef null both passed the check and the last write silently
// replaced contradictory provider evidence. The conditional updateMany
// makes the FIRST provider identity authoritative; losers converge by
// re-reading the committed row and NEVER overwrite it.
const enrichProviderReference = async (prisma, reference, currentTransaction, providerTxId) => {
    if (!providerTxId || currentTransaction?.providerRef) return currentTransaction;

    await prisma.transactionHistory.updateMany({
        where: { txHash: reference, providerRef: null },
        data: { providerRef: String(providerTxId) },
    });

    // Winner or loser: always return the authoritative committed row.
    const latest = await prisma.transactionHistory.findUnique({
        where: { txHash: reference }
    });
    return latest || currentTransaction;
};

const settleFiatWithdrawal = async (prisma, {
    reference,
    status,
    provider = 'MTN_MOMO_DISBURSEMENT',
    providerTxId = null,
    reason = null,
    // r20 P0: the provider-reported payout amount when the settlement
    // callback carries one (captured by the webhook normalizer). Validated
    // against the durable committed economics — never against the current rate.
    amountGhs = null,
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

    // §P.5-D OUTBOUND EVIDENCE (fail-closed): the terminal provider
    // observation is durably retained BEFORE any authoritative settlement
    // transition. A duplicate terminal callback converges to the committed
    // observation; a CONTRADICTORY one (SUCCESS after FAILED / FAILED after
    // SUCCESS) lands as a distinct durable row — the authority's quarantine
    // path consumes it, and nothing is silently dropped. If evidence cannot
    // be persisted the settlement MUST NOT proceed as though it exists: the
    // caller (webhook/recon worker) fails closed and the provider retries.
    await fiatLiquidity.recordProviderEvent(prisma, {
        provider,
        rail: 'MOMO',
        direction: 'OUTBOUND',
        status,
        providerRef: providerTxId,
        dedupKey: `event:payout-outbound:${provider}:${reference}:${status}`,
        relatedReference: reference,
        raw: { reason: reason ?? null, source: 'provider_callback' },
    });

    // r20 P0 — OUTBOUND SETTLEMENT EVIDENCE BINDING: the observation is now
    // durably recorded above (contradictions are evidence, never dropped),
    // but it may move customer money ONLY when bound to the EXACT payout:
    // a known canonical provider identity, agreement with the durable owner
    // when one exists, the provider-named reference (inherent for an
    // authenticated callback — the reference IS the echoed externalref),
    // and the exact amount when the callback contract carries one. A
    // rejected binding parks the payout (durable exception, no completion,
    // no refund) and surfaces a classified error to the caller.
    const binding = await bindOutboundSettlementEvidence(prisma, {
        reference,
        provider,
        externalId: reference, // the callback reference IS the provider-named externalref
        amountGhs,
        status,
        source: 'provider_callback',
    });
    if (!binding.bound) {
        await recordReconciliationExceptionLoud(prisma, {
            entityType: 'TRANSACTION',
            entityId: reference,
            reference,
            reason: 'SETTLEMENT_EVIDENCE_REJECTED',
            details: {
                bindingReason: binding.reason,
                bindingDetails: binding.details || null,
                provider,
                observedStatus: status,
                observedAmountGhs: amountGhs ?? null,
            },
        });
        const rejected = new Error(
            `[fiatSettlement] terminal ${status} observation for ${reference} is NOT bound to this payout (${binding.reason}) — parked for operator review.`
        );
        rejected.code = 'SETTLEMENT_EVIDENCE_REJECTED';
        throw rejected;
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
        if (original.status === 'FAILED') {
            // A late SUCCESS contradicts the authoritatively FAILED
            // withdrawal: the provider may actually have paid cash that the
            // FAILED path already returned to availability. Push the
            // terminal observation through the authority's quarantine path
            // (RELEASED reservation → reconciliation hold, guarded against
            // the funds having already been consumed).
            const quarantine = await fiatLiquidity.settleIfRecorded(prisma, {
                reference,
                outcome: 'SUCCESSFUL',
                providerTxId,
                reason: 'contradictory late SUCCESS after FAILED settlement',
            });
            return {
                reference,
                userId: original.userId,
                status: 'FAILED',
                changed: false,
                conflictingTerminalCallback: true,
                quarantined: !quarantine.skipped,
                providerTxId: providerTxId || original.providerRef || null,
                transaction
            };
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
        // r15 R15-E: same CAS discipline — a concurrent callback may have
        // enriched the reference between our read and this write; the
        // conditional claim keeps the FIRST provider identity and never
        // silently replaces contradictory evidence.
        await prisma.transactionHistory.updateMany({
            where: { txHash: reference, providerRef: null },
            data: { providerRef: String(providerTxId) },
        });
        transaction = await prisma.transactionHistory.findUnique({
            where: { txHash: reference }
        }) || original;
    }

    const reversal = await financeService.reverseFiatWithdrawal(prisma, reference, {
        reason: reason || 'Provider reported FAILED settlement.',
        // provider-terminal evidence: the FAILED observation was durably
        // recorded above, so the authority releases (not quarantines) the
        // IN_TRANSIT reservation through the evidence-backed settle path.
        providerTerminal: true,
        providerTxId
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

module.exports = { settleFiatWithdrawal, enrichProviderReference };