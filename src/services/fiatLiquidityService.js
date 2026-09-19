// =============================================================================
// AZAMAN — §P.5-D EVIDENCE-BACKED GHS LIQUIDITY AUTHORITY
//
// docs/p5d-ghs-liquidity-authority.md is the design authority for this module.
//
// SystemFiatPool was a scalar treated as if it proved available GHS cash. It
// proved nothing: nothing on the inbound side ever created evidence, and the
// balance moved by internal scalar arithmetic alone. This service is the
// replacement authority:
//
//   FiatProviderEvent      append-only raw provider evidence (never rewritten)
//   FiatLiquidityReceipt   inbound GHS: RECEIVED → AVAILABLE | UNMATCHED | …
//   FiatLiquidityReservation outbound GHS: RESERVED → IN_TRANSIT → PAID_OUT | RELEASED
//   FiatLiquidityState     claimable aggregate (guarded conditional updates only)
//
// Core rules (all fail-closed, all real-PG proven in
// __tests__/p5d-fiat-liquidity-authority.test.js):
//
//   1. ONLY evidence creates AVAILABLE liquidity — and the service VERIFIES
//      the evidence chain itself; it never trusts a caller's say-so:
//        recordReceipt (matched deposit) requires a durable INBOUND
//        FiatProviderEvent whose provider/status/amount/reference identity
//        matches the settled TransactionHistory deposit row and its consumed
//        P5-C quote exactly (docs §3.1).
//        An UNMATCHED receipt becomes AVAILABLE only through
//        confirmReconciliationMatch — which verifies the same durable chain.
//        An audited treasury opening (RECEIVED) becomes AVAILABLE only through
//        confirmTreasuryOpening — which requires a durable external GHS
//        funding observation. An internal USDC operation (liquidateProfits)
//        can NEVER unlock spendable GHS by itself.
//   2. Reservation is a single-winner conditional decrement
//      (availableGhs >= amount); losers fail closed with the legacy
//      FIAT_POOL_INSUFFICIENT contract preserved for API compatibility.
//   3. Every receipt/reservation/terminal transition has a durable economic
//      identity; replays converge to the committed result; conflicting reuse
//      fails closed with the evidence retained.
//   4. Contradictory provider evidence is preserved and quarantined
//      (RECONCILIATION_REQUIRED + ReconciliationException), never rewritten,
//      never auto-repaired, never auto-released. Quarantined funds move into
//      the reconciliationHeldGhs bucket: counted, NEVER spendable — including
//      the released-then-contradicted case, where the previously returned
//      amount is removed from spendable availability and held.
//   5. GHS amounts are exact Decimal(20,2) (pesewas). Amounts with sub-pesewa
//      precision are rejected — the authority never guesses a rounding.
//   6. SystemFiatPool is a derived projection: every authority transition
//      syncs pool.balance := state.availableGhs inside the same transaction.
//      No other writer may mutate it.
//
// P4 boundary: this service records GHS liquidity truth only. It never posts
// customer liability, never touches restricted obligations, never realizes
// economics, never balances GHS against USDC.
//
// Provider adapters (Moolre/MTN) stay external I/O: they return provider
// evidence; this module owns durable state and atomic financial transitions.
// =============================================================================

const { Prisma } = require('@prisma/client');
const crypto = require('crypto');
const logger = require('../config/logger');
const { recordReconciliationException } = require('../../services/reconciliationExceptionService');

const LIQUIDITY_INSUFFICIENT_CODE = 'FIAT_POOL_INSUFFICIENT';

// ─── errors ────────────────────────────────────────────────────────────────

class LiquidityInsufficientError extends Error {
    constructor() {
        super(
            'MoMo payouts are temporarily at capacity. Your USDC has not been deducted. ' +
            'Please try again in a few minutes or contact support.'
        );
        this.code = LIQUIDITY_INSUFFICIENT_CODE;
    }
}

class ConflictingEvidenceError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.code = 'LIQUIDITY_CONFLICTING_EVIDENCE';
        this.details = details;
    }
}

class InvalidEvidenceError extends Error {
    constructor(message) {
        super(message);
        this.code = 'LIQUIDITY_INVALID_EVIDENCE';
    }
}

// The authority refuses to manufacture GHS availability from a non-GHS event.
class GhsEvidenceRequiredError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.code = 'FIAT_LIQUIDITY_REQUIRES_GHS_EVIDENCE';
        this.details = details;
    }
}

// ─── exact GHS decimals ─────────────────────────────────────────────────────

// GHS has exactly 2 fractional digits (pesewas). Evidence or amounts carrying
// sub-pesewa precision are rejected — the authority never rounds silently.
const GHS_DP = 2;

function toExactGhsDecimal(value, { field = 'amountGhs' } = {}) {
    let d;
    try {
        d = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(String(value));
    } catch {
        throw new InvalidEvidenceError(`[${field}] not a finite decimal: ${String(value)}`);
    }
    if (!d.isFinite() || d.lte(0)) {
        throw new InvalidEvidenceError(`[${field}] must be a positive decimal: ${String(value)}`);
    }
    if (d.decimalPlaces() > GHS_DP) {
        throw new InvalidEvidenceError(
            `[${field}] carries sub-pesewa precision: ${String(value)} — the liquidity authority never rounds silently`
        );
    }
    return d;
}

// ─── flag ───────────────────────────────────────────────────────────────────

const isAuthorityEnabled = async (prisma) => {
    const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
    return settings?.fiatLiquidityAuthorityEnabled === true;
};

// ─── provider-observation identity (docs §3.3) ───────────────────────────────
//
// ONE dedupKey names ONE provider observation. The identity of an observation
// is its SEMANTIC authority fields — never its transport payload:
//   provider, rail, direction, status, providerRef, amountGhs, relatedReference
// `raw` is deliberately NOT identity: providers retry the same economic
// observation with byte-different payloads (timestamps, ordering, extra
// fields), and byte-comparison would manufacture contradictions out of
// retries. Replay therefore converges ONLY when the semantic fields match;
// a materially different observation under an already-committed identity is
// contradictory evidence — retained as a DISTINCT durable row under a
// deterministic conflict identity (so exact retries of the contradictory
// payload converge too) and surfaced with a typed fail-closed error. It is
// NEVER silently absorbed, NEVER rewritten over the committed row.
const OBSERVATION_SEMANTIC_FIELDS = ['provider', 'rail', 'direction', 'status', 'providerRef', 'amountGhs', 'relatedReference'];

// ── providerRef identity binding (audit r10, Finding 3) ─────────────────────
// A PRESENT provider reference binds STRICTLY: two non-null refs that differ
// are materially different observations (contradiction). An ABSENT reference
// carries NO claim: it neither contradicts a committed reference nor blocks
// convergence. This is the project's established providerRef semantics — the
// receipt/event checks below compare refs only when BOTH are non-null, and
// markReservationInTransit explicitly FILLS an absent reservation ref with an
// incoming one (enrichment, never a conflict). Producers of optional refs are
// real: the generic deposit webhook's providerTxId has never been a required
// field (stored as `providerTxId || null` enrichment on both lifecycle
// paths), and payout callbacks legitimately arrive before the provider's
// durable txid exists. So:
//   committed null  + incoming ref    → CONVERGE, and the committed row is
//                                       ENRICHED with the observed ref
//                                       (strictly additive durable evidence;
//                                       committed semantic claims are never
//                                       changed — receivedAt, status, amount
//                                       stay exactly as committed). The
//                                       enrichment claim is a database-
//                                       enforced compare-and-set on the NULL
//                                       slot (audit r11): under concurrency,
//                                       exactly ONE different present ref can
//                                       ever win — the loser converges only
//                                       onto the winner's ref, or is rejected
//                                       as contradictory evidence
//   committed ref   + incoming null   → CONVERGE (the retry simply carries
//                                       less detail; the committed ref is
//                                       never downgraded)
//   committed ref   + different ref   → CONTRADICTION (unchanged — binding is
//                                       NOT weakened for present refs)
const providerRefClaimsDiffer = (a, b) =>
    a.providerRef != null && b.providerRef != null && a.providerRef !== b.providerRef;

