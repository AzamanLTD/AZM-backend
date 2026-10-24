'use strict';

// FX-unavailable transaction gate middleware (FX-balance workstream).
//
// PRODUCT POLICY (enforced server-side, never by disabled frontend buttons):
// when the CURRENT canonical USDC/GHS rate is not fresh/valid, USDC-enabled
// transaction actions are UNAVAILABLE. A saved/demo fallback rate is NEVER
// transaction authorization — it exists for display only.
//
// The gate delegates to the ONE canonical freshness authority
// (transactionQuoteService.getFreshServerRateGhsPerUsdc, 271C): fail-closed
// on NULL/invalid/future/stale lastExternalSync or an unusable rate value.
// Freshness is recomputed AT REQUEST TIME — an operation that started while
// a rate was fresh can never settle later against a cached verdict.
//
// Refusal contract:
//   • HTTP 503 with success=false, a stable code (RATE_STALE /
//     RATE_UNAVAILABLE), retryable=true and the honest display hint — no
//     client-side retry storm can turn a stale oracle green.
//   • SIDE-EFFECT SAFE BY ORDERING: mount this middleware BEFORE idempotency
//     (and before any controller) so a refused request never claims an
//     idempotency key, never debits/credits/reserves anything and never
//     dispatches to a provider. The controllers' own gates re-validate
//     inside the financial transaction for defense in depth.
//
// Ordering contract (enforced by the mounted route stacks and pinned by
// tests): authentication / ban guard / required 2FA run BEFORE this gate;
// this gate runs BEFORE idempotency and before any controller. An
// unauthenticated request must never learn the gate's state, and a refused
// request never claims an idempotency key.
//
// Scope discipline: mount ONLY on NEW USDC-enabled transaction
// authorizations. Read models (balance/valuation/oracle), auth,
// settlement/lifecycle routes (decline, satisfy, cancel, refund, expiry —
// completions/reversals of ALREADY-AUTHORIZED operations) and provider
// WEBHOOKS are deliberately not gated: a rate refusal can never block
// settlement — see docs/native-ghs-fx-audit.md §4.1 for the full route
// inventory and documented exceptions.

const { getFreshServerRateGhsPerUsdc } = require('../src/services/transactionQuoteService');

// UNIVERSAL SCOPE — no conditional bypass. The earlier `when` predicate
// (conditional FX-dependence scoping) is RETIRED: a stale/missing canonical
// rate makes the whole combined wallet valuation unpriceable at
// authorization time, so EVERY new USDC-enabled transaction authorization on
// a gated route is refused — including flows whose own math computes no GHS
// conversion. There is deliberately no way for a call site to soften this
// middleware; if a future route needs a scoped exception it must be a
// reviewed, documented, TESTED exception (see the settlement-protection
// inventory in docs/native-ghs-fx-audit.md §4.1), not a lambda.
function requireFreshFxRate() {
    return async (req, res, next) => {
        try {
            const prisma = req.app.get('prisma');
            if (!prisma) {
                // Fail closed on infrastructure ambiguity — a missing
                // database handle can never become an open gate.
                return res.status(503).json({
                    success: false,
                    code: 'RATE_UNAVAILABLE',
                    message: 'Exchange rate is temporarily unavailable. Please retry shortly.',
                    retryable: true,
                    usdcTransactionGate: 'CLOSED',
                });
            }

            // Recomputed at request time, server-side. A saved/demo fallback
            // rate is never consulted by this authority.
            const fresh = await getFreshServerRateGhsPerUsdc({ prisma });
            req.freshFxRate = fresh; // exact rate + provenance for controllers
            return next();
        } catch (err) {
            const code = err?.code === 'RATE_STALE' ? 'RATE_STALE' : 'RATE_UNAVAILABLE';
            return res.status(err?.statusCode || 503).json({
                success: false,
                code,
                message:
                    err?.message ||
                    'Exchange rate is temporarily unavailable. Please retry shortly.',
                retryable: true,
                // Honest hint: the saved-rate display fallback (if any) is
                // display-only and does NOT re-open the gate.
                usdcTransactionGate: 'CLOSED',
                savedRateIsDisplayOnly: true,
            });
        }
    };
}

module.exports = { requireFreshFxRate };
