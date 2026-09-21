// services/smartRouteOccurrence.js
// =============================================================================
// AZAMAN — SMART ROUTE OCCURRENCE + SETTLEMENT CONVERGENCE  (r19, 2026-09-21)
//
// A LEAF module: it requires nothing from the other services (no cycles).
// It owns the two facts every Smart Route actor must share:
//
//   1. OCCURRENCE CADENCE — how a claimed occurrence advances to the next
//      one (FREQUENCY_MS / computeNextRun). The cadence is part of the
//      run's immutable execution snapshot: a claimed occurrence advances
//      relative to the occurrence that was ACTUALLY claimed
//      (SmartRouteRun.claimedOccurrenceAt + run.frequency/run.dayOfMonth),
//      never relative to a later-edited route schedule.
//
//   2. CANONICAL SETTLEMENT CONVERGENCE — the projection of a terminal
//      canonical fiat outcome back onto the SmartRouteRun that fired it.
//
// ── WHY THIS MODULE EXISTS (r19 P0) ────────────────────────────────────────
// A MoMo SmartRouteRun may be SUCCESS ("provider accepted the dispatch")
// while the canonical TransactionHistory (reference `SRWD_{runId}`) is still
// PENDING — the provider outcome arrives later, through the Moolre settlement
// webhook or the withdrawal reconciliation worker. Before r19 NOTHING linked
// the terminal canonical outcome back to the run: the run could stay
// "successful" forever even though the payout later failed and the user was
// refunded, and a run parked AWAITING_RECONCILIATION had no convergence path
// at all — a permanent dead-end.
//
// The authority direction is deliberate:
//   • the canonical TransactionHistory (+ Withdrawal mirror + §P.4 ledger +
//     §P.5-D liquidity) is the FINANCIAL AUTHORITY for the payout;
//   • the SmartRouteRun is a PROJECTION of execution history.
// The convergence functions run INSIDE the canonical settlement/reversal
// transaction (same single-winner claim as the money), so the projection can
// never disagree with the money, and can never miss a terminal transition —
// every caller that settles or reverses a canonical fiat withdrawal
// (settlement webhook, reconciliation worker, admin rejection, payout
// worker races) converges the run through exactly one code path.
//
// The run is located through the DETERMINISTIC canonical reference
// (`SRWD_{runId}` — the run's own durable identity), so no additional
// relation column is required for convergence; the existing
// SmartRouteRun.withdrawalId remains a convenience projection written by the
// dispatch path.
//
// Convergence table (single-winner guarded claims, exactly-once effects):
//   canonical COMPLETED:
//     run PENDING/EXECUTING            → SUCCESS (+stats, +occurrence advance
//                                         — neither ever happened for it)
//     run AWAITING_RECONCILIATION      → SUCCESS (+stats — occurrence was
//                                         already consumed at park time)
//     run SUCCESS                      → no-op (already converged)
//   canonical FAILED (reversed):
//     run SUCCESS                      → FAILED_GATEWAY (−stats — unwind the
//                                         increments the SUCCESS finalization
//                                         made; occurrence NOT re-advanced)
//     run AWAITING_RECONCILIATION      → FAILED_GATEWAY (no stats change;
//                                         occurrence already consumed)
//     run PENDING/EXECUTING            → FAILED_GATEWAY (+occurrence advance
//                                         — the failed occurrence consumes
//                                         itself exactly once; no stats)
// =============================================================================

const { Prisma } = require('@prisma/client');

const FREQUENCY_MS = {
    DAILY: 24 * 60 * 60 * 1000,
    WEEKLY: 7 * 24 * 60 * 60 * 1000,
    MONTHLY: 30 * 24 * 60 * 60 * 1000,
    // r19: the update() gate previously keyed off FREQUENCY_MS, which
    // silently rejected ON_DAY_OF_MONTH patches. The canonical set of
    // valid schedule cadences is defined here, once.
    ON_DAY_OF_MONTH: 0,
};

const VALID_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'ON_DAY_OF_MONTH'];

// Smart-route MoMo payout references are derived from the run identity, so
// the canonical TransactionHistory txHash IS the durable linkage back to the
// run. Direct (non-smart-route) withdrawals carry different prefixes and are
// untouched by convergence.
const SR_REFERENCE_PREFIX = 'SRWD_';