const observationSemantics = ({
    provider, rail = null, direction, status, providerRef = null, amountGhs = null, relatedReference = null,
}) => ({
    provider: String(provider),
    rail: rail == null ? null : String(rail),
    direction: String(direction),
    status: String(status),
    providerRef: providerRef == null ? null : String(providerRef),
    amountGhs: amountGhs == null ? null : new Prisma.Decimal(String(amountGhs)).toFixed(GHS_DP),
    relatedReference: relatedReference == null ? null : String(relatedReference),
});

const observationSemanticsMatch = (a, b) =>
    OBSERVATION_SEMANTIC_FIELDS.every((f) =>
        f === 'providerRef' ? !providerRefClaimsDiffer(a, b) : (a[f] ?? null) === (b[f] ?? null));

// Material-difference reporting follows the adopted contract (audit r10/r11):
// a null-vs-present providerRef difference is legitimate enrichment, NOT a
// contradiction — it must never be reported as a differing field alongside a
// real contradiction. providerRef is listed only when both sides are PRESENT
// and different. All other semantic fields compare exactly as before.
const observationSemanticDiffs = (a, b) =>
    OBSERVATION_SEMANTIC_FIELDS.filter((f) =>
        f === 'providerRef' ? providerRefClaimsDiffer(a, b) : (a[f] ?? null) !== (b[f] ?? null));

// Deterministic conflict identity for a contradictory observation: derived
// ONLY from the semantic fields of the incoming payload, so the same
// contradictory observation retried converges to the same conflict row.
const conflictingObservationDedupKey = (dedupKey, semantics) => {
    const canonical = OBSERVATION_SEMANTIC_FIELDS
        .map((f) => (semantics[f] ?? '\\0'))
        .join('\\u{1F}');
    const fingerprint = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
    return `${dedupKey}:CONFLICT:${fingerprint}`;
};

// ── concurrency-safe null→present enrichment (audit r11) ────────────────────
// Enrichment is a database-enforced COMPARE-AND-SET on the NULL slot: the
// WHERE clause `providerRef: null` means exactly ONE concurrent caller can
// ever claim it. An unconditional update() here would be last-writer-wins —
// two concurrent retries carrying DIFFERENT present refs would each see NULL,
// each overwrite, and the durable identity would depend on timing. Instead:
//   * claim.count === 1 → this caller performed the unique enrichment;
//   * claim.count === 0 → re-read the AUTHORITATIVE row:
//       - same ref as ours           → converge (the winner wrote our ref);
//       - still unexpectedly NULL    → replay untouched — never blindly
//                                      overwrite (the concurrent claim may
//                                      have rolled back; a later legitimate
//                                      retry can still enrich);
//       - a DIFFERENT present ref    → CONTRADICTION under the strict
//                                      present→different-present rule — the
//                                      conflicting observation is retained
//                                      under its deterministic conflict
//                                      identity and the call fails closed.
async function enrichProviderRefObservation(prisma, existing, incomingProviderRef, failClosedOnConflict) {
    const incomingRef = String(incomingProviderRef);
    const claimed = await prisma.fiatProviderEvent.updateMany({
        where: { id: existing.id, providerRef: null },
        data: { providerRef: incomingRef },
    });
    if (claimed.count === 1) {
        return { event: await prisma.fiatProviderEvent.findUnique({ where: { id: existing.id } }), replay: true };
    }
    const authoritative = await prisma.fiatProviderEvent.findUnique({ where: { id: existing.id } });
    if (!authoritative) {
        throw new Error('[fiatLiquidity] provider observation identity lost during providerRef enrichment');
    }
    if (authoritative.providerRef == null || String(authoritative.providerRef) === incomingRef) {
        return { event: authoritative, replay: true };
    }
    await failClosedOnConflict(authoritative);
}

// ─── raw provider evidence (append-only, replay only on semantic match) ─────
//
// Records a raw provider observation OUTSIDE any caller transaction. Called
// BEFORE the settlement transaction so evidence always survives, even when
// the financial transition fails closed or rolls back.
//
// IDENTITY CONTRACT (docs §3.3):
//   * an exact semantic duplicate of a committed observation converges to
//     the committed row (replay: true) — webhook retries are idempotent;
//   * a materially different observation under the same identity is
//     CONTRADICTORY EVIDENCE: it is retained as a distinct durable row
//     (deterministic conflict identity; never rewritten over the committed
//     row) and the call FAILS CLOSED with ConflictingEvidenceError — the
//     caller can never proceed as though the new payload were the committed
//     observation, and contradictory evidence stays queryable/auditable;
//   * genuinely distinct provider observations (different status, reference,
//     provider) MUST be given distinct dedupKeys by the caller — the surface
//     derives the identity from fields actually present in its callback.
//
// INBOUND observations MUST carry the collected amount (the receipt evidence
// chain depends on it). OUTBOUND observations may carry none — a disbursement
// callback/poll often reports only status and reference; the amount stays
// whatever the reservation already recorded.
async function recordProviderEvent(prisma, {
    provider, rail = null, direction, status, providerRef = null, dedupKey,
    amountGhs = null, relatedReference = null, raw = null,
}) {
    if (!['INBOUND', 'OUTBOUND'].includes(direction)) {
        throw new InvalidEvidenceError(`[fiatLiquidity] invalid direction: ${direction}`);
    }
    if (!provider || !status || !dedupKey) {
        throw new InvalidEvidenceError('[fiatLiquidity] provider, status and dedupKey are required evidence');
    }
    const amount = amountGhs == null
        ? null
        : toExactGhsDecimal(amountGhs);
    if (direction === 'INBOUND' && amount == null) {
        throw new InvalidEvidenceError(
            `[fiatLiquidity] INBOUND observation ${dedupKey} must carry the collected amount — inbound evidence without an amount cannot back a receipt`
        );
    }
    const semantics = observationSemantics({
        provider, rail, direction, status, providerRef,
        amountGhs: amount, relatedReference,
    });
    const failClosedOnConflict = async (committed) => {
        const conflicting = await retainConflictingObservation(prisma, dedupKey, semantics, {
            provider, rail, direction, status,
            providerRef: providerRef == null ? null : String(providerRef),
            amountGhs: amount,
            relatedReference: relatedReference == null ? null : String(relatedReference),
            raw: raw ?? undefined,
        });
        const diffs = observationSemanticDiffs(
            observationSemantics(committed), semantics,
        );
        throw new ConflictingEvidenceError(
            `[fiatLiquidity] provider observation ${dedupKey} contradicts committed evidence — differing fields: ${diffs.join(', ')}; ` +
            `the contradictory observation is retained under ${conflicting.dedupKey}, never silently converged`,
            {
                dedupKey,
                committedEventId: committed.id,
                differingFields: diffs,
                conflictingEventId: conflicting.id,
                conflictingDedupKey: conflicting.dedupKey,
            }
        );
    };
    const existing = await prisma.fiatProviderEvent.findUnique({ where: { dedupKey } });
    if (existing) {
        if (observationSemanticsMatch(observationSemantics(existing), semantics)) {
            // Converge: the SAME observation already committed. NEVER rewrite
            // its committed semantic claims. The one strictly-additive
            // exception (audit r10): a committed observation recorded WITHOUT
            // a provider reference may be ENRICHED with the reference a retry
            // now carries — mirroring markReservationInTransit's fill-in. A
            // committed reference is never downgraded or changed. The
            // enrichment itself is a database-enforced compare-and-set (audit
            // r11): concurrent retries carrying different refs can never
            // collapse into last-writer-wins.
            if (existing.providerRef == null && semantics.providerRef != null) {
                return enrichProviderRefObservation(prisma, existing, semantics.providerRef, failClosedOnConflict);
            }
            return { event: existing, replay: true };
        }
        // A materially different payload under a committed identity is
        // contradictory evidence — retain it durably and fail closed.
        await failClosedOnConflict(existing);
    }
    let event;
    try {
        event = await prisma.fiatProviderEvent.create({
            data: {
                provider, rail, direction, status,
                providerRef: providerRef == null ? null : String(providerRef),
                dedupKey,
                amountGhs: amount,
                relatedReference: relatedReference == null ? null : String(relatedReference),
                raw: raw ?? undefined,
            },
        });
        return { event, replay: false };
    } catch (err) {
        if (err?.code === 'P2002') {
            // Concurrent duplicate under the same identity — the winner
            // committed first. Converge ONLY if it is semantically the same
            // observation; otherwise it is contradictory evidence.
            const raced = await prisma.fiatProviderEvent.findUnique({ where: { dedupKey } });
            if (!raced) throw new Error('[fiatLiquidity] provider event identity lost after race');
            if (observationSemanticsMatch(observationSemantics(raced), semantics)) {
                // Same enrichment exception as the sequential path — and the
                // same compare-and-set (audit r11): this branch can race a
                // concurrent enrichment of the row the winner committed, so
                // the NULL-slot claim must be database-enforced here too.
                if (raced.providerRef == null && semantics.providerRef != null) {
                    return enrichProviderRefObservation(prisma, raced, semantics.providerRef, failClosedOnConflict);
                }
                return { event: raced, replay: true };
            }
            await failClosedOnConflict(raced);
        }
        throw err;
    }
}

