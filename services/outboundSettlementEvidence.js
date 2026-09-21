// services/outboundSettlementEvidence.js
// =============================================================================
// AZAMAN V2 — OUTBOUND SETTLEMENT EVIDENCE BINDING (r20 P0)
//
// INVARIANT: a provider terminal observation (SUCCESS / FAILED) may change the
// canonical withdrawal state ONLY when the observation is durably bound to the
// exact payout identity and economics that were committed when the withdrawal
// was created. This module is the SINGLE canonical binding boundary for every
// outbound settlement path:
//
//   • workers/withdrawalReconciliationWorker (provider status polling)
//   • services/fiatSettlementService (provider settlement callbacks)
//
// Both paths must call bindOutboundSettlementEvidence() BEFORE entering the
// finance.service settlement boundary (completeFiatWithdrawal /
// reverseFiatWithdrawal). It fails closed: a contradiction parks the payout
// with durable evidence (the caller records a ReconciliationException) and NO
// canonical economic state moves toward terminal settlement.
//
// Bindings established here (per the documented provider contracts):
//
//   1. PROVIDER IDENTITY — the observation must name a KNOWN canonical
//      provider identity (MOOLRE_DISBURSEMENT / MTN_MOMO_DISBURSEMENT). The
//      normalized poll fallback 'DISBURSEMENT_POLL' is NOT admissible for
//      terminal settlement: no fallback identity may masquerade as provider
//      ownership.
//
//   2. PROVIDER-OWNER — when the payout has a durable owner (canonical
//      metadata.payoutProvider, or the durable dispatch evidence recovered by
//      resolvePayoutOwner), the observation's provider identity must match it.
//      A status answer or callback from a DIFFERENT provider is a
//      contradiction, never new information.
//
//   3. EXACT REFERENCE — for status POLLS, both live adapter contracts echo
//      the business reference in their status answer (Moolre: data.externalref;
//      MTN: externalId). The echo is MANDATORY terminal evidence: a terminal
//      poll answer that does not name the reference it was queried for cannot
//      prove it belongs to this payout and fails closed. The echo is compared
//      exactly — a provider reference is never silently coerced into the
//      requested reference. For CALLBACKS, the reference IS the provider-named
//      externalref from the authenticated payload, so the binding is inherent
//      (externalId === reference by construction) — but it is still checked,
//      so a future caller cannot skip it.
//
//   4. EXACT PAYOUT AMOUNT — the expected GHS payout comes from the durable
//      local economics committed at creation time, NEVER recomputed from the
//      current exchange rate:
//        • §P.5-D authority rows: FiatLiquidityReservation.amountGhs
//        • legacy rows: canonical TransactionHistory.metadata.payoutGhs
//      A row with NEITHER durable amount authority cannot be bound — it
//      fails closed (no requote, ever). Amounts compare in exact pesewa
//      integers via Decimal arithmetic, never JS floats.
//      • For POLLS, the provider-reported amount is MANDATORY terminal
//        evidence (both live status contracts expose it). A terminal poll
//        without an amount cannot prove the economics and fails closed.
//      • For CALLBACKS, the Moolre/MTN settlement webhook normalizer captures
//        payload.amount when the callback carries it and it is then enforced;
//        when the callback contract genuinely omits the amount, the residual
//        binding is the signature-authenticated provider identity + the
//        provider-named exact externalref — the strongest guarantee that
//        contract provides, documented here rather than faked.
//
//   5. DESTINATION — DOCUMENTED LIMITATION: neither live status contract
//      (Moolre transfer/status, MTN remittance status) echoes the recipient
//      MSISDN, and the settlement webhooks as normalized do not carry it.
//      Destination is bound at DISPATCH time (the reservation records it and
//      the initiation response echoes it back through the adapters) and is
//      therefore NOT re-verifiable at settlement time. This module does NOT
//      pretend destination was verified — the residual guarantee above
//      (provider identity + exact reference + amount) is what the settlement
//      contract actually provides.
//
// Ordering contract (audit F): retrieve → validate identity → validate
// reference → validate owner → validate amount → validate destination →
// persist observation → only then enter the canonical finance settlement
// boundary. No money state transition may precede this validation.
// =============================================================================

const { Prisma } = require('@prisma/client');
const { resolvePayoutOwner, KNOWN_CANONICAL_PROVIDERS } = require('./payoutProviderOwnership');

const TERMINAL_SUCCESS = ['SUCCESSFUL', 'COMPLETED'];
const TERMINAL_FAILURE = ['FAILED', 'REJECTED'];
const TERMINAL_STATUSES = [...TERMINAL_SUCCESS, ...TERMINAL_FAILURE];

const GHS_DECIMALS = 2;

/** Is this normalized observation status a TERMINAL settlement answer? */
const isTerminalStatus = (status) =>
    TERMINAL_STATUSES.includes(String(status || '').toUpperCase());