/**
 * Compute the next occurrence from a claimed occurrence base. Cadence
 * semantics are IDENTICAL to the pre-r19 smartRouteService._computeNextRun:
 *   • DAILY/WEEKLY/MONTHLY — fixed intervals from the claimed base;
 *   • ON_DAY_OF_MONTH — the target day of the NEXT calendar month at 09:00
 *     server-local (day clamped 1..28);
 *   • unknown cadence — WEEKLY fallback (defensive; validated at the API
 *     boundary).
 */
function computeNextRun(from, frequency, dayOfMonth) {
    const base = new Date(from);
    if (frequency === 'DAILY') return new Date(base.getTime() + FREQUENCY_MS.DAILY);
    if (frequency === 'WEEKLY') return new Date(base.getTime() + FREQUENCY_MS.WEEKLY);
    if (frequency === 'MONTHLY') return new Date(base.getTime() + FREQUENCY_MS.MONTHLY);
    if (frequency === 'ON_DAY_OF_MONTH') {
        const target = Math.min(Math.max(Number(dayOfMonth) || 1, 1), 28);
        return new Date(base.getFullYear(), base.getMonth() + 1, target, 9, 0, 0);
    }
    return new Date(base.getTime() + FREQUENCY_MS.WEEKLY);
}

/** Extract the SmartRouteRun id from a canonical fiat reference, or null. */
function runIdFromReference(reference) {
    if (typeof reference !== 'string' || !reference.startsWith(SR_REFERENCE_PREFIX)) return null;
    const runId = reference.slice(SR_REFERENCE_PREFIX.length);
    return runId || null;
}

/**
 * Converge a SmartRouteRun onto a canonical fiat SUCCESS settlement.
 * MUST be called INSIDE the settlement transaction, after the canonical
 * PENDING → COMPLETED claim has been won (claim.count === 1) — the guarded
 * run claim below is the exactly-once projection of that financial claim.
 *
 * @param tx     the settlement transaction handle
 * @param reference  canonical TransactionHistory txHash
 * @param payoutGhs/retailRate  canonical reservation economics, used to
 *        backfill the run's display columns if the dispatch never got to
 */
async function convergeRunOnFiatSettlement(tx, reference, { payoutGhs = null, retailRate = null } = {}) {
    const runId = runIdFromReference(reference);
    if (!runId) return { converged: false, reason: 'NOT_SMART_ROUTE' };

    const run = await tx.smartRouteRun.findUnique({ where: { id: runId } });
    if (!run) return { converged: false, reason: 'RUN_NOT_FOUND' };
    if (run.status === 'SUCCESS') return { converged: false, reason: 'ALREADY_CONVERGED' };

    const claim = await tx.smartRouteRun.updateMany({
        where: { id: run.id, status: { in: ['PENDING', 'EXECUTING', 'AWAITING_RECONCILIATION'] } },
        data: {
            status: 'SUCCESS',
            failureReason: null,
            amountGhs: run.amountGhs == null && payoutGhs != null
                ? new Prisma.Decimal(String(payoutGhs)) : undefined,
            rateUsed: run.rateUsed == null && retailRate != null
                ? new Prisma.Decimal(String(retailRate)) : undefined,
        },
    });
    if (claim.count !== 1) return { converged: false, reason: 'CONVERGENCE_LOST' };

    const route = await tx.smartRoute.findUnique({ where: { id: run.routeId } });
    if (route) {
        // The run's SUCCESS stats were never counted (only a SUCCESS
        // finalization counts them, and this run never had one).
        const amount = new Prisma.Decimal(run.amountUsdc);
        await tx.smartRoute.update({
            where: { id: route.id },
            data: {
                totalRuns: { increment: 1 },
                totalRoutedUsdc: { increment: amount },
            },
        });
        // A run still PENDING/EXECUTING at settlement time (its driver
        // crashed after the provider accepted, before finalization) never
        // advanced its occurrence — converge that too, from the CLAIMED
        // occurrence snapshot (r19 P0-3: never from the mutable route).
        if (run.status === 'PENDING' || run.status === 'EXECUTING') {
            const occurrenceBased = Boolean(run.executionKey && run.executionKey.includes(':occ:'));
            if (occurrenceBased) {
                const base = run.claimedOccurrenceAt || route.nextRunAt;
                const frequency = run.frequency || route.frequency;
                const dayOfMonth = run.dayOfMonth != null ? run.dayOfMonth : route.dayOfMonth;
                await tx.smartRoute.update({
                    where: { id: route.id },
                    data: { nextRunAt: computeNextRun(base, frequency, dayOfMonth), lastRunAt: new Date() },
                });
            }
        }
    }
    return { converged: true, fromStatus: run.status };
}

