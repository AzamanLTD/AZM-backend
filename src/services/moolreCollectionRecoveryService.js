/**
 * r15 R15-B — durable Moolre collection recovery by SAME-reference status query.
 * =========================================================================
 * Moolre guidance: one durable external reference per business action; after
 * an uncertain response the SAME reference is reused and the operation stays
 * pending until status/callback resolves the outcome. This service is the
 * status half of that contract:
 *
 *   status query by the SAME externalRef → validate the returned authority →
 *   SUCCESS settles ONCE through the shared settlement core (identical
 *   transaction to the mounted webhook); FAILED fails the deposit ONCE via
 *   database CAS; PENDING stays pending. An uncertain status lookup itself
 *   stays pending — a status endpoint error is "unresolved", never "failed".
 *
 * Authority validation BEFORE any lifecycle mutation (r15 R15-P):
 *   * returned externalref MUST equal the requested externalRef
 *   * returned amount MUST parse exactly (2dp) and equal the quote's exact
 *     GHS amount — no tolerance
 *   * returned payer, when present, must match the payer the local
 *     initiation contract made authoritative
 *   * final txstatus is the lifecycle authority (0=Pending, 1=Success, 2=Failed)
 *   * any mismatch is contradictory evidence — quarantined via
 *     ReconciliationException, nothing settles, the deposit stays PENDING
 */
const logger = require('../../src/config/logger');
const fiatLiquidity = require('./fiatLiquidityService');
const settlementCore = require('./moolreDepositSettlement');
const { getPersistedTransactionQuoteExact } = require('./transactionQuoteService');
const { recordReconciliationException } = require('../../services/reconciliationExceptionService');

const TX_STATUS = { PENDING: 0, SUCCESS: 1, FAILED: 2 };

class ContradictoryStatusEvidenceError extends Error {
    constructor(message, details) {
        super(message);
        this.name = 'ContradictoryStatusEvidenceError';
        this.code = 'CONTRADICTORY_PROVIDER_EVIDENCE';
        this.details = details;
    }
}

/** Normalize MSISDNs for comparison (233… and 0… forms are equivalent). */
function msisdnDigits(value) {
    const digits = String(value ?? '').replace(/\D/g, '');
    if (digits.startsWith('233') && digits.length === 12) return '0' + digits.slice(3);
    return digits;
}

/** Record the contradiction durably and fail closed — the deposit stays PENDING. */
async function quarantineContradiction(prisma, { deposit, statusData, reason, details }) {
    try {
        await recordReconciliationException(prisma, {
            entityType: 'TRANSACTION',
            entityId: deposit.txHash,
            reference: deposit.txHash,
            reason: 'CONTRADICTORY_PROVIDER_EVIDENCE',
            details: {
                surface: 'MOOLRE_STATUS_QUERY',
                reason,
                provider: 'MOOLRE',
                requestedExternalRef: deposit.txHash,
                ...details,
                observed: statusData ?? null,
            },
        });
    } catch (err) {
        // The quarantine WRITE failed — the contradiction must still be
        // surfaced loudly; the caller retries and the write is retried with
        // it. Never swallow: the typed error below still fails the recovery.
        logger.error({ err, reference: deposit.txHash, reason },
            '[moolreCollectionRecovery] CONTRADICTION QUARANTINE WRITE FAILED — retrying the recovery re-attempts it');
        throw new ContradictoryStatusEvidenceError(
            `Provider status contradicts the local contract (${reason}); the contradiction could not yet be quarantined — the deposit stays pending and the quarantine write is retried on the next recovery pass.`,
            { reason, quarantineWriteFailed: true },
        );
    }
    throw new ContradictoryStatusEvidenceError(
        `Provider status contradicts the local contract (${reason}) — quarantined for reconciliation; the deposit stays pending and nothing settles.`,
        { reason },
    );
}

/**
 * Resolve ONE pending Moolre-collection deposit by querying the provider's
 * status endpoint under the SAME durable external reference.
 *
 * @returns {Promise<{outcome: string, deposit?: object, result?: object}>}
 *   outcome ∈ SETTLED | ALREADY_SETTLED | FAILED | ALREADY_FAILED |
 *             STILL_PENDING | STATUS_UNAVAILABLE | CONCURRENTLY_RESOLVED
 */