// Retain a contradictory observation as its own durable evidence row under
// the deterministic conflict identity. Exact retries of the contradictory
// payload converge to this row. If the retention itself cannot be persisted
// the persistence error propagates — evidence is never silently dropped.
async function retainConflictingObservation(prisma, dedupKey, semantics, data) {
    const conflictKey = conflictingObservationDedupKey(dedupKey, semantics);
    const existing = await prisma.fiatProviderEvent.findUnique({ where: { dedupKey: conflictKey } });
    if (existing) return existing;
    try {
        return await prisma.fiatProviderEvent.create({
            data: { ...data, dedupKey: conflictKey },
        });
    } catch (err) {
        if (err?.code === 'P2002') {
            const raced = await prisma.fiatProviderEvent.findUnique({ where: { dedupKey: conflictKey } });
            if (raced) return raced;
        }
        throw err;
    }
}

// ─── state helpers ──────────────────────────────────────────────────────────

const ensureStateRow = (tx) =>
    tx.fiatLiquidityState.upsert({
        where: { id: 1 },
        update: {},
        create: { id: 1, availableGhs: 0, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0 },
    });

// Guarded conditional decrement: the single-winner reservation claim. The
// WHERE clause is the concurrency guard — never read-then-write.
const claimAvailable = async (tx, amount) => {
    const claim = await tx.fiatLiquidityState.updateMany({
        where: { id: 1, availableGhs: { gte: amount } },
        data: { availableGhs: { decrement: amount }, reservedGhs: { increment: amount } },
    });
    if (claim.count !== 1) throw new LiquidityInsufficientError();
};

// Compatibility projection: SystemFiatPool.balance mirrors the authority's
// available liquidity. Called ONLY inside authority transactions.
const syncPoolProjection = async (tx) => {
    const state = await tx.fiatLiquidityState.findUnique({ where: { id: 1 } });
    await tx.systemFiatPool.upsert({
        where: { id: 1 },
        update: { balance: state.availableGhs },
        create: { id: 1, balance: state.availableGhs },
    });
    return state;
};

// ─── evidence-chain verification (docs §3.1) ────────────────────────────────

/**
 * Verify the FULL durable evidence chain a matched deposit receipt claims:
 *
 *   1. the INBOUND FiatProviderEvent exists (caller cannot invent it);
 *   2. its provider identity matches the receipt's;
 *   3. its collected amount matches the receipt amount EXACTLY;
 *   4. the event reports a successful collection;
 *   5. the event's relatedReference is the internal deposit txHash;
 *   6. the referenced TransactionHistory row exists (by id);
 *   7. it IS the fiat deposit the event is about (txHash binding, type);
 *   8. it is in the AUTHORITATIVE settled state (COMPLETED — the deposit
 *      webhooks CAS-claim it inside the caller transaction);
 *   9. its P5-C quote exists, is consumed, belongs to the same user, and its
 *      selected route is not contradicted.
 *
 * Any gap or contradiction fails closed — a caller-asserted
 * relatedTransactionId is never sufficient to create AVAILABLE GHS.
 */
async function verifyDepositEvidenceChain(tx, {
    eventDedupKey, provider, amount, providerRef, reference, relatedTransactionId, route,
}) {
    const fail = (msg) => {
        throw new InvalidEvidenceError(`[fiatLiquidity] matched-deposit evidence chain rejected: ${msg}`);
    };

    if (!eventDedupKey) fail('the durable provider observation backing the deposit is required');
    const event = await tx.fiatProviderEvent.findUnique({ where: { dedupKey: eventDedupKey } });
    if (!event) fail(`unknown provider observation ${eventDedupKey}`);
    if (event.direction !== 'INBOUND') fail(`event for ${reference} is ${event.direction}, not INBOUND`);
    if (event.provider !== provider) fail(`event provider ${event.provider} ≠ receipt provider ${provider}`);
    if (!event.amountGhs || !event.amountGhs.equals(amount)) {
        fail(`event amount ${event.amountGhs?.toString()} ≠ receipt amount ${amount.toString()}`);
    }
    if (event.status !== 'SUCCESSFUL') fail(`event status ${event.status} is not a successful collection`);
    if (event.relatedReference !== reference) {
        fail(`event reference ${event.relatedReference} ≠ deposit reference ${reference}`);
    }
    if (providerRef != null && event.providerRef != null && String(providerRef) !== String(event.providerRef)) {
        fail(`event providerRef ${event.providerRef} ≠ receipt providerRef ${providerRef}`);
    }

    const deposit = await tx.transactionHistory.findUnique({ where: { id: relatedTransactionId } });
    if (!deposit) fail(`unknown TransactionHistory ${relatedTransactionId}`);
    if (deposit.txHash !== reference) fail(`deposit txHash ${deposit.txHash} ≠ evidence reference ${reference}`);
    if (deposit.type !== 'DEPOSIT_FIAT') fail(`transaction ${reference} is ${deposit.type}, not DEPOSIT_FIAT`);
    if (deposit.status !== 'COMPLETED') fail(`deposit ${reference} is ${deposit.status}, not the authoritative settled state`);

    const quoteId = deposit.metadata?.quoteId;
    if (!quoteId) fail(`deposit ${reference} has no transaction quote`);
    // TransactionQuote is an overlay-managed table with NO Prisma model —
    // it is addressed through raw SQL everywhere (transactionQuoteService
    // uses $queryRaw for the same reason). Read the durable P5-C evidence
    // row through the same boundary.
    const quoteRows = await tx.$queryRaw`
        SELECT "id", "userId", "consumedAt", "consumedFor", "selectedRoute"
        FROM "TransactionQuote" WHERE "id" = ${quoteId}::uuid`;
    const quote = quoteRows[0];
    if (!quote) fail(`unknown transaction quote ${quoteId}`);
    if (quote.consumedAt == null) fail(`quote ${quoteId} is not consumed — deposit ${reference} is not authoritatively settled`);
    if (String(quote.userId) !== String(deposit.userId)) fail(`quote user ${quote.userId} ≠ deposit user ${deposit.userId}`);
    if (route != null && quote.selectedRoute != null && quote.selectedRoute !== route) {
        fail(`quote selectedRoute ${quote.selectedRoute} ≠ receipt route ${route}`);
    }
    return { event, deposit, quote };
}

// ─── inbound: receipts ──────────────────────────────────────────────────────

/**
 * Record an inbound GHS receipt from provider evidence.
 *
 *  - matched (relatedTransactionId + reference set — a deposit that already
 *    CAS-claimed its TransactionHistory PENDING→COMPLETED inside the caller
 *    transaction): the FULL durable evidence chain is verified
 *    (verifyDepositEvidenceChain) and only then lands AVAILABLE.
 *  - unmatched (no internal deposit): lands UNMATCHED — evidence retained,
 *    NO liquidity effect until confirmReconciliationMatch verifies a real
 *    chain against durable evidence.
 *  - treasury opening (audited internal record, e.g. liquidateProfits):
 *    lands RECEIVED; ONLY confirmTreasuryOpening — which requires a durable
 *    external GHS funding observation — can make it AVAILABLE.
 *
 * Idempotent by dedupKey: a replay returns the committed receipt unchanged.
 * Conflicting reuse (same dedupKey, different amount/provider) fails closed.
 */