/**
 * Converge a SmartRouteRun onto a canonical fiat reversal (PENDING → FAILED,
 * user refunded). MUST be called INSIDE the reversal transaction, after the
 * canonical FAILED claim has been won (claim.count === 1).
 *
 * A run that already claimed SUCCESS must NOT remain "successful money
 * movement" after the refund — it converges to FAILED_GATEWAY and the stats
 * the SUCCESS finalization counted are unwound exactly once.
 */
async function convergeRunOnFiatReversal(tx, reference, { reason = null, runFailureStatus = 'FAILED_GATEWAY' } = {}) {
    const runId = runIdFromReference(reference);
    if (!runId) return { converged: false, reason: 'NOT_SMART_ROUTE' };

    const run = await tx.smartRouteRun.findUnique({ where: { id: runId } });
    if (!run) return { converged: false, reason: 'RUN_NOT_FOUND' };
    if (!['PENDING', 'EXECUTING', 'AWAITING_RECONCILIATION', 'SUCCESS'].includes(run.status)) {
        return { converged: false, reason: 'ALREADY_CONVERGED' };
    }

    // The caller may classify its own reversal honestly (e.g. the smart-route
    // executor's dispatcher-unavailable unwind is FAILED_OTHER, not a gateway
    // rejection). Unknown values fail closed to the canonical gateway state.
    const failureStatus = ['FAILED_GATEWAY', 'FAILED_OTHER'].includes(runFailureStatus)
        ? runFailureStatus
        : 'FAILED_GATEWAY';

    const failureReason = reason
        ? `canonical payout reversed: ${String(reason).slice(0, 240)}`
        : 'canonical payout reversed — user refunded';

    const claim = await tx.smartRouteRun.updateMany({
        where: { id: run.id, status: { in: ['PENDING', 'EXECUTING', 'AWAITING_RECONCILIATION', 'SUCCESS'] } },
        data: { status: failureStatus, failureReason },
    });
    if (claim.count !== 1) return { converged: false, reason: 'CONVERGENCE_LOST' };

    const route = await tx.smartRoute.findUnique({ where: { id: run.routeId } });
    if (route) {
        if (run.status === 'SUCCESS') {
            // Unwind exactly the stats the SUCCESS finalization counted.
            const amount = new Prisma.Decimal(run.amountUsdc);
            await tx.smartRoute.update({
                where: { id: route.id },
                data: {
                    totalRuns: { decrement: 1 },
                    totalRoutedUsdc: { decrement: amount },
                },
            });
        } else if (run.status === 'PENDING' || run.status === 'EXECUTING') {
            // The failed occurrence consumes itself exactly once (a failed
            // run never retries the same occurrence), from the CLAIMED
            // occurrence snapshot.
            const occurrenceBased = Boolean(run.executionKey && run.executionKey.includes(':occ:'));
            if (occurrenceBased) {
                const base = run.claimedOccurrenceAt || route.nextRunAt;
                const frequency = run.frequency || route.frequency;
                const dayOfMonth = run.dayOfMonth != null ? run.dayOfMonth : route.dayOfMonth;
                await tx.smartRoute.update({
                    where: { id: route.id },
                    data: { nextRunAt: computeNextRun(base, frequency, dayOfMonth), lastRunAt: new Date() },
                });
            }
        }
        // AWAITING_RECONCILIATION: the occurrence was already consumed at
        // park time and the stats were never counted — nothing to adjust.
    }
    return { converged: true, fromStatus: run.status };
}

module.exports = {
    FREQUENCY_MS,
    VALID_FREQUENCIES,
    SR_REFERENCE_PREFIX,
    computeNextRun,
    runIdFromReference,
    convergeRunOnFiatSettlement,
    convergeRunOnFiatReversal,
};