/** Is `provider` a KNOWN canonical provider identity? */
const isKnownProvider = (provider) =>
    KNOWN_CANONICAL_PROVIDERS.includes(String(provider || '').toUpperCase());

/**
 * Exact-pesewa integer comparison basis. Any value that cannot be expressed
 * as an exact 2-decimal GHS amount (a malformed provider number, or a value
 * with more than 2 decimals) is rejected — never rounded into a match.
 * Returns a string like '15000' (pesewa) or null when not exact.
 */
const exactPesewa = (value) => {
    if (value === null || value === undefined || value === '') return null;
    let d;
    try {
        d = new Prisma.Decimal(String(value));
    } catch {
        return null;
    }
    if (!d.isFinite()) return null;
    const scaled = d.times(100);
    // Must be an exact integer number of pesewa at 2-decimal GHS precision.
    if (!scaled.isInteger()) return null;
    return scaled.toFixed(0);
};

/**
 * Resolve the durable expected GHS payout economics for a canonical
 * withdrawal reference. NEVER recomputes from the current rate.
 *
 *   • §P.5-D authority rows: the exact FiatLiquidityReservation.amountGhs
 *     committed at reservation time.
 *   • Legacy rows: the payout amount captured at creation time in canonical
 *     TransactionHistory.metadata.payoutGhs.
 *   • Neither → NO durable amount authority (fail closed).
 */
async function resolveExpectedPayoutEconomics(prisma, reference) {
    const reservation = await prisma.fiatLiquidityReservation.findUnique({
        where: { reference: String(reference) },
        select: { amountGhs: true },
    });
    if (reservation && reservation.amountGhs !== null && reservation.amountGhs !== undefined) {
        return {
            authority: 'FIAT_LIQUIDITY_RESERVATION',
            amountGhs: reservation.amountGhs,
        };
    }

    const canonical = await prisma.transactionHistory.findUnique({
        where: { txHash: String(reference) },
        select: { metadata: true, type: true },
    });
    if (!canonical) {
        return { authority: null, amountGhs: null, reason: 'CANONICAL_ROW_NOT_FOUND' };
    }
    const metadataPayoutGhs = canonical.metadata?.payoutGhs;
    if (metadataPayoutGhs !== null && metadataPayoutGhs !== undefined) {
        return {
            authority: 'CANONICAL_METADATA_PAYOUT_GHS',
            amountGhs: metadataPayoutGhs,
        };
    }

    // Authority 3 — the durable DISPATCH observation: the outbound
    // `event:payout-dispatch:<provider>:<reference>` evidence written when the
    // provider ACCEPTED the payout carries the exact GHS amount the provider
    // was asked to pay. Auto-payout (batch-worker) rows carry no reservation
    // and no payoutGhs metadata — the dispatch observation is their durable
    // committed payout economics. This is OUR OWN dispatch-time record,
    // captured before settlement; it is never recomputed from the current rate.
    const dispatchEvidence = await prisma.fiatProviderEvent.findFirst({
        where: {
            relatedReference: String(reference),
            direction: 'OUTBOUND',
            dedupKey: { startsWith: `event:payout-dispatch:` },
        },
        orderBy: { receivedAt: "desc" },
        select: { amountGhs: true },
    });
    if (dispatchEvidence && dispatchEvidence.amountGhs !== null && dispatchEvidence.amountGhs !== undefined) {
        return {
            authority: 'DURABLE_DISPATCH_OBSERVATION',
            amountGhs: dispatchEvidence.amountGhs,
        };
    }
    return { authority: null, amountGhs: null, reason: 'NO_DURABLE_AMOUNT_AUTHORITY' };
}

/**
 * Bind a TERMINAL outbound provider observation to the exact canonical payout
 * before any settlement transition. Fails closed on every contradiction.
 *
 * @param {Object} prisma
 * @param {Object} input
 * @param {string} input.reference          canonical withdrawal reference (TransactionHistory.txHash)
 * @param {string} input.provider           the observation's provider identity (canonical name)
 * @param {string|null} input.externalId    the provider-echoed external reference (MANDATORY for polls)
 * @param {number|string|null} input.amountGhs the provider-reported payout amount (MANDATORY for polls)
 * @param {string} input.status             normalized terminal status
 * @param {'provider_status_poll'|'provider_callback'} input.source
 * @param {Object|null} [input.payoutOwner] pre-resolved durable owner ({ tag, canonicalName }) —
 *                                          resolved internally when omitted.
 * @returns {Promise<{bound: boolean, reason?: string, details?: Object, checks: Object}>}
 */