async function recordReceipt(tx, {
    provider, rail = null, providerRef = null, dedupKey, amountGhs,
    route = null, reference = null, relatedTransactionId = null, evidence = null, treasury = false,
    eventDedupKey = null,
}) {
    if (!provider || !dedupKey) {
        throw new InvalidEvidenceError('[fiatLiquidity] provider and dedupKey are required receipt evidence');
    }
    const amount = toExactGhsDecimal(amountGhs);

    await ensureStateRow(tx);

    const existing = await tx.fiatLiquidityReceipt.findUnique({ where: { dedupKey } });
    if (existing) {
        if (!existing.amountGhs.equals(amount) || existing.provider !== provider) {
            // Conflicting reuse of an economic identity — fail closed. The
            // raw evidence rows for both observations are already durable.
            throw new ConflictingEvidenceError(
                `[fiatLiquidity] receipt identity ${dedupKey} already committed with different economics`,
                { committedAmountGhs: existing.amountGhs.toString(), committedProvider: existing.provider }
            );
        }
        return { receipt: existing, replay: true };
    }

    let status;
    if (treasury) {
        status = 'RECEIVED';
    } else if (relatedTransactionId != null) {
        // Matched deposit: the service verifies the evidence chain itself —
        // a caller-asserted relatedTransactionId is never sufficient.
        if (!reference) {
            throw new InvalidEvidenceError(
                '[fiatLiquidity] a matched deposit receipt requires the deposit reference (txHash) to bind its evidence chain'
            );
        }
        await verifyDepositEvidenceChain(tx, {
            eventDedupKey, provider, amount, providerRef, reference, relatedTransactionId, route,
        });
        status = 'AVAILABLE';
    } else {
        status = 'UNMATCHED';
    }

    const receipt = await tx.fiatLiquidityReceipt.create({
        data: {
            provider, rail, providerRef: providerRef == null ? null : String(providerRef),
            dedupKey, amountGhs: amount, status, route,
            relatedTransactionId: relatedTransactionId == null ? null : String(relatedTransactionId),
            confirmedAt: status === 'AVAILABLE' ? new Date() : null,
            evidence,
        },
    }).catch((err) => {
        if (err?.code === 'P2002') {
            // Concurrent duplicate of the same economic receipt — converge to
            // the committed row; never create a second liquidity result.
            return tx.fiatLiquidityReceipt.findUnique({ where: { dedupKey } });
        }
        throw err;
    });
    if (!receipt) throw new Error('[fiatLiquidity] receipt identity lost after race');
    if (receipt.dedupKey !== dedupKey || !receipt.amountGhs.equals(amount)) {
        // The row we converged to is not ours — conflicting identity.
        throw new ConflictingEvidenceError(
            `[fiatLiquidity] receipt identity ${dedupKey} conflicted under concurrency`
        );
    }

    if (receipt.status === 'AVAILABLE') {
        await tx.fiatLiquidityState.update({
            where: { id: 1 },
            data: { availableGhs: { increment: amount } },
        });
        await syncPoolProjection(tx);
        return { receipt, replay: false };
    }
    return { receipt, replay: false };
}

/**
 * UNMATCHED → AVAILABLE via a REAL reconciliation match. This transition
 * verifies the durable evidence chain — the operator names the deposit and
 * the durable provider observation, and the authority checks:
 *
 *   - the receipt exists and is UNMATCHED;
 *   - a durable INBOUND FiatProviderEvent exists whose provider, status,
 *     amount and reference identity match the receipt exactly;
 *   - the matched TransactionHistory deposit exists, is DEPOSIT_FIAT,
 *     COMPLETED, and is the transaction the event is about;
 *   - no OTHER receipt already claims the same deposit (no double count).
 *
 * Caller-asserted JSON is never sufficient.
 */
async function confirmReconciliationMatch(tx, {
    dedupKey, matchedTransactionId, confirmedBy = null, providerEventDedupKey = null,
}) {
    await ensureStateRow(tx);
    const receipt = await tx.fiatLiquidityReceipt.findUnique({ where: { dedupKey } });
    if (!receipt) throw new InvalidEvidenceError(`[fiatLiquidity] unknown receipt identity ${dedupKey}`);
    if (receipt.status !== 'UNMATCHED') {
        // An idempotent retry of the SAME confirmation converges instead of
        // erroring: an operator re-clicking "confirm match" (or a retried
        // request) must not be told the reconciliation failed.
        if (receipt.status === 'AVAILABLE'
            && String(receipt.relatedTransactionId) === String(matchedTransactionId)) {
            return { receipt, replay: true };
        }
        throw new ConflictingEvidenceError(
            `[fiatLiquidity] receipt ${dedupKey} in state ${receipt.status} cannot be reconciliation-matched (UNMATCHED only)`
        );
    }
    if (!matchedTransactionId) {
        throw new InvalidEvidenceError('[fiatLiquidity] a reconciliation match requires the matched deposit transaction');
    }
    if (!providerEventDedupKey) {
        throw new InvalidEvidenceError(
            '[fiatLiquidity] a reconciliation match requires the durable provider observation backing the receipt'
        );
    }

    // Durable evidence chain: the raw observation must exist and match the
    // receipt's economics exactly.
    const event = await tx.fiatProviderEvent.findUnique({ where: { dedupKey: providerEventDedupKey } });
    if (!event) {
        throw new InvalidEvidenceError(`[fiatLiquidity] unknown provider observation ${providerEventDedupKey}`);
    }
    if (event.direction !== 'INBOUND') {
        throw new InvalidEvidenceError(`[fiatLiquidity] observation ${providerEventDedupKey} is ${event.direction}, not INBOUND`);
    }
    if (event.provider !== receipt.provider) {
        throw new InvalidEvidenceError(
            `[fiatLiquidity] observation provider ${event.provider} ≠ receipt provider ${receipt.provider}`
        );
    }
    if (event.status !== 'SUCCESSFUL') {
        throw new InvalidEvidenceError(`[fiatLiquidity] observation ${providerEventDedupKey} status ${event.status} is not a successful collection`);
    }
    if (!event.amountGhs || !event.amountGhs.equals(receipt.amountGhs)) {
        throw new InvalidEvidenceError(
            `[fiatLiquidity] observation amount ${event.amountGhs?.toString()} ≠ receipt amount ${receipt.amountGhs.toString()}`
        );
    }

    const deposit = await tx.transactionHistory.findUnique({ where: { id: matchedTransactionId } });
    if (!deposit) throw new InvalidEvidenceError(`[fiatLiquidity] unknown matched deposit ${matchedTransactionId}`);
    if (deposit.type !== 'DEPOSIT_FIAT') {
        throw new InvalidEvidenceError(`[fiatLiquidity] matched transaction ${matchedTransactionId} is ${deposit.type}, not DEPOSIT_FIAT`);
    }
    if (deposit.status !== 'COMPLETED') {
        throw new InvalidEvidenceError(
            `[fiatLiquidity] matched deposit ${matchedTransactionId} is ${deposit.status}, not the authoritative settled state`
        );
    }
    if (event.relatedReference !== deposit.txHash) {
        throw new InvalidEvidenceError(
            `[fiatLiquidity] observation reference ${event.relatedReference} ≠ matched deposit txHash ${deposit.txHash}`
        );
    }
    if (receipt.providerRef != null && event.providerRef != null && String(receipt.providerRef) !== String(event.providerRef)) {
        throw new InvalidEvidenceError('[fiatLiquidity] observation providerRef contradicts the receipt providerRef');
    }

    // No double count: the deposit must not already carry an AVAILABLE receipt.
    const existingClaim = await tx.fiatLiquidityReceipt.findFirst({
        where: { relatedTransactionId: String(matchedTransactionId), status: 'AVAILABLE' },
    });
    if (existingClaim) {
        throw new ConflictingEvidenceError(
            `[fiatLiquidity] deposit ${matchedTransactionId} already has an AVAILABLE receipt ${existingClaim.dedupKey}`,
            { committedDedupKey: existingClaim.dedupKey }
        );
    }

    const claim = await tx.fiatLiquidityReceipt.updateMany({
        where: { id: receipt.id, status: 'UNMATCHED' },
        data: {
            status: 'AVAILABLE',
            confirmedAt: new Date(),
            relatedTransactionId: String(matchedTransactionId),
        },
    });
    if (claim.count !== 1) throw new ConflictingEvidenceError('[fiatLiquidity] reconciliation match raced');

    const updated = await tx.fiatLiquidityReceipt.update({
        where: { id: receipt.id },
        data: {
            evidence: {
                ...(receipt.evidence ?? {}),
                confirmedBy,
                reconciliationMatch: {
                    matchedTransactionId: String(matchedTransactionId),
                    providerEventDedupKey,
                },
            },
        },
    });
    await tx.fiatLiquidityState.update({
        where: { id: 1 },
        data: { availableGhs: { increment: receipt.amountGhs } },
    });
    await syncPoolProjection(tx);
    return { receipt: updated, replay: false };
}