async function resolvePendingDeposit({ prisma, moolre, transactionHistoryId }) {
    const deposit = await prisma.transactionHistory.findUnique({ where: { id: transactionHistoryId } });
    if (!deposit) throw new Error(`[moolreCollectionRecovery] unknown deposit ${transactionHistoryId}`);
    if (deposit.type !== 'DEPOSIT_FIAT') {
        throw new Error(`[moolreCollectionRecovery] ${transactionHistoryId} is ${deposit.type}, not a deposit`);
    }
    if (deposit.status !== 'PENDING') {
        return { outcome: deposit.status === 'COMPLETED' ? 'ALREADY_SETTLED' : `ALREADY_${deposit.status}` };
    }
    const meta = deposit.metadata || {};
    if (!meta.quoteId) {
        throw new Error(`[moolreCollectionRecovery] deposit ${transactionHistoryId} has no bound quote`);
    }

    // The quote is the local amount/route authority for the validation below.
    let quote;
    try {
        quote = await getPersistedTransactionQuoteExact({ prisma, quoteId: meta.quoteId });
    } catch (quoteErr) {
        // A missing/unreadable quote cannot validate the provider's answer —
        // fail closed, keep pending, surface for ops.
        logger.error({ err: quoteErr, reference: deposit.txHash }, '[moolreCollectionRecovery] quote authority unavailable');
        return { outcome: 'STATUS_UNAVAILABLE', reason: 'quote-unavailable' };
    }
    if (quote.selectedRoute && quote.selectedRoute !== 'MOOLRE_MOMO_COLLECTION') {
        // Only the Moolre collection surface is recoverable here — other
        // routes own different provider evidence identities.
        return { outcome: 'NOT_MOOLRE_SURFACE', reason: quote.selectedRoute };
    }

    let statusData;
    try {
        statusData = await moolre.getPaymentStatus({ externalRef: deposit.txHash });
    } catch (err) {
        // Status lookup itself uncertain → the outcome stays UNRESOLVED
        // (never failed). The reference stays the single authority.
        logger.warn({ err, reference: deposit.txHash },
            '[moolreCollectionRecovery] status lookup unavailable — deposit stays pending');
        return { outcome: 'STATUS_UNAVAILABLE' };
    }

    // ── Authority validation BEFORE any lifecycle mutation ─────────────────
    const observedRef = statusData?.externalref ?? statusData?.externalRef ?? null;
    if (observedRef == null || String(observedRef) !== String(deposit.txHash)) {
        return quarantineContradiction(prisma, {
            deposit, statusData,
            reason: 'status response for a different reference',
            details: { observedExternalRef: observedRef == null ? null : String(observedRef) },
        });
    }
    let observedAmount;
    try {
        observedAmount = fiatLiquidity.toExactGhsDecimal(statusData?.amount, { field: 'amount' });
    } catch (e) {
        return quarantineContradiction(prisma, {
            deposit, statusData,
            reason: 'unparseable status amount',
            details: { observedAmount: statusData?.amount ?? null },
        });
    }
    const { Prisma } = require('@prisma/client');
    const quotedGhs = quote.amountGhsExact ?? String(quote.amountGhs);
    const quotedGhsDec = new Prisma.Decimal(quotedGhs);
    if (observedAmount.toFixed(2) !== quotedGhsDec.toFixed(2)) {
        return quarantineContradiction(prisma, {
            deposit, statusData,
            reason: 'status amount does not equal the quoted GHS',
            details: { observedAmount: observedAmount.toFixed(2), quotedGhs: quotedGhsDec.toFixed(2) },
        });
    }
    // Payer identity: the initiation contract made the requested payer phone
    // authoritative — validate when the status response carries one.
    const observedPayer = statusData?.payer ?? null;
    if (observedPayer != null && meta.payerPhone
        && msisdnDigits(observedPayer) !== msisdnDigits(meta.payerPhone)) {
        return quarantineContradiction(prisma, {
            deposit, statusData,
            reason: 'status payer does not match the initiation payer',
            details: { observedPayer: String(observedPayer), requestedPayer: String(meta.payerPhone) },
        });
    }

    const txstatus = Number(statusData?.txstatus);

    // ── SUCCESS → settle ONCE through the shared core ──────────────────────
    if (txstatus === TX_STATUS.SUCCESS) {
        // The SAME durable evidence identity as the mounted webhook
        // (event:moolre-collection:<ref>): a callback racing this query
        // converges on one observation; materially different observations
        // fail closed as contradictory evidence. The status payload
        // (transactionid, thirdpartyref, txstatus) is retained in raw.
        const { event: providerEvent } = await fiatLiquidity.recordProviderEvent(prisma, {
            provider: 'MOOLRE',
            direction: 'INBOUND',
            status: 'SUCCESSFUL',
            providerRef: deposit.providerRef ?? null,
            dedupKey: `event:moolre-collection:${deposit.txHash}`,
            amountGhs: observedAmount,
            relatedReference: deposit.txHash,
            raw: { source: 'STATUS_QUERY', ...statusData },
        });
        const settlementProviderRef = await settlementCore.reconcileSettlementProviderRef(prisma, {
            deposit, providerEvent,
        });
        try {
            const result = await settlementCore.settleMoolreDeposit(prisma, {
                deposit,
                quoteId: meta.quoteId,
                settledGhs: observedAmount,
                providerEvent,
                settlementProviderRef,
                payerMsisdn: observedPayer,
                providerData: { source: 'STATUS_QUERY', ...statusData },
                evidenceSource: 'moolre_status_query',
            });
            return { outcome: 'SETTLED', result };
        } catch (settleErr) {
            const now = await prisma.transactionHistory.findUnique({
                where: { id: deposit.id }, select: { status: true },
            });
            if (now?.status === 'COMPLETED') return { outcome: 'ALREADY_SETTLED' };
            if (now?.status === 'FAILED') return { outcome: 'CONCURRENTLY_FAILED' };
            throw settleErr; // genuinely unresolved — surface for ops
        }
    }

    // ── FAILED → terminal transition ONCE via database CAS ──────────────────
    if (txstatus === TX_STATUS.FAILED) {
        // Distinct evidence identity from SUCCESS observations: a provider
        // failure event can never collide with a later success observation.
        await fiatLiquidity.recordProviderEvent(prisma, {
            provider: 'MOOLRE',
            direction: 'INBOUND',
            status: 'FAILED',
            providerRef: deposit.providerRef ?? null,
            dedupKey: `event:moolre-status:${deposit.txHash}:FAILED`,
            amountGhs: observedAmount,
            relatedReference: deposit.txHash,
            raw: { source: 'STATUS_QUERY', ...statusData },
        });
        const failed = await prisma.transactionHistory.updateMany({
            where: { id: deposit.id, status: 'PENDING' },
            data: { status: 'FAILED' },
        });
        return { outcome: failed.count === 1 ? 'FAILED' : 'ALREADY_RESOLVED' };
    }

    // PENDING (or any non-final status) → stay pending, no mutation.
    return { outcome: 'STILL_PENDING' };
}

module.exports = {
    resolvePendingDeposit,
    ContradictoryStatusEvidenceError,
};