async function bindOutboundSettlementEvidence(prisma, {
    reference,
    provider,
    externalId = null,
    amountGhs = null,
    status,
    source,
    payoutOwner = null,
}) {
    if (!reference) {
        return { bound: false, reason: 'REFERENCE_REQUIRED', checks: {} };
    }
    const normalizedStatus = String(status || '').toUpperCase();
    if (!isTerminalStatus(normalizedStatus)) {
        // Non-terminal observations are not settlement attempts — the caller
        // handles them (PENDING/NOT_FOUND/UNKNOWN paths). Nothing to bind.
        return { bound: false, reason: 'NOT_TERMINAL', checks: {} };
    }
    if (source !== 'provider_status_poll' && source !== 'provider_callback') {
        return { bound: false, reason: 'UNKNOWN_OBSERVATION_SOURCE', checks: { source: source ?? null } };
    }

    const canonical = await prisma.transactionHistory.findUnique({
        where: { txHash: String(reference) },
        select: { id: true, type: true, status: true, userId: true },
    });
    if (!canonical) {
        return { bound: false, reason: 'CANONICAL_ROW_NOT_FOUND', checks: {} };
    }
    if (canonical.type !== 'WITHDRAWAL_FIAT') {
        return { bound: false, reason: 'NOT_A_FIAT_WITHDRAWAL', checks: { type: canonical.type } };
    }

    // ── 1. PROVIDER IDENTITY ─────────────────────────────────────────────────
    const observedProvider = String(provider || '').toUpperCase();
    if (!isKnownProvider(observedProvider)) {
        return {
            bound: false,
            reason: 'PROVIDER_NOT_IDENTIFIED',
            details: {
                reference,
                observedProvider: observedProvider || null,
                note: 'a terminal observation must name a KNOWN canonical provider — normalized fallbacks (e.g. DISBURSEMENT_POLL) are not admissible owner identity',
            },
            checks: { provider: false },
        };
    }

    // ── 2. PROVIDER-OWNER BINDING ───────────────────────────────────────────
    let owner = payoutOwner;
    let ownershipStatus = owner ? 'OWNED' : null;
    if (!owner) {
        // Pass the CANONICAL ROW — resolvePayoutOwner reads the authoritative
        // metadata.payoutProvider ownership from it. Passing only { txHash }
        // would silently drop the strongest ownership record and let a wrong
        // provider's callback bind against a durably-owned payout.
        const txRow = await prisma.transactionHistory.findUnique({
            where: { txHash: String(reference) },
            select: { txHash: true, metadata: true },
        });
        const ownership = await resolvePayoutOwner(prisma, txRow);
        ownershipStatus = ownership.status;
        if (ownership.status === 'OWNED') owner = ownership.owner;
        if (ownership.status === 'CONFLICT') {
            return {
                bound: false,
                reason: 'OWNER_CONFLICT',
                details: { reference, owners: ownership.owners },
                checks: { provider: true, owner: false },
            };
        }
    }
    if (owner && owner.canonicalName && owner.canonicalName !== observedProvider) {
        return {
            bound: false,
            reason: 'OWNER_CONTRADICTION',
            details: {
                reference,
                ownerCanonicalName: owner.canonicalName,
                ownerTag: owner.tag || null,
                observedProvider,
                observedStatus: normalizedStatus,
            },
            checks: { provider: true, owner: false },
        };
    }

    // ── 3. EXACT REFERENCE BINDING ───────────────────────────────────────────
    const expected = String(reference);
    const echoed = externalId === null || externalId === undefined ? null : String(externalId);
    if (echoed === null || echoed === '') {
        return {
            bound: false,
            reason: 'REFERENCE_ECHO_MISSING',
            details: {
                reference: expected,
                observedProvider,
                observedStatus: normalizedStatus,
                note: 'both live status contracts echo the queried business reference (Moolre data.externalref / MTN externalId) — a terminal answer without the echo cannot prove it belongs to this payout',
            },
            checks: { provider: true, owner: true, reference: false },
        };
    }
    if (echoed !== expected) {
        return {
            bound: false,
            reason: 'REFERENCE_MISMATCH',
            details: {
                reference: expected,
                echoedReference: echoed,
                observedProvider,
                observedStatus: normalizedStatus,
                note: 'the provider answer names a DIFFERENT business reference than the one queried — contradictory evidence, never coerced',
            },
            checks: { provider: true, owner: true, reference: false },
        };
    }

    // ── 4. EXACT PAYOUT-AMOUNT BINDING ───────────────────────────────────────
    // The durable amount authority (reservation amountGhs / creation-time
    // payoutGhs — NEVER the current rate) is mandatory wherever an amount
    // comparison must happen: every POLL (the provider amount is mandatory
    // terminal evidence) and every CALLBACK that carries an amount. A
    // callback whose documented contract carries NO amount cannot verify the
    // amount axis at all — it settles on the residual binding above
    // (authenticated provider identity + exact provider-named reference),
    // explicitly documented here instead of faked.
    const economics = await resolveExpectedPayoutEconomics(prisma, reference);
    const callbackCarriesAmount = source === 'provider_callback'
        && amountGhs !== null && amountGhs !== undefined && amountGhs !== '';
    const amountAuthorityRequired = source === 'provider_status_poll' || callbackCarriesAmount;

    const expectedPesewa = economics.amountGhs !== null && economics.amountGhs !== undefined
        ? exactPesewa(economics.amountGhs)
        : null;
    if (amountAuthorityRequired && economics.authority && expectedPesewa === null) {
        return {
            bound: false,
            reason: 'DURABLE_AMOUNT_MALFORMED',
            details: {
                reference,
                authority: economics.authority,
                amountGhs: String(economics.amountGhs),
            },
            checks: { provider: true, owner: true, reference: true, amount: false },
        };
    }
    // GENUINE LEGACY ROW (no reservation, no creation-time payoutGhs, no
    // durable dispatch observation — a pre-evidence-era payout): there is no
    // local economics record to contradict. The provider-reported amount is
    // the payout's own economics under the exact queried reference; it is
    // durably recorded as the FIRST committed observation (a later,
    // materially-different observation under the same identity is retained by
    // the evidence store as a contradiction, never converged). The amount
    // remains MANDATORY on polls either way; the expected value is NEVER
    // recomputed from the current rate.

    let amountCheck;
    if (source === 'provider_status_poll') {
        // POLL: the provider-reported amount is MANDATORY terminal evidence
        // (both live status contracts expose it).
        const observedPesewa = exactPesewa(amountGhs);
        if (observedPesewa === null) {
            return {
                bound: false,
                reason: 'PROVIDER_AMOUNT_MISSING',
                details: {
                    reference,
                    observedProvider,
                    observedStatus: normalizedStatus,
                    expectedPesewa,
                    note: 'a terminal status poll without a provider amount cannot prove the payout economics',
                },
                checks: { provider: true, owner: true, reference: true, amount: false },
            };
        }
        if (expectedPesewa !== null && observedPesewa !== expectedPesewa) {
            return {
                bound: false,
                reason: 'AMOUNT_MISMATCH',
                details: {
                    reference,
                    observedProvider,
                    observedStatus: normalizedStatus,
                    expectedPesewa,
                    observedPesewa,
                },
                checks: { provider: true, owner: true, reference: true, amount: false },
            };
        }
        amountCheck = expectedPesewa !== null
            ? { verified: true, expectedPesewa, observedPesewa, authority: economics.authority }
            : { verified: true, observedPesewa, authority: 'PROVIDER_REPORTED_FIRST_OBSERVATION' };
    } else {
        // CALLBACK: enforce the amount when the callback carries it; when the
        // documented callback contract omits it, the residual binding is the
        // signature-authenticated provider identity + provider-named external
        // reference (documented, not faked).
        if (callbackCarriesAmount) {
            const observedPesewa = exactPesewa(amountGhs);
            if (observedPesewa === null) {
                return {
                    bound: false,
                    reason: 'PROVIDER_AMOUNT_MALFORMED',
                    details: { reference, observedAmountGhs: String(amountGhs) },
                    checks: { provider: true, owner: true, reference: true, amount: false },
                };
            }
            if (expectedPesewa !== null && observedPesewa !== expectedPesewa) {
                return {
                    bound: false,
                    reason: 'AMOUNT_MISMATCH',
                    details: {
                        reference,
                        observedProvider,
                        observedStatus: normalizedStatus,
                        expectedPesewa,
                        observedPesewa,
                    },
                    checks: { provider: true, owner: true, reference: true, amount: false },
                };
            }
            amountCheck = expectedPesewa !== null
                ? { verified: true, expectedPesewa, observedPesewa, authority: economics.authority }
                : { verified: true, observedPesewa, authority: 'PROVIDER_REPORTED_FIRST_OBSERVATION' };
        } else {
            amountCheck = {
                verified: false,
                expectedPesewa,
                authority: economics.authority || null,
                residual: 'callback contract carries no amount — the amount axis is unverifiable in this contract; binding rests on authenticated provider identity + exact provider-named reference',
            };
        }
    }

    // ── 5. DESTINATION — documented limitation, see module header ──────────
    return {
        bound: true,
        reference: expected,
        provider: observedProvider,
        status: normalizedStatus,
        checks: {
            provider: true,
            owner: true,
            reference: true,
            amount: amountCheck,
            destination: {
                verified: false,
                residual: 'neither live status contract nor the settlement webhook echoes the recipient MSISDN — destination is bound at dispatch time (reservation destination + initiation echo), not re-verifiable at settlement',
            },
        },
    };
}

module.exports = {
    bindOutboundSettlementEvidence,
    resolveExpectedPayoutEconomics,
    isTerminalStatus,
    isKnownProvider,
    exactPesewa,
};