/**
 * RECEIVED (treasury opening) → AVAILABLE — a SEPARATE explicit contract.
 *
 * A treasury opening records that an internal, audited operation moved USDC
 * profit aside and PRICED a GHS opening at the canonical rate. That pricing is
 * NOT GHS custody evidence: this transition is available only when a REAL
 * external GHS funding event is attested — a durable FiatProviderEvent for
 * the funding observation (bank/MoMo transfer reference), which this function
 * records and binds to the receipt.
 *
 * The generic "confirm anything" behavior is deliberately absent: an internal
 * USDC liquidation can never unlock spendable GHS by itself.
 */
async function confirmTreasuryOpening(tx, {
    dedupKey, confirmedBy = null, fundingReference, fundingChannel,
}) {
    await ensureStateRow(tx);
    const receipt = await tx.fiatLiquidityReceipt.findUnique({ where: { dedupKey } });
    if (!receipt) throw new InvalidEvidenceError(`[fiatLiquidity] unknown receipt identity ${dedupKey}`);
    if (receipt.status === 'AVAILABLE') return { receipt, replay: true };
    if (receipt.status !== 'RECEIVED') {
        throw new ConflictingEvidenceError(
            `[fiatLiquidity] receipt ${dedupKey} in state ${receipt.status} cannot be confirmed (RECEIVED treasury opening only)`
        );
    }
    if (!fundingReference || typeof fundingReference !== 'string' || fundingReference.trim().length < 3) {
        throw new InvalidEvidenceError(
            '[fiatLiquidity] confirming a treasury opening requires an external funding reference (e.g. bank/MoMo transfer id)'
        );
    }
    if (!['BANK', 'MOMO', 'OTHER'].includes(fundingChannel)) {
        throw new InvalidEvidenceError('[fiatLiquidity] fundingChannel must be BANK, MOMO or OTHER');
    }

    // The funding observation becomes DURABLE evidence, not caller JSON.
    const fundingEventDedupKey = `event:treasury-funding:${fundingReference.trim()}`;
    const { event: fundingEvent } = await recordProviderEvent(tx, {
        provider: 'AZM_TREASURY',
        rail: fundingChannel === 'BANK' ? 'BANK' : fundingChannel === 'MOMO' ? 'MOMO' : 'INTERNAL',
        direction: 'INBOUND',
        status: 'FUNDED',
        providerRef: fundingReference.trim(),
        dedupKey: fundingEventDedupKey,
        amountGhs: receipt.amountGhs,
        relatedReference: dedupKey,
        raw: { fundingChannel, confirmedBy },
    });
    if (fundingEvent.amountGhs == null || !fundingEvent.amountGhs.equals(receipt.amountGhs)) {
        throw new ConflictingEvidenceError(
            '[fiatLiquidity] funding observation amount contradicts the treasury opening'
        );
    }

    const claim = await tx.fiatLiquidityReceipt.updateMany({
        where: { id: receipt.id, status: 'RECEIVED' },
        data: { status: 'AVAILABLE', confirmedAt: new Date() },
    });
    if (claim.count !== 1) throw new ConflictingEvidenceError('[fiatLiquidity] treasury confirmation raced');
    const updated = await tx.fiatLiquidityReceipt.update({
        where: { id: receipt.id },
        data: {
            evidence: {
                ...(receipt.evidence ?? {}),
                confirmedBy,
                treasuryFunding: {
                    fundingReference: fundingReference.trim(),
                    fundingChannel,
                    providerEventDedupKey: fundingEventDedupKey,
                },
            },
        },
    });
    await tx.fiatLiquidityState.update({
        where: { id: 1 },
        data: { availableGhs: { increment: receipt.amountGhs } },
    });
    await syncPoolProjection(tx);
    return { receipt: updated, replay: false };
}

// ─── outbound: reservations ──────────────────────────────────────────────────

/**
 * Reserve GHS liquidity for a fiat payout. Single-winner by construction:
 *
 *   1. INSERT the reservation row (unique reference) — a concurrent
 *      duplicate reference converges to the committed reservation and never
 *      double-reserves; a conflicting amount reuse fails closed.
 *   2. guarded conditional decrement of availableGhs — a loser throws
 *      LiquidityInsufficientError, which rolls back the whole caller
 *      transaction INCLUDING the reservation row (never an orphan).
 */
async function reserveForPayout(tx, {
    reference, amountGhs, provider, rail = null, destination = null, relatedTransactionId = null,
}) {
    if (!reference) throw new InvalidEvidenceError('[fiatLiquidity] reservation reference is required');
    if (!provider) throw new InvalidEvidenceError('[fiatLiquidity] reservation provider is required');
    const amount = toExactGhsDecimal(amountGhs);

    await ensureStateRow(tx);

    const existing = await tx.fiatLiquidityReservation.findUnique({ where: { reference } });
    if (existing) {
        if (!existing.amountGhs.equals(amount) || existing.provider !== provider) {
            throw new ConflictingEvidenceError(
                `[fiatLiquidity] reservation ${reference} already committed with different economics`,
                { committedAmountGhs: existing.amountGhs.toString(), committedProvider: existing.provider }
            );
        }
        return { reservation: existing, replay: true };
    }

    // Single-winner reservation: ONLY the creator of the reservation row
    // performs the liquidity claim. A concurrent duplicate of the same
    // reference converges to the committed row (P2002, verified identical)
    // and never claims twice; a conflicting reuse fails closed; a claim
    // loser rolls back the whole caller transaction including this row.
    let created;
    try {
        created = await tx.fiatLiquidityReservation.create({
            data: {
                reference, amountGhs: amount, provider, rail,
                destination: destination == null ? null : String(destination),
                relatedTransactionId: relatedTransactionId == null ? null : String(relatedTransactionId),
                status: 'RESERVED',
            },
        });
    } catch (err) {
        if (err?.code === 'P2002') {
            const raced = await tx.fiatLiquidityReservation.findUnique({ where: { reference } });
            if (raced && raced.amountGhs.equals(amount) && raced.provider === provider) {
                return { reservation: raced, replay: true };
            }
            throw new ConflictingEvidenceError(
                `[fiatLiquidity] reservation ${reference} conflicted under concurrency`,
                { committedAmountGhs: raced?.amountGhs?.toString(), committedProvider: raced?.provider }
            );
        }
        throw err;
    }

    await claimAvailable(tx, amount);
    const state = await syncPoolProjection(tx);
    return { reservation: created, replay: false, state };
}

/**
 * RESERVED → IN_TRANSIT (provider accepted the payout). Single-winner CAS;
 * replays are side-effect free; terminal rows fail closed.
 */
