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
//   1. ONLY evidence creates AVAILABLE liquidity: a settled, quote-matched
//      deposit observation (the two mounted deposit webhooks, each of which
//      CAS-claims the deposit inside the same transaction) or an explicit
//      confirmation of an audited treasury opening. A client request, a
//      quote, an unverified webhook or a scalar increment can NEVER create
//      availability.
//   2. Reservation is a single-winner conditional decrement
//      (availableGhs >= amount); losers fail closed with the legacy
//      FIAT_POOL_INSUFFICIENT contract preserved for API compatibility.
//   3. Every receipt/reservation/terminal transition has a durable economic
//      identity; replays converge to the committed result; conflicting reuse
//      fails closed with the evidence retained.
//   4. Contradictory provider evidence is preserved and quarantined
//      (RECONCILIATION_REQUIRED + ReconciliationException), never rewritten,
//      never auto-repaired, never auto-released.
//   5. GHS amounts are exact Decimal(20,2) (pesewas). Amounts with sub-pesewa
//      precision are rejected — the authority never guesses a rounding.
//   6. SystemFiatPool becomes a derived projection: every authority
//      transition syncs pool.balance := state.availableGhs inside the same
//      transaction. No other writer may mutate it.
//
// P4 boundary: this service records GHS liquidity truth only. It never posts
// customer liability, never touches restricted obligations, never realizes
// economics, never balances GHS against USDC.
//
// Provider adapters (Moolre/MTN) stay external I/O: they return provider
// evidence; this module owns durable state and atomic financial transitions.
// =============================================================================

const { Prisma } = require('@prisma/client');
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

// ─── raw provider evidence (append-only, idempotent) ───────────────────────

// Records a raw provider observation OUTSIDE any caller transaction. Called
// BEFORE the settlement transaction so evidence always survives, even when
// the financial transition fails closed or rolls back. Replays converge to the
// committed event row (dedupKey is the observation's economic identity).
async function recordProviderEvent(prisma, {
    provider, rail = null, direction, status, providerRef = null, dedupKey,
    amountGhs, relatedReference = null, raw = null,
}) {
    if (!['INBOUND', 'OUTBOUND'].includes(direction)) {
        throw new InvalidEvidenceError(`[fiatLiquidity] invalid direction: ${direction}`);
    }
    if (!provider || !status || !dedupKey) {
        throw new InvalidEvidenceError('[fiatLiquidity] provider, status and dedupKey are required evidence');
    }
    const amount = toExactGhsDecimal(amountGhs);
    const existing = await prisma.fiatProviderEvent.findUnique({ where: { dedupKey } });
    if (existing) {
        // Converge: same observation already committed. NEVER rewrite it.
        return { event: existing, replay: true };
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
            // Concurrent duplicate of the same observation — converge.
            const raced = await prisma.fiatProviderEvent.findUnique({ where: { dedupKey } });
            if (!raced) throw new Error('[fiatLiquidity] provider event identity lost after race');
            return { event: raced, replay: true };
        }
        throw err;
    }
}

// ─── state helpers ──────────────────────────────────────────────────────────