async function markReservationInTransit(tx, { reference, providerRef = null }) {
    const reservation = await tx.fiatLiquidityReservation.findUnique({ where: { reference } });
    if (!reservation) throw new InvalidEvidenceError(`[fiatLiquidity] unknown reservation ${reference}`);
    if (reservation.status === 'IN_TRANSIT') {
        if (providerRef && !reservation.providerRef) {
            await tx.fiatLiquidityReservation.update({
                where: { id: reservation.id },
                data: { providerRef: String(providerRef) },
            });
        }
        return { reservation, replay: true };
    }
    if (reservation.status !== 'RESERVED') {
        throw new ConflictingEvidenceError(
            `[fiatLiquidity] reservation ${reference} in state ${reservation.status} cannot dispatch`
        );
    }
    const claim = await tx.fiatLiquidityReservation.updateMany({
        where: { id: reservation.id, status: 'RESERVED' },
        data: { status: 'IN_TRANSIT', dispatchedAt: new Date() },
    });
    if (claim.count !== 1) throw new ConflictingEvidenceError('[fiatLiquidity] dispatch claim raced');
    await tx.fiatLiquidityState.update({
        where: { id: 1 },
        data: { reservedGhs: { decrement: reservation.amountGhs }, inTransitGhs: { increment: reservation.amountGhs } },
    });
    const updated = providerRef
        ? await tx.fiatLiquidityReservation.update({
            where: { id: reservation.id }, data: { providerRef: String(providerRef) },
        })
        : reservation;
    return { reservation: updated, replay: false };
}

/**
 * Terminal provider outcome for a payout reservation.
 *
 *   SUCCESSFUL → IN_TRANSIT → PAID_OUT          (funds leave; totals move)
 *   FAILED     → RESERVED|IN_TRANSIT → RELEASED (funds return to available)
 *
 * Replays of the same outcome are side-effect free. A CONTRADICTORY outcome
 * (SUCCESS after FAILED or vice versa, or a different provider reference)
 * never rewrites the terminal state: evidence is retained and the reservation
 * is quarantined RECONCILIATION_REQUIRED with a ReconciliationException, and
 * the disputed amount moves into the reconciliationHeldGhs bucket — counted,
 * never spendable again without an explicit resolution.
 */
async function settleReservation(tx, { reference, outcome, providerTxId = null, reason = null }) {
    if (!['SUCCESSFUL', 'FAILED'].includes(outcome)) {
        throw new InvalidEvidenceError(`[fiatLiquidity] unsupported terminal outcome: ${outcome}`);
    }
    await ensureStateRow(tx);
    const reservation = await tx.fiatLiquidityReservation.findUnique({ where: { reference } });
    if (!reservation) throw new InvalidEvidenceError(`[fiatLiquidity] unknown reservation ${reference}`);

    const successRef = providerTxId == null ? null : String(providerTxId);

    if (reservation.status === 'PAID_OUT') {
        if (outcome !== 'SUCCESSFUL' || (successRef && reservation.providerRef && reservation.providerRef !== successRef)) {
            return quarantineContradictoryOutcome(tx, reservation, { outcome, providerTxId: successRef, reason });
        }
        return { reservation, replay: true };
    }
    if (reservation.status === 'RELEASED') {
        if (outcome !== 'FAILED' || (reason && reservation.releasedAt === null)) {
            return quarantineContradictoryOutcome(tx, reservation, { outcome, providerTxId: successRef, reason });
        }
        return { reservation, replay: true };
    }
    if (reservation.status === 'RECONCILIATION_REQUIRED') {
        // Terminal-quarantined: later evidence is retained via the event log,
        // but the reservation is never auto-repaired here.
        return { reservation, replay: true, quarantined: true };
    }
    if (reservation.status === 'RESERVED' && outcome === 'SUCCESSFUL') {
        // SUCCESS evidence while the reservation was never dispatched: the
        // provider outcome contradicts our recorded lifecycle. Never
        // auto-repair and never throw on the mounted settle path — quarantine
        // with the evidence retained (ops resolves; funds move to the
        // reconciliation hold, so nothing is spendable twice).
        return quarantineContradictoryOutcome(tx, reservation, { outcome, providerTxId: successRef, reason });
    }
    if (reservation.status === 'IN_TRANSIT' && outcome === 'SUCCESSFUL') {
        if (successRef && reservation.providerRef && reservation.providerRef !== successRef) {
            // Terminal success claimed through a DIFFERENT provider reference
            // than the dispatched one — contradictory evidence, fail closed.
            return quarantineContradictoryOutcome(tx, reservation, { outcome, providerTxId: successRef, reason });
        }
        const claim = await tx.fiatLiquidityReservation.updateMany({
            where: { id: reservation.id, status: 'IN_TRANSIT' },
            data: { status: 'PAID_OUT', settledAt: new Date() },
        });
        if (claim.count !== 1) throw new ConflictingEvidenceError('[fiatLiquidity] settlement claim raced');
        await tx.fiatLiquidityState.update({
            where: { id: 1 },
            data: { inTransitGhs: { decrement: reservation.amountGhs }, paidOutGhs: { increment: reservation.amountGhs } },
        });
        const updated = successRef
            ? await tx.fiatLiquidityReservation.update({
                where: { id: reservation.id }, data: { providerRef: successRef },
            })
            : await tx.fiatLiquidityReservation.findUnique({ where: { id: reservation.id } });
        await syncPoolProjection(tx);
        return { reservation: updated, replay: false };
    }
    if ((reservation.status === 'RESERVED' || reservation.status === 'IN_TRANSIT') && outcome === 'FAILED') {
        const claim = await tx.fiatLiquidityReservation.updateMany({
            where: { id: reservation.id, status: reservation.status },
            data: { status: 'RELEASED', releasedAt: new Date() },
        });
        if (claim.count !== 1) throw new ConflictingEvidenceError('[fiatLiquidity] release claim raced');
        if (reservation.status === 'RESERVED') {
            await tx.fiatLiquidityState.update({
                where: { id: 1 },
                data: { reservedGhs: { decrement: reservation.amountGhs }, availableGhs: { increment: reservation.amountGhs } },
            });
        } else {
            await tx.fiatLiquidityState.update({
                where: { id: 1 },
                data: { inTransitGhs: { decrement: reservation.amountGhs }, availableGhs: { increment: reservation.amountGhs } },
            });
        }
        const updated = await tx.fiatLiquidityReservation.findUnique({ where: { id: reservation.id } });
        await syncPoolProjection(tx);
        return { reservation: updated, replay: false };
    }
    throw new ConflictingEvidenceError(
        `[fiatLiquidity] reservation ${reference} in state ${reservation.status} cannot settle ${outcome}`
    );
}

/**
 * Internal reversal while still RESERVED (provider dispatch never happened —
 * synchronous failure/unavailable gateway). Funds return to available. If the
 * payout already went IN_TRANSIT, the cash position is unprovable from here:
 * the reservation is quarantined (funds held, never auto-released).
 */
async function releaseReservation(tx, { reference, reason = null }) {
    await ensureStateRow(tx);
    const reservation = await tx.fiatLiquidityReservation.findUnique({ where: { reference } });
    if (!reservation) throw new InvalidEvidenceError(`[fiatLiquidity] unknown reservation ${reference}`);
    if (reservation.status === 'RELEASED') return { reservation, replay: true };
    if (reservation.status === 'RESERVED') {
        const claim = await tx.fiatLiquidityReservation.updateMany({
            where: { id: reservation.id, status: 'RESERVED' },
            data: { status: 'RELEASED', releasedAt: new Date() },
        });
        if (claim.count !== 1) throw new ConflictingEvidenceError('[fiatLiquidity] release claim raced');
        await tx.fiatLiquidityState.update({
            where: { id: 1 },
            data: { reservedGhs: { decrement: reservation.amountGhs }, availableGhs: { increment: reservation.amountGhs } },
        });
        const updated = await tx.fiatLiquidityReservation.findUnique({ where: { id: reservation.id } });
        await syncPoolProjection(tx);
        return { reservation: updated, replay: false };
    }
    if (reservation.status === 'IN_TRANSIT') {
        return quarantineContradictoryOutcome(tx, reservation, { outcome: 'INTERNAL_REVERSAL', providerTxId: null, reason });
    }
    if (reservation.status === 'RECONCILIATION_REQUIRED') {
        return { reservation, replay: true, quarantined: true };
    }
    // PAID_OUT: a late internal reversal cannot unpay cash.
    return quarantineContradictoryOutcome(tx, reservation, { outcome: 'INTERNAL_REVERSAL', providerTxId: null, reason });
}

// Quarantine: preserve the contradictory evidence, never rewrite terminal
// state, never auto-repair. The disputed amount moves into the
// reconciliationHeldGhs bucket so it is counted but NEVER spendable:
//
//   prior RESERVED     → reservedGhs      −→ reconciliationHeldGhs
//   prior IN_TRANSIT   → inTransitGhs     −→ reconciliationHeldGhs
//   prior RELEASED     → availableGhs     −→ reconciliationHeldGhs (guarded:
//                          if the released funds were already consumed by
//                          later payouts, the un-spendable move fails and a
//                          separate exception flags the over-spend loudly)
//   prior PAID_OUT     → no move (already non-spendable)
//
// Idempotent via the OPEN-exception unique index.
async function quarantineContradictoryOutcome(tx, reservation, { outcome, providerTxId, reason }) {
    const amount = reservation.amountGhs;

    // Single-winner quarantine claim on the row's CURRENT state.
    const claim = await tx.fiatLiquidityReservation.updateMany({
        where: { id: reservation.id, status: reservation.status },
        data: { status: 'RECONCILIATION_REQUIRED' },
    });

    let heldMove = 'not_claimed';
    if (claim.count === 1) {
        if (reservation.status === 'RESERVED') {
            await tx.fiatLiquidityState.update({
                where: { id: 1 },
                data: { reservedGhs: { decrement: amount }, reconciliationHeldGhs: { increment: amount } },
            });
            heldMove = 'reserved_to_held';
        } else if (reservation.status === 'IN_TRANSIT') {
            await tx.fiatLiquidityState.update({
                where: { id: 1 },
                data: { inTransitGhs: { decrement: amount }, reconciliationHeldGhs: { increment: amount } },
            });
            heldMove = 'in_transit_to_held';
        } else if (reservation.status === 'RELEASED') {
            // The provider may actually have paid cash that we already handed
            // back to availability. Remove the disputed amount from spendable
            // availability — guarded, because a fungible pool may have already
            // consumed it with later payouts.
            const move = await tx.fiatLiquidityState.updateMany({
                where: { id: 1, availableGhs: { gte: amount } },
                data: { availableGhs: { decrement: amount }, reconciliationHeldGhs: { increment: amount } },
            });
            heldMove = move.count === 1 ? 'released_to_held' : 'released_already_spent';
        }
        // prior PAID_OUT: funds are already non-spendable in paidOutGhs —
        // the contradiction is flagged, no fund movement needed.
        if (reservation.status === 'PAID_OUT') heldMove = 'paid_out_unchanged';
    }

    // Exception infra is the operational queue (evidence, non-authoritative);
    // the reservation state above is the financial truth.
    await recordReconciliationException(tx, {
        entityType: 'FIAT_LIQUIDITY_RESERVATION',
        entityId: reservation.reference,
        reference: reservation.providerRef,
        reason: 'CONTRADICTORY_PROVIDER_EVIDENCE',
        details: {
            reservationStatus: reservation.status,
            contradictoryOutcome: outcome,
            contradictoryProviderTxId: providerTxId,
            reason: reason ?? null,
            amountGhs: amount.toString(),
            heldMove,
        },
    }).catch(() => null);

    if (heldMove === 'released_already_spent') {
        // Fungibility honesty: the returned funds were consumed by later
        // payouts before the contradiction arrived. This may be a REAL
        // over-spend of GHS cash — flag it separately and loudly.
        await recordReconciliationException(tx, {
            entityType: 'FIAT_LIQUIDITY_STATE',
            entityId: reservation.reference,
            reference: reservation.providerRef,
            reason: 'CONTRADICTORY_RELEASE_ALREADY_SPENT',
            details: {
                reservationReference: reservation.reference,
                amountGhs: amount.toString(),
                contradictoryOutcome: outcome,
            },
        }).catch(() => null);
    }

    return {
        reservation: await tx.fiatLiquidityReservation.findUnique({ where: { id: reservation.id } }),
        replay: false,
        quarantined: true,
        heldMove,
    };
}

// ─── integration wrappers ───────────────────────────────────────────────────
//
// The mounted withdrawal paths may encounter withdrawals created BEFORE the
// authority existed (no reservation row). The regime follows the recorded
// row, never the current flag: an authority reservation is settled/released
// by the authority; a legacy withdrawal keeps the legacy SystemFiatPool
// behavior. Missing liquidity history is NEVER invented (docs §1.5).

const inTransitIfRecorded = async (tx, args) => {
    const rz = await tx.fiatLiquidityReservation.findUnique({ where: { reference: args.reference } });
    if (!rz) return { skipped: true };
    return { skipped: false, ...(await markReservationInTransit(tx, args)) };
};

const settleIfRecorded = async (tx, args) => {
    const rz = await tx.fiatLiquidityReservation.findUnique({ where: { reference: args.reference } });
    if (!rz) return { skipped: true };
    return { skipped: false, ...(await settleReservation(tx, args)) };
};

const releaseIfRecorded = async (tx, args) => {
    const rz = await tx.fiatLiquidityReservation.findUnique({ where: { reference: args.reference } });
    if (!rz) return { skipped: true };
    return { skipped: false, ...(await releaseReservation(tx, args)) };
};

// ─── reconciliation ─────────────────────────────────────────────────────────

/**
 * Compare the aggregate against evidence. NEVER auto-repairs: every
 * discrepancy is retained as an OPEN ReconciliationException (idempotent per
 * entity+reason) and reported. Categories (docs §1.3/§5):
 *
 *   RECEIPT_WITHOUT_CONFIRMATION  RECEIVED/UNMATCHED older than the horizon
 *   EVENT_WITHOUT_RECEIPT         inbound evidence with no liquidity receipt
 *   DUPLICATE_PROVIDER_REFERENCE  same provider+ref on multiple receipts
 *   AMOUNT_MISMATCH               event vs receipt amounts for a reference
 *   RESERVATION_MISSING_RESULT    RESERVED/IN_TRANSIT older than the horizon
 *   STATE_CONSERVATION_DELTA      aggregate vs receipts/reservations sums
 *                                 (EVERY bucket: available/reserved/
 *                                 inTransit/reconciliationHeld/paidOut)
 *   AVAILABLE_UNSUPPORTED        available exceeds matched AVAILABLE evidence
 *   CONTRADICTORY_RELEASE_ALREADY_SPENT  (written at quarantine time)
 */