const ensureStateRow = (tx) =>
    tx.fiatLiquidityState.upsert({
        where: { id: 1 },
        update: {},
        create: { id: 1, availableGhs: 0, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0 },
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

// ─── inbound: receipts ──────────────────────────────────────────────────────

/**
 * Record an inbound GHS receipt from provider evidence.
 *
 *  - matched (relatedTransactionId set — a deposit that already CAS-claimed
 *    its TransactionHistory PENDING→COMPLETED inside the caller transaction):
 *    lands AVAILABLE immediately and increases claimable liquidity.
 *  - unmatched (no internal deposit): lands UNMATCHED — evidence retained,
 *    NO liquidity effect until an explicit reconciliation match.
 *  - treasury opening (audited internal liquidation): lands RECEIVED; ONLY
 *    confirmReceipt may make it AVAILABLE.
 *
 * Idempotent by dedupKey: a replay returns the committed receipt unchanged.
 * Conflicting reuse (same dedupKey, different amount/provider) fails closed.
 */
async function recordReceipt(tx, {
    provider, rail = null, providerRef = null, dedupKey, amountGhs,
    route = null, relatedTransactionId = null, evidence = null, treasury = false,
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

    const status = treasury
        ? 'RECEIVED'
        : (relatedTransactionId ? 'AVAILABLE' : 'UNMATCHED');

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
 * Explicit RECEIVED/UNMATCHED → AVAILABLE transition (audited treasury
 * confirmation or reconciliation match). Single-winner conditional claim;
 * replays are side-effect free.
 */
async function confirmReceiptAvailable(tx, { dedupKey, confirmedBy = null, evidence = null }) {
    await ensureStateRow(tx);
    const receipt = await tx.fiatLiquidityReceipt.findUnique({ where: { dedupKey } });
    if (!receipt) throw new InvalidEvidenceError(`[fiatLiquidity] unknown receipt identity ${dedupKey}`);
    if (receipt.status === 'AVAILABLE') return { receipt, replay: true };
    if (receipt.status !== 'RECEIVED' && receipt.status !== 'UNMATCHED') {
        throw new ConflictingEvidenceError(
            `[fiatLiquidity] receipt ${dedupKey} in state ${receipt.status} cannot become AVAILABLE`
        );
    }
    const claim = await tx.fiatLiquidityReceipt.updateMany({
        where: { id: receipt.id, status: receipt.status },
        data: { status: 'AVAILABLE', confirmedAt: new Date() },
    });
    if (claim.count !== 1) throw new ConflictingEvidenceError('[fiatLiquidity] receipt confirmation raced');
    const updated = await tx.fiatLiquidityReceipt.update({
        where: { id: receipt.id },
        data: {
            evidence: evidence
                ? { ...(receipt.evidence ?? {}), confirmedBy, confirmation: evidence }
                : (receipt.evidence ?? {}),
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
 * is quarantined RECONCILIATION_REQUIRED with a ReconciliationException.
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
        // with the evidence retained (ops resolves; funds stay counted in
        // reservedGhs, so nothing is spendable twice).
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
 * the reservation is quarantined, NEVER auto-released.
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
// state, never auto-repair. Idempotent via the OPEN-exception unique index.
async function quarantineContradictoryOutcome(tx, reservation, { outcome, providerTxId, reason }) {
    const updated = await tx.fiatLiquidityReservation.updateMany({
        where: { id: reservation.id, status: { not: 'RECONCILIATION_REQUIRED' } },
        data: { status: 'RECONCILIATION_REQUIRED' },
    });
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
            amountGhs: reservation.amountGhs.toString(),
        },
    }).catch(() => null);
    return {
        reservation: await tx.fiatLiquidityReservation.findUnique({ where: { id: reservation.id } }),
        replay: false,
        quarantined: true,
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
 *   AVAILABLE_UNSUPPORTED        available exceeds matched AVAILABLE evidence
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

    for (const r of receipts) {
        if (['RECEIVED', 'UNMATCHED'].includes(r.status) && r.createdAt < horizon) {
            push('FIAT_LIQUIDITY_RECEIPT', r.dedupKey, r.providerRef, 'RECEIPT_WITHOUT_CONFIRMATION',
                { status: r.status, ageMinutes: Math.round((Date.now() - r.createdAt.getTime()) / 60_000) });
        }
    }

    const receiptKeys = new Set(receipts.map((r) => r.dedupKey));
    for (const ev of inboundEvents) {
        if (!receiptKeys.has(ev.dedupKey)) {
            push('FIAT_PROVIDER_EVENT', ev.dedupKey, ev.providerRef, 'EVENT_WITHOUT_RECEIPT',
                { provider: ev.provider, amountGhs: ev.amountGhs.toString(), status: ev.status });
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
        const receipt = receipts.find((r) => r.dedupKey === ev.dedupKey);
        if (receipt && !receipt.amountGhs.equals(ev.amountGhs)) {
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

    // Conservation: every reservation claim removes its amount from
    // available; a release returns it. So the evidence-supported figure is
    //   AVAILABLE receipts − active reservations − paid-out reservations,
    // with RELEASED contributing net zero (claimed then returned).
    const zero = new Prisma.Decimal(0);
    const sum = (rows) => rows.reduce((acc, r) => acc.plus(r.amountGhs ?? zero), zero);
    const availableEvidence = sum(receipts.filter((r) => r.status === 'AVAILABLE'));
    const activeHeld = sum(reservations.filter((r) => ['RESERVED', 'IN_TRANSIT'].includes(r.status)));
    const paidOutHeld = sum(reservations.filter((r) => r.status === 'PAID_OUT'));
    const expectedAvailable = availableEvidence.minus(activeHeld).minus(paidOutHeld);
    const conservationDelta = state.availableGhs.minus(expectedAvailable);
    if (!conservationDelta.isZero()) {
        push('FIAT_LIQUIDITY_STATE', '1', null, 'STATE_CONSERVATION_DELTA',
            { availableGhs: state.availableGhs.toString(), expectedAvailableGhs: expectedAvailable.toString() });
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
    isAuthorityEnabled,
    recordProviderEvent,
    recordReceipt,
    confirmReceiptAvailable,
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