async function reconcile(prisma, { horizonMinutes = 60, dryRun = false } = {}) {
    const horizon = new Date(Date.now() - horizonMinutes * 60_000);
    const exceptions = [];

    const push = (entityType, entityId, reference, reason, details) =>
        exceptions.push({ entityType, entityId, reference, reason, details });

    const [state, receipts, reservations, inboundEvents] = await Promise.all([
        prisma.fiatLiquidityState.findUnique({ where: { id: 1 } }),
        prisma.fiatLiquidityReceipt.findMany(),
        prisma.fiatLiquidityReservation.findMany(),
        prisma.fiatProviderEvent.findMany({ where: { direction: 'INBOUND' } }),
    ]);

    // Durable join for event ↔ receipt pairing: real chains record the event
    // under an event:… dedupKey and the receipt under a receipt:… dedupKey, so
    // key equality NEVER pairs them. The durable join is: (a) shared dedupKey
    // (legacy/manual), (b) provider + providerRef, or (c) event.relatedReference
    // (the deposit txHash) → the settled TransactionHistory row → the receipt
    // bound to that deposit.
    const receiptThIds = [...new Set(receipts.map((r) => r.relatedTransactionId).filter(Boolean))];
    const depositRows = receiptThIds.length
        ? await prisma.transactionHistory.findMany({ where: { id: { in: receiptThIds } }, select: { id: true, txHash: true } })
        : [];
    const thIdByHash = new Map(depositRows.map((t) => [t.txHash, t.id]));
    const receiptForEvent = (ev) => receipts.find((r) => r.dedupKey === ev.dedupKey)
        ?? receipts.find((r) => r.provider === ev.provider && r.providerRef != null && ev.providerRef != null && String(r.providerRef) === String(ev.providerRef))
        ?? (ev.relatedReference != null
            ? receipts.find((r) => r.relatedTransactionId === thIdByHash.get(ev.relatedReference))
            : undefined);

    for (const r of receipts) {
        if (['RECEIVED', 'UNMATCHED'].includes(r.status) && r.createdAt < horizon) {
            push('FIAT_LIQUIDITY_RECEIPT', r.dedupKey, r.providerRef, 'RECEIPT_WITHOUT_CONFIRMATION',
                { status: r.status, ageMinutes: Math.round((Date.now() - r.createdAt.getTime()) / 60_000) });
        }
    }

    for (const ev of inboundEvents) {
        if (!receiptForEvent(ev)) {
            push('FIAT_PROVIDER_EVENT', ev.dedupKey, ev.providerRef, 'EVENT_WITHOUT_RECEIPT',
                { provider: ev.provider, amountGhs: ev.amountGhs?.toString() ?? null, status: ev.status });
        }
    }

    const byRef = new Map();
    for (const r of receipts) {
        if (!r.providerRef) continue;
        const key = `${r.provider}:${r.providerRef}`;
        if (byRef.has(key)) {
            for (const other of byRef.get(key)) {
                push('FIAT_LIQUIDITY_RECEIPT', r.dedupKey, r.providerRef, 'DUPLICATE_PROVIDER_REFERENCE',
                    { provider: r.provider, providerRef: r.providerRef, firstDedupKey: other.dedupKey });
            }
        }
        byRef.set(key, [...(byRef.get(key) ?? []), r]);
    }

    for (const ev of inboundEvents) {
        const receipt = receiptForEvent(ev);
        if (receipt && ev.amountGhs != null && !receipt.amountGhs.equals(ev.amountGhs)) {
            push('FIAT_LIQUIDITY_RECEIPT', receipt.dedupKey, receipt.providerRef, 'AMOUNT_MISMATCH',
                { receiptGhs: receipt.amountGhs.toString(), eventGhs: ev.amountGhs.toString() });
        }
    }

    for (const rz of reservations) {
        if (['RESERVED', 'IN_TRANSIT'].includes(rz.status) && rz.createdAt < horizon) {
            push('FIAT_LIQUIDITY_RESERVATION', rz.reference, rz.providerRef, 'RESERVATION_MISSING_RESULT',
                { status: rz.status, ageMinutes: Math.round((Date.now() - rz.createdAt.getTime()) / 60_000) });
        }
    }

    // Conservation (docs §5): every bucket is derived from durable evidence.
    //   AVAILABLE receipts − claims (active, paid out, quarantined-held)
    //     = expected available   (RELEASED contributes net zero)
    //   sums over reservations per state = expected bucket totals.
    const zero = new Prisma.Decimal(0);
    const sum = (rows) => rows.reduce((acc, r) => acc.plus(r.amountGhs ?? zero), zero);
    const availableEvidence = sum(receipts.filter((r) => r.status === 'AVAILABLE'));
    const activeHeld = sum(reservations.filter((r) => ['RESERVED', 'IN_TRANSIT'].includes(r.status)));
    const paidOutHeld = sum(reservations.filter((r) => r.status === 'PAID_OUT'));
    const quarantinedHeld = sum(reservations.filter((r) => r.status === 'RECONCILIATION_REQUIRED'));

    const expectedAvailable = availableEvidence.minus(activeHeld).minus(paidOutHeld).minus(quarantinedHeld);
    const expected = {
        availableGhs: expectedAvailable,
        reservedGhs: sum(reservations.filter((r) => r.status === 'RESERVED')),
        inTransitGhs: sum(reservations.filter((r) => r.status === 'IN_TRANSIT')),
        paidOutGhs: paidOutHeld,
        reconciliationHeldGhs: quarantinedHeld,
    };
    const mismatches = Object.entries(expected)
        .filter(([bucket, value]) => !state[bucket].minus(value).isZero())
        .map(([bucket, value]) => ({ bucket, stateGhs: state[bucket].toString(), evidenceGhs: value.toString() }));
    if (mismatches.length > 0) {
        push('FIAT_LIQUIDITY_STATE', '1', null, 'STATE_CONSERVATION_DELTA', { mismatches });
    }
    // AVAILABLE liquidity is supported ONLY by AVAILABLE receipt evidence
    // (releases came from that evidence already — no double counting).
    if (state.availableGhs.gt(availableEvidence)) {
        push('FIAT_LIQUIDITY_STATE', '1', null, 'AVAILABLE_UNSUPPORTED',
            { availableGhs: state.availableGhs.toString(), supportedGhs: availableEvidence.toString() });
    }

    if (!dryRun) {
        for (const ex of exceptions) {
            await recordReconciliationException(prisma, {
                entityType: ex.entityType,
                entityId: ex.entityId,
                reference: ex.reference,
                reason: ex.reason,
                details: ex.details,
            }).catch((err) => {
                logger.warn({ err: err.message, reason: ex.reason }, '[fiatLiquidity] exception record failed');
            });
        }
    }

    return {
        exceptions,
        totals: {
            availableGhs: state.availableGhs.toString(),
            reservedGhs: state.reservedGhs.toString(),
            inTransitGhs: state.inTransitGhs.toString(),
            paidOutGhs: state.paidOutGhs.toString(),
            reconciliationHeldGhs: state.reconciliationHeldGhs.toString(),
        },
    };
}

// ─── observability ──────────────────────────────────────────────────────────

async function liquiditySummary(prisma) {
    const [state, receipts, reservations] = await Promise.all([
        prisma.fiatLiquidityState.findUnique({ where: { id: 1 } }),
        prisma.fiatLiquidityReceipt.groupBy({ by: ['status'], _sum: { amountGhs: true }, _count: true }),
        prisma.fiatLiquidityReservation.groupBy({ by: ['status', 'provider'], _sum: { amountGhs: true }, _count: true }),
    ]);
    const pool = await prisma.systemFiatPool.findUnique({ where: { id: 1 } });
    return {
        authoritative: {
            availableGhs: state.availableGhs.toString(),
            reservedGhs: state.reservedGhs.toString(),
            inTransitGhs: state.inTransitGhs.toString(),
            paidOutGhs: state.paidOutGhs.toString(),
            reconciliationHeldGhs: state.reconciliationHeldGhs.toString(),
        },
        receiptsByStatus: receipts.map((g) => ({
            status: g.status, count: g._count, amountGhs: (g._sum.amountGhs ?? new Prisma.Decimal(0)).toString(),
        })),
        reservationsByStatus: reservations.map((g) => ({
            status: g.status, provider: g.provider, count: g._count,
            amountGhs: (g._sum.amountGhs ?? new Prisma.Decimal(0)).toString(),
        })),
        // Explicitly NON-authoritative compatibility projection.
        systemFiatPoolProjection: pool ? pool.balance.toString() : null,
    };
}

module.exports = {
    LIQUIDITY_INSUFFICIENT_CODE,
    LiquidityInsufficientError,
    ConflictingEvidenceError,
    InvalidEvidenceError,
    GhsEvidenceRequiredError,
    isAuthorityEnabled,
    recordProviderEvent,
    recordReceipt,
    confirmReconciliationMatch,
    confirmTreasuryOpening,
    reserveForPayout,
    markReservationInTransit,
    settleReservation,
    releaseReservation,
    inTransitIfRecorded,
    settleIfRecorded,
    releaseIfRecorded,
    reconcile,
    liquiditySummary,
    toExactGhsDecimal,
};
